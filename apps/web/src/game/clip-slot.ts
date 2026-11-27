import { PAL } from '@kto/assets';
import type { Dict, SlotOutcome, SlotRecord } from '@kto/game-core';
import { SLOT_SPINS, SLOT_STOP_MS, SLOT_SYMBOLS, SLOT_TEASE_MS, fmt, slotWindow } from '@kto/game-core';
import { text } from './art';
import { canvas } from './pixels';
import {
  BODY_W, BTN_H, BTN_PULL, BTN_Y, CANDLE_Y, PANEL_TOP, REELS_H, REELS_X, REELS_Y, REEL_GAP, REEL_W, SYM_K, SYM_W, TOP_H, TOP_Y,
  makeSlotBackdrop, makeSlotBody, makeSlotSymbols,
} from './slot-art';
import type { Sfx } from './audio';

/**
 * «Крутка» в клипе и фильме — тот же автомат, что у игрока на экране (slot-ui.ts): лампы по краю поля и
 * «КРУТКА!», сверху падает автомат с коробом, фонарём, барабанами и рычагом; рычаг опускается, барабаны
 * тормозят по очереди, на табло — что выпало (после дубля это уже не тайна).
 *
 * Без Phaser и без clip() — рисует на холсте клипа (телефон) и в монтаже на сервере (film-native.ts).
 * Время — мировое (от World.crowd), поэтому замедление разбора замедляет и автомат.
 */

/** Как в slot-ui.ts: падение и подъём; рычаг в клипе дёргается, когда автомат дёрнул бы сам (окна — slots.ts). */
const DROP_MS = 400;
const RISE_MS = 300;
const LEVER_MS = 220;
const SPEED = 0.5;
const ROW = SYM_W * SYM_K + 4;
const N = SLOT_SYMBOLS.length;
const strip = (r: number, k: number): number => (((k * 5 + r * 4) % N) + N) % N;
/** Цвета итога на табло — как в игре. */
const RESULT: Record<SlotOutcome, string> = {
  seven: PAL.yellow,
  star: PAL.yellow,
  fist: PAL.amber,
  peek: PAL.cyan,
  bolt: PAL.yellow,
  spot: PAL.coral,
  weight: PAL.mist,
  reel: PAL.coral,
  skull: PAL.red,
  miss: PAL.mist,
};
const SOUND: Partial<Record<SlotOutcome, Sfx>> = { seven: 'slotJackpot', star: 'slotCoins', fist: 'slotCoins', peek: 'slotCoins', skull: 'slotSkull' };

interface Art {
  bg: HTMLCanvasElement;
  body: HTMLCanvasElement;
  syms: HTMLCanvasElement;
  /** Тень круглого барабана и блики стекла поверх ленты (прозрачный холст). */
  glass: HTMLCanvasElement;
}
let art: Art | null = null;

function glassOverlay(): HTMLCanvasElement {
  const rw = REEL_W * 3 + REEL_GAP * 2;
  const { c, g } = canvas(rw, REELS_H);
  const dot = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };
  for (let i = 0; i < 3; i++) {
    const x0 = i * (REEL_W + REEL_GAP);
    const band = (y: number, col: string, stepX: number) => {
      for (let x = y % 2; x < REEL_W; x += stepX) {
        dot(x0 + x, y, col);
        dot(x0 + x, REELS_H - 1 - y, col);
      }
    };
    for (let y = 0; y < 4; y++) band(y, PAL.dusk, 1);
    for (let y = 4; y < 8; y++) band(y, PAL.steel, 1 + (y - 4));
    for (let y = 8; y < 12; y++) band(y, PAL.slate, 2 + (y - 8) * 2);
    g.fillStyle = PAL.slate;
    g.fillRect(x0, 3, 1, REELS_H - 6);
    g.fillRect(x0 + REEL_W - 1, 3, 1, REELS_H - 6);
  }
  g.fillStyle = PAL.white;
  for (const sx of [12, 22, 92]) {
    for (let y = 4; y < REELS_H - 4; y++) {
      const x = sx + Math.floor((REELS_H - y) / 2);
      if (y % 2 === 0) g.fillRect(x, y, sx === 22 ? 1 : 2, 1);
    }
  }
  return c;
}

function getArt(): Art {
  return (art ??= { bg: makeSlotBackdrop(), body: makeSlotBody(), syms: makeSlotSymbols(), glass: glassOverlay() });
}

