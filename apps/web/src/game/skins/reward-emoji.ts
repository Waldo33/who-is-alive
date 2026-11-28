import { PAL } from '@kto/assets';
import { REWARDS } from '@kto/game-core';
import type { RewardId } from '@kto/game-core';
import { draw, inked, rows } from './post-emoji';
import type { PostEmoji } from './post-emoji';

/**
 * Эмодзи-награды личного пака игрока (решение владельца 28.11.2026): в пак сразу кладутся 30 общих эмодзи
 * (post-emoji.ts), а эти открываются за достижения — площадки, события матча, покупки. Рисунки не повторяют
 * ни общие, ни значки статуса. Тот же формат: до 18×18 + белый контур, в файле ×5 на 100×100.
 */

type P = (x: number, y: number, c: string) => void;
const disc = (P: P, cx: number, cy: number, r: number, col: (d: number, x: number, y: number) => string | null, w = 18, h = 18) => {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < r) {
        const c = col(d, x, y);
        if (c) P(x, y, c);
      }
    }
};

// ───────────── площадки ─────────────

/** Парк: кепка. */
const CAP = [
  '....oooooo........',
  '..oobbbbbboo......',
  '.obbwwbbbbbbo.....',
  'obbwbbbbbbbbbo....',
  'obbbbbbbbbbbbbo...',
  'obbbbbbbbbbbbbo...',
  'onbbbbbbbbbbbbnooo',
  'onnnnnnnnnnnnnnnno',
  '.oooooooooooooooo.',
];

/** Повара: колпак. */
const CHEF = [
  '...oooo.ooo...',
  '..owwwwowwwo..',
  '.owwwwwwwwwwo.',
  'owwwwwwwwwwwmo',
  'owwwwwwwwwwmmo',
  '.owwwwwwwwwmo.',
  '..owwwwwwwmo..',
  '..owwwwwwwmo..',
  '..oooooooooo..',
  '..owmwmwmwmo..',
  '..owwwwwwwmo..',
  '..oooooooooo..',
];

/** Пингвин. */
const PENGUIN = [
  '...oooooo...',
  '..okkkkkko..',
  '.okkwwwwkko.',
  '.okwowwowko.',
  '.okwwffwwko.',
  '.okkwffwkko.',
  'okkkwwwwkkko',
  'okkwwwwwwkko',
  'okowwwwwwoko',
  'oo.owwwwo.oo',
  '...owwwwo...',
  '...owwwmo...',
  '..oowwmmoo..',
  '.offoooooffo',
  '.oooo..oooo.',
];

/** Космонавты: шлем со стеклом. */
function helmet(): HTMLCanvasElement {
  return inked(
    draw(16, 16, (P) => {
      disc(P, 8, 7.5, 7.6, (d, x, y) => (y >= 14 ? null : d > 6.6 ? PAL.mist : PAL.white));
      // стекло
      disc(P, 8, 7.5, 5, (_, x, y) => (y > 11 ? null : y < 5 && x < 7 ? PAL.cyan : PAL.navy));
      P(5, 4, PAL.white);
      P(6, 3, PAL.white);
      P(5, 5, PAL.white);
      // воротник
      for (let x = 2; x < 14; x++) {
        P(x, 14, PAL.slate);
        P(x, 15, PAL.steel);
      }
      P(4, 14, PAL.red);
      P(5, 14, PAL.red);
    }),
  );
}

/** Офис: кофе. */
const COFFEE = [
  '....m...m.......',
  '...m...m........',
  '....m...m.......',
  '................',
  'oooooooooooo....',
  'owuuuuuuuuwo....',
  'owwwwwwwwwwoooo.',
  'owwwwwwwwwwo..oo',
  'owwrrrwwwwwo..oo',
  'owwrrrwwwwmoooo.',
  '.owwwwwwwmo.....',
  '..oooooooo......',
  'oooooooooooooo..',
  '.ommmmmmmmmmo...',
  '..oooooooooo....',
];

