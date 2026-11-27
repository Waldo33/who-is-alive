import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { stat } from 'node:fs/promises';
import { CLIP_MIME, ClipStore } from './clips';
import type { FilmService } from './film';
import { PUZZLE_CODE, PuzzleStore } from './puzzles';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { ClientMsg, DEFAULT_WIRE_SETTINGS, ROOM_CODE_ALPHABET, RoomSettingsSchema, WIRE_MAX_BYTES, WIRE_VERSION } from '@kto/net';
import { skinOf } from '@kto/game-core';
import type { ServerMsg, WireError } from '@kto/net';
import { Auth } from './auth';
import { Counter, MsgBudget, RateWindow } from './limits';
import type { ErrorTracker } from './errors';
import { errFields, jsonLogger } from './log';
import type { Logger } from './log';
import type { Bot, CardNotice, FilmNotice } from './bot';
import { Room } from './room';
import { localLedger, shopLedgerOp } from './shop';
import type { ShopLedger } from './shop';
import { MemoryStore, parseEvents } from './store';
import type { Store } from './store';
import type { Peer, RoomCard, RoomFilm, RoomSnapshot } from './room';
import type { Geo } from './geo';
import { VideoSwitch } from './video-switch';

export interface GameServerOptions {
  /** Ключ подписи токенов (≥ 32 символов). */
  authSecret: string;
  /** Имя экземпляра для адреса WebSocket: /i/<instance>/ws (синий/зелёный деплой). */
  instance?: string;
  /** Публичная основа адреса WebSocket, например wss://api.benobody.app. Нет — из заголовка Host. */
  publicWsBase?: string;
  /**
   * Свои входы (хосты без схемы): запрос пришёл через один из них — адрес WebSocket тот же
   * (wss://<хост>). Сервер в Европе доступен и как api.benobody.app, и по запасному адресу <IP>.sslip.io:
   * игрок остаётся на том входе, через который пришёл.
   */
  publicWsHosts?: string[];
  /** Разрешённые сайты (CORS и Origin у WebSocket). '*' — любые (разработка). */
  allowedOrigins?: string[] | '*';
  /** За прокси (Caddy): адрес клиента — из X-Forwarded-For. */
  trustProxy?: boolean;
  log?: Logger;
  now?: () => number;
  /** Ускорение времени матча (только тесты). */
  speed?: number;
  /** Сколько комнат одновременно, больше — «сервер занят». */
  maxRooms?: number;
  /** База (аналитика и т. п.); нет — память. */
  store?: Store;
  /** Telegram-бот (маршруты /tg/*); нет ключа — бота нет. */
  bot?: Bot;
  /** Клипы для Telegram (/v1/clips); нет — во временной папке. */
  clips?: ClipStore;
  /** «Фильм матча» (film.ts); нет — фильм монтирует телефон. */
  film?: FilmService;
  /** Загадки из фильма (/v1/puzzles); нет — в подпапке клипов. */
  puzzles?: PuzzleStore;
  /**
   * Бот изнутри (туннель на сервер бота: http://127.0.0.1:9090): фильм матча комнаты по приглашению
   * из Telegram уходит туда — бот заменит им карточку в чате. Нет — не сообщаем.
   */
  botInternal?: string;
  /** Рисование своих стикеров игроков (sticker-render.ts): нет ffmpeg или шрифтов — нет. */
  stickers?: { render(look: unknown): Promise<Buffer> };
  /** Аварийный выключатель видео (video-switch.ts); нет — видео всегда включено. */
  video?: VideoSwitch;
  /** Страна по адресу для замера доступности (geo.ts); нет — неизвестна. */
  geo?: Geo;
  /**
   * Ключ нагрузочного прогона (scripts/load.ts, load-test.yml): запросы с заголовком x-kto-load
   * не упираются в лимиты по адресу (один раннер = тысячи игроков), а их комнаты не монтируют фильм.
   */
  loadKey?: string;
  /** Где стоит сервер (msk, nl…): в ответе /v1/probe. */
  region?: string;
  /**
   * Соседний экземпляр (синий ↔ зелёный на той же машине): куда перевозить комнаты при выкладке.
   * http — его адрес изнутри машины, wsUrl — публичный адрес его WebSocket для клиентов.
   */
  peer?: { http: string; wsUrl: string };
  /** Drain закончился (все комнаты переехали или доиграли) — main.ts завершает процесс. */
  onDrained?: () => void;
  /** Сколько ждать конца матчей при drain, мс (по умолчанию 20 минут: матч идёт около 5). */
  drainMs?: number;
  /**
   * Куда пересылать аналитику (адрес игрового сервера с базой). Сервер в Нидерландах принимает
   * события от тех, кто не достал до Москвы, и пересылает их в Москву по туннелю.
   */
  eventsUpstream?: string;
  /** Трекер ошибок (errors.ts): ошибки с телефонов и от соседа без базы. Нет — только журнал. */
  errors?: ErrorTracker;
}

/** Лимиты (docs/server-migration.md › 3.3). */
const MSGS_PER_SEC = 30;
const MAX_STRIKES = 3;
// за одним адресом бывают тысячи людей (мобильные операторы, VPN, вайфай кафе) — лимиты по IP только
// грубая страховка от ботов, а комнаты ограничиваем по игроку (docs/infra-plan.md › этап 4)
const CONNS_PER_IP = 200;
const ROOMS_PER_USER_MIN = 5;
const ROOMS_PER_IP_MIN = 60;
const AUTH_PER_IP_MIN = 300;
const EVENTS_PER_IP_MIN = 600;
/** Ошибки JS с телефонов: телефон шлёт не больше 10 за заход, это страховка от флуда. */
const ERRORS_PER_IP_MIN = 30;
// на сервере бота все запросы телефонов приходят через Москву (один адрес) — лимит с запасом
const BOT_PER_IP_MIN = 600;
/**
 * Коды комнат (4 буквы, ~280 тысяч): GET /v1/rooms/<код> и вход по коду. Обычному игроку хватает пары
 * запросов на комнату, промахи (опечатка, старая ссылка) редки — их лимит строже: перебрать все коды
 * с одного адреса нельзя (ревью безопасности, M1). Свои запросы машины (превью ссылок сайта) — без лимита.
 */
const ROOM_LOOKUPS_PER_IP_MIN = 120;
const ROOM_MISSES_PER_IP = 30;
const ROOM_MISS_WINDOW_MS = 10 * 60_000;
/** Загрузок клипов с одного адреса за 10 минут: игроку — пара клипов на матч, за одним адресом бывает компания. */
const CLIPS_PER_IP = 60;
/** Загадка: открыть и тапнуть — на зрителя десяток запросов. */
const PUZZLE_PER_IP_MIN = 120;
/** Лобби без действий — закрыть; комната старше — закрыть; без единого игрока на связи — закрыть. */
const LOBBY_IDLE_MS = 30 * 60_000;
const ROOM_MAX_AGE_MS = 6 * 3600_000;
const EMPTY_CLOSE_MS = 10 * 60_000;
/** Комнаты нагрузочного прогона: пустая закрывается почти сразу — не держит места у настоящих игроков. */
const LOAD_EMPTY_CLOSE_MS = 15_000;
const HELLO_TIMEOUT_MS = 10_000;
/** Метка приглашения (startapp=g_<метка> из карточки бота). */
const INVITE = /^[A-Za-z0-9]{8,32}$/;
const HEARTBEAT_MS = 10_000;

