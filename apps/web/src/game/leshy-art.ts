/**
 * Леший «Купальской ночи» — хозяин леса ростом с ель: рога-ветви с мхом, череп из коры с горящими
 * глазами, борода-лишайник, длинные руки-сучья до колен, ноги-корни. Без DOM: кадры — строки букв
 * (буква → цвет из PAL в scene.ts › makeLeshy), поэтому их можно проверить и вне браузера.
 *
 * Кадры 0–3 — шаг, 4–5 — стоит и смотрит (голова чуть повёрнута влево/вправо), 6 — замах (правая рука-сук
 * над головой), 7 — удар (рука выброшена вперёд и вниз, голова подалась следом).
 */
export const LESHY_W = 52;
export const LESHY_H = 96;
export const LESHY_FRAMES = 8;

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
  const strike = f === 6 ? 1 : f === 7 ? 2 : 0;
  const look = f === 4 ? -1 : f === 5 || f === 7 ? 1 : 0;
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
    if (side === 1 && strike) {
      // рука для удара: замах — локоть в сторону, кисть-когти над рогами; удар — вперёд и вниз, на всю длину
      const sx = cx + 7;
      const sy = tTop + 2;
      const [ex, ey, hx, hy] = strike === 1 ? [cx + 14, tTop - 8, cx + 11, tTop - 22] : [cx + 14, tTop + 7, cx + 19, tTop + 17];
      line(sx, sy, ex, ey, 'p', 2);
      line(sx, sy, ex, ey, 'u');
      line(ex, ey, hx, hy, 'p', 2);
      put(ex, ey, 'u');
      if (strike === 1) {
        // когти вверх, растопырены
        line(hx, hy, hx - 3, hy - 6, 'p');
        line(hx + 1, hy, hx + 1, hy - 7, 'u');
        line(hx + 1, hy, hx + 4, hy - 5, 'p');
        line(hx, hy, hx - 4, hy - 2, 'u');
      } else {
        // когти вперёд, сжимаются
        line(hx, hy, hx + 5, hy + 1, 'p');
        line(hx, hy + 1, hx + 5, hy + 4, 'u');
        line(hx, hy, hx + 4, hy - 3, 'p');
        line(hx, hy + 1, hx + 3, hy + 6, 'p');
      }
      continue;
    }
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

/**
 * Морда Лешего во весь экран — скример «Тебя забрал Леший». Череп из бересты вплотную: тяжёлое надбровье,
 * провалы глазниц с горящими углями, вытянутая пасть со щепками-зубами, у висков — основания рогов, по
 * краям — борода-лишайник. Кадры 0–3: пасть всё шире (0 — сомкнута, 3 — челюсть вывихнута до низа кадра), глаза разгораются,
 * надбровье опускается. Показывается ×2 (бросок — ×3).
 */
export const FACE_W = 90;
export const FACE_H = 110;

export const FACE_FRAMES = 4;
/** Где глаза в кадре морды (для угольков во тьме до и после скримера). */
export const FACE_EYES: readonly (readonly [number, number])[] = [[31, 39], [59, 39]];

export function leshyFace(): string[][] {
  return [face(0), face(1), face(2), face(3)];
}

