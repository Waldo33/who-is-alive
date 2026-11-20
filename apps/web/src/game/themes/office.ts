import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import type { Song, SongApi, SongStep } from '../music';
import { canvas, ellipse, grid, px } from '../pixels';
import { BASE_MAP } from './base';
import type { CharStyle, Look, Pose, PropSet, ThemePack, View } from './types';
import { centerDist, critterSheet, hash, line, tile } from './util';

/**
 * Клерки в офисе — и бойцы в подвале. Днём ковролин, жалюзи и переговорка; посреди дубля
 * свет мигает, и та же толпа оказывается в подвале: бетон, бочка с огнём, груша, шкафчики.
 * Боты там «боксируют с тенью» (эмоция изнанки в game-core › themes.ts) — кнопка эмоции у
 * игрока делает то же, так что можно слиться с толпой. Музыка — тихий куплет и громкий
 * перегруженный припев в духе альтернативы 90-х (своя мелодия).
 */

// ═════════════ костюмы ═════════════

/**
 * Люди толпы: кожа и волосы. Фигура с номером i — один и тот же человек и в офисе, и в подвале
 * (клерк i ↔ боец i), меняется только одежда. Порядок совпадает с CLERKS/FIGHTERS.
 */
const PEOPLE: { skin: [string, string]; hair: [string, string, string] | null }[] = [
  { skin: [PAL.peach, PAL.fawn], hair: [PAL.umber, PAL.plum, PAL.brick] }, // светлый, каштановые волосы
  { skin: [PAL.tan, PAL.fawn], hair: [PAL.night, PAL.ink, PAL.dusk] }, // загорелый брюнет
  { skin: [PAL.fawn, PAL.brick], hair: [PAL.ink, PAL.ink, PAL.night] }, // смуглый брюнет
  { skin: [PAL.brick, PAL.umber], hair: [PAL.ink, PAL.ink, PAL.night] }, // темнокожий
  { skin: [PAL.peach, PAL.fawn], hair: null }, // лысый
];

/** Цвета лица и головы человека i для карты букв персонажа. */
function face(i: number): Record<string, string> {
  const p = PEOPLE[i];
  const [s, S] = p.skin;
  const [h, H, k] = p.hair ?? [s, S, PAL.sand];
  return { s, S, m: S, c: s, h, H, k, r: p.hair ? h : s, R: p.hair ? H : S };
}

/** Клерк: аккуратная стрижка, белая рубашка, галстук, бейдж, серые брюки. */
const CLERK: CharStyle = {
  map: {
    ...BASE_MAP,
    ...face(0),
    a: PAL.mist, b: PAL.white, B: PAL.mist, v: PAL.white, l: PAL.steel, L: PAL.ink,
    t: PAL.wine, n: PAL.blue,
    // ноутбук, кружка с кофе, сигарета, дым, телефон
    Q: PAL.slate, U: PAL.red, u: PAL.umber, C: PAL.white, E: PAL.orange, F: PAL.mist, P: PAL.night,
  },
  patch: (m, view) => {
    if (view === 'D') {
      // галстук от воротника вниз и бейдж на кармане
      m[9][5] = 't'; m[9][6] = 't';
      m[10][5] = 't'; m[10][6] = 't';
      m[11][5] = 't';
      m[10][3] = 'n';
    } else if (view === 'S') {
      m[9][7] = 't'; // узел галстука виден сбоку
    }
  },
};

/** Остальные клерки — те же люди, что бойцы FIGHTERS (по номеру): одежда та же, лица разные. */
const CLERKS: CharStyle[] = [1, 2, 3, 4].map((i) => ({ map: { ...CLERK.map, ...face(i) }, patch: CLERK.patch }));

/** Общее у всех бойцов: бинты на кулаках, фингал, ссадина. */
function fighterMarks(m: string[][], view: View): void {
  if (view === 'D') {
    m[6][2] = 'x'; // фингал под глазом
    if (m[11][2] === 'a') m[11][2] = 'T';
    if (m[11][9] === 'a') m[11][9] = 'T';
  } else if (view === 'U') {
    if (m[11][2] === 'a') m[11][2] = 'T';
    if (m[11][9] === 'a') m[11][9] = 'T';
  } else if (m[10][7] === 'a') m[10][7] = 'T';
}

/** Боец (человек 0): голый торс, ёжик, джинсы. Остальные бойцы — FIGHTERS ниже. */
const FIGHTER: CharStyle = {
  map: {
    ...BASE_MAP,
    ...face(0),
    c: PAL.coral, // раскраснелся
    a: PAL.peach, b: PAL.peach, B: PAL.fawn, v: PAL.tan, l: PAL.navy, L: PAL.ink,
    x: PAL.grape,
    z: PAL.red, // ссадина
    Q: PAL.red, // скакалка
    T: PAL.white, // бинты на кулаках
  },
  patch: (m: string[][], view: View) => {
    fighterMarks(m, view);
    // ёжик на макушке: без блика, короче
    m[1] = m[1].map((ch) => (ch === 'k' ? 'h' : ch));
    if (view === 'D') m[10][7] = m[10][7] === 'v' ? 'z' : m[10][7]; // ссадина
  },
};

/**
 * Разные бойцы подвала (у каждой фигуры свой — по её номеру, одинаково у ботов и игроков,
 * поэтому никого не выдаёт): в майке, в капюшоне, боксёр в трусах и с повязкой, бритый в армейских штанах.
 */
