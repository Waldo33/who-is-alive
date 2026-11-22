import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Channel, PresenceMember, Transport } from './transport';

/**
 * Транспорт на Supabase Realtime: Broadcast + Presence, приватные каналы с RLS (раздел 13).
 *   room:CODE        — все читают, Broadcast пишет только хост; Presence всех участников
 *   room:CODE:p:UID  — двусторонний личный канал: читают и пишут только UID и хост.
 *                      Гость шлёт сюда намерения (логический канал 'host'), хост — личные данные ('private').
 * Подписаться можно лишь на канал, который разрешено читать, поэтому отдельного канала
 * «только для записи» нет. Права проверяются при подключении — при смене хоста каналы переподключаются.
 * Отправитель сообщения в личном канале определяется самим каналом, а не подписью в конверте.
 */
interface Envelope {
  d: unknown;
  f: string;
}

export class SupabaseTransport implements Transport {
  private room: RealtimeChannel | null = null;
  private privCh = new Map<string, RealtimeChannel>();
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private presenceHandlers = new Set<(m: PresenceMember[]) => void>();
  private members: PresenceMember[] = [];
  private me: PresenceMember | null = null;
  private isHost = false;
  /** Отправлено сообщений — для оценки нагрузки на лимит Realtime. */
  sent = 0;

  constructor(
    private readonly sb: SupabaseClient,
    private readonly code: string,
    readonly selfId: string,
  ) {}

  private topic(suffix = ''): string {
    return `room:${this.code}${suffix}`;
  }

  private open(topic: string, opts: { presence?: boolean; receive?: Channel; from?: string }): Promise<RealtimeChannel> {
    const ch = this.sb.channel(topic, {
      config: { private: true, broadcast: { self: false, ack: false }, presence: opts.presence ? { key: this.selfId } : undefined },
    });
    if (opts.receive) {
      const kind = opts.receive;
      ch.on('broadcast', { event: 'm' }, ({ payload }) => {
        const env = payload as Envelope;
        const from = opts.from ?? env.f;
        for (const h of this.handlers) h(kind, env.d, from);
      });
    }
    if (opts.presence) {
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<PresenceMember>();
        this.members = Object.values(state)
          .map((arr) => arr[arr.length - 1])
          .filter(Boolean)
          .map((p) => ({ userId: p.userId, name: p.name, color: p.color, joinedAt: p.joinedAt, ready: p.ready }))
          .sort((a, b) => a.joinedAt - b.joinedAt);
        for (const h of this.presenceHandlers) h(this.members.slice());
      });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      ch.subscribe((status, err) => {
        if (settled) return;
        if (status === 'SUBSCRIBED') {
          settled = true;
          resolve(ch);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          settled = true;
          void this.sb.removeChannel(ch);
          reject(new Error(`${topic}: ${status}${err ? ' ' + err.message : ''}`));
        }
      });
    });
  }

  /** Подключиться к комнате. Хост дополнительно открывает личные каналы игроков. */
  async connect(me: PresenceMember, isHost: boolean, playerIds: string[]): Promise<void> {
    await this.sb.realtime.setAuth();
    this.me = me;
    this.room = await this.open(this.topic(), { presence: true, receive: 'room' });
    await this.room.track(me);
    await this.setRole(isHost, playerIds, true);
  }

  /**
   * Зритель: только читает общий канал (право даёт spectate_room). Себя в Presence не ставит,
   * личного канала нет — игроки зрителя не видят и он им ничего не шлёт.
   */
  async watch(): Promise<void> {
    await this.sb.realtime.setAuth();
    this.room = await this.open(this.topic(), { presence: true, receive: 'room' });
  }

  async setRole(isHost: boolean, playerIds: string[], force = false): Promise<void> {
    if (!force && isHost === this.isHost && (!isHost || playerIds.every((id) => id === this.selfId || this.privCh.has(id)))) return;
    this.isHost = isHost;
    await this.sb.realtime.setAuth();
    for (const [id, ch] of this.privCh) {
      await this.sb.removeChannel(ch);
      this.privCh.delete(id);
    }
    if (isHost) {
      // хост слушает намерения каждого игрока в его личном канале; отправитель — владелец канала
      const ids = playerIds.filter((id) => id !== this.selfId);
      const chans = await Promise.all(ids.map((id) => this.open(this.topic(`:p:${id}`), { receive: 'host', from: id })));
      ids.forEach((id, i) => this.privCh.set(id, chans[i]));
    } else {
      this.privCh.set(this.selfId, await this.open(this.topic(`:p:${this.selfId}`), { receive: 'private' }));
    }
    // права на общий канал (писать Broadcast может только хост) тоже кешируются при подключении
    if (this.room && !force) {
      await this.sb.removeChannel(this.room);
      this.room = await this.open(this.topic(), { presence: true, receive: 'room' });
      if (this.me) await this.room.track(this.me);
    }
  }

  async send(channel: Channel, msg: unknown, to?: string): Promise<void> {
    const ch = channel === 'room' ? this.room : channel === 'host' ? this.privCh.get(this.selfId) : to ? this.privCh.get(to) : undefined;
    if (!ch) return;
    this.sent++;
    await ch.send({ type: 'broadcast', event: 'm', payload: { d: msg, f: this.selfId } satisfies Envelope });
  }

  onMessage(h: (c: Channel, m: unknown, f: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  presence(): PresenceMember[] {
    return this.members.slice();
  }

  onPresence(h: (m: PresenceMember[]) => void): () => void {
    this.presenceHandlers.add(h);
    return () => this.presenceHandlers.delete(h);
  }

  async track(state: PresenceMember): Promise<void> {
    this.me = state;
    await this.room?.track(state);
  }

  async close(): Promise<void> {
    for (const ch of [this.room, ...this.privCh.values()]) if (ch) await this.sb.removeChannel(ch);
    this.room = null;
    this.privCh.clear();
    this.handlers.clear();
    this.presenceHandlers.clear();
  }
}
