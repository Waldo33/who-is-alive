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
 *    `apps/server/src/bot.ts` на сервере в Нидерландах, через api.<домен>/tg), иначе родным окном выбора чата (`t.me/share/url`);
 *  - рейтинг загадки дня «в этом чате» (по `chat_instance`, подпись initData проверяет сервер бота).
 *
 * Вне Telegram всё здесь — пустые вызовы. Скрипт Telegram грузится только внутри Telegram.
 */
import type { BadgeState, EffectId, MyFig, MySticker, RewardId, StickerId } from '@kto/game-core';
import { GAME_API, TG_APP } from './env';
import { ensureGameUser } from './game-server';
import type { SharedClip } from './clips';
import { featureOn } from './features';
import { LANG_KEY } from './lang';
import { savedName, saveName } from './name';
import { currentWebLogin } from './tg-login';

/** tick — щелчок барабана автомата («Казино»): в Telegram — как select, вне его — самый короткий толчок мотора. */
export type Haptic = 'light' | 'medium' | 'heavy' | 'success' | 'error' | 'warning' | 'select' | 'tick';

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
  initDataUnsafe: { user?: { id?: number; first_name?: string; last_name?: string; username?: string; language_code?: string; is_premium?: boolean }; start_param?: string };
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
  shareToStory?(mediaUrl: string, params?: { text?: string; widget_link?: { url: string; name?: string } }): void;
  openInvoice?(url: string, cb?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void): void;
  requestWriteAccess?(cb?: (allowed: boolean) => void): void;
  downloadFile?(params: { url: string; file_name: string }, cb?: (accepted: boolean) => void): void;
  setEmojiStatus?(customEmojiId: string, params?: { duration?: number }, cb?: (set: boolean) => void): void;
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
        // свернули и развернули Mini App (Bot API 8.0): document при этом может не стать hidden,
        // а звук на iOS глохнет — сообщаем звуку (audio.ts) событием, без зависимости от него
        if (at('8.0')) {
          w.onEvent('deactivated', () => window.dispatchEvent(new Event('kto:away')));
          w.onEvent('activated', () => window.dispatchEvent(new Event('kto:back')));
        }
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
      if (kind === 'select' || kind === 'tick') h.selectionChanged();
      else if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
      else h.impactOccurred(kind);
      return;
    }
    if (inTelegram()) return;
    const ms = kind === 'heavy' || kind === 'error' ? 40 : kind === 'success' ? 25 : kind === 'tick' ? 5 : 12;
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
 * Параметр запуска (?startapp=…): `r_КОД` — комната, `play` — сразу матч с ИИ, `friends` — новая
 * комната, `g_МЕТКА` — общее лобби по карточке бота «Собрать комнату», `c_КОД` — загадка из фильма, `daily` — загадка дня, `dev[_tN][_sN]` — песочница с дев-панелью (тема N, ускорение N), `shop` — «Гардероб», `shoptest` — дев-панель песочницы (там проверочная покупка), `stickers` — «Собери свой стикерпак» (`ff_shop`/`ff_stickers` — старые варианты). Telegram передаёт его
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
  if (room) return `/r/${room[1]}?src=tg`;
  if (start === 'play') return '/?create=1&src=tg';
  // дев-режим песочницы для владельца (в Telegram адрес не поправить руками): dev, dev_t7, dev_t7_s8 —
  // тема и ускорение, как ?dev&theme=7&speed=8
  const dev = /^dev(?:_t(\d{1,2}))?(?:_s(\d{1,2}))?$/.exec(start);
  if (dev) return `/sandbox?dev${dev[1] ? `&theme=${dev[1]}` : ''}${dev[2] ? `&speed=${dev[2]}` : ''}&src=tg`;
  if (start === 'friends') return '/?create=1&src=tg';
  // «Гардероб» и «Собери свой стикерпак» (ff_* — старые ссылки времён флага shop, ещё живут в чатах)
  if (start === 'shop' || start === 'ff_shop') return '/wardrobe?src=tg';
  // проверочная покупка за 1 звезду (владельцу) — в дев-панели песочницы, вне гардероба (старая ссылка тоже ведёт туда)
  if (start === 'shoptest') return '/sandbox?dev&src=tg';
  if (start === 'stickers' || start === 'ff_stickers') return '/stickers?src=tg';
  if (start === 'badges') return '/badges?src=tg';
  if (start === 'emoji') return '/emoji?src=tg';
  // загадка из фильма матча: кнопка «Найди актёра» под видео в чате
  const puzzle = /^c_([A-Z2-9]{5})$/.exec(start);
  if (puzzle) return `/${puzzle[1]}?src=tg_film`;
  // карточка бота «Собрать комнату»: первый нажавший создаёт лобби, остальные попадают в него же
  const invite = /^g_([A-Za-z0-9]{8,32})$/.exec(start);
  if (invite) return `/?invite=${invite[1]}&src=tg`;
  return start === 'daily' && featureOn('casting') ? '/daily?src=tg' : null;
}

