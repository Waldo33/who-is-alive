import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot';
import { silentLogger } from '../src/log';
import { GameServer } from '../src/server';
import { RemoteLedger, packName, shopLedgerOp, wantedStickers } from '../src/shop';
import { MemoryStore } from '../src/store';

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

interface Call {
  method: string;
  body: Record<string, unknown>;
  files: string[];
}

function makeBot(opts: { fail?: (method: string) => string | null; store?: MemoryStore; ledger?: ConstructorParameters<typeof Bot>[0]['shopLedger'] } = {}) {
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
    const result = method === 'getMe' ? { username: 'be_nobody_bot' } : method === 'createInvoiceLink' ? 'https://t.me/$invoice' : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const store = opts.store ?? new MemoryStore();
  const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, stickersDir: STICKERS, shopLedger: opts.ledger });
  return { bot, calls, store };
}

const ANYA = { id: 77, first_name: 'Аня @spam', language_code: 'ru' };
const hook = (bot: Bot, upd: unknown) => bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
const payment = (over: Record<string, unknown> = {}) => ({
  message: {
    chat: { id: 77, type: 'private' },
    from: ANYA,
    successful_payment: { currency: 'XTR', total_amount: 199, invoice_payload: 'kotBanan:77', telegram_payment_charge_id: 'ch_1', ...over },
  },
});

describe('гардероб', () => {
  it('бесплатный пак: один пак на игрока с 4 стикерами актёра, повтор ничего не создаёт', async () => {
    const { bot, calls } = makeBot();
    const r = await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ items: ['starter'], pack: 'https://t.me/addstickers/m77_by_be_nobody_bot', issued: 4, wanted: 4 });
    const create = calls.filter((c) => c.method === 'createNewStickerSet');
    expect(create).toHaveLength(1);
    // имя без @: подпись пака уходит в Telegram
    expect(create[0].body.title).toBe('Массовка · Аня spam · @be_nobody_bot');
    expect((create[0].body.stickers as { format: string }[]).map((s) => s.format)).toEqual(['video', 'video', 'video', 'video']);
    expect(create[0].files.map((f) => f.split(':')[1])).toEqual(['hi.webm', 'dance.webm', 'oops.webm', 'who.webm']);
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('стикерпак'))).toBe(true);

    calls.length = 0;
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(calls.filter((c) => /StickerSet|StickerToSet/.test(c.method))).toHaveLength(0);
  });

  it('покупка: счёт в звёздах; проверка перед оплатой — тот ли игрок и цена; оплата даёт набор и 2 стикера', async () => {
    const { bot, calls, store } = makeBot();
    const buy = await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'kotBanan' });
    expect(buy).toEqual({ status: 200, body: { link: 'https://t.me/$invoice' } });
    const inv = calls.find((c) => c.method === 'createInvoiceLink')!.body;
    expect(inv).toMatchObject({ currency: 'XTR', payload: 'kotBanan:77', prices: [{ amount: 199 }] });
    expect(inv.provider_token).toBeUndefined();
    expect((await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'nope' })).status).toBe(400);

    const pre = async (q: Record<string, unknown>) => {
      calls.length = 0;
      await hook(bot, { pre_checkout_query: { id: 'q', from: { id: 77 }, currency: 'XTR', total_amount: 199, invoice_payload: 'kotBanan:77', ...q } });
      return calls.find((c) => c.method === 'answerPreCheckoutQuery')!.body.ok;
    };
    expect(await pre({})).toBe(true);
    expect(await pre({ from: { id: 78 } })).toBe(false);
    expect(await pre({ total_amount: 1 })).toBe(false);
    expect(await pre({ invoice_payload: 'starter:77' })).toBe(false);

    calls.length = 0;
    expect((await hook(bot, payment())).status).toBe(200);
    const u = await store.shopUser(77);
    expect(u?.items).toEqual(['kotBanan']);
    expect(u?.issued).toEqual(['notCrying', 'justBanana']);
    expect(calls.find((c) => c.method === 'sendMessage')!.body.text).toContain('Кот-банан');

    // Telegram повторил обновление — второй раз не выдаём и не пишем
    calls.length = 0;
    await hook(bot, payment());
    expect(calls.filter((c) => c.method !== 'getMe')).toHaveLength(0);
    // уже куплено — второй счёт не выставляем, и перед оплатой — отказ
    expect((await bot.handle('POST', '/shop/buy', {}, { initData: initData(ANYA), item: 'kotBanan' })).status).toBe(409);
    expect(await pre({})).toBe(false);
  });

  it('бесплатный пак после покупки — стикеры актёра добавляются в тот же пак', async () => {
    const { bot, calls, store } = makeBot();
    await hook(bot, payment());
    calls.length = 0;
    await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'addStickerToSet')).toHaveLength(4);
    expect((await store.shopUser(77))?.issued).toHaveLength(6);
  });

  it('сбой Telegram: выдано записано, остальное дошлётся при заходе в гардероб; без «Старт» у бота — need_bot', async () => {
    let down = true;
    const { bot, calls } = makeBot({ fail: (m) => (m === 'createNewStickerSet' && down ? 'Bad Request: PEER_ID_INVALID' : null) });
    const r = await bot.handle('POST', '/shop/claim', {}, { initData: initData(ANYA) });
    expect(r.body).toMatchObject({ pack: null, issued: 0, wanted: 4, error: 'need_bot' });
    down = false;
    calls.length = 0;
    await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    await new Promise((res) => setTimeout(res, 50));
    expect(calls.filter((c) => c.method === 'createNewStickerSet')).toHaveLength(1);
    const st = await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) });
    expect(st.body).toMatchObject({ issued: 4, error: null });
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
    };
    const { bot } = makeBot({ store, ledger });
    expect((await hook(bot, payment())).status).toBe(500);
  });

  it('возврат: звёзды назад, набор забран — только изнутри машины', async () => {
    const { bot, calls, store } = makeBot();
    await hook(bot, payment());
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, trustProxy: true, store, bot });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const url = `http://127.0.0.1:${port}/internal/tg/refund`;
      expect((await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ charge: 'ch_1' }) })).status).toBe(404);
      const r = await fetch(url, { method: 'POST', body: JSON.stringify({ charge: 'ch_1' }) });
      expect(r.status).toBe(200);
      expect(calls.find((c) => c.method === 'refundStarPayment')?.body).toEqual({ user_id: 77, telegram_payment_charge_id: 'ch_1' });
      expect((await store.shopUser(77))?.items).toEqual([]);
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

    expect((await shopLedgerOp(store, { op: 'save', user: { userId: 1, lang: 'ru', name: 'x', items: ['kotBanan'], pack: 'evil pack', issued: [] } })).status).toBe(400);
    expect((await shopLedgerOp(store, { op: 'save', user: { userId: 1, lang: 'ru', name: 'x', items: [], pack: null, issued: ['nope'] } })).status).toBe(400);
    expect((await shopLedgerOp(store, { op: 'pay', payment: { charge: 'c', userId: 1, item: 'nope', stars: 1 } })).status).toBe(400);
    expect((await shopLedgerOp(store, { op: 'drop' })).status).toBe(400);

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
    expect(wantedStickers(['kotBanan', 'st:aaa']).map((s) => s.id)).toEqual(['notCrying', 'justBanana', 'aaa']);
    expect(packName('  Вася‮ https://x.y @boss ')).toBe('Вася x.y boss');
  });
});
