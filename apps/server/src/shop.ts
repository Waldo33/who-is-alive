import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DICTS, SHOP_ITEMS, STICKER_LIST, fmt, isStickerId, shopItem } from '@kto/game-core';
import type { StickerMeta } from '@kto/game-core';
import { RateWindow } from './limits';
import { errFields } from './log';
import type { Logger } from './log';
import type { ShopPayment, ShopUser, Store, TgLink } from './store';

/**
 * Гардероб (за флагом shop в клиенте): наборы за звёзды Telegram и личный стикерпак игрока.
 *
 * Маршруты бота (https://api.<домен>/tg/...), тело — { initData } от Mini App (подпись проверяет бот):
 *   POST /shop        — что есть у игрока, ссылка на его пак; недовыданные стикеры досылаются;
 *   POST /shop/claim  — бесплатный пак с обычным актёром (плашка на главной после первого матча);
 *   POST /shop/pack   — { item, mode: in | own } стикеры купленного набора: в свой пак (in) или новым паком (own);
 *   POST /shop/buy    — { item } → ссылка на счёт в звёздах (WebApp.openInvoice);
 *   POST /shop/link   — { token } связать игрока игрового сервера (его токен) с этим пользователем Telegram:
 *                       по связи сервер после матча открывает стикеры за события матча (earn в game-core/shop.ts).
 * Стикеры за матч: игровой сервер считает, кому что открылось, и шлёт боту /internal/tg/stickers → `earn`
 * (только наборы, которые у игрока есть; новый стикер — сообщение «Новый стикер в паке»).
 * Вебхук: pre_checkout_query (проверка перед оплатой), message.successful_payment (выдать набор и
 * предложить кнопками «В мой пак» / «Новый пак»), callback_query «pk:in|own:<набор>» (эти кнопки), /start stickers (бесплатный пак по внешней
 * ссылке t.me/<бот>?start=stickers), /paysupport (обязателен для оплаты звёздами).
 * Возврат — только изнутри: POST /internal/tg/refund { charge }.
 *
 * Паки — только по желанию игрока: свой пак (`pack`, «Массовка · Имя · @бот»; набор в него — `in:<набор>`) или
 * отдельный пак набора (`own:<набор>`, создан — `made:<набор>`). Бот правит лишь паки, которые создал сам.
 * Стикеры набора попадают в пак только после записанной оплаты. Стикеры — видео WEBM из apps/server/stickers
 * (`pnpm --filter web stickers`). Выдача — очередью по игроку: что выдано, записано в учёте; упало — дошлётся
 * при следующем заходе в гардероб.
 *
 * Учёт: у игрового сервера — его Postgres; у сервера бота базы нет — RemoteLedger, по туннелю к игровому.
 */

export type ShopLedger = Pick<Store, 'shopUser' | 'saveShopUser' | 'saveShopPayment' | 'refundShopPayment'> & {
  /** Связать игрока игрового сервера (по его токену — проверяет игровой сервер) с пользователем Telegram. false — токен чужой. */
  linkGame(token: string, link: Omit<TgLink, 'gameUser'>): Promise<boolean>;
};

/** Проверка токена игрока (auth.ts › verify): id игрока или null. */
export type VerifyToken = (token: string) => Promise<string | null>;

/** Учёт в своей базе (бот и игровой сервер в одном процессе: разработка, тесты). */
export function localLedger(store: Store, verify?: VerifyToken): ShopLedger {
  return {
    shopUser: (id) => store.shopUser(id),
    saveShopUser: (u) => store.saveShopUser(u),
    saveShopPayment: (p) => store.saveShopPayment(p),
    refundShopPayment: (c) => store.refundShopPayment(c),
    async linkGame(token, link) {
      const gameUser = verify ? await verify(token) : null;
      if (!gameUser) return false;
      await store.linkTelegram({ gameUser, ...link });
      return true;
    },
  };
}

/** Токен игрока: JWT (три части base64url), не длиннее 1 КБ. */
const TOKEN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,512}$/;

