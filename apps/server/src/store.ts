import pg from 'pg';
import type { ErrorRow } from './errors';
import type { Logger } from './log';
import { NO_STATS } from '@kto/game-core';
import type { BadgeStats, MySticker, StatsDelta } from '@kto/game-core';

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
  /** Инлайн-карточка «Собрать комнату», отправленная в чат: метка приглашения → id сообщения (для фильма матча). */
  saveTgCard(card: TgCard): Promise<void>;
  tgCard(tag: string): Promise<TgCard | null>;
  /** Загадка из фильма (/c/<код>): итог зрителя — первый с телефона окончательный. */
  savePuzzleResult(r: PuzzleResult): Promise<void>;
  /** Сколько зрителей сыграло загадку и сколько нашли актёра. */
  puzzleStats(code: string): Promise<{ played: number; found: number }>;
  /** Трекер ошибок (errors.ts): прибавить случаи к группам. Ответ — отпечатки новых групп и вернувшихся после недели тишины. */
  saveErrors(rows: ErrorRow[]): Promise<string[]>;
  /** Уборка: группы и дни старше 90 суток. */
  cleanupErrors(): Promise<void>;
  /** Гардероб (shop.ts): покупки и личный стикерпак игрока Telegram. */
  shopUser(userId: number): Promise<ShopUser | null>;
  saveShopUser(u: ShopUser): Promise<void>;
  /** Игроки гардероба с этой отметкой в учёте (до 500) — для напоминаний бота. */
  shopUsersWith(item: string): Promise<number[]>;
  /** Игроки с личным паком, по возрастанию id, после `after` (до `limit`) — для уборки чужих стикеров. */
  shopPacks(after: number, limit: number): Promise<number[]>;
  /**
   * Стикеры личного пака, которые положил бот (file_unique_id из getStickerSet). null — ещё не записаны (пак
   * собран до уборки): бот узнает свои по первому эмодзи.
   */
  packOwn(userId: number): Promise<string[] | null>;
  savePackOwn(userId: number, ids: string[]): Promise<void>;
  /** Записать оплату. false — этот платёж уже записан (Telegram повторил обновление). */
  saveShopPayment(p: ShopPayment): Promise<boolean>;
  /** Отметить возврат. null — платежа нет или он уже возвращён. */
  refundShopPayment(charge: string): Promise<ShopPayment | null>;
  /** Связь игрока сервера (анонимный id) с пользователем Telegram — для стикеров за матчи. */
  linkTelegram(link: TgLink): Promise<void>;
  /** Связи для этих игроков сервера (кого нет — нет в ответе). */
  telegramOf(gameUsers: string[]): Promise<TgLink[]>;
  /**
   * Матч сыгран без входа через Telegram (сайт): что открылось — ждёт, пока игрок войдёт (до 30 дней).
   * Стикеры копятся (без повторов, до 64), матч засчитан и с пустым списком.
   */
  savePendingEarn(gameUser: string, stickers: string[]): Promise<void>;
  /** Забрать отложенное при входе: null — матчей без входа не было. */
  takePendingEarn(gameUser: string): Promise<string[] | null>;
  /** Значки для статуса (game-core/badges.ts): прибавить к счётчикам игрока Telegram после матча. */
  bumpTgStats(tgUser: number, d: StatsDelta): Promise<void>;
  /** Счётчики игрока Telegram для значков (нет — нули). */
  tgStats(tgUser: number): Promise<BadgeStats>;
  /**
   * Аренда общей задачи (сверка оплат по расписанию): true — задача за этим экземпляром на `ms` (свою аренду
   * продлевает); false — её держит другой (синий и зелёный живут вместе при выкладке, база общая).
   */
  lease(name: string, owner: string, ms: number): Promise<boolean>;
  /**
   * Напоминания бота (nudges.ts): игроки Telegram, чья последняя победа — в [from, to) (мс). До 500.
   * Каждый — с языком, временем последнего матча и состоянием напоминаний.
   */
  nudgeWinners(from: number, to: number): Promise<NudgeRow[]>;
  /** Игроки Telegram, сыгравшие матч с `since` (мс). До 5000. */
  nudgeActive(since: number): Promise<NudgeRow[]>;
  /** Состояние напоминаний игрока Telegram (не писали ни разу — null). */
  nudgeOf(tgUser: number): Promise<NudgeState | null>;
  saveNudge(s: NudgeState): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface ShopUser {
  userId: number;
  lang: 'ru' | 'en';
  /** Имя в названии пака. */
  name: string;
  /** Что есть у игрока: `starter` (бесплатный пак), наборы (`kotBanan`), открытые стикеры (`st:<id>`). */
  items: string[];
  /** Имя стикерпака в Telegram (…_by_<бот>), пока не создан — null. */
  pack: string | null;
  /** Стикеры, уже добавленные в пак (стандартные — id, свои — `my<место>.<правка>`). */
  issued: string[];
  /** Свои стикеры игрока («Собери свой стикерпак»); нет — нет. */
  my?: MySticker[];
}

