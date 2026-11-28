import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BADGE_IDS, badgeEmoji } from '@kto/game-core';
import type { BadgeId } from '@kto/game-core';
import { errFields } from './log';
import type { Logger } from './log';

/**
 * Значки для эмодзи-статуса (game-core/badges.ts): один общий набор эмодзи у бота — `massovka_badges_by_<бот>`.
 * Картинки 100×100 PNG — `apps/server/stickers/badges/<id>.png`, анимированные (значки-слоты) — `<id>.webm` (видео-эмодзи) (`pnpm --filter web badges`, едут с выкладкой
 * вместе со стикерами). Значок в наборе бот узнаёт по эмодзи. Ставит его в статус сам игрок из Mini App
 * (`WebApp.setEmojiStatus` по id эмодзи) — бот только держит набор и отдаёт id.
 *
 * Владелец набора в Telegram — человек (так требует createNewStickerSet): BADGES_OWNER или создатель чата
 * поддержки (getChatAdministrators), то есть владелец игры. Набор создаётся при первом заходе в гардероб и
 * дополняется новыми значками (новый скин) сам; не вышло — повтор не чаще раза в 10 минут.
 */
export interface EmojiSetDeps {
  api<R = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<R>;
  username(): Promise<string>;
  log: Logger;
  /** Папка с картинками: <id>.png. */
  dir: string;
  /** Чат поддержки: его создатель — владелец набора, если owner не задан. */
  supportChat: string;
  owner?: number;
  now?: () => number;
}

interface TgSticker {
  emoji?: string;
  custom_emoji_id?: string;
  file_id?: string;
  is_video?: boolean;
}

/** Какой набор: имя `<prefix>_by_<бот>`, заголовок, состав и эмодзи, по которому бот узнаёт свою картинку. */
export interface EmojiSetSpec<Id extends string> {
  prefix: string;
  title: string;
  ids(): readonly Id[];
  emoji(id: Id): string;
}

const RETRY_MS = 10 * 60_000;
const bare = (e: string | undefined) => (e ?? '').replace(/️/g, '');

/**
 * Набор custom emoji у бота из картинок папки `dir` (<id>.png или <id>.webm): создать, дополнить новыми,
 * картинку, ставшую анимацией, заменить. Его используют значки статуса (BadgeSet) и эмодзи для постов
 * канала (emoji-set.ts).
 */
export class EmojiSet<Id extends string> {
  private cache: Partial<Record<Id, string>> = {};
  /** Значок стал анимированным (появился <id>.webm), а в наборе ещё картинка: заменить (id → file_id картинки). */
  private stale = new Map<Id, string>();
  private busy: Promise<void> | null = null;
  private lastTry = -Infinity;
  private owner: number | undefined;

  constructor(
    protected readonly d: EmojiSetDeps,
    private readonly spec: EmojiSetSpec<Id>,
  ) {
    this.owner = d.owner;
  }

  /** id эмодзи значков, что уже есть в наборе. Чего-то нет — в фоне доделать набор. */
  ids(): Partial<Record<Id, string>> {
    if (this.spec.ids().some((id) => !this.cache[id]) || this.stale.size) this.kick();
    return { ...this.cache };
  }

