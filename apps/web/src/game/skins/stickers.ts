import { PAL } from '@kto/assets';
import { DICTS, MY_COLORS, STICKER_LIST } from '@kto/game-core';
import type { Lang, StickerId, StickerMeta } from '@kto/game-core';
import { CH_H, CH_W, F, PARK_CHARS, makeCharacterSheets } from '../sprites';
import type { CharSheets } from '../sprites';
import { canvas, outlineOf } from '../pixels';
import type { Ctx } from '../pixels';
import { text } from '../art';
import { KB_W, kotBananFrame, tearArcs, wailFace } from './kot-banan';
import { PLAY_ART } from './stickers-play';
import { EX_ART } from './stickers-ex';

/**
 * Стикеры для Telegram (гардероб, за флагом shop): рисуются кодом из тех же спрайтов, что игра.
 * Стикер — холст 96×96 (подпись игровым шрифтом, белая стикерная обводка), в файл — ×5 с полями: 512×512.
 * Анимированные — 20 кадров по 100 мс (видеостикер WEBM, `pnpm --filter web stickers`).
 *
 * Наборы: `starter` — бесплатный пак с обычным актёром (после первого матча), `kotBanan` и `extinguisher`
 * (stickers-ex.ts) — за покупку набора (2 сразу, остальные позже — за награды в матче).
 */

export const ST_SIZE = 96;
export const ST_FRAMES = 20;
export const ST_FRAME_MS = 100;

export interface StickerDef extends StickerMeta {
  draw(g: Ctx, t: number, lang: Lang): void;
  /** Кадров в петле (по 100 мс), если не ST_FRAMES: «Пшшш!» Огнетушки — 30 (3 с, предел Telegram). */
  frames?: number;
}
export interface Art {
  id: StickerId;
  draw(g: Ctx, t: number, lang: Lang): void;
  frames?: number;
}

/** Второе семейство — латиница на сервере (film-render.ts регистрирует два файла шрифта); в браузере его нет и оно не мешает. */
export const FONT = '"Press Start 2P", "Press Start 2P Latin"';
const K = 2;
const CX = ST_SIZE / 2 - KB_W;

let actor: CharSheets | null = null;
const actorSheets = () => (actor ??= makeCharacterSheets(PARK_CHARS));

/** Кадр обычного актёра с чёрным контуром (14×18). */
export function actorFrame(frame: number, sheets: CharSheets = actorSheets()): HTMLCanvasElement {
  const one = canvas(CH_W, CH_H);
  one.g.drawImage(sheets.body, frame * CH_W, 0, CH_W, CH_H, 0, 0, CH_W, CH_H);
  const o = canvas(CH_W + 2, CH_H + 2);
  outlineOf(one.g, CH_W, CH_H, o.g, 0, 0, PAL.ink);
  o.g.drawImage(one.c, 1, 1);
  return o.c;
}

export const R = (g: Ctx, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};
export const put = (g: Ctx, h: HTMLCanvasElement, x: number, y: number, k = K) => g.drawImage(h, x, y, h.width * k, h.height * k);
/** Надпись игровым шрифтом без сглаживания: рисуем отдельно и оставляем только чёткие пиксели. */
export function say(g: Ctx, s: string, x: number, y: number, col: string, size = 1): void {
  const tmp = canvas(ST_SIZE, ST_SIZE);
  text(tmp.g, s, x, y, col, FONT, { size });
  const img = tmp.g.getImageData(0, 0, ST_SIZE, ST_SIZE);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 100 ? 255 : 0;
  tmp.g.putImageData(img, 0, 0);
  g.drawImage(tmp.c, 0, 0);
}
/** Цвет надписи, выбранный игроком (на время рисования — `withCapColor`); null — родной цвет стикера. */
let capColor: string | null = null;
export const cap = (g: Ctx, id: StickerId, lang: Lang, y: number, col: string = PAL.white) =>
  DICTS[lang].shop.stickers[id].forEach((s, i) => say(g, s, ST_SIZE / 2, y + i * 10, capColor ?? col));