export interface TgLink {
  /** id игрока на игровом сервере (auth.ts). */
  gameUser: string;
  /** id пользователя Telegram. */
  tgUser: number;
  /** Имя для названия пака и язык — если пака ещё нет. */
  name: string;
  lang: 'ru' | 'en';
}

/** Напоминания бота игроку (nudges.ts). */
export interface NudgeState {
  tgUser: number;
  /** Нажал «Не напоминать». */
  off: boolean;
  /** Telegram не даёт писать (бот не запущен или заблокирован) — молчим до /start. */
  dead: boolean;
  /** Часовой пояс с телефона: минуты, как у `Date.getTimezoneOffset()` (Москва — −180); нет — по языку. */
  tz: number | null;
  /** Про какую победу (мс) уже напомнили, что звезда гаснет. */
  star: number | null;
  /** Какой стикер недели уже объявили. */
  week: string | null;
  /** Когда писали (мс), за последнюю неделю — для потолка. */
  sent: number[];
}

export interface NudgeRow {
  tgUser: number;
  lang: 'ru' | 'en';
  lastWin: number | null;
  /** Последний сыгранный матч (мс). */
  playedAt: number;
  nudge: NudgeState | null;
}

export interface ShopPayment {
  /** telegram_payment_charge_id */
  charge: string;
  userId: number;
  item: string;
  stars: number;
  refunded: boolean;
}

export interface DailyScore {
  chat: string;
  day: number;
  userId: number;
  name: string;
  tries: number;
  won: boolean;
}

export interface PuzzleResult {
  code: string;
  device: string;
  found: boolean;
  tries: number;
}

export interface TgCard {
  /** Метка приглашения (startapp=g_<метка>). */
  tag: string;
  /** inline_message_id из chosen_inline_result. */
  inlineId: string;
  lang: 'ru' | 'en';
}

