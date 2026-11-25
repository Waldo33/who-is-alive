import type { Rect } from './arena';
import { rectContains } from './arena';
import type { GameConfig } from './config';
import type { ActKind, CrowdKind, Dir, WorldEvent } from './events';
import type { Rng } from './rng';
import type { TwistRules } from './themes';
import type { World } from './world';

interface BotState {
  eid: number;
  /** Когда закончится стоянка и бот выберет новую цель. */
  pauseUntil: number;
  turnAt: number;
  emoteAt: number;
  walking: boolean;
  crowdReactAt: number;
  crowdKind: CrowdKind | null;
  /** Может ли этот бот чудить (у игроков на автопилоте — нет). */
  quirky: boolean;
  quirk: Quirk | null;
  /** Следующая команда «Море волнуется» — с опозданием или не та. */
  lateNext: boolean;
  /** «Разогрев» перед «Толпа решает»: когда показать жест настроения (0 — нет). */
  moodAt: number;
}

/** panic — «перепуг» (тема с рассудком): вздрогнул, убегает от пустоты, иногда отмахивается. */
export type QuirkKind = 'zigzag' | 'stalker' | 'starRun' | 'emoteSpam' | 'late' | 'panic';

interface Quirk {
  kind: QuirkKind;
  until: number;
  nextAt: number;
  target: number;
  left: number;
}

export const CROWD_ACT: Record<CrowdKind, ActKind> = { freeze: 'freeze', jump: 'jump', dance: 'dance' };

export function crowdActDur(cfg: GameConfig, kind: CrowdKind): number {
  return (kind === 'freeze' ? cfg.freezeSec : kind === 'jump' ? cfg.jumpSec : cfg.danceSec) * 1000;
}

/** Поза по команде, начатая в at: пока смотрит Леший (`watchUntil`), замершие стоят до его приговора. */
export function crowdHoldDur(cfg: GameConfig, kind: CrowdKind, at: number, watchUntil?: number): number {
  const d = crowdActDur(cfg, kind);
  return kind === 'freeze' && watchUntil !== undefined ? Math.max(d, watchUntil - at) : d;
}

/** Разброс реакции толпы — одинаковый для ботов и вовремя нажавших игроков. */
export function crowdJitter(rng: Rng, a: number, b: number): number {
  return Math.round(rng.range(a, b) / 50) * 50;
}

export function emoteDur(kind: ActKind): number {
  return kind === 'wave' ? 900 : kind === 'dance' ? 1200 : kind === 'jump' ? 600 : kind === 'jab' ? 700 : 500;
}

/**
 * Мозг ботов (раздел 4): выбрать цель → дойти по A* → постоять → повторить.
 * Решения принимает только хост, генератор — с зерном раунда.
 */
export class BotBrain {
  private bots = new Map<number, BotState>();

  constructor(
    private world: World,
    private cfg: GameConfig,
    private rng: Rng,
    private emit: (ev: WorldEvent) => void,
    /** Изнанка темы: какой эмоцией и насколько чаще толпа «живёт» в ней. */
    private twist?: TwistRules,
  ) {}

  /**
   * «Перепуг» (тема с рассудком): эпизодов в минуту на бота, сейчас. Ставит MatchSim — к ночи чаще.
   * Игрока с кикиморой видно со стороны как человечка, который шарахается от пустоты; боты делают так же.
   */
  panicPerMin = 0;

  /** Для отладки и тестов: сколько эпизодов чудачеств было. */
  quirkLog: { eid: number; kind: QuirkKind; at: number }[] = [];

  add(eid: number, now: number, opts: { quirky?: boolean } = {}): void {
    this.bots.set(eid, {
      quirky: opts.quirky ?? true,
      quirk: null,
      lateNext: false,
      moodAt: 0,
      eid,
      pauseUntil: now + this.rng.range(0, 1500),
      turnAt: 0,
      emoteAt: 0,
      walking: false,
      crowdReactAt: 0,
      crowdKind: null,
    });
  }

  remove(eid: number): void {
    this.bots.delete(eid);
  }

  has(eid: number): boolean {
    return this.bots.has(eid);
  }

  private mood: { kind: CrowdKind; until: number } | null = null;
  /** Кто из ботов на последнюю команду опоздал или перепутал (чудачество late) — их тоже ловит прожектор. */
  lastSlips: number[] = [];

