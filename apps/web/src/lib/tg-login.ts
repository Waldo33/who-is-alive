/**
 * Вход через Telegram на сайте (браузер, не Mini App) — через бота, как в других приложениях: сайт заранее
 * берёт одноразовый код (`/tg/login/start`), кнопка открывает бота `t.me/<бот>?start=login_<код>`, игрок жмёт
 * «Войти» в чате, сайт опрашивает `/tg/login/poll` и получает подписанные данные { id, first_name, username,
 * auth_date, hash } (формат Telegram Login Widget, сервер — web-login.ts). Подпись проверяет бот
 * (bot.ts › verifyLogin). Данные хранятся в браузере 30 дней и уходят вместо initData в /tg/shop/*: гардероб,
 * стикерпак и связь игрока с Telegram (скин в комнате) работают и в браузере. Номер телефона не нужен.
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
/** Начатый вход: код и секрет переживают уход страницы в Telegram (Safari может её выгрузить). */
const PENDING = 'kto:tglogin-wait';
/** Столько же принимает сервер (bot.ts › LOGIN_TTL_SEC); на день раньше — чтобы не упереться в границу. */
const TTL_MS = 29 * 86_400_000;
/** Код живёт на сервере 10 минут; заранее взятый обновляем раньше. */
const CODE_MS = 8 * 60_000;

interface Code {
  code: string;
  secret: string;
  link: string;
  at: number;
}

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
  mem = null;
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem('kto:tglink');
    localStorage.removeItem('kto:shop');
  } catch {
    /* приватный режим */
  }
}

let ready: Code | null = null;
let preparing: Promise<boolean> | null = null;

/**
 * Взять код заранее (при открытии страницы): Telegram надо открыть прямо в нажатии, без ожидания сети —
 * иначе Safari не отдаст ссылку приложению. false — бот недоступен.
 */
export function prepareWebLogin(): Promise<boolean> {
  if (ready && Date.now() - ready.at < CODE_MS) return Promise.resolve(true);
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      const r = await fetch(`${GAME_API}/tg/login/start`, { method: 'POST', signal: AbortSignal.timeout(8000) });
      const j = r.ok ? ((await r.json()) as Partial<Code>) : null;
      if (!j?.code || !j.secret || !j.link?.startsWith('https://t.me/')) return false;
      ready = { code: j.code, secret: j.secret, link: j.link, at: Date.now() };
      return true;
    } catch {
      return false;
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/**
 * Войти: открывает бота в Telegram (звать прямо из нажатия, после prepareWebLogin) и ждёт, пока игрок
 * нажмёт «Войти» в чате. Итог — данные входа или null (не подтвердил за 10 минут, код устарел).
 */
export function startWebLogin(): Promise<TgLogin | null> {
  const c = ready && Date.now() - ready.at < CODE_MS ? ready : null;
  if (!c) return Promise.resolve(null);
  ready = null;
  try {
    sessionStorage.setItem(PENDING, JSON.stringify(c));
  } catch {
    /* приватный режим: ждём, пока страница жива */
  }
  location.href = c.link;
  return waitLogin(c);
}

/** Вход начат и страница перезагрузилась (вернулись из Telegram): дождаться его. null — входа не начинали. */
export function resumeWebLogin(): Promise<TgLogin | null> | null {
  try {
    const c = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as Code | null;
    if (!c?.code || !c.secret || Date.now() - c.at > 10 * 60_000) return null;
    return waitLogin(c);
  } catch {
    return null;
  }
}

/** Опрос сервера раз в 2 с, пока вкладка на виду (вернулся из Telegram — сразу). */
function waitLogin(c: Code): Promise<TgLogin | null> {
  return new Promise((resolve) => {
    let timer = 0;
    let busy = false;
    const end = (l: TgLogin | null) => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      try {
        sessionStorage.removeItem(PENDING);
      } catch {
        /* приватный режим */
      }
      resolve(l);
    };
    async function tick() {
      if (busy || document.visibilityState !== 'visible') return;
      if (Date.now() - c.at > 10 * 60_000) return end(null);
      busy = true;
      try {
        const r = await fetch(`${GAME_API}/tg/login/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: c.code, secret: c.secret }),
          signal: AbortSignal.timeout(6000),
        });
        const j = r.ok ? ((await r.json()) as { state?: string; login?: TgLogin }) : null;
        if (j?.state === 'gone') return end(null);
        if (j?.state === 'ok' && j.login && typeof j.login.id === 'number') {
          try {
            localStorage.setItem(KEY, JSON.stringify(j.login));
          } catch {
            /* приватный режим: вход только на эту страницу */
          }
          mem = j.login;
          return end(j.login);
        }
      } catch {
        /* нет сети — следующий раз */
      } finally {
        busy = false;
      }
    }
    timer = window.setInterval(() => void tick(), 2000);
    document.addEventListener('visibilitychange', tick);
    void tick();
  });
}

/** Вход этой страницы, если localStorage недоступен (приватный режим). */
let mem: TgLogin | null = null;
export function currentWebLogin(): TgLogin | null {
  return webLogin() ?? mem;
}
