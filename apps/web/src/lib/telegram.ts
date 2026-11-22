/**
 * Telegram Mini App: игра открывается внутри Telegram (бот → Mini App) и пользуется его родными
 * возможностями, где они есть (Bot API, `Telegram.WebApp`):
 *  - во весь экран (8.0), без сворачивания свайпом вниз (7.7), портретная ориентация (8.0);
 *  - цвета шапки, фона и нижней панели — как у игры; безопасные зоны Telegram → CSS `--tg-top/--tg-bottom`;
 *  - родная кнопка «Назад» вместо нашей (topbar), подтверждение закрытия посреди матча;
 *  - вибрация (HapticFeedback) на ударах, звёздах, ошибках;
 *  - имя и язык игрока из профиля Telegram — по умолчанию, если своё не задано;
 *  - ссылки `t.me/<бот>/<приложение>?startapp=…` ведут сразу в комнату (`r_КОД`) или в загадку дня (`daily`);
 *  - «Поделиться» и «Позвать» — карточкой с кнопкой «Играть» (8.0, `shareMessage`: её готовит сервер бота,
 *    `supabase/functions/tg-bot`), иначе родным окном выбора чата (`t.me/share/url`);
 *  - рейтинг загадки дня «в этом чате» (по `chat_instance`, подпись initData проверяет сервер бота).
 *
 * Вне Telegram всё здесь — пустые вызовы. Скрипт Telegram грузится только внутри Telegram.
 */
import { TG_APP } from './env';
import { featureOn } from './features';
import { LANG_KEY } from './lang';
import { savedName, saveName } from './name';

type Haptic = 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning' | 'select';

interface TgButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

interface TgInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { first_name?: string; last_name?: string; username?: string; language_code?: string }; start_param?: string };
  version: string;
  platform: string;
  isFullscreen?: boolean;
  safeAreaInset?: TgInsets;
  contentSafeAreaInset?: TgInsets;
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  requestFullscreen?(): void;
  lockOrientation?(): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  openTelegramLink(url: string): void;
  shareMessage?(id: string, cb?: (sent: boolean) => void): void;
  onEvent(e: string, cb: () => void): void;
  BackButton: TgButton;
  HapticFeedback: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

const SDK = 'https://telegram.org/js/telegram-web-app.js';
const FLAG = 'kto:tg';
const INK = '#181425';

let app: TgWebApp | null = null;
let booting: Promise<TgWebApp | null> | null = null;
let backCb: (() => void) | null = null;

/** Открыто ли внутри Telegram: при запуске Telegram кладёт параметры в адрес (#tgWebAppData…), помним до закрытия. */
export function inTelegram(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (/tgWebAppData|tgWebAppPlatform/.test(location.hash) || 'TelegramWebviewProxy' in window) sessionStorage.setItem(FLAG, '1');
    return sessionStorage.getItem(FLAG) === '1';
  } catch {
    return /tgWebAppData/.test(location.hash);
  }
}

/** Telegram.WebApp, если игра внутри Telegram и SDK уже загружен. */
export function tg(): TgWebApp | null {
  return app;
}

function at(v: string): boolean {
  try {
    return !!app?.isVersionAtLeast(v);
  } catch {
    return false;
  }
}

function applyInsets(): void {
  const a = app;
  if (!a) return;
  const s = a.safeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const c = a.contentSafeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const root = document.documentElement.style;
  root.setProperty('--tg-top', `${(s.top || 0) + (c.top || 0)}px`);
  root.setProperty('--tg-bottom', `${(s.bottom || 0) + (c.bottom || 0)}px`);
}

