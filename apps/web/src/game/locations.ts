import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas, ellipse, grid, px } from './pixels';
import type { Ctx } from './pixels';

/**
 * Локации тем раунда: у каждой темы своё место — кепки в парке (рисуется в sprites.ts),
 * повара на кухне, пингвины на льдине, космонавты на луне.
 *
 * Раскладка арены одна на всех (она в game-core и влияет на ходьбу, ботов и сужение зоны),
 * поэтому здесь меняется только облик: тот же след на земле — другой предмет. Размер кадров
 * и их число (фонтан — 4 кадра, фонарь — 2) у предмета-замены те же, что в парке.
 */

export type PropArt = [HTMLCanvasElement, number, number, number];

/** Темы: 0 — кепки/парк, 1 — повара/кухня, 2 — пингвины/льдина, 3 — космонавты/луна. */
export const LOC_KITCHEN = 1;
export const LOC_ICE = 2;
export const LOC_MOON = 3;

function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

/** Круг в центре площади (под фонтаном и его заменами): расстояние с растяжкой по x, как в парке. */
function centerDist(w: number, x: number, y: number): number {
  return Math.hypot((x - w / 2) / 1.15, y - 132);
}

/** Линия по пикселям (Брезенхэм). */
function line(g: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, step = 1): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  let i = 0;
  for (;;) {
    if (i++ % step === 0) px(g, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

// ═════════════ фон ═════════════

export function locBackground(theme: number, arena: ArenaDef): HTMLCanvasElement | null {
  if (theme === LOC_KITCHEN) return kitchenBg(arena);
  if (theme === LOC_ICE) return iceBg(arena);
  if (theme === LOC_MOON) return moonBg(arena);
  return null;
}

function kitchenBg(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // кафель шахматкой: холодный пол, белые повара на нём хорошо видны
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const odd = (x / 8 + y / 8) % 2 === 1;
      px(g, x, y, odd ? PAL.dusk : PAL.steel, 8, 8);
      px(g, x, y, PAL.night, 8, 1);
      px(g, x, y, PAL.night, 1, 8);
      if (!odd) px(g, x + 2, y + 2, PAL.slate, 2, 1);
      if (hash(x, y) < 0.07) px(g, x + 4, y + 3, PAL.night, 1, 3); // трещинка
    }
  }
  // деревянный настил вокруг острова-плиты
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 40 && d > 37) px(g, x, y, PAL.umber);
      else if (d <= 37) {
        const row = Math.floor(y / 4);
        const seamX = (x + row * 5) % 14 === 0;
        const v = hash(row, Math.floor((x + row * 5) / 14));
        px(g, x, y, y % 4 === 0 || seamX ? PAL.umber : v < 0.2 ? PAL.fawn : v > 0.85 ? PAL.sand : PAL.tan);
        if (y % 4 === 2 && (x * 7 + row) % 23 === 0) px(g, x, y, PAL.fawn);
      }
    }
  }
  // просыпанная мука у перечных мельниц
  for (const p of arena.props) {
    if (p.kind !== 'lamp') continue;
    for (let y = -2; y <= 3; y++) for (let x = -7; x <= 7; x++) {
      if (Math.hypot(x / 1.8, y) > 3.5 || (x + y) % 2 !== 0) continue;
      if (hash(p.x + x, p.y + y) < 0.45) px(g, p.x + x, p.y + 4 + y, PAL.slate);
    }
  }
  // стена: белый кафель, полка с банками, половники
  px(g, 0, 0, PAL.white, w, 12);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < w; x++) {
      if (y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 3) % 6 === 0) px(g, x, y, PAL.mist);
    }
  }
  px(g, 0, 5, PAL.umber, w, 1);
  px(g, 0, 6, PAL.plum, w, 1);
  const jarCols = [PAL.red, PAL.amber, PAL.green, PAL.coral, PAL.orange, PAL.blue];
  for (let x = 6; x < w - 6; x += 7) {
    const v = hash(x, 7);
    if (v < 0.75) {
      const col = jarCols[Math.floor(v * 97) % jarCols.length];
      grid(g, x, 1, ['.oo.', 'occo', 'occo', 'oooo'], { o: PAL.ink, c: col });
    }
  }
  for (let x = 10; x < w - 8; x += 13) {
    px(g, x, 7, PAL.steel, 1, 3);
    px(g, x - 1, 10, PAL.slate, 3, 1);
    px(g, x - 1, 9, PAL.steel, 1, 1);
    px(g, x + 1, 9, PAL.steel, 1, 1);
  }
  // плинтус и тёмные стены по бокам
  px(g, 0, 12, PAL.umber, w, 1);
  px(g, 0, 13, PAL.plum, w, 1);
  px(g, 0, 12, PAL.night, 4, h - 12);
  px(g, w - 4, 12, PAL.night, 4, h - 12);
  px(g, 3, 12, PAL.dusk, 1, h - 15);
  px(g, w - 4, 12, PAL.dusk, 1, h - 15);
  px(g, 0, h - 3, PAL.night, w, 3);
  return c;
}

