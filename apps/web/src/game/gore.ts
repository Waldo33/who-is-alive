import { PAL } from '@kto/assets';
import type { WorldEvent } from '@kto/game-core';

/**
 * Выбивание оружием (ночь Майами): замах, удар, брызги, лужа, брошенное оружие.
 * Одна модель на три места — живая игра, повтор на разоблачении и клип «Лучший момент», —
 * поэтому всё детерминировано (брызги из зерна по сущности и моменту) и рисуется
 * через `Px` — прямоугольник пикселей, хоть в Phaser Graphics, хоть в canvas.
 *
 * Время — `dt`, мс от удара: от −SWING_HIT (начало замаха) и дальше.
 */

/** Нарисовать прямоугольник цветом из PAL в координатах поля. */
export type Px = (x: number, y: number, w: number, h: number, c: string, a?: number) => void;
export type WeaponKind = 0 | 1 | 2;

/** Замах до удара (подъём, пауза на пике, удар); после — доводка и оружие ещё миг в руках. */
export const SWING_HIT = 220;
export const SWING_END = 520;
const DROP_MS = 420;
const SPARK_MS = 180;

type Dot = { x: number; y: number; c: string };
type Drop = { vx: number; vy: number; c: string };

export interface Kill {
  eid: number;
  x: number;
  y: number;
  /** Время мира удара. */
  at: number;
  kind: WeaponKind;
  dir: 1 | -1;
  pool: Dot[];
  drops: Drop[];
  /** Кто бил — известно только в повторе после разоблачения: тогда машет он, а не тень. */
  by?: number;
}

/** Кто держит оружие: ноги фигуры (свой персонаж в повторе или «тень» у жертвы). */
export interface Holder {
  x: number;
  y: number;
}

/** Цвета рук: рукав, контур, кулак. */
export interface ArmColors {
  fill: string;
  edge: string;
  fist: string;
}

/** Руки персонажа темы по карте костюма (рукав `a`, кожа `s`). */
export function armsOf(map: Record<string, string>): ArmColors {
  return { fill: map.a ?? PAL.peach, edge: PAL.ink, fist: map.s ?? PAL.peach };
}

/** «Тень убийцы» (в живой игре нападавшего не раскрываем): чёрный силуэт с неоновым контуром. */
export const SHADOW_ARMS: ArmColors = { fill: PAL.ink, edge: PAL.magenta, fist: PAL.ink };

const REDS = [PAL.red, PAL.magenta, PAL.red, PAL.plum];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Удар по сущности eid в точке (x, y) в момент at: оружие, сторона, брызги — всегда те же. */
export function makeKill(eid: number, x: number, y: number, at: number, dir: 1 | -1 = eid % 2 ? 1 : -1): Kill {
  const r = rng(eid * 7919 + Math.round(at) * 31 + 17 + (dir > 0 ? 0 : 5));
  x = Math.round(x);
  y = Math.round(y);
  const side = dir > 0 ? 0 : Math.PI;
  const pool: Dot[] = [];
  // лужа: плотное пятно под телом (по 2×2) и брызги веером в сторону удара
  for (let k = 0; k < 46; k++) {
    const rr = r() * 5.5;
    const a = r() * Math.PI * 2;
    const sx = Math.round(x + Math.cos(a) * rr * 1.6);
    const sy = Math.round(y - 1 + Math.sin(a) * rr * 0.7);
    const c = REDS[k % 4];
    pool.push({ x: sx, y: sy, c }, { x: sx + 1, y: sy, c }, { x: sx, y: sy + 1, c });
  }
  for (let k = 0; k < 30; k++) {
    const rr = 6 + r() * 14;
    const a = side + (r() - 0.5) * 1.6;
    pool.push({ x: Math.round(x + Math.cos(a) * rr), y: Math.round(y - 3 + Math.sin(a) * rr * 0.5), c: REDS[k % 3] });
  }
  const drops: Drop[] = [];
  for (let k = 0; k < 44; k++) {
    const a = side + (r() - 0.5) * 2.4;
    const v = 0.04 + r() * 0.1;
    drops.push({ vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.06, c: REDS[k % 4] });
  }
  return { eid, x, y, at, kind: (eid % 3) as WeaponKind, dir, pool, drops };
}