/** Ход одного барабана: где лента (px) в момент e (мс от рывка) и встал ли он. */
function reelPos(e: number, b: number): { p: number; targetK: number; landedAt: number } {
  const from = SPEED * b;
  const targetK = Math.ceil(from / ROW) + 3;
  const to = targetK * ROW;
  const dur = (2 * (to - from)) / SPEED;
  const landedAt = b + dur;
  if (e < b) return { p: SPEED * Math.max(0, e), targetK, landedAt };
  const u = Math.min(dur, e - b);
  return { p: from + SPEED * u - (SPEED * u * u) / (2 * dur), targetK, landedAt };
}

/** Барабаны вращения в момент now (мс от рывка — pe; рывок — как у автомата, сам в своё время). */
export interface SlotSpinState {
  /** Какое вращение идёт: следующее начинается с рывка в своём окне, до него видно, где встало прошлое. */
  k: number;
  spin: SlotRecord;
  pe: number;
  tease: boolean;
  reels: { p: number; targetK: number; landedAt: number }[];
  done: boolean;
}

export function slotSpinAt(showAt: number, spins: readonly SlotRecord[], now: number): SlotSpinState {
  let k = 0;
  for (let j = 1; j < spins.length; j++) if (now >= slotWindow(showAt, j).auto) k = j;
  const spin = spins[k];
  const pe = now - slotWindow(showAt, k).auto;
  const tease = spin.reels[0] === spin.reels[1];
  const reels = slotStops(tease).map((s) => reelPos(pe, s));
  return { k, spin, pe, tease, reels, done: pe >= reels[2].landedAt };
}

/** Когда (мс от рывка) барабаны начинают тормозить: третий при двух одинаковых — позже, с интригой. */
export function slotStops(tease: boolean): number[] {
  return SLOT_STOP_MS.map((s, i) => s + (i === 2 && tease ? SLOT_TEASE_MS : 0));
}

/** Когда (мс от рывка) встаёт барабан, начавший тормозить в b. */
export function reelLandMs(b: number): number {
  return reelPos(0, b).landedAt;
}

/** Символ на ленте барабана r под номером k (как на автомате). */
export function stripSymbol(r: number, k: number): number {
  return strip(r, k);
}

export interface ClipSlotFrame {
  /** Холст клипа (логические пиксели 180×320, поле — от ay до py). */
  g: CanvasRenderingContext2D;
  font: string;
  t: Dict;
  ay: number;
  py: number;
  /** «Крутка» в мире: начало, стоп-кадр, конец. */
  warnAt: number;
  showAt: number;
  resumeAt: number;
  /** Мировое время кадра. */
  now: number;
  /** Чьи вращения показать (по порядку); пусто — только лампы и «КРУТКА!». */
  spins: readonly SlotRecord[];
  /** Звук (один раз на ключ — повтор кадра не повторяет звук). */
  sound?: (key: string, sfx: Sfx, step?: number) => void;
  /** Без автомата: только лампы и «КРУТКА!» до стоп-кадра (вращения — табло над головами, drawSlotHeads). */
  warnOnly?: boolean;
}