function iceBg(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // снег: белый, голубые тени наносов — редким шахматным дизерингом, искорки
  px(g, 0, 0, PAL.white, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = hash((x + (y >> 4) * 5) >> 4, y >> 3);
      if (v < 0.28 && (x + y) % 2 === 0 && y % 2 === 0) px(g, x, y, PAL.mist);
      else if (hash(x * 5, y * 3) > 0.993) px(g, x, y, hash(x, y * 7) < 0.5 ? PAL.cyan : PAL.mist);
    }
  }
  // цепочки следов
  const trails: [number, number, number, number][] = [
    [20, 60, 70, 230],
    [160, 40, 120, 250],
    [12, 190, 170, 175],
  ];
  for (const [x0, y0, x1, y1] of trails) {
    const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / 5);
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const x = Math.round(x0 + (x1 - x0) * k + (i % 2 ? 1.5 : -1.5));
      const y = Math.round(y0 + (y1 - y0) * k);
      if (hash(i, x0) < 0.85) grid(g, x - 1, y, ['s.s', '.s.'], { s: PAL.slate });
    }
  }
  // гладкий лёд в центре
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d < 40 && d > 37.5) px(g, x, y, d > 39 ? PAL.mist : PAL.slate);
      else if (d <= 37.5) {
        let col: string = PAL.mist;
        if ((x - y + 400) % 13 === 0 || (x - y + 401) % 13 === 0) col = PAL.white;
        else if ((x + 2 * y) % 31 === 0) col = PAL.cyan;
        px(g, x, y, col);
      }
    }
  }
  // трещины во льду
  for (let k = 0; k < 5; k++) {
    let x = w / 2 + Math.round((hash(k, 1) - 0.5) * 50);
    let y = 132 + Math.round((hash(k, 2) - 0.5) * 50);
    for (let i = 0; i < 14; i++) {
      if (centerDist(w, x, y) < 36 && centerDist(w, x, y) > 18) px(g, x, y, PAL.slate);
      x += hash(k, i) < 0.5 ? 1 : -1;
      y += hash(i, k) < 0.6 ? 1 : 0;
    }
  }
  // море сверху и по краям: волны, льдинки, снежная кромка
  const sea = (x0: number, y0: number, sw: number, sh: number) => {
    px(g, x0, y0, PAL.navy, sw, sh);
    for (let y = y0; y < y0 + sh; y++) for (let x = x0; x < x0 + sw; x++) {
      if (y % 3 === 1 && (x + Math.floor(y / 3) * 4) % 9 < 3) px(g, x, y, PAL.blue);
      else if (hash(x * 3, y * 11) > 0.985) px(g, x, y, PAL.white);
    }
  };
  sea(0, 0, w, 11);
  sea(0, 0, 4, h);
  sea(w - 4, 0, 4, h);
  sea(0, h - 3, w, 3);
  for (const [fx, fy, rx] of [[34, 4, 6], [96, 6, 4], [146, 3, 7]]) {
    ellipse(g, fx, fy, rx, 2, PAL.mist);
    ellipse(g, fx, fy - 1, rx - 1, 1, PAL.white);
  }
  for (let x = 4; x < w - 4; x++) {
    const top = hash(x >> 1, 5) < 0.35 ? 9 : 10;
    px(g, x, top, PAL.white, 1, 12 - top);
  }
  px(g, 4, 12, PAL.mist, w - 8, 1);
  px(g, 4, 12, PAL.mist, 1, h - 15);
  px(g, w - 5, 12, PAL.mist, 1, h - 15);
  return c;
}

