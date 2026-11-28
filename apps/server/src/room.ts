import { DICTS, DIRECTOR_HUMANS, slotHits, TICK_MS, fmt, earnedStickers, recordRound, renamePid, seasonLeadTheme } from '@kto/game-core';
import type { GameConfig, PlayerInfo, SkinId } from '@kto/game-core';
import { DEFAULT_WIRE_SETTINGS, HostSession } from '@kto/net';
import type { Channel, PresenceMember, RoomMsg, ServerMsg, Transport, WireError, WireRoom, WireRoomSettings } from '@kto/net';
import type { Logger } from './log';
import type { FilmDone, FilmService } from './film';
import type { PuzzleStore } from './puzzles';
import { deathClipJob } from './death-clip';
// только тип: код монтажа живёт в отдельном процессе (film-worker.ts) и в основную сборку не попадает
import type { FilmTake } from '../../web/src/game/film';

/** Сезонная тема первого дубля — по московской дате (игроки в основном из России). */
function seasonLeadThemeNow(now = Date.now()): number {
  const d = new Date(now + 3 * 3600_000);
  return seasonLeadTheme(d.getUTCMonth(), d.getUTCDate());
}

/** Одно соединение игрока (WebSocket или тестовая заглушка). */
export interface Peer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface Member {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
  ready: boolean;
  peer: Peer | null;
  /** Когда соединение пропало (для освобождения места через HOLD_MS). */
  offlineSince: number;
  /** Ушёл сам («Назад») посреди матча: его место в матче можно занять сразу, не ждать HOLD_MS. */
  left?: boolean;
  /** Скин из гардероба — по покупкам (server.ts › skinFor), не с телефона. */
  skin?: SkinId;
}

/** Сколько держим место за отключившимся (как пульс в Supabase): 75 с. */
export const HOLD_MS = 75_000;
/** Режиссёр пропал во время матча — роль у следующего через столько. */
export const DIRECTOR_GONE_PLAYING_MS = 10_000;
/** Игрок пропал посреди матча — за него играет ИИ через столько (вернётся — управление снова его). */
export const BOT_AFTER_MS = 5_000;
const SEATS = 4;
/** Зрителей на комнату (опоздавшие к матчу смотрят трансляцию). */
const MAX_SPECTATORS = 8;
export const SERVER_PID = '$server';

export interface RoomOptions {
  code: string;
  directorId: string;
  directorName: string;
  settings: WireRoomSettings;
  lang: 'ru' | 'en';
  now: () => number;
  log: Logger;
  /** Во сколько раз быстрее реального времени идёт матч (только тесты). */
  speed?: number;
  onEmpty?: (room: Room) => void;
  /** «Фильм матча» (film.ts): нет — фильм монтирует телефон. */
  film?: FilmService;
  /** Загадки из фильма (puzzles.ts): нет — фильм без загадки, QR ведёт на главную. */
  puzzles?: PuzzleStore;
  /** Видео не выключено аварийно (video-switch.ts). */
  videoOn?: () => boolean;
  /** Фильм матча готов (на сервере): комнате по приглашению из Telegram — отправить его в чат (server.ts). */
  onFilm?: (room: Room, film: RoomFilm) => void;
  /** Комната по приглашению из Telegram: что показать на карточке в чате (сбор, съёмка) — server.ts › cardToChat. */
  onCard?: (room: Room, card: RoomCard) => void;
  /** Матч сыгран: всем людям — что им открылось (game-core › earnedStickers, может быть пусто) — server.ts отдаст боту. */
  onStickers?: (room: Room, earned: { pid: string; stickers: string[] }[]) => void;
  /**
   * Матч сыгран: счётчики значков для статуса (game-core/badges.ts) — люди, победители и режиссёр, если комната
   * впервые сыграла матч с `DIRECTOR_HUMANS` живыми (одна комната — одна засчитанная); server.ts запишет по связке с Telegram.
   */
  onBadges?: (room: Room, m: MatchBadges) => void;
  /** Комната переехала с соседнего экземпляра сервера (выкладка без обрыва): состав и настройки — оттуда. */
  restore?: RoomSnapshot;
}

/** Итог матча для значков: id людей, победителей и режиссёра, которому засчитана комната (или null). */
export interface MatchBadges {
  humans: string[];
  winners: string[];
  director: string | null;
  /** 777 и черепа в «Крутках» матча по людям (только у кого что-то выпало). */
  slots?: { pid: string; jackpots: number; skulls: number }[];
}

/** Готовый фильм матча: ролик в хранилище клипов и итог для подписи. */
export interface RoomFilm {
  id: string;
  /** Имена победителей; больше одного — ничья. */
  winners: string[];
  draw: boolean;
  /** Награды матча с именами (для подписи «Снято!» в чате). */
  awards: { id: string; names: string[] }[];
  /** Код загадки из фильма (/c/<код>) — кнопка «Найди актёра» под видео. */
  puzzle?: string;
}

/**
 * Живая карточка в чате Telegram: сбор («2 из 4»), съёмка (счёт по дублям), отмена (комната закрылась
 * без матча). После конца матча карточку меняет фильм (onFilm). Только имена и очки — то, что и так
 * видно всем в игре; кто из человечков кто, сюда не попадает.
 */
export type RoomCard =
  | { state: 'lobby'; seats: { name: string; color: number }[]; max: number }
  | { state: 'playing'; take: number; target: number; scores: { name: string; color: number; score: number }[] }
  | { state: 'closed' };

/**
 * Снимок комнаты в лобби для переезда на другой экземпляр сервера (синий/зелёный, другой регион):
 * состав с цветами и «Готов», режиссёр, настройки, зрители. Матч не переезжает — его доигрывают на месте.
 */
