import { PAL } from '@kto/assets';
import { DICTS, STICKER_LIST, fmt, shopItem } from '@kto/game-core';
import type { Lang, ShopItemId, StickerId } from '@kto/game-core';
import { text } from '../art';
import { canvas, dither, outlineOf } from '../pixels';
import type { Ctx } from '../pixels';
import { F } from '../sprites';
import type { View } from '../themes/types';
import { KB_W, kotBananFrame, tearArcs, wailFace } from './kot-banan';

/**
 * Карточка набора в «Гардеробе» (за флагом shop): сцена под дождём с прожектором, маленький Кот-банан ×4
 * (тот же, что в дубле) ревёт, танцует и машет; имя, подпись, ряд из 8 стикеров в подарок
 * (выданные — ярко, остальные — под замком) и старая цена. Кнопки — разметкой страницы.
 * Холст 180×CARD_H логических пикселей; масштаб — целый в пикселях экрана (рисует зовущий через scale).
 */
export const CARD_W = 180;
export const CARD_H = 246;
const FONT = '"Press Start 2P"';

interface Pose {
  f: number;
  v: View;
  s?: number;
  hop?: number;
  ms: number;
  cry?: number;
}

// стоит → ревёт (слёзы дугами, как в меме) → танцует → машет; поворачивать не даём (решение владельца)
const SEQ: Pose[] = [
  { f: F.D, v: 'D', ms: 700 },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ f: F.D, v: 'D' as View, cry: i, hop: i % 2 ? -1 : 0, ms: 130 })),
  { f: F.D, v: 'D', ms: 300 },
  ...[0, 1, 2].flatMap(() => [
    { f: F.DANCE, v: 'D' as View, s: -1, ms: 160 },
    { f: F.DANCE + 1, v: 'D' as View, hop: -1, ms: 160 },
    { f: F.DANCE + 2, v: 'D' as View, s: 1, ms: 160 },
    { f: F.DANCE + 3, v: 'D' as View, hop: -1, ms: 160 },
  ]),
  { f: F.D, v: 'D', ms: 300 },
  ...[0, 1, 0, 1].map((i) => ({ f: F.WAVE + i, v: 'D' as View, ms: 200 })),
];
const SEQ_MS = SEQ.reduce((a, p) => a + p.ms, 0);

function poseAt(ms: number): { p: Pose; k: number } {
  let t = ms % SEQ_MS;
  for (const [k, p] of SEQ.entries()) {
    if (t < p.ms) return { p, k };
    t -= p.ms;
  }
  return { p: SEQ[0], k: 0 };
}

/** Иконка стикера в ряду подарков: маленький кот в позе стикера, белая обводка. */
const ICON: Record<string, () => HTMLCanvasElement> = {
  notCrying: () => wailFace(kotBananFrame(F.D, 'D')),
  justBanana: () => kotBananFrame(F.U, 'U'),
  splat: () => kotBananFrame(F.STUN, 'D'),
  allGood: () => kotBananFrame(F.D, 'D'),
  aaa: () => wailFace(kotBananFrame(F.STARTLE, 'D')),
  happyTears: () => kotBananFrame(F.DANCE + 2, 'D'),
  freeze: () => {
    const h = kotBananFrame(F.FREEZE, 'D');
    const q = h.getContext('2d') as Ctx;
    q.globalCompositeOperation = 'source-atop';
    q.fillStyle = 'rgba(115,239,247,0.55)';
    q.fillRect(0, 0, h.width, h.height);
    return h;
  },
  meow: () => kotBananFrame(F.S, 'S'),
};
const icons = new Map<string, HTMLCanvasElement>();
function icon(id: StickerId): HTMLCanvasElement {
  let o = icons.get(id);
  if (!o) {
    const c = (ICON[id] ?? ICON.allGood)();
    const w = canvas(c.width + 2, c.height + 2);
    outlineOf(c.getContext('2d') as Ctx, c.width, c.height, w.g, 0, 0, PAL.white);
    w.g.drawImage(c, 1, 1);
    icons.set(id, (o = w.c));
  }
  return o;
}

export interface CardState {
  lang: Lang;
  item: ShopItemId;
  /** Выданные стикеры (ярко), остальные — под замком. */
  issued: Set<string>;
}

