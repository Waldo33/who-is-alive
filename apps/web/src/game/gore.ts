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

/** Замах до удара; после удара оружие ещё миг висит у цели. */
export const SWING_HIT = 170;
export const SWING_END = 430;
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
}

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
export function makeKill(eid: number, x: number, y: number, at: number): Kill {
  const r = rng(eid * 7919 + Math.round(at) * 31 + 17);
  x = Math.round(x);
  y = Math.round(y);
  const dir: 1 | -1 = eid % 2 ? 1 : -1;
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

/** Удары оружием за дубль по журналу событий: только те, что случились в облике с оружием. */
export function killsFromLog(log: readonly WorldEvent[], weaponLook: (twist: boolean) => boolean): Kill[] {
  let twist = false;
  const out: Kill[] = [];
  for (const ev of log) {
    if (ev.t === 'twist') twist = ev.on;
    else if (ev.t === 'hit' && weaponLook(twist)) out.push(makeKill(ev.target, ev.x, ev.y, ev.at));
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

/** Над фигурами: оружие в замахе, искры, летящие брызги. */
export function drawAir(px: Px, k: Kill, dt: number): void {
  const t = dt + SWING_HIT;
  if (t >= 0 && t <= SWING_END) drawWeapon(px, k.x, k.y, k.kind, k.dir, t);
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

/** Пиксельная линия толщиной 1–2 с тёмным контуром. */
function stick(px: Px, x0: number, y0: number, a: number, len: number, colors: (i: number) => string, thick: (i: number) => number): void {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= len; i++) pts.push([Math.round(x0 + Math.cos(a) * i), Math.round(y0 - Math.sin(a) * i), i]);
  for (const [x, y, i] of pts) px(x - 1, y - 1, thick(i) + 2, thick(i) + 2, PAL.ink);
  for (const [x, y, i] of pts) px(x, y, thick(i), thick(i), colors(i));
}

/**
 * Оружие — пиксельные линии, без поворота спрайтов: 0 бита, 1 труба, 2 нож.
 * t — мс с начала замаха: замах назад, быстрый удар дугой (нож — тычок), задержка у цели.
 */
function drawWeapon(px: Px, x: number, y: number, kind: WeaponKind, dir: 1 | -1, t: number): void {
  if (t > SWING_END - 120 && Math.floor(t / 40) % 2) return; // в конце мерцает и исчезает
  if (kind === 2) {
    // нож: отводит назад, тычок в цель
    const off = t < 110 ? 6 + Math.round((t / 110) * 6) : t < SWING_HIT ? Math.round(12 * (1 - (t - 110) / (SWING_HIT - 110))) : 0;
    const bx = x - dir * (5 + off);
    const by = y - 9;
    const a = dir > 0 ? 0 : Math.PI;
    stick(px, bx - dir * 4, by, a, 4, () => PAL.umber, () => 2);
    stick(px, bx, by, a, 7, (i) => (i === 5 ? PAL.white : PAL.mist), (i) => (i < 6 ? 2 : 1));
    return;
  }
  // бита / труба: от «за спиной» вверх-назад, резко вниз дугой к цели
  const a = t < 110 ? -1.4 - (t / 110) * 1.1 : t < SWING_HIT ? -2.5 + ((t - 110) / (SWING_HIT - 110)) * 2.8 : 0.3;
  const x0 = x - dir * 8;
  const y0 = y - 17;
  const ang = dir > 0 ? -a : Math.PI + a; // зеркально для удара слева
  if (kind === 0) stick(px, x0, y0, ang, 14, (i) => (i < 4 ? PAL.umber : i > 10 ? PAL.tan : PAL.fawn), (i) => (i > 7 ? 2 : 1));
  else stick(px, x0, y0, ang, 15, (i) => (i === 0 || i === 15 ? PAL.steel : i % 5 === 2 ? PAL.white : PAL.mist), () => 2);
  // след удара — дуга из светлых пикселей
  if (t >= 110 && t < SWING_HIT + 60) {
    for (let k = 0; k < 6; k++) {
      const aa = -2.5 + (k / 6) * 2.8;
      const an = dir > 0 ? -aa : Math.PI + aa;
      px(Math.round(x0 + Math.cos(an) * 13), Math.round(y0 - Math.sin(an) * 13), 1, 1, PAL.white, 0.6);
    }
  }
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
