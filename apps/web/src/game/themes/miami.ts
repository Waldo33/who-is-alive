import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import { face, skin } from './people';
import type { CharStyle, Look, Pose, PropSet, ThemePack, View } from './types';
import { centerDist, critterSheet, hash, line, tile } from './util';

/**
 * «Майами-86». Днём — Ocean Drive в духе криминальных боевиков 80-х (дань Vice City): туристы
 * в гавайских рубашках, пастельные отели, бассейн с фламинго, кабриолет, синт-поп. На закате
 * (плавно, без мигания) — неоновая ночь в духе Hotline Miami: те же люди в звериных масках,
 * поле пульсирует в такт, тёмный синти с эхом-шлейфом. Подобрал звезду — мигалка («розыск»).
 * Ни названий, ни героев, ни мелодий источников — только жанр, палитра и типажи.
 */

const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};

/** Ноги ниже шорт — голые. */
const shorts = (m: string[][]) => {
  m[14] = m[14].map((ch) => (ch === 'l' ? 'a' : ch));
};

// ═════════════ день: туристы ═════════════

/** Гавайская рубашка: цветочки по ткани, расстёгнутый ворот. */
function hawaii(m: string[][], view: View): void {
  if (view === 'D') {
    set(m, 4, 9, 'f'); set(m, 7, 10, 'f'); set(m, 3, 11, 'f'); set(m, 8, 11, 'f');
    set(m, 5, 9, 's'); set(m, 6, 9, 's'); // ворот
  } else if (view === 'U') {
    set(m, 4, 10, 'f'); set(m, 7, 11, 'f'); set(m, 5, 9, 'f');
  } else {
    set(m, 5, 10, 'f'); set(m, 7, 9, 'f');
  }
}

/** Тёмные очки. */
function shades(m: string[][], view: View): void {
  if (view === 'D') for (const x of [2, 3, 4, 5, 6, 7, 8, 9]) set(m, x, 5, 'g');
  else if (view === 'S') for (const x of [6, 7, 8, 9]) set(m, x, 5, 'g');
}

const TOURIST_MAP = {
  ...BASE_MAP,
  g: PAL.ink,
  // фотоаппарат, кружка-коктейль и зонтик, доска, напульсник
  Q: PAL.ink, q: PAL.mist, G: PAL.cyan, U: PAL.orange, Z: PAL.cyan, x: PAL.white,
};

/** Туристы в порядке людей PEOPLE: тот же человек ночью — в маске (MASKED ниже). */
const TOURISTS: CharStyle[] = [
  // розовая рубашка в жёлтый цветочек, бежевые шорты
  {
    map: { ...TOURIST_MAP, ...face(0), c: PAL.coral, a: skin(0), b: PAL.coral, B: PAL.orchid, v: PAL.coral, f: PAL.yellow, l: PAL.sand, L: PAL.umber },
    patch: (m, view) => { hawaii(m, view); shorts(m); },
  },
  // бирюзовая рубашка в белый цветочек, белые шорты, тёмные очки
  {
    map: { ...TOURIST_MAP, ...face(1), a: skin(1), b: PAL.cyan, B: PAL.blue, v: PAL.cyan, f: PAL.white, l: PAL.white, L: PAL.umber },
    patch: (m, view) => { hawaii(m, view); shades(m, view); shorts(m); },
  },
  // сиреневая рубашка, джинсовые шорты
  {
    map: { ...TOURIST_MAP, ...face(2), a: skin(2), b: PAL.orchid, B: PAL.grape, v: PAL.orchid, f: PAL.sand, l: PAL.navy, L: PAL.ink },
    patch: (m, view) => { hawaii(m, view); shorts(m); },
  },
  // белое поло, оранжевые шорты, золотая цепь, очки
  {
    map: { ...TOURIST_MAP, ...face(3), a: skin(3), b: PAL.white, B: PAL.mist, v: PAL.white, f: PAL.amber, l: PAL.orange, L: PAL.ink },
    patch: (m, view) => {
      shades(m, view);
      shorts(m);
      if (view === 'D') { set(m, 4, 9, 'f'); set(m, 7, 9, 'f'); set(m, 5, 10, 'f'); set(m, 6, 10, 'f'); }
    },
  },
  // лысый, обгоревший, тёмно-зелёная рубашка в оранжевый цветочек
  {
    map: { ...TOURIST_MAP, ...face(4), c: PAL.red, a: skin(4), b: PAL.forest, B: PAL.pine, v: PAL.forest, f: PAL.orange, l: PAL.tan, L: PAL.umber },
    patch: (m, view) => { hawaii(m, view); shorts(m); },
  },
];

// ═════════════ ночь: звериные маски ═════════════

type Mask = 'pig' | 'horse' | 'owl' | 'tiger' | 'wolf';

