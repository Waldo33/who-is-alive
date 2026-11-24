import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import { face } from './people';
import type { CharStyle, PropSet, ThemePack, View } from './types';
import { centerDist, critterSheet, hash, line, tile } from './util';

/**
 * «Купальская ночь»: грибники в дождевиках с капюшонами бродят по ночному болоту вокруг купальского
 * костра. Вместо звёзд — цветы (три — венок), у живых тает рассудок (game-core › sanity.ts), а сумерки
 * плавно уходят в ночь — это рисует сцена вуалью поверх поля (`night`), без резкой изнанки.
 */

// ───────────── толпа ─────────────

/** Капюшон дождевика вокруг лица (как шлем космонавта, но мягче) и корзинка в руке. */
function hood(m: string[][], view: View): void {
  const set = (y: number, x: number, ch: string) => {
    m[y][x] = ch;
  };
  // острый верх капюшона
  set(0, 3, 'o'); set(0, 8, 'o');
  for (let x = 4; x <= 7; x++) set(0, x, 'o');
  for (let y = 1; y <= 3; y++) for (let x = 2; x <= 9; x++) if (m[y][x] !== 'o') set(y, x, y === 1 ? 'k' : 'h');
  if (view !== 'U') {
    // капюшон обнимает лицо: кайма по бокам
    for (let y = 2; y <= 7; y++) {
      set(y, 0, 'o'); set(y, 1, 'H'); set(y, 10, 'H'); set(y, 11, 'o');
    }
    set(8, 1, 'o'); set(8, 10, 'o');
  } else {
    for (let y = 1; y <= 8; y++) for (let x = 1; x <= 10; x++) if (m[y][x] !== 'o' && m[y][x] !== '.') set(y, x, y < 4 ? 'h' : 'H');
  }
  // корзинка в правой руке
  if (view === 'D') {
    set(11, 10, 'U'); set(11, 11, 'U');
    set(12, 10, 'u'); set(12, 11, 'u');
    set(13, 10, 'o'); set(13, 11, 'o');
  } else if (view === 'S') {
    set(11, 7, 'U'); set(11, 8, 'U');
    set(12, 7, 'u'); set(12, 8, 'u');
  }
}

/**
 * Цвета дождевиков: не похожи на кожу (иначе капюшон читается как лысина) и видны на тёмном болоте;
 * жёлтый, зелёный, красный и голубой — обводка игроков, их не берём.
 */
const COATS: [string, string][] = [
  [PAL.mist, PAL.slate],
  [PAL.orchid, PAL.grape],
  [PAL.clay, PAL.rust],
  [PAL.slate, PAL.steel],
  [PAL.wine, PAL.plum],
];

function coat(i: number): CharStyle {
  const [b, B] = COATS[i];
  const f = face(i);
  return {
    map: {
      ...BASE_MAP,
      s: f.s, S: f.S, m: f.m, c: f.c,
      h: b, H: B, k: b, r: b, R: B,
      a: b, b, B, v: B,
      l: PAL.dusk, L: PAL.ink,
      u: PAL.umber, U: PAL.tan,
    },
    patch: hood,
  };
}

// ───────────── болото ─────────────

