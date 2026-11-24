/**
 * Леший «Купальской ночи» — хозяин леса ростом с ель: рога-ветви с мхом, череп из коры с горящими
 * глазами, борода-лишайник, длинные руки-сучья до колен, ноги-корни. Без DOM: кадры — строки букв
 * (буква → цвет из PAL в scene.ts › makeLeshy), поэтому их можно проверить и вне браузера.
 *
 * Кадры 0–3 — шаг, 4–5 — стоит и смотрит (голова чуть повёрнута влево/вправо).
 */
export const LESHY_W = 52;
export const LESHY_H = 96;
export const LESHY_FRAMES = 6;

/** o ink, n night, u umber, p plum, b brick, d deep, P pine, f forest, k dusk, s slate, m mist, y yellow, w white, a amber */
export type LeshyKey = 'o' | 'n' | 'u' | 'p' | 'b' | 'd' | 'P' | 'f' | 'k' | 's' | 'm' | 'y' | 'w' | 'a';

function h2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function leshyFrames(): string[][] {
  const out: string[][] = [];
  for (let f = 0; f < LESHY_FRAMES; f++) out.push(frame(f));
  return out;
}

function frame(f: number): string[] {
  const W = LESHY_W;
  const H = LESHY_H;
  const g: (LeshyKey | null)[][] = Array.from({ length: H }, () => Array<LeshyKey | null>(W).fill(null));
  const put = (x: number, y: number, k: LeshyKey): void => {
    x = Math.round(x);
    y = Math.round(y) + 8; // сверху место под рога
    if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = k;
  };
  const line = (x0: number, y0: number, x1: number, y1: number, k: LeshyKey, w = 1): void => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      for (let dx = 0; dx < w; dx++) put(x + dx, y, k);
    }
  };
  const walk = f < 4;
  const s = walk ? [-1, 0, 1, 0][f] : 0; // шаг: −1 левая впереди, 1 — правая
  const bob = walk && f % 2 === 1 ? 1 : 0; // на перекате тело чуть ниже
  const look = f === 4 ? -1 : f === 5 ? 1 : 0;
  const cx = 26;

  // ── ноги-корни ──
  for (const side of [-1, 1]) {
    const fwd = side === -1 ? -s : s; // вперёд выставленная нога короче шагает вниз
    const hipX = cx + side * 3;
    const footX = cx + side * 5 + fwd * 3;
    const top = 58 + bob;
    const bottom = 84 - (fwd > 0 ? 1 : 0);
    for (let y = top; y <= bottom; y++) {
      const k = (y - top) / (bottom - top);
      const x = hipX + (footX - hipX) * k + Math.sin(k * 3.1) * side;
      const wd = k < 0.5 ? 4 : 3;
      for (let dx = 0; dx < wd; dx++) put(x - 1 + dx, y, dx === 0 ? 'u' : dx === wd - 1 ? 'o' : h2(x + dx, y) < 0.3 ? 'u' : 'p');
      if (h2(y, side) < 0.12) put(x, y, 'o'); // трещины коры
    }
    // корни-пальцы расползаются
    const fy = bottom;
    line(footX - 1, fy, footX - 5, fy + 3, 'u');
    line(footX, fy, footX + side * 1, fy + 3, 'p');
    line(footX + 1, fy, footX + 5, fy + 2, 'u');
    line(footX - 4, fy + 2, footX - 6, fy + 3, 'p');
  }

  // ── туловище: худой ствол, кора полосами, мох пятнами ──
  const tTop = 31 + bob;
  const tBot = 60 + bob;
  for (let y = tTop; y <= tBot; y++) {
    const k = (y - tTop) / (tBot - tTop);
    const half = Math.round(7 - k * 3 + (k > 0.85 ? 1 : 0));
    for (let x = cx - half; x <= cx + half; x++) {
      const stripe = (x + Math.floor(y / 5)) % 3 === 0;
      let c: LeshyKey = stripe ? 'u' : 'p';
      if (x === cx + half || x === cx + half - 1) c = 'o'; // тень справа
      if (x === cx - half + 1 && h2(x, y) < 0.6) c = 'u'; // свет слева
      put(x, y, c);
    }
  }
  // рёбра-сучья и дупло в груди
  for (let r = 0; r < 4; r++) {
    const y = tTop + 7 + r * 3;
    line(cx - 5 + r % 2, y, cx - 1, y + 1, 'o');
    line(cx + 1, y + 1, cx + 5 - r % 2, y, 'o');
  }
  for (let y = tTop + 17; y < tTop + 23; y++) for (let x = cx - 2; x <= cx + 1; x++) if (Math.hypot(x - cx + 0.5, (y - tTop - 20) * 0.7) < 2.2) put(x, y, 'o');
  for (let k = 0; k < 16; k++) {
    const x = cx - 6 + Math.floor(h2(k, 3) * 13);
    const y = tTop + 2 + Math.floor(h2(3, k) * 26);
    put(x, y, h2(k, 9) < 0.5 ? 'P' : 'f');
  }

  // ── руки-сучья до колен, качаются против ног ──
  for (const side of [-1, 1]) {
    const swing = side === -1 ? s : -s;
    const sx = cx + side * 7;
    const sy = tTop + 2;
    const ex = cx + side * 12 + swing;
    const ey = tTop + 17;
    const hx = cx + side * 13 + swing * 3;
    const hy = 70 + bob + (look ? -2 : 0);
    line(sx, sy, ex, ey, 'p', 2);
    line(sx, sy, ex, ey, 'u');
    line(ex, ey, hx, hy, 'p', 2);
    put(ex, ey, 'u');
    // пальцы — длинные кривые сучья
    line(hx, hy, hx - 2, hy + 7, 'p');
    line(hx + 1, hy, hx + 1, hy + 8, 'u');
    line(hx + 1, hy, hx + 4, hy + 6, 'p');
    line(hx, hy, hx + side * 4, hy + 3, 'u');
    put(hx - 2, hy + 8, 'p');
    put(hx + 4, hy + 7, 'p');
  }

  // ── рога-ветви: от темени вверх и в стороны, ветвятся (рисуются до головы — голова поверх) ──
  const hTop = 12 + bob;
  const hcx = cx + look;
  const branch = (x: number, y: number, ang: number, len: number, depth: number, seed: number): void => {
    let px = x;
    let py = y;
    for (let i = 0; i < len; i++) {
      const bend = Math.sin(i * 0.7 + seed) * 0.25;
      px += Math.cos(ang + bend);
      py += Math.sin(ang + bend);
      put(px, py, depth >= 2 && i < len / 2 ? 'u' : 'p');
      if (depth >= 2 && i < len / 3) put(px + 1, py, 'p');
    }
    if (depth > 0) {
      branch(px, py, ang - 0.55, Math.round(len * 0.62), depth - 1, seed + 1.3);
      branch(px, py, ang + 0.5, Math.round(len * 0.55), depth - 1, seed + 2.1);
    }
    // мох свисает с развилки
    if (depth === 1) {
      const n = 2 + Math.floor(h2(seed, x) * 4);
      const sw = walk ? [0, 1, 0, -1][(f + Math.floor(seed)) % 4] : 0;
      for (let j = 1; j <= n; j++) put(px + (j === n ? sw : 0), py + j, j === n ? 'd' : 'f');
    }
  };
  for (const side of [-1, 1]) {
    const up = -Math.PI / 2;
    branch(hcx + side * 3, hTop + 2, up + side * 0.7, 11, 2, side > 0 ? 1 : 4);
    branch(hcx + side * 2, hTop + 1, up + side * 0.3, 11, 2, side > 0 ? 7 : 9);
  }

  // ── голова: череп из бересты — бледный, скулы, провалы глазниц, вытянутая открытая пасть ──
  const skull = [9, 11, 11, 11, 11, 11, 11, 11, 9, 9, 7, 7, 7, 7, 5, 5, 3];
  skull.forEach((wd, i) => {
    const y = hTop + i;
    const x0 = hcx - Math.floor(wd / 2);
    for (let x = x0; x < x0 + wd; x++) {
      let c: LeshyKey = 's';
      if (x === x0 + wd - 1 || (x === x0 + wd - 2 && i > 2)) c = 'k'; // тень справа
      else if (x <= x0 + 1 && i < 8) c = 'm'; // свет слева
      if (i > 0 && (x * 5 + i * 3) % 11 === 0) c = 'n'; // чёрные чёрточки бересты
      put(x, y, c);
    }
  });
  // провалы глазниц под тяжёлым надбровьем, в глубине — угли
  for (const ex of [hcx - 3, hcx + 2]) {
    for (let y = hTop + 4; y < hTop + 9; y++)
      for (let x = ex - 1; x <= ex + 1; x++) if (!(y === hTop + 8 && x !== ex) && !(y === hTop + 4 && x === ex + (ex < hcx ? -1 : 1))) put(x, y, 'o');
    put(ex + (look > 0 ? 1 : 0), hTop + 6, 'y');
    put(ex + (look > 0 ? 1 : 0) - (look < 0 ? 1 : 0), hTop + 6, look ? 'w' : 'y');
    put(ex, hTop + 7, 'a');
  }
  line(hcx - 5, hTop + 3, hcx - 1, hTop + 4, 'k');
  line(hcx + 1, hTop + 4, hcx + 5, hTop + 3, 'k');
  // впалые щёки и нос-дыра
  put(hcx - 4, hTop + 9, 'k');
  put(hcx + 3, hTop + 9, 'k');
  put(hcx, hTop + 9, 'o');
  put(hcx - 1, hTop + 10, 'o');
  // пасть: вытянута вниз, щепки-зубы сверху и снизу
  for (let y = hTop + 11; y < hTop + 16; y++) {
    const half = y < hTop + 14 ? 2 : 1;
    for (let x = hcx - half; x <= hcx + half - 1; x++) put(x, y, 'o');
  }
  for (const x of [hcx - 2, hcx, hcx + 1]) put(x, hTop + 11, 'm');
  put(hcx - 1, hTop + 15, 'm');
  put(hcx - 2, hTop + 13, 'p');

  // ── борода-лишайник: редкие тонкие пряди до пояса, колышутся ──
  for (let i = 0; i < 9; i++) {
    const x0 = hcx - 5 + i + (i > 4 ? 1 : 0);
    const len = 10 + Math.floor(h2(i, 7) * 12) - Math.abs(i - 4) * 2;
    const sway = walk ? [0, 1, 0, -1][(f + i) % 4] : 0;
    const startY = hTop + 16 + Math.floor(Math.abs(i - 4) / 2);
    for (let y = 0; y < len; y++) {
      const x = x0 + (y > len * 0.6 ? sway : 0);
      const c: LeshyKey = y > len - 3 ? 'd' : (i + y) % 3 === 0 ? 'f' : 'P';
      put(x, startY + y, c);
    }
  }

  // ── контур: всё обведено чернилами снаружи ──
  const outl: [number, number][] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (g[y][x]) continue;
      const n = (x > 0 && g[y][x - 1]) || (x < W - 1 && g[y][x + 1]) || (y > 0 && g[y - 1][x]) || (y < H - 1 && g[y + 1][x]);
      if (n) outl.push([x, y]);
    }
  for (const [x, y] of outl) g[y][x] = 'o';
  return g.map((r) => r.map((k) => k ?? '.').join(''));
}
