import type { SkinId } from '@kto/game-core';
import { frameSpec } from '../sprites';
import { KB_H, KB_W, kotBananFrame } from './kot-banan';
import { EX_H, EX_W, extinguisherFrame } from './extinguisher';

/**
 * Фигурки скинов гардероба: кадр скина для кадра человечка `F.*`. У всех скинов кадр одного размера (18×30,
 * ноги на 28-й строке, середина — 9-й столбец), поэтому раскладка поля, повтора, клипа и витрины — общая.
 */
export const SKIN_W = KB_W;
export const SKIN_H = KB_H;
if (EX_W !== SKIN_W || EX_H !== SKIN_H) throw new Error('skin frame size');

export function skinFigure(id: SkinId, frame: number): HTMLCanvasElement {
  if (id === 'extinguisher') return extinguisherFrame(frame);
  const { view, shift } = frameSpec(frame);
  return kotBananFrame(frame, view, shift);
}
