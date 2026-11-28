import { PAL } from '@kto/assets';
import { THEME_RULES } from '@kto/game-core';
import type { MyPose, ThemeId } from '@kto/game-core';
import { CH_H, CH_W, F, PARK_CHARS, makeCharacterSheets } from '../sprites';
import type { CharSheets } from '../sprites';
import { canvas, outlineOf } from '../pixels';
import type { Ctx } from '../pixels';
import { text } from '../art';
import type { CharStyle, Pose } from '../themes/types';
import { themeLook, themePack } from '../themes';
import { kotBananFrame, tearArcs, wailFace } from './kot-banan';

/**
 * Свои жесты фигурок для «Своего стикера» (решение владельца 28.11.2026: жесты под переписку и мемы, у каждой
 * фигурки — свои, `MY_FIG_POSES`) и сцены мемов пака («Вычислил», «Всё, я спать», «Последний раз»).
 *
 * Сцена рисуется в своей сетке (пиксель фигурки ×k, холст 96×96) тремя слоями: подложка, «чернила» (их обводит
 * чёрный контур — фигурка с предметами одним силуэтом) и искры поверх. Подписи сцена не рисует: подпись своего
 * стикера ставит my-sticker.ts, мема — stickers-play.ts. Костюмы тем — из пакетов тем (`loadAllThemes` заранее).
 * Модуль не импортирует stickers.ts (тот сам тянет сцены мемов через stickers-play.ts) — шрифт и кадр актёра свои.
 */

const SZ = 96;
const ST_FRAMES = 20;
const NONE = 'rgba(0,0,0,0)';
/** Шрифт подписей стикеров (как `stickers.ts › FONT`; второе семейство — латиница на сервере). */
const FONT = '"Press Start 2P", "Press Start 2P Latin"';

/** Надпись игровым шрифтом без сглаживания (как `stickers.ts › say`). */
function say(g: Ctx, s: string, x: number, y: number, col: string, size = 1): void {
  const tmp = canvas(SZ, SZ);
  text(tmp.g, s, x, y, col, FONT, { size });
  const img = tmp.g.getImageData(0, 0, SZ, SZ);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 100 ? 255 : 0;
  tmp.g.putImageData(img, 0, 0);
  g.drawImage(tmp.c, 0, 0);
}

/** Кадр человечка из ленты с чёрным контуром (как `stickers.ts › actorFrame`). */
function actorFrame(frame: number, sheets: CharSheets): HTMLCanvasElement {
  const one = canvas(CH_W, CH_H);
  one.g.drawImage(sheets.body, frame * CH_W, 0, CH_W, CH_H, 0, 0, CH_W, CH_H);
  const o = canvas(CH_W + 2, CH_H + 2);
  outlineOf(one.g, CH_W, CH_H, o.g, 0, 0, PAL.ink);
  o.g.drawImage(one.c, 1, 1);
  return o.c;
}

// ───────────── слой сцены ─────────────

/** Холсты одного кадра: bg — подложка, ink — то, что обводится чёрным, fx — искры поверх. Единица — пиксель фигурки. */
interface L {
  bg: Ctx;
  ink: Ctx;
  fx: Ctx;
  N: number;
  t: number;
  /** Надписи-значки в координатах 96×96. */
  text: { s: string; x: number; y: number; col: string; size: number }[];
  /** Всё нарисованное — в серый (по яркости, серыми цветами палитры); надписи — как есть. */
  gray?: boolean;
}
type Draw = (l: L) => void;
/** Сцена: рисует кадр t со сдвигом по вертикали dy (экранные пиксели). */
export type Scene = (g: Ctx, t: number, dy?: number) => void;

/** Сцена в сетке ×k (пиксель фигурки — k экранных). */
function scene(k: number, draw: Draw): Scene {
  const N = SZ / k;
  const f = (g: Ctx, t: number, dy = 0) => {
    const mk = () => canvas(N, N);
    const bg = mk();
    const ink = mk();
    const fx = mk();
    const l: L = { bg: bg.g, ink: ink.g, fx: fx.g, N, t, text: [] };
    draw(l);
    if (l.gray) for (const c of [bg, ink, fx]) grayOut(c.g, N);
    const o = mk();
    outlineOf(ink.g, N, N, o.g, -1, -1, PAL.ink);
    g.imageSmoothingEnabled = false;
    for (const c of [bg.c, o.c, ink.c, fx.c]) g.drawImage(c, 0, dy, SZ, SZ);
    for (const s of l.text) say(g, s.s, s.x, s.y + dy, s.col, s.size);
  };
  return f;
}

const P = (g: Ctx, x: number, y: number, c: string, w = 1, h = 1) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), w, h);
};

/** Нарисовать кадр-ленту (без контура) в слой: поворот кратно 90°, разворот. */
function blit(g: Ctx, src: HTMLCanvasElement, sx: number, sw: number, sh: number, x: number, y: number, o: { flip?: boolean; rot?: number } = {}) {
  g.save();
  g.translate(Math.round(x) + sw / 2, Math.round(y) + sh / 2);
  if (o.rot) g.rotate((o.rot * Math.PI) / 2);
  if (o.flip) g.scale(-1, 1);
  g.drawImage(src, sx, 0, sw, sh, -sw / 2, -sh / 2, sw, sh);
  g.restore();
}

/** Человечек из ленты `sh` (кадр `fr`) с левым верхним углом в (x, y). */
const man = (g: Ctx, sh: CharSheets, fr: number, x: number, y: number, o: { flip?: boolean; rot?: number } = {}) => blit(g, sh.body, fr * CH_W, CH_W, CH_H, x, y, o);

const GRAYS = [PAL.ink, PAL.night, PAL.dusk, PAL.steel, PAL.slate, PAL.mist, PAL.white].map((h) => {
  const v = parseInt(h.slice(1), 16);
  const [r, g, b] = [v >> 16, (v >> 8) & 255, v & 255];
  return { r, g, b, y: 0.3 * r + 0.59 * g + 0.11 * b };
});
function grayOut(g: Ctx, N: number) {
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const y = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    let best = GRAYS[0];
    for (const c of GRAYS) if (Math.abs(c.y - y) < Math.abs(best.y - y)) best = c;
    d[i] = best.r;
    d[i + 1] = best.g;
    d[i + 2] = best.b;
  }
  g.putImageData(img, 0, 0);
}

// ───────────── мелочи ─────────────

