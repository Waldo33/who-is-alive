import { AiPlayer, LocalSession, MatchSim, TICK_MS, hasSanity, makeConfig, slotOutcomeIndex, slotSymbolIndex } from '@kto/game-core';
import type { ClientSession, GameConfig, Intent, Notice, PlayerInfo, WorldEvent } from '@kto/game-core';
import { GuestMsg, SNAP_SCALE } from './protocol';
import type { MeMsg, PrivateMsg, RoomMsg } from './protocol';
import type { Transport } from './transport';

/** Полный снимок мира одному игроку — не чаще, мс (M6). */
export const RESYNC_MIN_MS = 2000;

export interface HostOptions {
  transport: Transport;
  players: PlayerInfo[];
  cfg: Partial<GameConfig>;
  seed: number;
  /** Режиссёр (жмёт «Дальше» и «Ещё дубль»). */
  hostPid: string;
  /**
   * Кто смотрит на этот экран. По умолчанию — режиссёр (хост на телефоне). Безголовый хост
   * на сервере передаёт id, которого нет среди игроков: тогда все игроки — удалённые.
   */
  selfPid?: string;
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
  private lastKm = new Map<string, string>();
  private lastKmN = new Map<string, number>();
  private lastMeAt = new Map<string, number>();
  /**
   * Полный снимок мира по просьбе гостя — не чаще раза в RESYNC_MIN_MS на игрока: иначе 30 просьб в секунду
   * от одного клиента грузят канал и процессор сервера (ревью безопасности, M6). Просьба раньше срока не
   * теряется — снимок уйдёт, как только срок выйдет.
   */
  private lastResyncAt = new Map<string, number>();
  private resyncDue = new Set<string>();
  private lastSentWt = -1;
  private unsub: (() => void) | null = null;
  private readonly cfgOverrides: Partial<GameConfig>;
  /** Отправлено сообщений (для оценки нагрузки). */
  sent = 0;

