import { PAL } from '@kto/assets';
import { bossLooking, bossWatching } from '@kto/game-core';
import type { BossLook, BossState, Dir } from '@kto/game-core';
import { canvas, grid } from './pixels';

/**
 * Шеф «Клерков» (game-core › boss.ts) — «Пустой костюм» (решение владельца): тёмно-серый пиджак, белый
 * воротничок и красный галстук — единственное яркое пятно (пиджак тёмный: читается силуэтом); над воротником пустота (лишь два пикселя глаз,
 * тусклые в покое и ярко-красные под взглядом), пустые рукава колышутся, брюки обрезаны над полом —
 * под ними только мягкая тень. Не шагает, а плывёт, покачиваясь. Ростом в полтора человечка.
 *
 * Без DOM и без Phaser: кадры — строки букв, поза и дверь считаются из состояния мира, а рисуются
 * через `Fill` — одинаково в сцене (Phaser), в клипе и в «Фильме матча» (canvas).
 *
 * Лента: по 4 кадра на вид — вниз (D), вверх (U), боком вправо (S; влево — зеркально):
 * 0–2 рукава колышутся, 3 — рукав указывает (выговор или ложная тревога).
 */
export const BOSS_W = 24;
export const BOSS_H = 36;
export const BOSS_PER_VIEW = 4;
export const BOSS_SWAY = 0;
export const BOSS_POINT = 3;
/** Дверь кабинета захлопывается через столько мс после того, как он ушёл к себе / вышел к нам. */
export const BOSS_SHUT_OUT = 500;
export const BOSS_SHUT_IN = 900;
/** Выход — резко: дверь распахивается за столько мс, костюм сразу стоит в проёме. */
const BURST_MS = 70;
/** Глаза вспыхивают при выходе, мс. */
export const BOSS_FLARE_MS = 700;
/** Пустой рукав указывает столько мс. */
const POINT_MS = 1000;
/** Полоска под дверью мигает за столько мс до его возвращения. */
const BLINK_MS = 3000;

/**
 * o ink (контур), n dusk (пиджак), k night (тень пиджака, лацканы), h steel (блик ткани), p ink (брюки), w white (воротничок),
 * m mist (дальний край воротника изнутри), r red (галстук), R wine (тень галстука), e ink (пустота)
 */
type BossKey = 'o' | 'n' | 'k' | 'h' | 'p' | 'w' | 'm' | 'r' | 'R' | 'e';
type View = 'D' | 'U' | 'S';
type Grid = (BossKey | null)[][];

export function bossFrames(): string[][] {
  const out: string[][] = [];
  for (const v of ['D', 'U', 'S'] as View[]) for (let f = 0; f < BOSS_PER_VIEW; f++) out.push(frame(v, f));
  return out;
}

/** Номер кадра в ленте по виду (0 вниз, 1 вверх, 2/3 боком) и позе. */
export function bossFrame(dir: Dir, pose: number): number {
  const v = dir === 0 ? 0 : dir === 1 ? 1 : 2;
  return v * BOSS_PER_VIEW + pose;
}

