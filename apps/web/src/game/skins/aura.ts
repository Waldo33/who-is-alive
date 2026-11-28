import { isEffect } from '@kto/game-core';
import type { EffectId } from '@kto/game-core';
import { canvas, withCanvasFactory } from '../pixels';
import type { Ctx } from '../pixels';
import { fxOver, holoOver } from './shine';

/**
 * Эффект на своём персонаже (решение владельца 28.11.2026): тот же эффект, что на стикерах (`shine.ts › fxOver`),
 * поверх кадра человечка или скина, пиксель спрайта — 1. Показывается ровно там же, где скин (skin-art.ts):
 * на поле — только на своём телефоне, остальным — когда связь «игрок ↔ сущность» уже открыта.
 *
 * Эффект считается на своём маленьком «программном» холсте (SoftCanvas), а не на холсте браузера: так один и
 * тот же код и одинаковые пиксели и на телефоне (Phaser, лобби, клип), и на сервере, где фильм рисует
 * нативный модуль без putImageData и source-atop. Готовый кадр переносится на настоящий холст прямоугольниками.
 */

/** Поля вокруг кадра: пламя «Огня» поднимается над головой, «VHS» разъезжается в стороны. */
export const AURA_X = 3;
export const AURA_TOP = 6;
export const AURA_BOTTOM = 1;
/** Кадров анимации эффекта (как в стикере) и длина кадра: 10 в секунду. */
export const AURA_STEPS = 20;
export const AURA_MS = 100;
export const auraStep = (ms: number): number => ((Math.floor(ms / AURA_MS) % AURA_STEPS) + AURA_STEPS) % AURA_STEPS;
/** Эффект из PlayerInfo / состава лобби (строка с сервера) или null. */
export const auraFx = (x: unknown): EffectId | null => (isEffect(x) ? x : null);

// ───────────── программный холст: ровно то, чем пользуется fxOver ─────────────

type RGBA = [number, number, number, number];

function parse(s: string): RGBA {
  if (s[0] === '#') {
    const h = s.length === 4 ? s.replace(/[0-9a-f]/gi, (c) => c + c) : s;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s.trim());
  if (!m) return [0, 0, 0, 1];
  const [r, g, b, a] = m[1].split(',').map((x) => Number(x.trim()));
  return [r, g, b, a === undefined || Number.isNaN(a) ? 1 : a];
}

class SoftCanvas {
  private w = 1;
  private h = 1;
  data = new Uint8ClampedArray(4);
  private ctx: SoftCtx | null = null;
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = Math.max(1, Math.floor(v));
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = Math.max(1, Math.floor(v));
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  getContext(): SoftCtx {
    return (this.ctx ??= new SoftCtx(this));
  }
}

type Comp = 'source-over' | 'source-atop' | 'source-in' | 'destination-over' | 'copy';

class SoftCtx {
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  globalCompositeOperation: Comp = 'source-over';
  private fill: RGBA = [0, 0, 0, 1];
  private fillStr = '#000000';
  private stack: { a: number; c: Comp; f: RGBA; s: string }[] = [];
  constructor(readonly canvas: SoftCanvas) {}
  get fillStyle(): string {
    return this.fillStr;
  }
  set fillStyle(v: string) {
    this.fillStr = v;
    this.fill = parse(v);
  }
  save(): void {
    this.stack.push({ a: this.globalAlpha, c: this.globalCompositeOperation, f: this.fill, s: this.fillStr });
  }
  restore(): void {
    const s = this.stack.pop();
    if (!s) return;
    this.globalAlpha = s.a;
    this.globalCompositeOperation = s.c;
    this.fill = s.f;
    this.fillStr = s.s;
  }

