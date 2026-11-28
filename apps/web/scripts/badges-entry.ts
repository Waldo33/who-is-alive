/** Картинки значков для `scripts/badges.mjs`: 100×100 PNG на каждый значок (game-core/badges.ts). */
import { BADGE_IDS } from '@kto/game-core';
import { badgeFile } from '../src/game/skins/badges';

const G = globalThis as unknown as { __out: { id: string; png: string }[] };
G.__out = BADGE_IDS.map((id) => ({ id, png: badgeFile(id).toDataURL('image/png') }));
