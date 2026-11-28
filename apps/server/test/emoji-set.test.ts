import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostEmojiSet } from '../src/emoji-set';
import { silentLogger } from '../src/log';

/** Эмодзи для постов канала: набор `massovka_emoji_by_<бот>` из apps/server/stickers/emoji (emoji-set.ts). */

const DIR = join(import.meta.dirname, '..', 'stickers', 'emoji');
const LIST = JSON.parse(readFileSync(join(DIR, 'list.json'), 'utf8')) as { id: string; emoji: string }[];
const bare = (e: string) => e.replace(/️/g, '');

function fakeApi() {
  const calls: { method: string; body: Record<string, unknown>; files: string[] }[] = [];
  let set: { emoji: string; custom_emoji_id: string }[] | null = null;
  let n = 0;
  const api = async <R>(method: string, body: Record<string, unknown> | FormData): Promise<R> => {
    const b: Record<string, unknown> = {};
    const files: string[] = [];
    if (body instanceof FormData) {
      for (const [k, v] of body.entries()) {
        if (typeof v === 'string') b[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        else files.push((v as File).name);
      }
    } else Object.assign(b, body);
    calls.push({ method, body: b, files });
    if (method === 'getStickerSet') {
      if (!set) throw new Error('getStickerSet: Bad Request: STICKERSET_INVALID');
      return { stickers: set } as R;
    }
    if (method === 'createNewStickerSet') set = (b.stickers as { emoji_list: string[] }[]).map((s) => ({ emoji: s.emoji_list[0]!, custom_emoji_id: `ce${++n}` }));
    return true as R;
  };
  return { api, calls };
}

describe('эмодзи для постов', () => {
  it('в списке есть картинки, у каждого эмодзи — свой (по нему бот узнаёт картинку), не те, что у значков', () => {
    expect(LIST.length).toBeGreaterThanOrEqual(20);
    expect(new Set(LIST.map((x) => bare(x.emoji))).size).toBe(LIST.length);
    const badges = readFileSync(join(import.meta.dirname, '..', '..', '..', 'packages', 'game-core', 'src', 'badges.ts'), 'utf8');
    for (const x of LIST) expect(badges.includes(`emoji: '${x.emoji}'`), x.id).toBe(false);
  });

  it('набора нет — бот создаёт его целиком, анимированные — видео, и отдаёт ссылку на добавление', async () => {
    const { api, calls } = fakeApi();
    const s = new PostEmojiSet({ api, username: async () => 'be_nobody_bot', log: silentLogger, dir: DIR, supportChat: '-1', owner: 42, now: () => 0 });
    await s.kick();
    const made = calls.find((c) => c.method === 'createNewStickerSet')!;
    expect(made.body).toMatchObject({ user_id: '42', name: 'massovka_emoji_by_be_nobody_bot', sticker_type: 'custom_emoji' });
    expect(made.files).toHaveLength(LIST.length);
    expect(made.files).toContain('fire.webm');
    expect(made.files).toContain('camera.png');
    expect(Object.keys(s.ids())).toHaveLength(LIST.length);
    expect(await s.link()).toBe('https://t.me/addemoji/massovka_emoji_by_be_nobody_bot');
  });
});