/** Майами: пальма на закате. */
function palm(): HTMLCanvasElement {
  return inked(
    draw(16, 16, (P) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if ((x === 0 || x === 15) && (y === 0 || y === 15)) continue;
          const c = y < 4 ? PAL.grape : y < 7 ? PAL.orchid : y < 10 ? PAL.coral : y < 11 ? PAL.orange : PAL.navy;
          P(x, y, c);
        }
      disc(P, 10, 11, 3.6, (_, x, y) => (y < 11 ? PAL.yellow : null), 16, 16);
      for (const y of [12, 14]) for (let x = 2 + (y % 3); x < 14; x += 3) P(x, y, PAL.blue);
      // ствол
      for (const [x, y] of [[4, 15], [4, 14], [5, 13], [5, 12], [5, 11], [6, 10], [6, 9], [6, 8], [7, 7], [7, 6]] as const) P(x, y, PAL.ink);
      // листья
      for (const [x, y] of [[8, 5], [9, 5], [10, 5], [11, 6], [6, 5], [5, 5], [4, 6], [3, 7], [7, 4], [8, 3], [9, 3], [10, 3], [6, 3], [5, 3], [4, 4], [11, 4], [12, 5]] as const) P(x, y, PAL.ink);
    }),
  );
}

/** Вечеринка: диско-шар. */
function disco(): HTMLCanvasElement {
  return inked(
    draw(16, 18, (P) => {
      for (let y = 0; y < 3; y++) P(8, y, PAL.slate);
      disc(
        P,
        8.5,
        10,
        7.2,
        (d, x, y) => {
          if (d > 6.3) return PAL.steel;
          const tile = (Math.floor(x / 2) + Math.floor(y / 2)) % 2;
          if (x < 7 && y < 9) return tile ? PAL.white : PAL.cyan;
          return tile ? PAL.mist : PAL.slate;
        },
        16,
        18,
      );
      for (const [x, y] of [[13, 4], [14, 3], [15, 4], [14, 5]] as const) P(x, y, PAL.yellow);
      P(14, 4, PAL.white);
    }),
  );
}

/** Купала: цветок папоротника. */
function fern(): HTMLCanvasElement {
  return inked(
    draw(16, 18, (P) => {
      // стебель и листья
      for (let y = 9; y < 18; y++) P(8, y, PAL.forest);
      for (const [x, y] of [[7, 13], [6, 13], [5, 12], [9, 15], [10, 15], [11, 14], [7, 16], [6, 16]] as const) P(x, y, PAL.green);
      // лепестки огнём
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
        disc(P, 8 + Math.cos(a) * 4, 6.5 + Math.sin(a) * 4, 2.6, (d) => (d > 1.6 ? PAL.red : PAL.orange), 16, 18);
      }
      disc(P, 8, 6.5, 2.4, (d) => (d > 1.2 ? PAL.yellow : PAL.white), 16, 18);
    }),
  );
}

/** Казино: игральная кость. */
function dice(): HTMLCanvasElement {
  return inked(
    draw(15, 15, (P) => {
      for (let y = 0; y < 15; y++)
        for (let x = 0; x < 15; x++) {
          if ((x === 0 || x === 14) && (y === 0 || y === 14)) continue;
          P(x, y, x >= 12 || y >= 12 ? PAL.mist : PAL.white);
        }
      for (const [x, y] of [[3, 3], [10, 3], [6, 6], [3, 9], [10, 9]] as const) {
        P(x, y, PAL.red);
        P(x + 1, y, PAL.red);
        P(x, y + 1, PAL.wine);
        P(x + 1, y + 1, PAL.wine);
      }
    }),
  );
}

// ───────────── события матча ─────────────

/** Угадал из-за кадра: хрустальный шар. */
function crystal(): HTMLCanvasElement {
  return inked(
    draw(16, 17, (P) => {
      disc(P, 8, 7, 7, (d, x, y) => (d > 6 ? PAL.grape : x < 7 && y < 6 ? PAL.orchid : PAL.grape), 16, 17);
      disc(P, 8, 7, 5.2, (d, x, y) => (x < 7 && y < 6 ? PAL.coral : null), 16, 17);
      P(5, 3, PAL.white);
      P(4, 4, PAL.white);
      P(10, 8, PAL.cyan);
      P(9, 10, PAL.cyan);
      for (let x = 3; x < 13; x++) P(x, 14, PAL.umber);
      for (let x = 2; x < 14; x++) {
        P(x, 15, PAL.umber);
        P(x, 16, PAL.ink);
      }
      for (let x = 4; x < 12; x++) P(x, 14, PAL.fawn);
    }),
  );
}