const FIGHTERS: CharStyle[] = [
  // в белой майке, загорелый, серые треники
  {
    map: { ...FIGHTER.map, ...face(1), a: PAL.tan, b: PAL.white, B: PAL.mist, v: PAL.white, l: PAL.steel },
    patch: (m, view) => {
      fighterMarks(m, view);
      m[1] = m[1].map((ch) => (ch === 'k' ? 'h' : ch));
    },
  },
  // в сером капюшоне
  {
    map: { ...FIGHTER.map, ...face(2), h: PAL.slate, H: PAL.steel, k: PAL.mist, r: PAL.slate, R: PAL.steel, a: PAL.slate, b: PAL.slate, B: PAL.steel, v: PAL.steel, l: PAL.night },
    patch: (m, view) => {
      fighterMarks(m, view);
      if (view === 'D') for (let y = 4; y <= 7; y++) { m[y][1] = 'H'; m[y][10] = 'H'; } // капюшон вокруг лица
      if (view === 'S') for (let y = 4; y <= 7; y++) m[y][1] = 'H';
    },
  },
  // боксёр: смуглый, красная повязка, красные трусы
  {
    map: { ...FIGHTER.map, ...face(3), H: PAL.red, a: PAL.brick, b: PAL.brick, B: PAL.umber, v: PAL.clay, l: PAL.red, L: PAL.ink },
    patch: (m, view) => {
      fighterMarks(m, view);
      // ноги ниже трусов — голые
      m[14] = m[14].map((ch) => (ch === 'l' ? 'a' : ch));
    },
  },
  // бритый, чёрная майка, армейские штаны
  {
    map: { ...FIGHTER.map, ...face(4), c: PAL.coral, a: PAL.peach, b: PAL.night, B: PAL.ink, v: PAL.night, l: PAL.forest, L: PAL.ink, z: PAL.navy },
    patch: (m, view) => {
      fighterMarks(m, view);
      if (view === 'D') m[10][2] = 'z'; // наколка на плече
    },
  },
];

// ═════════════ действия ═════════════
// Механика у всех тем одна (game-core: freeze, jump, dance, wave — и у ботов, и у игроков),
// здесь — только как это выглядит. m[строка][столбец]; голова — строки 0–8, тело 9–12, ноги 13–15.

const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};
/** Убрать опущенную правую (на экране) руку — она поднята. */
const rightArmUp = (m: string[][]) => {
  set(m, 9, 10, 'b');
  set(m, 9, 11, 'B');
};

/** Офис: делают вид, что работают; кофе; перекур; звонок. */
const OFFICE_POSES: Pose[] = [
  // 0–1 ноутбук в руках, пальцы стучат
  ...[3, 4].map((f): Pose => ({
    view: 'D',
    patch: (m) => {
      // тёмная крышка с бликом по краю, светлая клавиатура, пальцы стучат
      for (let x = 3; x <= 8; x++) {
        set(m, x, 9, 'Q');
        set(m, x, 10, 'P');
        set(m, x, 11, 'Q');
      }
      set(m, 2, 9, 'o'); set(m, 9, 9, 'o'); set(m, 2, 10, 'o'); set(m, 9, 10, 'o');
      set(m, f, 11, 's'); set(m, 11 - f, 11, 's');
    },
  })),
  // 2 кружка у груди, пар
  {
    view: 'D',
    patch: (m) => {
      set(m, 8, 10, 'u'); set(m, 9, 10, 'U'); set(m, 8, 11, 'U'); set(m, 9, 11, 'U'); set(m, 10, 11, 'o');
      set(m, 11, 7, 'F'); set(m, 10, 8, 'F');
    },
  },
  // 3 глоток: кружка у рта, глаза прикрыты
  {
    view: 'D',
    patch: (m) => {
      rightArmUp(m);
      set(m, 6, 7, 'U'); set(m, 7, 7, 'U'); set(m, 6, 8, 'U'); set(m, 7, 8, 'U');
      set(m, 8, 8, 's'); set(m, 8, 9, 'a'); set(m, 9, 9, 'a');
      set(m, 3, 5, 's'); set(m, 8, 5, 's');
    },
  },
  // 4 затяжка: сигарета у рта, рука у лица
  {
    view: 'D',
    patch: (m) => {
      rightArmUp(m);
      set(m, 9, 7, 'C'); set(m, 10, 7, 'C'); set(m, 11, 7, 'E');
      set(m, 10, 8, 's'); set(m, 10, 9, 'a'); set(m, 9, 9, 'a');
    },
  },
  // 5 выдох: рука с сигаретой внизу, дымок над головой
  {
    view: 'D',
    patch: (m) => {
      set(m, 10, 11, 'C'); set(m, 11, 11, 'E');
      set(m, 5, 7, 'o'); set(m, 6, 7, 'o');
      set(m, 10, 1, 'F'); set(m, 9, 0, 'F'); set(m, 11, 0, 'F');
    },
  },
  // 6–7 по телефону: трубка у уха, рот то закрыт, то открыт
  ...[false, true].map((talk): Pose => ({
    view: 'D',
    patch: (m) => {
      rightArmUp(m);
      set(m, 10, 4, 'P'); set(m, 10, 5, 'P'); set(m, 10, 6, 'P');
      set(m, 11, 6, 's'); set(m, 11, 7, 'a'); set(m, 11, 8, 'a'); set(m, 10, 9, 'a');
      if (talk) { set(m, 5, 7, 'o'); set(m, 6, 7, 'o'); }
    },
  })),
];

