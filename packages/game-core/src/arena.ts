/** Арена «Площадь на закате»: препятствия, точки интереса, границы ходьбы. Координаты — логические пиксели арены. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PropKind = 'fountain' | 'tree' | 'lamp' | 'benchH' | 'benchV' | 'stall' | 'planter';

export interface Prop {
  kind: PropKind;
  /** Точка основания (по ней сортируется глубина). */
  x: number;
  y: number;
  /** Блокирующий след на земле. */
  foot: Rect;
}

export interface Point {
  x: number;
  y: number;
}

export interface ArenaDef {
  id: string;
  width: number;
  height: number;
  /** Где могут стоять «ноги» сущности. */
  walk: Rect;
  props: Prop[];
  interest: Point[];
}

function prop(kind: PropKind, x: number, y: number, foot: Rect): Prop {
  return { kind, x, y, foot };
}

export function plazaArena(width = 180, height = 260): ArenaDef {
  const cx = width / 2;
  const props: Prop[] = [
    prop('fountain', cx, 144, { x: cx - 14, y: 120, w: 28, h: 22 }),
    prop('tree', 18, 46, { x: 14, y: 42, w: 8, h: 5 }),
    prop('tree', width - 18, 46, { x: width - 22, y: 42, w: 8, h: 5 }),
    prop('tree', 18, 238, { x: 14, y: 234, w: 8, h: 5 }),
    prop('tree', width - 18, 238, { x: width - 22, y: 234, w: 8, h: 5 }),
    prop('lamp', 56, 94, { x: 54, y: 92, w: 4, h: 3 }),
    prop('lamp', width - 56, 94, { x: width - 58, y: 92, w: 4, h: 3 }),
    prop('lamp', 56, 172, { x: 54, y: 170, w: 4, h: 3 }),
    prop('lamp', width - 56, 172, { x: width - 58, y: 170, w: 4, h: 3 }),
    prop('benchH', cx, 69, { x: cx - 10, y: 63, w: 20, h: 6 }),
    prop('benchH', cx, 199, { x: cx - 10, y: 193, w: 20, h: 6 }),
    prop('benchV', 29, 140, { x: 26, y: 120, w: 7, h: 20 }),
    prop('benchV', width - 29, 140, { x: width - 33, y: 120, w: 7, h: 20 }),
    prop('stall', 47, 34, { x: 32, y: 20, w: 30, h: 14 }),
    prop('planter', width - 47, 30, { x: width - 62, y: 22, w: 30, h: 8 }),
    prop('planter', 47, 252, { x: 32, y: 244, w: 30, h: 8 }),
    prop('planter', width - 47, 252, { x: width - 62, y: 244, w: 30, h: 8 }),
  ];
  const interest: Point[] = [
    { x: cx, y: 114 },
    { x: cx, y: 150 },
    { x: cx - 22, y: 132 },
    { x: cx + 22, y: 132 },
    { x: cx, y: 76 },
    { x: cx, y: 188 },
    { x: 40, y: 132 },
    { x: width - 40, y: 132 },
    { x: 47, y: 42 },
    { x: width - 47, y: 38 },
    { x: 56, y: 100 },
    { x: width - 56, y: 178 },
  ];
  return {
    id: 'plaza',
    width,
    height,
    walk: { x: 10, y: 18, w: width - 20, h: height - 24 },
    props,
    interest,
  };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function clampToRect(r: Rect, x: number, y: number, margin = 0): Point {
  return {
    x: Math.min(r.x + r.w - margin, Math.max(r.x + margin, x)),
    y: Math.min(r.y + r.h - margin, Math.max(r.y + margin, y)),
  };
}

export function lerpRect(a: Rect, b: Rect, k: number): Rect {
  const t = Math.max(0, Math.min(1, k));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

/** Итоговый прямоугольник сужения: та же пропорция, площадь × ratio, центр в середине. */
export function shrinkRect(r: Rect, areaRatio: number): Rect {
  const k = Math.sqrt(areaRatio);
  const w = r.w * k;
  const h = r.h * k;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}
