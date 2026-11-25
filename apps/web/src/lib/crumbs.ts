/**
 * Что было перед ошибкой (для трекера ошибок, lib/errors.ts): последние шаги и где игрок сейчас.
 * Только безличное: имена событий аналитики, фазы и тема дубля, код комнаты. Без имён игроков и текстов.
 */
const MAX = 12;
const ring: string[] = [];
let t0 = 0;

/** Сцена игры: тема, фаза, дубль, условие съёмки. */
let scene: Record<string, string> = {};

/** Записать шаг («phase:play», «room_join»). */
export function crumb(s: string): void {
  try {
    const now = typeof performance === 'undefined' ? 0 : performance.now();
    if (!t0) t0 = now || 1;
    ring.push(`${Math.round((now - t0) / 1000)}s ${s.slice(0, 60)}`);
    if (ring.length > MAX) ring.shift();
  } catch {
    /* шаги никогда не ломают игру */
  }
}

export function crumbs(): string[] {
  return ring.slice();
}

/** Где игрок в игре: подмешивается в каждую ошибку. Новая фаза или тема — заодно шаг. */
export function setErrorScene(next: Record<string, string | number | null | undefined>): void {
  for (const [k, v] of Object.entries(next)) {
    const s = v == null ? '' : String(v);
    if (scene[k] === s) continue;
    if (k === 'phase' || k === 'theme') crumb(`${k}:${s}`);
    if (s) scene[k] = s;
    else delete scene[k];
  }
}

export function errorScene(): Record<string, string> {
  return { ...scene };
}

/** Вышли из игры (страница сменилась) — сцены больше нет. */
export function clearErrorScene(): void {
  scene = {};
}
