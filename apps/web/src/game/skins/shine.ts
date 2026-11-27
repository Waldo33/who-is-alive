import { PAL } from '@kto/assets';
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

/** Иней вокруг обледеневшей фигурки — рисовать на общем холсте после неё. */
export function iceFrost(g: Ctx, t: number, b: Box): void {
  for (const [dx, dy, ph] of [
    [2, -2, 0],
    [b.w - 4, 6, 5],
    [-2, b.h - 10, 10],
  ] as const) {
    if ((t + ph) % 10 < 6) sparkle(g, b.x + dx, b.y + dy, 2);
  }
}

/** «Голограмма» по силуэту: радужные диагонали плывут, по ним проходит блик. alpha — сила радуги, period — блика. */
export function holoOver(g: Ctx, t: number, b: Box, alpha = 0.28, period = 20): void {
  const cols = Math.ceil(b.w / b.k);
  const rows = Math.ceil(b.h / b.k);
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.globalAlpha = alpha;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) px(g, b, i, j, HOLO[((i + j + t) >> 2) % HOLO.length]);
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
