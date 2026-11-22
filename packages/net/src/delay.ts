import type { Channel, PresenceMember, Transport } from './transport';

/**
 * Зритель: смотрит общий канал комнаты с задержкой и ничего не отправляет.
 * Задержка — чтобы опоздавший, сидящий рядом с игроками, не мог подсказать, кто где:
 * всё, что видно зрителю, игроки уже видели несколько секунд назад.
 * Личного канала у зрителя нет — ни своей сущности, ни намерений.
 */
export class DelayedTransport implements Transport {
  private handlers = new Set<(c: Channel, m: unknown, f: string) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private unsub: () => void;

  constructor(
    private readonly inner: Transport,
    readonly delayMs: number,
  ) {
    this.unsub = inner.onMessage((c, m, f) => {
      if (c !== 'room') return;
      const id = setTimeout(() => {
        this.timers.delete(id);
        for (const h of this.handlers) h(c, m, f);
      }, delayMs);
      this.timers.add(id);
    });
  }

  get selfId(): string {
    return this.inner.selfId;
  }

  /** Зритель ничего не шлёт (пинги, намерения): у него нет ни прав, ни личного канала. */
  async send(): Promise<void> {}

  onMessage(h: (c: Channel, m: unknown, f: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  presence(): PresenceMember[] {
    return this.inner.presence();
  }

  onPresence(h: (m: PresenceMember[]) => void): () => void {
    return this.inner.onPresence(h);
  }

  async track(): Promise<void> {}

  async setRole(): Promise<void> {}

  /** Закрывает только задержку; сам транспорт закрывает владелец (комната). */
  async close(): Promise<void> {
    this.unsub();
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.handlers.clear();
  }
}
