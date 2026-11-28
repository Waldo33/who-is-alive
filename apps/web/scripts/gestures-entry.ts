/**
 * Лист жестов «Своего стикера» и мемов пака для `scripts/gestures.mjs`: по ряду на фигурку — её свои жесты
 * (`MY_FIG_POSES`, рисует skins/gestures.ts через my-sticker.ts), последним рядом — мемы пака. 20 кадров
 * по 100 мс, как стикер. Подпись по желанию: `__caption` — одна строка снизу у всех жестов.
 */
import { PAL } from '@kto/assets';
import { DICTS, MY_FIGS, MY_FIG_POSES } from '@kto/game-core';
import type { Lang, MyFig, MyPose } from '@kto/game-core';
import { canvas } from '../src/game/pixels';
import type { Ctx } from '../src/game/pixels';
import { loadAllThemes } from '../src/game/themes';
import { myDef } from '../src/game/skins/my-sticker';
import { ST_FRAMES, STICKERS, stickerFrame } from '../src/game/skins/stickers';

const G = globalThis as unknown as { __out: { name: string; frames: string[] }[]; __dbg?: number[]; __caption?: string };
const lang: Lang = 'ru';
const d = DICTS[lang].shop;

interface Tile {
  row: string;
  name: string;
  def: { draw(g: Ctx, t: number, lang: Lang): void };
}

void loadAllThemes(60000).then(() => {
  const tiles: Tile[] = [];
  const figName = (f: MyFig) => (d.build.figs as Record<string, string>)[f] ?? d.stickers[f as 'chef']?.[0] ?? f;
  for (const f of MY_FIGS) {
    for (const pose of MY_FIG_POSES[f.id] as readonly MyPose[]) {
      tiles.push({ row: figName(f.id), name: d.build.poses[pose], def: myDef({ fig: f.id, pose, color: 0, text: G.__caption ? [G.__caption] : [] }) });
    }
  }
  for (const id of ['busted', 'sleep', 'lastTime'] as const) {
    const s = STICKERS.find((x) => x.id === id)!;
    tiles.push({ row: 'Мемы', name: id, def: s });
  }

  const T = 192;
  const PAD = 12;
  const HEAD = 26;
  const COLS = 4;
  const rows = [...new Set(tiles.map((s) => s.row))];
  const parts = [rows.slice(0, 5), rows.slice(5, 10), rows.slice(10)];
  const out: typeof G.__out = [];
  parts.forEach((part, pi) => {
    const W = PAD + COLS * (T + PAD);
    const H = PAD + part.length * (HEAD + T + PAD + 22);
    const frames: string[] = [];
    for (let t = 0; t < ST_FRAMES; t++) {
      const { c, g } = canvas(W, H);
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#17212b';
      g.fillRect(0, 0, W, H);
      part.forEach((row, ri) => {
        const y = PAD + ri * (HEAD + T + PAD + 22);
        g.fillStyle = PAL.yellow;
        g.font = '16px "Press Start 2P"';
        g.textBaseline = 'top';
        g.fillText(row, PAD, y + 4);
        tiles.filter((s) => s.row === row).forEach((s, ci) => {
          const x = PAD + ci * (T + PAD);
          g.drawImage(stickerFrame(s.def, t, lang), x, y + HEAD, T, T);
          g.fillStyle = PAL.white;
          g.font = '8px "Press Start 2P"';
          g.fillText(s.name, x, y + HEAD + T + 6);
        });
      });
      frames.push(c.toDataURL('image/png'));
    }
    out.push({ name: `zhesty-${pi + 1}`, frames });
  });
  // отладочная лента: каждая плитка — кадры 0, 3, 6 … 18 (или __dbg)
  const pick = G.__dbg ?? [0, 3, 6, 9, 12, 15, 18];
  const { c, g } = canvas(pick.length * 100, tiles.length * 100);
  g.fillStyle = '#17212b';
  g.fillRect(0, 0, c.width, c.height);
  tiles.forEach((s, i) => pick.forEach((t, j) => g.drawImage(stickerFrame(s.def, t, lang), j * 100, i * 100, 96, 96)));
  out.push({ name: 'debug', frames: [c.toDataURL('image/png')] });
  G.__out = out;
});
