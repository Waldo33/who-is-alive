import type { ArenaDef } from '@kto/game-core';
import type { Flavor, Song } from '../music';

/**
 * Пакет темы («площадки») для клиента: облик толпы, локация, музыка. Каждый пакет —
 * отдельный модуль, который грузится только когда тема выпала (themes/index.ts), поэтому
 * темы не утяжеляют первую загрузку. Правила темы (изнанка, эмоция толпы) — в game-core
 * (themes.ts), тексты — в словарях (`themeText`).
 *
 * Раскладка арены одна на всех (game-core: от неё зависят ходьба, боты и сужение зоны),
 * поэтому пакет меняет только облик: тот же след на земле — другой предмет того же размера
 * и с тем же числом кадров (фонтан — 4 кадра 34×34, фонарь — 2 кадра 9×26…).
 * Чего пакет не задал, берётся из парка (sprites.ts).
 */

export type View = 'D' | 'U' | 'S';

/** [холст, ширина кадра, высота кадра, число кадров] */
export type PropArt = [HTMLCanvasElement, number, number, number];
export type PropSet = Record<string, () => PropArt>;

/** Костюм толпы: цвета букв шаблона персонажа (sprites.ts › HEAD/BODY/LEGS) и правки поверх. */
export interface CharStyle {
  map: Record<string, string>;
  /** Особые правки поверх кадра (колпак повара, шлем космонавта). */
  patch?: (m: string[][], view: View) => void;
}

export interface Look {
  chars: CharStyle;
  /** Земля арены целиком (arena.width × arena.height). */
  ground?: (arena: ArenaDef) => HTMLCanvasElement;
  /** Предмет арены по виду (fountain, tree, lamp, benchH, benchV, stall, planter). */
  prop?: (kind: string) => PropArt | null;
  /** Плитка 8×8 стенки сужающейся зоны. */
  wall?: () => HTMLCanvasElement;
  /** Зверёк: 6 кадров 6×6 (0–1 стоит, 2–5 убегает). Получает кадры голубя — можно перекрасить их. */
  critter?: (pigeonFrames: string[][]) => HTMLCanvasElement;
}

export interface ThemePack {
  /** [0] — обычный облик; [1] — изнанка, если у темы в game-core есть twist. */
  looks: Look[];
  /** Характер музыки дубля: тембры и темп общей темы — или своя песня. */
  music?: { flavor: Flavor; song?: Song };
  /** «25-й кадр»: в обычном облике иногда на кадр мелькает персонаж из изнанки. */
  subliminal?: boolean;
}