/** Маска закрывает голову целиком (строки 0–8): M — основной цвет, N — тень, Y — глаза, W — светлое, Z — морда, K — чёрное. */
function mask(kind: Mask) {
  return (m: string[][], view: View): void => {
    for (let y = 0; y <= 8; y++) {
      for (let x = 0; x < 12; x++) {
        const ch = m[y][x];
        if (ch === '.' || ch === 'o') continue;
        m[y][x] = ch === 'H' || ch === 'R' || ch === 'S' ? 'N' : ch === 'e' ? (kind === 'owl' || kind === 'wolf' ? 'Y' : 'K') : 'M';
      }
    }
    // уши/хохолки над головой
    if (kind !== 'horse') { set(m, 2, 0, 'N'); set(m, 9, 0, 'N'); } else { set(m, 3, 0, 'M'); set(m, 8, 0, 'M'); }
    if (view === 'D') {
      if (kind === 'pig') {
        for (let x = 4; x <= 7; x++) { set(m, x, 6, 'Z'); set(m, x, 7, 'Z'); }
        set(m, 5, 7, 'K'); set(m, 6, 7, 'K');
      } else if (kind === 'horse') {
        for (let x = 3; x <= 8; x++) set(m, x, 1, 'K'); // грива
        for (let y = 2; y <= 6; y++) { set(m, 5, y, 'W'); set(m, 6, y, 'W'); } // проточина
        for (let x = 3; x <= 8; x++) set(m, x, 8, 'Z');
        set(m, 4, 8, 'K'); set(m, 7, 8, 'K');
      } else if (kind === 'owl') {
        for (const cx of [3, 8]) for (let y = 4; y <= 6; y++) for (let x = cx - 1; x <= cx + 1; x++) set(m, x, y, 'Y');
        set(m, 3, 5, 'K'); set(m, 8, 5, 'K');
        set(m, 5, 6, 'Z'); set(m, 6, 6, 'Z'); set(m, 5, 7, 'Z');
      } else if (kind === 'tiger') {
        set(m, 3, 1, 'K'); set(m, 8, 1, 'K'); set(m, 5, 2, 'K'); set(m, 6, 2, 'K'); set(m, 2, 4, 'K'); set(m, 9, 4, 'K');
        for (let x = 3; x <= 8; x++) { set(m, x, 6, 'W'); set(m, x, 7, 'W'); }
        set(m, 5, 6, 'K'); set(m, 6, 6, 'K');
      } else {
        for (let x = 4; x <= 7; x++) { set(m, x, 6, 'W'); set(m, x, 7, 'W'); }
        set(m, 5, 6, 'K'); set(m, 6, 6, 'K');
      }
    } else if (view === 'U') {
      if (kind === 'horse') for (let y = 1; y <= 8; y++) { set(m, 5, y, 'K'); set(m, 6, y, 'K'); }
      if (kind === 'tiger') { set(m, 3, 3, 'K'); set(m, 8, 3, 'K'); set(m, 5, 5, 'K'); set(m, 6, 5, 'K'); }
    } else {
      // сбоку: морда вперёд
      if (kind === 'pig' || kind === 'horse' || kind === 'wolf') {
        set(m, 10, 6, kind === 'horse' ? 'Z' : kind === 'pig' ? 'Z' : 'W'); set(m, 10, 7, kind === 'horse' ? 'Z' : kind === 'pig' ? 'Z' : 'W');
        set(m, 11, 6, 'o'); set(m, 11, 7, 'o');
      }
      if (kind === 'owl') { set(m, 8, 5, 'Y'); set(m, 9, 6, 'Z'); }
      if (kind === 'horse') for (let y = 1; y <= 7; y++) set(m, 2, y, 'K');
    }
  };
}

const MASK_COLORS: Record<Mask, Record<string, string>> = {
  pig: { M: PAL.coral, N: PAL.orchid, Z: PAL.peach, Y: PAL.yellow, W: PAL.white, K: PAL.ink },
  horse: { M: PAL.umber, N: PAL.plum, Z: PAL.fawn, Y: PAL.yellow, W: PAL.white, K: PAL.night },
  owl: { M: PAL.fawn, N: PAL.umber, Z: PAL.amber, Y: PAL.yellow, W: PAL.white, K: PAL.ink },
  tiger: { M: PAL.orange, N: PAL.rust, Z: PAL.white, Y: PAL.yellow, W: PAL.white, K: PAL.ink },
  wolf: { M: PAL.slate, N: PAL.steel, Z: PAL.mist, Y: PAL.yellow, W: PAL.white, K: PAL.ink },
};

const NIGHT_MAP = { ...BASE_MAP };

