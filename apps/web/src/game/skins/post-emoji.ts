import { PAL } from '@kto/assets';
import { F } from '../sprites';
import { canvas, outlineOf, px } from '../pixels';
import type { Ctx } from '../pixels';
import { actorFrame } from './stickers';

/**
 * Эмодзи для постов канала (решение владельца 28.11.2026): свой набор custom emoji Telegram в пиксельном
 * стиле игры, чтобы писать посты не стандартными смайлами. Отдельно от значков статуса (skins/badges.ts) —
 * и рисунки другие. Иконка до 18×18 + белый контур, в файле — ровно ×5 по центру холста 100×100 PNG,
 * анимированные — ещё видео WEBM (`pnpm --filter web post-emoji` → `apps/server/stickers/emoji`).
 * Набор у бота собирает `apps/server/src/emoji-set.ts`; эмодзи (`emoji`) — по нему бот узнаёт свою картинку
 * в наборе, поэтому у каждой — свой.
 */

export interface PostEmoji {
  id: string;
  emoji: string;
  /** Подпись для превью. */
  name: string;
  /** Кадр без белого контура; t — время анимации, мс (нет — неподвижная картинка). */
  art(t?: number): HTMLCanvasElement;
  /** Анимированный: видео-эмодзи, круг POST_EMOJI_MS. */
  anim?: boolean;
}

export const POST_EMOJI_MS = 2000;
export const POST_EMOJI_FPS = 20;

/**
 * Буквы сеток: o ink, w white, m mist, s slate, d steel, n dusk, k night, y yellow, a amber, f orange,
 * r red, v wine, g green, G forest, b blue, c cyan, u umber, t tan, p peach, z sand, x magenta, h coral, q grape.
 */
const K: Record<string, string> = {
  o: PAL.ink, w: PAL.white, m: PAL.mist, s: PAL.slate, d: PAL.steel, n: PAL.dusk, k: PAL.night,
  y: PAL.yellow, a: PAL.amber, f: PAL.orange, r: PAL.red, v: PAL.wine, g: PAL.green, G: PAL.forest,
  b: PAL.blue, c: PAL.cyan, u: PAL.umber, t: PAL.tan, p: PAL.peach, z: PAL.sand, x: PAL.magenta, h: PAL.coral, q: PAL.grape,
};

function rows(r: string[], map: Record<string, string> = K): HTMLCanvasElement {
  const w = Math.max(...r.map((s) => s.length));
  const { c, g } = canvas(w, r.length);
  r.forEach((s, y) => {
    for (let x = 0; x < s.length; x++) {
      const col = map[s[x]!];
      if (col) px(g, x, y, col);
    }
  });
  return c;
}

/** Холст w×h с рисованием по точкам. */
function draw(w: number, h: number, f: (P: (x: number, y: number, col: string) => void, g: Ctx) => void): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  f((x, y, col) => px(g, x, y, col), g);
  return c;
}

/** Обвести залитое чернилами: всё, что нарисовано, получает контур ink снаружи (холст +2). */
function inked(src: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = canvas(src.width + 2, src.height + 2);
  outlineOf(src.getContext('2d')!, src.width, src.height, g, 0, 0, PAL.ink);
  g.drawImage(src, 1, 1);
  return c;
}

// ───────────── рисунки ─────────────

/** Кинокамера на треноге, огонёк записи. */
const CAMERA = [
  '..ooo....ooo......',
  '.ommmo..ommmo.....',
  'omdmdmoomdmdmo....',
  'ommommoommommo....',
  'omdmdmoomdmdmo....',
  '.ommmo..ommmo.....',
  '..ooooooooooo.....',
  '.onnnnnnnnnnno..oo',
  '.onrnddddddddoodmo',
  '.onnnddddddddodmmo',
  '.onddddddddddodmmo',
  '.onddddddddddodmmo',
  '.onddddddddddoodmo',
  '.onnnnnnnnnnnno.oo',
  '..ooooooooooooo...',
  '......oddo........',
  '.....odoodo.......',
  '....odo..odo......',
];

/** Попкорн в полосатом стакане. */
const POPCORN = [
  '.....oooo.......',
  '..oooowwzoooo...',
  '.owwzwwwwowwwo..',
  'owwwwwzowwwzwwo.',
  'owzwwwwwwzwwwwwo',
  'oooooooooooooooo',
  'owwrrwwrrwwrrwwo',
  '.owrrwwrrwwrrwo.',
  '.owrrwwrrwwrrwo.',
  '.owrrwwrrwwrrwo.',
  '..orrwwrrwwrro..',
  '..orrwwrrwwrro..',
  '..orrwwrrwwrro..',
  '...orwwrrwwro...',
  '...oooooooooo...',
];