/** Карточки старше недели не нужны: фильм приходит в конце матча, через минуты после отправки. */
const TG_CARD_TTL = '7 days';

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
  `create table if not exists tg_inline_cards (
     tag text primary key,
     inline_id text not null,
     lang text not null,
     created_at timestamptz not null default now()
   )`,
  // трекер ошибок (errors.ts): группа — отпечаток; sample — последний случай (без личного), tags — разбивка
  // по платформе, теме, фазе; reopened_at — вернулась после недели тишины (сторож шлёт тревогу)
  `create table if not exists error_groups (
     fp text primary key,
     source text not null,
     title text not null,
     culprit text not null default '',
     count bigint not null default 0,
     first_seen timestamptz not null default now(),
     last_seen timestamptz not null default now(),
     reopened_at timestamptz,
     first_build text not null default '',
     last_build text not null default '',
     tags jsonb not null default '{}'::jsonb,
     sample jsonb not null default '{}'::jsonb
   )`,
  `create index if not exists error_groups_last_idx on error_groups (last_seen)`,
  `create table if not exists error_daily (
     day date not null,
     fp text not null,
     count integer not null default 0,
     primary key (day, fp)
   )`,
  // загадки из фильма (puzzles.ts): по строке на телефон, первая попытка — окончательная
  `create table if not exists puzzle_results (
     code text not null,
     device text not null,
     found boolean not null,
     tries integer not null,
     created_at timestamptz not null default now(),
     primary key (code, device)
   )`,
  // гардероб (shop.ts): у игрока Telegram — наборы и личный стикерпак; оплаты звёздами — по charge id
  `create table if not exists shop_users (
     user_id bigint primary key,
     lang text not null default 'ru',
     name text not null default '',
     items text[] not null default '{}',
     pack text,
     issued text[] not null default '{}',
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists shop_payments (
     charge text primary key,
     user_id bigint not null,
     item text not null,
     stars integer not null,
     refunded boolean not null default false,
     created_at timestamptz not null default now()
   )`,
  // «Собери свой стикерпак»: свои стикеры игрока (фигурка, поза, цвет, подпись)
  `alter table shop_users add column if not exists my jsonb not null default '[]'::jsonb`,
  // стикеры за матчи: какой игрок сервера — какой пользователь Telegram (вход из Mini App; новый вход — перезапись)
  `create table if not exists tg_links (
     game_user text primary key,
     tg_user bigint not null,
     name text not null default '',
     lang text not null default 'ru',
     updated_at timestamptz not null default now()
   )`,
  // матчи до входа через Telegram (сайт): что открылось — отдаётся при входе
  `create table if not exists tg_pending_earn (
     game_user text primary key,
     stickers text[] not null default '{}',
     updated_at timestamptz not null default now()
   )`,
  // значки для статуса: счётчики игрока Telegram (матчи, победы, комнаты режиссёра с 4 живыми, последняя победа)
  `create table if not exists tg_stats (
     tg_user bigint primary key,
     matches integer not null default 0,
     wins integer not null default 0,
     rooms integer not null default 0,
     last_win timestamptz,
     updated_at timestamptz not null default now()
   )`,
  // значки-слоты «Казино»: сколько раз выбил 777 и череп в «Крутке»
  `alter table tg_stats add column if not exists jackpots integer not null default 0`,
  `alter table tg_stats add column if not exists skulls integer not null default 0`,
  // аренда общих задач (сверка оплат): кто держит и до какого времени
  `create table if not exists job_leases (
     name text primary key,
     owner text not null,
     until timestamptz not null
   )`,
  // напоминания бота (nudges.ts): «Звезда дубля гаснет», «Новый стикер недели» — кому можно писать и когда писали
  `create table if not exists tg_nudges (
     tg_user bigint primary key,
     off boolean not null default false,
     dead boolean not null default false,
     tz smallint,
     star bigint,
     week text,
     sent bigint[] not null default '{}',
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists tg_stats_last_win_idx on tg_stats (last_win)`,
  // уборка личных паков (shop.ts › cleanPacks): какие стикеры пака положил бот — остальные добавил сам игрок
  `create table if not exists tg_pack_own (
     user_id bigint primary key,
     ids text[] not null default '{}',
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists tg_stats_updated_idx on tg_stats (updated_at)`,
  `create index if not exists tg_links_tg_user_idx on tg_links (tg_user)`,
];

function nudgeFrom(x: Record<string, unknown>): NudgeState {
  return {
    tgUser: Number(x.tg_user ?? x.n_user),
    off: !!x.off,
    dead: !!x.dead,
    tz: x.tz === null || x.tz === undefined ? null : Number(x.tz),
    star: x.star === null || x.star === undefined ? null : Number(x.star),
    week: typeof x.week === 'string' ? x.week : null,
    sent: Array.isArray(x.sent) ? x.sent.map(Number) : [],
  };
}