function frame(view: View, f: number): string[] {
  const g: Grid = Array.from({ length: BOSS_H }, () => Array<BossKey | null>(BOSS_W).fill(null));
  const put = (x: number, y: number, k: BossKey): void => {
    if (x >= 0 && y >= 0 && x < BOSS_W && y < BOSS_H) g[y][x] = k;
  };
  const rect = (x: number, y: number, w: number, h: number, k: BossKey): void => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, k);
  };
  const point = f === BOSS_POINT;
  // рукава колышутся: низ рукава уходит на пиксель влево-вправо (кадры 0–2), рукава — в противофазе
  const sway = point ? 0 : [0, 1, -1][f] ?? 0;
  // пустой рукав: длинный, висит от плеча ниже пиджака; низ колышется; манжета — тёмная пустота
  const sleeve = (x: number, dx: number, k: BossKey, dark: BossKey): void => {
    rect(x, 11, 3, 8, k);
    rect(x + dx, 19, 3, 6, k);
    put(x + dx + (x < 12 ? 2 : 0), 19, dark);
    rect(x + dx, 25, 3, 1, 'e');
  };
  // рукав указывает: вытянут вбок на уровне груди, манжета пустая
  const pointing = (x0: number): void => {
    rect(x0, 12, BOSS_W - 1 - x0, 3, 'n');
    rect(x0, 15, BOSS_W - 2 - x0, 1, 'k');
    rect(BOSS_W - 1, 12, 1, 3, 'e');
  };
  if (view === 'S') {
    // боком: воротник — открытое кольцо, внутри пустота; кончик галстука выглядывает спереди
    rect(11, 7, 3, 1, 'm');
    put(10, 8, 'w');
    rect(11, 8, 3, 2, 'e');
    rect(14, 8, 2, 2, 'w');
    put(10, 9, 'w');
    rect(9, 10, 8, 1, 'n');
    rect(8, 11, 9, 15, 'n');
    rect(8, 23, 9, 3, 'k');
    put(15, 10, 'w');
    rect(16, 11, 1, 6, 'r');
    put(16, 17, 'R');
    put(14, 13, 'w');
    if (point) pointing(13);
    else {
      // рукав висит поверх пиджака: тёмный, с тёмной кромкой сзади
      sleeve(11, sway, 'k', 'k');
      for (let y = 12; y < 25; y++) put(10 + (y >= 19 ? sway : 0), y, 'o');
    }
    rect(9, 10, 6, 1, 'h');
    for (let y = 11; y < 23; y++) put(8, y, 'h');
    if (point) rect(13, 12, 10, 1, 'h');
    // брюки обрезаны над полом — ног нет
    rect(9, 26, 7, 1, 'p');
    rect(9, 27, 3, 6, 'p');
    rect(13, 27, 3, 6, 'p');
    put(12, 27, 'o');
  } else {
    const front = view === 'D';
    // воротник: открытое кольцо, внутри — пустота (видно дальний край изнутри); сзади — белый
    if (front) {
      rect(10, 7, 4, 1, 'm');
      rect(8, 8, 2, 2, 'w');
      rect(14, 8, 2, 2, 'w');
      rect(10, 8, 4, 2, 'e');
      put(9, 10, 'w');
      put(14, 10, 'w');
      rect(10, 10, 4, 1, 'e');
    } else {
      rect(8, 7, 8, 3, 'w');
      rect(9, 7, 6, 1, 'm');
    }
    // широкие плечи, длинный пиджак
    rect(5, 10, 14, 1, 'n');
    rect(3, 11, 18, 2, 'n');
    rect(6, 13, 12, 13, 'n');
    rect(6, 23, 12, 3, 'k');
    if (front) {
      rect(11, 11, 2, 1, 'r');
      rect(10, 12, 4, 1, 'r');
      rect(11, 13, 2, 6, 'r');
      rect(11, 19, 2, 1, 'R');
      // лацканы
      put(9, 11, 'k');
      put(9, 12, 'k');
      put(10, 13, 'k');
      put(14, 11, 'k');
      put(14, 12, 'k');
      put(13, 13, 'k');
      // платок в кармане и пуговицы
      put(15, 14, 'w');
      put(12, 21, 'k');
      put(12, 23, 'o');
    } else rect(12, 13, 1, 13, 'k');
    // рукава отдельно от пиджака: левый (с экрана) колышется в противофазе правому
    sleeve(2, -sway, 'n', 'k');
    if (point) pointing(19);
    else sleeve(19, sway, 'n', 'k');
    rect(8, 26, 8, 1, 'p');
    rect(8, 27, 3, 6, 'p');
    rect(13, 27, 3, 6, 'p');
    // блик ткани по плечам и рукавам — силуэт читается на тёмном полу и в тёмном проёме
    rect(5, 10, 3, 1, 'h');
    rect(16, 10, 3, 1, 'h');
    rect(3, 11, 2, 1, 'h');
    rect(19, 11, 2, 1, 'h');
    for (let y = 12; y < 19; y++) put(2, y, 'h');
    if (!point) for (let y = 12; y < 19; y++) put(21, y, 'h');
    else rect(19, 12, 4, 1, 'h');
  }
  outline(g);
  return g.map((r) => r.map((k) => k ?? '.').join(''));
}

/** Контур ink вокруг фигуры; пустота над воротником остаётся пустой. */
function outline(g: Grid): void {
  const add: [number, number][] = [];
  for (let y = 0; y < BOSS_H; y++) {
    for (let x = 0; x < BOSS_W; x++) {
      if (g[y][x]) continue;
      const near = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]?.[x - 1], g[y]?.[x + 1]].some((k) => k && k !== 'o' && k !== 'e' && k !== 'm');
      if (near) add.push([x, y]);
    }
  }
  for (const [x, y] of add) g[y][x] = 'o';
}

