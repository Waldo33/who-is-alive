import { PAL, PLAYER_COLORS } from '@kto/assets';
import type { ArenaDef } from '@kto/game-core';
import { canvas } from './pixels';
import {
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
import { isThemeLoaded, themeLook } from './themes';
import type { Look } from './themes';

/**
 * Те же процедурные спрайты, что в игре, но как обычные canvas — для рисования клипа
 * и карточки результата без Phaser. Строятся при первом обращении; облик темы — только когда
 * пакет темы загружен (themes/index.ts › loadTheme), до того — парк.
 */
export interface LocArt {
  arena: HTMLCanvasElement;
  props: Map<string, { c: HTMLCanvasElement; fw: number; fh: number; frames: number }>;
  hedge: HTMLCanvasElement;
}

export interface CharArt {
  /** Свои действия облика (для frameFor). */
  acts: Look['acts'];
  body: HTMLCanvasElement;
  /** Контуры: [0 — белый, 1..4 — цвета игроков]. */
  outline: HTMLCanvasElement[];
}

export interface Art {
  /** Локация темы раунда (земля, предметы, стенка зоны); look 1 — изнанка темы. */
  loc(theme: number, look?: number): LocArt;
  /** Костюм толпы темы; look 1 — изнанка темы. */
  chars(theme: number, look?: number): CharArt;
  shadow: HTMLCanvasElement;
  poof: HTMLCanvasElement;
  star: HTMLCanvasElement;
  stun: HTMLCanvasElement;
  mark: HTMLCanvasElement;
  vignette: HTMLCanvasElement;
  icons: { canvas: HTMLCanvasElement; names: string[] };
}

let cache: { arenaId: string; art: Art } | null = null;

export function getArt(arena: ArenaDef): Art {
  if (cache?.arenaId === arena.id) return cache.art;
  // пока пакет темы не загружен — рисуем парк (и не кешируем подмену под ключом темы)
  const key = (theme: number, look: number) => (isThemeLoaded(theme) ? `${theme}:${look}` : '0:0');
  const locs = new Map<string, LocArt>();
  const loc = (theme: number, look = 0): LocArt => {
    const k = key(theme, look);
    let l = locs.get(k);
    if (!l) {
      const lk = k === '0:0' ? themeLook(0, 0) : themeLook(theme, look);
      const props = new Map<string, { c: HTMLCanvasElement; fw: number; fh: number; frames: number }>();
      for (const p of arena.props) {
        if (props.has(p.kind)) continue;
        const [c, fw, fh, frames] = makeProp(p.kind, lk);
        props.set(p.kind, { c, fw, fh, frames });
      }
      l = { arena: makeArenaBackground(arena, lk), props, hedge: makeHedge(lk) };
      locs.set(k, l);
    }
    return l;
  };
  const sheets = new Map<string, CharArt>();
  const chars = (theme: number, look = 0): CharArt => {
    const k = key(theme, look);
    let a = sheets.get(k);
    if (!a) {
      const lk = k === '0:0' ? themeLook(0, 0) : themeLook(theme, look);
      const s = makeCharacterSheets(lk.chars, lk.poses);
      a = { acts: lk.acts, body: s.body, outline: [s.outline, ...PLAYER_COLORS.map((col) => tint(s.outline, col))] };
      sheets.set(k, a);
    }
    return a;
  };
  const art: Art = {
    loc,
    chars,
    shadow: makeShadow(),
    poof: makePoof(),
    star: makeStar(),
    stun: makeStunStars(),
    mark: makeMark('!'),
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
/**
 * Размер шрифта, при котором строка влезает в ширину maxW (в игровых пикселях) на холсте ×scale.
 * Уменьшаем ступенями по целому числу экранных пикселей на пиксель шрифта (6 → 5 → 4 → 3 при ×6),
 * чтобы буквы оставались чёткими, а не размытыми дробным масштабом.
 */
export function fitSize(s: string, maxW: number, scale: number, size = 1): number {
  for (let k = Math.round(scale * size); k >= Math.ceil(scale / 2); k--) {
    if (s.length * 8 * (k / scale) <= maxW) return k / scale;
  }
  return Math.ceil(scale / 2) / scale;
}

export function text(
  g: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  font: string,
  opts: { size?: number; align?: CanvasTextAlign; outline?: string | null; maxWidth?: number } = {},
): number {
  // Рисуем в экранных пикселях с целым кеглем: Safari отбрасывает дробный размер шрифта
  // (например 6.67px при масштабе ×6) и рисует прежним — строка вылезала за кадр.
  const m = g.getTransform();
  const sc = m.a || 1;
  let px = Math.max(1, Math.round(8 * (opts.size ?? 1) * sc));
  g.save();
  g.setTransform(1, 0, 0, 1, m.e, m.f);
  const setFont = () => (g.font = `${px}px ${font}`);
  setFont();
  // страховка: если строка всё равно шире — уменьшаем по одному экранному пикселю на пиксель шрифта
  if (opts.maxWidth) {
    const limit = opts.maxWidth * sc;
    while (px > 8 && g.measureText(s).width > limit) {
      px = Math.max(8, px - 8);
      setFont();
    }
  }
  g.textAlign = opts.align ?? 'center';
  g.textBaseline = 'top';
  const X = Math.round(x * sc);
  const Y = Math.round(y * sc);
  const step = px / 8; // один пиксель шрифта в экранных пикселях
  const outline = opts.outline === undefined ? PAL.ink : opts.outline;
  if (outline) {
    g.fillStyle = outline;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      g.fillText(s, X + dx * step, Y + dy * step);
    }
  }
  g.fillStyle = color;
  g.fillText(s, X, Y);
  const w = g.measureText(s).width / sc;
  g.restore();
  return w;
}
