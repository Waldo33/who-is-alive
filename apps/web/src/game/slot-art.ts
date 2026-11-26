import { PAL } from '@kto/assets';
import type { SlotSymbol } from '@kto/game-core';
import { SLOT_SYMBOLS } from '@kto/game-core';
import { canvas, dither, grid, px } from './pixels';

/**
 * Арт «Казино» (game-core › slots.ts): символы барабанов, автомат на поле, корпус большого автомата.
 * Без DOM — холсты из фабрики `pixels.ts`, поэтому тот же арт может нарисовать и сервер.
 */

/** Символ барабана 12×12 (буквы → цвета SYM_MAP). */
const SYM: Record<SlotSymbol, string[]> = {
  star: [
    '.....oo.....',
    '....oyyo....',
    '....oyyo....',
    'ooooowyooooo',
    'oyyyywyyyyyo',
    '.oyyyyyyyyo.',
    '..oyyyyyyo..',
    '..oyyyyyyo..',
    '.oyyyooyyyo.',
    '.oyyo..oyyo.',
    'oyoo....ooyo',
    'oo........oo',
  ],
  skull: [
    '...oooooo...',
    '..owwwwwwo..',
    '.owwwwwwwwo.',
    '.owwwwwwwmo.',
    '.ownnwwnnmo.',
    '.ownnwwnnmo.',
    '.owwwnnwwmo.',
    '..owwwwwmo..',
    '..owownomo..',
    '..ooooooo...',
    '............',
    '............',
  ],
  mask: [
    '............',
    '.oooooooooo.',
    'oaaaayyaaaao',
    'oaoooaaoooao',
    'oaaaaaaaaaao',
    'oaaaaaaaaaao',
    '.oaoaaaaoao.',
    '.oaaooooaao.',
    '..oaaaaaao..',
    '...oaaaao...',
    '....oooo....',
    '............',
  ],
  clap: [
    'oooooooooo..',
    'owwoowwoowo.',
    'oooooooooooo',
    '.owwoowwoowo',
    '.oooooooooo.',
    '.onnnnnnnno.',
    '.onwwwwnnno.',
    '.onnnnnnnno.',
    '.onwwwnnnno.',
    '.onnnnnnnno.',
    '.oooooooooo.',
    '............',
  ],
  spot: [
    '.......y....',
    '......yy..y.',
    'oooo.yy..y..',
    'odddoyyyy...',
    'odmmdoy..yy.',
    'odmmdoyy....',
    'odddo.yy.y..',
    'oooo...y..y.',
    '..oo........',
    '..oo........',
    '.oooo.......',
    'oooooo......',
  ],
  camera: [
    '.ooo..ooo...',
    'odddoodddo..',
    'odmdoodmdo..',
    'odddoodddo..',
    '.ooooooooo..',
    'onnnnnnnnoo.',
    'onnmmnnnnodo',
    'onnnnnnnnoddo',
    'onnnnnnnnodo',
    'oooooooooo..',
    '..o....o....',
    '.oo....oo...',
  ],
  reel: [
    '...oooooo...',
    '..oddddddo..',
    '.oddmddmddo.',
    'oddmmddmmddo',
    'oddddoodddddo',
    'odmddoodddmo',
    'oddddoodddmo',
    'oddmmddmmddo',
    '.oddmddmddo.',
    '..oddddddo..',
    '...oooooo...',
    '............',
  ],
  popcorn: [
    '..w.ww.w....',
    '.wwwwwwww...',
    'wwwwswwwww..',
    'owwwwwwwwo..',
    'orwrwrwrwo..',
    'orwrwrwrwo..',
    '.orwrwrwo...',
    '.orwrwrwo...',
    '.orwrwrwo...',
    '..oooooo....',
    '............',
    '............',
  ],
};

const SYM_MAP: Record<string, string> = {
  o: PAL.ink,
  y: PAL.yellow,
  w: PAL.white,
  m: PAL.mist,
  n: PAL.night,
  a: PAL.amber,
  d: PAL.steel,
  r: PAL.red,
  s: PAL.sand,
};

