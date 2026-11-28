import { PAL } from '@kto/assets';
import { BASE_MAP } from '../themes/base';
import type { Arms, CharStyle, Face, Legs, View } from '../themes/types';
import { CH_H, CH_W, frameSpec, makeCharacterSheets } from '../sprites';
import type { CharSheets } from '../sprites';
import { canvas, outlineOf } from '../pixels';
import type { Ctx } from '../pixels';

/**
 * Набор «Кот-банан» (гардероб, за флагом shop): серый кот — обычный человечек 12×16 в своём окрасе,
 * поверх — отдельный слой банана, который выходит за рамки (решение владельца 27.11: человечки и
 * площадки прежние, скин — слой поверх; образец — shop/kot-banan-malenkiy-seryy-v8.png).
 * Позы берутся у человечка, банан следует за головой. Без DOM: холсты — из pixels.ts.
 */

/** Кадр: 16×28 + контур 1 пикс. = 18×30. Кот в нём стоит с отступом (OX, OY). */
export const KB_W = 18;
export const KB_H = 30;
const W = 16;
const H = 28;
const OX = 2;
const OY = 11;

const CAT: CharStyle = {
  map: {
    ...BASE_MAP,
    h: PAL.slate, k: PAL.mist, H: PAL.slate, s: PAL.mist, S: PAL.slate, r: PAL.slate, R: PAL.steel,
    b: PAL.yellow, B: PAL.amber, v: PAL.yellow, a: PAL.steel, m: PAL.steel, l: PAL.slate, L: PAL.steel,
  },
  patch(m: string[][], view: View) {
    // слёзы под глазами, розовый нос, белые щёчки
    if (view === 'D') {
      m[7][3] = 'd'; m[7][8] = 'd'; m[6][5] = 'c'; m[6][6] = 'c'; m[7][4] = 'w'; m[7][7] = 'w';
    }
    if (view === 'S') {
      m[7][8] = 'd'; m[6][9] = 'c';
    }
  },
};

/**
 * Лапки: серые, со светлыми подушечками, торчат из боков банана. Шаблон — левая (для смотрящего) лапка
 * спереди или спиной: столбцы от «край банана − 2» (край — крайний пиксель кожуры), строки от `y`;
 * правая — зеркально. a — шёрстка, d — тень у кожуры, p — подушечки.
 */
const PAW: Record<string, { y: number; rows: string[] }> = {
  down: { y: 18, rows: ['..a.', '.aa.', '.ad.', '.ad.', '.pp.'] },
  // при шаге лапка уходит вперёд — видна короче
  fwd: { y: 18, rows: ['..a.', '.aa.', '.ad.', '.pp.'] },
  // вверх — снаружи от края кожуры, чтобы лапка не слилась с ушами
  up: { y: 9, rows: ['pp..', 'aa..', 'ad..', 'ad..', 'ad..', 'ad..', '.ad.', '..d.'] },
  // машет: лапка в сторону и вверх
  out: { y: 12, rows: ['pp..', 'aa..', '.aa.', '.ad.', '..d.'] },
  // испуг: лапки врозь
  spread: { y: 14, rows: ['p...', 'pa..', '.aa.', '..d.'] },
};

/** Лапка сбоку (вид S, нос в +x): точки [dx от середины банана, y, цвет]. */
const SIDE_PAW: Record<'down' | 'guard' | 'jab', [number, number, string][]> = {
  // висит под мордочкой, на кожуре
  down: [[0, 21, 'a'], [1, 21, 'a'], [0, 22, 'a'], [1, 22, 'd'], [0, 23, 'a'], [1, 23, 'd'], [0, 24, 'p'], [1, 24, 'p']],
  // кулак у подбородка
  guard: [[-3, 19, 'a'], [-3, 20, 'a'], [-2, 21, 'a'], [-1, 22, 'a'], [0, 22, 'a'], [1, 22, 'a'], [2, 21, 'a'], [3, 21, 'a'], [4, 19, 'p'], [5, 19, 'p'], [4, 20, 'p'], [5, 20, 'p']],
  // удар: лапка вперёд до упора
  jab: [[-3, 19, 'a'], [-3, 20, 'a'], [-2, 21, 'a'], [-1, 21, 'a'], [0, 21, 'a'], [1, 21, 'a'], [2, 21, 'a'], [3, 21, 'a'], [4, 21, 'a'], [5, 21, 'a'], [6, 20, 'p'], [7, 20, 'p'], [6, 21, 'p'], [7, 21, 'p']],
};
const PAW_COL: Record<string, string> = { a: PAL.slate, d: PAL.steel, p: PAL.mist };

