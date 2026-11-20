import { NavGrid, TICK_MS, World, makeConfig, planPath, plazaArena } from '@kto/game-core';
import type {
  ArenaDef,
  AwardCard,
  ClientSession,
  GameConfig,
  Intent,
  MatchSummary,
  MeView,
  Notice,
  Phase,
  PlayerInfo,
  RoundSummary,
  WorldEvent,
} from '@kto/game-core';
import { SNAP_SCALE } from './protocol';
import type { MeMsg, PrivateMsg, RoomMsg } from './protocol';
import type { Transport } from './transport';

type St = Extract<RoomMsg, { t: 'st' }> & { wt?: number };

export interface RemoteOptions {
  transport: Transport;
  selfPid: string;
  hostPid: string;
  players: PlayerInfo[];
  cfg: Partial<GameConfig>;
  /** Источник времени (мс, монотонный) — подменяется в тестах. */
  clock?: () => number;
  /** Сразу запросить снимок у хоста (переподключение). */
  resync?: boolean;
}

/** Запас поверх интервала пакетов: насколько отстаёт отрисовка от последних данных хоста. */
const JITTER_MS = 120;
const OFFSET_WINDOW = 40;

/**
 * Гость: мир строится только из событий хоста. Гость не знает, какие сущности — игроки:
 * кроме своей (личный канал) это приходит лишь в итогах раунда после обвинения.
 */
export class RemoteSession implements ClientSession {
  readonly selfPid: string;
  hostPid: string;
  readonly cfg: GameConfig;
  readonly arena: ArenaDef;
  readonly world: World;
  players: PlayerInfo[];
  phase: Phase = 'countdown';
  round = 0;
  theme = 0;
  now = 0;
  scores: Record<string, number> = {};
  summary: RoundSummary | null = null;
  match: MatchSummary | null = null;
  roundsPlayed = 0;
  roundAwards: AwardCard[][] = [];
  private meMsg: MeMsg | null = null;
  private notices: Notice[] = [];
  private stQueue: St[] = [];
  private tl = 0;
  private tlAt = 0;
  private ppe = 0;
  private lastHostWt = 0;
  private running = false;
  private offsets: number[] = [];
  private snap: { wt: number; p: [number, number, number][] } | null = null;
  private predicted: { cell: number; until: number } | null = null;
  private readonly t: Transport;
  private readonly clock: () => number;
  private unsub: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Оценка задержки сети (половина RTT), мс. */
  latency = 0;
  /** Сколько шагов мира пришлось догонять или ждать — для отладки плавности. */
  stalls = 0;

