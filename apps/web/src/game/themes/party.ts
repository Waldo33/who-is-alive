import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import type { CharStyle, Look, Pose, PropArt, PropSet, ThemePack, View } from './types';
import { centerDist, critterSheet, hash, tile } from './util';
import { face } from './people';
import { NY_ROOTS, NY_TRIADS, nyMelodyAt } from '../newyear';

/**
 * Новогодний корпоратив в опенспейсе: ёлка с огнями посреди переговорки, фикусы в мишуре,
 * гирлянда по стене, караоке, мандарины и шампанское, конфетти на ковролине. Толпа — те же
 * клерки в нарядах: колпак, Дед Мороз, Снегурочка, свитер с оленем, мишура.
 * Изнанка — «свет погас»: всё темнеет, горят только ёлка и гирлянды, поле мерцает в такт,
 * у всех в руках бенгальские огни. Музыка — праздничный свинг с бубенцами, в темноте —
 * танцевальный бит «на четыре» (мелодия своя).
 */

// ═════════════ цвета: «свет погас» ═════════════

/** Тот же цвет в темноте: на ступень темнее по палитре. */
const DIM: Record<string, string> = {
  [PAL.white]: PAL.mist, [PAL.mist]: PAL.slate, [PAL.slate]: PAL.steel, [PAL.steel]: PAL.dusk, [PAL.dusk]: PAL.night,
  [PAL.night]: PAL.ink, [PAL.peach]: PAL.fawn, [PAL.tan]: PAL.fawn, [PAL.fawn]: PAL.brick, [PAL.brick]: PAL.umber,
  [PAL.umber]: PAL.plum, [PAL.plum]: PAL.ink, [PAL.coral]: PAL.wine, [PAL.forest]: PAL.pine,
  [PAL.pine]: PAL.deep, [PAL.navy]: PAL.night, [PAL.grape]: PAL.plum, [PAL.orchid]: PAL.grape, [PAL.amber]: PAL.clay,
  [PAL.yellow]: PAL.amber, [PAL.sand]: PAL.tan, [PAL.clay]: PAL.rust, [PAL.rust]: PAL.umber, [PAL.orange]: PAL.rust,
  [PAL.cyan]: PAL.blue, [PAL.blue]: PAL.navy, [PAL.green]: PAL.forest, [PAL.red]: PAL.wine, [PAL.deep]: PAL.ink,
};
/** Бордовое сукно (колпаки, шуба) в темноте не темнеет: иначе сливается с волосами и полом. */
const dim = (c: string) => DIM[c] ?? c;

/** Бенгальский огонь — светится и в темноте: стержень, искры, белое ядро. */
const SPARK = { K: PAL.slate, Z: PAL.yellow, z: PAL.amber, W: PAL.white };
/** Предметы поз при свете: бокал, шампанское, подарок, лента, телефон, экран. */
const ITEMS = { G: PAL.white, J: PAL.amber, X: PAL.orchid, Y: PAL.white, P: PAL.night, Q: PAL.cyan };

// ═════════════ костюмы ═════════════

const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};

/** Колпак Деда Мороза: красное сукно, белая опушка, помпон. */
function santaHat(m: string[][], view: View): void {
  m[1] = m[1].map((ch) => (ch === 'h' || ch === 'k' ? 'q' : ch));
  m[2] = m[2].map((ch) => (ch === 'h' || ch === 'k' ? 'q' : ch));
  m[3] = m[3].map((ch) => (ch === 'H' ? 'p' : ch));
  set(m, view === 'S' ? 2 : 9, 1, 'p');
  set(m, view === 'S' ? 1 : 10, 1, 'p');
}

