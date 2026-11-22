import pg from 'pg';
import type { Logger } from './log';

/**
 * Хранилище игрового сервера. Игре база не нужна (комнаты в памяти) — здесь аналитика воронки
 * и то, что раньше жило в Supabase. Без DATABASE_URL (тесты, разработка) — память.
 */
export interface AnalyticsEvent {
  name: string;
  props: Record<string, unknown>;
  room: string | null;
}

export interface Store {
  logEvents(device: string, session: string | null, userId: string | null, events: AnalyticsEvent[]): Promise<void>;
  /** Рейтинг «Кастинга дня» в чате Telegram: записать результат игрока. */
  saveDailyScore(row: DailyScore): Promise<void>;
  dailyBoard(chat: string, day: number): Promise<DailyScore[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DailyScore {
  chat: string;
  day: number;
  userId: number;
  name: string;
  tries: number;
  won: boolean;
}

/** Схема: только «расширяющие» изменения (новые таблицы и столбцы), старый код с ними работает. */
const MIGRATIONS: string[] = [
  `create table if not exists analytics_events (
     id bigserial primary key,
     created_at timestamptz not null default now(),
     user_id text,
     device_id text,
     session_id text,
     room_code text,
     name text not null,
     props jsonb not null default '{}'::jsonb
   )`,
  `create index if not exists analytics_events_created_idx on analytics_events (created_at)`,
  `create index if not exists analytics_events_name_created_idx on analytics_events (name, created_at)`,
  `create index if not exists analytics_events_device_idx on analytics_events (device_id)`,
  `create table if not exists tg_daily_scores (
     chat text not null,
     day integer not null,
     user_id bigint not null,
     name text not null,
     tries integer not null,
     won boolean not null,
     created_at timestamptz not null default now(),
     primary key (chat, day, user_id)
   )`,
];

export class PgStore implements Store {
  private readonly pool: pg.Pool;

  constructor(
    url: string,
    private readonly log: Logger,
  ) {
    this.pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (e) => log('error', 'pg_pool', { err: String(e) }));
  }

  async migrate(): Promise<void> {
    for (const sql of MIGRATIONS) await this.pool.query(sql);
  }

  async logEvents(device: string, session: string | null, userId: string | null, events: AnalyticsEvent[]): Promise<void> {
    if (!events.length) return;
    const vals: unknown[] = [];
    const rows = events.map((e, i) => {
      vals.push(userId, device, session, e.room, e.name, JSON.stringify(e.props));
      const b = i * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb)`;
    });
    await this.pool.query(`insert into analytics_events (user_id, device_id, session_id, room_code, name, props) values ${rows.join(', ')}`, vals);
  }

  async saveDailyScore(r: DailyScore): Promise<void> {
    // первый результат за день — окончательный (как в самой загадке)
    await this.pool.query(
      `insert into tg_daily_scores (chat, day, user_id, name, tries, won) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
      [r.chat, r.day, r.userId, r.name, r.tries, r.won],
    );
  }

  async dailyBoard(chat: string, day: number): Promise<DailyScore[]> {
    const res = await this.pool.query(
      `select chat, day, user_id, name, tries, won from tg_daily_scores where chat = $1 and day = $2 order by won desc, tries asc, created_at asc limit 20`,
      [chat, day],
    );
    return res.rows.map((x) => ({ chat: x.chat, day: x.day, userId: Number(x.user_id), name: x.name, tries: x.tries, won: x.won }));
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Память: тесты и запуск без базы. */
export class MemoryStore implements Store {
  events: (AnalyticsEvent & { device: string; session: string | null; userId: string | null })[] = [];
  daily: DailyScore[] = [];

  async logEvents(device: string, session: string | null, userId: string | null, events: AnalyticsEvent[]): Promise<void> {
    for (const e of events) this.events.push({ ...e, device, session, userId });
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000);
  }

  async saveDailyScore(r: DailyScore): Promise<void> {
    if (!this.daily.some((x) => x.chat === r.chat && x.day === r.day && x.userId === r.userId)) this.daily.push({ ...r });
  }

  async dailyBoard(chat: string, day: number): Promise<DailyScore[]> {
    return this.daily
      .filter((x) => x.chat === chat && x.day === day)
      .sort((a, b) => Number(b.won) - Number(a.won) || a.tries - b.tries)
      .slice(0, 20);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

/** Проверка событий как в Supabase (log_events): имя по шаблону, не больше 30 за раз, props до 2 КБ. */
export function parseEvents(raw: unknown): { device: string; session: string | null; token: string | null; events: AnalyticsEvent[] } | null {
  const b = raw as { d?: unknown; s?: unknown; t?: unknown; e?: unknown } | null;
  if (!b || typeof b.d !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(b.d)) return null;
  const session = typeof b.s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.s) ? b.s : null;
  const token = typeof b.t === 'string' && b.t.length < 2000 ? b.t : null;
  if (!Array.isArray(b.e)) return null;
  const events: AnalyticsEvent[] = [];
  for (const e of b.e.slice(0, 30)) {
    const x = e as { n?: unknown; p?: unknown; r?: unknown } | null;
    if (!x || typeof x.n !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(x.n)) continue;
    let props: Record<string, unknown> = {};
    if (x.p && typeof x.p === 'object' && !Array.isArray(x.p) && JSON.stringify(x.p).length <= 2048) props = x.p as Record<string, unknown>;
    const room = typeof x.r === 'string' && /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(x.r) ? x.r : null;
    events.push({ name: x.n, props, room });
  }
  return { device: b.d, session, token, events };
}
