import { PAL } from '@kto/assets';
import { leshySpot } from '@kto/game-core';
import { LESHY_H, LESHY_W, leshyFrames, type LeshyKey } from './leshy-art';
import { canvas, px as ppx } from './pixels';

/**
 * Ночь «Купальской ночи» без Phaser и DOM: вуаль ночи, просветы, кадры Лешего и где он стоит в каждый миг
 * своего стоп-кадра. Одним кодом рисуют игра (scene.ts), клип и фильм (clip.ts — и на сервере).
 */

export { LESHY_H, LESHY_W };

/** Центр костра на поле (как в ядре: match.ts › sanityTick). */
export const FIRE_X = 90;
export const FIRE_Y = 132;

/**
 * Вуаль ночи 180×260: тёмно-синяя целиком, у костра (90, 132) — просвет с шахматной кромкой, чтобы свет
 * костра читался кругом, а не пятном. Прозрачность задаёт сцена (renderNight).
 */
export function makeNightVeil(): HTMLCanvasElement {
  const { c, g } = canvas(180, 260);
  for (let y = 0; y < 260; y++) {
    for (let x = 0; x < 180; x++) {
      const d = Math.hypot((x - 90) / 1.1, y - 132);
      if (d < 30) continue;
      if (d < 40 && (x + y) % 2 === 0) continue;
      if (d < 48 && x % 2 === 0 && y % 2 === 0) continue;
      ppx(g, x, y, PAL.night);
    }
  }
  return c;
}

/** Леший — кадры из leshy-art.ts (буквы → цвета PAL). */
export function makeLeshy(): HTMLCanvasElement {
  const col: Record<LeshyKey, string> = {
    o: PAL.ink, n: PAL.night, u: PAL.umber, p: PAL.plum, b: PAL.brick, d: PAL.deep, P: PAL.pine, f: PAL.forest,
    k: PAL.dusk, s: PAL.slate, m: PAL.mist, y: PAL.yellow, w: PAL.white, a: PAL.amber,
  };
  const frames = leshyFrames();
  const { c, g } = canvas(LESHY_W * frames.length, LESHY_H);
  frames.forEach((rows, f) =>
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) if (r[x] !== '.') ppx(g, f * LESHY_W + x, y, col[r[x] as LeshyKey]);
    }),
  );
  return c;
}

/** Просвет факела в ночи: стирает вуаль — сплошь в середине, решёткой к краю (как вуаль у костра). */
export function makeTorchHole(): HTMLCanvasElement {
  const R = 24;
  const { c, g } = canvas(R * 2, R * 2);
  for (let y = 0; y < R * 2; y++) {
    for (let x = 0; x < R * 2; x++) {
      const d = Math.hypot(x - R + 0.5, y - R + 0.5);
      if (d < 14 || (d < 19 && (x + y) % 2 === 0) || (d < R && x % 2 === 0 && y % 2 === 0)) ppx(g, x, y, PAL.ink);
    }
  }
  return c;
}


/** Ночь целиком с просветом углей у костра (как факел): ей клип накрывает вуаль, когда костёр прогорел. */
export function makeEmberVeil(): HTMLCanvasElement {
  const R = 24;
  const { c, g } = canvas(180, 260);
  for (let y = 0; y < 260; y++) {
    for (let x = 0; x < 180; x++) {
      const d = Math.hypot(x - FIRE_X + 0.5, y - FIRE_Y + 0.5);
      if (d < 14 || (d < 19 && (x + y) % 2 === 0) || (d < R && x % 2 === 0 && y % 2 === 0)) continue;
      ppx(g, x, y, PAL.night);
    }
  }
  return c;
}

/** Стоп-кадр Лешего: время (мировое) его выхода, окна ответа и приговора. */
export interface LeshyCrowd {
  warnAt: number;
  showAt: number;
  windowEnd: number;
  watchUntil?: number;
}

/** Где Леший и в каком кадре: x, ноги (y), кадр листа, зеркально ли, идёт ли. */
export interface GiantPose {
  x: number;
  feet: number;
  frame: number;
  flipX: boolean;
  walking: boolean;
  dir: 1 | -1;
}

/** Когда Леший уходит с поляны совсем (мировое время): после приговора — ещё 2,6 с. */
export function giantEnd(c: LeshyCrowd): number {
  return (c.watchUntil ?? c.windowEnd + 600) + 2600;
}

/**
 * Поза Лешего в мировое время t его стоп-кадра (strike — его удар, если уже был): выходит из-за края поля
 * (1,6 с), стоит и озирается, перед приговором замахивается; ударил — в два шага рядом с жертвой и бьёт;
 * потом уходит в другую сторону. now — часы анимации шага (мс). arenaW — ширина поля.
 */
export function giantPose(c: LeshyCrowd, t: number, strike: { x: number; y: number; at: number } | null, now: number, arenaW = 180): GiantPose {
  const wt = t - c.showAt;
  const judge = (c.watchUntil ?? c.windowEnd + 600) - c.showAt;
  const spot = leshySpot(c.warnAt, arenaW);
  const dir = spot.dir;
  const from = arenaW / 2 - dir * 125;
  let x: number = spot.x;
  let feet = spot.y;
  let frame: number;
  let walking = false;
  let flipX = dir < 0;
  const st = strike && t >= strike.at ? strike : null;
  const leaveAt = Math.max(judge + 500, st ? st.at - c.showAt + 900 : 0);
  if (wt < 1600) {
    x = from + (spot.x - from) * (wt / 1600);
    frame = Math.floor(now / 260) % 4;
    walking = true;
  } else if (st && wt < leaveAt) {
    const q = Math.min(1, (t - st.at) / 160);
    const side = st.x >= spot.x ? 1 : -1;
    x = spot.x + (st.x - side * 20 - spot.x) * q;
    feet = Math.round(spot.y + (st.y - spot.y) * q);
    flipX = side < 0;
    frame = t - st.at < 450 ? 7 : 4;
  } else if (wt < leaveAt) {
    frame = wt >= judge - 800 && wt < judge + 300 ? 6 : Math.floor((wt - 1600) / 700) % 2 ? 5 : 4;
  } else {
    const base = st ? { x: st.x - (st.x >= spot.x ? 1 : -1) * 20, y: st.y } : spot;
    x = base.x + dir * 140 * Math.min(1, (wt - leaveAt) / 1500);
    feet = base.y;
    frame = Math.floor(now / 220) % 4;
    walking = true;
  }
  return { x: Math.round(x), feet, frame, flipX, walking, dir };
}