/** Поставил метку: мишень со стрелой. */
function target(): HTMLCanvasElement {
  return inked(
    draw(17, 17, (P) => {
      disc(P, 8, 9, 7.6, (d) => (d > 6.2 ? PAL.red : d > 4.6 ? PAL.white : d > 3 ? PAL.red : d > 1.5 ? PAL.white : PAL.red), 17, 17);
      // стрела в центр
      for (let i = 0; i < 7; i++) P(9 + i, 8 - i, PAL.umber);
      for (const [x, y] of [[15, 0], [16, 1], [14, 0], [16, 2], [15, 2], [14, 1]] as const) P(x, y, PAL.yellow);
    }),
  );
}

/** «Чистая массовка»: очки с носом и усами. */
const DISGUISE = [
  '.oooo.....oooo.',
  'ommmmo...ommmmo',
  'omwwmooooomwwmo',
  'ommmmo.o.ommmmo',
  '.oooo.opo.oooo.',
  '.....oppo......',
  '....opppo......',
  '..ooopppoooo...',
  '.ouuuuoouuuuo..',
  'ouuuuuuuuuuuuo.',
  'ouuuo....ouuuo.',
  '.ooo......ooo..',
];

/** «Параноик»: перепуганное лицо, руки у щёк. */
function scream(): HTMLCanvasElement {
  return inked(
    draw(18, 18, (P) => {
      disc(P, 9, 9, 8, (d, x, y) => (d > 7 ? PAL.amber : y < 4 ? PAL.mist : PAL.yellow));
      // глаза
      for (const ex of [5, 11]) {
        for (let y = 5; y < 9; y++) {
          P(ex, y, PAL.white);
          P(ex + 1, y, PAL.white);
        }
        P(ex, 7, PAL.ink);
        P(ex + 1, 7, PAL.ink);
      }
      // рот «О»
      for (let y = 11; y < 16; y++) {
        P(8, y, PAL.ink);
        P(9, y, PAL.ink);
      }
      P(7, 12, PAL.ink); P(10, 12, PAL.ink); P(7, 14, PAL.ink); P(10, 14, PAL.ink); P(7, 13, PAL.ink); P(10, 13, PAL.ink);
      // руки
      for (const hx of [0, 15]) for (let y = 10; y < 17; y++) for (let x = 0; x < 3; x++) P(hx + x, y, x === 1 && y > 11 ? PAL.peach : PAL.tan);
    }),
  );
}

/** Три звезды: тройка звёздочек со следом. */
function starTrio(): HTMLCanvasElement {
  const star = (P: P, cx: number, cy: number, big: boolean) => {
    const r = big ? 2 : 1;
    for (let i = -r - 1; i <= r + 1; i++) {
      P(cx + i, cy, PAL.yellow);
      P(cx, cy + i, PAL.yellow);
    }
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (Math.abs(x) + Math.abs(y) <= r) P(cx + x, cy + y, PAL.yellow);
    P(cx, cy, PAL.white);
    if (big) P(cx - 1, cy - 1, PAL.white);
  };
  return inked(
    draw(17, 17, (P) => {
      // след-вихрь
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 1.6 + 0.6;
        const r = 3 + k * 0.22;
        P(Math.round(8 + Math.cos(a) * r), Math.round(9 + Math.sin(a) * r * 0.7), k % 3 ? PAL.amber : PAL.orange);
      }
      star(P, 8, 4, true);
      star(P, 3, 12, false);
      star(P, 13, 12, false);
    }),
  );
}

/** Дожил до конца дубля: щит. */
const SHIELD = [
  'oooooooooooooo',
  'obbbbbbccccbbo',
  'obbbbbbccccbno',
  'obwbbbbccccbno',
  'obbbbbbccccbno',
  'occcccccccccco',
  'occcccccccccco',
  'obbbbbbccccbno',
  'obbbbbbccccbno',
  '.obbbbbccccno.',
  '.obbbbbccccno.',
  '..obbbbcccno..',
  '...obbbccno...',
  '....obbcno....',
  '.....oooo.....',
];

/** Вырезан: пластырь. */
function bandage(): HTMLCanvasElement {
  return inked(
    draw(17, 17, (P) => {
      for (let y = 0; y < 17; y++)
        for (let x = 0; x < 17; x++) {
          // полоса по диагонали
          const u = (x - y) / Math.SQRT2;
          const v = (x + y - 16) / Math.SQRT2;
          if (Math.abs(u) > 3.3 || Math.abs(v) > 10.5) continue;
          const pad = Math.abs(v) < 3.6;
          P(x, y, pad ? ((x + y) % 3 === 0 ? PAL.tan : PAL.sand) : Math.abs(u) > 2.4 ? PAL.fawn : PAL.peach);
        }
      for (const [x, y] of [[4, 11], [11, 4], [3, 13], [13, 3]] as const) P(x, y, PAL.fawn);
    }),
  );
}