function face(open: number): string[] {
  const W = FACE_W;
  const H = FACE_H;
  const g: (LeshyKey | null)[][] = Array.from({ length: H }, () => Array<LeshyKey | null>(W).fill(null));
  const put = (x: number, y: number, k: LeshyKey): void => {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = k;
  };
  const cx = 45;
  const at = (x: number, y: number): LeshyKey | null => g[Math.round(y)]?.[Math.round(x)] ?? null;
  // полуширина черепа по строкам: лоб, скулы, впалые щёки, челюсть уходит вниз вместе с пастью
  const jawEnd = [88, 92, 104, 109][open];
  const half = (y: number): number => {
    if (y < 6) return 0;
    if (y < 30) return Math.round(22 + Math.sqrt((y - 6) / 24) * 12); // купол лба
    if (y < 50) return 34 + (y > 42 && y < 48 ? 2 : 0); // скулы
    if (y < 60) return Math.round(34 - (y - 50) * 0.9); // впадины щёк
    const k = (y - 60) / (jawEnd - 60);
    return Math.max(0, Math.round(25 - k * 13 - (k > 0.85 ? (k - 0.85) * 60 : 0)));
  };

  // ── рога-ветви от висков: толстые у основания, ветвятся и уходят за край кадра ──
  const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number, seed: number): void => {
    let px = x;
    let py = y;
    for (let i = 0; i < len; i++) {
      px += Math.cos(ang + Math.sin(i * 0.6 + seed) * 0.2);
      py += Math.sin(ang + Math.sin(i * 0.6 + seed) * 0.2);
      const ww = Math.max(1, Math.round(w * (1 - i / (len * 1.6))));
      for (let d = 0; d < ww; d++) put(px + d * 0.7, py + d * 0.7, d === 0 ? 'u' : d === ww - 1 ? 'o' : 'p');
    }
    if (depth > 0) {
      branch(px, py, ang - 0.6, Math.round(len * 0.6), Math.max(1, w - 1), depth - 1, seed + 1.7);
      branch(px, py, ang + 0.55, Math.round(len * 0.55), Math.max(1, w - 1), depth - 1, seed + 2.9);
    } else {
      for (let j = 1; j < 4 + (seed % 3); j++) put(px, py + j, j > 2 ? 'd' : 'f'); // мох с концов
    }
  };
  for (const side of [-1, 1]) {
    branch(cx + side * 22, 14, -Math.PI / 2 + side * 0.95, 14, 4, 2, side > 0 ? 1 : 5);
    branch(cx + side * 14, 9, -Math.PI / 2 + side * 0.45, 10, 3, 1, side > 0 ? 3 : 8);
  }

  // ── череп: береста — бледная, свет слева, тень справа, чёрные чёрточки ──
  for (let y = 6; y < jawEnd; y++) {
    const hw = half(y);
    for (let x = cx - hw; x <= cx + hw; x++) {
      const rx = (x - cx) / Math.max(1, hw);
      let c: LeshyKey = 's';
      if (rx > 0.72) c = 'k';
      else if (rx < -0.55 && y < 56) c = 'm';
      if (rx > 0.9) c = 'n';
      // берестяные чёрточки: короткие горизонтальные штрихи
      const band = Math.floor(y / 3);
      if (h2(Math.floor(x / 5) + band * 7, band) < 0.16 && y % 3 === 0) c = 'n';
      put(x, y, c);
    }
  }
  // трещины по лбу и щекам
  const crack = (x: number, y: number, dx: number, n: number, seed: number): void => {
    for (let i = 0; i < n; i++) {
      put(x, y, 'o');
      y += 1;
      x += h2(seed, i) < 0.5 ? dx : 0;
    }
  };
  crack(cx - 6, 7, -1, 14, 1);
  crack(cx + 9, 9, 1, 10, 2);
  crack(cx - 26, 46, -1, 12, 3);
  crack(cx + 24, 50, 1, 9, 4);
  // мох пятнами на висках и под скулами
  for (let k = 0; k < 40; k++) {
    const side = k % 2 ? 1 : -1;
    const x = cx + side * (26 + Math.floor(h2(k, 5) * 9));
    const y = 18 + Math.floor(h2(5, k) * 40);
    if (g[y]?.[x]) put(x, y, h2(k, 8) < 0.5 ? 'P' : 'f');
  }

  // ── надбровье: тяжёлый козырёк, под ним глазницы ──
  for (const side of [-1, 1]) {
    const ex = cx + side * 15;
    const ey = 38;
    for (let x = ex - 13; x <= ex + 13; x++) {
      const t = Math.abs(x - ex) / 13;
      const y = Math.round(ey - 11 + t * t * 5 + (side * (x - ex) < 0 ? 2 : 0));
      put(x, y, 'k');
      put(x, y + 1, 'o');
    }
    // глазница — провал
    for (let y = ey - 9; y <= ey + 9; y++)
      for (let x = ex - 12; x <= ex + 12; x++) {
        const d = Math.hypot((x - ex) / 11, (y - ey) / 8.5);
        if (d < 1) put(x, y, d > 0.86 ? 'n' : 'o');
      }
    // уголь в глубине: жёлтое ядро, белая сердцевина, янтарный ореол решёткой
    const r = [2.6, 3.2, 4.2, 5.2][open];
    const px = ex + side * -1;
    const py = ey + 1;
    for (let y = py - 7; y <= py + 7; y++)
      for (let x = px - 7; x <= px + 7; x++) {
        const d = Math.hypot(x - px, (y - py) * 1.2);
        if (d < r * 0.45) put(x, y, 'w');
        else if (d < r) put(x, y, 'y');
        else if (d < r + 1.4) put(x, y, 'a');
        else if (d < r + 4 && (x + y) % 2 === 0 && g[y]?.[x] === 'o') put(x, y, 'b');
      }
  }
  // переносица и нос-провал
  for (let y = 44; y < 54; y++) {
    const w = y < 48 ? 1 : 2 + (y > 50 ? 1 : 0);
    for (let x = cx - w; x <= cx + w - 1; x++) put(x, y, 'o');
  }
  put(cx - 3, 52, 'k');
  put(cx + 3, 52, 'k');

  // ── пасть: вытянутая чёрная дыра до подбородка, щепки-зубы по краям ──
  const mTop = 58;
  const mBot = [68, 80, 99, 107][open];
  const mw = [9, 12, 15, 17][open];
  for (let y = mTop; y <= mBot; y++) {
    const k = (y - mTop) / (mBot - mTop);
    const hw = Math.round(mw * Math.pow(Math.sin(Math.min(1, k * 0.9 + 0.1) * Math.PI), 0.55) + 1);
    for (let x = cx - hw; x <= cx + hw; x++) put(x, y, Math.abs(x - cx) >= hw - 1 || y === mTop ? 'n' : 'o');
  }
  // зубы: от края пасти внутрь, разной длины и кривые
  for (let x = cx - mw + 2; x <= cx + mw - 2; x += 2 + (x % 3 === 0 ? 1 : 0)) {
    let top = mTop;
    while (top < mBot && at(x, top) !== 'o' && at(x, top) !== 'n') top++;
    let bot = mBot;
    while (bot > mTop && at(x, bot) !== 'o' && at(x, bot) !== 'n') bot--;
    const room = bot - top;
    if (room < 4) continue;
    const lenT = Math.min(room / 2 - 1, 3 + Math.floor(h2(x, 11) * (open >= 2 ? 7 : 4)));
    const lenB = Math.min(room / 2 - 1, 2 + Math.floor(h2(x, 13) * (open >= 2 ? 5 : 3)));
    for (let j = 0; j < lenT; j++) put(x + (j > lenT * 0.6 && h2(x, 3) < 0.4 ? 1 : 0), top + j, j < lenT - 1 ? 'm' : 'w');
    for (let j = 0; j < lenB; j++) put(x, bot - j, j < lenB - 1 ? 's' : 'm');
  }
  // из глазниц по щекам — тёмные потёки смолы
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x0 = cx + side * (9 + k * 5);
      const len = 6 + Math.floor(h2(k, side + 5) * 12);
      for (let j = 0; j < len; j++) if (at(x0, 47 + j) && at(x0, 47 + j) !== 'o') put(x0, 47 + j, j < len - 2 ? 'n' : 'k');
    }
  }

  // ── борода-лишайник по краям челюсти, свисает за низ кадра ──
  for (let i = 0; i < 16; i++) {
    const side = i % 2 ? 1 : -1;
    const x0 = cx + side * (14 + Math.floor(i / 2) * 2);
    const y0 = 62 + Math.floor(i / 2) * 2;
    const len = 18 + Math.floor(h2(i, 21) * 22);
    for (let y = 0; y < len; y++) {
      const x = x0 + Math.round(Math.sin(y * 0.3 + i) * 1);
      if (g[y0 + y]?.[x] && g[y0 + y][x] !== 'P' && g[y0 + y][x] !== 'f' && g[y0 + y][x] !== 'd') continue;
      put(x, y0 + y, y > len - 4 ? 'd' : (i + y) % 3 === 0 ? 'f' : 'P');
    }
  }

  // ── контур чернилами ──
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