/** Кто есть кто: i — человек (лицо и волосы из people.ts), одинаковый при свете и в темноте. */
const OUTFITS: { map: Record<string, string>; patch: (m: string[][], view: View) => void }[] = [
  // 0 клерк в колпаке: белая рубашка, галстук
  {
    map: { ...face(0), q: PAL.wine, p: PAL.white, a: PAL.mist, b: PAL.white, B: PAL.mist, v: PAL.white, l: PAL.steel, L: PAL.ink, t: PAL.wine },
    patch: (m, view) => {
      santaHat(m, view);
      if (view === 'D') { set(m, 5, 9, 't'); set(m, 6, 9, 't'); set(m, 5, 10, 't'); set(m, 6, 10, 't'); set(m, 5, 11, 't'); }
    },
  },
  // 1 Дед Мороз: шуба с белой опушкой, борода
  {
    map: { ...face(1), q: PAL.wine, p: PAL.white, y: PAL.white, a: PAL.wine, b: PAL.wine, B: PAL.plum, v: PAL.white, l: PAL.wine, L: PAL.ink },
    patch: (m, view) => {
      santaHat(m, view);
      if (view === 'D') {
        for (let x = 2; x <= 9; x++) if (m[7][x] !== 'o') m[7][x] = 'y';
        for (let x = 3; x <= 8; x++) m[8][x] = 'y';
        set(m, 5, 9, 'y'); set(m, 6, 9, 'y');
      } else if (view === 'S') {
        for (let x = 5; x <= 9; x++) if (m[7][x] !== 'o') m[7][x] = 'y';
        for (let x = 5; x <= 8; x++) if (m[8][x] !== 'o') m[8][x] = 'y';
      }
    },
  },
  // 2 Снегурочка: кокошник, светлая шубка, сапожки
  {
    map: { ...face(2), h: PAL.navy, H: PAL.white, k: PAL.cyan, a: PAL.mist, b: PAL.mist, B: PAL.slate, v: PAL.white, l: PAL.mist, L: PAL.white },
    patch: (m, view) => {
      // кокошник выше головы: зубцы по верху
      if (view !== 'U') { set(m, 4, 0, 'h'); set(m, 7, 0, 'h'); set(m, 5, 0, 'k'); set(m, 6, 0, 'h'); }
      // коса за спиной
      if (view === 'U') for (let y = 9; y <= 12; y++) set(m, 5, y, 'r');
    },
  },
  // 3 свитер с оленем и рожки на ободке
  {
    map: { ...face(3), u: PAL.tan, a: PAL.forest, b: PAL.forest, B: PAL.pine, v: PAL.white, l: PAL.navy, L: PAL.ink, p: PAL.white },
    patch: (m, view) => {
      set(m, 2, 0, 'u'); set(m, 1, 0, 'u'); set(m, 9, 0, 'u'); set(m, 10, 0, 'u');
      if (view !== 'S') { set(m, 3, 9, 'p'); set(m, 8, 9, 'p'); set(m, 3, 12, 'p'); set(m, 8, 12, 'p'); }
    },
  },
  // 4 мишура на шее, бордовая рубашка
  {
    map: { ...face(4), A: PAL.amber, M: PAL.yellow, a: PAL.grape, b: PAL.grape, B: PAL.plum, v: PAL.orchid, l: PAL.night, L: PAL.ink },
    patch: (m) => {
      for (let x = 2; x <= 9; x++) if (m[9][x] !== 'o') m[9][x] = x % 2 ? 'A' : 'M';
    },
  },
];

function outfit(i: number, dark: boolean): CharStyle {
  const o = OUTFITS[i];
  const own = Object.fromEntries(Object.entries(o.map).map(([k, c]) => [k, dark ? dim(c) : c]));
  const items = dark ? {} : ITEMS;
  return { map: { ...BASE_MAP, ...own, ...items, ...SPARK, o: PAL.ink, e: PAL.ink }, patch: o.patch };
}

const LIGHT = OUTFITS.map((_, i) => outfit(i, false));
const DARK = OUTFITS.map((_, i) => outfit(i, true));

// ═════════════ действия ═════════════
// m[строка][столбец]; голова — строки 0–8, тело 9–12, ноги 13–15; руки — столбцы 2 и 9 в строках 10–11.

const downArmR = (m: string[][]) => { set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); };
const downArmL = (m: string[][]) => { set(m, 2, 10, 'b'); set(m, 2, 11, 'B'); };

/** При свете: тост, подарок, хоровод, селфи. */
const PARTY_POSES: Pose[] = [
  // 0 тост: бокал шампанского над головой
  {
    view: 'D',
    face: 'happy',
    patch: (m) => {
      downArmR(m);
      for (let y = 6; y <= 9; y++) set(m, 10, y, 'a');
      set(m, 10, 5, 's');
      set(m, 10, 4, 'G');
      set(m, 10, 3, 'J'); set(m, 11, 3, 'J');
      set(m, 10, 2, 'G'); set(m, 11, 2, 'G');
    },
  },
  // 1 подарок над головой
  {
    view: 'D',
    face: 'wide',
    patch: (m) => {
      downArmL(m); downArmR(m);
      for (let y = 1; y <= 9; y++) { set(m, 0, y, 'a'); set(m, 11, y, 'a'); }
      for (let y = 0; y <= 2; y++) for (let x = 1; x <= 10; x++) set(m, x, y, 'X');
      for (let y = 0; y <= 2; y++) { set(m, 5, y, 'Y'); set(m, 6, y, 'Y'); }
      for (let x = 1; x <= 10; x++) set(m, x, 1, x === 5 || x === 6 ? 'Y' : 'X');
      set(m, 0, 1, 's'); set(m, 11, 1, 's');
    },
  },
  // 2 подарок у груди
  {
    view: 'D',
    patch: (m) => {
      for (let y = 9; y <= 12; y++) for (let x = 3; x <= 8; x++) set(m, x, y, 'X');
      for (let y = 9; y <= 12; y++) { set(m, 5, y, 'Y'); set(m, 6, y, 'Y'); }
      for (let x = 3; x <= 8; x++) set(m, x, 10, 'Y');
      set(m, 2, 10, 's'); set(m, 9, 10, 's');
    },
  },
  // 3–4 хоровод: руки в стороны, шаг
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
  // 5–6 селфи: телефон в вытянутой руке, во втором кадре — вспышка и улыбка
  ...[false, true].map((flash): Pose => ({
    view: 'D',
    face: flash ? 'happy' : 'normal',
    patch: (m) => {
      downArmR(m);
      set(m, 10, 9, 'a'); set(m, 10, 8, 'a'); set(m, 11, 7, 's');
      for (let y = 4; y <= 6; y++) { set(m, 10, y, 'P'); set(m, 11, y, 'P'); }
      set(m, 10, 5, 'Q');
      if (flash) { set(m, 11, 3, 'W'); set(m, 10, 2, 'Z'); }
    },
  })),
];