  /**
   * «Разогрев» перед «Толпа решает»: до until часть толпы показывает жест большинства
   * (танцует или прыгает), а перед «замри» — затихает и останавливается. Подсказка внимательным.
   * null — снять настроение.
   */
  setMood(kind: CrowdKind | null, now: number, until = now): void {
    for (const s of this.bots.values()) s.moodAt = 0;
    this.mood = kind ? { kind, until } : null;
    if (!kind) return;
    for (const s of this.bots.values()) {
      const e = this.world.get(s.eid);
      if (!e || !e.alive || s.quirk) continue;
      if (kind === 'freeze') {
        if (!this.rng.chance(0.6)) continue;
        if (s.walking) this.emit({ t: 'stop', eid: s.eid, at: now });
        s.walking = false;
        s.pauseUntil = Math.max(s.pauseUntil, until + this.rng.range(200, 900));
        s.emoteAt = 0;
        s.turnAt = 0;
      } else if (this.rng.chance(0.5)) {
        s.moodAt = Math.round(now + this.rng.range(0, Math.max(0, until - now - 600)));
      }
    }
  }

  /**
   * «Море волнуется»: после стоп-кадра каждый бот выполнит команду со своей задержкой.
   * vote — «Толпа решает»: доля ботов выбирает kind (большинство), остальные — другой жест.
   */
  onCrowd(kind: CrowdKind, resumeAt: number, opts: { skip?: Set<number>; vote?: number } = {}): void {
    const [a, b] = this.cfg.botCrowdReactMs;
    const others = (['freeze', 'jump', 'dance'] as CrowdKind[]).filter((k) => k !== kind);
    this.mood = null;
    this.lastSlips = [];
    for (const s of this.bots.values()) {
      s.moodAt = 0;
      if (opts.skip?.has(s.eid)) continue;
      s.crowdKind = opts.vote !== undefined && !this.rng.chance(opts.vote) ? this.rng.pick(others) : kind;
      s.crowdReactAt = resumeAt + crowdJitter(this.rng, a, b);
      if (s.lateNext) {
        // опоздал, как зазевавшийся игрок; иногда ещё и перепутал команду
        s.lateNext = false;
        this.lastSlips.push(s.eid);
        s.crowdReactAt = resumeAt + crowdJitter(this.rng, 500, 1200);
        if (this.rng.chance(0.25)) s.crowdKind = this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance'].filter((k) => k !== kind) as CrowdKind[]);
      }
    }
  }

  /** Сущность испугалась удара — пусть постоит после испуга. */
  interrupt(eid: number, until: number): void {
    const s = this.bots.get(eid);
    if (!s) return;
    s.walking = false;
    s.pauseUntil = Math.max(s.pauseUntil, until + this.rng.range(200, 900));
    s.turnAt = 0;
    s.emoteAt = 0;
  }

  update(now: number, zoneNow: Rect | null, zoneFinal: Rect | null, playing: boolean): void {
    for (const s of this.bots.values()) {
      const e = this.world.get(s.eid);
      if (!e || !e.alive) continue;

      if (s.crowdKind && now >= s.crowdReactAt) {
        const kind = s.crowdKind;
        s.crowdKind = null;
        // при Лешем толпа стоит, пока он не уйдёт (иначе стоять — выдать себя)
        const dur = crowdHoldDur(this.cfg, kind, now, this.world.crowd?.watchUntil);
        this.emit({ t: 'act', eid: s.eid, kind: CROWD_ACT[kind], dur, at: now });
        s.walking = false;
        s.pauseUntil = now + dur + this.rng.range(100, 700);
        s.turnAt = 0;
        s.emoteAt = 0;
        continue;
      }
      if (!playing) continue;
      if (e.act && now < e.actEnd) continue;

      // изгородь растёт: уйти внутрь, как и должны игроки
      if (zoneNow && !rectContains(zoneNow, e.x, e.y)) {
        const d = this.world.destination(e);
        if (!zoneFinal || !rectContains(zoneFinal, d.x, d.y)) {
          this.goInside(s, zoneFinal ?? zoneNow, now);
        }
        continue;
      }

      if (this.world.isFrozen(now)) continue;
      if (s.moodAt && now >= s.moodAt && this.mood) {
        s.moodAt = 0;
        const kind = CROWD_ACT[this.mood.kind];
        const dur = emoteDur(kind);
        if (s.walking) this.emit({ t: 'stop', eid: s.eid, at: now });
        s.walking = false;
        this.emit({ t: 'act', eid: s.eid, kind, dur, at: now });
        s.pauseUntil = Math.max(s.pauseUntil, now + dur + this.rng.range(200, 600));
        s.emoteAt = 0;
        continue;
      }
      if (this.mood?.kind === 'freeze' && now < this.mood.until && !s.walking && now >= s.pauseUntil) {
        // перед «замри» толпа не расходится: кто стоит — стоит
        s.pauseUntil = now + 250;
        continue;
      }
      if (this.panicPerMin > 0 && s.quirky && !s.quirk && !zoneNow && this.rng.chance((this.panicPerMin * 50) / 60000)) this.startPanic(s, now);
      if (s.quirky && !s.quirk && !zoneNow && this.rng.chance((this.cfg.botQuirkPerMin * 50) / 60000)) this.startQuirk(s, now);
      if (s.quirk) {
        if (this.runQuirk(s, now, zoneFinal ?? zoneNow)) continue;
      }

      if (s.walking) {
        if (e.pi < e.path.length) continue;
        s.walking = false;
        this.startPause(s, now);
        continue;
      }
      if (s.turnAt && now >= s.turnAt) {
        s.turnAt = 0;
        const dir = this.rng.int(0, 3) as Dir;
        if (dir !== e.dir) this.emit({ t: 'face', eid: s.eid, dir, at: now });
      }
      if (s.emoteAt && now >= s.emoteAt) {
        s.emoteAt = 0;
        const kind = this.world.twist && this.twist?.emote ? this.twist.emote : this.rng.pick<ActKind>(['wave', 'dance', 'jump']);
        const dur = emoteDur(kind);
        this.emit({ t: 'act', eid: s.eid, kind, dur, at: now });
        s.pauseUntil = Math.max(s.pauseUntil, now + dur + 200);
      }
      if (now >= s.pauseUntil) this.chooseTarget(s, now, zoneFinal ?? zoneNow);
    }
  }