/** Нарисовать «Крутку» в кадре клипа. Вызывать каждый кадр, пока мир внутри [warnAt, resumeAt + RISE_MS). */
export function drawClipSlot(f: ClipSlotFrame): void {
  const { g, ay, py, now } = f;
  if (now < f.warnAt || now >= f.resumeAt + RISE_MS) return;
  const a = getArt();
  const ts = f.t.slot;
  if (f.warnOnly) {
    if (now < f.showAt) drawWarn(f, ts.warn);
    return;
  }
  // лампы и «КРУТКА!» — до автомата (и всю паузу, если чьё вращение неизвестно)
  if (now < f.showAt || !f.spins.length) {
    if (now < f.resumeAt) drawWarn(f, ts.warn);
    return;
  }
  const e = now - f.showAt;
  const oy = e < DROP_MS ? -Math.round((1 - easeOut(e / DROP_MS)) * (py - ay + 10)) : now >= f.resumeAt ? -Math.round(((now - f.resumeAt) / RISE_MS) * (py - ay + 10)) : 0;
  const bx = 4;
  // ниже плашки подписи ролика: в коробе — отсчёт загадки, ниже — барабаны и табло; лоток уходит за нижнюю полосу
  const by = ay + 39 + oy;
  // бархат под автоматом
  g.globalAlpha = 0.85;
  g.drawImage(a.bg, 0, 0, 180, py - ay, 0, ay, 180, py - ay);
  g.globalAlpha = 1;
  g.drawImage(a.body, bx, by);

  const { k, spin, pe, tease, reels, done } = slotSpinAt(f.showAt, f.spins, now);
  const nextWin = k + 1 < f.spins.length ? slotWindow(f.showAt, k + 1) : null;
  const btnOpen = pe < 0 || (!!nextWin && now >= nextWin.from);
  const key = `${f.warnAt}:${k}:`;
  if (pe >= 0) f.sound?.(key + 'lever', 'slotLever');
  reels.forEach((r, i) => pe >= r.landedAt && f.sound?.(key + 'r' + i, 'slotStop', i));
  if (done) {
    const sfx = SOUND[spin.outcome] ?? (spin.outcome === 'miss' && tease ? 'slotTease' : undefined);
    if (sfx) f.sound?.(key + 'res', sfx);
  }

  // барабаны: лента, символы обрезаны окном (без clip())
  const rx0 = bx + REELS_X;
  const ry0 = by + REELS_Y;
  const sz = SYM_W * SYM_K;
  g.fillStyle = PAL.ink;
  g.fillRect(rx0, ry0, REEL_W * 3 + REEL_GAP * 2, REELS_H);
  reels.forEach((r, i) => {
    const x0 = rx0 + i * (REEL_W + REEL_GAP);
    g.fillStyle = PAL.white;
    g.fillRect(x0, ry0, REEL_W, REELS_H);
    const settle = pe - r.landedAt;
    const bounce = settle >= 0 && settle < 160 ? Math.round(Math.sin((settle / 160) * Math.PI) * 3) : 0;
    const p = Math.max(0, pe) > 0 ? r.p + bounce : 0;
    const k0 = Math.floor(p / ROW);
    const frac = p - k0 * ROW;
    for (let d = -2; d <= 2; d++) {
      const idx = k0 + d === r.targetK ? SLOT_SYMBOLS.indexOf(spin.reels[i]) : strip(i, k0 + d);
      const y = Math.round(ry0 + REELS_H / 2 - sz / 2 - d * ROW + frac);
      const top = Math.max(y, ry0);
      const bot = Math.min(y + sz, ry0 + REELS_H);
      if (bot <= top) continue;
      // источник — целыми пикселями символа (×3), иначе край символа «плывёт»
      const s0 = Math.floor((top - y) / SYM_K);
      const s1 = Math.ceil((bot - y) / SYM_K);
      g.drawImage(a.syms, idx * SYM_W, s0, SYM_W, s1 - s0, x0 + (REEL_W - sz) / 2, y + s0 * SYM_K, sz, (s1 - s0) * SYM_K);
    }
  });
  // поля за окном барабанов: символ мог вылезти на пиксель-два при обрезке целыми пикселями
  g.drawImage(a.body, REELS_X, REELS_Y - 3, REEL_W * 3 + REEL_GAP * 2, 3, rx0, ry0 - 3, REEL_W * 3 + REEL_GAP * 2, 3);
  g.drawImage(a.body, REELS_X, REELS_Y + REELS_H, REEL_W * 3 + REEL_GAP * 2, 3, rx0, ry0 + REELS_H, REEL_W * 3 + REEL_GAP * 2, 3);
  g.drawImage(a.glass, rx0, ry0);

  // лампочки короба бегут (пока крутятся — быстрее), фонарь, кнопка, рычаг
  const spinning = pe >= 0 && !done;
  const step = Math.floor(now / (spinning ? 70 : 160));
  const bulbs: [number, number][] = [];
  for (let x = 10; x <= BODY_W - 12; x += 8) bulbs.push([x, TOP_Y]);
  for (let y = TOP_Y + 9; y <= TOP_Y + TOP_H - 9; y += 9) bulbs.push([BODY_W - 8, y]);
  for (let x = BODY_W - 12; x >= 10; x -= 8) bulbs.push([x, TOP_Y + TOP_H - 2]);
  for (let y = TOP_Y + TOP_H - 9; y >= TOP_Y + 9; y -= 9) bulbs.push([6, y]);
  bulbs.forEach(([x, y], k) => {
    fill(g, bx + x - 1, by + y - 1, 4, 4, PAL.ink);
    fill(g, bx + x, by + y, 2, 2, (k + step) % 3 === 0 ? PAL.white : PAL.amber);
  });
  const party = done && (spin.outcome === 'seven' || spin.outcome === 'star') && pe - reels[2].landedAt < 2400;
  drawCandle(g, now, bx, by, spinning, party);
  drawButton(g, f, bx, by, btnOpen);
  const lk = pe < 0 ? 0 : pe < LEVER_MS ? pe / LEVER_MS : pe < LEVER_MS * 2 ? 1 - (pe - LEVER_MS) / LEVER_MS : 0;
  drawLever(g, bx, by, lk);

  // табло: «Вращение 2 из 3» и что выпало в последнем вставшем
  const px0 = by + PANEL_TOP;
  const cx = bx + BODY_W / 2;
  if (pe >= 0 || k > 0) text(g, fmt(ts.spinOf, { n: k + 1, m: SLOT_SPINS }), cx, px0 + 10, PAL.mist, f.font, { outline: null, maxWidth: BODY_W - 16 });
  const shown = done ? spin : k > 0 ? f.spins[k - 1] : null;
  if (shown) {
    const st = shown.reels[0] === shown.reels[1];
    const label = shown.outcome === 'miss' && st ? ts.tease : ts[shown.outcome];
    text(g, label, cx, px0 + 22, RESULT[shown.outcome], f.font, { outline: null, maxWidth: BODY_W - 16 });
  }
  // вспышка итога: 777 и звезда — золотом, череп — красным
  const since = pe - reels[2].landedAt;
  if (done && since < 600 && (spin.outcome === 'seven' || spin.outcome === 'star' || spin.outcome === 'skull')) {
    g.globalAlpha = 0.45 * (1 - since / 600);
    g.fillStyle = spin.outcome === 'skull' ? PAL.red : PAL.yellow;
    g.fillRect(0, ay, 180, py - ay);
    g.globalAlpha = 1;
  }
}

