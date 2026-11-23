import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
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

function makeBot(clipDir?: string) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    const result = method === 'getMe' ? { username: 'be_nobody_bot', supports_inline_queries: true } : method === 'savePreparedInlineMessage' ? { id: 'prep1' } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as unknown as typeof fetch;
  const store = new MemoryStore();
  const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, features: ['casting'], clipDir });
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

  it('«поделиться» из Mini App: карточка комнаты со ссылкой startapp', async () => {
    const { bot, calls } = makeBot();
    const r = await bot.handle('POST', '/prepare', {}, { initData: initData({ id: 5 }), kind: 'room', code: 'WXYZ' });
    expect(r.body).toEqual({ id: 'prep1' });
    const prep = calls.find((c) => c.method === 'savePreparedInlineMessage')!;
    expect(JSON.stringify(prep.body)).toContain('https://t.me/be_nobody_bot/play?startapp=r_WXYZ');
  });

  it('клип: загрузка с подписью initData, файл по ссылке, видео-карточка в чат', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clips-'));
    const { bot, calls } = makeBot(dir);
    const video = Buffer.alloc(5000, 7);
    const init = initData({ id: 9, language_code: 'ru' });
    expect((await bot.handle('POST', '/clip', { 'content-type': 'video/mp4' }, video)).status).toBe(401);
    expect((await bot.handle('POST', '/clip', { 'content-type': 'text/plain', 'x-tg-init': init }, video)).status).toBe(400);
    const up = await bot.handle('POST', '/clip', { 'content-type': 'video/mp4;codecs=avc1', 'x-tg-init': init }, video);
    const { id, ext } = up.body as { id: string; ext: string };
    expect(ext).toBe('mp4');
    expect(id).toMatch(/^[0-9a-f]{20}$/);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect((await bot.handle('POST', `/clip/${id}/thumb`, { 'x-tg-init': init }, jpg)).status).toBe(200);
    const f = await bot.handle('GET', `/clips/${id}.mp4`, {}, null);
    expect(f.file?.mime).toBe('video/mp4');
    expect(readFileSync(f.file!.path).length).toBe(5000);
    expect((await bot.handle('GET', `/clips/${'0'.repeat(20)}.mp4`, {}, null)).status).toBe(404);
    expect((await bot.handle('GET', `/clips/../../etc/passwd`, {}, null)).file).toBeUndefined();
    const r = await bot.handle('POST', '/prepare', {}, { initData: init, kind: 'clip', clip: id, text: 'Вырезал!' });
    expect(r.body).toEqual({ id: 'prep1' });
    const res = calls.find((c) => c.method === 'savePreparedInlineMessage')!.body.result as Record<string, string>;
    expect(res.type).toBe('video');
    expect(res.video_url).toBe(`https://api.example/tg/clips/${id}.mp4`);
    expect(res.thumbnail_url).toBe(`https://api.example/tg/clips/${id}.jpg`);
    expect(res.caption).toBe('Вырезал!');
    expect((await bot.handle('POST', '/prepare', {}, { initData: init, kind: 'clip', clip: 'f'.repeat(20) })).status).toBe(404);
  });
});

describe('клип через HTTP-сервер', () => {
  it('сырое тело до 12 МБ доходит до бота, файл отдаётся с attachment', async () => {
    const { GameServer } = await import('../src/server');
    const dir = mkdtempSync(join(tmpdir(), 'clips-'));
    const { bot } = makeBot(dir);
    const srv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, bot });
    const port = await srv.listen(0, '127.0.0.1');
    try {
      const video = Buffer.alloc(3 * 1024 * 1024, 3);
      const up = await fetch(`http://127.0.0.1:${port}/tg/clip`, {
        method: 'POST',
        headers: { 'content-type': 'video/mp4', 'x-tg-init': initData({ id: 4 }), origin: 'https://benobody.app' },
        body: video,
      });
      expect(up.status).toBe(200);
      expect(up.headers.get('access-control-allow-origin')).toBe('https://benobody.app');
      const { id } = (await up.json()) as { id: string };
      const f = await fetch(`http://127.0.0.1:${port}/tg/clips/${id}.mp4`);
      expect(f.status).toBe(200);
      expect(f.headers.get('content-disposition')).toContain('attachment');
      expect((await f.arrayBuffer()).byteLength).toBe(video.length);
      const pre = await fetch(`http://127.0.0.1:${port}/tg/clip`, { method: 'OPTIONS', headers: { origin: 'https://benobody.app' } });
      expect(pre.headers.get('access-control-allow-headers')).toContain('x-tg-init');
    } finally {
      await srv.close();
    }
  });
});
