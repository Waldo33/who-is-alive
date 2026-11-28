/** Мелкие помощники для процедурных пиксельных заглушек. */
export type Ctx = CanvasRenderingContext2D;

/**
 * Откуда берутся холсты. В браузере — `document.createElement('canvas')`; игровой сервер
 * рисует фильм матча теми же спрайтами через @napi-rs/canvas и подставляет свою фабрику.
 */
let makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas');
export function setCanvasFactory(f: () => HTMLCanvasElement): void {
  makeCanvas = f;
}
/** Выполнить f с другой фабрикой холстов (эффект на персонаже считается на своих «программных» холстах). */
export function withCanvasFactory<T>(f: () => HTMLCanvasElement, fn: () => T): T {
  const was = makeCanvas;
  makeCanvas = f;
  try {
    return fn();
  } finally {
    makeCanvas = was;
  }
}
/** Пустой холст из текущей фабрики. */
export function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas();
  c.width = w;
  c.height = h;
  return c;
}

export function canvas(w: number, h: number): { c: HTMLCanvasElement; g: Ctx } {
  const c = makeCanvas();
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  return { c, g };
}

export function px(g: Ctx, x: number, y: number, color: string, w = 1, h = 1): void {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), w, h);
}

/** Рисует сетку символов: каждый символ → цвет из map, '.' и пробел прозрачны. */
export function grid(g: Ctx, x: number, y: number, rows: readonly string[], map: Record<string, string | undefined>): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === '.' || ch === ' ') continue;
      const col = map[ch];
      if (col) px(g, x + c, y + r, col);
    }
  }
}

/** Эллипс по пикселям (заливка). */
export function ellipse(g: Ctx, cx: number, cy: number, rx: number, ry: number, color: string): void {
  for (let y = -ry; y <= ry; y++) {
    for (let x = -rx; x <= rx; x++) {
      if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) px(g, cx + x, cy + y, color);
    }
  }
}

/** Шахматный дизеринг поверх прямоугольника. */
export function dither(g: Ctx, x: number, y: number, w: number, h: number, color: string, phase = 0): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((i + j + phase) % 2 === 0) px(g, x + i, y + j, color);
}

/** 1-пиксельный контур вокруг непрозрачных пикселей области. */
export function outlineOf(src: Ctx, w: number, h: number, dst: Ctx, ox: number, oy: number, color: string): void {
  const data = src.getImageData(0, 0, w, h).data;
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 0;
  for (let y = -1; y <= h; y++) {
    for (let x = -1; x <= w; x++) {
      if (op(x, y)) continue;
      if (op(x - 1, y) || op(x + 1, y) || op(x, y - 1) || op(x, y + 1)) px(dst, ox + x + 1, oy + y + 1, color);
    }
  }
}
