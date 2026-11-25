/**
 * Ошибки JS с телефонов → свой сервер (`POST /v1/errors`) → трекер ошибок (apps/server/src/errors.ts):
 * группы в базе, стек по source maps, новые — в чат тревог; заодно журнал → VictoriaLogs и Grafana,
 * счётчик — для тревоги сторожа после выкладки (docs/architecture.md › 7).
 *
 * - Ловит `error` (исключения, в том числе из игрового цикла Phaser и непойманные ошибки React)
 *   и `unhandledrejection`; пойманное вручную — `reportError(e, 'где')`.
 * - С ошибкой уходит контекст: платформа (ОС, браузер, Telegram, PWA, язык), экран и комната, тема,
 *   фаза и дубль (`setErrorScene` из сцены), последние шаги (lib/crumbs.ts). Без имён, id и IP; из ссылок
 *   вычищаются параметры и фрагмент (там tgWebAppData с данными игрока из Telegram).
 * - Не больше 10 разных ошибок за заход, повтор той же — не шлёт. «Script error.» без подробностей
 *   (чужой скрипт) и шум браузеров отбрасываем: по ним ничего не починить.
 * - Включено там же, где аналитика (`trackingEnabled`): не на localhost, не с `?dev`, не в автономном HTML.
 * - Сам репортёр никогда не бросает и не мешает игре.
 */
import { errorContext, trackingEnabled, inAppBrowser } from './analytics';
import { crumbs, errorScene } from './crumbs';
import { GAME_API } from './env';
import { inTelegram } from './telegram';

const MAX_PER_PAGE = 10;
const NOISE = [/^Script error\.?$/i, /ResizeObserver loop/i, /^Load failed$/i, /^cancel(l)?ed$/i, /AbortError/i];
const BUILD = (process.env.NEXT_PUBLIC_BUILD || 'dev').slice(0, 7);

let installed = false;
const seen = new Set<string>();

export interface ClientErrorBody {
  /** сообщение */
  m: string;
  /** вид: error | rejection | caught */
  k: 'error' | 'rejection' | 'caught';
  /** файл:строка:столбец */
  f?: string;
  s?: string;
  /** путь страницы (код комнаты скрыт) */
  p: string;
  /** версия сайта (короткий sha) */
  b: string;
  ua: string;
  /** встроенный браузер: telegram, instagram… */
  a?: string;
  /** контекст: os, br, app, pwa, lang, mode, room, theme, phase, round… */
  c?: Record<string, string>;
  /** последние шаги */
  bc?: string[];
}

/** Ссылки без параметров и фрагмента: в них бывают данные игрока (tgWebAppData) и метки приглашений. */
export function scrubUrls(s: string): string {
  return s.replace(/(\bhttps?:\/\/[^\s?#()'"]*)[?#][^\s()'"]*/g, '$1').replace(/tgWebApp\w*=[^\s&'"]*/g, 'tgWebApp…');
}

function describe(reason: unknown): { m: string; s?: string } {
  if (reason instanceof Error) return { m: `${reason.name}: ${reason.message}`, s: reason.stack };
  if (typeof reason === 'string') return { m: reason };
  try {
    return { m: JSON.stringify(reason)?.slice(0, 300) ?? String(reason) };
  } catch {
    return { m: String(reason) };
  }
}

/** Тело запроса; null — не слать (шум, повтор, лимит). Отдельно от отправки — для тестов. */
export function errorBody(kind: ClientErrorBody['k'], reason: unknown, where?: string): ClientErrorBody | null {
  const d = describe(reason);
  const m = scrubUrls(d.m);
  if (!m || NOISE.some((re) => re.test(m))) return null;
  const key = `${kind}|${m}|${where ?? ''}`;
  if (seen.has(key) || seen.size >= MAX_PER_PAGE) return null;
  seen.add(key);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  let c: Record<string, string> | undefined;
  try {
    c = { ...errorContext(), ...errorScene() };
  } catch {
    c = undefined;
  }
  return {
    m: m.slice(0, 300),
    k: kind,
    f: where ? scrubUrls(where).slice(0, 200) : undefined,
    s: d.s ? scrubUrls(d.s).slice(0, 4000) : undefined,
    p: typeof location === 'undefined' ? '' : location.pathname.replace(/^\/r\/[A-Za-z]{4}/, '/r/'),
    b: BUILD,
    ua: ua.slice(0, 200),
    a: (inTelegram() ? 'telegram' : inAppBrowser(ua)) ?? undefined,
    c,
    bc: crumbs(),
  };
}

function send(body: ClientErrorBody): void {
  try {
    void fetch(`${GAME_API}/v1/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* нет сети — не страшно */
  }
}

/** Сообщить о пойманной ошибке (игра продолжается): `reportError(e, 'clip')`. */
export function reportError(e: unknown, where?: string): void {
  try {
    if (typeof window === 'undefined' || !trackingEnabled()) return;
    const b = errorBody('caught', e, where);
    if (b) send(b);
  } catch {
    /* репортёр не ломает игру */
  }
}

/** Повесить обработчики один раз на заход. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined' || !trackingEnabled()) return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    try {
      // ошибки загрузки картинок и скриптов приходят без message — их не шлём
      if (!e.message && !e.error) return;
      const where = e.filename ? `${e.filename.replace(location.origin, '')}:${e.lineno}:${e.colno}` : undefined;
      const b = errorBody('error', e.error ?? e.message, where);
      if (b) send(b);
    } catch {
      /* репортёр не ломает игру */
    }
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      const b = errorBody('rejection', e.reason);
      if (b) send(b);
    } catch {
      /* репортёр не ломает игру */
    }
  });
}
