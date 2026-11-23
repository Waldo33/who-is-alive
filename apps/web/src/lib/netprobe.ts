/**
 * Замер доступности (docs/infra-plan.md › этап 0): кто до какого сервера достаёт — Москва или Европа.
 * От него зависит, нужен ли после переезда игры в Европу российский вход в Москве.
 *
 * Раз в сутки на телефон, через несколько секунд после открытия страницы, в фоне:
 * - HTTPS: короткий `GET /v1/probe` — «достаю ли» и за сколько;
 * - 64 КБ: `GET /v1/probe?kb=64` — ловит фильтр, который глушит соединение после первых ~16 КБ;
 * - WebSocket: рукопожатие на `/ws` (без входа в комнату) — так ходит сама игра.
 * Итог — событие `net_probe` туда, куда достал (сначала Москва, иначе Европа: сервер в Нидерландах
 * пересылает его в Москву). Сервер дописывает страну адреса (`cc`); часовой пояс телефона (`tz`) рядом —
 * по ним видно «скорее всего VPN». Ничего не мешает игре: ошибки глотаются, игра замера не ждёт.
 */
import { drainOutbox, trackNow, trackingEnabled } from './analytics';
import { GAME_API } from './env';

/** Европейская точка замера: сервер бота в Нидерландах (Timeweb), там же будет игра после переезда. */
export const EU_PROBE = (process.env.NEXT_PUBLIC_EU_PROBE || 'https://72-56-73-184.sslip.io').replace(/\/$/, '');

const KEY = 'kto:probe';
const EVERY_MS = 24 * 3600_000;
const TIMEOUT_MS = 6000;

export interface ProbeResult {
  /** 1 — ответил, 0 — нет */
  http: 0 | 1;
  http_ms: number | null;
  big: 0 | 1;
  big_ms: number | null;
  ws: 0 | 1;
  ws_ms: number | null;
}

function timeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function timed(run: (signal: AbortSignal) => Promise<boolean>, ms: number): Promise<[0 | 1, number | null]> {
  const t0 = performance.now();
  const to = timeout(ms);
  try {
    const ok = await run(to.signal);
    return ok ? [1, Math.round(performance.now() - t0)] : [0, null];
  } catch {
    return [0, null];
  } finally {
    to.done();
  }
}

function wsOpen(url: string, ms: number): Promise<[0 | 1, number | null]> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve([0, null]);
      return;
    }
    const finish = (ok: boolean) => {
      clearTimeout(t);
      try {
        ws.onopen = ws.onerror = ws.onclose = null;
        ws.close(1000);
      } catch {
        /* уже закрыт */
      }
      resolve(ok ? [1, Math.round(performance.now() - t0)] : [0, null]);
    };
    const t = setTimeout(() => finish(false), ms);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}

/** Один сервер: HTTPS, 64 КБ и WebSocket — по очереди, чтобы не мешать друг другу. */
export async function probeServer(base: string): Promise<ProbeResult> {
  const [http, http_ms] = await timed(async (signal) => (await fetch(`${base}/v1/probe`, { cache: 'no-store', signal })).ok, TIMEOUT_MS);
  const [big, big_ms] = await timed(async (signal) => {
    const r = await fetch(`${base}/v1/probe?kb=64`, { cache: 'no-store', signal });
    return r.ok && (await r.arrayBuffer()).byteLength === 64 * 1024;
  }, 10_000);
  const [ws, ws_ms] = await wsOpen(`${base.replace(/^http/, 'ws')}/ws`, TIMEOUT_MS);
  return { http, http_ms, big, big_ms, ws, ws_ms };
}

function due(): boolean {
  try {
    const last = Number(localStorage.getItem(KEY) || 0);
    return !(Date.now() - last < EVERY_MS);
  } catch {
    return false;
  }
}

let started = false;

/** Запустить замер, если сегодня его на этом телефоне ещё не было. */
export function scheduleNetProbe(delayMs = 4000): void {
  if (started || typeof window === 'undefined' || !trackingEnabled() || !due()) return;
  started = true;
  setTimeout(() => void runNetProbe(), delayMs);
}

export async function runNetProbe(): Promise<void> {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* приватный режим: замер всё равно сделаем, просто чаще */
  }
  try {
    const [msk, eu] = await Promise.all([probeServer(GAME_API), probeServer(EU_PROBE)]);
    const props: Record<string, number | string | null> = {};
    for (const [k, v] of Object.entries(msk)) props[`msk_${k}`] = v;
    for (const [k, v] of Object.entries(eu)) props[`eu_${k}`] = v;
    props.tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    const nc = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
    props.net = nc?.effectiveType ?? null;
    const base = msk.http ? GAME_API : eu.http ? EU_PROBE : null;
    // никуда не достал — событие ляжет в отложенные и уйдёт при первой удачной связи
    trackNow(base ?? GAME_API, 'net_probe', props);
    // отложенное раньше (не достал до Москвы) — отправить через тот сервер, что ответил
    if (base && base !== GAME_API) void drainOutbox(base);
  } catch {
    /* замер никогда не ломает игру */
  }
}
