import { PAL } from '@kto/assets';
import type { ActKind } from '@kto/game-core';
import { F, makeCharacterSheets, makeStar } from '../sprites';
import type { CharSheets } from '../sprites';
import { canvas, ellipse, grid, px } from '../pixels';
import type { Ctx } from '../pixels';
import { themeLook } from '../themes';
import { ST_FRAMES, R, actorFrame, cap, put, say, star } from './stickers';
import type { Art } from './stickers';

/**
 * Стикеры «за игру» (бесплатные, открываются в матчах): узнаваемое с площадки — хлопушка, автомат «Крутки»,
 * три звезды, массовка, стоп-кадр — и герои тем в своих движениях. Тот же холст 96×96 и 20 кадров,
 * что у стикеров гардероба (stickers.ts). Костюмы тем берутся из пакетов тем — до рисования их нужно
 * загрузить (`loadAllThemes`), иначе выйдет парк.
 */

/** Середина холста (ST_SIZE / 2): числом — модуль грузится раньше stickers.ts (циклический импорт). */
const MID = 48;

/** Мелкий арт рисуем в 1:1 и кладём ×2 — тот же «пиксель», что у Кот-банана. */
function art(w: number, h: number, draw: (g: Ctx) => void): HTMLCanvasElement {
  const { c, g } = canvas(w, h);
  g.imageSmoothingEnabled = false;
  draw(g);
  return c;
}

let bigStar: HTMLCanvasElement | null = null;
/** Звезда «трёх звёзд» 10×10 (как в игре), кадр f 0–3. */
function gameStar(f: number): HTMLCanvasElement {
  bigStar ??= makeStar();
  const { c, g } = canvas(10, 10);
  g.drawImage(bigStar, f * 10, 0, 10, 10, 0, 0, 10, 10);
  return c;
}

// ───────────── костюмы тем ─────────────

const themeSheets = new Map<number, CharSheets>();
function sheetsOf(theme: number): CharSheets {
  let s = themeSheets.get(theme);
  if (!s) {
    const look = themeLook(theme, 0);
    s = makeCharacterSheets(look.chars, look.poses);
    themeSheets.set(theme, s);
  }
  return s;
}

/** Кадры общих действий, если тема не задала своих. */
const BASE_ACT: Partial<Record<ActKind, number[]>> = {
  dance: [F.DANCE, F.DANCE + 1, F.DANCE + 2, F.DANCE + 3],
  wave: [F.WAVE, F.WAVE + 1, F.WAVE + 2, F.WAVE + 1],
  jump: [F.JUMP, F.D],
  freeze: [F.FREEZE],
};

/** Герой темы в её движении: кадр, разворот, подскок на шаге t (шаг стикера 100 мс). */
function themeActor(theme: number, act: ActKind, t: number): { fr: HTMLCanvasElement; flip: boolean; dy: number } {
  const look = themeLook(theme, 0);
  const a = look.acts?.[act];
  const sheets = sheetsOf(theme);
  if (a) {
    const step = Math.floor((t * 100) / a.ms);
    const i = step % a.poses.length;
    return { fr: actorFrame(F.COUNT + a.poses[i], sheets), flip: !!a.flip && Math.floor(step / 4) % 2 === 1, dy: a.yoff?.[i] ?? 0 };
  }
  const list = BASE_ACT[act] ?? [F.D];
  const i = Math.floor(t / 2) % list.length;
  return { fr: actorFrame(list[i], sheets), flip: false, dy: act === 'jump' && i === 0 ? -2 : 0 };
}

function hero(g: Ctx, theme: number, act: ActKind, t: number, y: number, x = MID): void {
  const { fr, flip, dy } = themeActor(theme, act, t);
  const w = fr.width * 3;
  if (flip) {
    g.save();
    g.translate(x * 2, 0);
    g.scale(-1, 1);
    put(g, fr, x - w / 2, y + dy * 3, 3);
    g.restore();
  } else put(g, fr, x - w / 2, y + dy * 3, 3);
}

// ───────────── предметы ─────────────

