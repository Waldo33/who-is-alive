import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, dither, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import { face, skin } from './people';
import type { CharStyle, Look, Pose, PropSet, ThemePack } from './types';
import { centerDist, hash, tile } from './util';

/**
 * «Казино»: гости в вечернем бродят по залу — ковёр с золотой решёткой, рулетка в центре, бар, пальмы
 * в кадках, бархатные диваны. Вместо жестов толпы — «Крутка»: автомат опускается на экран (game-core ›
 * slots.ts, экран — `slot-ui.ts`). Музыка — лаунж-свинг.
 */

const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};

// ───────────── толпа: смокинги и вечерние платья ─────────────

/** Смокинг: чёрный пиджак, белая манишка, бабочка. */
function tux(i: number, tie: string): CharStyle {
  return {
    map: { ...BASE_MAP, ...face(i), a: PAL.night, b: PAL.night, B: PAL.ink, v: PAL.white, l: PAL.night, L: PAL.ink, q: tie },
    patch: (m, view) => {
      if (view === 'D') {
        set(m, 5, 9, 'q');
        set(m, 6, 9, 'q');
      }
    },
  };
}

/** Вечернее платье: в пол, без рук-рукавов (кожа), блёстка. */
function gown(i: number, c: string, C: string): CharStyle {
  return {
    map: { ...BASE_MAP, ...face(i), a: skin(i), b: c, B: C, v: c, l: c, L: C, g: PAL.yellow },
    patch: (m, view) => {
      // подол до пола вместо ног
      for (const y of [13, 14]) for (let x = 3; x <= 8; x++) if (m[y][x] !== '.') set(m, x, y, y === 14 ? 'B' : 'b');
      if (view === 'D') set(m, 4, 10, 'g');
    },
  };
}

const GUESTS: CharStyle[] = [
  tux(0, PAL.wine),
  gown(1, PAL.orchid, PAL.grape),
  tux(2, PAL.amber),
  gown(3, PAL.navy, PAL.night),
  tux(4, PAL.wine),
];

/** Свои позы: дёрнул воображаемый рычаг, вскинул руки (выигрыш!). */
const POSES: Pose[] = [
  { view: 'D', arms: 'rightUp' },
  { view: 'D', arms: 'down' },
  { view: 'D', arms: 'up', face: 'happy' },
  { view: 'D', arms: 'up', face: 'happy' },
];
const ACTS: Look['acts'] = {
  wave: { poses: [0, 0, 1, 1], ms: 170 }, // рычаг
  jump: { poses: [2, 2, 2], ms: 200, yoff: [-2, -3, -1] }, // выигрыш!
  dance: { poses: [3, 2], ms: 240 },
};

// ───────────── зал ─────────────

function ground(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // ковёр: бордо с дизерингом и золотая ромбовая решётка
  px(g, 0, 0, PAL.wine, w, h);
  dither(g, 0, 0, w, h, PAL.umber, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + y) % 16;
      const v = (x - y + 1600) % 16;
      if (u === 0 || v === 0) px(g, x, y, (x + y) % 2 ? PAL.amber : PAL.brick);
      if (u === 8 && v === 8) px(g, x, y, PAL.yellow);
    }
  }
  // паркет под рулеткой
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 40 && d > 37) px(g, x, y, PAL.amber);
      else if (d <= 37) {
        const row = Math.floor(y / 4);
        const v = hash(row, Math.floor((x + row * 3) / 10));
        px(g, x, y, y % 4 === 0 || (x + row * 3) % 10 === 0 ? PAL.plum : v < 0.3 ? PAL.umber : PAL.brick);
      }
    }
  }
  // стена: тёмное дерево, золотая полоса, лампочки вывески
  px(g, 0, 0, PAL.plum, w, 12);
  for (let x = 0; x < w; x += 6) px(g, x, 0, PAL.umber, 1, 12);
  px(g, 0, 2, PAL.amber, w, 1);
  px(g, 0, 9, PAL.amber, w, 1);
  for (let x = 3; x < w; x += 6) px(g, x, 5, x % 12 === 3 ? PAL.yellow : PAL.orange, 2, 2);
  px(g, 0, 12, PAL.ink, w, 1);
  px(g, 0, 13, PAL.umber, w, 1);
  px(g, 0, 12, PAL.plum, 4, h - 12);
  px(g, w - 4, 12, PAL.plum, 4, h - 12);
  px(g, 3, 12, PAL.amber, 1, h - 15);
  px(g, w - 4, 12, PAL.amber, 1, h - 15);
  px(g, 0, h - 3, PAL.plum, w, 3);
  return c;
}

