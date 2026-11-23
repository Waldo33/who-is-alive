'use client';

import { useEffect, useRef } from 'react';
import { PAL, PLAYER_COLORS } from '@kto/assets';
import { CH_H, CH_W, F, OL_H, OL_W, PARK_CHARS, makeCharacterSheets } from '@/game/sprites';
import type { CharSheets } from '@/game/sprites';

/**
 * Человечек из игры в лобби: спрайт парка ×3 с обводкой цвета игрока. Готовый — машет рукой (кадр жеста),
 * пустое место — силуэт цвета dusk. Рисуется на canvas целыми пикселями, без сглаживания.
 */
let sheets: CharSheets | null = null;
const SCALE = 3;
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

export function Actor({ color, waving = false, empty = false }: { color?: number; waving?: boolean; empty?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
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
  }, [color, waving, empty]);
  return <canvas ref={ref} className="actor" width={OL_W * SCALE} height={OL_H * SCALE} aria-hidden="true" />;
}
