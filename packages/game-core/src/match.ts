import type { ArenaDef, Rect } from './arena';
import { clampToRect, plazaArena, rectContains, shrinkRect } from './arena';
import type { AwardCard, RoundStats } from './awards';
import { pickMatchAwards, pickRoundAwards } from './awards';
import { BotBrain, CROWD_ACT, crowdActDur, crowdJitter, emoteDur, planPath } from './bots';
import type { GameConfig } from './config';
import { TICK_MS, accuseMs, crowdPauseMs, revealMs } from './config';
import type { ActKind, CrowdKind, Dir, EmoteKind, EntitySpawn, WorldEvent } from './events';

const EMOTES: EmoteKind[] = ['wave', 'dance', 'jump'];
import { NavGrid } from './nav';
import { Rng } from './rng';
import { World } from './world';

export interface PlayerInfo {
  pid: string;
  name: string;
  /** 0 красный, 1 синий, 2 жёлтый, 3 зелёный */
  color: number;
}

export type Phase = 'countdown' | 'play' | 'accuse' | 'reveal' | 'results' | 'match_end';

export type Intent =
  | { k: 'move'; x: number; y: number }
  | { k: 'stop' }
  /** kind выбирает сам игрок (гость показывает эмоцию сразу, не дожидаясь хоста); без него — случайно. */
  | { k: 'emote'; kind?: EmoteKind }
  /** wt — время мира на экране игрока в момент нажатия (компенсация задержки сети). */
  | { k: 'crowd'; kind: CrowdKind; wt?: number }
  | { k: 'attack'; eid: number; wt?: number }
  | { k: 'autopilot'; on: boolean }
  | { k: 'accuse'; eid: number }
  | { k: 'next' }
  | { k: 'rematch' };

export interface PlayerRound {
  pid: string;
  eid: number;
  alive: boolean;
  attacksLeft: number;
  stars: number;
  stunUntil: number;
  autopilot: boolean;
  diedAt: number | null;
  kills: number;
  killTimes: number[];
  botHits: number;
  accused: number | null;
  accusedAsGhost: boolean;
  crowdAnswered: number;
  /** Нажал во время стоп-кадра: команда выполнится в этот момент вместе с толпой. */
  crowdQueued: { kind: CrowdKind; at: number } | null;
}

export interface PointsLine {
  kill: number;
  survive: number;
  stars: number;
  accuse: number;
  total: number;
}

export interface RoundSummary {
  round: number;
  endReason: 'time' | 'stars' | 'last_alive';
  starWinner: string | null;
  reveal: { pid: string; eid: number; alive: boolean; x: number; y: number }[];
  accusations: { pid: string; eid: number; correct: boolean }[];
  points: Record<string, PointsLine>;
  awards: AwardCard[];
  replayFrom: number;
  replayTo: number;
}

export interface MatchSummary {
  winners: string[];
  tooAlive: boolean;
  scores: Record<string, number>;
  awards: AwardCard[];
}

export type Notice =
  | { t: 'round_start'; round: number; theme: number }
  | { t: 'phase'; phase: Phase; at: number }
  | { t: 'score'; pid: string; delta: number; reason: keyof Omit<PointsLine, 'total'> }
  | { t: 'denied'; pid: string; reason: 'no_attacks' | 'out_of_range' | 'stunned' | 'autopilot' }
  /** Итог удара — только для того, кто бил (по сети уходит ему лично, чтобы показать результат без задержки показа мира). */
  | { t: 'attack'; pid: string; target: number; result: 'player' | 'bot'; at: number };

/** Наблюдатель-ИИ (песочница и безголовая симуляция) получает только то, что видно на поле. */
export interface AiAgent {
  pid: string;
  onRound(sim: MatchSim, eid: number): void;
  update(sim: MatchSim): void;
}

export const THEME_COUNT = 4;
/** Насколько поздно может прийти по сети нажатие, чтобы его засчитали по времени экрана игрока. */
export const LAG_GRACE_MS = 600;

/**
 * Авторитетная симуляция матча. Работает у хоста; в песочнице — на единственном устройстве.
 * Все решения (боты, удары, звёзды, фазы) принимаются здесь, наружу уходят только события мира.
 */
export class MatchSim {
  readonly arena: ArenaDef;
  readonly nav: NavGrid;
  readonly world: World;
  readonly rng: Rng;
  bots!: BotBrain;

