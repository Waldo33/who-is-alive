'use client';

import { useEffect, useRef } from 'react';
import { PAL, PLAYER_COLORS } from '@kto/assets';
import { CH_H, CH_W, F, OL_H, OL_W, PARK_CHARS, makeCharacterSheets } from '@/game/sprites';
import type { CharSheets } from '@/game/sprites';
import { skinArt, skinFrame } from '@/game/skins/skin-art';
import { AURA_BOTTOM, AURA_MS, AURA_STEPS, AURA_TOP, AURA_X, auraFrame, auraFx } from '@/game/skins/aura';

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
 * fx — эффект на персонаже (виден там же, где скин): холст шире ещё на поля эффекта (skins/aura.ts), анимация 10 кадров в секунду.
 */
export function Actor({ color, waving = false, empty = false, skin, fx: fxRaw }: { color?: number; waving?: boolean; empty?: boolean; skin?: string; fx?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sk = empty ? null : skinArt(skin);
  const fx = empty ? null : auraFx(fxRaw);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    // с эффектом всё сдвинуто на поля эффекта
    const ox = fx ? AURA_X : 0;
    const oy = fx ? AURA_TOP : 0;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let i = 0;
    let step = 0;
    let draw: () => void;
    if (sk) {
      const ol = color === undefined ? null : sk.outlines[1 + color];
      draw = () => {
        // руки скрыты бананом: «машет» — покачивается в танце (поза меняется через кадр эффекта: 200 мс)
        const f = skinFrame(waving ? F.DANCE + (Math.floor(i / (fx ? 2 : 1)) % 4) : F.D);
        g.clearRect(0, 0, cv.width, cv.height);
        if (ol) g.drawImage(ol, f * sk.ow, 0, sk.ow, sk.oh, ox, oy, sk.ow, sk.oh);
        if (fx) auraFrame(g, sk.body, sk.fw, sk.fh, f, ox + 1, oy + 1, false, fx, step);
        else g.drawImage(sk.body, f * sk.fw, 0, sk.fw, sk.fh, 1, 1, sk.fw, sk.fh);
      };
    } else {
      sheets ??= makeCharacterSheets(PARK_CHARS);
      const s = sheets;
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
      draw = () => {
        const f = waving && !empty ? WAVE[Math.floor(i / (fx ? 2 : 1)) % WAVE.length] : F.D;
        g.clearRect(0, 0, cv.width, cv.height);
        if (ol) g.drawImage(ol, f * OL_W, 0, OL_W, OL_H, ox, oy, OL_W * SCALE, OL_H * SCALE);
        if (fx) auraFrame(g, body, CH_W, CH_H, f, ox + SCALE, oy + SCALE, false, fx, step);
        else g.drawImage(body, f * CH_W, 0, CH_W, CH_H, SCALE, SCALE, CH_W * SCALE, CH_H * SCALE);
      };
    }
    draw();
    if (reduce || (!fx && (!waving || empty))) return;
    const id = setInterval(
      () => {
        i++;
        step = (step + 1) % AURA_STEPS;
        draw();
      },
      fx ? AURA_MS : 180,
    );
    return () => clearInterval(id);
  }, [color, waving, empty, sk, fx]);
  const pad = fx ? { w: 2 * AURA_X, h: AURA_TOP + AURA_BOTTOM } : { w: 0, h: 0 };
  const cls = `actor${sk ? ' skin' : ''}${fx ? ' fx' : ''}`;
  if (sk) return <canvas ref={ref} className={cls} width={sk.ow + pad.w} height={sk.oh + pad.h} aria-hidden="true" />;
  return <canvas ref={ref} className={cls} width={OL_W * SCALE + pad.w} height={OL_H * SCALE + pad.h} aria-hidden="true" />;
}