/** Автомат «Крутки» 30×38: табло с лампочками, три барабана, рычаг; `spin` — сколько барабанов ещё крутится. */
function slotMachine(t: number, stopped: number, lever: number): HTMLCanvasElement {
  return art(34, 40, (g) => {
    // рычаг справа
    const ly = lever ? 14 : 6;
    px(g, 29, ly + 2, PAL.ink, 3, 24 - ly);
    px(g, 30, ly + 2, PAL.mist, 1, 23 - ly);
    ellipse(g, 30.5, ly + 1.5, 2.5, 2.5, PAL.ink);
    ellipse(g, 30.5, ly + 1.5, 1.6, 1.6, PAL.red);
    px(g, 30, ly, PAL.white);
    px(g, 27, 22, PAL.ink, 3, 5);
    px(g, 27, 23, PAL.slate, 2, 3);
    // корпус
    px(g, 0, 6, PAL.ink, 28, 34);
    px(g, 1, 7, PAL.red, 26, 32);
    px(g, 1, 7, PAL.coral, 26, 1);
    px(g, 25, 8, PAL.wine, 2, 31);
    // табло-купол с лампочками
    px(g, 2, 0, PAL.ink, 24, 8);
    px(g, 3, 1, PAL.amber, 22, 6);
    px(g, 3, 1, PAL.yellow, 22, 1);
    for (let i = 0; i < 6; i++) px(g, 4 + i * 4, 3, (i + t) % 2 ? PAL.white : PAL.orange, 2, 2);
    // окно барабанов
    px(g, 2, 11, PAL.ink, 24, 13);
    px(g, 3, 12, PAL.amber, 22, 11);
    const SEVEN = ['ooooo', 'orrro', 'oooro', '.oro.', '.oro.', 'oro..', 'ooo..'];
    const CHERRY = ['...o.', '..o..', '.o.o.', 'ooooo', 'orror', 'orroo', 'ooo..'];
    const BAR = ['.....', 'ooooo', 'odddo', 'odddo', 'ooooo', '.....', '.....'];
    const syms = [SEVEN, CHERRY, BAR];
    for (let r = 0; r < 3; r++) {
      const x = 4 + r * 7;
      px(g, x, 13, PAL.white, 6, 9);
      if (r < stopped) {
        grid(g, x, 14, SEVEN.map((row) => row + '.'), { o: PAL.ink, r: PAL.red });
      } else {
        // крутится: символы бегут вниз, полосы смазки
        const off = (t * 5 + r * 3) % 9;
        for (const k of [-1, 0]) {
          const sym = syms[(Math.floor((t * 5 + r * 3) / 9) + k + r + 3) % 3];
          const yy = 14 + off + k * 9;
          sym.forEach((row, j) => {
            const y = yy + j;
            if (y < 13 || y > 21) return;
            [...row].forEach((ch, i) => {
              if (ch !== '.') px(g, x + i, y, ch === 'o' ? PAL.slate : ch === 'r' ? PAL.coral : PAL.mist);
            });
          });
        }
      }
      px(g, x, 13, PAL.mist, 6, 1);
    }
    // лоток и надпись-полоса
    px(g, 3, 27, PAL.ink, 22, 2);
    px(g, 3, 27, PAL.yellow, 22, 1);
    px(g, 5, 33, PAL.ink, 18, 5);
    px(g, 6, 34, PAL.night, 16, 3);
  });
}

/** Монета 5×5. */
function coin(g: Ctx, x: number, y: number, f: number): void {
  const w = [5, 3, 1, 3][f % 4];
  const x0 = x + (5 - w) / 2;
  R(g, x0, y, w, 5, PAL.ink);
  if (w > 1) R(g, x0 + 1, y + 1, w - 2, 3, f % 4 === 0 ? PAL.yellow : PAL.amber);
  if (w === 5) R(g, x + 1, y + 1, 1, 1, PAL.white);
}