/** Неделя тишины — и группа считается вернувшейся (снова тревога). */
const ERROR_QUIET = '7 days';

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

  async saveTgCard(c: TgCard): Promise<void> {
    await this.pool.query(
      `insert into tg_inline_cards (tag, inline_id, lang) values ($1, $2, $3) on conflict (tag) do update set inline_id = excluded.inline_id, lang = excluded.lang`,
      [c.tag, c.inlineId, c.lang],
    );
    // уборка заодно: карточек немного (по одной на приглашение)
    await this.pool.query(`delete from tg_inline_cards where created_at < now() - interval '${TG_CARD_TTL}'`);
  }

  async tgCard(tag: string): Promise<TgCard | null> {
    const res = await this.pool.query(`select tag, inline_id, lang from tg_inline_cards where tag = $1 and created_at > now() - interval '${TG_CARD_TTL}'`, [tag]);
    const x = res.rows[0];
    return x ? { tag: x.tag, inlineId: x.inline_id, lang: x.lang === 'en' ? 'en' : 'ru' } : null;
  }

  async savePuzzleResult(r: PuzzleResult): Promise<void> {
    await this.pool.query(`insert into puzzle_results (code, device, found, tries) values ($1, $2, $3, $4) on conflict do nothing`, [r.code, r.device, r.found, r.tries]);
  }

  async puzzleStats(code: string): Promise<{ played: number; found: number }> {
    const res = await this.pool.query(`select count(*)::int as played, count(*) filter (where found)::int as found from puzzle_results where code = $1`, [code]);
    return { played: res.rows[0]?.played ?? 0, found: res.rows[0]?.found ?? 0 };
  }

  async saveErrors(rows: ErrorRow[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const r of rows) {
      // xmax = 0 — строка только что вставлена; reopened — была тишина больше недели
      const res = await this.pool.query(
        `insert into error_groups as g (fp, source, title, culprit, count, first_build, last_build, tags, sample)
         values ($1, $2, $3, $4, $5, $6, $6, $7::jsonb, $8::jsonb)
         on conflict (fp) do update set
           count = g.count + excluded.count,
           last_seen = now(),
           last_build = case when excluded.last_build <> '' then excluded.last_build else g.last_build end,
           title = excluded.title,
           sample = excluded.sample,
           reopened_at = case when g.last_seen < now() - interval '${ERROR_QUIET}' then now() else g.reopened_at end,
           tags = (select coalesce(jsonb_object_agg(k, coalesce((g.tags->>k)::bigint, 0) + coalesce((excluded.tags->>k)::bigint, 0)), '{}'::jsonb)
                   from (select jsonb_object_keys(g.tags || excluded.tags) as k limit 80) t)
         returning (xmax = 0) as inserted, coalesce(reopened_at = now(), false) as reopened`,
        [r.fp, r.source, r.title, r.culprit, r.count, r.build, JSON.stringify(r.tags), JSON.stringify(r.sample)],
      );
      const x = res.rows[0];
      if (x?.inserted || x?.reopened) fresh.push(r.fp);
    }
    if (rows.length) {
      const vals: unknown[] = [];
      const ph = rows.map((r, i) => {
        vals.push(r.fp, r.count);
        return `(current_date, $${i * 2 + 1}, $${i * 2 + 2})`;
      });
      await this.pool.query(
        `insert into error_daily as d (day, fp, count) values ${ph.join(', ')} on conflict (day, fp) do update set count = d.count + excluded.count`,
        vals,
      );
    }
    return fresh;
  }

  async cleanupErrors(): Promise<void> {
    await this.pool.query(`DELETE FROM error_groups WHERE last_seen < now() - interval '90 days'`);
    await this.pool.query(`DELETE FROM error_daily WHERE day < current_date - 90`);
  }

  async shopUser(userId: number): Promise<ShopUser | null> {
    const res = await this.pool.query(`select user_id, lang, name, items, pack, issued, my from shop_users where user_id = $1`, [userId]);
    const x = res.rows[0];
    return x ? { userId: Number(x.user_id), lang: x.lang === 'en' ? 'en' : 'ru', name: x.name, items: x.items, pack: x.pack, issued: x.issued, my: Array.isArray(x.my) ? x.my : [] } : null;
  }

  async shopUsersWith(item: string): Promise<number[]> {
    const res = await this.pool.query(`select user_id from shop_users where $1 = any(items) limit 500`, [item]);
    return res.rows.map((r: { user_id: string | number }) => Number(r.user_id));
  }

  async shopPacks(after: number, limit: number): Promise<number[]> {
    const res = await this.pool.query(`select user_id from shop_users where pack is not null and user_id > $1 order by user_id limit $2`, [after, limit]);
    return res.rows.map((r: { user_id: string | number }) => Number(r.user_id));
  }

  async packOwn(userId: number): Promise<string[] | null> {
    const res = await this.pool.query(`select ids from tg_pack_own where user_id = $1`, [userId]);
    return res.rows[0] ? (res.rows[0].ids as string[]) : null;
  }

  async savePackOwn(userId: number, ids: string[]): Promise<void> {
    await this.pool.query(
      `insert into tg_pack_own (user_id, ids) values ($1, $2) on conflict (user_id) do update set ids = excluded.ids, updated_at = now()`,
      [userId, ids],
    );
  }

  async saveShopUser(u: ShopUser): Promise<void> {
    await this.pool.query(
      // my: undefined — запись от старого бота (своих стикеров не знает): не трогаем
      `insert into shop_users (user_id, lang, name, items, pack, issued, my) values ($1, $2, $3, $4, $5, $6, coalesce($7::jsonb, '[]'::jsonb))
       on conflict (user_id) do update set lang = excluded.lang, name = excluded.name, items = excluded.items, pack = excluded.pack, issued = excluded.issued,
         my = coalesce($7::jsonb, shop_users.my), updated_at = now()`,
      [u.userId, u.lang, u.name, u.items, u.pack, u.issued, u.my ? JSON.stringify(u.my) : null],
    );
  }

  async saveShopPayment(p: ShopPayment): Promise<boolean> {
    const res = await this.pool.query(`insert into shop_payments (charge, user_id, item, stars) values ($1, $2, $3, $4) on conflict do nothing`, [p.charge, p.userId, p.item, p.stars]);
    return res.rowCount === 1;
  }

  async refundShopPayment(charge: string): Promise<ShopPayment | null> {
    const res = await this.pool.query(`update shop_payments set refunded = true where charge = $1 and not refunded returning charge, user_id, item, stars`, [charge]);
    const x = res.rows[0];
    return x ? { charge: x.charge, userId: Number(x.user_id), item: x.item, stars: x.stars, refunded: true } : null;
  }

  async linkTelegram(l: TgLink): Promise<void> {
    await this.pool.query(
      `insert into tg_links (game_user, tg_user, name, lang) values ($1, $2, $3, $4)
       on conflict (game_user) do update set tg_user = excluded.tg_user, name = excluded.name, lang = excluded.lang, updated_at = now()`,
      [l.gameUser, l.tgUser, l.name, l.lang],
    );
  }

  async savePendingEarn(gameUser: string, stickers: string[]): Promise<void> {
    await this.pool.query(
      `insert into tg_pending_earn (game_user, stickers) values ($1, $2::text[])
       on conflict (game_user) do update set stickers = (select coalesce(array_agg(y.x), '{}') from (select distinct x from unnest(tg_pending_earn.stickers || excluded.stickers) x limit 64) y), updated_at = now()`,
      [gameUser, stickers.slice(0, 64)],
    );
  }

  async takePendingEarn(gameUser: string): Promise<string[] | null> {
    const res = await this.pool.query(`delete from tg_pending_earn where game_user = $1 and updated_at > now() - interval '30 days' returning stickers`, [gameUser]);
    return res.rows[0] ? (res.rows[0].stickers as string[]) : null;
  }

  async telegramOf(gameUsers: string[]): Promise<TgLink[]> {
    if (!gameUsers.length) return [];
    const res = await this.pool.query(`select game_user, tg_user, name, lang from tg_links where game_user = any($1::text[])`, [gameUsers]);
    return res.rows.map((x) => ({ gameUser: x.game_user, tgUser: Number(x.tg_user), name: x.name, lang: x.lang === 'en' ? 'en' : 'ru' }));
  }

  async bumpTgStats(tgUser: number, d: StatsDelta): Promise<void> {
    await this.pool.query(
      `insert into tg_stats (tg_user, matches, wins, rooms, last_win, jackpots, skulls) values ($1, $2, $3, $4, to_timestamp($5::double precision / 1000), $6, $7)
       on conflict (tg_user) do update set matches = tg_stats.matches + excluded.matches, wins = tg_stats.wins + excluded.wins,
         rooms = tg_stats.rooms + excluded.rooms, last_win = greatest(tg_stats.last_win, excluded.last_win),
         jackpots = tg_stats.jackpots + excluded.jackpots, skulls = tg_stats.skulls + excluded.skulls, updated_at = now()`,
      [tgUser, d.matches, d.wins, d.rooms, d.winAt, d.jackpots ?? 0, d.skulls ?? 0],
    );
  }

  async tgStats(tgUser: number): Promise<BadgeStats> {
    const r = await this.pool.query(`select matches, wins, rooms, extract(epoch from last_win) * 1000 as last_win, jackpots, skulls from tg_stats where tg_user = $1`, [tgUser]);
    const x = r.rows[0];
    return x
      ? { matches: Number(x.matches), wins: Number(x.wins), rooms: Number(x.rooms), lastWin: x.last_win === null ? null : Math.round(Number(x.last_win)), jackpots: Number(x.jackpots), skulls: Number(x.skulls) }
      : { ...NO_STATS };
  }

  private async nudgeRows(where: string, args: unknown[], limit: number): Promise<NudgeRow[]> {
    const r = await this.pool.query(
      `select s.tg_user, extract(epoch from s.last_win) * 1000 as last_win, extract(epoch from s.updated_at) * 1000 as played,
         (select lang from tg_links l where l.tg_user = s.tg_user order by l.updated_at desc limit 1) as lang,
         n.tg_user as n_user, n.off, n.dead, n.tz, n.star, n.week, n.sent
       from tg_stats s left join tg_nudges n on n.tg_user = s.tg_user
       where ${where} limit ${limit}`,
      args,
    );
    return r.rows.map((x) => ({
      tgUser: Number(x.tg_user),
      lang: x.lang === 'en' ? 'en' : 'ru',
      lastWin: x.last_win === null ? null : Math.round(Number(x.last_win)),
      playedAt: Math.round(Number(x.played)),
      nudge: x.n_user === null ? null : nudgeFrom(x),
    }));
  }

  nudgeWinners(from: number, to: number): Promise<NudgeRow[]> {
    return this.nudgeRows(`s.last_win >= to_timestamp($1::double precision / 1000) and s.last_win < to_timestamp($2::double precision / 1000)`, [from, to], 500);
  }

  nudgeActive(since: number): Promise<NudgeRow[]> {
    return this.nudgeRows(`s.updated_at >= to_timestamp($1::double precision / 1000)`, [since], 5000);
  }

  async nudgeOf(tgUser: number): Promise<NudgeState | null> {
    const r = await this.pool.query(`select tg_user, off, dead, tz, star, week, sent from tg_nudges where tg_user = $1`, [tgUser]);
    return r.rows[0] ? nudgeFrom(r.rows[0]) : null;
  }

  async saveNudge(s: NudgeState): Promise<void> {
    await this.pool.query(
      `insert into tg_nudges (tg_user, off, dead, tz, star, week, sent) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tg_user) do update set off = excluded.off, dead = excluded.dead, tz = excluded.tz, star = excluded.star,
         week = excluded.week, sent = excluded.sent, updated_at = now()`,
      [s.tgUser, s.off, s.dead, s.tz, s.star, s.week, s.sent],
    );
  }

  async lease(name: string, owner: string, ms: number): Promise<boolean> {
    // одна строка на задачу: занять свободную (или просроченную, или свою) — атомарно, одним запросом
    const r = await this.pool.query(
      `insert into job_leases (name, owner, until) values ($1, $2, now() + make_interval(secs => $3))
       on conflict (name) do update set owner = excluded.owner, until = excluded.until
       where job_leases.owner = excluded.owner or job_leases.until < now()
       returning owner`,
      [name, owner, ms / 1000],
    );
    return (r.rowCount ?? 0) > 0;
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

  cards = new Map<string, TgCard>();

  async saveTgCard(c: TgCard): Promise<void> {
    this.cards.delete(c.tag);
    this.cards.set(c.tag, { ...c });
    if (this.cards.size > 5000) this.cards.delete(this.cards.keys().next().value!);
  }

  async tgCard(tag: string): Promise<TgCard | null> {
    return this.cards.get(tag) ?? null;
  }

  puzzles: PuzzleResult[] = [];

  async savePuzzleResult(r: PuzzleResult): Promise<void> {
    if (this.puzzles.some((x) => x.code === r.code && x.device === r.device)) return;
    this.puzzles.push({ ...r });
    if (this.puzzles.length > 20_000) this.puzzles.splice(0, this.puzzles.length - 20_000);
  }

  async puzzleStats(code: string): Promise<{ played: number; found: number }> {
    const rows = this.puzzles.filter((x) => x.code === code);
    return { played: rows.length, found: rows.filter((x) => x.found).length };
  }

  errors = new Map<string, ErrorRow & { firstSeen: number; lastSeen: number }>();

  async saveErrors(rows: ErrorRow[]): Promise<string[]> {
    const fresh: string[] = [];
    const now = Date.now();
    for (const r of rows) {
      const g = this.errors.get(r.fp);
      if (!g) {
        this.errors.set(r.fp, { ...r, tags: { ...r.tags }, firstSeen: now, lastSeen: now });
        fresh.push(r.fp);
        continue;
      }
      if (now - g.lastSeen > 7 * 86_400_000) fresh.push(r.fp);
      g.count += r.count;
      g.lastSeen = now;
      g.sample = r.sample;
      for (const [k, v] of Object.entries(r.tags)) g.tags[k] = (g.tags[k] ?? 0) + v;
    }
    if (this.errors.size > 2000) this.errors.delete(this.errors.keys().next().value!);
    return fresh;
  }

  async cleanupErrors(): Promise<void> {}

  shop = new Map<number, ShopUser>();
  payments = new Map<string, ShopPayment>();

  async shopUser(userId: number): Promise<ShopUser | null> {
    const u = this.shop.get(userId);
    return u ? structuredClone(u) : null;
  }

  async shopUsersWith(item: string): Promise<number[]> {
    return [...this.shop.values()].filter((u) => u.items.includes(item)).map((u) => u.userId).slice(0, 500);
  }

  async shopPacks(after: number, limit: number): Promise<number[]> {
    return [...this.shop.values()].filter((u) => u.pack && u.userId > after).map((u) => u.userId).sort((a, b) => a - b).slice(0, limit);
  }

  packOwnIds = new Map<number, string[]>();

  async packOwn(userId: number): Promise<string[] | null> {
    const ids = this.packOwnIds.get(userId);
    return ids ? [...ids] : null;
  }

  async savePackOwn(userId: number, ids: string[]): Promise<void> {
    this.packOwnIds.set(userId, [...ids]);
  }

  async saveShopUser(u: ShopUser): Promise<void> {
    // как в Postgres: запись без my (старый бот) своих стикеров не стирает
    const my = u.my ?? this.shop.get(u.userId)?.my;
    this.shop.set(u.userId, structuredClone({ ...u, ...(my ? { my } : {}) }));
  }

  async saveShopPayment(p: ShopPayment): Promise<boolean> {
    if (this.payments.has(p.charge)) return false;
    this.payments.set(p.charge, { ...p, refunded: false });
    return true;
  }

  async refundShopPayment(charge: string): Promise<ShopPayment | null> {
    const p = this.payments.get(charge);
    if (!p || p.refunded) return null;
    p.refunded = true;
    return { ...p };
  }

  links = new Map<string, TgLink>();

  async linkTelegram(l: TgLink): Promise<void> {
    this.links.set(l.gameUser, { ...l });
  }

  pending = new Map<string, string[]>();

  async savePendingEarn(gameUser: string, stickers: string[]): Promise<void> {
    this.pending.set(gameUser, [...new Set([...(this.pending.get(gameUser) ?? []), ...stickers])].slice(0, 64));
  }

  async takePendingEarn(gameUser: string): Promise<string[] | null> {
    const x = this.pending.get(gameUser) ?? null;
    this.pending.delete(gameUser);
    return x;
  }

  async telegramOf(gameUsers: string[]): Promise<TgLink[]> {
    return gameUsers.flatMap((g) => (this.links.has(g) ? [{ ...this.links.get(g)! }] : []));
  }

  stats = new Map<number, BadgeStats>();

  async bumpTgStats(tgUser: number, d: StatsDelta): Promise<void> {
    this.played.set(tgUser, Date.now());
    const s = this.stats.get(tgUser) ?? { ...NO_STATS };
    this.stats.set(tgUser, {
      matches: s.matches + d.matches,
      wins: s.wins + d.wins,
      rooms: s.rooms + d.rooms,
      lastWin: d.winAt === null ? s.lastWin : Math.max(s.lastWin ?? 0, d.winAt),
      jackpots: s.jackpots + (d.jackpots ?? 0),
      skulls: s.skulls + (d.skulls ?? 0),
    });
  }

  async tgStats(tgUser: number): Promise<BadgeStats> {
    return { ...(this.stats.get(tgUser) ?? NO_STATS) };
  }

  /** Когда игрок Telegram сыграл последний матч (как updated_at у tg_stats). */
  played = new Map<number, number>();
  nudges = new Map<number, NudgeState>();

  private nudgeRowsWhere(ok: (s: BadgeStats, played: number) => boolean): NudgeRow[] {
    const lang = (tg: number) => [...this.links.values()].reverse().find((l) => l.tgUser === tg)?.lang ?? 'ru';
    return [...this.stats].flatMap(([tg, s]) => {
      const played = this.played.get(tg) ?? 0;
      if (!ok(s, played)) return [];
      const n = this.nudges.get(tg);
      return [{ tgUser: tg, lang: lang(tg), lastWin: s.lastWin, playedAt: played, nudge: n ? { ...n, sent: [...n.sent] } : null }];
    });
  }

  async nudgeWinners(from: number, to: number): Promise<NudgeRow[]> {
    return this.nudgeRowsWhere((s) => s.lastWin !== null && s.lastWin >= from && s.lastWin < to);
  }

  async nudgeActive(since: number): Promise<NudgeRow[]> {
    return this.nudgeRowsWhere((_, played) => played >= since);
  }

  async nudgeOf(tgUser: number): Promise<NudgeState | null> {
    const n = this.nudges.get(tgUser);
    return n ? { ...n, sent: [...n.sent] } : null;
  }

  async saveNudge(s: NudgeState): Promise<void> {
    this.nudges.set(s.tgUser, { ...s, sent: [...s.sent] });
  }

  leases = new Map<string, { owner: string; until: number }>();

  async lease(name: string, owner: string, ms: number): Promise<boolean> {
    const l = this.leases.get(name);
    if (l && l.owner !== owner && l.until > Date.now()) return false;
    this.leases.set(name, { owner, until: Date.now() + ms });
    return true;
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