const OFFICE_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 }, // «Шеф идёт!» — все уткнулись в ноутбуки
  jump: { poses: [2, 3, 3, 2], ms: 260 }, // кофе
  dance: { poses: [4, 4, 5, 5], ms: 300 }, // перекур
  wave: { poses: [6, 7], ms: 200 }, // звонок
};

/** Подвал: стойка, скакалка, бой с тенью, бицепс. */
const BASEMENT_POSES: Pose[] = [
  // 0 стойка: кулаки у подбородка
  {
    view: 'D',
    patch: (m) => {
      set(m, 3, 8, 'T'); set(m, 8, 8, 'T'); set(m, 2, 9, 'a'); set(m, 9, 9, 'a');
    },
  },
  // 1 скакалка над головой (руки в стороны)
  {
    view: 'D',
    patch: (m) => {
      for (let y = 1; y <= 11; y++) { set(m, 0, y, 'Q'); set(m, 11, y, 'Q'); }
      set(m, 1, 0, 'Q'); set(m, 2, 0, 'Q'); set(m, 9, 0, 'Q'); set(m, 10, 0, 'Q');
      set(m, 0, 11, 'a'); set(m, 11, 11, 'a'); set(m, 1, 11, 'a'); set(m, 10, 11, 'a');
    },
  },
  // 2 скакалка под ногами, прыжок
  {
    view: 'D',
    legs: 'idle',
    patch: (m) => {
      for (let x = 0; x < 12; x++) if (m[15][x] === '.') set(m, x, 15, 'Q');
      set(m, 0, 12, 'Q'); set(m, 11, 12, 'Q'); set(m, 0, 13, 'Q'); set(m, 11, 13, 'Q'); set(m, 0, 14, 'Q'); set(m, 11, 14, 'Q');
      set(m, 0, 11, 'a'); set(m, 11, 11, 'a'); set(m, 1, 11, 'a'); set(m, 10, 11, 'a');
    },
  },
  // 3–4 бой с тенью: стойка — удар (вид сбоку)
  { view: 'S', arms: 'guard', legs: 'liftL' },
  { view: 'S', arms: 'jab', legs: 'liftR' },
  // 5–6 бицепс: обе руки согнуты, во втором кадре «играет» мышцей и ухмыляется
  ...[false, true].map((pump): Pose => ({
    view: 'D',
    face: pump ? 'happy' : 'normal',
    patch: (m) => {
      set(m, 2, 10, 'b'); set(m, 2, 11, 'B'); set(m, 9, 10, 'b'); set(m, 9, 11, 'B');
      set(m, 0, 9, 'a'); set(m, 1, 9, 'a'); set(m, 10, 9, 'a'); set(m, 11, 9, 'a');
      set(m, 0, 8, 'a'); set(m, 0, 7, 'a'); set(m, 11, 8, 'a'); set(m, 11, 7, 'a');
      if (pump) { set(m, 1, 8, 'a'); set(m, 10, 8, 'a'); }
    },
  })),
];

const BASEMENT_ACTS: Look['acts'] = {
  freeze: { poses: [0], ms: 1000 }, // «В стойку!»
  jump: { poses: [1, 2], ms: 180, yoff: [0, -3] }, // скакалка
  dance: { poses: [3, 4], ms: 115, flip: true }, // бой с тенью
  jab: { poses: [3, 4], ms: 115, flip: true },
  wave: { poses: [5, 6], ms: 260 }, // бицепс
};

const OFFICE_ICONS = {
  freeze: ['........', '.oooooo.', '.obbbbo.', '.obbbbo.', '.oooooo.', 'oddddddo', 'oooooooo', '........'],
  jump: ['..m.m...', '...m.m..', 'oooooo..', 'owwwwooo', 'owwwwo.o', 'owwwwooo', '.owwo...', '..oo....'],
  dance: ['.....m..', '....m.m.', '.....m..', '........', 'oooooooo', 'owwwwwro', 'oooooooo', '........'],
};

const BASEMENT_ICONS = {
  freeze: ['.oooooo.', 'orrrrrro', 'orwrrrro', 'orrrrrro', 'oorrrrro', '.orrrro.', '.owwwwo.', '..oooo..'],
  jump: ['.uuuuuu.', 'u......u', 'u......u', 'u......u', 'u......u', 'oo....oo', 'oo....oo', '........'],
  dance: ['........', 'm..oooo.', '..orrrro', 'mmorwrro', '..orrrro', 'm..oooo.', '........', '........'],
};

// ═════════════ офис: земля ═════════════