/** Хлопушка: доска 30×22 + палка 30×5, раскрытая на угол `ang` (радианы, 0 — закрыта). */
function clapper(ang: number): HTMLCanvasElement {
  const board = art(32, 20, (g) => {
    px(g, 0, 0, PAL.ink, 32, 20);
    px(g, 1, 1, PAL.night, 30, 18);
    // полосы-зебра сверху доски
    for (let x = 1; x < 31; x++) px(g, x, 1, Math.floor((x + 2) / 4) % 2 ? PAL.white : PAL.ink, 1, 4);
    px(g, 1, 5, PAL.ink, 30, 1);
    // мелом: «сцена / дубль» — строки
    px(g, 4, 8, PAL.mist, 10, 1);
    px(g, 18, 8, PAL.mist, 9, 1);
    px(g, 4, 13, PAL.mist, 20, 1);
    px(g, 4, 10, PAL.slate, 24, 1);
    px(g, 4, 15, PAL.slate, 24, 1);
  });
  const stick = art(32, 6, (g) => {
    px(g, 0, 0, PAL.ink, 32, 6);
    for (let x = 1; x < 31; x++) px(g, x, 1, Math.floor(x / 4) % 2 ? PAL.white : PAL.ink, 1, 4);
    px(g, 1, 1, PAL.slate, 2, 4);
  });
  return art(48, 48, (g) => {
    g.drawImage(board, 8, 22);
    // палка на шарнире в левом верхнем углу доски
    g.save();
    g.translate(8, 22);
    g.rotate(-ang);
    g.drawImage(stick, 0, -6);
    g.restore();
    const img = g.getImageData(0, 0, 48, 48);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 127 ? 255 : 0;
    g.putImageData(img, 0, 0);
  });
}

/** Рупор режиссёра 26×16, раструбом вправо. */
const megaphone = () =>
  art(28, 18, (g) => {
    for (let x = 0; x < 20; x++) {
      const hh = 3 + Math.round(x * 0.32);
      px(g, 4 + x, 9 - hh, PAL.ink, 1, hh * 2);
      if (x > 0 && x < 19) {
        px(g, 4 + x, 10 - hh, x % 6 < 3 ? PAL.red : PAL.white, 1, hh * 2 - 2);
        px(g, 4 + x, 10 - hh, x % 6 < 3 ? PAL.coral : PAL.white, 1, 1);
      }
    }
    px(g, 23, 0, PAL.ink, 2, 18);
    px(g, 24, 1, PAL.mist, 1, 16);
    px(g, 0, 6, PAL.ink, 5, 6);
    px(g, 1, 7, PAL.steel, 3, 4);
    px(g, 8, 12, PAL.ink, 3, 6);
    px(g, 9, 12, PAL.dusk, 1, 5);
  });

/** Ножницы 14×9: раскрыты (open) или сомкнуты. */
const scissors = (open: boolean) =>
  art(16, 11, (g) => {
    const blades = open
      ? ['.........oo.....', '......ooomo.....', '...oooommo......', 'oo.ommmo........', 'ooooo...........', 'oo.ommmo........', '...oooommo......', '......ooomo.....', '.........oo.....']
      : ['................', '................', '...ooooo........', 'oo.ommmmoooooo..', 'oooooooommmmmmo.', 'oo.ommmmoooooo..', '...ooooo........', '................', '................'];
    grid(g, 0, 1, blades, { o: PAL.ink, m: PAL.mist });
    // кольца ручек
    for (const y of [0, 7]) {
      px(g, 0, y + (open ? 0 : 1), PAL.ink, 4, 4);
      px(g, 1, y + 1 + (open ? 0 : 1), PAL.red, 2, 2);
    }
  });

/** Кадр плёнки 22×26 с перфорацией и актёром внутри. */
const filmFrame = (fr: HTMLCanvasElement) =>
  art(24, 28, (g) => {
    px(g, 0, 0, PAL.ink, 24, 28);
    for (let y = 2; y < 28; y += 4) {
      px(g, 1, y, PAL.mist, 2, 2);
      px(g, 21, y, PAL.mist, 2, 2);
    }
    px(g, 4, 2, PAL.dusk, 16, 24);
    px(g, 4, 18, PAL.steel, 16, 8);
    g.drawImage(fr, 5, 5);
  });

