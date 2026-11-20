/** Лист темы крупно (×8): по облику — костюм в общих кадрах, свои позы, иконки команд. См. theme-sheet.mjs. */
import { PAL } from '@kto/assets';
import { CH_H, CH_W, F, makeCharacterSheets, makeIconSheet } from '../src/game/sprites';
import { loadTheme } from '../src/game/themes';

const G = globalThis as unknown as { __theme: number; __png: string };
const SC = 8;
const BASE = [F.D, F.D + 2, F.U, F.S, F.S + 3, F.FREEZE, F.WAVE, F.DANCE, F.JUMP, F.STUN];

void loadTheme(G.__theme).then((pack) => {
  const cols = Math.max(BASE.length, ...pack.looks.map((l) => l.poses?.length ?? 0));
  const rowH = (CH_H + 3) * SC;
  const c = document.createElement('canvas');
  c.width = cols * (CH_W + 1) * SC;
  c.height = pack.looks.length * (rowH * 2 + 10 * SC);
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = PAL.dusk;
  g.fillRect(0, 0, c.width, c.height);
  pack.looks.forEach((lk, li) => {
    const y0 = li * (rowH * 2 + 10 * SC);
    const s = makeCharacterSheets(lk.chars, lk.poses);
    const put = (frame: number, col: number, y: number) =>
      g.drawImage(s.body, frame * CH_W, 0, CH_W, CH_H, col * (CH_W + 1) * SC, y, CH_W * SC, CH_H * SC);
    BASE.forEach((f, i) => put(f, i, y0));
    (lk.poses ?? []).forEach((_, i) => put(F.COUNT + i, i, y0 + rowH));
    if (lk.icons) {
      const list = (['freeze', 'jump', 'dance'] as const).map((k) => lk.icons?.[k] ?? ['........']);
      g.drawImage(makeIconSheet(list), 0, 0, 24, 8, 0, y0 + rowH * 2, 24 * SC, 8 * SC);
    }
  });
  G.__png = c.toDataURL('image/png');
});