/** Бьющий оказался с другой стороны — брызги и тело в сторону удара. */
export function aim(k: Kill, hx: number): void {
  const dir: 1 | -1 = hx <= k.x ? 1 : -1;
  if (dir === k.dir) return;
  const n = makeKill(k.eid, k.x, k.y, k.at, dir);
  k.dir = dir;
  k.pool = n.pool;
  k.drops = n.drops;
}

/** Где встаёт «тень» — сбоку от жертвы, лицом к ней. */
export function shadowAt(k: Kill): Holder {
  return { x: k.x - k.dir * 9, y: k.y };
}

/** Оружие в руках (dt — от удара): на входе тень проявляется, на выходе мерцает и исчезает. */
export function armed(dt: number): boolean {
  const t = dt + SWING_HIT;
  if (t < 0 || t > SWING_END) return false;
  if (t < 40) return Math.floor(t / 20) % 2 === 0;
  if (t > SWING_END - 120) return Math.floor(t / 40) % 2 === 0;
  return true;
}

/** Удары оружием за дубль по журналу событий: только те, что случились в облике с оружием. */
export function killsFromLog(log: readonly WorldEvent[], weaponLook: (twist: boolean) => boolean): Kill[] {
  let twist = false;
  const out: Kill[] = [];
  for (const ev of log) {
    if (ev.t === 'twist') twist = ev.on;
    else if (ev.t === 'hit' && weaponLook(twist)) {
      const k = makeKill(ev.target, ev.x, ev.y, ev.at);
      // удар по статисту и так раскрывает бьющего (он оглушён) — машет он сам
      k.by = ev.attacker;
      out.push(k);
    }
  }
  return out;
}

/** Капля в момент t после удара (летит по дуге, на DROP_MS падает на пол). */
function dropAt(k: Kill, d: Drop, t: number): { x: number; y: number } {
  t = Math.min(t, DROP_MS);
  return { x: Math.round(k.x + d.vx * t), y: Math.round(k.y - 8 + d.vy * t + 0.0002 * t * t) };
}

/** Тело лежит на боку: центр спрайта и поворот (градусы). */
export function bodyPose(k: Kill): { x: number; y: number; angle: number } {
  return { x: k.x, y: k.y - 4, angle: k.dir * 90 };
}

/** Звук удара этим оружием. */
export function weaponSfx(k: Kill): 'whack' | 'clang' | 'stab' {
  return k.kind === 0 ? 'whack' : k.kind === 1 ? 'clang' : 'stab';
}

/** Пол (под фигурами): лужа, упавшие капли, брошенное оружие. */
export function drawFloor(px: Px, k: Kill, dt: number): void {
  if (dt < 0) return;
  for (const p of k.pool) px(p.x, p.y, 1, 1, p.c);
  if (dt >= DROP_MS) {
    for (const d of k.drops) {
      const p = dropAt(k, d, DROP_MS);
      px(p.x, p.y, 1, 1, d.c);
    }
  }
  drawDropped(px, k.x - k.dir * 9, k.y + 3, k.kind, k.dir);
}

/** Над фигурами: руки с оружием у того, кто бьёт, искры, летящие брызги. */
export function drawAir(px: Px, k: Kill, dt: number, holder: Holder, arms: ArmColors): void {
  if (armed(dt)) drawSwing(px, k, dt + SWING_HIT, holder, arms);
  if (dt < 0) return;
  if (dt < SPARK_MS) {
    const r = 3 + dt / 22;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      px(Math.round(k.x + Math.cos(a) * r), Math.round(k.y - 9 + Math.sin(a) * r * 0.8), 1, 1, dt < 70 ? PAL.white : PAL.yellow);
    }
  }
  if (dt < DROP_MS) {
    for (const d of k.drops) {
      const p = dropAt(k, d, dt);
      px(p.x, p.y, 1, 1, d.c);
    }
  }
}

