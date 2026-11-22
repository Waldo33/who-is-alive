import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas, dither, ellipse, grid, outlineOf, px } from './pixels';
import type { Ctx } from './pixels';
import { BASE_MAP } from './themes/base';
import type { Arms, CharStyle, Face, Legs, Look, Pose, View } from './themes/types';

/**
 * Процедурные заглушки ассетов (раздел 9). Размеры и имена кадров совпадают с таблицей ассетов,
 * поэтому финальный арт из Aseprite заменит их без правок кода игры.
 */

export const CH_W = 12;
export const CH_H = 16;
export const OL_W = 14;
export const OL_H = 18;

export const F = {
  D: 0,
  U: 6,
  S: 12,
  FREEZE: 18,
  WAVE: 19,
  STARTLE: 22,
  DANCE: 24,
  STUN: 28,
  JUMP: 29,
  /** Бой с тенью (эмоция изнанки): стойка и удар, вид сбоку. */
  GUARD: 30,
  JAB: 31,
  COUNT: 32,
} as const;


interface FrameSpec {
  view: View;
  legs?: Legs;
  arms?: Arms;
  face?: Face;
  sweat?: boolean;
  shift?: number;
}

const HEAD: Record<View, string[]> = {
  D: [
    '...oooooo...',
    '..ohhhhkho..',
    '.ohhhhhhkho.',
    '.oHHHHHHHHo.',
    '.osssssssso.',
    '.osesssseso.',
    '.osesssseso.',
    '.ocssmmssco.',
    '..oSssssSo..',
  ],
  U: [
    '...oooooo...',
    '..ohhhhkho..',
    '.ohhhhhhkho.',
    '.oHHHHHHHHo.',
    '.orrrrrrrro.',
    '.orrrrrrrro.',
    '.orrrrrrrro.',
    '.oRrrrrrrRo.',
    '..oRRRRRRo..',
  ],
  S: [
    '...oooooo...',
    '..ohhhhkho..',
    '.ohhhhhhhko.',
    '.oHHHHHHHHHo',
    '.orrsssssso.',
    '.orssssseso.',
    '.orssssseso.',
    '.orssssmsco.',
    '..oRSsssSo..',
  ],
};

const BODY: Record<View, string[]> = {
  D: ['..obbbbbbo..', '.oabvvvvbao.', '.oaBvvvvBao.', '..oBBBBBBo..'],
  U: ['..obbbbbbo..', '.oabbbbbbao.', '.oaBbbbbBao.', '..oBBBBBBo..'],
  S: ['..obbbbbbo..', '..obbbbabo..', '..oBbbbbBo..', '..oBBBBBBo..'],
};

const LEGS: Record<Legs, string[]> = {
  idle: ['..ollLLllo..', '..olloollo..', '...oo..oo...'],
  liftL: ['..ollLLllo..', '...oo.ollo..', '.......oo...'],
  liftR: ['..ollLLllo..', '..ollo.oo...', '...oo.......'],
};

/** Кепки в парке — облик по умолчанию: чего тема не задала, берётся отсюда. */
export const PARK_CHARS: CharStyle = {
  map: {
    ...BASE_MAP,
    h: PAL.blue, H: PAL.navy, k: PAL.cyan, r: PAL.umber, R: PAL.plum,
    s: PAL.peach, S: PAL.fawn, a: PAL.peach, m: PAL.fawn,
    b: PAL.orange, B: PAL.rust, v: PAL.orange, l: PAL.dusk, L: PAL.night,
  },
};