interface ConnState {
  userId: string | null;
  room: Room | null;
  ip: string;
  budget: MsgBudget;
  alive: boolean;
  name: string;
}

export class GameServer {
  readonly http: Server;
  readonly rooms = new Map<string, Room>();
  /** Приглашение из Telegram → код его комнаты (пока комната жива). */
  private readonly invites = new Map<string, string>();
  readonly instance: string;
  draining = false;
  /** Когда drain обязан закончиться (матчи, не доигравшие к этому сроку, закрываются). */
  private drainUntil = 0;
  private drainedFired = false;
  /** Комнаты, переезд которых сейчас идёт (запрос соседу в пути). */
  private moving = new Set<string>();
  /** Соседний экземпляр (из опций или setPeer). */
  private peer: GameServerOptions['peer'];
  private readonly auth: Auth;
  /** Учёт гардероба для бота с другого сервера (/internal/shop): связь с Telegram проверяет здешний токен. */
  private readonly ledger: ShopLedger;
  private readonly clips: ClipStore;
  private readonly wss: WebSocketServer;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly speed: number;
  private readonly maxRooms: number;
  private readonly conns = new Map<WebSocket, ConnState>();
  private readonly video: VideoSwitch;
  private readonly ipConns = new Counter();
  private readonly roomRate = new RateWindow(ROOMS_PER_IP_MIN, 60_000);
  private readonly roomUserRate = new RateWindow(ROOMS_PER_USER_MIN, 60_000);
  private readonly authRate = new RateWindow(AUTH_PER_IP_MIN, 60_000);
  private readonly eventsRate = new RateWindow(EVENTS_PER_IP_MIN, 60_000);
  private readonly errorsRate = new RateWindow(ERRORS_PER_IP_MIN, 60_000);
  private readonly botRate = new RateWindow(BOT_PER_IP_MIN, 60_000);
  private readonly puzzleRate = new RateWindow(PUZZLE_PER_IP_MIN, 60_000);
  private readonly clipIpRate = new RateWindow(CLIPS_PER_IP, 10 * 60_000);
  private readonly roomLookupRate = new RateWindow(ROOM_LOOKUPS_PER_IP_MIN, 60_000);
  private readonly roomMissRate = new RateWindow(ROOM_MISSES_PER_IP, ROOM_MISS_WINDOW_MS);
  readonly puzzles: PuzzleStore;
  readonly store: Store;
  private readonly emptySince = new Map<Room, number>();
  /** Коды комнат нагрузочного прогона (создатель пришёл с LOAD_KEY). */
  private readonly loadRooms = new Set<string>();
  /** Комнаты, которые нельзя перевезти (код у соседа занят другой комнатой). */
  private readonly noMove = new Set<string>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private slow: ReturnType<typeof setInterval> | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  /** Счётчики для /metrics. */
  readonly stats = { matches: 0, clientErrors: 0, rejected: new Counter() };