/** Билет в кино: вырезы по бокам, линия отрыва, красная звёздочка-штамп. */
const TICKET = [
  'oooooooooooooooooo',
  'oaaaayaaaaaaaaaaao',
  'oaaaaaaaaaaroaaaao',
  '.oaaayaaaaarrraao.',
  '..oaaaaaaarrrrro..',
  '..oaayaaaaarrraao.',
  '.oaaaaaaaaaroaraao',
  'oaaaayaaaaaaaaaaao',
  'oaaaaaaaaaaaaaaaao',
  'oooooooooooooooooo',
];

/** Молния. */
const BOLT = [
  '......ooooooo',
  '.....oyyyyyo.',
  '.....oyyyyo..',
  '....oyyyyo...',
  '....oyyyo....',
  '...oyyyyoooo.',
  '...oyyyyyyyo.',
  '..oaaaayyyo..',
  '..ooooyyyo...',
  '.....oyyo....',
  '....oyyo.....',
  '....oyao.....',
  '...oyao......',
  '...oao.......',
  '..oao........',
  '..oo.........',
];

/** Глаза, смотрят вбок. */
const EYE = ['..ooo..', '.owwwo.', 'owwwwwo', 'owwwwwo', 'owwoowo', 'owwoowo', 'owwoowo', 'owwwwwo', '.owwwo.', '..ooo..'];

/** Монтажные ножницы: «вырезан». */
const SCISSORS = [
  'o..............o',
  'omo...........mo',
  '.omo........omo.',
  '..omo......omo..',
  '...omo....omo...',
  '....omo..omo....',
  '.....omoomo.....',
  '......owwo......',
  '.....oommoo.....',
  '....orroorro....',
  '...orro..orro...',
  '..orro....orro..',
  '.orrrro..orrrro.',
  '.or..ro..or..ro.',
  '.or..ro..or..ro.',
  '..oooo....oooo..',
];

/** Стоп-кадр: пауза изо льда. */
const PAUSE = [
  'oooooo..oooooo',
  'owwcco..owwcco',
  'owccbo..owccbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occcbo..occcbo',
  'occbbo..occbbo',
  'oooooo..oooooo',
];

/** Корона с камнями. */
const CROWN = [
  '.o......oo......o.',
  'oyo....oyyo....oyo',
  'oyyo..oyyyyo..oyyo',
  'oyyyooyywyyyooyyyo',
  'oyyyyyywyyyyyyyyyo',
  'oyyyyyyyyyyyyyyyyo',
  'oyyyyyyyyyyyyyyyao',
  'oooooooooooooooooo',
  'oaaraaaaccaaaaraao',
  'oaaaaaaaaaaaaaaaao',
  'oooooooooooooooooo',
];

/** Сердце. */
const HEART = [
  '..oooo....oooo..',
  '.orrrro..orrrro.',
  'orrwwrroorrrrrro',
  'orwwrrrrrrrrrrro',
  'orwrrrrrrrrrrrro',
  'orrrrrrrrrrrrrvo',
  '.orrrrrrrrrrrvo.',
  '..orrrrrrrrrvo..',
  '...orrrrrrrvo...',
  '....orrrrrvo....',
  '.....orrrvo.....',
  '......orvo......',
  '.......oo.......',
];

/** Подарок: коробка с бантом. */
const GIFT = [
  '....ooo..ooo....',
  '...oyyyooyyyo...',
  '...oyaayyaayo...',
  '....ooyyyyoo....',
  'oooooooyyooooooo',
  'orrrrrryyrrrrrro',
  'orwrrrryyrrrrrro',
  'oooooooooooooooo',
  '.orrrrryyrrrrro.',
  '.orrrrryyrrrrro.',
  '.orrrrryyrrrrro.',
  '.orrrrryyrrrrro.',
  '.ovrrrryyrrrrvo.',
  '.ovvvvvyavvvvvo.',
  '.oooooooooooooo.',
];

