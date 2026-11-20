/**
 * Фоны превью ссылок (1200×630) по темам раунда: полосы, рамка и площадь ×2 с толпой —
 * из тех же процедурных спрайтов, что в игре (запускается в браузере, см. make-og.mjs).
 * Над одним человечком — «?»: кто из них живой?
 */
import { PAL } from '@kto/assets';
import { Rng, THEME_COUNT, plazaArena, rectContains } from '@kto/game-core';
import { frame, getArt } from '../src/game/art';
import { canvas } from '../src/game/pixels';
import { CH_H, CH_W, F, makeMark } from '../src/game/sprites';
import { loadTheme } from '../src/game/themes';

const W = 1200;
const H = 630;
const arena = plazaArena(180, 260);
const art = getArt(arena);
const qmark = makeMark('?');

function scene(theme: number): HTMLCanvasElement {
  const { c, g } = canvas(arena.width, arena.height);
  const loc = art.loc(theme);
  g.drawImage(loc.arena, 0, 0);
  const rng = new Rng(7 + theme * 101);
  // толпа: случайные места на площади, не в предметах и не друг в друге
  const people: { x: number; y: number; f: number; flip: boolean }[] = [];
  for (let tries = 0; people.length < 30 && tries < 3000; tries++) {
    const x = Math.round(rng.range(arena.walk.x + 6, arena.walk.x + arena.walk.w - 6));
    const y = Math.round(rng.range(arena.walk.y + 14, arena.walk.y + arena.walk.h - 2));
    if (arena.props.some((p) => rectContains({ x: p.foot.x - 6, y: p.foot.y - 2, w: p.foot.w + 12, h: p.foot.h + 14 }, x, y))) continue;
    if (people.some((p) => Math.abs(p.x - x) < 11 && Math.abs(p.y - y) < 9)) continue;
    const view = rng.next();
    const f = view < 0.55 ? F.D + (rng.next() < 0.5 ? 2 : 3) : view < 0.75 ? F.U + 2 : F.S + 3;
    people.push({ x, y, f, flip: view >= 0.75 && rng.next() < 0.5 });
  }
  type D = { y: number; draw: () => void };
  const list: D[] = [];
  for (const p of arena.props) {
    const pr = loc.props.get(p.kind)!;
    list.push({ y: p.y, draw: () => frame(g, pr.c, pr.fw, pr.fh, 0, p.x - pr.fw / 2, p.y - pr.fh) });
  }
  for (const p of people) {
    list.push({
      y: p.y,
      draw: () => {
        g.drawImage(art.shadow, p.x - 5, p.y - 2);
        frame(g, art.chars(theme).body, CH_W, CH_H, p.f, p.x - 6, p.y - CH_H, p.flip);
      },
    });
  }
  list.sort((a, b) => a.y - b.y);
  for (const d of list) d.draw();
  // «?» над тем, кто ближе всех к центру выше фонтана
  const sus = [...people].sort((a, b) => Math.hypot(a.x - 96, a.y - 100) - Math.hypot(b.x - 96, b.y - 100))[0];
  if (sus) g.drawImage(qmark, sus.x - Math.floor(qmark.width / 2), sus.y - CH_H - qmark.height - 1);
  g.globalAlpha = 0.35;
  g.drawImage(art.vignette, 0, 0);
  g.globalAlpha = 1;
  return c;
}

function og(theme: number): string {
  const { c, g } = canvas(W, H);
  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, W, H);
  g.fillStyle = PAL.plum;
  for (let y = 6; y < H; y += 8) g.fillRect(0, y, W, 2);
  // рамка игрового экрана: сиреневая, чёрная, ночная — по 4 px
  const ax = 780;
  const ay = 55;
  const aw = 360;
  const ah = 520;
  const ring = (k: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(ax - k, ay - k, aw + 2 * k, ah + 2 * k);
  };
  ring(12, PAL.grape);
  ring(8, PAL.ink);
  ring(4, PAL.night);
  g.drawImage(scene(theme), ax, ay, aw, ah);
  return c.toDataURL('image/png');
}

// пакеты тем грузятся по требованию — сначала все, потом рисуем
void Promise.all(Array.from({ length: THEME_COUNT }, (_, i) => loadTheme(i))).then(() => {
  (globalThis as unknown as { __og: string[] }).__og = Array.from({ length: THEME_COUNT }, (_, i) => og(i));
});
