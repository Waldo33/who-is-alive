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

  it('/start без параметра: «Играть» — новая комната (лобби), «Сыграть с ботами» — матч с ИИ', async () => {
    const { bot, calls } = makeBot();
    const upd = { message: { chat: { id: 1, type: 'private' }, text: '/start', from: { language_code: 'ru' } } };
    await bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
    const kb = (calls.find((c) => c.method === 'sendMessage')!.body as { reply_markup: { inline_keyboard: { text: string; web_app: { url: string } }[][] } }).reply_markup.inline_keyboard;
    expect(kb[0][0].web_app.url).toBe('https://site.example/?create=1&src=tg');
    expect(kb[1][0].web_app.url).toBe('https://site.example/sandbox?go&src=tg');
    expect(JSON.stringify(kb.at(-1))).toContain('https://t.me/benobody_app');
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

describe('фильм матча в чат приглашения', () => {
  const hdr = (bot: Bot) => ({ 'x-telegram-bot-api-secret-token': bot.hookSecret });
  const film = { invite: 'AbCd1234xyz9', id: 'cd'.repeat(10), code: 'WXYZ', winners: ['Аня'], draw: false };

  it('карточку «Собрать комнату» отправили — в конце матча она становится видео «Снято!» и «Реванш»', async () => {
    const { bot, calls, store } = makeBot();
    // без отправленной карточки — молчим
    expect((await bot.film(film)).body).toEqual({ sent: false });
    await bot.handle('POST', '/hook', hdr(bot), { chosen_inline_result: { result_id: 'lobby-AbCd1234xyz9', inline_message_id: 'IM1', from: { language_code: 'ru' } } });
    // чужие карточки и без inline_message_id — не запоминаем
    await bot.handle('POST', '/hook', hdr(bot), { chosen_inline_result: { result_id: 'invite', inline_message_id: 'IM2', from: {} } });
    await bot.handle('POST', '/hook', hdr(bot), { chosen_inline_result: { result_id: 'lobby-Zzzz1234xyz9', from: {} } });
    expect([...store.cards.keys()]).toEqual(['AbCd1234xyz9']);
    calls.length = 0;
    expect((await bot.film(film)).body).toEqual({ sent: true });
    const edit = calls.find((c) => c.method === 'editMessageMedia')!.body as {
      inline_message_id: string;
      media: { type: string; media: string; caption: string };
      reply_markup: { inline_keyboard: { url: string; text: string }[][] };
    };
    expect(edit.inline_message_id).toBe('IM1');
    expect(edit.media.type).toBe('video');
    expect(edit.media.media).toBe(`https://msk.example/v1/clips/${'cd'.repeat(10)}.mp4`);
    expect(edit.media.caption).toContain('WXYZ');
    expect(edit.media.caption).toContain('Звезда фильма — Аня');
    // та же метка — та же комната
    expect(edit.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/be_nobody_bot/play?startapp=g_AbCd1234xyz9');
    expect((await bot.film({ ...film, id: '../x' })).status).toBe(400);
  });

  it('живая карточка: сбор «2 из 4» с именами, «осталось одно место», съёмка со счётом, правки не чаще раза в 3 с', async () => {
    const { bot, calls, store } = makeBot();
    const card = { invite: 'AbCd1234xyz9', code: 'WXYZ' };
    // карточку ещё не отправили — молчим; мусор — 400
    expect((await bot.card({ ...card, state: 'lobby', seats: [{ name: 'Енот', color: 0 }], max: 4 })).body).toEqual({ sent: false });
    expect((await bot.card({ ...card, code: 'x', state: 'closed' })).status).toBe(400);
    await store.saveTgCard({ tag: 'AbCd1234xyz9', inlineId: 'IM1', lang: 'ru' });
    calls.length = 0;
    expect((await bot.card({ ...card, state: 'lobby', seats: [{ name: 'Енот', color: 0 }, { name: '@spam http://x', color: 1 }], max: 4 })).body).toEqual({ sent: true });
    const first = calls.find((c) => c.method === 'editMessageText')!.body as { inline_message_id: string; text: string; reply_markup: { inline_keyboard: { url: string }[][] } };
    expect(first.inline_message_id).toBe('IM1');
    expect(first.text).toContain('В кадре: Енот, spam x · 2 из 4');
    expect(first.text).toContain('🟥🟦⬜⬜');
    expect(first.text).toContain('Можно начинать');
    expect(first.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/be_nobody_bot/play?startapp=g_AbCd1234xyz9');
    // через секунду ещё двое — правка ждёт, промежуточное «3 из 4» пропускается
    calls.length = 0;
    expect((await bot.card({ ...card, state: 'lobby', seats: [{ name: 'Енот', color: 0 }, { name: 'B', color: 1 }, { name: 'C', color: 2 }], max: 4 })).body).toEqual({ sent: true, queued: true });
    await bot.card({ ...card, state: 'playing', take: 2, target: 8, scores: [{ name: 'Енот', color: 0, score: 3 }, { name: 'B', color: 1, score: 1 }] });
    expect(calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 3100));
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1);
    const shooting = calls[0].body.text as string;
    expect(shooting).toContain('Идёт съёмка · комната WXYZ · дубль 2');
    expect(shooting).toContain('🟥Енот 3 · 🟦B 1');
    // фильм занял карточку — дальше правится подпись под видео
    await bot.film({ invite: 'AbCd1234xyz9', id: 'cd'.repeat(10), code: 'WXYZ', winners: ['Енот'], draw: false, awards: [{ id: 'clairvoyant', names: ['B'] }, { id: 'nope', names: ['C'] }], score: 'Енот 5 : 3 B' });
    const media = calls.find((c) => c.method === 'editMessageMedia')!.body as { media: { caption: string } };
    expect(media.media.caption).toBe('🎬 Снято! Звезда фильма — Енот\n🏅 Голос за кадром — B\nЕнот 5 : 3 B\nКомната WXYZ. Реванш? Жми кнопку — та же комната.');
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 3100));
    await bot.card({ ...card, state: 'lobby', seats: [{ name: 'Енот', color: 0 }, { name: 'B', color: 1 }, { name: 'C', color: 2 }], max: 4 });
    expect(calls.map((c) => c.method)).toEqual(['editMessageCaption']);
    expect(calls[0].body.caption).toContain('Осталось одно место!');
  }, 10_000);

  it('Telegram не взял видео — карточка становится текстом со ссылкой на ролик', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const method = url.split('/').pop()!;
      calls.push(method + ' ' + init.body);
      if (method === 'editMessageMedia') return new Response(JSON.stringify({ ok: false, description: 'Bad Request: there is no media in the message to edit' }));
      return new Response(JSON.stringify({ ok: true, result: method === 'getMe' ? { username: 'be_nobody_bot' } : true }));
    }) as unknown as typeof fetch;
    const store = new MemoryStore();
    const bot = new Bot({ token: TOKEN, apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl, clipBase: 'https://msk.example' });
    await store.saveTgCard({ tag: 'AbCd1234xyz9', inlineId: 'IM1', lang: 'en' });
    expect((await bot.film({ ...film, winners: ['A', 'B'], draw: true })).body).toEqual({ sent: true, text: true });
    const text = calls.find((c) => c.startsWith('editMessageText'))!;
    expect(text).toContain('Draw: A, B');
    expect(text).toContain(`/v1/clips/${'cd'.repeat(10)}.mp4`);
  });

  it('игровой сервер отдаёт фильм боту изнутри (/internal/tg/film), снаружи этого входа нет', async () => {
    const { GameServer } = await import('../src/server');
    const { bot, calls } = makeBot();
    const botSrv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, bot });
    const port = await botSrv.listen(0, '127.0.0.1');
    const game = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, botInternal: `http://127.0.0.1:${port}` });
    try {
      await bot.handle('POST', '/hook', hdr(bot), { chosen_inline_result: { result_id: 'lobby-AbCd1234xyz9', inline_message_id: 'IM1', from: { language_code: 'ru' } } });
      // снаружи (адрес клиента — не свой) — нет
      const outside = await fetch(`http://127.0.0.1:${port}/internal/tg/film`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(film) });
      expect(outside.status).toBe(404);
      const room = { code: 'WXYZ', invite: 'AbCd1234xyz9' };
      (game as unknown as { filmToChat: (r: unknown, f: unknown) => void }).filmToChat(room, { id: film.id, winners: ['Аня'], draw: false });
      for (let i = 0; i < 200 && !calls.some((c) => c.method === 'editMessageMedia'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(calls.find((c) => c.method === 'editMessageMedia')?.body.inline_message_id).toBe('IM1');
    } finally {
      await botSrv.close();
      await game.close();
    }
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

  it('перепривязка вебхука и состояние бота — только изнутри машины; кривые пути к /internal/* — отказ', async () => {
    const { GameServer, badPath } = await import('../src/server');
    const { request } = await import('node:http');
    const { bot, calls } = makeBot();
    const srv = new GameServer({ authSecret: 'test-secret-test-secret-test-secret!!', log: silentLogger, bot });
    const port = await srv.listen(0, '127.0.0.1');
    // сырой запрос: fetch сам схлопнул бы «..» и обратную косую
    const raw = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end('{}');
      });
    try {
      const out = { 'x-forwarded-for': '203.0.113.7' };
      expect((await fetch(`http://127.0.0.1:${port}/tg/setup`, { headers: out })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/tg/status`, { headers: out })).status).toBe(404);
      expect(calls.some((c) => c.method === 'setWebhook')).toBe(false);
      // изнутри (выкладка по SSH, сторож) — можно
      expect((await fetch(`http://127.0.0.1:${port}/tg/setup`)).status).toBe(200);
      expect(calls.some((c) => c.method === 'setWebhook')).toBe(true);
      // информация для проверок выкладки — по-прежнему всем
      expect((await fetch(`http://127.0.0.1:${port}/tg/info`, { headers: out })).status).toBe(200);
      for (const path of ['/tg/../internal/drain', '/tg/%2e%2e/internal/drain', '/tg/..%2Finternal/drain', '/tg/..\\internal/drain', '/tg/./prepare']) {
        expect(badPath(path)).toBe(true);
        expect(await raw(path, out)).toBe(400);
      }
      expect(srv.draining).toBe(false);
      // обычные пути своих клиентов не задеты
      for (const path of ['/v1/clips/0123456789abcdef0123.mp4', '/v1/puzzles/ABC23/tap', '/tg/prepare', '/v1/rooms/ABCD?x=..%2f']) expect(badPath(path)).toBe(false);
    } finally {
      await srv.close();
    }
  });
});