/** 777 в «Крутке»: монета с семёркой. */
function coin(): HTMLCanvasElement {
  return inked(
    draw(16, 16, (P) => {
      disc(P, 8, 8, 7.8, (d, x, y) => (d > 6.8 ? PAL.amber : d > 5.6 ? PAL.yellow : x + y < 12 ? PAL.yellow : PAL.amber), 16, 16);
      const seven = ['wwwww', '...wo', '..wo.', '..wo.', '.wo..', '.wo..', '.wo..'];
      seven.forEach((r, y) => [...r].forEach((ch, x) => ch !== '.' && P(6 + x, 4 + y, ch === 'w' ? PAL.white : PAL.umber)));
      P(4, 3, PAL.white);
    }),
  );
}

// ───────────── покупки ─────────────

/** Кот-банан: кошачья морда (серый кот скина). */
const CAT = [
  '.oo..........oo.',
  'osso........osso',
  'oshso......oshso',
  'oshhsoooooosshso',
  'osssssssssssssso',
  'osssssssssssssso',
  'ossooossssooosso',
  'ossowossssowosso',
  'oswsssshhssssswo',
  'owwwsssoossswwwo',
  '.owwssswwssswwo.',
  '..owwwwwwwwwwo..',
  '...oooooooooo...',
];

/** Эффект: палитра художника. */
function palette(): HTMLCanvasElement {
  return inked(
    draw(18, 15, (P) => {
      for (let y = 0; y < 15; y++)
        for (let x = 0; x < 18; x++) {
          const d = Math.hypot((x + 0.5 - 9) / 9, (y + 0.5 - 7.5) / 7.5);
          if (d > 1) continue;
          if (Math.hypot(x + 0.5 - 12.5, y + 0.5 - 10.5) < 2) continue; // дырка под палец
          P(x, y, d > 0.85 ? PAL.fawn : PAL.tan);
        }
      const blob = (cx: number, cy: number, c: string) => {
        P(cx, cy, c);
        P(cx + 1, cy, c);
        P(cx, cy + 1, c);
        P(cx + 1, cy + 1, c);
      };
      blob(4, 6, PAL.red);
      blob(6, 3, PAL.yellow);
      blob(10, 2, PAL.green);
      blob(14, 4, PAL.blue);
      blob(5, 10, PAL.magenta);
      blob(8, 11, PAL.white);
    }),
  );
}

/** Эмодзи награды — из game-core (по нему бот узнаёт картинку в наборе). */
const R = (id: RewardId, _hint: string, name: string, art: () => HTMLCanvasElement): PostEmoji => ({ id, emoji: REWARDS.find((r) => r.id === id)!.emoji, name, art });

/** Награды личного пака: id → эмодзи и рисунок. За что даётся — решает game-core. */
export const REWARD_EMOJI: readonly PostEmoji[] = [
  R('th_caps', '🧢', 'Парк', () => rows(CAP)),
  R('th_chefs', '🧑‍🍳', 'Повара', () => rows(CHEF)),
  R('th_penguins', '🐧', 'Пингвины', () => rows(PENGUIN)),
  R('th_cosmonauts', '🧑‍🚀', 'Космонавты', helmet),
  R('th_office', '☕', 'Офис', () => rows(COFFEE)),
  R('th_miami', '🌴', 'Майами', palm),
  R('th_party', '🪩', 'Вечеринка', disco),
  R('th_kupala', '🌿', 'Купала', fern),
  R('th_casino', '🎲', 'Казино', dice),
  R('ev_clairvoyant', '🔮', 'Угадал', crystal),
  R('ev_accuse', '🎯', 'Метка', target),
  R('ev_unsuspected', '🥸', 'Чистая массовка', () => rows(DISGUISE)),
  R('ev_paranoid', '😱', 'Параноик', scream),
  R('ev_stars', '💫', 'Три звезды', starTrio),
  R('ev_survive', '🛡️', 'Дожил', () => rows(SHIELD)),
  R('ev_cut', '🩹', 'Вырезан', bandage),
  R('ev_jackpot', '🪙', '777', coin),
  R('buy_kotBanan', '🐱', 'Кот-банан', () => rows(CAT)),
  R('buy_effect', '🎨', 'Эффект', palette),
];