/** Пиксельная линия толщиной 1–2 с контуром (без контура там, где bare). */
function stick(
  px: Px,
  x0: number,
  y0: number,
  a: number,
  len: number,
  colors: (i: number) => string,
  thick: (i: number) => number,
  edge: string = PAL.ink,
  bare?: (x: number, y: number) => boolean,
): void {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= len; i++) pts.push([Math.round(x0 + Math.cos(a) * i), Math.round(y0 - Math.sin(a) * i), i]);
  for (const [x, y, i] of pts) if (!bare?.(x, y)) px(x - 1, y - 1, thick(i) + 2, thick(i) + 2, edge);
  for (const [x, y, i] of pts) px(x, y, thick(i), thick(i), colors(i));
}

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
const out = (e: number) => 1 - (1 - e) * (1 - e);

/** Ключевые позы: [t, рука, оружие, длина руки]; между ними — плавно (удар — с разгоном). */
type Key = [number, number, number, number];
const CLUB: Key[] = [
  [0, -40, -70, 4], // оружие опущено
  [110, 128, 140, 6], // занёс над головой, оружие назад
  [150, 132, 150, 6], // пик замаха — пауза
  [SWING_HIT, 42, 22, 6], // удар по голове
  [SWING_HIT + 90, -5, -40, 5], // доводка вниз
  [SWING_END, -10, -45, 5],
];
const KNIFE: Key[] = [
  [0, -30, -30, 4],
  [110, 165, 15, 4], // отвёл руку назад, остриё вперёд
  [150, 170, 18, 4],
  [SWING_HIT, 5, 0, 7], // выпад в цель
  [SWING_HIT + 90, 0, -5, 6],
  [SWING_END, -10, -15, 5],
];

/**
 * Поза в момент t (мс от начала замаха), углы в градусах «вперёд = 0, вверх = 90, назад = 180»:
 * arm — куда вытянута рука от плеча, wep — куда смотрит оружие от кулака, reach — длина руки.
 */
function pose(kind: WeaponKind, t: number): { arm: number; wep: number; reach: number } {
  const keys = kind === 2 ? KNIFE : CLUB;
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1][0]) i++;
  const [t0, a0, w0, r0] = keys[i];
  const [t1, a1, w1, r1] = keys[i + 1];
  const k = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  // удар — с разгоном, остальное — с замедлением; на пике чуть дрожит
  const e = t1 === SWING_HIT ? k * k : out(k);
  const shake = t0 === 110 ? Math.floor(t / 20) % 2 : 0;
  return { arm: lerp(a0, a1, e) + shake, wep: lerp(w0, w1, e) + shake, reach: Math.round(lerp(r0, r1, e)) };
}