function moonBg(arena: ArenaDef): HTMLCanvasElement {
  const { width: w, height: h } = arena;
  const { c, g } = canvas(w, h);
  // реголит: ровный серый, тёмные и светлые пятна дизерингом, камешки
  px(g, 0, 0, PAL.steel, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = hash((x + (y >> 3) * 3) >> 4, y >> 4);
      if (v < 0.22 && (x + y) % 2 === 0) px(g, x, y, PAL.dusk);
      else if (v > 0.8 && (x + y) % 2 === 0 && y % 2 === 0) px(g, x, y, PAL.slate);
      const p = hash(x * 7, y * 5);
      if (p > 0.992) {
        px(g, x, y, PAL.dusk, 2, 1);
        px(g, x, y - 1, PAL.slate, 2, 1);
      }
    }
  }
  // следы лунохода
  for (let x = 6; x < w - 6; x += 2) {
    const y = Math.round(212 + 7 * Math.sin(x / 19));
    px(g, x, y, PAL.dusk);
    px(g, x, y + 4, PAL.dusk);
  }
  for (let y = 16; y < 112; y += 2) {
    const x = Math.round(150 + 5 * Math.sin(y / 17));
    px(g, x, y, PAL.dusk);
    px(g, x + 4, y, PAL.dusk);
  }
  // кратеры: свет сверху слева — тень на левой верхней стенке, светлый край справа снизу
  const craters: [number, number, number][] = [
    [28, 66, 7], [152, 150, 5], [40, 218, 8], [132, 238, 5], [100, 30, 4], [24, 120, 4], [160, 196, 6], [76, 240, 3],
  ];
  for (const [cx, cy, r] of craters) {
    for (let y = -r - 2; y <= r + 2; y++) {
      for (let x = -r - 3; x <= r + 3; x++) {
        const d = Math.hypot(x / 1.25, y);
        if (d < r) px(g, cx + x, cy + y, x + y < 0 ? PAL.dusk : PAL.steel);
        else if (d < r + 1.3) px(g, cx + x, cy + y, x + y > 0 ? PAL.mist : PAL.night);
      }
    }
  }
  // посадочная площадка в центре
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = centerDist(w, x, y);
      if (d > 40) continue;
      if (d > 37) {
        px(g, x, y, PAL.night);
        continue;
      }
      const a = Math.atan2(y - 132, (x - w / 2) / 1.15);
      let col: string = (x % 9 === 0 || y % 9 === 0) ? PAL.night : PAL.dusk;
      if (d > 32 && d < 35) col = Math.floor(((a + Math.PI) * 10) / Math.PI) % 2 ? PAL.amber : PAL.ink;
      else if (d > 21 && d < 22.5) col = PAL.slate;
      px(g, x, y, col);
    }
  }
  // космос сверху и по краям: звёзды, Земля
  const space = (x0: number, y0: number, sw: number, sh: number) => {
    px(g, x0, y0, PAL.ink, sw, sh);
    for (let y = y0; y < y0 + sh; y++) for (let x = x0; x < x0 + sw; x++) {
      const v = hash(x * 13, y * 7);
      if (v > 0.975) px(g, x, y, v > 0.992 ? PAL.white : PAL.slate);
    }
  };
  space(0, 0, w, 12);
  space(0, 0, 4, h);
  space(w - 4, 0, 4, h);
  space(0, h - 3, w, 3);
  ellipse(g, 146, 6, 5, 5, PAL.navy);
  ellipse(g, 145, 5, 4, 4, PAL.blue);
  grid(g, 142, 2, ['..gg..', '.ggg..', '..g..g', '....gg', '.w....'], { g: PAL.green, w: PAL.white });
  for (let y = 1; y <= 11; y++) for (let x = 147; x <= 151; x++) {
    if (Math.hypot(x - 146, y - 6) <= 5 && x - 146 > 1 + Math.abs(y - 6) * 0.3) px(g, x, y, PAL.night);
  }
  px(g, 4, 12, PAL.slate, w - 8, 1);
  px(g, 4, 13, PAL.dusk, w - 8, 1);
  px(g, 4, 12, PAL.slate, 1, h - 15);
  px(g, w - 5, 12, PAL.slate, 1, h - 15);
  return c;
}

// ═════════════ предметы ═════════════

export function locProp(theme: number, kind: string): PropArt | null {
  const set = theme === LOC_KITCHEN ? KITCHEN : theme === LOC_ICE ? ICE : theme === LOC_MOON ? MOON : null;
  return set?.[kind]?.() ?? null;
}

type PropSet = Record<string, () => PropArt>;

