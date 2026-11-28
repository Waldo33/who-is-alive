import { PAL } from '@kto/assets';
import { REWARDS } from '@kto/game-core';
import type { RewardId } from '@kto/game-core';
import { canvas } from '../pixels';
import { POST_EMOJI_MS, draw, inked, rows } from './post-emoji';
import type { PostEmoji } from './post-emoji';

/**
 * Эмодзи-награды личного пака игрока (решение владельца 28.11.2026): в пак сразу кладутся 30 общих эмодзи
 * (post-emoji.ts), а эти открываются за достижения — площадки, события матча, покупки. Рисунки не повторяют
 * ни общие, ни значки статуса. Тот же формат: до 18×18 + белый контур, в файле ×5 на 100×100.
 * Все награды анимированные (решение владельца): круг POST_EMOJI_MS, в наборе — видео-эмодзи. Кадр t = 0 —
 * он же картинка на странице — у каждой «спокойный» и законченный. Холст у всех кадров одного размера.
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

/** Доля круга анимации 0…1 и угол (k оборотов за круг). */
const at = (t: number) => (((t % POST_EMOJI_MS) + POST_EMOJI_MS) % POST_EMOJI_MS) / POST_EMOJI_MS;
const ang = (t: number, k = 1) => at(t) * Math.PI * 2 * k;
const INK = [0x18, 0x14, 0x25];

/** Блик: белая диагональная полоса проходит по рисунку (не по контуру) с доли from за долю len круга. */
function shine(src: HTMLCanvasElement, t: number, from = 0.15, len = 0.35): HTMLCanvasElement {
  const { c, g } = canvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  const u = (at(t) - from) / len;
  if (u < 0 || u > 1) return c;
  const { width: w, height: h } = c;
  const d = g.getImageData(0, 0, w, h);
  const p = Math.round(u * (w + h + 4)) - 3;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = x + y;
      if (s !== p && s !== p + 1) continue;
      const i = (y * w + x) * 4;
      if (!d.data[i + 3] || (d.data[i] === INK[0] && d.data[i + 1] === INK[1] && d.data[i + 2] === INK[2])) continue;
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    }
  g.putImageData(d, 0, 0);
  return c;
}

/** Подпрыгнуть n раз за круг на H точек (холст выше на H). */
function hop(src: HTMLCanvasElement, t: number, n = 1, H = 2): HTMLCanvasElement {
  const { c, g } = canvas(src.width, src.height + H);
  const q = (at(t) * n) % 1;
  const lift = q < 0.4 ? Math.round(Math.sin((q / 0.4) * Math.PI) * H) : 0;
  g.drawImage(src, 0, H - lift);
  return c;
}