function officeGround(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // ковролин плиткой 8×8: ворс в соседних плитках лежит поперёк
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const alt = ((x >> 3) + (y >> 3)) % 2 === 1;
      px(g, x, y, PAL.dusk, 8, 8);
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const on = alt ? j % 3 === 0 && (i + j) % 2 === 0 : i % 3 === 0 && (i + j) % 2 === 0;
          if (on) px(g, x + i, y + j, PAL.night);
          else if (hash(x + i, y + j) < 0.025) px(g, x + i, y + j, PAL.steel);
        }
      }
    }
  }
  // круглый ковёр переговорки под столом
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 40 && d > 37) px(g, x, y, PAL.night);
      else if (d <= 37) {
        px(g, x, y, Math.floor(d / 6) % 2 ? PAL.steel : PAL.slate);
        if ((x + y) % 2 === 0 && Math.floor(d / 6) % 2 === 0) px(g, x, y, PAL.steel);
      }
    }
  }
  // кофейные пятна — офис как офис
  for (const [sx, sy] of [[38, 60], [140, 210], [122, 64]]) {
    ellipse(g, sx, sy, 3, 2, PAL.umber);
    px(g, sx - 1, sy - 1, PAL.plum, 2, 1);
  }
  // стена: светлая, окна с жалюзи, часы
  px(g, 0, 0, PAL.mist, w, 12);
  for (let x = 8; x + 22 <= w - 6; x += 30) {
    px(g, x, 1, PAL.slate, 22, 9);
    px(g, x + 1, 2, PAL.cyan, 20, 7);
    for (let y = 2; y < 9; y += 2) px(g, x + 1, y, PAL.white, 20, 1);
    px(g, x + 11, 2, PAL.slate, 1, 7);
    px(g, x + 3 + (x % 7), 9, PAL.slate, 1, 2); // шнурок жалюзи
  }
  px(g, w - 12, 2, PAL.ink, 7, 7);
  px(g, w - 11, 3, PAL.white, 5, 5);
  px(g, w - 9, 4, PAL.ink, 1, 2);
  px(g, w - 9, 5, PAL.ink, 2, 1);
  // плинтус и тёмные стены по бокам
  px(g, 0, 10, PAL.slate, w, 1);
  px(g, 0, 11, PAL.steel, w, 1);
  px(g, 0, 12, PAL.night, w, 1);
  px(g, 0, 12, PAL.night, 4, h - 12);
  px(g, w - 4, 12, PAL.night, 4, h - 12);
  px(g, 3, 13, PAL.steel, 1, h - 16);
  px(g, w - 4, 13, PAL.steel, 1, h - 16);
  px(g, 0, h - 3, PAL.night, w, 3);
  return c;
}

// ═════════════ офис: предметы ═════════════

const OFFICE: PropSet = {
  // стол переговорки: ноутбуки мерцают, над кружкой пар
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    const laptop = ['oooooo', 'osssso', 'osssso', 'oooooo', 'okkkko', '.oooo.'];
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      ellipse(g, ox + 17, 24, 16, 9, PAL.ink);
      ellipse(g, ox + 17, 24, 15, 8, PAL.steel);
      ellipse(g, ox + 17, 22, 15, 7, PAL.ink);
      ellipse(g, ox + 17, 22, 14, 6, PAL.mist);
      ellipse(g, ox + 15, 21, 10, 4, PAL.white);
      const glow = [PAL.blue, PAL.cyan, PAL.blue, PAL.navy];
      grid(g, ox + 5, 17, laptop, { o: PAL.ink, s: glow[f], k: PAL.steel });
      grid(g, ox + 22, 15, laptop, { o: PAL.ink, s: glow[(f + 2) % 4], k: PAL.steel });
      grid(g, ox + 15, 23, laptop, { o: PAL.ink, s: glow[(f + 1) % 4], k: PAL.steel });
      // бумаги и кружка
      px(g, ox + 12, 18, PAL.ink, 5, 4);
      px(g, ox + 13, 18, PAL.white, 3, 3);
      px(g, ox + 13, 19, PAL.slate, 3, 1);
      px(g, ox + 25, 23, PAL.ink, 4, 4);
      px(g, ox + 26, 23, PAL.red, 2, 3);
      px(g, ox + 29, 24, PAL.ink, 1, 2);
      px(g, ox + 26 + (f % 2), 21 - (f >> 1), PAL.white);
      px(g, ox + 27 - (f % 2), 19 - (f >> 1), PAL.mist);
    }
    return [c, fw, fh, 4];
  },
  // фикус в белом горшке
  tree: () => {
    const { c, g } = canvas(22, 30);
    px(g, 10, 12, PAL.umber, 2, 10);
    ellipse(g, 11, 9, 9, 8, PAL.ink);
    ellipse(g, 11, 9, 8, 7, PAL.forest);
    ellipse(g, 8, 7, 4, 3, PAL.green);
    ellipse(g, 14, 12, 4, 3, PAL.pine);
    for (let i = 0; i < 18; i++) {
      const x = 4 + Math.floor(hash(i, 3) * 15);
      const y = 3 + Math.floor(hash(i, 7) * 12);
      if (Math.hypot((x - 11) / 8, (y - 9) / 7) < 0.95) px(g, x, y, hash(i, 1) < 0.5 ? PAL.green : PAL.pine);
    }
    px(g, 6, 20, PAL.ink, 10, 10);
    px(g, 7, 21, PAL.white, 8, 8);
    px(g, 12, 21, PAL.mist, 3, 8);
    px(g, 7, 21, PAL.umber, 8, 1);
    px(g, 5, 20, PAL.ink, 12, 1);
    return [c, 22, 30, 1];
  },
  // кулер с бутылью: пузырьки поднимаются
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      px(g, ox + 1, 0, PAL.ink, 7, 10);
      px(g, ox + 2, 1, PAL.blue, 5, 8);
      px(g, ox + 2, 1, PAL.cyan, 1, 8);
      px(g, ox + 3, 10, PAL.ink, 3, 1);
      px(g, ox + 0, 11, PAL.ink, 9, 15);
      px(g, ox + 1, 12, PAL.white, 7, 13);
      px(g, ox + 6, 12, PAL.mist, 1, 13);
      px(g, ox + 2, 15, PAL.red);
      px(g, ox + 5, 15, PAL.blue);
      px(g, ox + 2, 19, PAL.slate, 5, 1);
      px(g, ox + 4, f ? 3 : 6, PAL.white);
      px(g, ox + 5, f ? 6 : 2, PAL.white);
    }
    return [c, 9, 26, 2];
  },
  // стол с монитором
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 3, PAL.ink, 22, 6);
    px(g, 1, 4, PAL.mist, 20, 4);
    px(g, 1, 4, PAL.white, 20, 1);
    px(g, 1, 8, PAL.ink, 2, 2);
    px(g, 19, 8, PAL.ink, 2, 2);
    px(g, 7, 0, PAL.ink, 8, 5);
    px(g, 8, 1, PAL.blue, 6, 3);
    px(g, 8, 1, PAL.cyan, 6, 1);
    px(g, 6, 6, PAL.steel, 8, 1);
    px(g, 16, 5, PAL.ink, 3, 3);
    px(g, 17, 5, PAL.amber, 1, 2);
    return [c, 22, 10, 1];
  },
  // ряд картотечных шкафов
  benchV: () => {
    const { c, g } = canvas(9, 24);
    px(g, 1, 0, PAL.ink, 7, 22);
    px(g, 2, 1, PAL.slate, 5, 20);
    for (const y of [1, 8, 15]) {
      px(g, 2, y, PAL.mist, 5, 1);
      px(g, 3, y + 3, PAL.ink, 3, 1);
      px(g, 2, y + 6, PAL.steel, 5, 1);
    }
    px(g, 1, 22, PAL.ink, 2, 2);
    px(g, 6, 22, PAL.ink, 2, 2);
    return [c, 9, 24, 1];
  },
  // ксерокс со стопкой бумаги и стикером
  stall: () => {
    const { c, g } = canvas(34, 30);
    px(g, 2, 10, PAL.ink, 30, 20);
    px(g, 3, 11, PAL.mist, 28, 18);
    px(g, 3, 11, PAL.white, 28, 2);
    px(g, 2, 6, PAL.ink, 30, 5);
    px(g, 3, 7, PAL.slate, 28, 3);
    px(g, 3, 7, PAL.steel, 28, 1);
    px(g, 6, 2, PAL.ink, 11, 5);
    px(g, 7, 3, PAL.white, 9, 3);
    px(g, 7, 4, PAL.mist, 9, 1);
    px(g, 22, 13, PAL.steel, 8, 4);
    px(g, 23, 14, PAL.green);
    px(g, 26, 14, PAL.cyan, 3, 2);
    px(g, 9, 14, PAL.yellow, 4, 4);
    px(g, 10, 15, PAL.amber, 2, 1);
    px(g, 3, 20, PAL.slate, 28, 1);
    px(g, 3, 25, PAL.slate, 28, 1);
    px(g, 15, 22, PAL.ink, 4, 1);
    px(g, 15, 27, PAL.ink, 4, 1);
    return [c, 34, 30, 1];
  },
  // низкий стеллаж с папками
  planter: () => {
    const { c, g } = canvas(32, 13);
    px(g, 0, 2, PAL.ink, 32, 11);
    px(g, 1, 3, PAL.steel, 30, 9);
    px(g, 1, 3, PAL.slate, 30, 1);
    const cols = [PAL.red, PAL.blue, PAL.yellow, PAL.green, PAL.white, PAL.orange];
    for (let x = 2; x < 30; x += 3) {
      if (hash(x, 4) < 0.15) continue;
      const col = cols[Math.floor(hash(x, 9) * cols.length)];
      const top = 4 + (hash(x, 2) < 0.3 ? 1 : 0);
      px(g, x, top, col, 2, 11 - top);
      px(g, x, 7, PAL.white, 2, 1);
    }
    return [c, 32, 13, 1];
  },
};

