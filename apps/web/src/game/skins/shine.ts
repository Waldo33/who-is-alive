import { PAL } from '@kto/assets';
import type { EffectId, Lang } from '@kto/game-core';
import { canvas } from '../pixels';
import type { Ctx } from '../pixels';

/**
 * Блики поверх фигурки — только по её силуэту (source-atop) и пикселями спрайта (k×k), без сглаживания:
 * «Лёд» — поза «Замри» в своих стикерах, «Голограмма» — премиальный скин на витрине гардероба.
 * Варианты выбирал владелец 27.11.2026 (лист вариантов — blik-varianty.gif в файлах проекта).
 */

/** Где лежит фигурка на холсте: левый верх, размер в пикселях холста и масштаб спрайта. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  k: number;
}

const ICE_TINT = 'rgba(115,239,247,0.45)';
const HALO = 'rgba(255,255,255,0.45)';
const HOLO = [PAL.magenta, PAL.orchid, PAL.yellow, PAL.green, PAL.cyan, PAL.blue];

function px(g: Ctx, b: Box, i: number, j: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(b.x + i * b.k, b.y + j * b.k, b.k, b.k);
}

/** Диагональная полоса блика: проходит фигурку за несколько кадров, потом пауза до конца периода. */
function band(g: Ctx, t: number, b: Box, wide: number, period: number): void {
  const cols = Math.ceil(b.w / b.k);
  const rows = Math.ceil(b.h / b.k);
  const p = (t % period) * 3 - 6;
  if (p > cols + rows + 4) return;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const d = i + j - p;
      if (d >= 0 && d < wide) px(g, b, i, j, PAL.white);
      else if (d === -1 || d === wide) px(g, b, i, j, HALO);
    }
  }
}

/** Искра-крестик: s — длина лучей (0 — нет). */
export function sparkle(g: Ctx, x: number, y: number, s: number, core: string = PAL.white, ray: string = PAL.cyan): void {
  if (s <= 0) return;
  g.fillStyle = ray;
  g.fillRect(x - s, y, 2 * s + 1, 1);
  g.fillRect(x, y - s, 1, 2 * s + 1);
  g.fillStyle = core;
  g.fillRect(x - 1, y, 3, 1);
  g.fillRect(x, y - 1, 1, 3);
}

/** «Лёд» по силуэту: холст `g` содержит только фигурку (рисуем поверх её пикселей). */
export function iceOver(g: Ctx, t: number, b: Box): void {
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = ICE_TINT;
  g.fillRect(b.x, b.y, b.w, b.h);
  band(g, t, b, 2, 14);
  g.restore();
}

/** Иней вокруг обледеневшей фигурки — рисовать на общем холсте после неё. ray — цвет лучей искорок. */
export function iceFrost(g: Ctx, t: number, b: Box, ray: string = PAL.cyan): void {
  for (const [dx, dy, ph] of [
    [2, -2, 0],
    [b.w - 4, 6, 5],
    [-2, b.h - 10, 10],
  ] as const) {
    if ((t + ph) % 10 < 6) sparkle(g, b.x + dx, b.y + dy, 2, PAL.white, ray);
  }
}

/** «Голограмма» по силуэту: радужные диагонали плывут, по ним проходит блик. alpha — сила радуги, period — блика. */
export function holoOver(g: Ctx, t: number, b: Box, alpha = 0.28, period = 20): void {
  const cols = Math.ceil(b.w / b.k);
  const rows = Math.ceil(b.h / b.k);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.globalAlpha = alpha;
  // радуга делает полный круг (6 цветов × 4) за period кадров — лента стикера зациклена без скачка
  const shift = Math.floor((t * HOLO.length * 4) / period);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) px(g, b, i, j, HOLO[((i + j + shift) >> 2) % HOLO.length]);
  g.globalAlpha = 1;
  band(g, t, b, 1, period);
  g.restore();
}

/** Кадров в ленте голограммы: радуга (6 цветов × 4) и блик сходятся — лента зациклена без скачка. */
export const HOLO_FRAMES = 24;

/**
 * Лента кадров «переливается» для неподвижной картинки (платные стикеры в стикерпаке): кадры слева направо,
 * листать CSS-анимацией steps(HOLO_FRAMES). k — пиксель спрайта на картинке.
 */
export function holoStrip(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const { width: w, height: h } = src;
  const out = canvas(w * HOLO_FRAMES, h);
  const one = canvas(w, h);
  for (let t = 0; t < HOLO_FRAMES; t++) {
    one.g.clearRect(0, 0, w, h);
    one.g.drawImage(src, 0, 0);
    holoOver(one.g, t, { x: 0, y: 0, w, h, k }, 0.3, HOLO_FRAMES);
    out.g.drawImage(one.c, t * w, 0);
  }
  return out.c;
}

