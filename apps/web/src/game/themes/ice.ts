import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas, ellipse, grid, px } from '../pixels';
import type { PropSet, ThemePack } from './types';
import { BASE_MAP } from './base';
import { centerDist, critterSheet, hash, line, tile } from './util';

/** Пингвины на льдине: снег, прорубь, чайка; музыка — холодные колокольчики. */

function ground(arena: ArenaDef): HTMLCanvasElement {
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

const pack: ThemePack = {
  looks: [
    {
      chars: {
        map: {
          ...BASE_MAP,
          h: PAL.night, H: PAL.ink, k: PAL.dusk, r: PAL.night, R: PAL.ink,
          s: PAL.white, S: PAL.mist, a: PAL.night, m: PAL.amber, c: PAL.coral,
          b: PAL.night, B: PAL.ink, v: PAL.white, l: PAL.amber, L: PAL.orange,
        },
      },
      ground,
      prop: (kind) => ICE[kind]?.() ?? null,
      wall: () => tile(['wwwwwwwS', 'wmmmmmcS', 'wmmmmcmS', 'wmmmmmmS', 'wmmmmmmS', 'wmcmmmmS', 'wmmmmmmS', 'SSSSSSSS'], { w: PAL.white, m: PAL.mist, c: PAL.cyan, S: PAL.slate }),
      critter: (pf) => critterSheet(pf, { o: PAL.ink, b: PAL.white, h: PAL.mist, w: PAL.slate, y: PAL.amber }), // чайка
    },
  ],
  music: { flavor: { transpose: -3, bpm: 112, swing: 0, lead: 'sine', bass: 'triangle', arp: true, echo: true } },
};

export default pack;
