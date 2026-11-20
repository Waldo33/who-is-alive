import { PAL } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas, ellipse, grid, px } from '../pixels';
import type { PropSet, ThemePack } from './types';
import { BASE_MAP } from './base';
import { centerDist, critterSheet, hash, tile } from './util';

/** Повара на кухне: кафель, остров-плита, мышь; музыка — со свингом. */

function ground(arena: ArenaDef): HTMLCanvasElement {
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

const pack: ThemePack = {
  looks: [
    {
      chars: {
        map: {
          ...BASE_MAP,
          h: PAL.white, H: PAL.mist, k: PAL.white, r: PAL.umber, R: PAL.plum,
          s: PAL.peach, S: PAL.fawn, a: PAL.peach, m: PAL.fawn,
          b: PAL.white, B: PAL.mist, v: PAL.red, l: PAL.night, L: PAL.ink,
        },
        patch: (m) => {
          // колпак пышнее: светлые «облачка» на макушке
          m[0] = '..oooooooo..'.split('');
          m[1][2] = 'h';
          m[1][9] = 'h';
        },
      },
      ground,
      prop: (kind) => KITCHEN[kind]?.() ?? null,
      wall: () => tile(['UUUUUUUU', 'UbbbbbtU', 'UbbbbtbU', 'UbbbtbbU', 'UbbtbbbU', 'UbtbbbbU', 'UtbbbbbU', 'UUUUUUUU'], { U: PAL.umber, b: PAL.brick, t: PAL.tan }),
      critter: () => {
        // мышь
        const a = ['......', '......', '...c..', '.hbbo.', 'cbbbbo', '.o..o.'];
        const b = ['......', '......', '...c..', '.hbbo.', 'cbbbbo', '..oo..'];
        const r1 = ['......', '......', '...c..', 'chbbo.', '.bbbbo', '.o..o.'];
        const r2 = ['......', '...c..', '.hbbo.', 'cbbbbo', '..oo..', '......'];
        return critterSheet([a, b, r1, r2, r1, r2], { o: PAL.ink, b: PAL.slate, h: PAL.mist, c: PAL.coral });
      },
    },
  ],
  music: { flavor: { transpose: 5, bpm: 128, swing: 0.28, lead: 'pulse', bass: 'square', arp: false, echo: false } },
};

export default pack;
