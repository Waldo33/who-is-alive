/**
 * Холсты для монтажа фильма на Rust (apps/server/native): тот же интерфейс Canvas 2D, которым рисуют
 * сцены фильма (apps/web/src/game/film.ts, clip.ts, art.ts, sprites.ts, темы), но вместо рисования —
 * запись команд в буфер чисел. Буфер уходит в нативный модуль одним вызовом на кадр (или раньше,
 * когда нужны пиксели — getImageData при сборке спрайтов). Так сцены остаются общими с телефоном,
 * а дорогое — заливки, спрайты, текст, растяжка ×2, перевод в YUV — делает Rust.
 *
 * Поддерживается ровно то, чем пользуются сцены: fillRect/clearRect/strokeRect, drawImage (3, 5 и 9
 * аргументов), fillText/measureText (Press Start 2P), преобразования, save/restore, globalAlpha,
 * source-over/source-in/copy, узор createPattern(…, 'repeat'), getImageData. Остальное — ошибка
 * (в тесте сверки видно сразу), а не тихо пропущенный кадр.
 */
import { readFileSync } from 'node:fs';
import { createRequire as requireFrom } from 'node:module';

export interface NativeEngine {
  exec(ops: Float64Array, len: number, strs: string[]): void;
  read(id: number, x: number, y: number, w: number, h: number): Buffer;
  measure(s: string, px: number): number;
  jpeg(id: number, quality: number): Buffer;
  encodeStart(ffmpeg: string, w: number, h: number, fps: number, args: string[]): void;
  encodeFrame(id: number): void;
  encodeFinish(): number;
}

type EngineCtor = new (fonts: Buffer[]) => NativeEngine;

let mod: { Engine: EngineCtor } | null = null;

/** Загрузить нативный модуль (`massovka-film.node`). */
export function loadNative(path: string): { Engine: EngineCtor } {
  mod ??= requireFrom(import.meta.url)(path) as { Engine: EngineCtor };
  return mod;
}

const OP = { STATE: 1, RESIZE: 2, FILL: 3, CLEAR: 4, IMAGE: 5, TEXT: 6, STROKE: 7, FREE: 8 } as const;
const COMP: Record<string, number> = { 'source-over': 0, 'source-in': 1, copy: 2 };
const ALIGN: Record<string, number> = { left: 0, start: 0, center: 1, right: 2, end: 2 };
const BASE: Record<string, number> = { alphabetic: 0, top: 1, hanging: 1, middle: 2, bottom: 3, ideographic: 3 };

const colors = new Map<string, number>();
/** CSS-цвет → RGBA (младший байт — r). Сцены пользуются #rgb/#rrggbb(aa) из палитры и rgb(a)(). */
export function parseColor(s: string): number {
  let v = colors.get(s);
  if (v !== undefined) return v;
  const t = s.trim().toLowerCase();
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^#([0-9a-f]{3,8})$/))) {
    const h = m[1];
    const x = (i: number, n: number) => parseInt(n === 1 ? h[i] + h[i] : h.slice(i, i + 2), 16);
    if (h.length === 3 || h.length === 4) [r, g, b, a] = [x(0, 1), x(1, 1), x(2, 1), h.length === 4 ? x(3, 1) : 255];
    else if (h.length === 6 || h.length === 8) [r, g, b, a] = [x(0, 2), x(2, 2), x(4, 2), h.length === 8 ? x(6, 2) : 255];
    else throw new Error(`цвет ${s}`);
  } else if ((m = t.match(/^rgba?\(([^)]+)\)$/))) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    [r, g, b] = p;
    a = p.length > 3 ? Math.round(Math.max(0, Math.min(1, p[3])) * 255) : 255;
  } else if (t === 'transparent') {
    a = 0;
  } else if (t === 'white' || t === 'black') {
    r = g = b = t === 'white' ? 255 : 0;
  } else throw new Error(`цвет ${s}`);
  v = ((a << 24) >>> 0) + (b << 16) + (g << 8) + r;
  colors.set(s, v);
  return v;
}

interface CtxState {
  m: [number, number, number, number, number, number];
  alpha: number;
  comp: string;
  fill: string | NPattern;
  stroke: string;
  lineWidth: number;
  font: string;
  fontPx: number;
  align: string;
  baseline: string;
  smoothing: boolean;
}

const fresh = (): CtxState => ({
  m: [1, 0, 0, 1, 0, 0],
  alpha: 1,
  comp: 'source-over',
  fill: '#000',
  stroke: '#000',
  lineWidth: 1,
  font: '10px sans-serif',
  fontPx: 10,
  align: 'start',
  baseline: 'alphabetic',
  smoothing: true,
});