  now = 0;
  phase: Phase = 'countdown';
  phaseEndsAt = 0;
  round = 0;
  theme = 0;
  /** Порядок тем в матче — свой в каждом матче и реванше. */
  themeOrder: number[] = [];
  scores: Record<string, number> = {};
  matchKills: Record<string, number> = {};
  roundAwards: AwardCard[][] = [];
  pr: PlayerRound[] = [];
  summary: RoundSummary | null = null;
  match: MatchSummary | null = null;
  notices: Notice[] = [];
  /**
   * Где были сущности последние ~0,7 с (по шагам мира). Игрок по сети видит мир с опозданием,
   * поэтому удар проверяется и по тому месту, где цель была на его экране («перемотка», как в шутерах).
   */
  private posHist: { t: number; pos: Map<number, [number, number]> }[] = [];
  agents: AiAgent[] = [];

  playStart = 0;
  plannedPlayEnd = 0;
  playEnd = 0;
  endReason: RoundSummary['endReason'] = 'time';
  starWinner: string | null = null;
  nextCrowdAt = 0;
  crowdShowTimes: number[] = [];
  zoneStarted = false;
  starSpawnQueue: number[] = [];
  starSeq = 1;
  neighbors = new Map<string, { a: string; b: string; cur: number; max: number; hit: boolean }>();
  private intents: { pid: string; it: Intent }[] = [];

  constructor(
    readonly cfg: GameConfig,
    readonly players: PlayerInfo[],
    seed: number,
    readonly hostPid: string = players[0]?.pid ?? '',
  ) {
    this.arena = plazaArena(cfg.arenaWidth, cfg.arenaHeight);
    this.nav = new NavGrid(this.arena, cfg.navCellSize);
    this.world = new World(this.nav, cfg.entitySpeed);
    this.rng = new Rng(seed);
    this.shuffleThemes();
    for (const p of players) {
      this.scores[p.pid] = 0;
      this.matchKills[p.pid] = 0;
    }
    this.startRound();
  }

  // ───────────── публичный API ─────────────

  intent(pid: string, it: Intent): void {
    this.intents.push({ pid, it });
  }

  playerRound(pid: string): PlayerRound | undefined {
    return this.pr.find((p) => p.pid === pid);
  }

  playerByEid(eid: number): PlayerRound | undefined {
    return this.pr.find((p) => p.eid === eid);
  }

  info(pid: string): PlayerInfo | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  zoneFinal(): Rect | null {
    return this.world.zone ? this.world.zone.to : null;
  }

  crowdWindowOpen(t = this.world.time): boolean {
    const c = this.world.crowd;
    return !!c && t >= c.showAt && t <= c.windowEnd;
  }

  /** Сколько мс осталось в текущей фазе (для таймера в шапке). */
  timeLeft(): number {
    if (this.phase === 'play') {
      const c = this.world.crowd;
      const pause = c && this.world.isFrozen() ? c.resumeAt - this.world.time : 0;
      return Math.max(0, this.plannedPlayEnd - this.world.time - pause);
    }
    return Math.max(0, this.phaseEndsAt - this.now);
  }

  tick(): void {
    this.now += TICK_MS;
    this.processIntents();
    switch (this.phase) {
      case 'countdown':
        if (this.now >= this.phaseEndsAt) this.beginPlay();
        else {
          this.bots.update(this.world.time, null, null, false);
          this.world.step();
        }
        break;
      case 'play':
        this.playTick();
        break;
      case 'accuse':
        for (const a of this.agents) a.update(this);
        if (this.now >= this.phaseEndsAt) this.finishRound();
        break;
      case 'reveal':
        if (this.now >= this.phaseEndsAt) this.setPhase('results', this.cfg.autoNextSec * 1000);
        break;
      case 'results':
        if (this.now >= this.phaseEndsAt) this.advanceAfterResults();
        break;
      case 'match_end':
        break;
    }
  }

  // ───────────── раунд ─────────────

  private setPhase(p: Phase, dur: number): void {
    this.phase = p;
    this.phaseEndsAt = this.now + dur;
    this.notices.push({ t: 'phase', phase: p, at: this.now });
  }

