import { PAL } from '@kto/assets';
import { canvas, grid, outlineOf } from '../pixels';

/**
 * Значки-слоты для эмодзи-статуса (game-core/badges.ts): «Джекпот» (777 в «Крутке») и «Три черепа» (череп).
 * Маленький автомат площадки «Казино»: три барабана крутятся и встают по одному, потом лампы мигают.
 * Кадр 23×23 + белый контур = 25×25, в файле ×4 = 100×100 (видео-эмодзи Telegram, ≤ 3 с, по кругу).
 * Без DOM: холсты — из pixels.ts.
 */
export type SlotBadge = 'jackpot' | 'skulls';

/** Длина круга анимации, мс (видео-эмодзи Telegram — до 3 секунд). */
export const SLOT_BADGE_MS = 3000;
export const SLOT_BADGE_FPS = 20;

const K: Record<string, string> = { o: PAL.ink, r: PAL.red, v: PAL.wine, y: PAL.yellow, a: PAL.amber, w: PAL.white, m: PAL.mist, s: PAL.slate, c: PAL.cyan, b: PAL.blue, g: PAL.green };

/** Символы барабана 5×7 на белой ленте. */
const SYM: Record<string, string[]> = {
  seven: ['rrrrr', 'vvvvr', '...rv', '..rv.', '..rv.', '.rv..', '.rv..'],
  // череп — белый на тёмной плашке (плашку рисует барабан): на светлой ленте в 5 пикселей его не узнать
  skull: ['.www.', 'wwwww', 'wowow', 'wwwww', '.www.', '.w.w.', '.....'],
  star: ['..y..', '..y..', 'yyyyy', '.yyy.', '.yay.', 'ya.ay', '.....'],
  cherry: ['...g.', '..gg.', '.g..g', 'rr.rr', 'rrwrr', 'rr.rr', '.....'],
  bar: ['.....', 'ooooo', 'obwbo', 'obbbo', 'ooooo', '.....', '.....'],
};
/** Лента барабана сверху вниз (крутится вниз). */
const STRIP = ['seven', 'cherry', 'star', 'bar', 'skull', 'cherry', 'star', 'bar'];
const CELL = 8;

const W = 23;
const H = 23;
/** Окно барабанов: x барабанов, верх окна, высота видимой части. */
const REEL_X = [3, 9, 15];
const REEL_Y = 7;
const REEL_H = 9;
/** Когда встаёт каждый барабан (мс от начала круга); дальше — мигание выигрыша. */
const STOP = [900, 1250, 1600];

function reelOffset(i: number, t: number, target: number): number {
  // крутится быстро, встаёт на целевой символ ровно по центру окна
  const len = STRIP.length * CELL;
  const center = target * CELL - Math.floor((REEL_H - 7) / 2);
  if (t >= STOP[i]!) return center;
  const left = STOP[i]! - t;
  // последние 200 мс — замедление и лёгкий перелёт
  const speed = 0.09;
  const back = left < 120 ? Math.round((left / 120) * 3) : Math.floor(left * speed);
  return (((center - back) % len) + len) % len;
}

function frame(kind: SlotBadge, t: number): HTMLCanvasElement {
  const { c, g } = canvas(W, H);
  const P = (x: number, y: number, col: string, w = 1, h = 1) => {
    g.fillStyle = col;
    g.fillRect(x, y, w, h);
  };
  const win = t >= STOP[2]! + 100;
  const blink = Math.floor(t / 150) % 2;
  // ручка справа: шар и стойка; в начале круга её дёргают вниз
  const pulled = t < 300;
  const ky = pulled ? 7 : 2;
  P(21, ky + 2, PAL.ink, 1, 13 - ky);
  P(22, ky + 2, PAL.slate, 0, 0);
  grid(g, 20, ky - 1, ['.oo.', 'orro', 'orvo', '.oo.'].map((r) => r.slice(0, 3)), K);
  P(20, 14, PAL.ink, 2, 2);
  // корпус: чернильный контур, красный бок, золотая рамка окна
  P(1, 3, PAL.ink, 19, 20);
  P(2, 4, PAL.red, 17, 18);
  P(2, 21, PAL.wine, 17, 1);
  P(18, 5, PAL.wine, 1, 16);
  // шапка с лампами
  P(3, 0, PAL.ink, 15, 4);
  P(4, 1, PAL.wine, 13, 2);
  for (let i = 0; i < 6; i++) P(5 + i * 2, 1, (i + (win ? blink : Math.floor(t / 250))) % 2 ? PAL.yellow : PAL.amber, 1, 2);
  // окно барабанов
  P(2, 6, PAL.amber, 17, REEL_H + 2);
  P(2, 6, PAL.yellow, 17, 1);
  P(2, 6 + REEL_H + 1, PAL.ink, 17, 1);
  const target = kind === 'jackpot' ? STRIP.indexOf('seven') : STRIP.indexOf('skull');
  REEL_X.forEach((x, i) => {
    P(x - 1, REEL_Y - 1 + 1, PAL.ink, 7, REEL_H);
    P(x, REEL_Y, PAL.white, 5, REEL_H);
    const off = reelOffset(i, t, target);
    const len = STRIP.length * CELL;
    for (let y = 0; y < REEL_H; y++) {
      const sy = (((off + y) % len) + len) % len;
      const cell = Math.floor(sy / CELL);
      const row = sy % CELL;
      const rows = SYM[STRIP[cell]!]!;
      if (STRIP[cell] === 'skull') P(x, REEL_Y + y, PAL.night, 5, 1);
      if (row >= 7) continue;
      for (let dx = 0; dx < 5; dx++) {
        const ch = rows[row]![dx]!;
        if (K[ch]) P(x + dx, REEL_Y + y, K[ch]);
      }
    }
    // тень сверху и снизу ленты — объём барабана
    P(x, REEL_Y, PAL.mist, 5, 1);
    P(x, REEL_Y + REEL_H - 1, PAL.mist, 5, 1);
  });
  // линия выигрыша: мигает после остановки
  if (win && blink) {
    const col = kind === 'jackpot' ? PAL.yellow : PAL.magenta;
    P(1, REEL_Y + 4, col, 1, 1);
    P(19, REEL_Y + 4, col, 1, 1);
  }
  // лоток монет; у джекпота из него сыплются монеты
  P(5, 18, PAL.ink, 11, 3);
  P(6, 19, PAL.night, 9, 1);
  if (win && kind === 'jackpot') {
    const k = Math.min(3, Math.floor((t - STOP[2]! - 100) / 120));
    for (let i = 0; i <= k; i++) P(7 + i * 2, 19, i % 2 ? PAL.amber : PAL.yellow, 1, 1);
  }
  return c;
}

/** Кадр значка с белым контуром (25×25). */
export function slotBadgeFrame(kind: SlotBadge, t: number): HTMLCanvasElement {
  const src = frame(kind, ((t % SLOT_BADGE_MS) + SLOT_BADGE_MS) % SLOT_BADGE_MS);
  const { c, g } = canvas(W + 2, H + 2);
  outlineOf(src.getContext('2d')!, W, H, g, 0, 0, PAL.white);
  g.drawImage(src, 1, 1);
  return c;
}

/** Последний кадр — выигрыш на месте (для страницы «Значки» и запасной картинки). */
export const slotBadgeStill = (kind: SlotBadge): HTMLCanvasElement => slotBadgeFrame(kind, STOP[2]! + 400);