/** Искры вокруг голограммы — по очереди, рисовать на общем холсте после фигурки. */
export function holoSparks(g: Ctx, t: number, b: Box, s = 1): void {
  for (const [dx, dy, ph] of [
    [-6, 4, 0],
    [b.w + 2, -4, 7],
    [b.w + 4, Math.round(b.h * 0.5), 13],
    [-8, Math.round(b.h * 0.75), 4],
  ] as const) {
    const f = (t + 20 - ph) % 20;
    sparkle(g, b.x + dx, b.y + dy, ([0, 2, 4, 3, 1][f] ?? 0) * s);
  }
}

const NOIR = [PAL.ink, PAL.night, PAL.dusk, PAL.steel, PAL.slate, PAL.mist, PAL.white];
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const NOIR_RGB = NOIR.map(rgb);
const RED = rgb(PAL.red);
/** Красные палитры остаются красными (кровь, помада, ленты) — как в нуаре с одним цветом. */
const NOIR_KEEP = new Set([PAL.red, PAL.magenta, PAL.wine, PAL.rust].map((h) => rgb(h).join(',')));

/**
 * «Нуар» по силуэту: яркость → 7 серых палитры, красное остаётся красным, плёночное зерно (пиксель спрайта k×k
 * иногда на тон темнее или светлее, меняется по кадрам). Рисует пикселями холста — без сглаживания.
 */
export function noirOver(g: Ctx, t: number, b: Box): void {
  const d = g.getImageData(b.x, b.y, b.w, b.h);
  const a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 10) continue;
    if (NOIR_KEEP.has(`${a[i]},${a[i + 1]},${a[i + 2]}`)) {
      a.set(RED, i);
      continue;
    }
    const l = 0.3 * a[i] + 0.59 * a[i + 1] + 0.11 * a[i + 2];
    const x = Math.floor(((i / 4) % b.w) / b.k);
    const y = Math.floor(i / 4 / b.w / b.k);
    const grain = ((x * 7 + y * 13 + t * 5) % 17 === 0 ? 1 : 0) - ((x * 11 + y * 3 + t * 7) % 19 === 0 ? 1 : 0);
    const k = Math.max(0, Math.min(NOIR.length - 1, Math.round((l / 255) * (NOIR.length - 1)) + grain));
    a.set(NOIR_RGB[k], i);
  }
  g.putImageData(d, b.x, b.y);
}

/** Перекрасить силуэт по яркости в ряд цветов палитры (тёмный → светлый). */
function rampOver(g: Ctx, b: Box, cols: readonly string[]): void {
  const d = g.getImageData(b.x, b.y, b.w, b.h);
  const a = d.data;
  const R = cols.map(rgb);
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 10) continue;
    const l = 0.3 * a[i] + 0.59 * a[i + 1] + 0.11 * a[i + 2];
    a.set(R[Math.min(R.length - 1, Math.round((l / 255) * (R.length - 1)))], i);
  }
  g.putImageData(d, b.x, b.y);
}

/** Псевдослучайное 0…1 по трём целым — одно и то же на телефоне и на сервере. */
function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Где силуэт: сетка клеток спрайта (k×k) по прозрачности. */
function maskOf(g: Ctx, b: Box): boolean[][] {
  const cols = Math.ceil(b.w / b.k);
  const rows = Math.ceil(b.h / b.k);
  const a = g.getImageData(b.x, b.y, b.w, b.h).data;
  const o = Math.floor(b.k / 2);
  return Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => a[((Math.min(b.h - 1, j * b.k + o) * b.w + Math.min(b.w - 1, i * b.k + o)) * 4) + 3] > 40));
}

/** «Сепия»: старая плёнка — коричневые тона, царапины и пыль по силуэту, иногда кадр мигает. */
function sepiaOver(g: Ctx, t: number, b: Box): void {
  rampOver(g, b, [PAL.ink, PAL.umber, PAL.brick, PAL.fawn, PAL.tan, PAL.peach, PAL.sand]);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  for (let s = 0; s < 2; s++) {
    if (hash(t, s, 2) < 0.3) continue;
    g.fillStyle = s ? PAL.sand : PAL.umber;
    g.fillRect(b.x + Math.floor(hash(t, s, 1) * b.w), b.y, 1, b.h);
  }
  g.fillStyle = PAL.ink;
  for (let s = 0; s < 6; s++) g.fillRect(b.x + Math.floor(hash(t, s, 3) * (b.w / b.k)) * b.k, b.y + Math.floor(hash(t, s, 4) * (b.h / b.k)) * b.k, Math.max(1, b.k - 1), Math.max(1, b.k - 1));
  if (t % 7 === 3) {
    g.fillStyle = 'rgba(24,20,37,0.25)';
    g.fillRect(b.x, b.y, b.w, b.h);
  }
  g.restore();
}

/** «Золото»: статуэтка — силуэт в золотых тонах, по нему проходит блик, сбоку вспыхивает искра. */
function goldOver(g: Ctx, t: number, b: Box, period: number): void {
  rampOver(g, b, [PAL.ink, PAL.umber, PAL.brick, PAL.clay, PAL.amber, PAL.yellow, PAL.white]);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  band(g, t, b, 2, period);
  g.restore();
  const f = t % period;
  if (f >= period - 5) sparkle(g, b.x + Math.round(b.w * 0.75), b.y + Math.round(b.h * 0.18), [0, 2, 3, 2, 1][f - (period - 5)], PAL.white, PAL.yellow);
}