const PARTY_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 }, // «Тост!»
  jump: { poses: [2, 1], ms: 240, yoff: [0, -2] }, // «Подарок!»
  dance: { poses: [3, 4], ms: 240, flip: true }, // «Хоровод!»
  wave: { poses: [5, 5, 6], ms: 260 }, // селфи
};

/** В темноте: желание, салют, огоньки — у всех бенгальские огни. */
const DARK_POSES: Pose[] = [
  // 0 загадай желание: глаза закрыты, огонёк у груди
  {
    view: 'D',
    face: 'blink',
    patch: (m) => {
      downArmR(m);
      set(m, 8, 11, 's'); set(m, 9, 11, 'a');
      set(m, 9, 10, 'K'); set(m, 10, 9, 'K');
      set(m, 11, 8, 'W'); set(m, 10, 7, 'Z'); set(m, 11, 7, 'z'); set(m, 11, 9, 'z');
    },
  },
  // 1–2 салют: огонь над головой, искры разлетаются по-разному
  ...[0, 1].map((f): Pose => ({
    view: 'D',
    face: 'wide',
    patch: (m) => {
      downArmR(m);
      for (let y = 6; y <= 9; y++) set(m, 10, y, 'a');
      set(m, 10, 5, 's'); set(m, 10, 4, 'K'); set(m, 10, 3, 'K');
      set(m, 10, 1, 'W');
      if (f === 0) { set(m, 9, 0, 'Z'); set(m, 11, 0, 'Z'); set(m, 11, 2, 'z'); set(m, 9, 2, 'z'); }
      else { set(m, 10, 0, 'Z'); set(m, 11, 1, 'Z'); set(m, 9, 1, 'z'); set(m, 11, 3, 'z'); }
    },
  })),
  // 3–4 огоньки: машут огнём то вправо, то влево
  ...[false, true].map((left): Pose => ({
    view: 'D',
    face: 'happy',
    patch: (m) => {
      const x0 = left ? 0 : 11;
      const x1 = left ? 1 : 10;
      if (left) downArmL(m);
      else downArmR(m);
      set(m, x1, 10, 'a'); set(m, x0, 10, 's');
      set(m, x0, 9, 'K'); set(m, x0, 8, 'K');
      set(m, x0, 7, 'W'); set(m, x1, 6, 'Z'); set(m, x0, 5, 'z'); set(m, x1, 7, 'z');
    },
  })),
];

const DARK_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 }, // «Загадай желание!»
  jump: { poses: [1, 2], ms: 140, yoff: [0, -2] }, // «Салют!»
  dance: { poses: [3, 4], ms: 220 }, // «Огоньки!»
  wave: { poses: [1, 2], ms: 200 }, // рисуют огнём
};

const PARTY_ICONS = {
  freeze: ['.owwwwo.', '.oaaaao.', '.oaawao.', '..oaao..', '...oo...', '...oo...', '..oooo..', '........'],
  jump: ['.y....y.', '..y..y..', 'oooyyooo', 'orryyrro', 'oooyyooo', '.oryyro.', '.oryyro.', '.oooooo.'],
  // хоровод — вокруг ёлки
  dance: ['...yy...', '...gg...', '..gggg..', '.gggggg.', '..gggg..', '.gggggg.', 'gggggggg', '...uu...'],
};

const DARK_ICONS = {
  freeze: ['...y....', '...y....', 'yyyyyyy.', '.yywyy..', '..yyy...', '.yy.yy..', '.y...y..', '........'],
  jump: ['y..y..y.', '.y.y.y..', '..www...', 'yyw.wyy.', '..www...', '.y.y.y..', 'y..y..y.', '........'],
  dance: ['.y.w..y.', '..yay...', '.wa.ay..', '..yay...', '...d....', '..d.....', '.d......', 'd.......'],
};

