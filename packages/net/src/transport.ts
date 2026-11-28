/**
 * Абстракция транспорта (раздел 12). Вся сеть игры идёт только через этот интерфейс,
 * поэтому игра не зависит от того, как сообщения доходят (сейчас — WebSocket своего сервера, `ws.ts`).
 *
 * Три логических канала (раздел 13):
 *  - 'room'    — хост → все участники (события мира, фазы, счёт); здесь же Presence;
 *  - 'host'    — участник → хост (намерения, пинги);
 *  - 'private' — хост → один участник (`to`): «ты — сущность №…», снимки, ответы на пинги.
 */
export type Channel = 'room' | 'host' | 'private';

/** Состояние участника в Presence. */
export interface PresenceMember {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
  ready?: boolean;
}

export interface Transport {
  readonly selfId: string;
  /**
   * Все входящие сообщения — от авторитетного сервера (свой игровой сервер, не телефон хоста):
   * подпись отправителя не проверяем, её ставит сервер, а не другой участник.
   */
  readonly authoritative?: boolean;
  send(channel: Channel, msg: unknown, to?: string): Promise<void>;
  onMessage(handler: (channel: Channel, msg: unknown, from: string) => void): () => void;
  presence(): PresenceMember[];
  onPresence(handler: (members: PresenceMember[]) => void): () => void;
  /** Обновить своё состояние в Presence (имя, «Готов»). */
  track(state: PresenceMember): Promise<void>;
  /** Сменить роль (стал хостом / перестал): переподключает каналы под новые права. */
  setRole(isHost: boolean, playerIds: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Петля в памяти: несколько «клиентов» в одном процессе (тесты, сетевой стенд). */
export class LoopbackHub {
  private peers = new Map<string, LoopbackTransport>();
  members: PresenceMember[] = [];
  hostId = '';
  /** Искусственная задержка доставки, мс: [мин, макс]. */
  latency: [number, number] = [0, 0];
  /** Доля потерянных сообщений (0..1). */
  loss = 0;
  /** Счётчик доставленных сообщений — для оценки нагрузки. */
  delivered = 0;
  private rand: () => number;
  /** Порядок внутри канала сохраняется, как в Realtime: следующее сообщение не обгоняет предыдущее. */
  private lastDue = new Map<string, number>();

  constructor(seed = 1) {
    let s = seed >>> 0 || 1;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  join(member: PresenceMember): LoopbackTransport {
    const t = new LoopbackTransport(this, member.userId);
    this.peers.set(member.userId, t);
    this.members = this.members.filter((m) => m.userId !== member.userId).concat(member);
    if (!this.hostId) this.hostId = member.userId;
    this.emitPresence();
    return t;
  }

  leave(id: string): void {
    this.peers.delete(id);
    this.members = this.members.filter((m) => m.userId !== id);
    this.emitPresence();
  }

  update(member: PresenceMember): void {
    this.members = this.members.map((m) => (m.userId === member.userId ? member : m));
    this.emitPresence();
  }

  emitPresence(): void {
    for (const p of this.peers.values()) p.emitPresence();
  }

  route(from: string, channel: Channel, msg: unknown, to?: string): void {
    for (const [id, p] of this.peers) {
      if (channel === 'room' && id === from) continue;
      if (channel === 'host' && id !== this.hostId) continue;
      if (channel === 'private' && id !== to) continue;
      if (this.loss && this.rand() < this.loss) continue;
      // JSON — как по сети: никакие ссылки на объекты отправителя не доходят до получателя
      const copy = JSON.parse(JSON.stringify(msg));
      const [a, b] = this.latency;
      const key = `${from}>${id}:${channel}`;
      const now = Date.now();
      const due = Math.max(now + a + (b - a) * this.rand(), this.lastDue.get(key) ?? 0);
      this.lastDue.set(key, due);
      this.delivered++;
      if (due - now <= 0) queueMicrotask(() => p.deliver(channel, copy, from));
      else setTimeout(() => p.deliver(channel, copy, from), due - now);
    }
  }
}

export class LoopbackTransport implements Transport {
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private presenceHandlers = new Set<(m: PresenceMember[]) => void>();
  /** Стенд «игровой сервер»: гость принимает всё от безголового хоста. */
  authoritative = false;
  constructor(private hub: LoopbackHub, readonly selfId: string) {}
  async send(channel: Channel, msg: unknown, to?: string): Promise<void> {
    this.hub.route(this.selfId, channel, msg, to);
  }
  onMessage(h: (c: Channel, m: unknown, f: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  presence(): PresenceMember[] {
    return this.hub.members.slice();
  }
  onPresence(h: (m: PresenceMember[]) => void): () => void {
    this.presenceHandlers.add(h);
    return () => this.presenceHandlers.delete(h);
  }
  async track(state: PresenceMember): Promise<void> {
    this.hub.update(state);
  }
  async setRole(isHost: boolean): Promise<void> {
    if (isHost) this.hub.hostId = this.selfId;
  }
  deliver(c: Channel, m: unknown, f: string): void {
    for (const h of this.handlers) h(c, m, f);
  }
  emitPresence(): void {
    const list = this.presence();
    for (const h of this.presenceHandlers) h(list);
  }
  async close(): Promise<void> {
    this.hub.leave(this.selfId);
  }
}