  /** Доделать набор, если не занят и не пробовали недавно. Ждать — `await kick()`. */
  kick(): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    if (this.busy) return this.busy;
    if (now - this.lastTry < RETRY_MS) return Promise.resolve();
    this.lastTry = now;
    this.busy = this.sync()
      .catch((e) => this.d.log('warn', 'emoji_set_sync', { prefix: this.spec.prefix, ...errFields(e) }))
      .finally(() => {
        this.busy = null;
      });
    return this.busy;
  }

  async name(): Promise<string> {
    return `${this.spec.prefix}_by_${await this.d.username()}`;
  }

  /** Набор в Telegram: null — его ещё нет. */
  private async read(name: string): Promise<TgSticker[] | null> {
    try {
      const set = await this.d.api<{ stickers?: TgSticker[] }>('getStickerSet', { name });
      return set?.stickers ?? [];
    } catch (e) {
      if (/STICKERSET_INVALID|not found/i.test(String(e))) return null;
      throw e;
    }
  }

  /** Есть видео — значок анимированный (видео-эмодзи WEBM), иначе картинка PNG. */
  private video(id: Id): boolean {
    return existsSync(join(this.d.dir, `${id}.webm`));
  }

  private remember(list: TgSticker[]): void {
    this.stale.clear();
    for (const id of this.spec.ids()) {
      const s = list.find((x) => bare(x.emoji) === bare(this.spec.emoji(id)) && x.custom_emoji_id);
      if (s?.custom_emoji_id) this.cache[id] = s.custom_emoji_id;
      if (s?.file_id && !s.is_video && this.video(id)) this.stale.set(id, s.file_id);
    }
  }

  private async ownerId(): Promise<number> {
    if (this.owner) return this.owner;
    const admins = await this.d.api<{ status: string; user: { id: number } }[]>('getChatAdministrators', { chat_id: this.d.supportChat });
    const creator = admins.find((a) => a.status === 'creator');
    if (!creator) throw new Error('badges: no owner');
    this.owner = creator.user.id;
    return this.owner;
  }

  private async sync(): Promise<void> {
    const name = await this.name();
    let list = await this.read(name);
    if (list) this.remember(list);
    const missing = this.spec.ids().filter((id) => !this.cache[id]);
    if (!missing.length && !this.stale.size) return;
    const owner = await this.ownerId();
    const video = (id: Id) => this.video(id);
    const input = (id: Id, i: number) => ({ sticker: `attach://f${i}`, format: video(id) ? 'video' : 'static', emoji_list: [this.spec.emoji(id)] });
    const ext = (id: Id) => (video(id) ? 'webm' : 'png');
    const file = async (id: Id) =>
      new Blob([new Uint8Array(await readFile(join(this.d.dir, `${id}.${ext(id)}`)))], { type: video(id) ? 'video/webm' : 'image/png' });
    if (!list) {
      const form = new FormData();
      form.set('user_id', String(owner));
      form.set('name', name);
      form.set('title', `${this.spec.title} · @${await this.d.username()}`.slice(0, 64));
      form.set('sticker_type', 'custom_emoji');
      form.set('stickers', JSON.stringify(missing.map(input)));
      for (const [i, id] of missing.entries()) form.set(`f${i}`, await file(id), `${id}.${ext(id)}`);
      await this.d.api('createNewStickerSet', form);
      this.d.log('info', 'emoji_set_created', { name, n: missing.length });
    } else {
      for (const id of missing) {
        const form = new FormData();
        form.set('user_id', String(owner));
        form.set('name', name);
        form.set('sticker', JSON.stringify(input(id, 0)));
        form.set('f0', await file(id), `${id}.${ext(id)}`);
        await this.d.api('addStickerToSet', form);
        this.d.log('info', 'emoji_set_added', { name, id });
      }
      // значок стал анимированным: картинку в наборе меняем на видео (id эмодзи у Telegram при этом новый)
      for (const [id, old] of [...this.stale]) {
        const form = new FormData();
        form.set('user_id', String(owner));
        form.set('name', name);
        form.set('old_sticker', old);
        form.set('sticker', JSON.stringify(input(id, 0)));
        form.set('f0', await file(id), `${id}.${ext(id)}`);
        await this.d.api('replaceStickerInSet', form);
        this.d.log('info', 'emoji_set_replaced', { name, id });
      }
    }
    list = await this.read(name);
    if (list) this.remember(list);
  }
}

/** Значки для статуса: `massovka_badges_by_<бот>`. */
export type BadgeSetDeps = EmojiSetDeps;
export class BadgeSet extends EmojiSet<BadgeId> {
  constructor(d: EmojiSetDeps) {
    super(d, { prefix: 'massovka_badges', title: 'Массовка · значки', ids: () => BADGE_IDS, emoji: badgeEmoji });
  }
}
