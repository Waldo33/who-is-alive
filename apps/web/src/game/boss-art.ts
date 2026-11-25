import { PAL } from '@kto/assets';
import { bossLooking, bossWatching } from '@kto/game-core';
import type { BossLook, BossState, Dir } from '@kto/game-core';
import { canvas, grid } from './pixels';

/**
 * Шеф «Клерков» (game-core › boss.ts) — «Пустой костюм» (решение владельца): тёмно-серый пиджак, белый
 * воротничок и красный галстук — единственное яркое пятно; над воротником пустота (лишь два пикселя глаз,
 * тусклые в покое и ярко-красные под взглядом), пустые рукава колышутся, брюки обрезаны над полом —
 * под ними только мягкая тень. Не шагает, а плывёт, покачиваясь. Ростом в полтора человечка.
 *
 * Без DOM и без Phaser: кадры — строки букв, поза и дверь считаются из состояния мира, а рисуются
 * через `Fill` — одинаково в сцене (Phaser), в клипе и в «Фильме матча» (canvas).
 *
 * Лента: по 4 кадра на вид — вниз (D), вверх (U), боком вправо (S; влево — зеркально):
 * 0–2 рукава колышутся, 3 — рукав указывает (выговор или ложная тревога).
 */
export const BOSS_W = 20;
export const BOSS_H = 24;
export const BOSS_PER_VIEW = 4;
export const BOSS_SWAY = 0;
export const BOSS_POINT = 3;
/** Дверь кабинета захлопывается через столько мс после того, как он ушёл к себе / выплыл к нам. */
export const BOSS_SHUT_OUT = 650;
export const BOSS_SHUT_IN = 1100;
/** Выход: щелчок замка, дверь сама открывается через столько мс, костюм выплывает из темноты. */
const OPEN_AT = 150;
const EMERGE_MS = 650;
/** Пустой рукав указывает столько мс. */
const POINT_MS = 1000;
/** Полоска под дверью мигает за столько мс до его возвращения. */
const BLINK_MS = 3000;

/**
 * o ink (контур), n steel (пиджак), k dusk (тень пиджака, лацканы), p night (брюки), w white (воротничок),
 * r red (галстук), R wine (тень галстука), e ink (пустота внутри воротника и рукавов)
 */
type BossKey = 'o' | 'n' | 'k' | 'p' | 'w' | 'r' | 'R' | 'e';
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
  // пустой рукав: висит от плеча, низ колышется, на конце — тёмная пустота манжеты
  const sleeve = (x: number, dx: number, k: BossKey): void => {
    rect(x, 8, 2, 4, k);
    rect(x + dx, 12, 2, 3, k);
    put(x + dx, 15, 'e');
    put(x + dx + 1, 15, 'e');
  };
  // рукав указывает: вытянут вбок на уровне груди, манжета пустая
  const pointing = (x0: number): void => {
    rect(x0, 8, BOSS_W - 1 - x0, 2, 'n');
    rect(x0, 10, BOSS_W - 2 - x0, 1, 'k');
    put(BOSS_W - 1, 8, 'e');
    put(BOSS_W - 1, 9, 'e');
  };
  if (view === 'S') {
    // боком: пиджак уже, воротничок сбоку, кончик галстука выглядывает спереди
    rect(9, 6, 3, 1, 'w');
    put(12, 6, 'w');
    put(10, 6, 'e');
    put(11, 6, 'e');
    rect(8, 7, 6, 1, 'n');
    rect(8, 8, 6, 8, 'n');
    rect(8, 14, 6, 2, 'k');
    put(13, 7, 'w');
    rect(13, 8, 1, 3, 'r');
    put(13, 11, 'R');
    if (point) pointing(10);
    else {
      // рукав висит поверх пиджака: тёмный, с тёмной кромкой сзади
      sleeve(10, sway, 'k');
      for (let y = 9; y < 15; y++) put(9 + (y >= 12 ? sway : 0), y, 'o');
    }
    // брюки обрезаны над полом
    rect(9, 16, 4, 1, 'p');
    rect(9, 17, 2, 4, 'p');
    rect(11, 17, 2, 4, 'p');
    put(11, 17, 'o');
  } else {
    const front = view === 'D';
    // воротничок: спереди V, внутри — пустота; сзади — белая полоска
    if (front) {
      rect(7, 5, 2, 2, 'w');
      rect(11, 5, 2, 2, 'w');
      rect(9, 5, 2, 2, 'e');
    } else rect(7, 5, 6, 2, 'w');
    rect(5, 7, 10, 1, 'n');
    rect(4, 8, 12, 1, 'n');
    rect(6, 9, 8, 7, 'n');
    rect(6, 14, 8, 2, 'k');
    if (front) {
      put(8, 7, 'w');
      put(11, 7, 'w');
      put(9, 7, 'r');
      put(10, 7, 'r');
      rect(9, 8, 2, 4, 'r');
      rect(9, 12, 2, 1, 'R');
      // лацканы
      put(7, 8, 'k');
      put(8, 9, 'k');
      put(12, 8, 'k');
      put(11, 9, 'k');
    } else rect(10, 9, 1, 7, 'k');
    // рукава отдельно от пиджака: левый (с экрана) колышется в противофазе правому
    sleeve(3, -sway, 'n');
    if (point) pointing(15);
    else sleeve(15, sway, 'n');
    rect(7, 16, 6, 1, 'p');
    rect(7, 17, 2, 4, 'p');
    rect(11, 17, 2, 4, 'p');
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
      const near = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]?.[x - 1], g[y]?.[x + 1]].some((k) => k && k !== 'o' && k !== 'e');
      if (near) add.push([x, y]);
    }
  }
  for (const [x, y] of add) g[y][x] = 'o';
}

