import { PAL, PLAYER_COLORS } from '@kto/assets';
import { tp } from '@kto/game-core';
import type { ArenaDef, AwardCard, Dict, Lang, PlayerInfo } from '@kto/game-core';
import { fitSize, frame, getArt, scaledCanvas, text } from './art';
import { CH_H, CH_W, F, OL_H, OL_W } from './sprites';

/**
 * Карточка результата матча 1080×1350 (4:5 — так её не обрезают ленты соцсетей):
 * победитель, счёт, две награды, адрес игры. Рисуется пиксельно, ×6.
 */
const LW = 180;
const LH = 225;
const SCALE = 6;

export interface CardInput {
  players: readonly PlayerInfo[];
  scores: Record<string, number>;
  winners: string[];
  tooAlive: boolean;
  awards: AwardCard[];
  theme: number;
  arena: ArenaDef;
  t: Dict;
  lang: Lang;
  font: string;
  site: string;
}

export function drawResultCard(inp: CardInput): HTMLCanvasElement {
  const { c, g } = scaledCanvas(LW, LH, SCALE);
  const { t, font } = inp;
  const art = getArt(inp.arena);
  const fit = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, LW, LH);
  g.fillStyle = PAL.plum;
  for (let y = 6; y < LH; y += 7) g.fillRect(0, y, LW, 1);
  g.strokeStyle = PAL.steel;
  g.lineWidth = 1;
  g.strokeRect(2.5, 2.5, LW - 5, LH - 5);

  text(g, t.meta.title, LW / 2, 9, PAL.yellow, font, { size: 1.25 });
  const crown = art.icons.names.indexOf('crown');
  g.save();
  g.translate(LW / 2 - 8, 23);
  g.scale(2, 2);
  frame(g, art.icons.canvas, 8, 8, Math.max(0, crown), 0, 0);
  g.restore();
  // по бокам короны — два танцующих: один с цветным контуром живого, другой — бот
  const ch = art.chars(inp.theme);
  [[30, 0], [150, -1]].forEach(([x, col], i) => {
    const fr = F.DANCE + i * 2;
    g.drawImage(art.shadow, x - 5, 40);
    if (col >= 0) frame(g, ch.outline[1 + col], OL_W, OL_H, fr, x - 7, 42 - 17);
    frame(g, ch.body, CH_W, CH_H, fr, x - 6, 42 - CH_H);
  });

  const byColor = (pid: string) => inp.players.find((p) => p.pid === pid);
  if (inp.tooAlive || !inp.winners.length) {
    text(g, t.card.tooAlive, LW / 2, 44, PAL.yellow, font);
  } else {
    text(g, t.card.winner, LW / 2, 42, PAL.mist, font);
    const names = inp.winners.map((pid) => byColor(pid)!);
    const w = names[0];
    const label = names.length > 1 ? names.map((n) => n.name.split(' ')[0]).join(t.game.and) : w.name;
    text(g, label, LW / 2, 53, PLAYER_COLORS[w.color], font, { maxWidth: LW - 10 });
  }

  // счёт
  const order = [...inp.players].sort((a, b) => (inp.scores[b.pid] ?? 0) - (inp.scores[a.pid] ?? 0));
  order.forEach((p, i) => {
    const y = 68 + i * 13;
    g.fillStyle = PAL.ink;
    g.fillRect(14, y, 9, 9);
    g.fillStyle = PLAYER_COLORS[p.color];
    g.fillRect(15, y + 1, 7, 7);
    text(g, p.name, 28, y + 1, PAL.white, font, { align: 'left', maxWidth: LW - 28 - 30 });
    text(g, String(inp.scores[p.pid] ?? 0), LW - 14, y + 1, PAL.sand, font, { align: 'right' });
  });

  // две награды
  inp.awards.slice(0, 2).forEach((a, i) => {
    const x = 8;
    const y = 124 + i * 36;
    const def = t.awards[a.id];
    g.fillStyle = PAL.ink;
    g.fillRect(x, y, LW - 16, 33);
    g.fillStyle = PAL.grape;
    g.fillRect(x + 1, y + 1, LW - 18, 31);
    g.fillStyle = PAL.orchid;
    g.fillRect(x + 1, y + 1, LW - 18, 1);
    frame(g, art.icons.canvas, 8, 8, Math.max(0, crown), x + 4, y + 4);
    text(g, fit(def.title, 18), x + 15, y + 4, PAL.yellow, font, { align: 'left', outline: null });
    const who = a.pids.map((pid) => byColor(pid)?.name ?? '?');
    const whoS = who.length > 1 ? who.map((n) => n.split(' ')[0]).join(t.game.and) : who[0];
    text(g, whoS, x + 4, y + 14, PAL.white, font, { align: 'left', outline: null, maxWidth: LW - 24 });
    text(g, fit(tp(inp.lang, def.text, a.value), 20), x + 4, y + 23, PAL.mist, font, { align: 'left', outline: null });
  });

  text(g, t.card.cta, LW / 2, LH - 22, PAL.white, font, { outline: null });
  text(g, inp.site, LW / 2, LH - 12, PAL.cyan, font, { outline: null, size: fitSize(inp.site, LW - 12, SCALE), maxWidth: LW - 12 });
  return c;
}

export function resultCardFile(inp: CardInput): Promise<File | null> {
  const c = drawResultCard(inp);
  return new Promise((res) =>
    c.toBlob((b) => res(b ? new File([b], 'kto-tut-zhivoy.png', { type: 'image/png' }) : null), 'image/png'),
  );
}
