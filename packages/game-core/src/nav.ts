import type { ArenaDef, Rect } from './arena';
import { rectContains } from './arena';

/**
 * Навигационная сетка и A*. Боты и игроки ходят по одному и тому же поиску пути,
 * поэтому по маршруту нельзя отличить живого от бота.
 */
export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly blocked: Uint8Array;

  constructor(readonly arena: ArenaDef, cell: number) {
    this.cell = cell;
    this.cols = Math.floor(arena.width / cell);
    this.rows = Math.floor(arena.height / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = c * cell + cell / 2;
        const y = r * cell + cell / 2;
        let b = !rectContains(arena.walk, x, y);
        if (!b) {
          for (const p of arena.props) {
            const f = p.foot;
            if (x >= f.x - 3 && x <= f.x + f.w + 3 && y >= f.y - 2 && y <= f.y + f.h + 2) {
              b = true;
              break;
            }
            if (p.cover && rectContains(p.cover, x, y)) {
              b = true;
              break;
            }
          }
        }
        this.blocked[r * this.cols + c] = b ? 1 : 0;
      }
    }
  }

  idx(c: number, r: number): number {
    return r * this.cols + c;
  }
  col(i: number): number {
    return i % this.cols;
  }
  row(i: number): number {
    return Math.floor(i / this.cols);
  }
  cx(i: number): number {
    return this.col(i) * this.cell + this.cell / 2;
  }
  cy(i: number): number {
    return this.row(i) * this.cell + this.cell / 2;
  }
  cellAt(x: number, y: number): number {
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cell)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cell)));
    return this.idx(c, r);
  }
  inBounds(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }
  walkable(i: number, zone?: Rect | null): boolean {
    if (this.blocked[i]) return false;
    if (zone && !rectContains(zone, this.cx(i), this.cy(i))) return false;
    return true;
  }
  walkableXY(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.cols * this.cell || y >= this.rows * this.cell) return false;
    return !this.blocked[this.cellAt(x, y)];
  }

  /** Ближайшая проходимая клетка (BFS по кольцам). */
  nearestWalkable(i: number, zone?: Rect | null): number {
    if (this.walkable(i, zone)) return i;
    const c0 = this.col(i);
    const r0 = this.row(i);
    const maxR = Math.max(this.cols, this.rows);
    for (let rad = 1; rad < maxR; rad++) {
      let best = -1;
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const c = c0 + dc;
          const r = r0 + dr;
          if (!this.inBounds(c, r)) continue;
          const j = this.idx(c, r);
          if (!this.walkable(j, zone)) continue;
          const d = dc * dc + dr * dr;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Прямая видимость между центрами клеток (для сглаживания пути). */
  lineClear(a: number, b: number, zone?: Rect | null): boolean {
    const x0 = this.cx(a);
    const y0 = this.cy(a);
    const x1 = this.cx(b);
    const y1 = this.cy(b);
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(dist / (this.cell * 0.25));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      // проверяем «плечи» шириной ±1 пикс., чтобы не срезать углы препятствий
      for (const [ox, oy] of [[0, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const j = this.cellAt(x + ox, y + oy);
        if (!this.walkable(j, zone)) return false;
      }
    }
    return true;
  }

  /**
   * A* по 8 направлениям без срезания углов, затем сглаживание по прямой видимости.
   * Возвращает путевые точки (индексы клеток) без стартовой, с целевой; null — пути нет.
   */
  findPath(start: number, goal: number, zone?: Rect | null): number[] | null {
    if (start === goal) return [];
    if (!this.walkable(goal, zone)) return null;
    const n = this.cols * this.rows;
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const gc = this.col(goal);
    const gr = this.row(goal);
    const h = (i: number) => {
      const dx = Math.abs(this.col(i) - gc);
      const dy = Math.abs(this.row(i) - gr);
      return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };
    g[start] = 0;
    heap.push(start, h(start));
    // старт может оказаться в непроходимой клетке (вытолкнуло изгородью) — разрешаем выйти из неё
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const c = this.col(cur);
      const r = this.row(cur);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (!this.inBounds(nc, nr)) continue;
          const j = this.idx(nc, nr);
          if (closed[j] || !this.walkable(j, zone)) continue;
          if (dr && dc) {
            if (!this.walkable(this.idx(c + dc, r), zone) || !this.walkable(this.idx(c, r + dr), zone)) continue;
          }
          const ng = g[cur] + (dr && dc ? Math.SQRT2 : 1);
          if (ng < g[j]) {
            g[j] = ng;
            came[j] = cur;
            heap.push(j, ng + h(j));
          }
        }
      }
    }
    if (came[goal] < 0) return null;
    const raw: number[] = [];
    for (let i = goal; i !== start; i = came[i]) raw.push(i);
    raw.reverse();
    // сглаживание: от текущей точки прыгаем к самой дальней видимой
    const out: number[] = [];
    let from = start;
    let k = 0;
    while (k < raw.length) {
      let far = k;
      for (let m = raw.length - 1; m > k; m--) {
        if (this.lineClear(from, raw[m], zone)) {
          far = m;
          break;
        }
      }
      out.push(raw[far]);
      from = raw[far];
      k = far + 1;
    }
    return out;
  }
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastI = a.pop()!;
    const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastI;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}