/** Стикер с надписью цвета `MY_COLORS[color]` (как у своих стикеров); null — как есть. */
export function withCapColor<D extends { draw(g: Ctx, t: number, lang: Lang): void }>(def: D, color: number | null | undefined): D {
  const c = color === null || color === undefined ? null : MY_COLORS[color];
  if (!c) return def;
  return {
    ...def,
    draw(g: Ctx, t: number, lang: Lang) {
      const was = capColor;
      capColor = PAL[c];
      try {
        def.draw(g, t, lang);
      } finally {
        capColor = was;
      }
    },
  };
}
export const star = (g: Ctx, x: number, y: number, c: string = PAL.yellow) => {
  R(g, x, y - 2, 2, 6, c);
  R(g, x - 2, y, 6, 2, c);
};
/** Звёздочки по кругу над головой (оглушён). */
export const orbit = (g: Ctx, cx: number, cy: number, t: number) => {
  for (let i = 0; i < 3; i++) {
    const a = (t / ST_FRAMES) * Math.PI * 2 + (i * Math.PI * 2) / 3;
    star(g, Math.round(cx + Math.cos(a) * 14), Math.round(cy + Math.sin(a) * 4));
  }
};
const DANCE_SHIFT = [-1, 0, 1, 0];

const ART: Art[] = [
  // ── стартовый пак: обычный актёр ──
  {
    id: 'hi',
    draw(g, t, lang) {
      const fr = [F.WAVE, F.WAVE + 1, F.WAVE + 2, F.WAVE + 1][Math.floor(t / 2) % 4];
      put(g, actorFrame(fr), ST_SIZE / 2 - 14 * 1.5, 14, 3);
      cap(g, 'hi', lang, 84);
    },
  },
  {
    id: 'dance',
    draw(g, t, lang) {
      const i = Math.floor(t / 2) % 4;
      put(g, actorFrame(F.DANCE + i), ST_SIZE / 2 - 21 + DANCE_SHIFT[i] * 3, 14 - (i % 2) * 3, 3);
      for (const [x, y, p] of [[12, 22, 0], [82, 18, 1], [10, 60, 1], [84, 56, 0]]) if ((Math.floor(t / 3) + p) % 2) star(g, x, y, PAL.magenta);
      cap(g, 'dance', lang, 84);
    },
  },
  {
    id: 'oops',
    draw(g, t, lang) {
      put(g, actorFrame(F.STUN), ST_SIZE / 2 - 21, 18, 3);
      orbit(g, ST_SIZE / 2, 16, t);
      cap(g, 'oops', lang, 84);
    },
  },
  {
    id: 'who',
    draw(g, t, lang) {
      const fr = Math.floor(t / 4) % 2 ? F.STARTLE + 1 : F.STARTLE;
      put(g, actorFrame(fr), ST_SIZE / 2 - 21, 14, 3);
      if (Math.floor(t / 5) % 2 === 0) say(g, '?', 80, 6, PAL.white, 2);
      cap(g, 'who', lang, 84);
    },
  },
  {
    // приманка в конце пака: силуэт из толпы и «Собери свой пак!» — пак открыт всем, это зовёт в игру
    id: 'lure',
    draw(g, t, lang) {
      // хлопушка с «?»: щёлкает раз в две секунды — «твой дубль впереди»
      const x0 = 12;
      const w = 72;
      R(g, x0 - 1, 33, w + 2, 36, PAL.ink);
      R(g, x0 + 1, 35, w - 2, 32, PAL.night);
      R(g, x0 + 1, 50, w - 2, 1, PAL.slate);
      say(g, '?', ST_SIZE / 2, 38, PAL.yellow, 2);
      say(g, 'BENOBODY', ST_SIZE / 2, 55, PAL.mist);
      // палка: закрыта — ровно, открыта (первые кадры) — правый край поднят
      const lift = t < 3 ? [10, 14, 8][t] : 0;
      for (let x = 0; x < w + 2; x++) {
        const dy = Math.round((x / (w + 2)) * lift);
        const stripe = Math.floor((x + 40) / 6) % 2 === 0;
        R(g, x0 - 1 + x, 24 - dy, 1, 9, PAL.ink);
        R(g, x0 - 1 + x, 25 - dy, 1, 7, x === 0 || x === w + 1 ? PAL.ink : stripe ? PAL.white : PAL.ink);
      }
      if (t < 3) for (const [x, y] of [[6, 18], [88, 6], [90, 22]]) star(g, x, y);
      cap(g, 'lure', lang, 76);
    },
  },
  // ── набор «Кот-банан» ──
  {
    id: 'justBanana',
    draw(g, t, lang) {
      const bob = Math.floor(t / 5) % 2;
      put(g, kotBananFrame(F.U, 'U'), CX, 8 + bob);
      // капля пота сползает
      const dy = (t * 2) % 22;
      R(g, 66, 12 + dy, 1, 1, PAL.white);
      R(g, 65, 13 + dy, 3, 2, PAL.cyan);
      R(g, 66, 15 + dy, 1, 1, PAL.cyan);
      cap(g, 'justBanana', lang, 74);
    },
  },
  {
    id: 'splat',
    draw(g, t, lang) {
      const h = kotBananFrame(F.STUN, 'D');
      const r = canvas(h.height, h.width);
      r.g.translate(r.c.width, 0);
      r.g.rotate(Math.PI / 2);
      r.g.drawImage(h, 0, 0);
      put(g, r.c, 48 - r.c.width, 40);
      for (const [x, y, w] of [[60, 76, 14], [62, 74, 4], [70, 74, 4], [58, 78, 4], [72, 78, 4]]) R(g, x, y, w, 2, PAL.yellow);
      R(g, 60, 78, 12, 1, PAL.amber);
      R(g, 64, 72, 2, 2, PAL.umber);
      orbit(g, 24, 34, t);
      cap(g, 'splat', lang, 84);
    },
  },
  {
    id: 'allGood',
    draw(g, t, lang) {
      const y0 = 20;
      put(g, kotBananFrame(F.D, 'D'), CX, y0);
      const inCloud = (x: number, y: number) =>
        y <= 17 && [[38, 12, 5.5], [48, 9, 7.5], [58, 12, 5.5], [44, 13, 5], [53, 13, 5]].some(([cx, cy, r]) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r);
      for (let y = 0; y < 20; y++) {
        for (let x = 28; x < 68; x++) {
          if (inCloud(x, y)) R(g, x, y, 1, 1, y >= 15 ? PAL.slate : (x + y) % 9 === 0 && y < 9 ? PAL.mist : PAL.steel);
          else if (inCloud(x - 1, y) || inCloud(x + 1, y) || inCloud(x, y - 1) || inCloud(x, y + 1)) R(g, x, y, 1, 1, PAL.ink);
        }
      }
      // дождь только под тучей: капли падают по кругу
      for (const [x, ph] of [[34, 0], [39, 7], [45, 3], [51, 11], [57, 5], [62, 9], [42, 14], [55, 17]]) {
        const y = 20 + ((ph * 3 + t * 3) % 60);
        R(g, x, y, 1, 3, PAL.cyan);
        R(g, x, y + 3, 1, 1, PAL.blue);
      }
      R(g, CX + 4, y0 + 60, 28, 2, PAL.blue);
      R(g, CX + 8, y0 + 60, 10, 1, PAL.cyan);
      cap(g, 'allGood', lang, 84);
    },
  },
  {
    id: 'aaa',
    draw(g, t, lang) {
      const y0 = 26;
      const sh = t % 2 ? 1 : -1;
      put(g, wailFace(kotBananFrame(F.D, 'D')), CX + sh, y0);
      tearArcs(g, CX + sh, y0, K, t, 99, true);
      if (t % 2) for (const [x, y, w] of [[20, 40, 4], [18, 46, 5], [20, 52, 4], [72, 40, 4], [73, 46, 5], [72, 52, 4]]) R(g, x, y, w, 1, PAL.white);
      say(g, DICTS[lang].shop.stickers.aaa[0], ST_SIZE / 2 + sh, 6, capColor ?? PAL.yellow);
    },
  },
  {
    id: 'happyTears',
    draw(g, t, lang) {
      const i = Math.floor(t / 2) % 4;
      const hop = i % 2;
      put(g, kotBananFrame(F.D, 'D'), CX, 12 - hop * 2);
      const cx = 48;
      const cy = 3 - hop * 2;
      for (const [x, y, w, h] of [[cx - 7, cy + 4, 14, 4], [cx - 7, cy, 2, 4], [cx - 1, cy - 1, 2, 5], [cx + 5, cy, 2, 4]]) R(g, x, y, w, h, PAL.yellow);
      R(g, cx - 1, cy + 5, 2, 2, PAL.red);
      for (const [x, y, p] of [[16, 24, 0], [80, 20, 1], [14, 56, 1], [82, 52, 0]]) if ((Math.floor(t / 3) + p) % 2) star(g, x, y);
      cap(g, 'happyTears', lang, 76, PAL.yellow);
    },
  },
  {
    id: 'freeze',
    draw(g, t, lang) {
      const h = kotBananFrame(F.FREEZE, 'D');
      const q = h.getContext('2d') as Ctx;
      q.globalCompositeOperation = 'source-atop';
      q.fillStyle = 'rgba(115,239,247,0.5)';
      q.fillRect(0, 0, h.width, h.height);
      R(g, CX - 6, 10, 48, 66, 'rgba(115,239,247,0.35)');
      put(g, h, CX, 14);
      R(g, CX - 6, 10, 48, 1, PAL.white);
      R(g, CX - 6, 10, 1, 66, PAL.white);
      R(g, CX + 41, 10, 1, 66, PAL.cyan);
      R(g, CX - 6, 75, 48, 1, PAL.cyan);
      // блик бежит по льду
      const bx = CX - 4 + ((t * 4) % 60);
      if (bx < CX + 40) for (let i = 0; i < 8; i++) R(g, bx + i, 66 - i * 6, 1, 4, 'rgba(255,255,255,0.7)');
      for (const x of [CX + 8, CX + 26]) {
        R(g, x, 54, 2, 6, PAL.white);
        R(g, x, 60, 1, 3, PAL.white);
      }
      cap(g, 'freeze', lang, 82, PAL.cyan);
    },
  },
  {
    id: 'meow',
    draw(g, t, lang) {
      put(g, kotBananFrame(F.S, 'S'), CX, 16);
      say(g, '?', 74, 6 + (Math.floor(t / 4) % 2), PAL.white, 2);
      cap(g, 'meow', lang, 84);
    },
  },
];