const spark = (g: Ctx, x: number, y: number, c: string = PAL.yellow) => {
  P(g, x, y - 1, c, 1, 3);
  P(g, x - 1, y, c, 3, 1);
};
const heart = (g: Ctx, x: number, y: number, c: string = PAL.red) => {
  P(g, x, y, c, 2, 1);
  P(g, x + 3, y, c, 2, 1);
  P(g, x - 1 + 1, y + 1, c, 5, 1);
  P(g, x + 1, y + 2, c, 3, 1);
  P(g, x + 2, y + 3, c, 1, 1);
};
const note = (g: Ctx, x: number, y: number, c: string = PAL.white) => {
  P(g, x + 2, y, c, 1, 4);
  P(g, x + 3, y, c, 1, 1);
  P(g, x, y + 3, c, 2, 2);
};
const flame = (g: Ctx, x: number, y: number, h: number, t: number) => {
  // язык пламени высотой h: красный край, оранжевое тело, жёлтая сердцевина
  for (let i = 0; i < h; i++) {
    const w = Math.max(1, Math.round((h - i) * 0.6));
    const sway = Math.round(Math.sin((t + i) * 1.3) * (i / h) * 1.5);
    P(g, x - Math.floor(w / 2) + sway, y - i, i > h * 0.7 ? PAL.red : PAL.orange, w, 1);
    if (i < h * 0.5 && w > 2) P(g, x - Math.floor((w - 2) / 2) + sway, y - i, PAL.yellow, w - 2, 1);
  }
};
const coin = (g: Ctx, x: number, y: number, f: number) => {
  const w = [3, 2, 1, 2][f % 4];
  P(g, x + (3 - w) / 2, y, PAL.amber, w, 3);
  if (w > 1) P(g, x + (3 - w) / 2, y, PAL.yellow, w - 1, 2);
};

// ───────────── костюмы ─────────────

const sheetCache = new Map<string, CharSheets>();
function sheets(key: string, chars: CharStyle, poses: Pose[] = []): CharSheets {
  let s = sheetCache.get(key);
  if (!s) sheetCache.set(key, (s = makeCharacterSheets(chars, poses)));
  return s;
}
/** Лента героя площадки: его позы + наши (номер нашей позы i → `extra(theme, i)`). */
const themeSheets = (theme: number, look = 0, mine: Pose[] = []) => {
  const l = themeLook(theme, look);
  return sheets(`t${theme}.${look}.${mine.length}`, l.chars, [...(l.poses ?? []), ...mine]);
};
const own = (theme: number, i: number, look = 0) => F.COUNT + (themeLook(theme, look).poses?.length ?? 0) + i;
const tp = (i: number) => F.COUNT + i;

const set = (m: string[][], x: number, y: number, ch: string) => {
  if (y >= 0 && y < m.length && x >= 0 && x < m[y].length) m[y][x] = ch;
};

/** Общие правки поз. */
const POSE = {
  /** Руки скрещены на груди. */
  crossed: { view: 'D', patch: (m) => { for (let x = 2; x <= 9; x++) set(m, x, 10, x % 2 ? 'a' : 'b'); set(m, 2, 11, 'B'); set(m, 9, 11, 'B'); } } as Pose,
  /** Ладонь закрывает глаза (фейспалм), рука от груди. */
  palm: { view: 'D', face: 'blink', patch: (m) => { for (let x = 3; x <= 8; x++) { set(m, x, 4, 'a'); set(m, x, 5, 'a'); } set(m, 9, 6, 'a'); set(m, 9, 7, 'b'); set(m, 9, 8, 'b'); set(m, 9, 9, 'b'); set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); } } as Pose,
  /** Ладонь у рта (поцелуй / микрофон / тсс). */
  mouth: { view: 'D', patch: (m) => { set(m, 6, 7, 'a'); set(m, 7, 7, 'a'); set(m, 7, 8, 'a'); set(m, 8, 9, 'b'); set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); } } as Pose,
  /** Рука вытянута в сторону ладонью (после поцелуя пальцев), лицо довольное. */
  flick: { view: 'D', arms: 'rightUp', face: 'happy' } as Pose,
  /** Руки вперёд, держит что-то перед собой у груди. */
  hold: { view: 'D', patch: (m) => { set(m, 3, 11, 'a'); set(m, 8, 11, 'a'); set(m, 2, 11, 'B'); set(m, 9, 11, 'B'); } } as Pose,
  /** Испуг с руками у щёк. */
  panic: { view: 'D', face: 'wide', arms: 'up' } as Pose,
  /** Обе руки вверх, довольный. */
  yay: { view: 'D', face: 'happy', arms: 'up' } as Pose,
  /** Рука у шлема/виска. */
  temple: { view: 'D', patch: (m) => { set(m, 11, 4, 'a'); set(m, 11, 5, 'b'); set(m, 10, 6, 'b'); set(m, 10, 7, 'b'); set(m, 9, 10, 'b'); set(m, 9, 11, 'B'); } } as Pose,
  /** Сонный, глаза закрыты. */
  sleepy: { view: 'D', face: 'blink' } as Pose,
  /** Подозревает: брови домиком вниз, глаза-щёлки, рот ровный. */
  sus: { view: 'D', patch: (m) => { set(m, 3, 5, 's'); set(m, 8, 5, 's'); for (const x of [2, 3, 8, 9]) set(m, x, 6, 'e'); set(m, 2, 4, 'e'); set(m, 3, 4, 'e'); set(m, 4, 5, 'e'); set(m, 9, 4, 'e'); set(m, 8, 4, 'e'); set(m, 7, 5, 'e'); set(m, 5, 7, 'e'); set(m, 6, 7, 'e'); } } as Pose,
} satisfies Record<string, Pose>;
const MINE: Pose[] = Object.values(POSE);
const M = Object.fromEntries(Object.keys(POSE).map((k, i) => [k, i])) as Record<keyof typeof POSE, number>;


// ───────────── жесты ─────────────

const GESTURES: Partial<Record<MyPose, Scene>> = {};
const MEMES: Partial<Record<'busted' | 'sleep' | 'lastTime', Scene>> = {};

/** Индекс площадки по id (индексы THEME_RULES уходят в сеть, но здесь надёжнее по имени). */
const ti = (id: ThemeId) => THEME_RULES.findIndex((r) => r.id === id);

const OX = 10;
const OY = 5;
let built = false;