/** Табло над головой: x — середина, y — низ (над плашкой имени). */
export interface SlotHead {
  x: number;
  y: number;
  color: string;
  spins: readonly SlotRecord[];
}

/** Ширина и высота табло над головой: три символа ленты в рамке цвета игрока. */
export const HEAD_W = SYM_W * 3 + 2 + 4;
export const HEAD_H = SYM_W + 4;

/**
 * Повтор «Крутки» без автомата: над каждым актёром — табло из трёх символов, барабаны идут, как у автомата
 * (slotSpinAt). Рамка — цвет игрока; 777 и звезда мигают золотом, череп — красным. Без clip(): символы целиком.
 */
export function drawSlotHeads(g: CanvasRenderingContext2D, now: number, wall: number, showAt: number, heads: readonly SlotHead[], minY: number): void {
  const a = getArt();
  const placed: { x: number; y: number }[] = [];
  for (const h of heads) {
    if (!h.spins.length) continue;
    const st = slotSpinAt(showAt, h.spins, now);
    const x = Math.max(1, Math.min(179 - HEAD_W, Math.round(h.x) - Math.floor(HEAD_W / 2)));
    let y = Math.round(h.y) - HEAD_H;
    while (placed.some((p) => Math.abs(p.x - x) < HEAD_W + 1 && Math.abs(p.y - y) < HEAD_H + 1)) y -= HEAD_H + 1;
    if (y < minY) continue;
    placed.push({ x, y });
    const out = st.done ? st.spin.outcome : null;
    const blink = Math.floor(wall / 140) % 2 === 0;
    const frame = out === 'skull' && blink ? PAL.red : (out === 'seven' || out === 'star') && blink ? PAL.yellow : h.color;
    fill(g, x, y, HEAD_W, HEAD_H, frame);
    fill(g, Math.round(h.x) - 1, y + HEAD_H, 3, 1, frame);
    fill(g, x + 1, y + 1, HEAD_W - 2, HEAD_H - 2, PAL.ink);
    for (let i = 0; i < 3; i++) {
      const cx = x + 2 + i * (SYM_W + 1);
      fill(g, cx, y + 2, SYM_W, SYM_W, PAL.white);
      const landed = st.pe >= st.reels[i].landedAt;
      const idx = landed ? SLOT_SYMBOLS.indexOf(st.spin.reels[i]) : strip(i, st.pe < 0 ? 0 : Math.floor(st.reels[i].p / 40));
      g.globalAlpha = st.pe < 0 ? 0.35 : 1;
      g.drawImage(a.syms, idx * SYM_W, 0, SYM_W, SYM_W, cx, y + 2, SYM_W, SYM_W);
      g.globalAlpha = 1;
    }
  }
}

function easeOut(k: number): number {
  // падение с отскоком, как у автомата в игре
  const x = Math.min(1, Math.max(0, k));
  return x < 0.8 ? (x / 0.8) ** 2 : 1 - Math.sin(((x - 0.8) / 0.2) * Math.PI) * 0.04;
}

function fill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string, al = 1): void {
  g.globalAlpha = al;
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
  g.globalAlpha = 1;
}