/** Какие лапки у кадра: [левая, правая] спереди или спиной; у вида сбоку — одна ближняя. */
function pawsOf(view: View, arms: Arms, legs: Legs, face: Face): [string, string] | { side: keyof typeof SIDE_PAW; dx: number } {
  if (view === 'S') {
    if (arms === 'guard' || arms === 'jab') return { side: arms, dx: 0 };
    // на ходу лапка качается вперёд-назад
    return { side: 'down', dx: legs === 'liftL' ? 1 : legs === 'liftR' ? -1 : 0 };
  }
  if (arms === 'up') return ['up', 'up'];
  if (arms === 'leftUp') return ['up', 'down'];
  if (arms === 'rightUp') return ['down', 'up'];
  if (arms === 'waveA') return ['down', 'out'];
  if (arms === 'waveB') return ['down', 'up'];
  if (face === 'wide') return ['spread', 'spread'];
  if (legs === 'liftL') return ['down', 'fwd'];
  if (legs === 'liftR') return ['fwd', 'down'];
  return ['down', 'down'];
}

let sheets: CharSheets | null = null;
const cat = () => (sheets ??= makeCharacterSheets(CAT));

const hex = (d: Uint8ClampedArray, i: number) => '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Кадр Кот-банана: кадр человечка `frame` (F.*), вид `view`; `shift` — сдвиг по x (танец), `outline` —
 * цвет контура (чёрный; цвет игрока — вторым кольцом снаружи, как у людей).
 */