  constructor(o: RemoteOptions) {
    this.t = o.transport;
    this.selfPid = o.selfPid;
    this.hostPid = o.hostPid;
    this.players = o.players;
    this.cfg = makeConfig(o.cfg);
    this.arena = plazaArena(this.cfg.arenaWidth, this.cfg.arenaHeight);
    this.world = new World(new NavGrid(this.arena, this.cfg.navCellSize), this.cfg.entitySpeed);
    this.clock = o.clock ?? (() => performance.now());
    for (const p of this.players) this.scores[p.pid] = 0;
    this.unsub = this.t.onMessage((ch, msg, from) => {
      if (from !== this.hostPid) return;
      if (ch === 'room') this.onRoom(msg as RoomMsg);
      else if (ch === 'private') this.onPrivate(msg as PrivateMsg);
    });
    this.pingTimer = setInterval(() => this.ping(), 10_000);
    for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 150);
    if (o.resync) void this.t.send('host', { t: 'resync' });
  }

  /** Хост сменился: принимать сообщения от нового. */
  setHost(pid: string): void {
    this.hostPid = pid;
  }

  private ping(): void {
    void this.t.send('host', { t: 'ping', c: this.clock() });
  }

  private noteOffset(wt: number): void {
    this.offsets.push(wt - this.clock());
    if (this.offsets.length > OFFSET_WINDOW) this.offsets.shift();
  }

  private onRoom(m: RoomMsg): void {
    switch (m.t) {
      case 'round':
        this.world.init(m.spawns, m.t0);
        this.round = m.round;
        this.theme = m.theme;
        this.summary = null;
        this.snap = null;
        this.predicted = null;
        this.offsets = [];
        this.lastHostWt = m.t0;
        this.noteOffset(m.t0);
        this.notices.push({ t: 'round_start', round: m.round, theme: m.theme });
        break;
      case 'ev': {
        this.lastHostWt = Math.max(this.lastHostWt, m.wt);
        this.running = m.run;
        this.noteOffset(m.wt);
        for (const ev of m.ev) {
          if (this.dropPredicted(ev)) continue;
          this.world.push(ev);
        }
        break;
      }
      case 'snap':
        this.snap = m;
        break;
      case 'st':
        this.stQueue.push(m);
        break;
      case 'reveal':
        this.summary = m.summary;
        this.roundAwards = m.awards;
        break;
      case 'match_end':
        this.match = m.match;
        break;
      default:
        break;
    }
  }

  private onPrivate(m: PrivateMsg): void {
    switch (m.t) {
      case 'me':
        this.meMsg = m.me;
        break;
      case 'denied':
        this.notices.push({ t: 'denied', pid: this.selfPid, reason: m.reason });
        break;
      case 'pong': {
        const rtt = this.clock() - m.c;
        this.latency = this.latency ? Math.min(this.latency * 0.8 + (rtt / 2) * 0.2, rtt / 2 + 50) : rtt / 2;
        break;
      }
      case 'resync':
        this.world.restore(m.world);
        this.round = m.round;
        this.theme = m.theme;
        this.meMsg = m.me;
        this.lastHostWt = m.world.time;
        this.offsets = [];
        this.noteOffset(m.world.time);
        this.players = m.players;
        this.stQueue.push(m.st);
        this.notices.push({ t: 'round_start', round: m.round, theme: m.theme });
        break;
    }
  }

  /** Своё движение уже предсказано локально — подтверждение хоста с той же целью пропускаем. */
  private dropPredicted(ev: WorldEvent): boolean {
    const pr = this.predicted;
    const me = this.meMsg;
    if (!pr || !me || ev.t !== 'move' || ev.eid !== me.eid) return false;
    if (this.clock() > pr.until) {
      this.predicted = null;
      return false;
    }
    if (ev.path[ev.path.length - 1] === pr.cell) {
      this.predicted = null;
      return true;
    }
    return false;
  }

  private applySt(st: St): void {
    if (st.phase !== this.phase) {
      this.phase = st.phase;
      this.notices.push({ t: 'phase', phase: st.phase, at: this.now });
    }
    this.round = st.round;
    this.theme = st.theme;
    this.tl = st.tl;
    this.tlAt = this.clock();
    this.ppe = st.ppe;
    this.scores = st.scores;
    this.roundsPlayed = st.played;
  }

  /** Сколько мира гость может показать: отстаёт от хоста на интервал пакетов + запас, но не дальше полученного. */
  private targetTime(): number {
    if (!this.running) return this.lastHostWt;
    const off = this.offsets.length ? Math.max(...this.offsets) : this.lastHostWt - this.clock();
    const est = this.clock() + off - this.cfg.cmdBatchMs - JITTER_MS;
    return Math.min(est, this.lastHostWt);
  }

  tick(): void {
    this.now += TICK_MS;
    const target = this.targetTime();
    let steps = 0;
    const behind = target - this.world.time;
    const maxSteps = behind > 2000 ? 60 : 2;
    while (this.world.time + TICK_MS <= target && steps < maxSteps) {
      this.world.step();
      steps++;
      if (this.snap && this.world.time >= this.snap.wt) this.applySnap();
    }
    if (steps === 0 && this.running) this.stalls++;
    // фазы применяются, когда мир гостя дошёл до момента смены (иначе обвинение начнётся раньше, чем замер мир)
    while (this.stQueue.length) {
      const st = this.stQueue[0];
      const due = st.wt === undefined || this.world.time >= st.wt || !this.running || this.clock() - this.tlAt > 1500;
      if (!due) break;
      this.applySt(this.stQueue.shift()!);
    }
  }

  private applySnap(): void {
    const s = this.snap!;
    this.snap = null;
    if (this.world.time !== s.wt) return;
    const myEid = this.meMsg?.eid ?? -1;
    for (const [eid, x100, y100] of s.p) {
      const e = this.world.get(eid);
      if (!e || !e.alive) continue;
      const x = x100 / SNAP_SCALE;
      const y = y100 / SNAP_SCALE;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < 0.02) continue;
      if (eid === myEid && d < 8) continue; // своё движение предсказано — мелкие расхождения не дёргаем
      e.x = x;
      e.y = y;
    }
  }

  me(): MeView | undefined {
    const m = this.meMsg;
    if (!m) return undefined;
    return {
      eid: m.eid,
      alive: m.alive,
      attacksLeft: m.attacksLeft,
      stars: m.stars,
      stunUntil: m.stunUntil,
      autopilot: m.autopilot,
      crowdAnswered: m.crowdAnswered,
      accused: m.accused,
    };
  }

  get myMatchKills(): number {
    return this.meMsg?.kills ?? 0;
  }

  otherStars(): number[] {
    return this.meMsg?.others ?? [];
  }

  info(pid: string): PlayerInfo | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  timeLeft(): number {
    if (this.phase === 'play') {
      const c = this.world.crowd;
      const pause = c && this.world.isFrozen() ? c.resumeAt - this.world.time : 0;
      return Math.max(0, this.ppe - this.world.time - pause);
    }
    return Math.max(0, this.tl - (this.clock() - this.tlAt));
  }

  crowdWindowOpen(t = this.world.time): boolean {
    const c = this.world.crowd;
    return !!c && t >= c.showAt && t <= c.windowEnd;
  }

  intent(it: Intent): void {
    let out: Intent = it;
    if (it.k === 'crowd' || it.k === 'attack') out = { ...it, wt: this.world.time };
    const me = this.meMsg;
    // предсказание своего движения: начать идти сразу, не дожидаясь хоста
    if (me && me.alive && this.phase === 'play' && !me.autopilot && this.world.time >= me.stunUntil) {
      const e = this.world.get(me.eid);
      if (e && (!e.act || e.act === 'stun')) {
        if (it.k === 'move') {
          const path = planPath(this.world, me.eid, it.x, it.y, this.world.zoneRect());
          if (path && path.length && !this.world.isFrozen()) {
            this.world.push({ t: 'move', eid: me.eid, path, at: this.world.time });
            this.predicted = { cell: path[path.length - 1], until: this.clock() + 1500 };
          }
        } else if (it.k === 'stop') {
          this.world.push({ t: 'stop', eid: me.eid, at: this.world.time });
        }
      }
    }
    void this.t.send('host', { t: 'i', i: out });
  }

  drainNotices(): Notice[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  onWorldEvent(fn: (ev: WorldEvent) => void): void {
    this.world.listeners.push(fn);
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.world.listeners.length = 0;
  }
}