// ═════════════ земля ═════════════

const BULBS = [PAL.amber, PAL.cyan, PAL.orchid, PAL.green, PAL.coral];

function partyGround(arena: ArenaDef, dark: boolean): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  const C = (col: string) => (dark ? dim(col) : col);
  // ковролин плиткой, как в офисе, но весь в конфетти и серпантине
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const alt = ((x >> 3) + (y >> 3)) % 2 === 1;
      // в темноте ковролин почти чёрный: ворс едва виден
      px(g, x, y, dark ? PAL.ink : PAL.dusk, 8, 8);
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const on = alt ? j % 3 === 0 && (i + j) % 2 === 0 : i % 3 === 0 && (i + j) % 2 === 0;
          if (on) px(g, x + i, y + j, PAL.night);
        }
      }
    }
  }
  for (let y = 13; y < h - 3; y++) {
    for (let x = 4; x < w - 4; x++) {
      const v = hash(x, y);
      // в темноте конфетти видно только местами — там, где ловит свет гирлянды
      if (v < (dark ? 0.005 : 0.009)) px(g, x, y, BULBS[Math.floor(hash(y, x) * BULBS.length)]);
    }
  }
  // серпантин: завитки
  for (const [sx, sy, col] of [[30, 70, PAL.coral], [150, 90, PAL.cyan], [40, 200, PAL.amber], [140, 230, PAL.orchid], [96, 238, PAL.green]] as const) {
    for (let k = 0; k < 14; k++) {
      const a = k * 0.9;
      const r = 1 + k * 0.35;
      px(g, Math.round(sx + Math.cos(a) * r * 1.3), Math.round(sy + Math.sin(a) * r), C(col));
    }
  }
  // мандариновые корки
  for (const [sx, sy] of [[62, 40], [120, 205], [24, 150]]) {
    px(g, sx, sy, C(PAL.orange), 2, 1);
    px(g, sx + 1, sy + 1, C(PAL.amber), 1, 1);
  }
  // «снег» из ваты под ёлкой
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 40 && d > 37) px(g, x, y, C(PAL.steel));
      else if (d <= 37) {
        // вата не белая, а голубовато-серая: белые рубашки толпы на ней видны
        const v = hash(x >> 1, y >> 1);
        if (dark) px(g, x, y, (x + y) % 2 === 0 ? PAL.dusk : v < 0.3 ? PAL.steel : PAL.night);
        else px(g, x, y, v < 0.22 ? PAL.white : v > 0.9 ? PAL.steel : PAL.mist);
        if (!dark && (x + y) % 2 === 0 && v > 0.55 && v <= 0.9) px(g, x, y, PAL.slate);
        if (hash(x, y) < 0.012) px(g, x, y, dark ? PAL.amber : PAL.cyan); // блёстки
      }
    }
  }
  // стена: окна с зимней ночью и снежинками, гирлянда провисает между гвоздиками
  px(g, 0, 0, C(PAL.mist), w, 12);
  for (let x = 8; x + 22 <= w - 6; x += 30) {
    px(g, x, 1, C(PAL.slate), 22, 9);
    px(g, x + 1, 2, dark ? PAL.ink : PAL.navy, 20, 7);
    px(g, x + 11, 2, C(PAL.slate), 1, 7);
    for (let k = 0; k < 6; k++) px(g, x + 2 + Math.floor(hash(x, k) * 18), 2 + Math.floor(hash(k, x) * 7), PAL.white);
    // бумажная снежинка на стекле
    grid(g, x + 4, 4, ['.w.', 'www', '.w.'], { w: C(PAL.white) });
  }
  for (let x = 0; x < w; x++) {
    const y = 3 + Math.round(Math.abs(Math.sin((x / 22) * Math.PI)) * 3);
    px(g, x, y, C(PAL.ink));
    if (x % 6 === 3) {
      const col = BULBS[Math.floor(x / 6) % BULBS.length];
      px(g, x, y + 1, col);
      px(g, x, y + 2, dark ? col : C(col));
      if (dark) {
        // в темноте лампочки светятся: ореол на стене
        px(g, x - 1, y + 1, col);
        px(g, x + 1, y + 1, col);
        px(g, x, y + 3, col);
      }
    }
  }
  // плинтус и тёмные стены по бокам
  px(g, 0, 10, C(PAL.slate), w, 1);
  px(g, 0, 11, C(PAL.steel), w, 1);
  px(g, 0, 12, PAL.night, w, 1);
  px(g, 0, 12, PAL.night, 4, h - 12);
  px(g, w - 4, 12, PAL.night, 4, h - 12);
  px(g, 3, 13, C(PAL.steel), 1, h - 16);
  px(g, w - 4, 13, C(PAL.steel), 1, h - 16);
  // на боковых стенах — мишура
  for (let y = 16; y < h - 6; y += 3) {
    px(g, 1, y, (y / 3) % 2 ? PAL.amber : C(PAL.yellow));
    px(g, w - 2, y, (y / 3) % 2 ? C(PAL.yellow) : PAL.amber);
  }
  px(g, 0, h - 3, PAL.night, w, 3);
  return c;
}

