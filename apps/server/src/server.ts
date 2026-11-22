import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { ClientMsg, DEFAULT_WIRE_SETTINGS, ROOM_CODE_ALPHABET, RoomSettingsSchema, WIRE_MAX_BYTES, WIRE_VERSION } from '@kto/net';
import type { ServerMsg, WireError } from '@kto/net';
import { Auth } from './auth';
import { Counter, MsgBudget, RateWindow } from './limits';
import { jsonLogger } from './log';
import type { Logger } from './log';
import { Room } from './room';
import { MemoryStore, parseEvents } from './store';
import type { Store } from './store';
import type { Peer } from './room';

export interface GameServerOptions {
  /** Ключ подписи токенов (≥ 32 символов). */
  authSecret: string;
  /** Имя экземпляра для адреса WebSocket: /i/<instance>/ws (синий/зелёный деплой). */
  instance?: string;
  /** Публичная основа адреса WebSocket, например wss://api.benobody.app. Нет — из заголовка Host. */
  publicWsBase?: string;
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
}

/** Лимиты (docs/server-migration.md › 3.3). */
const MSGS_PER_SEC = 30;
const MAX_STRIKES = 3;
const CONNS_PER_IP = 20;
const ROOMS_PER_IP_MIN = 10;
const AUTH_PER_IP_MIN = 30;
const EVENTS_PER_IP_MIN = 120;
/** Лобби без действий — закрыть; комната старше — закрыть; без единого игрока на связи — закрыть. */
const LOBBY_IDLE_MS = 30 * 60_000;
const ROOM_MAX_AGE_MS = 6 * 3600_000;
const EMPTY_CLOSE_MS = 10 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
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
  readonly instance: string;
  draining = false;
  private readonly auth: Auth;
  private readonly wss: WebSocketServer;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly speed: number;
  private readonly maxRooms: number;
  private readonly conns = new Map<WebSocket, ConnState>();
  private readonly ipConns = new Counter();
  private readonly roomRate = new RateWindow(ROOMS_PER_IP_MIN, 60_000);
  private readonly authRate = new RateWindow(AUTH_PER_IP_MIN, 60_000);
  private readonly eventsRate = new RateWindow(EVENTS_PER_IP_MIN, 60_000);
  readonly store: Store;
  private readonly emptySince = new Map<Room, number>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private slow: ReturnType<typeof setInterval> | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  /** Счётчики для /metrics. */
  readonly stats = { matches: 0, rejected: new Counter() };

  constructor(private readonly o: GameServerOptions) {
    this.auth = new Auth(o.authSecret);
    this.instance = o.instance ?? 'blue';
    this.log = o.log ?? jsonLogger();
    this.now = o.now ?? Date.now;
    this.speed = o.speed ?? 1;
    this.maxRooms = o.maxRooms ?? 2000;
    this.store = o.store ?? new MemoryStore();
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WIRE_MAX_BYTES });
    this.http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== `/i/${this.instance}/ws` && path !== '/ws') return socket.destroy();
      if (!this.originOk(req.headers.origin)) return socket.destroy();
      const ip = this.ip(req);
      if (this.ipConns.get(ip) >= CONNS_PER_IP) {
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
    for (const r of [...this.rooms.values()]) {
      r.housekeeping();
      if (r.onlineCount() === 0) {
        if (!this.emptySince.has(r)) this.emptySince.set(r, now);
      } else this.emptySince.delete(r);
      const empty = this.emptySince.get(r);
      let why = '';
      if (r.members.size === 0) why = 'no_members';
      else if (empty !== undefined && now - empty > EMPTY_CLOSE_MS) why = 'empty';
      else if (now - r.createdAt > ROOM_MAX_AGE_MS) why = 'age';
      else if (r.status === 'lobby' && now - r.lastActive > LOBBY_IDLE_MS) why = 'idle';
      if (why) this.dropRoom(r, why);
    }
    this.roomRate.sweep(now);
    this.authRate.sweep(now);
    this.eventsRate.sweep(now);
  }

  private dropRoom(r: Room, why: string): void {
    r.close(why);
    this.rooms.delete(r.code);
    this.emptySince.delete(r);
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
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return this.reply(res, 204);
    try {
      const p = url.pathname;
      if (p === '/healthz') return this.reply(res, 200, { ok: true });
      if (p === '/readyz') return this.reply(res, this.draining ? 503 : 200, { ok: !this.draining, instance: this.instance });
      if (p === '/metrics' && req.method === 'GET') return this.metrics(req, res);
      if (p === '/v1/auth/anon' && req.method === 'POST') {
        if (!this.authRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
        return this.reply(res, 200, await this.auth.issue());
      }
      if (p === '/v1/rooms' && req.method === 'POST') return this.createRoom(req, res);
      if (p === '/v1/events' && req.method === 'POST') return this.events(req, res);
      const m = /^\/v1\/rooms\/([A-Za-z]{4})$/.exec(p);
      if (m && req.method === 'GET') {
        const r = this.rooms.get(m[1].toUpperCase());
        if (!r) return this.reply(res, 404, { error: 'room_not_found' });
        return this.reply(res, 200, {
          code: r.code,
          status: r.status,
          players: r.view().members.map((x) => ({ name: x.name, color: x.color })),
          wsUrl: this.wsUrl(req),
        });
      }
      return this.reply(res, 404, { error: 'not_found' });
    } catch (e) {
      this.log('error', 'http_error', { path: url.pathname, err: String(e) });
      return this.reply(res, 500, { error: 'internal' });
    }
  }

  private async createRoom(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = await this.bearer(req);
    if (!userId) return this.reply(res, 401, { error: 'bad_token' });
    if (this.draining || this.rooms.size >= this.maxRooms) return this.reply(res, 503, { error: 'server_busy' });
    if (!this.roomRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const body = (await readJson(req)) as { name?: unknown; settings?: unknown; lang?: unknown } | null;
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
    });
    this.rooms.set(code, room);
    this.log('info', 'room_created', { room: code, user: hashId(userId) });
    return this.reply(res, 200, { code, wsUrl: this.wsUrl(req) });
  }

  /**
   * Аналитика воронки: пачка событий (как RPC log_events в Supabase). Тело — JSON с типом text/plain,
   * чтобы браузер слал без предварительного запроса и с keepalive при закрытии вкладки.
   */
  private async events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.eventsRate.take(this.ip(req), this.now())) return this.reply(res, 429, { error: 'rate_limited' });
    const b = parseEvents(await readJson(req));
    if (!b) return this.reply(res, 400, { error: 'bad_events' });
    const userId = b.token ? await this.auth.verify(b.token) : null;
    try {
      await this.store.logEvents(b.device, b.session, userId, b.events);
    } catch (e) {
      this.log('error', 'events_store', { err: String(e) });
      return this.reply(res, 503, { error: 'store' });
    }
    return this.reply(res, 204);
  }

  private newCode(): string | null {
    for (let i = 0; i < 200; i++) {
      let c = '';
      for (let k = 0; k < 4; k++) c += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    return null;
  }

  private metrics(req: IncomingMessage, res: ServerResponse): void {
    // только изнутри: снаружи Caddy этот путь не пропускает, а здесь — запросы без прокси
    if (this.o.trustProxy && req.headers['x-forwarded-for']) return this.reply(res, 404, { error: 'not_found' });
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
      `game_rooms_playing{instance="${this.instance}"} ${playing}`,
      `game_players_online{instance="${this.instance}"} ${players}`,
      `game_connections{instance="${this.instance}"} ${this.conns.size}`,
      `game_matches_total{instance="${this.instance}"} ${this.stats.matches}`,
      `game_step_ms_p99{instance="${this.instance}"} ${p99.toFixed(3)}`,
      `game_draining{instance="${this.instance}"} ${this.draining ? 1 : 0}`,
    ];
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
  }

  private wsUrl(req: IncomingMessage): string {
    const base = this.o.publicWsBase ?? `ws://${req.headers.host ?? 'localhost'}`;
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

  private originOk(origin: string | undefined): boolean {
    const allowed = this.o.allowedOrigins ?? '*';
    if (allowed === '*') return true;
    // запрос не из браузера (сервер, бот превью) — Origin нет
    if (!origin) return true;
    return allowed.includes(origin);
  }

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
      void this.onClientMsg(ws, st, peer, parsed.data).catch((e) => this.log('error', 'ws_error', { err: String(e) }));
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
      const room = this.rooms.get(m.code.toUpperCase());
      if (!room || room.closed) return this.fail(peer, 'room_not_found', true, ws);
      const err = room.join(userId, m.name, peer);
      if (err) return this.fail(peer, err, true, ws);
      st.userId = userId;
      st.room = room;
      st.name = m.name;
      return;
    }
    const room = st.room;
    const uid = st.userId;
    if (!room || !uid) return;
    let err: WireError | null = null;
    switch (m.t) {
      case 'g':
        room.game(uid, m.m);
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8192) return null;
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** Для логов: id игрока не пишем в открытом виде. */
function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 10);
}