/** Цвета букв кадра — только из палитры. */
const BOSS_MAP: Record<BossKey, string> = {
  o: PAL.ink,
  n: PAL.dusk,
  k: PAL.night,
  h: PAL.steel,
  p: PAL.ink,
  w: PAL.white,
  m: PAL.slate,
  r: PAL.red,
  R: PAL.wine,
  e: PAL.ink,
};

/** Лента кадров шефа: BOSS_W × BOSS_H, подряд все виды (`bossFrame`). */
export function makeBossSheet(): HTMLCanvasElement {
  const fr = bossFrames();
  const { c, g } = canvas(BOSS_W * fr.length, BOSS_H);
  fr.forEach((rows, i) => grid(g, i * BOSS_W, 0, rows, BOSS_MAP));
  return c;
}

// ───────────── поза и дверь из состояния мира ─────────────

/** Прямоугольник цвета PAL с прозрачностью — общий способ рисовать (Phaser Graphics или canvas). */
export type Fill = (x: number, y: number, w: number, h: number, color: string, alpha?: number) => void;

export interface BossPose {
  /** Ноги (точка мира), куда рисовать кадр: снизу по центру. */
  x: number;
  y: number;
  frame: number;
  flip: boolean;
  /** Покачивание и подъём в проёме двери, пиксели вверх. */
  lift: number;
  alpha: number;
  /** Призрак в проёме двери — рисовать за толпой. */
  ghost: boolean;
  /** Глаза: точки внутри кадра (уже с учётом зеркала) и цвет. */
  eyes: [number, number][];
  eyeColor: string;
  /** Глаза горят — с ореолом. */
  glow: boolean;
  /** Только что появился: ореол глаз шире и ярче. */
  flare: boolean;
  /** Шеф указывает на сущность. */
  point: number | null;
}

/** Дверь кабинета: середина верхней стены. Вычислено один раз за кадр в `bossScene`. */
export interface BossScene {
  pose: BossPose | null;
  /** Открыта на 0–1. */
  open: number;
  /** Свет над дверью горит (шеф у себя). */
  lamp: boolean;
  /** Красная полоска под дверью: шеф у себя, подвал; мигает перед возвращением. */
  strip: boolean;
  /** Где тени ног в полоске (смещение от середины), если видны. */
  feet: number | null;
}

/**
 * Что видно от шефа в момент t: поза костюма, дверь, свет над ней и полоска под ней.
 * `door` — точка двери (game-core › bossDoor), kids — детский режим (глаза жёлтые).
 */
export function bossScene(b: BossState, t: number, door: { x: number; y: number }, kids: boolean, alpha = 1): BossScene {
  const since = b.door !== undefined ? t - b.door : Infinity;
  const atDoor = Math.abs(b.x - door.x) < 2 && Math.abs(b.y - door.y) < 2;
  const fresh = since >= 0 && (b.out || atDoor);
  let open = 0;
  if (fresh) {
    if (b.out) open = since < 200 ? since / 200 : since < BOSS_SHUT_OUT ? 1 : since < BOSS_SHUT_OUT + 120 ? 1 - (since - BOSS_SHUT_OUT) / 120 : 0;
    // выход — резко: дверь распахивается настежь, он уже стоит в проёме
    else open = since < BURST_MS ? since / BURST_MS : since < BOSS_SHUT_IN ? 1 : since < BOSS_SHUT_IN + 120 ? 1 - (since - BOSS_SHUT_IN) / 120 : 0;
  }
  const lamp = b.out && !(since >= 0 && since < BOSS_SHUT_OUT + 150);
  const blink = b.out && b.back !== undefined && t >= b.back - BLINK_MS;
  const strip = b.out && open === 0 && (!blink || Math.floor(t / 160) % 2 === 0);
  const feet = strip ? Math.round(Math.sin(t / 900) * 4) : null;
  const ghostOut = b.out && since >= 0 && since < 350;
  if (b.out && !ghostOut) return { pose: null, open, lamp, strip, feet };

  const x = Math.round(b.px + (b.x - b.px) * alpha);
  const y = Math.round(b.py + (b.y - b.py) * alpha);
  const moving = !b.out && b.pi < b.path.length;
  const look = !b.out ? b.look : null;
  const looking = !b.out && bossLooking(b, t);
  const watching = !b.out && bossWatching(b, t);
  // воротник поворачивается раньше пиджака: глаза — сразу к взгляду, пиджак — к началу взгляда
  let body: Dir = b.dir;
  let head: Dir = b.dir;
  if (looking && look) {
    head = look.dir;
    if (t >= look.from - 250) body = look.dir;
  }
  // рукава колышутся (на ходу быстрее), костюм покачивается в воздухе
  const sw = Math.floor(t / (moving ? 170 : 280)) % 4;
  let pose = BOSS_SWAY + [0, 1, 0, 2][sw];
  let point: number | null = null;
  if (b.point && t - b.point.at >= 0 && t - b.point.at < POINT_MS && !b.out) {
    point = b.point.eid;
    pose = BOSS_POINT;
  }
  let lift = Math.round(Math.sin(t / 380) + 1);
  let a = 1;
  if (ghostOut) {
    // ушёл к себе: отступает в темноту проёма
    body = 1;
    head = 1;
    a = 1 - since / 350;
    lift += Math.round((since / 350) * 6);
  }
  // только что появился — глаза вспыхивают
  const flare = !b.out && since >= 0 && since < BOSS_FLARE_MS;
  const flip = body === 2;
  const eyes: [number, number][] = [];
  const ey = 4;
  if (head === 0) eyes.push([9, ey], [10, ey], [13, ey], [14, ey]);
  else if (head === 3) eyes.push([14, ey], [15, ey]);
  else if (head === 2) eyes.push([8, ey], [9, ey]);
  // спиной к нам (вверх) глаз не видно
  const hot = watching || point !== null || flare;
  const eyeColor = kids ? (hot ? PAL.yellow : PAL.amber) : hot ? PAL.magenta : looking ? (Math.floor(t / 120) % 2 ? PAL.red : PAL.wine) : PAL.wine;
  return {
    pose: { x, y, frame: bossFrame(body, pose), flip, lift, alpha: a, ghost: ghostOut, eyes, eyeColor, glow: hot && !kids, flare: flare && !kids, point },
    open,
    lamp,
    strip,
    feet,
  };
}