/** Телефон: на экране — актёр массовки и звезда. */
const PHONE = [
  '.oooooooooo.',
  'onnnnnnnnnno',
  'onoooooooono',
  'onobbbbbbono',
  'onobbbbybono',
  'onobbbyyyono',
  'onobbbbybono',
  'onobbopbbono',
  'onobbohbbono',
  'onobooooobno',
  'onobbbbbbono',
  'onoooooooono',
  'onnnnoonnnno',
  'onnnnnnnnnno',
  '.oooooooooo.',
];

/** Плашка NEW. */
const NEW = [
  '.oooooooooooooooo.',
  'oxxxxxxxxxxxxxxxxo',
  'oxwxxwxwwwxwxxxwxo',
  'oxwwxwxwxxxwxxxwxo',
  'oxwxwwxwwxxwxwxwxo',
  'oxwxxwxwxxxwxwxwxo',
  'oxwxxwxwwwxxwxwxxo',
  'oxxxxxxxxxxxxxxxxo',
  '.oooooooooooooooo.',
];

/** Кресло режиссёра. */
const CHAIR = [
  'oo............oo',
  'ouo..........ouo',
  'ouoooooooooooouo',
  'ouonnnnnnnnnnouo',
  'ouonwwnwwnwwnouo',
  'ouonnnnnnnnnnouo',
  'ouoooooooooooouo',
  'ouo..........ouo',
  'oooooooooooooooo',
  'ottttttttttttuuo',
  'oooooooooooooooo',
  '.ouo........ouo.',
  '..ouo......ouo..',
  '...ouo....ouo...',
  '....ouooooouo...',
  '...ouo....ouo...',
  '..ouo......ouo..',
  '.oo..........oo.',
];

/** Хлопушка-конфетти. */
const POPPER = [
  '...........y...c..',
  '.....c..r.........',
  '..y.........g...r.',
  '.......g..y.......',
  '...r.........c....',
  '..........ooo...y.',
  '..c......oyyyo....',
  '........oyrrryo.g.',
  '......oorrryyyo...',
  '.....oyyyrrrro....',
  '....orrryyyyo.....',
  '...oyyyrrrro......',
  '..orrryyyyo.......',
  '..oyyyrrro........',
  '.orrryyyo.........',
  '.oyyyrro..........',
  'oaaaoo............',
  'ooo...............',
];

/** Стрелка вправо. */
const ARROW = [
  '..........oo....',
  '..........oyo...',
  '..........oyyo..',
  'oooooooooooyyyo.',
  'oyyyyyyyyyyyyyyo',
  'oyyyyyyyyyyyyyyyo',
  'oaaaaaaaaaaaaaao',
  'oooooooooooaaao.',
  '..........oaao..',
  '..........oao...',
  '..........oo....',
];

/** Знак вопроса и восклицательный. */
const QUESTION = [
  '..oooooo..',
  '.oyyyyyyo.',
  'oyyooooyyo',
  'oyyo..oyyo',
  'oooo..oyyo',
  '.....oyyao',
  '....oyyao.',
  '...oyyao..',
  '...oyyo...',
  '...oooo...',
  '..........',
  '...oooo...',
  '...oyyo...',
  '...oaao...',
  '...oooo...',
];
const BANG = [
  '.oooo.',
  'orrrro',
  'orwrro',
  'orrrro',
  'orrrro',
  'orrrro',
  'orrrvo',
  '.orvo.',
  '.orvo.',
  '.oooo.',
  '......',
  '.oooo.',
  '.orro.',
  '.ovvo.',
  '.oooo.',
];

/** Видеокассета VHS с радужной наклейкой. */
const VHS = [
  'oooooooooooooooooo',
  'onnnnnnnnnnnnnnnno',
  'onwwwwwwwwwwwwwwno',
  'onwrrrrffffyyyywno',
  'onwwwwwwwwwwwwwwno',
  'onnnnnnnnnnnnnnnno',
  'onnoooonnnnoooonno',
  'onoommoonnoommoono',
  'onnoooonnnnoooonno',
  'onnnnnnnnnnnnnnnno',
  'onnnnoooooooonnnno',
  'oooooooooooooooooo',
];

/** Банановая кожура: на ней поскальзываются. */
const PEEL = [
  '.......oo.......',
  '......ouuo......',
  '......oyyo......',
  '.....oyzzyo.....',
  '....oyzzzzyo....',
  '....oyzzzzyo....',
  '...oyyzzzzyyo...',
  '..oyyoyzzyoyyo..',
  '.oyyo.oyyo.oyyo.',
  '.oyo..oyyo..oyo.',
  'oyao..oyao..oayo',
  'oao...oyao...oao',
  'oo....oaao....oo',
  '......oooo......',
]