function ground(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // мох: тёмная зелень с проплешинами, кочки
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = hash((x + (y >> 3) * 3) >> 3, y >> 3);
      let col: string = PAL.pine;
      if (v < 0.22 && (x + y) % 2 === 0) col = PAL.deep;
      else if (hash(x * 3, y * 7) > 0.985) col = PAL.forest;
      px(g, x, y, col);
    }
  }
  // топкие лужи: тёмная вода с рябью (по ним можно ходить — мелко)
  const pools: [number, number, number, number][] = [
    [28, 60, 14, 6], [150, 78, 12, 5], [40, 214, 16, 6], [140, 226, 13, 5], [96, 40, 9, 3], [20, 150, 7, 9], [162, 160, 7, 10],
  ];
  for (const [px0, py0, rx, ry] of pools) {
    ellipse(g, px0, py0, rx + 1, ry + 1, PAL.deep);
    ellipse(g, px0, py0, rx, ry, PAL.night);
    for (let k = 0; k < rx; k++) {
      const x = px0 - rx + 2 + Math.floor(hash(k, px0) * (rx * 2 - 4));
      const y = py0 - ry + 1 + Math.floor(hash(px0, k) * (ry * 2 - 1));
      if (Math.hypot((x - px0) / rx, (y - py0) / ry) < 0.8) px(g, x, y, PAL.navy, 2, 1);
    }
  }
  // кочки с осокой
  for (let k = 0; k < 34; k++) {
    const x = 8 + Math.floor(hash(k, 11) * (w - 16));
    const y = 16 + Math.floor(hash(k, 12) * (h - 24));
    if (centerDist(w, x, y) < 44) continue;
    ellipse(g, x, y, 3, 1, PAL.forest);
    px(g, x - 2, y - 1, PAL.green);
    px(g, x, y - 2, PAL.green);
    px(g, x + 2, y - 1, PAL.green);
    if (hash(k, 13) < 0.3) px(g, x + 1, y - 1, PAL.white); // белый цветок пушицы
  }
  // вытоптанная поляна вокруг костра: земля, пепел, круг из камней
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d <= 37) {
        const v = hash(x >> 1, y >> 1);
        px(g, x, y, v < 0.15 ? PAL.plum : v > 0.9 ? PAL.brick : PAL.umber);
        if (d < 16 && hash(x, y) < 0.25) px(g, x, y, PAL.steel); // пепел
      } else if (d < 40) px(g, x, y, (Math.floor(Math.atan2(y - 132, x - w / 2) * 9) % 2 === 0) ? PAL.slate : PAL.steel);
    }
  }
  // лес сверху: чёрные ели и белые стволы берёз
  px(g, 0, 0, PAL.ink, w, 12);
  for (let x = 0; x < w; x += 6) {
    const th = 4 + Math.floor(hash(x, 1) * 7);
    for (let y = 0; y < th; y++) px(g, x + 3 - Math.floor((y * 3) / th), 11 - y, PAL.deep, 1 + Math.floor((y * 6) / th), 1);
  }
  for (let x = 9; x < w - 4; x += 23) {
    px(g, x, 1, PAL.mist, 2, 11);
    px(g, x, 3 + (x % 4), PAL.ink, 2, 1);
    px(g, x + 1, 7, PAL.ink, 1, 1);
  }
  px(g, 0, 12, PAL.deep, w, 1);
  // бока и низ — топь
  px(g, 0, 12, PAL.ink, 4, h - 12);
  px(g, w - 4, 12, PAL.ink, 4, h - 12);
  px(g, 3, 12, PAL.deep, 1, h - 15);
  px(g, w - 4, 12, PAL.deep, 1, h - 15);
  px(g, 0, h - 3, PAL.ink, w, 3);
  return c;
}