/** Стикеры в порядке пака: данные — game-core › shop.ts, рисунок — здесь. */
export const STICKERS: StickerDef[] = STICKER_LIST.map((m) => {
  const a = [...ART, ...PLAY_ART, ...EX_ART].find((x) => x.id === m.id)!;
  return { ...m, draw: a.draw, ...(a.frames ? { frames: a.frames } : {}) };
});
/** Кадров в петле стикера. */
export const stickerFrames = (def: object): number => ('frames' in def && typeof def.frames === 'number' ? def.frames : ST_FRAMES);

/** Белая стикерная обводка 2 пикс. по альфе — поверх прозрачного фона. */
function stickerize(c: HTMLCanvasElement): HTMLCanvasElement {
  const d = (c.getContext('2d') as Ctx).getImageData(0, 0, ST_SIZE, ST_SIZE).data;
  const a = (x: number, y: number) => x >= 0 && y >= 0 && x < ST_SIZE && y < ST_SIZE && d[(y * ST_SIZE + x) * 4 + 3] > 0;
  const o = canvas(ST_SIZE, ST_SIZE);
  o.g.fillStyle = PAL.white;
  for (let y = 0; y < ST_SIZE; y++) {
    for (let x = 0; x < ST_SIZE; x++) {
      if (a(x, y)) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) near = Math.abs(dx) + Math.abs(dy) <= 3 && a(x + dx, y + dy);
      if (near) o.g.fillRect(x, y, 1, 1);
    }
  }
  o.g.drawImage(c, 0, 0);
  return o.c;
}

/** Кадр стикера 96×96 с обводкой. */
export function stickerFrame(def: Pick<StickerDef, 'draw'>, t: number, lang: Lang): HTMLCanvasElement {
  const { c, g } = canvas(ST_SIZE, ST_SIZE);
  g.imageSmoothingEnabled = false;
  def.draw(g, t, lang);
  return stickerize(c);
}

/** Файл для Telegram: 512×512, стикер ×5 по центру. */
export function stickerFile(def: Pick<StickerDef, 'draw'>, t: number, lang: Lang): HTMLCanvasElement {
  const s = stickerFrame(def, t, lang);
  const { c, g } = canvas(512, 512);
  g.imageSmoothingEnabled = false;
  g.drawImage(s, 16, 16, 480, 480);
  return c;
}