/** Цвета букв кадра — только из палитры. */
const BOSS_MAP: Record<BossKey, string> = {
  o: PAL.ink,
  n: PAL.steel,
  k: PAL.dusk,
  p: PAL.night,
  w: PAL.white,
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
    else {
      // выход: щелчок замка — и дверь открывается сама, медленно
      const s = since - OPEN_AT;
      open = s < 0 ? 0 : s < 350 ? s / 350 : since < BOSS_SHUT_IN ? 1 : since < BOSS_SHUT_IN + 120 ? 1 - (since - BOSS_SHUT_IN) / 120 : 0;
    }
  }
  const lamp = b.out && !(since >= 0 && since < BOSS_SHUT_OUT + 150);
  const blink = b.out && b.back !== undefined && t >= b.back - BLINK_MS;
  const strip = b.out && open === 0 && (!blink || Math.floor(t / 160) % 2 === 0);
  const feet = strip ? Math.round(Math.sin(t / 900) * 4) : null;
  const ghostOut = b.out && since >= 0 && since < 500;
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
    // ушёл к себе: уплывает вглубь проёма и тает в темноте
    body = 1;
    head = 1;
    a = 1 - since / 500;
    lift += Math.round((since / 500) * 8);
  } else if (fresh && atDoor && !b.out) {
    const s = since - OPEN_AT - 200;
    a = s < 0 ? 0 : Math.min(1, s / EMERGE_MS);
    lift += Math.round((1 - a) * 6);
  }
  const flip = body === 2;
  const eyes: [number, number][] = [];
  const ey = 2;
  if (head === 0) eyes.push([8, ey], [11, ey]);
  else if (head === 3) eyes.push([12, ey]);
  else if (head === 2) eyes.push([7, ey]);
  // спиной к нам (вверх) глаз не видно
  const hot = watching || point !== null;
  const eyeColor = kids ? (hot ? PAL.yellow : PAL.amber) : hot ? PAL.magenta : looking ? (Math.floor(t / 120) % 2 ? PAL.red : PAL.wine) : PAL.wine;
  return {
    pose: { x, y, frame: bossFrame(body, pose), flip, lift, alpha: a, ghost: ghostOut, eyes, eyeColor, glow: hot && !kids, point },
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
  const k = Math.floor(t / 90);
  const h = (n: number) => ((n * 2654435761) >>> 0) % 1000;
  for (let i = 0; i < 2; i++) {
    const r = h(k * 3 + i);
    if (r < 450) continue;
    fill(left + 8 + (r % 4), topY + 1 + ((r >> 2) % 5), 1, 1, PAL.mist, 0.18);
  }
}

/** Глаза поверх кадра: два пикселя, под взглядом — с красным ореолом. */
export function drawBossEyes(fill: Fill, p: BossPose, left: number, topY: number): void {
  for (const [ex, ey] of p.eyes) {
    if (p.glow) fill(left + ex - 1, topY + ey - 1, 3, 3, PAL.red, 0.35 * p.alpha);
    fill(left + ex, topY + ey, 1, 1, p.eyeColor, p.alpha);
  }
}

/** Мягкая тень под костюмом (ног нет — только тень). */
export function drawBossShadow(fill: Fill, x: number, y: number, alpha: number): void {
  fill(x - 6, y - 1, 12, 2, PAL.ink, 0.3 * alpha);
  fill(x - 4, y - 2, 8, 4, PAL.ink, 0.25 * alpha);
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