function buildMatrix(spec: FrameSpec): string[][] {
  const rows = [...HEAD[spec.view], ...BODY[spec.view], ...LEGS[spec.legs ?? 'idle']];
  const m = rows.map((r) => r.split(''));
  const set = (x: number, y: number, ch: string) => {
    if (x >= 0 && x < CH_W && y >= 0 && y < CH_H) m[y][x] = ch;
  };
  const face = spec.face ?? 'normal';
  if (spec.view === 'D') {
    if (face === 'blink') {
      set(3, 5, 's'); set(8, 5, 's'); set(3, 6, 'S'); set(8, 6, 'S');
    } else if (face === 'wide') {
      set(3, 5, 'w'); set(8, 5, 'w'); set(5, 7, 'o'); set(6, 7, 'o');
    } else if (face === 'dizzy') {
      set(3, 5, 'e'); set(3, 6, 's'); set(4, 6, 'e'); set(8, 5, 'e'); set(8, 6, 's'); set(7, 6, 'e');
    } else if (face === 'happy') {
      set(3, 6, 's'); set(8, 6, 's'); set(2, 6, 'e'); set(9, 6, 'e');
    }
  } else if (spec.view === 'S' && face === 'blink') {
    set(8, 5, 's'); set(8, 6, 'S');
  }
  const arms = spec.arms ?? 'down';
  const leftUp = arms === 'up' || arms === 'leftUp';
  const rightUp = arms === 'up' || arms === 'rightUp' || arms === 'waveA' || arms === 'waveB';
  if (spec.view === 'D') {
    if (leftUp) {
      set(2, 10, 'b'); set(2, 11, 'B');
      set(0, 6, 'a'); set(0, 7, 'a'); set(0, 8, 'b'); set(0, 9, 'b');
    }
    if (rightUp) {
      set(9, 10, 'b'); set(9, 11, 'B');
      if (arms === 'waveB') {
        set(11, 4, 'a'); set(11, 5, 'a'); set(11, 6, 'b'); set(11, 7, 'b'); set(11, 8, 'b');
      } else {
        set(11, 6, 'a'); set(11, 7, 'a'); set(11, 8, 'b'); set(11, 9, 'b');
      }
    }
  }
  if (spec.view === 'S' && arms === 'guard') {
    // кулак у подбородка
    set(9, 8, 'a'); set(9, 9, 'b'); set(8, 9, 'b');
  } else if (spec.view === 'S' && arms === 'jab') {
    // рука вперёд до упора
    set(9, 10, 'b'); set(10, 10, 'b'); set(11, 10, 'a'); set(11, 9, 'a');
  }
  if (spec.sweat) {
    set(11, 2, 'd'); set(11, 3, 'd');
  }
  return m;
}

/** Сдвиг кадра (танец) — после правок темы, чтобы колпак или шлем ехали вместе с головой. */
function applyShift(m: string[][], shift: number): void {
  for (const row of m) {
    if (shift > 0) {
      row.unshift(...Array(shift).fill('.'));
      row.splice(CH_W);
    } else {
      row.splice(0, -shift);
      row.push(...Array(-shift).fill('.'));
    }
  }
}

const FRAMES: FrameSpec[] = (() => {
  const out: FrameSpec[] = [];
  for (const view of ['D', 'U', 'S'] as View[]) {
    out.push({ view }, { view, face: 'blink' });
    out.push({ view, legs: 'idle' }, { view, legs: 'liftL' }, { view, legs: 'idle' }, { view, legs: 'liftR' });
  }
  out.push({ view: 'D', arms: 'up' }); // FREEZE «статуя»
  out.push({ view: 'D', arms: 'waveA' }, { view: 'D', arms: 'waveB' }, { view: 'D', arms: 'waveA', face: 'happy' });
  out.push({ view: 'D', face: 'wide' }, { view: 'D', face: 'wide', sweat: true });
  out.push(
    { view: 'D', arms: 'leftUp', legs: 'liftR', face: 'happy', shift: -1 },
    { view: 'D', arms: 'down', face: 'happy' },
    { view: 'D', arms: 'rightUp', legs: 'liftL', face: 'happy', shift: 1 },
    { view: 'D', arms: 'up', face: 'happy' },
  );
  out.push({ view: 'D', face: 'dizzy' });
  out.push({ view: 'D', arms: 'up', face: 'happy', legs: 'liftL' });
  out.push({ view: 'S', arms: 'guard', legs: 'liftL' }, { view: 'S', arms: 'jab', legs: 'liftR' });
  return out;
})();

export interface CharSheets {
  body: HTMLCanvasElement;
  outline: HTMLCanvasElement;
}

/** Лента персонажа: общие кадры F, затем свои позы темы (F.COUNT + i) — их правки поверх костюма. */
export function makeCharacterSheets(theme: CharStyle, poses: Pose[] = []): CharSheets {
  const all: (FrameSpec & { pose?: Pose['patch'] })[] = [...FRAMES, ...poses.map((p) => ({ ...p, pose: p.patch }))];
  const body = canvas(CH_W * all.length, CH_H);
  const outline = canvas(OL_W * all.length, OL_H);
  all.forEach((spec, i) => {
    const m = buildMatrix(spec);
    theme.patch?.(m, spec.view);
    spec.pose?.(m);
    if (spec.shift) applyShift(m, spec.shift);
    const one = canvas(CH_W, CH_H);
    grid(one.g, 0, 0, m.map((r) => r.join('')), theme.map);
    body.g.drawImage(one.c, i * CH_W, 0);
    outlineOf(one.g, CH_W, CH_H, outline.g, i * OL_W, 0, PAL.white);
  });
  return { body: body.c, outline: outline.c };
}