const KITCHEN: PropSet = {
  // остров-плита с кастрюлей и сковородкой; пар идёт кадрами
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      px(g, ox + 2, 13, PAL.ink, 30, 21);
      px(g, ox + 3, 14, PAL.mist, 28, 9);
      px(g, ox + 3, 14, PAL.white, 28, 1);
      px(g, ox + 3, 23, PAL.slate, 28, 10);
      px(g, ox + 3, 23, PAL.ink, 28, 1);
      px(g, ox + 5, 25, PAL.steel, 11, 6);
      px(g, ox + 18, 25, PAL.steel, 11, 6);
      px(g, ox + 14, 27, PAL.mist, 1, 2);
      px(g, ox + 19, 27, PAL.mist, 1, 2);
      px(g, ox + 3, 32, PAL.steel, 28, 1);
      // конфорки
      ellipse(g, ox + 10, 19, 5, 2, PAL.dusk);
      ellipse(g, ox + 23, 19, 5, 2, PAL.dusk);
      grid(g, ox + 5, 8, [
        '.ooooooooo.',
        'owAAAAAAAwo',
        '.ooooooooo.',
        'oorrrrrrroo',
        '.orrrrrrro.',
        '.orRrrrrro.',
        '.oRRRRRRRo.',
        '..ooooooo..',
      ], { o: PAL.ink, w: PAL.white, A: PAL.orange, r: PAL.red, R: PAL.wine });
      grid(g, ox + 17, 13, [
        '..oooooo....',
        '.osnwwnso...',
        '.osnwyysoooo',
        '.osnnnnsoUUo',
        '..oooooo.oo.',
      ], { o: PAL.ink, s: PAL.slate, n: PAL.night, w: PAL.white, y: PAL.yellow, U: PAL.umber });
      // огонёк под сковородкой
      px(g, ox + 19 + (f % 2) * 2, 18, f % 2 ? PAL.cyan : PAL.blue);
      px(g, ox + 23 - (f % 2) * 2, 18, f % 2 ? PAL.blue : PAL.cyan);
      // пар
      for (let k = 0; k < 4; k++) {
        const t = ((k * 3 + f) % 4) / 4 + (k % 2) * 0.12;
        const x = ox + 10 + Math.round(Math.sin(t * 6 + k) * 2) + (k % 2 ? 2 : -1);
        const y = Math.round(7 - t * 7);
        px(g, x, y, t < 0.45 ? PAL.white : PAL.mist, t < 0.3 ? 2 : 1, 1);
      }
    }
    return [c, fw, fh, 4];
  },
  // лимонное деревце в горшке
  tree: () => {
    const { c, g } = canvas(22, 30);
    px(g, 6, 21, PAL.ink, 10, 9);
    px(g, 7, 22, PAL.brick, 8, 7);
    px(g, 7, 22, PAL.clay, 8, 1);
    px(g, 5, 21, PAL.ink, 12, 2);
    px(g, 6, 21, PAL.rust, 10, 1);
    px(g, 10, 15, PAL.ink, 3, 6);
    px(g, 11, 15, PAL.umber, 1, 6);
    ellipse(g, 11, 9, 9, 8, PAL.ink);
    ellipse(g, 11, 9, 8, 7, PAL.forest);
    ellipse(g, 9, 7, 5, 4, PAL.green);
    for (let k = 0; k < 8; k++) {
      const x = 5 + Math.floor(hash(k, 3) * 12);
      const y = 4 + Math.floor(hash(k, 4) * 10);
      px(g, x, y, PAL.pine);
    }
    for (const [x, y] of [[6, 10], [14, 6], [12, 12], [16, 11]]) {
      px(g, x, y, PAL.yellow, 2, 2);
      px(g, x + 1, y + 1, PAL.amber);
    }
    return [c, 22, 30, 1];
  },
  // огромная перечная мельница (кадры одинаковые: фонарь в парке мигает, здесь нечему)
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      grid(g, ox + 2, 0, ['.ooo.', 'osmso', '.ooo.'], { o: PAL.ink, s: PAL.slate, m: PAL.mist });
      for (let y = 3; y < 24; y++) {
        const hw = y > 9 && y < 15 ? 2 : 3;
        px(g, ox + 4 - hw, y, PAL.ink, hw * 2 + 1, 1);
        px(g, ox + 5 - hw, y, PAL.brick, hw * 2 - 1, 1);
        px(g, ox + 5 - hw, y, PAL.tan, 1, 1);
        px(g, ox + 3 + hw, y, PAL.umber, 1, 1);
      }
      px(g, ox + 1, 8, PAL.ink, 7, 1);
      px(g, ox + 1, 16, PAL.ink, 7, 1);
      px(g, ox + 1, 24, PAL.ink, 7, 2);
    }
    return [c, 9, 26, 2];
  },
  // разделочный стол: доска, помидор, морковь, нож
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 1, PAL.ink, 22, 7);
    px(g, 1, 2, PAL.tan, 20, 4);
    px(g, 1, 2, PAL.sand, 20, 1);
    px(g, 1, 6, PAL.brick, 20, 1);
    px(g, 3, 3, PAL.sand, 8, 3);
    px(g, 3, 5, PAL.fawn, 8, 1);
    grid(g, 4, 2, ['.gg', 'rrr', 'rrr'], { g: PAL.green, r: PAL.red });
    grid(g, 13, 3, ['ooog', '.oo.'], { o: PAL.orange, g: PAL.green });
    px(g, 17, 4, PAL.mist, 3, 1);
    px(g, 15, 4, PAL.umber, 2, 1);
    px(g, 2, 8, PAL.ink, 2, 2);
    px(g, 18, 8, PAL.ink, 2, 2);
    return [c, 22, 10, 1];
  },
  benchV: () => {
    const { c, g } = canvas(9, 24);
    px(g, 1, 0, PAL.ink, 7, 22);
    px(g, 2, 1, PAL.tan, 5, 20);
    px(g, 2, 1, PAL.sand, 1, 20);
    px(g, 6, 1, PAL.brick, 1, 20);
    grid(g, 3, 3, ['.g.', 'rrr', 'rrr'], { g: PAL.green, r: PAL.red });
    grid(g, 3, 9, ['ggg', 'gGg', 'ggg'], { g: PAL.green, G: PAL.forest });
    grid(g, 3, 15, ['ooo', 'o.o', 'ooo'], { o: PAL.mist });
    px(g, 4, 16, PAL.yellow);
    px(g, 1, 22, PAL.ink, 2, 2);
    px(g, 6, 22, PAL.ink, 2, 2);
    return [c, 9, 24, 1];
  },
  // плита с духовкой
  stall: () => {
    const { c, g } = canvas(34, 30);
    px(g, 2, 4, PAL.ink, 30, 26);
    px(g, 3, 5, PAL.slate, 28, 4);
    for (let x = 6; x < 30; x += 5) px(g, x, 6, PAL.ink, 2, 2);
    px(g, 3, 9, PAL.night, 28, 5);
    ellipse(g, 10, 11, 4, 1, PAL.dusk);
    ellipse(g, 24, 11, 4, 1, PAL.dusk);
    px(g, 8, 11, PAL.orange, 1, 1);
    px(g, 12, 11, PAL.amber, 1, 1);
    px(g, 3, 14, PAL.mist, 28, 15);
    px(g, 3, 14, PAL.white, 28, 1);
    px(g, 6, 17, PAL.ink, 22, 10);
    px(g, 7, 18, PAL.night, 20, 8);
    for (let y = 21; y < 26; y++) for (let x = 8; x < 26; x++) if ((x + y) % 2 === 0) px(g, x, y, y > 23 ? PAL.orange : PAL.rust);
    px(g, 9, 16, PAL.steel, 16, 1);
    px(g, 3, 28, PAL.steel, 28, 1);
    // кастрюлька наверху
    grid(g, 20, 0, ['.oooooo.', 'osssssso', 'osssssso', '.oooooo.'], { o: PAL.ink, s: PAL.steel });
    px(g, 21, 1, PAL.mist, 6, 1);
    return [c, 34, 30, 1];
  },
  // ящики с овощами
  planter: () => {
    const { c, g } = canvas(32, 13);
    px(g, 0, 4, PAL.ink, 32, 9);
    px(g, 1, 5, PAL.brick, 30, 7);
    px(g, 1, 5, PAL.tan, 30, 1);
    px(g, 1, 8, PAL.umber, 30, 1);
    px(g, 15, 5, PAL.umber, 2, 7);
    const veg = [PAL.green, PAL.red, PAL.orange, PAL.sand, PAL.red, PAL.green, PAL.yellow, PAL.orange, PAL.green, PAL.red];
    for (let i = 0; i < veg.length; i++) {
      const x = 1 + i * 3;
      px(g, x, 2 + (i % 2), veg[i], 3, 3);
      px(g, x, 2 + (i % 2), PAL.ink, 1, 1);
      if (veg[i] === PAL.orange || veg[i] === PAL.red) px(g, x + 1, 1 + (i % 2), PAL.forest, 1, 1);
    }
    return [c, 32, 13, 1];
  },
};

