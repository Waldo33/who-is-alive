import { PAL } from '@kto/assets';
import type { SlotSymbol } from '@kto/game-core';
import { SLOT_SYMBOLS } from '@kto/game-core';
import { canvas, dither, ellipse, grid, px } from './pixels';

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
export const BODY_W = 140;
export const BODY_H = 176;
export const REELS_X = 14;
export const REELS_Y = 40;
export const REEL_W = 36;
export const REEL_GAP = 2;
export const REELS_H = 44;

/** Корпус большого автомата 140×176: вывеска, окно барабанов, панель, щель для монет. */
export function makeSlotBody(): HTMLCanvasElement {
  const { c, g } = canvas(BODY_W, BODY_H);
  const W = BODY_W;
  // корпус
  px(g, 0, 4, PAL.ink, W, BODY_H - 4);
  px(g, 1, 5, PAL.wine, W - 2, BODY_H - 6);
  px(g, 1, 5, PAL.red, W - 2, 1);
  px(g, 1, 5, PAL.red, 2, BODY_H - 6);
  px(g, W - 4, 5, PAL.plum, 3, BODY_H - 6);
  // вывеска (арка) — золото
  ellipse(g, W / 2, 16, 66, 14, PAL.ink);
  ellipse(g, W / 2, 16, 65, 13, PAL.amber);
  ellipse(g, W / 2, 17, 60, 10, PAL.night);
  px(g, 4, 16, PAL.ink, W - 8, 16);
  px(g, 5, 17, PAL.amber, W - 10, 14);
  px(g, 8, 19, PAL.night, W - 16, 10);
  // окно барабанов
  const rw = REEL_W * 3 + REEL_GAP * 2;
  px(g, REELS_X - 4, REELS_Y - 4, PAL.ink, rw + 8, REELS_H + 8);
  px(g, REELS_X - 3, REELS_Y - 3, PAL.amber, rw + 6, REELS_H + 6);
  px(g, REELS_X - 3, REELS_Y - 3, PAL.yellow, rw + 6, 1);
  px(g, REELS_X - 1, REELS_Y - 1, PAL.ink, rw + 2, REELS_H + 2);
  // линия выигрыша: стрелки слева и справа
  grid(g, REELS_X - 9, REELS_Y + REELS_H / 2 - 3, ['o...', 'oo..', 'oyo.', 'oyyo', 'oyo.', 'oo..', 'o...'], { o: PAL.ink, y: PAL.yellow });
  grid(g, REELS_X + rw + 5, REELS_Y + REELS_H / 2 - 3, ['...o', '..oo', '.oyo', 'oyyo', '.oyo', '..oo', '...o'], { o: PAL.ink, y: PAL.yellow });
  // панель с надписями
  px(g, 8, 92, PAL.ink, W - 16, 62);
  px(g, 9, 93, PAL.night, W - 18, 60);
  px(g, 9, 93, PAL.dusk, W - 18, 1);
  // щель для монет и лоток
  px(g, W / 2 - 10, 158, PAL.ink, 20, 3);
  px(g, W / 2 - 9, 159, PAL.amber, 18, 1);
  px(g, 20, 164, PAL.ink, W - 40, 9);
  px(g, 21, 165, PAL.plum, W - 42, 7);
  px(g, 21, 165, PAL.amber, W - 42, 1);
  return c;
}