// ───────────── мелкие спрайты ─────────────

export function makeShadow(): HTMLCanvasElement {
  const { c, g } = canvas(10, 4);
  g.globalAlpha = 0.35;
  ellipse(g, 5, 2, 4, 1, PAL.ink);
  return c;
}

export function makeRing(): HTMLCanvasElement {
  // кольцо под своим персонажем: 2 пикселя толщиной, белое (тонируется цветом игрока),
  // с контуром ink снаружи и внутри — читается на кирпиче парка и на светлой льдине
  const { c, g } = canvas(21, 11);
  for (let a = 0; a < Math.PI * 2; a += 0.03) {
    px(g, Math.round(10 + Math.cos(a) * 10), Math.round(5 + Math.sin(a) * 5), PAL.ink);
    px(g, Math.round(10 + Math.cos(a) * 7), Math.round(5 + Math.sin(a) * 2), PAL.ink);
  }
  for (let a = 0; a < Math.PI * 2; a += 0.03) {
    px(g, Math.round(10 + Math.cos(a) * 9), Math.round(5 + Math.sin(a) * 4), PAL.white);
    px(g, Math.round(10 + Math.cos(a) * 8), Math.round(5 + Math.sin(a) * 3), PAL.white);
  }
  return c;
}

export function makeArrow(color: string = PAL.white): HTMLCanvasElement {
  // стрелка «это ты» над головой: крупная, контур ink, кромка цветом игрока и белая сердцевина —
  // жёлтая на светлой льдине и красная на кирпиче больше не теряются (не тонируется)
  const { c, g } = canvas(11, 9);
  grid(g, 0, 0, ['ooooooooooo', 'occcccccccc'.slice(0, 10) + 'o', 'occwwwwwcco', '.occwwwcco.', '..occwcco..', '...occco...', '....oco....', '.....o.....', '...........'], { o: PAL.ink, w: PAL.white, c: color });
  return c;
}

export function makeStar(): HTMLCanvasElement {
  const { c, g } = canvas(40, 10);
  const shape = [
    '....oo....',
    '....oyo...',
    '...oyyo...',
    'ooooyyyooo',
    'oyyyywyyyo',
    '.oyyyyyyo.',
    '..oyyyyo..',
    '.oyyooyyo.',
    '.oyo..oyo.',
    '.oo....oo.',
  ];
  for (let f = 0; f < 4; f++) {
    // контур ink (был umber): звезда не тонет в снегу льдины и в конфетти корпоратива
    grid(g, f * 10, 0, shape, { o: PAL.ink, y: f % 2 ? PAL.amber : PAL.yellow, w: PAL.white });
    const sp = [[2, 1], [8, 2], [8, 8], [1, 7]][f];
    px(g, f * 10 + sp[0], sp[1], PAL.white);
  }
  return c;
}

export function makeStarFlash(): HTMLCanvasElement {
  const { c, g } = canvas(64, 16);
  for (let f = 0; f < 4; f++) {
    const r = 2 + f * 2;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      px(g, f * 16 + 8 + Math.round(Math.cos(ang) * r), 8 + Math.round(Math.sin(ang) * r), f < 2 ? PAL.white : PAL.yellow);
    }
  }
  return c;
}

export function makePoof(): HTMLCanvasElement {
  const { c, g } = canvas(24 * 6, 24);
  const parts = Array.from({ length: 22 }, (_, i) => {
    const ang = (i / 22) * Math.PI * 2 + (i % 3) * 0.3;
    return { ang, sp: 1.6 + (i % 5) * 0.55, col: [PAL.white, PAL.mist, PAL.sand, PAL.peach, PAL.orange][i % 5] };
  });
  for (let f = 0; f < 6; f++) {
    if (f === 0) ellipse(g, 12, 12, 5, 5, PAL.white);
    for (const p of parts) {
      const d = p.sp * (f + 1);
      const sz = f < 3 ? 2 : 1;
      if (f >= 4 && (p.sp * 10) % 2 < 1) continue;
      px(g, f * 24 + 12 + Math.cos(p.ang) * d, 12 + Math.sin(p.ang) * d * 0.8, p.col, sz, sz);
    }
  }
  return c;
}

