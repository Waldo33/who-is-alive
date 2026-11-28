import { PAL } from '@kto/assets';
import { MY_COLORS, MY_FIGS, THEME_RULES } from '@kto/game-core';
import type { ActKind, MyFig, MyPose, MySticker } from '@kto/game-core';
import { F, PARK_CHARS, makeCharacterSheets } from '../sprites';
import type { CharSheets } from '../sprites';
import type { Ctx } from '../pixels';
import { themeLook } from '../themes';
import type { Pose } from '../themes/types';
import { kotBananFrame } from './kot-banan';
import { extinguisherFrame } from './extinguisher';
import { iceFrost, withFx } from './shine';
import { R, ST_SIZE, actorFrame, orbit, put, say, star } from './stickers';
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
  return { frame: F.FREEZE, dx: 0, dy: 0 };
}

/**
 * Движения тем, которые есть у героя площадки (свои кадры темы, если она их задала). «Прыжка» здесь нет:
 * в темах это эмоция площадки (кофе, факел, скакалка), а стикер «Прыжок» должен прыгать — см. `jumpOf`.
 */
const THEME_ACT: Partial<Record<MyPose, ActKind>> = { wave: 'wave', dance: 'dance', freeze: 'freeze' };

// ───────────── «Прыжок» ─────────────

/** Ноги (строки 14–15 кадра 12×16) врозь: левая половина влево, правая вправо на n пикселей. */
function spread(row: string[], n: number): string[] {
  const l = row.slice(0, 6);
  const r = row.slice(6);
  return [...l.slice(n), ...Array<string>(n).fill('.'), ...Array<string>(n).fill('.'), ...r.slice(0, r.length - n)];
}
/** Свои кадры прыжка поверх костюма (после правок темы — юбки, сапоги, хвосты едут вместе с ногами). */
const JUMP_POSES: Pose[] = [
  // присед: ноги короче на строку, всё тело ниже на пиксель
  {
    view: 'D',
    patch: (m) => {
      m.splice(14, 1);
      m.unshift(Array<string>(m[0].length).fill('.'));
    },
  },
  // в воздухе: руки вверх, ноги «звёздочкой» врозь
  {
    view: 'D',
    arms: 'up',
    face: 'happy',
    patch: (m) => {
      m[14] = spread(m[14], 1);
      m[15] = spread(m[15], 2);
    },
  },
];
const jumpSheets = new Map<number, { sheets: CharSheets; at: number }>();
/** Лента костюма с кадрами прыжка: `at` — номер кадра приседа (за ним — полёт). Парк — тема -1. */
function jumpOf(theme: number): { sheets: CharSheets; at: number } {
  let j = jumpSheets.get(theme);
  if (!j) {
    const look = theme < 0 ? null : themeLook(theme, 0);
    const own = look?.poses ?? [];
    j = { sheets: makeCharacterSheets(look?.chars ?? PARK_CHARS, [...own, ...JUMP_POSES]), at: F.COUNT + own.length };
    jumpSheets.set(theme, j);
  }
  return j;
}

/** Фаза прыжка на шаге t (цикл 1 с, два прыжка за стикер): кадр и высота 0…1. */
type JumpPhase = 'stand' | 'crouch' | 'up' | 'air' | 'land';
const JUMP: readonly { ph: JumpPhase; h: number }[] = [
  { ph: 'stand', h: 0 },
  { ph: 'crouch', h: 0 },
  { ph: 'up', h: 0.45 },
  { ph: 'air', h: 0.85 },
  { ph: 'air', h: 1 },
  { ph: 'air', h: 1 },
  { ph: 'air', h: 0.8 },
  { ph: 'up', h: 0.4 },
  { ph: 'land', h: 0 },
  { ph: 'stand', h: 0 },
];
const jumpAt = (t: number) => JUMP[t % JUMP.length];

function jumpFigure(fig: MyFig, t: number): { fr: HTMLCanvasElement; k: number } {
  const { ph } = jumpAt(t);
  if (fig === 'kotBanan') {
    // у банана своих ног нет: присед — пригнулся, в воздухе — руки вверх
    if (ph === 'crouch' || ph === 'land') return { fr: kotBananFrame(F.D, 'D', 0, 2), k: 2 };
    return { fr: kotBananFrame(ph === 'stand' ? F.D : F.DANCE + 3, 'D'), k: 2 };
  }
  if (fig === 'extinguisher') return { fr: extinguisherFrame(ph === 'stand' || ph === 'crouch' || ph === 'land' ? F.D : F.DANCE + 3), k: 2 };
  const def = MY_FIGS.find((f) => f.id === fig);
  const theme = def && 'theme' in def ? THEME_RULES.findIndex((r) => r.id === def.theme) : -1;
  const j = jumpOf(theme);
  const frame = ph === 'stand' ? F.D : ph === 'crouch' || ph === 'land' ? j.at : ph === 'up' ? F.DANCE + 3 : j.at + 1;
  return { fr: actorFrame(frame, j.sheets), k: 3 };
}

