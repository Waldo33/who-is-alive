import type { Channel, PresenceMember, Transport } from './transport';
import { WIRE_VERSION } from './wire';
import type { ServerMsg, WireClip, WireError, WireFilm, WireRoom, WireRoomSettings } from './wire';

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
  /** Язык и «без крови» для клипа выбывшего (уходят в hello): сервер заготовит клип до нажатия. */
  clipPrefs?: () => { lang: 'ru' | 'en'; mild: boolean };
  /** Пришли посреди матча — занять место ИИ, если оно есть (сервер решает; иначе — зритель). */
  seat?: boolean;
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
  /** Пришёл посреди матча: смотрит, место займёт после (`join`). */
  spectator = false;
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempts = 0;
  private everJoined = false;
  /** Соединение открыто заново (после обрыва), ждём его welcome. */
  private reopened = false;
  private lastMsgAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private presenceHandlers = new Set<Listener<PresenceMember[]>>();
  private roomHandlers = new Set<Listener<WireRoom>>();
  private errorHandlers = new Set<Listener<WireError>>();
  private endHandlers = new Set<Listener<'kicked' | 'closed' | WireError>>();
  private filmHandlers = new Set<Listener<WireFilm>>();
  /** Последнее известие о фильме матча (сбрасывает клиент, когда начинается новый матч). */
  film: WireFilm | null = null;
  /** Код загадки из фильма этого матча (`{t:'puzzle'}`); новый матч — снова null. */
  puzzle: string | null = null;
  /** Что умеет сервер сверх базового протокола (из welcome): 'clip' — монтирует клип выбывшего. */
  caps: string[] = [];
  /** Видео не выключено аварийно (`{t:'flags'}`): false — клипов и фильма нет нигде. */
  video = true;
  private flagHandlers = new Set<Listener<{ video: boolean }>>();
  private firstJoin: { resolve: (r: WireRoom) => void; reject: (e: Error) => void } | null = null;
  private name: string;
  /** Переподключений за жизнь связи — для статистики сети. */
  reconnects = 0;
  /** Переездов комнаты на другой экземпляр сервера (выкладка без обрыва). */
  moves = 0;
  /** Текущий адрес WebSocket: после «переезжай» — адрес соседнего экземпляра. */
  private url: string;

  constructor(private readonly o: ServerLinkOptions) {
    this.selfId = o.selfId;
    this.name = o.name;
    this.url = o.url;
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
    const ws = new WS(this.url);
    this.ws = ws;
    this.reopened = this.everJoined;
    this.lastMsgAt = Date.now();
    ws.onopen = () => {
      this.lastMsgAt = Date.now();
      this.raw({ t: 'hello', v: WIRE_VERSION, token: this.o.token, code: this.o.code, name: this.name, ...(this.o.clipPrefs ? { clip: this.o.clipPrefs() } : {}), ...(this.o.seat ? { seat: true } : {}) });
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
        // зритель занял место — это не переподключение
        const promoted = this.spectator && !m.spectator && this.ws !== null && this.everJoined && !this.reopened;
        this.reopened = false;
        const again = this.everJoined && !promoted;
        this.everJoined = true;
        this.spectator = !!m.spectator;
        this.caps = Array.isArray(m.caps) ? m.caps : [];
        this.setRoom(m.room);
        if (this.firstJoin) {
          this.firstJoin.resolve(m.room);
          this.firstJoin = null;
        } else if (again) {
          this.reconnects++;
          // матч шёл, пока нас не было: попросить полный снимок мира
          if (m.room.status === 'playing' && !this.spectator) this.raw({ t: 'g', m: { t: 'resync' } });
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
      case 'move': {
        // комната переехала на соседний экземпляр (выкладка): тот же токен и код, новый адрес, сразу
        if (typeof m.url !== 'string' || !/^wss?:\/\//.test(m.url)) return;
        this.url = m.url;
        this.moves++;
        this.attempts = 0;
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.close(1000, 'moving');
        } catch {
          // уже закрыт
        }
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        if (!this.closedByUs) this.open();
        return;
      }
      case 'clock': {
        const w = this.clockWait.get(m.c);
        if (w) {
          this.clockWait.delete(m.c);
          w(m.s);
        }
        return;
      }
      case 'puzzle':
        this.puzzle = m.code;
        return;
      case 'film':
        // новый матч: загадки прошлого больше нет
        if (m.state === 'none') this.puzzle = null;
        this.film = m;
        for (const h of this.filmHandlers) h(m);
        return;
      case 'clip':
        this.clipWait.get(m.n)?.(m);
        return;
      case 'flags':
        this.video = m.video !== false;
        for (const h of this.flagHandlers) h({ video: this.video });
        return;
    }
  }

  /** Переключатели сервера (аварийный выключатель видео): сразу после входа и при смене. */
  onFlags(h: Listener<{ video: boolean }>): () => void {
    this.flagHandlers.add(h);
    return () => this.flagHandlers.delete(h);
  }

  private clipWait = new Map<number, (m: WireClip) => void>();
  private clipSeq = 0;

  /**
   * Клип выбывшего — смонтировать на сервере. null — сервер не умеет, занят, не вышло или молчит:
   * тогда клип пишет телефон. onEta — сколько мс ещё ждать (сервер поставил в очередь).
   */
  deathClip(round: number, lang: 'ru' | 'en', mild: boolean, onEta?: (ms: number) => void): Promise<{ id: string; ext: 'mp4'; thumb: boolean } | null> {
    if (!this.video || !this.caps.includes('clip') || !this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    const n = ++this.clipSeq;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (r: { id: string; ext: 'mp4'; thumb: boolean } | null) => {
        clearTimeout(timer);
        this.clipWait.delete(n);
        resolve(r);
      };
      // нет ответа «в очереди» за 3 с — связь плохая или сервер старый: монтирует телефон
      timer = setTimeout(() => finish(null), 3000);
      this.clipWait.set(n, (m) => {
        if (m.state === 'making') {
          clearTimeout(timer);
          timer = setTimeout(() => finish(null), m.eta + 15_000);
          onEta?.(m.eta);
        } else finish(m.state === 'ready' ? { id: m.id, ext: m.ext, thumb: m.thumb } : null);
      });
      this.raw({ t: 'clip', n, round, lang, mild });
    });
  }

  /** Фильм матча: монтируется, готов или не вышел. */
  onFilm(h: Listener<WireFilm>): () => void {
    this.filmHandlers.add(h);
    return () => this.filmHandlers.delete(h);
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

  private clockWait = new Map<number, (s: number) => void>();

  /**
   * Сдвиг часов сервера относительно Date.now(), мс (оркестр из телефонов): несколько замеров,
   * берётся самый быстрый ответ — у него меньше всего ошибка (половина пути туда-обратно).
   * null — не ответил (старый сервер, нет связи).
   */
  async serverClock(samples = 6): Promise<number | null> {
    let best: { rtt: number; off: number } | null = null;
    for (let i = 0; i < samples; i++) {
      const c = Date.now() + i / 1000;
      const t0 = performance.now();
      const s = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          this.clockWait.delete(c);
          resolve(null);
        }, 2000);
        this.clockWait.set(c, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        this.raw({ t: 'clock', c });
      });
      if (s === null) continue;
      const rtt = performance.now() - t0;
      const off = s - (Date.now() - rtt / 2);
      if (!best || rtt < best.rtt) best = { rtt, off };
    }
    return best ? best.off : null;
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

  /** Зритель: матч кончился — занять место в комнате. */
  join(): void {
    this.raw({ t: 'join' });
  }

  /**
   * Вернулись в приложение (телефон спал): если давно ничего не приходило, соединение, скорее
   * всего, мёртвое — переподключаемся сразу, не дожидаясь сторожа.
   */
  poke(): void {
    if (this.closedByUs) return;
    if (!this.ws || Date.now() - this.lastMsgAt > 4000) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.close();
      } catch {
        // уже закрыт
      }
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.attempts = 0;
      this.open();
    }
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
