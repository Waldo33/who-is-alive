import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DICTS, SHOP_ITEMS, STICKER_LIST, fmt, isStickerId, shopItem } from '@kto/game-core';
import type { StickerMeta } from '@kto/game-core';
import { RateWindow } from './limits';
import { errFields } from './log';
import type { Logger } from './log';
import type { ShopPayment, ShopUser, Store } from './store';

/**
 * Гардероб (за флагом shop в клиенте): наборы за звёзды Telegram и личный стикерпак игрока.
 *
 * Маршруты бота (https://api.<домен>/tg/...), тело — { initData } от Mini App (подпись проверяет бот):
 *   POST /shop        — что есть у игрока, ссылка на его пак; недовыданные стикеры досылаются;
 *   POST /shop/claim  — бесплатный пак с обычным актёром (клиент зовёт после первого матча);
 *   POST /shop/buy    — { item } → ссылка на счёт в звёздах (WebApp.openInvoice).
 * Вебхук: pre_checkout_query (проверка перед оплатой), message.successful_payment (выдать набор),
 * /paysupport (обязателен для оплаты звёздами). Возврат — только изнутри: POST /internal/tg/refund { charge }.
 *
 * Пак — один на игрока: «Массовка · Имя · @бот», стикеры — видео WEBM из apps/server/stickers
 * (`pnpm --filter web stickers`). Выдача — очередью по игроку: что выдано, записано в учёте; упало — дошлётся
 * при следующем заходе в гардероб.
 *
 * Учёт: у игрового сервера — его Postgres; у сервера бота базы нет — RemoteLedger, по туннелю к игровому.
 */

export type ShopLedger = Pick<Store, 'shopUser' | 'saveShopUser' | 'saveShopPayment' | 'refundShopPayment'>;

const ITEM = /^(?:starter|st:[A-Za-z]{1,24}|[A-Za-z]{1,24})$/;
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
  const b = raw as { op?: unknown; userId?: unknown; user?: unknown; payment?: unknown; charge?: unknown } | null;
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
  if (b?.op === 'refund') return typeof b.charge === 'string' && CHARGE.test(b.charge) ? { status: 200, body: { result: await store.refundShopPayment(b.charge) } } : bad;
  return bad;
}

/** Стикеры, которые положены игроку: стартовый пак, «сразу» у наборов и открытые наградами (`st:<id>`). */
export function wantedStickers(items: string[]): StickerMeta[] {
  const has = new Set(items);
  return STICKER_LIST.filter((s) => (s.set === 'starter' ? has.has('starter') : has.has(s.set) && (s.now || has.has(`st:${s.id}`))));
}

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
  async route(path: string, init: ShopInit, body: { item?: unknown }): Promise<ShopReply> {
    const id = init.user.id;
    const now = (this.d.now ?? Date.now)();
    if (!this.rate.take(String(id), now)) return { status: 429, body: { error: 'rate_limited' } };
    this.rate.sweep(now);
    if (path === '/shop') return { status: 200, body: await this.state(id, true) };
    if (path === '/shop/claim') return this.claim(init);
    if (path === '/shop/buy') return this.buy(init, body.item);
    return { status: 404, body: { error: 'not_found' } };
  }

  private async state(id: number, kick: boolean) {
    const u = await this.d.ledger.shopUser(id);
    const want = u ? wantedStickers(u.items) : [];
    const missing = u ? want.filter((s) => !u.issued.includes(s.id)).length : 0;
    // недовыданное (сбой Telegram, перезапуск) — дослать в фоне
    if (kick && missing && !this.queue.has(id)) void this.issue(id);
    return {
      items: (u?.items ?? []).filter((i) => i === 'starter' || shopItem(i)),
      pack: u?.pack ? `https://t.me/addstickers/${u.pack}` : null,
      issued: u?.issued.length ?? 0,
      wanted: want.length,
      error: this.failed.get(id) ?? null,
      catalog: SHOP_ITEMS,
    };
  }

  private async user(init: ShopInit): Promise<ShopUser> {
    const id = init.user.id;
    return (
      (await this.d.ledger.shopUser(id)) ?? {
        userId: id,
        lang: langOf(init.user.language_code),
        name: packName(init.user.first_name) || packName(init.user.username) || 'Актёр',
        items: [],
        pack: null,
        issued: [],
      }
    );
  }

  private async claim(init: ShopInit): Promise<ShopReply> {
    const u = await this.user(init);
    if (!u.items.includes('starter')) {
      u.items.push('starter');
      await this.d.ledger.saveShopUser(u);
    }
    const before = u.issued.length;
    await this.issue(u.userId);
    const st = await this.state(u.userId, false);
    // первый раз пак собран — сообщение в личку с кнопкой (игрок мог закрыть Mini App)
    if (!before && st.issued && st.pack) await this.notify(u.userId, u.lang, DICTS[u.lang].shop.botFree, st.pack);
    return { status: 200, body: st };
  }

  private async buy(init: ShopInit, raw: unknown): Promise<ShopReply> {
    const item = shopItem(raw);
    if (!item) return { status: 400, body: { error: 'bad_item' } };
    const u = await this.user(init);
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
    const u = await this.user({ user: from });
    if (!u.items.includes(p.item.id)) {
      u.items.push(p.item.id);
      await this.d.ledger.saveShopUser(u);
    }
    if (!fresh) return;
    this.d.log('info', 'shop_paid', { item: p.item.id, stars: sp.total_amount });
    await this.issue(u.userId);
    const after = await this.d.ledger.shopUser(u.userId);
    await this.notify(u.userId, u.lang, DICTS[u.lang].shop.botBought, after?.pack ? `https://t.me/addstickers/${after.pack}` : null);
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

  private async notify(chat: number, lang: Lang, text: string, pack: string | null): Promise<void> {
    const t = DICTS[lang].shop;
    try {
      await this.d.api('sendMessage', { chat_id: chat, text, ...(pack ? { reply_markup: { inline_keyboard: [[{ text: t.botPack, url: pack }]] } } : {}) });
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
    if (!u.pack) {
      const name = `m${id}_by_${bot}`.slice(0, 64);
      const list = missing().slice(0, 50);
      const form = new FormData();
      form.set('user_id', String(id));
      form.set('name', name);
      form.set('title', `${fmt(DICTS[u.lang].shop.packTitle, { name: u.name })} · @${bot}`.slice(0, 64));
      form.set('stickers', JSON.stringify(list.map(input)));
      for (const [i, s] of list.entries()) form.set(`f${i}`, await file(s), `${s.id}.webm`);
      try {
        await this.call('createNewStickerSet', form);
        u.issued.push(...list.map((s) => s.id));
      } catch (e) {
        // пак уже есть (упали между созданием и записью) — дальше добавляем по одному
        if (!/already occupied/i.test(String(e))) throw e;
      }
      u.pack = name;
      await this.d.ledger.saveShopUser(u);
    }
    for (const s of missing()) {
      const form = new FormData();
      form.set('user_id', String(id));
      form.set('name', u.pack);
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