export function makeStunStars(): HTMLCanvasElement {
  const { c, g } = canvas(36, 5);
  for (let f = 0; f < 3; f++) {
    for (let k = 0; k < 2; k++) {
      const ang = (f / 3) * Math.PI * 2 + k * Math.PI;
      const x = f * 12 + 6 + Math.round(Math.cos(ang) * 4);
      const y = 2 + Math.round(Math.sin(ang) * 1.5);
      px(g, x, y, PAL.yellow);
      px(g, x - 1, y, PAL.amber);
    }
  }
  return c;
}

export function makeMark(ch: '!' | '?'): HTMLCanvasElement {
  const { c, g } = canvas(5, 8);
  const rows = ch === '!' ? ['.ooo.', '.oyo.', '.oyo.', '.oyo.', '.ooo.', '.ooo.', '.oyo.', '.ooo.'] : ['ooooo', 'oyyyo', 'oooyo', '.oyyo', '.oyoo', '.ooo.', '.oyo.', '.ooo.'];
  grid(g, 0, 0, rows, { o: PAL.ink, y: ch === '!' ? PAL.red : PAL.mist });
  return c;
}

export function makeIcons(): { canvas: HTMLCanvasElement; names: string[] } {
  const W = PAL.white;
  const icons: Record<string, string[]> = {
    fist: ['.oooooo.', 'owwwwwwo', 'owmwmwmo', 'owwwwwwo', 'oowwwwwo', '.owwwwo.', '.owwwwo.', '..oooo..'],
    fistOff: ['.oooooo.', 'oddddddo', 'odndndno', 'oddddddo', 'ooddddd o'.replace(' ', ''), '.oddddo.', '.oddddo.', '..oooo..'],
    star: ['...oo...', '...oy o.'.replace(' ', ''), 'oooyyooo', 'oyyyyyyo', '.oyyyyo.', '.oyooyo.', '.oo..oo.', '........'],
    soundOn: ['...o..o.', '..oo.o.o', 'ooww..o.', 'owww.o.o', 'owww.o.o', 'ooww..o.', '..oo.o.o', '...o..o.'],
    soundOff: ['...o....', '..oo....', 'ooww.o.o', 'owww..o.', 'owww..o.', 'ooww.o.o', '..oo....', '...o....'],
    robot: ['...oo...', '.oooooo.', 'owwwwwwo', 'owowwowo', 'owwwwwwo', 'owmmmmwo', '.oooooo.', '.o.oo.o.'],
    smile: ['..oooo..', '.owwwwo.', 'owowwowo', 'owwwwwwo', 'owowwowo', 'owwoowwo', '.owwwwo.', '..oooo..'],
    hand: ['..o.o...', '.owowoo.', '.owowowo', '.owwwwwo', 'oowwwwwo', 'owwwwwo.', '.owwwo..', '..ooo...'],
    jump: ['...oo...', '..owwo..', '.owwwwo.', 'owwwwwwo', 'ooowwooo', '..owwo..', '..owwo..', '..oooo..'],
    dance: ['...oooo.', '...owwo.', '...oo.o.', '...o..o.', '.ooo.oo.', 'owwo.oo.', 'owwo....', '.oo.....'],
    check: ['......oo', '.....owo', 'oo..owo.', 'owo.owo.', '.owowo..', '..owo...', '...o....', '........'],
    cross: ['oo....oo', 'owo..owo', '.owoowo.', '..owwo..', '..owwo..', '.owoowo.', 'owo..owo', 'oo....oo'],
    gear: ['...mm...', '.m.mm.m.', '..mmmm..', 'mmm..mmm', 'mmm..mmm', '..mmmm..', '.m.mm.m.', '...mm...'],
    crown: ['o..o..o.', 'oyoyoyo.', 'oyyyyyo.', 'oyyyyyo.', 'oyryryo.', 'ooooooo.', '........', '........'],
    // «Толпа решает»: жест не назван
    question: ['.oooooo.', 'oyyyyyyo', 'oyooooyo', 'ooo.oyyo', '...oyyo.', '...oyo..', '...ooo..', '...oyo..'],
  };
  const names = Object.keys(icons);
  const { c, g } = canvas(names.length * 8, 8);
  names.forEach((n, i) => {
    const rows = icons[n].map((r) => (r + '........').slice(0, 8));
    const map: Record<string, string> = { o: PAL.ink, w: W, m: PAL.mist, d: PAL.steel, n: PAL.dusk, y: PAL.yellow, r: PAL.red };
    if (n === 'check') map.w = PAL.green;
    if (n === 'cross') map.w = PAL.red;
    grid(g, i * 8, 0, rows, map);
  });
  return { canvas: c, names };
}

