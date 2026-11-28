/** Картинки эмодзи для постов (`scripts/post-emoji.mjs`): 100×100 PNG, у анимированных — ещё кадры видео; плюс лист-превью. */
import { PAL } from '@kto/assets';
import { POST_EMOJI, POST_EMOJI_FPS, POST_EMOJI_MS, postEmojiFile, postEmojiIcon } from '../src/game/skins/post-emoji';
import { REWARD_EMOJI } from '../src/game/skins/reward-emoji';
import { canvas } from '../src/game/pixels';

const G = globalThis as unknown as { __out: { id: string; emoji: string; base: boolean; png: string; frames: string[]; fps: number }[]; __sheet: string };
const n = Math.round((POST_EMOJI_MS / 1000) * POST_EMOJI_FPS);
// общие (в list.json — набор владельца для постов) и награды личного пака (только файлы)
G.__out = [...POST_EMOJI, ...REWARD_EMOJI].map((e) => ({
  id: e.id,
  emoji: e.emoji,
  base: POST_EMOJI.includes(e),
  png: postEmojiFile(e).toDataURL('image/png'),
  fps: POST_EMOJI_FPS,
  frames: e.anim ? Array.from({ length: n }, (_, i) => postEmojiFile(e, (i * 1000) / POST_EMOJI_FPS).toDataURL('image/png')) : [],
}));

// лист-превью: на тёмном и светлом фоне, ×4 и мелко (как в тексте поста)
const cols = 6;
const cell = 100;
const rowsN = Math.ceil(POST_EMOJI.length / cols);
const { c, g } = canvas(cols * cell * 2, rowsN * cell + 60);
g.fillStyle = '#17212b';
g.fillRect(0, 0, cols * cell, c.height);
g.fillStyle = '#ffffff';
g.fillRect(cols * cell, 0, cols * cell, c.height);
POST_EMOJI.forEach((e, i) => {
  const ic = postEmojiIcon(e, 300);
  const x = (i % cols) * cell;
  const y = Math.floor(i / cols) * cell;
  for (const ox of [0, cols * cell]) {
    g.drawImage(ic, ox + x + 10, y + 10, ic.width * 4, ic.height * 4);
    g.font = '11px sans-serif';
    g.fillStyle = ox ? PAL.ink : PAL.white;
    g.fillText(e.emoji + ' ' + e.name, ox + x + 10, y + 96);
  }
});
// мелко — как в строке текста (×1)
POST_EMOJI.forEach((e, i) => {
  const ic = postEmojiIcon(e, 300);
  for (const ox of [0, cols * cell]) g.drawImage(ic, ox + 10 + i * 19, rowsN * cell + 20);
});
G.__sheet = c.toDataURL('image/png');
// кадры анимаций рядом — проверить глазами
{
  const an = [...POST_EMOJI, ...REWARD_EMOJI].filter((e) => e.anim);
  const { c: s, g: h } = canvas(8 * 90, an.length * 90);
  h.fillStyle = '#17212b';
  h.fillRect(0, 0, s.width, s.height);
  an.forEach((e, j) => {
    for (let i = 0; i < 8; i++) {
      const ic = postEmojiIcon(e, (i * POST_EMOJI_MS) / 8);
      h.drawImage(ic, i * 90 + 5, j * 90 + 5, ic.width * 4, ic.height * 4);
    }
  });
  (G as unknown as { __frames: string }).__frames = s.toDataURL('image/png');
}