/** Нарисовать кадр карточки на `ms` от начала. `g` уже в масштабе (setTransform(k…)). */
export function drawCard(g: Ctx, ms: number, st: CardState): void {
  const t = DICTS[st.lang].shop;
  const R = (x: number, y: number, w: number, h: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(x, y, w, h);
  };
  g.imageSmoothingEnabled = false;
  R(0, 0, CARD_W, CARD_H, PAL.night);
  // сцена: дождь, прожектор, лужа
  const SY = 0;
  const SH = 146;
  const FLOOR = SY + SH - 8;
  const k = Math.floor(ms / 100);
  R(0, SY, CARD_W, SH, PAL.navy);
  dither(g, 0, SY + 40, CARD_W, 40, PAL.night);
  R(0, SY + 80, CARD_W, SH - 80, PAL.night);
  for (let i = 0; i < 70; i++) {
    const x = (i * 37) % CARD_W;
    const y = SY + ((i * 53 + k * 6) % (SH - 20));
    R(x, y, 1, 3, i % 3 ? PAL.blue : PAL.cyan);
  }
  g.fillStyle = 'rgba(254,231,97,0.10)';
  g.beginPath();
  g.moveTo(74, SY);
  g.lineTo(106, SY);
  g.lineTo(150, FLOOR + 4);
  g.lineTo(30, FLOOR + 4);
  g.fill();
  R(0, FLOOR, CARD_W, SY + SH - FLOOR, PAL.dusk);
  R(46, FLOOR - 2, 88, 6, PAL.navy);
  R(56, FLOOR - 1, 68, 4, PAL.blue);
  R(66, FLOOR, 18, 1, PAL.cyan);
  // ярлык «НОВОЕ»
  const tw = text(g, t.isNew, 0, -100, PAL.white, FONT, { outline: null });
  R(CARD_W - tw - 12, SY + 6, tw + 6, 12, PAL.magenta);
  text(g, t.isNew, CARD_W - 9 - tw / 2, SY + 8, PAL.white, FONT, { outline: null });
  // Кот-банан ×4
  const { p, k: pk } = poseAt(ms);
  const hs = 4;
  const h = kotBananFrame(p.f, p.v, p.s ?? 0);
  if (p.cry !== undefined) wailFace(h);
  const x0 = Math.round(CARD_W / 2 - (KB_W * hs) / 2);
  const y0 = FLOOR + 2 - h.height * hs + (p.hop ?? 0) * hs;
  g.drawImage(h, x0, y0, h.width * hs, h.height * hs);
  if (p.cry !== undefined) tearArcs(g, x0, y0, hs, pk, 6 + p.cry * 4);
  R(0, SY + SH, CARD_W, 1, PAL.yellow);
  // имя, подпись, подарок
  text(g, t.items[st.item].name, 90, 152, PAL.yellow, FONT, { size: 2 });
  text(g, t.items[st.item].tagline, 90, 172, PAL.white, FONT);
  text(g, t.gift, 90, 187, PAL.yellow, FONT);
  const list = STICKER_LIST.filter((s) => s.set === st.item);
  const TW = 20;
  const TH = 32;
  const TY = 199;
  const TX = Math.round((CARD_W - (TW * list.length + list.length - 1)) / 2);
  list.forEach((s, i) => {
    const x = TX + i * (TW + 1);
    const open = st.issued.has(s.id);
    R(x, TY, TW, TH, open ? PAL.dusk : PAL.navy);
    const c = icon(s.id);
    g.drawImage(c, x + Math.round((TW - c.width) / 2), TY + TH - c.height + 1);
    if (!open) {
      g.fillStyle = 'rgba(24,20,37,0.42)';
      g.fillRect(x, TY, TW, TH);
      // замочек
      const lx = x + TW - 7;
      const ly = TY + 2;
      R(lx + 1, ly, 3, 1, PAL.mist);
      R(lx, ly + 1, 1, 2, PAL.mist);
      R(lx + 4, ly + 1, 1, 2, PAL.mist);
      R(lx - 1, ly + 3, 7, 4, PAL.mist);
      R(lx + 2, ly + 4, 1, 2, PAL.ink);
    }
  });
  text(g, t.giftHow, 90, 236, PAL.mist, FONT);
}

/** Старая цена зачёркнутой строкой для кнопки: «275». */
export function oldPrice(item: ShopItemId): string {
  const w = shopItem(item)?.was;
  return w ? String(w) : '';
}

/** Подпись кнопки покупки: «Купить 199». */
export function buyLabel(lang: Lang, item: ShopItemId): string {
  return fmt(DICTS[lang].shop.buy, { n: shopItem(item)?.stars ?? 0 });
}

/**
 * Звезда Telegram (валюта Stars) в пикселях игры: пятиконечная, золотой ободок, светлая серединка.
 * Рисуется по многоугольнику звезды в 15×15 (с контуром — 17×17), цвета — только из палитры.
 */
export function starsIcon(): HTMLCanvasElement {
  const N = 15;
  const { c, g } = canvas(N, N);
  const pts = (scale: number) =>
    Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = (i % 2 ? 0.58 : 1) * scale;
      return [7.5 + Math.cos(a) * r, 8.4 + Math.sin(a) * r] as const;
    });
  const inside = (p: readonly (readonly [number, number])[], x: number, y: number) => {
    let s = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i];
      const [xj, yj] = p[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) s = !s;
    }
    return s;
  };
  const outer = pts(7.6);
  const mid = pts(5.2);
  const core = pts(2.4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!inside(outer, px, py)) continue;
      g.fillStyle = inside(core, px, py) ? PAL.white : inside(mid, px, py) ? PAL.yellow : py > 9 ? PAL.orange : PAL.amber;
      g.fillRect(x, y, 1, 1);
    }
  }
  // тёмный контур — чтобы звезда читалась и на оранжевой кнопке
  const o = canvas(N + 2, N + 2);
  outlineOf(g, N, N, o.g, 0, 0, PAL.ink);
  o.g.drawImage(c, 1, 1);
  return o.c;
}