const PIGEON_FRAMES = [
  ['......', '..oo..', '.ohyo.', 'obbbo.', 'obwbo.', '.o.o..'],
  ['......', '......', '..oo..', 'oohyo.', 'obwbo.', '.o.o..'],
  ['o....o', 'wo..ow', '.whhw.', '.obbo.', '..oo..', '......'],
  ['......', '......', 'oohhoo', 'wwbbww', '..oo..', '......'],
  ['......', '..hh..', '.obbo.', 'ow..wo', 'o....o', '......'],
  ['......', '......', 'oohhoo', 'wwbbww', '..oo..', '......'],
];

/** Зверёк локации (6 кадров 6×6): голубь в парке, мышь на кухне, чайка на льдине, дрон на луне. */
export function makePigeon(look?: Look): HTMLCanvasElement {
  if (look?.critter) return look.critter(PIGEON_FRAMES);
  const { c, g } = canvas(36, 6);
  const map = { o: PAL.ink, b: PAL.slate, h: PAL.steel, w: PAL.mist, y: PAL.amber };
  PIGEON_FRAMES.forEach((f, i) => grid(g, i * 6, 0, f, map));
  return c;
}

/** Стенка сужающейся зоны (плитка 8×8): живая изгородь в парке, ящики, лёд, камни. */
export function makeHedge(look?: Look): HTMLCanvasElement {
  if (look?.wall) return look.wall();
  const { c, g } = canvas(8, 8);
  px(g, 0, 0, PAL.pine, 8, 8);
  const leaves = ['.gG..gG.', 'gGGggGGg', 'GGfGGGfG', '.gG.fgG.', 'gGGgGGg.', 'GfGGGfGG', '.gGg.gGg', 'gG.fgG.f'];
  grid(g, 0, 0, leaves, { g: PAL.green, G: PAL.forest, f: PAL.deep });
  return c;
}

export function makeVignette(w: number, h: number): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (d < 3 || (d < 7 && (x + y) % 2 === 0) || (d < 12 && (x % 2 === 0 && y % 2 === 0))) px(g, x, y, PAL.ink);
    }
  }
  return c;
}

// ───────────── арена ─────────────

