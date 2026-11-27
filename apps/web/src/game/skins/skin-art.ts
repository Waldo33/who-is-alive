import { PAL, PLAYER_COLORS } from '@kto/assets';
import { isSkin } from '@kto/game-core';
import type { SkinId } from '@kto/game-core';
import { F, frameSpec } from '../sprites';
import { canvas, outlineOf } from '../pixels';
import type { Ctx } from '../pixels';
import { KB_H, KB_W, kotBananFrame } from './kot-banan';

/**
 * Скины гардероба в игре: лента кадров `F.*` (те же позы, что у человечка) в том же масштабе, что соседи —
 * на поле, в повторе, на триумфе, в лобби, клипе и фильме. Без DOM (холсты — pixels.ts): тот же код рисует
 * фильм на сервере.
 *
 * Кто видит (docs/architecture.md › 4.3): на поле скин рисует только телефон самого игрока на своём
 * персонаже; остальные видят его, когда связь «игрок ↔ сущность» и так открыта — повтор и финал
 * разоблачения, итоги, клип, фильм.
 */
export interface SkinArt {
  /** Лента тела: кадры fw×fh по порядку F.* (до F.COUNT). */
  body: HTMLCanvasElement;
  /** Белый контур, кадры ow×oh; `outlines[1 + цвет]` — цветом игрока. */
  outline: HTMLCanvasElement;
  outlines: HTMLCanvasElement[];
  fw: number;
  fh: number;
  ow: number;
  oh: number;
  /** Точка «ноги, середина» в кадре тела (у человечка — 6, 16) и в кадре контура (у человечка — 7, 17). */
  ax: number;
  ay: number;
  oax: number;
  oay: number;
}

/** Кадр скина для кадра человечка: свои позы тем (≥ F.COUNT) скин не знает — стоит прямо. */
export const skinFrame = (frame: number): number => (frame >= 0 && frame < F.COUNT ? frame : F.D);

const cache = new Map<SkinId, SkinArt>();

function tinted(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const { c, g } = canvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, src.width, src.height);
  return c;
}

function build(id: SkinId): SkinArt {
  void id; // пока один скин — Кот-банан
  const fw = KB_W;
  const fh = KB_H;
  const ow = fw + 2;
  const oh = fh + 2;
  const body = canvas(fw * F.COUNT, fh);
  const outline = canvas(ow * F.COUNT, oh);
  for (let i = 0; i < F.COUNT; i++) {
    const { view, shift } = frameSpec(i);
    const one = kotBananFrame(i, view, shift);
    body.g.drawImage(one, i * fw, 0);
    outlineOf(one.getContext('2d')! as Ctx, fw, fh, outline.g, i * ow, 0, PAL.white);
  }
  // кот стоит в кадре с отступом (3, 12) — ноги на 28-й строке, середина — 9-й столбец
  return {
    body: body.c,
    outline: outline.c,
    outlines: [outline.c, ...PLAYER_COLORS.map((col) => tinted(outline.c, col))],
    fw,
    fh,
    ow,
    oh,
    ax: 9,
    ay: 28,
    oax: 10,
    oay: 29,
  };
}

/** Арт скина (лениво, один раз на приложение); не скин — null. */
export function skinArt(id: unknown): SkinArt | null {
  if (!isSkin(id)) return null;
  let a = cache.get(id);
  if (!a) cache.set(id, (a = build(id)));
  return a;
}
