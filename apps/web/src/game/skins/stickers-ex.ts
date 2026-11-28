import { PAL } from '@kto/assets';
import type { Lang, StickerId } from '@kto/game-core';
import { DICTS } from '@kto/game-core';
import { F } from '../sprites';
import type { Ctx } from '../pixels';
import { disc, extinguisherFrame, flame } from './extinguisher';
import { R, cap, put, star } from './stickers';
import type { Art } from './stickers';

/**
 * Стикеры набора «Огнетушка»: вокруг горит, а он по сценарию. Холст 96×96, фигурка ×2 (кадр 18×30 → 36×60),
 * как у Кот-банана. «Пшшш!» — петля на 3 с (30 кадров): брызгает в экран, пена заливает кадр, туман
 * расходится клубами, по «стеклу» стекают капли. Остальные — обычные 20 кадров.
 */

/** Числами — модуль грузится раньше stickers.ts (циклический импорт). */
const MID = 48;
const K = 2;
const CX = MID - 18;
/** Кадров у «Пшшш!»: 3 с по 100 мс — предел видеостикера Telegram. */
export const SPRAY_FRAMES = 30;

/** Подпись: одна строка — ниже, две — выше. */
const capAt = (g: Ctx, id: StickerId, lang: Lang, col?: string) => cap(g, id, lang, DICTS[lang].shop.stickers[id].length > 1 ? 76 : 84, col);

/** Пламя по бокам кадра: языки дышат по кадру `t`. */
function fireSides(g: Ctx, t: number, base = 72, tall = 1): void {
  const L: [number, number, number][] = [[8, 10, 30], [17, 12, 44], [26, 8, 24], [70, 8, 26], [79, 12, 46], [88, 10, 32]];
  L.forEach(([x, w, h], i) => flame(g, x, base, w + ((t + i) % 2), Math.round((h + (((t + i * 3) % 4) - 1) * 3) * tall)));
}

/** Повторяемый «случай»: одно и то же в браузере и на сервере. */
function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ── «Пшшш!»: облако из клубов ──
const CLX = MID;
const CLY = MID + 2;
const PUFFS: [number, number, number, number][] = (() => {
  const r = rnd(7);
  const out: [number, number, number, number][] = [[0, 0, 17, 0]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    out.push([Math.cos(a) * 16, Math.sin(a) * 14, 14 + (r() * 3 - 1), 0.15]);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.1;
    out.push([Math.cos(a) * 31, Math.sin(a) * 28, 11 + (r() * 3.5 - 1), 0.3]);
  }
  return out;
})();
const SPLASH: [number, number, number][] = (() => {
  const r = rnd(11);
  return Array.from({ length: 16 }, () => [r() * Math.PI * 2, 0.7 + r() * 0.3, 10 + Math.floor(r() * 3)] as [number, number, number]);
})();
const DRIPS: [number, number, number, number][] = [
  [12, 16, 15, 0.8],
  [82, 20, 16, 0.7],
  [16, 62, 17, 0.9],
  [80, 56, 15, 0.6],
  [30, 8, 16, 1],
  [66, 8, 17, 0.75],
];
const ease = (x: number) => {
  const v = Math.max(0, Math.min(1, x));
  return v * v * (3 - 2 * v);
};

/** Клубы на кадре `t`: [x, y, r]. Наконечник — в (nx, ny). */
function puffsAt(t: number, nx: number, ny: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  PUFFS.forEach(([hx, hy, r, delay], i) => {
    if (t >= 7 && t <= 11) {
      const k = ease(((t - 6) / 5) * 1.4 - delay);
      if (k <= 0) return;
      out.push([nx + (CLX + hx - nx) * k, ny + (CLY + hy - ny) * k, 1.5 + (r - 1.5) * k]);
    } else if (t >= 12 && t <= 14) {
      out.push([CLX + hx, CLY + hy, r * (1 + 0.04 * Math.sin(t * 2 + i))]);
    } else if (t >= 15 && t <= 24) {
      const k = (t - 14) / 10;
      const d = Math.hypot(hx, hy) || 1;
      const [dx, dy] = i ? [hx / d, hy / d] : [0, -1];
      const mv = 4 + k ** 1.2 * 38;
      const rr = r * (1 - k ** 0.9);
      if (rr >= 1) out.push([CLX + hx + dx * mv, CLY + hy + dy * mv - k * 6, rr]);
    }
  });
  return out;
}

