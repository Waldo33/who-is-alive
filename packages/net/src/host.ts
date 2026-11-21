import { LocalSession, MatchSim, TICK_MS, makeConfig } from '@kto/game-core';
import type { ClientSession, GameConfig, Intent, Notice, PlayerInfo, WorldEvent } from '@kto/game-core';
import { GuestMsg, SNAP_SCALE } from './protocol';
import type { MeMsg, PrivateMsg, RoomMsg } from './protocol';
import type { Transport } from './transport';

export interface HostOptions {
  transport: Transport;
  players: PlayerInfo[];
  cfg: Partial<GameConfig>;
  seed: number;
  hostPid: string;
  /** Продолжение матча после смены хоста. */
  resume?: { scores: Record<string, number>; round: number };
}

/**
 * Хост: авторитетная симуляция на этом устройстве (раздел 12) + рассылка.
 * Для своего экрана хост — обычная локальная сессия; гостям уходят только события мира,
 * фазы и счёт в общий канал, а «кто ты» — каждому в личный.
 */
export class HostSession implements ClientSession {
  readonly sim: MatchSim;
  private readonly local: LocalSession;
  private readonly t: Transport;
  private pending: WorldEvent[] = [];
  private notices: Notice[] = [];
  private lastBatch = -Infinity;
  private lastSnap = -Infinity;
  private lastSt = -Infinity;
  private lastPhase = '';
  private lastRound = -1;
  private lastMe = new Map<string, string>();
  private lastSentWt = -1;
  private unsub: (() => void) | null = null;
  private readonly cfgOverrides: Partial<GameConfig>;
  /** Отправлено сообщений (для оценки нагрузки). */
  sent = 0;

  constructor(opts: HostOptions) {
    this.t = opts.transport;
    this.cfgOverrides = opts.cfg;
    this.sim = new MatchSim(makeConfig(opts.cfg), opts.players, opts.seed, opts.hostPid);
    if (opts.resume) this.sim.resumeMatch(opts.resume);
    this.local = new LocalSession(this.sim, opts.hostPid, opts.seed, { ai: false });
    this.sim.world.listeners.push((ev) => this.pending.push(ev));
    this.unsub = this.t.onMessage((ch, msg, from) => {
      if (ch === 'host') this.onGuest(from, msg);
    });
    this.afterTick();
  }

  // ───────────── ClientView: делегирование своей локальной сессии ─────────────
  get selfPid() { return this.local.selfPid; }
  get hostPid() { return this.local.hostPid; }
  get cfg() { return this.local.cfg; }
  get arena() { return this.local.arena; }
  get world() { return this.local.world; }
  get players() { return this.local.players; }
  get phase() { return this.local.phase; }
  get round() { return this.local.round; }
  get theme() { return this.local.theme; }
  get mod() { return this.local.mod; }
  get now() { return this.local.now; }
  get scores() { return this.local.scores; }
  get summary() { return this.local.summary; }
  get match() { return this.local.match; }
  get roundsPlayed() { return this.local.roundsPlayed; }
  get myMatchKills() { return this.local.myMatchKills; }
  get roundAwards() { return this.local.roundAwards; }
  me() { return this.local.me(); }
  otherStars() { return this.local.otherStars(); }
  info(pid: string) { return this.local.info(pid); }
  timeLeft() { return this.local.timeLeft(); }
  crowdWindowOpen(t?: number) { return this.local.crowdWindowOpen(t); }
  crowdCanStart(t?: number) { return this.local.crowdCanStart(t); }
  onWorldEvent(fn: (ev: WorldEvent) => void) { this.local.onWorldEvent(fn); }

  intent(it: Intent): void {
    this.local.intent(it);
  }

  tick(): void {
    this.local.tick();
    this.afterTick();
  }

  drainNotices(): Notice[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  // ───────────── сеть ─────────────

  private send(msg: RoomMsg): void {
    this.sent++;
    void this.t.send('room', msg);
  }

  private sendTo(pid: string, msg: PrivateMsg): void {
    this.sent++;
    void this.t.send('private', msg, pid);
  }

  private onGuest(from: string, raw: unknown): void {
    if (!this.sim.info(from) || from === this.selfPid) return;
    const parsed = GuestMsg.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.t === 'i') this.sim.intent(from, m.i as Intent);
    else if (m.t === 'ping') this.sendTo(from, { t: 'pong', c: m.c, wt: this.sim.world.time });
    else if (m.t === 'resync') this.sendResync(from);
  }

