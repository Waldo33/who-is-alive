/** Картинки значков для `scripts/badges.mjs`: 100×100 PNG на каждый значок, у анимированных — ещё кадры видео. */
import { ANIMATED_BADGES, BADGE_IDS } from '@kto/game-core';
import { badgeFile } from '../src/game/skins/badges';
import { SLOT_BADGE_FPS, SLOT_BADGE_MS } from '../src/game/skins/badge-slots';

const G = globalThis as unknown as { __out: { id: string; png: string; frames: string[]; fps: number }[] };
const n = Math.round((SLOT_BADGE_MS / 1000) * SLOT_BADGE_FPS);
G.__out = BADGE_IDS.map((id) => ({
  id,
  png: badgeFile(id).toDataURL('image/png'),
  fps: SLOT_BADGE_FPS,
  frames: ANIMATED_BADGES.includes(id) ? Array.from({ length: n }, (_, i) => badgeFile(id, (i * 1000) / SLOT_BADGE_FPS).toDataURL('image/png')) : [],
}));
