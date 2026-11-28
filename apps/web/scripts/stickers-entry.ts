/** Кадры видеостикеров для `scripts/stickers.mjs`: каждый стикер × язык × 20 кадров (у «Пшшш!» — 30), 512×512 PNG. */
import { LANGS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { STICKERS, stickerFile, stickerFrames } from '../src/game/skins/stickers';
import { loadAllThemes } from '../src/game/themes';

const G = globalThis as unknown as { __out: { lang: string; id: string; frames: string[] }[] };
const out: typeof G.__out = [];
// костюмы тем для стикеров «за игру» — из пакетов тем
void loadAllThemes(60000).then(() => {
  for (const lang of LANGS as Lang[]) {
    for (const s of STICKERS) {
      const frames: string[] = [];
      for (let t = 0; t < stickerFrames(s); t++) frames.push(stickerFile(s, t, lang).toDataURL('image/png'));
      out.push({ lang, id: s.id, frames });
    }
  }
  G.__out = out;
});
