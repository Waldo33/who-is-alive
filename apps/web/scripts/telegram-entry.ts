/**
 * Пакет Telegram-визуалов из тех же процедурных спрайтов, что в игре (запускается в браузере, см. make-telegram.mjs).
 * Иконка экрана загрузки Mini App: силуэт героя и «?» над ним — маска непрозрачных пикселей.
 */
import { PAL } from '@kto/assets';
import { CH_H, CH_W, F, PARK_CHARS, makeCharacterSheets, makeMark } from '../src/game/sprites';

type Mask = { w: number; h: number; on: boolean[] };

/** Маска кадра: непрозрачные пиксели; тёмные пиксели внутри фигуры (глаза, рот) — дыры, чтобы читалось лицо. */
function maskOf(src: CanvasImageSource, sx: number, sy: number, w: number, h: number, holes: boolean, noInk = false): Mask {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.drawImage(src, sx, sy, w, h, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const ink = [1, 3, 5].map((i) => parseInt(PAL.ink.slice(i, i + 2), 16));
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 128;
  const on: boolean[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = opaque(x, y);
      const isInk = d[i] === ink[0] && d[i + 1] === ink[1] && d[i + 2] === ink[2];
      // у «?» контур ink — только обводка: знак — сама заливка
      if (noInk && isInk) v = false;
      if (v && holes) {
        const inner = opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1);
        if (isInk && inner) v = false;
      }
      on.push(v);
    }
  }
  return { w, h, on };
}

/** Один <path>: горизонтальные отрезки пикселей прямоугольниками (не пересекаются — правило заливки не важно). */
function loadingIcon(): string {
  const sheets = makeCharacterSheets(PARK_CHARS);
  const body = maskOf(sheets.body, F.D * CH_W, 0, CH_W, CH_H, true);
  const qc = makeMark('?');
  const q = maskOf(qc, 0, 0, qc.width, qc.height, false, true);
  // обрезать пустые поля «?»
  const rows = (m: Mask) => [...Array(m.h).keys()].filter((y) => m.on.slice(y * m.w, y * m.w + m.w).some(Boolean));
  const cols = (m: Mask) => [...Array(m.w).keys()].filter((x) => [...Array(m.h).keys()].some((y) => m.on[y * m.w + x]));
  const qr = rows(q);
  const qcols = cols(q);
  const br = rows(body);
  const bcols = cols(body);
  const qW = qcols[qcols.length - 1] - qcols[0] + 1;
  const qH = qr[qr.length - 1] - qr[0] + 1;
  const bW = bcols[bcols.length - 1] - bcols[0] + 1;
  const bH = br[br.length - 1] - br[0] + 1;
  const gap = 2;
  const W = Math.max(qW, bW);
  const H = qH + gap + bH;
  const S = Math.floor((512 * 0.82) / Math.max(W, H));
  const ox = Math.round((512 - W * S) / 2);
  const oy = Math.round((512 - H * S) / 2);
  const runs: string[] = [];
  const put = (m: Mask, x0: number, y0: number, dx: number, dy: number, rs: number[], cs: number[]) => {
    for (const y of rs) {
      let x = cs[0];
      while (x <= cs[cs.length - 1]) {
        if (!m.on[y * m.w + x]) {
          x++;
          continue;
        }
        let e = x;
        while (e + 1 <= cs[cs.length - 1] && m.on[y * m.w + e + 1]) e++;
        const px = ox + (dx + x - x0) * S;
        const py = oy + (dy + y - rs[0]) * S;
        runs.push(`M${px} ${py}h${(e - x + 1) * S}v${S}h-${(e - x + 1) * S}z`);
        x = e + 1;
      }
    }
  };
  put(q, qcols[0], qr[0], Math.floor((W - qW) / 2), 0, qr, qcols);
  put(body, bcols[0], br[0], Math.floor((W - bW) / 2), qH + gap, br, bcols);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><path d="${runs.join('')}"/></svg>\n`;
}

(globalThis as unknown as { __tg: Record<string, string> }).__tg = { 'loading-icon.svg': loadingIcon() };