/** Собрать сцены (костюмы тем к этому времени загружены). */
function build(): void {
  if (built) return;
  built = true;
  const actor = sheets('actor', PARK_CHARS, MINE);
  const mine = (i: number) => F.COUNT + i;
  const add = (pose: MyPose, draw: Draw, k = 3) => (GESTURES[pose] = scene(k, draw));

  // ═══ Актёр ═══
  add('snap', (l) => {
    const { t, ink, fx } = l;
    if (t < 10) {
      man(ink, actor, F.WAVE, OX, OY);
      // хлопушка в поднятой руке: доска и палка; палка падает на 6-м кадре
      const bx = OX + 11;
      const by = OY + 1;
      // доска: чёрная, две белые строки «сцена / дубль»
      P(ink, bx, by + 3, PAL.night, 9, 6);
      P(ink, bx + 1, by + 5, PAL.white, 3, 1);
      P(ink, bx + 5, by + 5, PAL.white, 3, 1);
      P(ink, bx + 1, by + 7, PAL.white, 7, 1);
      // палка в косую полоску: открыта (наклон) или захлопнута
      const stick = (i: number) => (Math.floor(i / 2) % 2 ? PAL.white : PAL.night);
      if (t < 6) for (let i = 0; i < 9; i++) P(ink, bx + i, by + 2 - Math.floor(i / 2), stick(i), 1, 2);
      else {
        for (let i = 0; i < 9; i++) P(ink, bx + i, by + 1, stick(i), 1, 2);
        if (t < 9) for (const [dx, dy] of [[-2, -1], [10, -1], [4, -2], [11, 3]]) spark(fx, bx + dx, by + dy, PAL.yellow);
      }
    } else {
      man(ink, actor, F.WAVE + 2, OX, OY);
      // большой палец вверх: кулак с костяшками и палец, крупно сбоку
      const hx = OX + 11;
      const hy = OY + 4;
      P(ink, hx, hy + 2, PAL.peach, 4, 4);
      P(ink, hx + 1, hy + 3, PAL.fawn, 3, 1);
      P(ink, hx + 1, hy + 5, PAL.fawn, 3, 1);
      P(ink, hx, hy - 1, PAL.peach, 2, 3);
      P(ink, hx + 1, hy, PAL.fawn, 1, 2);
      P(ink, hx + 1, hy + 6, PAL.orange, 2, 3);
      if (t % 4 < 2) spark(fx, OX + 18, OY + 1, PAL.yellow);
      if (t % 4 >= 2) spark(fx, OX - 3, OY + 4, PAL.yellow);
    }
  });

  add('facepalm', (l) => {
    const { t, ink, fx } = l;
    if (t < 4) man(ink, actor, F.D, OX, OY);
    else {
      const sway = t >= 8 ? [0, 0, 1, 1, 0, 0, -1, -1][(t - 8) % 8] : 0;
      man(ink, actor, F.D, OX + sway, OY + 1);
      const x0 = OX + sway;
      const y0 = OY + 1;
      // рука от плеча вверх к лицу, ладонь поперёк глаз — шире головы, видна обводкой
      P(ink, x0 + 10, y0 + 7, PAL.orange, 2, 4);
      P(ink, x0 + 11, y0 + 6, PAL.rust, 1, 1);
      P(ink, x0 + 2, y0 + 4, PAL.peach, 10, 3);
      P(ink, x0 + 1, y0 + 4, PAL.peach, 1, 2);
      for (const fxx of [3, 5, 7]) P(ink, x0 + fxx, y0 + 4, PAL.fawn, 1, 2);
      P(ink, x0 + 2, y0 + 7, PAL.ink, 9, 1);
      P(ink, x0 + 2, y0 + 3, PAL.ink, 9, 1);
      if (t >= 8) for (let i = 0; i < 3; i++) if (Math.floor((t - 8) / 2) > i) P(fx, OX + 13 + i * 2, OY - 1, PAL.white);
      if (t % 6 < 3 && t >= 6) P(fx, OX + 1, OY + 1, PAL.cyan, 1, 2);
    }
  });

  add('wait', (l) => {
    const { t, ink, fx } = l;
    // руки скрещены, носком отбивает ритм, над головой песочные часы
    const fr = mine(M.crossed);
    man(ink, actor, fr, OX, OY);
    if (t % 4 < 2) { ink.clearRect(OX + 7, OY + 15, 2, 1); ink.clearRect(OX + 7, OY + 14, 2, 1); P(ink, OX + 7, OY + 14, PAL.night, 2, 1); }
    const hx = OX + 13;
    const hy = OY - 3;
    const flip = t >= 10;
    const sand = flip ? t - 10 : t;
    P(ink, hx, hy, PAL.umber, 5, 1);
    P(ink, hx, hy + 6, PAL.umber, 5, 1);
    for (let y = 1; y <= 5; y++) {
      const w = y === 3 ? 1 : 3;
      P(ink, hx + (5 - w) / 2, hy + y, PAL.mist, w, 1);
    }
    const top = Math.max(0, 2 - Math.floor(sand / 4));
    // песок сыплется сверху вниз; на 10-м кадре часы перевернулись — снова сверху
    if (top > 0) P(ink, hx + 1, hy + 1, PAL.sand, 3, top > 1 ? 2 : 1);
    P(ink, hx + 2, hy + 3, PAL.sand);
    const bot = Math.min(2, Math.floor(sand / 4) + 1);
    P(ink, hx + 1, hy + 6 - bot, PAL.sand, 3, bot);
    if (t % 10 === 9) spark(fx, hx + 2, hy - 2, PAL.white);
  });

  // ═══ Кот-банан ═══
  const KO = 15;
  const KY = 3;
  const kot = (fr: number) => kotBananFrame(fr, 'D', 0, 0, NONE);
  add('sob', (l) => {
    const { t, ink, fx } = l;
    const sh = t % 2 ? 1 : 0;
    const h = wailFace(kot(F.D));
    ink.drawImage(h, KO + sh, KY);
    tearArcs(fx, KO + sh, KY, 1, t, 4 + t * 2, true);
  }, 2);

  add('hide', (l) => {
    const { t, ink } = l;
    const h = kot(F.D);
    ink.drawImage(h, KO, KY);
    // прячется в кожуру: окошко мордочки зарастает бананом снизу вверх, по силуэту самого банана;
    // швы кожуры сходятся к верхушке; закрытый — вздрагивает, потом подглядывает в щёлку
    const close = t < 3 ? 0 : t < 7 ? (t - 2) / 4 : t < 17 ? 1 : 1 - (t - 16) / 3;
    if (close > 0) {
      const g = h.getContext('2d') as Ctx;
      const src = g.getImageData(0, 0, h.width, h.height).data;
      const FACE_TOP = 10;
      const FACE_BOT = 24;
      const edge = Math.round(FACE_BOT - close * (FACE_BOT - FACE_TOP));
      const peek = t >= 12 && t < 15;
      const isBanana = (r: number, gg: number, b: number) => r > 150 && gg > 100 && b < 120;
      for (let y = edge; y <= FACE_BOT; y++) {
        for (let x = 0; x < h.width; x++) {
          const o = (y * h.width + x) * 4;
          if (!src[o + 3]) continue;
          if (isBanana(src[o], src[o + 1], src[o + 2])) continue;
          if (peek && (x === 8 || x === 9) && y >= 15 && y <= 18) continue;
          // кромка лепестков — темнее, швы — к верхушке
          const seam = Math.abs(x - 9) === Math.max(1, Math.round((y - FACE_TOP) / 4));
          P(g, x, y, y === edge && close < 1 ? PAL.amber : seam ? PAL.amber : PAL.yellow);
        }
      }
    }
    const shake = t >= 8 && t < 11 ? (t % 2 ? 1 : -1) : 0;
    ink.clearRect(0, 0, l.N, l.N);
    ink.drawImage(h, KO + shake, KY);
  }, 2);

  add('plead', (l) => {
    const { t, ink, fx } = l;
    const sw = [0, 0, 1, 1, 0, 0, -1, -1][Math.floor(t / 2) % 8];
    const h = kot(F.D);
    const g = h.getContext('2d') as Ctx;
    // огромные глаза-блюдца с бликом, лапки под подбородком
    for (const ex of [4, 10]) {
      P(g, ex, 15, PAL.ink, 4, 4);
      P(g, ex + 1, 16, PAL.navy, 2, 2);
      P(g, ex, 15, PAL.white, 2, 1);
      P(g, ex, 16, PAL.white, 1, 1);
      P(g, ex + 2, 17, t % 6 < 3 ? PAL.white : PAL.cyan);
    }
    P(g, 8, 20, PAL.ink, 2, 1);
    P(g, 7, 22, PAL.mist, 4, 2);
    P(g, 9, 22, PAL.steel, 1, 2);
    ink.drawImage(h, KO + sw, KY);
    if (t % 8 < 5) P(fx, KO + 5 + sw, KY + 20 + (t % 8), PAL.cyan, 1, 1);
    if (t % 10 < 5) heart(fx, KO + 20, KY + 2 - (t % 5), PAL.coral);
  }, 2);

  // ═══ Повар ═══
  const CHEF = ti('chefs');
  const chef = themeSheets(CHEF, 0, MINE);
  add('chefKiss', (l) => {
    const { t, ink, fx } = l;
    if (t < 8) {
      man(ink, chef, own(CHEF, M.mouth), OX, OY);
      if (t >= 4) P(fx, OX + 6, OY + 7, PAL.coral, 1, 1);
    } else {
      man(ink, chef, own(CHEF, M.flick), OX, OY);
      // пальцы веером
      for (const [dx, dy] of [[12, 4], [13, 5], [12, 6]]) P(ink, OX + dx, OY + dy, PAL.peach);
      const k = t - 8;
      heart(fx, OX + 14 + Math.floor(k / 3), OY + 2 - k, PAL.red);
      if (k % 4 < 2) spark(fx, OX + 18, OY + 6, PAL.yellow);
      if (k % 4 >= 2) spark(fx, OX - 3, OY + 3, PAL.yellow);
    }
  });

  add('onFire', (l) => {
    const { t, ink, fx } = l;
    const hop = t % 4 < 2 ? 0 : -1;
    man(ink, chef, own(CHEF, M.hold), OX, OY + hop);
    // сковорода в руках, на ней пламя до головы
    P(ink, OX + 1, OY + 11 + hop, PAL.night, 10, 2);
    P(ink, OX + 11, OY + 11 + hop, PAL.umber, 4, 1);
    const hgt = 6 + (t % 3) + Math.min(4, Math.floor(t / 3));
    flame(fx, OX + 3, OY + 10 + hop, hgt - 2, t);
    flame(fx, OX + 6, OY + 10 + hop, hgt, t + 1);
    flame(fx, OX + 9, OY + 10 + hop, hgt - 3, t + 2);
    if (t % 4 < 2) P(fx, OX + 11, OY + 2 + hop, PAL.cyan, 1, 2);
    // дым
    for (let i = 0; i < 3; i++) {
      const y = OY - 2 - ((t * 1 + i * 6) % 14);
      if (y > -2) P(fx, OX + 4 + i * 3 + (i % 2), y, PAL.slate, 2, 2);
    }
  });

  add('orderUp', (l) => {
    const { t, ink, fx } = l;
    const down = t % 10 >= 4 && t % 10 < 7;
    man(ink, chef, down ? own(CHEF, M.hold) : F.WAVE, OX, OY);
    // стойка раздачи и звонок
    P(ink, OX - 4, OY + 13, PAL.mist, 20, 3);
    P(ink, OX - 4, OY + 13, PAL.white, 20, 1);
    P(ink, OX + 7, OY + 10, PAL.amber, 4, 3);
    P(ink, OX + 8, OY + 9, PAL.yellow, 2, 1);
    P(ink, OX + 8, OY + 8, PAL.amber, 2, 1);
    P(ink, OX + 6, OY + 12, PAL.umber, 6, 1);
    if (down) {
      // «дзынь»: дуги над звонком
      for (const [dx, dy] of [[4, 6], [13, 6], [3, 4], [14, 4]]) P(fx, OX + dx, OY + dy, PAL.yellow, 1, 2);
      spark(fx, OX + 9, OY + 4, PAL.white);
    }
  });

  // ═══ Пингвин ═══
  const PEN = ti('penguins');
  const pen = themeSheets(PEN, 0, MINE);
  add('shiver', (l) => {
    const { t, ink, fx } = l;
    const dx = t % 2 ? 1 : -1;
    man(ink, pen, own(PEN, M.crossed), OX + dx, OY);
    // сосулька под клювом и пар изо рта
    P(ink, OX + 6 + dx, OY + 9, PAL.cyan, 1, 2);
    if (t % 6 < 4) P(fx, OX + 13 + (t % 6), OY + 6 - (t % 6), PAL.white, 2, 1);
    for (let i = 0; i < 4; i++) {
      const y = (t * 1 + i * 7) % 30;
      P(fx, (i * 9 + 3) % 30, y, PAL.white);
    }
  });

  add('leave', (l) => {
    const { t, ink, fx } = l;
    if (t < 7) man(ink, pen, F.WAVE + (t % 2), OX, OY);
    else if (t < 9) man(ink, pen, F.D, OX, OY + 1);
    else {
      // на пузе вправо, за край
      const x = OX + (t - 9) * 4;
      man(ink, pen, F.S, x - 2, OY + 6, { rot: 1 });
      for (let i = 1; i < 4; i++) if (x - i * 4 > 0) P(fx, x - i * 4, OY + 17 + (i % 2), PAL.white, 3, 2);
    }
  });

  add('flop', (l) => {
    const { t, ink, fx } = l;
    if (t < 4) man(ink, pen, F.STUN, OX + (t % 2), OY);
    else if (t < 6) man(ink, pen, F.STUN, OX + 2, OY + 2, { rot: 1 });
    else {
      // лежит лицом в снег, белый флажок «сдаюсь»
      man(ink, pen, F.U, OX - 1, OY + 7, { rot: 1 });
      if (t < 8) for (const [dx, dy] of [[-3, 15], [15, 14], [5, 17], [11, 17]]) P(fx, OX + dx, OY + dy, PAL.white, 2, 1);
      const fy = OY + 6 - Math.min(4, t - 6);
      P(ink, OX + 16, fy, PAL.umber, 1, 8);
      const wv = t % 4 < 2 ? 0 : 1;
      P(ink, OX + 17, fy + wv, PAL.white, 4, 3);
    }
  });

  // ═══ Космонавт ═══
  const COS = ti('cosmonauts');
  const cos = themeSheets(COS, 0, MINE);
  add('liftoff', (l) => {
    const { t, ink, fx } = l;
    const up = t < 4 ? 1 : -Math.round(Math.sin(((t - 4) / 16) * Math.PI) * 4);
    man(ink, cos, t < 4 ? F.D : F.WAVE + 1, OX, OY + up);
    // ранец и пламя под ногами
    if (t >= 3) {
      flame(fx, OX + 4, OY + 19 + up + 2, 3 + (t % 2), -t);
      flame(fx, OX + 8, OY + 19 + up + 2, 3 + ((t + 1) % 2), -t);
      for (const sx of [2, 26, 5, 23]) P(fx, sx, (t * 3 + sx) % 30, PAL.white, 1, 2);
    }
  });

  add('float', (l) => {
    const { t, ink, fx } = l;
    const a = (t / ST_FRAMES) * Math.PI * 2;
    const x = OX + Math.round(Math.cos(a) * 3);
    const y = OY + Math.round(Math.sin(a) * 2) - 1;
    man(ink, cos, F.D, x, y, { rot: Math.floor(t / 5) % 4 });
    for (const [sx, sy, ph] of [[2, 3, 0], [27, 6, 1], [4, 20, 1], [26, 22, 0], [15, 0, 1]]) if ((Math.floor(t / 3) + ph) % 2) spark(fx, sx, sy, ph ? PAL.white : PAL.yellow);
  });

  add('ping', (l) => {
    const { t, ink, fx } = l;
    const knock = t % 4 < 2;
    man(ink, cos, own(COS, M.temple), OX + (knock ? 0 : 0), OY);
    // антенна с мигалкой и волны сигнала
    P(ink, OX + 3, OY - 3, PAL.mist, 1, 3);
    P(fx, OX + 3, OY - 4, t % 4 < 2 ? PAL.red : PAL.wine);
    const r = t % 6;
    if (r > 0) {
      P(fx, OX + 3 - r - 1, OY - 4 - r, PAL.cyan, 1, 2);
      P(fx, OX + 3 + r + 1, OY - 4 - r, PAL.cyan, 1, 2);
    }
    // стук по шлему: штрихи удара
    if (knock) for (const [dx, dy] of [[14, 2], [15, 4], [14, 6]]) P(fx, OX + dx, OY + dy, PAL.white, 2, 1);
  });

  // ═══ Клерк ═══
  const OFF = ti('office');
  const off = themeSheets(OFF, 0, MINE);
  const basement = themeSheets(OFF, 1);
  add('call', (l) => {
    const { t, ink } = l;
    man(ink, off, tp([6, 7][Math.floor(t / 2) % 2]), OX, OY);
    // облачко «бла-бла»
    P(ink, OX - 8, OY - 3, PAL.white, 9, 5);
    P(ink, OX - 2, OY + 2, PAL.white, 2, 1);
    for (let i = 0; i < 3; i++) if ((Math.floor(t / 2) + i) % 3 !== 0) P(ink, OX - 7 + i * 3, OY - 1, PAL.dusk, 2, 1);
  });

  add('coffee', (l) => {
    const { t, ink, fx } = l;
    man(ink, off, tp([2, 3, 3, 2][Math.floor(t / 3) % 4]), OX, OY);
    for (let i = 0; i < 3; i++) {
      const k = (t + i * 4) % 12;
      P(fx, OX + 10 + ((k >> 1) % 2), OY + 7 - k, PAL.mist);
    }
    if (t % 10 < 5) l.text.push({ s: 'z', x: 22, y: 12 - (t % 5), col: PAL.white, size: 1 });
  });

  add('typing', (l) => {
    const { t, ink } = l;
    man(ink, off, tp(0), OX + (t % 2), OY);
    // летящие буквы
    const glyphs = ['A', '!', '#', '?', 'W', '@', '%', '$'];
    for (let i = 0; i < 3; i++) {
      const k = (t + i * 3) % 9;
      const g = glyphs[(Math.floor((t + i * 3) / 9) * 3 + i) % glyphs.length];
      l.text.push({ s: g, x: [14, 82, 20][i], y: [44, 40, 20][i] - k * 3, col: [PAL.white, PAL.yellow, PAL.cyan][i], size: 1 });
    }
  });

  add('frame25', (l) => {
    const { t, ink, bg, N } = l;
    if (t === 13) {
      // мелькнул подвал: бетон, красная лампа, боец бьёт в камеру
      for (let y = 0; y < 25; y++) for (let x = 0; x < N; x++) {
        if (Math.hypot(x - N / 2, (y - 12) * 1.2) > 15) continue;
        P(bg, x, y, y % 4 === 0 || (x + Math.floor(y / 4) * 3) % 8 === 0 ? PAL.night : PAL.dusk);
      }
      P(bg, 15, 0, PAL.red, 3, 2);
      P(bg, 13, 2, PAL.wine, 7, 1);
      man(ink, basement, F.JAB, OX, OY);
      P(ink, OX + 5, OY + 6, PAL.white, 2, 1);
    } else {
      man(ink, off, tp([2, 3, 3, 2][Math.floor(t / 3) % 4]), OX, OY);
    }
  });

  // ═══ Майами ═══
  const MIA = ti('miami');
  const day = themeSheets(MIA, 0, MINE);
  const night = themeSheets(MIA, 1);
  const pack = themePack(MIA);
  const dress = pack.dressUp ? sheets('miaDress', pack.dressUp.look.chars, pack.dressUp.look.poses ?? []) : night;
  add('shades', (l) => {
    const { t, ink, fx } = l;
    man(ink, day, t < 12 ? F.D : own(MIA, M.sleepy), OX, OY);
    const gy = t < 12 ? OY - 10 + Math.round((t / 11) * 15) : OY + 5;
    P(ink, OX + 2, gy, PAL.ink, 8, 1);
    P(ink, OX + 2, gy + 1, PAL.ink, 3, 1);
    P(ink, OX + 7, gy + 1, PAL.ink, 3, 1);
    if (t >= 12) {
      const gx = OX + 2 + ((t - 12) % 8);
      if (gx < OX + 10) P(fx, gx, gy, PAL.white);
      if (t >= 14 && t < 18) spark(fx, OX + 13, OY + 3, PAL.white);
    }
  });

  add('cocktail', (l) => {
    const { t, ink, fx } = l;
    man(ink, day, tp(Math.floor(t / 5) % 2 ? 6 : 5), OX, OY);
    // солнце и марево
    P(fx, 1, 1, PAL.yellow, 4, 4);
    if (t % 4 < 2) for (const [dx, dy] of [[6, 2], [2, 6], [5, 5]]) P(fx, dx, dy, PAL.amber);
    for (let i = 0; i < 2; i++) {
      const y = OY + 17 - ((t + i * 5) % 10);
      P(fx, OX - 3 + i * 18, y, PAL.orange, 2, 1);
    }
  });

  add('friday', (l) => {
    const { t, ink, fx } = l;
    man(ink, day, tp(3 + (Math.floor(t / 3) % 2)), OX, OY - (Math.floor(t / 3) % 2));
    const cols = [PAL.magenta, PAL.cyan, PAL.yellow, PAL.orange];
    for (const [sx, sy, ph] of [[3, 4, 0], [27, 3, 1], [2, 18, 1], [28, 17, 0]]) if ((Math.floor(t / 3) + ph) % 2) spark(fx, sx, sy, cols[(sx + t) % 4]);
  });

  add('mask', (l) => {
    const { t, ink, bg, N } = l;
    // день: улыбается и машет; надевает маску; ночь: неон и голова набок
    if (t < 6) {
      man(ink, day, F.WAVE + (Math.floor(t / 2) % 2), OX, OY);
    } else if (t < 9) {
      man(ink, dress, tp(t < 7 ? 0 : t < 8 ? 1 : 1), OX, OY);
    } else {
      const neon = Math.floor(t / 2) % 2 ? PAL.magenta : PAL.grape;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const d = Math.hypot(x - N / 2, y - N / 2 + 3);
        if (d < 14) P(bg, x, y, d < 13 ? (y % 3 === 0 ? PAL.night : neon) : PAL.cyan);
      }
      man(ink, night, tp(t < 14 ? 4 : t < 16 ? 0 : 5), OX, OY);
    }
  });

  // ═══ Корпоратив ═══
  const PAR = ti('party');
  const par = themeSheets(PAR, 0, MINE);
  const confetti = (fx: Ctx, t: number) => {
    const cols = [PAL.red, PAL.yellow, PAL.cyan, PAL.green, PAL.magenta];
    for (let i = 0; i < 7; i++) P(fx, (i * 11 + 3) % 30, (t * 2 + i * 9) % 30, cols[i % 5], 1, 1);
  };
  add('toast', (l) => {
    const { t, ink, fx } = l;
    man(ink, par, tp(0), OX, OY - (t % 10 < 2 ? 1 : 0));
    for (let i = 0; i < 3; i++) {
      const k = (t + i * 3) % 8;
      P(fx, OX + 10 + (i % 2), OY - 3 - k, PAL.yellow);
    }
    confetti(fx, t);
  });

  add('gift', (l) => {
    const { t, ink, fx } = l;
    man(ink, par, tp(t % 10 < 5 ? 2 : 1), OX, OY);
    if (t % 10 >= 5) {
      heart(fx, OX + 14, OY - 2 - (t % 5), PAL.red);
      heart(fx, OX - 6, OY - (t % 5), PAL.coral);
    }
  });

  add('karaoke', (l) => {
    const { t, ink, fx } = l;
    const sw = [0, 1, 0, -1][Math.floor(t / 3) % 4];
    man(ink, par, own(PAR, M.mouth), OX + sw, OY);
    // микрофон у рта
    P(ink, OX + 6 + sw, OY + 6, PAL.night, 3, 3);
    P(ink, OX + 6 + sw, OY + 6, PAL.steel, 1, 1);
    P(ink, OX + 7 + sw, OY + 9, PAL.ink, 1, 3);
    P(ink, OX + 4 + sw, OY + 7, PAL.ink, 2, 1);
    for (let i = 0; i < 3; i++) {
      const k = (t + i * 4) % 12;
      note(fx, OX + 12 + i * 4 + sw, OY + 4 - k, [PAL.white, PAL.yellow, PAL.cyan][i]);
    }
  });

  // ═══ Купала ═══
  const KUP = ti('kupala');
  const kup = themeSheets(KUP, 0, MINE);
  const firefly = (fx: Ctx, t: number) => {
    for (let i = 0; i < 4; i++) {
      const a = t / 3 + i * 1.7;
      if ((t + i) % 4 < 3) P(fx, Math.round(15 + Math.cos(a) * (10 + i)), Math.round(10 + Math.sin(a * 1.3) * 8), PAL.yellow);
    }
  };
  add('shh', (l) => {
    const { t, ink, fx } = l;
    man(ink, kup, tp(2), OX, OY);
    firefly(fx, t);
    // шёпот: волна от пальца у губ
    if (t % 10 < 6) for (let i = 0; i < 3; i++) P(fx, OX + 13 + i * 2, OY + 6 - i, PAL.mist, 1, 1 + i);
  });

  add('fireJump', (l) => {
    const { t, ink, fx } = l;
    // костёр по центру; прыжок туда и обратно: присел — резко взлетел — приземлился с пылью
    P(ink, 12, 22, PAL.umber, 8, 1);
    P(ink, 13, 21, PAL.umber, 6, 1);
    const back = t >= 10;
    const k = t % 10;
    const L0 = -1;
    const R0 = 21;
    const from = back ? R0 : L0;
    const to = back ? L0 : R0;
    // 0–1 присел, 2–6 полёт, 7 приземление, 8–9 стоит
    const air = k >= 2 && k <= 6 ? (k - 2 + 0.5) / 5 : -1;
    const x = air < 0 ? (k < 2 ? from : to) : Math.round(from + (to - from) * air);
    const y = air < 0 ? OY + 3 + (k === 1 || k === 7 ? 1 : 0) : Math.round(OY + 3 - Math.sin(air * Math.PI) * 8);
    // след в полёте
    if (air > 0) for (let i = 1; i <= 2; i++) P(fx, x + 6 - Math.sign(to - from) * i * 3, y + 8 + i, PAL.yellow, 1, 1);
    man(ink, kup, air >= 0 ? F.JUMP : F.D, x, y, { flip: back });
    // пламя тянется за прыгуном, над огнём — сноп искр
    const lean = air >= 0 ? Math.sign(to - from) : 0;
    flame(fx, 14 + lean, 21, 6 + (t % 2) + (air > 0.3 && air < 0.7 ? 2 : 0), t);
    flame(fx, 17 + lean, 21, 8 + ((t + 1) % 2) + (air > 0.3 && air < 0.7 ? 2 : 0), t + 2);
    if (air > 0.3 && air < 0.8) for (const [dx, dy] of [[-3, -6], [4, -8], [0, -10]]) spark(fx, 16 + dx, 14 + dy + k, PAL.yellow);
    if (k === 7 || k === 8) for (const dx of [-2, 13]) P(fx, to + dx, OY + 18, PAL.mist, 2, 1);
  });

  add('daisy', (l) => {
    const { t, ink, fx } = l;
    man(ink, kup, own(KUP, M.hold), OX, OY);
    // ромашка в руках: лепестки отлетают по одному, в конце — сердце
    const cx = OX + 14;
    const cy = OY + 4;
    P(ink, OX + 10, OY + 10, PAL.white, 2, 1);
    for (let i = 0; i < 6; i++) P(ink, cx - Math.floor(i / 2), cy + 2 + i, PAL.forest);
    const PET: [number, number][] = [[-4, -1], [-3, -4], [0, -5], [3, -4], [4, -1], [2, 2], [-2, 2]];
    const left = Math.max(0, PET.length - Math.floor(t / 2));
    for (let i = 0; i < left; i++) P(ink, cx + PET[i][0], cy + PET[i][1], PAL.white, 2, 2);
    P(ink, cx - 1, cy - 1, PAL.yellow, 3, 3);
    P(ink, cx, cy, PAL.amber, 1, 1);
    // оторванный лепесток летит вниз
    const k = t % 2;
    if (left > 0 && left < PET.length) P(fx, cx + PET[left][0] + 2 + k, cy + PET[left][1] + 4 + k * 3, PAL.white, 2, 1);
    if (t >= 15) heart(fx, cx - 2, cy - 6 - (t - 15), PAL.red);
    // «любит — не любит»: сердечко и крестик по очереди
    if (t < 15) {
      if (Math.floor(t / 2) % 2) for (let i = 0; i < 4; i++) { P(fx, 2 + i, 3 + i, PAL.mist); P(fx, 5 - i, 3 + i, PAL.mist); }
      else heart(fx, 1, 3, PAL.coral);
    }
  });

  // ═══ Ва-банк ═══
  const CAS = ti('casino');
  const cas = themeSheets(CAS, 0, MINE);
  add('lever', (l) => {
    const { t, ink, fx } = l;
    man(ink, cas, tp(Math.floor(t / 2) % 2), OX, OY + 3);
    // окно барабанов над головой
    P(ink, 6, 0, PAL.wine, 20, 7);
    P(ink, 7, 1, PAL.white, 18, 5);
    const sym = ['7', 'X', '$', '7', '#'];
    const stop = [8, 12, 16];
    for (let i = 0; i < 3; i++) {
      const s = t >= stop[i] ? '7' : sym[(t + i * 2) % sym.length];
      l.text.push({ s, x: 30 + i * 18, y: 5, col: s === '7' ? PAL.red : PAL.ink, size: 1 });
    }
    if (t >= 17) spark(fx, 28, 2, PAL.yellow);
  });

  add('allIn', (l) => {
    const { t, ink, fx } = l;
    // стол с сукном, стопка фишек едет вперёд
    man(ink, cas, own(CAS, M.hold), OX, OY);
    P(ink, 0, OY + 13, PAL.forest, 32, 4);
    P(ink, 0, OY + 13, PAL.green, 32, 1);
    const push = Math.min(6, Math.max(0, t - 6));
    const cols = [PAL.red, PAL.white, PAL.blue, PAL.red, PAL.white, PAL.blue, PAL.red];
    for (let i = 0; i < 4; i++) for (const sx of [0, 7]) P(ink, OX + 1 + sx + push, OY + 12 - i, cols[(i + sx) % 7], 5, 1);
    if (t >= 12 && t % 2) for (const [dx, dy] of [[-2, 2], [10, -1], [12, 6]]) spark(fx, OX + 3 + push + dx, OY + 4 + dy, PAL.yellow);
  });

  add('payday', (l) => {
    const { t, ink, fx } = l;
    man(ink, cas, tp(2), OX, OY - [2, 3, 1][Math.floor(t / 2) % 3] + 2);
    for (let i = 0; i < 8; i++) {
      const y = (t * 2 + i * 7) % 32 - 4;
      coin(fx, (i * 7 + 2) % 29, y, t + i);
    }
  });

  // «Вычислил»: обычный кадр — резкие склейки ближе и ближе — глаза-щёлки на красном; без подписи, кадр во весь стикер
  MEMES.busted = (g: Ctx, t: number) => {
        g.imageSmoothingEnabled = false;
        // без подписи: квадратный кадр во весь стикер, склейки ближе и ближе
        const shot = t < 6 ? 0 : t < 9 ? 1 : t < 12 ? 2 : 3;
        const fr = actorFrame(shot === 0 ? (t % 6 === 3 ? F.D + 1 : F.D) : mine(M.sus), actor);
        const K = [4, 5, 6, 7][shot];
        const [cx, cy] = [[7, 9], [7, 8], [7, 7], [7, 6]][shot];
        const B = 4;
        const W = 88;
        g.fillStyle = shot === 3 ? PAL.wine : PAL.night;
        g.fillRect(B, B, W, W);
        if (shot === 3) {
          g.fillStyle = PAL.red;
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2 + (t % 2) * 0.12;
            for (let r = 34; r < 80; r += 2) {
              const x = Math.round(48 + Math.cos(a) * r);
              const y = Math.round(48 + Math.sin(a) * r);
              if (x >= B && x < B + W && y >= B && y < B + W) g.fillRect(x - 1, y - 1, 3, 3);
            }
          }
        }
        g.save();
        g.beginPath();
        g.rect(B, B, W, W);
        g.clip();
        const shake = shot === 3 ? (t % 2 ? 1 : -1) * 2 : 0;
        g.drawImage(fr, 48 - cx * K + shake, 48 - cy * K, fr.width * K, fr.height * K);
        g.restore();
        if (t === 6 || t === 9 || t === 12) {
          g.fillStyle = PAL.white;
          for (let y = B; y < B + W; y += 2) for (let x = B + ((y / 2) % 2) * 2; x < B + W; x += 4) g.fillRect(x, y, 2, 2);
        }
  };

  // 2. «Всё, я спать»: комната, на тумбочке часы 23:00, пингвин засыпает; щёлк — темно, на часах 03:00,
  // а одеяло стоит горкой и светится изнутри: из щели смотрят глаза в голубом свете экрана
  MEMES.sleep = scene(2, (l) => {
      const { t, ink, fx, bg } = l;
      const dark = t >= 10;
      const DIG: Record<string, string[]> = {
        '0': ['111', '101', '101', '101', '111'],
        '2': ['111', '001', '111', '100', '111'],
        '3': ['111', '001', '111', '001', '111'],
        ':': ['0', '1', '0', '1', '0'],
      };
      const led = (g: Ctx, str: string, x: number, y: number, c: string) => {
        let cx = x;
        for (const ch of str) {
          const d = DIG[ch];
          d.forEach((row, yy) => [...row].forEach((b, xx) => b === '1' && P(g, cx + xx, y + yy, c)));
          cx += d[0].length + 1;
        }
      };
      // комната: стена и пол
      const WALL = dark ? PAL.night : PAL.sand;
      for (let y = 2; y < 37; y++) for (let x = 1; x < 47; x++) {
        const floor = y >= 32;
        P(bg, x, y, floor ? (dark ? PAL.ink : PAL.clay) : (x + y) % 2 === 0 && y % 4 === 0 ? (dark ? PAL.navy : PAL.tan) : WALL);
      }
      // кровать: спинка слева, матрас, ножки
      const WOOD = dark ? PAL.plum : PAL.umber;
      P(ink, 2, 14, WOOD, 3, 20);
      P(ink, 2, 13, dark ? PAL.ink : PAL.rust, 3, 1);
      P(ink, 2, 26, WOOD, 27, 5);
      P(ink, 3, 27, dark ? PAL.ink : PAL.rust, 25, 1);
      P(ink, 4, 31, WOOD, 2, 3);
      P(ink, 25, 31, WOOD, 2, 3);
      // тумбочка с часами
      P(ink, 31, 24, dark ? PAL.plum : PAL.clay, 14, 10);
      P(ink, 32, 28, dark ? PAL.ink : PAL.umber, 12, 1);
      P(ink, 37, 30, dark ? PAL.steel : PAL.sand, 2, 1);
      P(ink, 28, 16, PAL.ink, 19, 8);
      P(ink, 29, 17, dark ? PAL.ink : PAL.night, 17, 6);
      led(ink, dark ? '03:00' : '23:00', 29, 18, dark && t % 6 < 3 ? PAL.coral : PAL.red);
      if (dark) for (let x = 28; x < 47; x++) if (x % 2 === 0) P(fx, x, 15, PAL.wine);
      // подушка
      P(ink, 6, 20, dark ? PAL.dusk : PAL.white, 9, 6);
      P(ink, 7, 19, dark ? PAL.dusk : PAL.white, 7, 1);
      P(ink, 6, 25, dark ? PAL.night : PAL.mist, 9, 1);
      if (!dark) {
        // голова пингвина на подушке, одеяло по шею
        const fr = t < 4 ? F.D : F.D + 1;
        ink.drawImage(pen.body, fr * CH_W, 0, CH_W, 9, 5, 13, CH_W, 9);
        P(ink, 13, 21, PAL.blue, 16, 6);
        P(ink, 15, 20, PAL.blue, 13, 1);
        P(ink, 13, 21, PAL.cyan, 16, 1);
        for (let x = 16; x < 28; x += 4) for (let y = 23; y < 26; y += 2) P(ink, x + ((y >> 1) % 2) * 2, y, PAL.navy);
        // «z» поднимаются по одной
        if (t >= 4) for (let i = 0; i < 3; i++) if (t - 4 >= i * 2) l.text.push({ s: 'z', x: 40 + i * 10, y: 24 - i * 9 - ((t - 4 - i) % 2), col: PAL.night, size: 1 });
      } else {
        // одеяло горкой над головой (поднято коленками и рукой с телефоном)
        const BL = PAL.navy;
        for (let x = 4; x < 29; x++) {
          const h = x < 18 ? 13 - Math.round(Math.abs(x - 11) * 0.7) : 6 - Math.round((x - 18) * 0.15);
          P(ink, x, 26 - h, BL, 1, h);
          P(ink, x, 26 - h, PAL.blue, 1, 1);
        }
        if (t >= 11) {
          // щель спереди — арка; внутри в мягком свете экрана круглая голова пингвина
          const on = t % 5 !== 4;
          const R = (x: number, y: number) => Math.hypot(x - 11.5, (y - 21.5) * 1.15);
          for (let y = 16; y < 26; y++) for (let x = 6; x < 18; x++) {
            const d = R(x, y);
            if (d > 6) continue;
            // свет: ярче снизу, у телефона; к краям — дизерингом в тень
            const lit = Math.hypot(x - 11.5, y - 25) ;
            P(ink, x, y, d > 5.2 ? PAL.ink : lit < 4 ? (on ? PAL.cyan : PAL.blue) : lit < 6 ? ((x + y) % 2 ? PAL.blue : PAL.navy) : PAL.night);
          }
          // голова: чёрная, белая маска лица, подсвеченная снизу голубым
          for (let y = 17; y < 25; y++) for (let x = 8; x < 16; x++) {
            const d = Math.hypot(x - 11.5, (y - 21) * 1.1);
            if (d > 4) continue;
            const face = Math.hypot(x - 11.5, (y - 21.6) * 1.3) < 3;
            P(ink, x, y, face ? (y >= 22 ? (on ? PAL.white : PAL.mist) : PAL.mist) : y >= 22 ? PAL.dusk : PAL.night);
          }
          // глаза: широко открытые, к концу — уставшие щёлочки
          const tired = t >= 18;
          for (const ex of [10, 13]) {
            if (tired) P(ink, ex - 1, 21, PAL.ink, 2, 1);
            else {
              P(ink, ex - 1, 20, PAL.white, 2, 2);
              P(ink, ex - (t % 6 < 3 ? 1 : 0), 21, PAL.ink);
            }
          }
          P(ink, 11, 22, PAL.orange, 2, 1);
          P(ink, 11, 23, PAL.rust, 2, 1);
          // телефон снизу: виден торец и свет над ним
          P(ink, 9, 24, PAL.ink, 6, 2);
          P(ink, 9, 24, on ? PAL.white : PAL.mist, 6, 1);
          // свет из щели ложится на край одеяла вокруг арки
          for (let x = 4; x < 20; x++) {
            const h = x < 18 ? 13 - Math.round(Math.abs(x - 11) * 0.7) : 6;
            const y = 26 - h;
            if (Math.abs(x - 11.5) < 7.5) P(fx, x, y, Math.abs(x - 11.5) < 4 ? PAL.cyan : PAL.blue);
          }
          for (const [x, y] of [[5, 19], [5, 22], [18, 21], [18, 24]]) P(fx, x, y, on ? PAL.blue : PAL.navy, 1, 2);
        }
      }
    });

  // 3. «Последний раз»: три прокрута всё быстрее, почти 777 — и мимо; финал — в бочке, из кошелька вылетает моль
  MEMES.lastTime = scene(3, (l) => {
      const { t, ink, fx } = l;
      const starts = [0, 6, 10, 13];
      const broke = t >= 15;
      const c = t < 6 ? 0 : t < 10 ? 1 : 2;
      const k = Math.min(t, 12) - starts[c];
      const len = starts[c + 1] - starts[c];
      const hold = t >= 13;
      const y0 = OY + 3;
      if (!broke) man(ink, cas, hold ? own(CAS, M.sus) : tp(k < 1 ? 1 : 0), OX + (hold && t % 2 ? 1 : 0), y0);
      else {
        // тот же смокинг — грязный и драный: пыль, дыра на рукаве, бабочка набок, волосы торчат,
        // карманы вывернуты, взгляд в пустоту
        man(ink, cas, F.D, OX, y0);
        // круги под глазами
        P(ink, OX + 3, y0 + 7, PAL.grape);
        P(ink, OX + 8, y0 + 7, PAL.grape);
        P(ink, OX + 5, y0 + 7, PAL.ink, 2, 1);
        P(ink, OX - 1, y0 + 12, PAL.white, 2, 2);
        P(ink, OX + 11, y0 + 12, PAL.white, 2, 2);
        if (t % 4 < 2) P(fx, OX + 1, y0 + 5, PAL.cyan, 1, 1);
        // раскрытый пустой кошелёк в руке, из него моль

        const m = t - 15;
        const mx = OX + 12 + Math.round(Math.sin(m * 1.5) * 2);
        const my = y0 + 10 - m * 2;
        const flap = t % 2;
        P(fx, mx, my, PAL.white, 1, 2);
        P(fx, mx - 1 - flap, my - flap, PAL.white, 1 + flap, 2 - flap);
        P(fx, mx + 1, my - flap, PAL.white, 1 + flap, 2 - flap);
      }
      P(ink, 6, 0, PAL.wine, 20, 7);
      P(ink, 7, 1, PAL.white, 18, 5);
      const sym = ['X', '$', '7', '#', '7'];
      const fin = ['7', '7', 'X'];
      for (let i = 0; i < 3; i++) {
        const stopped = hold || k >= Math.max(1, len - 3 + i);
        const ch = hold ? fin[i] : stopped ? (i < 2 ? '7' : c === 1 ? '$' : '#') : sym[(t * 3 + i * 2) % sym.length];
        // в сером финале цветной остаётся только красный «мимо»
        const col = broke ? (ch === 'X' ? PAL.red : PAL.dusk) : ch === '7' ? PAL.red : PAL.ink;
        l.text.push({ s: ch, x: 30 + i * 18, y: 5, col, size: 1 });
      }
      // табло гаснет: проигрыш
      if (broke) {
        P(fx, 7, 1, PAL.night, 18, 5);
        l.gray = true;
      }
      if (!broke) for (let i = 0; i <= c; i++) if ((t + i) % 3 < 2) P(fx, OX + 11 + i, y0 + 1 + i * 2 + (t % 3), PAL.cyan, 1, 2);
      if (!hold) l.text.push({ s: String(c + 1), x: 10, y: 30, col: PAL.yellow, size: 1 });
    });}

/** Есть ли у позы своя сцена (свой жест фигурки). */
export function hasGesture(pose: MyPose): boolean {
  build();
  return !!GESTURES[pose];
}

/**
 * Нарисовать жест. Сцены рассчитаны на подпись снизу в одну-две строки; без подписи сцена ниже, по центру,
 * со строкой сверху — тоже чуть ниже, чтобы предметы над головой не налезали на неё.
 */
export function drawGesture(g: Ctx, pose: MyPose, t: number, caption: { lines: number; head: boolean }): void {
  build();
  const s = GESTURES[pose];
  if (s) s(g, t, caption.head ? 4 : caption.lines === 0 ? 5 : 0);
}

/** Нарисовать сцену мема (без подписи). */
export function drawMeme(g: Ctx, id: 'busted' | 'sleep' | 'lastTime', t: number): void {
  build();
  MEMES[id]?.(g, t);
}
