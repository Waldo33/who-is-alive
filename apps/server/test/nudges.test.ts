import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAR_MS } from '@kto/game-core';
import { Bot } from '../src/bot';
import { silentLogger } from '../src/log';
import { Nudges, localHour, mayWrite } from '../src/nudges';
import { MemoryStore } from '../src/store';

/** Напоминания бота (nudges.ts): «звезда дубля гаснет», «стикер недели» — кому, когда и как часто. */

const H = 3600_000;

function setup(fail?: (chat: number) => string | null) {
  const store = new MemoryStore();
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  const api = async <R,>(method: string, body: Record<string, unknown>): Promise<R> => {
    const err = method === 'sendMessage' ? fail?.(Number(body.chat_id)) : null;
    if (err) throw new Error(`${method}: ${err}`);
    sent.push({ method, body });
    return true as R;
  };
  const nudges = new Nudges({ api, store, site: 'https://site.example', log: silentLogger });
  const msgs = () => sent.filter((c) => c.method === 'sendMessage');
  return { store, nudges, msgs, sent };
}

/** Игрок Telegram выиграл матч «сейчас» (по поддельным часам). */
async function win(store: MemoryStore, tg: number, lang: 'ru' | 'en' = 'ru') {
  store.links.set(`g${tg}`, { gameUser: `g${tg}`, tgUser: tg, name: 'Аня', lang });
  await store.bumpTgStats(tg, { matches: 1, wins: 1, rooms: 0, winAt: Date.now() });
}