  constructor(opts: HostOptions) {
    this.t = opts.transport;
    this.cfgOverrides = opts.cfg;
    this.seed = opts.seed;
    this.sim = new MatchSim(makeConfig(opts.cfg), opts.players, opts.seed, opts.hostPid);
    if (opts.resume) this.sim.resumeMatch(opts.resume);
    // ИИ-актёры (добор комнаты до 4): играют здесь, у хоста, и видят только то, что видно всем
    opts.players.forEach((p, i) => {
      if (p.ai) this.sim.addAgent(new AiPlayer(p.pid, (opts.seed >>> 0) + 101 + i * 7919));
    });
    this.local = new LocalSession(this.sim, opts.selfPid ?? opts.hostPid, opts.seed, { ai: false });
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
  /** «Казино»: вращения игроков этого дубля — только для сервера (клип выбывшего), в сеть не уходят. */
  get spins() { return this.sim.spins; }
  get match() { return this.local.match; }
  get roundsPlayed() { return this.local.roundsPlayed; }
  get myMatchKills() { return this.local.myMatchKills; }
  get roundAwards() { return this.local.roundAwards; }
  me() { return this.local.me(); }
  otherStars() { return this.local.otherStars(); }
  info(pid: string) { return this.local.info(pid); }
  timeLeft() { return this.local.timeLeft(); }
  crowdWindowOpen(t?: number) { return this.local.crowdWindowOpen(t); }
  ghostClapOpen(t?: number) { return this.local.ghostClapOpen(t); }
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

  /** Сервер: режиссёр ушёл — роль у следующего. */
  setDirector(pid: string): void {
    this.sim.hostPid = pid;
  }

  /** ИИ, которые играют за ушедших игроков (по pid места): вернётся игрок — тот же ИИ ждёт следующего раза. */
  private standIns = new Map<string, AiPlayer>();
  private seed: number;

  /** Сервер: игрок ушёл посреди матча — за его место играет ИИ (очки копятся тому же месту). */
  botTakeover(pid: string): boolean {
    const i = this.sim.players.findIndex((p) => p.pid === pid);
    if (i < 0 || this.sim.players[i].ai) return false;
    let a = this.standIns.get(pid);
    if (!a) this.standIns.set(pid, (a = new AiPlayer(pid, (this.seed >>> 0) + 977 + i * 7919 + this.standIns.size * 31)));
    this.sim.players[i] = { ...this.sim.players[i], ai: true };
    this.sim.addAgent(a);
    this.sendPlayers();
    return true;
  }

  /** Сервер: ушедший вернулся — ИИ отдаёт ему управление. */
  humanBack(pid: string): boolean {
    const i = this.sim.players.findIndex((p) => p.pid === pid);
    if (i < 0 || !this.sim.players[i].ai || !this.standIns.has(pid)) return false;
    this.sim.removeAgent(pid);
    const { ai: _ai, ...rest } = this.sim.players[i];
    void _ai;
    this.sim.players[i] = rest;
    this.sendPlayers();
    return true;
  }

  /**
   * Сервер: новый игрок занимает место ИИ посреди матча. Сущность, очки и история — от места;
   * выбит ли персонаж в этом дубле — тоже (тогда новичок до конца дубля за кадром).
   */
  takeSeat(oldPid: string, info: PlayerInfo): boolean {
    const p = this.sim.info(oldPid);
    if (!p?.ai) return false;
    if (!this.sim.replacePlayer(oldPid, { pid: info.pid, name: info.name, color: p.color })) return false;
    this.standIns.delete(oldPid);
    for (const m of [this.lastMe, this.lastKm, this.lastKmN, this.lastMeAt]) m.delete(oldPid);
    this.sendPlayers();
    return true;
  }

  /** Места, которые сейчас ведёт ИИ (и добранные режиссёром, и за ушедших). */
  aiSeats(): string[] {
    return this.sim.players.filter((p) => p.ai).map((p) => p.pid);
  }

  /** Ведёт ли ИИ место ушедшего игрока (а не добранное режиссёром). */
  isStandIn(pid: string): boolean {
    return this.standIns.has(pid) && !!this.sim.info(pid)?.ai;
  }

  private sendPlayers(): void {
    this.send({ t: 'players', players: this.sim.players.map((p) => ({ ...p })) });
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
    else if (m.t === 'resync') this.askResync(from);
  }

  private askResync(pid: string): void {
    const last = this.lastResyncAt.get(pid);
    if (last !== undefined && this.sim.now - last < RESYNC_MIN_MS) {
      this.resyncDue.add(pid);
      return;
    }
    this.lastResyncAt.set(pid, this.sim.now);
    this.resyncDue.delete(pid);
    this.sendResync(pid);
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
      ...(hasSanity(this.sim.theme) ? { sanity: Math.ceil(p.sanity), sins: p.sins } : {}),
      ...(p.slot
        ? {
            sl: [p.slot.at, slotOutcomeIndex(p.slot.spins[0].outcome), ...p.slot.spins[0].reels.map(slotSymbolIndex)] as [number, number, number, number, number],
            s3: [p.slot.at, ...p.slot.spins.flatMap((s) => [slotOutcomeIndex(s.outcome), ...s.reels.map(slotSymbolIndex)])],
          }
        : {}),
      ...(p.peek && this.sim.world.time < p.peek.until ? { pk: [p.peek.eid, p.peek.until] as [number, number] } : {}),
      ...(p.kiki.length ? { km: p.kiki.map((k) => [k.id, Math.round(k.x), Math.round(k.y), this.sim.world.time < k.at ? 1 : 0] as [number, number, number, number]) } : {}),
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
      hostId: this.sim.hostPid,
      ...(this.sim.summary ? { summary: this.sim.summary, awards: this.sim.roundAwards } : {}),
      ...(this.sim.match ? { match: this.sim.match } : {}),
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
    for (const pid of this.resyncDue) if (now - (this.lastResyncAt.get(pid) ?? 0) >= RESYNC_MIN_MS) this.askResync(pid);
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
      // кикиморы двигаются каждый шаг — их позиции шлём не чаще раза в cmdBatchMs (клиент дорисует ход сам)
      const { km, ...rest } = me;
      const key = JSON.stringify(rest);
      const kmKey = JSON.stringify(km ?? null);
      const moved = kmKey !== this.lastKm.get(p.pid) && now - (this.lastMeAt.get(p.pid) ?? -Infinity) >= s.cfg.cmdBatchMs;
      const appeared = (km?.length ?? 0) !== (this.lastKmN.get(p.pid) ?? 0);
      if (this.lastMe.get(p.pid) !== key || moved || appeared) {
        this.lastMe.set(p.pid, key);
        this.lastKm.set(p.pid, kmKey);
        this.lastKmN.set(p.pid, km?.length ?? 0);
        this.lastMeAt.set(p.pid, now);
        this.sendTo(p.pid, { t: 'me', me });
      }
    }
  }

  private lastSent(now: number, force: boolean): void {
    if (force) this.lastBatch = now - TICK_MS;
  }
}