const ITEM = /^(?:starter|(?:st|in|own|made):[A-Za-z]{1,24}|[A-Za-z]{1,24})$/;
const PACK = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CHARGE = /^[A-Za-z0-9_:.-]{1,128}$/;

/** Учёт на игровом сервере, по туннелю (сервер бота без базы). */
export class RemoteLedger implements ShopLedger {
  constructor(
    private readonly base: string,
    private readonly f: typeof fetch = fetch,
  ) {}

  private async op<R>(body: Record<string, unknown>): Promise<R> {
    const r = await this.f(`${this.base}/internal/shop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`shop upstream ${r.status}`);
    return ((await r.json()) as { result: R }).result;
  }

  shopUser(userId: number) {
    return this.op<ShopUser | null>({ op: 'get', userId });
  }
  saveShopUser(user: ShopUser) {
    return this.op<void>({ op: 'save', user });
  }
  saveShopPayment(payment: ShopPayment) {
    return this.op<boolean>({ op: 'pay', payment });
  }
  refundShopPayment(charge: string) {
    return this.op<ShopPayment | null>({ op: 'refund', charge });
  }
  linkGame(token: string, link: Omit<TgLink, 'gameUser'>) {
    return this.op<boolean>({ op: 'link', token, link });
  }
}

const userId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const strs = (x: unknown, max: number, re: RegExp): x is string[] => Array.isArray(x) && x.length <= max && x.every((s) => typeof s === 'string' && re.test(s));

function parseUser(x: unknown): ShopUser | null {
  const u = x as Partial<ShopUser> | null;
  if (!u || !userId(u.userId) || (u.lang !== 'ru' && u.lang !== 'en') || typeof u.name !== 'string' || u.name.length > 32) return null;
  if (!strs(u.items, 64, ITEM) || !Array.isArray(u.issued) || u.issued.length > 120 || !u.issued.every(isStickerId)) return null;
  if (u.pack !== null && !(typeof u.pack === 'string' && PACK.test(u.pack))) return null;
  return { userId: u.userId, lang: u.lang, name: u.name, items: [...u.items], pack: u.pack, issued: [...u.issued] };
}

/** /internal/shop на игровом сервере: операция учёта от сервера бота. Маршрут внутренний, но вход всё равно проверяем. */
export async function shopLedgerOp(store: ShopLedger, raw: unknown): Promise<{ status: number; body: unknown }> {
  const b = raw as { op?: unknown; userId?: unknown; user?: unknown; payment?: unknown; charge?: unknown; token?: unknown; link?: unknown } | null;
  const bad = { status: 400, body: { error: 'bad_request' } };
  if (b?.op === 'get') return userId(b.userId) ? { status: 200, body: { result: await store.shopUser(b.userId) } } : bad;
  if (b?.op === 'save') {
    const u = parseUser(b.user);
    if (!u) return bad;
    await store.saveShopUser(u);
    return { status: 200, body: { result: null } };
  }
  if (b?.op === 'pay') {
    const p = b.payment as Partial<ShopPayment> | null;
    if (!p || typeof p.charge !== 'string' || !CHARGE.test(p.charge) || !userId(p.userId) || !shopItem(p.item) || !Number.isInteger(p.stars) || p.stars! < 1) return bad;
    return { status: 200, body: { result: await store.saveShopPayment({ charge: p.charge, userId: p.userId, item: p.item!, stars: p.stars!, refunded: false }) } };
  }
  if (b?.op === 'link') {
    const l = b.link as Partial<TgLink> | null;
    if (typeof b.token !== 'string' || !TOKEN.test(b.token) || !l || !userId(l.tgUser) || typeof l.name !== 'string' || l.name.length > 32 || (l.lang !== 'ru' && l.lang !== 'en')) return bad;
    return { status: 200, body: { result: await store.linkGame(b.token, { tgUser: l.tgUser, name: packName(l.name), lang: l.lang }) } };
  }
  if (b?.op === 'refund') return typeof b.charge === 'string' && CHARGE.test(b.charge) ? { status: 200, body: { result: await store.refundShopPayment(b.charge) } } : bad;
  return bad;
}

/**
 * Стикеры, которые положены игроку: стартовый пак, «сразу» у наборов и открытые наградами (`st:<id>`) —
 * если игрок захотел пак (`pack`).
 */
export function wantedStickers(items: string[]): StickerMeta[] {
  const has = new Set(items);
  return STICKER_LIST.filter((s) =>
    s.set === 'starter'
      ? has.has('starter') && has.has('pack')
      : has.has(s.set) && (has.has(`in:${s.set}`) || has.has(`own:${s.set}`)) && (s.now || has.has(`st:${s.id}`)),
  );
}

/** Имя отдельного пака набора: <набор><игрок>_by_<бот>. */
const ownPack = (set: string, id: number, bot: string) => `${set.toLowerCase()}${id}_by_${bot}`.slice(0, 64);

/** Имя игрока в названии пака: без @, ссылок и невидимых символов. */
export function packName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/https?:|[@/\\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 20)
    : '';
}

export interface ShopDeps {
  api<R = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<R>;
  username(): Promise<string>;
  ledger: ShopLedger;
  log: Logger;
  /** Папка с видеостикерами: <язык>/<id>.webm. */
  stickersDir: string;
  /** Канал игры — в /paysupport. */
  channel: string;
  /** Адрес игры (кнопка «Играть» в сообщении о новом стикере). */
  site?: string;
  /** Канал игры для проверки подписки (getChatMember; бот должен быть админом канала): «@имя». */
  channelId?: string;
  /** Подмена ожидания (тесты). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ShopInit {
  user: { id: number; first_name?: string; username?: string; language_code?: string };
}

export interface ShopReply {
  status: number;
  body: unknown;
}

type Lang = 'ru' | 'en';
/** Какой пак показать после выдачи: отдельный пак набора (own:) или свой. */
const link0 = (st: { pack: string | null; packs: Record<string, string> }, add: string[]) => {
  const own = add.find((i) => i.startsWith('own:'));
  return (own && st.packs[own.slice(4)]) || st.pack;
};
const langOf = (code?: string): Lang => (code && /^(ru|uk|be|kk)/.test(code) ? 'ru' : 'en');

export class Shop {
  private readonly queue = new Map<number, Promise<void>>();
  /** Почему не вышло выдать (покажет гардероб): need_bot — игрок не открыл бота. */
  private readonly failed = new Map<number, string>();
  private readonly rate = new RateWindow(20, 60_000);
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: ShopDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Маршрут /tg/shop… с проверенным initData. */
  async route(path: string, init: ShopInit, body: { item?: unknown; mode?: unknown; token?: unknown }): Promise<ShopReply> {
    const id = init.user.id;
    const now = (this.d.now ?? Date.now)();
    if (!this.rate.take(String(id), now)) return { status: 429, body: { error: 'rate_limited' } };
    this.rate.sweep(now);
    if (path === '/shop') return { status: 200, body: await this.state(id, true) };
    if (path === '/shop/claim') return { status: 200, body: await this.claim(init.user) };
    if (path === '/shop/pack') return this.makePack(init.user, body.item, body.mode);
    if (path === '/shop/buy') return this.buy(init, body.item);
    if (path === '/shop/link') return this.link(init.user, body.token);
    return { status: 404, body: { error: 'not_found' } };
  }

  private async state(id: number, kick: boolean) {
    const u = await this.d.ledger.shopUser(id);
    const want = u ? wantedStickers(u.items) : [];
    const missing = u ? want.filter((s) => !u.issued.includes(s.id)).length : 0;
    // недовыданное (сбой Telegram, перезапуск) — дослать в фоне
    if (kick && missing && !this.queue.has(id)) void this.issue(id);
    const bot = u && SHOP_ITEMS.some((x) => u.items.includes(`made:${x.id}`)) ? await this.d.username() : '';
    return {
      items: (u?.items ?? []).filter((i) => i === 'starter' || i === 'pack' || shopItem(i) || /^(?:in|own):/.test(i)),
      pack: u?.pack ? `https://t.me/addstickers/${u.pack}` : null,
      /** Отдельные паки наборов: набор → ссылка. */
      packs: Object.fromEntries(SHOP_ITEMS.filter((x) => u?.items.includes(`made:${x.id}`)).map((x) => [x.id, `https://t.me/addstickers/${ownPack(x.id, u!.userId, bot)}`])),
      issued: u?.issued.length ?? 0,
      wanted: want.length,
      error: this.failed.get(id) ?? null,
      catalog: SHOP_ITEMS,
    };
  }