class NPattern {
  constructor(readonly id: number) {}
  setTransform(): void {
    throw new Error('узор с преобразованием не поддерживается');
  }
}

/** Общая запись команд всех холстов. */
export class Recorder {
  ops = new Float64Array(1 << 16);
  n = 0;
  strs: string[] = [];
  last: NCtx | null = null;
  nextId = 1;
  private gc = new FinalizationRegistry<number>((id) => this.push1(OP.FREE, id));

  constructor(readonly engine: NativeEngine) {}

  ensure(k: number): void {
    if (this.n + k <= this.ops.length) return;
    const a = new Float64Array(Math.max(this.ops.length * 2, this.n + k));
    a.set(this.ops.subarray(0, this.n));
    this.ops = a;
  }

  push1(op: number, a: number): void {
    this.ensure(2);
    this.ops[this.n++] = op;
    this.ops[this.n++] = a;
  }

  /** Исполнить накопленное. */
  flush(): void {
    if (!this.n) return;
    this.engine.exec(this.ops, this.n, this.strs);
    this.n = 0;
    this.strs = [];
    this.last = null;
  }

  canvas(): NCanvas {
    const c = new NCanvas(this, this.nextId++);
    this.gc.register(c, c.id);
    return c;
  }
}

export class NCanvas {
  private w = 300;
  private h = 150;
  private ctx: NCtx | null = null;

  constructor(
    readonly rec: Recorder,
    readonly id: number,
  ) {
    this.resize();
  }

  private resize(): void {
    const r = this.rec;
    r.ensure(4);
    r.ops[r.n++] = OP.RESIZE;
    r.ops[r.n++] = this.id;
    r.ops[r.n++] = this.w;
    r.ops[r.n++] = this.h;
    if (this.ctx) this.ctx.reset();
  }

  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = Math.max(0, Math.floor(v));
    this.resize();
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = Math.max(0, Math.floor(v));
    this.resize();
  }

  getContext(kind: string): NCtx {
    if (kind !== '2d') throw new Error(`контекст ${kind}`);
    this.ctx ??= new NCtx(this);
    return this.ctx;
  }

  /** Пиксели всего холста (RGBA без умноженной альфы). */
  pixels(): Buffer {
    this.rec.flush();
    return this.rec.engine.read(this.id, 0, 0, this.w, this.h);
  }
}

const ALLOWED_FONT = /(\d+(?:\.\d+)?)px/;

export class NCtx {
  private s: CtxState = fresh();
  private stack: CtxState[] = [];
  private dirty = true;

  constructor(readonly canvas: NCanvas) {}

  reset(): void {
    this.s = fresh();
    this.stack = [];
    this.dirty = true;
  }

  private get rec(): Recorder {
    return this.canvas.rec;
  }

  /** Перед командой рисования: прислать состояние, если оно поменялось или сменился холст. */
  private state(): Recorder {
    const r = this.rec;
    if (r.last !== this || this.dirty) {
      const s = this.s;
      r.ensure(17);
      const o = r.ops;
      let n = r.n;
      o[n++] = OP.STATE;
      o[n++] = this.canvas.id;
      o[n++] = s.m[0];
      o[n++] = s.m[1];
      o[n++] = s.m[2];
      o[n++] = s.m[3];
      o[n++] = s.m[4];
      o[n++] = s.m[5];
      o[n++] = s.alpha;
      o[n++] = COMP[s.comp];
      const pat = s.fill instanceof NPattern;
      o[n++] = pat ? 1 : 0;
      o[n++] = pat ? (s.fill as NPattern).id : parseColor(s.fill as string);
      o[n++] = parseColor(s.stroke);
      o[n++] = s.lineWidth;
      o[n++] = s.fontPx;
      o[n++] = ALIGN[s.align] ?? 0;
      o[n++] = BASE[s.baseline] ?? 0;
      r.n = n;
      r.last = this;
      this.dirty = false;
    }
    return r;
  }