/**
 * Дверь кабинета в верхней стене: (dx, top) — левый верхний угол, высота h. Закрыта — филёнки и ручка;
 * открывается сама в темноту; над ней лампа (горит, пока шеф у себя), под ней красная полоска с тенями ног.
 */
export function drawBossDoor(fill: Fill, s: BossScene, dx: number, top: number, h: number): void {
  fill(dx, top, 20, h, PAL.ink);
  if (s.open > 0) {
    // проём — темнота; полотно на петлях слева сужается, как будто поворачивается к нам
    const lw = Math.max(2, Math.round(18 * (1 - s.open)));
    fill(dx + 1, top + 1, lw, h - 1, PAL.umber);
    fill(dx + lw, top + 1, 1, h - 1, PAL.brick);
  } else {
    fill(dx + 1, top + 1, 18, h - 1, PAL.umber);
    fill(dx + 4, top + 3, 12, 8, PAL.brick);
    fill(dx + 4, top + 14, 12, 8, PAL.brick);
    fill(dx + 15, top + 12, 2, 1, PAL.yellow);
    if (s.strip) {
      fill(dx + 2, top + h - 1, 16, 1, PAL.red);
      fill(dx + 2, top + h, 16, 1, PAL.red, 0.35);
      if (s.feet !== null) {
        const fx = dx + 10 + s.feet;
        fill(fx - 3, top + h - 1, 2, 1, PAL.ink);
        fill(fx + 1, top + h - 1, 2, 1, PAL.ink);
      }
    }
  }
  // лампа над дверью — на стене справа: горит, пока шеф у себя
  fill(dx + 21, top + 2, 3, 3, PAL.ink);
  fill(dx + 22, top + 3, 1, 1, s.lamp ? PAL.yellow : PAL.dusk);
  if (s.lamp) fill(dx + 20, top + 1, 5, 5, PAL.yellow, 0.18);
}

/** Пустота над воротником дрожит: пара бледных пикселей то тут, то там. */
export function drawBossVoid(fill: Fill, t: number, left: number, topY: number): void {
  // тёмное марево там, где должна быть голова: её нет, а темнота — есть
  const breath = 0.22 + 0.08 * Math.sin(t / 300);
  fill(left + 10, topY, 4, 1, PAL.ink, breath);
  fill(left + 9, topY + 1, 6, 6, PAL.ink, breath);
  fill(left + 10, topY + 7, 4, 1, PAL.ink, breath);
  const k = Math.floor(t / 90);
  const h = (n: number) => ((n * 2654435761) >>> 0) % 1000;
  for (let i = 0; i < 2; i++) {
    const r = h(k * 3 + i);
    if (r < 450) continue;
    fill(left + 9 + (r % 6), topY + 1 + ((r >> 2) % 6), 1, 1, PAL.mist, 0.2);
  }
}

