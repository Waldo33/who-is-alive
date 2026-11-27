'use client';

import { useEffect, useRef } from 'react';
import { PAL, PLAYER_COLORS } from '@kto/assets';
import { CH_H, CH_W, F, OL_H, OL_W, PARK_CHARS, makeCharacterSheets } from '@/game/sprites';
import type { CharSheets } from '@/game/sprites';
import { skinArt, skinFrame } from '@/game/skins/skin-art';

/**
 * Человечек из игры в лобби: спрайт парка (×3, на низком экране ×2) с обводкой цвета игрока. Готовый — машет рукой (кадр жеста),
 * пустое место — силуэт цвета dusk. Рисуется на canvas целыми пикселями, без сглаживания.
 */
let sheets: CharSheets | null = null;
// холст — 1:1 со спрайтом; размер на экране задаёт CSS целым множителем (×3, на низком экране ×2)
const SCALE = 1;
const WAVE = [F.WAVE, F.WAVE + 1, F.WAVE + 2, F.WAVE + 1];

function tinted(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d')!;
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

const outlines = new Map<string, HTMLCanvasElement>();
const silhouette = new Map<string, HTMLCanvasElement>();

/**
 * skin — скин из гардероба (в лобби его видят все): тот же масштаб, что у соседей, банан выше человечка —
 * холст выше и шире, лишнее уходит вверх и в стороны отрицательными полями (карточка не растёт).
 */
export function Actor({ color, waving = false, empty = false, skin }: { color?: number; waving?: boolean; empty?: boolean; skin?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sk = empty ? null : skinArt(skin);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (sk) {
      const g = cv.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      const ol = color === undefined ? null : sk.outlines[1 + color];
      let i = 0;
      const draw = () => {
        // руки скрыты бананом: «машет» — покачивается в танце
        const f = skinFrame(waving ? F.DANCE + (i++ % 4) : F.D);
        g.clearRect(0, 0, cv.width, cv.height);
        if (ol) g.drawImage(ol, f * sk.ow, 0, sk.ow, sk.oh, 0, 0, sk.ow, sk.oh);
        g.drawImage(sk.body, f * sk.fw, 0, sk.fw, sk.fh, 1, 1, sk.fw, sk.fh);
      };
      draw();
      const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!waving || reduce) return;
      const id = setInterval(draw, 180);
      return () => clearInterval(id);
    }
    sheets ??= makeCharacterSheets(PARK_CHARS);
    const s = sheets;
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const col = color === undefined ? null : PLAYER_COLORS[color];
    let ol: HTMLCanvasElement | null = null;
    if (col && !empty) {
      ol = outlines.get(col) ?? tinted(s.outline, col);
      outlines.set(col, ol);
    }
    let body = s.body;
    if (empty) {
      body = silhouette.get('dusk') ?? tinted(s.body, PAL.dusk);
      silhouette.set('dusk', body);
    }
    let i = 0;
    const draw = () => {
      const f = waving && !empty ? WAVE[i++ % WAVE.length] : F.D;
      g.clearRect(0, 0, cv.width, cv.height);
      if (ol) g.drawImage(ol, f * OL_W, 0, OL_W, OL_H, 0, 0, OL_W * SCALE, OL_H * SCALE);
      g.drawImage(body, f * CH_W, 0, CH_W, CH_H, SCALE, SCALE, CH_W * SCALE, CH_H * SCALE);
    };
    draw();
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!waving || empty || reduce) return;
    const id = setInterval(draw, 180);
    return () => clearInterval(id);
  }, [color, waving, empty, sk]);
  if (sk) return <canvas ref={ref} className="actor skin" width={sk.ow} height={sk.oh} aria-hidden="true" />;
  return <canvas ref={ref} className="actor" width={OL_W * SCALE} height={OL_H * SCALE} aria-hidden="true" />;
}