  /** Положить пиксель (r, g, b, sa — сила 0…1) по текущему режиму наложения. */
  private put(i: number, r: number, g: number, b: number, sa: number): void {
    const d = this.canvas.data;
    const da = d[i + 3] / 255;
    let oa: number;
    let or: number;
    let og: number;
    let ob: number;
    switch (this.globalCompositeOperation) {
      case 'source-atop':
        if (!da) return;
        oa = da;
        or = r * sa + d[i] * (1 - sa);
        og = g * sa + d[i + 1] * (1 - sa);
        ob = b * sa + d[i + 2] * (1 - sa);
        break;
      case 'source-in':
        oa = sa * da;
        or = r;
        og = g;
        ob = b;
        break;
      case 'destination-over':
        oa = da + sa * (1 - da);
        if (!oa) return;
        or = (d[i] * da + r * sa * (1 - da)) / oa;
        og = (d[i + 1] * da + g * sa * (1 - da)) / oa;
        ob = (d[i + 2] * da + b * sa * (1 - da)) / oa;
        break;
      case 'copy':
        oa = sa;
        or = r;
        og = g;
        ob = b;
        break;
      default:
        oa = sa + da * (1 - sa);
        if (!oa) return;
        or = (r * sa + d[i] * da * (1 - sa)) / oa;
        og = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
        ob = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
    }
    d[i] = or;
    d[i + 1] = og;
    d[i + 2] = ob;
    d[i + 3] = oa * 255;
  }

  /** Прямоугольник в пределах холста (целые клетки). */
  private clip(x: number, y: number, w: number, h: number): [number, number, number, number] {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.canvas.width, Math.round(x + w));
    const y1 = Math.min(this.canvas.height, Math.round(y + h));
    return [x0, y0, x1, y1];
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [r, g, b, a] = this.fill;
    const sa = a * this.globalAlpha;
    const W = this.canvas.width;
    // source-in стирает и всё вне прямоугольника — fxOver заливает им холст целиком, так и считаем
    const [x0, y0, x1, y1] = this.clip(x, y, w, h);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this.put((j * W + i) * 4, r, g, b, sa);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const W = this.canvas.width;
    const [x0, y0, x1, y1] = this.clip(x, y, w, h);
    for (let j = y0; j < y1; j++) this.canvas.data.fill(0, (j * W + x0) * 4, (j * W + x1) * 4);
  }

  /** drawImage(img, dx, dy) и drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) без растяжки. */
  drawImage(img: SoftCanvas, ...a: number[]): void {
    const [sx, sy, sw, sh, dx, dy] = a.length >= 8 ? a : [0, 0, img.width, img.height, a[0], a[1]];
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = img.data;
    for (let j = 0; j < sh; j++) {
      const ty = Math.round(dy) + j;
      const fy = Math.round(sy) + j;
      if (ty < 0 || ty >= H || fy < 0 || fy >= img.height) continue;
      for (let i = 0; i < sw; i++) {
        const tx = Math.round(dx) + i;
        const fx = Math.round(sx) + i;
        if (tx < 0 || tx >= W || fx < 0 || fx >= img.width) continue;
        const k = (fy * img.width + fx) * 4;
        if (!s[k + 3] && this.globalCompositeOperation !== 'source-in' && this.globalCompositeOperation !== 'copy') continue;
        this.put((ty * W + tx) * 4, s[k], s[k + 1], s[k + 2], (s[k + 3] / 255) * this.globalAlpha);
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    const out = new Uint8ClampedArray(w * h * 4);
    const W = this.canvas.width;
    for (let j = 0; j < h; j++) {
      const fy = y + j;
      if (fy < 0 || fy >= this.canvas.height) continue;
      for (let i = 0; i < w; i++) {
        const fx = x + i;
        if (fx < 0 || fx >= W) continue;
        out.set(this.canvas.data.subarray((fy * W + fx) * 4, (fy * W + fx) * 4 + 4), (j * w + i) * 4);
      }
    }
    return { data: out, width: w, height: h };
  }

  putImageData(d: { data: Uint8ClampedArray; width: number; height: number }, x: number, y: number): void {
    const W = this.canvas.width;
    for (let j = 0; j < d.height; j++) {
      const ty = y + j;
      if (ty < 0 || ty >= this.canvas.height) continue;
      for (let i = 0; i < d.width; i++) {
        const tx = x + i;
        if (tx < 0 || tx >= W) continue;
        this.canvas.data.set(d.data.subarray((j * d.width + i) * 4, (j * d.width + i) * 4 + 4), (ty * W + tx) * 4);
      }
    }
  }
}

const softCanvas = () => new SoftCanvas() as unknown as HTMLCanvasElement;

// ───────────── кадр в эффекте ─────────────

export interface AuraPixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/**
 * Кадр w×h (RGBA) в эффекте fx на шаге t: картинка (w + 2·AURA_X)×(AURA_TOP + h + AURA_BOTTOM),
 * кадр лежит в ней с отступом (AURA_X, AURA_TOP).
 */
export function auraPixels(src: Uint8ClampedArray, w: number, h: number, fx: EffectId, t: number): AuraPixels {
  const W = w + 2 * AURA_X;
  const H = AURA_TOP + h + AURA_BOTTOM;
  return withCanvasFactory(softCanvas, () => {
    const { c, g } = canvas(W, H);
    const s = c as unknown as SoftCanvas;
    for (let j = 0; j < h; j++) s.data.set(src.subarray(j * w * 4, (j + 1) * w * 4), ((j + AURA_TOP) * W + AURA_X) * 4);
    const box = { x: 0, y: 0, w: W, h: H, k: 1 };
    // голограмма на маленькой фигуре — тише, чем на стикере (как Кот-банан на витрине гардероба): костюм должен читаться
    if (fx === 'holo') holoOver(g, t, box, 0.18, AURA_STEPS);
    else fxOver(g, fx, t, box, AURA_STEPS);
    return { data: s.data, w: W, h: H };
  });
}

/** Перенести пиксели на холст прямоугольниками по строкам (работает и на нативном холсте сервера). */
function blit(g: Ctx, p: AuraPixels): void {
  const d = p.data;
  for (let y = 0; y < p.h; y++) {
    let x = 0;
    while (x < p.w) {
      const i = (y * p.w + x) * 4;
      if (d[i + 3] === 0) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < p.w) {
        const k = (y * p.w + e) * 4;
        if (d[k] !== d[i] || d[k + 1] !== d[i + 1] || d[k + 2] !== d[i + 2] || d[k + 3] !== d[i + 3]) break;
        e++;
      }
      g.fillStyle = d[i + 3] === 255 ? `rgb(${d[i]},${d[i + 1]},${d[i + 2]})` : `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${(d[i + 3] / 255).toFixed(3)})`;
      g.fillRect(x, y, e - x, 1);
      x = e;
    }
  }
}

