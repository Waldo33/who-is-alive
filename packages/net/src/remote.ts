import { NavGrid, TICK_MS, World, clampToRect, emoteDur, makeConfig, planPath, plazaArena } from '@kto/game-core';
import type {
  ArenaDef,
  AwardCard,
  ClientSession,
  EmoteKind,
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
/** Расхождение своего персонажа с хостом, которое считаем шумом (пикс.): дальше — плавно поправляем. */
const OWN_TOLERANCE = 6;
/** Больше этого — уже не «догонялки», а другое место: переносим сразу. */
const OWN_TELEPORT = 48;
/** Доля оставшейся поправки за шаг мира (50 мс): ~0,3 с на всю поправку. */
const OWN_BLEND = 0.2;
/** Не больше этого за шаг (пикс.): 12 пикс./с — заметно медленнее ходьбы (18 пикс./с). */
const OWN_MAX_STEP = 0.6;
const EMOTES: EmoteKind[] = ['wave', 'dance', 'jump'];

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
  /**
   * Свой персонаж гость ведёт сам (предсказание), как в сетевых играх: команды хоста на шаги
   * своего персонажа не применяются, а снимки хоста сверяются с собственной историей
   * со сдвигом lead — на столько свой персонаж живёт впереди остального мира.
   */
  private own: { t: number; x: number; y: number }[] = [];
  private lead = 0;
  private corr: { x: number; y: number } | null = null;
  private lastPred: { at: number; cell: number } | null = null;
  private lastPredClock = -1e9;
  private lastAuth: { x: number; y: number } | null = null;
  private emotePred: { kind: string; until: number } | null = null;
  /** События, которые гость положил в мир сам (предсказание) — фильтр их пропускает. */
  private local = new WeakSet<WorldEvent>();
  /** До этого момента шагами своего персонажа управляет хост (автопилот и сразу после него). */
  private hostDrivenUntil = 0;
  private readonly t: Transport;
  private readonly clock: () => number;
  private unsub: (() => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Оценка задержки сети (половина RTT), мс. */
  latency = 0;
  /** Сколько шагов мира пришлось догонять или ждать — для отладки плавности. */
  stalls = 0;
  /** Запас задержки: растёт, если данные хоста не успевают, и медленно сокращается. */
  private jitter = JITTER_MS;

  constructor(o: RemoteOptions) {
    this.t = o.transport;
    this.selfPid = o.selfPid;
    this.hostPid = o.hostPid;
    this.players = o.players;
    this.cfg = makeConfig(o.cfg);
    this.arena = plazaArena(this.cfg.arenaWidth, this.cfg.arenaHeight);
    this.world = new World(new NavGrid(this.arena, this.cfg.navCellSize), this.cfg.entitySpeed);
    this.clock = o.clock ?? (() => performance.now());
    this.world.filter = (ev) => this.keepEvent(ev);
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
        this.resetOwn();
        this.offsets = [];
        this.lastHostWt = m.t0;
        this.noteOffset(m.t0);
        this.notices.push({ t: 'round_start', round: m.round, theme: m.theme });
        break;
      case 'ev': {
        this.lastHostWt = Math.max(this.lastHostWt, m.wt);
        this.running = m.run;
        this.noteOffset(m.wt);
        for (const ev of m.ev) this.world.push(ev);
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
        if (this.meMsg?.autopilot && !m.me.autopilot) this.hostDrivenUntil = this.clock() + 3000;
        if (m.me.autopilot) this.hostDrivenUntil = Math.max(this.hostDrivenUntil, this.clock() + 3000);
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
        this.resetOwn();
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

  private resetOwn(): void {
    this.own = [];
    this.corr = null;
    this.lastAuth = null;
    this.lastPred = null;
    this.emotePred = null;
  }

  /** Применять ли событие хоста в мире гостя: шаги своего персонажа гость уже показал сам. */
  private keepEvent(ev: WorldEvent): boolean {
    if (this.local.has(ev)) return true;
    const me = this.meMsg;
    if (!me || !('eid' in ev) || ev.eid !== me.eid) return true;
    if (me.autopilot || this.clock() < this.hostDrivenUntil) return true;
    if (ev.t === 'move') {
      // подтверждение последнего нажатия: точный сдвиг между своим временем и временем хоста
      const lp = this.lastPred;
      if (lp && ev.path[ev.path.length - 1] === lp.cell && ev.at >= lp.at) {
        const d = ev.at - lp.at;
        this.lead = this.lead ? this.lead * 0.5 + d * 0.5 : d;
        this.lastPred = null;
      }
      return false;
    }
    if (ev.t === 'stop' || ev.t === 'face') return false;
    if (ev.t === 'act' && ev.kind !== 'stun' && this.emotePred && ev.kind === this.emotePred.kind && this.clock() < this.emotePred.until) {
      this.emotePred = null;
      return false;
    }
    return true;
  }

  /** Оценка текущего времени хоста. */
  private hostNow(): number {
    const off = this.offsets.length ? Math.max(...this.offsets) : this.lastHostWt - this.clock();
    return this.clock() + off;
  }

  /** На сколько свой персонаж впереди мира гостя: задержка показа + дорога до хоста. */
  private estimateLead(): number {
    return Math.max(0, this.hostNow() - this.world.time + this.latency * 2);
  }

  /** Где был свой персонаж в момент t по собственной истории. */
  private ownAt(t: number): { x: number; y: number } | null {
    const h = this.own;
    if (!h.length) return null;
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i];
    return h[0];
  }

  /** Снимок хоста про своего персонажа: сверка с историей и плавная поправка. */
  private reconcileOwn(e: { x: number; y: number; px: number; py: number; moving: boolean; path: number[]; pi: number }, ax: number, ay: number, wt: number): void {
    const prevAuth = this.lastAuth;
    this.lastAuth = { x: ax, y: ay };
    const authMoving = !prevAuth || Math.hypot(prevAuth.x - ax, prevAuth.y - ay) > 0.05;
    const idle = !e.moving && e.pi >= e.path.length && this.clock() - this.lastPredClock > this.lead + 300;
    if (idle && authMoving) return; // свой уже пришёл, а у хоста он ещё идёт (маршрут бывает длиннее) — ждём
    // оба стоят — сравниваем с текущим местом и добираем даже мелочь; на ходу — с историей со сдвигом lead
    const ref = idle ? e : this.ownAt(wt - this.lead) ?? e;
    const dx = ax - ref.x;
    const dy = ay - ref.y;
    const d = Math.hypot(dx, dy);
    if (d > OWN_TELEPORT) {
      e.x += dx;
      e.y += dy;
      e.px += dx;
      e.py += dy;
      this.corr = null;
      this.own = [];
      return;
    }
    if (d > (idle ? 0.05 : OWN_TOLERANCE)) this.corr = { x: dx, y: dy };
  }

  private applyCorrection(): void {
    const c = this.corr;
    const id = this.meMsg?.eid;
    const e = id === undefined ? undefined : this.world.get(id);
    if (!c || !e || !e.alive) {
      this.corr = null;
      return;
    }
    // поправка медленнее ходьбы: со стороны это лёгкая смена темпа, а не рывок
    const left = Math.hypot(c.x, c.y);
    const k = left <= OWN_MAX_STEP ? 1 : Math.min(OWN_BLEND, OWN_MAX_STEP / left);
    const sx = c.x * k;
    const sy = c.y * k;
    e.x += sx;
    e.y += sy;
    e.px += sx;
    e.py += sy;
    c.x -= sx;
    c.y -= sy;
    if (k === 1) this.corr = null;
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
    const est = this.clock() + off - this.cfg.cmdBatchMs - this.jitter;
    if (est > this.lastHostWt) this.jitter = Math.min(500, this.jitter + 15);
    else if (this.lastHostWt - est > 150) this.jitter = Math.max(JITTER_MS, this.jitter - 0.5);
    return est;
  }

  tick(): void {
    this.now += TICK_MS;
    const target = this.targetTime();
    // ровно один шаг мира на кадр; два — если отстали, ноль — если убежали вперёд.
    // Так нет дрожи 0-2-0-2 шага, когда время колеблется у границы шага.
    const err = target - this.world.time;
    let want = err > 2000 ? 60 : err > 120 ? 2 : err < -60 ? 0 : 1;
    const limit = this.running ? this.lastHostWt : target;
    let steps = 0;
    while (want-- > 0 && this.world.time + TICK_MS <= limit) {
      this.world.step();
      steps++;
      this.applyCorrection();
      this.recordOwn();
      if (this.snap && this.world.time >= this.snap.wt) this.applySnap();
    }
    if (steps === 0 && this.running) this.stalls++;
    // фазы применяются, когда мир гостя дошёл до момента смены (иначе обвинение начнётся раньше, чем замер мир)
    while (this.stQueue.length) {
      const st = this.stQueue[0];
      // итоги и конец матча показываем только вместе с данными для них
      const dataReady = (st.phase !== 'reveal' && st.phase !== 'results') || this.summary !== null;
      const matchReady = st.phase !== 'match_end' || this.match !== null;
      const due =
        (dataReady && matchReady && (st.wt === undefined || this.world.time >= st.wt || !this.running)) || this.clock() - this.tlAt > 3000;
      if (!due) break;
      this.applySt(this.stQueue.shift()!);
    }
  }

  private recordOwn(): void {
    const id = this.meMsg?.eid;
    const e = id === undefined ? undefined : this.world.get(id);
    if (!e) return;
    this.own.push({ t: this.world.time, x: e.x, y: e.y });
    if (this.own.length > 200) this.own.splice(0, this.own.length - 200);
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
      if (eid === myEid) {
        this.reconcileOwn(e, x, y, s.wt);
        continue;
      }
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
    // предсказание: показать своё действие сразу, если хост его примет (не автопилот, не оглушён к его приходу)
    const lead = this.estimateLead();
    const accepts = !!me && me.alive && this.phase === 'play' && !me.autopilot && this.hostNow() + this.latency >= me.stunUntil;
    const e = me ? this.world.get(me.eid) : undefined;
    if (accepts && e && e.alive) {
      if (it.k === 'move') {
        const zone = this.world.zoneRect(this.world.time + lead);
        const tgt = zone ? clampToRect(zone, it.x, it.y, 2) : { x: it.x, y: it.y };
        const path = planPath(this.world, me!.eid, tgt.x, tgt.y, zone);
        if (path && path.length) {
          this.pushLocal({ t: 'move', eid: me!.eid, path, at: this.world.time });
          this.lastPred = { at: this.world.time, cell: path[path.length - 1] };
          this.lastPredClock = this.clock();
          if (!this.lead) this.lead = lead;
        }
      } else if (it.k === 'stop') {
        this.pushLocal({ t: 'stop', eid: me!.eid, at: this.world.time });
        this.lastPredClock = this.clock();
      } else if (it.k === 'emote') {
        const kind = it.kind ?? EMOTES[Math.floor(Math.random() * EMOTES.length)];
        this.pushLocal({ t: 'act', eid: me!.eid, kind, dur: emoteDur(kind), at: this.world.time });
        this.emotePred = { kind, until: this.clock() + 3000 };
        this.lastPredClock = this.clock();
        out = { k: 'emote', kind };
      }
    }
    void this.t.send('host', { t: 'i', i: out });
  }

  private pushLocal(ev: WorldEvent): void {
    this.local.add(ev);
    this.world.push(ev);
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