/** Объёмное облако: у клуба тень снизу справа, тело, блик сверху слева; общий контур — сталью. */
function cloud(g: Ctx, ps: [number, number, number][]): void {
  const N = 96;
  const col = new Array<string | null>(N * N).fill(null);
  const ell = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    if (rx <= 0 || ry <= 0) return;
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(N - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(N - 1, Math.ceil(x1)); x++) {
        if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) col[y * N + x] = c;
      }
    }
  };
  for (const [x, y, r] of [...ps].sort((a, b) => a[1] - b[1])) {
    ell(x - r, y - r, x + r, y + r, PAL.slate);
    ell(x - r, y - r, x + r - Math.max(1, r * 0.18), y + r - Math.max(1, r * 0.22), PAL.mist);
    ell(x - r * 0.85, y - r * 0.9, x + r * 0.45, y + r * 0.35, PAL.white);
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = col[y * N + x];
      if (c) R(g, x, y, 1, 1, c);
      else if ((x > 0 && col[y * N + x - 1]) || (x < N - 1 && col[y * N + x + 1]) || (y > 0 && col[(y - 1) * N + x]) || (y < N - 1 && col[(y + 1) * N + x])) R(g, x, y, 1, 1, PAL.steel);
    }
  }
}

/** Комок пены: крупный (r 3) или капля (стекает, r 2). */
function blob(g: Ctx, x: number, y: number, big: boolean): void {
  const X = Math.round(x);
  const Y = Math.round(y);
  if (big) {
    disc(g, X, Y, 3.5, PAL.steel);
    disc(g, X, Y, 2.5, PAL.mist);
    disc(g, X - 0.5, Y - 0.5, 1.8, PAL.white);
  } else {
    disc(g, X, Y, 3, PAL.steel);
    disc(g, X, Y, 2, PAL.mist);
    R(g, X - 2, Y - 2, 2, 2, PAL.white);
  }
}

function sprayFx(g: Ctx, t: number): void {
  // брызги — к краям, пока облако раздувается
  for (const [a, sp, t0] of SPLASH) {
    const k = t - t0;
    if (k < 0 || k > 4) continue;
    const d = 38 + k * 9 * sp;
    const x = CLX + Math.cos(a) * d;
    const y = CLY + Math.sin(a) * d + k * k * 0.8;
    if (x > 3 && x < 93 && y > 3 && y < 93) blob(g, x, y, true);
  }
  // капли «на стекле»: шлёпнулись и стекают, к концу петли их нет
  for (const [x, y, t0, v] of DRIPS) {
    const k = t - t0;
    if (k < 0 || t > 27) continue;
    const yy = y + Math.max(0, k - 2) * v * (1 + 0.15 * Math.max(0, k - 2));
    if (yy > 92) continue;
    for (let j = Math.max(y, Math.floor(yy) - 7); j < Math.floor(yy) - 2; j++) {
      R(g, x - 2, j, 4, 1, PAL.steel);
      R(g, x - 1, j, 2, 1, PAL.mist);
    }
    if (t >= 26) R(g, x - 1, Math.round(yy) - 1, 2, 2, PAL.mist);
    else blob(g, x, yy, false);
    if (k <= 1) for (const [dx, dy] of [[-4, 0], [4, 0], [0, -4], [-3, 3], [3, 3]]) R(g, x + dx, Math.round(yy) + dy, 1, 1, PAL.white);
  }
}

