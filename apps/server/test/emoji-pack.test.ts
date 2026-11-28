import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMOJI_BASE, REWARDS } from '@kto/game-core';
import { Bot } from '../src/bot';
import { silentLogger } from '../src/log';
import { MemoryStore } from '../src/store';

/** Личный эмодзи-пак игрока (shop.ts › emojiRun, game-core/emoji-pack.ts). */

const TOKEN = '123456:TEST-token';
const STICKERS = join(import.meta.dirname, '..', 'stickers');
const ANYA = { id: 77, first_name: 'Аня', language_code: 'ru' };

function initData(user: object): string {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

function makeBot(fail?: (method: string, body: Record<string, unknown>) => string | null) {
  const calls: { method: string; body: Record<string, unknown>; files: string[] }[] = [];
  const fetchImpl = (async (url: string, init: { body: string | FormData }) => {
    const method = url.split('/').pop()!;
    let body: Record<string, unknown> = {};
    const files: string[] = [];
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') body[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        else files.push((v as File).name);
      }
    } else body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body, files });
    const err = fail?.(method, body);
    if (err) return new Response(JSON.stringify({ ok: false, description: err }));
    return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { username: 'be_nobody_bot' } : true }));
  }) as unknown as typeof fetch;
  const store = new MemoryStore();
  const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, stickersDir: STICKERS });
  return { bot, calls, store };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('личный эмодзи-пак', () => {
  it('в папке есть файл на каждое эмодзи пака; общие — те же, что в наборе владельца (list.json)', () => {
    const list = JSON.parse(readFileSync(join(STICKERS, 'emoji', 'list.json'), 'utf8')) as { id: string; emoji: string }[];
    expect(list).toEqual(EMOJI_BASE);
    for (const e of [...EMOJI_BASE, ...REWARDS]) expect(() => readFileSync(join(STICKERS, 'emoji', `${e.id}.png`)), e.id).not.toThrow();
  });

  it('«Забрать»: бот создаёт набор игрока с 30 общими и уже открытыми наградами, отдаёт ссылку', async () => {
    const { bot, calls, store } = makeBot();
    await store.saveShopUser({ userId: 77, lang: 'ru', name: 'Аня', items: ['kotBanan', 'st:penguin'], pack: null, issued: [] });
    const r = await bot.handle('POST', '/shop/emoji', {}, { initData: initData(ANYA) });
    expect(r.status).toBe(200);
    await settle();
    const made = calls.find((c) => c.method === 'createNewStickerSet')!;
    expect(made.body).toMatchObject({ user_id: '77', name: 'e77_by_be_nobody_bot', sticker_type: 'custom_emoji' });
    expect(made.files).toHaveLength(EMOJI_BASE.length + 2);
    expect(made.files).toEqual(expect.arrayContaining(['buy_kotBanan.webm', 'th_penguins.webm', 'fire.webm']));
    const st = (await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { emoji: { claimed: boolean; pack: string; pending: number; open: string[] } };
    expect(st.emoji).toMatchObject({ claimed: true, pack: 'https://t.me/addemoji/e77_by_be_nobody_bot', pending: 0 });
    expect(st.emoji.open).toEqual(expect.arrayContaining(['buy_kotBanan', 'th_penguins']));
  });

  it('награда за матч докладывается в набор и бот пишет игроку; повтор не кладёт второй раз', async () => {
    const { bot, calls, store } = makeBot();
    await store.saveShopUser({ userId: 77, lang: 'ru', name: 'Аня', items: [], pack: null, issued: [] });
    await bot.handle('POST', '/shop/emoji', {}, { initData: initData(ANYA) });
    await settle();
    const users = [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: [], rewards: ['th_miami', 'ev_cut'] }];
    await bot.shop.earn({ users });
    const added = calls.filter((c) => c.method === 'addStickerToSet');
    expect(added.map((c) => c.files[0])).toEqual(['th_miami.webm', 'ev_cut.webm']);
    expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('эмодзи'))).toBe(true);
    await bot.shop.earn({ users });
    expect(calls.filter((c) => c.method === 'addStickerToSet')).toHaveLength(2);
  });

  it('без «Забрать» награды только копятся, набор не создаётся; чужие id наград отбрасываются', async () => {
    const { bot, calls, store } = makeBot();
    const r = await bot.shop.earn({ users: [{ tgUser: 78, name: 'Боря', lang: 'ru', stickers: [], rewards: ['th_casino'] }] });
    expect(r.users).toBe(1);
    expect((await store.shopUser(78))?.items).toContain('em:th_casino');
    expect(calls.some((c) => c.method === 'createNewStickerSet' || c.method === 'addStickerToSet')).toBe(false);
    expect((await bot.shop.earn({ users: [{ tgUser: 78, name: 'Боря', lang: 'ru', stickers: [], rewards: ['hack'] }] })).users).toBe(0);
  });

  it('игрок удалил набор в Telegram: страница замечает, бот собирает его заново — имя занято, значит следующим', async () => {
    const dead = new Set<string>();
    const { bot, calls, store } = makeBot((m, b) => {
      const name = String(b.name ?? '');
      if ((m === 'getStickerSet' || m === 'addStickerToSet') && dead.has(name)) return 'Bad Request: STICKERSET_INVALID';
      if (m === 'createNewStickerSet' && dead.has(name)) return 'Bad Request: sticker set name is already occupied';
      return null;
    });
    await store.saveShopUser({ userId: 77, lang: 'ru', name: 'Аня', items: [], pack: null, issued: [] });
    await bot.handle('POST', '/shop/emoji', {}, { initData: initData(ANYA) });
    await settle();
    dead.add('e77_by_be_nobody_bot');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      calls.length = 0;
      const st = (await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { emoji: { pack: string | null; pending: number } };
      expect(st.emoji).toMatchObject({ pack: null, pending: EMOJI_BASE.length });
      await settle();
      expect(calls.filter((c) => c.method === 'createNewStickerSet').map((c) => c.body.name)).toEqual(['e77_by_be_nobody_bot', 'e77_2_by_be_nobody_bot']);
      const again = (await bot.handle('POST', '/shop', {}, { initData: initData(ANYA) })).body as { emoji: { pack: string; pending: number } };
      expect(again.emoji).toMatchObject({ pack: 'https://t.me/addemoji/e77_2_by_be_nobody_bot', pending: 0 });

      // новая награда, а набор снова удалён (страницу не открывали) — пересобирается при докладке, без ошибки
      dead.add('e77_2_by_be_nobody_bot');
      calls.length = 0;
      await bot.shop.earn({ users: [{ tgUser: 77, name: 'Аня', lang: 'ru', stickers: [], rewards: ['th_miami'] }] });
      await settle();
      expect(calls.filter((c) => c.method === 'createNewStickerSet').map((c) => c.body.name)).toEqual(['e77_by_be_nobody_bot', 'e77_2_by_be_nobody_bot', 'e77_3_by_be_nobody_bot']);
      expect(calls.find((c) => c.method === 'createNewStickerSet' && c.body.name === 'e77_3_by_be_nobody_bot')?.files).toContain('th_miami.webm');
    } finally {
      later.mockRestore();
    }
  });
});
