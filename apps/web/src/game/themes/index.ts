import { THEME_RULES } from '@kto/game-core';
import type { ThemeId } from '@kto/game-core';
import { PARK_CHARS } from '../sprites';
import type { Look, ThemePack } from './types';

export type { Look, ThemePack } from './types';

/**
 * Реестр пакетов тем. Парк (кепки) встроен — это облик по умолчанию; остальные темы —
 * отдельные модули, которые сборщик кладёт в свои файлы и грузит только по требованию.
 *
 * Новая тема: id в game-core (themes.ts › THEME_RULES), название в словарях (`themes`),
 * файл themes/<id>.ts с `export default pack` и строка здесь.
 */
const PARK: ThemePack = { looks: [{ chars: PARK_CHARS }] };

const LOADERS: Record<ThemeId, () => Promise<{ default: ThemePack }>> = {
  caps: async () => ({ default: PARK }),
  chefs: () => import('./kitchen'),
  penguins: () => import('./ice'),
  cosmonauts: () => import('./moon'),
  office: () => import('./office'),
};

const loaded = new Map<number, ThemePack>([[0, PARK]]);
const loading = new Map<number, Promise<ThemePack>>();

function idOf(theme: number): ThemeId | null {
  return THEME_RULES[theme]?.id ?? null;
}

/** Пакет темы, если уже загружен (иначе — парк: рисовать есть чем всегда). */
export function themePack(theme: number): ThemePack {
  return loaded.get(theme) ?? PARK;
}

export function isThemeLoaded(theme: number): boolean {
  return loaded.has(theme) || !idOf(theme);
}

/** Загрузить пакет темы (один раз; повторные вызовы ждут ту же загрузку). */
export function loadTheme(theme: number): Promise<ThemePack> {
  const have = loaded.get(theme);
  if (have) return Promise.resolve(have);
  const id = idOf(theme);
  if (!id) return Promise.resolve(PARK);
  let p = loading.get(theme);
  if (!p) {
    p = LOADERS[id]()
      .then((m) => {
        loaded.set(theme, m.default);
        return m.default;
      })
      .catch(() => {
        // нет сети или устаревшая вкладка — играем в парке, попробуем ещё раз в следующий раз
        loading.delete(theme);
        return PARK;
      });
    loading.set(theme, p);
  }
  return p;
}

/** Подгрузить все темы в фоне, когда браузер свободен: к следующему дублю всё уже будет. */
export function preloadThemes(): void {
  const run = () => THEME_RULES.forEach((_, i) => void loadTheme(i));
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

/**
 * Загрузить все темы до старта игры (вместе со шрифтом — параллельно), но не дольше timeoutMs:
 * иначе первый кадр дубля мелькнёт парком, а потом переоденется.
 */
export function loadAllThemes(timeoutMs = 2500): Promise<void> {
  const all = Promise.all(THEME_RULES.map((_, i) => loadTheme(i))).then(() => undefined);
  return Promise.race([all, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

/** Облик темы: 0 — обычный, 1 — изнанка (если у темы её нет — обычный). */
export function themeLook(theme: number, look: number): Look {
  const p = themePack(theme);
  return p.looks[look] ?? p.looks[0];
}

/** Сколько обликов у загруженной темы. */
export function lookCount(theme: number): number {
  return themePack(theme).looks.length;
}