export const SYM_W = 12;

/** Лента символов в порядке SLOT_SYMBOLS, по 12×12. */
export function makeSlotSymbols(): HTMLCanvasElement {
  const { c, g } = canvas(SYM_W * SLOT_SYMBOLS.length, SYM_W);
  SLOT_SYMBOLS.forEach((s, i) => grid(g, i * SYM_W, 0, SYM[s].map((r) => r.slice(0, SYM_W)), SYM_MAP));
  return c;
}

/** Ячейки звёзд в полосе мест: 0 пустая, 1 половинка, 2 полная — по 7×7. */
export function makeSlotStars(): HTMLCanvasElement {
  const { c, g } = canvas(21, 7);
  const star = ['...o...', '..oyo..', 'ooyyyoo', '.oyyyo.', '.oyoyo.', 'oo...oo', '.......'];
  for (let f = 0; f < 3; f++) {
    const rows = star.map((r) => [...r].map((ch, x) => (ch === 'y' && (f === 0 || (f === 1 && x > 3)) ? 'n' : ch)).join(''));
    grid(g, f * 7, 0, rows, { o: PAL.ink, y: PAL.yellow, n: PAL.dusk });
  }
  return c;
}

/**
 * Автомат на поле 12×20, 2 кадра (лампочки мигают). Ставится низом над местом: человечек стоит
 * перед ним спиной к нам. Экран светится, сверху — лампа.
 */
export function makeFieldMachine(): HTMLCanvasElement {
  const { c, g } = canvas(24, 20);
  for (let f = 0; f < 2; f++) {
    const ox = f * 12;
    px(g, ox + 1, 2, PAL.ink, 10, 18);
    px(g, ox + 2, 3, PAL.wine, 8, 16);
    px(g, ox + 2, 3, PAL.red, 8, 1);
    px(g, ox + 9, 3, PAL.plum, 1, 16);
    // экран с тремя окошками
    px(g, ox + 2, 6, PAL.ink, 8, 6);
    px(g, ox + 3, 7, PAL.white, 6, 4);
    const sy = [PAL.yellow, PAL.red, PAL.cyan];
    for (let k = 0; k < 3; k++) px(g, ox + 3 + k * 2, 8, sy[(k + f) % 3], 1, 2);
    // золотая полка и низ
    px(g, ox + 1, 12, PAL.amber, 10, 1);
    px(g, ox + 2, 13, PAL.plum, 8, 5);
    px(g, ox + 4, 14, PAL.amber, 4, 1);
    // лампа наверху и рычаг справа
    px(g, ox + 4, 0, PAL.ink, 4, 3);
    px(g, ox + 5, 1, f ? PAL.yellow : PAL.orange, 2, 1);
    px(g, ox + 11, 6, PAL.ink, 1, 6);
    px(g, ox + 11, 5, PAL.red, 1, 1);
  }
  return c;
}

/** Фон экрана автомата 180×260: бархат с золотым узором. */
export function makeSlotBackdrop(): HTMLCanvasElement {
  const { c, g } = canvas(180, 260);
  px(g, 0, 0, PAL.plum, 180, 260);
  dither(g, 0, 0, 180, 260, PAL.ink, 0);
  for (let y = 0; y < 260; y += 2) for (let x = 0; x < 180; x += 2) {
    const u = (x + y) % 24;
    const v = (x - y + 2400) % 24;
    if (u === 0 || v === 0) px(g, x, y, PAL.umber);
  }
  return c;
}

/** Размеры корпуса большого автомата и окна барабанов (в его координатах). */
export const BODY_W = 162;
export const BODY_H = 254;
/** Высота светового короба сверху. */
export const TOP_H = 44;
export const REEL_W = 46;
export const REEL_GAP = 3;
export const REELS_X = (BODY_W - (REEL_W * 3 + REEL_GAP * 2)) / 2;
export const REELS_Y = 58;
export const REELS_H = 64;
/** Масштаб символа на барабане. */
export const SYM_K = 3;
/** Табло: верх и высота (в координатах корпуса). */
export const PANEL_TOP = 132;
export const PANEL_H = 74;
/** окошко счёта под табло */
export const SCORE_X = 46;
export const SCORE_W = 78;
export const SCORE_Y = PANEL_TOP + PANEL_H + 2;