const PROPS: PropSet = {
  // рулетка: зелёное сукно, колесо крутится кадрами (ставки пока не принимаются)
  fountain: () => {
    const fw = 34;
    const { c, g } = canvas(fw * 4, 34);
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      ellipse(g, ox + 17, 24, 16, 9, PAL.ink);
      ellipse(g, ox + 17, 23, 15, 8, PAL.forest);
      ellipse(g, ox + 17, 22, 15, 7, PAL.green);
      ellipse(g, ox + 17, 21, 10, 5, PAL.ink);
      ellipse(g, ox + 17, 21, 9, 4, PAL.umber);
      // ячейки красное/чёрное бегут по кругу
      for (let k = 0; k < 12; k++) {
        const a = ((k + f * 0.75) / 12) * Math.PI * 2;
        const x = Math.round(ox + 17 + Math.cos(a) * 8);
        const y = Math.round(21 + Math.sin(a) * 3.5);
        px(g, x, y, k % 2 ? PAL.ink : PAL.red);
      }
      ellipse(g, ox + 17, 21, 3, 1, PAL.amber);
      px(g, ox + 17, 19, PAL.yellow, 1, 2);
      // шарик
      const b = ((f * 3) / 12) * Math.PI * 2;
      px(g, Math.round(ox + 17 + Math.cos(b) * 6), Math.round(21 + Math.sin(b) * 2.5), PAL.white);
      // ножки стола
      px(g, ox + 6, 30, PAL.ink, 2, 4);
      px(g, ox + 26, 30, PAL.ink, 2, 4);
    }
    return [c, fw, 34, 4];
  },
  // пальма в золотой кадке
  tree: () => {
    const { c, g } = canvas(22, 30);
    px(g, 6, 22, PAL.ink, 10, 8);
    px(g, 7, 23, PAL.amber, 8, 6);
    px(g, 7, 23, PAL.yellow, 8, 1);
    px(g, 7, 27, PAL.brick, 8, 1);
    for (let y = 9; y < 22; y++) px(g, 10 + (y % 4 === 0 ? 1 : 0), y, y % 2 ? PAL.umber : PAL.brick, 2, 1);
    const leaf = (x0: number, y0: number, dx: number, dy: number) => {
      for (let k = 0; k < 9; k++) {
        const x = x0 + Math.round(dx * k);
        const y = y0 + Math.round(dy * k + (k * k) / 14);
        px(g, x, y, k % 3 ? PAL.forest : PAL.green, 2, 1);
        px(g, x, y + 1, PAL.pine, 1, 1);
      }
    };
    leaf(11, 8, -1.1, -0.6);
    leaf(11, 8, 1.1, -0.6);
    leaf(10, 8, -1, 0.1);
    leaf(12, 8, 1, 0.1);
    leaf(11, 7, 0.1, -0.9);
    return [c, 22, 30, 1];
  },
  // торшер с абажуром, свет мерцает
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      grid(g, ox, 0, ['..ooooo..', '.oyyyyyo.', '.oyyyyyo.', 'oaaaaaaao', 'ooooooooo'], { o: PAL.ink, y: f ? PAL.yellow : PAL.sand, a: PAL.amber });
      px(g, ox + 4, 5, PAL.ink, 1, 19);
      px(g, ox + 4, 5, PAL.amber, 1, 18);
      px(g, ox + 2, 23, PAL.ink, 5, 2);
      px(g, ox + 3, 23, PAL.amber, 3, 1);
    }
    return [c, 9, 26, 2];
  },
  // бархатный диван
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 0, PAL.ink, 22, 9);
    px(g, 1, 1, PAL.grape, 20, 3);
    px(g, 1, 4, PAL.orchid, 20, 3);
    px(g, 1, 4, PAL.coral, 20, 1);
    for (let x = 4; x < 20; x += 5) px(g, x, 2, PAL.ink);
    px(g, 0, 1, PAL.grape, 2, 7);
    px(g, 20, 1, PAL.grape, 2, 7);
    px(g, 2, 9, PAL.amber, 2, 1);
    px(g, 18, 9, PAL.amber, 2, 1);
    return [c, 22, 10, 1];
  },
  benchV: () => {
    const { c, g } = canvas(9, 24);
    px(g, 0, 0, PAL.ink, 9, 23);
    px(g, 1, 1, PAL.grape, 3, 21);
    px(g, 4, 1, PAL.orchid, 4, 21);
    px(g, 4, 1, PAL.coral, 1, 21);
    for (let y = 4; y < 21; y += 5) px(g, 2, y, PAL.ink);
    px(g, 1, 23, PAL.amber, 2, 1);
    px(g, 6, 23, PAL.amber, 2, 1);
    return [c, 9, 24, 1];
  },
  // бар: стойка, бокалы, бутылки на полке
  stall: () => {
    const { c, g } = canvas(34, 30);
    px(g, 1, 2, PAL.ink, 32, 14);
    px(g, 2, 3, PAL.plum, 30, 12);
    px(g, 2, 8, PAL.umber, 30, 1);
    const bottle = [PAL.green, PAL.amber, PAL.wine, PAL.cyan, PAL.green, PAL.orchid, PAL.amber];
    bottle.forEach((col, i) => {
      px(g, 4 + i * 4, 4, col, 2, 4);
      px(g, 4 + i * 4, 3, PAL.ink, 1, 1);
      px(g, 4 + i * 4, 9, col, 2, 5);
    });
    px(g, 0, 16, PAL.ink, 34, 14);
    px(g, 1, 17, PAL.umber, 32, 12);
    px(g, 1, 17, PAL.amber, 32, 1);
    px(g, 1, 18, PAL.brick, 32, 1);
    for (let x = 5; x < 32; x += 7) px(g, x, 21, PAL.plum, 1, 7);
    // бокалы на стойке
    for (const x of [6, 15, 25]) grid(g, x, 12, ['owwo', '.ww.', '.o..', 'ooo.'], { o: PAL.ink, w: PAL.mist });
    return [c, 34, 30, 1];
  },
  // ограждение-бархатный канат на золотых столбиках
  planter: () => {
    const { c, g } = canvas(32, 13);
    for (const x of [1, 15, 29]) {
      px(g, x, 2, PAL.ink, 3, 11);
      px(g, x + 1, 3, PAL.amber, 1, 9);
      px(g, x, 1, PAL.yellow, 3, 2);
      px(g, x - 1, 11, PAL.ink, 5, 2);
    }
    for (let x = 4; x < 29; x++) {
      if (x >= 15 && x <= 17) continue;
      const k = x < 15 ? x - 4 : x - 18;
      const y = 4 + Math.round(Math.sin((k / 11) * Math.PI) * 3);
      px(g, x, y, PAL.wine, 1, 2);
      px(g, x, y, PAL.red, 1, 1);
    }
    return [c, 32, 13, 1];
  },
};

