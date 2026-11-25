import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bot, dailyNow } from '../src/bot';
import { silentLogger } from '../src/log';
import { MemoryStore } from '../src/store';

const TOKEN = '123456:TEST-token';

/** initData, подписанный как в Telegram. */
function initData(user: object, extra: Record<string, string> = {}, auth = Math.floor(Date.now() / 1000)): string {
  const p = new URLSearchParams({ auth_date: String(auth), user: JSON.stringify(user), ...extra });
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

function makeBot() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    const result = method === 'getMe' ? { username: 'be_nobody_bot', supports_inline_queries: true } : method === 'savePreparedInlineMessage' ? { id: 'prep1' } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const store = new MemoryStore();
  const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, features: ['casting'], clipBase: 'https://msk.example' });
  return { bot, calls, store };
}

describe('Telegram-бот', () => {
  it('подпись initData: своя проходит, чужая и старая — нет', () => {
    const { bot } = makeBot();
    const good = initData({ id: 7, first_name: 'Аня' }, { chat_instance: '-100' });
    expect(bot.verify(good)?.user.id).toBe(7);
    expect(bot.verify(good.replace('chat_instance=-100', 'chat_instance=-101'))).toBeNull();
    expect(bot.verify(initData({ id: 7 }, {}, Math.floor(Date.now() / 1000) - 90_000))).toBeNull();
  });

  it('вебхук без секрета — 403; /start в личке — кнопка web_app на сайт', async () => {
    const { bot, calls } = makeBot();
    const upd = { message: { chat: { id: 1, type: 'private' }, text: '/start r_ABCD', from: { language_code: 'ru' } } };
    expect((await bot.handle('POST', '/hook', {}, upd)).status).toBe(403);
    const r = await bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
    expect(r.status).toBe(200);
    const send = calls.find((c) => c.method === 'sendMessage')!;
    expect(JSON.stringify(send.body)).toContain('https://site.example/r/ABCD?src=tg');
  });

  it('/start без параметра: «Играть» — сразу матч с ИИ, «С друзьями» — новая комната', async () => {
    const { bot, calls } = makeBot();
    const upd = { message: { chat: { id: 1, type: 'private' }, text: '/start', from: { language_code: 'ru' } } };
    await bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
    const kb = (calls.find((c) => c.method === 'sendMessage')!.body as { reply_markup: { inline_keyboard: { text: string; web_app: { url: string } }[][] } }).reply_markup.inline_keyboard;
    expect(kb[0][0].web_app.url).toBe('https://site.example/sandbox?go&src=tg');
    expect(kb[1][0].web_app.url).toBe('https://site.example/?create=1&src=tg');
  });

  it('кастинг: первый результат за день окончательный, рейтинг чата по победам и попыткам', async () => {
    const { bot } = makeBot();
    const n = dailyNow();
    const a = initData({ id: 1, first_name: 'A' }, { chat_instance: 'c1' });
    const b = initData({ id: 2, first_name: 'B' }, { chat_instance: 'c1' });
    await bot.handle('POST', '/daily', {}, { initData: a, n, tries: 3, won: true });
    await bot.handle('POST', '/daily', {}, { initData: a, n, tries: 1, won: true });
    const r = await bot.handle('POST', '/daily', {}, { initData: b, n, tries: 2, won: true });
    const board = (r.body as { board: { name: string; tries: number; me: boolean }[] }).board;
    expect(board.map((x) => [x.name, x.tries, x.me])).toEqual([
      ['B', 2, true],
      ['A', 3, false],
    ]);
    expect((await bot.handle('POST', '/daily', {}, { initData: a, n: n + 5, tries: 1, won: true })).status).toBe(400);
  });

  it('инлайн-режим: первой — «Собрать комнату» со своей меткой; набран код — сначала эта комната', async () => {
    const { bot, calls } = makeBot();
    const hdr = { 'x-telegram-bot-api-secret-token': bot.hookSecret };
    const ask = async (query: string) => {
      calls.length = 0;
      await bot.handle('POST', '/hook', hdr, { inline_query: { id: 'q', query, from: { language_code: 'ru' } } });
      const body = calls.find((c) => c.method === 'answerInlineQuery')!.body as { cache_time: number; results: { id: string; reply_markup: { inline_keyboard: { url: string }[][] } }[] };
      return { cache: body.cache_time, results: body.results, urls: body.results.map((r) => r.reply_markup.inline_keyboard[0][0].url) };
    };
    const a = await ask('');
    expect(a.cache).toBe(0);
    expect(a.results[0].id).toMatch(/^lobby-/);
    expect(a.urls[0]).toMatch(/^https:\/\/t\.me\/be_nobody_bot\/play\?startapp=g_[A-Za-z0-9]{12}$/);
    const b = await ask('');
    expect(b.urls[0]).not.toBe(a.urls[0]);
    const c = await ask('abcd');
    expect(c.urls[0]).toBe('https://t.me/be_nobody_bot/play?startapp=r_ABCD');
    expect(c.urls[1]).toMatch(/startapp=g_/);
  });

  it('«поделиться» из Mini App: карточка комнаты со ссылкой startapp', async () => {
    const { bot, calls } = makeBot();
    const r = await bot.handle('POST', '/prepare', {}, { initData: initData({ id: 5 }), kind: 'room', code: 'WXYZ' });
    expect(r.body).toEqual({ id: 'prep1' });
    const prep = calls.find((c) => c.method === 'savePreparedInlineMessage')!;
    expect(JSON.stringify(prep.body)).toContain('https://t.me/be_nobody_bot/play?startapp=r_WXYZ');
  });

  it('видео-карточка клипа: ссылка на игровой сервер (Москва), подпись, обложка', async () => {
    const { bot, calls } = makeBot();
    const init = initData({ id: 9, language_code: 'ru' });
    const id = 'ab'.repeat(10);
    const r = await bot.handle('POST', '/prepare', {}, { initData: init, kind: 'clip', clip: id, text: 'Вырезал!', thumb: true });
    expect(r.body).toEqual({ id: 'prep1' });
    const res = calls.find((c) => c.method === 'savePreparedInlineMessage')!.body.result as Record<string, string>;
    expect(res.type).toBe('video');
    expect(res.video_url).toBe(`https://msk.example/v1/clips/${id}.mp4`);
    expect(res.thumbnail_url).toBe(`https://msk.example/v1/clips/${id}.jpg`);
    expect(res.caption).toBe('Вырезал!');
  });
});

