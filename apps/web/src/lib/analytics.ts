/**
 * Аналитика воронки: события пачками на свой сервер (`POST /v1/events`, таблица `analytics_events`
 * в Postgres сервера; раньше — RPC `log_events` в Supabase). Без имён и IP.
 *
 * - `device_id` — случайный id телефона (localStorage), `session_id` — один заход на страницу;
 *   `user_id` сервер берёт из токена, если игрок уже вошёл анонимно.
 * - Отправка «выстрелил и забыл»: ошибки и отсутствие сети молча глотаются, игра не ждёт.
 * - Вход не нужен: токен игрока читается из того же localStorage, куда его кладёт `lib/game-server`
 *   (песочница не должна тянуть сеть и авторизацию). Тело — JSON с типом text/plain: так браузер
 *   шлёт без предварительного запроса CORS, в том числе с keepalive при закрытии вкладки.
 * - Выключено: в автономном HTML (file:), на localhost и с `?dev` — чтобы проверки не мешали цифрам.
 *   Включить для проверки: `localStorage['kto:track'] = '1'`.
 *
 * Метка `?src=` во входящей ссылке (invite, qr, clip, card…) запоминается на заход (`src`)
 * и навсегда — первая (`src0`): откуда человек пришёл впервые.
 */
import { GAME_API } from './env';
import { inTelegram } from './telegram';

export type Props = Record<string, string | number | boolean | null | undefined>;

interface Ev {
  n: string;
  r?: string;
  p: Props;
}

/** Контекст экрана: подмешивается в каждое событие (комната, режим, режиссёр ли). */
let ctx: { room?: string; mode?: 'online' | 'sandbox' | 'tutorial'; host?: boolean } = {};
let queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let base: Props | null = null;
let device = '';
let session = '';
let bound = false;

const SRC_RE = /^[a-z0-9_-]{1,24}$/;

/** Слать ли аналитику и ошибки (lib/errors.ts): не на localhost, не с `?dev`, не в автономном HTML. */
export function trackingEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem('kto:track') === '1') return true;
  } catch {
    /* приватный режим */
  }
  if (!/^https?:$/.test(location.protocol)) return false;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) return false;
  return !new URLSearchParams(location.search).has('dev');
}

function rid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function store(kind: 'local' | 'session', k: string, make: () => string | null): string | null {
  try {
    const s = kind === 'local' ? localStorage : sessionStorage;
    const v = s.getItem(k);
    if (v) return v;
    const nv = make();
    if (nv) s.setItem(k, nv);
    return nv;
  } catch {
    return make();
  }
}

/** Встроенный браузер мессенджера или соцсети — по User-Agent (iOS-Telegram его не выдаёт). */
export function inAppBrowser(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string | null {
  if (/Telegram/i.test(ua)) return 'telegram';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  if (/VKAndroidApp|com\.vk/i.test(ua)) return 'vk';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'tiktok';
  if (/; wv\)/.test(ua)) return 'webview';
  return null;
}

function os(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function browser(ua: string): string {
  if (/CriOS/.test(ua)) return 'chrome-ios';
  if (/FxiOS|Firefox/.test(ua)) return 'firefox';
  if (/YaBrowser/.test(ua)) return 'yandex';
  if (/SamsungBrowser/.test(ua)) return 'samsung';
  if (/Edg/.test(ua)) return 'edge';
  if (/Chrome/.test(ua)) return 'chrome';
  if (/Safari/.test(ua)) return 'safari';
  return 'other';
}

/** Общие свойства захода: считаются один раз. */
function baseProps(): Props {
  if (base) return base;
  const ua = navigator.userAgent;
  const q = new URLSearchParams(location.search).get('src');
  const src = q && SRC_RE.test(q) ? q : null;
  let ref: string | null = null;
  try {
    const h = document.referrer ? new URL(document.referrer).hostname : '';
    ref = h && h !== location.hostname ? h : null;
  } catch {
    ref = null;
  }
  base = {
    src: store('session', 'kto:src', () => src),
    src0: store('local', 'kto:src0', () => src ?? (ref ? 'ref' : 'direct')),
    ref,
    os: os(ua),
    br: browser(ua),
    app: inTelegram() ? 'telegram' : inAppBrowser(ua),
    pwa: typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
    lang: document.documentElement.lang || null,
  };
  return base;
}

/** Токен игрока на своём сервере (если уже входил в комнату). */
function token(): string | null {
  try {
    const raw = localStorage.getItem('kto:auth2');
    if (!raw) return null;
    return (JSON.parse(raw) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

function flush(keepalive = false): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length) return;
  const events = queue.slice(0, 30);
  queue = queue.slice(30);
  try {
    void fetch(`${GAME_API}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ d: device, s: session, t: token(), e: events }),
      keepalive,
    }).catch(() => undefined);
  } catch {
    /* нет fetch или сети — не страшно */
  }
  if (queue.length) flush(keepalive);
}

function bind(): void {
  if (bound) return;
  bound = true;
  device = store('local', 'kto:did', rid) ?? rid();
  session = rid();
  // уход со страницы или сворачивание: отправить, что накопилось (keepalive переживает закрытие вкладки)
  addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
}

/** Записать событие. name — латиница в нижнем регистре и `_` (до 40 знаков), props — плоские значения. */
export function track(name: string, props: Props = {}): void {
  if (!trackingEnabled()) return;
  try {
    bind();
    const p: Props = { ...baseProps(), mode: ctx.mode, host: ctx.host, path: location.pathname.replace(/^\/r\/[A-Z]{4}$/, '/r/'), ...props };
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    queue.push({ n: name, r: ctx.room, p });
    timer ??= setTimeout(() => flush(), 1500);
  } catch {
    /* аналитика никогда не ломает игру */
  }
}

/** Контекст экрана: комната, режим, режиссёр ли. Подмешивается в события до следующего вызова. */
export function setTrackContext(next: typeof ctx): void {
  ctx = { ...next };
}

/** Вид отправленного: клип (видео), карточка (картинка) или текст. Для метки `?src=`. */
export function shareKind(files?: File[]): 'clip' | 'card' | 'text' {
  const t = files?.[0]?.type ?? '';
  return t.startsWith('video') ? 'clip' : t.startsWith('image') ? 'card' : 'text';
}
