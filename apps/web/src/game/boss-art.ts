import { PAL } from '@kto/assets';
import { canvas, grid } from './pixels';

/**
 * Шеф «Клерков» (game-core › boss.ts) — свой спрайт, вдвое выше толпы и детальнее её: высокий и худой,
 * в чёрном костюме с широкими плечами, зачёсанные назад седые волосы, бледное лицо с тёмными впадинами
 * глаз, тонкие губы, красный галстук. Пока смотрит — глаза горят красным. Без DOM: кадры — строки букв
 * (буква → цвет из PAL в `makeBossSheet`), их можно проверить и вне браузера.
 *
 * Лента: по 7 кадров на вид — вниз (D), вверх (U), боком вправо (S; влево — зеркально):
 * 0 стоит, 1–4 шаг, 5 смотрит (подался вперёд, руки за спиной, глаза горят), 6 указывает пальцем (выговор).
 */
export const BOSS_W = 20;
export const BOSS_H = 34;
export const BOSS_PER_VIEW = 7;
export const BOSS_STAND = 0;
export const BOSS_WALK = 1;
export const BOSS_LOOK = 5;
export const BOSS_POINT = 6;

/**
 * o ink (контур), n night (пиджак), k dusk (лацканы, блик ткани), s steel (волосы), S slate (волосы светлее, тень лица),
 * m mist (лицо), w white (рубашка, блик глаза), r red (галстук), R wine (тень галстука), e ink (впадины глаз),
 * g magenta (горящий глаз), G red (ореол глаза), h mist (кисти)
 */
export type BossKey = 'o' | 'n' | 'k' | 's' | 'S' | 'm' | 'w' | 'r' | 'R' | 'e' | 'g' | 'G' | 'h';

type View = 'D' | 'U' | 'S';
type Grid = (BossKey | null)[][];

export function bossFrames(): string[][] {
  const out: string[][] = [];
  for (const v of ['D', 'U', 'S'] as View[]) for (let f = 0; f < BOSS_PER_VIEW; f++) out.push(frame(v, f));
  return out;
}

/** Номер кадра в ленте по виду (0 вниз, 1 вверх, 2/3 боком) и позе. */
export function bossFrame(dir: 0 | 1 | 2 | 3, pose: number): number {
  const v = dir === 0 ? 0 : dir === 1 ? 1 : 2;
  return v * BOSS_PER_VIEW + pose;
}

function frame(view: View, f: number): string[] {
  const g: Grid = Array.from({ length: BOSS_H }, () => Array<BossKey | null>(BOSS_W).fill(null));
  const put = (x: number, y: number, k: BossKey): void => {
    if (x >= 0 && y >= 0 && x < BOSS_W && y < BOSS_H) g[y][x] = k;
  };
  const rect = (x: number, y: number, w: number, h: number, k: BossKey): void => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, k);
  };
  const walk = f >= BOSS_WALK && f < BOSS_WALK + 4 ? f - BOSS_WALK : -1;
  const look = f === BOSS_LOOK;
  const point = f === BOSS_POINT;
  // шаг: тело проседает на 1 пиксель, когда обе ноги на земле (кадры 0 и 2 шага)
  const bob = walk === 1 || walk === 3 ? -1 : 0;
  // смотрит — подался вперёд и вниз: голова на пиксель ниже
  const lean = look ? 1 : 0;
  const top = 2 + bob;

  if (view === 'S') side(g, put, rect, top, walk, look, point, lean);
  else front(g, put, rect, view, top, walk, look, point, lean);
  outline(g);
  return g.map((r) => r.map((k) => k ?? '.').join(''));
}

