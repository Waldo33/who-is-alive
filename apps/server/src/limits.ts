/**
 * Ограничения частоты (docs/server-migration.md › 3.3): на соединение — сообщений в секунду,
 * с одного адреса — соединений и новых комнат. Адрес храним только в памяти.
 */
export class RateWindow {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** true — можно; false — лимит исчерпан. */
  take(key: string, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** Убрать старые ключи (раз в минуту). */
  sweep(now: number): void {
    for (const [k, list] of this.hits) if (!list.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

/** Сообщения одного соединения: не больше max в секунду; лишнее отбрасывается. */
export class MsgBudget {
  private second = 0;
  private count = 0;
  strikes = 0;

  constructor(private readonly max: number) {}

  take(now: number): boolean {
    const s = Math.floor(now / 1000);
    if (s !== this.second) {
      this.second = s;
      this.count = 0;
    }
    this.count++;
    if (this.count === this.max + 1) this.strikes++;
    return this.count <= this.max;
  }
}

export class Counter {
  private n = new Map<string, number>();
  inc(key: string): number {
    const v = (this.n.get(key) ?? 0) + 1;
    this.n.set(key, v);
    return v;
  }
  dec(key: string): void {
    const v = (this.n.get(key) ?? 0) - 1;
    if (v <= 0) this.n.delete(key);
    else this.n.set(key, v);
  }
  get(key: string): number {
    return this.n.get(key) ?? 0;
  }
}
