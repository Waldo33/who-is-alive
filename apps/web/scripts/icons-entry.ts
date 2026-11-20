/**
 * Иконки приложения из тех же процедурных спрайтов, что в игре (запускается в браузере, см. make-icons.mjs).
 * Сюжет: толпа одинаковых человечков, один — живой (жёлтый контур) и над ним «?».
 */
import { PAL } from '@kto/assets';
import { tint } from '../src/game/art';
import { canvas } from '../src/game/pixels';
import { CH_H, CH_W, F, OL_H, OL_W, THEMES, makeCharacterSheets, makeMark } from '../src/game/sprites';

const sheets = makeCharacterSheets(THEMES[0]);
const glow = tint(sheets.outline, PAL.yellow);
/** «?» из игры, но с жёлтой заливкой вместо серой. */
const qMark = (() => {
  const c = makeMark('?');
  const g = c.getContext('2d')!;
  const d = g.getImageData(0, 0, c.width, c.height);
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [mr, mg, mb] = hex(PAL.mist);
  const [yr, yg, yb] = hex(PAL.yellow);
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i] === mr && d.data[i + 1] === mg && d.data[i + 2] === mb) [d.data[i], d.data[i + 1], d.data[i + 2]] = [yr, yg, yb];
  }
  g.putImageData(d, 0, 0);
  return c;
})();

function char(g: CanvasRenderingContext2D, x: number, y: number, s: number, frame: number, outline: boolean): void {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  if (outline) g.drawImage(glow, frame * OL_W, 0, OL_W, OL_H, -7, -17, OL_W, OL_H);
  g.drawImage(sheets.body, frame * CH_W, 0, CH_W, CH_H, -6, -CH_H, CH_W, CH_H);
  g.restore();
}

/** Основная иконка: логические 64×64, рисуется ×k. maskable — с запасом под круглую маску. */
function bigIcon(px: number, maskable: boolean): string {
  const L = 64;
  const k = px / L;
  const out = document.createElement('canvas');
  out.width = px;
  out.height = px;
  const o = out.getContext('2d')!;
  o.imageSmoothingEnabled = false;
  const { c, g } = canvas(L, L);
  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, L, L);
  g.fillStyle = PAL.plum;
  for (let y = 3; y < L; y += 4) g.fillRect(0, y, L, 1);
  // площадь: тень-эллипс под ногами
  g.fillStyle = PAL.night;
  for (let x = -26; x <= 26; x++) {
    const h = Math.round(Math.sqrt(1 - (x / 27) ** 2) * 5);
    g.fillRect(32 + x, 52 - h, 1, h * 2);
  }
  // боты по бокам — приглушены
  for (const [x, f] of [[13, F.D], [51, F.S]] as const) {
    const one = canvas(CH_W, CH_H);
    one.g.drawImage(sheets.body, f * CH_W, 0, CH_W, CH_H, 0, 0, CH_W, CH_H);
    one.g.globalCompositeOperation = 'source-atop';
    one.g.fillStyle = PAL.ink;
    one.g.globalAlpha = 0.45;
    one.g.fillRect(0, 0, CH_W, CH_H);
    g.drawImage(one.c, x - 6, 50 - CH_H);
  }
  // живой — вдвое крупнее, с жёлтым контуром
  char(g, 32, 54, 2, F.D, true);
  // «?» над головой
  g.save();
  g.translate(32 - 5, 2);
  g.scale(2, 2);
  g.drawImage(qMark, 0, 0);
  g.restore();
  if (maskable) {
    // маска бывает кругом: рисунок ×6 по центру (≈75%), поля — тем же фоном
    o.fillStyle = PAL.ink;
    o.fillRect(0, 0, px, px);
    const kk = Math.floor((px * 0.75) / L);
    const off = Math.round((px - L * kk) / 2);
    // полосы полей продолжают полосы рисунка (каждые 4 логических пикселя, толщина 1)
    o.fillStyle = PAL.plum;
    for (let y = off + 3 * kk - 4 * kk * Math.ceil(off / (4 * kk)); y < px; y += 4 * kk) o.fillRect(0, y, px, kk);
    o.drawImage(c, 0, 0, L, L, off, off, L * kk, L * kk);
  } else o.drawImage(c, 0, 0, L, L, 0, 0, L * k, L * k);
  return out.toDataURL('image/png');
}

/** Фавикон 32×32 и 16×16 — отдельный рисунок, чтобы пиксели не мылились при уменьшении. */
function favicon(px: 16 | 32): string {
  const { c, g } = canvas(px, px);
  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, px, px);
  if (px === 32) {
    g.fillStyle = PAL.night;
    g.fillRect(4, 28, 24, 3);
    char(g, 16, 30, 1, F.D, true);
    g.drawImage(qMark, 24, 1);
  } else {
    // 16: голова и плечи живого в жёлтом контуре
    g.drawImage(glow, F.D * OL_W, 0, OL_W, 15, 1, 1, OL_W, 15);
    g.drawImage(sheets.body, F.D * CH_W, 0, CH_W, 14, 2, 2, CH_W, 14);
  }
  return c.toDataURL('image/png');
}

(window as unknown as { __icons: Record<string, string> }).__icons = {
  'icon-192.png': bigIcon(192, false),
  'icon-512.png': bigIcon(512, false),
  'icon-maskable-512.png': bigIcon(512, true),
  'apple-touch-icon.png': bigIcon(192, false),
  'favicon-32.png': favicon(32),
  'favicon-16.png': favicon(16),
};
