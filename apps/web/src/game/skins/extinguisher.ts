import { PAL } from '@kto/assets';
import { F, frameSpec } from '../sprites';
import type { Arms, Face, Legs, View } from '../themes/types';
import { canvas, grid } from '../pixels';
import type { Ctx } from '../pixels';

/**
 * Набор «Огнетушка» (гардероб): ростовая кукла-огнетушитель, лицо актёра — в окошке. Настроение — «всё по
 * сценарию»: вокруг горит, а он спокоен. Кадр — как у Кот-банана: 18×30, ноги на 28-й строке, середина — 9-й
 * столбец, поэтому скин встаёт на место человечка без правок раскладки. Позы — те же `F.*`: что делают руки
 * у человечка, то здесь делает шланг (поднят, машет, нацелен), а в танце из него бьёт фонтанчик пены.
 * Без DOM: холсты — из pixels.ts (тот же код рисует фильм на сервере).
 */

export const EX_W = 18;
export const EX_H = 30;
/** Где в кадре лежит левый верхний угол сетки 14×20. */
const X0 = 3;
const Y0 = 9;

const MAP: Record<string, string> = {
  o: PAL.ink,
  t: PAL.steel,
  s: PAL.slate,
  m: PAL.mist,
  w: PAL.white,
  r: PAL.red,
  R: PAL.rust,
  W: PAL.wine,
  k: PAL.peach,
  f: PAL.fawn,
  y: PAL.yellow,
  a: PAL.amber,
  O: PAL.orange,
  d: PAL.dusk,
  C: PAL.cyan,
  L: PAL.blue,
  p: PAL.plum,
};

// корпус спереди: баллон, блик слева, окошко с лицом, жёлтая этикетка с пламенем, тёмное донышко
const FRONT = [
  '.....ooo......',
  '....ottto.....',
  '....otmto.....',
  '...oooooo.....',
  '..orrrrrrro...',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orwkkkkkkRo..',
  '.orwkokkokRo..',
  '.orwkkkkkkRo..',
  '.orwkkffkkRo..',
  '.orwrrrrrrRo..',
  '.orwyyyOyyRo..',
  '.orwyyOayyRo..',
  '.orwyyyyyyRo..',
  '.orrrrrrrrRo..',
  '.oWrrrrrrrWo..',
  '..oWWWWWWWo...',
];
// спиной: без окошка, этикетка — полоской
const BACK = [
  '.....ooo......',
  '....ottto.....',
  '....otmto.....',
  '...oooooo.....',
  '..orrrrrrro...',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orwrrrrrrRo..',
  '.orrrrrrrrRo..',
  '.orryyyyyyRo..',
  '.orryyyyyyRo..',
  '.orrrrrrrrRo..',
  '.orrrrrrrrRo..',
  '.oWrrrrrrrWo..',
  '..oWWWWWWWo...',
];
// сбоку (смотрит вправо): окошко у правого края, нос торчит
const SIDE = [
  '.....ooo......',
  '....ottto.....',
  '....otmto.....',
  '...oooooo.....',
  '..orrrrrRo....',
  '..orwrrrRo....',
  '..orwrokkko...',
  '..orwrokoko...',
  '..orwrokkkko..',
  '..orwrokffo...',
  '..orwrrrrRo...',
  '..orwyyyyRo...',
  '..orwOayyRo...',
  '..orwyyyyRo...',
  '..orwrrrrRo...',
  '..orrrrrrRo...',
  '..oWrrrrrWo...',
  '...oWWWWWo....',
];
const LEGS: Record<'D' | 'S', Record<Legs, [string, string]>> = {
  D: {
    idle: ['...oddoddo....', '....oo.oo.....'],
    liftL: ['...oddoddo....', '....oo........'],
    liftR: ['...oddoddo....', '.......oo.....'],
  },
  S: {
    idle: ['...oddddo.....', '....oooo......'],
    liftL: ['...oddddo.....', '...oo.........'],
    liftR: ['...oddddo.....', '......oo......'],
  },
};

/** Как держит шланг. */
export type Hose = 'hang' | 'back' | 'up' | 'upL' | 'upR' | 'aim' | 'front' | 'none';