  private startRound(): void {
    this.round++;
    this.theme = this.themeOrder[(this.round - 1) % THEME_COUNT];
    this.summary = null;
    const rng = this.rng;
    // случайные id, новые каждый раунд
    const ids = new Set<number>();
    while (ids.size < this.cfg.entitiesTotal) ids.add(rng.int(100, 9999));
    const eids = rng.shuffle([...ids]);
    const spawns: EntitySpawn[] = [];
    const taken: { x: number; y: number }[] = [];
    let guard = 0;
    while (spawns.length < eids.length && guard++ < 10000) {
      const c = rng.int(0, this.nav.cols - 1);
      const r = rng.int(0, this.nav.rows - 1);
      const i = this.nav.idx(c, r);
      if (!this.nav.walkable(i)) continue;
      const x = this.nav.cx(i);
      const y = this.nav.cy(i);
      if (taken.some((t) => Math.abs(t.x - x) < 10 && Math.abs(t.y - y) < 10)) continue;
      taken.push({ x, y });
      spawns.push({ eid: eids[spawns.length], x, y, dir: rng.int(0, 3) as Dir });
    }
    const t0 = Math.ceil(this.world.time / 1000) * 1000 + 1000;
    this.world.init(spawns, t0);
    this.posHist = [];
    const playerEids = rng.shuffle(spawns.map((s) => s.eid)).slice(0, this.players.length);
    this.pr = this.players.map((p, i) => ({
      pid: p.pid,
      eid: playerEids[i],
      alive: true,
      attacksLeft: this.cfg.attacksPerRound,
      stars: 0,
      stunUntil: 0,
      autopilot: false,
      diedAt: null,
      kills: 0,
      killTimes: [],
      botHits: 0,
      accused: null,
      accusedAsGhost: false,
      crowdAnswered: -1,
      crowdQueued: null,
    }));
    this.bots = new BotBrain(this.world, this.cfg, new Rng(rng.fork()), (ev) => this.emit(ev));
    const pset = new Set(playerEids);
    for (const s of spawns) if (!pset.has(s.eid)) this.bots.add(s.eid, t0 + this.cfg.countdownSec * 1000);
    this.crowdShowTimes = [];
    this.zoneStarted = false;
    this.starSpawnQueue = [];
    this.neighbors.clear();
    this.endReason = 'time';
    this.starWinner = null;
    this.notices.push({ t: 'round_start', round: this.round, theme: this.theme });
    this.setPhase('countdown', this.cfg.countdownSec * 1000);
    for (const a of this.agents) a.onRound(this, this.playerRound(a.pid)!.eid);
  }

  /** Подключить ИИ-агентов (песочница/симуляция). */
  addAgent(a: AiAgent): void {
    this.agents.push(a);
    const p = this.playerRound(a.pid);
    if (p) a.onRound(this, p.eid);
  }

  private beginPlay(): void {
    this.setPhase('play', this.cfg.roundSec * 1000);
    this.playStart = this.world.time;
    this.plannedPlayEnd = this.playStart + this.cfg.roundSec * 1000;
    this.nextCrowdAt = this.playStart + this.crowdInterval();
    for (let i = 0; i < this.cfg.maxStars; i++) this.spawnStar();
  }

  private crowdInterval(): number {
    const [a, b] = this.cfg.crowdCmdIntervalSec;
    return Math.round(this.rng.range(a, b) * 20) * 50;
  }

  private emit(ev: WorldEvent): void {
    this.world.push(ev);
  }