/** Лампы по краю поля бегут по кругу, по центру — «КРУТКА!» крупно. */
function drawWarn(f: ClipSlotFrame, label: string): void {
  const { g, ay, py, now } = f;
  const h = py - ay;
  const step = Math.floor(now / 110);
  const pts: [number, number][] = [];
  for (let x = 4; x < 178; x += 10) pts.push([x, ay + 2]);
  for (let y = ay + 12; y < ay + h - 4; y += 10) pts.push([176, y]);
  for (let x = 174; x > 2; x -= 10) pts.push([x, ay + h - 4]);
  for (let y = ay + h - 14; y > ay + 2; y -= 10) pts.push([2, y]);
  pts.forEach(([x, y], k) => {
    fill(g, x - 1, y - 1, 4, 4, PAL.ink);
    fill(g, x, y, 2, 2, (k + step) % 3 === 0 ? PAL.yellow : PAL.amber);
  });
  const blink = Math.floor(now / 220) % 2 === 0;
  const y = ay + 70;
  fill(g, 28, y - 4, 124, 24, PAL.ink, 0.7);
  text(g, label, 90, y, blink ? PAL.yellow : PAL.amber, f.font, { size: 2, outline: null, maxWidth: 120 });
}

/** Фонарь-«свеча»: пока крутятся — мигает красным, на 777 и звезде — салют. */
function drawCandle(g: CanvasRenderingContext2D, now: number, bx: number, by: number, spinning: boolean, party: boolean): void {
  const x = bx + BODY_W / 2 - 4;
  const y = by + CANDLE_Y - 13;
  const blink = Math.floor(now / 120) % 2 === 0;
  const spin = spinning && Math.floor(now / 250) % 2 === 0;
  const topC = party ? (blink ? PAL.white : PAL.red) : spin ? PAL.red : PAL.wine;
  const botC = party ? (blink ? PAL.red : PAL.white) : PAL.slate;
  fill(g, x, y, 8, 11, PAL.ink);
  fill(g, x + 1, y, 6, 1, PAL.mist);
  fill(g, x + 1, y + 1, 6, 4, topC);
  fill(g, x + 1, y + 5, 6, 1, PAL.ink);
  fill(g, x + 1, y + 6, 6, 4, botC);
  fill(g, x + 2, y + 2, 1, 2, PAL.white, 0.7);
  fill(g, x + 2, y + 7, 1, 2, PAL.white, 0.7);
  if (party || spin) fill(g, x - 3, y - 2, 14, 14, topC, 0.25);
}

/** Кнопка «Крутить»: горит, пока окно вращения ждёт рывка, потом погашена. */
function drawButton(g: CanvasRenderingContext2D, f: ClipSlotFrame, bx: number, by: number, open: boolean): void {
  const x = bx + BTN_PULL.x;
  const y = by + BTN_Y;
  const side = 4;
  fill(g, x - 1, y - 1, BTN_PULL.w + 2, BTN_H + side + 2, PAL.ink);
  fill(g, x, y + BTN_H, BTN_PULL.w, side, open ? PAL.orange : PAL.plum);
  fill(g, x, y, BTN_PULL.w, BTN_H, open ? PAL.amber : PAL.umber);
  fill(g, x, y, BTN_PULL.w, 2, open ? PAL.yellow : PAL.brick);
  fill(g, x, y, 1, BTN_H, open ? PAL.yellow : PAL.brick);
  g.globalAlpha = open ? 1 : 0.5;
  text(g, f.t.slot.pull, x + BTN_PULL.w / 2, y + 3, open ? PAL.ink : PAL.sand, f.font, { outline: null });
  g.globalAlpha = 1;
}

/** Рычаг справа от корпуса: k — 0 вверху, 1 внизу. */
function drawLever(g: CanvasRenderingContext2D, bx: number, by: number, k: number): void {
  const lx = bx + BODY_W;
  const piv = by + REELS_Y + REELS_H / 2 + 6;
  const top = by + REELS_Y + 2 + Math.round(k * 34);
  fill(g, lx, piv - 2, 9, 16, PAL.ink);
  fill(g, lx + 1, piv - 1, 7, 14, PAL.steel);
  fill(g, lx + 1, piv - 1, 7, 1, PAL.mist);
  fill(g, lx + 3, Math.min(top, piv), 3, Math.abs(piv + 2 - top) + 1, PAL.ink);
  fill(g, lx + 4, Math.min(top, piv), 1, Math.abs(piv + 2 - top), PAL.mist);
  fill(g, lx + 1, top - 4, 7, 9, PAL.ink);
  fill(g, lx, top - 3, 9, 7, PAL.ink);
  fill(g, lx + 1, top - 3, 7, 7, PAL.wine);
  fill(g, lx + 1, top - 3, 5, 5, PAL.red);
  fill(g, lx + 2, top - 3, 2, 2, PAL.coral);
  fill(g, lx + 2, top - 2, 1, 1, PAL.white);
}
