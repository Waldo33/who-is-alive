import { CROWD_ACT, NavGrid, TICK_MS, World, clampToRect, crowdHoldDur, emoteDur, ghostClapOpenView, makeConfig, planPath, plazaArena, twistEmote } from '@kto/game-core';
import type {
  ArenaDef,
  AwardCard,
  ClientSession,
  CrowdKind,
  EmoteKind,
  GameConfig,
  Intent,
  MatchSummary,
  MeView,
  Notice,
  Phase,
  PlayerInfo,
  RoundSummary,
  Star,
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
  /**
   * Зритель (опоздал к матчу): своей сущности нет, мир строится с начала следующего дубля —
   * до первого сообщения 'round' всё остальное пропускаем (собрать мир с середины не из чего).
   */
  spectator?: boolean;
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
/** Сколько ждём подтверждения хоста, прежде чем отменить показанное заранее (мс). */
const OPTIMISTIC_MS = 2500;

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
  mod = 0;
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
  /** История своего персонажа; ht — момент мира хоста, когда он там же (свой время + lead, вровень — без lead). */
  private own: { ht: number; x: number; y: number; pi: number; path: number[] }[] = [];
  /**
   * Свой персонаж поставлен вровень с хостом (в стоп-кадре): пока игрок не задал новый маршрут,
   * он идёт не впереди мира на lead, а вместе с ним. См. syncAtFreeze.
   */
  private synced = false;
  private wasFrozen = false;
  private lead = 0;
  private corr: { x: number; y: number } | null = null;
  private lastPred: { at: number; cell: number; resent?: boolean } | null = null;
  /**
   * Последнее нажатие «иди сюда», пока хост его не подтвердил. Сообщение могло потеряться —
   * тогда свой персонаж ушёл бы, а у хоста стоял на месте, и через пару секунд расхождение
   * исправлялось бы рывком. Не пришло подтверждение — шлём то же нажатие ещё раз (до двух раз).
   */
  private moveResend: { it: Intent; at: number; tries: number } | null = null;
  private lastPredClock = -1e9;
  private lastAuth: { x: number; y: number } | null = null;
  private emotePred: { kind: string; until: number } | null = null;
  /** События, которые гость положил в мир сам (предсказание) — фильтр их пропускает. */
  private local = new WeakSet<WorldEvent>();
  /** До этого момента шагами своего персонажа управляет хост (автопилот и сразу после него). */
  private hostDrivenUntil = 0;
  /*
   * Оптимистичный интерфейс: всё, что игрок сделал сам, показываем сразу, не дожидаясь хоста
   * (как в сетевых играх: ввод отзывается мгновенно, хост потом подтверждает или поправляет).
   */
  /** Удары, ушедшие хосту: кулак в счётчике гаснет сразу. base — сколько ударов было по данным хоста. */
  private pendingAtk: { base: number; until: number }[] = [];
  /** Цели, «поф» которых уже показан по личному итогу удара: повтор из потока мира не нужен. */
  private fastHits = new Set<number>();
  /** Свой промах уже показан (оглушение и метка): такие же события хоста про себя пропускаем. */
  private fastStun = { act: false, mark: false };
  /** Команда «Море волнуется», нажатая в этом стоп-кадре. */
  private crowdPred: { warnAt: number; kind: CrowdKind; act: boolean } | null = null;
  private accusePred: number | null = null;
  private autoPred: { on: boolean; until: number } | null = null;
  /** Звёзды, которые свой персонаж уже подобрал на экране гостя. */
  private starPred = new Map<number, { base: number; until: number; star: Star; confirmed: boolean }>();
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
  readonly spectator: boolean;
  /** Зритель уже видит дубль с начала (пришло 'round'). */
  watching = false;

  constructor(o: RemoteOptions) {
    this.t = o.transport;
    this.selfPid = o.selfPid;
    this.hostPid = o.hostPid;
    this.players = o.players;
    this.cfg = makeConfig(o.cfg);
    this.arena = plazaArena(this.cfg.arenaWidth, this.cfg.arenaHeight);
    this.world = new World(new NavGrid(this.arena, this.cfg.navCellSize), this.cfg.entitySpeed);
    this.clock = o.clock ?? (() => performance.now());
    this.spectator = !!o.spectator;
    this.world.filter = (ev) => this.keepEvent(ev);
    for (const p of this.players) this.scores[p.pid] = 0;
    this.unsub = this.t.onMessage((ch, msg, from) => {
      if (!this.t.authoritative && from !== this.hostPid) return;
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
    if (this.spectator) {
      if (m.t === 'round') this.watching = true;
      else if (!this.watching) return;
    }
    switch (m.t) {
      case 'round':
        this.world.init(m.spawns, m.t0);
        this.round = m.round;
        this.theme = m.theme;
        this.mod = m.mod ?? 0;
        this.summary = null;
        this.snap = null;
        this.resetOwn();
        this.offsets = [];
        this.lastHostWt = m.t0;
        this.noteOffset(m.t0);
        this.notices.push({ t: 'round_start', round: m.round, theme: m.theme, mod: this.mod });
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
        if (this.autoPred && m.me.autopilot === this.autoPred.on) this.autoPred = null;
        if (this.meMsg?.autopilot && !m.me.autopilot) this.hostDrivenUntil = this.clock() + 3000;
        if (m.me.autopilot) this.hostDrivenUntil = Math.max(this.hostDrivenUntil, this.clock() + 3000);
        this.meMsg = m.me;
        break;
      case 'denied':
        this.pendingAtk.shift();
        this.notices.push({ t: 'denied', pid: this.selfPid, reason: m.reason });
        break;
      case 'atk':
        this.fastHit(m.target, m.result, m.at);
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
        this.mod = m.st.mod ?? 0;
        this.meMsg = m.me;
        this.lastHostWt = m.world.time;
        this.offsets = [];
        this.noteOffset(m.world.time);
        this.players = m.players;
        this.stQueue.push(m.st);
        this.notices.push({ t: 'round_start', round: m.round, theme: m.theme, mod: this.mod });
        break;
    }
  }

  private resetOwn(): void {
    this.own = [];
    this.corr = null;
    this.lastAuth = null;
    this.lastPred = null;
    this.moveResend = null;
    this.emotePred = null;
    this.pendingAtk = [];
    this.fastHits.clear();
    this.fastStun = { act: false, mark: false };
    this.crowdPred = null;
    this.accusePred = null;
    this.starPred.clear();
  }

  /** Применять ли событие хоста в мире гостя: шаги своего персонажа гость уже показал сам. */
  private keepEvent(ev: WorldEvent): boolean {
    if (this.local.has(ev)) return true;
    // уже показанное заранее: свой удар, своя звезда
    if ((ev.t === 'hit' || ev.t === 'remove') && this.fastHits.has(ev.t === 'hit' ? ev.target : ev.eid)) return false;
    if (ev.t === 'star_taken' && this.starPred.has(ev.id)) {
      const sp = this.starPred.get(ev.id)!;
      if (ev.eid === this.meMsg?.eid) sp.confirmed = true;
      else this.starPred.delete(ev.id); // звезду всё-таки взял другой — своя прибавка отменяется
      return false;
    }
    const me = this.meMsg;
    if (!me || !('eid' in ev) || ev.eid !== me.eid) return true;
    if (me.autopilot || this.clock() < this.hostDrivenUntil) return true;
    if (ev.t === 'move') {
      // подтверждение последнего нажатия: точный сдвиг между своим временем и временем хоста
      const lp = this.lastPred;
      if (lp && ev.path[ev.path.length - 1] === lp.cell && ev.at >= lp.at) {
        // повторно отправленное нажатие пришло позже — по нему сдвиг не меряем
        if (!lp.resent) {
          const d = ev.at - lp.at;
          this.lead = this.lead ? this.lead * 0.5 + d * 0.5 : d;
        }
        this.lastPred = null;
        this.moveResend = null;
      }
      return false;
    }
    if (ev.t === 'stop' || ev.t === 'face') return false;
    if (ev.t === 'act' && ev.kind === 'stun' && this.fastStun.act) {
      this.fastStun.act = false;
      return false;
    }
    if (ev.t === 'mark' && this.fastStun.mark) {
      this.fastStun.mark = false;
      return false;
    }
    const cp = this.crowdPred;
    if (ev.t === 'act' && cp?.act && ev.kind === CROWD_ACT[cp.kind] && this.world.crowd?.warnAt === cp.warnAt) {
      cp.act = false;
      return false;
    }
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

  /** Где свой персонаж по собственной истории соответствует моменту мира хоста ht. */
  private ownAt(ht: number): { x: number; y: number; pi: number; path: number[] } | null {
    const h = this.own;
    if (!h.length) return null;
    if (ht <= h[0].ht) return h[0];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].ht <= ht) return h[i];
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
    const ref = idle ? e : this.ownAt(wt) ?? e;
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
    this.mod = st.mod ?? 0;
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
    this.resendMove();
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
      // поправка — раз за кадр, а не за шаг: когда догоняем хоста двумя шагами, рывка не будет
      if (steps === 1) this.applyCorrection();
      this.recordOwn();
      const frozen = this.world.isFrozen();
      if (frozen && !this.wasFrozen) this.syncAtFreeze();
      this.wasFrozen = frozen;
      this.predictStars();
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

  /** Итог своего удара пришёл лично: показать «поф» сейчас, а не когда мир гостя дойдёт до момента удара. */
  private fastHit(target: number, result: 'player' | 'bot', at: number): void {
    const te = this.world.get(target);
    const myEid = this.meMsg?.eid;
    if (!te || !te.alive || this.world.time >= at || myEid === undefined) return;
    const t = this.world.time;
    this.fastHits.add(target);
    this.pushLocal({ t: 'hit', target, result, x: te.x, y: te.y, at: t });
    this.pushLocal({ t: 'remove', eid: target, cause: result, at: t });
    if (result === 'bot') {
      this.fastStun = { act: true, mark: true };
      this.pushLocal({ t: 'act', eid: myEid, kind: 'stun', dur: this.cfg.missStunSec * 1000, at: t });
      this.pushLocal({ t: 'mark', eid: myEid, until: t + this.cfg.missMarkSec * 1000, at: t });
    }
  }

  /** Свой персонаж наступил на звезду — подобрать на экране сразу; хост подтвердит. */
  private predictStars(): void {
    const now = this.clock();
    for (const [id, sp] of this.starPred) {
      if (now < sp.until) continue;
      this.starPred.delete(id);
      // хост так и не отдал звезду — вернуть её на поле
      if (!sp.confirmed && !this.world.stars.has(id)) this.world.stars.set(id, sp.star);
    }
    const me = this.meMsg;
    if (!me || !me.alive || me.autopilot || this.phase !== 'play' || now < this.hostDrivenUntil) return;
    if (this.hostNow() < me.stunUntil) return;
    const e = this.world.get(me.eid);
    if (!e || !e.alive) return;
    for (const st of this.world.stars.values()) {
      if (this.starPred.has(st.id) || Math.hypot(st.x - e.x, st.y - e.y) > this.cfg.starPickupRadius) continue;
      this.starPred.set(st.id, { base: me.stars, until: now + OPTIMISTIC_MS, star: { ...st }, confirmed: false });
      this.pushLocal({ t: 'star_taken', id: st.id, eid: me.eid, at: this.world.time });
      break;
    }
  }

  /**
   * Стоп-кадр замораживает мир у хоста и у гостя в один и тот же момент, а свой персонаж у гостя
   * шёл впереди на lead — у хоста он замер на несколько пикселей раньше. Без этого после «Отомри»
   * гость подтягивал бы его назад посреди жеста. Ставим его туда, где он у хоста, в момент, когда
   * экран сереет (рывок в пару пикселей там не виден), и дальше ведём вровень с хостом.
   */
  private syncAtFreeze(): void {
    const me = this.meMsg;
    const e = me ? this.world.get(me.eid) : undefined;
    if (!me || !e || !e.alive || me.autopilot || this.clock() < this.hostDrivenUntil || !this.lead) return;
    const at = this.world.crowd?.showAt ?? this.world.time;
    const h = this.ownAt(at);
    this.synced = true;
    this.corr = null;
    if (!h || Math.hypot(h.x - e.x, h.y - e.y) < 0.05) return;
    e.x = e.px = h.x;
    e.y = e.py = h.y;
    // тот же маршрут: вернуть и номер точки, к которой он тогда шёл
    if (h.path === e.path && h.pi <= e.pi) e.pi = h.pi;
    this.own = [];
  }

  /** Свой персонаж идёт вровень с хостом: остановка у хоста случится на lead позже — и здесь так же. */
  private stopAt(e: { moving: boolean }): number {
    return this.synced && e.moving ? this.world.time + Math.round(this.lead / TICK_MS) * TICK_MS : this.world.time;
  }

  private recordOwn(): void {
    const id = this.meMsg?.eid;
    const e = id === undefined ? undefined : this.world.get(id);
    if (!e) return;
    this.own.push({ ht: this.world.time + (this.synced ? 0 : this.lead), x: e.x, y: e.y, pi: e.pi, path: e.path });
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
    const now = this.clock();
    this.pendingAtk = this.pendingAtk.filter((p) => p.base === m.attacksLeft && now < p.until);
    let stars = m.stars;
    for (const sp of this.starPred.values()) if (sp.base === m.stars && now < sp.until) stars++;
    const cp = this.crowdPred;
    const ap = this.autoPred && now < this.autoPred.until ? this.autoPred.on : null;
    return {
      eid: m.eid,
      alive: m.alive,
      attacksLeft: Math.max(0, m.attacksLeft - this.pendingAtk.length),
      stars,
      stunUntil: m.stunUntil,
      autopilot: ap ?? m.autopilot,
      crowdAnswered: cp && this.world.crowd?.warnAt === cp.warnAt ? cp.warnAt : m.crowdAnswered,
      // своя метка «?» — сразу (-1 — снята), не ждём хоста: вырезанного по ходу дубля, живого — в «Кто ещё живой?»
      accused: (this.phase === 'play' || this.phase === 'accuse') && this.accusePred !== null ? (this.accusePred < 0 ? null : this.accusePred) : m.accused,
      clapsLeft: m.clapsLeft ?? 0,
      clapAt: m.clapAt ?? 0,
      sanity: m.sanity ?? this.cfg.sanityStart,
      sins: m.sins ?? 0,
      kiki: (m.km ?? []).map(([id, x, y, w]) => ({ id, x, y, warn: w === 1 })),
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

  ghostClapOpen(t = this.world.time): boolean {
    return ghostClapOpenView(this.world, this.cfg, this.ppe, t);
  }

  intent(it: Intent): void {
    let out: Intent = it;
    if (it.k === 'crowd' || it.k === 'attack') out = { ...it, wt: this.world.time };
    const me = this.meMsg;
    if (it.k === 'accuse' && me && (this.phase === 'play' ? !me.alive : this.phase === 'accuse')) this.accusePred = it.eid;
    if (it.k === 'autopilot' && me && me.alive && this.phase === 'play') this.autoPred = { on: it.on, until: this.clock() + OPTIMISTIC_MS };
    if (it.k === 'autopilot') this.moveResend = null;
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
          // новый маршрут: свой персонаж снова живёт впереди мира (если шёл вровень — расхождение
          // на lead добирается плавно на ходу, это смена темпа, а не рывок)
          this.synced = false;
          this.lastPred = { at: this.world.time, cell: path[path.length - 1] };
          this.moveResend = { it: out, at: this.clock(), tries: 0 };
          this.lastPredClock = this.clock();
          if (!this.lead) this.lead = lead;
        }
      } else if (it.k === 'stop') {
        this.moveResend = null;
        this.pushLocal({ t: 'stop', eid: me!.eid, at: this.stopAt(e) });
        this.lastPredClock = this.clock();
      } else if (it.k === 'emote') {
        const kind = twistEmote(this.theme, this.world.twist) ?? it.kind ?? EMOTES[Math.floor(Math.random() * EMOTES.length)];
        this.pushLocal({ t: 'act', eid: me!.eid, kind, dur: emoteDur(kind), at: this.stopAt(e) });
        this.emotePred = { kind, until: this.clock() + 3000 };
        this.lastPredClock = this.clock();
        out = { k: 'emote', kind };
      } else if (it.k === 'attack' && it.eid >= 0) {
        // удар по своей кикиморе (id < 0) ударов дубля не тратит
        const left = me!.attacksLeft - this.pendingAtk.length;
        if (left > 0) this.pendingAtk.push({ base: me!.attacksLeft, until: this.clock() + OPTIMISTIC_MS });
      } else if (it.k === 'crowd') {
        const c = this.world.crowd;
        if (c && this.crowdWindowOpen() && me!.crowdAnswered !== c.warnAt && this.crowdPred?.warnAt !== c.warnAt) {
          // в стоп-кадре — вместе с толпой (с таким же разбросом, как у ботов), после — сразу
          const [a, b] = this.cfg.botCrowdReactMs;
          const at = this.world.time < c.resumeAt ? c.resumeAt + Math.round((a + Math.random() * (b - a)) / TICK_MS) * TICK_MS : this.stopAt(e);
          this.crowdPred = { warnAt: c.warnAt, kind: it.kind, act: true };
          this.pushLocal({ t: 'act', eid: me!.eid, kind: CROWD_ACT[it.kind], dur: crowdHoldDur(this.cfg, it.kind, at, c.watchUntil), at });
          // хост начнёт жест в тот же момент (свой персонаж в стоп-кадре поставлен вровень с хостом)
          if (this.world.time < c.resumeAt) out = { ...out, at } as Intent;
        }
      }
    }
    void this.t.send('host', { t: 'i', i: out });
  }

  /** Нажатие «иди сюда» не подтвердилось за ~3 задержки — отправить его ещё раз (не больше двух раз). */
  private resendMove(): void {
    const r = this.moveResend;
    if (!r || !this.lastPred || this.phase !== 'play') return;
    if (this.clock() - r.at < Math.max(900, this.latency * 3 + 300)) return;
    if (r.tries >= 2) {
      this.moveResend = null;
      return;
    }
    r.tries++;
    r.at = this.clock();
    this.lastPred.resent = true;
    void this.t.send('host', { t: 'i', i: r.it });
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
