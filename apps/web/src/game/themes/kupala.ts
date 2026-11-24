import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import { face } from './people';
import type { CharStyle, Look, Pose, PropSet, ThemePack, View } from './types';
import { centerDist, critterSheet, hash, line, tile } from './util';

/**
 * «Купальская ночь»: грибники в дождевиках с капюшонами бродят по ночному болоту вокруг купальского
 * костра. Вместо звёзд — цветы (три — венок), у живых тает рассудок (game-core › sanity.ts), а сумерки
 * плавно уходят в ночь — это рисует сцена вуалью поверх поля (`night`), без резкой изнанки.
 */

// ───────────── толпа ─────────────

// m[строка][столбец]; голова — строки 0–8, тело 9–12, ноги 13–15; руки — столбцы 2 и 9 в строках 10–11.
const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};
const row = (m: string[][], y: number, s: string) => {
  m[y] = s.split('');
};

/** Буквы поверх шаблона: огонь, лён, вышивка, мех, рога, травы. */
const EXTRA: Record<string, string> = {
  F: PAL.orange, Y: PAL.yellow, W: PAL.white, Q: PAL.red, G: PAL.forest, g: PAL.green,
  T: PAL.tan, N: PAL.fawn, Z: PAL.sand, U: PAL.umber, P: PAL.plum, X: PAL.mist,
};

/** Длинный подол до пят: щель между ногами заполнена, по краю — вышивка `hem`. */
function longSkirt(m: string[][], hem: string): void {
  row(m, 13, '..ollllllo..');
  row(m, 14, '..o' + 'lLlLlL'.split('').map((c, i) => (i % 2 ? hem : c)).join('') + 'o..');
  row(m, 15, '...oo..oo...');
}

/** 0 — девушка в венке: белая рубаха до пят с красной вышивкой, венок из цветов, лента и коса за спиной. */
function maiden(m: string[][], view: View): void {
  if (view !== 'U') {
    const wreath = ['W', 'G', 'Y', 'G', 'Q', 'G', 'W', 'G'];
    for (let x = 2; x <= 9; x++) set(m, x, 1, wreath[x - 2]);
    set(m, 1, 2, 'G'); set(m, 10, 2, 'G');
  } else {
    for (let x = 2; x <= 9; x++) set(m, x, 1, x % 2 ? 'Y' : 'G');
    // коса и ленты по спине
    for (let y = 7; y <= 12; y++) set(m, 5, y, 'h');
    for (let y = 7; y <= 12; y++) set(m, 6, y, y % 2 ? 'H' : 'h');
    set(m, 4, 11, 'Q'); set(m, 7, 12, 'Q');
  }
  if (view === 'D') {
    // вышитый ворот и рукава
    set(m, 4, 9, 'Q'); set(m, 7, 9, 'Q');
    set(m, 1, 11, 'Q'); set(m, 10, 11, 'Q');
  }
  longSkirt(m, 'Q');
}

/** 1 — парень в косоворотке: красная рубаха с вышитым воротом набок, плетёный пояс с кистью, лапти. */
function lad(m: string[][], view: View): void {
  if (view === 'D') {
    set(m, 6, 9, 'Y'); set(m, 7, 9, 'Y'); set(m, 7, 10, 'Y');
  }
  for (let x = 3; x <= 8; x++) set(m, x, 12, x % 2 ? 'Y' : 'Z');
  if (view !== 'U') { set(m, 8, 13, 'Y'); }
  for (const x of [3, 4, 7, 8]) if (m[15][x] === 'o') set(m, x, 15, 'T');
}