// ═════════════ подвал: земля ═════════════

function basementGround(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // бетон: пятна, крошка, трещины
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // сырые пятна — дизерингом, чтобы не было квадратов
      const big = (hash(x >> 4, y >> 4) + hash((x + 8) >> 4, (y + 8) >> 4)) / 2;
      const v = hash(x, y);
      let col: string = (big < 0.35 && (x + y) % 2 === 0) || big < 0.2 ? PAL.night : PAL.dusk;
      if (v < 0.012) col = PAL.steel;
      else if (v > 0.975) col = PAL.ink;
      px(g, x, y, col);
    }
  }
  for (let k = 0; k < 7; k++) {
    let x = 10 + Math.floor(hash(k, 11) * (w - 20));
    let y = 20 + Math.floor(hash(k, 13) * (h - 40));
    for (let s = 0; s < 14; s++) {
      px(g, x, y, PAL.ink);
      x += hash(k, s) < 0.5 ? 1 : 0;
      y += 1;
      if (hash(s, k) < 0.3) x -= 1;
    }
  }
  // лужи с бликом
  for (const [lx, ly, rx] of [[30, 200, 7], [150, 90, 5], [128, 236, 6]]) {
    ellipse(g, lx, ly, rx, 2, PAL.navy);
    px(g, lx - 2, ly - 1, PAL.cyan, 2, 1);
  }
  // свет голой лампочки над центром: тёплое пятно дизерингом
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 22 && (x + y) % 2 === 0) px(g, x, y, PAL.umber);
      else if (d < 42 && x % 2 === 0 && y % 2 === 0) px(g, x, y, PAL.plum);
    }
  }
  // круг мелом — «ринг»
  for (let a = 0; a < 360; a += 2) {
    const r = (a * Math.PI) / 180;
    if (Math.floor(a / 8) % 3 === 2) continue;
    const x = Math.round(w / 2 + Math.cos(r) * 45 * 1.15);
    const y = Math.round(132 + Math.sin(r) * 45);
    px(g, x, y, PAL.mist);
  }
  // стена: кирпич, труба с ржавчиной, решётка окошка
  for (let y = 0; y < 12; y += 3) {
    const off = (y / 3) % 2 ? 3 : 0;
    for (let x = -off; x < w; x += 6) {
      px(g, x, y, hash(x, y) < 0.3 ? PAL.plum : PAL.umber, 6, 3);
      px(g, x, y, PAL.ink, 6, 1);
      px(g, x, y, PAL.ink, 1, 3);
    }
  }
  px(g, 0, 4, PAL.ink, w, 4);
  px(g, 0, 5, PAL.steel, w, 2);
  px(g, 0, 5, PAL.slate, w, 1);
  for (let x = 12; x < w; x += 37) {
    px(g, x, 4, PAL.ink, 3, 4);
    px(g, x + 9, 6, PAL.rust, 2, 1);
  }
  px(g, w / 2 - 8, 1, PAL.ink, 16, 9);
  px(g, w / 2 - 7, 2, PAL.deep, 14, 7);
  for (let x = w / 2 - 6; x < w / 2 + 7; x += 3) px(g, x, 2, PAL.ink, 1, 7);
  px(g, 0, 12, PAL.ink, w, 1);
  px(g, 0, 12, PAL.ink, 4, h - 12);
  px(g, w - 4, 12, PAL.ink, 4, h - 12);
  px(g, 0, h - 3, PAL.ink, w, 3);
  return c;
}