function front(
  g: Grid,
  put: (x: number, y: number, k: BossKey) => void,
  rect: (x: number, y: number, w: number, h: number, k: BossKey) => void,
  view: View,
  top: number,
  walk: number,
  look: boolean,
  point: boolean,
  lean: number,
): void {
  const back = view === 'U';
  const hy = top + lean; // макушка
  // ── ноги: длинные, в чёрных брюках; на шаге одна нога короче (поднята) ──
  const legTop = top + 21;
  const liftL = walk === 0 ? 2 : walk === 1 ? 1 : 0;
  const liftR = walk === 2 ? 2 : walk === 3 ? 1 : 0;
  rect(6, legTop, 4, BOSS_H - 2 - legTop - liftL, 'n');
  rect(10, legTop, 4, BOSS_H - 2 - legTop - liftR, 'n');
  put(9, legTop + 2, 'o'); // шов между штанинами
  // туфли — с бликом
  rect(5, BOSS_H - 2 - liftL, 5, 2, 'o');
  rect(10, BOSS_H - 2 - liftR, 5, 2, 'o');
  put(6, BOSS_H - 2 - liftL, 'k');
  put(13, BOSS_H - 2 - liftR, 'k');
  // ── пиджак: широкие плечи, сужается к поясу, полы ниже пояса ──
  const jy = hy + 10;
  rect(3, jy, 14, 3, 'n'); // плечи
  rect(4, jy + 3, 12, 9, 'n');
  rect(5, jy + 12, 10, 2, 'n'); // полы
  put(3, jy, 'k');
  put(16, jy, 'k'); // подплечники ловят свет
  if (!back) {
    // рубашка и галстук V-вырезом, лацканы
    rect(8, jy, 4, 1, 'w');
    rect(9, jy + 1, 2, 1, 'w');
    put(7, jy + 1, 'k');
    put(12, jy + 1, 'k');
    put(7, jy + 2, 'k');
    put(12, jy + 2, 'k');
    put(8, jy + 3, 'k');
    put(11, jy + 3, 'k');
    rect(9, jy + 1, 2, 1, 'r');
    rect(9, jy + 2, 2, 5, 'r');
    put(10, jy + 3, 'R');
    put(10, jy + 5, 'R');
    put(9, jy + 7, 'r');
    // пуговица
    put(10, jy + 9, 'k');
  } else {
    // спинка: шов посередине и шлица
    for (let y = jy + 2; y < jy + 14; y++) put(10, y, y > jy + 11 ? 'o' : 'k');
  }
  // ── руки ──
  if (look && !back) {
    // руки за спиной: локти торчат, кистей не видно
    rect(2, jy + 2, 2, 6, 'n');
    rect(16, jy + 2, 2, 6, 'n');
  } else if (point && !back) {
    // правая рука вытянута в сторону, указательный палец
    rect(2, jy + 1, 2, 10, 'n');
    rect(2, jy + 11, 2, 2, 'h');
    rect(16, jy + 1, 4, 2, 'n');
    put(19, jy + 1, 'h');
    put(19, jy + 2, 'h');
  } else {
    // руки вдоль тела, на шаге качаются навстречу ногам
    const swL = walk === 0 ? -1 : walk === 2 ? 1 : 0;
    const swR = -swL;
    rect(2, jy + 1, 2, 10 + swL, 'n');
    rect(2, jy + 11 + swL, 2, 2, 'h');
    rect(16, jy + 1, 2, 10 + swR, 'n');
    rect(16, jy + 11 + swR, 2, 2, 'h');
  }
  // ── шея и голова: узкое вытянутое лицо ──
  rect(9, hy + 8, 2, 2, back ? 's' : 'S');
  rect(6, hy, 8, 7, back ? 's' : 'm');
  rect(7, hy + 7, 6, 1, back ? 's' : 'm'); // узкий подбородок
  // волосы: зачёсаны назад, клин на лбу
  rect(6, hy, 8, 2, 's');
  put(5, hy + 1, 's');
  put(14, hy + 1, 's');
  rect(5, hy + 2, 1, 3, 's');
  rect(14, hy + 2, 1, 3, 's');
  for (let x = 7; x < 13; x += 2) put(x, hy, 'S'); // пряди блестят
  if (back) {
    rect(6, hy, 8, 8, 's');
    for (let y = hy + 1; y < hy + 7; y += 2) put(8 + ((y >> 1) % 3), y, 'S');
    return;
  }
  put(9, hy + 2, 's');
  put(10, hy + 2, 's'); // клин
  // лоб и скулы в тени
  rect(6, hy + 3, 8, 1, 'S');
  // впадины глаз и сами глаза
  rect(7, hy + 4, 2, 2, 'e');
  rect(11, hy + 4, 2, 2, 'e');
  if (look) {
    put(8, hy + 4, 'g');
    put(11, hy + 4, 'g');
    put(7, hy + 4, 'G');
    put(12, hy + 4, 'G');
  } else {
    put(8, hy + 4, 'w');
    put(11, hy + 4, 'w');
  }
  // впалые щёки и нос
  put(7, hy + 6, 'S');
  put(12, hy + 6, 'S');
  put(10, hy + 5, 'S');
  rect(8, hy + 7, 4, 1, look ? 'e' : 'S');
}