export interface RoomSnapshot {
  v: 1;
  code: string;
  directorId: string;
  settings: WireRoomSettings;
  lang: 'ru' | 'en';
  createdAt: number;
  lastActive: number;
  members: { userId: string; name: string; color: number; joinedAt: number; ready: boolean; offlineSince: number }[];
  /** Зрители (пришли посреди прошлого матча): после переезда снова зрители, место займут сами. */
  spectators: string[];
  /** Комната нагрузочного прогона: у соседа тоже закроется через 15 с пустоты (необязательное — старые версии не шлют). */
  load?: boolean;
  /** Сколько комната уже пустая (мс): сосед продолжает отсчёт, а не начинает 10 минут заново. */
  emptyMs?: number;
  /** Метка приглашения из Telegram: по той же карточке после переезда — в эту же комнату. */
  invite?: string;
  /** Матч уже был (карточку в чате держит фильм, а не сбор). */
  played?: boolean;
  /** Комната уже засчитана режиссёру для значка «Режиссёр». */
  directorCounted?: boolean;
}

/**
 * Транспорт безголового хоста: «общий канал» — все игроки комнаты, «личный» — один игрок.
 * Общий текст сериализуется один раз на всех.
 */
class RoomTransport implements Transport {
  readonly selfId = SERVER_PID;
  handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  constructor(private readonly room: Room) {}
  async send(channel: Channel, msg: unknown, to?: string): Promise<void> {
    if (channel === 'room') this.room.broadcastText(JSON.stringify({ t: 'g', ch: 'room', m: msg } satisfies ServerMsg));
    else if (channel === 'private' && to) this.room.sendTo(to, { t: 'g', ch: 'private', m: msg });
  }
  onMessage(h: (c: Channel, m: unknown, f: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  deliver(from: string, m: unknown): void {
    for (const h of this.handlers) h('host', m, from);
  }
  presence(): PresenceMember[] {
    return [];
  }
  onPresence(): () => void {
    return () => {};
  }
  async track(): Promise<void> {}
  async setRole(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Матч на сервере: безголовый хост и часы реального времени (догоняем пачкой, если отстали). */
export class MatchRunner {
  readonly host: HostSession;
  readonly transport: RoomTransport;
  private startedAt: number;
  private steps = 0;
  /** Длительности шагов (мс) — для метрик. */
  stepMs: number[] = [];
  /** Дубли матча для фильма: запись мира снимается на разоблачении (потом её уже не собрать). */
  private takes: FilmTake[] = [];
  /** Шёл дубль (фаза игры) и его разоблачение ещё не снято — снимаем ровно один раз. */
  private armed = false;
  /** Снят последний дубль матча (разоблачение): итоги уже известны — можно монтировать фильм. */
  onLastTake: ((takes: FilmTake[]) => void) | null = null;
  /** Дубль кончился (разоблачение): очки начислены — карточка в чате обновит счёт. */
  onTake: (() => void) | null = null;
  /**
   * Живого игрока выбили, и прошло 1,5 с (столько клип показывает после удара): можно заготовить
   * его клип — кнопка «Клип» у него появится только через 3,4 с после удара.
   */
  onKnockout: ((pid: string, eid: number, round: number) => void) | null = null;
  private koLog: unknown[] | null = null;
  private koSeen = 0;
  private koDue: { pid: string; eid: number; round: number; due: number }[] = [];

  constructor(
    room: Room,
    readonly players: PlayerInfo[],
    cfg: Partial<GameConfig>,
    seed: number,
    private readonly now: () => number,
    private readonly speed: number,
  ) {
    this.transport = new RoomTransport(room);
    this.host = new HostSession({ transport: this.transport, players, cfg, seed, hostPid: room.directorId, selfPid: SERVER_PID });
    this.startedAt = now();
  }

  /** Сделать столько шагов мира, сколько положено к этому моменту. */
  pump(): void {
    const due = Math.floor(((this.now() - this.startedAt) * this.speed) / TICK_MS);
    let todo = due - this.steps;
    // сервер подвис надолго (>2 с) — не прокручивать матч рывком, а сдвинуть часы
    if (todo > 40) {
      this.startedAt += ((todo - 40) * TICK_MS) / this.speed;
      todo = 40;
    }
    for (let i = 0; i < todo; i++) this.step();
  }

  step(): void {
    const t0 = performance.now();
    this.host.tick();
    this.host.drainNotices();
    this.noteTake();
    this.noteKnockouts();
    this.steps++;
    const dt = performance.now() - t0;
    if (this.stepMs.length >= 600) this.stepMs.shift();
    this.stepMs.push(dt);
  }

  /** Разоблачение дубля — запомнить запись мира и итоги (init следующего дубля создаст новые массивы). */
  private noteTake(): void {
    const h = this.host;
    const s = h.summary;
    if (h.phase === 'play') this.armed = true;
    if (h.phase !== 'reveal' || !s || !this.armed) return;
    this.armed = false;
    this.takes.push({
      rec: recordRound(h.world, { round: h.round, theme: h.theme, players: s.reveal, playEnd: s.replayTo, kills: s.kills, slots: s.slots }),
      summary: s,
      arena: h.arena,
    });
    this.onTake?.();
    if (h.sim.lastRound) this.onLastTake?.(this.flushTakes());
  }

  /** Удары по живым игрокам (не ИИ) — через 1,5 с игрового времени после удара в onKnockout. */
  private noteKnockouts(): void {
    if (!this.onKnockout) return;
    const h = this.host;
    const w = h.world;
    // новый дубль — новый журнал
    if (w.log !== this.koLog) {
      this.koLog = w.log;
      this.koSeen = 0;
      this.koDue = [];
    }
    for (; this.koSeen < w.log.length; this.koSeen++) {
      const e = w.log[this.koSeen];
      if (e.t !== 'hit' || e.result !== 'player') continue;
      const p = this.players.find((x) => !x.ai && h.sim.playerRound(x.pid)?.eid === e.target);
      if (p) this.koDue.push({ pid: p.pid, eid: e.target, round: h.round, due: e.at + 1500 });
    }
    // дубль кончился раньше — на разоблачении телефон сам попросит полный клип (с тем, кто выбил)
    const over = !!h.summary && h.summary.round === h.round;
    while (this.koDue.length && (over || w.time >= this.koDue[0].due)) {
      const k = this.koDue.shift()!;
      if (!over && k.round === h.round) this.onKnockout(k.pid, k.eid, k.round);
    }
  }

  /** Место перешло к новому игроку: в записанных дублях (для фильма) — тоже он. */
  renameSeat(from: string, to: string): void {
    this.takes = this.takes.map((t) => renamePid(t, from, to));
  }

  /** Дубли сыгранного матча (и начать копить заново — к реваншу). */
  flushTakes(): FilmTake[] {
    const t = this.takes;
    this.takes = [];
    return t;
  }

  stop(): void {
    this.host.dispose();
  }
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  directorId: string;
  settings: WireRoomSettings;
  members = new Map<string, Member>();
  /** Зрители: пришли посреди матча — получают только общий канал, после матча занимают место. */
  spectators = new Map<string, Peer>();
  status: 'lobby' | 'playing' = 'lobby';
  runner: MatchRunner | null = null;
  lastActive: number;
  readonly lang: 'ru' | 'en';
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly speed: number;
  private directorGoneSince = 0;
  /** Номер фильма: готовый фильм прошлого матча не рассылаем, если уже идёт следующий. */
  private filmSeq = 0;
  private film: { n: number; state: 'making' | 'ready' | 'failed'; done?: FilmDone; puzzle?: string } | null = null;
  /** Зрители, приехавшие со снимком: войдут — снова станут зрителями, а не займут место. */
  private expectSpectators = new Set<string>();
  closed = false;
  /** Комната по приглашению из Telegram («Собрать комнату» в боте) — метка карточки. */
  invite?: string;
  /** Что последним ушло на карточку в чате — одинаковое второй раз не шлём. */
  private cardSig = '';
  /** Был ли тут матч: закрытие лобби без матча — «Съёмку отменили» на карточке. */
  private played = false;
  /** Комната уже засчитана режиссёру для значка «Режиссёр» (матч с четырьмя живыми). */
  private directorCounted = false;

  constructor(private readonly o: RoomOptions) {
    this.code = o.code;
    this.now = o.now;
    this.log = o.log;
    this.lang = o.lang;
    this.speed = o.speed ?? 1;
    this.createdAt = this.lastActive = o.now();
    this.directorId = o.directorId;
    this.settings = { ...DEFAULT_WIRE_SETTINGS, ...o.settings };
    const snap = o.restore;
    if (snap) {
      // переехала с соседа: все пока «не на связи» — переподключатся через долю секунды
      this.createdAt = snap.createdAt;
      this.lastActive = snap.lastActive;
      for (const m of snap.members) this.members.set(m.userId, { ...m, peer: null, offlineSince: m.offlineSince || o.now() });
      for (const id of snap.spectators) this.expectSpectators.add(id);
      this.played = snap.played === true;
      this.directorCounted = snap.directorCounted === true;
      return;
    }
    // создатель занимает место и цвет 0 сразу (как create_room), подключится следом
    this.members.set(o.directorId, {
      userId: o.directorId,
      name: cleanName(o.directorName, 'Host'),
      color: 0,
      joinedAt: o.now(),
      ready: false,
      peer: null,
      offlineSince: o.now(),
    });
  }

  // ───────────── вход и выход ─────────────

  /** Зрители, чей клиент умеет занять место ИИ посреди матча (hello.seat). */
  private seatable = new Map<string, string>();
  /** Скины по покупкам (приходят после входа): игрок → скин, null — без скина. Переживает выход и место ИИ. */
  private skins = new Map<string, SkinId | null>();

  /**
   * Скин игрока узнали по покупкам (server.ts › skinFor). В лобби его видят все; в матч он уходит только со
   * следующим стартом (идущий матч уже знает состав) — на поле его рисует лишь телефон самого игрока.
   */
  setSkin(userId: string, skin: SkinId | null): void {
    if (this.closed) return;
    this.skins.set(userId, skin);
    const m = this.members.get(userId);
    if (!m || (m.skin ?? null) === skin) return;
    if (skin) m.skin = skin;
    else delete m.skin;
    this.broadcastRoom();
  }

  /**
   * Вход по WebSocket. Возвращает код ошибки или null.
   * seat — клиент умеет войти в идущий матч на место ИИ (старые клиенты — только зрителями).
   */
  join(userId: string, name: string, peer: Peer, opts: { seat?: boolean } = {}): WireError | null {
    const now = this.now();
    let m = this.members.get(userId);
    if (m) {
      // перезаход: старое соединение (другая вкладка, оборванная сеть) закрываем
      if (m.peer && m.peer !== peer) m.peer.close(4000, 'replaced');
      m.peer = peer;
      m.offlineSince = 0;
      m.left = false;
      if (name.trim()) m.name = cleanName(name, m.name);
      // вернулся посреди матча: ИИ, который играл за него, отдаёт управление
      if (this.runner?.host.humanBack(userId)) this.log('info', 'seat_back', { room: this.code });
    } else {
      if (this.expectSpectators.delete(userId)) {
        this.spectators.set(userId, peer);
        peer.send(JSON.stringify({ t: 'welcome', selfId: userId, room: this.view(), spectator: true } satisfies ServerMsg));
        return null;
      }
      if (this.status === 'playing') {
        if (opts.seat) this.seatable.set(userId, name);
        else this.seatable.delete(userId);
        // в матче есть свободное место ИИ — сразу на него
        const old = this.spectators.get(userId);
        if (opts.seat && this.takeSeat(userId, name, peer)) {
          if (old && old !== peer) old.close(4000, 'replaced');
          this.spectators.delete(userId);
          return null;
        }
        if (this.spectators.size >= MAX_SPECTATORS && !this.spectators.has(userId)) return 'room_playing';
        if (old && old !== peer) old.close(4000, 'replaced');
        this.spectators.set(userId, peer);
        peer.send(JSON.stringify({ t: 'welcome', selfId: userId, room: this.view(), spectator: true } satisfies ServerMsg));
        return null;
      }
      this.purgeOffline(now);
      if (this.members.size >= SEATS) return 'room_full';
      const used = new Set([...this.members.values()].map((x) => x.color));
      const color = [0, 1, 2, 3].find((c) => !used.has(c)) ?? 0;
      m = { userId, name: cleanName(name, 'Player'), color, joinedAt: now, ready: false, peer, offlineSince: 0 };
      const skin = this.skins.get(userId);
      if (skin) m.skin = skin;
      this.members.set(userId, m);
    }
    this.lastActive = now;
    this.sendTo(userId, { t: 'welcome', selfId: userId, room: this.view(), ...(this.o.film && (this.o.videoOn?.() ?? true) ? { caps: ['clip'] } : {}) });
    this.broadcastRoom();
    return null;
  }

  /**
   * Свободное место ИИ в идущем матче: добранное режиссёром или ушедшего игрока (ушёл сам или пропал
   * дольше HOLD_MS — раньше место ждёт его). Сначала — где персонаж ещё жив в этом дубле.
   * Только в отсчёт и в игру: на разоблачении и итогах у новичка не было бы итогов дубля.
   */
  private freeSeat(now: number): string | null {
    const h = this.runner?.host;
    if (!h || this.status !== 'playing' || (h.phase !== 'countdown' && h.phase !== 'play')) return null;
    const free = h.aiSeats().filter((pid) => {
      const m = this.members.get(pid);
      return !m || (!m.peer && (m.left || now - m.offlineSince >= HOLD_MS));
    });
    return free.find((pid) => h.sim.playerRound(pid)?.alive) ?? free[0] ?? null;
  }

  /** Новый игрок занимает свободное место ИИ посреди матча (очки и персонаж — от места). */
  private takeSeat(userId: string, name: string, peer: Peer): boolean {
    const now = this.now();
    const seat = this.freeSeat(now);
    const r = this.runner;
    if (!seat || !r) return false;
    const color = r.host.sim.info(seat)!.color;
    const nm = cleanName(name, 'Player');
    const skin = this.skins.get(userId);
    if (!r.host.takeSeat(seat, { pid: userId, name: nm, color, ...(skin ? { skin } : {}) })) return false;
    r.renameSeat(seat, userId);
    this.members.delete(seat);
    this.members.set(userId, { userId, name: nm, color, joinedAt: now, ready: false, peer, offlineSince: 0, ...(skin ? { skin } : {}) });
    if (!this.members.has(this.directorId)) this.passDirector();
    this.lastActive = now;
    this.log('info', 'seat_taken', { room: this.code, ai: seat.startsWith('ai-') });
    this.sendTo(userId, { t: 'welcome', selfId: userId, room: this.view(), ...(this.o.film && this.videoOn() ? { caps: ['clip'] } : {}) });
    this.broadcastRoom();
    return true;
  }

  /** Зрители, которые умеют войти в матч, — на освободившиеся места ИИ. */
  private seatSpectators(): void {
    for (const [userId, peer] of [...this.spectators]) {
      if (!this.seatable.has(userId)) continue;
      if (!this.freeSeat(this.now())) return;
      this.spectators.delete(userId);
      if (!this.takeSeat(userId, this.seatable.get(userId) ?? '', peer)) this.spectators.set(userId, peer);
    }
  }

  /** Игроки матча, которых нет на связи дольше BOT_AFTER_MS (или ушли сами), — за них играет ИИ. */
  private standIns(now: number): void {
    const r = this.runner;
    if (!r || this.status !== 'playing' || r.host.phase === 'match_end') return;
    for (const p of r.players) {
      if (p.ai) continue;
      const m = this.members.get(p.pid);
      if (m?.peer || (m && !m.left && now - m.offlineSince < BOT_AFTER_MS)) continue;
      if (r.host.botTakeover(p.pid)) this.log('info', 'seat_bot', { room: this.code, left: !!m?.left });
    }
  }

  /** Соединение оборвалось: место держится HOLD_MS. */
  disconnected(userId: string, peer: Peer): void {
    if (this.spectators.get(userId) === peer) {
      this.spectators.delete(userId);
      this.seatable.delete(userId);
      return;
    }
    const m = this.members.get(userId);
    if (!m || m.peer !== peer) return;
    m.peer = null;
    m.offlineSince = this.now();
    m.ready = false;
    this.broadcastRoom();
    if (this.onlineCount() === 0) this.o.onEmpty?.(this);
  }

  /** Явный уход (кнопка «Назад»): место освобождается сразу. */
  leave(userId: string): void {
    this.spectators.delete(userId);
    this.seatable.delete(userId);
    const m = this.members.get(userId);
    if (!m) return;
    // во время матча персонаж игрока остаётся на поле до конца матча: за него сразу играет ИИ,
    // а место может занять новый игрок по ссылке
    if (this.status === 'playing' && this.runner?.players.some((p) => p.pid === userId)) {
      m.peer = null;
      m.offlineSince = this.now();
      m.ready = false;
      m.left = true;
      this.standIns(this.now());
      this.seatSpectators();
    } else {
      this.members.delete(userId);
    }
    if (userId === this.directorId) this.passDirector();
    this.lastActive = this.now();
    this.broadcastRoom();
    if (this.onlineCount() === 0) this.o.onEmpty?.(this);
  }

  private purgeOffline(now: number): void {
    for (const m of [...this.members.values()]) {
      if (m.peer || !m.offlineSince || now - m.offlineSince < HOLD_MS) continue;
      if (m.userId === this.directorId) continue;
      this.members.delete(m.userId);
    }
  }

  /** Раз в секунду: занятые места отключившихся, пропавший режиссёр. */
  housekeeping(): void {
    const now = this.now();
    const before = this.members.size;
    if (this.status === 'lobby') this.purgeOffline(now);
    if (this.status === 'playing') {
      this.standIns(now);
      this.seatSpectators();
    }
    const d = this.members.get(this.directorId);
    const dOnline = !!d?.peer;
    if (dOnline) this.directorGoneSince = 0;
    else {
      // отсчёт — с момента обрыва, а не с первой проверки
      this.directorGoneSince ||= d?.offlineSince || now;
      const limit = this.status === 'playing' ? DIRECTOR_GONE_PLAYING_MS : HOLD_MS;
      if (now - this.directorGoneSince >= limit && this.onlineCount() > 0) {
        this.passDirector();
        if (this.status === 'lobby' && d && !d.peer) this.members.delete(d.userId);
        this.broadcastRoom();
      }
    }
    if (this.members.size !== before) this.broadcastRoom();
  }

  /** Роль режиссёра — следующему по порядку входа (сначала тем, кто на связи). */
  private passDirector(): void {
    const rest = [...this.members.values()].filter((m) => m.userId !== this.directorId).sort((a, b) => a.joinedAt - b.joinedAt);
    const next = rest.find((m) => m.peer) ?? rest[0];
    if (!next) return;
    this.log('info', 'director_passed', { room: this.code });
    this.directorId = next.userId;
    this.directorGoneSince = 0;
    this.runner?.host.setDirector(next.userId);
  }

  /** Зритель занимает место, когда матч кончился (комната снова в лобби). */
  promote(userId: string, name: string): WireError | null {
    const peer = this.spectators.get(userId);
    if (!peer) return null;
    if (this.status === 'playing') return 'not_now';
    this.spectators.delete(userId);
    const err = this.join(userId, name, peer);
    // мест нет — остаётся зрителем следующего матча
    if (err) this.spectators.set(userId, peer);
    return err;
  }

  // ───────────── действия в лобби ─────────────

  setReady(userId: string, on: boolean): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.ready = on;
    this.broadcastRoom();
  }

  rename(userId: string, name: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.name = cleanName(name, m.name);
    this.broadcastRoom();
  }

  updateSettings(userId: string, s: WireRoomSettings): WireError | null {
    if (userId !== this.directorId) return 'not_director';
    if (this.status !== 'lobby') return 'not_now';
    this.settings = s;
    this.lastActive = this.now();
    this.broadcastRoom();
    return null;
  }

  kick(userId: string, target: string): WireError | null {
    if (userId !== this.directorId) return 'not_director';
    if (this.status !== 'lobby' || target === userId) return 'not_now';
    const m = this.members.get(target);
    if (!m) return null;
    this.members.delete(target);
    if (m.peer) {
      m.peer.send(JSON.stringify({ t: 'kicked' } satisfies ServerMsg));
      m.peer.close(4001, 'kicked');
    }
    this.broadcastRoom();
    return null;
  }

  /** Сколько людей нужно для старта: с ИИ-актёрами хватит одного. */
  minHumans(): number {
    return this.settings.aiFill ? 1 : 2;
  }

  /** Старт матча (или новый матч после конца — с новым составом). */
  start(userId: string): WireError | null {
    if (userId !== this.directorId) return 'not_director';
    if (this.status === 'playing' && this.runner?.host.phase !== 'match_end') return 'not_now';
    const humans: PlayerInfo[] = this.onlineMembers().map((m) => ({ pid: m.userId, name: m.name, color: m.color, ...(m.skin ? { skin: m.skin } : {}) }));
    if (humans.length < this.minHumans()) return 'not_enough_players';
    // из лобби — только когда все подключённые нажали «Готов»; «Ещё дубль» с экрана итогов — без этого
    const rematch = this.runner?.host.phase === 'match_end';
    if (!rematch && this.onlineMembers().some((m) => m.userId !== this.directorId && !m.ready)) return 'not_ready';
    const players = [...humans, ...this.aiFill(humans)];
    const cfg: Partial<GameConfig> = {
      roundSec: this.settings.roundSec,
      maxRounds: this.settings.maxRounds,
      kidsMode: this.settings.kidsMode,
      strictCrowd: !!this.settings.strictCrowd,
      leadTheme: seasonLeadThemeNow(),
    };
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.runner?.stop();
    this.status = 'playing';
    // места тех, кто не попал в матч (не на связи), освобождаются
    for (const m of [...this.members.values()]) if (!players.some((p) => p.pid === m.userId)) this.members.delete(m.userId);
    this.broadcastRoom();
    const start: RoomMsg = { t: 'match_start', players, cfg, seed, hostId: this.directorId };
    this.broadcastText(JSON.stringify({ t: 'g', ch: 'room', m: start } satisfies ServerMsg));
    this.runner = new MatchRunner(this, players, cfg, seed, this.now, this.speed);
    const runner = this.runner;
    this.film = null;
    this.broadcastText(JSON.stringify({ t: 'film', state: 'none' } satisfies ServerMsg));
    runner.onLastTake = (takes) => {
      this.matchStickers(runner, takes);
      this.matchBadges(runner, takes);
      this.startFilm(runner, takes);
    };
    runner.onKnockout = (pid, eid, round) => this.preclip(pid, eid, round);
    runner.onTake = () => this.cardNote();
    this.played = true;
    // карточка в чате: «Идёт съёмка» сразу со стартом
    this.cardNote();
    // процесс монтажа — заранее: первый клип выбывшего не ждёт его запуска
    if (this.videoOn()) this.o.film?.warm();
    this.lastActive = this.now();
    this.log('info', 'match_start', { room: this.code, humans: humans.length, ai: players.length - humans.length });
    return null;
  }

  private aiFill(humans: PlayerInfo[]): PlayerInfo[] {
    if (!this.settings.aiFill) return [];
    const t = DICTS[this.lang];
    const free = [0, 1, 2, 3].filter((c) => !humans.some((h) => h.color === c));
    const nouns = [...t.names.noun].sort(() => Math.random() - 0.5);
    return free.slice(0, Math.max(0, SEATS - humans.length)).map((color, i) => ({
      pid: `ai-${i + 1}`,
      name: fmt(t.lobby.aiName, { name: nouns[i] }).slice(0, 14),
      color,
      ai: true,
    }));
  }

  /** Клипы выбывших в этом дубле: игрок → сколько просил (ранний и полный — не больше двух). */
  private clipAsks = new Map<string, number>();
  private clipRound = -1;
  /** Язык и «без крови» у игрока (из hello или прошлой просьбы) — чтобы заготовить его клип заранее. */
  private clipPrefs = new Map<string, { lang: 'ru' | 'en'; mild: boolean }>();
  /** Заготовленные клипы выбывших этого дубля (до нажатия «Клип»). */
  private preclips = new Map<string, { round: number; lang: 'ru' | 'en'; mild: boolean; p: Promise<FilmDone | null>; done?: FilmDone | null }>();

  private videoOn(): boolean {
    return this.o.videoOn?.() ?? true;
  }

  setClipPrefs(userId: string, p: { lang: 'ru' | 'en'; mild: boolean }): void {
    this.clipPrefs.set(userId, { lang: p.lang, mild: p.mild });
  }

  private newClipRound(round: number): void {
    if (this.clipRound === round) return;
    this.clipRound = round;
    this.clipAsks.clear();
    this.preclips.clear();
  }

  /** Игрока выбили: смонтировать его клип, пока он не попросил (монтаж свободен — иначе нет). */
  private preclip(pid: string, eid: number, round: number): void {
    const film = this.o.film;
    const h = this.runner?.host;
    if (!film || !h || !this.videoOn() || !this.members.get(pid)?.peer) return;
    this.newClipRound(round);
    const pr = this.clipPrefs.get(pid) ?? { lang: this.lang, mild: false };
    const job = deathClipJob(h, pid, eid, { lang: pr.lang, noGore: pr.mild });
    if (!job || job.known) return;
    const p = film.preclip(job);
    if (!p) return;
    const e: { round: number; lang: 'ru' | 'en'; mild: boolean; p: Promise<FilmDone | null>; done?: FilmDone | null } = { round, ...pr, p };
    this.preclips.set(pid, e);
    void p.then((d) => (e.done = d));
  }

  /**
   * Клип выбывшего — смонтировать на сервере (Rust, film.ts). Кого подсветить, решает сервер:
   * героем всегда будет сам просящий (deathClipJob). Ответ — `clip` с тем же n.
   * Заготовленный (preclip) с тем же языком — отдаём его: готов сразу или раньше нового.
   */
  clip(userId: string, m: { n: number; round: number; lang: 'ru' | 'en'; mild: boolean }): void {
    const film = this.o.film;
    const r = this.runner;
    const fail = () => this.sendTo(userId, { t: 'clip', n: m.n, state: 'failed' });
    const h = r?.host;
    const eid = h?.sim.playerRound(userId)?.eid;
    if (!film || !h || eid === undefined || h.round !== m.round) return fail();
    this.newClipRound(h.round);
    this.setClipPrefs(userId, m);
    const asks = this.clipAsks.get(userId) ?? 0;
    if (asks >= 2) return fail();
    const job = deathClipJob(h, userId, eid, { lang: m.lang, noGore: m.mild });
    if (!job) return fail();
    this.clipAsks.set(userId, asks + 1);
    const send = (done: FilmDone | null) => {
      if (this.closed) return;
      this.sendTo(userId, done ? { t: 'clip', n: m.n, state: 'ready', id: done.id, ext: done.ext, thumb: done.thumb } : { t: 'clip', n: m.n, state: 'failed' });
    };
    const pre = this.preclips.get(userId);
    if (pre && !job.known && pre.lang === m.lang && pre.mild === m.mild && pre.done !== null) {
      this.preclips.delete(userId);
      if (pre.done) return send(pre.done);
      this.sendTo(userId, { t: 'clip', n: m.n, state: 'making', eta: film.etaOf(pre.p) });
      void pre.p.then(send);
      return;
    }
    const p = film.clip(job, (eta) => this.sendTo(userId, { t: 'clip', n: m.n, state: 'making', eta }));
    if (!p) return fail();
    void p.then(send);
  }

  /** Игровое сообщение от игрока — безголовому хосту. «Ещё дубль» с новым составом — новый матч. */
  game(userId: string, m: unknown): void {
    const r = this.runner;
    const msg = m as { t?: string; i?: { k?: string } };
    if (!r) {
      // комната переехала с экрана конца матча (матча здесь нет): «Ещё дубль» — новый матч
      if (msg?.t === 'i' && msg.i?.k === 'rematch' && userId === this.directorId) this.start(userId);
      return;
    }
    if (msg?.t === 'i' && msg.i?.k === 'rematch' && userId === this.directorId && r.host.phase === 'match_end') {
      const now = this.onlineMembers().map((x) => x.userId);
      const before = r.players.filter((p) => !p.ai).map((p) => p.pid);
      const same = now.length === before.length && now.every((p) => before.includes(p));
      if (!same && now.length >= this.minHumans()) {
        this.start(userId);
        return;
      }
    }
    r.transport.deliver(userId, m);
  }

  /** Шаги матча к этому моменту. Конец матча → комната снова принимает новых (они войдут к «Ещё дублю»). */
  pump(): void {
    this.runner?.pump();
    if (this.status === 'playing' && this.runner?.host.phase === 'match_end') {
      this.status = 'lobby';
      this.broadcastRoom();
      this.filmToAll();
    } else if (this.status === 'lobby' && this.runner && this.runner.host.phase !== 'match_end') {
      // реванш: фильм прошлого матча больше не рассылаем
      this.film = null;
      this.status = 'playing';
      this.broadcastRoom();
      this.broadcastText(JSON.stringify({ t: 'film', state: 'none' } satisfies ServerMsg));
    }
  }

  /** Последний дубль разоблачён — итоги матча известны: кому из людей какие стикеры открылись. */
  private matchStickers(r: MatchRunner, takes: FilmTake[]): void {
    if (!this.o.onStickers || !takes.length) return;
    const match = r.host.sim.outcome();
    const rounds = takes.map((t) => ({ ...t.summary, theme: t.rec.theme }));
    const earned = r.players.filter((p) => !p.ai).map((p) => ({ pid: p.pid, stickers: earnedStickers(p.pid, rounds, match) as string[] }));
    // всех людей: сыгранный матч сам по себе открывает бесплатный пак (shop.ts › earn)
    if (earned.length) this.o.onStickers(this, earned);
  }

  /** Последний дубль разоблачён: кто играл и кто победил — для значков (комната режиссёру — один раз). */
  private matchBadges(r: MatchRunner, takes: FilmTake[]): void {
    if (!this.o.onBadges || !takes.length) return;
    const humans = r.players.filter((p) => !p.ai).map((p) => p.pid);
    if (!humans.length) return;
    const winners = r.host.sim.outcome().winners.filter((pid) => humans.includes(pid));
    let director: string | null = null;
    if (!this.directorCounted && humans.length >= DIRECTOR_HUMANS && humans.includes(this.directorId)) {
      director = this.directorId;
      this.directorCounted = true;
    }
    const rounds = takes.map((t) => t.summary);
    const slots = humans.map((pid) => ({ pid, ...slotHits(rounds, pid) })).filter((x) => x.jackpots || x.skulls);
    this.o.onBadges(this, { humans, winners, director, ...(slots.length ? { slots } : {}) });
  }

  /**
   * «Фильм матча»: монтаж начинается на разоблачении последнего дубля (итоги уже известны) —
   * пока идут повтор и итоги, фильм почти готов; на экране конца матча его получают все в комнате и зрители.
   */
  private startFilm(r: MatchRunner, takes: FilmTake[]): void {
    const film = this.o.film;
    const puzzles = this.o.puzzles;
    if ((!film && !puzzles) || !takes.length) return;
    const n = ++this.filmSeq;
    this.film = { n, state: film ? 'making' : 'failed' };
    const match = r.host.sim.outcome();
    const winners = match.winners.map((pid) => r.players.find((p) => p.pid === pid)?.name ?? '').filter(Boolean);
    void this.makePuzzle(takes).then((puzzle) => {
      if (puzzle && this.film?.n === n) {
        this.film.puzzle = puzzle;
        // код — сразу всем: телефон, который монтирует фильм сам, впишет его в финал
        if (!this.closed) this.broadcastText(JSON.stringify({ t: 'puzzle', code: puzzle } satisfies ServerMsg));
      }
      if (!film) return;
      return film.make({ takes, players: r.players.map((p) => ({ pid: p.pid, name: p.name, color: p.color, ...(p.skin ? { skin: p.skin } : {}) })), match, lang: this.lang, puzzle }).then((done) => {
        // в чат Telegram — даже если все уже ушли или начали реванш: фильм этого матча готов
        const name = (pid: string) => r.players.find((p) => p.pid === pid)?.name ?? '';
        const awards = match.awards.map((a) => ({ id: a.id, names: a.pids.map(name).filter(Boolean) })).filter((a) => a.names.length);
        if (done && this.invite) this.o.onFilm?.(this, { id: done.id, winners, draw: winners.length > 1, awards, puzzle });
        if (this.closed || this.film?.n !== n) return;
        this.film = { n, state: done ? 'ready' : 'failed', done: done ?? undefined, puzzle };
        // конец матча уже на экране — разослать сразу, иначе дождётся его (filmToAll из pump)
        if (this.status === 'lobby' && this.runner?.host.phase === 'match_end') this.filmToAll();
      });
    });
  }

  /** Загадка из дублей матча (puzzles.ts): код или undefined (нет хранилища, нет честного куска, сбой). */
  private async makePuzzle(takes: FilmTake[]): Promise<string | undefined> {
    const store = this.o.puzzles;
    if (!store) return undefined;
    try {
      const p = await store.create(takes, this.lang);
      this.o.log('info', p ? 'puzzle_made' : 'puzzle_none', { room: this.code, ...(p ? { code: p.code, round: p.puzzle.secret.round, tells: p.puzzle.secret.tells, actors: p.puzzle.secret.answer.length } : {}) });
      return p?.code;
    } catch (e) {
      this.o.log('warn', 'puzzle_failed', { room: this.code, err: String(e).slice(0, 300) });
      return undefined;
    }
  }

  /** Разослать, что с фильмом (на экране конца матча). */
  private filmToAll(): void {
    const f = this.film;
    if (!f) return;
    // загадка — до фильма: зашедшим позже (переподключение) код тоже нужен
    if (f.puzzle) this.broadcastText(JSON.stringify({ t: 'puzzle', code: f.puzzle } satisfies ServerMsg));
    // фильм монтирует не сервер (нет ffmpeg) — о нём молчим, как раньше: телефон смонтирует сам
    if (!this.o.film) return;
    const msg: ServerMsg =
      f.state === 'ready' && f.done ? { t: 'film', state: 'ready', id: f.done.id, ext: f.done.ext, thumb: f.done.thumb } : f.state === 'failed' ? { t: 'film', state: 'failed' } : { t: 'film', state: 'making' };
    this.broadcastText(JSON.stringify(msg));
  }

  // ───────────── рассылка ─────────────

  onlineMembers(): Member[] {
    return [...this.members.values()].filter((m) => m.peer).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  onlineCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.peer) n++;
    return n;
  }

  view(): WireRoom {
    return {
      code: this.code,
      status: this.status,
      directorId: this.directorId,
      settings: this.settings,
      members: [...this.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((m) => ({ userId: m.userId, name: m.name, color: m.color, joinedAt: m.joinedAt, online: !!m.peer, ready: m.ready, ...(m.skin ? { skin: m.skin } : {}) })),
    };
  }

  broadcastRoom(): void {
    this.broadcastText(JSON.stringify({ t: 'room', room: this.view() } satisfies ServerMsg));
    this.cardNote();
  }

  /** Карточка в чате Telegram (только комнаты по приглашению): что на ней должно быть сейчас. */
  cardNow(): RoomCard | null {
    if (!this.invite) return null;
    if (this.closed) return this.played ? null : { state: 'closed' };
    const r = this.runner;
    if (this.status === 'playing' && r) {
      // реванш стартует: старый матч ещё на месте — его итог на карточке не нужен
      if (r.host.phase === 'match_end') return null;
      const sim = r.host.sim;
      // счёт — только после разоблачения дубля (до этого очки не начислены и не видны)
      const scores = r.players.map((p) => ({ name: p.name, color: p.color, score: sim.scores[p.pid] ?? 0 })).sort((a, b) => b.score - a.score);
      return { state: 'playing', take: Math.max(1, sim.round), target: sim.cfg.scoreToWin, scores };
    }
    // матч кончился — карточку заменит фильм; лобби до первого матча — сбор
    if (r || this.played) return null;
    const seats = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({ name: m.name, color: m.color }));
    return { state: 'lobby', seats, max: SEATS };
  }

  private cardNote(): void {
    const c = this.cardNow();
    if (!c || !this.o.onCard) return;
    const sig = JSON.stringify(c);
    if (sig === this.cardSig) return;
    this.cardSig = sig;
    this.o.onCard(this, c);
  }

  broadcastText(text: string): void {
    for (const m of this.members.values()) m.peer?.send(text);
    for (const p of this.spectators.values()) p.send(text);
  }

  sendTo(userId: string, msg: ServerMsg): void {
    this.members.get(userId)?.peer?.send(JSON.stringify(msg));
  }

  // ───────────── переезд на другой экземпляр ─────────────

  /** Можно ли перевезти сейчас: лобби (матч доигрывается на месте) и фильм прошлого матча уже разослан. */
  canMove(): boolean {
    return !this.closed && this.status === 'lobby' && this.film?.state !== 'making';
  }

  snapshot(): RoomSnapshot {
    return {
      v: 1,
      code: this.code,
      directorId: this.directorId,
      settings: this.settings,
      lang: this.lang,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      members: [...this.members.values()].map((m) => ({
        userId: m.userId,
        name: m.name,
        color: m.color,
        joinedAt: m.joinedAt,
        ready: m.ready,
        offlineSince: m.peer ? 0 : m.offlineSince || this.now(),
      })),
      spectators: [...this.spectators.keys(), ...this.expectSpectators],
      ...(this.invite ? { invite: this.invite } : {}),
      ...(this.played ? { played: true } : {}),
      ...(this.directorCounted ? { directorCounted: true } : {}),
    };
  }

  /**
   * Комната уже на соседнем экземпляре: всем — «переезжай» с новым адресом и закрыть соединения
   * (без «closed» — иначе клиент решит, что комнаты больше нет).
   */
  moveTo(wsUrl: string): void {
    if (this.closed) return;
    this.closed = true;
    this.runner?.stop();
    this.runner = null;
    const text = JSON.stringify({ t: 'move', url: wsUrl } satisfies ServerMsg);
    for (const m of this.members.values()) {
      m.peer?.send(text);
      m.peer?.close(4005, 'moved');
    }
    for (const p of this.spectators.values()) {
      p.send(text);
      p.close(4005, 'moved');
    }
    this.spectators.clear();
    this.members.clear();
    this.log('info', 'room_moved', { room: this.code });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    // лобби по карточке из Telegram закрылось без матча — «Съёмку отменили» в чате
    this.cardNote();
    this.runner?.stop();
    this.runner = null;
    const text = JSON.stringify({ t: 'closed' } satisfies ServerMsg);
    for (const m of this.members.values()) {
      m.peer?.send(text);
      m.peer?.close(4002, 'closed');
    }
    for (const p of this.spectators.values()) {
      p.send(text);
      p.close(4002, 'closed');
    }
    this.spectators.clear();
    this.members.clear();
    this.log('info', 'room_closed', { room: this.code, reason });
  }
}

/** Имя: без лишних пробелов и управляющих символов, до 14 знаков (как в Supabase). */
export function cleanName(raw: string, fallback: string): string {
  // управляющие, невидимые и «переворачивающие» символы (U+202E, U+200B…) — вон: иначе можно выдать себя за
  // другого игрока в лобби, карточке Telegram и фильме (ревью безопасности, N6). ZWJ оставляем — им склеены эмодзи
  const s = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, (c) => (c === '\u200d' ? c : ''))
    .trim();
  return [...s].slice(0, 14).join('').trim() || fallback;
}