// ───────────── музыка: лаунж-свинг (свой мотив) ─────────────

/** ii–V–I–VI в фа мажоре по такту; бас — шагающий, щётки по малому, вибрафон-«пульс» вполголоса. */
const CHORDS = [
  [55, 58, 62, 65], // Gm7
  [60, 64, 67, 70], // C7
  [53, 57, 60, 64], // Fmaj7
  [62, 66, 69, 72], // D7
];
const BASS = [43, 48, 41, 50];
const MELODY = [72, -1, 70, 69, -1, 67, -1, -1, 69, -1, 72, -1, 74, -1, 72, -1];

const song: Song = {
  step(a: SongApi, st: SongStep) {
    const { s16, bar, t, dt } = st;
    const ch = CHORDS[bar % 4];
    const root = BASS[bar % 4];
    // шагающий бас: четверти, проходящая нота перед сменой аккорда
    if (s16 % 4 === 0) {
      // четвёртая доля — хроматический подход к следующему аккорду
      const note = s16 === 12 ? BASS[(bar + 1) % 4] - 1 : root + [0, 7, 12][s16 / 4];
      a.voice('triangle', note, t, dt * 3.6, 0.15);
    }
    // щётки: хэт на 2 и 4, мягкие восьмые
    if (s16 % 8 === 4) a.hit(dt * 1.5, 0.05, 1600, t);
    if (s16 % 2 === 0) a.hit(dt * 0.6, 0.018, 7000, t);
    if (s16 === 0 && bar % 2 === 0) a.kick(t, 0.16);
    // аккорды «пианино»: на раз и на «и» второй доли
    if (s16 === 0 || s16 === 6) for (const n of ch) a.voice('sine', n, t, dt * 3, 0.03);
    // мелодия — каждый второй такт, вибрафон
    if (bar % 4 >= 2 && st.intensity < 2) {
      const n = MELODY[s16];
      if (n > 0) a.voice('pulse', n + (bar % 8 >= 6 ? 2 : 0), t, dt * 1.8, 0.05);
    }
    // ближе к концу — быстрее пульс сверху
    if (st.intensity >= 1 && s16 % 2 === 1) a.voice('square', ch[3] + 12, t, dt * 0.5, 0.02);
  },
};

const pack: ThemePack = {
  looks: [
    {
      chars: GUESTS[0],
      variants: GUESTS.slice(1),
      ground,
      prop: (k) => PROPS[k]?.() ?? null,
      wall: () => tile(['aaaaaaaa', 'awwwwwwa', 'awrrrrwa', 'awrrrrwa', 'awrrrrwa', 'awrrrrwa', 'awwwwwwa', 'aaaaaaaa'], { a: PAL.amber, w: PAL.wine, r: PAL.red }),
      poses: POSES,
      acts: ACTS,
    },
  ],
  music: { flavor: { transpose: 0, bpm: 112, swing: 0.3, lead: 'pulse', bass: 'triangle', arp: false, echo: true }, song },
};

export default pack;