// ═════════════ подвал: предметы ═════════════

const BASEMENT: PropSet = {
  // бочка с огнём между стопками покрышек
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    const tyre = (x: number, y: number) => {
      ellipse(g, x, y, 6, 3, PAL.ink);
      ellipse(g, x, y - 1, 5, 2, PAL.dusk);
      ellipse(g, x, y - 1, 2, 1, PAL.ink);
    };
    const flames = [
      ['...y....', '..yay...', '.yaoay..', '.aoroa..', 'aorrroa.', 'orrrrro.'],
      ['....y...', '...yay..', '..yaoay.', '.yaorao.', '.aorrroa', '.orrrrro'],
      ['..y.....', '.yay.y..', '.aoaya..', 'aorooa..', 'aorrroa.', 'orrrrro.'],
      ['.....y..', '..y.yay.', '..yaoaoy', '.yaorroa', '.aorrroa', '.orrrrro'],
    ];
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      tyre(ox + 7, 31);
      tyre(ox + 7, 27);
      tyre(ox + 27, 31);
      px(g, ox + 11, 13, PAL.ink, 12, 20);
      px(g, ox + 12, 14, PAL.rust, 10, 18);
      px(g, ox + 13, 14, PAL.clay, 1, 18);
      px(g, ox + 12, 18, PAL.umber, 10, 1);
      px(g, ox + 12, 26, PAL.umber, 10, 1);
      ellipse(g, ox + 17, 13, 6, 2, PAL.ink);
      ellipse(g, ox + 17, 13, 5, 1, PAL.plum);
      grid(g, ox + 13, 7, flames[f], { y: PAL.yellow, a: PAL.amber, o: PAL.orange, r: PAL.red });
      // искры летят вверх
      for (let k = 0; k < 3; k++) {
        const y = 6 - ((f * 2 + k * 3) % 7);
        if (y >= 0) px(g, ox + 14 + ((k * 5 + f) % 7), y, k % 2 ? PAL.yellow : PAL.amber);
      }
    }
    return [c, fw, fh, 4];
  },
  // боксёрская груша на цепи
  tree: () => {
    const { c, g } = canvas(22, 30);
    for (let y = 0; y < 6; y += 2) px(g, 10, y, PAL.slate, 2, 1);
    px(g, 7, 6, PAL.ink, 8, 1);
    px(g, 6, 7, PAL.ink, 10, 19);
    px(g, 7, 26, PAL.ink, 8, 1);
    px(g, 7, 7, PAL.wine, 8, 19);
    px(g, 8, 8, PAL.red, 1, 17);
    px(g, 13, 8, PAL.plum, 1, 17);
    px(g, 7, 11, PAL.slate, 8, 2);
    px(g, 7, 21, PAL.slate, 8, 2);
    ellipse(g, 11, 28, 5, 1, PAL.ink);
    return [c, 22, 30, 1];
  },
  // бетонный столб с лампой в решётке: лампа подмигивает
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      px(g, ox + 2, 6, PAL.ink, 5, 20);
      px(g, ox + 3, 7, PAL.slate, 3, 19);
      px(g, ox + 3, 7, PAL.mist, 1, 19);
      px(g, ox + 5, 14, PAL.steel, 1, 3);
      grid(g, ox, 0, ['..ooooo..', '.oyoyoyo.', '.oywyyyo.', '.oyoyoyo.', '..ooooo..', '...ooo...'], {
        o: PAL.ink,
        y: f ? PAL.amber : PAL.yellow,
        w: PAL.white,
      });
    }
    return [c, 9, 26, 2];
  },
  // поддон, на нём бутылка воды и полотенце
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 2, PAL.ink, 22, 7);
    px(g, 1, 3, PAL.brick, 20, 2);
    px(g, 1, 6, PAL.brick, 20, 2);
    px(g, 1, 3, PAL.tan, 20, 1);
    px(g, 1, 6, PAL.tan, 20, 1);
    px(g, 1, 8, PAL.ink, 3, 2);
    px(g, 9, 8, PAL.ink, 3, 2);
    px(g, 18, 8, PAL.ink, 3, 2);
    px(g, 3, 1, PAL.ink, 7, 4);
    px(g, 4, 2, PAL.white, 5, 2);
    px(g, 15, 0, PAL.ink, 3, 5);
    px(g, 16, 1, PAL.cyan, 1, 3);
    return [c, 22, 10, 1];
  },
  // ящики друг на друге
  benchV: () => {
    const { c, g } = canvas(9, 24);
    for (const y of [0, 8, 16]) {
      px(g, 0, y, PAL.ink, 9, 8);
      px(g, 1, y + 1, PAL.brick, 7, 6);
      line(g, 1, y + 1, 7, y + 6, PAL.umber);
      line(g, 7, y + 1, 1, y + 6, PAL.umber);
      px(g, 1, y + 1, PAL.tan, 7, 1);
    }
    return [c, 9, 24, 1];
  },
  // ряд железных шкафчиков, один приоткрыт
  stall: () => {
    const { c, g } = canvas(34, 30);
    px(g, 1, 2, PAL.ink, 32, 27);
    for (let i = 0; i < 4; i++) {
      const x = 2 + i * 8;
      const open = i === 2;
      px(g, x, 3, open ? PAL.ink : PAL.deep, 7, 25);
      if (open) {
        px(g, x + 1, 4, PAL.night, 5, 23);
        px(g, x + 2, 6, PAL.mist, 3, 6); // футболка на крючке
        continue;
      }
      px(g, x, 3, PAL.pine, 7, 1);
      for (let k = 0; k < 3; k++) px(g, x + 2, 5 + k * 2, PAL.ink, 3, 1);
      px(g, x + 5, 15, PAL.mist, 1, 3);
      if (hash(i, 5) < 0.6) px(g, x + 1 + (i % 3), 20, PAL.forest, 2, 2); // вмятина
    }
    return [c, 34, 30, 1];
  },
  // покрышки в ряд
  planter: () => {
    const { c, g } = canvas(32, 13);
    for (let i = 0; i < 4; i++) {
      const x = 4 + i * 8;
      ellipse(g, x, 7, 4, 5, PAL.ink);
      ellipse(g, x, 7, 3, 4, PAL.dusk);
      ellipse(g, x, 7, 1, 2, PAL.ink);
      px(g, x - 2, 4, PAL.steel, 1, 2);
    }
    return [c, 32, 13, 1];
  },
};