/** Фигурка в позе: холст кадра, масштаб, сдвиг и разворот. */
function figure(fig: MyFig, pose: MyPose, t: number): { fr: HTMLCanvasElement; k: number; dx: number; dy: number; flip: boolean } {
  if (pose === 'jump') return { ...jumpFigure(fig, t), dx: 0, dy: 0, flip: false };
  const p = poseFrame(pose, t);
  if (fig === 'actor') return { fr: actorFrame(p.frame), k: 3, dx: p.dx * 3, dy: p.dy * 3, flip: false };
  if (fig === 'kotBanan') return { fr: kotBananFrame(p.frame, 'D'), k: 2, dx: p.dx * 2, dy: p.dy * 2, flip: false };
  if (fig === 'extinguisher') return { fr: extinguisherFrame(p.frame), k: 2, dx: p.dx * 2, dy: p.dy * 2, flip: false };
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
  const h = fr.height * k;
  const x = Math.round(MID - w / 2 + dx);
  // «Прыжок»: земля — чуть ниже обычного, насколько пускает подпись снизу; потолок — край или строка сверху
  const y0 = lines.length === 2 ? 76 : 84;
  const ground = s.pose === 'jump' ? Math.max(top, Math.min(top + 9, (lines.length ? y0 - 7 : ST_SIZE - 3) - h)) : top;
  const lift = s.pose === 'jump' ? Math.round(jumpAt(t).h * Math.min(18, ground - (head ? 12 : 0))) : 0;
  const y = ground + dy - lift;
  if (flip) {
    g.save();
    g.translate(MID * 2, 0);
    g.scale(-1, 1);
    put(g, fr, x, y, k);
    g.restore();
  } else put(g, fr, x, y, k);
  // «Замри» — только искорки вокруг; лёд по силуэту — платный эффект «Лёд», в позе его нет
  if (s.pose === 'jump') jumpDust(g, jumpAt(t).ph, x, w, ground + h, y + h);
  if (s.pose === 'freeze') iceFrost(g, t, { x, y, w, h: fr.height * k, k }, col);
  // украшение позы цветом подписи
  if (s.pose === 'stun') orbit(g, MID, top + 2, t);
  // «!» и «?» над головой; под верхней строкой — чуть ниже, чтобы не налезали на неё
  const mark = head ? top + 2 : top - 4;
  if (s.pose === 'startle' && Math.floor(t / 5) % 2 === 0) say(g, '!', 82, mark, col, 2);
  if (s.pose === 'ask' && Math.floor(t / 5) % 2 === 0) say(g, '?', 82, mark, col, 2);
  if (s.pose === 'dance') for (const [sx, sy, ph] of [[12, top + 8, 0], [84, top + 4, 1], [10, top + 44, 1], [86, top + 40, 0]]) if ((Math.floor(t / 3) + ph) % 2) star(g, sx, sy, col);
  if (s.pose === 'wave' && t % 10 < 5) {
    // «привет» — штрихи у поднятой руки
    g.fillStyle = col;
    for (const [sx, sy] of [[x + w + 2, top + 6], [x + w + 4, top + 12], [x + w + 2, top + 18]]) g.fillRect(sx, sy, 3, 1);
  }
  lines.forEach((ln, i) => say(g, ln, MID, y0 + i * 10, col));
  if (head) say(g, head, MID, 2, col);
}

/**
 * Едва заметные частицы прыжка (владелец: «не яркие, а слегка заметные»): приглушённый серо-синий, а не цвет
 * подписи; пылинки у ног при толчке и приземлении, два коротких штриха под ногами в полёте. Без тени.
 */
function jumpDust(g: Ctx, ph: JumpPhase, x: number, w: number, floor: number, feet: number): void {
  const c = PAL.steel;
  if (ph === 'crouch' || ph === 'land') {
    for (const [ox, oy] of [[-3, -2], [-6, -4], [2, -2], [5, -4]]) R(g, (ox < 0 ? x : x + w) + ox, floor + oy, 2, 2, c);
  } else if (ph === 'air' && floor - feet > 8) {
    const cx = x + Math.round(w / 2);
    for (const ox of [-5, 4]) R(g, cx + ox, feet + 3, 1, 4, c);
  }
}

/** Как стикер пака (для stickerFrame / stickerFile в stickers.ts). */
export const myDef = (s: MyLook): Pick<StickerDef, 'draw'> => withFx({ draw: (g: Ctx, t: number) => drawMy(g, s, t) }, s.fx);