/** Привидение: актёр в два тона дымки, низ растворяется в шашечку. */
function ghostOf(fr: HTMLCanvasElement): HTMLCanvasElement {
  const { c, g } = canvas(fr.width, fr.height);
  g.drawImage(fr, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [mist, white, slate] = [PAL.mist, PAL.white, PAL.slate].map(hex);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (!d[i + 3]) continue;
      const fade = y >= c.height - 5 && (x + y) % 2 === 0;
      if (fade || y >= c.height - 2) {
        d[i + 3] = 0;
        continue;
      }
      const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const col = lum < 40 ? slate : lum < 140 ? mist : white;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
    }
  }
  g.putImageData(img, 0, 0);
  // глаза-точки и «о» ртом
  px(g, 4, 8, PAL.ink, 1, 2);
  px(g, 9, 8, PAL.ink, 1, 2);
  px(g, 6, 11, PAL.steel, 2, 2);
  return c;
}

/** Уголки видоискателя. */
function viewfinder(g: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
    R(g, sx > 0 ? cx : cx - 8, sy > 0 ? cy : cy - 2, 8, 2, c);
    R(g, sx > 0 ? cx : cx - 2, sy > 0 ? cy : cy - 8, 2, 8, c);
  }
}

/** Кастрюля 16×11. */
const pot = () =>
  art(18, 12, (g) => {
    px(g, 0, 3, PAL.ink, 18, 3);
    px(g, 2, 2, PAL.ink, 14, 10);
    px(g, 3, 4, PAL.slate, 12, 7);
    px(g, 3, 4, PAL.mist, 12, 1);
    px(g, 13, 5, PAL.steel, 2, 6);
    px(g, 3, 2, PAL.white, 12, 1);
    px(g, 1, 4, PAL.steel, 1, 1);
    px(g, 16, 4, PAL.steel, 1, 1);
  });

/** Костёр 16×14: поленья и пламя (2 кадра). */
const bonfire = (f: number) =>
  art(18, 16, (g) => {
    grid(g, 1, 0, f ? ['......o.........', '.....oyo...o....', '....oyyoo.oyo...', '...oyywyyoyyo...', '..oyywwyyyyyo...', '..oyywwwyyyyyo..', '.oorywwwyyyroo..', '.orrryyyyyrrro..', '..orrrrrrrrro...'] : ['.........o......', '....o...oyo.....', '...oyo.oyyo.....', '...oyyooyyyo....', '..oyywyyywyyo...', '..oyywwwywyyo...', '.oorywwwyyyroo..', '.orrryyyyyrrro..', '..orrrrrrrrro...'], {
      o: PAL.ink,
      y: f ? PAL.amber : PAL.yellow,
      w: PAL.white,
      r: PAL.orange,
    });
    px(g, 0, 9, PAL.ink, 18, 5);
    px(g, 1, 10, PAL.brick, 16, 1);
    px(g, 1, 12, PAL.umber, 16, 1);
    px(g, 1, 11, PAL.ink, 16, 1);
  });

/** Стопка фишек 7×n. */
function chips(g: Ctx, x: number, y: number, n: number, c: string): void {
  for (let i = 0; i < n; i++) {
    R(g, x, y - i * 4, 14, 5, PAL.ink);
    R(g, x + 2, y - i * 4 + 1, 10, 2, c);
    R(g, x + 6, y - i * 4 + 1, 2, 2, PAL.white);
  }
}

// ───────────── стикеры ─────────────