function side(
  g: Grid,
  put: (x: number, y: number, k: BossKey) => void,
  rect: (x: number, y: number, w: number, h: number, k: BossKey) => void,
  top: number,
  walk: number,
  look: boolean,
  point: boolean,
  lean: number,
): void {
  const hy = top + lean;
  const hx = 7 + lean; // голова подаётся вперёд (вправо)
  // ── ноги: шаг ножницами ──
  const legTop = top + 21;
  const stride = walk === 0 ? 3 : walk === 2 ? -3 : walk === 1 || walk === 3 ? 1 : 0;
  const footY = BOSS_H - 2;
  // задняя нога — темнее
  for (let y = legTop; y < footY; y++) {
    const k = (y - legTop) / (footY - legTop);
    put(Math.round(9 - stride * k), y, 'o');
    put(Math.round(10 - stride * k), y, 'n');
  }
  rect(Math.round(9 - stride), footY, 4, 2, 'o');
  for (let y = legTop; y < footY; y++) {
    const k = (y - legTop) / (footY - legTop);
    put(Math.round(9 + stride * k), y, 'n');
    put(Math.round(10 + stride * k), y, 'n');
    put(Math.round(11 + stride * k), y, 'k');
  }
  rect(Math.round(9 + stride), footY, 5, 2, 'o');
  put(Math.round(12 + stride), footY, 'k');
  // ── пиджак боком ──
  const jy = hy + 10;
  rect(7, jy, 7, 12, 'n');
  rect(7, jy + 12, 6, 2, 'n');
  put(13, jy, 'k');
  // рубашка и галстук видны спереди (справа)
  put(13, jy, 'w');
  put(13, jy + 1, 'r');
  put(13, jy + 2, 'R');
  // ── рука ──
  if (point) {
    rect(10, jy + 1, 9, 2, 'n');
    put(19, jy + 1, 'h');
    put(18, jy + 2, 'h');
  } else if (look) {
    // руки за спиной: локоть торчит назад
    rect(5, jy + 2, 3, 5, 'n');
    put(5, jy + 7, 'h');
  } else {
    const sw = walk === 0 ? -2 : walk === 2 ? 2 : 0;
    for (let y = 0; y < 10; y++) put(10 + Math.round((sw * y) / 10), jy + 1 + y, 'k');
    for (let y = 0; y < 10; y++) put(9 + Math.round((sw * y) / 10), jy + 1 + y, 'n');
    rect(9 + sw, jy + 11, 2, 2, 'h');
  }
  // ── голова в профиль ──
  rect(hx, hy + 8, 3, 2, 'S'); // шея
  rect(hx - 1, hy, 7, 8, 'm');
  rect(hx - 1, hy, 7, 2, 's');
  rect(hx - 1, hy + 2, 3, 4, 's'); // затылок
  put(hx - 2, hy + 2, 's');
  put(hx - 2, hy + 3, 's');
  put(hx + 2, hy + 1, 'S');
  rect(hx + 2, hy + 3, 4, 1, 'S'); // бровь в тени
  // глаз
  rect(hx + 3, hy + 4, 2, 1, 'e');
  put(hx + 4, hy + 4, look ? 'g' : 'w');
  if (look) put(hx + 5, hy + 4, 'G');
  // нос с горбинкой и губы
  put(hx + 6, hy + 4, 'm');
  put(hx + 6, hy + 5, 'm');
  put(hx + 5, hy + 7, look ? 'e' : 'S');
  put(hx + 4, hy + 7, look ? 'e' : 'S');
  put(hx + 1, hy + 6, 'S'); // скула
}

/** Контур ink вокруг фигуры — читается на любом полу. */
function outline(g: Grid): void {
  const add: [number, number][] = [];
  for (let y = 0; y < BOSS_H; y++) {
    for (let x = 0; x < BOSS_W; x++) {
      if (g[y][x]) continue;
      const near = [g[y - 1]?.[x], g[y + 1]?.[x], g[y]?.[x - 1], g[y]?.[x + 1]].some((k) => k && k !== 'o');
      if (near) add.push([x, y]);
    }
  }
  for (const [x, y] of add) g[y][x] = 'o';
}

/** Цвета букв кадра — только из палитры. */
const BOSS_MAP: Record<BossKey, string> = {
  o: PAL.ink,
  n: PAL.night,
  k: PAL.dusk,
  s: PAL.steel,
  S: PAL.slate,
  m: PAL.mist,
  w: PAL.white,
  r: PAL.red,
  R: PAL.wine,
  e: PAL.ink,
  g: PAL.magenta,
  G: PAL.red,
  h: PAL.mist,
};

/** Лента кадров шефа: BOSS_W × BOSS_H, подряд все виды (`bossFrame`). */
export function makeBossSheet(): HTMLCanvasElement {
  const fr = bossFrames();
  const { c, g } = canvas(BOSS_W * fr.length, BOSS_H);
  fr.forEach((rows, i) => grid(g, i * BOSS_W, 0, rows, BOSS_MAP));
  return c;
}