export const EX_ART: Art[] = [
  {
    // стоит в огне и спокойно улыбается, иногда моргает
    id: 'asPlanned',
    draw(g, t, lang) {
      fireSides(g, t);
      put(g, extinguisherFrame(t % 10 === 6 ? F.D + 1 : F.D, { face: t % 10 === 6 ? 'blink' : 'happy' }), CX, 12, K);
      capAt(g, 'asPlanned', lang);
    },
  },
  {
    // наводит шланг в камеру, пена заливает кадр, туман расходится клубами
    id: 'spray',
    frames: SPRAY_FRAMES,
    draw(g, t, lang) {
      const face = t === 3 ? 'blink' : t >= 5 && t <= 10 ? 'wide' : t >= 15 && t <= 25 ? 'happy' : 'normal';
      const rec = t === 7 || t === 9 ? 1 : 0;
      const y0 = 10;
      put(g, extinguisherFrame(F.D, { hose: 'front', face }), CX + rec * K, y0 - rec, K);
      if (t < 7 || t > 24) capAt(g, 'spray', lang);
      // раструб в кадре 18×30: (15, 19) → на холсте
      const ps = puffsAt(t, CX + 15 * K + 1, y0 + 19 * K + 1);
      if (ps.length) cloud(g, ps);
      sprayFx(g, t);
    },
  },
  {
    // весь в копоти, дымится, капля пота — но «норм»
    id: 'fine',
    draw(g, t, lang) {
      put(g, extinguisherFrame(F.D, { soot: true, face: t % 10 < 7 ? 'normal' : 'blink' }), CX, 12, K);
      for (let i = 0; i < 4; i++) {
        const k = (t + i * 5) % 20;
        const x = 40 + i * 6 + Math.round(Math.sin((k + i) / 3) * 2);
        const y = 28 - k;
        if (y > 2) R(g, x, y, 2 + (k > 10 ? 1 : 0), 2 + (k > 10 ? 1 : 0), k > 12 ? PAL.steel : PAL.slate);
      }
      const dy = Math.floor(t / 2) % 6;
      R(g, CX + 30, 34 + dy, 2, 3, PAL.cyan);
      R(g, CX + 30, 37 + dy, 2, 1, PAL.blue);
      flame(g, 22, 72, 8, 10 + (t % 3));
      capAt(g, 'fine', lang);
    },
  },
  {
    // пьёт чай с закрытыми глазами, пока всё горит
    id: 'noDisturb',
    draw(g, t, lang) {
      fireSides(g, t, 72, 0.7);
      put(g, extinguisherFrame(F.D, { face: 'blink' }), CX, 12, K);
      // кружка у наконечника
      const mx = CX + 30;
      const my = 48;
      R(g, mx - 1, my - 1, 10, 10, PAL.ink);
      R(g, mx, my, 8, 8, PAL.white);
      R(g, mx, my, 8, 2, PAL.umber);
      R(g, mx + 8, my + 2, 3, 1, PAL.ink);
      R(g, mx + 10, my + 2, 1, 4, PAL.ink);
      R(g, mx + 8, my + 5, 3, 1, PAL.ink);
      R(g, mx + 1, my + 3, 1, 4, PAL.mist);
      for (let i = 0; i < 3; i++) {
        const k = (t + i * 7) % 20;
        const y = my - 3 - Math.floor(k / 2);
        if (k < 14) R(g, mx + 2 + i * 2 + (Math.floor(k / 3) % 2), y, 1, 2, PAL.mist);
      }
      capAt(g, 'noDisturb', lang);
    },
  },
  {
    // танцует, из шланга — фонтанчик пены, вокруг огонь и фейерверк
    id: 'sfx',
    draw(g, t, lang) {
      fireSides(g, t);
      const i = Math.floor(t / 2) % 4;
      put(g, extinguisherFrame(F.DANCE + i, { foam: Math.floor(t / 2) }), CX, 12 - (i % 2) * 2, K);
      for (const [x, y, p] of [[14, 16, 0], [82, 12, 1], [10, 40, 1], [86, 36, 0], [48, 4, 1]] as const) {
        const on = (Math.floor(t / 3) + p) % 2;
        if (on) star(g, x, y, p ? PAL.magenta : PAL.yellow);
      }
      capAt(g, 'sfx', lang, PAL.yellow);
    },
  },
  {
    // держит хлопушку шлангом: щёлк — и снова спокоен
    id: 'takeOn',
    draw(g, t, lang) {
      put(g, extinguisherFrame(F.D, { face: t % 20 < 3 ? 'wide' : 'normal' }), CX, 12, K);
      const x0 = CX + 30;
      const y0 = 40;
      R(g, x0 - 1, y0 - 1, 22, 16, PAL.ink);
      R(g, x0, y0, 20, 14, PAL.night);
      R(g, x0 + 2, y0 + 5, 16, 1, PAL.mist);
      R(g, x0 + 2, y0 + 9, 10, 1, PAL.slate);
      // палка: открыта в первые кадры петли
      const lift = t % 20 < 2 ? [6, 3][t % 20] : 0;
      for (let x = 0; x < 22; x++) {
        const dy = Math.round((x / 22) * lift);
        R(g, x0 - 1 + x, y0 - 6 - dy, 1, 5, PAL.ink);
        R(g, x0 - 1 + x, y0 - 5 - dy, 1, 3, x === 0 || x === 21 ? PAL.ink : Math.floor(x / 4) % 2 ? PAL.white : PAL.ink);
      }
      if (t % 20 === 2) for (const [x, y] of [[x0 + 24, y0 - 10], [x0 + 18, y0 - 14]]) star(g, x, y);
      capAt(g, 'takeOn', lang);
    },
  },
  {
    // поднял шланг «во!» и подмигивает, на наконечнике — искра
    id: 'intended',
    draw(g, t, lang) {
      const up = Math.floor(t / 5) % 2;
      put(g, extinguisherFrame(F.D, { hose: up ? 'up' : 'upR', face: 'happy', foam: null }), CX, 14, K);
      // подмигивание: левый глаз — чёрточкой
      R(g, CX + 2 * (3 + 4), 14 + 2 * (9 + 8), 4, 2, PAL.peach);
      R(g, CX + 2 * (3 + 4), 14 + 2 * (9 + 8), 4, 1, PAL.ink);
      const tip = up ? [CX + 2 * (3 + 12), 14 + 2 * (9 - 6)] : [CX + 2 * (3 + 14), 14 + 2 * (9 - 5)];
      if (t % 5 < 3) star(g, tip[0] + 1, tip[1] - 4, t % 2 ? PAL.white : PAL.yellow);
      capAt(g, 'intended', lang);
    },
  },
];