/** Те же люди ночью: свои руки (кожа), тёмная одежда с неоном, маска. */
const MASKED: CharStyle[] = (
  [
    // свинья, тёмная футболка с розовой полосой
    ['pig', { b: PAL.night, B: PAL.ink, v: PAL.orchid, l: PAL.navy, L: PAL.ink }],
    // лошадь, светлая майка
    ['horse', { b: PAL.mist, B: PAL.slate, v: PAL.mist, l: PAL.ink, L: PAL.ink }],
    // сова, фиолетовая толстовка
    ['owl', { b: PAL.grape, B: PAL.plum, v: PAL.grape, l: PAL.night, L: PAL.ink }],
    // тигр, чёрная кожанка с бирюзой
    ['tiger', { b: PAL.ink, B: PAL.ink, v: PAL.cyan, l: PAL.navy, L: PAL.ink }],
    // волк, синяя олимпийка с белыми лампасами
    ['wolf', { b: PAL.navy, B: PAL.night, v: PAL.white, l: PAL.navy, L: PAL.ink }],
  ] as [Mask, Record<string, string>][]
).map(([kind, clothes], i) => ({
  map: { ...NIGHT_MAP, ...face(i), ...MASK_COLORS[kind], a: skin(i), ...clothes },
  patch: mask(kind),
}));

/**
 * Те же люди ночью, но ещё без маски — для анимации «натянуть маску» на закате (и снять на
 * рассвете): маска в руках над головой → натянута до глаз → надета (обычный ночной облик).
 */
const UNMASKED: CharStyle[] = MASKED.map((st) => ({ map: st.map }));

/** Маска закрывает голову сверху до строки `to` (контур остаётся); на 5-й строке — прорези глаз. */
const maskTo = (to: number) => (m: string[][]) => {
  for (let y = 0; y <= to; y++) for (let x = 0; x < 12; x++) if (m[y][x] !== '.' && m[y][x] !== 'o') m[y][x] = y === to ? 'N' : 'M';
  if (to >= 5) { set(m, 3, 5, 'K'); set(m, 8, 5, 'K'); }
};

const MASKING_POSES: Pose[] = [
  // 0 маска в поднятых руках, на макушке
  { view: 'D', arms: 'up', patch: maskTo(2) },
  // 1 натянута до подбородка — ещё видно рот
  { view: 'D', arms: 'up', patch: maskTo(6) },
];

// ═════════════ действия ═════════════

const rightArmUp = (m: string[][]) => { set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); };
const armsOff = (m: string[][]) => { set(m, 2, 10, 'b'); set(m, 2, 11, 'B'); rightArmUp(m); };

/** День: фото, сёрфинг, аэробика, коктейль. */
const DAY_POSES: Pose[] = [
  // 0 «Скажи «сыр»!»: фотоаппарат у лица, руки держат
  {
    view: 'D',
    patch: (m) => {
      armsOff(m);
      for (let x = 3; x <= 8; x++) { set(m, x, 5, 'Q'); set(m, x, 6, 'Q'); }
      set(m, 5, 5, 'q'); set(m, 6, 6, 'q'); set(m, 8, 4, 'q');
      set(m, 2, 6, 'a'); set(m, 9, 6, 'a'); set(m, 2, 7, 'a'); set(m, 9, 7, 'a'); set(m, 2, 8, 'a'); set(m, 9, 8, 'a');
    },
  },
  // 1–2 сёрфинг: руки в стороны, доска под ногами, качает
  ...[0, 1].map((tilt): Pose => ({
    view: 'D',
    legs: tilt ? 'liftL' : 'liftR',
    patch: (m) => {
      armsOff(m);
      set(m, 0, tilt ? 8 : 10, 'a'); set(m, 1, 9, 'a'); set(m, 10, 9, 'a'); set(m, 11, tilt ? 10 : 8, 'a');
      for (let x = 0; x < 12; x++) if (m[15][x] === '.') set(m, x, 15, 'Z');
    },
  })),
  // 3–4 аэробика: руки вверх / вниз, ноги врозь, напульсник
  { view: 'D', arms: 'up', legs: 'liftL', face: 'happy', patch: (m) => { for (let x = 2; x <= 9; x++) if (m[3][x] !== 'o') set(m, x, 3, 'x'); } },
  { view: 'D', legs: 'liftR', face: 'happy', patch: (m) => { for (let x = 2; x <= 9; x++) if (m[3][x] !== 'o') set(m, x, 3, 'x'); } },
  // 5 коктейль у груди (с зонтиком)
  { view: 'D', patch: (m) => { set(m, 8, 10, 'G'); set(m, 8, 11, 'G'); set(m, 9, 9, 'U'); set(m, 10, 9, 'U'); } },
  // 6 глоток: бокал у рта
  {
    view: 'D',
    patch: (m) => {
      rightArmUp(m);
      set(m, 6, 7, 'G'); set(m, 7, 7, 'G'); set(m, 8, 6, 'U'); set(m, 9, 6, 'U');
      set(m, 8, 8, 'a'); set(m, 9, 9, 'a');
    },
  },
];

const DAY_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 },
  jump: { poses: [1, 2], ms: 260, yoff: [0, -1] },
  dance: { poses: [3, 4], ms: 254 },
  wave: { poses: [5, 6, 6, 5], ms: 260 },
};