// ═════════════ предметы ═════════════

/** Ёлка с огнями (центр, 4 кадра — огни бегут); в темноте огни ярче и с ореолом. */
function xmasTree(dark: boolean): PropArt {
  const fw = 34;
  const fh = 34;
  const { c, g } = canvas(fw * 4, fh);
  const cx = 17;
  const hw = (y: number) => {
    let r = -1;
    if (y >= 5 && y <= 12) r = Math.max(r, Math.floor((y - 5) * 0.8) + 1);
    if (y >= 10 && y <= 19) r = Math.max(r, Math.floor((y - 10) * 0.8) + 3);
    if (y >= 16 && y <= 27) r = Math.max(r, Math.floor((y - 16) * 0.85) + 5);
    return r;
  };
  const lights: [number, number][] = [];
  for (let k = 0; k < 40 && lights.length < 16; k++) {
    const y = 7 + Math.floor(hash(k, 11) * 20);
    const r = hw(y);
    if (r < 2) continue;
    const x = cx - r + 1 + Math.floor(hash(k, 12) * (r * 2 - 1));
    if (!lights.some(([lx, ly]) => Math.abs(lx - x) + Math.abs(ly - y) < 3)) lights.push([x, y]);
  }
  for (let f = 0; f < 4; f++) {
    const ox = f * fw;
    // ствол и подарки
    px(g, ox + cx - 2, 27, PAL.ink, 4, 4);
    px(g, ox + cx - 1, 27, dark ? PAL.plum : PAL.umber, 2, 3);
    const gift = (x: number, y: number, ww: number, hh: number, col: string, rib: string) => {
      px(g, ox + x, y, PAL.ink, ww, hh);
      px(g, ox + x + 1, y + 1, dark ? dim(col) : col, ww - 2, hh - 2);
      px(g, ox + x + Math.floor(ww / 2), y + 1, dark ? dim(rib) : rib, 1, hh - 2);
      px(g, ox + x + 1, y + Math.floor(hh / 2), dark ? dim(rib) : rib, ww - 2, 1);
    };
    gift(6, 27, 8, 7, PAL.orchid, PAL.white);
    gift(20, 28, 9, 6, PAL.navy, PAL.amber);
    gift(13, 30, 6, 4, PAL.forest, PAL.yellow);
    // крона ярусами: контур, светлая и тёмная стороны
    for (let y = 5; y <= 27; y++) {
      const r = hw(y);
      if (r < 0) continue;
      px(g, ox + cx - r - 1, y, PAL.ink, r * 2 + 3, 1);
      for (let x = -r; x <= r; x++) {
        const lit = x < -r / 3;
        const shade = x > r / 3;
        let col: string = lit ? PAL.green : shade ? PAL.pine : PAL.forest;
        if (dark) col = lit ? PAL.forest : shade ? PAL.deep : PAL.pine;
        px(g, ox + cx + x, y, col);
      }
      const nr = hw(y + 1);
      if (nr > r + 1 || nr < 0) px(g, ox + cx - r, y, PAL.ink, r * 2 + 1, 1); // нижний край яруса
    }
    // гирлянда-мишура по диагонали
    for (let k = 0; k < 3; k++) {
      for (let x = -12; x <= 12; x++) {
        const y = 12 + k * 7 + Math.round(x * 0.3);
        if (hw(y) >= Math.abs(x) && hw(y) > 1) px(g, ox + cx + x, y, dark ? PAL.clay : (x + f) % 3 ? PAL.amber : PAL.yellow);
      }
    }
    // огни: цвет бежит по кадрам
    lights.forEach(([x, y], k) => {
      const col = BULBS[(k + f) % BULBS.length];
      const on = dark || (k + f) % 3 !== 0;
      if (!on) return;
      px(g, ox + x, y, col);
      if (dark) {
        px(g, ox + x - 1, y, col);
        px(g, ox + x + 1, y, col);
        px(g, ox + x, y - 1, col);
        px(g, ox + x, y, PAL.white);
      }
    });
    // звезда на макушке
    grid(g, ox + cx - 3, 0, ['...y...', '..yyy..', 'yyywyyy', '.yyyyy.', '.yy.yy.', '.y...y.'], {
      y: f % 2 && !dark ? PAL.amber : PAL.yellow,
      w: PAL.white,
    });
  }
  return [c, fw, fh, 4];
}