/** Студийный микрофон на стойке. */
const MIC = [
  '...oooooo...',
  '..ommmmmmo..',
  '.omdmdmdmmo.',
  '.ommmmmmmmo.',
  '.omdmdmdmmo.',
  '.ommmmmmmmo.',
  '.omdmdmdmmo.',
  '..ommmmmmo..',
  '...oooooo...',
  'o...odo....o',
  'od..odo...do',
  '.od.odo..do.',
  '..ooodoooo..',
  '.....odo....',
  '.....odo....',
  '...oooooo...',
  '..oddddddo..',
  '..oooooooo..',
];

/** Медаль за первое место. */
const MEDAL = [
  'ooo......ooo',
  'obbo....orro',
  '.obbo..orro.',
  '..obboorro..',
  '...obbrro...',
  '...oooooo...',
  '..oyyyyyyo..',
  '.oyyaaaayyo.',
  'oyyaayyaayyo',
  'oyaaayyaaayo',
  'oyaaayyaaayo',
  'oyaaayyaaayo',
  'oyyaayyyaayo',
  '.oyyaaaayyo.',
  '..oyyyyyyo..',
  '...oooooo...',
];

/** Ракета: «запуск». */
const ROCKET = [
  '.......oo.......',
  '......owwo......',
  '.....owwwmo.....',
  '.....owwwmo.....',
  '....owwccwmo....',
  '....owcbbcmo....',
  '....owcbbcmo....',
  '....owwccwmo....',
  '....owwwwwmo....',
  '...oowwwwwmoo...',
  '..orowwwwwmoro..',
  '.orrowwwwwmorro.',
  '.orooommmmooroo.',
  '.oo..oyffyo..oo.',
  '......oyyo......',
  '.......oo.......',
];

/** Будильник: «скоро». */
function clock(): HTMLCanvasElement {
  return draw(18, 18, (P) => {
    for (let y = 0; y < 18; y++)
      for (let x = 0; x < 18; x++) {
        const r = Math.hypot(x + 0.5 - 9, y + 0.5 - 10);
        if (r < 7.6) P(x, y, r > 6.4 ? PAL.ink : r > 5.4 ? PAL.red : PAL.white);
      }
    // колокольчики
    for (const cx of [3.5, 14.5])
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 18; x++) {
          const r = Math.hypot(x + 0.5 - cx, y + 0.5 - 3.5);
          if (r < 3 && Math.hypot(x + 0.5 - 9, y + 0.5 - 10) >= 7.6) P(x, y, r > 2 ? PAL.ink : PAL.red);
        }
    // стрелки
    for (let y = 6; y <= 10; y++) P(9, y, PAL.ink);
    for (let x = 9; x <= 12; x++) P(x, 10, PAL.ink);
    P(9, 10, PAL.red);
    // ножки
    P(4, 16, PAL.ink); P(5, 16, PAL.ink); P(12, 16, PAL.ink); P(13, 16, PAL.ink);
    P(3, 17, PAL.ink); P(14, 17, PAL.ink);
  });
}

/** Галочка и крестик в рамке. */
function box(col: string, dark: string, mark: 'check' | 'cross'): HTMLCanvasElement {
  return draw(16, 16, (P) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const corner = (x === 0 || x === 15) && (y === 0 || y === 15);
        if (corner) continue;
        const edge = x === 0 || y === 0 || x === 15 || y === 15;
        P(x, y, edge ? PAL.ink : y >= 13 || x >= 13 ? dark : col);
      }
    const pen = (x: number, y: number) => {
      P(x, y, PAL.white);
      P(x + 1, y, PAL.white);
      P(x, y + 1, PAL.white);
      P(x + 1, y + 1, PAL.white);
    };
    if (mark === 'check') {
      for (let i = 0; i <= 3; i++) pen(3 + i, 7 + i);
      for (let i = 0; i <= 6; i++) pen(6 + i, 10 - i);
    } else {
      for (let i = 0; i <= 7; i++) {
        pen(3 + i, 3 + i);
        pen(10 - i, 3 + i);
      }
    }
  });
}