/** Путь шланга (клетки сетки) и наконечник: тело шланга — сталь, контур дорисуется сам. */
const HOSE: Record<Exclude<Hose, 'none'>, { core: [number, number][]; tip: [number, number][] }> = {
  // висит сбоку до пояса
  hang: { core: [[9, 1], [10, 2], [11, 3], [12, 4], [12, 5], [12, 6], [12, 7], [12, 8], [12, 9], [12, 10]], tip: [[12, 11], [12, 12]] },
  // спиной: висит с другого бока
  back: { core: [[3, 1], [2, 2], [1, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 9], [0, 10]], tip: [[0, 11], [0, 12]] },
  // поднят над головой
  up: { core: [[9, 1], [10, 0], [11, -1], [11, -2], [12, -3]], tip: [[12, -4], [12, -5]] },
  // машет: наконечник то влево, то вправо
  upL: { core: [[9, 1], [10, 0], [10, -1], [10, -2], [9, -3]], tip: [[9, -4], [8, -5]] },
  upR: { core: [[9, 1], [10, 0], [11, -1], [12, -2], [13, -2]], tip: [[14, -3], [14, -4]] },
  // сбоку: нацелен вперёд, на уровне этикетки
  aim: { core: [[9, 1], [10, 2], [11, 3], [11, 4], [11, 5], [11, 6], [11, 7], [11, 8], [11, 9]], tip: [[12, 10], [13, 10]] },
  // спереди: шланг загибается к зрителю, наконечник смотрит прямо в камеру
  front: { core: [[9, 1], [10, 2], [11, 3], [12, 4], [12, 5], [12, 6], [12, 7], [12, 8]], tip: [] },
};

const hoseOf = (arms: Arms, view: View): Hose => {
  if (view === 'S') return arms === 'guard' || arms === 'jab' ? 'aim' : 'none';
  if (view === 'U') return 'back';
  if (arms === 'up') return 'up';
  if (arms === 'waveA' || arms === 'leftUp') return 'upL';
  if (arms === 'waveB' || arms === 'rightUp') return 'upR';
  return 'hang';
};

export interface ExOpts {
  /** Лицо вместо позы кадра. */
  face?: Face;
  /** Шланг вместо позы кадра. */
  hose?: Hose;
  /** Фонтанчик пены из наконечника: номер фазы (0…3), null — нет. */
  foam?: number | null;
  /** Копоть на корпусе (стикер «Норм»). */
  soot?: boolean;
  /** Пшик из наконечника (удар в бое с тенью): 1 — есть, 0 — нет. */
  jet?: number;
}