/** 2 — ряженый-козёл: шуба мехом наружу, маска с рогами, глаза-бусины, борода. */
function goat(m: string[][], view: View): void {
  row(m, 0, 'Zo..oooo..oZ');
  row(m, 1, 'oZoohTTTooZo');
  row(m, 2, '.oZTTTTTTZo.');
  if (view === 'U') {
    for (let y = 3; y <= 8; y++) for (let x = 2; x <= 9; x++) if (m[y][x] !== 'o' && m[y][x] !== '.') set(m, x, y, (x + y) % 3 ? 'T' : 'N');
    return;
  }
  row(m, 3, '.oTNTTTTNTo.');
  row(m, 4, '.oTTTTTTTTo.');
  row(m, 5, view === 'S' ? '.oTTTToTYTo.' : '.oToYTToYTo.');
  row(m, 6, '..oTTTTTTo..');
  row(m, 7, '..oTNooNTo..');
  row(m, 8, '...oWWWWo...');
  for (let x = 4; x <= 7; x++) set(m, x, 9, 'W');
  set(m, 5, 10, 'W'); set(m, 6, 10, 'W');
  // мех клочьями
  for (let y = 9; y <= 12; y++) for (let x = 2; x <= 9; x++) if ((x * 3 + y) % 5 === 0 && m[y][x] === 'b') set(m, x, y, 'N');
}

/** 3 — знахарка: тёмный платок, завязанный под подбородком, шаль в цветах, пучок трав в руке. */
function herbalist(m: string[][], view: View): void {
  if (view !== 'U') {
    for (let y = 3; y <= 7; y++) { set(m, 0, y, 'o'); set(m, 1, y, 'h'); set(m, 10, y, 'h'); set(m, 11, y, 'o'); }
    set(m, 5, 8, 'h'); set(m, 6, 8, 'h'); set(m, 4, 9, 'h'); set(m, 7, 9, 'h');
  }
  set(m, 3, 2, 'k'); set(m, 7, 1, 'k'); set(m, 5, 2, 'k');
  set(m, 3, 10, 'Y'); set(m, 6, 11, 'Y'); set(m, 8, 10, 'Q');
  if (view === 'D') {
    // травы в правой руке
    set(m, 10, 12, 'g'); set(m, 11, 11, 'g'); set(m, 10, 11, 'G'); set(m, 11, 10, 'W'); set(m, 10, 10, 'Y');
  }
  longSkirt(m, 'P');
}

/** 4 — дед в брыле: соломенная шляпа с широкими полями, белая борода, льняная рубаха, красный пояс. */
function elder(m: string[][], view: View): void {
  row(m, 0, '...oooooo...');
  row(m, 1, '..ohhhhkho..');
  row(m, 2, '.ohhhhhhkho.');
  row(m, 3, 'oHHHHHHHHHHo');
  if (view === 'D') {
    for (let x = 3; x <= 8; x++) set(m, x, 7, 'W');
    for (let x = 3; x <= 8; x++) set(m, x, 8, 'W');
    set(m, 5, 7, 'm'); set(m, 6, 7, 'm');
    for (let x = 4; x <= 7; x++) set(m, x, 9, 'W');
    set(m, 5, 10, 'W'); set(m, 6, 10, 'W');
  }
  for (let x = 3; x <= 8; x++) set(m, x, 12, 'Q');
}

/** Облики толпы по номеру фигуры: у ботов и у живых одинаково (`variantOf`). */
const FOLK: { map: Record<string, string>; patch: (m: string[][], view: View) => void }[] = [
  { map: { h: PAL.tan, H: PAL.fawn, k: PAL.sand, r: PAL.tan, R: PAL.fawn, b: PAL.white, B: PAL.mist, v: PAL.white, a: PAL.white, l: PAL.white, L: PAL.mist }, patch: maiden },
  { map: { h: PAL.umber, H: PAL.plum, k: PAL.brick, r: PAL.umber, R: PAL.plum, b: PAL.red, B: PAL.wine, v: PAL.red, a: PAL.red, l: PAL.dusk, L: PAL.night }, patch: lad },
  { map: { h: PAL.tan, H: PAL.fawn, k: PAL.sand, r: PAL.tan, R: PAL.fawn, b: PAL.tan, B: PAL.fawn, v: PAL.tan, a: PAL.tan, l: PAL.umber, L: PAL.plum }, patch: goat },
  { map: { h: PAL.plum, H: PAL.ink, k: PAL.wine, r: PAL.plum, R: PAL.ink, b: PAL.wine, B: PAL.plum, v: PAL.wine, a: PAL.wine, l: PAL.umber, L: PAL.plum }, patch: herbalist },
  { map: { h: PAL.sand, H: PAL.tan, k: PAL.white, r: PAL.sand, R: PAL.tan, b: PAL.mist, B: PAL.slate, v: PAL.mist, a: PAL.mist, l: PAL.mist, L: PAL.slate }, patch: elder },
];