const ICE: PropSet = {
  // прорубь с удочкой, рябь и поплавок
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      ellipse(g, ox + 17, 24, 16, 9, PAL.ink);
      ellipse(g, ox + 17, 25, 15, 8, PAL.mist);
      ellipse(g, ox + 17, 24, 15, 7, PAL.white);
      ellipse(g, ox + 17, 24, 11, 5, PAL.ink);
      ellipse(g, ox + 17, 25, 10, 4, PAL.navy);
      ellipse(g, ox + 17, 26, 8, 2, PAL.blue);
      // рябь расходится кругами
      for (let k = 0; k < 2; k++) {
        const r = ((f + k * 2) % 4) + 2;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const x = Math.round(12 + Math.cos(ang) * r * 1.6);
          const y = Math.round(25 + Math.sin(ang) * r * 0.6);
          if (Math.hypot((x - 17) / 10, (y - 25) / 4) < 1) px(g, ox + x, y, PAL.cyan);
        }
      }
      // удочка в снежной кочке, леска, поплавок
      ellipse(g, ox + 28, 23, 4, 2, PAL.ink);
      ellipse(g, ox + 28, 22, 3, 1, PAL.white);
      line(g, ox + 28, 22, ox + 22, 2, PAL.ink);
      line(g, ox + 29, 22, ox + 23, 2, PAL.umber);
      line(g, ox + 22, 2, ox + 12, 23, PAL.mist, 2);
      const by = 23 + (f % 2);
      px(g, ox + 12, by, PAL.red);
      px(g, ox + 12, by + 1, PAL.white);
    }
    return [c, fw, fh, 4];
  },
  // ёлка в снегу
  tree: () => {
    const { c, g } = canvas(22, 30);
    px(g, 9, 24, PAL.ink, 4, 6);
    px(g, 10, 24, PAL.umber, 2, 6);
    const tiers: [number, number, number][] = [[1, 11, 5], [6, 17, 7], [11, 25, 10]];
    for (const [top, bot, half] of tiers) {
      for (let y = top; y <= bot; y++) {
        const hw = Math.max(1, Math.round((half * (y - top + 1)) / (bot - top + 1)));
        px(g, 11 - hw - 1, y, PAL.ink, hw * 2 + 2, 1);
      }
    }
    for (const [top, bot, half] of tiers) {
      for (let y = top + 1; y < bot; y++) {
        const hw = Math.max(1, Math.round((half * (y - top + 1)) / (bot - top + 1))) - 1;
        if (hw < 1) continue;
        px(g, 11 - hw, y, PAL.forest, hw * 2, 1);
        px(g, 11 - hw, y, PAL.pine, Math.ceil(hw / 2), 1);
        if (y - top < 3 || hash(y, top) < 0.2) px(g, 11 - hw + Math.floor(hash(y, 9) * hw), y, PAL.white, Math.min(3, hw), 1);
      }
    }
    return [c, 22, 30, 1];
  },
  // флажок на шесте (кадры: флаг полощется)
  lamp: () => {
    const fw = 15;
    const { c, g } = canvas(fw * 2, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * fw;
      px(g, ox + 6, 3, PAL.ink, 3, 21);
      px(g, ox + 7, 4, PAL.mist, 1, 20);
      px(g, ox + 6, 1, PAL.amber, 3, 2);
      const rows = f ? ['ooooooo.', 'orrwwrro', 'orwwrrro', '.ooooooo'] : ['oooooo..', 'orrwwroo', 'orrwwrro', 'oooooooo'];
      grid(g, ox + 8, 3 + f, rows, { o: PAL.ink, r: PAL.red, w: PAL.white });
      ellipse(g, ox + 7, 24, 5, 1, PAL.mist);
      px(g, ox + 4, 23, PAL.white, 7, 1);
    }
    return [c, fw, 26, 2];
  },
  // ледяные глыбы
  benchH: () => {
    const { c, g } = canvas(22, 10);
    const block = (x: number, bw: number) => {
      px(g, x, 0, PAL.ink, bw, 10);
      px(g, x + 1, 1, PAL.white, bw - 2, 3);
      px(g, x + 1, 4, PAL.mist, bw - 2, 5);
      px(g, x + 1, 8, PAL.slate, bw - 2, 1);
      px(g, x + 2, 5, PAL.cyan, 1, 1);
      px(g, x + 3, 6, PAL.cyan, 1, 1);
    };
    block(0, 11);
    block(11, 11);
    return [c, 22, 10, 1];
  },
  benchV: () => {
    const { c, g } = canvas(9, 24);
    for (let i = 0; i < 3; i++) {
      const y = i * 8;
      px(g, 1, y, PAL.ink, 7, 8);
      px(g, 2, y + 1, i === 0 ? PAL.white : PAL.mist, 5, 2);
      px(g, 2, y + 3, PAL.mist, 5, 4);
      px(g, 2, y + 6, PAL.slate, 5, 1);
      px(g, 3, y + 4, PAL.cyan, 1, 1);
    }
    return [c, 9, 24, 1];
  },
  // иглу
  stall: () => {
    const { c, g } = canvas(34, 30);
    ellipse(g, 17, 25, 16, 17, PAL.ink);
    ellipse(g, 17, 25, 15, 16, PAL.white);
    for (let y = 9; y < 30; y++) for (let x = 2; x < 32; x++) {
      const inside = Math.hypot((x - 17) / 15, (y - 25) / 16) < 1;
      if (!inside) continue;
      if (x - 17 + (y - 25) * 0.6 > 6) px(g, x, y, PAL.mist);
      const row = Math.floor((y - 9) / 4);
      if ((y - 9) % 4 === 3 || (x + row * 4) % 8 === 0) px(g, x, y, PAL.slate);
    }
    px(g, 0, 29, PAL.ink, 34, 1);
    // вход
    grid(g, 10, 18, [
      '..ooooooooo..',
      '.owwwwwwwwwo.',
      'owwmmmmmmmwwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'owmonnnnnomwo',
      'ooooooooooooo',
    ], { o: PAL.ink, w: PAL.white, m: PAL.mist, n: PAL.night });
    return [c, 34, 30, 1];
  },
  // сугроб и рыба из него
  planter: () => {
    const { c, g } = canvas(32, 13);
    ellipse(g, 8, 9, 8, 4, PAL.ink);
    ellipse(g, 19, 8, 10, 5, PAL.ink);
    ellipse(g, 27, 10, 5, 3, PAL.ink);
    px(g, 0, 12, PAL.ink, 32, 1);
    ellipse(g, 8, 9, 7, 3, PAL.white);
    ellipse(g, 19, 8, 9, 4, PAL.white);
    ellipse(g, 27, 10, 4, 2, PAL.white);
    px(g, 1, 11, PAL.mist, 30, 1);
    const fish = ['.o.o.', '..o..', '.obo.', '.ocb.', '.obo.'];
    grid(g, 9, 0, fish, { o: PAL.ink, b: PAL.blue, c: PAL.cyan });
    grid(g, 21, 1, fish, { o: PAL.ink, b: PAL.steel, c: PAL.mist });
    return [c, 32, 13, 1];
  },
};