describe('напоминания бота', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('звезда: одно сообщение за 2 часа до конца, днём, только если после победы не играл', async () => {
    const { store, nudges, msgs } = setup();
    // победа в 10:00 по Москве → звезда гаснет завтра в 10:00, напоминание — около 8:00 (не ночь)
    vi.setSystemTime(new Date('2026-11-28T07:00:00Z'));
    await win(store, 77);
    vi.setSystemTime(new Date('2026-11-28T07:00:00Z').getTime() + STAR_MS - 3 * H);
    expect(await nudges.starAll()).toBe(0);
    // за 2 часа до конца (8:00 по Москве) — ночь ещё не кончилась? 8:00 — ночь (до 9:00): молчим
    vi.setSystemTime(new Date('2026-11-28T07:00:00Z').getTime() + STAR_MS - 2 * H + 60_000);
    expect(await nudges.starAll()).toBe(0);
    // игрок в Европе (UTC+1): там 6:00 — тоже ночь
    await nudges.setTz(77, -60);
    expect(await nudges.starAll()).toBe(0);
    // а у игрока в Азии (UTC+5) уже 10:00 — пишем
    await nudges.setTz(77, -300);
    expect(await nudges.starAll()).toBe(1);
    expect(msgs()[0].body.chat_id).toBe(77);
    expect(String(msgs()[0].body.text)).toContain('Звезда дубля погаснет через 2 часа');
    const kb = (msgs()[0].body.reply_markup as { inline_keyboard: { text: string; web_app?: { url: string }; callback_data?: string }[][] }).inline_keyboard;
    expect(kb[0][0].web_app?.url).toBe('https://site.example/?src=tg_star');
    expect(kb[1][0].callback_data).toBe('nudge:off');
    // через 10 минут — та же звезда, второй раз не пишем
    vi.advanceTimersByTime(10 * 60_000);
    expect(await nudges.starAll()).toBe(0);
  });

  it('звезда: играл после победы — не напоминаем; новая победа — новая звезда, но не чаще раза в сутки', async () => {
    const { store, nudges, msgs } = setup();
    const t0 = new Date('2026-11-28T12:00:00Z').getTime(); // 15:00 по Москве
    vi.setSystemTime(t0);
    await win(store, 5);
    vi.setSystemTime(t0 + H);
    await store.bumpTgStats(5, { matches: 1, wins: 0, rooms: 0, winAt: null });
    vi.setSystemTime(t0 + STAR_MS - 2 * H + 60_000);
    expect(await nudges.starAll()).toBe(0);
    expect(msgs()).toHaveLength(0);
  });

  it('потолок: не больше одного в сутки и трёх в неделю; ночью молчим', () => {
    const now = new Date('2026-11-28T12:00:00Z').getTime();
    const s = { tgUser: 1, off: false, dead: false, tz: null, star: null, week: null, sent: [] as number[] };
    expect(mayWrite(s, 'ru', now)).toBe(true);
    expect(mayWrite({ ...s, sent: [now - 23 * H] }, 'ru', now)).toBe(false);
    expect(mayWrite({ ...s, sent: [now - 25 * H] }, 'ru', now)).toBe(true);
    expect(mayWrite({ ...s, sent: [now - 2 * 24 * H, now - 3 * 24 * H, now - 4 * 24 * H] }, 'ru', now)).toBe(false);
    expect(mayWrite({ ...s, sent: [now - 8 * 24 * H, now - 3 * 24 * H, now - 4 * 24 * H] }, 'ru', now)).toBe(true);
    expect(mayWrite({ ...s, off: true }, 'ru', now)).toBe(false);
    expect(mayWrite({ ...s, dead: true }, 'ru', now)).toBe(false);
    // 23:30 по Москве — ночь; по-английски без пояса — UTC, 20:30 — можно
    const late = new Date('2026-11-28T20:30:00Z').getTime();
    expect(localHour(late, null, 'ru')).toBe(23);
    expect(mayWrite(s, 'ru', late)).toBe(false);
    expect(mayWrite(s, 'en', late)).toBe(true);
  });

  it('Telegram не даёт писать — замолкаем до /start; «Не напоминать» выключает, /start включает', async () => {
    let blocked = true;
    const { store, nudges, msgs, sent } = setup(() => (blocked ? 'Forbidden: bot was blocked by the user' : null));
    const t0 = new Date('2026-11-28T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    await win(store, 9);
    vi.setSystemTime(t0 + STAR_MS - 2 * H + 60_000);
    expect(await nudges.starAll()).toBe(0);
    expect((await store.nudgeOf(9))?.dead).toBe(true);
    blocked = false;
    expect(await nudges.weeklyAll({ id: 'w1', name: { ru: 'Кот', en: 'Cat' } })).toBe(0);
    await nudges.onStart(9);
    expect(await nudges.weeklyAll({ id: 'w1', name: { ru: 'Кот', en: 'Cat' } })).toBe(1);
    expect(String(msgs()[0].body.text)).toBe('🎞 Новый стикер недели: «Кот». Сыграй матч, и он появится в твоём паке.');
    // «Не напоминать»
    expect(await nudges.onCallback({ id: 'q', from: { id: 9, language_code: 'ru' }, data: 'nudge:off', message: { chat: { id: 9 }, message_id: 3 } })).toBe(true);
    expect(sent.find((c) => c.method === 'answerCallbackQuery')?.body.text).toContain('больше не напоминаю');
    const edit = sent.find((c) => c.method === 'editMessageReplyMarkup')!;
    expect(JSON.stringify(edit.body.reply_markup)).not.toContain('nudge:off');
    vi.advanceTimersByTime(8 * 24 * H);
    await store.bumpTgStats(9, { matches: 1, wins: 0, rooms: 0, winAt: null });
    expect(await nudges.weeklyAll({ id: 'w2', name: { ru: 'Пёс', en: 'Dog' } })).toBe(0);
    await nudges.onStart(9);
    expect(await nudges.weeklyAll({ id: 'w2', name: { ru: 'Пёс', en: 'Dog' } })).toBe(1);
  });

  it('стикер недели: один раз на стикер и только тем, кто играл за 30 дней', async () => {
    const { store, nudges, msgs } = setup();
    const t0 = new Date('2026-11-01T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    await win(store, 1);
    vi.setSystemTime(t0 + 20 * 24 * H);
    await win(store, 2, 'en');
    vi.setSystemTime(t0 + 32 * 24 * H);
    const st = { id: 'meme1', name: { ru: 'Мем', en: 'Meme' } };
    expect(await nudges.weeklyAll(st)).toBe(1);
    expect(msgs()[0].body.chat_id).toBe(2);
    expect(String(msgs()[0].body.text)).toContain('New sticker of the week: «Meme»');
    vi.advanceTimersByTime(2 * 24 * H);
    expect(await nudges.weeklyAll(st)).toBe(0);
  });

  it('бот: кнопка «Не напоминать» и /start доходят до напоминаний', async () => {
    vi.useRealTimers();
    const store = new MemoryStore();
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, result: true }))) as unknown as typeof fetch;
    const bot = new Bot({ token: '1:T', apiBase: 'https://api.example', site: 'https://site.example', store, log: silentLogger, fetchImpl });
    const hook = (upd: unknown) => bot.handle('POST', '/hook', { 'x-telegram-bot-api-secret-token': bot.hookSecret }, upd);
    await hook({ callback_query: { id: 'q', from: { id: 44, language_code: 'en' }, data: 'nudge:off', message: { chat: { id: 44 }, message_id: 1 } } });
    expect((await store.nudgeOf(44))?.off).toBe(true);
    await hook({ message: { message_id: 2, chat: { id: 44, type: 'private' }, from: { id: 44 }, text: '/start' } });
    expect((await store.nudgeOf(44))?.off).toBe(false);
  });
});