/** «Огонь»: пиксельное пламя поднимается от силуэта (за ним), сам силуэт — в тёплом отсвете. */
function fireOver(g: Ctx, t: number, b: Box): void {
  const m = maskOf(g, b);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(247,118,34,0.22)';
  g.fillRect(b.x, b.y, b.w, b.h);
  g.restore();
  const cols = [PAL.yellow, PAL.amber, PAL.orange, PAL.red, PAL.wine];
  const fl = canvas(b.w, b.h);
  for (let j = 0; j < m.length; j++)
    for (let i = 0; i < m[j].length; i++) {
      if (m[j][i]) continue;
      let d = 0;
      for (let k = 1; k <= 5 && !d; k++) if (m[j + k]?.[i] || m[j + k]?.[i - 1] || m[j + k]?.[i + 1]) d = k;
      if (!d) continue;
      const n = hash(i, j + t, 5);
      if (n >= 1 - d * 0.17) continue;
      fl.g.fillStyle = cols[Math.min(4, d - 1 + (n < 0.3 ? 0 : 1))];
      fl.g.fillRect(i * b.k, j * b.k, b.k, b.k);
    }
  g.save();
  g.globalCompositeOperation = 'destination-over';
  g.drawImage(fl.c, b.x, b.y);
  g.restore();
}

/** «VHS»: цвета разъезжаются (красный влево, голубой вправо), бегут светлые полосы, кусок кадра дёргается. */
function vhsOver(g: Ctx, t: number, b: Box): void {
  const src = canvas(b.w, b.h);
  src.g.drawImage(g.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  const tint = (c: string) => {
    const q = canvas(b.w, b.h);
    q.g.drawImage(src.c, 0, 0);
    q.g.globalCompositeOperation = 'source-in';
    q.g.fillStyle = c;
    q.g.fillRect(0, 0, b.w, b.h);
    return q.c;
  };
  g.clearRect(b.x, b.y, b.w, b.h);
  g.globalAlpha = 0.8;
  g.drawImage(tint(PAL.magenta), b.x - b.k, b.y);
  g.drawImage(tint(PAL.cyan), b.x + b.k, b.y);
  g.globalAlpha = 1;
  // строки по клетке спрайта; на каждом четвёртом кадре полоса из трёх клеток сдвигается
  const rows = Math.ceil(b.h / b.k);
  const jy = Math.floor(hash(t, 9, 9) * Math.max(1, rows - 3));
  const jdx = t % 4 === 0 ? 2 * b.k : 0;
  for (let r = 0; r < rows; r++) g.drawImage(src.c, 0, r * b.k, b.w, b.k, b.x + (r >= jy && r < jy + 3 ? jdx : 0), b.y + r * b.k, b.w, b.k);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(255,255,255,0.18)';
  for (let y = (t * b.k) % (4 * b.k); y < b.h; y += 4 * b.k) g.fillRect(b.x, b.y + y, b.w, 1);
  g.restore();
}

/** «Лёд»: как поза «Замри» — лёд и блик по силуэту, иней вокруг. */
function iceFx(g: Ctx, t: number, b: Box): void {
  iceOver(g, t, b);
  const pad = Math.round(Math.min(b.w, b.h) * 0.1);
  iceFrost(g, t, { x: b.x + pad, y: b.y + pad, w: b.w - 2 * pad, h: b.h - 2 * pad, k: b.k });
}

/** Эффект стикера (товар «Эффекты» в гардеробе) поверх холста, где только стикер. period — кадров в стикере. */
export function fxOver(g: Ctx, fx: EffectId, t: number, b: Box, period = 20): void {
  if (fx === 'holo') holoOver(g, t, b, 0.3, period);
  else if (fx === 'noir') noirOver(g, t, b);
  else if (fx === 'sepia') sepiaOver(g, t, b);
  else if (fx === 'gold') goldOver(g, t, b, period);
  else if (fx === 'fire') fireOver(g, t, b);
  else if (fx === 'vhs') vhsOver(g, t, b);
  else iceFx(g, t, b);
}

/** Стикер с эффектом: рисуем его на свой холст, накидываем эффект по силуэту, переносим (обводку стикер получит после). */
export function withFx<D extends { draw(g: Ctx, t: number, lang: Lang): void }>(def: D, fx: EffectId | null | undefined): D {
  if (!fx) return def;
  return {
    ...def,
    draw(g: Ctx, t: number, lang: Lang) {
      const w = g.canvas.width;
      const h = g.canvas.height;
      const o = canvas(w, h);
      def.draw(o.g, t, lang);
      fxOver(o.g, fx, t, { x: 0, y: 0, w, h, k: 3 });
      g.drawImage(o.c, 0, 0);
    },
  };
}
