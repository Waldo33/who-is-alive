import { DICTS, STAR_MS, fmt } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { errFields, type Logger } from './log';
import type { NudgeRow, NudgeState, Store } from './store';

/**
 * Напоминания бота, которые зовут игрока обратно на площадку (решение владельца 28.11.2026):
 *   - «Звезда дубля погаснет через 2 часа» — значок держится сутки после победы (game-core/badges.ts › STAR_MS);
 *   - «Новый стикер недели» — когда выходит стикер рубрики (`weeklyAll`; рубрики пока нет — вызывать некому).
 *
 * Правила (чтобы не спамить):
 *   - пишем, только если Telegram разрешает: отказ («бот заблокирован», «не начинал чат») — молчим до /start;
 *   - «Не напоминать» под сообщением выключает оба вида навсегда, /start включает снова;
 *   - не чаще одного сообщения в сутки и трёх в неделю на игрока;
 *   - ночью (23:00–9:00 по времени игрока: пояс с телефона, нет — Москва для ru, UTC для en) не пишем;
 *   - звезда — одно сообщение на одну победу и только если после неё игрок не играл; ночью — пропускаем;
 *   - стикер недели — одно объявление на стикер, тем, кто играл за последние 30 дней (ночью — утром).
 *
 * Счётчики побед — в базе игрового сервера (tg_stats): работает там, где бот живёт в процессе игры.
 */

export type NudgeStore = Pick<Store, 'nudgeWinners' | 'nudgeActive' | 'nudgeOf' | 'saveNudge'>;