/** Хромовая рамка: свет сверху-слева, тень снизу-справа (толщина t). */
function chrome(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t = 3): void {
  px(g, x, y, PAL.ink, w, h);
  const bands = [PAL.white, PAL.mist, PAL.slate, PAL.steel];
  for (let k = 0; k < t; k++) {
    const lo = bands[Math.min(bands.length - 1, k + 1)];
    const hi = bands[Math.min(bands.length - 1, k)];
    px(g, x + 1 + k, y + 1 + k, hi, w - 2 - k * 2, 1); // верх
    px(g, x + 1 + k, y + 1 + k, hi, 1, h - 2 - k * 2); // лево
    px(g, x + 1 + k, y + h - 2 - k, PAL.steel, w - 2 - k * 2, 1); // низ
    px(g, x + w - 2 - k, y + 1 + k, k ? lo : PAL.dusk, 1, h - 2 - k * 2); // право
  }
}

/** Круглая подсвеченная кнопка 7×7 с бликом. */
function knob(g: CanvasRenderingContext2D, x: number, y: number, c: string, dark: string): void {
  grid(g, x, y, ['.ooooo.', 'occccco', 'ocwcccd', 'occccdo', 'occcddo', 'odddddo', '.ooooo.'], { o: PAL.ink, c, d: dark, w: PAL.white });
}

/**
 * Корпус большого автомата во весь экран (162×254), как настоящий: световой короб сверху с лучами и
 * звездой, хромовые рамки, красный корпус с объёмом, окно барабанов, табло, кнопки, щель, лоток, дверца.
 */