  private meFor(pid: string): MeMsg | null {
    const p = this.sim.playerRound(pid);
    if (!p) return null;
    return {
      eid: p.eid,
      alive: p.alive,
      attacksLeft: p.attacksLeft,
      stars: p.stars,
      stunUntil: p.stunUntil,
      autopilot: p.autopilot,
      crowdAnswered: p.crowdAnswered,
      accused: p.accused,
      others: this.sim.pr.filter((o) => o.pid !== pid).map((o) => o.stars).sort((a, b) => b - a),
      kills: this.sim.matchKills[pid] ?? 0,
      clapsLeft: p.clapsLeft,
      clapAt: p.clapAt,
    };
  }

  private stMsg(): Extract<RoomMsg, { t: 'st' }> & { wt: number } {
    const s = this.sim;
    return {
      t: 'st',
      phase: s.phase,
      round: s.round,
      theme: s.theme,
      mod: s.mod,
      tl: s.timeLeft(),
      ppe: s.plannedPlayEnd,
      scores: { ...s.scores },
      played: s.roundAwards.length,
      wt: s.world.time,
    };
  }

  private sendResync(pid: string): void {
    const me = this.meFor(pid);
    if (!me) return;
    this.sendTo(pid, {
      t: 'resync',
      world: this.sim.world.snapshot(),
      round: this.sim.round,
      theme: this.sim.theme,
      t0: this.sim.world.time,
      me,
      st: this.stMsg(),
      players: [...this.sim.players],
      cfg: this.cfgOverrides,
      hostId: this.selfPid,
    });
    this.lastMe.delete(pid);
  }

  private afterTick(): void {
    const s = this.sim;
    // уведомления: отказы гостей — им лично, остальное — своему экрану
    for (const n of s.notices) {
      if (n.t === 'denied') {
        if (n.pid === this.selfPid) this.notices.push(n);
        else this.sendTo(n.pid, { t: 'denied', reason: n.reason });
      } else if (n.t === 'attack') {
        // итог удара — лично нападавшему: он увидит «поф» сразу, а не когда мир на его экране дойдёт до удара
        if (n.pid !== this.selfPid) this.sendTo(n.pid, { t: 'atk', target: n.target, result: n.result, at: n.at });
      } else if (n.t !== 'score') this.notices.push(n);
    }
    s.notices = [];

    const now = s.now;
    // новый раунд: мир только что создан — отправить расстановку (без указания, кто игрок)
    if (s.round !== this.lastRound) {
      this.lastRound = s.round;
      this.pending = [];
      this.send({
        t: 'round',
        round: s.round,
        theme: s.theme,
        mod: s.mod,
        t0: s.world.time,
        spawns: s.world.entities.map((e) => ({ eid: e.eid, x: e.x, y: e.y, dir: e.dir })),
      });
      this.lastMe.clear();
      this.lastSent(now, true);
    }

    const phaseChanged = s.phase !== this.lastPhase;
    const running = s.phase === 'countdown' || s.phase === 'play';
    if (this.pending.length || now - this.lastBatch >= s.cfg.cmdBatchMs || phaseChanged) {
      if (this.pending.length || s.world.time !== this.lastSentWt || now - this.lastBatch >= 1000 || phaseChanged) {
        this.send({ t: 'ev', wt: s.world.time, run: running, ev: this.pending });
        this.pending = [];
        this.lastSentWt = s.world.time;
      }
      this.lastBatch = now;
    }

    if (s.phase === 'play' && now - this.lastSnap >= s.cfg.snapEveryMs) {
      this.lastSnap = now;
      this.send({
        t: 'snap',
        wt: s.world.time,
        p: s.world.entities.filter((e) => e.alive).map((e) => [e.eid, Math.round(e.x * SNAP_SCALE), Math.round(e.y * SNAP_SCALE)]),
      });
    }

    if (phaseChanged) {
      if (s.phase === 'reveal' && s.summary) this.send({ t: 'reveal', summary: s.summary, awards: s.roundAwards });
      if (s.phase === 'match_end' && s.match) this.send({ t: 'match_end', match: s.match });
    }

    if (phaseChanged || now - this.lastSt >= 500) {
      this.lastSt = now;
      this.lastPhase = s.phase;
      this.send(this.stMsg());
    }

    for (const p of s.players) {
      if (p.pid === this.selfPid) continue;
      const me = this.meFor(p.pid);
      if (!me) continue;
      const key = JSON.stringify(me);
      if (this.lastMe.get(p.pid) !== key) {
        this.lastMe.set(p.pid, key);
        this.sendTo(p.pid, { t: 'me', me });
      }
    }
  }

  private lastSent(now: number, force: boolean): void {
    if (force) this.lastBatch = now - TICK_MS;
  }
}
