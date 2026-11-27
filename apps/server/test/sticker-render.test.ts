import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EFFECTS } from '@kto/game-core';
import { silentLogger } from '../src/log';
import { StickerRender } from '../src/sticker-render';

/** Свой стикер игрока рисует сервер (тем же кодом, что превью на телефоне): WEBM VP9 512×512 ≤ 256 КБ. */

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const FONTS = join(import.meta.dirname, '..', '..', 'web', 'assets', 'og');

describe('свой стикер на сервере', () => {
  it.skipIf(!hasFfmpeg)('герой площадки с подписью — видеостикер для Telegram', async () => {
    const r = new StickerRender({ fonts: FONTS, log: silentLogger });
    const webm = await r.render({ fig: 'office', pose: 'dance', color: 1, text: ['Это мой', 'дубль 42'] });
    // EBML — заголовок WEBM
    expect(webm.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(webm.length).toBeLessThanOrEqual(256 * 1024);
    // картинок и чужого текста не рисуем: только проверенный выбор
    await expect(r.render({ fig: 'actor', pose: 'wave', color: 0, text: ['@spam'] })).rejects.toThrow('bad_sticker');
  }, 60_000);

  it.skipIf(!hasFfmpeg)('эффекты: стандартный стикер пака и свой — с эффектом, у каждого эффекта влезает в 256 КБ', async () => {
    const r = new StickerRender({ fonts: FONTS, log: silentLogger });
    for (const fx of EFFECTS) {
      const webm = await r.render({ std: 'aaa', fx, lang: 'ru' });
      expect(webm.subarray(0, 4).toString('hex'), fx).toBe('1a45dfa3');
      expect(webm.length, fx).toBeLessThanOrEqual(256 * 1024);
    }
    expect((await r.render({ fig: 'kotBanan', pose: 'ask', color: 2, text: ['Эй'], fx: 'fire' })).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    await expect(r.render({ std: 'aaa', fx: 'glitter', lang: 'ru' })).rejects.toThrow('bad_sticker');
    await expect(r.render({ std: 'nope', fx: 'holo', lang: 'ru' })).rejects.toThrow('bad_sticker');
  }, 240_000);
});
