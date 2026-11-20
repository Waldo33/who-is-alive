import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas, ellipse, grid, px } from '../pixels';
import type { PropSet, ThemePack } from './types';
import { BASE_MAP } from './base';
import { centerDist, critterSheet, hash, line, tile } from './util';

/** Космонавты на луне: реголит, посадочный модуль, дрон; музыка — «бип» с эхом. */

function ground(arena: ArenaDef): HTMLCanvasElement {
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

const pack: ThemePack = {
  looks: [
    {
      chars: {
        map: {
          ...BASE_MAP,
          h: PAL.white, H: PAL.slate, k: PAL.cyan, r: PAL.white, R: PAL.mist,
          s: PAL.peach, S: PAL.fawn, a: PAL.mist, m: PAL.fawn,
          b: PAL.white, B: PAL.mist, v: PAL.blue, l: PAL.mist, L: PAL.slate,
        },
        patch: (m, view) => {
          // круглый шлем вокруг лица: шире головы на пиксель с каждой стороны
          const set = (y: number, x: number, ch: string) => {
            m[y][x] = ch;
          };
          set(0, 2, 'o'); set(0, 9, 'o');
          set(1, 1, 'o'); set(1, 2, 'h'); set(1, 9, 'h'); set(1, 10, 'o');
          for (let y = 2; y <= 7; y++) {
            set(y, 0, 'o'); set(y, 1, y < 4 ? 'h' : 'H'); set(y, 10, y < 4 ? 'h' : 'H'); set(y, 11, 'o');
          }
          set(8, 1, 'o'); set(8, 2, 'H'); set(8, 9, 'H'); set(8, 10, 'o');
          // ранец со спины
          if (view === 'U') for (let y = 9; y <= 11; y++) for (let x = 4; x <= 7; x++) set(y, x, 'H');
        },
      },
      ground,
      prop: (kind) => MOON[kind]?.() ?? null,
      wall: () => tile(['nssmssdn', 'smmsssdn', 'ssssssdn', 'dssssddn', 'nddddnss', 'ssdnsmms', 'sssdssss', 'dddnnddd'], { n: PAL.night, s: PAL.slate, m: PAL.mist, d: PAL.dusk }),
      critter: (pf) => critterSheet(pf, { o: PAL.ink, b: PAL.steel, h: PAL.slate, w: PAL.cyan, y: PAL.red }), // дрон
    },
  ],
  music: { flavor: { transpose: 2, bpm: 116, swing: 0, lead: 'square', bass: 'pulse', arp: true, echo: true } },
};

export default pack;