/** Руки с оружием у бьющего: заднее плечо, оружие, переднее плечо и кулак поверх рукояти; дуга-след удара. */
function drawSwing(px: Px, k: Kill, t: number, h: Holder, c: ArmColors): void {
  const f = h.x <= k.x ? 1 : -1;
  const rad = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return f > 0 ? r : Math.PI - r; // зеркально, если бьёт справа налево
  };
  const p = pose(k.kind, t);
  const sx = h.x + f;
  const sy = h.y - 7;
  const ar = rad(p.arm);
  const hx = Math.round(sx + Math.cos(ar) * p.reach);
  const hy = Math.round(sy - Math.sin(ar) * p.reach);
  const wr = rad(p.wep);
  const len = k.kind === 2 ? 0 : 12;
  // след удара: дуга, по которой прошёл конец оружия
  if (k.kind !== 2 && t >= 150 && t < SWING_HIT + 70) {
    const now = t < SWING_HIT ? pose(k.kind, t).wep : 22;
    const fade = t < SWING_HIT ? 1 : 1 - (t - SWING_HIT) / 70;
    for (let d = 146; d > now; d -= 7) {
      const r = rad(d);
      const ra = rad(lerp(42, 132, (d - 22) / 128)); // где была рука, когда оружие смотрело сюда
      const cx = sx + Math.cos(ra) * 6;
      const cy = sy - Math.sin(ra) * 6;
      px(Math.round(cx + Math.cos(r) * (len - 1)), Math.round(cy - Math.sin(r) * (len - 1)), 1, 1, PAL.white, 0.75 * fade);
      px(Math.round(cx + Math.cos(r) * (len - 4)), Math.round(cy - Math.sin(r) * (len - 4)), 1, 1, PAL.white, 0.35 * fade);
    }
  }
  // руки поверх своей фигуры — без контура, чтобы не было каши
  const inBody = (x: number, y: number) =>
    (x >= h.x - 5 && x <= h.x + 4 && y >= h.y - 16 && y <= h.y - 8) || (x >= h.x - 3 && x <= h.x + 3 && y >= h.y - 7 && y <= h.y - 1);
  // заднее плечо тянется к рукояти чуть ниже кулака
  const gx = Math.round(hx - Math.cos(wr) * 2);
  const gy = Math.round(hy + Math.sin(wr) * 2);
  const bsx = sx - f * 3;
  stick(px, bsx, sy, Math.atan2(-(gy - sy), gx - bsx), Math.max(1, Math.round(Math.hypot(gx - bsx, gy - sy))), () => c.fill, () => 1, c.edge, inBody);
  // оружие
  if (k.kind === 0) stick(px, gx, gy, wr, len, (i) => (i < 3 ? PAL.umber : i > 8 ? PAL.tan : PAL.fawn), (i) => (i > 6 ? 2 : 1));
  else if (k.kind === 1) stick(px, gx, gy, wr, len, (i) => (i === 0 || i === len ? PAL.steel : i % 4 === 2 ? PAL.white : PAL.mist), () => 2);
  else {
    stick(px, gx, gy, wr, 2, () => PAL.umber, () => 1);
    stick(px, gx + Math.round(Math.cos(wr) * 3), gy - Math.round(Math.sin(wr) * 3), wr, 7, (i) => (i === 5 ? PAL.white : PAL.mist), (i) => (i < 4 ? 2 : 1));
    // выпад: блик по ходу ножа
    if (t >= 150 && t < SWING_HIT + 50) {
      for (let d = 2; d < 9; d += 2) px(Math.round(gx - Math.cos(wr) * d), Math.round(gy + Math.sin(wr) * d) - 1, 1, 1, PAL.white, 0.5);
    }
  }
  // переднее плечо и кулак поверх рукояти
  stick(px, sx, sy, ar, p.reach, () => c.fill, () => 1, c.edge, inBody);
  px(hx - 1, hy - 1, 3, 3, c.edge);
  px(hx, hy, 2, 2, c.fist);
}

/** Брошенное оружие на полу рядом с телом. */
function drawDropped(px: Px, x: number, y: number, kind: WeaponKind, dir: 1 | -1): void {
  const a = dir > 0 ? 0.25 : Math.PI - 0.25;
  if (kind === 0) stick(px, x, y, a, 11, (i) => (i < 3 ? PAL.umber : PAL.fawn), (i) => (i > 6 ? 2 : 1));
  else if (kind === 1) stick(px, x, y, a, 12, (i) => (i === 0 || i === 12 ? PAL.steel : PAL.mist), () => 1);
  else {
    stick(px, x, y, a, 3, () => PAL.umber, () => 1);
    stick(px, x + Math.round(Math.cos(a) * 4), y - Math.round(Math.sin(a) * 4), a, 5, () => PAL.mist, () => 1);
  }
}