/** Загрузить SDK и настроить приложение (один раз). Вне Telegram — null. */
export function bootTelegram(): Promise<TgWebApp | null> {
  if (booting) return booting;
  if (!inTelegram()) return (booting = Promise.resolve(null));
  booting = new Promise((resolve) => {
    const done = () => {
      const w = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp ?? null;
      if (!w || !w.initData) return resolve(null);
      app = w;
      document.documentElement.classList.add('tg');
      try {
        w.ready();
        w.expand();
        w.setHeaderColor(INK);
        w.setBackgroundColor(INK);
        if (at('7.10')) w.setBottomBarColor?.(INK);
        // игра — свайпы и тапы по полю: свайп вниз не должен сворачивать приложение
        if (at('7.7')) w.disableVerticalSwipes?.();
        // на телефоне — во весь экран и только вертикально (как и задумана игра)
        const mobile = w.platform === 'ios' || w.platform === 'android';
        if (mobile && at('8.0')) {
          w.requestFullscreen?.();
          w.lockOrientation?.();
        }
        applyInsets();
        for (const e of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged']) w.onEvent(e, applyInsets);
        w.BackButton.onClick(() => backCb?.());
        if (backCb) w.BackButton.show();
      } catch {
        /* старый клиент Telegram — чего нет, то пропускаем */
      }
      resolve(w);
    };
    const have = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
    if (have) return done();
    const s = document.createElement('script');
    s.src = SDK;
    s.async = true;
    s.onload = done;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return booting;
}

/** Родная кнопка «Назад» Telegram: обработчик или null — спрятать. */
export function setTelegramBack(cb: (() => void) | null): void {
  backCb = cb;
  if (!app) return;
  try {
    if (cb) app.BackButton.show();
    else app.BackButton.hide();
  } catch {
    /* старый клиент */
  }
}

/** Спросить подтверждение, если игрок закрывает Telegram посреди матча. */
export function setClosingConfirmation(on: boolean): void {
  if (!app || !at('6.2')) return;
  try {
    if (on) app.enableClosingConfirmation();
    else app.disableClosingConfirmation();
  } catch {
    /* старый клиент */
  }
}

/** Вибрация: в Telegram — HapticFeedback, на Android вне Telegram — коротко вибромотором. */
export function haptic(kind: Haptic): void {
  try {
    if (app && at('6.1')) {
      const h = app.HapticFeedback;
      if (kind === 'select') h.selectionChanged();
      else if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
      else h.impactOccurred(kind);
      return;
    }
    if (inTelegram()) return;
    const ms = kind === 'heavy' || kind === 'error' ? 40 : kind === 'success' ? 25 : 12;
    if (kind !== 'select') navigator.vibrate?.(ms);
  } catch {
    /* нет вибрации */
  }
}

/** Имя из профиля Telegram (до 14 знаков) — по умолчанию, если игрок своё ещё не задал. */
export function telegramName(): string | null {
  const u = app?.initDataUnsafe.user;
  const n = (u?.first_name || u?.username || '').trim();
  return n ? n.slice(0, 14) : null;
}

export function telegramLang(): 'ru' | 'en' | null {
  const l = app?.initDataUnsafe.user?.language_code;
  if (!l) return null;
  return /^(ru|uk|be|kk)/.test(l) ? 'ru' : 'en';
}

/**
 * Параметр запуска (?startapp=…): `r_КОД` — комната, `daily` — загадка дня. Telegram передаёт его
 * и в адресе (`tgWebAppStartParam`) — так он известен сразу, ещё до загрузки SDK.
 */
export function telegramStart(): string | null {
  if (app?.initDataUnsafe.start_param) return app.initDataUnsafe.start_param;
  if (typeof location === 'undefined') return null;
  return new URLSearchParams(location.search).get('tgWebAppStartParam');
}

/**
 * Куда вести по параметру запуска — один раз за запуск (потом «Назад» на главную не уводит обратно).
 * null — оставаться на месте.
 */
export function telegramStartTarget(): string | null {
  const start = telegramStart();
  if (!start) return null;
  try {
    if (sessionStorage.getItem('kto:tg-routed') === '1') return null;
    sessionStorage.setItem('kto:tg-routed', '1');
  } catch {
    /* приватный режим */
  }
  const room = /^r_([A-Z]{4})$/.exec(start);
  return room ? `/r/${room[1]}?src=tg` : start === 'daily' && featureOn('casting') ? '/daily?src=tg' : null;
}

/** Ссылка, открывающая игру в Telegram с параметром (или null, если бот ещё не настроен). */
export function tgLink(start: string): string | null {
  if (!TG_APP) return null;
  return `https://t.me/${TG_APP}?startapp=${encodeURIComponent(start)}`;
}

/** Ссылка на сайт → такая же ссылка внутрь Telegram (комната, загадка дня, иначе — главная). null — бот не настроен. */
export function tgLinkFor(webUrl: string): string | null {
  let path = '/';
  try {
    path = new URL(webUrl).pathname;
  } catch {
    /* не адрес — главная */
  }
  const room = /^\/r\/([A-Z]{4})/.exec(path);
  return tgLink(room ? `r_${room[1]}` : path.startsWith('/daily') ? 'daily' : 'home');
}

/** Внутри Telegram: родное окно «Переслать в чат» со ссылкой и текстом. true — открыто. */
export function telegramShare(url: string, text: string): boolean {
  if (!app) return false;
  try {
    app.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    return true;
  } catch {
    return false;
  }
}

/** SDK готов, и имя с языком из профиля Telegram взяты по умолчанию (если свои не заданы). */
export async function telegramReady(): Promise<TgWebApp | null> {
  const w = await bootTelegram();
  if (!w) return null;
  const name = telegramName();
  if (name && !savedName()) saveName(name);
  try {
    const lang = telegramLang();
    if (lang && !localStorage.getItem(LANG_KEY)) localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* приватный режим */
  }
  return w;
}

/**
 * Сервер бота — Supabase Edge Function `tg-bot` (Франкфурт). На своём сервере в Москве бот есть
 * (apps/server/src/bot.ts, /tg/*), но оттуда закрыт api.telegram.org (проверено 23.11.2026) — переедет,
 * когда появится сервер или прокси за границей.
 */
const BOT_FN = 'https://wivildtgfkpuxvqoamqg.supabase.co/functions/v1/tg-bot';

async function botPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const w = await bootTelegram();
  if (!w?.initData) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`${BOT_FN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: w.initData, ...body }),
      signal: ctl.signal,
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ShareCard = { kind: 'room'; code: string } | { kind: 'daily'; squares: string } | { kind: 'invite' };

/**
 * Поделиться карточкой с кнопкой «Играть» (Bot API 8.0): Telegram показывает выбор чата поверх игры
 * и не закрывает её. false — не вышло (старый Telegram, сервер бота не настроен) — пусть зовущий
 * откроет обычное окно `telegramShare`.
 */
export async function telegramShareCard(card: ShareCard): Promise<boolean> {
  const w = await bootTelegram();
  if (!w?.shareMessage || !at('8.0')) return false;
  const r = await botPost<{ id?: string }>('/prepare', card);
  if (!r?.id) return false;
  try {
    w.shareMessage(r.id);
    return true;
  } catch {
    return false;
  }
}

export interface ChatScore {
  name: string;
  tries: number;
  won: boolean;
  me: boolean;
}

/**
 * Загадка дня в чате, откуда открыта игра: записать свой результат (первый за день — окончательный)
 * и получить рейтинг чата. null — не в чате или сервер недоступен.
 */
export async function telegramDailyBoard(n: number, result: { tries: number; won: boolean }): Promise<ChatScore[] | null> {
  const r = await botPost<{ board: ChatScore[]; chat: boolean }>('/daily', { n, ...result });
  return r?.chat ? r.board : null;
}
