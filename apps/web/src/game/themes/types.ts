import type { ActKind, ArenaDef, CrowdKind } from '@kto/game-core';
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
export type Legs = 'idle' | 'liftL' | 'liftR';
export type Arms = 'down' | 'up' | 'waveA' | 'waveB' | 'leftUp' | 'rightUp' | 'guard' | 'jab';
export type Face = 'normal' | 'blink' | 'wide' | 'dizzy' | 'happy';

/**
 * Своя поза персонажа темы (кадр 12×16 поверх шаблона): база (вид, ноги, руки, лицо) и правки
 * `patch(m)` — `m[строка][столбец] = 'буква'`, буквы и цвета — из `chars.map` облика.
 * Позы дописываются в ленту персонажа после общих кадров (`F.COUNT + индекс`).
 */
export interface Pose {
  view: View;
  legs?: Legs;
  arms?: Arms;
  face?: Face;
  patch?: (m: string[][]) => void;
}

/** Анимация действия: позы по кругу через `ms`; `flip` — разворот каждые 4 кадра; `yoff` — подскок по кадрам. */
export interface ActAnim {
  poses: number[];
  ms: number;
  flip?: boolean;
  yoff?: number[];
}

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
  /**
   * Ещё костюмы толпы в этом облике: у каждой фигуры свой, по её номеру (`variantOf`) — одинаково
   * у ботов и у игроков, поэтому никого не выдаёт. Позы (`poses`) общие для всех костюмов.
   */
  variants?: CharStyle[];
  /** Земля арены целиком (arena.width × arena.height). */
  ground?: (arena: ArenaDef) => HTMLCanvasElement;
  /** Предмет арены по виду (fountain, tree, lamp, benchH, benchV, stall, planter). */
  prop?: (kind: string) => PropArt | null;
  /** Плитка 8×8 стенки сужающейся зоны. */
  wall?: () => HTMLCanvasElement;
  /** Зверёк: 6 кадров 6×6 (0–1 стоит, 2–5 убегает). Получает кадры голубя — можно перекрасить их. */
  critter?: (pigeonFrames: string[][]) => HTMLCanvasElement;
  /**
   * Свои действия: как в этом облике выглядят эмоции и команды «Море волнуется». Механика та же
   * (game-core: wave/dance/jump/freeze…), меняется только анимация — в офисе «танец» — это
   * перекур, в подвале — бой с тенью. Не заданное — общий кадр (sprites.ts › F).
   */
  poses?: Pose[];
  acts?: Partial<Record<ActKind, ActAnim>>;
  /** Пульсация поля в такт (ночной клуб): цвета по очереди, мс на цвет, сила (0–1). */
  pulse?: { colors: string[]; ms: number; alpha: number };
  /**
   * Как выглядит выбивание в этом облике: по умолчанию — облачко «поф»; 'weapon' — удар битой,
   * трубой или ножом, брызги и тело на полу до конца дубля (в детском режиме — всё равно «поф»).
   */
  kill?: 'weapon';
  /** Иконки команд «Море волнуется» 8×8 (буквы: o контур, w белый, m светлый, d сталь, n сумрак, y жёлтый, r красный, b синий, g зелёный, u бурый, f оранжевый). */
  icons?: Partial<Record<CrowdKind, string[]>>;
}

export interface ThemePack {
  /** [0] — обычный облик; [1] — изнанка, если у темы в game-core есть twist. */
  looks: Look[];
  /** Характер музыки дубля: тембры и темп общей темы — или своя песня. */
  music?: { flavor: Flavor; song?: Song };
  /**
   * Как меняется облик на изнанку: 'flicker' (по умолчанию) — свет мигнул, щелчок, резко;
   * 'dusk' — плавно, закатом: небо золотеет и лиловеет, на пике сумерек облик меняется, неон
   * проступает (и рассвет обратно); музыка переключается на границе такта.
   */
  transition?: 'flicker' | 'dusk';
  /** Подобрал звезду — мигалка и сирена («звёзды розыска»). */
  starSiren?: boolean;
  /**
   * Переодевание при смене облика на `to` (и обратно — в обратном порядке): каждая фигура со своей
   * задержкой проигрывает позы `poses` промежуточного облика `look` (те же костюмы по номеру), по `ms`.
   * Майами: на закате толпа натягивает маски.
   */
  dressUp?: { to: number; look: Pick<Look, 'chars' | 'variants' | 'poses'>; poses: number[]; ms: number };
  /** «25-й кадр»: в обычном облике иногда мелькает персонаж из изнанки (~140 мс), изредка — весь кадр изнанки (80 мс). */
  subliminal?: boolean;
  /** Своя «звезда» на поле (цветок): лента 4 кадра (10×10, как `sprites.ts › makeStar`, или крупнее — кадр = ¼ ширины). */
  star?: () => HTMLCanvasElement;
  /** «Звезда» растёт на земле: не подпрыгивает, кадры сменяются медленно (мс на кадр) — мерцает, а не мигает. */
  starStill?: number;
  /** Её значок в шапке: 2 кадра 10×10 — собранная и пустая ячейка. */
  hudStar?: () => HTMLCanvasElement;
  /** Шеф темы (game-core › boss.ts): его костюм — те же кадры, что у толпы. */
  boss?: CharStyle;
  /** Сумерки плавно уходят в ночь за дубль (game-core › sanity.ts › nightLevel): вуаль темнеет, у костра светлее. */
  night?: boolean;
}