  constructor(private readonly o: GameServerOptions) {
    this.auth = new Auth(o.authSecret);
    this.clips = o.clips ?? new ClipStore(undefined, () => this.now());
    this.puzzles = o.puzzles ?? new PuzzleStore(join(this.clips.dir, 'puzzles'), () => this.now());
    this.instance = o.instance ?? 'blue';
    this.log = o.log ?? jsonLogger();
    this.now = o.now ?? Date.now;
    this.speed = o.speed ?? 1;
    this.video = o.video ?? new VideoSwitch(null);
    this.maxRooms = o.maxRooms ?? 2000;
    this.peer = o.peer;
    this.store = o.store ?? new MemoryStore();
    this.ledger = localLedger(
      this.store,
      (t) => this.auth.verify(t),
      // связь с Telegram часто приходит, когда игрок уже в лобби (RoomClient › linkTelegramOnce)
      (u) => {
        for (const r of this.rooms.values()) if (r.members.has(u)) this.skinFor(r, u);
      },
    );
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WIRE_MAX_BYTES });
    this.http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      // любой /i/<экземпляр>/ws: если экземпляр уже завершился, Caddy отдаёт его адрес соседу
      if (!/^\/i\/[a-z0-9-]{1,16}\/ws$/.test(path) && path !== '/ws') return socket.destroy();
      if (!this.originOk(req.headers.origin)) return socket.destroy();
      const ip = this.ip(req);
      if (this.ipConns.get(ip) >= CONNS_PER_IP && !this.isLoad(req)) {
        this.stats.rejected.inc('ip_conns');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
    });
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve) => this.http.listen(port, host, resolve));
    this.loop = setInterval(() => this.pump(), 20);
    this.slow = setInterval(() => this.housekeeping(), 1000);
    this.hb = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    return (this.http.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const t of [this.loop, this.slow, this.hb]) if (t) clearInterval(t);
    for (const r of this.rooms.values()) r.close('shutdown');
    this.rooms.clear();
    for (const ws of this.conns.keys()) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ───────────── цикл ─────────────

  pump(): void {
    for (const r of this.rooms.values()) r.pump();
  }

  housekeeping(): void {
    const now = this.now();
    // аварийный выключатель видео: файл появился или пропал — сказать всем телефонам
    if (this.video.check(now)) {
      this.log('warn', this.video.on ? 'video_on' : 'video_off');
      const text = this.flagsText();
      for (const [ws, st] of this.conns) if (st.userId) ws.send(text);
    }
    for (const r of [...this.rooms.values()]) {
      r.housekeeping();
      if (r.onlineCount() === 0) {
        if (!this.emptySince.has(r)) this.emptySince.set(r, now);
      } else this.emptySince.delete(r);
      const empty = this.emptySince.get(r);
      let why = '';
      if (r.members.size === 0) why = 'no_members';
      else if (empty !== undefined && now - empty > (this.loadRooms.has(r.code) ? LOAD_EMPTY_CLOSE_MS : EMPTY_CLOSE_MS)) why = 'empty';
      else if (now - r.createdAt > ROOM_MAX_AGE_MS) why = 'age';
      else if (r.status === 'lobby' && now - r.lastActive > LOBBY_IDLE_MS) why = 'idle';
      if (why) this.dropRoom(r, why);
    }
    if (this.draining) this.drainStep(now);
    this.roomRate.sweep(now);
    this.roomUserRate.sweep(now);
    this.authRate.sweep(now);
    this.eventsRate.sweep(now);
    this.botRate.sweep(now);
    this.roomLookupRate.sweep(now);
    this.clipIpRate.sweep(now);
    this.roomMissRate.sweep(now);
  }

  private bindInvite(r: Room, invite: string): void {
    r.invite = invite;
    this.invites.set(invite, r.code);
  }

  private dropRoom(r: Room, why: string): void {
    r.close(why);
    if (r.invite && this.invites.get(r.invite) === r.code) this.invites.delete(r.invite);
    this.rooms.delete(r.code);
    this.emptySince.delete(r);
    this.loadRooms.delete(r.code);
    this.noMove.delete(r.code);
  }

  private flagsText(): string {
    return JSON.stringify({ t: 'flags', video: this.video.on } satisfies ServerMsg);
  }

  private heartbeat(): void {
    const text = JSON.stringify({ t: 'hb' } satisfies ServerMsg);
    for (const [ws, st] of this.conns) {
      if (!st.alive) {
        ws.terminate();
        continue;
      }
      st.alive = false;
      ws.ping();
      ws.send(text);
    }
  }

  // ───────────── HTTP ─────────────

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && this.originOk(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-tg-init');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return this.reply(res, 204);
    // «Кривой» путь (/tg/..\internal/…, %2e%2e, %2f): URL ниже схлопнул бы его в другой маршрут, чем видел Caddy, —
    // так снаружи можно было бы попасть в /internal/*. Своим клиентам такие пути не нужны: отказ сразу
    if (badPath(req.url ?? '/')) return this.reply(res, 400, { error: 'bad_path' });
    try {
      const p = url.pathname;
      if (p === '/healthz') return this.reply(res, 200, { ok: true });
      if (p === '/readyz') return this.reply(res, this.draining ? 503 : 200, { ok: !this.draining, instance: this.instance });
      if (p === '/metrics' && req.method === 'GET') return await this.metrics(req, res);
      if (p === '/v1/auth/anon' && req.method === 'POST') {
        if (!this.isLoad(req) && !this.authRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
        return this.reply(res, 200, await this.auth.issue());
      }
      if (p.startsWith('/internal/')) return await this.internalRoute(req, res, p);
      if (p === '/v1/rooms' && req.method === 'POST') return this.createRoom(req, res);
      if (p === '/v1/events' && req.method === 'POST') return this.events(req, res);
      if (p === '/v1/probe' && req.method === 'GET') return this.probe(req, res, url);
      // переключатели для песочницы и главной (там нет WebSocket): выключено ли видео
      if (p === '/v1/flags' && req.method === 'GET') return this.reply(res, 200, { video: this.video.on });
      if (p === '/v1/errors' && req.method === 'POST') return this.clientError(req, res);
      if (p.startsWith('/v1/clips')) return this.clipRoute(req, res, p);
      if (p.startsWith('/v1/puzzles/')) return await this.puzzleRoute(req, res, p);
      if (p.startsWith('/tg/')) {
        if (!this.o.bot) return this.reply(res, 503, { error: 'no_bot' });
        // вебхук Telegram — без лимита (его проверяет секретный заголовок), остальное — по адресу
        // перепривязка вебхука и состояние бота — только изнутри машины (выкладка по SSH, сторож): иначе любой
        // скрипт гоняет setWebhook и профиль бота, и Telegram на время режет боту все методы
        if ((p === '/tg/setup' || p === '/tg/status') && !this.internal(req)) return this.reply(res, 404, { error: 'not_found' });
        if (p !== '/tg/hook' && !this.botRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
        const body = req.method === 'POST' ? await readJson(req, 65_536) : null;
        const r = await this.o.bot.handle(req.method ?? 'GET', p.slice(3), req.headers, body);
        return this.reply(res, r.status, r.body);
      }
      const m = /^\/v1\/rooms\/([A-Za-z]{4})$/.exec(p);
      if (m && req.method === 'GET') {
        const ip = this.ip(req);
        const free = this.internal(req) || this.isLoad(req) || this.ownMachine(ip);
        if (!free && (this.roomMissRate.full(ip, this.now()) || !this.roomLookupRate.take(ip, this.now()))) {
          return this.reply(res, 429, { error: 'rate_limited' });
        }
        const r = this.rooms.get(m[1].toUpperCase());
        if (!r) {
          // комната могла переехать или жить у соседа (выкладка): спросить его, если вопрос не от него же
          const far = req.headers['x-kto-peer'] && this.internal(req) ? null : await this.peerRoom(m[1].toUpperCase());
          if (!far && !free) this.roomMissRate.take(ip, this.now());
          return far ? this.reply(res, 200, far) : this.reply(res, 404, { error: 'room_not_found' });
        }
        return this.reply(res, 200, {
          code: r.code,
          status: r.status,
          players: r.view().members.map((x) => ({ name: x.name, color: x.color })),
          wsUrl: this.wsUrl(req),
        });
      }
      return this.reply(res, 404, { error: 'not_found' });
    } catch (e) {
      this.log('error', 'http_error', { path: url.pathname, ...errFields(e) });
      return this.reply(res, 500, { error: 'internal' });
    }
  }

  private async createRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = await this.bearer(req);
    if (!userId) return this.reply(res, 401, { error: 'bad_token' });
    const body = (await readJson(req)) as { name?: unknown; settings?: unknown; lang?: unknown; invite?: unknown } | null;
    // приглашение из Telegram (карточка «Собрать комнату» инлайн-режима бота): первый нажавший создаёт
    // комнату, остальные по той же карточке попадают в неё же
    const invite = typeof body?.invite === 'string' && INVITE.test(body.invite) ? body.invite : undefined;
    if (invite) {
      const have = this.rooms.get(this.invites.get(invite) ?? '');
      if (have && !have.closed) return this.reply(res, 200, { code: have.code, wsUrl: this.wsUrl(req) });
    }
    if (this.draining || this.rooms.size >= this.maxRooms) return this.reply(res, 503, { error: 'server_busy' });
    const load = this.isLoad(req);
    if (!load && (!this.roomUserRate.take(userId, this.now()) || !this.roomRate.take(this.ip(req), this.now()))) return this.reply(res, 429, { error: 'rate_limited' });
    const settings = RoomSettingsSchema.safeParse(body?.settings);
    const code = this.newCode();
    if (!code) return this.reply(res, 503, { error: 'server_busy' });
    const room = new Room({
      code,
      directorId: userId,
      directorName: typeof body?.name === 'string' ? body.name : '',
      settings: settings.success ? settings.data : DEFAULT_WIRE_SETTINGS,
      lang: body?.lang === 'en' ? 'en' : 'ru',
      now: this.now,
      log: this.log,
      speed: this.speed,
      // нагрузочный прогон: фильм матча не монтируем (ffmpeg исказил бы замер и занял бы процессор)
      film: load ? undefined : this.o.film,
      puzzles: load ? undefined : this.puzzles,
      videoOn: () => this.video.on,
      onFilm: (r, f) => this.filmToChat(r, f),
      onCard: (r, c) => this.cardToChat(r, c),
      onStickers: load ? undefined : (r, e) => this.stickersToBot(r, e),
    });
    this.rooms.set(code, room);
    if (load) this.loadRooms.add(code);
    if (invite) this.bindInvite(room, invite);
    this.log('info', 'room_created', { room: code, user: hashId(userId), ...(load ? { load: true } : {}), ...(invite ? { invite: true } : {}) });
    return this.reply(res, 200, { code, wsUrl: this.wsUrl(req) });
  }

  /**
   * Аналитика воронки: пачка событий (как RPC log_events в Supabase). Тело — JSON с типом text/plain,
   * чтобы браузер слал без предварительного запроса и с keepalive при закрытии вкладки.
   */
  private async events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const internal = this.internal(req);
    if (!internal && !this.eventsRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const b = parseEvents(await readJson(req));
    if (!b) return this.reply(res, 400, { error: 'bad_events' });
    // замер доступности: страна адреса (сам адрес не храним). Пересланное соседом — страна уже стоит
    for (const e of b.events) {
      if (e.name !== 'net_probe' && e.name !== 'net_fail') continue;
      if (!internal || typeof e.props.cc !== 'string') e.props = { ...e.props, cc: this.o.geo?.country(this.ip(req)) ?? null, via: this.o.region ?? null };
    }
    if (this.o.eventsUpstream) return this.relayEvents(res, b);
    const userId = b.token ? await this.auth.verify(b.token) : null;
    try {
      await this.store.logEvents(b.device, b.session, userId, b.events);
    } catch (e) {
      this.log('error', 'events_store', { err: String(e) });
      return this.reply(res, 503, { error: 'store' });
    }
    return this.reply(res, 204);
  }

  /**
   * Ошибка JS с телефона (lib/errors.ts на сайте): пишем в журнал — оттуда VictoriaLogs и Grafana,
   * счётчик game_client_errors_total — для тревоги сторожа. Тело — JSON с типом text/plain (без CORS-запроса).
   */
  private async clientError(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.errorsRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const e = parseClientError(await readJson(req, 8192));
    if (!e) return this.reply(res, 400, { error: 'bad_error' });
    this.stats.clientErrors++;
    // в журнал — без стека и шагов (они в базе трекера), с отпечатком группы: по нему ищется в VictoriaLogs
    const row = this.o.errors?.capture({
      source: 'web',
      kind: e.kind,
      message: e.msg,
      stack: e.stack,
      at: e.at,
      build: e.build,
      ctx: { ...e.ctx, path: e.path ?? '', app: e.app ?? e.ctx.app ?? '', ua: e.ua ?? '' },
      crumbs: e.crumbs,
    });
    this.log('warn', 'client_error', { error: e.msg, kind: e.kind, at: row?.culprit || e.at, build: e.build, path: e.path, app: e.app, ua: e.ua, fp: row?.fp });
    return this.reply(res, 204);
  }

  // ───────────── выкладка без обрыва: drain и переезд комнат ─────────────

  /** Внутренние маршруты (только изнутри машины): переезд комнат и drain при выкладке. */
  private async internalRoute(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
    if (!this.internal(req)) return this.reply(res, 404, { error: 'not_found' });
    if (p === '/internal/import' && req.method === 'POST') {
      const snap = (await readJson(req, 65_536)) as RoomSnapshot | null;
      if (!snap || snap.v !== 1 || typeof snap.code !== 'string' || !Array.isArray(snap.members)) return this.reply(res, 400, { error: 'bad_snapshot' });
      const have = this.rooms.get(snap.code);
      // 409 — эта же комната уже здесь (повтор после сбоя); тот же код у другой комнаты (другой сервер) — 422,
      // и переезжать нельзя: игроки попали бы в чужую комнату
      if (have && !have.closed) return have.directorId === snap.directorId ? this.reply(res, 409, { error: 'exists' }) : this.reply(res, 422, { error: 'code_taken' });
      const room = new Room({
        code: snap.code,
        directorId: snap.directorId,
        directorName: '',
        settings: snap.settings,
        lang: snap.lang === 'en' ? 'en' : 'ru',
        now: this.now,
        log: this.log,
        speed: this.speed,
        film: this.o.film,
        puzzles: this.puzzles,
        videoOn: () => this.video.on,
        onFilm: (r, f) => this.filmToChat(r, f),
        onCard: (r, c) => this.cardToChat(r, c),
        onStickers: snap.load === true ? undefined : (r, e) => this.stickersToBot(r, e),
        restore: snap,
      });
      this.rooms.set(snap.code, room);
      if (snap.load === true) this.loadRooms.add(snap.code);
      if (typeof snap.invite === 'string' && INVITE.test(snap.invite)) this.bindInvite(room, snap.invite);
      // пустая комната продолжает отсчёт до закрытия, а не держит место ещё 10 минут
      if (typeof snap.emptyMs === 'number' && snap.emptyMs >= 0) this.emptySince.set(room, this.now() - Math.min(snap.emptyMs, EMPTY_CLOSE_MS));
      this.log('info', 'room_imported', { room: snap.code, members: snap.members.length, ...(snap.load ? { load: true } : {}) });
      return this.reply(res, 204);
    }
    if (p === '/internal/tg/film' && req.method === 'POST') {
      // сервер бота: игровой сервер (по туннелю) сообщает, что фильм комнаты по приглашению готов
      if (!this.o.bot) return this.reply(res, 503, { error: 'no_bot' });
      const r = await this.o.bot.film(((await readJson(req, 4096)) ?? {}) as FilmNotice);
      return this.reply(res, r.status, r.body);
    }
    if (p === '/internal/tg/card' && req.method === 'POST') {
      // сервер бота: игровой сервер сообщает, что на карточке комнаты по приглашению (сбор, съёмка)
      if (!this.o.bot) return this.reply(res, 503, { error: 'no_bot' });
      const r = await this.o.bot.card(((await readJson(req, 4096)) ?? {}) as CardNotice);
      return this.reply(res, r.status, r.body);
    }
    // гардероб: учёт покупок и стикеров для сервера бота (без своей базы) — по туннелю, в базу игрового
    if (p === '/internal/shop' && req.method === 'POST') {
      const r = await shopLedgerOp(this.ledger, await readJson(req, 16_384));
      return this.reply(res, r.status, r.body);
    }
    // свой стикер игрока («Собери свой стикерпак»): сервер бота без ffmpeg просит нарисовать его здесь (по туннелю)
    if (p === '/internal/sticker' && req.method === 'POST') {
      if (!this.o.stickers) return this.reply(res, 503, { error: 'no_renderer' });
      try {
        const webm = await this.o.stickers.render(await readJson(req, 4096));
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': webm.length, 'Cache-Control': 'no-store' });
        res.end(webm);
        return;
      } catch (e) {
        const code = String(e instanceof Error ? e.message : e);
        return this.reply(res, code === 'bad_sticker' ? 400 : code === 'busy' ? 429 : 500, { error: code === 'bad_sticker' || code === 'busy' ? code : 'render' });
      }
    }
    // стикеры, открытые в матче (от игрового сервера, по туннелю) — бот кладёт их в пак игрока
    if (p === '/internal/tg/stickers' && req.method === 'POST') {
      if (!this.o.bot) return this.reply(res, 503, { error: 'no_bot' });
      return this.reply(res, 200, await this.o.bot.shop.earn(await readJson(req, 16_384)));
    }
    // возврат звёзд за покупку (руками, по SSH на сервере бота): набор забирается
    if (p === '/internal/tg/refund' && req.method === 'POST') {
      if (!this.o.bot) return this.reply(res, 503, { error: 'no_bot' });
      const r = await this.o.bot.shop.refund(((await readJson(req, 4096)) as { charge?: unknown } | null)?.charge);
      return this.reply(res, r.status, r.body);
    }
    // группы ошибок от сервера бота (Нидерланды, без своей базы) — по туннелю
    if (p === '/internal/errors' && req.method === 'POST') {
      if (!this.o.errors) return this.reply(res, 503, { error: 'no_tracker' });
      const n = this.o.errors.ingest(await readJson(req, 262_144));
      return this.reply(res, 200, { ok: true, n });
    }
    if (p === '/internal/drain' && req.method === 'POST') {
      // переезд на другой сервер (Москва → Европа): сосед — из тела запроса, а не соседний цвет
      const body = (await readJson(req, 4096)) as { peer?: { http?: unknown; wsUrl?: unknown } } | null;
      const np = body?.peer;
      if (np && typeof np.http === 'string' && typeof np.wsUrl === 'string' && /^https?:\/\//.test(np.http) && /^wss?:\/\//.test(np.wsUrl)) {
        this.setPeer({ http: np.http.replace(/\/$/, ''), wsUrl: np.wsUrl });
        this.log('info', 'peer_set', { http: np.http, wsUrl: np.wsUrl });
      }
      this.drain();
      return this.reply(res, 200, { draining: true, rooms: this.rooms.size });
    }
    if (p === '/internal/undrain' && req.method === 'POST') {
      // откат выкладки: снова принимаем новые комнаты (переехавшие обратно не вернутся — они у соседа)
      this.draining = false;
      this.drainUntil = 0;
      return this.reply(res, 200, { draining: false, rooms: this.rooms.size });
    }
    return this.reply(res, 404, { error: 'not_found' });
  }

  /** Задать соседа после запуска (тесты: порты известны только после listen). */
  setPeer(peer: GameServerOptions['peer']): void {
    this.peer = peer;
  }

  /**
   * Выкладка: новых комнат не создаём, лобби перевозим к соседу, матчи доигрываем (после матча
   * комната тоже переезжает). Пусто или вышел срок — onDrained (процесс завершается).
   */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainUntil = this.now() + (this.o.drainMs ?? 20 * 60_000);
    this.log('info', 'drain_start', { rooms: this.rooms.size, peer: !!this.peer });
    this.drainStep(this.now());
  }

  private drainStep(now: number): void {
    for (const r of [...this.rooms.values()]) {
      if (r.closed) {
        this.rooms.delete(r.code);
        continue;
      }
      // без участников перевозить нечего; без соседа — лобби доживают здесь до срока
      if (r.members.size === 0) {
        this.dropRoom(r, 'drain_empty');
        continue;
      }
      if (this.peer && r.canMove() && !this.moving.has(r.code) && !this.noMove.has(r.code)) void this.moveRoom(r);
    }
    if (now >= this.drainUntil) {
      for (const r of [...this.rooms.values()]) this.dropRoom(r, 'drain_deadline');
    }
    if (this.rooms.size === 0 && this.moving.size === 0 && !this.drainedFired) {
      this.drainedFired = true;
      this.log('info', 'drain_done', {});
      this.o.onDrained?.();
    }
  }

  /** Перевезти комнату к соседу: снимок → он создаёт такую же → игрокам «переезжай». */
  private async moveRoom(r: Room): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    this.moving.add(r.code);
    try {
      const empty = this.emptySince.get(r);
      const snap: RoomSnapshot = {
        ...r.snapshot(),
        ...(this.loadRooms.has(r.code) ? { load: true } : {}),
        ...(empty !== undefined ? { emptyMs: this.now() - empty } : {}),
      };
      const res = await fetch(`${peer.http}/internal/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snap),
        signal: AbortSignal.timeout(5000),
      });
      // 409 — у соседа уже есть такая (повтор после сбоя): всё равно переезжаем к нему
      if (res.status === 422) {
        // код занят чужой комнатой у соседа — эта доживёт здесь до срока drain
        this.log('warn', 'room_move_conflict', { room: r.code });
        this.noMove.add(r.code);
        return;
      }
      if (res.status !== 204 && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      if (r.closed || r.status !== 'lobby') return;
      r.moveTo(peer.wsUrl);
      this.rooms.delete(r.code);
      this.emptySince.delete(r);
      this.loadRooms.delete(r.code);
    } catch (e) {
      // сосед не ответил — попробуем на следующем шаге drain (раз в секунду)
      this.log('warn', 'room_move_failed', { room: r.code, err: String(e) });
    } finally {
      this.moving.delete(r.code);
    }
  }

  /** Есть ли комната у соседа: его ответ /v1/rooms/<код> (с его адресом WebSocket) или null. */
  private async peerRoom(code: string): Promise<unknown> {
    const peer = this.peer;
    if (!peer) return null;
    try {
      const r = await fetch(`${peer.http}/v1/rooms/${code}`, { headers: { 'x-kto-peer': '1' }, signal: AbortSignal.timeout(2000) });
      if (!r.ok) return null;
      const body = (await r.json()) as Record<string, unknown>;
      // адрес изнутри машины клиенту не нужен — отдаём публичный
      return { ...body, wsUrl: peer.wsUrl };
    } catch {
      return null;
    }
  }

  /** Переслать пачку событий на сервер с базой (с сервера в Нидерландах — в Москву по туннелю). */
  private async relayEvents(res: ServerResponse, b: NonNullable<ReturnType<typeof parseEvents>>): Promise<void> {
    try {
      const r = await fetch(`${this.o.eventsUpstream}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ d: b.device, s: b.session, t: b.token, e: b.events.map((e) => ({ n: e.name, p: e.props, r: e.room ?? undefined })) }),
        signal: AbortSignal.timeout(10_000),
      });
      return this.reply(res, r.status === 204 ? 204 : 502);
    } catch (e) {
      this.log('warn', 'events_relay', { err: String(e) });
      return this.reply(res, 502, { error: 'relay' });
    }
  }

  /**
   * Замер доступности (lib/netprobe.ts на сайте): маленький ответ — «достаю ли», `?kb=64` — кусок
   * случайных байт, чтобы поймать фильтр, который глушит соединение после первых ~16 КБ.
   */
  private probe(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!this.eventsRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const kb = Math.max(0, Math.min(64, Number(url.searchParams.get('kb')) || 0));
    if (!kb) return this.reply(res, 200, { ok: true, region: this.o.region ?? null, instance: this.instance });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(randomBytes(kb * 1024));
  }

  /** Нагрузочный прогон с верным ключом (заголовок x-kto-load). */
  private isLoad(req: IncomingMessage): boolean {
    const k = this.o.loadKey;
    const h = req.headers['x-kto-load'];
    if (!k || typeof h !== 'string' || h.length !== k.length) return false;
    return timingSafeEqual(Buffer.from(h), Buffer.from(k));
  }

  /** Запрос изнутри машины (сосед-экземпляр, сосед по туннелю), не снаружи: внешним Caddy ставит адрес клиента. */
  /** Фильм матча готов, а комната собрана карточкой из Telegram — отдать боту (он заменит карточку видео). */
  private filmToChat(room: Room, f: RoomFilm): void {
    const base = this.o.botInternal;
    if (!base || !room.invite) return;
    const body: FilmNotice = { invite: room.invite, id: f.id, code: room.code, winners: f.winners, draw: f.draw, awards: f.awards, ...(f.puzzle ? { puzzle: f.puzzle } : {}) };
    void fetch(`${base}/internal/tg/film`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { sent?: boolean } | null;
        this.log(r.ok ? 'info' : 'warn', 'film_to_chat', { room: room.code, status: r.status, sent: !!j?.sent });
      })
      .catch((e) => this.log('warn', 'film_to_chat', { room: room.code, err: String(e) }));
  }

  /**
   * Стикеры за матч: кому из игроков что открылось (room.ts › earnedStickers) — тем, кто связан с Telegram
   * (/tg/shop/link), бот положит их в пак. Бот на другом сервере (туннель) или в этом же процессе.
   */
  private stickersToBot(room: Room, earned: { pid: string; stickers: string[] }[]): void {
    const base = this.o.botInternal;
    const bot = this.o.bot;
    if (!base && !bot) return;
    void this.store
      .telegramOf(earned.map((e) => e.pid))
      .then(async (links) => {
        const users = links.flatMap((l) => {
          const e = earned.find((x) => x.pid === l.gameUser);
          return e ? [{ tgUser: l.tgUser, name: l.name, lang: l.lang, stickers: e.stickers }] : [];
        });
        if (!users.length) return;
        if (!base) return void (await bot!.shop.earn({ users }));
        const r = await fetch(`${base}/internal/tg/stickers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ users }),
          signal: AbortSignal.timeout(10_000),
        });
        this.log(r.ok ? 'info' : 'warn', 'stickers_to_bot', { room: room.code, status: r.status, users: users.length });
      })
      .catch((e) => this.log('warn', 'stickers_to_bot', { room: room.code, err: String(e) }));
  }

  /**
   * Скин игрока — по покупкам его Telegram (tg_links → shop_users), а не с телефона: надеть некупленное
   * нельзя. Приходит в комнату чуть позже входа; ошибка базы — просто без скина.
   */
  private skinFor(room: Room, userId: string): void {
    void this.store
      .telegramOf([userId])
      .then(async (links) => {
        const tg = links[0];
        const u = tg ? await this.store.shopUser(tg.tgUser) : null;
        room.setSkin(userId, (u && skinOf(u.items)) ?? null);
      })
      .catch((e) => this.log('warn', 'skin_lookup', { room: room.code, err: String(e) }));
  }

  /** Живая карточка в чате: состав лобби или счёт съёмки — боту, он перерисует карточку (bot.ts › card). */
  private cardToChat(room: Room, c: RoomCard): void {
    const base = this.o.botInternal;
    if (!base || !room.invite) return;
    const body: CardNotice = { invite: room.invite, code: room.code, ...c };
    void fetch(`${base}/internal/tg/card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => {
        if (!r.ok) this.log('warn', 'card_to_chat', { room: room.code, status: r.status });
      })
      .catch((e) => this.log('warn', 'card_to_chat', { room: room.code, err: String(e) }));
  }

  private internal(req: IncomingMessage): boolean {
    const loop = (x: string) => x === '127.0.0.1' || x === '::1' || x === '::ffff:127.0.0.1';
    if (!loop(req.socket.remoteAddress ?? '')) return false;
    const xf = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
    // внутренний вход Caddy (127.0.0.1:8080, синий/зелёный) ставит адрес клиента — тоже 127.0.0.1
    return !first || loop(first);
  }

  private newCode(): string | null {
    for (let i = 0; i < 200; i++) {
      let c = '';
      // синий и зелёный берут первую букву из разных половин алфавита: код не столкнётся с соседским
      const half = Math.ceil(ROOM_CODE_ALPHABET.length / 2);
      const [lo, hi] = this.instance === 'blue' ? [0, half] : this.instance === 'green' ? [half, ROOM_CODE_ALPHABET.length] : [0, ROOM_CODE_ALPHABET.length];
      c += ROOM_CODE_ALPHABET[lo + randomInt(hi - lo)];
      for (let k = 1; k < 4; k++) c += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  private async metrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // только изнутри машины: напрямую или через внутренний вход Caddy 127.0.0.1:8080 (синий/зелёный —
    // он ставит X-Forwarded-For: 127.0.0.1); снаружи Caddy этот путь не пропускает вовсе
    if (this.o.trustProxy && !this.internal(req)) return this.reply(res, 404, { error: 'not_found' });
    let players = 0;
    let playing = 0;
    const steps: number[] = [];
    for (const r of this.rooms.values()) {
      players += r.onlineCount();
      if (r.status === 'playing') playing++;
      if (r.runner) steps.push(...r.runner.stepMs);
    }
    steps.sort((a, b) => a - b);
    const p99 = steps.length ? steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.99))] : 0;
    const lines = [
      `game_rooms{instance="${this.instance}"} ${this.rooms.size}`,
      `game_rooms_limit{instance="${this.instance}"} ${this.maxRooms}`,
      `game_rooms_playing{instance="${this.instance}"} ${playing}`,
      `game_players_online{instance="${this.instance}"} ${players}`,
      `game_connections{instance="${this.instance}"} ${this.conns.size}`,
      `game_matches_total{instance="${this.instance}"} ${this.stats.matches}`,
      `game_client_errors_total{instance="${this.instance}"} ${this.stats.clientErrors}`,
      `game_errors_captured_total{instance="${this.instance}"} ${this.o.errors?.stats.captured ?? 0}`,
      `game_error_groups_new_total{instance="${this.instance}"} ${this.o.errors?.stats.groupsNew ?? 0}`,
      `game_step_ms_p99{instance="${this.instance}"} ${p99.toFixed(3)}`,
      `game_draining{instance="${this.instance}"} ${this.draining ? 1 : 0}`,
    ];
    // место под клипы для Telegram: тревога сторожа на 80% лимита (пора S3), график в Grafana
    const c = await this.clips.usage();
    lines.push(`game_clips_bytes ${c.bytes}`, `game_clips_count ${c.count}`, `game_clips_limit_bytes ${c.limit}`);
    if (this.clips.hasRemote) {
      const r = this.clips.remoteStats;
      lines.push(`game_clips_s3_uploaded_total ${r.uploaded}`, `game_clips_s3_failed_total ${r.failed}`, `game_clips_s3_redirects_total ${r.redirects}`, `game_clips_s3_direct_total ${r.direct}`);
    }
    // фильм матча: сколько смонтировано, неудач, очередь, время последнего (тревога, если монтаж встал)
    const f = this.o.film;
    if (f) lines.push(`game_films_total ${f.made}`, `game_films_failed_total ${f.failed}`, `game_film_queue ${f.queued}`, `game_film_last_ms ${f.lastMs}`,
        `game_death_clips_total ${f.clipsMade}`, `game_death_clips_failed_total ${f.clipsFailed}`, `game_death_clips_busy_total ${f.clipsRejected}`, `game_death_clip_last_ms ${f.lastClipMs}`, `game_death_preclips_total ${f.preclips}`, `game_film_worker_starts_total ${f.workerStarts}`);
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
  }

  private wsUrl(req: IncomingMessage): string {
    const host = (req.headers.host ?? '').toLowerCase();
    const own = host && this.o.publicWsHosts?.includes(host) ? `wss://${host}` : undefined;
    const base = own ?? this.o.publicWsBase ?? `ws://${req.headers.host ?? 'localhost'}`;
    return `${base}/i/${this.instance}/ws`;
  }

  private async bearer(req: IncomingMessage): Promise<string | null> {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    return token ? this.auth.verify(token) : null;
  }

  private reply(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /** Клипы для Telegram (`clips.ts`): загрузка — с токеном игрока, файл — по ссылке. */
  private async clipRoute(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
    // загрузки клипов: кроме лимита на игрока (clips.ts) — и по адресу: токенов можно взять сколько угодно,
    // без этого хранилище становится бесплатным файлообменником (ревью безопасности, M3)
    if ((p === '/v1/clips' || p === '/v1/clips/direct') && req.method === 'POST' && !this.isLoad(req) && !this.clipIpRate.take(this.ip(req), this.now())) {
      return this.reply(res, 429, { error: 'rate_limited' });
    }
    if (p === '/v1/clips' && req.method === 'POST') {
      const user = await this.bearer(req);
      if (!user) return this.reply(res, 401, { error: 'bad_token' });
      const r = await this.clips.upload(user, req);
      return this.reply(res, r.status, r.body);
    }
    // телефон кладёт клип прямо в S3: здесь — только id и подписанные ссылки PUT (clips.ts › direct)
    if (p === '/v1/clips/direct' && req.method === 'POST') {
      const user = await this.bearer(req);
      if (!user) return this.reply(res, 401, { error: 'bad_token' });
      const r = this.clips.direct(user, (await readJson(req, 1024)) as { ext?: unknown; size?: unknown } | null);
      return this.reply(res, r.status, r.body);
    }
    const thumbUrl = /^\/v1\/clips\/([0-9a-f]{20})\/thumb-url$/.exec(p);
    if (thumbUrl && req.method === 'POST') {
      const user = await this.bearer(req);
      if (!user) return this.reply(res, 401, { error: 'bad_token' });
      const r = this.clips.directThumb(thumbUrl[1], (await readJson(req, 1024)) as { size?: unknown } | null, user);
      return this.reply(res, r.status, r.body);
    }
    const thumb = /^\/v1\/clips\/([0-9a-f]{20})\/thumb$/.exec(p);
    if (thumb && req.method === 'POST') {
      const user = await this.bearer(req);
      if (!user) return this.reply(res, 401, { error: 'bad_token' });
      const r = await this.clips.thumb(thumb[1], req, user);
      return this.reply(res, r.status, r.body);
    }
    const f = /^\/v1\/clips\/([0-9a-f]{20})\.(mp4|webm|jpg)$/.exec(p);
    if (f && (req.method === 'GET' || req.method === 'HEAD')) {
      const path = await this.clips.file(f[1], f[2]);
      if (!path) {
        // на диске нет (видео живёт в S3) — тянем из бакета потоком и отдаём с этого же адреса:
        // Telegram не отправил карточку с фильмом, когда здесь было 302 на подписанную ссылку S3 (26.11)
        const r = await this.clips.remoteOpen(f[1], f[2], req.method ?? 'GET');
        if (!r) return this.reply(res, 404, { error: 'no_clip' });
        const len = r.headers.get('content-length');
        res.writeHead(200, {
          'content-type': CLIP_MIME[f[2]],
          ...(len ? { 'content-length': len } : {}),
          'content-disposition': `attachment; filename="massovka-${f[1].slice(0, 6)}.${f[2]}"`,
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=86400',
        });
        if (req.method === 'HEAD' || !r.body) return void res.end();
        await pipeline(Readable.fromWeb(r.body as WebStream<Uint8Array>), res).catch(() => res.destroy());
        return;
      }
      return this.sendFile(req, res, { path, mime: CLIP_MIME[f[2]], name: `massovka-${f[1].slice(0, 6)}.${f[2]}` });
    }
    return this.reply(res, 404, { error: 'not_found' });
  }

  /**
   * Загадка из фильма (puzzles.ts): GET — что видит зритель (без ответа), POST …/tap — проверить тап.
   * Итог зрителя (с какого телефона, нашёл ли) пишется в базу один раз — для доли нашедших.
   */
  private async puzzleRoute(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
    if (!this.puzzleRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const m = /^\/v1\/puzzles\/([A-Za-z0-9]{5})(\/tap)?$/.exec(p);
    const code = m?.[1].toUpperCase() ?? '';
    if (!m || !PUZZLE_CODE.test(code)) return this.reply(res, 404, { error: 'not_found' });
    if (!m[2] && req.method === 'GET') {
      const doc = await this.puzzles.get(code);
      if (!doc) return this.reply(res, 404, { error: 'no_puzzle' });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      return void res.end(JSON.stringify({ code, lang: doc.lang, puzzle: doc.pub }));
    }
    if (m[2] && req.method === 'POST') {
      const b = (await readJson(req, 1024)) as { eid?: unknown; n?: unknown; d?: unknown } | null;
      const ip = this.ip(req);
      const device = typeof b?.d === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.d) ? b.d : null;
      // попытки считает сервер — по устройству, без него — по адресу (M4)
      const r = await this.puzzles.tap(code, Number(b?.eid), Number(b?.n), device ?? `ip:${ip}`);
      if (!r) return this.reply(res, 404, { error: 'no_puzzle' });
      const out = r.res;
      if (out.status === 200 && out.body.done) {
        try {
          // итог — один раз (первый тап, закончивший загадку) и не больше 5 устройств с адреса
          if (device && r.first && this.puzzles.resultAllowed(code, ip, device)) await this.store.savePuzzleResult({ code, device, found: out.body.hit, tries: r.tries });
          out.body.stats = await this.store.puzzleStats(code);
        } catch (e) {
          this.log('warn', 'puzzle_stats', { err: String(e).slice(0, 200) });
        }
      }
      return this.reply(res, out.status, out.body);
    }
    return this.reply(res, 404, { error: 'not_found' });
  }

  /** Файл клипа: целиком (до 12 МБ) — для сторис, скачивания из Telegram и видео-карточки. */
  private async sendFile(req: IncomingMessage, res: ServerResponse, f: { path: string; mime: string; name: string }): Promise<void> {
    const st = await stat(f.path);
    res.writeHead(200, {
      'content-type': f.mime,
      'content-length': String(st.size),
      // downloadFile в Telegram просит «attachment» и доступ с web.telegram.org
      'content-disposition': `attachment; filename="${f.name}"`,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(f.path).pipe(res);
  }

  private originOk(origin: string | undefined): boolean {
    const allowed = this.o.allowedOrigins ?? '*';
    if (allowed === '*') return true;
    // запрос не из браузера (сервер, бот превью) — Origin нет
    if (!origin) return true;
    return allowed.includes(origin);
  }

  /** Адрес — сама эта машина (сайт рядом ходит в игру по публичному адресу) или петля. */
  private ownMachine(ip: string): boolean {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    if (!this.ownIps) {
      this.ownIps = new Set(
        Object.values(networkInterfaces())
          .flat()
          .map((a) => a?.address ?? '')
          .filter(Boolean),
      );
    }
    return this.ownIps.has(ip.replace(/^::ffff:/, ''));
  }
  private ownIps: Set<string> | null = null;

  private ip(req: IncomingMessage): string {
    if (this.o.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xf) ? xf[0] : xf)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? '?';
  }

  // ───────────── WebSocket ─────────────

  private onConnection(ws: WebSocket, ip: string): void {
    this.ipConns.inc(ip);
    const st: ConnState = { userId: null, room: null, ip, budget: new MsgBudget(MSGS_PER_SEC), alive: true, name: '' };
    this.conns.set(ws, st);
    const peer: Peer = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const helloTimer = setTimeout(() => {
      if (!st.userId) ws.close(4003, 'no_hello');
    }, HELLO_TIMEOUT_MS);
    ws.on('pong', () => (st.alive = true));
    ws.on('message', (data, isBinary) => {
      st.alive = true;
      if (isBinary) return;
      if (!st.budget.take(this.now())) {
        if (st.budget.strikes >= MAX_STRIKES) {
          this.stats.rejected.inc('flood');
          ws.close(4008, 'rate_limited');
        }
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = ClientMsg.safeParse(raw);
      if (!parsed.success) return this.fail(peer, 'bad_message');
      void this.onClientMsg(ws, st, peer, parsed.data).catch((e) => this.log('error', 'ws_error', errFields(e)));
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(ws);
      this.ipConns.dec(ip);
      if (st.room && st.userId) st.room.disconnected(st.userId, peer);
    });
    ws.on('error', () => ws.terminate());
  }

  private async onClientMsg(ws: WebSocket, st: ConnState, peer: Peer, m: ClientMsg): Promise<void> {
    if (m.t === 'hello') {
      if (st.userId) return;
      if (m.v !== WIRE_VERSION) return this.fail(peer, 'bad_version', true, ws);
      const userId = await this.auth.verify(m.token);
      if (!userId) return this.fail(peer, 'bad_token', true, ws);
      // перебор кодов через вход: тот же лимит промахов, что у GET /v1/rooms/<код>
      if (this.roomMissRate.full(st.ip, this.now()) && !this.ownMachine(st.ip)) return this.fail(peer, 'rate_limited', true, ws);
      const room = this.rooms.get(m.code.toUpperCase());
      if (!room || room.closed) {
        // комната переехала к соседу (или переезжает прямо сейчас): «переезжай» вместо «не найдена»
        if (this.peer && (this.moving.has(m.code.toUpperCase()) || (await this.peerRoom(m.code.toUpperCase())))) {
          peer.send(JSON.stringify({ t: 'move', url: this.peer.wsUrl } satisfies ServerMsg));
          ws.close(4005, 'moved');
          return;
        }
        if (!this.ownMachine(st.ip)) this.roomMissRate.take(st.ip, this.now());
        return this.fail(peer, 'room_not_found', true, ws);
      }
      const err = room.join(userId, m.name, peer, { seat: !!m.seat });
      if (err) return this.fail(peer, err, true, ws);
      st.userId = userId;
      st.room = room;
      st.name = m.name;
      if (m.clip) room.setClipPrefs(userId, m.clip);
      peer.send(this.flagsText());
      this.skinFor(room, userId);
      return;
    }
    const room = st.room;
    const uid = st.userId;
    if (!room || !uid) return;
    if (m.t === 'clock') {
      peer.send(JSON.stringify({ t: 'clock', c: m.c, s: this.now() } satisfies ServerMsg));
      return;
    }
    let err: WireError | null = null;
    switch (m.t) {
      case 'g':
        room.game(uid, m.m);
        return;
      case 'clip':
        room.clip(uid, m);
        return;
      case 'ready':
        room.setReady(uid, m.on);
        return;
      case 'rename':
        st.name = m.name;
        room.rename(uid, m.name);
        return;
      case 'settings':
        err = room.updateSettings(uid, m.settings);
        break;
      case 'kick':
        err = room.kick(uid, m.userId);
        break;
      case 'start': {
        const before = room.runner;
        err = room.start(uid);
        if (!err && room.runner !== before) this.stats.matches++;
        break;
      }
      case 'join':
        err = room.promote(uid, st.name);
        break;
      case 'leave':
        room.leave(uid);
        st.room = null;
        ws.close(1000, 'left');
        return;
    }
    if (err) this.fail(peer, err);
  }

  private fail(peer: Peer, code: WireError, fatal = false, ws?: WebSocket): void {
    peer.send(JSON.stringify({ t: 'error', code, fatal } satisfies ServerMsg));
    if (fatal) ws?.close(4004, code);
  }
}

/** Путь с точками-переходами, обратной косой или их кодами (%2e, %2f, %5c) — до разбора URL. */
export function badPath(rawUrl: string): boolean {
  const path = rawUrl.split('?')[0];
  return /(^|\/)\.\.?(\/|$)|\\|%2e|%2f|%5c/i.test(path);
}

async function readJson(req: IncomingMessage, limit = 8192): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return null;
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** Поля ошибки с телефона: только строки, обрезанные; лишнее отбрасываем. */
export interface ClientError {
  msg: string;
  kind?: string;
  at?: string;
  stack?: string;
  path?: string;
  build?: string;
  ua?: string;
  app?: string;
  /** контекст: тема, комната, фаза, платформа (короткие строки) */
  ctx: Record<string, string>;
  /** шаги перед ошибкой */
  crumbs: string[];
}

export function parseClientError(raw: unknown): ClientError | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined =>
    // журнал — JSON (jsonLogger экранирует управляющие символы), поэтому только обрезаем
    typeof v === 'string' && v ? v.slice(0, max) : undefined;
  const msg = str(o.m, 300);
  if (!msg) return null;
  const out: Record<string, string | undefined> = {
    msg,
    kind: str(o.k, 16),
    at: str(o.f, 200),
    stack: str(o.s, 4000),
    path: str(o.p, 80),
    build: str(o.b, 16),
    ua: str(o.ua, 200),
    app: str(o.a, 16),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  const ctx: Record<string, string> = {};
  if (o.c && typeof o.c === 'object' && !Array.isArray(o.c))
    for (const [k, v] of Object.entries(o.c as Record<string, unknown>).slice(0, 16)) {
      if (!/^[a-z]\w{0,15}$/i.test(k)) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ctx[k] = String(v).slice(0, 60);
    }
  const crumbs = Array.isArray(o.bc) ? o.bc.slice(-12).filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 80)) : [];
  return { ...(out as Omit<ClientError, 'ctx' | 'crumbs' | 'msg'>), msg, ctx, crumbs };
}

/** Для логов: id игрока не пишем в открытом виде. */
function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 10);
}
