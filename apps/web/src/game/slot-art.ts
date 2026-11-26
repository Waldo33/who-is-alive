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
  const { c, g } = canvas(180, 296);
  px(g, 0, 0, PAL.plum, 180, 296);
  dither(g, 0, 0, 180, 296, PAL.ink, 0);
  for (let y = 0; y < 296; y += 2) for (let x = 0; x < 180; x += 2) {
    const u = (x + y) % 24;
    const v = (x - y + 2400) % 24;
    if (u === 0 || v === 0) px(g, x, y, PAL.umber);
  }
  return c;
}

/** Размеры корпуса большого автомата и окна барабанов (в его координатах). */
export const BODY_W = 162;
/** До самого низа экрана: кнопки «Крутить» и «Пас» — на корпусе, отдельной панели нет. */
export const BODY_H = 290;
/** Фонарь-«свеча» на макушке: центр по x, низ по y. */
export const CANDLE_Y = 12;
/** Световой короб сверху: верх и высота. */
export const TOP_Y = 12;
export const TOP_H = 38;
export const REEL_W = 46;
export const REEL_GAP = 3;
export const REELS_X = (BODY_W - (REEL_W * 3 + REEL_GAP * 2)) / 2;
export const REELS_Y = 64;
export const REELS_H = 64;
/** Масштаб символа на барабане. */
export const SYM_K = 3;
/** Табло: верх и высота (в координатах корпуса). */
export const PANEL_TOP = 142;
export const PANEL_H = 68;
/** Наклонная панель с кнопками: верх и высота. */
export const DECK_Y = 213;
export const DECK_H = 30;
/** Кнопки на панели: x, ширина (y и высота — общие, крышка без боковины). */
export const BTN_PULL = { x: 12, w: 96 };
export const BTN_PASS = { x: 114, w: 36 };
export const BTN_Y = DECK_Y + 6;
export const BTN_H = 14;
/** Нижнее расписное стекло. */
export const BELLY_Y = 259;

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

/** Хромовая отливка: w — белый блик, m — светлый хром, s — средний, t — тень, o — контур. */
const CAST = { o: PAL.ink, w: PAL.white, m: PAL.mist, s: PAL.slate, t: PAL.steel, r: PAL.red, k: PAL.wine };
/** Завиток литья в углу (левый верхний; остальные — зеркалом). */
const SCROLL = [
  'oooooooo..',
  'owwmmmsso.',
  'owmoooosto',
  'omo.ooo.so',
  'omo.omso.o',
  'oso.osto..',
  'oso..oo...',
  'osto......',
  '.oto......',
  '..o.......',
];
const mirrorX = (rows: string[]) => rows.map((r) => [...r].reverse().join(''));
/** Медальон над окном барабанов: хромовый овал с рубином. */
const CREST = [
  '....oooooooo....',
  '..oowwmmmmssoo..',
  '.owmmoookkoosto.',
  'owmmorrrrrrkosto',
  'osmmorwrrrrkosto',
  '.ossookkkkoosto.',
  '..oossssttttoo..',
  '....oooooooo....',
];

/**
 * Корпус большого автомата во весь экран (162×290), по мотивам настоящих: фонарь-свеча на макушке
 * (рисует slot-ui — он мигает), световой короб с лучами и звездой, красный корпус с объёмом и хромовым
 * литьём по краям, окно барабанов с медальоном, табло, наклонная панель с кнопками (крышки кнопок рисует
 * slot-ui — они горят и нажимаются), лоток с монетами и расписное нижнее стекло: хлопушка в лучах прожекторов.
 */