  private startQuirk(s: BotState, now: number): void {
    const w = this.cfg.botQuirkWeights;
    const entries = Object.entries(w) as [QuirkKind, number][];
    let roll = this.rng.next() * entries.reduce((a, [, v]) => a + v, 0);
    let kind: QuirkKind = 'zigzag';
    for (const [k, v] of entries) {
      if ((roll -= v) < 0) {
        kind = k;
        break;
      }
    }
    if (kind === 'starRun' && this.world.stars.size === 0) kind = 'zigzag';
    this.quirkLog.push({ eid: s.eid, kind, at: now });
    if (kind === 'late') {
      s.lateNext = true;
      return;
    }
    const e = this.world.get(s.eid)!;
    let target = -1;
    if (kind === 'stalker') {
      const near = this.world.alive().filter((o) => o.eid !== s.eid && Math.hypot(o.x - e.x, o.y - e.y) < 60);
      if (!near.length) kind = 'zigzag';
      else target = this.rng.pick(near).eid;
    }
    const dur = kind === 'emoteSpam' ? 3000 : kind === 'starRun' ? 8000 : this.rng.range(3000, 6000);
    s.quirk = { kind, until: now + dur, nextAt: now, target, left: kind === 'emoteSpam' ? this.rng.int(2, 3) : 0 };
    s.turnAt = 0;
    s.emoteAt = 0;
  }

  private startPanic(s: BotState, now: number): void {
    this.quirkLog.push({ eid: s.eid, kind: 'panic', at: now });
    // «откуда» пришёл страх — случайное направление; убегает в противоположную сторону
    const ang = this.rng.range(0, Math.PI * 2);
    this.emit({ t: 'act', eid: s.eid, kind: 'startle', dur: 500, dx: Math.cos(ang) * 3, dy: Math.sin(ang) * 3, at: now });
    s.quirk = { kind: 'panic', until: now + this.rng.range(3000, 5000), nextAt: now + 450, target: Math.round(ang * 1000), left: this.rng.int(2, 3) };
    s.turnAt = 0;
    s.emoteAt = 0;
  }

  /** Шаг чудачества. true — бот занят чудачеством и обычная логика пропускается. */
  private runQuirk(s: BotState, now: number, zone: Rect | null): boolean {
    const q = s.quirk!;
    const e = this.world.get(s.eid)!;
    if (now >= q.until) {
      s.quirk = null;
      s.walking = false;
      this.startPause(s, now);
      return true;
    }
    if (now < q.nextAt) return true;
    switch (q.kind) {
      case 'zigzag': {
        // суетливые короткие перебежки, как у нервного игрока, тапающего по экрану
        const ang = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(10, 26);
        this.walkTo(s, e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r, zone, now, false);
        q.nextAt = now + this.rng.range(400, 800);
        break;
      }
      case 'stalker': {
        // ходит за кем-то по пятам, как охотник
        const t = this.world.get(q.target);
        if (!t || !t.alive) {
          q.until = now;
          break;
        }
        if (Math.hypot(t.x - e.x, t.y - e.y) > 10) this.walkTo(s, t.x + this.rng.range(-6, 6), t.y + this.rng.range(-4, 4), zone, now, false);
        q.nextAt = now + this.rng.range(500, 900);
        break;
      }
      case 'starRun': {
        // прямиком к звезде (сквозь неё — боты звёзды не собирают)
        if (q.left === 0) {
          let best: { x: number; y: number } | null = null;
          for (const st of this.world.stars.values()) if (!best || Math.hypot(st.x - e.x, st.y - e.y) < Math.hypot(best.x - e.x, best.y - e.y)) best = st;
          if (!best || !this.walkTo(s, best.x, best.y, zone, now, false)) q.until = now;
          q.left = 1;
        } else if (e.pi >= e.path.length) q.until = now;
        q.nextAt = now + 200;
        break;
      }
      case 'emoteSpam': {
        if (q.left <= 0) {
          q.until = now;
          break;
        }
        q.left--;
        const kind = this.world.twist && this.twist?.emote ? this.twist.emote : this.rng.pick<ActKind>(['wave', 'dance', 'jump']);
        this.emit({ t: 'act', eid: s.eid, kind, dur: emoteDur(kind), at: now });
        q.nextAt = now + emoteDur(kind) + this.rng.range(100, 300);
        break;
      }
      case 'panic': {
        if (q.left <= 0) {
          // иногда отмахивается от того, чего нет, — как игрок, бьющий свою кикимору
          if (this.rng.chance(0.4)) this.emit({ t: 'act', eid: s.eid, kind: 'jab', dur: emoteDur('jab'), at: now });
          q.until = now;
          break;
        }
        q.left--;
        const ang = q.target / 1000 + this.rng.range(-0.6, 0.6);
        const r = this.rng.range(18, 30);
        this.walkTo(s, e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r, zone, now, false);
        q.nextAt = now + this.rng.range(700, 1100);
        break;
      }
      default:
        q.until = now;
    }
    return true;
  }

