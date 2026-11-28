import { PAL } from '@kto/assets';
import type { BadgeId } from '@kto/game-core';
import { canvas, grid, outlineOf } from '../pixels';
import { F } from '../sprites';
import { slotBadgeFrame, slotBadgeStill } from './badge-slots';
import type { SlotBadge } from './badge-slots';
import { kotBananFrame } from './kot-banan';

/**
 * Значки для эмодзи-статуса Telegram (game-core/badges.ts): пиксельные иконки 18×18 + белый контур = 20×20,
 * в файле — ×5 = 100×100 PNG с прозрачным фоном (требование Telegram к custom emoji). Файлы для набора
 * бота — `pnpm --filter web badges` → `apps/server/stickers/badges/<id>.png`. Без DOM: холсты — из pixels.ts.
 */
const K: Record<string, string> = { o: PAL.ink, w: PAL.white, y: PAL.yellow, a: PAL.amber, r: PAL.red, v: PAL.wine, d: PAL.dusk, s: PAL.slate, u: PAL.umber };

const ROWS: Record<'onSet' | 'star' | 'director' | 'oscar', string[]> = {
  // хлопушка
  onSet: [
    '..........ooo.....',
    '.......oooowwo....',
    '....ooowwoowwoo...',
    '.oooowwoowwoowwo..',
    'owwoowwoowwoowwo..',
    'oowwoowwoowooooo..',
    'oooooooooooo......',
    'oooooooooooooooo..',
    'owwoowwoowwoowwo..',
    'oooooooooooooooo..',
    'oddddddddddddddo..',
    'odwwwwwwdddddddo..',
    'oddddddddddddddo..',
    'odwwwwdddwwwwddo..',
    'oddddddddddddddo..',
    'odwwwddddddddddo..',
    'oddddddddddddddo..',
    'oooooooooooooooo..',
  ],
  star: [
    '........oo........',
    '.......oyyo.......',
    '.......oyyo.......',
    '......oyyyyo......',
    '......oywyyo......',
    'ooooooyyyyyyoooooo',
    'oyyyyyywyyyyyyyyao',
    '.oyyyyyyyyyyyyyao.',
    '..oyyyyyyyyyyyao..',
    '...oyyyyyyyyyao...',
    '...oyyyyyyyyyao...',
    '..oyyyyyyyyyyyao..',
    '..oyyyyaooayyyao..',
    '.oyyyyao..oayyyao.',
    '.oyyao......oayao.',
    'oyao..........oao.',
    'oo..............oo',
    '..................',
  ],
  // рупор режиссёра
  director: [
    '..............oo..',
    '............oorro.',
    '..........oowrrro.',
    '........oowrrrrro.',
    'oooooooowrrrrrrro.',
    'owwwwwwwrrrrrrrro.',
    'owwwwwwwrrrrrrrro.',
    'owwwwwwwrrrrrrrro.',
    'oooooooovrrrrrrro.',
    '...ossoo.oovrrrro.',
    '...osso....oovrro.',
    '...osso......oovo.',
    '...osso........oo.',
    '...oooo...........',
    '..................',
    '..................',
    '..................',
    '..................',
  ],
  // статуэтка
  oscar: [
    '.......oooo.......',
    '......oyyyao......',
    '......oyyyao......',
    '.......oyao.......',
    '.....ooyyyaoo.....',
    '....oyyyyyyyao....',
    '....oyoyyyaoao....',
    '....oyoyyyaoao....',
    '....oo.oyyao.oo...',
    '.......oyyao......',
    '.......oyyao......',
    '.......oyaao......',
    '.......oyoao......',
    '.......oyoao......',
    '.....oooooooo.....',
    '....ouuuuuuuuo....',
    '...ouuuyyyyuuuo...',
    '...oooooooooooo...',
  ],
};

/** Бобина киноплёнки: круг с четырьмя окнами. */
function reel(): HTMLCanvasElement {
  const { c, g } = canvas(18, 18);
  const P = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };
  const each = (f: (x: number, y: number) => void) => {
    for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) f(x, y);
  };
  each((x, y) => {
    const r = Math.hypot(x + 0.5 - 9, y + 0.5 - 9);
    if (r < 8.6) P(x, y, r > 7.4 ? PAL.ink : PAL.steel);
  });
  for (const [hx, hy] of [[9, 4.5], [13, 9], [9, 13.5], [5, 9]] as const) each((x, y) => Math.hypot(x + 0.5 - hx, y + 0.5 - hy) < 2 && P(x, y, PAL.ink));
  each((x, y) => Math.hypot(x + 0.5 - 9, y + 0.5 - 9) < 1.6 && P(x, y, PAL.mist));
  P(6, 5, PAL.mist);
  P(5, 6, PAL.mist);
  return c;
}

/** Голова Кот-банана: верх кадра стоя (банан + морда). */
function kotBananHead(): HTMLCanvasElement {
  const f = kotBananFrame(F.D, 'D');
  const { c, g } = canvas(f.width, 21);
  g.drawImage(f, 0, 0);
  return c;
}

const SLOT: Partial<Record<BadgeId, SlotBadge>> = { jackpot: 'jackpot', skulls: 'skulls' };

function art(id: BadgeId): HTMLCanvasElement {
  if (id === 'reel') return reel();
  if (id === 'kotBanan') return kotBananHead();
  const rows = ROWS[id as keyof typeof ROWS];
  const { c, g } = canvas(rows[0]!.length, rows.length);
  grid(g, 0, 0, rows, K);
  return c;
}

/** Значок с белым контуром, без масштаба (20×20 и около). */
export function badgeIcon(id: BadgeId, t?: number): HTMLCanvasElement {
  // значки-слоты: свой автомат с белым контуром; t — кадр анимации (нет — выигрыш на месте)
  const slot = SLOT[id];
  if (slot) return t === undefined ? slotBadgeStill(slot) : slotBadgeFrame(slot, t);
  const src = art(id);
  const { c, g } = canvas(src.width + 2, src.height + 2);
  outlineOf(src.getContext('2d')!, src.width, src.height, g, 0, 0, PAL.white);
  g.drawImage(src, 1, 1);
  return c;
}

/** Файл для набора Telegram: 100×100, целый масштаб, по центру, фон прозрачный. */
export const BADGE_PX = 100;
export function badgeFile(id: BadgeId, t?: number): HTMLCanvasElement {
  const ic = badgeIcon(id, t);
  const s = Math.floor(BADGE_PX / Math.max(ic.width, ic.height));
  const { c, g } = canvas(BADGE_PX, BADGE_PX);
  g.imageSmoothingEnabled = false;
  g.drawImage(ic, Math.floor((BADGE_PX - ic.width * s) / 2), Math.floor((BADGE_PX - ic.height * s) / 2), ic.width * s, ic.height * s);
  return c;
}