const MOON: PropSet = {
  // посадочный модуль: золотая фольга, кабина, мигающий маячок
  fountain: () => {
    const fw = 34;
    const fh = 34;
    const { c, g } = canvas(fw * 4, fh);
    for (let f = 0; f < 4; f++) {
      const ox = f * fw;
      // опоры
      line(g, ox + 8, 19, ox + 3, 31, PAL.ink);
      line(g, ox + 9, 19, ox + 4, 31, PAL.slate);
      line(g, ox + 25, 19, ox + 30, 31, PAL.ink);
      line(g, ox + 24, 19, ox + 29, 31, PAL.slate);
      px(g, ox + 1, 31, PAL.ink, 6, 2);
      px(g, ox + 27, 31, PAL.ink, 6, 2);
      px(g, ox + 2, 31, PAL.mist, 4, 1);
      px(g, ox + 28, 31, PAL.mist, 4, 1);
      // сопло
      grid(g, ox + 13, 24, ['oooooooo', '.osssso.', 'osssssso', 'oooooooo'], { o: PAL.ink, s: PAL.steel });
      // посадочная ступень в фольге
      px(g, ox + 6, 13, PAL.ink, 22, 12);
      for (let y = 14; y < 24; y++) for (let x = 7; x < 27; x++) {
        const v = hash(x, y);
        px(g, ox + x, y, v < 0.18 ? PAL.orange : v > 0.8 ? PAL.yellow : PAL.amber);
      }
      px(g, ox + 7, 14, PAL.yellow, 20, 1);
      px(g, ox + 16, 14, PAL.ink, 1, 10);
      // взлётная ступень — кабина
      grid(g, ox + 9, 3, [
        '..oooooooooo..',
        '.ommmmmmmmmmo.',
        'omwwmmmmmmmsso',
        'omonnnommmmsso',
        'omoncnommmmsso',
        'omonnnommmmsso',
        'ommmmmmmmmmsso',
        'osssssssssssso',
        'oooooooooooooo',
        '..o........o..',
      ], { o: PAL.ink, m: PAL.mist, w: PAL.white, s: PAL.slate, n: PAL.night, c: PAL.cyan });
      // антенна-тарелка
      line(g, ox + 22, 4, ox + 25, 1, PAL.ink);
      px(g, ox + 24, 0, PAL.mist, 3, 1);
      // маячок
      const on = f < 2;
      px(g, ox + 15, 1, PAL.ink, 4, 3);
      px(g, ox + 16, 2, on ? PAL.red : PAL.wine, 2, 1);
      if (on) px(g, ox + 16, 1, PAL.coral, 2, 1);
    }
    return [c, fw, fh, 4];
  },
  // радиотарелка на треноге
  tree: () => {
    const { c, g } = canvas(22, 30);
    line(g, 11, 16, 4, 29, PAL.ink);
    line(g, 11, 16, 18, 29, PAL.ink);
    line(g, 11, 16, 11, 29, PAL.ink);
    line(g, 11, 17, 5, 29, PAL.slate);
    line(g, 12, 17, 18, 28, PAL.steel);
    ellipse(g, 11, 10, 10, 7, PAL.ink);
    ellipse(g, 11, 10, 9, 6, PAL.mist);
    ellipse(g, 12, 11, 6, 4, PAL.white);
    ellipse(g, 9, 12, 5, 2, PAL.slate);
    line(g, 11, 10, 7, 2, PAL.ink);
    px(g, 6, 1, PAL.amber, 2, 2);
    return [c, 22, 30, 1];
  },
  // маяк на штанге: мигает красным
  lamp: () => {
    const { c, g } = canvas(18, 26);
    for (let f = 0; f < 2; f++) {
      const ox = f * 9;
      px(g, ox + 3, 5, PAL.ink, 3, 19);
      px(g, ox + 4, 6, PAL.slate, 1, 17);
      px(g, ox + 1, 23, PAL.ink, 7, 3);
      px(g, ox + 2, 24, PAL.steel, 5, 1);
      grid(g, ox + 1, 0, ['.ooooo.', 'orrwrro', 'orrrrro', '.ooooo.', '..ooo..'], {
        o: PAL.ink,
        r: f ? PAL.wine : PAL.red,
        w: f ? PAL.wine : PAL.coral,
      });
    }
    return [c, 9, 26, 2];
  },
  // солнечные панели
  benchH: () => {
    const { c, g } = canvas(22, 10);
    px(g, 0, 0, PAL.ink, 22, 8);
    px(g, 1, 1, PAL.navy, 20, 6);
    for (let x = 1; x < 21; x += 5) px(g, x, 1, PAL.blue, 1, 6);
    px(g, 1, 4, PAL.blue, 20, 1);
    px(g, 3, 2, PAL.cyan, 2, 1);
    px(g, 13, 5, PAL.cyan, 1, 1);
    px(g, 3, 8, PAL.ink, 2, 2);
    px(g, 17, 8, PAL.ink, 2, 2);
    return [c, 22, 10, 1];
  },
  benchV: () => {
    const { c, g } = canvas(9, 24);
    px(g, 1, 0, PAL.ink, 7, 22);
    px(g, 2, 1, PAL.navy, 5, 20);
    for (let y = 1; y < 21; y += 5) px(g, 2, y, PAL.blue, 5, 1);
    px(g, 4, 1, PAL.blue, 1, 20);
    px(g, 3, 2, PAL.cyan, 1, 2);
    px(g, 1, 22, PAL.ink, 2, 2);
    px(g, 6, 22, PAL.ink, 2, 2);
    return [c, 9, 24, 1];
  },
  // жилой модуль базы
  stall: () => {
    const { c, g } = canvas(34, 30);
    ellipse(g, 17, 12, 16, 7, PAL.ink);
    px(g, 1, 12, PAL.ink, 32, 18);
    ellipse(g, 17, 12, 15, 6, PAL.white);
    px(g, 2, 12, PAL.white, 30, 17);
    px(g, 2, 24, PAL.mist, 30, 5);
    for (let x = 7; x < 32; x += 7) px(g, x, 8, PAL.mist, 1, 21);
    px(g, 2, 19, PAL.red, 30, 1);
    // иллюминатор
    grid(g, 6, 12, ['.oooo.', 'onnnco', 'onnnno', '.oooo.'], { o: PAL.ink, n: PAL.night, c: PAL.cyan });
    // шлюз
    px(g, 21, 17, PAL.ink, 9, 13);
    px(g, 22, 18, PAL.slate, 7, 11);
    px(g, 25, 18, PAL.steel, 1, 11);
    px(g, 24, 15, PAL.amber, 3, 1);
    // антенна
    px(g, 28, 0, PAL.ink, 1, 7);
    px(g, 27, 0, PAL.red, 3, 1);
    return [c, 34, 30, 1];
  },
  // контейнеры с образцами
  planter: () => {
    const { c, g } = canvas(32, 13);
    for (let i = 0; i < 3; i++) {
      const x = i * 11;
      px(g, x, 3, PAL.ink, 10, 10);
      px(g, x + 1, 4, PAL.mist, 8, 8);
      px(g, x + 1, 4, PAL.white, 8, 1);
      px(g, x + 1, 11, PAL.slate, 8, 1);
      for (let k = 0; k < 8; k++) px(g, x + 1 + k, 7, (k + i) % 4 < 2 ? PAL.amber : PAL.ink);
    }
    return [c, 32, 13, 1];
  },
};

