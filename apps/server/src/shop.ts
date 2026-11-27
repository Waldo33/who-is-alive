import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DICTS, MY_FIGS, MY_ISSUED, MY_MARKS, MY_MAX, MY_POSE_EMOJI, SHOP_ITEMS, STICKER_LIST, canDrop, fmt, isMySticker, isSkin, isStickerId, myFigOpen, myIssued, offSticker, parseMySticker, shopItem, skinOf, wearItems } from '@kto/game-core';
import type { MySticker, StickerId, StickerMeta } from '@kto/game-core';
import { RateWindow } from './limits';
import { errFields } from './log';
import type { Logger } from './log';
import type { ShopPayment, ShopUser, Store, TgLink } from './store';

/**
 * Гардероб (за флагом shop в клиенте): наборы за звёзды Telegram и личный стикерпак игрока.
 *
 * Маршруты бота (https://api.<домен>/tg/...), тело — { initData } от Mini App (подпись проверяет бот):
 *   POST /shop        — что есть у игрока, ссылка на его пак; недовыданные стикеры досылаются;
 *   POST /shop/claim  — бесплатный пак с обычным актёром (после первого матча и подписки на канал);
 *   POST /shop/pack   — устарело (старые вкладки): просто состояние;
 *   POST /shop/buy    — { item } → ссылка на счёт в звёздах (WebApp.openInvoice);
 *   POST /shop/link   — { token } связать игрока игрового сервера (его токен) с этим пользователем Telegram:
 *                       по связи сервер после матча открывает стикеры за события матча (earn в game-core/shop.ts).
 * Стикеры за матч: игровой сервер считает, кому что открылось, и шлёт боту /internal/tg/stickers → `earn`
 * (только наборы, которые у игрока есть; новый стикер — сообщение «Новый стикер в паке»).
 * Вебхук: pre_checkout_query (проверка перед оплатой), message.successful_payment (набор — и его стикеры сразу
 * в пак), callback_query «free:claim» («Забрать стикерпак» / «Я подписался»), /start stickers (бесплатный пак по
 * внешней ссылке t.me/<бот>?start=stickers), /paysupport (обязателен для оплаты звёздами).
 * Возврат — только изнутри: POST /internal/tg/refund { charge }.
 *
 * Пак — один на игрока (`pack`, «Массовка · Имя · @бот»): бесплатные, «за игру» и купленные наборы; последней —
 * приманка «Собери свой пак!». Бот правит лишь паки, которые создал сам.
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
/** onLink — игрок сервера связан с Telegram (его скин теперь известен: server.ts обновит комнату). */
export function localLedger(store: Store, verify?: VerifyToken, onLink?: (gameUser: string) => void): ShopLedger {
  return {
    shopUser: (id) => store.shopUser(id),
    saveShopUser: (u) => store.saveShopUser(u),
    saveShopPayment: (p) => store.saveShopPayment(p),
    refundShopPayment: (c) => store.refundShopPayment(c),
    async linkGame(token, link) {
      const gameUser = verify ? await verify(token) : null;
      if (!gameUser) return false;
      await store.linkTelegram({ gameUser, ...link });
      onLink?.(gameUser);
      return true;
    },
  };
}

/** Токен игрока: JWT (три части base64url), не длиннее 1 КБ. */
const TOKEN = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,512}$/;

const ITEM = /^(?:starter|(?:st|in|own|made|off|wear):[A-Za-z]{1,24}|[A-Za-z]{1,24})$/;
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
  if (!strs(u.items, 120, ITEM) || !Array.isArray(u.issued) || u.issued.length > 120 || !u.issued.every((x) => isStickerId(x) || (typeof x === 'string' && MY_ISSUED.test(x)))) return null;
  if (u.pack !== null && !(typeof u.pack === 'string' && PACK.test(u.pack))) return null;
  // свои стикеры: старый бот их не присылает — оставляем как есть (undefined), новый — проверяем каждый
  const my = u.my === undefined ? undefined : Array.isArray(u.my) && u.my.length <= MY_MAX && u.my.every(isMySticker) && new Set(u.my.map((m) => m.slot)).size === u.my.length ? u.my.map((m) => ({ ...m, text: [...m.text] })) : null;
  if (my === null) return null;
  return { userId: u.userId, lang: u.lang, name: u.name, items: [...u.items], pack: u.pack, issued: [...u.issued], ...(my ? { my } : {}) };
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
 * Стикеры, которые открыты игроку: стартовый пак, «сразу» у наборов и открытые наградами (`st:<id>`) —
 * если игрок захотел пак (`pack`). Что из них в паке — решает сам игрок (`wantedStickers`).
 */