  private playTick(): void {
    const t = this.world.time;
    const cfg = this.cfg;

    // «Море волнуется»
    // (не во время сужения: зона зависит от времени, а в стоп-кадре никто не может уйти)
    if (t >= this.nextCrowdAt && !this.zoneStarted && t < this.plannedPlayEnd - cfg.zoneStartBeforeEndSec * 1000 - 3000) {
      const kind = this.rng.pick<CrowdKind>(['freeze', 'jump', 'dance']);
      const pause = crowdPauseMs(cfg);
      const resumeAt = t + pause;
      this.emit({ t: 'crowd', kind, at: t, showAt: t, resumeAt, windowEnd: resumeAt + cfg.crowdLateMs });
      this.crowdShowTimes.push(resumeAt);
      this.plannedPlayEnd += pause; // пауза не съедает время раунда
      // игроки на автопилоте — это тоже игроки: за них команду никто не выполнит
      this.bots.onCrowd(kind, resumeAt, { skip: new Set(this.pr.map((p) => p.eid)) });
      this.nextCrowdAt = resumeAt + this.crowdInterval();
    }
    // нажавшие во время стоп-кадра выполняют команду вместе с толпой, с тем же разбросом, что у ботов
    for (const p of this.pr) {
      if (p.crowdQueued && t >= p.crowdQueued.at) {
        const k = p.crowdQueued.kind;
        p.crowdQueued = null;
        if (p.alive) this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[k], dur: crowdActDur(cfg, k), at: t });
      }
    }

    // сужение
    if (!this.zoneStarted && t >= this.plannedPlayEnd - cfg.zoneStartBeforeEndSec * 1000) {
      this.zoneStarted = true;
      this.emit({
        t: 'zone',
        at: t,
        startAt: t,
        endAt: t + cfg.zoneShrinkSec * 1000,
        from: { ...this.arena.walk },
        to: shrinkRect(this.arena.walk, cfg.zoneFinalAreaRatio),
      });
    }

    // звёзды
    while (this.starSpawnQueue.length && this.starSpawnQueue[0] <= t) {
      this.starSpawnQueue.shift();
      this.spawnStar();
    }

    const zoneNow = this.world.zoneRect(t);
    const zoneFinal = this.zoneFinal();
    this.bots.update(t, zoneNow, zoneFinal, true);
    for (const a of this.agents) a.update(this);
    this.processIntents();

    // игроков, оставшихся в изгороди, выталкивает к центру
    if (zoneNow) {
      for (const p of this.pr) {
        if (!p.alive) continue;
        const e = this.world.get(p.eid)!;
        if (rectContains(zoneNow, e.x, e.y)) continue;
        const d = this.world.destination(e);
        if (zoneFinal && rectContains(zoneFinal, d.x, d.y)) continue;
        const z = zoneFinal ?? zoneNow;
        const target = clampToRect(z, e.x, e.y, 6);
        const path = planPath(this.world, p.eid, target.x, target.y, z, true);
        if (path && path.length) this.emit({ t: 'move', eid: p.eid, path, at: t });
      }
    }

    // сбор звёзд (боты проходят сквозь звёзды, не собирая)
    const takenNow = new Set<number>();
    for (const p of this.pr) {
      if (!p.alive || p.autopilot || t < p.stunUntil) continue;
      const e = this.world.get(p.eid)!;
      for (const st of this.world.stars.values()) {
        if (takenNow.has(st.id)) continue;
        if (Math.hypot(st.x - e.x, st.y - e.y) <= cfg.starPickupRadius) {
          this.emit({ t: 'star_taken', id: st.id, eid: p.eid, at: t });
          takenNow.add(st.id); // чтобы второй игрок не взял ту же звезду в этом же тике
          p.stars++;
          this.starSpawnQueue.push(t + cfg.starRespawnSec * 1000);
          if (p.stars >= cfg.starsToWin && !this.starWinner) {
            this.starWinner = p.pid;
            this.endReason = 'stars';
          }
          break;
        }
      }
    }

    // «слепые соседи»
    const alive = this.pr.filter((p) => p.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const key = [a.pid, b.pid].sort().join('|');
        let n = this.neighbors.get(key);
        if (!n) this.neighbors.set(key, (n = { a: a.pid, b: b.pid, cur: 0, max: 0, hit: false }));
        const ea = this.world.get(a.eid)!;
        const eb = this.world.get(b.eid)!;
        if (Math.hypot(ea.x - eb.x, ea.y - eb.y) <= 20) {
          n.cur += TICK_MS;
          n.max = Math.max(n.max, n.cur);
        } else n.cur = 0;
      }
    }

    this.world.step();
    this.recordPositions();

    const aliveCount = this.pr.filter((p) => p.alive).length;
    const lastAlive = this.players.length >= 2 && aliveCount <= 1;
    if (lastAlive && this.endReason === 'time') this.endReason = 'last_alive';
    if (this.starWinner || lastAlive || this.world.time >= this.plannedPlayEnd) this.beginAccuse();
  }

  private spawnStar(): void {
    const zone = this.world.zoneRect() ?? this.arena.walk;
    for (let k = 0; k < 200; k++) {
      const i = this.nav.idx(this.rng.int(0, this.nav.cols - 1), this.rng.int(0, this.nav.rows - 1));
      if (!this.nav.walkable(i, zone)) continue;
      const x = this.nav.cx(i);
      const y = this.nav.cy(i);
      if (this.world.alive().some((e) => Math.hypot(e.x - x, e.y - y) < 10)) continue;
      if ([...this.world.stars.values()].some((s) => Math.hypot(s.x - x, s.y - y) < 40)) continue;
      this.emit({ t: 'star_spawn', id: this.starSeq++, x, y, at: this.world.time });
      return;
    }
  }

  private beginAccuse(): void {
    this.playEnd = this.world.time;
    for (const e of this.world.alive()) this.world.push({ t: 'stop', eid: e.eid, at: this.world.time });
    this.world.step(); // применить остановку
    this.setPhase('accuse', accuseMs(this.cfg));
  }

  private finishRound(): void {
    const cfg = this.cfg;
    const pts: Record<string, PointsLine> = {};
    for (const p of this.pr) pts[p.pid] = { kill: p.kills * cfg.points.kill, survive: 0, stars: 0, accuse: 0, total: 0 };
    const aliveEids = new Set(this.pr.filter((p) => p.alive).map((p) => p.eid));
    const accusations: RoundSummary['accusations'] = [];
    const accusedCount = new Map<number, number>();
    for (const p of this.pr) {
      if (p.accused === null) continue;
      const correct = aliveEids.has(p.accused);
      accusations.push({ pid: p.pid, eid: p.accused, correct });
      accusedCount.set(p.accused, (accusedCount.get(p.accused) ?? 0) + 1);
      if (correct) this.addScore(p.pid, cfg.points.accuse, 'accuse', pts);
    }
    for (const p of this.pr) {
      // выжил, но тебя вычислили — очко за выживание пропадает (обвинитель своё +1 уже получил)
      if (p.alive && !accusedCount.get(p.eid)) this.addScore(p.pid, cfg.points.survive, 'survive', pts);
      if (this.starWinner === p.pid) this.addScore(p.pid, cfg.points.stars, 'stars', pts);
    }
    for (const p of this.pr) pts[p.pid].total = pts[p.pid].kill + pts[p.pid].survive + pts[p.pid].stars + pts[p.pid].accuse;

    const stats: RoundStats[] = this.pr.map((p) => ({
      pid: p.pid,
      alive: p.alive,
      diedAtFromStart: p.diedAt === null ? null : p.diedAt - this.playStart,
      kills: p.kills,
      killTimes: p.killTimes,
      botHits: p.botHits,
      stars: p.stars,
      accused: p.accused,
      accuseCorrect: p.accused !== null && aliveEids.has(p.accused),
      accusedAsGhost: p.accusedAsGhost,
      timesAccused: accusedCount.get(p.eid) ?? 0,
    }));
    const awards = pickRoundAwards({
      stats,
      neighbors: [...this.neighbors.values()].map((n) => ({ a: n.a, b: n.b, ms: n.max, hit: n.hit })),
      crowdShowTimes: this.crowdShowTimes,
      plannedPlayEnd: this.plannedPlayEnd,
    });
    this.roundAwards.push(awards);

    const replayTo = this.playEnd;
    const replayFrom = Math.max(this.playStart, replayTo - cfg.revealReplaySec * 1000);
    this.summary = {
      round: this.round,
      endReason: this.endReason,
      starWinner: this.starWinner,
      reveal: this.pr.map((p) => {
        const e = this.world.get(p.eid)!;
        return { pid: p.pid, eid: p.eid, alive: p.alive, x: e.x, y: e.y };
      }),
      accusations,
      points: pts,
      awards,
      replayFrom,
      replayTo,
    };
    this.setPhase('reveal', revealMs(cfg));
  }

  private addScore(pid: string, delta: number, reason: keyof Omit<PointsLine, 'total'>, pts?: Record<string, PointsLine>): void {
    if (!delta) return;
    this.scores[pid] += delta;
    if (pts) pts[pid][reason] += delta;
    this.notices.push({ t: 'score', pid, delta, reason });
  }

  private advanceAfterResults(): void {
    const top = Math.max(...Object.values(this.scores));
    if (top >= this.cfg.scoreToWin || this.round >= this.cfg.maxRounds) {
      const leaders = this.players.filter((p) => this.scores[p.pid] === top).map((p) => p.pid);
      let winners = leaders;
      let tooAlive = false;
      if (leaders.length > 1) {
        const k = Math.max(...leaders.map((pid) => this.matchKills[pid]));
        winners = leaders.filter((pid) => this.matchKills[pid] === k);
        tooAlive = winners.length > 1;
      }
      this.match = {
        winners,
        tooAlive,
        scores: { ...this.scores },
        awards: pickMatchAwards(this.roundAwards, this.matchKills),
      };
      this.setPhase('match_end', 0);
    } else {
      this.startRound();
    }
  }

  private shuffleThemes(): void {
    const last = this.theme;
    const order = this.rng.shuffle(Array.from({ length: THEME_COUNT }, (_, i) => i));
    // реванш не начинается с той же темы, которой закончился прошлый матч
    if (this.round > 0 && order[0] === last) order.push(order.shift()!);
    this.themeOrder = order;
  }

  /**
   * Продолжить матч после смены хоста: счёт известен всем, текущий раунд начинается заново (раздел 13).
   */
  resumeMatch(state: { scores: Record<string, number>; round: number; matchKills?: Record<string, number> }): void {
    for (const p of this.players) {
      this.scores[p.pid] = state.scores[p.pid] ?? 0;
      this.matchKills[p.pid] = state.matchKills?.[p.pid] ?? 0;
    }
    this.round = Math.max(0, state.round - 1);
    this.roundAwards = Array.from({ length: this.round }, () => []);
    this.notices = [];
    this.startRound();
  }

  private rematch(): void {
    this.shuffleThemes();
    for (const p of this.players) {
      this.scores[p.pid] = 0;
      this.matchKills[p.pid] = 0;
    }
    this.round = 0;
    this.roundAwards = [];
    this.match = null;
    this.startRound();
  }

  // ───────────── намерения игроков ─────────────

  private processIntents(): void {
    const list = this.intents;
    this.intents = [];
    for (const { pid, it } of list) this.handle(pid, it);
  }

  private handle(pid: string, it: Intent): void {
    const p = this.playerRound(pid);
    if (!p) return;
    const t = this.world.time;
    const cfg = this.cfg;

    if (it.k === 'next') {
      if (pid === this.hostPid && this.phase === 'results') this.advanceAfterResults();
      return;
    }
    if (it.k === 'rematch') {
      if (pid === this.hostPid && this.phase === 'match_end') this.rematch();
      return;
    }
    if (it.k === 'accuse') {
      if (this.phase !== 'accuse' || it.eid === p.eid) return;
      const e = this.world.get(it.eid);
      if (!e || !e.alive) return;
      p.accused = it.eid;
      p.accusedAsGhost = !p.alive;
      return;
    }
    if (this.phase !== 'play' || !p.alive) return;
    const e = this.world.get(p.eid)!;

    switch (it.k) {
      case 'autopilot': {
        if (it.on === p.autopilot) return;
        p.autopilot = it.on;
        if (it.on) this.bots.add(p.eid, t, { quirky: false });
        else {
          this.bots.remove(p.eid);
          this.emit({ t: 'stop', eid: p.eid, at: t });
        }
        return;
      }
      case 'crowd': {
        const c = this.world.crowd;
        if (!c || p.crowdAnswered === c.warnAt) return;
        // игрок по сети видит мир с опозданием: судим по тому, что было на его экране
        const wt = Math.max(t - LAG_GRACE_MS, Math.min(t, it.wt ?? t));
        if (wt < c.showAt || wt > c.windowEnd || t > c.windowEnd + LAG_GRACE_MS) return;
        p.crowdAnswered = c.warnAt;
        if (wt < c.resumeAt) {
          const [a, b] = cfg.botCrowdReactMs;
          // нажал в стоп-кадре — выполнит вместе с толпой (или сразу, если пакет пришёл уже после паузы)
          p.crowdQueued = { kind: it.kind, at: Math.max(t, c.resumeAt + crowdJitter(this.rng, a, b)) };
        } else {
          this.emit({ t: 'act', eid: p.eid, kind: CROWD_ACT[it.kind], dur: crowdActDur(cfg, it.kind), at: t });
        }
        return;
      }
    }
    if (t < p.stunUntil) {
      if (it.k === 'attack') this.notices.push({ t: 'denied', pid, reason: 'stunned' });
      return;
    }
    if (p.autopilot && it.k !== 'emote') {
      if (it.k === 'attack') this.notices.push({ t: 'denied', pid, reason: 'autopilot' });
      return;
    }
    switch (it.k) {
      case 'move': {
        const zone = this.world.zoneRect(t);
        const target = zone ? clampToRect(zone, it.x, it.y, 2) : { x: it.x, y: it.y };
        const path = planPath(this.world, p.eid, target.x, target.y, zone);
        if (path && path.length) this.emit({ t: 'move', eid: p.eid, path, at: t });
        return;
      }
      case 'stop':
        this.emit({ t: 'stop', eid: p.eid, at: t });
        return;
      case 'emote': {
        const kind: ActKind = it.kind && EMOTES.includes(it.kind) ? it.kind : this.rng.pick<ActKind>(EMOTES);
        this.emit({ t: 'act', eid: p.eid, kind, dur: emoteDur(kind), at: t });
        return;
      }
      case 'attack':
        // момент мира на экране нападавшего (не раньше LAG_GRACE_MS назад)
        this.attack(p, it.eid, e.x, e.y, Math.max(t - LAG_GRACE_MS, Math.min(t, it.wt ?? t)));
        return;
    }
  }

  private recordPositions(): void {
    const pos = new Map<number, [number, number]>();
    for (const e of this.world.entities) if (e.alive) pos.set(e.eid, [e.x, e.y]);
    this.posHist.push({ t: this.world.time, pos });
    while (this.posHist.length && this.posHist[0].t < this.world.time - LAG_GRACE_MS - 100) this.posHist.shift();
  }

  /** Где была сущность в момент мира t (последний записанный шаг не позже t). */
  private posAt(eid: number, t: number): [number, number] | null {
    for (let i = this.posHist.length - 1; i >= 0; i--) if (this.posHist[i].t <= t) return this.posHist[i].pos.get(eid) ?? null;
    return null;
  }

  private attack(p: PlayerRound, target: number, ax: number, ay: number, view?: number): void {
    const cfg = this.cfg;
    const t = this.world.time;
    if (p.attacksLeft <= 0) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'no_attacks' });
      return;
    }
    const te = this.world.get(target);
    if (!te || !te.alive || target === p.eid) return;
    const reach = (x: number, y: number) => Math.hypot(x - ax, y - ay) <= cfg.attackRange + 1;
    // цель в радиусе сейчас или там, где её видел нападавший (его персонаж у хоста уже там, где был на его экране)
    const seen = view !== undefined && view < t ? this.posAt(target, view) : null;
    if (!reach(te.x, te.y) && !(seen && reach(seen[0], seen[1]))) {
      this.notices.push({ t: 'denied', pid: p.pid, reason: 'out_of_range' });
      return;
    }
    p.attacksLeft--;
    const victim = this.pr.find((v) => v.eid === target && v.alive);
    const hx = te.x;
    const hy = te.y;
    if (victim) {
      victim.alive = false;
      victim.diedAt = t;
      p.kills++;
      p.killTimes.push(t);
      this.matchKills[p.pid]++;
      this.addScore(p.pid, cfg.points.kill, 'kill');
      const key = [p.pid, victim.pid].sort().join('|');
      const n = this.neighbors.get(key);
      if (n) n.hit = true;
      if (victim.autopilot) this.bots.remove(victim.eid);
      this.emit({ t: 'hit', target, result: 'player', x: hx, y: hy, at: t });
    } else {
      p.botHits++;
      p.stunUntil = t + cfg.missStunSec * 1000;
      this.bots.remove(target);
      this.emit({ t: 'hit', target, result: 'bot', x: hx, y: hy, attacker: p.eid, at: t });
    }
    this.emit({ t: 'remove', eid: target, cause: victim ? 'player' : 'bot', at: t });
    this.notices.push({ t: 'attack', pid: p.pid, target, result: victim ? 'player' : 'bot', at: t });
    // испуг соседей маскирует нападающего
    for (const o of this.world.alive()) {
      if (o.eid === target) continue;
      if (!victim && o.eid === p.eid) continue;
      const dx = o.x - hx;
      const dy = o.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > cfg.startleRadius) continue;
      const k = d > 0.01 ? cfg.startleStepPx / d : 0;
      const dur = cfg.startleSec * 1000;
      this.emit({ t: 'act', eid: o.eid, kind: 'startle', dur, dx: dx * k, dy: dy * k, at: t });
      this.bots.interrupt(o.eid, t + dur);
    }
    if (!victim) {
      this.emit({ t: 'act', eid: p.eid, kind: 'stun', dur: cfg.missStunSec * 1000, at: t });
      this.emit({ t: 'mark', eid: p.eid, until: t + cfg.missMarkSec * 1000, at: t });
    }
  }
}