/** Наклон головы: строки 0–8 сдвигаются на пиксель. */
const tiltHead = (dir: 1 | -1) => (m: string[][]) => {
  for (let y = 0; y <= 8; y++) {
    const row = m[y];
    m[y] = dir > 0 ? ['.', ...row.slice(0, 11)] : [...row.slice(1), '.'];
  }
};

/** Ночь: руки вверх, пригнуться, танцпол, жуткий наклон головы. */
const NIGHT_POSES: Pose[] = [
  { view: 'D', arms: 'up' }, // 0 руки вверх
  // 1 пригнулся, руки над головой
  { view: 'D', arms: 'up', legs: 'idle' },
  // 2–3 танцпол: кулак вверх / вниз
  { view: 'D', arms: 'rightUp', legs: 'liftL' },
  { view: 'D', legs: 'liftR' },
  // 4–5 голова набок — вправо и влево
  { view: 'D', patch: tiltHead(1) },
  { view: 'D', patch: tiltHead(-1) },
];

const NIGHT_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 },
  jump: { poses: [1, 1], ms: 300, yoff: [3, 2] },
  dance: { poses: [2, 3], ms: 254 },
  wave: { poses: [4, 4, 5, 5], ms: 420 },
};

const DAY_ICONS = {
  freeze: ['..oo....', 'oooooooo', 'onnoonno', 'onowwono', 'onowwono', 'onnoonno', 'oooooooo', '........'],
  jump: ['......ff', '.....fwf', '....fwf.', '...fwf..', '..fwf...', '.fwf....', 'fwf.....', 'ff......'],
  dance: ['o..oo..o', 'ow.ww.wo', '.owwwwo.', '..owwo..', '..owwo..', '.ow..wo.', 'ow....wo', 'o......o'],
};

const NIGHT_ICONS = {
  freeze: ['o.o..o.o', 'owo..owo', 'owwoowwo', '.owwwwo.', '..owwo..', '..owwo..', '..owwo..', '..oooo..'],
  jump: ['...oo...', '..owwo..', '..owwo..', 'ooowwooo', '.owwwwo.', '..owwo..', '...oo...', '........'],
  dance: ['...oo...', '..owmo..', '.owmwmo.', 'omwmwmwo', 'owmwmwmo', '.omwmwo.', '..owmo..', '...oo...'],
};

// ═════════════ земля ═════════════

interface Ground {
  pave: string;
  pave2: string;
  wave: string;
  deck: string;
  deck2: string;
  grout: string;
  wall: string[];
  wallTrim: string;
  window: string;
  windowLit: string;
  side: string;
  sea: string;
  foam: string;
  shadow: string;
}

const DAY_GROUND: Ground = {
  pave: PAL.sand, pave2: PAL.peach, wave: PAL.coral, deck: PAL.white, deck2: PAL.mist, grout: PAL.cyan,
  wall: [PAL.coral, PAL.mist, PAL.sand, PAL.cyan, PAL.peach], wallTrim: PAL.white, window: PAL.navy, windowLit: PAL.blue,
  side: PAL.forest, sea: PAL.blue, foam: PAL.white, shadow: PAL.tan,
};

const NIGHT_GROUND: Ground = {
  pave: PAL.night, pave2: PAL.ink, wave: PAL.grape, deck: PAL.dusk, deck2: PAL.night, grout: PAL.cyan,
  wall: [PAL.ink, PAL.night, PAL.ink, PAL.night, PAL.ink], wallTrim: PAL.orchid, window: PAL.night, windowLit: PAL.amber,
  side: PAL.ink, sea: PAL.navy, foam: PAL.cyan, shadow: PAL.ink,
};