// ═════════════ музыка ═════════════

/**
 * Своя песня темы, инструментальный рок: Em — C — G — D, 132 BPM, мелодия своя.
 * Офис — тихо: бас восьмыми, чистая гитара перебором с эхом, римшот; со второго круга
 * та же мелодия, что потом в подвале, — чистым звуком, вполголоса.
 * Подвал — громко, по частям (счёт тактов от смены света, круг 14 тактов):
 *   риф (перегруженные квинты с акцентами) → риф + соло → стоп-тайм со сбивкой → риф октавой выше,
 *   сбивки малым и томами в конце каждой четвёрки, тарелка на смене и в начале частей.
 */
const ROOTS = [40, 36, 43, 38]; // E2 C2 G2 D2
const TRIADS = [
  [0, 3, 7], // Em
  [0, 4, 7], // C
  [0, 4, 7], // G
  [0, 4, 7], // D
];
const PICK = [0, 2, 1, 3, 2, 1, 3, 1];
/** Мелодия: по 5 нот на такт на шестнадцатых 0, 3, 6, 10, 12 (синкопы). */
const MEL_AT = [0, 3, 6, 10, 12];
const MELODY = [
  [76, 79, 81, 79, 76],
  [76, 74, 72, 74, 76],
  [74, 76, 79, 81, 79],
  [78, 76, 74, 71, 74],
];

/** Нота мелодии на этой шестнадцатой (и её длина в шестнадцатых) или null. */
function melodyAt(ch: number, s: number): [number, number] | null {
  const k = MEL_AT.indexOf(s);
  if (k < 0) return null;
  return [MELODY[ch][k], (MEL_AT[k + 1] ?? 16) - s];
}

/** Сбивка в конце такта: малый шестнадцатыми и томы вниз. */
function fill(a: SongApi, s: number, t: number): void {
  if (s < 12) return;
  a.hit(0.07, 0.12 + (s - 12) * 0.03, 1400, t);
  a.kick(t, 0.22, [240, 200, 165, 130][s - 12]);
}