const BOG: PropSet = {
  // купальский костёр: перекрещённые поленья, пламя кадрами, искры вверх
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      // камни вокруг
      for (const [x, y] of [[4, 29], [9, 31], [15, 32], [21, 32], [27, 30], [30, 27], [3, 26]]) {
        ellipse(g, ox + x, y, 2, 1, PAL.ink);
        px(g, ox + x - 1, y - 1, PAL.slate, 2, 1);
      }
      // поленья крест-накрест
      line(g, ox + 7, 30, ox + 26, 22, PAL.ink);
      line(g, ox + 7, 29, ox + 26, 21, PAL.umber);
      line(g, ox + 27, 30, ox + 8, 22, PAL.ink);
      line(g, ox + 27, 29, ox + 8, 21, PAL.brick);
      // угли
      for (let x = 11; x < 24; x++) if (hash(x, f) < 0.6) px(g, ox + x, 26 + Math.floor(hash(f, x) * 2), hash(x * 3, f) < 0.5 ? PAL.orange : PAL.wine);
      // пламя: три языка, качаются по кадрам
      const tongues: [number, number, number][] = [[12, 9, 4], [17, 14, 5], [22, 10, 4]];
      tongues.forEach(([cx, ht, wd], i) => {
        const sway = [0, 1, 0, -1][(f + i) % 4];
        const hh = ht + [0, 2, 1, -1][(f + i * 2) % 4];
        for (let y = 0; y < hh; y++) {
          const k = y / hh;
          const half = Math.max(0, Math.round(wd * (1 - k) * (k < 0.25 ? k * 4 : 1)));
          const x = cx + Math.round(sway * k * 2);
          const yy = 25 - y;
          px(g, ox + x - half - 1, yy, PAL.wine, half * 2 + 3, 1);
          px(g, ox + x - half, yy, PAL.orange, half * 2 + 1, 1);
          if (half >= 2) px(g, ox + x - half + 1, yy, PAL.amber, half * 2 - 1, 1);
          if (half >= 3 && k < 0.5) px(g, ox + x - 1, yy, PAL.yellow, 3, 1);
        }
      });
      // искры
      for (let k = 0; k < 5; k++) {
        const t = ((k * 7 + f * 3) % 12) / 12;
        const x = ox + 10 + Math.floor(hash(k, 9) * 14) + Math.round(Math.sin(t * 6 + k) * 2);
        const y = Math.round(14 - t * 13);
        px(g, x, y, t < 0.5 ? PAL.yellow : PAL.orange);
      }
    }
    return [c, fw, fh, 4];
  },
  // кривая берёза
  tree: () => {
    const { c, g } = canvas(22, 30);
    // ствол с изгибом
    const trunk = [11, 11, 12, 12, 12, 11, 11, 10, 10, 10, 11, 11, 12, 12, 12, 12];
    for (let i = 0; i < trunk.length; i++) {
      const y = 29 - i;
      px(g, trunk[i] - 2, y, PAL.ink, 4, 1);
      px(g, trunk[i] - 1, y, PAL.white, 2, 1);
      if (i % 3 === 1) px(g, trunk[i] - 1, y, PAL.ink, 1, 1);
      if (i % 5 === 3) px(g, trunk[i], y, PAL.ink, 1, 1);
    }
    line(g, 11, 17, 5, 11, PAL.ink);
    line(g, 12, 15, 18, 9, PAL.ink);
    // редкая крона
    for (const [x, y, r] of [[6, 9, 5], [16, 8, 5], [11, 5, 6]]) {
      ellipse(g, x, y, r, r - 2, PAL.deep);
      ellipse(g, x, y - 1, r - 1, r - 3, PAL.pine);
    }
    for (let k = 0; k < 14; k++) px(g, 2 + Math.floor(hash(k, 5) * 18), 2 + Math.floor(hash(k, 6) * 11), PAL.forest);
    return [c, 22, 30, 1];
  },
  // рогоз и светлячок над ним (два кадра — светлячок мигает)
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      for (const [x, top] of [[2, 6], [4, 3], [6, 8]]) {
        px(g, ox + x, top + 6, PAL.forest, 1, 26 - top - 6);
        px(g, ox + x - 1, top, PAL.ink, 3, 7);
        px(g, ox + x, top + 1, PAL.umber, 1, 5);
        px(g, ox + x, top - 2, PAL.forest, 1, 2);
      }
      line(g, ox + 1, 25, ox + 0, 16, PAL.green);
      line(g, ox + 7, 25, ox + 8, 15, PAL.green);
      px(g, ox + (f ? 7 : 1), f ? 1 : 0, f ? PAL.yellow : PAL.green, 1, 1);
      if (f) px(g, ox + 7, 2, PAL.amber, 1, 1);
    }
    return [c, 9, 26, 2];
  },
  // мшистое бревно
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 2, PAL.ink, 22, 7);
    px(g, 1, 3, PAL.umber, 20, 5);
    px(g, 1, 3, PAL.brick, 20, 1);
    for (let x = 3; x < 20; x += 5) px(g, x, 5, PAL.plum, 3, 1);
    ellipse(g, 1, 5, 1, 2, PAL.tan);
    px(g, 4, 2, PAL.forest, 6, 1);
    px(g, 13, 2, PAL.green, 4, 1);
    px(g, 15, 1, PAL.forest, 2, 1);
    grid(g, 9, 0, ['.o.', 'oro', '.w.'], { o: PAL.ink, r: PAL.red, w: PAL.white }); // мухомор
    return [c, 22, 10, 1];
  },
  // мостки через топь
  benchV: () => {
    const { c, g } = canvas(9, 24);
    for (let y = 0; y < 24; y += 3) {
      px(g, 0, y, PAL.ink, 9, 3);
      px(g, 1, y, hash(y, 3) < 0.5 ? PAL.brick : PAL.umber, 7, 2);
      px(g, 1, y, PAL.tan, 3, 1);
    }
    px(g, 2, 0, PAL.plum, 1, 24);
    px(g, 6, 0, PAL.plum, 1, 24);
    return [c, 9, 24, 1];
  },
  // шалаш из жердей
  stall: () => {
    const { c, g } = canvas(34, 30);
    for (let y = 4; y < 30; y++) {
      const half = Math.floor(((y - 4) / 26) * 15) + 1;
      px(g, 17 - half - 1, y, PAL.ink, half * 2 + 2, 1);
      px(g, 17 - half, y, PAL.umber, half * 2, 1);
      for (let x = 17 - half; x < 17 + half; x++) if ((x * 3 + y) % 7 === 0) px(g, x, y, PAL.brick);
    }
    // лаз — тёмный
    for (let y = 16; y < 30; y++) {
      const half = Math.floor(((y - 16) / 14) * 5) + 1;
      px(g, 17 - half, y, PAL.ink, half * 2, 1);
    }
    // торчащие жерди и пучки травы на крыше
    line(g, 15, 4, 12, 0, PAL.umber);
    line(g, 18, 4, 22, 0, PAL.brick);
    line(g, 17, 4, 17, 1, PAL.tan);
    for (let k = 0; k < 6; k++) px(g, 9 + k * 3, 10 + (k % 3) * 5, PAL.forest, 2, 1);
    return [c, 34, 30, 1];
  },
  // заводь с кувшинками
  planter: () => {
    const { c, g } = canvas(32, 13);
    ellipse(g, 16, 7, 15, 5, PAL.deep);
    ellipse(g, 16, 7, 14, 4, PAL.night);
    for (const [x, y] of [[7, 6], [15, 8], [24, 6], [19, 4]]) {
      ellipse(g, x, y, 2, 1, PAL.forest);
      px(g, x, y - 1, PAL.green);
    }
    grid(g, 14, 4, ['.w.', 'wyw'], { w: PAL.white, y: PAL.yellow });
    px(g, 10, 9, PAL.navy, 3, 1);
    px(g, 21, 9, PAL.navy, 2, 1);
    return [c, 32, 13, 1];
  },
};