const baked = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/**
 * Кадр i ленты `sheet` (кадры fw×fh) в эффекте на шаге t — готовый холст с полями AURA_*. Кэш — по ленте:
 * у фигуры ~30 кадров × 20 шагов, каждый считается один раз.
 */
export function auraFrameCanvas(sheet: HTMLCanvasElement, fw: number, fh: number, i: number, fx: EffectId, t: number): HTMLCanvasElement {
  let m = baked.get(sheet);
  if (!m) baked.set(sheet, (m = new Map()));
  const key = `${i}:${fx}:${t}`;
  let c = m.get(key);
  if (!c) {
    const src = (sheet.getContext('2d') as Ctx).getImageData(i * fw, 0, fw, fh).data;
    const p = auraPixels(src as Uint8ClampedArray, fw, fh, fx, t);
    const o = canvas(p.w, p.h);
    blit(o.g, p);
    if (m.size > 2000) m.clear();
    m.set(key, (c = o.c));
  }
  return c;
}

/** Как art.ts › frame, но в эффекте: кадр i ленты в (x, y) — левый верх самого кадра, поля эффекта — вокруг. */
export function auraFrame(g: Ctx, sheet: HTMLCanvasElement, fw: number, fh: number, i: number, x: number, y: number, flip: boolean, fx: EffectId, t: number): void {
  const c = auraFrameCanvas(sheet, fw, fh, i, fx, t);
  const X = Math.round(x) - AURA_X;
  const Y = Math.round(y) - AURA_TOP;
  if (!flip) {
    g.drawImage(c, X, Y);
    return;
  }
  g.save();
  g.translate(X + c.width, Y);
  g.scale(-1, 1);
  g.drawImage(c, 0, 0);
  g.restore();
}
