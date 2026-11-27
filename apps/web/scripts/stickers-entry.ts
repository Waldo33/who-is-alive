/** Кадры видеостикеров для `scripts/stickers.mjs`: каждый стикер × язык × 20 кадров, 512×512 PNG. */
import { LANGS } from '@kto/game-core';
import type { Lang } from '@kto/game-core';
import { ST_FRAMES, STICKERS, stickerFile } from '../src/game/skins/stickers';

const G = globalThis as unknown as { __out: { lang: string; id: string; frames: string[] }[] };
const out: typeof G.__out = [];
for (const lang of LANGS as Lang[]) {
  for (const s of STICKERS) {
    const frames: string[] = [];
    for (let t = 0; t < ST_FRAMES; t++) frames.push(stickerFile(s, t, lang).toDataURL('image/png'));
    out.push({ lang, id: s.id, frames });
  }
}
G.__out = out;