function ground(G: Ground) {
  return (arena: ArenaDef): HTMLCanvasElement => {
    const { width: w, height: h } = arena;
    const { c, g } = canvas(w, h);
    // тротуар Ocean Drive: плитка и волнистый узор
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tileOdd = ((x >> 3) + (y >> 3)) % 2 === 1;
        px(g, x, y, tileOdd && (x + y) % 2 === 0 ? G.pave2 : G.pave);
        const wy = Math.round(Math.sin((x + (y >> 4) * 9) / 5) * 1.5);
        if ((y + wy) % 16 === 0) px(g, x, y, G.wave);
      }
    }
    // тени пальм в углах
    for (const p of arena.props) {
      if (p.kind !== 'tree') continue;
      for (let y = -6; y <= 4; y++) for (let x = -12; x <= 12; x++) {
        if (Math.hypot(x / 1.6, y) > 6 || (x + y) % 2 !== 0) continue;
        px(g, p.x + x + 6, p.y + 2 + y, G.shadow);
      }
    }
    // настил у бассейна
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = centerDist(w, x, y);
        if (d < 40 && d > 37) px(g, x, y, G.grout);
        else if (d <= 37) {
          const seam = x % 6 === 0 || y % 6 === 0;
          px(g, x, y, seam ? G.deck2 : G.deck);
          if (seam && hash(x, y) < 0.08) px(g, x, y, G.grout);
        }
      }
    }
    // стена: фасады отелей ар-деко — окна, ступенчатые верха, неоновый карниз
    let x0 = 0;
    let k = 0;
    while (x0 < w) {
      const bw = 22 + Math.floor(hash(k, 3) * 10);
      const col = G.wall[k % G.wall.length];
      const top = hash(k, 5) < 0.5 ? 1 : 0;
      px(g, x0, top, col, bw, 10 - top);
      px(g, x0 + 2, 0, col, bw - 4, 1);
      for (let wy = 2; wy <= 7; wy += 3) {
        for (let wx = x0 + 3; wx < x0 + bw - 3; wx += 4) {
          px(g, wx, wy, hash(wx, wy + k) < 0.35 ? G.windowLit : G.window, 2, 2);
        }
      }
      px(g, x0, 9, G.wallTrim, bw, 1);
      px(g, x0 + bw - 1, top, PAL.ink, 1, 10 - top);
      x0 += bw;
      k++;
    }
    px(g, 0, 10, G.pave2, w, 1);
    px(g, 0, 11, PAL.ink, w, 1);
    // бортики — кусты, низ — море с пеной
    px(g, 0, 12, G.side, 4, h - 15);
    px(g, w - 4, 12, G.side, 4, h - 15);
    for (let y = 12; y < h - 3; y += 3) { px(g, 1, y, G.wave, 1, 1); px(g, w - 2, y + 1, G.wave, 1, 1); }
    px(g, 0, h - 3, G.sea, w, 3);
    for (let x = 0; x < w; x += 5) px(g, x + (x % 3), h - 3, G.foam, 2, 1);
    return c;
  };
}

// ═════════════ предметы ═════════════

interface PropColors {
  water: string; water2: string; ripple: string; rim: string; flamingo: string; flamingo2: string;
  trunk: string; trunk2: string; frond: string; frond2: string; rimLight: string;
  pole: string; neonA: string; neonB: string;
  lounger: string; cushion: string; cushion2: string;
  board1: string; board1s: string; board2: string; board2s: string;
  car: string; car2: string; glass: string; seat: string; chrome: string; light: string;
  pot: string; leaf: string; bloom: string;
}

const DAY_PROPS: PropColors = {
  water: PAL.cyan, water2: PAL.blue, ripple: PAL.white, rim: PAL.white, flamingo: PAL.coral, flamingo2: PAL.orchid,
  trunk: PAL.tan, trunk2: PAL.umber, frond: PAL.green, frond2: PAL.forest, rimLight: PAL.green,
  pole: PAL.slate, neonA: PAL.orchid, neonB: PAL.cyan,
  lounger: PAL.white, cushion: PAL.coral, cushion2: PAL.white,
  board1: PAL.cyan, board1s: PAL.orchid, board2: PAL.sand, board2s: PAL.orange,
  car: PAL.coral, car2: PAL.orchid, glass: PAL.cyan, seat: PAL.sand, chrome: PAL.mist, light: PAL.yellow,
  pot: PAL.coral, leaf: PAL.forest, bloom: PAL.orchid,
};

const NIGHT_PROPS: PropColors = {
  water: PAL.cyan, water2: PAL.navy, ripple: PAL.cyan, rim: PAL.dusk, flamingo: PAL.grape, flamingo2: PAL.plum,
  trunk: PAL.night, trunk2: PAL.ink, frond: PAL.dusk, frond2: PAL.night, rimLight: PAL.cyan,
  pole: PAL.night, neonA: PAL.orchid, neonB: PAL.cyan,
  lounger: PAL.night, cushion: PAL.orchid, cushion2: PAL.ink,
  board1: PAL.night, board1s: PAL.cyan, board2: PAL.ink, board2s: PAL.orchid,
  car: PAL.grape, car2: PAL.plum, glass: PAL.navy, seat: PAL.night, chrome: PAL.steel, light: PAL.amber,
  pot: PAL.ink, leaf: PAL.night, bloom: PAL.orchid,
};