export function openStickers(items: string[]): StickerMeta[] {
  const has = new Set(items);
  if (!has.has('pack')) return [];
  return STICKER_LIST.filter((s) =>
    // приманка — в любом паке; стартовый — когда забран бесплатный пак; «за игру» — с ним же, когда открыт в матче
    s.lure
      ? true
      : s.set === 'starter'
        ? has.has('starter')
        : s.set === 'play'
          ? has.has('starter') && has.has(`st:${s.id}`)
          : has.has(s.set) && (s.now || has.has(`st:${s.id}`)),
  );
}

/** Стикеры, которые должны быть в паке: открытые, кроме убранных игроком на странице «Собери свой стикерпак». */
export function wantedStickers(items: string[]): StickerMeta[] {
  return openStickers(items).filter((s) => !items.includes(offSticker(s.id)));
}

/** Первое эмодзи без «варианта отображения» (U+FE0F): Telegram может вернуть его и так, и так. */
const em = (s: string | undefined) => (s ?? '').replace(/\uFE0F/g, '');

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

/** Что положить в пак: стандартный стикер (файл) или свой (рисует сервер). `key` — запись в `issued`. */
interface Entry {
  key: string;
  emoji: string[];
  lure?: boolean;
  my?: MySticker;
}

/** Что боту сделать с паком игрока, чтобы он совпал с выбором. */
export function syncPlan(u: ShopUser): { add: Entry[]; drop: { key: string; emoji: string }[]; replace: { e: Entry; old: string }[]; total: number } {
  const want = wantedStickers(u.items);
  const my = u.items.includes('pack') ? (u.my ?? []) : [];
  const mine = (m: MySticker): Entry => ({ key: myIssued(m), emoji: [MY_MARKS[m.slot], MY_POSE_EMOJI[m.pose]], my: m });
  const slotOf = (x: string) => Number(MY_ISSUED.exec(x)?.[1] ?? -1);
  const add: Entry[] = [
    ...want.filter((s) => !u.issued.includes(s.id)).map((s) => ({ key: s.id, emoji: s.emoji, lure: s.lure })),
    ...my.filter((m) => !u.issued.some((x) => slotOf(x) === m.slot)).map(mine),
  ];
  // убранные игроком стандартные (возврат звёзд стикеры не забирает) и удалённые свои
  const drop = [
    ...u.issued.filter((x) => isStickerId(x) && u.items.includes(offSticker(x as StickerId))).map((x) => ({ key: x, emoji: STICKER_LIST.find((s) => s.id === x)!.emoji[0] })),
    ...u.issued.filter((x) => MY_ISSUED.test(x) && !my.some((m) => m.slot === slotOf(x))).map((x) => ({ key: x, emoji: MY_MARKS[slotOf(x)] })),
  ];
  const replace = my.flatMap((m) => {
    const old = u.issued.find((x) => slotOf(x) === m.slot);
    return old && old !== myIssued(m) ? [{ e: mine(m), old }] : [];
  });
  // «положено в пак» для полосы прогресса: стандартные по выбору и свои
  return { add, drop, replace, total: want.length + my.length };
}
const total = (p: ReturnType<typeof syncPlan>) => p.add.length + p.drop.length + p.replace.length;

/** Простой вызов Telegram формой (call() ждёт FormData). */
function jsonForm(o: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
}