describe('клипы на игровом сервере (/v1/clips)', () => {
  it('загрузка потоком с токеном игрока, обложка, файл с attachment; без токена и больше 12 МБ — нет', async () => {
    const { GameServer } = await import('../src/server');
    const { ClipStore } = await import('../src/clips');
    const dir = mkdtempSync(join(tmpdir(), 'clips-'));
    const srv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, clips: new ClipStore(dir) });
    const port = await srv.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    try {
      const { token } = (await (await fetch(`${base}/v1/auth/anon`, { method: 'POST' })).json()) as { token: string };
      const video = Buffer.alloc(3 * 1024 * 1024, 3);
      expect((await fetch(`${base}/v1/clips`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: video })).status).toBe(401);
      const auth = { authorization: `Bearer ${token}` };
      expect((await fetch(`${base}/v1/clips`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: video })).status).toBe(400);
      const big = await fetch(`${base}/v1/clips`, { method: 'POST', headers: { ...auth, 'content-type': 'video/mp4' }, body: Buffer.alloc(13 * 1024 * 1024) });
      expect(big.status).toBe(413);
      const up = await fetch(`${base}/v1/clips`, { method: 'POST', headers: { ...auth, 'content-type': 'video/mp4;codecs=avc1', origin: 'https://benobody.app' }, body: video });
      expect(up.status).toBe(200);
      const { id, ext } = (await up.json()) as { id: string; ext: string };
      expect(ext).toBe('mp4');
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      expect((await fetch(`${base}/v1/clips/${id}/thumb`, { method: 'POST', headers: auth, body: Buffer.from('nope') })).status).toBe(400);
      expect((await fetch(`${base}/v1/clips/${id}/thumb`, { method: 'POST', headers: auth, body: jpg })).status).toBe(200);
      const f = await fetch(`${base}/v1/clips/${id}.mp4`);
      expect(f.status).toBe(200);
      expect(f.headers.get('content-type')).toBe('video/mp4');
      expect(f.headers.get('content-disposition')).toContain('attachment');
      expect((await f.arrayBuffer()).byteLength).toBe(video.length);
      expect((await fetch(`${base}/v1/clips/${id}.jpg`)).status).toBe(200);
      expect((await fetch(`${base}/v1/clips/${'0'.repeat(20)}.mp4`)).status).toBe(404);
      expect(readdirSync(dir).sort()).toEqual([`${id}.jpg`, `${id}.mp4`]);
      // место под клипы — в метриках (тревога сторожа и график в Grafana)
      const m = await (await fetch(`${base}/metrics`)).text();
      expect(m).toContain('game_clips_count 1');
      expect(m).toMatch(new RegExp(`game_clips_bytes ${video.length + jpg.length}\\b`));
      expect(m).toContain(`game_clips_limit_bytes ${1024 * 1024 * 1024}`);
    } finally {
      await srv.close();
    }
  });
});