/** Фикус в мишуре и шарах (угол). */
function ficus(dark: boolean): PropArt {
  const { c, g } = canvas(22, 30);
  const C = (col: string) => (dark ? dim(col) : col);
  px(g, 6, 21, PAL.ink, 10, 9);
  px(g, 7, 22, C(PAL.brick), 8, 7);
  px(g, 7, 22, C(PAL.clay), 8, 1);
  px(g, 5, 21, PAL.ink, 12, 2);
  px(g, 6, 21, C(PAL.rust), 10, 1);
  px(g, 10, 14, PAL.ink, 3, 7);
  px(g, 11, 14, C(PAL.umber), 1, 7);
  ellipse(g, 11, 9, 9, 8, PAL.ink);
  ellipse(g, 11, 9, 8, 7, C(PAL.forest));
  ellipse(g, 8, 7, 4, 3, C(PAL.green));
  ellipse(g, 15, 11, 3, 2, C(PAL.pine));
  // мишура спиралью
  for (let x = 3; x <= 19; x++) {
    const y = 5 + Math.round((x - 3) * 0.55) + (x % 2);
    if (Math.hypot((x - 11) / 8, (y - 9) / 7) <= 1) px(g, x, y, (x % 3 ? PAL.amber : dark ? PAL.clay : PAL.yellow));
  }
  // шары
  for (const [x, y, col] of [[6, 11, PAL.coral], [15, 6, PAL.cyan], [12, 13, PAL.orchid], [9, 4, PAL.white]] as const) {
    px(g, x, y, PAL.ink, 3, 3);
    px(g, x, y, C(col), 2, 2);
    px(g, x, y, dark ? C(col) : PAL.white, 1, 1);
  }
  return [c, 22, 30, 1];
}

/** Светящаяся звезда на стойке (вместо фонаря, мигает). */
function starLamp(dark: boolean): PropArt {
  const { c, g } = canvas(18, 26);
  for (let f = 0; f < 2; f++) {
    const ox = f * 9;
    px(g, ox + 4, 7, PAL.ink, 1, 17);
    px(g, ox + 3, 7, dark ? PAL.dusk : PAL.steel, 1, 17);
    px(g, ox + 1, 24, PAL.ink, 7, 2);
    const col = f ? PAL.amber : PAL.yellow;
    grid(g, ox, 0, ['....y....', '...yyy...', '.yyyyyyy.', '..yywyy..', '..yy.yy..', '.yy...yy.', '.........'], {
      y: dark || f === 0 ? col : PAL.clay,
      w: PAL.white,
    });
    if (dark) {
      px(g, ox, 3, PAL.amber);
      px(g, ox + 8, 3, PAL.amber);
      px(g, ox + 4, 6, PAL.amber);
    }
  }
  return [c, 9, 26, 2];
}

/** Фуршет: скатерть, мандарины, шампанское, салатник. */
function buffetH(dark: boolean): PropArt {
  const { c, g } = canvas(22, 10);
  const C = (col: string) => (dark ? dim(col) : col);
  px(g, 0, 1, PAL.ink, 22, 7);
  px(g, 1, 2, C(PAL.white), 20, 4);
  px(g, 1, 6, C(PAL.mist), 20, 1);
  for (let x = 1; x < 21; x += 3) px(g, x, 6, C(PAL.wine), 1, 1); // кайма скатерти
  // салатник
  px(g, 2, 2, PAL.ink, 7, 3);
  px(g, 3, 2, C(PAL.sand), 5, 2);
  px(g, 4, 2, C(PAL.orange), 1, 1);
  px(g, 6, 3, C(PAL.green), 1, 1);
  // мандарины
  for (const x of [11, 13, 12]) {
    px(g, x, x === 12 ? 2 : 3, C(PAL.orange), 2, 2);
    px(g, x, x === 12 ? 2 : 3, C(PAL.amber), 1, 1);
  }
  px(g, 13, 1, C(PAL.green), 1, 1);
  // шампанское
  px(g, 17, 0, PAL.ink, 3, 6);
  px(g, 18, 1, C(PAL.pine), 1, 5);
  px(g, 18, 0, C(PAL.amber), 1, 2);
  px(g, 2, 8, PAL.ink, 2, 2);
  px(g, 18, 8, PAL.ink, 2, 2);
  return [c, 22, 10, 1];
}