/** Цветок вместо звезды: белые лепестки, жёлтая серединка, светится (4 кадра 10×10, как звезда). */
function flower(): HTMLCanvasElement {
  const { c, g } = canvas(40, 10);
  const shape = [
    '...oooo...',
    '..owwwwo..',
    '.owwyywwo.',
    '.owyyyywo.',
    '.owwyywwo.',
    '..owwwwo..',
    '...oogo...',
    '..ogogo...',
    '..oogo....',
    '....oo....',
  ];
  for (let f = 0; f < 4; f++) {
    grid(g, f * 10, 0, shape, { o: PAL.ink, w: f % 2 ? PAL.mist : PAL.white, y: f % 2 ? PAL.amber : PAL.yellow, g: PAL.green });
    const sp = [[1, 1], [8, 2], [8, 6], [1, 5]][f];
    px(g, f * 10 + sp[0], sp[1], PAL.cyan);
  }
  return c;
}

/** Значок цветка в шапке (8×8 в ячейке 10×10): собранный и пустая ячейка. */
function hudFlower(): HTMLCanvasElement {
  const { c, g } = canvas(20, 10);
  const rows = ['..oooo..', '.owwwwo.', 'owwyywwo', 'owyyyywo', 'owwyywwo', '.owwwwo.', '..oogo..', '...oo...'];
  grid(g, 1, 1, rows, { o: PAL.ink, w: PAL.white, y: PAL.yellow, g: PAL.green });
  grid(g, 11, 1, rows.map((r) => r.replace(/[^.o]/g, 'n')), { o: PAL.ink, n: PAL.dusk });
  return c;
}

// ───────────── музыка ─────────────