  private startPause(s: BotState, now: number): void {
    const [a, b] = this.cfg.botPauseSec;
    const dur = this.rng.range(a, b) * 1000;
    s.pauseUntil = now + dur;
    s.turnAt = this.rng.chance(this.cfg.botTurnChance) ? now + this.rng.range(0.2, 0.8) * dur : 0;
    const mul = this.world.twist ? (this.twist?.emoteMul ?? 1) : 1;
    s.emoteAt = this.rng.chance(Math.min(0.9, this.cfg.botEmoteChance * mul)) ? now + this.rng.range(0.1, 0.5) * dur : 0;
  }

  private goInside(s: BotState, zone: Rect, now: number): void {
    const e = this.world.get(s.eid)!;
    const cx = zone.x + zone.w / 2;
    const cy = zone.y + zone.h / 2;
    const tx = cx + (e.x - cx) * 0.4 + this.rng.range(-10, 10);
    const ty = cy + (e.y - cy) * 0.4 + this.rng.range(-10, 10);
    if (this.walkTo(s, tx, ty, zone, now, true)) return;
    s.pauseUntil = now + 300;
  }

  private chooseTarget(s: BotState, now: number, zone: Rect | null): void {
    const e = this.world.get(s.eid)!;
    const w = this.cfg.botTargetWeights;
    const roll = this.rng.next() * (w.random + w.interest + w.star);
    let tx: number;
    let ty: number;
    const stars = [...this.world.stars.values()];
    if (roll < w.star && stars.length) {
      let best = stars[0];
      for (const st of stars) if (Math.hypot(st.x - e.x, st.y - e.y) < Math.hypot(best.x - e.x, best.y - e.y)) best = st;
      tx = best.x;
      ty = best.y;
    } else if (roll < w.star + w.interest) {
      const p = this.rng.pick(this.world.nav.arena.interest);
      tx = p.x + this.rng.range(-6, 6);
      ty = p.y + this.rng.range(-4, 4);
    } else {
      const [r0, r1] = this.cfg.botWanderRadius;
      const ang = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(r0, r1);
      tx = e.x + Math.cos(ang) * r;
      ty = e.y + Math.sin(ang) * r;
    }
    if (!this.walkTo(s, tx, ty, zone, now, false)) s.pauseUntil = now + 250;
  }

  private walkTo(s: BotState, tx: number, ty: number, zone: Rect | null, now: number, escape: boolean): boolean {
    const path = planPath(this.world, s.eid, tx, ty, zone, escape);
    if (!path || !path.length) return false;
    this.emit({ t: 'move', eid: s.eid, path, at: now });
    s.walking = true;
    s.turnAt = 0;
    s.emoteAt = 0;
    return true;
  }
}

/**
 * Общий для ботов и игроков расчёт маршрута к точке.
 * escape — сущность вне зоны, ищем путь без ограничения зоной, но цель внутри неё.
 */
export function planPath(world: World, eid: number, tx: number, ty: number, zone: Rect | null, escape = false): number[] | null {
  const e = world.get(eid);
  if (!e) return null;
  const nav = world.nav;
  const startZone = escape ? null : zone;
  let goal = nav.cellAt(tx, ty);
  goal = nav.nearestWalkable(goal, zone);
  if (goal < 0) return null;
  const start = nav.cellAt(e.x, e.y);
  let path = nav.findPath(start, goal, startZone);
  if (!path && startZone) path = nav.findPath(start, goal, null);
  return path;
}
