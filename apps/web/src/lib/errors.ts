/**
 * Ошибки JS с телефонов → свой сервер (`POST /v1/errors`) → журнал → VictoriaLogs и Grafana,
 * счётчик — для тревоги сторожа после выкладки (docs/infra-plan.md › этап 0).
 *
 * - Ловит `error` (исключения, в том числе из игрового цикла Phaser) и `unhandledrejection`.
 * - Не больше 10 разных ошибок за заход, повтор той же — не шлёт. «Script error.» без подробностей
 *   (чужой скрипт) и шум браузеров отбрасываем: по ним ничего не починить.
 * - Включено там же, где аналитика (`trackingEnabled`): не на localhost, не с `?dev`, не в автономном HTML.
 * - Сам репортёр никогда не бросает и не мешает игре.
 */
import { trackingEnabled, inAppBrowser } from './analytics';
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
  /** вид: error | rejection */
  k: 'error' | 'rejection';
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
export function errorBody(kind: 'error' | 'rejection', reason: unknown, where?: string): ClientErrorBody | null {
  const { m, s } = describe(reason);
  if (!m || NOISE.some((re) => re.test(m))) return null;
  const key = `${kind}|${m}|${where ?? ''}`;
  if (seen.has(key) || seen.size >= MAX_PER_PAGE) return null;
  seen.add(key);
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return {
    m: m.slice(0, 300),
    k: kind,
    f: where,
    s: s?.slice(0, 2000),
    p: typeof location === 'undefined' ? '' : location.pathname.replace(/^\/r\/[A-Za-z]{4}/, '/r/'),
    b: BUILD,
    ua: ua.slice(0, 200),
    a: (inTelegram() ? 'telegram' : inAppBrowser(ua)) ?? undefined,
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
