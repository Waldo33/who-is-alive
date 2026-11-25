import type { AiAgent, MatchSim } from './match';
import type { CrowdKind, WorldEvent } from './events';
import { Rng } from './rng';
import { aiLevel } from './config';
import { canFight } from './themes';
import { bossLooking, pathInBossCone } from './boss';

export interface AiPersona {
  /** Шанс опоздать на «Море волнуется». */
  lateChance: number;
  /** Желание идти к звезде. */
  greed: number;
  /** Желание охотиться на подозреваемых. */
  aggression: number;
}

const PERSONAS: AiPersona[] = [
  { lateChance: 0.12, greed: 0.3, aggression: 0.6 },
  { lateChance: 0.2, greed: 0.55, aggression: 0.35 },
  { lateChance: 0.08, greed: 0.15, aggression: 0.8 },
  { lateChance: 0.25, greed: 0.4, aggression: 0.5 },
];

/**
 * ИИ-игрок для песочницы и безголовой симуляции.
 * Знает только своё id и то, что видно всем на поле; правду о других не подсматривает.
 */
export class AiPlayer implements AiAgent {
  private eid = -1;
  private rng: Rng;
  private suspicion = new Map<number, number>();
  private pauseUntil = 0;
  private walking = false;
  private crowdPlan: { kind: CrowdKind; at: number; warnAt: number } | null = null;
  private lastCrowdSeen = -1;
  private freezeChecked = -1;
  private attackAt = 0;
  private accuseAt = 0;
  private kikiAt = 0;
  /** Взгляд шефа, который ИИ уже заметил: когда замрёт и не зазевался ли. */
  private bossSeen = -1;
  private bossReactAt = 0;
  private bossSlip = false;
  private persona: AiPersona;
  private bound = false;

  constructor(readonly pid: string, seed: number, persona?: AiPersona) {
    this.rng = new Rng(seed);
    this.persona = persona ?? PERSONAS[seed % PERSONAS.length];
  }

  onRound(sim: MatchSim, eid: number): void {
    this.eid = eid;
    this.suspicion.clear();
    this.pauseUntil = 0;
    this.walking = false;
    this.crowdPlan = null;
    this.lastCrowdSeen = -1;
    this.freezeChecked = -1;
    this.accuseAt = 0;
    if (!this.bound) {
      this.bound = true;
      sim.world.listeners.push((ev) => this.observe(sim, ev));
    }
  }

  private bump(eid: number, v: number): void {
    if (eid === this.eid) return;
    this.suspicion.set(eid, (this.suspicion.get(eid) ?? 0) + v);
  }

  private observe(sim: MatchSim, ev: WorldEvent): void {
    if (ev.t === 'star_taken') this.bump(ev.eid, 7);
    else if (ev.t === 'hit' && ev.attacker !== undefined) this.bump(ev.attacker, 9);
    else if (ev.t === 'remove') this.suspicion.delete(ev.eid);
    // шеф поймал шевельнувшегося — ботов тоже ловит, но живые попадаются чаще
    else if (ev.t === 'boss' && ev.act === 'catch') this.bump(ev.eid, 5);
    else if (ev.t === 'act' && (ev.kind === 'freeze' || ev.kind === 'jump' || ev.kind === 'dance')) {
      const c = sim.world.crowd;
      if (c && ev.at > c.resumeAt + 320 && ev.at < c.windowEnd + 500) this.bump(ev.eid, 3);
    }
  }