function folk(i: number): CharStyle {
  const f = face(i);
  const o = FOLK[i];
  return {
    map: { ...BASE_MAP, s: f.s, S: f.S, m: f.m, c: f.c, ...o.map, ...EXTRA, o: PAL.ink, e: PAL.ink },
    patch: o.patch,
  };
}

// ───────────── жесты ─────────────

const downArmR = (m: string[][]) => { set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); };
const downArmL = (m: string[][]) => { set(m, 2, 10, 'b'); set(m, 2, 11, 'B'); };

/** «Факел!» — 0–1 берёзовый факел над головой, пламя мечется; «Тсс!» — 2 присел и зажал уши; «Хоровод!» — 3–4. */
const POSES: Pose[] = [
  ...[0, 1].map((f): Pose => ({
    view: 'D',
    face: 'wide',
    patch: (m) => {
      downArmR(m);
      for (let y = 6; y <= 9; y++) set(m, 10, y, 'a');
      set(m, 10, 5, 's');
      set(m, 10, 4, 'U'); set(m, 10, 3, 'Z');
      if (f === 0) { set(m, 10, 2, 'F'); set(m, 11, 2, 'F'); set(m, 10, 1, 'Y'); set(m, 11, 1, 'F'); set(m, 10, 0, 'F'); set(m, 9, 2, 'F'); }
      else { set(m, 10, 2, 'F'); set(m, 9, 2, 'F'); set(m, 10, 1, 'Y'); set(m, 9, 1, 'F'); set(m, 9, 0, 'F'); set(m, 11, 2, 'F'); }
    },
  })),
  {
    view: 'D',
    face: 'blink',
    patch: (m) => {
      // присел: всё на две строки ниже, колени у груди, ладони на ушах
      const body = m.slice(0, 13).map((r) => [...r]);
      for (let y = 0; y < 2; y++) m[y] = Array(12).fill('.');
      for (let y = 0; y < 13; y++) m[y + 2] = body[y];
      row(m, 15, '..olloollo..');
      set(m, 0, 7, 'o'); set(m, 0, 8, 's'); set(m, 0, 9, 'o');
      set(m, 11, 7, 'o'); set(m, 11, 8, 's'); set(m, 11, 9, 'o');
      set(m, 1, 10, 'a'); set(m, 10, 10, 'a');
    },
  },
  ...(['liftL', 'liftR'] as const).map((legs): Pose => ({
    view: 'D',
    legs,
    face: 'happy',
    patch: (m) => {
      downArmL(m); downArmR(m);
      set(m, 1, 10, 'a'); set(m, 0, 10, 's');
      set(m, 10, 10, 'a'); set(m, 11, 10, 's');
    },
  })),
];

