import { PAL, PLAYER_COLORS } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas } from './pixels';
import {
  THEMES,
  makeArenaBackground,
  makeCharacterSheets,
  makeHedge,
  makeIcons,
  makeMark,
  makePoof,
  makeProp,
  makeShadow,
  makeStar,
  makeStunStars,
  makeVignette,
} from './sprites';

/**
 * Те же процедурные спрайты, что в игре, но как обычные canvas — для рисования клипа
 * и карточки результата без Phaser. Строятся один раз при первом обращении.
 */
export interface Art {
  arena: HTMLCanvasElement;
  props: Map<string, { c: HTMLCanvasElement; fw: number; fh: number; frames: number }>;
  body: HTMLCanvasElement[];
  /** Контуры по темам: [тема][0 — белый, 1..4 — цвета игроков]. */
  outline: HTMLCanvasElement[][];
  shadow: HTMLCanvasElement;
  poof: HTMLCanvasElement;
  star: HTMLCanvasElement;
  stun: HTMLCanvasElement;
  mark: HTMLCanvasElement;
  hedge: HTMLCanvasElement;
  vignette: HTMLCanvasElement;
  icons: { canvas: HTMLCanvasElement; names: string[] };
}

let cache: { arenaId: string; art: Art } | null = null;

export function getArt(arena: ArenaDef): Art {
  if (cache?.arenaId === arena.id) return cache.art;
  const props = new Map<string, { c: HTMLCanvasElement; fw: number; fh: number; frames: number }>();
  for (const p of arena.props) {
    if (props.has(p.kind)) continue;
    const [c, fw, fh, frames] = makeProp(p.kind);
    props.set(p.kind, { c, fw, fh, frames });
  }
  const sheets = THEMES.map((th) => makeCharacterSheets(th));
  const art: Art = {
    arena: makeArenaBackground(arena),
    props,
    body: sheets.map((s) => s.body),
    outline: sheets.map((s) => [s.outline, ...PLAYER_COLORS.map((col) => tint(s.outline, col))]),
    shadow: makeShadow(),
    poof: makePoof(),
    star: makeStar(),
    stun: makeStunStars(),
    mark: makeMark('!'),
    hedge: makeHedge(),
    vignette: makeVignette(arena.width, arena.height),
    icons: makeIcons(),
  };
  cache = { arenaId: arena.id, art };
  return art;
}

/** Перекрасить непрозрачные пиксели в один цвет. */
export function tint(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const { c, g } = canvas(src.width, src.height);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, src.width, src.height);
  return c;
}

/** Холст с целочисленным масштабом: рисуем в «игровых» пикселях, получаем чёткие квадраты. */
export function scaledCanvas(w: number, h: number, scale: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  return { c, g };
}

/** Кадр из ленты (кадры по горизонтали). */
export function frame(
  g: CanvasRenderingContext2D,
  sheet: HTMLCanvasElement,
  fw: number,
  fh: number,
  i: number,
  x: number,
  y: number,
  flip = false,
): void {
  if (!flip) {
    g.drawImage(sheet, i * fw, 0, fw, fh, Math.round(x), Math.round(y), fw, fh);
    return;
  }
  g.save();
  g.translate(Math.round(x) + fw, Math.round(y));
  g.scale(-1, 1);
  g.drawImage(sheet, i * fw, 0, fw, fh, 0, 0, fw, fh);
  g.restore();
}

/**
 * Пиксельный текст с контуром. Размер шрифта — 8 «игровых» пикселей × size.
 * align: 'left' | 'center' | 'right' относительно x.
 */
export function text(
  g: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  font: string,
  opts: { size?: number; align?: CanvasTextAlign; outline?: string | null } = {},
): number {
  const size = opts.size ?? 1;
  g.font = `${8 * size}px ${font}`;
  g.textAlign = opts.align ?? 'center';
  g.textBaseline = 'top';
  const outline = opts.outline === undefined ? PAL.ink : opts.outline;
  if (outline) {
    g.fillStyle = outline;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      g.fillText(s, x + dx * size, y + dy * size);
    }
  }
  g.fillStyle = color;
  g.fillText(s, x, y);
  return g.measureText(s).width;
}