export function makeSlotBody(): HTMLCanvasElement {
  const { c, g } = canvas(BODY_W, BODY_H);
  const W = BODY_W;
  // подставка фонаря
  px(g, W / 2 - 7, CANDLE_Y - 3, PAL.ink, 14, 4);
  px(g, W / 2 - 6, CANDLE_Y - 2, PAL.mist, 12, 1);
  px(g, W / 2 - 6, CANDLE_Y - 1, PAL.steel, 12, 1);
  // световой короб: хромовая рамка, внутри — лучи от звезды
  chrome(g, 6, TOP_Y, W - 12, TOP_H, 2);
  const cx = W / 2;
  const cy = TOP_Y + TOP_H / 2;
  for (let y = TOP_Y + 3; y < TOP_Y + TOP_H - 3; y++) for (let x = 9; x < W - 9; x++) {
    const a = Math.atan2(y - cy, (x - cx) / 1.6);
    const ray = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 24) % 2;
    const d = Math.hypot((x - cx) / 1.6, y - cy);
    px(g, x, y, d < 11 ? PAL.yellow : ray ? (d < 26 ? PAL.amber : PAL.orange) : d < 26 ? PAL.yellow : PAL.amber);
  }
  // короб — выпуклое стекло: к краям темнее
  for (let y = TOP_Y + 3; y < TOP_Y + TOP_H - 3; y++) {
    dither(g, 9, y, 3, 1, PAL.rust, y % 2);
    dither(g, W - 12, y, 3, 1, PAL.rust, y % 2);
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

  // корпус: объём — свет слева, тень справа; сверху — тень от короба, снизу корпус уходит в тень
  const C0 = TOP_Y + TOP_H;
  px(g, 0, C0, PAL.ink, W, BODY_H - C0);
  for (let x = 1; x < W - 1; x++) {
    const col = x < 6 ? PAL.coral : x < 10 ? PAL.red : x > W - 5 ? PAL.plum : x > W - 11 ? PAL.wine : PAL.red;
    px(g, x, C0 + 1, col, 1, BODY_H - C0 - 2);
  }
  // мягкий переход света: точки на границах полос
  for (let y = C0 + 1; y < BODY_H - 1; y++) {
    dither(g, 6, y, 2, 1, PAL.coral, y % 2);
    dither(g, W - 13, y, 2, 1, PAL.wine, y % 2);
  }
  // тень под коробом
  px(g, 1, C0 + 1, PAL.wine, W - 2, 2);
  dither(g, 1, C0 + 3, W - 2, 1, PAL.wine, 0);
  // хромовые боковые планки во всю высоту корпуса
  for (const sx of [0, W - 4]) {
    px(g, sx, C0, PAL.ink, 4, BODY_H - C0);
    px(g, sx + 1, C0 + 1, PAL.white, 1, BODY_H - C0 - 2);
    px(g, sx + 2, C0 + 1, PAL.slate, 1, BODY_H - C0 - 2);
    // блики-заклёпки
    for (let y = C0 + 14; y < BODY_H - 8; y += 22) {
      px(g, sx + 1, y, PAL.ink, 2, 3);
      px(g, sx + 1, y, PAL.mist, 1, 1);
    }
  }
  // литьё: завитки по углам корпуса
  grid(g, 1, C0 + 1, SCROLL, CAST);
  grid(g, W - 11, C0 + 1, mirrorX(SCROLL), CAST);

  // окно барабанов: утоплено — внутренняя тень сверху, хромовая рамка, медальон над ним
  const rw = REEL_W * 3 + REEL_GAP * 2;
  chrome(g, REELS_X - 5, REELS_Y - 5, rw + 10, REELS_H + 10, 3);
  px(g, REELS_X - 2, REELS_Y - 2, PAL.ink, rw + 4, REELS_H + 4);
  grid(g, Math.floor(W / 2 - 8), REELS_Y - 10, CREST, CAST);
  // линия выигрыша: красные метки на рамке слева и справа
  grid(g, REELS_X - 5, REELS_Y + REELS_H / 2 - 3, ['oo..', 'oro.', 'orro', 'orrr', 'orro', 'oro.', 'oo..'], { o: PAL.ink, r: PAL.red });
  grid(g, REELS_X + rw + 1, REELS_Y + REELS_H / 2 - 3, ['..oo', '.oro', 'orro', 'rrro', 'orro', '.oro', '..oo'], { o: PAL.ink, r: PAL.red });
  // хромовая полка под окном
  const shelf = REELS_Y + REELS_H + 8;
  px(g, 4, shelf, PAL.ink, W - 8, 4);
  px(g, 5, shelf, PAL.white, W - 10, 1);
  px(g, 5, shelf + 1, PAL.mist, W - 10, 1);
  px(g, 5, shelf + 2, PAL.steel, W - 10, 1);
  px(g, 5, shelf + 4, PAL.wine, W - 10, 1);
  // табло: тёмное стекло со строками
  chrome(g, 4, PANEL_TOP, W - 8, PANEL_H, 2);
  px(g, 7, PANEL_TOP + 3, PAL.ink, W - 14, PANEL_H - 6);
  for (let y = PANEL_TOP + 4; y < PANEL_TOP + PANEL_H - 4; y += 2) px(g, 7, y, PAL.night, W - 14, 1);

  // наклонная панель: выступает к игроку — задний край уже, передний шире, сверху свет, спереди хромовая кромка
  for (let y = 0; y < DECK_H; y++) {
    const inset = Math.max(0, 6 - Math.floor(y / 4));
    const col = y < 2 ? PAL.ink : y === 2 ? PAL.coral : y < DECK_H - 6 ? PAL.red : y < DECK_H - 5 ? PAL.ink : y < DECK_H - 4 ? PAL.white : y < DECK_H - 3 ? PAL.mist : y < DECK_H - 1 ? PAL.steel : PAL.ink;
    px(g, inset, DECK_Y + y, PAL.ink, W - inset * 2, 1);
    px(g, inset + 1, DECK_Y + y, col, W - inset * 2 - 2, 1);
  }
  // глубокие лунки под кнопками
  for (const b of [BTN_PULL, BTN_PASS]) {
    px(g, b.x - 2, BTN_Y - 2, PAL.ink, b.w + 4, BTN_H + 7);
    px(g, b.x - 1, BTN_Y - 1, PAL.plum, b.w + 2, BTN_H + 5);
  }
  // под панелью — тень на корпусе
  px(g, 4, DECK_Y + DECK_H, PAL.wine, W - 8, 2);

  // лоток для монет: хромовая чаша, в ней монеты
  const ty = DECK_Y + DECK_H + 3;
  px(g, 14, ty, PAL.ink, W - 28, 11);
  px(g, 15, ty + 1, PAL.white, W - 30, 1);
  px(g, 15, ty + 2, PAL.mist, W - 30, 1);
  px(g, 16, ty + 3, PAL.steel, W - 32, 6);
  px(g, 16, ty + 9, PAL.dusk, W - 32, 1);
  for (const [x, dy] of [[28, 0], [33, 1], [38, 0], [44, 1], [52, 0], [96, 1], [103, 0], [109, 1], [116, 0], [124, 1], [130, 0]] as const) {
    px(g, x, ty + 6 + dy, PAL.ink, 5, 3);
    px(g, x + 1, ty + 6 + dy, PAL.yellow, 3, 1);
    px(g, x + 1, ty + 7 + dy, PAL.amber, 3, 1);
  }

  // нижнее расписное стекло: хлопушка в лучах двух прожекторов
  const bh = BODY_H - BELLY_Y - 2;
  chrome(g, 8, BELLY_Y, W - 16, bh, 2);
  const ix = 11;
  const iy = BELLY_Y + 3;
  const iw = W - 22;
  const ih = bh - 6;
  // ночное небо площадки: сверху темнее
  px(g, ix, iy, PAL.night, iw, ih);
  dither(g, ix, iy, iw, Math.floor(ih / 2), PAL.ink, 0);
  const hx = Math.floor(W / 2);
  const hy = iy + ih - 3;
  for (const sx of [ix + 3, ix + iw - 4]) {
    // луч: конус от прожектора в углу к хлопушке, расширяется книзу; в середине ярче
    const tx = sx < hx ? hx - 10 : hx + 10;
    const n = Math.abs(tx - sx);
    for (let i = 0; i <= n; i++) {
      const x = sx + Math.sign(tx - sx) * i;
      const k = i / n;
      const yc = iy + 2 + (hy - 7 - iy - 2) * k;
      const half = 1 + k * 7;
      for (let y = Math.round(yc - half); y <= Math.round(yc + half); y++) {
        if (y <= iy || y >= hy) continue;
        const core = Math.abs(y - yc) <= half / 2;
        if (core ? (x + y) % 2 === 0 : (x + y) % 4 === 0) px(g, x, y, core ? PAL.yellow : PAL.amber);
      }
    }
    // прожектор на штативе
    const left = sx < hx;
    grid(g, sx - 3, iy, left
      ? ['ooooo..', 'osssyo.', 'osssyyo', 'osssyo.', 'ooooo..']
      : ['..ooooo', '.oyssso', 'oyyssso', '.oyssso', '..ooooo'], { o: PAL.ink, s: PAL.steel, y: PAL.yellow });
  }
  // пол сцены с бликом от лучей
  px(g, ix, hy, PAL.umber, iw, 3);
  px(g, ix, hy, PAL.brick, iw, 1);
  dither(g, hx - 14, hy, 28, 1, PAL.amber, 0);
  // хлопушка: корпус с «надписями» и поднятая полосатая планка (шарнир справа)
  const kx = hx - 11;
  const ky = hy - 10;
  px(g, kx, ky, PAL.ink, 22, 10);
  px(g, kx + 1, ky + 1, PAL.dusk, 20, 8);
  for (const [dy, len] of [[2, 8], [4, 12], [6, 6]] as const) px(g, kx + 2, ky + dy, PAL.white, len, 1);
  for (let x = 0; x < 22; x++) {
    const lift = Math.floor((21 - x) / 6);
    const y0 = ky - 5 - lift;
    px(g, kx + x, y0, PAL.ink, 1, 5);
    if (x > 0 && x < 21) for (let r = 1; r < 4; r++) if ((x - r + 12) % 6 < 3) px(g, kx + x, y0 + r, PAL.white);
  }
  // искры вокруг
  for (const [x, y] of [[hx - 26, iy + 9], [hx + 25, iy + 7], [hx - 17, iy + 3], [hx + 17, iy + 12], [hx + 1, iy + 3]] as const) {
    px(g, x, y - 1, PAL.white, 1, 3);
    px(g, x - 1, y, PAL.white, 3, 1);
    px(g, x, y, PAL.yellow, 1, 1);
  }
  return c;
}