/** Метка карточки бота «Собрать комнату», если игру открыли с неё (g_МЕТКА) — для «Реванша» в чат. */
export function telegramInvite(): string | undefined {
  return /^g_([A-Za-z0-9]{8,32})$/.exec(telegramStart() ?? '')?.[1];
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
  // загадка из фильма: benobody.app/7KQ2P → c_7KQ2P
  const puzzle = /^\/([A-Z2-9]{5})$/.exec(path);
  return tgLink(room ? `r_${room[1]}` : puzzle ? `c_${puzzle[1]}` : path.startsWith('/daily') ? 'daily' : 'home');
}

/**
 * Ссылка, которую игрок отдаёт другим (приглашение, QR): в Telegram — на бота (друг откроет игру там же),
 * вне Telegram — на сайт как есть. У человека без Telegram t.me покажет страницу с кнопкой «открыть в браузере».
 */
export function inviteLink(webUrl: string): string {
  if (!inTelegram() || webUrl.startsWith('https://t.me/')) return webUrl;
  return tgLinkFor(webUrl) ?? webUrl;
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
 * Сервер бота: api.<домен>/tg/* — Москва пересылает их по туннелю на сервер в Нидерландах
 * (apps/server/src/bot.ts; из России api.telegram.org закрыт, а телефоны ходят только в Москву).
 */
const BOT_FN = `${GAME_API}/tg`;

/**
 * Кто зовёт бота: в Telegram — подписанный initData Mini App, в браузере — вход через Telegram на сайте
 * (tg-login.ts). null — ни того, ни другого.
 */
async function botAuth(): Promise<{ auth: Record<string, unknown>; tg: number } | null> {
  const w = await bootTelegram();
  if (w?.initData) return { auth: { initData: w.initData }, tg: w.initDataUnsafe?.user?.id ?? 0 };
  if (inTelegram()) return null;
  const l = currentWebLogin();
  if (!l) return null;
  let lang: string | null = null;
  try {
    lang = localStorage.getItem(LANG_KEY);
  } catch {
    /* приватный режим */
  }
  return { auth: { login: l, ...(lang === 'ru' || lang === 'en' ? { lang } : {}) }, tg: l.id };
}

/** Можно ли звать магазин: игра в Telegram или в браузере выполнен вход через Telegram. */
export function shopSignedIn(): boolean {
  return inTelegram() || !!currentWebLogin();
}

async function botPost<T>(path: string, body: Record<string, unknown>, timeoutMs = 6000): Promise<T | null> {
  const a = await botAuth();
  if (!a) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BOT_FN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...a.auth, ...body }),
      signal: ctl.signal,
    });
    if (!r.ok) return null;
    const out = (await r.json()) as T;
    if (path.startsWith('/shop')) rememberShop(a.tg, out);
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ShareCard = { kind: 'room'; code: string } | { kind: 'daily'; squares: string } | { kind: 'invite' } | { kind: 'clip'; clip: string; text: string; thumb: boolean; code?: string; invite?: string; puzzle?: string };

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

// ───────────── клип «Лучший момент» в Telegram ─────────────
// Внутри Telegram файл из браузера не скачать и не передать в сторис: клип лежит на игровом
// сервере (`lib/clips.ts`), а дальше — ссылкой: сторис, «Сохранить» и видео-карточка в чат.

/** Что из клипа умеет этот Telegram: в сторис (7.8, только mp4), в чат и скачать (8.0). */
export function telegramClipCaps(mime: string): { story: boolean; chat: boolean; save: boolean } {
  const mp4 = mime.startsWith('video/mp4');
  return {
    story: !!app?.shareToStory && at('7.8') && mp4,
    chat: !!app?.shareMessage && at('8.0') && mp4,
    save: !!app?.downloadFile && at('8.0'),
  };
}