/** Глаза поверх кадра: два пикселя, под взглядом — с красным ореолом. */
export function drawBossEyes(fill: Fill, p: BossPose, left: number, topY: number): void {
  for (const [ex, ey] of p.eyes) {
    if (p.flare) fill(left + ex - 2, topY + ey - 2, 5, 5, PAL.red, 0.3 * p.alpha);
    if (p.glow) fill(left + ex - 1, topY + ey - 1, 3, 3, PAL.red, 0.35 * p.alpha);
    fill(left + ex, topY + ey, 1, 1, p.eyeColor, p.alpha);
  }
}

/** Мягкая тень под костюмом (ног нет — только тень). */
export function drawBossShadow(fill: Fill, x: number, y: number, alpha: number): void {
  fill(x - 8, y - 1, 16, 2, PAL.ink, 0.3 * alpha);
  fill(x - 5, y - 2, 10, 4, PAL.ink, 0.25 * alpha);
}

/**
 * Конус взгляда на полу (sy — строка ног на экране): пока шеф поворачивается — бледный и мигает, потом
 * горит тусклым красным; dark — тьма вокруг луча (не в детском режиме). range/spread — из game-core › boss.ts.
 */
export function drawBossCone(
  fill: Fill,
  look: BossLook,
  x: number,
  sy: number,
  t: number,
  area: { x0: number; y0: number; w: number; h: number },
  range: number,
  spread: number,
  kids: boolean,
): void {
  const hot = t >= look.from;
  const d = look.dir;
  const vert = d === 0 || d === 1;
  const along = (r: number): number => (d === 0 ? r - (sy - 2) : d === 1 ? sy - 2 - r : d === 3 ? r - x : x - r);
  if (hot && !kids) {
    const k = Math.min(1, (t - look.from) / 300) * Math.min(1, (look.until - t) / 250);
    if (k > 0) {
      const al = 0.45 * k;
      const n = vert ? area.h : area.w;
      for (let i = 0; i < n; i++) {
        const r = (vert ? area.y0 : area.x0) + i;
        const a = along(r);
        const whole = a < 2 || a > range;
        const half = whole ? 0 : Math.round(5 + a * spread);
        if (vert) {
          if (whole) fill(area.x0, r, area.w, 1, PAL.ink, al);
          else {
            const lo = Math.max(0, x - half - area.x0);
            const hi = Math.max(0, area.x0 + area.w - (x + half + 1));
            if (lo) fill(area.x0, r, lo, 1, PAL.ink, al);
            if (hi) fill(x + half + 1, r, hi, 1, PAL.ink, al);
          }
        } else if (whole) fill(r, area.y0, 1, area.h, PAL.ink, al);
        else {
          const c = sy - 2;
          const lo = Math.max(0, c - half - area.y0);
          const hi = Math.max(0, area.y0 + area.h - (c + half + 1));
          if (lo) fill(r, area.y0, 1, lo, PAL.ink, al);
          if (hi) fill(r, c + half + 1, 1, hi, PAL.ink, al);
        }
      }
    }
  }
  if (!hot && Math.floor(t / 150) % 2 !== 0) return;
  const col = kids ? (hot ? PAL.yellow : PAL.sand) : hot ? PAL.red : PAL.wine;
  const body = hot ? 0.2 : 0.12;
  for (let a = 2; a <= range; a++) {
    const half = Math.round(5 + a * spread);
    if (vert) fill(x - half, sy + (d === 0 ? a : -a) - 2, half * 2 + 1, 1, col, body);
    else fill(x + (d === 3 ? a : -a), sy - 2 - half, 1, half * 2 + 1, col, body);
  }
  // кромка — пунктиром, чтобы край читался на любом полу
  const edge = hot ? 0.75 : 0.45;
  for (let a = 4; a <= range; a += 3) {
    const half = Math.round(5 + a * spread);
    if (vert) {
      const yy = sy + (d === 0 ? a : -a) - 2;
      fill(x - half, yy, 1, 1, col, edge);
      fill(x + half, yy, 1, 1, col, edge);
    } else {
      const xx = x + (d === 3 ? a : -a);
      fill(xx, sy - 2 - half, 1, 1, col, edge);
      fill(xx, sy - 2 + half, 1, 1, col, edge);
    }
  }
}