function buffetV(dark: boolean): PropArt {
  const { c, g } = canvas(9, 24);
  const C = (col: string) => (dark ? dim(col) : col);
  px(g, 1, 0, PAL.ink, 7, 22);
  px(g, 2, 1, C(PAL.white), 5, 20);
  px(g, 6, 1, C(PAL.mist), 1, 20);
  for (let y = 1; y < 21; y += 3) px(g, 2, y, C(PAL.wine));
  for (const y of [3, 5]) {
    px(g, 3, y, C(PAL.orange), 2, 2);
    px(g, 3, y, C(PAL.amber), 1, 1);
  }
  // бокалы
  for (const y of [9, 12]) {
    px(g, 3, y, C(PAL.amber), 2, 2);
    px(g, 3, y - 1, C(PAL.white), 2, 1);
    px(g, 4, y + 2, C(PAL.mist), 1, 1);
  }
  px(g, 3, 15, PAL.ink, 3, 5);
  px(g, 4, 16, C(PAL.pine), 1, 4);
  px(g, 4, 15, C(PAL.amber), 1, 1);
  px(g, 1, 22, PAL.ink, 2, 2);
  px(g, 6, 22, PAL.ink, 2, 2);
  return [c, 9, 24, 1];
}

/** Караоке: экран со строчками, колонка, микрофон на стойке. В темноте светится экран. */
function karaoke(dark: boolean): PropArt {
  const { c, g } = canvas(34, 30);
  const C = (col: string) => (dark ? dim(col) : col);
  // экран на ножке
  px(g, 1, 0, PAL.ink, 24, 17);
  px(g, 2, 1, dark ? PAL.navy : PAL.night, 22, 15);
  for (let k = 0; k < 4; k++) {
    const y = 4 + k * 3;
    const len = 8 + Math.floor(hash(k, 3) * 10);
    px(g, 4, y, k === 1 ? PAL.yellow : dark ? PAL.cyan : PAL.white, len, 1);
    if (k === 1) px(g, 4 + len, y, PAL.white, 4, 1); // строка, которую поют
  }
  px(g, 12, 17, PAL.ink, 2, 9);
  px(g, 8, 26, PAL.ink, 10, 2);
  // колонка
  px(g, 25, 8, PAL.ink, 9, 22);
  px(g, 26, 9, C(PAL.dusk), 7, 20);
  ellipse(g, 29, 14, 2, 2, PAL.ink);
  ellipse(g, 29, 23, 3, 3, PAL.ink);
  px(g, 29, 23, C(PAL.steel));
  px(g, 29, 14, C(PAL.steel));
  // микрофон на стойке
  px(g, 20, 18, PAL.ink, 1, 10);
  px(g, 18, 28, PAL.ink, 5, 2);
  px(g, 19, 15, PAL.ink, 3, 4);
  px(g, 20, 16, C(PAL.slate), 1, 2);
  return [c, 34, 30, 1];
}

/** Подарки рядком. */
function gifts(dark: boolean): PropArt {
  const { c, g } = canvas(32, 13);
  const C = (col: string) => (dark ? dim(col) : col);
  const list: [number, number, number, string, string][] = [
    [0, 4, 8, PAL.wine, PAL.amber],
    [8, 1, 7, PAL.navy, PAL.white],
    [15, 5, 9, PAL.orchid, PAL.yellow],
    [24, 3, 8, PAL.forest, PAL.coral],
  ];
  for (const [x, y, w, col, rib] of list) {
    const hh = 13 - y;
    px(g, x, y, PAL.ink, w, hh);
    px(g, x + 1, y + 1, C(col), w - 2, hh - 2);
    px(g, x + Math.floor(w / 2), y + 1, C(rib), 1, hh - 2);
    px(g, x + 1, y + 3, C(rib), w - 2, 1);
    px(g, x + Math.floor(w / 2) - 1, y - 1, C(rib), 1, 1);
    px(g, x + Math.floor(w / 2) + 1, y - 1, C(rib), 1, 1);
  }
  return [c, 32, 13, 1];
}

function props(dark: boolean): PropSet {
  return {
    fountain: () => xmasTree(dark),
    tree: () => ficus(dark),
    lamp: () => starLamp(dark),
    benchH: () => buffetH(dark),
    benchV: () => buffetV(dark),
    stall: () => karaoke(dark),
    planter: () => gifts(dark),
  };
}

const LIT = props(false);
const UNLIT = props(true);

/** Снегирь — вместо голубя. */
function bullfinch(dark: boolean) {
  return (frames: string[][]) =>
    critterSheet(frames, { o: PAL.ink, b: dark ? PAL.dusk : PAL.steel, h: PAL.ink, w: dark ? PAL.wine : PAL.coral, y: PAL.ink });
}

// ═════════════ музыка ═════════════
// Мотив общий с новогодним меню (newyear.ts): соль мажор, G – Em – Am – D, мелодия своя.

const ROOTS = NY_ROOTS;
const TRIADS = NY_TRIADS;
const melodyAt = nyMelodyAt;

