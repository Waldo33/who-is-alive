import * as Phaser from 'phaser';
import { PAL } from '@kto/assets';
import { canvas } from './pixels';

/**
 * Битмап-шрифт для canvas (раздел 9): глифы пиксельного веб-шрифта с кириллицей
 * растеризуются один раз в сетку 10×10 с тёмным контуром, без сглаживания.
 */
export const FONT_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя«»—–…×№·’“”';

export const FONT_COLORS = {
  white: PAL.white,
  sand: PAL.sand,
  yellow: PAL.yellow,
  red: PAL.red,
  blue: PAL.cyan,
  green: PAL.green,
  mist: PAL.mist,
  coral: PAL.coral,
  amber: PAL.amber,
} as const;
export type FontColor = keyof typeof FONT_COLORS;

const CELL = 10;
const PER_ROW = 32;

export function registerFonts(scene: Phaser.Scene, family: string): void {
  if (scene.cache.bitmapFont.exists('px-white')) return;
  const rows = Math.ceil(FONT_CHARS.length / PER_ROW);
  const mask = canvas(PER_ROW * 8, rows * 8);
  mask.g.font = `8px ${family}`;
  mask.g.textBaseline = 'top';
  mask.g.fillStyle = '#fff';
  [...FONT_CHARS].forEach((ch, i) => {
    mask.g.fillText(ch, (i % PER_ROW) * 8, Math.floor(i / PER_ROW) * 8);
  });
  const data = mask.g.getImageData(0, 0, mask.c.width, mask.c.height).data;
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < mask.c.width && y < mask.c.height && data[(y * mask.c.width + x) * 4 + 3] > 110;

  for (const [name, color] of Object.entries(FONT_COLORS)) {
    const { c, g } = canvas(PER_ROW * CELL, rows * CELL);
    [...FONT_CHARS].forEach((_, i) => {
      const sx = (i % PER_ROW) * 8;
      const sy = Math.floor(i / PER_ROW) * 8;
      const dx = (i % PER_ROW) * CELL + 1;
      const dy = Math.floor(i / PER_ROW) * CELL + 1;
      for (let y = -1; y <= 8; y++) {
        for (let x = -1; x <= 8; x++) {
          const inside = x >= 0 && y >= 0 && x < 8 && y < 8 && on(sx + x, sy + y);
          if (inside) {
            g.fillStyle = color;
            g.fillRect(dx + x, dy + y, 1, 1);
          } else if (
            (x >= -1 && y >= -1) &&
            [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([ox, oy]) => {
              const nx = x + ox;
              const ny = y + oy;
              return nx >= 0 && ny >= 0 && nx < 8 && ny < 8 && on(sx + nx, sy + ny);
            })
          ) {
            g.fillStyle = PAL.ink;
            g.fillRect(dx + x, dy + y, 1, 1);
          }
        }
      }
    });
    const key = `px-${name}`;
    scene.textures.addCanvas(key, c);
    const fontData = Phaser.GameObjects.RetroFont.Parse(scene, {
      image: key,
      width: CELL,
      height: CELL,
      chars: FONT_CHARS,
      charsPerRow: PER_ROW,
      'spacing.x': 0,
      'spacing.y': 0,
      'offset.x': 0,
      'offset.y': 0,
      lineSpacing: 0,
    } as unknown as Phaser.Types.GameObjects.BitmapText.RetroFontConfig);
    scene.cache.bitmapFont.add(key, fontData);
  }
}
