import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Bot } from '../src/bot';
import { silentLogger } from '../src/log';
import { GameServer } from '../src/server';
import { RemoteLedger, localLedger, packName, shopLedgerOp, wantedStickers } from '../src/shop';
import { MemoryStore } from '../src/store';
import { skinOf } from '@kto/game-core';

/** Гардероб: бесплатный пак, покупка за звёзды, выдача стикеров в личный пак (shop.ts). */

const TOKEN = '123456:TEST-token';
const STICKERS = join(import.meta.dirname, '..', 'stickers');

function initData(user: object, auth = Math.floor(Date.now() / 1000)): string {
  const p = new URLSearchParams({ auth_date: String(auth), user: JSON.stringify(user) });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

/** Данные входа через Telegram на сайте (Login Widget), подписанные как в Telegram. */
function webLogin(user: { id: number; first_name?: string; username?: string }, auth = Math.floor(Date.now() / 1000)): Record<string, string | number> {
  const d: Record<string, string | number> = { ...user, auth_date: auth };
  const check = Object.entries(d).map(([k, v]) => `${k}=${v}`).sort().join('\n');
  d.hash = createHmac('sha256', createHash('sha256').update(TOKEN).digest()).update(check).digest('hex');
  return d;
}

interface Call {
  method: string;
  body: Record<string, unknown>;
  files: string[];
}

function makeBot(opts: { result?: (method: string) => unknown; fail?: (method: string) => string | null; store?: MemoryStore; ledger?: ConstructorParameters<typeof Bot>[0]['shopLedger']; drawMy?: ConstructorParameters<typeof Bot>[0]['drawMy'] } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: { body: string | FormData }) => {
    const method = url.split('/').pop()!;
    let body: Record<string, unknown> = {};
    const files: string[] = [];
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') body[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        else files.push(`${k}:${(v as File).name}:${(v as File).size}`);
      }
    } else body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body, files });
    const err = opts.fail?.(method);
    if (err) return new Response(JSON.stringify({ ok: false, description: err }));
    const result = opts.result?.(method) ?? (method === 'getMe' ? { username: 'be_nobody_bot' } : method === 'createInvoiceLink' ? 'https://t.me/$invoice' : true);
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const store = opts.store ?? new MemoryStore();
  const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, stickersDir: STICKERS, shopLedger: opts.ledger, drawMy: opts.drawMy });
  return { bot, calls, store };
}

/** Чат поддержки по умолчанию (bot.ts › SUPPORT_CHAT). */
const SUPPORT = '-5387784292';
const ANYA = { id: 77, first_name: 'Аня @spam', language_code: 'ru' };
/** Сервер засчитал игроку сыгранный матч (бесплатный пак — после матча и подписки на канал). */
const played = (bot: Bot, id = 77) => bot.shop.earn({ users: [{ tgUser: id, name: 'Аня @spam', lang: 'ru', stickers: [] }] });
/** Стартовые стикеры бесплатного пака открываются по одному за матч: три матча — открыты все. */
const openStarters = async (bot: Bot, id = 77) => {
  for (let i = 0; i < 3; i++) await bot.shop.earn({ users: [{ tgUser: id, name: 'Аня @spam', lang: 'ru', stickers: ['dance', 'oops', 'who'] }] });
};
const hook = (bot: Bot, upd: unknown) => bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
const payment = (over: Record<string, unknown> = {}) => ({
  message: {
    chat: { id: 77, type: 'private' },
    from: ANYA,
    successful_payment: { currency: 'XTR', total_amount: 79, invoice_payload: 'kotBanan:77', telegram_payment_charge_id: 'ch_1', ...over },
  },
});