const ACTS: Look['acts'] = {
  jump: { poses: [0, 1], ms: 150 }, // «Факел!»
  freeze: { poses: [2], ms: 1000 }, // «Тсс!»
  dance: { poses: [3, 4], ms: 260, flip: true }, // «Хоровод!»
};

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
 * Колыбельная, которая ломается. Ре минор, медленно. В сумерках — музыкальная шкатулка над бурдоном
 * и жалейка. Чем темнее (`dread`, общая для всех ночь — не свой рассудок), тем сильнее шкатулка
 * расстраивается и запинается, в бурдон вползают малая секунда и тритон, в камыше шепчет. В глухую ночь
 * мелодии почти нет: гул, сбитое сердце, скрип и редкий удар-диссонанс.
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
    const D = st.dread ?? 0;
    // Леший рядом: всё замолкает, только сердце — тишина страшнее музыки
    if (st.hush) {
      if (s === 0 || s === 3) a.kick(t, s === 0 ? 0.3 : 0.2, 120);
      if (s === 8 || s === 11) a.kick(t, s === 8 ? 0.26 : 0.18, 120);
      return;
    }
    const ch = bar % 4;
    const root = ROOTS[ch];
    // расстройка шкатулки: в сумерках чуть-чуть, к ночи — на четверть тона и гуляет
    const off = (n: number) => (hash(bar * 16 + s, n) - 0.5) * D * 0.9;
    // бурдон: низкий ре; к ночи — малая секунда (ми-бемоль), в глухую ночь — тритон (ля-бемоль)
    if (s === 0 || s === 8) a.voice('triangle', 38, t, dt * 8, 0.13);
    if (s === 0 && D < 0.75) a.voice('triangle', root + 12, t, dt * 14, 0.08 * (1 - D));
    if (s === 0 && D >= 0.35) a.voice('sawtooth', 51 + off(1) * 0.3, t, dt * 15, 0.03 + 0.03 * D);
    if (s === 8 && D >= 0.7) a.voice('sawtooth', 44.2, t, dt * 8, 0.05);
    // шкатулка: арпеджио восьмыми; к ночи ноты выпадают, а оставшиеся фальшивят
    if (s % 2 === 0 && D < 0.85) {
      const tri = TRIADS[ch];
      const n = [0, 1, 2, 1, 0, 2, 1, 2][(s / 2) % 8];
      if (hash(bar * 8 + s, 2) >= D * 0.7) a.voice('pulse', root + 24 + tri[n] + off(3), t, dt * 1.4, 0.045);
    }
    // жалейка — со второй четвёрки тактов, пока не совсем темно; к ночи — обрывки фраз
    if ((bar % 8 >= 4 || I >= 1) && D < 0.8) {
      const k = MEL_AT.indexOf(s);
      if (k >= 0 && hash(bar, 4 + k) >= D * 0.6) {
        const len = (MEL_AT[k + 1] ?? 16) - s;
        const note = MEL[ch][k] + (I >= 2 ? 12 : 0) + off(5);
        a.voice('square', note, t, dt * len * 0.85, 0.05);
        a.voice('sine', note, t, dt * len * 0.9, 0.05);
      }
    }
    // глухая ночь: одна нота колыбельной в пустоте, на полтона мимо
    if (D >= 0.8 && s === 4 && hash(bar, 9) < 0.5) a.voice('pulse', MEL[ch][0] + 12.5, t, dt * 6, 0.035);
    // шорохи: в сумерках редкий камыш, к ночи — шёпот (шум на 2–4 кГц короткими клочками)
    if (s === 6 && hash(bar, 3) < 0.4) a.hit(0.5, 0.025, 3200, t);
    if (D >= 0.4 && hash(bar * 16 + s, 6) < 0.05 + 0.1 * D) a.hit(0.18 + 0.3 * hash(bar, s), 0.015 + 0.02 * D, 2200 + 2200 * hash(s, bar), t);
    // скрип: длинная высокая нота, медленно не в ту сторону
    if (D >= 0.6 && s === 12 && hash(bar, 7) < 0.3) a.voice('sawtooth', 88 + hash(bar, 8) * 2, t, dt * 10, 0.018);
    // удар-диссонанс: изредка, в глухую ночь
    if (D >= 0.75 && s === 0 && hash(bar, 10) < 0.2) {
      for (const iv of [0, 1, 6]) a.voice('square', 62 + iv, t, dt * 3, 0.05);
      a.hit(0.25, 0.06, 1400, t);
    }
    // сердце: с середины ночи глухое «тук-тук», к концу дубля — сбивается и чаще
    if ((I >= 1 || D >= 0.5) && (s === 0 || s === 3)) a.kick(t, s === 0 ? 0.26 : 0.18, 120);
    if ((I >= 2 || D >= 0.85) && (s === 8 || s === (hash(bar, 11) < 0.5 ? 10 : 11))) a.kick(t, s === 8 ? 0.24 : 0.16, 120);
  },
};

const ICONS = {
  // «Факел!» — берёзовый факел с пламенем
  jump: ['...oo...', '..ofyo..', '.ofyyfo.', '.ofyyfo.', '..offo..', '..ouuo..', '..ouuo..', '..oooo..'],
};

const pack: ThemePack = {
  looks: [
    {
      chars: folk(0),
      variants: [1, 2, 3, 4].map(folk),
      poses: POSES,
      acts: ACTS,
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