/** Клип в сторис: подпись и (у премиума) ссылка «Играть». */
export function telegramClipStory(clip: SharedClip, text: string, linkName: string): boolean {
  if (!app?.shareToStory) return false;
  const link = tgLink('play');
  try {
    app.shareToStory(clip.url, {
      text: text.slice(0, 200),
      ...(link && app.initDataUnsafe.user?.is_premium ? { widget_link: { url: link, name: linkName.slice(0, 48) } } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** «Сохранить» внутри Telegram — родное окно загрузки. */
export function telegramClipSave(clip: SharedClip): boolean {
  if (!app?.downloadFile) return false;
  try {
    app.downloadFile({ url: clip.url, file_name: `massovka.${clip.ext}` });
    return true;
  } catch {
    return false;
  }
}

// ───────────── гардероб (за флагом shop): покупка за звёзды и личный стикерпак ─────────────

export interface ShopState {
  /** Что есть: `starter` (бесплатный пак), наборы. */
  items: string[];
  /** Ссылка на свой пак от бота (t.me/addstickers/…) или null. */
  pack: string | null;
  /** Отдельные паки наборов: набор → ссылка. */
  packs: Record<string, string>;
  issued: number;
  wanted: number;
  /** need_bot — игрок не открывал бота, стикеры выдать нельзя; need_sub — бесплатный пак: ни матча, ни подписки. */
  error: string | null;
  /** Канал игры (при need_sub). */
  channel?: string;
  /** Надетый скин (null — снят или не куплен); старый сервер бота не шлёт. */
  worn?: string | null;
  /** «Собери свой стикерпак»: открытые стикеры, убранные игроком, свои, открытые фигурки, открытые наградами (`st:`). */
  open?: StickerId[];
  off?: StickerId[];
  my?: MySticker[];
  figs?: MyFig[];
  /** Открыто мест под свои стикеры и через сколько матчей следующее (null — все); старый сервер не шлёт. */
  slots?: number;
  slotIn?: number | null;
  earned?: string[];
  /** Дневной лимит стикеров за матчи исчерпан — когда снова (мс); null — можно открывать. */
  earnNext?: number | null;
  /** Игрок нажал «Напомнить» — бот напишет, когда стикеры снова откроются. */
  remind?: boolean;
  /** Эффекты на стандартных стикерах пака (id → эффект) и купленные эффекты. */
  fx?: Record<string, EffectId>;
  effects?: EffectId[];
  /** Цвет надписи стандартных стикеров (индекс MY_COLORS), у кого не родной; старый сервер не шлёт. */
  col?: Record<string, number>;
  /** Сколько ещё боту добавить, убрать или заменить в паке. */
  pending?: number;
  /** Бесплатный пак ещё не забран: сыгран ли матч, есть ли подписка на канал (экран-замок; старый сервер не шлёт). */
  free?: { played: boolean; sub: boolean; channel?: string };
  /** Значки для статуса (game-core/badges.ts) и id их эмодзи в наборе бота (null — набор ещё готовится); старый сервер не шлёт. */
  badges?: (BadgeState & { emoji: string | null })[];
  /** Личный эмодзи-пак (game-core/emoji-pack.ts): забран ли, ссылка на набор, открытые награды, сколько ещё положить; старый сервер не шлёт. */
  emoji?: { claimed: boolean; pack: string | null; open: RewardId[]; pending: number };
}

/** Можно ли ставить эмодзи-статус: Telegram 8.0+ и Telegram Premium (без него статус не ставится). */
export function emojiStatusCaps(): { ok: boolean; premium: boolean } {
  const ok = !!app?.setEmojiStatus && at('8.0');
  return { ok, premium: !!app?.initDataUnsafe.user?.is_premium };
}

/**
 * Поставить значок в эмодзи-статус: Telegram сам спрашивает игрока. `until` — срок (мс, «Звезда дубля»):
 * статус снимется сам. true — поставлен.
 */
export function setEmojiStatus(emoji: string, until: number | null): Promise<boolean> {
  const a = app;
  if (!a?.setEmojiStatus || !at('8.0')) return Promise.resolve(false);
  const duration = until !== null ? Math.max(60, Math.floor((until - Date.now()) / 1000)) : undefined;
  return new Promise((done) => {
    try {
      a.setEmojiStatus!(emoji, duration ? { duration } : {}, (set) => done(!!set));
    } catch {
      done(false);
    }
  });
}

/** Ответ бота с кодом ошибки (400/409/429 — `{ error }`); null — нет сети или не в Telegram. */
async function botCall<T>(path: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<{ body?: T; error?: string } | null> {
  const a = await botAuth();
  if (!a) return null;
  try {
    const r = await fetch(`${BOT_FN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...a.auth, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    return r.ok ? { body: j } : { error: typeof j.error === 'string' ? j.error : 'bad' };
  } catch {
    return null;
  }
}

/** Убрать стикер из пака (on=false) или вернуть. */
export function shopPick(id: StickerId, on: boolean) {
  return botCall<ShopState>('/shop/pick', { id, on });
}

/** Свой стикер: новый (slot нет) или правка места slot. Рисует и кладёт в пак бот. */
export function shopMy(sticker: { fig: MyFig; pose: string; color: number; caption: string; fx?: EffectId }, slot?: number) {
  return botCall<ShopState>('/shop/my', { sticker, slot });
}

/** Облик стандартного стикера пака: эффект (null — снять) и цвет надписи (null — родной; не передан — не трогать). */
export function shopFx(id: string, fx: EffectId | null, color?: number | null) {
  return botCall<ShopState>('/shop/fx', { id, fx, ...(color !== undefined ? { color } : {}) });
}

/** «Напомнить»: бот напишет, когда стикеры за дубли снова откроются (дневной лимит). */
export function shopRemind() {
  return botCall<ShopState>('/shop/remind', {});
}

export function shopMyDel(slot: number) {
  return botCall<ShopState>('/shop/my/del', { slot });
}

/** Что есть у игрока (и дослать недовыданные стикеры). null — не в Telegram или сервер недоступен. */
const SHOP_KEY = 'kto:shop';
/** Последний ответ магазина на этом телефоне: гардероб и стикерпак рисуются сразу им, а не «ничего не куплено», пока бот отвечает. */
function rememberShop(tg: number | undefined, st: unknown): void {
  if (!tg || !st || !Array.isArray((st as ShopState).items)) return;
  try {
    localStorage.setItem(SHOP_KEY, JSON.stringify({ tg, st }));
  } catch {
    /* приватный режим */
  }
}
/** Сохранённое состояние магазина (того же игрока Telegram), без сети. null — не было или другой игрок. */
export function shopCached(): ShopState | null {
  try {
    const c = JSON.parse(localStorage.getItem(SHOP_KEY) ?? 'null') as { tg?: number; st?: ShopState } | null;
    const me = (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp?.initDataUnsafe?.user?.id ?? (inTelegram() ? undefined : currentWebLogin()?.id);
    if (!c?.st || !Array.isArray(c.st.items) || (me && c.tg !== me)) return null;
    return c.st;
  } catch {
    return null;
  }
}

export function shopState(): Promise<ShopState | null> {
  return botPost<ShopState>('/shop', {});
}

/** «Надеть» купленный скин или «Снять» (null). В комнате — со следующего входа. */
export function shopWear(item: string | null): Promise<ShopState | null> {
  return botPost<ShopState>('/shop/wear', { item });
}

/** Забрать бесплатный пак: бот рисует пак и присылает ссылку (до ~20 с). */
export async function shopClaim(): Promise<ShopState | null> {
  const w = await bootTelegram();
  // боту нужно разрешение писать игроку (сообщение «пак готов»); отказ — пак всё равно будет
  if (w?.requestWriteAccess && at('6.9')) await new Promise<void>((r) => w.requestWriteAccess!(() => r()));
  return botPost<ShopState>('/shop/claim', {}, 25_000);
}

/** «Забрать эмодзи-пак»: бот соберёт личный набор эмодзи (в фоне) — состояние сразу. */
export async function shopEmoji(): Promise<ShopState | null> {
  const w = await bootTelegram();
  // боту нужно разрешение писать игроку (сообщение о новых эмодзи); отказ — пак всё равно будет
  if (w?.requestWriteAccess && at('6.9')) await new Promise<void>((r) => w.requestWriteAccess!(() => r()));
  return botPost<ShopState>('/shop/emoji', {}, 20_000);
}

/** «Вернуть звёзды» в карточке покупки (пока только проверочная покупка): новое состояние или null. */
export function shopRefund(item: string): Promise<ShopState | null> {
  return botPost<ShopState>('/shop/refund', { item }, 20_000);
}

/** Ссылки на счёт, взятые заранее (сайт): Telegram надо открыть прямо в нажатии, без ожидания сети. */
const invoices = new Map<string, { link: string; at: number }>();
/** Ссылка на счёт живёт долго; на всякий случай берём свежую раз в час. */
const INVOICE_MS = 60 * 60_000;

/** Сайт с входом через Telegram: заранее взять ссылку на счёт товара (кнопка «Купить» откроет её сразу). */
export async function prefetchInvoice(item: string): Promise<void> {
  if (inTelegram() || !currentWebLogin()) return;
  const c = invoices.get(item);
  if (c && Date.now() - c.at < INVOICE_MS) return;
  const r = await botPost<{ link?: string }>('/shop/buy', { item });
  if (r?.link?.startsWith('https://t.me/')) invoices.set(item, { link: r.link, at: Date.now() });
}

const ownsItem = (s: ShopState | null, item: string) => !!s && (s.items.includes(item) || !!s.effects?.some((e) => e === item));

/**
 * Покупка с сайта (вход через Telegram): ссылка на счёт открывает оплату в приложении Telegram, сайт ждёт,
 * пока покупка появится у игрока (опрос, пока вкладка на виду; до 15 минут). 'pending' — не дождались.
 */
async function buyFromSite(item: string): Promise<'paid' | 'failed' | 'pending' | 'owned'> {
  const c = invoices.get(item);
  let link = c && Date.now() - c.at < INVOICE_MS ? c.link : null;
  if (!link) {
    const r = await botPost<{ link?: string; error?: string }>('/shop/buy', { item });
    if (r?.error === 'owned') return 'owned';
    link = r?.link?.startsWith('https://t.me/') ? r.link : null;
  }
  if (!link) return 'failed';
  invoices.delete(item);
  location.href = link;
  const t0 = Date.now();
  while (Date.now() - t0 < 15 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    if (document.visibilityState !== 'visible') continue;
    if (ownsItem(await shopState(), item)) return 'paid';
  }
  return 'pending';
}

/** Купить набор: счёт в звёздах поверх игры (на сайте — в приложении Telegram). Итог — как у Telegram; 'owned' — уже куплено. */
export async function shopBuy(item: string): Promise<'paid' | 'cancelled' | 'failed' | 'pending' | 'owned'> {
  if (!inTelegram()) return currentWebLogin() ? buyFromSite(item) : 'failed';
  const w = await bootTelegram();
  if (!w?.openInvoice || !at('6.1')) return 'failed';
  const r = await botPost<{ link?: string; error?: string }>('/shop/buy', { item });
  if (!r?.link) return 'failed';
  return new Promise((res) => {
    try {
      w.openInvoice!(r.link!, (status) => res(status));
    } catch {
      res('failed');
    }
  });
}

/** Открыть ссылку Telegram (пак стикеров, бот) поверх игры. */
export function openTelegram(url: string): void {
  const w = tg();
  if (w) w.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

/**
 * Связать игрока игрового сервера с аккаунтом Telegram (один раз на пару «телефон — аккаунт»): по связи
 * сервер после матча кладёт открытые стикеры в пак игрока и надевает купленный скин. В браузере — если игрок
 * вошёл через Telegram на сайте; иначе ничего.
 */
export async function linkTelegramOnce(): Promise<void> {
  try {
    // в браузере — по входу через Telegram на сайте (tg-login.ts)
    const tg = inTelegram() ? (await bootTelegram())?.initDataUnsafe?.user?.id : currentWebLogin()?.id;
    if (!tg) return;
    const me = await ensureGameUser();
    const key = `${tg}:${me.userId}`;
    if (localStorage.getItem('kto:tglink') === key) return;
    // пояс телефона — чтобы бот не писал напоминания ночью
    const r = await botPost<{ ok?: boolean }>('/shop/link', { token: me.token, tz: new Date().getTimezoneOffset() });
    if (r?.ok) localStorage.setItem('kto:tglink', key);
  } catch {
    /* нет сети или приватный режим — свяжем в следующий раз */
  }
}