/** Кадр Огнетушки для кадра человечка `frame` (F.*): 18×30, чёрный контур — в самой сетке. */
export function extinguisherFrame(frame: number, o: ExOpts = {}): HTMLCanvasElement {
  const spec = frameSpec(frame);
  const view = spec.view;
  const face = o.face ?? spec.face;
  const hose = o.hose ?? hoseOf(spec.arms, view);
  // в игре: танцует и прыгает — фонтанчик пены, бьёт с тенью — струя
  const foamPh = o.foam !== undefined ? o.foam : face === 'happy' && hose !== 'hang' ? frame : null;
  const jet = o.jet ?? (spec.arms === 'jab' ? 1 : 0);
  const m: string[][] = Array.from({ length: EX_H }, () => Array<string>(EX_W).fill('.'));
  const get = (x: number, y: number) => m[y + Y0]?.[x + X0];
  const set = (x: number, y: number, ch: string) => {
    const r = m[y + Y0];
    if (r && x + X0 >= 0 && x + X0 < EX_W) r[x + X0] = ch;
  };
  const body = view === 'U' ? BACK : view === 'S' ? SIDE : FRONT;
  body.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && set(x, y, ch)));
  // лицо
  if (view === 'D') {
    const E: [number, number][] = [[5, 8], [8, 8]];
    if (face === 'blink') {
      for (const [x, y] of E) set(x, y, 'k');
      for (const x of [4, 5, 8, 9]) set(x, 8, 'o');
    } else if (face === 'wide') {
      for (const [x, y] of E) {
        set(x, y, 'o');
        set(x, y - 1, 'o');
      }
      set(6, 10, 'o');
      set(7, 10, 'o');
    } else if (face === 'dizzy') {
      // глаза вразнобой, рот волной
      set(8, 8, 'k');
      set(8, 9, 'o');
      set(5, 7, 'o');
      set(5, 8, 'k');
      for (const [x, y] of [[5, 10], [6, 10], [7, 10], [8, 10]] as const) set(x, y, x % 2 ? 'o' : 'k');
    } else if (face === 'happy') {
      // глаза открыты, рот до ушей
      for (const [x, y] of [[5, 9], [8, 9], [6, 10], [7, 10]] as const) set(x, y, 'o');
    }
  } else if (view === 'S' && face === 'blink') {
    set(7, 7, 'o');
    set(8, 7, 'k');
  }
  if (frame === F.STARTLE + 1) {
    set(0, 7, 'C');
    set(0, 8, 'L');
  }
  if (o.soot) for (const [x, y] of [[3, 5], [7, 4], [9, 6], [4, 12], [9, 14], [2, 15], [6, 16], [8, 11], [5, 2]] as const) if (get(x, y) !== 'o' && get(x, y) !== 'k') set(x, y, 'p');
  // шланг: тело — сталь, наконечник — светлее, контур вокруг — сам
  const core: [number, number, string][] = [];
  if (hose !== 'none') {
    const h = HOSE[hose];
    for (const [x, y] of h.core) core.push([x, y, 't']);
    for (const [x, y] of h.tip) core.push([x, y, 's']);
    if (hose === 'front') {
      // раструб к зрителю: кольцо 3×3 со тёмной серединкой
      for (let y = 9; y <= 11; y++) for (let x = 11; x <= 13; x++) core.push([x, y, x === 12 && y === 10 ? 'o' : x === 11 && y === 9 ? 'm' : 's']);
    }
  }
  for (const [x, y, ch] of core) set(x, y, ch);
  for (const [x, y] of core) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (get(x + dx, y + dy) === '.') set(x + dx, y + dy, 'o');
  }
  // ноги
  const legs = LEGS[view === 'S' ? 'S' : 'D'][spec.legs];
  const shift = spec.shift;
  if (shift) {
    for (let y = 0; y < Y0 + 18; y++) {
      const row = m[y];
      const pad = Array<string>(Math.abs(shift)).fill('.');
      if (shift > 0) {
        row.unshift(...pad);
        row.splice(EX_W);
      } else {
        row.splice(0, -shift);
        row.push(...pad);
      }
    }
  }
  legs.forEach((row, i) => [...row].forEach((ch, x) => ch !== '.' && set(x, 18 + i, ch)));
  // пена: фонтанчик из поднятого наконечника (танец) или струя вперёд (удар)
  const foam: [number, number, string][] = [];
  if (foamPh !== null && hose !== 'none' && hose !== 'hang' && hose !== 'back' && hose !== 'aim' && hose !== 'front') {
    const tip = HOSE[hose].tip[HOSE[hose].tip.length - 1];
    const tx = tip[0] + shift;
    const ty = tip[1] - 1;
    const ph = foamPh % 4;
    const DROPS: [number, number][][] = [
      [[0, 0], [0, -1], [-1, -3], [1, -4]],
      [[0, 0], [0, -1], [0, -2], [-1, -4], [2, -4]],
      [[0, 0], [0, -1], [-1, -2], [1, -2], [-2, -4], [2, -5]],
      [[0, 0], [-1, -1], [1, -1], [-2, -3], [2, -3], [0, -4]],
    ];
    for (const [dx, dy] of DROPS[ph]) foam.push([tx + dx, ty + dy, dy > -2 ? 'w' : 'm']);
  }
  if (jet && hose === 'aim') for (const [x, y, ch] of [[14, 10, 'w'], [14, 9, 'm'], [14, 11, 'm']] as const) foam.push([x, y, ch]);
  if (face === 'dizzy' && view === 'D') for (const [x, y, ch] of [[6, -1, 'm'], [7, -2, 'w'], [8, -1, 'm'], [5, -2, 'm'], [9, -3, 'm'], [7, -3, 'm']] as const) foam.push([x + shift, y, ch]);
  for (const [x, y, ch] of foam) if (get(x, y) === '.') set(x, y, ch);
  const { c, g } = canvas(EX_W, EX_H);
  grid(
    g,
    0,
    0,
    m.map((r) => r.join('')),
    MAP,
  );
  return c;
}

/** Язык пламени (витрина и стикеры): ширина `w` у основания, высота `h`; пояса от красного края к жёлтой сердцевине. */
export function flame(g: Ctx, cx: number, base: number, w: number, h: number): void {
  const bands: [number, string][] = [[1, PAL.red], [0.78, PAL.orange], [0.55, PAL.amber], [0.3, PAL.yellow]];
  for (const [kk, col] of bands) {
    const hh = Math.round(h * kk);
    const ww = w * kk + (kk < 1 ? 1 : 0);
    g.fillStyle = col;
    for (let y = 0; y < hh; y++) {
      const hw = (ww / 2) * (1 - y / hh) ** 0.8;
      const x0 = Math.round(cx - hw);
      const x1 = Math.round(cx + hw);
      if (x1 > x0) g.fillRect(x0, base - y, x1 - x0, 1);
    }
  }
}

/** Круг пикселями (без сглаживания). */
export function disc(g: Ctx, cx: number, cy: number, r: number, col: string): void {
  g.fillStyle = col;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy;
    if (Math.abs(dy) > r) continue;
    const hw = Math.sqrt(r * r - dy * dy);
    const x0 = Math.round(cx - hw);
    const x1 = Math.round(cx + hw);
    if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1);
  }
}

/** Кадр Огнетушки в позе стоя (значки, иконки). */
export const extinguisherStand = (): HTMLCanvasElement => extinguisherFrame(F.D);