  private async user(from: ShopInit['user']): Promise<ShopUser> {
    const id = from.id;
    return (
      (await this.d.ledger.shopUser(id)) ?? {
        userId: id,
        lang: langOf(from.language_code),
        name: packName(from.first_name) || packName(from.username) || 'Актёр',
        items: [],
        pack: null,
        issued: [],
      }
    );
  }

  /** Добавить игроку предметы и выдать стикеры; что-то выдалось впервые — сообщение в личку с кнопкой пака. */
  private async grant(from: ShopInit['user'], add: string[], text: (l: Lang) => string) {
    const u = await this.user(from);
    const fresh = add.filter((i) => !u.items.includes(i));
    if (fresh.length) {
      u.items.push(...fresh);
      await this.d.ledger.saveShopUser(u);
    }
    const before = u.issued.length;
    await this.issue(u.userId);
    const st = await this.state(u.userId, false);
    const link = link0(st, add);
    if (st.issued > before && link) await this.notify(u.userId, u.lang, text(u.lang), link);
    return st;
  }

  /** Связать игрока игрового сервера (его токен из Mini App) с этим пользователем Telegram. */
  private async link(from: ShopInit['user'], token: unknown): Promise<ShopReply> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return { status: 400, body: { error: 'bad_token' } };
    const ok = await this.d.ledger.linkGame(token, { tgUser: from.id, name: packName(from.first_name) || packName(from.username) || 'Актёр', lang: langOf(from.language_code) });
    return ok ? { status: 200, body: { ok: true } } : { status: 403, body: { error: 'bad_token' } };
  }

  /**
   * Стикеры, открытые в матче (от игрового сервера, /internal/tg/stickers). Кладём только стикеры наборов,
   * которые у игрока есть (стартовый — всем); каждый — один раз. Выдача — в той же очереди, что и остальное.
   */
  earn(raw: unknown): Promise<{ users: number }> {
    const list = (raw as { users?: unknown } | null)?.users;
    if (!Array.isArray(list)) return Promise.resolve({ users: 0 });
    const ok = list.slice(0, 8).filter(
      (x): x is { tgUser: number; name: string; lang: Lang; stickers: string[] } =>
        !!x && userId(x.tgUser) && typeof x.name === 'string' && x.name.length <= 32 && (x.lang === 'ru' || x.lang === 'en') && Array.isArray(x.stickers) && x.stickers.length <= 32 && x.stickers.every(isStickerId),
    );
    return Promise.all(ok.map((x) => this.earnOne(x))).then(() => ({ users: ok.length }));
  }

  private earnOne(x: { tgUser: number; name: string; lang: Lang; stickers: string[] }): Promise<void> {
    const id = x.tgUser;
    // в очередь игрока: запись предметов не перетрётся выдачей, которая идёт прямо сейчас
    const prev = this.queue.get(id) ?? Promise.resolve();
    const run = prev
      .then(async () => {
        const u = (await this.d.ledger.shopUser(id)) ?? { userId: id, lang: x.lang, name: packName(x.name) || 'Актёр', items: [], pack: null, issued: [] };
        const fresh = STICKER_LIST.filter(
          (s) => x.stickers.includes(s.id) && !s.now && (s.set === 'starter' || u.items.includes(s.set)) && !u.items.includes(`st:${s.id}`),
        );
        // первый сыгранный матч открывает бесплатный пак: бот предлагает его забрать
        const first = !u.items.includes('played');
        if (first) u.items.push('played');
        if (!fresh.length && !first) return;
        u.items.push(...fresh.map((s) => `st:${s.id}`));
        await this.d.ledger.saveShopUser(u);
        if (first && !u.items.includes('starter')) await this.offerFree(u);
        if (!fresh.length) return;
        this.d.log('info', 'shop_earned', { n: fresh.length });
        const before = new Set(u.issued);
        await this.issueRun(id);
        const after = await this.d.ledger.shopUser(id);
        const got = fresh.filter((s) => after?.issued.includes(s.id) && !before.has(s.id));
        if (!got.length || !after) return;
        const st = await this.state(id, false);
        const t = DICTS[after.lang].shop;
        const set = got[0].set;
        const inSet = STICKER_LIST.filter((s) => s.set === set);
        const text = fmt(t.botEarned, { sticker: got.map((s) => `«${t.stickers[s.id].join(' ')}»`).join(', '), n: inSet.filter((s) => after.issued.includes(s.id)).length, of: inSet.length });
        await this.notify(id, after.lang, text, (set !== 'starter' && st.packs[set]) || st.pack, true);
      })
      .catch((e: unknown) => this.d.log('warn', 'shop_earn', errFields(e)));
    this.queue.set(id, run);
    void run.finally(() => {
      if (this.queue.get(id) === run) this.queue.delete(id);
    });
    return run;
  }

  /** После первого матча: «Твой стикерпак готов — забрать?» с кнопкой (писать можно, если игрок открывал бота). */
  private async offerFree(u: ShopUser): Promise<void> {
    const t = DICTS[u.lang].shop;
    try {
      await this.d.api('sendMessage', { chat_id: u.userId, text: t.botFreeOffer, reply_markup: { inline_keyboard: [[{ text: t.botFreeClaim, callback_data: 'free:claim' }]] } });
    } catch (e) {
      this.d.log('warn', 'shop_notify', { err: String(e).slice(0, 200) });
    }
  }

  /** Бесплатный пак с обычным актёром: из гардероба на главной или по внешней ссылке (/start stickers). */
  async claim(from: ShopInit['user']) {
    const u = await this.d.ledger.shopUser(from.id);
    // бесплатный пак — за сыгранный матч (сервер видел игрока в матче, `played`) или за подписку на канал
    if (!u?.items.includes('starter') && !u?.items.includes('played') && !(await this.subscribed(from.id))) {
      return { ...(await this.state(from.id, false)), error: 'need_sub', channel: this.d.channel };
    }
    return this.grant(from, ['starter', 'pack'], (l) => DICTS[l].shop.botFree);
  }

  /** Бесплатный пак по ссылке /start stickers: нет ни матча, ни подписки — кнопки «Подписаться» и «Я подписался». */
  async claimInChat(from: ShopInit['user']): Promise<void> {
    const st = await this.claim(from);
    if (st.error !== 'need_sub') return;
    const t = DICTS[langOf(from.language_code)].shop;
    await this.d.api('sendMessage', {
      chat_id: from.id,
      text: t.botNeedSub,
      reply_markup: { inline_keyboard: [[{ text: t.botSubscribe, url: this.d.channel }], [{ text: t.botSubscribed, callback_data: 'free:claim' }]] },
    });
  }

  /**
   * Подписан ли игрок на канал игры. Проверить нельзя (бот не админ канала, сбой Telegram) — считаем, что да:
   * пак бесплатный, из-за настройки канала игроку отказывать не стоит.
   */
  private async subscribed(id: number): Promise<boolean> {
    if (!this.d.channelId) return true;
    try {
      const m = await this.d.api<{ status?: string; is_member?: boolean }>('getChatMember', { chat_id: this.d.channelId, user_id: id });
      if (m?.status === 'left' || m?.status === 'kicked') return false;
      if (m?.status === 'restricted') return m.is_member !== false;
      return true;
    } catch (e) {
      this.d.log('warn', 'shop_sub_check', { err: String(e).slice(0, 200) });
      return true;
    }
  }

  /**
   * Стикеры купленного набора: в свой пак (`in`, его нет — создастся) или отдельным паком (`own`).
   * Только если набор куплен (оплата записана); выбор делается один раз.
   */
  async makePack(from: ShopInit['user'], rawItem: unknown, mode: unknown): Promise<ShopReply> {
    const item = shopItem(rawItem);
    if (!item || (mode !== 'in' && mode !== 'own')) return { status: 400, body: { error: 'bad_request' } };
    const u = await this.d.ledger.shopUser(from.id);
    if (!u?.items.includes(item.id)) return { status: 403, body: { error: 'not_owned' } };
    if (u.items.includes(`in:${item.id}`) || u.items.includes(`own:${item.id}`)) return { status: 200, body: await this.state(u.userId, true) };
    return { status: 200, body: await this.grant(from, [`${mode}:${item.id}`], (l) => DICTS[l].shop.botPackReady) };
  }

  /** Кнопки под сообщением о покупке: «pk:in:<набор>» — в мой пак, «pk:own:<набор>» — новый пак. */
  async onCallback(q: { id: string; from: ShopInit['user']; data?: string }): Promise<void> {
    // «Забрать стикерпак» (после первого матча) и «Я подписался» (по ссылке)
    if (q.data === 'free:claim') {
      const r = this.claim(q.from);
      const first = await Promise.race([r, new Promise<null>((ok) => setTimeout(() => ok(null), 1500))]);
      const t = DICTS[langOf(q.from.language_code)].shop;
      await this.d.api('answerCallbackQuery', first?.error === 'need_sub' ? { callback_query_id: q.id, text: t.botNoSub, show_alert: true } : { callback_query_id: q.id });
      await r;
      return;
    }
    const m = /^pk:(in|own):([A-Za-z]{1,24})$/.exec(q.data ?? '');
    if (!m) return;
    // ответить сразу (кнопка перестаёт крутиться), пак собирается несколько секунд
    const r = this.makePack(q.from, m[2], m[1]);
    await this.d.api('answerCallbackQuery', { callback_query_id: q.id });
    await r;
  }

  private async buy(init: ShopInit, raw: unknown): Promise<ShopReply> {
    const item = shopItem(raw);
    if (!item) return { status: 400, body: { error: 'bad_item' } };
    const u = await this.user(init.user);
    if (u.items.includes(item.id)) return { status: 409, body: { error: 'owned' } };
    const t = DICTS[u.lang].shop;
    const link = await this.d.api<string>('createInvoiceLink', {
      title: t.invoiceTitle,
      description: t.invoiceText,
      payload: `${item.id}:${u.userId}`,
      currency: 'XTR',
      prices: [{ label: t.invoiceTitle, amount: item.stars }],
    });
    return { status: 200, body: { link } };
  }

  /** Разбор payload счёта: «набор:игрок». */
  private payload(s: unknown): { item: NonNullable<ReturnType<typeof shopItem>>; userId: number } | null {
    const m = typeof s === 'string' ? /^([A-Za-z]{1,24}):(\d{1,16})$/.exec(s) : null;
    const item = m ? shopItem(m[1]) : undefined;
    return m && item ? { item, userId: Number(m[2]) } : null;
  }

  /** Перед оплатой: тот ли игрок, та ли цена, нет ли уже набора. Ответить надо за 10 с. */
  async preCheckout(q: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string }): Promise<void> {
    const p = this.payload(q.invoice_payload);
    let ok = !!p && p.userId === q.from.id && q.currency === 'XTR' && q.total_amount === p.item.stars;
    if (ok) {
      const u = await this.d.ledger.shopUser(q.from.id);
      ok = !u?.items.includes(p!.item.id);
    }
    await this.d.api('answerPreCheckoutQuery', ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: 'Already owned / Уже куплено' });
  }

  /**
   * Оплата прошла: записать (повтор того же платежа не выдаёт дважды), дать набор, выдать стикеры «сразу».
   * Ошибка учёта — бросаем: вебхук ответит не 200, и Telegram повторит обновление.
   */
  async paid(msg: { from?: { id: number; first_name?: string; username?: string; language_code?: string }; successful_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string } }): Promise<void> {
    const sp = msg.successful_payment;
    const from = msg.from;
    const p = sp && this.payload(sp.invoice_payload);
    if (!sp || !from || !p || sp.currency !== 'XTR' || p.userId !== from.id || !CHARGE.test(sp.telegram_payment_charge_id)) {
      this.d.log('warn', 'shop_bad_payment', { payload: String(sp?.invoice_payload).slice(0, 80) });
      return;
    }
    const fresh = await this.d.ledger.saveShopPayment({ charge: sp.telegram_payment_charge_id, userId: from.id, item: p.item.id, stars: sp.total_amount, refunded: false });
    const u = await this.user(from);
    if (!u.items.includes(p.item.id)) {
      u.items.push(p.item.id);
      await this.d.ledger.saveShopUser(u);
    }
    if (!fresh) return;
    this.d.log('info', 'shop_paid', { item: p.item.id, stars: sp.total_amount });
    // пак — по желанию: свой пак от бота уже есть — «Добавить в мой пак» или «Создать новый», нет — «Создать»
    const t = DICTS[u.lang].shop;
    const rows = u.pack
      ? [[{ text: t.botAddPack, callback_data: `pk:in:${p.item.id}` }], [{ text: t.botNewPack, callback_data: `pk:own:${p.item.id}` }]]
      : [[{ text: t.botMakePack, callback_data: `pk:own:${p.item.id}` }]];
    await this.d.api('sendMessage', { chat_id: u.userId, text: t.botBought, reply_markup: { inline_keyboard: rows } });
  }

  /** Возврат звёзд (изнутри машины: /internal/tg/refund). Набор забираем, стикеры остаются в паке. */
  async refund(charge: unknown): Promise<ShopReply> {
    if (typeof charge !== 'string' || !CHARGE.test(charge)) return { status: 400, body: { error: 'bad_charge' } };
    const p = await this.d.ledger.refundShopPayment(charge);
    if (!p) return { status: 404, body: { error: 'not_found' } };
    try {
      await this.d.api('refundStarPayment', { user_id: p.userId, telegram_payment_charge_id: charge });
    } catch (e) {
      this.d.log('error', 'shop_refund', { charge, ...errFields(e) });
      return { status: 502, body: { error: 'telegram' } };
    }
    const u = await this.d.ledger.shopUser(p.userId);
    if (u) {
      u.items = u.items.filter((i) => i !== p.item);
      await this.d.ledger.saveShopUser(u);
    }
    this.d.log('info', 'shop_refunded', { item: p.item, stars: p.stars });
    return { status: 200, body: { ok: true, item: p.item, stars: p.stars } };
  }

  async support(chat: number, code?: string): Promise<void> {
    await this.d.api('sendMessage', { chat_id: chat, text: fmt(DICTS[langOf(code)].shop.botSupport, { channel: this.d.channel }) });
  }

  private async notify(chat: number, lang: Lang, text: string, pack: string | null, play = false): Promise<void> {
    const t = DICTS[lang].shop;
    const rows: { text: string; url?: string; web_app?: { url: string } }[][] = [];
    if (pack) rows.push([{ text: t.botPack, url: pack }]);
    // «Играть» — Mini App игры: новый стикер зовёт обратно
    if (play && this.d.site) rows.push([{ text: t.botPlay, web_app: { url: `${this.d.site}/?src=tg_sticker` } }]);
    try {
      await this.d.api('sendMessage', { chat_id: chat, text, ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    } catch (e) {
      // игрок не нажимал «Старт» — писать ему нельзя; пак всё равно в гардеробе
      this.d.log('warn', 'shop_notify', { err: String(e).slice(0, 200) });
    }
  }

  /** Выдать недостающие стикеры — по одному игроку за раз (повторный вызов ждёт идущий). */
  issue(id: number): Promise<void> {
    const prev = this.queue.get(id) ?? Promise.resolve();
    const run = prev.then(() => this.issueRun(id)).catch((e: unknown) => {
      const msg = String(e);
      this.failed.set(id, /PEER_ID_INVALID|user not found|USER_ID_INVALID|bot was blocked|chat not found/i.test(msg) ? 'need_bot' : 'telegram');
      this.d.log('warn', 'shop_issue', errFields(e));
    });
    this.queue.set(id, run);
    void run.finally(() => {
      if (this.queue.get(id) === run) this.queue.delete(id);
    });
    return run;
  }

  private async issueRun(id: number): Promise<void> {
    const u = await this.d.ledger.shopUser(id);
    if (!u) return;
    const missing = () => wantedStickers(u.items).filter((s) => !u.issued.includes(s.id));
    if (!missing().length) return;
    const bot = await this.d.username();
    const file = async (s: StickerMeta) => new Blob([await readFile(join(this.d.stickersDir, u.lang, `${s.id}.webm`))], { type: 'video/webm' });
    const input = (s: StickerMeta, i: number) => ({ sticker: `attach://f${i}`, format: 'video', emoji_list: s.emoji });
    const t = DICTS[u.lang].shop;
    // куда стикер: отдельный пак набора (own:) или свой пак
    const target = (s: StickerMeta) =>
      s.set !== 'starter' && u.items.includes(`own:${s.set}`)
        ? { name: ownPack(s.set, id, bot), made: u.items.includes(`made:${s.set}`), title: fmt(t.packTitleItem, { item: t.items[s.set].name, name: u.name }), mark: () => u.items.push(`made:${s.set}`) }
        : { name: `m${id}_by_${bot}`.slice(0, 64), made: !!u.pack, title: fmt(t.packTitle, { name: u.name }), mark: () => (u.pack = `m${id}_by_${bot}`.slice(0, 64)) };
    for (;;) {
      const left = missing();
      if (!left.length) break;
      const to = target(left[0]);
      const batch = left.filter((s) => target(s).name === to.name);
      if (!to.made) {
        const list = batch.slice(0, 50);
        const form = new FormData();
        form.set('user_id', String(id));
        form.set('name', to.name);
        form.set('title', `${to.title} · @${bot}`.slice(0, 64));
        form.set('stickers', JSON.stringify(list.map(input)));
        for (const [i, s] of list.entries()) form.set(`f${i}`, await file(s), `${s.id}.webm`);
        try {
          await this.call('createNewStickerSet', form);
          u.issued.push(...list.map((s) => s.id));
        } catch (e) {
          // пак уже есть (упали между созданием и записью) — дальше добавляем по одному
          if (!/already occupied/i.test(String(e))) throw e;
        }
        to.mark();
        await this.d.ledger.saveShopUser(u);
        continue;
      }
      const s = batch[0];
      const form = new FormData();
      form.set('user_id', String(id));
      form.set('name', to.name);
      form.set('sticker', JSON.stringify(input(s, 0)));
      form.set('f0', await file(s), `${s.id}.webm`);
      await this.call('addStickerToSet', form);
      u.issued.push(s.id);
      await this.d.ledger.saveShopUser(u);
    }
    this.failed.delete(id);
  }

  /** Вызов Telegram с ожиданием при «Too Many Requests: retry after N» (до трёх раз, не дольше 30 с). */
  private async call(method: string, form: FormData): Promise<void> {
    for (let k = 0; ; k++) {
      try {
        await this.d.api(method, form);
        return;
      } catch (e) {
        const m = /retry after (\d+)/i.exec(String(e));
        if (!m || k >= 2) throw e;
        await this.sleep(Math.min(30, Number(m[1])) * 1000);
      }
    }
  }
}