describe('гардероб', () => {
  it('бесплатный пак: один пак на игрока — 4 стикера актёра и приманка, повтор ничего не создаёт', async () => {
    const { bot, calls } = makeBot();
    await played(bot);
    calls.length = 0;
    const r = await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: ['starter', 'pack'], pack: 'https://t.me/addstickers/m77_by_be_nobody_bot', issued: 2, wanted: 2 });
    const create = calls.filter((c) => c.method === 'createNewStickerSet');
    expect(create).toHaveLength(1);
    // имя без @: подпись пака уходит в Telegram
    expect(create[0].body.title).toBe('Массовка · Аня spam · @be_nobody_bot');
    expect((create[0].body.stickers as { format: string }[]).map((s) => s.format)).toEqual(['video', 'video']);
    // сразу — «Привет!» и приманка, остальные стартовые — по одному за следующие матчи
    expect(create[0].files.map((f) => f.split(':')[1])).toEqual(['hi.webm', 'lure~vhs.webm']);
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('стикерпак'))).toBe(true);

    calls.length = 0;
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(calls.filter((c) => /StickerSet|StickerToSet/.test(c.method))).toHaveLength(0);
  });

  it('покупка: счёт в звёздах; проверка перед оплатой — тот ли игрок и цена; стикеры — сразу в пак игрока', async () => {
    const { bot, calls, store } = makeBot();
    const buy = await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'kotBanan' });
    expect(buy).toEqual({ status: 200, body: { link: 'https://t.me/$invoice' } });
    const inv = calls.find((c) => c.method === 'createInvoiceLink')!.body;
    expect(inv).toMatchObject({ currency: 'XTR', payload: 'kotBanan:77', prices: [{ amount: 79 }] });
    expect(inv.provider_token).toBeUndefined();
    expect((await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'nope' })).status).toBe(400);

    const pre = async (q: Record<string, unknown>) => {
      calls.length = 0;
      await hook(bot, { pre_checkout_query: { id: 'q', from: { id: 77 }, currency: 'XTR', total_amount: 79, invoice_payload: 'kotBanan:77', ...q } });
      return calls.find((c) => c.method === 'answerPreCheckoutQuery')!.body.ok;
    };
    expect(await pre({})).toBe(true);
    expect(await pre({ from: { id: 78 } })).toBe(false);
    expect(await pre({ total_amount: 1 })).toBe(false);
    expect(await pre({ invoice_payload: 'starter:77' })).toBe(false);

    calls.length = 0;
    expect((await hook(bot, payment())).status).toBe(200);
    // набор записан; пака не было — бот создал один пак игрока: 2 стикера набора и приманка последней
    const u = await store.shopUser(77);
    expect(u?.items).toEqual(['kotBanan', 'pack']);
    expect(u?.issued).toEqual(['justBanana', 'aaa', 'lure~vhs']);
    const made = calls.find((c) => c.method === 'createNewStickerSet')!;
    expect(made.body.name).toBe('m77_by_be_nobody_bot');
    expect(made.body.title).toBe('Массовка · Аня spam · @be_nobody_bot');
    expect(made.files.map((f) => f.split(':')[1])).toEqual(['justBanana.webm', 'aaa.webm', 'lure~vhs.webm']);
    // сообщение — без вопросов, со ссылкой на пак
    const msg = calls.find((c) => c.method === 'sendMessage')!.body;
    expect(msg.text).toContain('Кот-банан');
    expect(JSON.stringify(msg.reply_markup)).toContain('https://t.me/addstickers/m77_by_be_nobody_bot');
    expect(JSON.stringify(msg.reply_markup)).not.toContain('pk:');
    const st = await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect(st.body).toMatchObject({ pack: 'https://t.me/addstickers/m77_by_be_nobody_bot', issued: 3, wanted: 3 });

    // Telegram повторил обновление — второй раз не выдаём и не пишем
    calls.length = 0;
    await hook(bot, payment());
    expect(calls.filter((c) => c.method !== 'getMe')).toHaveLength(0);
    // уже куплено — второй счёт не выставляем, и перед оплатой — отказ
    expect((await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'kotBanan' })).status).toBe(409);
    expect(await pre({})).toBe(false);
  });

  it('пока бот выдаёт стикеры, покупка не теряется: выдача пишет только свой ход поверх свежей записи', async () => {
    const store = new MemoryStore();
    const { bot } = makeBot({
      store,
      // Telegram создаёт пак — а игрок в это время купил набор (запись поменялась в обход выдачи)
      result: (m) => {
        if (m === 'createNewStickerSet') {
          const cur = (store as unknown as { shop: Map<number, { items: string[] }> }).shop.get(77)!;
          cur.items.push('kotBanan');
        }
        return undefined;
      },
    });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    const u = await store.shopUser(77);
    expect(u?.items).toContain('kotBanan');
    expect(u?.items).toContain('starter');
    expect(u?.pack).toBe('m77_by_be_nobody_bot');
  });

  it('оплата с настоящим номером платежа (длинный, base64) записывается и выдаёт набор', async () => {
    const { bot, store } = makeBot();
    const charge = `stxmDht2QrZc${'aZ09+/_-='.repeat(14)}`;
    expect(charge.length).toBeGreaterThan(128);
    expect((await hook(bot, payment({ telegram_payment_charge_id: charge }))).status).toBe(200);
    expect((await store.shopUser(77))?.items).toContain('kotBanan');
    // кавычки и пробелы — нет (номер уходит в команду возврата)
    const { bot: b2, store: s2 } = makeBot();
    await hook(b2, payment({ telegram_payment_charge_id: "x'; rm -rf /" }));
    expect((await s2.shopUser(77))?.items ?? []).not.toContain('kotBanan');
  });

  it('уведомление об оплате потерялось — гардероб сверяется с Telegram и выдаёт набор; возвращённое не выдаёт', async () => {
    let txs: unknown[] = [];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStarTransactions' ? { transactions: txs } : undefined) });
    const pay = (id: string, user = 77) => ({ id, amount: 79, date: 1, source: { type: 'user', user: { id: user }, invoice_payload: `kotBanan:${user}` } });
    // чужая оплата и оплата с возвратом (встречная транзакция с тем же id) — не наши
    txs = [pay('ch_other', 78), pay('ch_back'), { id: 'ch_back', amount: 49, date: 2, receiver: { type: 'user', user: { id: 77 } } }];
    const st0 = await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect((st0.body as { items: string[] }).items).not.toContain('kotBanan');

    // новая оплата появилась, но сверка — не чаще раза в 30 с
    // настоящий номер платежа звёздами — длинный, с символами base64 (раньше не проходил проверку)
    const LOST = `stx${'Ab9+/='.repeat(25)}x`;
    txs.push(pay(LOST));
    calls.length = 0;
    await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect(calls.some((c) => c.method === 'getStarTransactions')).toBe(false);
    expect((await store.shopUser(77))?.items ?? []).not.toContain('kotBanan');

    // другой экземпляр (или позже) — сверка находит оплату: набор записан и выдан, как при обычной оплате
    const second = makeBot({ store, result: (m) => (m === 'getStarTransactions' ? { transactions: txs } : undefined) });
    const st = await second.bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect((st.body as { items: string[] }).items).toContain('kotBanan');
    expect(second.calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Кот-банан'))).toBe(true);
    // теперь платёж в учёте — возврат по нему пройдёт
    expect(await store.saveShopPayment({ charge: LOST, userId: 77, item: 'kotBanan', stars: 79, refunded: false })).toBe(false);
  });

  it('сверка по расписанию выдаёт оплату, хотя игрок не заходил в гардероб; повторная сверка ничего не дублирует', async () => {
    const LOST = `stx${'Qw7+/='.repeat(20)}y`;
    const txs = [{ id: LOST, amount: 79, date: 1, source: { type: 'user', user: { id: 77, first_name: 'Аня', language_code: 'ru' }, invoice_payload: 'kotBanan:77' } }];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStarTransactions' ? { transactions: txs } : undefined) });
    expect(await bot.shop.reconcileAll()).toBe(1);
    const u = await store.shopUser(77);
    expect(u?.items).toContain('kotBanan');
    expect(u?.lang).toBe('ru');
    expect(calls.filter((c) => c.method === 'sendMessage' && String(c.body.text).includes('Кот-банан'))).toHaveLength(1);
    // второй проход (или второй экземпляр) — уже выдано: ни записи, ни сообщения
    calls.length = 0;
    expect(await bot.shop.reconcileAll()).toBe(0);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('сверку по расписанию делает тот, кто держит аренду: синий и зелёный не сверяют вдвоём', async () => {
    const store = new MemoryStore();
    expect(await store.lease('shop_reconcile', 'blue:1', 60_000)).toBe(true);
    expect(await store.lease('shop_reconcile', 'green:2', 60_000)).toBe(false);
    // свою аренду продлевает
    expect(await store.lease('shop_reconcile', 'blue:1', 60_000)).toBe(true);
  });

  it('проверочная покупка за 1 звезду: без пака и стикеров, возвращается кнопкой; наборы так не вернуть', async () => {
    const CH = `stx${'Zz1+/='.repeat(20)}t`;
    let txs: unknown[] = [];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStarTransactions' ? { transactions: txs } : undefined) });
    const buy = await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'test' });
    expect(buy.status).toBe(200);
    expect(calls.find((c) => c.method === 'createInvoiceLink')?.body).toMatchObject({ payload: 'test:77', prices: [{ amount: 1 }] });
    // оплата прошла — только отметка: пака нет, стикеров и сообщения тоже
    calls.length = 0;
    await hook(bot, payment({ total_amount: 1, invoice_payload: 'test:77', telegram_payment_charge_id: CH }));
    expect((await store.shopUser(77))?.items).toEqual(['test']);
    expect(calls.some((c) => /StickerSet|StickerToSet|sendMessage/.test(c.method))).toBe(false);
    // «Вернуть звёзды»: номер платежа — из списка Telegram, отметка снимается
    txs = [{ id: CH, amount: 1, date: 1, source: { type: 'user', user: { id: 77 }, invoice_payload: 'test:77' } }];
    const back = await bot.handle('POST', '/shop/refund', {}, { initData: initData(ANYA), item: 'test' });
    expect(back.status).toBe(200);
    expect((back.body as { items: string[] }).items).not.toContain('test');
    expect(calls.find((c) => c.method === 'refundStarPayment')?.body).toEqual({ user_id: 77, telegram_payment_charge_id: CH });
    // чужая покупка не найдётся, набор так не вернуть
    const BOB = { id: 78, first_name: 'Боб', language_code: 'ru' };
    expect((await bot.handle('POST', '/shop/refund', {}, { initData: initData(BOB), item: 'test' })).status).toBe(404);
    expect((await bot.handle('POST', '/shop/refund', {}, { initData: initData(ANYA), item: 'kotBanan' })).status).toBe(403);
  });

  it('бесплатный пак есть — купленный набор сразу добавляется в него; пак по внешней ссылке /start stickers', async () => {
    // пак в Telegram: приманка (🎁) уже не последняя — бот переставит её в конец
    const set = { stickers: [...['👋', '💃', '😵', '🤨'].map((e, i) => ({ file_id: `f${i}`, emoji: e })), { file_id: 'lure_id', emoji: '🎁' }, { file_id: 'f5', emoji: '😭' }, { file_id: 'f6', emoji: '🍌' }] };
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined) });
    await played(bot);
    calls.length = 0;
    await hook(bot, { message: { chat: { id: 77, type: 'private' }, from: ANYA, text: '/start stickers' } });
    expect((await store.shopUser(77))?.issued).toHaveLength(2);
    calls.length = 0;
    await hook(bot, payment());
    // свой пак уже есть — стикеры набора сразу в него, без вопросов
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'addStickerToSet').map((c) => c.body.name)).toEqual(['m77_by_be_nobody_bot', 'm77_by_be_nobody_bot']);
    expect((await store.shopUser(77))?.issued).toHaveLength(4);
    expect(calls.find((c) => c.method === 'setStickerPositionInSet')?.body).toEqual({ sticker: 'lure_id', position: 6 });
    // старая кнопка «Новый пак» из прошлого сообщения — ничего не создаёт
    calls.length = 0;
    await hook(bot, { callback_query: { id: 'cb2', from: ANYA, data: 'pk:own:kotBanan' } });
    expect(calls.filter((c) => /StickerSet|StickerToSet/.test(c.method))).toHaveLength(0);
    // в группе — не выдаём (пак личный)
    await hook(bot, { message: { chat: { id: -5, type: 'group' }, from: { id: 90 }, text: '/start stickers' } });
    expect(await store.shopUser(90)).toBeNull();
  });

  it('стикеры набора без покупки не выдаются: ни кнопкой, ни маршрутом, ни бесплатным паком', async () => {
    const { bot, calls, store } = makeBot();
    await played(bot);
    calls.length = 0;
    await bot.handle('POST', '/shop/pack', {}, { initData: initData(ANYA), item: 'kotBanan', mode: 'in' });
    await hook(bot, { callback_query: { id: 'cb', from: ANYA, data: 'pk:in:kotBanan' } });
    await hook(bot, { callback_query: { id: 'cb', from: ANYA, data: 'pk:own:kotBanan' } });
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect((await store.shopUser(77))?.issued).toEqual(['hi', 'lure~vhs']);
    expect(calls.flatMap((c) => c.files).some((f) => /aaa|justBanana/.test(f))).toBe(false);
  });

  it('/paysupport: запрос — в чат поддержки с номером и покупками, ответ оттуда — игроку', async () => {
    const { bot, calls } = makeBot();
    const sent = (chat: number | string) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chat)).map((c) => String(c.body.text));
    // пустой /paysupport — подсказка игроку, в поддержку ничего
    await hook(bot, { message: { chat: { id: 77, type: 'private' }, from: ANYA, text: '/paysupport' } });
    expect(sent(77).at(-1)).toContain('77');
    expect(sent(SUPPORT)).toHaveLength(0);
    // следующее сообщение — в поддержку: имя без @, номер, покупки, без чужих ссылок
    await hook(bot, payment());
    await hook(bot, { message: { chat: { id: 77, type: 'private' }, from: ANYA, text: 'скин не появился evil.example/x @spammer' } });
    const card = sent(SUPPORT).at(-1)!;
    expect(card).toContain('Номер покупателя: 77');
    expect(card).toContain('kotBanan');
    expect(card).toContain('скин не появился');
    expect(card).not.toMatch(/evil\.example|@spam/);
    expect(card).toMatch(/#u77$/);
    const msg = calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === SUPPORT).at(-1)!;
    // кнопки — профиль покупателя (у Ани нет ника — по id) и сразу запуск возврата в GitHub Actions
    expect(msg.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '👤 Профиль покупателя', url: 'tg://user?id=77' }],
        [{ text: '↩️ Возврат: shop-refund', url: 'https://github.com/Waldo33/who-is-alive/actions/workflows/shop-refund.yml' }],
        [{ text: '✅ Закрыть обращение', callback_data: 'sup:close' }],
      ],
    });
    // ответ на пересылку в чате поддержки — игроку; чужая группа и не ответ — никому
    const before = sent(77).length;
    await hook(bot, { message: { message_id: 5, chat: { id: Number(SUPPORT), type: 'group' }, from: { id: 1, first_name: 'Owner' }, text: 'Вернули звёзды', reply_to_message: { text: card, from: { id: 9, is_bot: true } } } });
    expect(sent(77).at(-1)).toBe('Вернули звёзды');
    await hook(bot, { message: { chat: { id: -100, type: 'group' }, from: { id: 1 }, text: 'чужое', reply_to_message: { text: card, from: { id: 9, is_bot: true } } } });
    await hook(bot, { message: { chat: { id: Number(SUPPORT), type: 'group' }, from: { id: 1 }, text: 'просто так' } });
    expect(sent(77).length).toBe(before + 1);
    // «Закрыть обращение»: кнопки убраны, кто закрыл — в сообщении, метка #u77 — по-прежнему последней
    calls.length = 0;
    await hook(bot, { callback_query: { id: 'cq', from: { id: 1, first_name: 'Owner' }, data: 'sup:close', message: { message_id: 42, chat: { id: Number(SUPPORT) }, text: card } } });
    const edit = calls.find((c) => c.method === 'editMessageText')!;
    expect(edit.body).toMatchObject({ chat_id: Number(SUPPORT), message_id: 42 });
    expect(edit.body.reply_markup).toBeUndefined();
    expect(String(edit.body.text)).toMatch(/✅ Закрыто · Owner\n#u77$/);
    // в чужом чате кнопка ничего не правит
    calls.length = 0;
    await hook(bot, { callback_query: { id: 'cq2', from: { id: 5 }, data: 'sup:close', message: { message_id: 7, chat: { id: -100 }, text: card } } });
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });

  it('«Надеть» / «Снять»: только купленный скин; новая покупка надевается сама', async () => {
    const { bot, store } = makeBot();
    const wear = (item: unknown) => bot.handle('POST', '/shop/wear', {}, { initData: initData(ANYA), item });
    // не куплен — не надеть, чужое имя — отказ
    expect((await wear('kotBanan')).status).toBe(403);
    expect((await wear('<b>')).status).toBe(400);
    await hook(bot, payment());
    expect(skinOf((await store.shopUser(77))!.items)).toBe('kotBanan');
    const off = await wear(null);
    expect(off.status).toBe(200);
    expect((off.body as { worn: string | null }).worn).toBeNull();
    expect(skinOf((await store.shopUser(77))!.items)).toBeUndefined();
    const on = await wear('kotBanan');
    expect((on.body as { worn: string | null }).worn).toBe('kotBanan');
    expect((await store.shopUser(77))!.items.filter((x) => x.startsWith('wear:'))).toEqual(['wear:kotBanan']);
  });

  it('значки для статуса: по счётчикам и покупкам, с id эмодзи из набора бота; «Звезда дубля» — со сроком', async () => {
    const won = Date.now() - 3600_000;
    const set = [
      { emoji: '🎬', custom_emoji_id: 'e1' },
      { emoji: '⭐️', custom_emoji_id: 'e2' },
      { emoji: '🍌', custom_emoji_id: 'e3' },
    ];
    const { bot, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? { stickers: set } : undefined) });
    await store.bumpTgStats(77, { matches: 3, wins: 1, rooms: 0, winAt: won });
    // первый заход: набор ещё сверяется в фоне — id эмодзи появятся следом
    await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    await bot.badges.kick();
    await hook(bot, payment());
    const st = await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    const badges = (st.body as { badges: { id: string; have: boolean; n: number; of: number; until: number | null; emoji: string | null }[] }).badges;
    const by = (id: string) => badges.find((b) => b.id === id)!;
    expect(by('onSet')).toMatchObject({ have: true, emoji: 'e1' });
    expect(by('star')).toMatchObject({ have: true, until: won + 24 * 3600_000, emoji: 'e2' });
    expect(by('reel')).toMatchObject({ have: false, n: 3, of: 50 });
    expect(by('director')).toMatchObject({ have: false, n: 0, of: 10, emoji: null });
    expect(by('kotBanan')).toMatchObject({ have: true, emoji: 'e3' });
  });

  it('сбой Telegram: выдано записано, остальное дошлётся при заходе в гардероб; без «Старт» у бота — need_bot', async () => {
    let down = true;
    const { bot, calls } = makeBot({ fail: (m) => (m === 'createNewStickerSet' && down ? 'Bad Request: PEER_ID_INVALID' : null) });
    await played(bot);
    const r = await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(r.body).toMatchObject({ pack: null, issued: 0, wanted: 2, error: 'need_bot' });
    down = false;
    calls.length = 0;
    await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(1);
    const st = await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect(st.body).toMatchObject({ issued: 2, error: null });
  });

  it('оплата не записалась (учёт недоступен) — вебхук не 200, Telegram повторит', async () => {
    const store = new MemoryStore();
    const ledger = {
      shopUser: store.shopUser.bind(store),
      saveShopUser: store.saveShopUser.bind(store),
      saveShopPayment: async () => {
        throw new Error('db down');
      },
      refundShopPayment: store.refundShopPayment.bind(store),
      linkGame: async () => false,
    };
    const { bot } = makeBot({ store, ledger });
    expect((await hook(bot, payment())).status).toBe(500);
  });

  it('возврат: звёзды назад, набор и скин забраны, его стикеры удалены из пака — только изнутри машины', async () => {
    // пак игрока в Telegram: стикеры набора узнаются по первому эмодзи (🌧 — с вариантом U+FE0F, как отдаёт Telegram)
    const inPack = [
      { file_id: 'F_aaa', emoji: '😱' },
      { file_id: 'F_banana', emoji: '🍌' },
      { file_id: 'F_lure', emoji: '🎁' },
    ];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? { stickers: inPack } : undefined) });
    await hook(bot, payment());
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store, bot });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const url = `http://127.0.0.1:${port}/internal/tg/refund`;
      expect((await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ charge: 'ch_1' }) })).status).toBe(404);
      const r = await fetch(url, { method: 'POST', body: JSON.stringify({ charge: 'ch_1' }) });
      expect(r.status).toBe(200);
      expect(calls.find((c) => c.method === 'refundStarPayment')?.body).toEqual({ user_id: 77, telegram_payment_charge_id: 'ch_1' });
      // набор забран (скина больше нет), пак остаётся, стикеры набора удалены из него, приманка — на месте
      const u = (await store.shopUser(77))!;
      expect(u.items).toEqual(['pack']);
      expect(skinOf(u.items)).toBeUndefined();
      expect(calls.filter((c) => c.method === 'deleteStickerFromSet').map((c) => c.body.sticker)).toEqual(['F_banana', 'F_aaa']);
      expect(u.issued.some((id) => id === 'aaa' || id === 'justBanana')).toBe(false);
      expect(await r.json()).toMatchObject({ ok: true, item: 'kotBanan', removed: 2 });
      // второй возврат того же платежа — нет
      expect((await fetch(url, { method: 'POST', body: JSON.stringify({ charge: 'ch_1' }) })).status).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('безопасность: без подписи initData — 401; чужой payload не выдаёт набор; учёт снаружи закрыт и проверяет вход', async () => {
    const { bot, store } = makeBot();
    expect((await bot.handle('POST', '/shop/claim', {}, { initData: 'user=%7B%22id%22%3A77%7D&hash=00' })).status).toBe(401);
    // оплата пришла от 77, а в payload — другой игрок (подделанный счёт): ничего не выдаём
    await hook(bot, payment({ invoice_payload: 'kotBanan:78' }));
    expect(await store.shopUser(77)).toBeNull();
    expect(await store.shopUser(78)).toBeNull();

    expect((await shopLedgerOp(localLedger(store), { op: 'save', user: { userId: 1, lang: 'ru', name: 'x', items: ['kotBanan'], pack: 'evil pack', issued: [] } })).status).toBe(400);
    expect((await shopLedgerOp(localLedger(store), { op: 'save', user: { userId: 1, lang: 'ru', name: 'x', items: [], pack: null, issued: ['nope'] } })).status).toBe(400);
    expect((await shopLedgerOp(localLedger(store), { op: 'pay', payment: { charge: 'c', userId: 1, item: 'nope', stars: 1 } })).status).toBe(400);
    expect((await shopLedgerOp(localLedger(store), { op: 'drop' })).status).toBe(400);

    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const body = JSON.stringify({ op: 'save', user: { userId: 5, lang: 'ru', name: 'x', items: ['kotBanan'], pack: null, issued: [] } });
      expect((await fetch(`http://127.0.0.1:${port}/internal/shop`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body })).status).toBe(404);
      expect(await store.shopUser(5)).toBeNull();
      // сервер бота (по туннелю — изнутри) — через RemoteLedger
      const remote = new RemoteLedger(`http://127.0.0.1:${port}`);
      await remote.saveShopUser({ userId: 5, lang: 'en', name: 'x', items: ['starter'], pack: null, issued: [] });
      expect((await remote.shopUser(5))?.items).toEqual(['starter']);
      expect(await remote.saveShopPayment({ charge: 'c1', userId: 5, item: 'kotBanan', stars: 199, refunded: false })).toBe(true);
      expect(await remote.saveShopPayment({ charge: 'c1', userId: 5, item: 'kotBanan', stars: 199, refunded: false })).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('положенные стикеры и имя пака', () => {
    expect(wantedStickers([]).length).toBe(0);
    expect(wantedStickers(['kotBanan', 'st:aaa'])).toEqual([]);
    expect(wantedStickers(['kotBanan', 'pack', 'st:aaa']).map((s) => s.id)).toEqual(['lure', 'justBanana', 'aaa']);
    // выбор пака без покупки ничего не даёт
    expect(wantedStickers(['pack', 'starter', 'st:aaa']).map((s) => s.id)).toEqual(['hi', 'dance', 'oops', 'who', 'lure']);
    expect(packName('  Вася‮ https://x.y @boss ')).toBe('Вася x.y boss');
  });

  it('связь с Telegram: игрок сервера по своему токену; чужой или поддельный токен — отказ', async () => {
    const store = new MemoryStore();
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const me = (await (await fetch(`http://127.0.0.1:${port}/v1/auth/anon`, { method: 'POST' })).json()) as { userId: string; token: string };
      // бот на другом сервере: связь проверяет и пишет игровой (/internal/shop)
      const { bot } = makeBot({ ledger: new RemoteLedger(`http://127.0.0.1:${port}`) });
      const link = (token: unknown, init = initData(ANYA)) => bot.handle('POST', '/shop/link', {}, { initData: init, token });
      expect((await link(me.token)).status).toBe(200);
      expect(await store.telegramOf([me.userId])).toEqual([{ gameUser: me.userId, tgUser: 77, name: 'Аня spam', lang: 'ru' }]);
      // токен с чужой подписью
      const [h, b] = me.token.split('.');
      expect((await link(`${h}.${b}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(403);
      expect((await link('not a token')).status).toBe(400);
      expect((await bot.handle('POST', '/shop/link', {}, { initData: 'user=%7B%22id%22%3A78%7D&hash=00', token: me.token })).status).toBe(401);
      // снаружи учёт закрыт
      const ext = await fetch(`http://127.0.0.1:${port}/internal/shop`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ op: 'link', token: me.token, link: { tgUser: 99, name: 'x', lang: 'ru' } }) });
      expect(ext.status).toBe(404);
      expect((await store.telegramOf([me.userId]))[0].tgUser).toBe(77);
    } finally {
      await srv.close();
    }
  });

  it('матч на сайте до входа через Telegram: при входе засчитан (бесплатный пак) и стикеры открываются', async () => {
    const store = new MemoryStore();
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const me = (await (await fetch(`http://127.0.0.1:${port}/v1/auth/anon`, { method: 'POST' })).json()) as { userId: string; token: string };
      // так пишет server.ts › stickersToBot, когда связи ещё нет
      await store.savePendingEarn(me.userId, ['cut']);
      await store.savePendingEarn(me.userId, ['cut', 'nope']);
      const { bot } = makeBot({ ledger: new RemoteLedger(`http://127.0.0.1:${port}`) });
      expect((await bot.handle('POST', '/shop/link', {}, { initData: initData(ANYA), token: me.token })).status).toBe(200);
      expect((await store.shopUser(77))?.items).toContain('played');
      // отложенное забрано: второй вход ничего не добавляет
      expect(await store.takePendingEarn(me.userId)).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('вход через Telegram на сайте: подпись виджета, 30 дней; связь с игроком — как из Mini App; покупка — ссылкой на счёт', async () => {
    const store = new MemoryStore();
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const me = (await (await fetch(`http://127.0.0.1:${port}/v1/auth/anon`, { method: 'POST' })).json()) as { userId: string; token: string };
      const { bot } = makeBot({ ledger: new RemoteLedger(`http://127.0.0.1:${port}`) });
      const login = webLogin({ id: 77, first_name: 'Аня', username: 'anya' });
      expect(bot.verifyLogin(login, 'ru')?.user).toEqual({ id: 77, first_name: 'Аня', username: 'anya', language_code: 'ru' });
      // подмена id, лишнее поле, старый вход, мусор — отказ
      expect(bot.verifyLogin({ ...login, id: 78 })).toBeNull();
      expect(bot.verifyLogin({ ...login, admin: 1 })).toBeNull();
      expect(bot.verifyLogin(webLogin({ id: 77 }, Math.floor(Date.now() / 1000) - 31 * 86_400))).toBeNull();
      expect(bot.verifyLogin(webLogin({ id: 77 }, Math.floor(Date.now() / 1000) - 29 * 86_400))?.user.id).toBe(77);
      expect(bot.verifyLogin('id=77&hash=00')).toBeNull();
      expect(bot.verifyLogin({ ...login, hash: { $ne: 1 } })).toBeNull();
      // подпись Mini App (initData) для виджета не годится и наоборот
      expect(bot.verify(new URLSearchParams(Object.entries(login).map(([k, v]) => [k, String(v)])).toString())).toBeNull();

      expect((await bot.handle('POST', '/shop/link', {}, { login, lang: 'ru', token: me.token })).status).toBe(200);
      expect(await store.telegramOf([me.userId])).toEqual([{ gameUser: me.userId, tgUser: 77, name: 'Аня', lang: 'ru' }]);
      expect((await bot.handle('POST', '/shop', {}, { login })).status).toBe(200);
      expect((await bot.handle('POST', '/shop/link', {}, { login: { ...login, id: 99 }, token: me.token })).status).toBe(401);
      // покупка с сайта — ссылка на счёт этого игрока Telegram (оплатить в приложении)
      const buy = await bot.handle('POST', '/shop/buy', {}, { login, item: 'kotBanan' });
      expect(buy.status).toBe(200);
      expect(buy.body).toEqual({ link: 'https://t.me/$invoice' });
      expect((await bot.handle('GET', '/info', {}, null)).body).toMatchObject({ id: 123456 });
    } finally {
      await srv.close();
    }
  });

  it('вход на сайт через бота: код → «Войти» в чате → сайт получает вход один раз; без секрета и чужим кодом — нет', async () => {
    const { bot, calls } = makeBot();
    const st = (await bot.handle('POST', '/login/start', {}, null)).body as { code: string; secret: string; link: string };
    expect(st.link).toBe(`https://t.me/be_nobody_bot?start=login_${st.code}`);
    const poll = async (b: unknown) => (await bot.handle('POST', '/login/poll', {}, b)).body as { state: string; login?: Record<string, unknown> };
    expect((await poll({ code: st.code, secret: st.secret })).state).toBe('wait');
    // /start по ссылке — только вопрос с кнопкой, вход ещё не выдан
    await hook(bot, { message: { chat: { id: 77, type: 'private' }, from: ANYA, text: `/start login_${st.code}` } });
    const ask = calls.find((c) => c.method === 'sendMessage')!;
    expect(JSON.stringify(ask.body)).toContain(`login:${st.code}`);
    expect((await poll({ code: st.code, secret: st.secret })).state).toBe('wait');
    await hook(bot, { callback_query: { id: 'q1', from: ANYA, data: `login:${st.code}`, message: { message_id: 5, chat: { id: 77 } } } });
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(true);
    // чужой секрет — нет
    expect((await poll({ code: st.code, secret: 'x'.repeat(22) })).state).toBe('gone');
    const ok = await poll({ code: st.code, secret: st.secret });
    expect(ok.state).toBe('ok');
    // подпись — как у виджета: бот её принимает, игрок — тот, кто нажал «Войти»
    expect(bot.verifyLogin(ok.login, 'ru')?.user.id).toBe(77);
    expect((await bot.handle('POST', '/shop', {}, { login: ok.login })).status).toBe(200);
    // второй раз — уже нет; повторное «Войти» — отказ
    expect((await poll({ code: st.code, secret: st.secret })).state).toBe('gone');
    await hook(bot, { callback_query: { id: 'q2', from: { id: 99 }, data: `login:${st.code}` } });
    expect(JSON.stringify(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.body)).toContain('show_alert');
    expect((await poll({ code: 'bad', secret: st.secret })).state).toBe('gone');
  });

  it('стикеры за матч: только в купленный набор, каждый один раз, сообщение «Новый стикер» с кнопкой «Играть»', async () => {
    const { bot, calls, store } = makeBot();
    await hook(bot, payment());
    calls.length = 0;
    const earned = { users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: ['splat', 'happyTears', 'aaa'] }] };
    expect(await bot.shop.earn(earned)).toEqual({ users: 1 });
    const adds = calls.filter((c) => c.method === 'addStickerToSet');
    expect(adds.map((c) => c.body.name)).toEqual(['m77_by_be_nobody_bot', 'm77_by_be_nobody_bot']);
    expect(adds.flatMap((c) => c.files.map((f) => f.split(':')[1]))).toEqual(['splat.webm', 'happyTears.webm']);
    expect((await store.shopUser(77))?.issued).toEqual(['justBanana', 'aaa', 'lure~vhs', 'splat', 'happyTears']);
    // первый матч — ещё и предложение бесплатного пака; новое в паке — отдельным сообщением
    const msg = calls.find((c) => c.method === 'sendMessage' && String(c.body.text).includes('Новый стикер'))!.body;
    expect(msg.text).toContain('«Шмяк!»');
    expect(msg.text).toContain('4 из 7');
    expect(JSON.stringify(msg.reply_markup)).toContain('https://site.example/?src=tg_sticker');
    expect(JSON.stringify(msg.reply_markup)).toContain('https://t.me/addstickers/m77_by_be_nobody_bot');

    // тот же матч пришёл второй раз — ничего
    calls.length = 0;
    await bot.shop.earn(earned);
    expect(calls.filter((c) => c.method !== 'getMe')).toHaveLength(0);

    // набор не куплен — стикеры не выдаются и не копятся; мусор во входе отбрасывается
    await bot.shop.earn({ users: [{ tgUser: 78, name: 'Петя', lang: 'ru', stickers: ['splat', 'meow'] }, { tgUser: -1, name: 'x', lang: 'ru', stickers: [] }, { tgUser: 79, name: 'x', lang: 'ru', stickers: ['evil'] }] });
    // матч засчитан (бесплатный пак), но стикеры набора — нет
    expect((await store.shopUser(78))?.items).toEqual(['played']);
    expect((await store.shopUser(79))?.items).toBeUndefined();
    expect(calls.filter((c) => /StickerSet|StickerToSet/.test(c.method))).toHaveLength(0);
  });

  it('за матч открывается не больше двух новых стикеров, сначала редкие; остальные — в следующих матчах (и в пределах суток)', async () => {
    const { bot, store } = makeBot();
    const all = ['action', 'retake', 'cut', 'offscreen', 'still', 'chef', 'jackpot'];
    await bot.shop.earn({ users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: all }] });
    const got = (u: Awaited<ReturnType<typeof store.shopUser>>) => (u?.items ?? []).filter((i) => i.startsWith('st:'));
    expect(got(await store.shopUser(77))).toEqual(['st:jackpot', 'st:chef']);
    await bot.shop.earn({ users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: all }] });
    // третий за сутки — последний (EARN_PER_DAY)
    expect(got(await store.shopUser(77))).toEqual(['st:jackpot', 'st:chef', 'st:cut']);
  });

  it('за сутки (по Москве) — не больше трёх стикеров за матчи; экран говорит, когда снова', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-28T10:00:00Z'));
      const { bot, calls, store } = makeBot();
      await hook(bot, payment());
      // набор Кот-банана куплен — его стикеры за матчи идут в пак
      const all = ['splat', 'allGood', 'happyTears', 'freeze', 'meow'];
      const play = () => bot.shop.earn({ users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: all }] });
      const n = async () => (await store.shopUser(77))!.items.filter((i) => i.startsWith('st:')).length;
      const said = () => calls.filter((c) => c.method === 'sendMessage' && String(c.body.text).includes('Новый стикер')).map((c) => String(c.body.text));
      const state = async () => (await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { earnNext: number | null };
      await play();
      expect(said().at(-1)).toContain('следующие откроются');
      expect((await state()).earnNext).toBeNull();
      await play();
      expect(await n()).toBe(3);
      expect(said().at(-1)).toContain('следующие откроются');
      // следующие сутки по Москве — с 21:00 UTC
      expect((await state()).earnNext).toBe(Date.parse('2026-11-28T21:00:00Z'));
      await play();
      expect(await n()).toBe(3);
      // 23:30 по Москве — те же сутки
      vi.setSystemTime(new Date('2026-11-28T20:30:00Z'));
      await play();
      expect(await n()).toBe(3);
      // 00:30 по Москве — новые сутки
      vi.setSystemTime(new Date('2026-11-28T21:30:00Z'));
      await play();
      expect(await n()).toBe(5);
      expect((await state()).earnNext).toBeNull();
      expect((await store.shopUser(77))!.items.filter((i) => i.startsWith('day:'))).toEqual(['day:20261129:2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('«Напомнить»: только при исчерпанном лимите; бот пишет один раз в новые сутки, днём', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-28T10:00:00Z'));
      const { bot, calls } = makeBot();
      await hook(bot, payment());
      const remind = async () => bot.handle('POST', '/shop/remind', {}, { initData: initData(ANYA) });
      const play = () => bot.shop.earn({ users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: ['splat', 'allGood', 'happyTears', 'freeze', 'meow'] }] });
      // лимит не исчерпан — напоминать не о чем
      expect((await remind()).body).toEqual({ error: 'no_limit' });
      await play();
      await play();
      const r = await remind();
      expect(r.status).toBe(200);
      expect((r.body as { remind: boolean }).remind).toBe(true);
      const reminds = () => calls.filter((c) => c.method === 'sendMessage' && String(c.body.text).includes('снова открываются'));
      // те же сутки и ночь — молчит
      expect(await bot.shop.remindAll()).toBe(0);
      vi.setSystemTime(new Date('2026-11-29T03:00:00Z'));
      expect(await bot.shop.remindAll()).toBe(0);
      // 10:30 по Москве — пишет, второй раз — нет
      vi.setSystemTime(new Date('2026-11-29T07:30:00Z'));
      expect(await bot.shop.remindAll()).toBe(1);
      expect(reminds()).toHaveLength(1);
      expect(reminds()[0].body.text).toContain('ещё 3');
      expect(await bot.shop.remindAll()).toBe(0);
      expect(((await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { remind: boolean }).remind).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('бесплатный пак: нужен и сыгранный матч, и подписка на канал', async () => {
    let status = 'left';
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getChatMember' ? { status } : undefined) });
    // по ссылке без матча — «сыграй дубль» и кнопка «Играть», пака нет (даже с подпиской)
    status = 'member';
    await hook(bot, { message: { chat: { id: 77, type: 'private' }, from: ANYA, text: '/start stickers' } });
    expect(await store.shopUser(77)).toBeNull();
    expect(JSON.stringify(calls.find((c) => c.method === 'sendMessage')!.body.reply_markup)).toContain('web_app');
    expect((await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) })).body).toMatchObject({ error: 'need_match' });

    // первый матч без подписки — бот просит подписаться: кнопки канала и «Я подписался»
    status = 'left';
    calls.length = 0;
    await played(bot);
    expect(calls.find((c) => c.method === 'getChatMember')?.body).toEqual({ chat_id: '@benobody_app', user_id: 77 });
    const ask = JSON.stringify(calls.find((c) => c.method === 'sendMessage')!.body.reply_markup);
    expect(ask).toContain('https://t.me/benobody_app');
    expect(ask).toContain('free:claim');
    expect((await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) })).body).toMatchObject({ error: 'need_sub', channel: 'https://t.me/benobody_app' });
    // «Я подписался», а подписки нет — всплывашка, пака нет
    calls.length = 0;
    await hook(bot, { callback_query: { id: 'cb', from: ANYA, data: 'free:claim' } });
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body.show_alert).toBe(true);
    expect(calls.some((c) => c.method === 'createNewStickerSet')).toBe(false);
    // подписался — пак; второй матч ничего не предлагает
    status = 'member';
    await hook(bot, { callback_query: { id: 'cb', from: ANYA, data: 'free:claim' } });
    expect((await store.shopUser(77))?.issued).toHaveLength(2);
    calls.length = 0;
    await played(bot);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);

    // подписан заранее — после первого матча сразу «Забрать стикерпак»
    calls.length = 0;
    await played(bot, 88);
    const offer = calls.find((c) => c.method === 'sendMessage')!.body;
    expect(offer.text).toContain('Первый дубль снят');
    expect(JSON.stringify(offer.reply_markup)).toContain('free:claim');
  });

  it('проверить подписку нельзя (бот не админ канала) — пак всё равно выдаём', async () => {
    const { bot, store } = makeBot({ fail: (m) => (m === 'getChatMember' ? 'Bad Request: member list is inaccessible' : null) });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect((await store.shopUser(77))?.issued).toHaveLength(2);
  });

  it('стикеры «за игру» — в свой пак, когда открыты в матче (и только открытые)', () => {
    const got = wantedStickers(['starter', 'pack', 'st:cut', 'st:jackpot']).map((s) => s.id);
    expect(got).toEqual(['hi', 'dance', 'oops', 'who', 'lure', 'cut', 'jackpot']);
    // пак ещё не забран — «за игру» копятся, но не выдаются
    expect(wantedStickers(['st:cut', 'played'])).toEqual([]);
  });

  it('«Собери свой стикерпак»: убрать и вернуть стикер, приманку убрать нельзя, закрытый — нельзя', async () => {
    const set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined) });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    await openStarters(bot);
    const pick = (id: string, on: unknown) => bot.handle('POST', '/shop/pick', {}, { initData: initData(ANYA), id, on });
    calls.length = 0;
    const r = await pick('dance', false);
    expect(r.status).toBe(200);
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'deleteStickerFromSet')?.body).toEqual({ sticker: 'f1' });
    expect((await store.shopUser(77))?.issued).not.toContain('dance');
    expect((await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body).toMatchObject({ off: ['dance'], pending: 0, wanted: 4, issued: 4 });
    // вернуть — снова в пак, приманка опять последней
    calls.length = 0;
    await pick('dance', true);
    await bot.shop.issue(77);
    expect(calls.filter((c) => c.method === 'addStickerToSet').map((c) => c.files[0].split(':')[1])).toEqual(['dance.webm']);
    expect((await store.shopUser(77))?.items).not.toContain('off:dance');
    expect((await pick('lure', false)).status).toBe(400);
    expect((await pick('aaa', false)).status).toBe(409);
    expect((await pick('nope', false)).status).toBe(400);
  });

  it('свой стикер: рисует сервер, правка меняет его в паке на месте, удаление убирает; мат и чужая фигурка — отказ', async () => {
    const drawn: string[] = [];
    let set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const { bot, calls, store } = makeBot({
      result: (m) => (m === 'getStickerSet' ? set : undefined),
      drawMy: async (look) => {
        drawn.push(JSON.stringify(look));
        return Buffer.from('webm');
      },
    });
    const my = (sticker: unknown, slot?: number) => bot.handle('POST', '/shop/my', {}, { initData: initData(ANYA), sticker, slot });
    // без пака — сначала забрать бесплатный
    expect((await my({ fig: 'actor', pose: 'wave', color: 0, caption: 'Йо' })).status).toBe(409);
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    calls.length = 0;
    const r = await my({ fig: 'actor', pose: 'dance', color: 1, caption: 'Это мой дубль' });
    expect(r.status).toBe(200);
    await bot.shop.issue(77);
    expect(drawn).toEqual([JSON.stringify({ fig: 'actor', pose: 'dance', color: 1, text: ['Это мой', 'дубль'] })]);
    const add = calls.find((c) => c.method === 'addStickerToSet')!;
    // метка места первой: по ней бот найдёт стикер для замены; вторая — эмодзи позы
    expect((add.body.sticker as { emoji_list: string[] }).emoji_list).toEqual(['✏️', '💃']);
    expect((await store.shopUser(77))?.issued).toContain('my0.1');
    expect((await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body).toMatchObject({ my: [{ slot: 0, rev: 1, fig: 'actor' }], pending: 0 });

    // правка — replaceStickerInSet того же места, номер правки растёт
    set = { stickers: [...set.stickers, { file_id: 'my0', emoji: '✏' }] };
    calls.length = 0;
    expect((await my({ fig: 'actor', pose: 'stun', color: 2, caption: 'Ой' }, 0)).status).toBe(200);
    await bot.shop.issue(77);
    const rep = calls.find((c) => c.method === 'replaceStickerInSet')!;
    expect(rep.body.old_sticker).toBe('my0');
    // правленый стикер — сообщением в чат: игрок сразу видит его, Telegram обновляет копию пака
    expect(calls.find((c) => c.method === 'sendSticker')?.body).toEqual({ chat_id: 77, sticker: 'my0' });
    expect((await store.shopUser(77))?.issued).toContain('my0.2');
    expect((await store.shopUser(77))?.issued).not.toContain('my0.1');
    expect(calls.some((c) => c.method === 'addStickerToSet')).toBe(false);

    // удалить
    calls.length = 0;
    await bot.handle('POST', '/shop/my/del', {}, { initData: initData(ANYA), slot: 0 });
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'deleteStickerFromSet')?.body).toEqual({ sticker: 'my0' });
    expect((await store.shopUser(77))?.issued.some((x) => x.startsWith('my'))).toBe(false);

    // отказы: мат, ссылка, закрытая фигурка, чужая поза
    expect((await my({ fig: 'actor', pose: 'wave', color: 0, caption: 'сука' })).body).toEqual({ error: 'rude' });
    expect((await my({ fig: 'actor', pose: 'wave', color: 0, caption: '@spam' })).body).toEqual({ error: 'chars' });
    expect((await my({ fig: 'kotBanan', pose: 'wave', color: 0 })).body).toEqual({ error: 'locked' });
    expect((await my({ fig: 'actor', pose: 'fly', color: 0 })).status).toBe(400);
    expect((await my({ fig: 'actor', pose: 'wave', color: 0 }, 9)).status).toBe(400);
  });

  it('убрал свой стикер и сразу сделал новый на то же место — новый заменяет старый в паке (27.11)', async () => {
    let set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined), drawMy: async () => Buffer.from('webm') });
    const my = (caption: string) => bot.handle('POST', '/shop/my', {}, { initData: initData(ANYA), sticker: { fig: 'actor', pose: 'wave', color: 0, caption } });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    await my('Старый');
    await bot.shop.issue(77);
    expect((await store.shopUser(77))?.issued).toContain('my0.1');
    set = { stickers: [...set.stickers, { file_id: 'my0', emoji: '✏' }] };
    // удаление и новый стикер успели раньше, чем бот убрал старый из пака: в учёте всё ещё my0.1
    const u = (await store.shopUser(77))!;
    await store.saveShopUser({ ...u, my: [] });
    calls.length = 0;
    await my('Новый');
    expect((await store.shopUser(77))?.my?.[0]).toMatchObject({ slot: 0, rev: 2 });
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'replaceStickerInSet')?.body.old_sticker).toBe('my0');
    expect((await store.shopUser(77))?.issued).toContain('my0.2');
  });

  it('эффекты: купил «Голограмму» — накинул на стикер, бот рисует и заменяет его на месте; снял или вернул звёзды — обратно', async () => {
    const set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const jobs: unknown[] = [];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined), drawMy: async (look) => (jobs.push(look), Buffer.from('webm')) });
    const fx = (id: string, f: string | null) => bot.handle('POST', '/shop/fx', {}, { initData: initData(ANYA), id, fx: f });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    await bot.shop.issue(77);
    // эффект не куплен — нельзя; мусор — 400
    expect((await fx('hi', 'holo')).body).toEqual({ error: 'need_fx' });
    expect((await fx('hi', 'glitter')).status).toBe(400);
    expect((await fx('lure', null)).status).toBe(400);
    await hook(bot, payment({ invoice_payload: 'holo:77', total_amount: 59, telegram_payment_charge_id: 'ch_holo' }));
    expect((await store.shopUser(77))?.items).toContain('holo');
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Эффект «Голограмма» твой'))).toBe(true);
    calls.length = 0;
    const r = await fx('hi', 'holo');
    expect(r.status).toBe(200);
    expect((r.body as { fx: Record<string, string>; effects: string[] }).fx).toEqual({ hi: 'holo' });
    expect((r.body as { effects: string[] }).effects).toEqual(['holo']);
    await bot.shop.issue(77);
    expect(jobs.at(-1)).toEqual({ std: 'hi', fx: 'holo', color: null, lang: 'ru' });
    expect(calls.find((c) => c.method === 'replaceStickerInSet')?.body.old_sticker).toBe('f0');
    expect((await store.shopUser(77))?.issued).toContain('hi~holo');
    // снял — снова файл без эффекта
    calls.length = 0;
    await fx('hi', null);
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'replaceStickerInSet')?.files[0]).toContain('hi.webm');
    expect((await store.shopUser(77))?.issued).toContain('hi');
    // свой стикер с эффектом: рисуется с ним; без покупки — нельзя
    const my = (f?: string) => bot.handle('POST', '/shop/my', {}, { initData: initData(ANYA), sticker: { fig: 'actor', pose: 'wave', color: 0, caption: 'Эй', fx: f } });
    expect((await my('noir')).body).toEqual({ error: 'locked' });
    expect((await my('holo')).status).toBe(200);
    await bot.shop.issue(77);
    expect(jobs.at(-1)).toMatchObject({ fig: 'actor', fx: 'holo' });
    // вернул звёзды за эффект — стикер снова без эффекта
    await openStarters(bot);
    await fx('dance', 'holo');
    await bot.shop.issue(77);
    expect((await store.shopUser(77))?.issued).toContain('dance~holo');
    const u = (await store.shopUser(77))!;
    await store.saveShopUser({ ...u, items: u.items.filter((i) => i !== 'holo') });
    await bot.shop.issue(77);
    expect((await store.shopUser(77))?.issued).toContain('dance');
    expect((await store.shopUser(77))?.issued).not.toContain('dance~holo');
  });

  it('готовый стикер: цвет надписи без покупки, с эффектом — вместе; приманка всегда в VHS и не меняется', async () => {
    const set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const jobs: unknown[] = [];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined), drawMy: async (look) => (jobs.push(look), Buffer.from('webm')) });
    const look = (id: string, fx: string | null, color?: unknown) => bot.handle('POST', '/shop/fx', {}, { initData: initData(ANYA), id, fx, ...(color !== undefined ? { color } : {}) });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    await bot.shop.issue(77);
    // приманка — готовым файлом в VHS, без рисования на сервере
    expect((await store.shopUser(77))?.issued).toContain('lure~vhs');
    expect(jobs).toEqual([]);
    expect((await look('lure', null, 2)).status).toBe(400);
    expect((await look('hi', null, 9)).status).toBe(400);
    expect((await look('hi', null, 1.5)).status).toBe(400);
    // цвет — бесплатно
    calls.length = 0;
    const r = await look('hi', null, 3);
    expect(r.status).toBe(200);
    expect((r.body as { col: Record<string, number> }).col).toEqual({ hi: 3 });
    await bot.shop.issue(77);
    expect(jobs.at(-1)).toEqual({ std: 'hi', fx: null, color: 3, lang: 'ru' });
    expect((await store.shopUser(77))?.issued).toContain('hi~c3');
    expect(calls.find((c) => c.method === 'replaceStickerInSet')?.body.old_sticker).toBe('f0');
    // эффект без поля цвета — цвет остаётся
    await hook(bot, payment({ invoice_payload: 'fire:77', total_amount: 49, telegram_payment_charge_id: 'ch_fire' }));
    await look('hi', 'fire');
    await bot.shop.issue(77);
    expect(jobs.at(-1)).toEqual({ std: 'hi', fx: 'fire', color: 3, lang: 'ru' });
    expect((await store.shopUser(77))?.issued).toContain('hi~fire.c3');
    // родной цвет и без эффекта — снова файл
    calls.length = 0;
    await look('hi', null, null);
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'replaceStickerInSet')?.files[0]).toContain('hi.webm');
    expect((await store.shopUser(77))?.issued).toContain('hi');
  });

  it('игрок удалил «Собери свой пак!» руками в Telegram — при следующем обновлении пака она возвращается', async () => {
    let set = { stickers: [...['👋', '💃', '😵', '🤨', '🎁'].map((e, i) => ({ file_id: `f${i}`, emoji: e }))] };
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? set : undefined) });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    await bot.shop.issue(77);
    // удалил приманку в Telegram, потом убрал «Привет» на странице стикерпака
    set = { stickers: set.stickers.filter((x) => x.emoji !== '🎁') };
    calls.length = 0;
    await bot.handle('POST', '/shop/pick', {}, { initData: initData(ANYA), id: 'hi', on: false });
    await bot.shop.issue(77);
    expect(calls.filter((c) => c.method === 'addStickerToSet').flatMap((c) => c.files.map((f) => f.split(':')[1]))).toEqual(['lure~vhs.webm']);
    expect((await store.shopUser(77))?.issued).toContain('lure~vhs');
    // приманка на месте — ничего не добавляется
    set = { stickers: [...set.stickers, { file_id: 'fL', emoji: '🎁' }] };
    calls.length = 0;
    await bot.handle('POST', '/shop/pick', {}, { initData: initData(ANYA), id: 'hi', on: true });
    await bot.shop.issue(77);
    expect(calls.filter((c) => c.method === 'addStickerToSet').flatMap((c) => c.files.map((f) => f.split(':')[1]))).toEqual(['hi.webm']);
  });

  it('стикер, убранный из набора («Я не плачу», 27.11), уходит и из выданного пака', async () => {
    const inPack = [{ file_id: 'F_cry', emoji: '😭' }, { file_id: 'F_banana', emoji: '🍌' }];
    const { bot, calls, store } = makeBot({ result: (m) => (m === 'getStickerSet' ? { stickers: inPack } : undefined) });
    await hook(bot, payment());
    await bot.shop.issue(77);
    const u = (await store.shopUser(77))!;
    await store.saveShopUser({ ...u, issued: ['notCrying', ...u.issued] });
    calls.length = 0;
    await bot.shop.issue(77);
    expect(calls.find((c) => c.method === 'deleteStickerFromSet')?.body).toEqual({ sticker: 'F_cry' });
    expect((await store.shopUser(77))?.issued).not.toContain('notCrying');
  });

  it('свои стикеры: места открываются постепенно (1 сразу, +1 за 3 матча, до пяти), правки — не чаще 12 в час', async () => {
    const { bot, calls } = makeBot({ drawMy: async () => Buffer.from('webm') });
    await played(bot);
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    const my = (caption: string) => bot.handle('POST', '/shop/my', {}, { initData: initData(ANYA), sticker: { fig: 'actor', pose: 'wave', color: 0, caption } });
    const state = async () => (await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { slots: number; slotIn: number | null };
    expect(await state()).toMatchObject({ slots: 1, slotIn: 3 });
    expect((await my('Раз')).status).toBe(200);
    expect((await my('Два')).body).toEqual({ error: 'full' });
    await played(bot);
    await played(bot);
    expect(await state()).toMatchObject({ slots: 1, slotIn: 1 });
    calls.length = 0;
    await played(bot);
    expect(await state()).toMatchObject({ slots: 2, slotIn: 3 });
    expect(calls.find((c) => c.method === 'sendMessage')?.body.text).toContain('2 из 5');
    for (let i = 0; i < 9; i++) await played(bot);
    expect(await state()).toMatchObject({ slots: 5, slotIn: null });
    for (let i = 0; i < 4; i++) expect((await my(`Ещё ${i}`)).status).toBe(200);
    expect((await my('Шестой')).body).toEqual({ error: 'full' });
    for (let i = 0; i < 5; i++) await my(`Правка ${i}`);
    expect((await my('Хватит')).body).toEqual({ error: 'rate' });
  });

  it('учёт по туннелю: свои стикеры проверяются, чужие записи в issued — отказ', async () => {
    const store = new MemoryStore();
    const ledger = localLedger(store);
    const user = { userId: 5, lang: 'ru', name: 'Аня', items: ['pack', 'starter', 'off:dance'], pack: null, issued: ['hi', 'my0.1'], my: [{ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, text: ['Йо'] }] };
    expect((await shopLedgerOp(ledger, { op: 'save', user })).status).toBe(200);
    expect((await store.shopUser(5))?.my).toHaveLength(1);
    expect((await shopLedgerOp(ledger, { op: 'save', user: { ...user, my: [{ ...user.my[0], text: ['@spam'] }] } })).status).toBe(400);
    expect((await shopLedgerOp(ledger, { op: 'save', user: { ...user, my: [user.my[0], user.my[0]] } })).status).toBe(400);
    expect((await shopLedgerOp(ledger, { op: 'save', user: { ...user, issued: ['my9.1'] } })).status).toBe(400);
    // старый бот (без my) — свои стикеры не стираются
    const { my: _drop, ...old } = user;
    void _drop;
    expect((await shopLedgerOp(ledger, { op: 'save', user: old })).status).toBe(200);
    expect((await store.shopUser(5))?.my).toHaveLength(1);
  });

  it('рисование своего стикера (/internal/sticker): снаружи 404, изнутри — WEBM; кривой выбор — 400', async () => {
    const looks: unknown[] = [];
    const srv = new GameServer({
      authSecret: 'x'.repeat(32),
      log: silentLogger,
      trustProxy: true,
      store: new MemoryStore(),
      stickers: {
        render: async (look) => {
          if ((look as { fig?: string }).fig !== 'actor') throw new Error('bad_sticker');
          looks.push(look);
          return Buffer.from('WEBM');
        },
      },
    });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const body = JSON.stringify({ fig: 'actor', pose: 'wave', color: 0, text: ['Йо'] });
      expect((await fetch(`http://127.0.0.1:${port}/internal/sticker`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body })).status).toBe(404);
      expect(looks).toHaveLength(0);
      const r = await fetch(`http://127.0.0.1:${port}/internal/sticker`, { method: 'POST', body });
      expect(r.headers.get('content-type')).toBe('video/webm');
      expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('WEBM');
      expect((await fetch(`http://127.0.0.1:${port}/internal/sticker`, { method: 'POST', body: '{"fig":"x"}' })).status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});