export interface ShopDeps {
  api<R = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<R>;
  username(): Promise<string>;
  ledger: ShopLedger;
  log: Logger;
  /** Папка с видеостикерами: <язык>/<id>.webm. */
  stickersDir: string;
  /** Канал игры (кнопка «Подписаться» за бесплатный пак). */
  channel: string;
  /** Адрес игры (кнопка «Играть» в сообщении о новом стикере). */
  site?: string;
  /** Канал игры для проверки подписки (getChatMember; бот должен быть админом канала): «@имя». */
  channelId?: string;
  /** Нарисовать свой стикер (WEBM): игровой сервер — у себя, сервер бота — по туннелю (/internal/sticker). */
  drawMy?: (look: Pick<MySticker, 'fig' | 'pose' | 'color' | 'text'>) => Promise<Buffer>;
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
/** Оплата в звёздах из getStarTransactions: source — от кого (покупка), receiver — кому (возврат, тот же id). */
interface StarTx {
  id: string;
  amount: number;
  date: number;
  source?: { type: string; user?: { id: number }; invoice_payload?: string };
  receiver?: { type: string; user?: { id: number } };
}
const langOf = (code?: string): Lang => (code && /^(ru|uk|be|kk)/.test(code) ? 'ru' : 'en');

export class Shop {
  private readonly queue = new Map<number, Promise<void>>();
  /** Почему не вышло выдать (покажет гардероб): need_bot — игрок не открыл бота. */
  private readonly failed = new Map<number, string>();
  private readonly rate = new RateWindow(20, 60_000);
  /** Свои стикеры рисует сервер — не чаще 12 правок в час на игрока. */
  private readonly myRate = new RateWindow(12, 3_600_000);
  private readonly sleep: (ms: number) => Promise<void>;
  /** Сверка оплат с Telegram: когда игрока сверяли последний раз; список оплат бота — общий на 15 с. */
  private readonly synced = new Map<number, number>();
  private txCache: { at: number; list: Promise<StarTx[]> } | null = null;

  constructor(private readonly d: ShopDeps) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Маршрут /tg/shop… с проверенным initData. */
  async route(path: string, init: ShopInit, body: { item?: unknown; mode?: unknown; token?: unknown; id?: unknown; on?: unknown; slot?: unknown; sticker?: unknown }): Promise<ShopReply> {
    const id = init.user.id;
    const now = (this.d.now ?? Date.now)();
    if (!this.rate.take(String(id), now)) return { status: 429, body: { error: 'rate_limited' } };
    this.rate.sweep(now);
    if (path === '/shop') {
      await this.reconcile(init.user, now);
      return { status: 200, body: await this.state(id, true) };
    }
    if (path === '/shop/claim') return { status: 200, body: await this.claim(init.user) };
    // старые вкладки гардероба («В мой пак» / «Новый пак»): пак теперь один и наполняется сам — просто состояние
    if (path === '/shop/pack') return { status: 200, body: await this.state(id, true) };
    if (path === '/shop/buy') return this.buy(init, body.item);
    if (path === '/shop/link') return this.link(init.user, body.token);
    if (path === '/shop/wear') return this.wear(id, body.item);
    if (path === '/shop/pick') return this.pick(id, body.id, body.on);
    if (path === '/shop/my') return this.saveMy(id, body.slot, body.sticker, now);
    if (path === '/shop/my/del') return this.delMy(id, body.slot);
    return { status: 404, body: { error: 'not_found' } };
  }

  private async state(id: number, kick: boolean) {
    const u = await this.d.ledger.shopUser(id);
    const plan = u ? syncPlan(u) : null;
    const pending = plan ? plan.add.length + plan.drop.length + plan.replace.length : 0;
    // недовыданное и неубранное (сбой Telegram, перезапуск) — дослать в фоне
    if (kick && pending && !this.queue.has(id)) void this.issue(id);
    const open = u ? openStickers(u.items) : [];
    // бесплатный пак ещё не забран — шаги для экрана-замка: сыгран ли матч, есть ли подписка на канал
    const free = u?.items.includes('starter') ? undefined : { played: !!u?.items.includes('played'), sub: await this.subscribed(id), channel: this.d.channel };
    return {
      items: (u?.items ?? []).filter((i) => i === 'starter' || i === 'pack' || shopItem(i)),
      pack: u?.pack ? `https://t.me/addstickers/${u.pack}` : null,
      /** Отдельных паков больше нет (один пак на игрока); поле — для старых вкладок гардероба. */
      packs: {} as Record<string, string>,
      issued: plan ? plan.total - plan.add.length : 0,
      wanted: plan?.total ?? 0,
      error: this.failed.get(id) ?? null,
      catalog: SHOP_ITEMS,
      /** Надетый скин (null — снят или не куплен). */
      worn: (u && skinOf(u.items)) ?? null,
      // «Собери свой стикерпак»: что открыто, что убрано, свои стикеры, открытые фигурки, сколько ещё делать боту
      open: open.map((s) => s.id),
      off: open.filter((s) => u?.items.includes(offSticker(s.id))).map((s) => s.id),
      my: u?.my ?? [],
      figs: MY_FIGS.filter((f) => myFigOpen(f.id, u?.items ?? [])).map((f) => f.id),
      earned: (u?.items ?? []).filter((i) => i.startsWith('st:')).map((i) => i.slice(3)),
      pending,
      free,
    };
  }

