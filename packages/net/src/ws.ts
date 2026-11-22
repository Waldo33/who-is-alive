import type { Channel, PresenceMember, Transport } from './transport';
import { WIRE_VERSION } from './wire';
import type { ServerMsg, WireError, WireRoom, WireRoomSettings } from './wire';

export interface ServerLinkOptions {
  /** Адрес WebSocket экземпляра сервера, например wss://api.benobody.app/i/blue/ws. */
  url: string;
  token: string;
  selfId: string;
  code: string;
  name: string;
  /** Подмена WebSocket (тесты, старые среды). По умолчанию — глобальный. */
  WebSocketImpl?: typeof WebSocket;
  /** Тишина дольше этого — связь считаем мёртвой и переподключаемся (мс). */
  silenceMs?: number;
}

type Listener<T> = (v: T) => void;

/**
 * Связь с игровым сервером: лобби и транспорт игры на одном WebSocket.
 * Обрыв — переподключение с паузами; вернулись посреди матча — сами просим снимок (resync),
 * поэтому `RemoteSession` поверх этой связи переживает смену сети и сон телефона.
 */
export class ServerLink implements Transport {
  readonly authoritative = true;
  readonly selfId: string;
  room: WireRoom | null = null;
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempts = 0;
  private everJoined = false;
  private lastMsgAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private presenceHandlers = new Set<Listener<PresenceMember[]>>();
  private roomHandlers = new Set<Listener<WireRoom>>();
  private errorHandlers = new Set<Listener<WireError>>();
  private endHandlers = new Set<Listener<'kicked' | 'closed' | WireError>>();
  private firstJoin: { resolve: (r: WireRoom) => void; reject: (e: Error) => void } | null = null;
  private name: string;
  /** Переподключений за жизнь связи — для статистики сети. */
  reconnects = 0;

  constructor(private readonly o: ServerLinkOptions) {
    this.selfId = o.selfId;
    this.name = o.name;
  }

  /** Подключиться и войти в комнату. Ошибка входа (полная, не найдена…) — отказ с её кодом. */
  connect(): Promise<WireRoom> {
    return new Promise((resolve, reject) => {
      this.firstJoin = { resolve, reject };
      this.open();
      this.watchdog = setInterval(() => this.checkSilence(), 2000);
    });
  }

  private open(): void {
    const WS = this.o.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.o.url);
    this.ws = ws;
    this.lastMsgAt = Date.now();
    ws.onopen = () => {
      this.lastMsgAt = Date.now();
      this.raw({ t: 'hello', v: WIRE_VERSION, token: this.o.token, code: this.o.code, name: this.name });
    };
    ws.onmessage = (e: MessageEvent) => {
      this.lastMsgAt = Date.now();
      let m: ServerMsg;
      try {
        m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onServer(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.closedByUs) this.retry();
    };
    ws.onerror = () => {
      // за ошибкой всегда следует close — переподключение там
    };
  }

  private retry(): void {
    if (this.closedByUs || this.retryTimer) return;
    const delay = Math.min(5000, 300 * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closedByUs) this.open();
    }, delay);
  }

  private checkSilence(): void {
    if (!this.ws || this.closedByUs) return;
    if (Date.now() - this.lastMsgAt > (this.o.silenceMs ?? 25_000)) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // уже закрыт
      }
      this.retry();
    }
  }

  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        this.attempts = 0;
        const again = this.everJoined;
        this.everJoined = true;
        this.setRoom(m.room);
        if (this.firstJoin) {
          this.firstJoin.resolve(m.room);
          this.firstJoin = null;
        } else if (again) {
          this.reconnects++;
          // матч шёл, пока нас не было: попросить полный снимок мира
          if (m.room.status === 'playing') this.raw({ t: 'g', m: { t: 'resync' } });
        }
        return;
      }
      case 'room':
        this.setRoom(m.room);
        return;
      case 'g':
        for (const h of this.handlers) h(m.ch, m.m, this.room?.directorId ?? '');
        return;
      case 'error':
        if (this.firstJoin && m.fatal) {
          this.firstJoin.reject(new Error(m.code));
          this.firstJoin = null;
        }
        if (m.fatal) this.end(m.code);
        else for (const h of this.errorHandlers) h(m.code);
        return;
      case 'kicked':
      case 'closed':
        this.end(m.t);
        return;
      case 'hb':
        return;
    }
  }

  private end(why: 'kicked' | 'closed' | WireError): void {
    this.shutdown();
    for (const h of this.endHandlers) h(why);
  }

  private setRoom(r: WireRoom): void {
    this.room = r;
    for (const h of this.roomHandlers) h(r);
    const list = this.presence();
    for (const h of this.presenceHandlers) h(list);
  }

  private raw(msg: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ───────────── лобби ─────────────

  onRoom(h: Listener<WireRoom>): () => void {
    this.roomHandlers.add(h);
    return () => this.roomHandlers.delete(h);
  }

  /** Отказ на действие (не режиссёр, мало игроков…) — связь жива. */
  onError(h: Listener<WireError>): () => void {
    this.errorHandlers.add(h);
    return () => this.errorHandlers.delete(h);
  }

  /** Связь закончилась насовсем: убрали из комнаты, комната закрыта или вход невозможен. */
  onEnd(h: Listener<'kicked' | 'closed' | WireError>): () => void {
    this.endHandlers.add(h);
    return () => this.endHandlers.delete(h);
  }

  setReady(on: boolean): void {
    this.raw({ t: 'ready', on });
  }

  rename(name: string): void {
    this.name = name;
    this.raw({ t: 'rename', name });
  }

  updateSettings(settings: WireRoomSettings): void {
    this.raw({ t: 'settings', settings });
  }

  kick(userId: string): void {
    this.raw({ t: 'kick', userId });
  }

  start(): void {
    this.raw({ t: 'start' });
  }

  /** Уйти из комнаты насовсем (место освобождается сразу). */
  leave(): void {
    this.raw({ t: 'leave' });
    this.shutdown();
  }

  // ───────────── Transport для игры ─────────────

  async send(channel: Channel, msg: unknown): Promise<void> {
    // гость пишет только хосту, а хост — это сервер
    if (channel === 'host') this.raw({ t: 'g', m: msg });
  }

  onMessage(h: (c: Channel, m: unknown, f: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  presence(): PresenceMember[] {
    return (this.room?.members ?? [])
      .filter((m) => m.online)
      .map((m) => ({ userId: m.userId, name: m.name, color: m.color, joinedAt: m.joinedAt, ready: m.ready }));
  }

  onPresence(h: Listener<PresenceMember[]>): () => void {
    this.presenceHandlers.add(h);
    return () => this.presenceHandlers.delete(h);
  }

  async track(state: PresenceMember): Promise<void> {
    if (state.name && state.name !== this.name) this.rename(state.name);
    if (state.ready !== undefined) this.setReady(state.ready);
  }

  async setRole(): Promise<void> {
    // права решает сервер
  }

  private shutdown(): void {
    this.closedByUs = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.watchdog = null;
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // уже закрыт
    }
  }

  /** Закрыть связь, не уходя из комнаты (место держится ~75 с — можно вернуться). */
  async close(): Promise<void> {
    this.shutdown();
  }
}