  update(sim: MatchSim): void {
    const me = sim.playerRound(this.pid);
    if (!me) return;
    const w = sim.world;
    const t = w.time;

    // вырезанный ИИ иногда подаёт «Хлопушку» — в песочнице тоже видно, как это работает
    if (sim.phase === 'play' && !me.alive) {
      // метка «?» — обвинение: осмотрелся — ставит на самого подозрительного, потом изредка переносит
      if (!this.accuseAt) this.accuseAt = t + this.rng.range(3000, 9000);
      if (t >= this.accuseAt) {
        this.accuseAt = t + this.rng.range(6000, 12000);
        const target = this.topSuspect(sim, Infinity) ?? (me.accused === null || !w.get(me.accused)?.alive ? this.randomOther(sim) : null);
        if (target !== null && target !== me.accused) sim.intent(this.pid, { k: 'accuse', eid: target });
      }
      if (me.clapsLeft > 0 && t >= me.clapAt && sim.ghostCrowdAt(t) !== null && this.rng.chance(0.006)) {
        sim.intent(this.pid, { k: 'clap', kind: this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance']) });
      }
      return;
    }
    // живой ИИ в стоп-кадре «Кто ещё живой?» — подумал и ставит метку на самого подозрительного
    if (sim.phase === 'accuse' && me.alive) {
      if (me.accused === null && this.rng.chance(0.04)) {
        const target = this.topSuspect(sim, Infinity) ?? this.randomOther(sim);
        if (target !== null) sim.intent(this.pid, { k: 'accuse', eid: target });
      }
      return;
    }
    if (sim.phase !== 'play' || !me.alive) return;
    const e = w.get(this.eid);
    if (!e || !e.alive) return;

    // «Море волнуется»
    const c = w.crowd;
    if (c && c.warnAt !== this.lastCrowdSeen && t >= c.warnAt) {
      this.lastCrowdSeen = c.warnAt;
      const late = this.rng.chance(this.persona.lateChance);
      const pause = c.resumeAt - c.showAt;
      // вовремя: нажимает в стоп-кадре; опоздал: после паузы (видно всем) или вовсе не нажал
      const at = late ? c.resumeAt + this.rng.range(350, 1400) : c.showAt + this.rng.range(250, Math.max(300, pause - 100));
      // «Толпа решает»: ИИ угадывает жест большинства не всегда
      const kind = c.vote && !this.rng.chance(0.6) ? this.rng.pick((['freeze', 'jump', 'dance'] as CrowdKind[]).filter((k) => k !== c.kind)) : c.kind;
      this.crowdPlan = { kind, at, warnAt: c.warnAt };
    }
    if (this.crowdPlan && t >= this.crowdPlan.at) {
      sim.intent(this.pid, { k: 'crowd', kind: this.crowdPlan.kind });
      this.crowdPlan = null;
      this.walking = false;
      this.pauseUntil = t + 2200;
    }
    // кто продолжает идти во время «Замри» — подозрителен
    if (c && c.kind === 'freeze' && this.freezeChecked !== c.warnAt && t > c.resumeAt + 450) {
      this.freezeChecked = c.warnAt;
      for (const o of w.alive()) if (o.moving && o.act === null) this.bump(o.eid, 3);
    }
    // шеф смотрит: в его конусе не шевелиться (заметил с задержкой, а иногда и зазевался)
    const b = w.boss;
    if (bossLooking(b, t)) {
      if (this.bossSeen !== b.look.from) {
        this.bossSeen = b.look.from;
        this.bossReactAt = t + this.rng.range(150, 650);
        this.bossSlip = this.rng.chance(0.12);
      }
      const rest = e.path.slice(e.pi).map((c) => ({ x: w.nav.cx(c), y: w.nav.cy(c) }));
      if (!this.bossSlip && t >= this.bossReactAt && pathInBossCone(b, b.look.dir, e.x, e.y, rest)) {
        if (e.pi < e.path.length) sim.intent(this.pid, { k: 'stop' });
        this.walking = false;
        this.pauseUntil = Math.max(this.pauseUntil, b.look.until + 200);
        return;
      }
    }
    // стоп-кадр: мир замер, удары не принимаются — стоит, как все
    if (w.isFrozen()) return;
    if (e.act && t < e.actEnd) return;
    if (t < me.stunUntil) return;

    // свои кикиморы: рядом — отбиваться, поодаль — бежать от них
    if (this.kikimora(sim, me, e.x, e.y, t)) return;

    // охота: в разогреве (первые секунды дубля) не бьёт — живой игрок успевает осмотреться;
    // чем ниже сложность, тем дольше разогрев, медленнее реакция и больше нужно улик
    const cfg = sim.cfg;
    const lv = aiLevel(cfg);
    const need = cfg.aiSuspectMin[lv];
    const warm = t < sim.playStart + cfg.aiWarmupSec[lv] * 1000;
    // в офисе не дерутся — только в подвале (themes.ts › fight)
    const armed = me.attacksLeft > 0 && canFight(sim.theme, w.twist);
    if (armed && !warm) {
      const sus = this.topSuspect(sim, cfg.attackRange - 1);
      if (sus !== null && (this.suspicion.get(sus) ?? 0) >= need) {
        const [r0, r1] = cfg.aiReactMs[lv];
        if (!this.attackAt) this.attackAt = t + this.rng.range(r0, r1);
        if (t >= this.attackAt) {
          sim.intent(this.pid, { k: 'attack', eid: sus });
          this.attackAt = 0;
          this.suspicion.set(sus, 0);
        }
        return;
      }
      this.attackAt = 0;
      // изредка — удар наугад (рождает «Параноиков»)
      if (this.rng.chance(0.0015 * this.persona.aggression * cfg.aiRandomHitMul[lv])) {
        const near = w.alive().filter((o) => o.eid !== this.eid && Math.hypot(o.x - e.x, o.y - e.y) < cfg.attackRange - 1);
        if (near.length) {
          sim.intent(this.pid, { k: 'attack', eid: this.rng.pick(near).eid });
          return;
        }
      }
    }

    if (this.walking) {
      if (e.pi < e.path.length) return;
      this.walking = false;
      const [a, b] = sim.cfg.botPauseSec;
      this.pauseUntil = t + this.rng.range(a, b) * 1000;
      return;
    }
    if (t < this.pauseUntil) return;

    // выбрать цель: подозреваемый, звезда или прогулка «как бот»
    const hunt = this.topSuspect(sim, 70);
    if (hunt !== null && !warm && armed && (this.suspicion.get(hunt) ?? 0) >= need && this.rng.chance(this.persona.aggression)) {
      const h = w.get(hunt)!;
      this.go(sim, h.x + this.rng.range(-5, 5), h.y + this.rng.range(-4, 4));
      return;
    }
    const stars = [...w.stars.values()].filter((s) => Math.hypot(s.x - e.x, s.y - e.y) < 90);
    if (stars.length && this.rng.chance(this.persona.greed)) {
      const s = this.rng.pick(stars);
      this.go(sim, s.x, s.y);
      return;
    }
    if (this.rng.chance(0.2)) {
      const p = this.rng.pick(sim.arena.interest);
      this.go(sim, p.x + this.rng.range(-6, 6), p.y + this.rng.range(-4, 4));
      return;
    }
    const [r0, r1] = sim.cfg.botWanderRadius;
    const ang = this.rng.range(0, Math.PI * 2);
    const r = this.rng.range(r0, r1);
    this.go(sim, e.x + Math.cos(ang) * r, e.y + Math.sin(ang) * r);
  }

  /** Реакция на своих кикимор (тема с рассудком). true — ход занят. */
  private kikimora(sim: MatchSim, me: NonNullable<ReturnType<MatchSim['playerRound']>>, x: number, y: number, t: number): boolean {
    let near: { id: number; x: number; y: number } | null = null;
    let nd = Infinity;
    for (const k of me.kiki) {
      if (t < k.at) continue;
      const d = Math.hypot(k.x - x, k.y - y);
      if (d < nd) {
        nd = d;
        near = k;
      }
    }
    if (!near) {
      this.kikiAt = 0;
      return false;
    }
    if (nd <= sim.cfg.attackRange + 2) {
      if (!this.kikiAt) this.kikiAt = t + this.rng.range(150, 600);
      if (t >= this.kikiAt) {
        sim.intent(this.pid, { k: 'attack', eid: near.id });
        this.kikiAt = 0;
      }
      return true;
    }
    if (nd < 45 && !this.walking) {
      const a = Math.atan2(y - near.y, x - near.x) + this.rng.range(-0.6, 0.6);
      this.go(sim, x + Math.cos(a) * 40, y + Math.sin(a) * 40);
      return true;
    }
    return false;
  }

  private go(sim: MatchSim, x: number, y: number): void {
    sim.intent(this.pid, { k: 'move', x, y });
    this.walking = true;
    this.pauseUntil = sim.world.time + 400;
  }

  private topSuspect(sim: MatchSim, radius: number): number | null {
    const me = sim.world.get(this.eid);
    if (!me) return null;
    let best: number | null = null;
    let bestV = 0;
    for (const [eid, v] of this.suspicion) {
      const o = sim.world.get(eid);
      if (!o || !o.alive) continue;
      if (Math.hypot(o.x - me.x, o.y - me.y) > radius) continue;
      if (v > bestV) {
        bestV = v;
        best = eid;
      }
    }
    return best;
  }

  private randomOther(sim: MatchSim): number | null {
    const list = sim.world.alive().filter((o) => o.eid !== this.eid);
    return list.length ? this.rng.pick(list).eid : null;
  }
}