/** Качнуться: строки сдвигаются тем сильнее, чем выше (низ стоит), amp — точек у верха. */
function sway(src: HTMLCanvasElement, t: number, amp = 1.5, k = 1): HTMLCanvasElement {
  const pad = Math.ceil(amp);
  const { c, g } = canvas(src.width + pad * 2, src.height);
  const s = Math.sin(ang(t, k));
  for (let y = 0; y < src.height; y++) {
    const dx = Math.round(s * amp * (1 - y / (src.height - 1)));
    g.drawImage(src, 0, y, src.width, 1, pad + dx, y, src.width, 1);
  }
  return c;
}

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
function helmet(t = 0): HTMLCanvasElement {
  // по стеклу проходит отблеск звезды, в стекле мигает звёздочка
  const u = (at(t) - 0.3) / 0.35;
  const band = u >= 0 && u <= 1 ? Math.round(-9 + u * 20) : 99;
  return inked(
    draw(16, 16, (P) => {
      disc(P, 8, 7.5, 7.6, (d, x, y) => (y >= 14 ? null : d > 6.6 ? PAL.mist : PAL.white));
      // стекло
      disc(P, 8, 7.5, 5, (_, x, y) => (y > 11 ? null : Math.abs(x - y - band) < 1 ? PAL.cyan : y < 5 && x < 7 ? PAL.cyan : PAL.navy));
      P(5, 4, PAL.white);
      P(6, 3, PAL.white);
      P(5, 5, PAL.white);
      const tw = Math.floor(at(t) * 4) % 2;
      P(10, 9, tw ? PAL.white : PAL.blue);
      if (tw) {
        P(9, 9, PAL.blue);
        P(11, 9, PAL.blue);
        P(10, 8, PAL.blue);
        P(10, 10, PAL.blue);
      }
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
const CUP = [
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
function coffee(t = 0): HTMLCanvasElement {
  const { c, g } = canvas(16, 15);
  g.drawImage(rows(CUP), 0, 4);
  // две струйки пара: волна бежит вверх
  for (const [bx, k] of [[4, 0], [8, 1.7]] as const)
    for (let y = 0; y < 4; y++) {
      const x = bx + Math.round(Math.sin(y * 1.3 + ang(t, 2) + k) * 0.9);
      g.fillStyle = y === 0 ? PAL.slate : PAL.mist;
      g.fillRect(x, y, 1, 1);
    }
  return c;
}

/** Майами: пальма на закате. */
function palm(t = 0): HTMLCanvasElement {
  const wave = Math.floor(at(t) * 6) % 3;
  const lean = Math.round(Math.sin(ang(t)) * 0.8);
  return inked(
    draw(16, 16, (P) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          if ((x === 0 || x === 15) && (y === 0 || y === 15)) continue;
          const c = y < 4 ? PAL.grape : y < 7 ? PAL.orchid : y < 10 ? PAL.coral : y < 11 ? PAL.orange : PAL.navy;
          P(x, y, c);
        }
      disc(P, 10, 11, 3.6, (_, x, y) => (y < 11 ? PAL.yellow : null), 16, 16);
      // волны бегут, на воде дрожит дорожка солнца
      for (const y of [12, 14]) for (let x = 1 + ((y % 3) + wave) % 3; x < 15; x += 3) P(x, y, PAL.blue);
      if (wave !== 1) P(10, 12, PAL.yellow);
      if (wave !== 2) P(9, 13, PAL.amber);
      // ствол
      for (const [x, y] of [[4, 15], [4, 14], [5, 13], [5, 12], [5, 11], [6, 10], [6, 9], [6, 8], [7, 7], [7, 6]] as const) P(x, y, PAL.ink);
      // листья
      // листья на ветру
      for (const [x, y] of [[8, 5], [9, 5], [10, 5], [11, 6], [6, 5], [5, 5], [4, 6], [3, 7], [7, 4], [8, 3], [9, 3], [10, 3], [6, 3], [5, 3], [4, 4], [11, 4], [12, 5]] as const)
        P(x + (y < 5 ? lean : 0), y, PAL.ink);
    }),
  );
}

/** Вечеринка: диско-шар. */
function disco(t = 0): HTMLCanvasElement {
  const off = Math.floor(at(t) * 8) % 4;
  const tw = Math.floor(at(t) * 4);
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
          const tile = (Math.floor((x + off) / 2) + Math.floor(y / 2)) % 2;
          if (x < 7 && y < 9) return tile ? PAL.white : PAL.cyan;
          return tile ? PAL.mist : PAL.slate;
        },
        16,
        18,
      );
      // зайчики вспыхивают по очереди
      const [sx, sy] = ([[14, 4], [2, 5], [14, 15], [1, 14]] as const)[tw]!;
      for (const [x, y] of [[sx - 1, sy], [sx + 1, sy], [sx, sy - 1], [sx, sy + 1]] as const) P(x, y, PAL.yellow);
      P(sx, sy, PAL.white);
    }),
  );
}