// ═════════════ стенка сужающейся зоны (плитка 8×8) ═════════════

export function locWall(theme: number): HTMLCanvasElement | null {
  const rows: Record<number, [string[], Record<string, string>]> = {
    [LOC_KITCHEN]: [
      ['UUUUUUUU', 'UbbbbbtU', 'UbbbbtbU', 'UbbbtbbU', 'UbbtbbbU', 'UbtbbbbU', 'UtbbbbbU', 'UUUUUUUU'],
      { U: PAL.umber, b: PAL.brick, t: PAL.tan },
    ],
    [LOC_ICE]: [
      ['wwwwwwwS', 'wmmmmmcS', 'wmmmmcmS', 'wmmmmmmS', 'wmmmmmmS', 'wmcmmmmS', 'wmmmmmmS', 'SSSSSSSS'],
      { w: PAL.white, m: PAL.mist, c: PAL.cyan, S: PAL.slate },
    ],
    [LOC_MOON]: [
      ['nssmssdn', 'smmsssdn', 'ssssssdn', 'dssssddn', 'nddddnss', 'ssdnsmms', 'sssdssss', 'dddnnddd'],
      { n: PAL.night, s: PAL.slate, m: PAL.mist, d: PAL.dusk },
    ],
  };
  const r = rows[theme];
  if (!r) return null;
  const { c, g } = canvas(8, 8);
  grid(g, 0, 0, r[0], r[1]);
  return c;
}

