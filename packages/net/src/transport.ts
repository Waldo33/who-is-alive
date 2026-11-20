/**
 * Абстракция транспорта (раздел 12). Вся сеть игры идёт только через этот интерфейс,
 * поэтому Supabase Realtime можно будет заменить выделенным сервером комнат без переписывания игры.
 * Реализация на Supabase появится на этапе 4; сейчас есть локальная петля для песочницы и тестов.
 */
export type Channel = 'room' | 'host' | 'private';

export interface PresenceMember {
  userId: string;
  name: string;
  color: number;
  joinedAt: number;
}

export interface Transport {
  readonly selfId: string;
  send(channel: Channel, msg: unknown, to?: string): Promise<void>;
  onMessage(handler: (channel: Channel, msg: unknown, from: string) => void): () => void;
  presence(): PresenceMember[];
  onPresence(handler: (members: PresenceMember[]) => void): () => void;
  close(): Promise<void>;
}

/** Петля в памяти: несколько «клиентов» в одном процессе (песочница, сетевой стенд Playwright). */
export class LoopbackHub {
  private peers = new Map<string, LoopbackTransport>();
  members: PresenceMember[] = [];
  hostId = '';

  join(member: PresenceMember): LoopbackTransport {
    const t = new LoopbackTransport(this, member.userId);
    this.peers.set(member.userId, t);
    this.members.push(member);
    if (!this.hostId) this.hostId = member.userId;
    for (const p of this.peers.values()) p.emitPresence();
    return t;
  }

  leave(id: string): void {
    this.peers.delete(id);
    this.members = this.members.filter((m) => m.userId !== id);
    for (const p of this.peers.values()) p.emitPresence();
  }

  route(from: string, channel: Channel, msg: unknown, to?: string): void {
    for (const [id, p] of this.peers) {
      if (channel === 'room' && id === from) continue;
      if (channel === 'host' && id !== this.hostId) continue;
      if (channel === 'private' && id !== to) continue;
      queueMicrotask(() => p.deliver(channel, msg, from));
    }
  }
}

export class LoopbackTransport implements Transport {
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private presenceHandlers = new Set<(m: PresenceMember[]) => void>();
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
  deliver(c: Channel, m: unknown, f: string): void {
    for (const h of this.handlers) h(c, m, f);
  }
  emitPresence(): void {
    for (const h of this.presenceHandlers) h(this.presence());
  }
  async close(): Promise<void> {
    this.hub.leave(this.selfId);
  }
}