/** Огонь: язык пламени колышется (t — мс). */
function fire(t = 0): HTMLCanvasElement {
  const ph = (t / POST_EMOJI_MS) * Math.PI * 2;
  return inked(
    draw(14, 17, (P) => {
      for (let y = 0; y < 17; y++) {
        // чем выше, тем сильнее качает
        const sway = Math.round(Math.sin(ph * 2 + y * 0.45) * (1.6 * (1 - y / 17)));
        for (let x = 0; x < 14; x++) {
          const dx = x + 0.5 - 7 - sway;
          const dy = y + 0.5 - 11;
          // капля: круг снизу + сужение вверх
          const half = y >= 11 ? Math.sqrt(Math.max(0, 36 - dy * dy)) : 6 * Math.pow((y + 0.5) / 11.5, 1.15);
          const a = Math.abs(dx);
          if (a > half) continue;
          const k = half > 0 ? a / half : 1;
          const core = y > 6 && k < 0.45 && y < 15;
          const mid = y > 3 && k < 0.75;
          P(x, y, core ? PAL.yellow : mid ? PAL.orange : PAL.red);
        }
      }
    }),
  );
}

/** «REC»: красный огонёк мигает, под ним надпись. */
function rec(t = 0): HTMLCanvasElement {
  const on = t % 1000 < 600;
  const dot = on
    ? ['...oooo...', '.oorrrroo.', '.orwwrrro.', 'orwrrrrrro', 'orrrrrrrro', 'orrrrrrrro', 'orrrrrrrvo', '.orrrrrvo.', '.oorrrvoo.', '...oooo...']
    : ['...oooo...', '.oovvvvoo.', '.ovhvvvvo.', 'ovhvvvvvvo', 'ovvvvvvvvo', 'ovvvvvvvvo', 'ovvvvvvvqo', '.ovvvvvqo.', '.oovvvqoo.', '...oooo...'];
  const txt = [
    'ooooooooooooo',
    'owwoowwwoowwo',
    'owowowooowooo',
    'owwoowwoowooo',
    'owowowooowooo',
    'owowowwwoowwo',
    'ooooooooooooo',
  ];
  const { c, g } = canvas(13, 18);
  g.drawImage(rows(dot), 2, 0);
  g.drawImage(rows(txt), 0, 11);
  return c;
}

/** Искры ✨: три звёздочки мерцают по очереди. */
function sparkles(t = 0): HTMLCanvasElement {
  const spark = (P: (x: number, y: number, c: string) => void, cx: number, cy: number, r: number, hot: boolean) => {
    const body = hot ? PAL.white : PAL.yellow;
    for (let i = -r; i <= r; i++) {
      const w = Math.abs(i) < r / 2 ? 1 : 0;
      P(cx + i, cy, body);
      P(cx, cy + i, body);
      if (w && r > 2) {
        P(cx + i, cy + Math.sign(i || 1), PAL.yellow);
        P(cx + Math.sign(i || 1), cy + i, PAL.yellow);
      }
    }
    P(cx, cy, PAL.white);
  };
  const k = Math.floor((t % POST_EMOJI_MS) / (POST_EMOJI_MS / 3));
  return inked(
    draw(16, 16, (P) => {
      spark(P, 6, 9, k === 0 ? 6 : 5, k === 0);
      spark(P, 13, 3, k === 1 ? 3 : 2, k === 1);
      spark(P, 13, 13, k === 2 ? 2 : 1, k === 2);
    }),
  );
}

function eyes(): HTMLCanvasElement {
  const e = rows(EYE);
  const { c, g } = canvas(15, 10);
  g.drawImage(e, 0, 0);
  g.drawImage(e, 8, 0);
  return c;
}

/** Оглушённый актёр: ударил бота — над головой кружат звёздочки (как в игре). */
function stunned(t = 0): HTMLCanvasElement {
  const fr = actorFrame(F.STUN);
  const { c, g } = canvas(18, 18);
  g.drawImage(fr, 2, 0);
  const ph = (t / POST_EMOJI_MS) * Math.PI * 4;
  for (let k = 0; k < 3; k++) {
    const a = ph + (k / 3) * Math.PI * 2;
    const x = Math.round(9 + Math.cos(a) * 7.5);
    const y = Math.round(2 + Math.sin(a) * 1.5);
    const front = Math.sin(a) > 0;
    px(g, x, y, front ? PAL.yellow : PAL.amber);
    if (front) {
      px(g, x - 1, y, PAL.yellow);
      px(g, x + 1, y, PAL.yellow);
      px(g, x, y - 1, PAL.white);
    }
  }
  return c;
}

/** Актёр массовки из игры (обычный человечек парка). */
const actor = (frame: number) => () => actorFrame(frame);