const song: Song = {
  step(a: SongApi, st: SongStep) {
    const { s16: s, bar, t, dt, intensity: I, twist } = st;
    const ch = bar % 4;
    const root = ROOTS[ch];
    const tri = TRIADS[ch];
    if (!twist) {
      // ── офис: тихо ──
      if (s % 2 === 0) a.voice('triangle', root + (s === 14 ? 12 : 0), t, dt * 1.6, 0.13);
      if (s % 2 === 0) {
        const n = PICK[s / 2];
        a.voice('pulse', root + 24 + (n === 3 ? 12 : tri[n]), t, dt * 1.8, 0.04);
      }
      if (s % 4 === 2) a.hit(0.03, 0.035, 7000, t);
      if (s === 4 || s === 12) a.hit(0.03, 0.07, 2600, t); // римшот
      if (s === 0 || s === 10 || (I >= 1 && s === 8)) a.kick(t, 0.17, 110);
      if (I >= 2 && s % 2 === 1) a.hit(0.02, 0.025, 8000, t);
      // со второго круга — мелодия чистым звуком (намёк на подвал)
      const m = bar % 16 >= 8 ? melodyAt(ch, s) : null;
      if (m) a.voice('square', m[0] - 12, t, dt * m[1] * 0.9, 0.03);
      if (bar % 4 === 3 && s >= 14) a.hit(0.04, 0.05, 2600, t);
      return;
    }
    // ── подвал: громко, по частям ──
    const b = st.barsSinceTwist % 14;
    const part = b < 4 ? 'riff' : b < 8 ? 'solo' : b < 10 ? 'stop' : 'high';
    const lastOfFour = part === 'stop' ? b === 9 : b % 4 === 3;
    const crash = s === 0 && (b === 0 || b === 4 || b === 10 || (part === 'high' && b % 2 === 0));
    if (crash) a.hit(0.9, 0.16, 4500, t);

    if (part === 'stop') {
      // стоп-тайм: удары на «раз» и «и» второй доли, между ними тишина; второй такт — сбивка
      if (b === 8 && (s === 0 || s === 6)) {
        a.power(root + 12, t, dt * 3, 0.12);
        a.voice('square', root, t, dt * 3, 0.14);
        a.kick(t, 0.36, 160);
        a.hit(0.12, 0.2, 1500, t);
      }
      if (b === 9) {
        if (s === 0) a.power(root + 12, t, dt * 6, 0.1);
        if (s % 2 === 0 && s >= 4) a.hit(0.06, 0.08 + s * 0.008, 1400, t);
        if (s >= 8) a.kick(t, 0.25, 260 - s * 8);
      }
      return;
    }

    // риф — как был: перегруз восьмыми, акценты на 1, «и» 2-й, 3, «и» 4-й
    const up = part === 'high' ? 12 : 0;
    const accent = s === 0 || s === 6 || s === 8 || s === 14;
    if (s % 2 === 0) a.power(root + 12 + up, t, accent ? dt * 1.9 : dt * 0.9, accent ? 0.11 : 0.07);
    if (s % 2 === 0) a.voice('square', root, t, dt * 1.7, 0.12);
    // ударные: рок-бит, в «октаве» — бочка восьмыми и хэт шестнадцатыми
    if (lastOfFour) fill(a, s, t);
    if (!(lastOfFour && s >= 12)) {
      const kick = part === 'high' ? s % 4 === 0 || s === 6 || s === 14 : s === 0 || s === 6 || s === 10;
      if (kick || (I >= 2 && s % 4 === 0)) a.kick(t, 0.34, 160);
      if (s === 4 || s === 12) a.hit(0.14, 0.22, 1500, t);
      if (part === 'high' || I >= 1 ? true : s % 2 === 0) a.hit(s % 2 ? 0.03 : 0.06, s % 2 ? 0.035 : 0.06, 6500, t);
    }
    // соло: та же мелодия, перегруженная, октавой с дублем
    if (part === 'solo') {
      const m = melodyAt(ch, s);
      if (m) a.power(m[0] - 12, t, dt * m[1] * 0.95, 0.06, [0, 12]);
    }
  },
};

// ═════════════ пакет ═════════════

const pack: ThemePack = {
  looks: [
    {
      chars: CLERK,
      variants: CLERKS,
      poses: OFFICE_POSES,
      acts: OFFICE_ACTS,
      icons: OFFICE_ICONS,
      ground: officeGround,
      prop: (kind) => OFFICE[kind]?.() ?? null,
      // перегородка опенспейса
      wall: () =>
        tile(['ssssssss', 'sffffffs', 'sfdfffds', 'sffffffs', 'sffdfffs', 'sffffffs', 'sfdffdfs', 'ssssssss'], {
          s: PAL.slate,
          f: PAL.steel,
          d: PAL.dusk,
        }),
      // бумажный самолётик: лежит — и улетает
      critter: () => {
        const a = ['......', '......', '......', '.ow...', 'owwwo.', '.oooo.'];
        const b = ['......', '......', '......', '..ow..', '.owwwo', '.oooo.'];
        const r1 = ['......', 'o.....', 'wo....', 'wwwoo.', 'oooww.', '......'];
        const r2 = ['......', '......', 'o.....', 'wwo...', 'owwwoo', '......'];
        return critterSheet([a, b, r1, r2, r1, r2], { o: PAL.slate, w: PAL.white });
      },
    },
    {
      chars: FIGHTER,
      variants: FIGHTERS,
      poses: BASEMENT_POSES,
      acts: BASEMENT_ACTS,
      icons: BASEMENT_ICONS,
      ground: basementGround,
      prop: (kind) => BASEMENT[kind]?.() ?? null,
      // грязный кирпич
      wall: () =>
        tile(['mmmmmmmm', 'bbbmbbbB', 'bBbmbbbB', 'mmmmmmmm', 'bmbbbBmb', 'BmbbbbmB', 'mmmmmmmm', 'bbbmbbbB'], {
          m: PAL.ink,
          b: PAL.umber,
          B: PAL.plum,
        }),
      // крыса
      critter: () => {
        const a = ['......', '......', '...h..', '.hbbo.', 'cbbbbo', '.o..o.'];
        const b = ['......', '......', '...h..', '.hbbo.', 'cbbbbo', '..oo..'];
        const r1 = ['......', '......', '...h..', 'chbbo.', '.bbbbo', '.o..o.'];
        const r2 = ['......', '...h..', '.hbbo.', 'cbbbbo', '..oo..', '......'];
        return critterSheet([a, b, r1, r2, r1, r2], { o: PAL.ink, b: PAL.dusk, h: PAL.steel, c: PAL.coral });
      },
    },
  ],
  music: { flavor: { transpose: 0, bpm: 132, swing: 0, lead: 'pulse', bass: 'triangle', arp: false, echo: true }, song },
  subliminal: true,
};

export default pack;
