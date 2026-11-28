import { PAL } from '@kto/assets';
import { MY_COLORS, MY_FIGS, THEME_RULES } from '@kto/game-core';
import type { ActKind, MyFig, MyPose, MySticker } from '@kto/game-core';
import { F } from '../sprites';
import type { Ctx } from '../pixels';
import { kotBananFrame } from './kot-banan';
import { iceFrost, withFx } from './shine';
import { ST_SIZE, actorFrame, orbit, put, say, star } from './stickers';
import type { StickerDef } from './stickers';
import { sheetsOf, themeActor } from './stickers-play';

/**
 * Свой стикер игрока («Собери свой стикерпак»): фигурка в позе, искры цвета подписи и подпись игровым
 * шрифтом. Тот же холст 96×96 и 20 кадров, что у стикеров пака: превью на телефоне рисует этот код, файл для
 * Telegram — он же на игровом сервере (apps/server/src/sticker-render.ts). Костюмы тем — из пакетов тем
 * (`loadAllThemes` до рисования).
 */

export type MyLook = Pick<MySticker, 'fig' | 'pose' | 'color' | 'text' | 'top' | 'fx'>;

const MID = ST_SIZE / 2;
/** Кадры человечка по позе на шаге t (100 мс). */
function poseFrame(pose: MyPose, t: number): { frame: number; dx: number; dy: number } {
  const i = Math.floor(t / 2) % 4;
  if (pose === 'wave') return { frame: [F.WAVE, F.WAVE + 1, F.WAVE + 2, F.WAVE + 1][i], dx: 0, dy: 0 };
  if (pose === 'dance') return { frame: F.DANCE + i, dx: [-1, 0, 1, 0][i], dy: -(i % 2) };
  if (pose === 'stun') return { frame: F.STUN, dx: 0, dy: 0 };
  // «Вопрос» — тот же испуг, только над головой «?»
  if (pose === 'startle' || pose === 'ask') return { frame: Math.floor(t / 4) % 2 ? F.STARTLE + 1 : F.STARTLE, dx: 0, dy: 0 };
  if (pose === 'jump') return t % 10 < 5 ? { frame: F.JUMP, dx: 0, dy: -2 } : { frame: F.D, dx: 0, dy: 0 };
  return { frame: F.FREEZE, dx: 0, dy: 0 };
}

/** Движения тем, которые есть у героя площадки (свои кадры темы, если она их задала). */
const THEME_ACT: Partial<Record<MyPose, ActKind>> = { wave: 'wave', dance: 'dance', jump: 'jump', freeze: 'freeze' };

/** Фигурка в позе: холст кадра, масштаб, сдвиг и разворот. */
function figure(fig: MyFig, pose: MyPose, t: number): { fr: HTMLCanvasElement; k: number; dx: number; dy: number; flip: boolean } {
  const p = poseFrame(pose, t);
  if (fig === 'actor') return { fr: actorFrame(p.frame), k: 3, dx: p.dx * 3, dy: p.dy * 3, flip: false };
  if (fig === 'kotBanan') return { fr: kotBananFrame(p.frame, 'D'), k: 2, dx: p.dx * 2, dy: p.dy * 2, flip: false };
  const def = MY_FIGS.find((f) => f.id === fig);
  const theme = def && 'theme' in def ? THEME_RULES.findIndex((r) => r.id === def.theme) : -1;
  if (theme < 0) return { fr: actorFrame(p.frame), k: 3, dx: 0, dy: 0, flip: false };
  const act = THEME_ACT[pose];
  if (act) {
    const a = themeActor(theme, act, t);
    return { fr: a.fr, k: 3, dx: 0, dy: a.dy * 3, flip: a.flip };
  }
  return { fr: actorFrame(p.frame, sheetsOf(theme)), k: 3, dx: 0, dy: 0, flip: false };
}

/** Нарисовать свой стикер (кадр t) на холсте 96×96. */
export function drawMy(g: Ctx, s: MyLook, t: number): void {
  const col = PAL[MY_COLORS[s.color] ?? 'white'];
  const lines = s.text.slice(0, 2);
  const head = s.top ?? '';
  // без подписи фигурка ниже и по центру; с двумя строками — выше; строка сверху сдвигает фигурку вниз
  const top = head ? (lines.length === 2 ? 14 : 16) : lines.length === 0 ? 20 : lines.length === 1 ? 12 : 6;
  const { fr, k, dx, dy, flip } = figure(s.fig, s.pose, t);
  const w = fr.width * k;
  const x = Math.round(MID - w / 2 + dx);
  const y = top + dy;
  if (flip) {
    g.save();
    g.translate(MID * 2, 0);
    g.scale(-1, 1);
    put(g, fr, x, y, k);
    g.restore();
  } else put(g, fr, x, y, k);
  // «Замри» — только искорки вокруг; лёд по силуэту — платный эффект «Лёд», в позе его нет
  if (s.pose === 'freeze') iceFrost(g, t, { x, y, w, h: fr.height * k, k }, col);
  // украшение позы цветом подписи
  if (s.pose === 'stun') orbit(g, MID, top + 2, t);
  // «!» и «?» над головой; под верхней строкой — чуть ниже, чтобы не налезали на неё
  const mark = head ? top + 2 : top - 4;
  if (s.pose === 'startle' && Math.floor(t / 5) % 2 === 0) say(g, '!', 82, mark, col, 2);
  if (s.pose === 'ask' && Math.floor(t / 5) % 2 === 0) say(g, '?', 82, mark, col, 2);
  if (s.pose === 'dance' || s.pose === 'jump') for (const [sx, sy, ph] of [[12, top + 8, 0], [84, top + 4, 1], [10, top + 44, 1], [86, top + 40, 0]]) if ((Math.floor(t / 3) + ph) % 2) star(g, sx, sy, col);
  if (s.pose === 'wave' && t % 10 < 5) {
    // «привет» — штрихи у поднятой руки
    g.fillStyle = col;
    for (const [sx, sy] of [[x + w + 2, top + 6], [x + w + 4, top + 12], [x + w + 2, top + 18]]) g.fillRect(sx, sy, 3, 1);
  }
  const y0 = lines.length === 2 ? 76 : 84;
  lines.forEach((ln, i) => say(g, ln, MID, y0 + i * 10, col));
  if (head) say(g, head, MID, 2, col);
}

/** Как стикер пака (для stickerFrame / stickerFile в stickers.ts). */
export const myDef = (s: MyLook): Pick<StickerDef, 'draw'> => withFx({ draw: (g: Ctx, t: number) => drawMy(g, s, t) }, s.fx);