export const POST_EMOJI: readonly PostEmoji[] = [
  { id: 'camera', emoji: '📹', name: 'Камера', art: () => rows(CAMERA) },
  { id: 'rec', emoji: '🔴', name: 'REC', art: rec, anim: true },
  { id: 'actor', emoji: '🧍', name: 'Массовка', art: actor(F.D) },
  { id: 'stunned', emoji: '😵', name: 'Оглушён', art: stunned, anim: true },
  { id: 'popcorn', emoji: '🍿', name: 'Попкорн', art: () => rows(POPCORN) },
  { id: 'ticket', emoji: '🎟️', name: 'Билет', art: () => rows(TICKET) },
  { id: 'fire', emoji: '🔥', name: 'Огонь', art: fire, anim: true },
  { id: 'sparkles', emoji: '✨', name: 'Искры', art: sparkles, anim: true },
  { id: 'bolt', emoji: '⚡', name: 'Удар', art: () => rows(BOLT) },
  { id: 'eyes', emoji: '👀', name: 'Глаза', art: eyes },
  { id: 'scissors', emoji: '✂️', name: 'Вырезан', art: () => rows(SCISSORS) },
  { id: 'pause', emoji: '⏸️', name: 'Стоп-кадр', art: () => rows(PAUSE) },
  { id: 'crown', emoji: '👑', name: 'Корона', art: () => rows(CROWN) },
  { id: 'medal', emoji: '🥇', name: 'Медаль', art: () => rows(MEDAL) },
  { id: 'chair', emoji: '🪑', name: 'Кресло', art: () => rows(CHAIR) },
  { id: 'mic', emoji: '🎤', name: 'Микрофон', art: () => rows(MIC) },
  { id: 'vhs', emoji: '📼', name: 'VHS', art: () => rows(VHS) },
  { id: 'peel', emoji: '🍌', name: 'Кожура', art: () => rows(PEEL) },
  { id: 'phone', emoji: '📱', name: 'Телефон', art: () => rows(PHONE) },
  { id: 'gift', emoji: '🎁', name: 'Подарок', art: () => rows(GIFT) },
  { id: 'popper', emoji: '🎉', name: 'Праздник', art: () => rows(POPPER) },
  { id: 'heart', emoji: '❤️', name: 'Сердце', art: () => rows(HEART) },
  { id: 'rocket', emoji: '🚀', name: 'Запуск', art: () => rows(ROCKET) },
  { id: 'clock', emoji: '⏰', name: 'Скоро', art: clock },
  { id: 'new', emoji: '🆕', name: 'NEW', art: () => rows(NEW) },
  { id: 'arrow', emoji: '👉', name: 'Стрелка', art: () => rows(ARROW) },
  { id: 'check', emoji: '✅', name: 'Да', art: () => box(PAL.green, PAL.forest, 'check') },
  { id: 'cross', emoji: '❌', name: 'Нет', art: () => box(PAL.red, PAL.wine, 'cross') },
  { id: 'question', emoji: '❓', name: 'Вопрос', art: () => rows(QUESTION) },
  { id: 'bang', emoji: '❗', name: 'Важно', art: () => rows(BANG) },
];

/** С белым контуром, без масштаба (до 20×20). */
export function postEmojiIcon(e: PostEmoji, t?: number): HTMLCanvasElement {
  const src = e.art(e.anim ? (t ?? 0) : undefined);
  const { c, g } = canvas(src.width + 2, src.height + 2);
  outlineOf(src.getContext('2d')!, src.width, src.height, g, 0, 0, PAL.white);
  g.drawImage(src, 1, 1);
  return c;
}

/** Файл для набора Telegram: 100×100, у всех один пиксель — ×5, по центру, фон прозрачный. */
export const POST_EMOJI_PX = 100;
export function postEmojiFile(e: PostEmoji, t?: number): HTMLCanvasElement {
  const ic = postEmojiIcon(e, t);
  const s = Math.min(5, Math.floor(POST_EMOJI_PX / Math.max(ic.width, ic.height)));
  const { c, g } = canvas(POST_EMOJI_PX, POST_EMOJI_PX);
  g.imageSmoothingEnabled = false;
  g.drawImage(ic, Math.floor((POST_EMOJI_PX - ic.width * s) / 2), Math.floor((POST_EMOJI_PX - ic.height * s) / 2), ic.width * s, ic.height * s);
  return c;
}