/**
 * Колыбельная на болоте: ре минор, медленно, гусли (щипковое арпеджио) над бурдоном и жалейка-мелодия.
 * К концу дубля вступает сердце — глухие удары «тук-тук», мелодия уходит выше и тревожнее.
 */
const ROOTS = [38, 33, 34, 36]; // Dm — Am — B♭ — C
const TRIADS = [[0, 3, 7], [0, 3, 7], [0, 4, 7], [0, 4, 7]];
const MEL_AT = [0, 4, 6, 8, 12];
const MEL = [
  [74, 72, 70, 69, 67],
  [69, 67, 65, 64, 65],
  [70, 69, 67, 65, 62],
  [64, 65, 67, 69, 72],
];

const song: Song = {
  step(a: SongApi, st: SongStep) {
    const { s16: s, bar, t, dt, intensity: I } = st;
    const ch = bar % 4;
    const root = ROOTS[ch];
    // бурдон: низкий ре всё время, раз в полтакта
    if (s === 0 || s === 8) a.voice('triangle', 38, t, dt * 8, 0.13);
    if (s === 0) a.voice('triangle', root + 12, t, dt * 14, 0.08);
    // гусли: арпеджио вверх-вниз восьмыми
    if (s % 2 === 0) {
      const tri = TRIADS[ch];
      const n = [0, 1, 2, 1, 0, 2, 1, 2][(s / 2) % 8];
      a.voice('pulse', root + 24 + tri[n], t, dt * 1.8, 0.045);
    }
    // жалейка — со второй четвёрки тактов; в напряжении — октавой выше
    if (bar % 8 >= 4 || I >= 1) {
      const k = MEL_AT.indexOf(s);
      if (k >= 0) {
        const len = (MEL_AT[k + 1] ?? 16) - s;
        const note = MEL[ch][k] + (I >= 2 ? 12 : 0);
        a.voice('square', note, t, dt * len * 0.85, 0.05);
        a.voice('sine', note, t, dt * len * 0.9, 0.05);
      }
    }
    // шорохи: редкий «шелест» камыша
    if (s === 6 && hash(bar, 3) < 0.4) a.hit(0.5, 0.025, 3200, t);
    // сердце: к концу дубля глухие «тук-тук»
    if (I >= 1 && (s === 0 || s === 3)) a.kick(t, s === 0 ? 0.26 : 0.18, 120);
    if (I >= 2 && (s === 8 || s === 11)) a.kick(t, s === 8 ? 0.24 : 0.16, 120);
  },
};

const ICONS = {
  // «Через костёр!» — язык пламени
  jump: ['...o....', '..oyo...', '..ofyo..', '.ofyfo..', '.offyfo.', 'offaffo.', 'ofaaafo.', '.oooooo.'],
};

const pack: ThemePack = {
  looks: [
    {
      chars: coat(0),
      variants: [1, 2, 3, 4].map(coat),
      ground,
      prop: (k) => BOG[k]?.() ?? null,
      wall: () => tile(['oUoUoUoU', 'uUuUuUuU', 'uUuUuUuU', 'oooooooo', 'UoUoUoUo', 'UuUuUuUu', 'UuUuUuUu', 'oooooooo'], { o: PAL.ink, u: PAL.umber, U: PAL.brick }),
      critter: () => {
        // лягушка
        const a = ['......', '......', '.e..e.', 'oggggo', 'gGggGg', 'g.oo.g'];
        const b = ['......', '......', '.e..e.', 'oggggo', 'gGggGg', '.g..g.'];
        const r1 = ['......', '.e..e.', 'oggggo', 'gGggGg', 'g....g', '......'];
        const r2 = ['.e..e.', 'oggggo', 'gGggGg', '.g..g.', '......', '......'];
        return critterSheet([a, b, r1, r2, r1, b], { o: PAL.ink, g: PAL.green, G: PAL.forest, e: PAL.yellow });
      },
      icons: ICONS,
    },
  ],
  music: { flavor: { transpose: 2, bpm: 84, swing: 0.1, lead: 'triangle', bass: 'sine', arp: false, echo: true }, song },
  star: flower,
  hudStar: hudFlower,
  night: true,
};

export default pack;