function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Земля арены: облик темы (themes/) или парк. */
export function makeArenaBackground(arena: ArenaDef, look?: Look): HTMLCanvasElement {
  if (look?.ground) return look.ground(arena);
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // брусчатка
  for (let y = 0; y < h; y += 4) {
    const off = (y / 4) % 2 ? 4 : 0;
    for (let x = -off; x < w; x += 8) {
      const v = hash(x, y);
      const col = v < 0.15 ? PAL.fawn : v < 0.8 ? PAL.brick : PAL.clay;
      px(g, x, y, col, 8, 4);
      px(g, x, y, PAL.umber, 8, 1);
      px(g, x, y, PAL.umber, 1, 4);
      if (v > 0.5) px(g, x + 2, y + 1, PAL.tan);
    }
  }
  // светлая мозаика вокруг фонтана
  const cx = w / 2;
  const cy = 132;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot((x - cx) / 1.15, y - cy);
      if (d < 40 && d > 37) px(g, x, y, PAL.umber);
      else if (d <= 37) {
        const ring = Math.floor(d / 6) % 2;
        px(g, x, y, ring ? PAL.tan : PAL.sand);
        if ((x + y) % 7 === 0) px(g, x, y, PAL.fawn);
      }
    }
  }
  // трава по краям, бордюр
  const grass = (x0: number, y0: number, gw: number, gh: number) => {
    px(g, x0, y0, PAL.forest, gw, gh);
    for (let y = y0; y < y0 + gh; y++) for (let x = x0; x < x0 + gw; x++) {
      const v = hash(x * 3, y * 7);
      if (v < 0.25) px(g, x, y, PAL.green);
      else if (v > 0.9) px(g, x, y, PAL.pine);
      else if (v > 0.985) px(g, x, y, PAL.yellow);
    }
  };
  grass(0, 0, w, 12);
  grass(0, 0, 4, h);
  grass(w - 4, 0, 4, h);
  grass(0, h - 3, w, 3);
  px(g, 4, 12, PAL.mist, w - 8, 1);
  px(g, 4, 13, PAL.slate, w - 8, 1);
  px(g, 4, 12, PAL.mist, 1, h - 15);
  px(g, w - 5, 12, PAL.mist, 1, h - 15);
  // цветы на верхней траве
  for (let x = 6; x < w - 6; x += 5) {
    const v = hash(x, 99);
    if (v < 0.55) px(g, x, 3 + Math.floor(v * 10) % 6, [PAL.red, PAL.yellow, PAL.white, PAL.coral][Math.floor(v * 40) % 4]);
  }
  // тёплые пятна света от фонарей
  for (const p of arena.props) {
    if (p.kind !== 'lamp') continue;
    for (let y = -10; y <= 10; y++) for (let x = -16; x <= 16; x++) {
      const d = Math.hypot(x / 1.6, y);
      if (d > 10) continue;
      const k = d < 4 ? 2 : d < 7 ? 4 : 6;
      if ((x + 2 * y) % k === 0 && y % 2 === 0) px(g, p.x + x, p.y + 2 + y, d < 4 ? PAL.amber : PAL.tan);
    }
  }
  return c;
}