function props(P: PropColors): PropSet {
  return {
    // бассейн с надувным фламинго: рябь и фламинго покачиваются
    fountain: () => {
      const fw = 34;
      const fh = 34;
      const { c, g } = canvas(fw * 4, fh);
      for (let f = 0; f < 4; f++) {
        const ox = f * fw;
        ellipse(g, ox + 17, 22, 16, 10, PAL.ink);
        ellipse(g, ox + 17, 22, 15, 9, P.rim);
        ellipse(g, ox + 17, 22, 13, 7, P.water2);
        ellipse(g, ox + 17, 21, 12, 6, P.water);
        for (let k = 0; k < 6; k++) {
          const x = 8 + ((k * 7 + f * 3) % 18);
          const y = 18 + ((k * 3 + f) % 6);
          if (Math.hypot((x - 17) / 12, (y - 21) / 6) < 0.9) px(g, ox + x, y, P.ripple, 2, 1);
        }
        // фламинго: кольцо, шея, голова
        const bob = f % 2;
        const fx = ox + 11 + (f >> 1);
        ellipse(g, fx, 22 + bob, 4, 2, PAL.ink);
        ellipse(g, fx, 22 + bob, 3, 1, P.flamingo);
        px(g, fx - 1, 22 + bob, P.water2, 2, 1);
        px(g, fx + 3, 15 + bob, P.flamingo, 1, 6);
        px(g, fx + 2, 15 + bob, PAL.ink, 1, 6);
        px(g, fx + 3, 14 + bob, P.flamingo2, 2, 1);
        px(g, fx + 5, 14 + bob, PAL.ink, 1, 2);
        // лесенка
        px(g, ox + 26, 15, P.rim, 1, 5);
        px(g, ox + 29, 15, P.rim, 1, 5);
        px(g, ox + 26, 17, P.rim, 4, 1);
      }
      return [c, fw, fh, 4];
    },
    // пальма: изогнутый ствол, веер листьев, кокосы
    tree: () => {
      const { c, g } = canvas(22, 30);
      for (let y = 10; y < 30; y++) {
        const x = 10 + Math.round(Math.sin((y - 10) / 7) * 2);
        px(g, x - 1, y, PAL.ink, 4, 1);
        px(g, x, y, y % 3 === 0 ? P.trunk2 : P.trunk, 2, 1);
      }
      const fronds: [number, number][] = [[-9, 3], [-7, -2], [-2, -6], [4, -6], [8, -2], [9, 4], [0, 4]];
      for (const [dx, dy] of fronds) {
        line(g, 11, 9, 11 + dx, 9 + dy, PAL.ink);
        line(g, 11, 10, 11 + dx, 10 + dy, P.frond2);
        line(g, 11, 9, 11 + dx, 9 + dy - 1, P.frond);
      }
      px(g, 8, 4, P.rimLight, 2, 1);
      px(g, 14, 3, P.rimLight, 2, 1);
      px(g, 10, 10, PAL.umber, 2, 2);
      px(g, 12, 11, PAL.umber, 2, 2);
      return [c, 22, 30, 1];
    },
    // фонарь ар-деко с неоновым кольцом: мигает розовым и бирюзой
    lamp: () => {
      const { c, g } = canvas(18, 26);
      for (let f = 0; f < 2; f++) {
        const ox = f * 9;
        px(g, ox + 3, 7, PAL.ink, 3, 19);
        px(g, ox + 4, 8, P.pole, 1, 17);
        px(g, ox + 2, 24, PAL.ink, 5, 2);
        grid(g, ox + 1, 0, ['.ooooo.', 'onnnnno', 'on...no', 'on...no', 'onnnnno', '.ooooo.', '..ooo..'], {
          o: PAL.ink,
          n: f ? P.neonB : P.neonA,
        });
      }
      return [c, 9, 26, 2];
    },
    // шезлонг с полосатым матрасом и полотенцем
    benchH: () => {
      const { c, g } = canvas(22, 10);
      px(g, 0, 2, PAL.ink, 22, 7);
      px(g, 1, 3, P.lounger, 20, 5);
      for (let x = 2; x < 20; x += 4) px(g, x, 4, P.cushion, 2, 3);
      px(g, 1, 3, P.cushion2, 5, 4);
      px(g, 1, 8, PAL.ink, 2, 2);
      px(g, 19, 8, PAL.ink, 2, 2);
      return [c, 22, 10, 1];
    },
    // доски для сёрфинга у стойки
    benchV: () => {
      const { c, g } = canvas(9, 24);
      const board = (x: number, y: number, col: string, stripe: string) => {
        ellipse(g, x, y + 10, 2, 10, PAL.ink);
        ellipse(g, x, y + 10, 1, 9, col);
        px(g, x, y + 2, stripe, 1, 17);
      };
      board(2, 2, P.board1, P.board1s);
      board(6, 0, P.board2, P.board2s);
      return [c, 9, 24, 1];
    },
    // кабриолет сверху (нос вправо): скруглённый кузов, капот, лобовое, бежевый салон, руль
    stall: () => {
      const { c, g } = canvas(34, 30);
      const body = (x: number, y: number, w: number, h: number, col: string) => {
        px(g, x + 2, y, col, w - 4, h);
        px(g, x + 1, y + 1, col, w - 2, h - 2);
        px(g, x, y + 2, col, w, h - 4);
      };
      for (const [wx, wy] of [[5, 7], [24, 7], [5, 25], [24, 25]]) px(g, wx, wy, PAL.ink, 6, 3); // колёса
      body(0, 9, 34, 17, PAL.ink);
      body(1, 10, 32, 15, P.car);
      px(g, 3, 10, P.car2, 28, 1);
      px(g, 3, 24, P.car2, 28, 1);
      px(g, 26, 13, P.car2, 6, 1); // линии капота
      px(g, 26, 21, P.car2, 6, 1);
      body(9, 12, 15, 11, PAL.ink); // салон
      px(g, 10, 13, P.seat, 13, 9);
      px(g, 11, 14, P.car2, 4, 3); // сиденья: задний диван и два передних
      px(g, 11, 18, P.car2, 4, 3);
      px(g, 17, 14, P.car2, 3, 3);
      px(g, 17, 18, P.car2, 3, 3);
      px(g, 21, 14, PAL.ink, 1, 3); // руль
      px(g, 23, 12, P.glass, 2, 11); // лобовое
      px(g, 23, 12, PAL.white, 1, 2);
      px(g, 33, 12, P.light, 1, 2); // фары и стопы
      px(g, 33, 21, P.light, 1, 2);
      px(g, 0, 12, PAL.red, 1, 2);
      px(g, 0, 21, PAL.red, 1, 2);
      return [c, 34, 30, 1];
    },
    // вазон с гибискусом
    planter: () => {
      const { c, g } = canvas(32, 13);
      px(g, 0, 5, PAL.ink, 32, 8);
      px(g, 1, 6, P.pot, 30, 6);
      px(g, 1, 6, PAL.white, 30, 1);
      px(g, 2, 2, P.leaf, 28, 4);
      for (let x = 3; x < 29; x += 4) {
        px(g, x, 1 + (x % 3 === 0 ? 1 : 0), P.bloom, 2, 2);
        px(g, x + 1, 2, PAL.yellow, 1, 1);
      }
      return [c, 32, 13, 1];
    },
  };
}