const song: Song = {
  blackout: true,
  step(a: SongApi, st: SongStep) {
    const { s16: s, bar, t, dt, intensity: I, twist } = st;
    const ch = bar % 4;
    const root = ROOTS[ch];
    const tri = TRIADS[ch];
    if (!twist) {
      // ── при свете: свинг, бубенцы, колокольчики ──
      if (s % 4 === 0) a.voice('triangle', root + (s === 8 ? 7 : 0), t, dt * 3, 0.15);
      if (s % 4 === 2) for (const iv of tri) a.voice('pulse', root + 24 + iv, t, dt * 1.1, 0.022);
      // бубенцы шаффлом
      a.hit(0.025, s % 2 ? 0.02 : 0.035, 8500, t);
      if (s === 0 || s === 10 || (I >= 1 && s === 8)) a.kick(t, 0.16, 120);
      if (s === 4 || s === 12) a.hit(0.03, 0.06, 2600, t);
      const phrase = Math.floor(bar / 4) % 2;
      const m = melodyAt(ch, s);
      if (m) {
        // мелодия колокольчиком; во второй фразе — ещё и октавой ниже
        a.voice('triangle', m[0], t, dt * m[1] * 0.9, 0.06);
        a.voice('sine', m[0] + 12, t, dt * 0.6, 0.025);
        if (phrase) a.voice('pulse', m[0] - 12, t, dt * m[1] * 0.8, 0.025);
      }
      if (bar % 4 === 3 && s >= 12 && s % 2 === 0) a.voice('sine', 86 - (s - 12), t, dt, 0.02); // звон в конце круга
      return;
    }
    // ── свет погас: танцевальный бит «на четыре» (вход — «свет вырубили», Music › blackout) ──
    const b = st.barsSinceTwist;
    if (s === 0 && (b === 0 || b % 8 === 0)) a.hit(0.9, 0.15, 4500, t);
    const drop = b % 8 === 7; // такт-сбивка: без бочки, дробь малого
    if (!drop && s % 4 === 0) a.kick(t, 0.32, 150);
    if (drop && s >= 8 && s % 2 === 0) a.hit(0.06, 0.06 + (s - 8) * 0.012, 1500, t);
    if (!drop && (s === 4 || s === 12)) a.hit(0.12, 0.18, 1500, t);
    if (s % 4 === 2) a.hit(0.09, 0.05, 7500, t); // открытый хэт на «и»
    if (I >= 1 && s % 2 === 0 && s % 4 !== 2) a.hit(0.02, 0.025, 9000, t);
    // бас октавами восьмыми
    if (s % 2 === 0) a.voice('square', root + (s % 4 === 2 ? 12 : 0), t, dt * 1.6, 0.13);
    // аккорд-стаб
    if (s === 6 || s === 14) for (const iv of tri) a.voice('pulse', root + 24 + iv, t, dt * 1.2, 0.035);
    // мелодия — со второго такта темноты
    const m = b >= 2 ? melodyAt(ch, s) : null;
    if (m) a.voice('square', m[0], t, dt * m[1] * 0.85, 0.05);
  },
};

// ═════════════ пакет ═════════════

const pack: ThemePack = {
  looks: [
    {
      chars: LIGHT[0],
      variants: LIGHT.slice(1),
      poses: PARTY_POSES,
      acts: PARTY_ACTS,
      icons: PARTY_ICONS,
      ground: (a) => partyGround(a, false),
      prop: (kind) => LIT[kind]?.() ?? null,
      // подарочная бумага
      wall: () => tile(['wwwwwwww', 'wrrwrrrw', 'wrrrwrrw', 'wrrrrwrw', 'wrrrrrww', 'wwrrrrrw', 'wrwrrrrw', 'wwwwwwww'], { w: PAL.white, r: PAL.wine }),
      critter: bullfinch(false),
    },
    {
      chars: DARK[0],
      variants: DARK.slice(1),
      poses: DARK_POSES,
      acts: DARK_ACTS,
      icons: DARK_ICONS,
      ground: (a) => partyGround(a, true),
      prop: (kind) => UNLIT[kind]?.() ?? null,
      // гирлянда в темноте
      wall: () => tile(['nnnnnnnn', 'nannnnnn', 'nnnnncnn', 'nnnnnnnn', 'nnonnnnn', 'nnnnnnan', 'nnnnnnnn', 'ngnnnnnn'], { n: PAL.night, a: PAL.amber, c: PAL.cyan, o: PAL.orchid, g: PAL.green }),
      critter: bullfinch(true),
      // в темноте поле мерцает цветами гирлянды в такт
      pulse: { colors: [PAL.amber, PAL.orchid, PAL.cyan, PAL.green], ms: Math.round(60000 / 124), alpha: 0.08 },
    },
  ],
  music: { flavor: { transpose: 0, bpm: 124, swing: 0.2, lead: 'triangle', bass: 'triangle', arp: false, echo: true }, song },
};

export default pack;