// ═════════════ зверьки (кадры как у голубя: 0–1 стоит, 2–5 убегает) ═════════════

export function locCritter(theme: number, pigeonFrames: string[][]): HTMLCanvasElement | null {
  let frames = pigeonFrames;
  let map: Record<string, string>;
  if (theme === LOC_KITCHEN) {
    // мышь
    const a = ['......', '......', '...c..', '.hbbo.', 'cbbbbo', '.o..o.'];
    const b = ['......', '......', '...c..', '.hbbo.', 'cbbbbo', '..oo..'];
    const r1 = ['......', '......', '...c..', 'chbbo.', '.bbbbo', '.o..o.'];
    const r2 = ['......', '...c..', '.hbbo.', 'cbbbbo', '..oo..', '......'];
    frames = [a, b, r1, r2, r1, r2];
    map = { o: PAL.ink, b: PAL.slate, h: PAL.mist, c: PAL.coral };
  } else if (theme === LOC_ICE) {
    map = { o: PAL.ink, b: PAL.white, h: PAL.mist, w: PAL.slate, y: PAL.amber }; // чайка
  } else if (theme === LOC_MOON) {
    map = { o: PAL.ink, b: PAL.steel, h: PAL.slate, w: PAL.cyan, y: PAL.red }; // дрон
  } else return null;
  const { c, g } = canvas(36, 6);
  frames.forEach((f, i) => grid(g, i * 6, 0, f, map));
  return c;
}