/** Пропсы: кадры по горизонтали. Возвращает [canvas, frameW, frameH, frames]. */
export function makeProp(kind: string, look?: Look): [HTMLCanvasElement, number, number, number] {
  const loc = look?.prop?.(kind);
  if (loc) return loc;
  switch (kind) {
    case 'fountain': {
      const fw = 34;
      const fh = 34;
      const { c, g } = canvas(fw * 4, fh);
      for (let f = 0; f < 4; f++) {
        const ox = f * fw;
        ellipse(g, ox + 17, 22, 16, 10, PAL.ink);
        ellipse(g, ox + 17, 22, 15, 9, PAL.slate);
        ellipse(g, ox + 17, 21, 15, 8, PAL.mist);
        ellipse(g, ox + 17, 21, 12, 6, PAL.navy);
        ellipse(g, ox + 17, 21, 11, 5, PAL.blue);
        for (let k = 0; k < 7; k++) {
          const ang = k + f * 0.7;
          px(g, ox + 17 + Math.round(Math.cos(ang) * 8), 21 + Math.round(Math.sin(ang) * 3.5), PAL.cyan);
        }
        px(g, ox + 15, 9, PAL.ink, 5, 13);
        px(g, ox + 16, 10, PAL.mist, 3, 12);
        px(g, ox + 16, 10, PAL.white, 1, 12);
        ellipse(g, ox + 17, 9, 5, 2, PAL.ink);
        ellipse(g, ox + 17, 9, 4, 1, PAL.slate);
        // струи
        for (let k = 0; k < 6; k++) {
          const t = ((k * 5 + f * 2) % 10) / 10;
          const dx = (k % 2 ? 1 : -1) * Math.round(t * 7);
          const dy = Math.round(-3 + t * t * 12);
          px(g, ox + 17 + dx, 6 + dy, t < 0.5 ? PAL.white : PAL.cyan);
        }
        px(g, ox + 17, 3 + (f % 2), PAL.white);
      }
      return [c, fw, fh, 4];
    }
    case 'tree': {
      const { c, g } = canvas(22, 30);
      px(g, 9, 20, PAL.ink, 5, 10);
      px(g, 10, 20, PAL.umber, 3, 10);
      px(g, 10, 20, PAL.brick, 1, 10);
      ellipse(g, 11, 11, 10, 9, PAL.ink);
      ellipse(g, 11, 11, 9, 8, PAL.pine);
      ellipse(g, 9, 9, 6, 5, PAL.forest);
      ellipse(g, 8, 7, 3, 2, PAL.green);
      dither(g, 3, 14, 16, 4, PAL.deep, 1);
      px(g, 14, 6, PAL.amber);
      return [c, 22, 30, 1];
    }
    case 'lamp': {
      const { c, g } = canvas(18, 26);
      for (let f = 0; f < 2; f++) {
        const ox = f * 9;
        px(g, ox + 3, 6, PAL.ink, 3, 20);
        px(g, ox + 4, 7, PAL.dusk, 1, 18);
        px(g, ox + 2, 24, PAL.ink, 5, 2);
        grid(g, ox + 1, 0, ['.ooooo.', 'oyyyyyo', 'oywyyyo', 'oyyyyyo', '.ooooo.', '..ooo..'], {
          o: PAL.ink,
          y: f ? PAL.amber : PAL.yellow,
          w: PAL.white,
        });
      }
      return [c, 9, 26, 2];
    }
    case 'benchH': {
      const { c, g } = canvas(22, 10);
      px(g, 0, 1, PAL.ink, 22, 7);
      px(g, 1, 2, PAL.brick, 20, 2);
      px(g, 1, 5, PAL.brick, 20, 2);
      px(g, 1, 2, PAL.tan, 20, 1);
      px(g, 1, 5, PAL.tan, 20, 1);
      px(g, 2, 8, PAL.ink, 2, 2);
      px(g, 18, 8, PAL.ink, 2, 2);
      return [c, 22, 10, 1];
    }
    case 'benchV': {
      const { c, g } = canvas(9, 24);
      px(g, 1, 0, PAL.ink, 7, 22);
      px(g, 2, 1, PAL.brick, 2, 20);
      px(g, 5, 1, PAL.brick, 2, 20);
      px(g, 2, 1, PAL.tan, 1, 20);
      px(g, 5, 1, PAL.tan, 1, 20);
      px(g, 1, 22, PAL.ink, 2, 2);
      px(g, 6, 22, PAL.ink, 2, 2);
      return [c, 9, 24, 1];
    }
    case 'stall': {
      const { c, g } = canvas(34, 30);
      px(g, 2, 16, PAL.ink, 30, 14);
      px(g, 3, 17, PAL.umber, 28, 12);
      px(g, 3, 17, PAL.brick, 28, 3);
      px(g, 5, 21, PAL.amber, 4, 3);
      px(g, 11, 21, PAL.red, 4, 3);
      px(g, 17, 21, PAL.green, 4, 3);
      px(g, 23, 21, PAL.yellow, 4, 3);
      px(g, 3, 4, PAL.ink, 2, 13);
      px(g, 29, 4, PAL.ink, 2, 13);
      px(g, 0, 2, PAL.ink, 34, 9);
      for (let x = 1; x < 33; x++) {
        const col = Math.floor((x - 1) / 4) % 2 ? PAL.white : PAL.red;
        px(g, x, 3, col, 1, 6);
      }
      for (let x = 1; x < 33; x += 4) px(g, x + 1, 9, PAL.ink, 2, 2);
      px(g, 1, 3, PAL.white, 32, 1);
      return [c, 34, 30, 1];
    }
    case 'planter':
    default: {
      const { c, g } = canvas(32, 13);
      px(g, 0, 4, PAL.ink, 32, 9);
      px(g, 1, 5, PAL.slate, 30, 7);
      px(g, 1, 5, PAL.mist, 30, 1);
      px(g, 2, 3, PAL.pine, 28, 3);
      for (let x = 2; x < 30; x += 3) {
        const col = [PAL.red, PAL.yellow, PAL.coral, PAL.white][x % 4];
        px(g, x, 1 + (x % 2), col, 2, 2);
        px(g, x, 4, PAL.green, 1, 1);
      }
      return [c, 32, 13, 1];
    }
  }
}

export type { Ctx };

/** Цвета букв иконок 8×8 (общие и иконки тем). */
export const ICON_MAP: Record<string, string> = {
  o: PAL.ink, w: PAL.white, m: PAL.mist, d: PAL.steel, n: PAL.dusk, y: PAL.yellow, r: PAL.red,
  b: PAL.blue, g: PAL.green, u: PAL.umber, f: PAL.orange, a: PAL.amber, s: PAL.peach,
};

/** Лист иконок 8×8 из строк (иконки команд темы). */
export function makeIconSheet(list: string[][]): HTMLCanvasElement {
  const { c, g } = canvas(list.length * 8, 8);
  list.forEach((rows, i) => grid(g, i * 8, 0, rows.map((r) => (r + '........').slice(0, 8)), ICON_MAP));
  return c;
}
