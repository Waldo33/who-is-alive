/**
 * Вход через Telegram на сайте (браузер, не Mini App): Telegram Login Widget
 * (https://core.telegram.org/widgets/login). Окно входа открывает oauth.telegram.org, игрок подтверждает вход
 * в приложении Telegram, сайт получает подписанные данные { id, first_name, username, auth_date, hash, … }.
 * Подпись проверяет сервер бота (bot.ts › verifyLogin) — так же, как initData из Mini App. Данные хранятся в
 * браузере 30 дней и уходят вместо initData в /tg/shop/*: гардероб, стикерпак и связь игрока с Telegram
 * (скин в комнате) работают и в браузере. Нужен домен сайта у бота: BotFather › /setdomain.
 */
import { GAME_API } from './env';

export interface TgLogin {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

const KEY = 'kto:tglogin';
/** Столько же принимает сервер (bot.ts › LOGIN_TTL_SEC); на день раньше — чтобы не упереться в границу. */
const TTL_MS = 29 * 86_400_000;
const WIDGET = 'https://telegram.org/js/telegram-widget.js?22';

type LoginApi = { auth: (o: { bot_id: number; request_access?: string; lang?: string }, cb: (data: TgLogin | false) => void) => void };

/** Сохранённый вход (null — не входил, вышел или вход устарел). */
export function webLogin(): TgLogin | null {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null') as TgLogin | null;
    if (!d || typeof d.id !== 'number' || typeof d.hash !== 'string' || typeof d.auth_date !== 'number') return null;
    if (Date.now() - d.auth_date * 1000 > TTL_MS) return null;
    return d;
  } catch {
    return null;
  }
}

export function webLogout(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem('kto:tglink');
    localStorage.removeItem('kto:shop');
  } catch {
    /* приватный режим */
  }
}

let botId: number | null = null;
let preparing: Promise<boolean> | null = null;

/**
 * Подготовить вход заранее (при открытии страницы): скрипт Telegram и id бота. Окно входа надо открыть прямо в
 * нажатии (иначе браузер заблокирует его), поэтому к нажатию всё должно быть загружено. false — вход недоступен.
 */
export function prepareWebLogin(): Promise<boolean> {
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      const [info] = await Promise.all([
        fetch(`${GAME_API}/tg/info`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? (r.json() as Promise<{ id?: unknown }>) : null)),
        loadWidget(),
      ]);
      botId = typeof info?.id === 'number' ? info.id : null;
      return !!botId && !!loginApi();
    } catch {
      preparing = null;
      return false;
    }
  })();
  return preparing;
}

function loginApi(): LoginApi | null {
  return (window as unknown as { Telegram?: { Login?: LoginApi } }).Telegram?.Login ?? null;
}

function loadWidget(): Promise<void> {
  if (loginApi()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = WIDGET;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('widget'));
    document.head.appendChild(s);
  });
}

/**
 * Войти: открывает окно Telegram (звать прямо из нажатия, после prepareWebLogin). Итог — данные входа или
 * null (закрыл окно, отказал, вход не готов). request_access: 'write' — бот сможет прислать стикерпак в личку.
 */
export function startWebLogin(lang: 'ru' | 'en'): Promise<TgLogin | null> {
  const api = loginApi();
  if (!api || !botId) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.auth({ bot_id: botId!, request_access: 'write', lang }, (data) => {
        if (!data || typeof data.id !== 'number' || typeof data.hash !== 'string') return resolve(null);
        try {
          localStorage.setItem(KEY, JSON.stringify(data));
        } catch {
          /* приватный режим: вход только на эту страницу */
        }
        mem = data;
        resolve(data);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Вход этой страницы, если localStorage недоступен (приватный режим). */
let mem: TgLogin | null = null;
export function currentWebLogin(): TgLogin | null {
  return webLogin() ?? mem;
}