  /** Убрать стикер из пака или вернуть (только открытые; приманку — нельзя). */
  private async pick(id: number, sticker: unknown, on: unknown): Promise<ShopReply> {
    if (!isStickerId(sticker) || typeof on !== 'boolean' || !canDrop(sticker)) return { status: 400, body: { error: 'bad' } };
    const err = await this.edit(id, (u) => {
      if (!openStickers(u.items).some((s) => s.id === sticker)) return 'locked';
      const off = offSticker(sticker);
      u.items = u.items.filter((i) => i !== off);
      if (!on) u.items.push(off);
      return null;
    });
    if (err) return { status: 409, body: { error: err } };
    return { status: 200, body: await this.state(id, true) };
  }

  /** Свой стикер: новый (slot нет) или правка (slot есть) — проверяет и сохраняет, рисует и кладёт бот в очереди. */
  private async saveMy(id: number, slotRaw: unknown, raw: unknown, now: number): Promise<ShopReply> {
    const u0 = await this.d.ledger.shopUser(id);
    if (!u0?.items.includes('pack')) return { status: 409, body: { error: 'need_pack' } };
    const v = parseMySticker(raw, u0.items);
    if ('error' in v) return { status: 400, body: { error: v.error } };
    if (slotRaw !== undefined && slotRaw !== null && !(Number.isInteger(slotRaw) && (slotRaw as number) >= 0 && (slotRaw as number) < MY_MAX)) return { status: 400, body: { error: 'bad' } };
    if (!this.myRate.take(String(id), now)) return { status: 429, body: { error: 'rate' } };
    this.myRate.sweep(now);
    const err = await this.edit(id, (u) => {
      const my = (u.my ??= []);
      const slot = typeof slotRaw === 'number' ? slotRaw : [...Array(MY_MAX).keys()].find((i) => !my.some((m) => m.slot === i));
      if (slot === undefined) return 'full';
      const old = my.find((m) => m.slot === slot);
      if (old && old.fig === v.fig && old.pose === v.pose && old.color === v.color && old.text.join('\n') === v.text.join('\n')) return null;
      const next: MySticker = { slot, ...v, rev: (old?.rev ?? 0) + 1 };
      u.my = [...my.filter((m) => m.slot !== slot), next].sort((a, b) => a.slot - b.slot);
      return null;
    });
    if (err) return { status: 409, body: { error: err } };
    this.d.log('info', 'shop_my_saved', { fig: v.fig, pose: v.pose });
    return { status: 200, body: await this.state(id, true) };
  }

  private async delMy(id: number, slot: unknown): Promise<ShopReply> {
    if (!Number.isInteger(slot)) return { status: 400, body: { error: 'bad' } };
    await this.edit(id, (u) => {
      u.my = (u.my ?? []).filter((m) => m.slot !== slot);
      return null;
    });
    return { status: 200, body: await this.state(id, true) };
  }