export function kotBananFrame(frame: number, view: View, shift = 0, headDy = 0, outline: string = PAL.ink): HTMLCanvasElement {
  const { c, g } = canvas(W, H);
  const P = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };
  const cx = 8 + shift;
  const hy = headDy;
  const flip = view === 'S' ? -1 : 1;
  // банан: прямые бока, острые концы, лёгкий изгиб на концах
  const TOP = 2 + hy;
  const BOT = 25;
  const shape = (x: number, y: number): number | null => {
    if (y < TOP || y > BOT) return null;
    const t = (y + 0.5 - TOP) / (BOT + 1 - TOP);
    const hw = 5.5 * Math.min(1, t / 0.32) ** 0.6 * Math.min(1, (1 - t) / 0.16) ** 0.6;
    const bend = t < 0.25 ? ((0.25 - t) / 0.25) ** 1.5 * 1.3 : t > 0.82 ? ((t - 0.82) / 0.18) ** 1.5 * 0.8 : 0;
    const rel = (x + 0.5 - (cx - flip * bend)) / Math.max(hw, 0.5);
    return Math.abs(rel) <= 1 ? rel : null;
  };
  const peelAt = (x: number, y: number, rel: number) =>
    y >= BOT - 1 && Math.abs(rel) < 0.9
      ? PAL.umber
      : y <= TOP || rel * flip > 0.62
        ? PAL.amber
        : Math.round(x - cx) === (flip > 0 ? 2 : -3) && view !== 'S' && y > TOP + 3 && y < BOT - 3
          ? PAL.amber
          : PAL.yellow;
  // сам кот
  g.drawImage(cat().body, frame * CH_W, 0, CH_W, CH_H, OX, OY, CH_W, CH_H);
  const src = g.getImageData(0, 0, W, H).data;
  const alpha = (x: number, y: number) => src[(y * W + x) * 4 + 3];
  // окошко для мордочки: кошачья голова с треугольными ушами
  const hx = view === 'S' ? cx + 1.5 : cx;
  const hrx = view === 'S' ? 3.9 : 4.7;
  const EARS: [number, number][] = [[3, -1], [3, 0], [4, 0], [3, 1], [4, 1], [5, 1], [3, 2], [4, 2], [5, 2], [6, 2], [3, 3], [3, 4], [4, 3]];
  const ears = new Set<string>();
  const edx = Math.round(hx - 8);
  for (const [ex, ey] of EARS) {
    ears.add(`${ex + edx},${OY + ey + hy}`);
    if (view !== 'S') ears.add(`${15 - ex + edx},${OY + ey + hy}`);
  }
  const inHole = (x: number, y: number) => {
    if (view === 'U') return false;
    if (ears.has(`${x},${y}`)) return true;
    const dx = (x + 0.5 - hx) / hrx;
    const dy = (y + 0.5 - (OY + 6.1 + hy)) / 4.6;
    return y <= OY + 10 + hy && dx * dx + dy * dy <= 1;
  };
  // всё вне банана, кроме ступней, стираем: силуэт — только банан
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rel = shape(x, y);
      if (rel !== null) {
        if (!inHole(x, y)) P(x, y, peelAt(x, y, rel));
      } else if (y < BOT + 1 && y >= TOP) g.clearRect(x, y, 1, 1);
    }
  }
  // верхушка наклонена вперёд и чуть влево: хвостик лежит на лицевой стороне, под ним тень
  const sx = cx - flip * 2;
  if (view !== 'U') {
    P(sx, TOP, PAL.umber); P(sx, TOP + 1, PAL.umber); P(sx + flip, TOP + 1, PAL.plum); P(sx, TOP + 2, PAL.plum); P(sx + flip, TOP + 2, PAL.umber);
    P(sx - flip, TOP + 3, PAL.amber); P(sx, TOP + 3, PAL.amber); P(sx + flip, TOP + 3, PAL.amber); P(sx, TOP + 4, PAL.amber);
  } else {
    P(sx, TOP - 1, PAL.umber); P(sx, TOP, PAL.umber);
  }
  // шёрстка в окошке, светлая челюсть, край окошка
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inHole(x, y) && (!alpha(x, y) || ears.has(`${x},${y}`) || y >= OY + 9 + hy)) P(x, y, y >= OY + 9 + hy ? PAL.mist : PAL.slate);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inHole(x, y) && (!inHole(x, y - 1) || !inHole(x - 1, y) || !inHole(x + 1, y) || !inHole(x, y + 1))) P(x, y, PAL.steel);
    }
  }
  if (view !== 'U') {
    P(4 + edx, OY + 1 + hy, PAL.coral);
    if (view !== 'S') P(11 + edx, OY + 1 + hy, PAL.coral);
    const ey = OY + hy;
    if (view === 'D') {
      // полоски «М» на лбу и усы
      P(cx - 2, ey + 2, PAL.steel); P(cx - 1, ey + 3, PAL.steel); P(cx, ey + 3, PAL.steel); P(cx + 1, ey + 2, PAL.steel);
      for (const [x, y] of [[cx - 6, ey + 6], [cx - 5, ey + 7], [cx - 6, ey + 8], [cx + 5, ey + 6], [cx + 4, ey + 7], [cx + 5, ey + 8]]) P(x, y, PAL.dusk);
    } else {
      P(cx + 5, ey + 6, PAL.dusk); P(cx + 5, ey + 8, PAL.dusk);
    }
  } else {
    // на спине банана — рожица
    const ey = OY + 3 + hy;
    P(cx - 3, ey, PAL.umber); P(cx + 2, ey, PAL.umber);
    P(cx - 4, ey + 3, PAL.clay); P(cx + 3, ey + 3, PAL.clay);
    for (let x = cx - 3; x <= cx + 2; x++) P(x, ey + 4, PAL.clay);
  }
  // пятнышки
  for (const [x, y] of [[6, 6], [9, 9], [5, 22], [10, 21]]) {
    if (view === 'U' && y > 8 && y < 20) continue;
    const r = shape(x + shift, y);
    if (r !== null && !inHole(x + shift, y) && y < BOT - 1) P(x + shift, y, PAL.umber);
  }
  // лапки — поверх кожуры: торчат из боков банана
  const spec = frameSpec(frame);
  const paws = pawsOf(view, spec.arms, spec.legs, spec.face);
  if (Array.isArray(paws)) {
    const L = cx - 8;
    paws.forEach((kind, side) => {
      const { y, rows } = PAW[kind];
      // в танце банан сдвинут к краю кадра — лапку, что вылезла бы за кадр, прижимаем к боку
      const outer = side ? 2 * cx - 1 - L : L;
      const nudge = outer < 0 ? -outer : outer > W - 1 ? W - 1 - outer : 0;
      rows.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          const col = PAW_COL[row[i]];
          if (col) P((side ? 2 * cx - 1 - (L + i) : L + i) + nudge, y + j, col);
        }
      });
    });
  } else {
    for (const [dx, y, k] of SIDE_PAW[paws.side]) P(cx + dx + paws.dx, y, PAW_COL[k]);
  }
  // ступни под бананом — от человечка
  for (let y = BOT + 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!alpha(x, y)) continue;
      const k = hex(src, (y * W + x) * 4);
      if (k === PAL.slate.toLowerCase() || k === PAL.steel.toLowerCase() || k === PAL.ink.toLowerCase()) P(x, y, k);
    }
  }
  const o = canvas(KB_W, KB_H);
  outlineOf(g, W, H, o.g, 0, 0, outline);
  o.g.drawImage(c, 1, 1);
  return o.c;
}