export function makeSlotBody(): HTMLCanvasElement {
  const { c, g } = canvas(BODY_W, BODY_H);
  const W = BODY_W;
  // световой короб: хромовая рамка, внутри — лучи от звезды
  chrome(g, 6, 0, W - 12, TOP_H, 2);
  const cx = W / 2;
  const cy = TOP_H / 2;
  for (let y = 3; y < TOP_H - 3; y++) for (let x = 9; x < W - 9; x++) {
    const a = Math.atan2(y - cy, (x - cx) / 1.6);
    const ray = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 24) % 2;
    const d = Math.hypot((x - cx) / 1.6, y - cy);
    px(g, x, y, d < 11 ? PAL.yellow : ray ? (d < 28 ? PAL.amber : PAL.orange) : d < 28 ? PAL.yellow : PAL.amber);
  }
  // звезда в центре короба, вдвое крупнее
  const star = [
    '.......oo.......',
    '......oyyo......',
    '......oyyo......',
    '.....oywyyo.....',
    'oooooowyyyoooooo',
    'oyyyyywyyyyyyyyo',
    '.oyyyyyyyyyyyyo.',
    '..ooyyyyyyyyoo..',
    '...oyyyyyyyyo...',
    '...oyyyooyyyo...',
    '..oyyoo..ooyyo..',
    '..ooo......ooo..',
  ];
  star.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    px(g, cx - 16 + x * 2, cy - 12 + y * 2, ch === 'o' ? PAL.ink : ch === 'w' ? PAL.white : PAL.yellow, 2, 2);
  }));
  // корпус: объём — свет слева, тень справа
  px(g, 0, TOP_H, PAL.ink, W, BODY_H - TOP_H);
  for (let x = 1; x < W - 1; x++) {
    const col = x < 3 ? PAL.coral : x < 6 ? PAL.red : x > W - 4 ? PAL.plum : x > W - 9 ? PAL.wine : PAL.red;
    px(g, x, TOP_H + 1, col, 1, BODY_H - TOP_H - 2);
  }
  px(g, 1, TOP_H, PAL.mist, W - 2, 1);
  px(g, 1, TOP_H + 1, PAL.slate, W - 2, 1);
  // окно барабанов в хромовой рамке
  const rw = REEL_W * 3 + REEL_GAP * 2;
  chrome(g, REELS_X - 5, REELS_Y - 5, rw + 10, REELS_H + 10, 3);
  px(g, REELS_X - 2, REELS_Y - 2, PAL.ink, rw + 4, REELS_H + 4);
  // линия выигрыша: красные метки на рамке слева и справа
  grid(g, REELS_X - 5, REELS_Y + REELS_H / 2 - 3, ['oo..', 'oro.', 'orro', 'orrr', 'orro', 'oro.', 'oo..'], { o: PAL.ink, r: PAL.red });
  grid(g, REELS_X + rw + 1, REELS_Y + REELS_H / 2 - 3, ['..oo', '.oro', 'orro', 'rrro', 'orro', '.oro', '..oo'], { o: PAL.ink, r: PAL.red });
  // хромовая полка под окном
  const shelf = REELS_Y + REELS_H + 6;
  px(g, 4, shelf, PAL.ink, W - 8, 3);
  px(g, 5, shelf, PAL.white, W - 10, 1);
  px(g, 5, shelf + 1, PAL.slate, W - 10, 1);
  // табло: тёмное стекло со строками
  chrome(g, 4, PANEL_TOP, W - 8, PANEL_H, 2);
  px(g, 7, PANEL_TOP + 3, PAL.ink, W - 14, PANEL_H - 6);
  for (let y = PANEL_TOP + 4; y < PANEL_TOP + PANEL_H - 4; y += 2) px(g, 7, y, PAL.night, W - 14, 1);
  // кнопки и щель для монет
  const ky = PANEL_TOP + PANEL_H + 5;
  knob(g, 12, ky, PAL.red, PAL.wine);
  knob(g, 22, ky, PAL.amber, PAL.orange);
  knob(g, 32, ky, PAL.green, PAL.forest);
  px(g, W - 30, ky, PAL.ink, 18, 7);
  px(g, W - 29, ky + 1, PAL.slate, 16, 5);
  px(g, W - 29, ky + 1, PAL.mist, 16, 1);
  px(g, W - 22, ky + 2, PAL.ink, 2, 3);
  px(g, W - 21, ky + 2, PAL.amber, 1, 3);
  // окошко счёта между кнопками и щелью: очки матча
  px(g, SCORE_X - 1, ky - 3, PAL.ink, SCORE_W + 2, 13);
  px(g, SCORE_X, ky - 2, PAL.night, SCORE_W, 11);
  px(g, SCORE_X, ky - 2, PAL.dusk, SCORE_W, 1);
  // лоток для монет: хромовая чаша
  const ty = ky + 10;
  px(g, 14, ty, PAL.ink, W - 28, 10);
  px(g, 15, ty + 1, PAL.white, W - 30, 1);
  px(g, 15, ty + 2, PAL.mist, W - 30, 1);
  px(g, 16, ty + 3, PAL.steel, W - 32, 5);
  px(g, 16, ty + 8, PAL.dusk, W - 32, 1);
  for (const x of [30, 34, 41, 100, 107, 120]) {
    px(g, x, ty + 6, PAL.amber, 3, 1);
    px(g, x, ty + 7, PAL.orange, 3, 1);
  }
  // нижняя дверца с хромовой каймой и ромбом
  const dy = ty + 14;
  chrome(g, 10, dy, W - 20, BODY_H - dy - 3, 1);
  px(g, 12, dy + 2, PAL.wine, W - 24, BODY_H - dy - 7);
  const mx = W / 2;
  const my = dy + Math.floor((BODY_H - dy - 3) / 2);
  for (let k = 0; k < 5; k++) {
    px(g, mx - k, my - 4 + k, PAL.amber, 1, 1);
    px(g, mx + k, my - 4 + k, PAL.amber, 1, 1);
    px(g, mx - k, my + 4 - k, PAL.amber, 1, 1);
    px(g, mx + k, my + 4 - k, PAL.amber, 1, 1);
  }
  return c;
}