  save(): void {
    this.stack.push({ ...this.s, m: [...this.s.m] });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.s = s;
      this.dirty = true;
    }
  }

  get globalAlpha(): number {
    return this.s.alpha;
  }
  set globalAlpha(v: number) {
    if (!Number.isFinite(v) || v < 0 || v > 1) return;
    this.s.alpha = v;
    this.dirty = true;
  }
  get globalCompositeOperation(): string {
    return this.s.comp;
  }
  set globalCompositeOperation(v: string) {
    if (!(v in COMP)) throw new Error(`смешивание ${v} не поддерживается`);
    this.s.comp = v;
    this.dirty = true;
  }
  get fillStyle(): string | NPattern {
    return this.s.fill;
  }
  set fillStyle(v: string | NPattern) {
    if (typeof v === 'string') parseColor(v);
    else if (!(v instanceof NPattern)) throw new Error('заливка: только цвет или узор');
    this.s.fill = v;
    this.dirty = true;
  }
  get strokeStyle(): string {
    return this.s.stroke;
  }
  set strokeStyle(v: string) {
    parseColor(v);
    this.s.stroke = v;
    this.dirty = true;
  }
  get lineWidth(): number {
    return this.s.lineWidth;
  }
  set lineWidth(v: number) {
    this.s.lineWidth = v;
    this.dirty = true;
  }
  get font(): string {
    return this.s.font;
  }
  set font(v: string) {
    const m = v.match(ALLOWED_FONT);
    if (!m) return;
    this.s.font = v;
    this.s.fontPx = Number(m[1]);
    this.dirty = true;
  }
  get textAlign(): string {
    return this.s.align;
  }
  set textAlign(v: string) {
    this.s.align = v;
    this.dirty = true;
  }
  get textBaseline(): string {
    return this.s.baseline;
  }
  set textBaseline(v: string) {
    this.s.baseline = v;
    this.dirty = true;
  }
  /** Всегда «ближайший сосед»: фильм — пиксель-арт. */
  get imageSmoothingEnabled(): boolean {
    return this.s.smoothing;
  }
  set imageSmoothingEnabled(v: boolean) {
    this.s.smoothing = v;
  }

  setTransform(a: number | { a: number; b: number; c: number; d: number; e: number; f: number }, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    this.s.m = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b!, c!, d!, e!, f!];
    this.dirty = true;
  }
  resetTransform(): void {
    this.setTransform(1, 0, 0, 1, 0, 0);
  }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const [a, b, c, d, e, f] = this.s.m;
    return { a, b, c, d, e, f };
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [A, B, C, D, E, F] = this.s.m;
    this.s.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
    this.dirty = true;
  }
  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }
  rotate(r: number): void {
    const c = Math.cos(r);
    const s = Math.sin(r);
    this.transform(c, s, -s, c, 0, 0);
  }

  private rect(op: number, x: number, y: number, w: number, h: number): void {
    const r = this.state();
    r.ensure(5);
    const o = r.ops;
    o[r.n++] = op;
    o[r.n++] = x;
    o[r.n++] = y;
    o[r.n++] = w;
    o[r.n++] = h;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rect(OP.FILL, x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.rect(OP.CLEAR, x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rect(OP.STROKE, x, y, w, h);
  }

  drawImage(img: NCanvas, ...a: number[]): void {
    if (!(img instanceof NCanvas)) throw new Error('drawImage: только холсты');
    let sx = 0;
    let sy = 0;
    let sw = img.width;
    let sh = img.height;
    let dx: number;
    let dy: number;
    let dw = img.width;
    let dh = img.height;
    if (a.length === 2) [dx, dy] = a;
    else if (a.length === 4) [dx, dy, dw, dh] = a;
    else if (a.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a;
    else throw new Error(`drawImage: ${a.length + 1} аргументов`);
    const r = this.state();
    r.ensure(10);
    const o = r.ops;
    let n = r.n;
    o[n++] = OP.IMAGE;
    o[n++] = img.id;
    o[n++] = sx;
    o[n++] = sy;
    o[n++] = sw;
    o[n++] = sh;
    o[n++] = dx;
    o[n++] = dy;
    o[n++] = dw;
    o[n++] = dh;
    r.n = n;
  }

  fillText(s: string, x: number, y: number): void {
    const r = this.state();
    r.ensure(4);
    r.ops[r.n++] = OP.TEXT;
    r.ops[r.n++] = r.strs.push(String(s)) - 1;
    r.ops[r.n++] = x;
    r.ops[r.n++] = y;
  }
  measureText(s: string): { width: number } {
    return { width: this.rec.engine.measure(String(s), this.s.fontPx) };
  }

  createPattern(img: NCanvas, rep: string | null): NPattern {
    if (!(img instanceof NCanvas)) throw new Error('узор: только холсты');
    if (rep && rep !== 'repeat') throw new Error(`узор ${rep}`);
    return new NPattern(img.id);
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
    this.rec.flush();
    const b = this.rec.engine.read(this.canvas.id, Math.round(x), Math.round(y), w, h);
    return { data: new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength), width: w, height: h };
  }
}

/** Движок со шрифтом фильма: два woff Press Start 2P (кириллица, затем латиница). */
export function makeEngine(nativePath: string, fonts: string[]): Recorder {
  const { Engine } = loadNative(nativePath);
  return new Recorder(new Engine(fonts.map((f) => readFileSync(f))));
}