/** Рёв (кадр D): глаза-щёлочки «> <», рот нараспашку. Меняет холст на месте. */
export function wailFace(h: HTMLCanvasElement): HTMLCanvasElement {
  const q = h.getContext('2d') as Ctx;
  const P = (x: number, y: number, c: string) => {
    q.fillStyle = c;
    q.fillRect(x, y, 1, 1);
  };
  for (const [x, y] of [[6, 17], [6, 18], [11, 17], [11, 18], [7, 19], [10, 19], [6, 19], [11, 19]]) P(x, y, PAL.mist);
  for (const [x, y] of [[5, 17], [6, 18], [5, 19], [12, 17], [11, 18], [12, 19]]) P(x, y, PAL.ink);
  for (let x = 7; x <= 10; x++) {
    P(x, 20, PAL.ink);
    P(x, 21, PAL.ink);
  }
  P(8, 21, PAL.red); P(9, 21, PAL.red); P(8, 22, PAL.ink); P(9, 22, PAL.ink);
  return h;
}

// начало — внешний уголок глаза «>» (5, 18): струя бьёт из глаза вверх-вбок, через щёку и кожуру, и падает до пола
const ARC: [number, number][] = [[4, 18], [3, 17], [2, 16], [1, 15], [0, 15], [-1, 15], [-2, 16], [-3, 17], [-3, 18], [-4, 19], [-4, 20], [-4, 21], [-4, 22], [-4, 23], [-4, 24], [-4, 25], [-4, 26], [-4, 27], [-4, 28]];
// рёв: струя выше и шире, без разрывов
const ARC_BIG: [number, number][] = [[4, 18], [3, 17], [3, 16], [2, 15], [1, 14], [0, 13], [-1, 13], [-2, 13], [-3, 13], [-4, 14], [-5, 14], [-6, 15], [-7, 16], [-7, 17], [-8, 18], ...[19, 20, 21, 22, 23, 24, 25, 26, 27, 28].map((y) => [-8, y] as [number, number])];

/**
 * Дуги слёз из глаз в стороны и до пола (как в меме) — рисовать поверх кота, иначе начало струи прячется за ним:
 * кот в (x0, y0) в масштабе k, `t` — номер кадра
 * (блики бегут по дуге), `len` — сколько точек дуги уже вылетело, `big` — дуги шире (рёв).
 */
export function tearArcs(g: Ctx, x0: number, y0: number, k: number, t = 0, len = ARC.length, big = false): void {
  const pts = big ? ARC_BIG : ARC;
  const n = Math.min(len, pts.length);
  const B = (sx: number, sy: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(x0 + sx * k, y0 + sy * k, k, k);
  };
  for (const side of [0, 1]) {
    const X = (x: number) => (side ? KB_W - 1 - x : x);
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[i];
      // тень снизу у летящей части, сбоку — у падающей (точка прямо под прошлой)
      const vert = i > 0 && pts[i - 1][0] === x && i >= 8;
      B(X(vert ? x + 1 : x), vert ? y : y + 1, PAL.blue);
      B(X(x), y, (i + t) % 4 === 0 ? PAL.white : PAL.cyan);
    }
    if (n === pts.length) {
      const [lx] = pts[pts.length - 1];
      for (const [dx, dy] of [[-2, 1], [-1, 0], [-1, 1], [0, 1], [1, 1], [2, 0]]) B(X(lx + dx), 29 + dy, PAL.cyan);
      B(X(lx - 3 - (t % 2)), 27 + (t % 2), PAL.cyan);
    }
  }
}
