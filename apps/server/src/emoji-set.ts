import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmojiSet } from './badges';
import type { EmojiSetDeps } from './badges';

/**
 * Эмодзи для постов канала (решение владельца 28.11.2026): свой набор custom emoji `massovka_emoji_by_<бот>`,
 * чтобы писать посты пиксельными эмодзи игры вместо стандартных. Картинки и список (`list.json`: id и эмодзи) —
 * `apps/server/stickers/emoji` (`pnpm --filter web post-emoji`, рисует `apps/web/src/game/skins/post-emoji.ts`).
 * Бот собирает набор по команде `/emoji` в личке — только владельцу игры (тот же человек, что владеет набором),
 * и отвечает ссылкой на добавление; новый рисунок в папке — следующий `/emoji` его доложит. Сам набор Telegram
 * закрыть не даёт: по ссылке его может добавить любой, поэтому ссылку никто, кроме владельца, не получает.
 */
interface Item {
  id: string;
  emoji: string;
}

export class PostEmojiSet extends EmojiSet<string> {
  constructor(d: EmojiSetDeps) {
    let list: Item[] | null = null;
    const read = (): Item[] => {
      if (list) return list;
      const f = join(d.dir, 'list.json');
      list = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Item[]) : [];
      return list;
    };
    super(d, {
      prefix: 'massovka_emoji',
      title: 'Массовка · эмодзи',
      ids: () => read().map((x) => x.id),
      emoji: (id) => read().find((x) => x.id === id)?.emoji ?? '🎬',
    });
  }

  /** Ссылка «добавить набор» в Telegram. */
  async link(): Promise<string> {
    return `https://t.me/addemoji/${await this.name()}`;
  }
}
