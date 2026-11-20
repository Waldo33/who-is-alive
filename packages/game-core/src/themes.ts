import type { EmoteKind } from './events';

/**
 * Темы раунда («площадки»): костюм толпы + локация + музыка + свои события и текстовки.
 *
 * Здесь — только то, что влияет на правила и должно совпадать у всех: порядок тем (по сети
 * ходит индекс), «изнанка» (внезапная смена облика посреди дубля) и как ведёт себя толпа
 * в изнанке. Всё остальное — арт, музыка — живёт в клиенте отдельным пакетом на тему
 * (`apps/web/src/game/themes/`), а тексты — в словарях (`themeText`).
 *
 * Новая тема: id в конец THEME_RULES (порядок существующих не менять — индекс уходит в сеть),
 * название в `themes` словарей, пакет в клиенте. См. docs/architecture.md › «Темы».
 */

export type ThemeId = 'caps' | 'chefs' | 'penguins' | 'cosmonauts' | 'office';

export interface TwistRules {
  /** Когда изнанка включается впервые, с начала игры, сек [от, до]. */
  firstSec: [number, number];
  /** Сколько длится, сек [от, до]. */
  onSec: [number, number];
  /** Пауза до следующего раза, сек [от, до]. */
  gapSec: [number, number];
  /** Сколько раз за дубль, не больше. */
  max: number;
  /** Эмоция толпы в изнанке — у ботов и у игроков одна и та же. */
  emote?: EmoteKind;
  /** Во сколько раз чаще боты показывают эмоцию в изнанке. */
  emoteMul?: number;
}

export interface ThemeRules {
  id: ThemeId;
  /** Внезапная смена облика посреди дубля: офис → подвал, клерки → бойцы. */
  twist?: TwistRules;
}

export const THEME_RULES: readonly ThemeRules[] = [
  { id: 'caps' },
  { id: 'chefs' },
  { id: 'penguins' },
  { id: 'cosmonauts' },
  {
    id: 'office',
    twist: { firstSec: [14, 26], onSec: [14, 20], gapSec: [10, 16], max: 2, emote: 'jab', emoteMul: 4 },
  },
];

export const THEME_COUNT = THEME_RULES.length;

export function themeRules(theme: number): ThemeRules {
  return THEME_RULES[theme] ?? THEME_RULES[0];
}

/** Эмоция, которую в изнанке показывают все (и боты, и кнопка эмоции у игроков), или null. */
export function twistEmote(theme: number, twistOn: boolean): EmoteKind | null {
  return twistOn ? (themeRules(theme).twist?.emote ?? null) : null;
}