const DAY_SET = props(DAY_PROPS);
const NIGHT_SET = props(NIGHT_PROPS);

// ═════════════ музыка ═════════════

/**
 * Своя песня, 118 BPM.
 * День — синт-поп 80-х: A — F#m — D — E, бас октавами восьмыми, хлёсткий малый, синт-аккорды
 * на слабые доли, колокольчики-мелодия со второй четвёрки.
 * Ночь — тёмный синти: F#m — D — Bm — C#, прямая бочка, бас шестнадцатыми с «качелями» (тише на
 * бочке), арпеджио с эхом-шлейфом, мелодия с эхом; по частям (такты от заката, круг 16):
 * вступление (бочка и бас) → + арпеджио → + мелодия → брейк без бочки со сбивкой.
 */
const DAY_ROOTS = [45, 42, 38, 40];
const DAY_TRIADS = [[0, 4, 7], [0, 3, 7], [0, 4, 7], [0, 4, 7]];
const DAY_MEL_AT = [0, 4, 6, 10, 12];
const DAY_MEL = [
  [76, 78, 81, 78, 76],
  [73, 76, 78, 76, 73],
  [74, 78, 81, 83, 81],
  [80, 78, 76, 73, 76],
];
const NIGHT_ROOTS = [42, 38, 35, 37];
const NIGHT_TRIADS = [[0, 3, 7], [0, 4, 7], [0, 3, 7], [0, 4, 7]];
const NIGHT_MEL_AT = [0, 6, 8, 14];
const NIGHT_MEL = [
  [78, 76, 73, 76],
  [74, 73, 69, 73],
  [74, 76, 78, 81],
  [80, 77, 73, 80],
];

function melody(at: number[], mel: number[][], ch: number, s: number): [number, number] | null {
  const k = at.indexOf(s);
  return k < 0 ? null : [mel[ch][k], (at[k + 1] ?? 16) - s];
}

