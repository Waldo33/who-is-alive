import { canvas, grid, px } from '../pixels';
import type { Ctx } from '../pixels';

/** Детерминированный шум для узоров (одинаков у всех и в каждом кадре). */
export function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Круг в центре площади (под фонтаном и его заменами): расстояние с растяжкой по x, как в парке. */
export function centerDist(w: number, x: number, y: number): number {
  return Math.hypot((x - w / 2) / 1.15, y - 132);
}

/** Линия по пикселям (Брезенхэм). */
export function line(g: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, step = 1): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  let i = 0;
  for (;;) {
    if (i++ % step === 0) px(g, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Плитка 8×8 из строк. */
export function tile(rows: string[], map: Record<string, string>): HTMLCanvasElement {
  const { c, g } = canvas(8, 8);
  grid(g, 0, 0, rows, map);
  return c;
}

/** Лента зверька: 6 кадров 6×6. */
export function critterSheet(frames: string[][], map: Record<string, string>): HTMLCanvasElement {
  const { c, g } = canvas(36, 6);
  frames.forEach((f, i) => grid(g, i * 6, 0, f, map));
  return c;
}