/** Купала: цветок папоротника. */
function fern(t = 0): HTMLCanvasElement {
  const rot = (at(t) * Math.PI * 2) / 6;
  const hot = Math.sin(ang(t, 2)) > 0;
  return inked(
    draw(16, 18, (P) => {
      // стебель и листья
      for (let y = 9; y < 18; y++) P(8, y, PAL.forest);
      for (const [x, y] of [[7, 13], [6, 13], [5, 12], [9, 15], [10, 15], [11, 14], [7, 16], [6, 16]] as const) P(x, y, PAL.green);
      // лепестки огнём
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 - Math.PI / 2 + rot;
        disc(P, 8 + Math.cos(a) * 4, 6.5 + Math.sin(a) * 4, 2.6, (d) => (d > 1.6 ? PAL.red : PAL.orange), 16, 18);
      }
      disc(P, 8, 6.5, 2.4, (d) => (d > (hot ? 1.8 : 1.2) ? PAL.yellow : PAL.white), 16, 18);
    }),
  );
}

/** Казино: игральная кость. */
const PIPS: Record<number, [number, number][]> = {
  1: [[6, 6]],
  2: [[3, 3], [9, 9]],
  3: [[3, 3], [6, 6], [9, 9]],
  4: [[3, 3], [9, 3], [3, 9], [9, 9]],
  5: [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]],
  6: [[3, 3], [9, 3], [3, 6], [9, 6], [3, 9], [9, 9]],
};
const ROLL = [5, 2, 6, 3, 1, 4];
function dice(t = 0): HTMLCanvasElement {
  const face = ROLL[Math.floor(at(t) * ROLL.length) % ROLL.length]!;
  return hop(diceFace(face), t, ROLL.length, 2);
}
function diceFace(face: number): HTMLCanvasElement {
  return inked(
    draw(15, 15, (P) => {
      for (let y = 0; y < 15; y++)
        for (let x = 0; x < 15; x++) {
          if ((x === 0 || x === 14) && (y === 0 || y === 14)) continue;
          P(x, y, x >= 12 || y >= 12 ? PAL.mist : PAL.white);
        }
      for (const [x, y] of PIPS[face]!) {
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
function crystal(t = 0): HTMLCanvasElement {
  return inked(
    draw(16, 17, (P) => {
      disc(P, 8, 7, 7, (d, x, y) => (d > 6 ? PAL.grape : x < 7 && y < 6 ? PAL.orchid : PAL.grape), 16, 17);
      disc(P, 8, 7, 5.2, (d, x, y) => (x < 7 && y < 6 ? PAL.coral : null), 16, 17);
      P(5, 3, PAL.white);
      P(4, 4, PAL.white);
      // внутри кружат три огонька
      for (let k = 0; k < 3; k++) {
        const a = ang(t) + (k / 3) * Math.PI * 2;
        P(Math.round(8 + Math.cos(a) * 3.2), Math.round(7.5 + Math.sin(a) * 2.2), k ? PAL.cyan : PAL.white);
      }
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
function target(t = 0): HTMLCanvasElement {
  // t = 0 — стрела уже в центре; во второй половине круга — улетает, прилетает новая и дрожит
  const q = (at(t) + 0.5) % 1;
  const gone = q > 0.92;
  const o = q < 0.2 ? Math.round((1 - q / 0.2) * 9) : 0;
  const quiver = q >= 0.2 && q < 0.4 ? Math.floor(t / 50) % 2 : 0;
  return inked(
    draw(17, 17, (P) => {
      disc(P, 8, 9, 7.6, (d) => (d > 6.2 ? PAL.red : d > 4.6 ? PAL.white : d > 3 ? PAL.red : d > 1.5 ? PAL.white : PAL.red), 17, 17);
      // стрела в центр
      if (gone) return;
      const A = (x: number, y: number, c: string, i: number) => {
        const qx = x + o + (i > 2 ? quiver : 0);
        const qy = y - o;
        if (qx < 17 && qy >= 0) P(qx, qy, c);
      };
      for (let i = 0; i < 7; i++) A(9 + i, 8 - i, PAL.umber, i);
      for (const [x, y] of [[15, 0], [16, 1], [14, 0], [16, 2], [15, 2], [14, 1]] as const) A(x, y, PAL.yellow, 6);
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
function disguise(t = 0): HTMLCanvasElement {
  const q = at(t);
  const up = (q > 0.15 && q < 0.25) || (q > 0.35 && q < 0.45) ? 1 : 0;
  const tw = q > 0.6 && q < 0.8 ? Math.floor(t / 100) % 2 : 0;
  const top = rows(DISGUISE.slice(0, 5));
  const nose = rows(DISGUISE.slice(5, 8));
  const tash = rows(DISGUISE.slice(8));
  const { c, g } = canvas(15, 13);
  g.drawImage(nose, 0, 6);
  g.drawImage(top, 0, 1 - up);
  g.drawImage(tash, 0, 9 - tw);
  return c;
}

/** «Параноик»: перепуганное лицо, руки у щёк. */
function scream(t = 0): HTMLCanvasElement {
  const look = Math.floor(t / 250) % 2;
  // лицо трясётся между ладоней
  const dx = at(t) < 0.5 ? (Math.floor(t / 100) % 2 ? 1 : -1) : 0;
  return inked(
    draw(18, 18, (H) => {
      const P = (x: number, y: number, c: string) => H(x + dx, y, c);
      disc(P, 9, 9, 8, (d, x, y) => (d > 7 ? PAL.amber : y < 4 ? PAL.mist : PAL.yellow));
      // глаза
      for (const ex of [5, 11]) {
        for (let y = 5; y < 9; y++) {
          P(ex, y, PAL.white);
          P(ex + 1, y, PAL.white);
        }
        P(ex + look, 7, PAL.ink);
        P(ex + look, 6, PAL.ink);
      }
      // рот «О»
      for (let y = 11; y < 16; y++) {
        P(8, y, PAL.ink);
        P(9, y, PAL.ink);
      }
      P(7, 12, PAL.ink); P(10, 12, PAL.ink); P(7, 14, PAL.ink); P(10, 14, PAL.ink); P(7, 13, PAL.ink); P(10, 13, PAL.ink);
      // руки
      for (const hx of [0, 15]) for (let y = 10; y < 17; y++) for (let x = 0; x < 3; x++) H(hx + x, y, x === 1 && y > 11 ? PAL.peach : PAL.tan);
    }),
  );
}

/** Три звезды: тройка звёздочек со следом. */
function starTrio(t = 0): HTMLCanvasElement {
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
        const a = (k / 24) * Math.PI * 1.6 + 0.6 + ang(t);
        const r = 3 + k * 0.22;
        P(Math.round(8 + Math.cos(a) * r), Math.round(9 + Math.sin(a) * r * 0.7), k % 3 ? PAL.amber : PAL.orange);
      }
      // три звезды по кругу: ближняя — большая
      const st = [0, 1, 2].map((k) => {
        const a = ang(t) - Math.PI / 2 + (k / 3) * Math.PI * 2;
        return { x: Math.round(8 + Math.cos(a) * 5), y: Math.round(8.5 + Math.sin(a) * 4), big: k === 0 };
      });
      for (const s of st.filter((s) => !s.big)) star(P, s.x, s.y, false);
      star(P, st[0]!.x, st[0]!.y, true);
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
function bandage(t = 0): HTMLCanvasElement {
  return shine(bandageArt(t), t, 0.1, 0.35);
}
function bandageArt(t: number): HTMLCanvasElement {
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
      // «зажило»: искорка у края
      const q = at(t);
      if (q > 0.55 && q < 0.8) {
        const r = q > 0.62 && q < 0.72 ? 2 : 1;
        for (let i = -r; i <= r; i++) {
          P(14 + i, 13, PAL.yellow);
          P(14, 13 + i, PAL.yellow);
        }
        P(14, 13, PAL.white);
      }
    }),
  );
}

/** 777 в «Крутке»: монета с семёркой. */
function coin(t = 0): HTMLCanvasElement {
  // монета вертится: ширина — |cos|, ребром — полоска; семёрка видна, пока монета широкая
  const s = Math.abs(Math.cos(ang(t)));
  const rx = Math.max(1, 7.8 * s);
  return inked(
    draw(16, 16, (P) => {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const nx = (x + 0.5 - 8) / rx;
          const ny = (y + 0.5 - 8) / 7.8;
          const d = Math.hypot(nx, ny);
          if (d >= 1) continue;
          if (rx < 2) {
            P(x, y, PAL.amber);
            continue;
          }
          const dd = d * 7.8;
          P(x, y, dd > 6.8 ? PAL.amber : dd > 5.6 ? PAL.yellow : nx + ny < -0.1 ? PAL.yellow : PAL.amber);
        }
      if (s > 0.55) {
        const seven = ['wwwww', '...wo', '..wo.', '..wo.', '.wo..', '.wo..', '.wo..'];
        seven.forEach((r, y) => [...r].forEach((ch, x) => ch !== '.' && P(Math.round(8 + (6 + x + 0.5 - 8) * s - 0.5), 4 + y, ch === 'w' ? PAL.white : PAL.umber)));
        P(Math.round(8 - 4 * s), 3, PAL.white);
      }
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
function cat(t = 0): HTMLCanvasElement {
  const q = at(t);
  const r = [...CAT];
  if ((q > 0.3 && q < 0.36) || (q > 0.42 && q < 0.48)) {
    r[6] = 'osssssssssssssso';
    r[7] = 'ossooossssooosso';
  }
  if (q > 0.7 && q < 0.8) {
    r[0] = '.............oo.';
    r[1] = '.ooo........osso';
    r[2] = 'ossso......oshso';
  }
  return rows(r);
}

/** Эффект: палитра художника. */
const PAINTS = [PAL.red, PAL.yellow, PAL.green, PAL.blue, PAL.magenta];
function palette(t = 0): HTMLCanvasElement {
  const k = Math.floor(at(t) * PAINTS.length);
  const paint = (i: number) => PAINTS[(i + k) % PAINTS.length]!;
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
      blob(4, 6, paint(0));
      blob(6, 3, paint(1));
      blob(10, 2, paint(2));
      blob(14, 4, paint(3));
      blob(5, 10, paint(4));
      blob(8, 11, PAL.white);
    }),
  );
}

/** Эмодзи награды — из game-core (по нему бот узнаёт картинку в наборе). */
const R = (id: RewardId, _hint: string, name: string, art: (t?: number) => HTMLCanvasElement): PostEmoji => ({ id, emoji: REWARDS.find((r) => r.id === id)!.emoji, name, art, anim: true });

/** Награды личного пака: id → эмодзи и рисунок. За что даётся — решает game-core. */
export const REWARD_EMOJI: readonly PostEmoji[] = [
  R('th_caps', '🧢', 'Парк', (t = 0) => hop(shine(rows(CAP), t, 0.5, 0.3), t)),
  R('th_chefs', '🧑‍🍳', 'Повара', (t = 0) => shine(sway(rows(CHEF), t, 1.2), t, 0.55, 0.3)),
  R('th_penguins', '🐧', 'Пингвины', (t = 0) => sway(rows(PENGUIN), t, 1.5, 2)),
  R('th_cosmonauts', '🧑‍🚀', 'Космонавты', helmet),
  R('th_office', '☕', 'Офис', coffee),
  R('th_miami', '🌴', 'Майами', palm),
  R('th_party', '🪩', 'Вечеринка', disco),
  R('th_kupala', '🌿', 'Купала', fern),
  R('th_casino', '🎲', 'Казино', dice),
  R('ev_clairvoyant', '🔮', 'Угадал', crystal),
  R('ev_accuse', '🎯', 'Метка', target),
  R('ev_unsuspected', '🥸', 'Чистая массовка', disguise),
  R('ev_paranoid', '😱', 'Параноик', scream),
  R('ev_stars', '💫', 'Три звезды', starTrio),
  R('ev_survive', '🛡️', 'Дожил', (t = 0) => hop(shine(rows(SHIELD), t, 0.35, 0.35), t, 1, 1)),
  R('ev_cut', '🩹', 'Вырезан', bandage),
  R('ev_jackpot', '🪙', '777', coin),
  R('buy_kotBanan', '🐱', 'Кот-банан', cat),
  R('buy_effect', '🎨', 'Эффект', palette),
];