export const PLAY_ART: Art[] = [
  {
    // ножницы монтажёра режут кадр с актёром, нижняя половина падает
    id: 'cut',
    draw(g, t, lang) {
      const film = filmFrame(actorFrame(t >= 10 ? F.STUN : F.D));
      const fx = MID - 24;
      const fy = 6;
      const cutY = 13;
      const top = art(24, cutY, (q) => q.drawImage(film, 0, 0));
      const bot = art(24, 28 - cutY, (q) => q.drawImage(film, 0, -cutY));
      put(g, top, fx, fy);
      if (t < 10) put(g, bot, fx, fy + cutY * 2);
      else {
        // отрезанная половина падает вниз и чуть в сторону
        const k = t - 10;
        const dy = Math.round(k * k * 0.6) + k * 2;
        if (dy < 18) put(g, bot, fx + k * 2, fy + cutY * 2 + 2 + dy);
      }
      // ножницы едут слева направо и щёлкают
      const sx = t < 10 ? -6 + t * 8 : 74;
      const open = t < 10 ? Math.floor(t / 2) % 2 === 0 : t % 4 < 2;
      put(g, scissors(open), sx, fy + cutY * 2 - 10);
      if (t >= 10 && t < 14) for (const [x, y] of [[fx - 6, fy + 22], [fx + 50, fy + 24], [fx + 2, fy + 32]]) star(g, x, y, PAL.white);
      cap(g, 'cut', lang, 84);
    },
  },
  {
    // актёр подпрыгивает, над ним по очереди загораются три звезды
    id: 'star',
    draw(g, t, lang) {
      const hop = t >= 10 && Math.floor(t / 2) % 2 === 0;
      put(g, actorFrame(t >= 10 ? F.DANCE + 2 : F.D), MID - 21, 26 - (hop ? 4 : 0), 3);
      ([[MID - 34, 14], [MID - 10, 4], [MID + 14, 14]] as const).forEach(([x, y], i) => {
        const on = t >= 2 + i * 3;
        const s = gameStar(on ? Math.floor(t / 2) % 4 : 0);
        if (!on) {
          const q = art(10, 10, (h) => {
            h.drawImage(s, 0, 0);
            h.globalCompositeOperation = 'source-atop';
            h.fillStyle = PAL.dusk;
            h.fillRect(0, 0, 10, 10);
          });
          put(g, q, x, y);
        } else put(g, s, x, y);
        if (t === 2 + i * 3 || t === 3 + i * 3) for (const [dx, dy] of [[-3, 9], [23, 9], [9, -3], [9, 21]]) R(g, x + dx, y + dy, 2, 2, PAL.white);
      });
      cap(g, 'star', lang, 84, PAL.yellow);
    },
  },
  {
    // дёрнул рычаг — барабаны встают 7-7-7, из лотка сыплются монеты
    id: 'jackpot',
    draw(g, t, lang) {
      const stopped = t < 6 ? 0 : t < 9 ? 1 : t < 12 ? 2 : 3;
      put(g, slotMachine(t, stopped, t < 3 ? 1 : 0), MID - 34, 4);
      if (stopped === 3) {
        for (let i = 0; i < 6; i++) {
          const k = t - 12 + (i % 3);
          if (k < 0) continue;
          const x = MID - 26 + i * 9 + (i % 2 ? k : -k);
          const y = 60 + Math.round(k * k * 0.6) - (i % 3) * 2;
          if (y < 80) coin(g, x, y, t + i);
        }
        if (t % 2) for (const [x, y] of [[8, 20], [84, 26], [10, 46], [86, 50]]) star(g, x, y);
      }
      cap(g, 'jackpot', lang, 84, stopped === 3 ? PAL.yellow : PAL.white);
    },
  },
  {
    // хлопушка раскрывается и хлопает
    id: 'action',
    draw(g, t, lang) {
      const ang = t < 8 ? (t / 8) * 0.4 : t < 10 ? 0.4 - (t - 8) * 0.2 : 0;
      const shake = t === 10 || t === 11 ? (t % 2 ? 1 : -1) : 0;
      put(g, clapper(Math.max(0, ang)), MID - 48 + shake, -8);
      if (t >= 10 && t < 15) {
        for (const [x, y, w, h] of [[8, 34, 6, 2], [10, 26, 5, 2], [8, 42, 5, 2], [82, 34, 6, 2], [81, 26, 5, 2], [82, 42, 5, 2]] as const) R(g, x, y, w, h, PAL.yellow);
      }
      cap(g, 'action', lang, 84);
    },
  },
  {
    // рупор режиссёра: «Ещё дубль!» волнами
    id: 'retake',
    draw(g, t, lang) {
      const kick = t % 10 < 2 ? -2 : 0;
      put(g, megaphone(), 6 + kick, 22);
      for (let i = 0; i < 3; i++) {
        const k = (t + i * 3) % 9;
        const r = 6 + k * 3;
        if (k > 7) continue;
        const col = k < 4 ? PAL.white : PAL.mist;
        for (let a = -0.9; a <= 0.9; a += 0.15) {
          const x = Math.round(60 + Math.cos(a) * r);
          const y = Math.round(40 + Math.sin(a) * r * 1.2);
          if (x < 94) R(g, x, y, 2, 2, col);
        }
      }
      cap(g, 'retake', lang, 84, PAL.yellow);
    },
  },
  {
    // одинаковые человечки; средний на миг смотрит в камеру
    id: 'extra',
    draw(g, t, lang) {
      const crowd: [number, number, number][] = [
        [MID - 30, 8, 2],
        [MID + 2, 8, 6],
        [MID - 46, 28, 1],
        [MID - 14, 28, 0],
        [MID + 18, 28, 5],
      ];
      for (const [x, y, ph] of crowd) {
        const me = ph === 0;
        const look = me && t >= 8 && t < 16;
        const fr = look ? F.STARTLE : Math.floor((t + ph) / 3) % 4 === 3 ? F.S : F.D;
        put(g, actorFrame(fr), x, y - (me && t === 8 ? 2 : 0), 2);
      }
      if (t >= 9 && t < 16) {
        R(g, MID + 12, 30, 2, 3, PAL.cyan);
        R(g, MID + 12, 30, 1, 1, PAL.white);
      }
      cap(g, 'extra', lang, 80);
    },
  },
  {
    // выбыл и смотрит из-за кадра: привидение с меткой «?»
    id: 'offscreen',
    draw(g, t, lang) {
      const bob = Math.round(Math.sin((t / ST_FRAMES) * Math.PI * 2) * 3);
      put(g, ghostOf(actorFrame(F.D)), MID - 21, 22 + bob, 3);
      if (Math.floor(t / 5) % 2 === 0) say(g, '?', 72, 8 + bob, PAL.white, 2);
      cap(g, 'offscreen', lang, 84);
    },
  },
  {
    // стоп-кадр: замер в видоискателе, мигает запись
    id: 'still',
    draw(g, t, lang) {
      put(g, actorFrame(F.FREEZE), MID - 21, 16, 3);
      viewfinder(g, 12, 6, 72, 70, PAL.white);
      if (Math.floor(t / 5) % 2 === 0) {
        R(g, 18, 12, 6, 6, PAL.ink);
        R(g, 19, 13, 4, 4, PAL.red);
      }
      // «пауза» в углу
      R(g, 72, 12, 3, 8, PAL.white);
      R(g, 77, 12, 3, 8, PAL.white);
      cap(g, 'still', lang, 82, PAL.cyan);
    },
  },
  // ── герои тем (индексы — game-core › THEME_RULES) ──
  {
    id: 'chef',
    draw(g, t, lang) {
      hero(g, 1, 'dance', t, 18, 38);
      put(g, pot(), 58, 52);
      // пар над кастрюлей
      for (const [x, ph] of [[64, 0], [72, 4], [80, 2]]) {
        const k = (t + ph) % 8;
        if (k < 6) R(g, x + (k % 4 < 2 ? 0 : 2), 48 - k * 4, 3, 3, k < 3 ? PAL.white : PAL.mist);
      }
      cap(g, 'chef', lang, 84);
    },
  },
  {
    id: 'penguin',
    draw(g, t, lang) {
      const sh = t % 2 ? 1 : -1;
      // льдина под лапами
      ellipse(g, MID, 72, 30, 6, PAL.ink);
      ellipse(g, MID, 71, 29, 5, PAL.cyan);
      ellipse(g, MID, 70, 27, 3, PAL.white);
      hero(g, 2, 'freeze', t, 16, MID + sh);
      for (const [x, ph] of [[14, 0], [30, 7], [66, 3], [82, 11], [48, 15]]) {
        const y = (ph * 4 + t * 4) % 80;
        R(g, x, y, 2, 2, PAL.white);
      }
      for (const [x, y] of [[22, 40], [72, 40]]) R(g, x + sh, y, 3, 1, PAL.cyan);
      cap(g, 'penguin', lang, 84, PAL.cyan);
    },
  },
  {
    id: 'cosmo',
    draw(g, t, lang) {
      // прыжок на Луне: высоко и плавно
      const hop = Math.round(Math.sin((t / ST_FRAMES) * Math.PI * 2) * -8) - 4;
      // Земля вдали и лунный грунт
      ellipse(g, 16, 16, 8, 8, PAL.ink);
      ellipse(g, 16, 16, 7, 7, PAL.blue);
      for (const [x, y, w] of [[12, 12, 4], [17, 15, 5], [13, 19, 3]] as const) R(g, x, y, w, 2, PAL.green);
      ellipse(g, MID, 78, 40, 6, PAL.ink);
      ellipse(g, MID, 78, 39, 5, PAL.slate);
      for (const [x, w] of [[26, 6], [58, 8]] as const) R(g, x, 76, w, 2, PAL.steel);
      hero(g, 3, t % 10 < 5 ? 'jump' : 'wave', t, 18 + hop);
      for (const [x, y, p] of [[10, 12, 0], [84, 8, 1], [12, 60, 1], [80, 56, 0], [70, 26, 0]]) if ((Math.floor(t / 3) + p) % 2) R(g, x, y, 2, 2, PAL.white);
      cap(g, 'cosmo', lang, 84);
    },
  },
  {
    id: 'office',
    draw(g, t, lang) {
      hero(g, 4, 'wave', t, 18);
      // «дзынь» телефона
      if (t % 4 < 2) for (const [x, y, w, h] of [[70, 14, 2, 6], [74, 18, 6, 2], [72, 24, 4, 2]] as const) R(g, x, y, w, h, PAL.yellow);
      cap(g, 'office', lang, 84);
    },
  },
  {
    id: 'miami',
    draw(g, t, lang) {
      // солнце с лучами за спиной
      ellipse(g, 70, 20, 10, 10, PAL.ink);
      ellipse(g, 70, 20, 9, 9, PAL.orange);
      ellipse(g, 70, 20, 7, 7, PAL.amber);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2 + (t % 2) * 0.2;
        R(g, Math.round(70 + Math.cos(ang) * 14), Math.round(20 + Math.sin(ang) * 14), 2, 2, PAL.yellow);
      }
      hero(g, 5, 'dance', t, 18);
      cap(g, 'miami', lang, 84, PAL.coral);
    },
  },
  {
    id: 'party',
    draw(g, t, lang) {
      // диско-шар
      R(g, 47, 0, 2, 6, PAL.ink);
      ellipse(g, 48, 12, 8, 8, PAL.ink);
      ellipse(g, 48, 12, 7, 7, PAL.slate);
      for (let y = 6; y < 19; y += 3) for (let x = 42; x < 55; x += 3) if ((x - 48) ** 2 + (y - 12) ** 2 < 40) R(g, x, y, 2, 2, (x + y + t) % 4 < 2 ? PAL.white : PAL.mist);
      hero(g, 6, 'dance', t, 24);
      const cols = [PAL.magenta, PAL.cyan, PAL.yellow, PAL.green];
      for (let i = 0; i < 10; i++) {
        const x = (i * 23 + 7) % 90 + 3;
        const y = (i * 17 + t * 3) % 78;
        R(g, x, y, 2, (i + t) % 2 ? 2 : 1, cols[i % 4]);
      }
      cap(g, 'party', lang, 84, PAL.magenta);
    },
  },
  {
    id: 'kupala',
    draw(g, t, lang) {
      hero(g, 7, 'dance', t, 18, 36);
      put(g, bonfire(Math.floor(t / 2) % 2), 58, 46);
      // искры костра снизу вверх
      for (let i = 0; i < 6; i++) {
        const y = 76 - ((i * 13 + t * 4) % 70);
        const x = 10 + i * 15 + (Math.floor((t + i) / 2) % 2) * 2;
        R(g, x, y, 2, 2, y > 50 ? PAL.yellow : y > 26 ? PAL.orange : PAL.red);
      }
      cap(g, 'kupala', lang, 84, PAL.amber);
    },
  },
  {
    id: 'casino',
    draw(g, t, lang) {
      hero(g, 8, 'jump', t, 20, 40);
      chips(g, 62, 72, 4, PAL.red);
      chips(g, 77, 72, 2, PAL.navy);
      for (let i = 0; i < 5; i++) {
        const k = (t + i * 4) % ST_FRAMES;
        const x = 8 + i * 19;
        const y = -6 + Math.round(k * k * 0.22);
        if (y < 78) coin(g, x, y, t + i);
      }
      cap(g, 'casino', lang, 84, PAL.yellow);
    },
  },
];