export interface NudgeDeps {
  api: <R = unknown>(method: string, body: Record<string, unknown>) => Promise<R>;
  store: NudgeStore;
  /** Адрес игры для кнопки «На площадку» (Mini App). */
  site?: string;
  log: Logger;
  /** Аренда по расписанию (синий и зелёный при выкладке — пишет один). */
  lease?: (name: string, ms: number) => Promise<boolean>;
  now?: () => number;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Звезда: пишем, когда до конца осталось от 2 часов до 1 ч 35 мин (два прохода расписания по 10 минут). */
const STAR_FROM = 2 * HOUR;
const STAR_TO = 95 * 60_000;
/** «Не играл после победы»: матч с победой записывается в счётчики чуть позже самой победы. */
const PLAYED_SLACK = 15 * 60_000;
/** Потолок: одно в сутки, три в неделю. */
const PER_WEEK = 3;
/** Стикер недели — тем, кто играл за последние 30 дней. */
const ACTIVE_MS = 30 * DAY;
/** Ночь по времени игрока: с 23:00 до 9:00. */
const NIGHT_FROM = 23;
const NIGHT_TO = 9;
/** Ответы Telegram, после которых писать игроку нельзя, пока он сам не напишет боту. */
const CANT_WRITE = /bot was blocked|user is deactivated|chat not found|PEER_ID_INVALID|USER_ID_INVALID|can't initiate|initiate conversation|Forbidden/i;
/** Пояс с телефона: минуты `getTimezoneOffset()`, от −14 до +12 часов. */
export const isTz = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= -840 && (x as number) <= 720;

const fresh = (tgUser: number): NudgeState => ({ tgUser, off: false, dead: false, tz: null, star: null, week: null, sent: [] });

/** Который час у игрока (0–23). */
export function localHour(now: number, tz: number | null, lang: Lang): number {
  const offset = tz ?? (lang === 'ru' ? -180 : 0);
  return new Date(now - offset * 60_000).getUTCHours();
}

/** Можно ли сейчас писать игроку хоть что-то (выключил, не даёт Telegram, потолок, ночь). */
export function mayWrite(s: NudgeState | null, lang: Lang, now: number): boolean {
  if (s?.off || s?.dead) return false;
  const sent = (s?.sent ?? []).filter((t) => now - t < 7 * DAY);
  if (sent.some((t) => now - t < DAY) || sent.length >= PER_WEEK) return false;
  const h = localHour(now, s?.tz ?? null, lang);
  return !(h >= NIGHT_FROM || h < NIGHT_TO);
}

export class Nudges {
  constructor(private readonly d: NudgeDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private buttons(lang: Lang, src: string) {
    const t = DICTS[lang].shop;
    const rows: { text: string; web_app?: { url: string }; callback_data?: string }[][] = [];
    if (this.d.site) rows.push([{ text: t.botToSet, web_app: { url: `${this.d.site}/?src=${src}` } }]);
    rows.push([{ text: t.botNudgeOff, callback_data: 'nudge:off' }]);
    return { inline_keyboard: rows };
  }

  /** Отправить и записать. false — не дошло (Telegram не даёт писать — запомним и замолчим). */
  private async send(row: NudgeRow, text: string, src: string, mark: (s: NudgeState) => void): Promise<boolean> {
    const now = this.now();
    const s = row.nudge ?? fresh(row.tgUser);
    try {
      await this.d.api('sendMessage', { chat_id: row.tgUser, text, reply_markup: this.buttons(row.lang, src) });
    } catch (e) {
      if (!CANT_WRITE.test(String(e))) {
        this.d.log('warn', 'nudge_send', errFields(e));
        return false;
      }
      await this.d.store.saveNudge({ ...s, dead: true });
      return false;
    }
    const next = { ...s, sent: [...s.sent.filter((t) => now - t < 7 * DAY), now] };
    mark(next);
    await this.d.store.saveNudge(next);
    return true;
  }

  /** «Звезда дубля погаснет через 2 часа» — всем, кому пора. Ответ — сколько написали. */
  async starAll(): Promise<number> {
    const now = this.now();
    // победа, у которой до конца звезды осталось от STAR_TO до STAR_FROM
    const rows = await this.d.store.nudgeWinners(now + STAR_TO - STAR_MS, now + STAR_FROM - STAR_MS);
    let sent = 0;
    for (const row of rows) {
      if (row.lastWin === null || row.nudge?.star === row.lastWin) continue;
      // после победы уже играл — значит, помнит про игру; не дёргаем
      if (row.playedAt - row.lastWin > PLAYED_SLACK) continue;
      if (!mayWrite(row.nudge, row.lang, now)) continue;
      const win = row.lastWin;
      if (await this.send(row, DICTS[row.lang].shop.botStarFades, 'tg_star', (s) => (s.star = win))) sent++;
    }
    return sent;
  }

  /**
   * «Новый стикер недели» — один раз каждому, кто играл за 30 дней. Вызывать на каждом проходе расписания, пока
   * стикер «свежий»: кому ночью или упёрся в потолок — напишем позже. Ответ — сколько написали.
   */
  async weeklyAll(sticker: { id: string; name: Record<Lang, string> }): Promise<number> {
    const now = this.now();
    let sent = 0;
    for (const row of await this.d.store.nudgeActive(now - ACTIVE_MS)) {
      if (row.nudge?.week === sticker.id || !mayWrite(row.nudge, row.lang, now)) continue;
      const text = fmt(DICTS[row.lang].shop.botWeekSticker, { name: `«${sticker.name[row.lang]}»` });
      if (await this.send(row, text, 'tg_week', (s) => (s.week = sticker.id))) sent++;
    }
    return sent;
  }

  /** Кнопка «Не напоминать». true — это была она. */
  async onCallback(q: { id: string; from: { id: number; language_code?: string }; data?: string; message?: { chat: { id: number }; message_id: number } }): Promise<boolean> {
    if (q.data !== 'nudge:off') return false;
    const s = (await this.d.store.nudgeOf(q.from.id)) ?? fresh(q.from.id);
    await this.d.store.saveNudge({ ...s, off: true });
    const lang: Lang = q.from.language_code?.startsWith('ru') ? 'ru' : 'en';
    await this.d.api('answerCallbackQuery', { callback_query_id: q.id, text: DICTS[lang].shop.botNudgeOffDone });
    // под сообщением остаётся только «На площадку»
    if (q.message) {
      const kb = this.buttons(lang, 'tg_nudge').inline_keyboard.filter((r) => !r.some((b) => b.callback_data));
      await this.d.api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: kb } }).catch(() => undefined);
    }
    return true;
  }

  /** /start в личке: писать снова можно, «Не напоминать» снят. */
  async onStart(tgUser: number): Promise<void> {
    const s = await this.d.store.nudgeOf(tgUser);
    if (s && (s.off || s.dead)) await this.d.store.saveNudge({ ...s, off: false, dead: false });
  }

  /** Пояс с телефона (вход из Mini App): для «не писать ночью». */
  async setTz(tgUser: number, tz: number): Promise<void> {
    if (!isTz(tz)) return;
    const s = (await this.d.store.nudgeOf(tgUser)) ?? fresh(tgUser);
    if (s.tz !== tz) await this.d.store.saveNudge({ ...s, tz });
  }

  /** Проходить раз в `ms` (первый раз — через минуту после старта). Ответ — остановить. */
  sweepEvery(ms: number): () => void {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (this.d.lease && !(await this.d.lease('nudges', ms * 2))) return;
        const n = await this.starAll();
        if (n) this.d.log('info', 'nudge_star', { sent: n });
      } catch (e) {
        this.d.log('warn', 'nudge_sweep', errFields(e));
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => void tick(), Math.min(ms, 60_000));
    const every = setInterval(() => void tick(), ms);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }
}