  /** Правка учёта игрока в его очереди (не перетрётся выдачей, которая идёт прямо сейчас). */
  private edit(id: number, f: (u: ShopUser) => string | null): Promise<string | null> {
    const prev = this.queue.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const u = await this.d.ledger.shopUser(id);
      if (!u) return 'need_pack';
      const err = f(u);
      if (!err) await this.d.ledger.saveShopUser(u);
      return err;
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queue.set(id, tail);
    void tail.finally(() => {
      if (this.queue.get(id) === tail) this.queue.delete(id);
    });
    return run.catch((e: unknown) => {
      this.d.log('warn', 'shop_edit', errFields(e));
      return 'bad';
    });
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
    if (st.issued > before && st.pack) await this.notify(u.userId, u.lang, text(u.lang), st.pack);
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
          (s) => x.stickers.includes(s.id) && !s.now && (s.set === 'starter' || s.set === 'play' || u.items.includes(s.set)) && !u.items.includes(`st:${s.id}`),
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
        await this.notify(id, after.lang, text, st.pack, true);
      })
      .catch((e: unknown) => this.d.log('warn', 'shop_earn', errFields(e)));
    this.queue.set(id, run);
    void run.finally(() => {
      if (this.queue.get(id) === run) this.queue.delete(id);
    });
    return run;
  }

  /**
   * После первого матча (писать можно, если игрок открывал бота): подписан — «Забрать стикерпак»,
   * нет — сначала «Подписаться на канал» и «Я подписался».
   */
  private async offerFree(u: ShopUser): Promise<void> {
    const t = DICTS[u.lang].shop;
    try {
      if (!(await this.subscribed(u.userId))) return await this.askSub(u.userId, u.lang);
      await this.d.api('sendMessage', { chat_id: u.userId, text: t.botFreeOffer, reply_markup: { inline_keyboard: [[{ text: t.botFreeClaim, callback_data: 'free:claim' }]] } });
    } catch (e) {
      this.d.log('warn', 'shop_notify', { err: String(e).slice(0, 200) });
    }
  }

  /** Бесплатный пак с обычным актёром: из гардероба на главной или по внешней ссылке (/start stickers). */
  async claim(from: ShopInit['user']) {
    const u = await this.d.ledger.shopUser(from.id);
    // бесплатный пак — за сыгранный матч (сервер видел игрока в матче, `played`) и подписку на канал
    if (!u?.items.includes('starter')) {
      const miss = !u?.items.includes('played') ? 'need_match' : !(await this.subscribed(from.id)) ? 'need_sub' : null;
      if (miss) return { ...(await this.state(from.id, false)), error: miss, channel: this.d.channel };
    }
    return this.grant(from, ['starter', 'pack'], (l) => DICTS[l].shop.botFree);
  }

  /** Бесплатный пак по ссылке /start stickers: нет матча — «Играть», нет подписки — «Подписаться» и «Я подписался». */
  async claimInChat(from: ShopInit['user']): Promise<void> {
    const st = await this.claim(from);
    const lang = langOf(from.language_code);
    if (st.error === 'need_sub') await this.askSub(from.id, lang);
    else if (st.error === 'need_match') {
      const t = DICTS[lang].shop;
      await this.d.api('sendMessage', { chat_id: from.id, text: t.botNeedMatch, ...(this.d.site ? { reply_markup: { inline_keyboard: [[{ text: t.botPlay, web_app: { url: `${this.d.site}/?src=tg_sticker` } }]] } } : {}) });
    }
  }

  private async askSub(chat: number, lang: Lang): Promise<void> {
    const t = DICTS[lang].shop;
    await this.d.api('sendMessage', {
      chat_id: chat,
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

  /** Кнопки бота: «Забрать стикерпак» / «Я подписался» (free:claim); старые «pk:…» — просто ответить. */
  async onCallback(q: { id: string; from: ShopInit['user']; data?: string }): Promise<void> {
    // «Забрать стикерпак» (после первого матча) и «Я подписался» (по ссылке)
    if (q.data === 'free:claim') {
      const r = this.claim(q.from);
      const first = await Promise.race([r, new Promise<null>((ok) => setTimeout(() => ok(null), 1500))]);
      const t = DICTS[langOf(q.from.language_code)].shop;
      const no = first?.error === 'need_sub' ? t.botNoSub : first?.error === 'need_match' ? t.botNeedMatch : '';
      await this.d.api('answerCallbackQuery', no ? { callback_query_id: q.id, text: no, show_alert: true } : { callback_query_id: q.id });
      await r;
      return;
    }
    if (q.data?.startsWith('pk:')) await this.d.api('answerCallbackQuery', { callback_query_id: q.id });
  }

  /** «Надеть» (купленный скин) или «Снять» (item: null). В комнате — со следующего входа. */
  private async wear(id: number, raw: unknown): Promise<ShopReply> {
    if (raw !== null && !isSkin(raw)) return { status: 400, body: { error: 'bad_item' } };
    const u = await this.d.ledger.shopUser(id);
    if (!u || (raw !== null && !u.items.includes(raw))) return { status: 403, body: { error: 'not_owned' } };
    u.items = wearItems(u.items, raw);
    await this.d.ledger.saveShopUser(u);
    return { status: 200, body: await this.state(id, false) };
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

  /** Все оплаты бота в звёздах (getStarTransactions, по 100 в хронологическом порядке); на 15 с — из кэша. */
  private starTransactions(now: number): Promise<StarTx[]> {
    if (this.txCache && now - this.txCache.at < 15_000) return this.txCache.list;
    const list = (async () => {
      const all: StarTx[] = [];
      for (let offset = 0; offset < 20_000; offset += 100) {
        const r = await this.d.api<{ transactions?: StarTx[] }>('getStarTransactions', { offset, limit: 100 });
        const page = r?.transactions ?? [];
        all.push(...page);
        if (page.length < 100) break;
      }
      return all;
    })();
    this.txCache = { at: now, list };
    list.catch(() => (this.txCache = null));
    return list;
  }

  /**
   * Сверка с Telegram: оплата есть, а набора у игрока нет (уведомление об оплате потерялось — бот перезапускался,
   * учёт был недоступен) — записать и выдать, как при обычной оплате. Возвращённые оплаты (у них в Telegram
   * есть встречная транзакция с тем же id) пропускаем. Не чаще раза в 30 с на игрока; сбой — тихо, в журнал.
   */
  private async reconcile(user: ShopInit['user'], now: number): Promise<void> {
    if (now - (this.synced.get(user.id) ?? -Infinity) < 30_000) return;
    if (this.synced.size > 5000) this.synced.clear();
    this.synced.set(user.id, now);
    try {
      const txs = await this.starTransactions(now);
      const refunded = new Set(txs.filter((t) => t.receiver?.type === 'user').map((t) => t.id));
      for (const t of txs) {
        const src = t.source;
        if (src?.type !== 'user' || src.user?.id !== user.id || refunded.has(t.id) || !CHARGE.test(t.id)) continue;
        const p = this.payload(src.invoice_payload);
        if (!p || p.userId !== user.id) continue;
        const u = await this.d.ledger.shopUser(user.id);
        if (u?.items.includes(p.item.id)) continue;
        this.d.log('warn', 'shop_reconciled', { item: p.item.id, stars: t.amount });
        await this.paid({ from: user, successful_payment: { currency: 'XTR', total_amount: t.amount, invoice_payload: src.invoice_payload!, telegram_payment_charge_id: t.id } });
      }
    } catch (e) {
      this.d.log('warn', 'shop_reconcile', errFields(e));
    }
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
    // набор и пак (один на игрока: «Массовка · Имя»; нет — создастся) — записать до выдачи
    const add = [p.item.id, 'pack'].filter((i) => !u.items.includes(i));
    if (add.length) {
      u.items.push(...add);
      // купленный скин сразу надет (даже если раньше был «Снять»): без отметки надет последний купленный
      if (isSkin(p.item.id) && add.includes(p.item.id)) u.items = u.items.filter((x) => !x.startsWith('wear:'));
      await this.d.ledger.saveShopUser(u);
    }
    if (!fresh) return;
    this.d.log('info', 'shop_paid', { item: p.item.id, stars: sp.total_amount });
    // стикеры набора — сразу в пак; сбой Telegram — дошлётся при заходе в гардероб; сообщение — со ссылкой на пак
    await this.issue(u.userId);
    const st = await this.state(u.userId, false);
    await this.notify(u.userId, u.lang, DICTS[u.lang].shop.botBought, st.pack);
  }

  /**
   * Возврат звёзд (изнутри машины: /internal/tg/refund, кнопка shop-refund.yml). Набор забираем: скин пропадает
   * (и с «Надеть»), стикеры набора удаляются из пака игрока. Открытые в матчах (`st:<id>`) помним — при новой
   * покупке они вернутся в пак.
   */
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
    let removed = 0;
    if (u) {
      u.items = u.items.filter((i) => i !== p.item && i !== `wear:${p.item}`);
      await this.d.ledger.saveShopUser(u);
      removed = await this.dropStickers(u, p.item);
    }
    this.d.log('info', 'shop_refunded', { item: p.item, stars: p.stars, removed });
    return { status: 200, body: { ok: true, item: p.item, stars: p.stars, removed } };
  }

  /**
   * Убрать из пака стикеры набора: стикер пака узнаём по первому эмодзи (у каждого стикера своё). Пак не может
   * опустеть — приманка остаётся. Не вышло (сбой Telegram) — стикер остаётся выданным, ошибка — в журнал.
   */
  private async dropStickers(u: ShopUser, item: string): Promise<number> {
    const mine = STICKER_LIST.filter((s) => s.set === item && u.issued.includes(s.id));
    if (!mine.length || !u.pack) return 0;
    const bare = (e: string | undefined) => (e ?? '').replace(/\uFE0F/g, '');
    let n = 0;
    try {
      const set = await this.d.api<{ stickers?: { file_id: string; emoji?: string }[] }>('getStickerSet', { name: u.pack });
      for (const s of mine) {
        const st = set?.stickers?.find((x) => bare(x.emoji) === bare(s.emoji[0]));
        if (st) await this.d.api('deleteStickerFromSet', { sticker: st.file_id });
        u.issued = u.issued.filter((id) => id !== s.id);
        n++;
      }
    } catch (e) {
      this.d.log('error', 'shop_refund_stickers', errFields(e));
    }
    await this.d.ledger.saveShopUser(u);
    return n;
  }

  /** /paysupport: игроку — «запрос передан» (sent) или подсказка написать, что случилось; номер покупателя — в обоих. */
  async support(chat: number, code: string | undefined, sent: boolean): Promise<void> {
    const t = DICTS[langOf(code)].shop;
    await this.d.api('sendMessage', { chat_id: chat, text: fmt(sent ? t.botSupportSent : t.botSupport, { id: chat }) });
  }

  /** Что куплено (наборы, без стикеров и меток) — для запроса в поддержку. */
  async itemsOf(id: number): Promise<string[]> {
    const u = await this.d.ledger.shopUser(id);
    return (u?.items ?? []).filter((i) => !!shopItem(i));
  }

  private async notify(chat: number, lang: Lang, text: string, pack: string | null, play = false): Promise<void> {
    const t = DICTS[lang].shop;
    const rows: { text: string; url?: string; web_app?: { url: string } }[][] = [];
    if (pack) rows.push([{ text: t.botPack, url: pack }]);
    // «Собери свой стикерпак» — страница в Mini App (пока за флагом shop: ссылка включает его у игрока)
    if (pack && this.d.site) rows.push([{ text: t.botBuild, web_app: { url: `${this.d.site}/stickers?src=tg_sticker` } }]);
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

  /**
   * Привести пак к выбору игрока: убрать убранное, заменить изменённые свои стикеры на месте, добавить
   * недостающее (стандартные — файлы WEBM, свои — рисует `drawMy`). Стикер в паке находим по первому эмодзи
   * (у каждого своё: game-core/test/my-stickers.test.ts).
   */
  private async issueRun(id: number): Promise<void> {
    const u = await this.d.ledger.shopUser(id);
    if (!u) return;
    if (!total(syncPlan(u))) return;
    const bot = await this.d.username();
    const t = DICTS[u.lang].shop;
    // один пак на игрока: «Массовка · Имя · @бот» — бесплатные, «за игру», купленные наборы и свои
    const name = `m${id}_by_${bot}`.slice(0, 64);
    const title = fmt(t.packTitle, { name: u.name });
    const blob = async (e: Entry) => new Blob([new Uint8Array(e.my ? await this.drawMy(e.my) : await readFile(join(this.d.stickersDir, u.lang, `${e.key}.webm`)))], { type: 'video/webm' });
    const input = (e: Entry, i: number) => ({ sticker: `attach://f${i}`, format: 'video', emoji_list: e.emoji });
    let changed = false;

    // убрать и заменить — нужен список стикеров пака (file_id по первому эмодзи)
    const first = syncPlan(u);
    if (u.pack && (first.drop.length || first.replace.length)) {
      const set = await this.d.api<{ stickers?: { file_id: string; emoji?: string }[] }>('getStickerSet', { name: u.pack });
      const byEmoji = new Map((set?.stickers ?? []).map((x) => [em(x.emoji), x.file_id]));
      for (const d of first.drop) {
        const fid = byEmoji.get(em(d.emoji));
        if (fid) await this.call('deleteStickerFromSet', jsonForm({ sticker: fid }));
        u.issued = u.issued.filter((x) => x !== d.key);
        await this.d.ledger.saveShopUser(u);
        changed = true;
      }
      for (const r of first.replace) {
        const fid = byEmoji.get(em(r.e.emoji[0]));
        u.issued = u.issued.filter((x) => x !== r.old);
        if (fid) {
          const form = new FormData();
          form.set('user_id', String(id));
          form.set('name', u.pack);
          form.set('old_sticker', fid);
          form.set('sticker', JSON.stringify(input(r.e, 0)));
          form.set('f0', await blob(r.e), `${r.e.key}.webm`);
          await this.call('replaceStickerInSet', form);
          u.issued.push(r.e.key);
        }
        // не нашли в паке (убрали руками в Telegram) — добавится ниже как новый
        await this.d.ledger.saveShopUser(u);
        changed = true;
      }
    }

    for (;;) {
      const left = syncPlan(u).add;
      if (!left.length) break;
      if (!u.pack) {
        // приманка — последней и при создании
        const list = [...left.filter((e) => !e.lure), ...left.filter((e) => e.lure)].slice(-50);
        const form = new FormData();
        form.set('user_id', String(id));
        form.set('name', name);
        form.set('title', `${title} · @${bot}`.slice(0, 64));
        form.set('stickers', JSON.stringify(list.map(input)));
        for (const [i, e] of list.entries()) form.set(`f${i}`, await blob(e), `${e.key}.webm`);
        try {
          await this.call('createNewStickerSet', form);
          u.issued.push(...list.map((e) => e.key));
        } catch (e) {
          // пак уже есть (упали между созданием и записью) — дальше добавляем по одному
          if (!/already occupied/i.test(String(e))) throw e;
        }
        u.pack = name;
        await this.d.ledger.saveShopUser(u);
        continue;
      }
      const e = left[0];
      const form = new FormData();
      form.set('user_id', String(id));
      form.set('name', u.pack);
      form.set('sticker', JSON.stringify(input(e, 0)));
      form.set('f0', await blob(e), `${e.key}.webm`);
      await this.call('addStickerToSet', form);
      u.issued.push(e.key);
      await this.d.ledger.saveShopUser(u);
      changed = true;
    }
    // приманка «Собери свой пак» — снова в конец пака
    if (changed && u.pack) await this.lureLast(u.pack);
    this.failed.delete(id);
  }

  private async drawMy(m: MySticker): Promise<Buffer> {
    if (!this.d.drawMy) throw new Error('no_sticker_renderer');
    return this.d.drawMy({ fig: m.fig, pose: m.pose, color: m.color, text: m.text });
  }

  /** Приманка (первое эмодзи 🎬 есть только у неё) — последним стикером пака. Не вышло — не страшно. */
  private async lureLast(name: string): Promise<void> {
    const lure = STICKER_LIST.find((s) => s.lure);
    if (!lure) return;
    try {
      const set = await this.d.api<{ stickers?: { file_id: string; emoji?: string }[] }>('getStickerSet', { name });
      const list = set?.stickers ?? [];
      const at = list.findIndex((s) => s.emoji === lure.emoji[0]);
      if (at >= 0 && at !== list.length - 1) await this.d.api('setStickerPositionInSet', { sticker: list[at].file_id, position: list.length - 1 });
    } catch (e) {
      this.d.log('warn', 'shop_lure', { err: String(e).slice(0, 200) });
    }
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