const song: Song = {
  step(a: SongApi, st: SongStep) {
    const { s16: s, bar, t, dt, intensity: I, twist } = st;
    const ch = bar % 4;
    if (!twist) {
      // ── день: синт-поп ──
      const root = DAY_ROOTS[ch];
      if (s % 2 === 0) a.voice('sawtooth', root + (s % 4 === 2 ? 12 : 0), t, dt * 1.5, 0.1);
      if (s === 0 || s === 8 || (I >= 1 && s === 10)) a.kick(t, 0.28, 140);
      if (s === 4 || s === 12) {
        a.hit(0.18, 0.2, 1600, t); // хлёсткий малый
        a.hit(0.3, 0.05, 5000, t);
      }
      if (s % 2 === 0) a.hit(0.03, 0.04, 7500, t);
      if (I >= 2 && s % 2 === 1) a.hit(0.02, 0.025, 8500, t);
      if (s % 4 === 2) for (const iv of DAY_TRIADS[ch]) a.voice('pulse', root + 24 + iv, t, dt * 1.2, 0.025);
      const m = bar % 8 >= 4 ? melody(DAY_MEL_AT, DAY_MEL, ch, s) : null;
      if (m) {
        a.voice('sine', m[0], t, dt * m[1] * 0.9, 0.07);
        a.voice('square', m[0] + 12, t, dt * 0.8, 0.02); // «колокольчик»
      }
      if (bar % 4 === 3 && s >= 12) a.kick(t, 0.2, 220 - (s - 12) * 25); // томы
      return;
    }
    // ── ночь: тёмный синти по частям ──
    const b = st.barsSinceTwist % 16;
    const part = b < 4 ? 'intro' : b < 8 ? 'arp' : b < 14 ? 'lead' : 'break';
    const root = NIGHT_ROOTS[ch];
    const tri = NIGHT_TRIADS[ch];
    if (st.barsSinceTwist === 0 && s === 0) a.hit(1.2, 0.14, 4500, t);
    if (part !== 'break' && s % 4 === 0) a.kick(t, 0.28, 150);
    // бас шестнадцатыми с «качелями»: на бочке тише
    if (part !== 'break' || s % 4 === 0) a.voice('sawtooth', root + 12, t, dt * 0.8, s % 4 === 0 ? 0.06 : 0.13);
    if (part !== 'intro' && part !== 'break' ? s === 4 || s === 12 : false) a.hit(0.35, 0.16, 1400, t);
    if (part !== 'intro' && s % 4 === 2) a.hit(0.09, 0.06, 7000, t);
    if (I >= 1 && s % 2 === 1) a.hit(0.03, 0.03, 8500, t);
    // арпеджио — со второго такта вступления: на телефоне ночь слышна им, а не басом
    if (part !== 'intro' || b >= 2) {
      const n = [0, 1, 2, 1][s % 4];
      a.voice('pulse', root + 24 + tri[n] + (s % 8 >= 4 ? 12 : 0), t, dt * 0.7, part === 'intro' ? 0.05 : 0.07);
    }
    if (part === 'lead' || part === 'break') {
      const m = melody(NIGHT_MEL_AT, NIGHT_MEL, ch, s);
      if (m) a.voice('square', m[0], t, dt * m[1] * 0.85, 0.06);
    }
    if (part === 'break' && b === 15 && s >= 8) a.hit(0.05, 0.06 + (s - 8) * 0.012, 1400, t);
  },
};

// ═════════════ пакет ═════════════

const pack: ThemePack = {
  looks: [
    {
      chars: TOURISTS[0],
      variants: TOURISTS.slice(1),
      ground: ground(DAY_GROUND),
      prop: (kind) => DAY_SET[kind]?.() ?? null,
      // розовая штукатурка с белым карнизом
      wall: () => tile(['wwwwwwww', 'pppppppp', 'ppqppppq', 'pppppppp', 'pqppqppp', 'pppppppp', 'ppppppqp', 'qqqqqqqq'], { w: PAL.white, p: PAL.coral, q: PAL.orchid }),
      // чайка
      critter: (pf) => critterSheet(pf, { o: PAL.ink, b: PAL.white, h: PAL.mist, w: PAL.slate, y: PAL.amber }),
      poses: DAY_POSES,
      acts: DAY_ACTS,
      icons: DAY_ICONS,
    },
    {
      chars: MASKED[0],
      variants: MASKED.slice(1),
      ground: ground(NIGHT_GROUND),
      prop: (kind) => NIGHT_SET[kind]?.() ?? null,
      // тёмная стена с неоновой полосой
      wall: () => tile(['nnnnnnnn', 'iiiiiiii', 'iiinniii', 'mmmmmmmm', 'iiiiiiii', 'iniiiini', 'iiiiiiii', 'cccccccc'], { n: PAL.night, i: PAL.ink, m: PAL.orchid, c: PAL.cyan }),
      // летучая мышь
      critter: (pf) => critterSheet(pf, { o: PAL.ink, b: PAL.grape, h: PAL.plum, w: PAL.night, y: PAL.magenta }),
      poses: NIGHT_POSES,
      acts: NIGHT_ACTS,
      icons: NIGHT_ICONS,
      pulse: { colors: [PAL.orchid, PAL.cyan], ms: Math.round(60000 / 118), alpha: 0.1 },
      // ночью выбивают по-взрослому: бита, труба, нож, брызги и тело на полу (не в детском режиме)
      kill: 'weapon',
    },
  ],
  dressUp: { to: 1, look: { chars: UNMASKED[0], variants: UNMASKED.slice(1), poses: MASKING_POSES }, poses: [0, 1], ms: 230 },
  // bass: 'sawtooth' — бас без эха; всё остальное (колокольчики, арпеджио, мелодия) тянет эхо-шлейф
  music: { flavor: { transpose: 0, bpm: 118, swing: 0, lead: 'square', bass: 'sawtooth', arp: false, echo: true }, song },
  transition: 'dusk',
  starSiren: true,
};

export default pack;
