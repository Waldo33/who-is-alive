/**
 * Свой стикер игрока («Собери свой стикерпак», shop.ts) — видео WEBM для Telegram: тот же рисунок, что превью
 * на телефоне (apps/web/src/game/skins/my-sticker.ts), 20 кадров 512×512, VP9 с прозрачностью, ≤ 256 КБ —
 * как у стикеров пака (`pnpm --filter web stickers`). Картинок с телефона не принимаем: телефон присылает только
 * выбор (фигурка, поза, цвет, подпись), рисует сервер.
 *
 * Рисование — в отдельном коротком процессе (film-worker.ts --sticker → sticker-draw.ts): холсты Skia и ffmpeg не мешают матчам.
 * По одному за раз, очередь короткая; сервер бота без ffmpeg просит игровой (/internal/sticker по туннелю).
 */
import { fork } from 'node:child_process';
import { MY_COLORS, isEffect, isMySticker, isStickerId } from '@kto/game-core';
import type { EffectId, Lang, MySticker, StickerId } from '@kto/game-core';
import { workerPath } from './film';
import type { Logger } from './log';

export type MyLook = Pick<MySticker, 'fig' | 'pose' | 'color' | 'text' | 'top' | 'fx'>;
/** Стандартный стикер пака с эффектом (товар «Эффекты»): файлы без эффекта лежат готовыми, с эффектом — рисуем. */
export type StdLook = { std: StickerId; fx: EffectId | null; color?: number | null; lang: Lang };
export type StickerJob = MyLook | StdLook;

/** Задача процессу рисования и его ответ. */
export type StickerMsg = { look: StickerJob; fonts: string; ffmpeg?: string };
export type StickerReply = { ok: true; webm: Buffer } | { ok: false; err: string };

export interface StickerRenderOpts {
  fonts: string;
  ffmpeg?: string;
  log: Logger;
  /** Сколько ждать один стикер, мс. */
  timeoutMs?: number;
}

/** Очередь рисования своих стикеров на игровом сервере: по одному, в ожидании — не больше 4. */
export class StickerRender {
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly o: StickerRenderOpts) {}

  render(look: unknown): Promise<Buffer> {
    let clean: StickerJob;
    const s = look as Partial<StdLook> | null;
    if (s && typeof s === 'object' && 'std' in s) {
      const color = s.color ?? null;
      const colorOk = color === null || (Number.isInteger(color) && color >= 0 && color < MY_COLORS.length);
      if (!isStickerId(s.std) || !(s.fx === null || isEffect(s.fx)) || !colorOk || (s.fx === null && color === null) || (s.lang !== 'ru' && s.lang !== 'en')) return Promise.reject(new Error('bad_sticker'));
      clean = { std: s.std, fx: s.fx, color, lang: s.lang };
    } else {
      const v = { ...(look as MyLook), slot: 0, rev: 0 };
      if (!isMySticker(v)) return Promise.reject(new Error('bad_sticker'));
      clean = { fig: v.fig, pose: v.pose, color: v.color, text: [...v.text], ...(v.top ? { top: v.top } : {}), ...(v.fx ? { fx: v.fx } : {}) };
    }
    if (this.waiting >= 4) return Promise.reject(new Error('busy'));
    this.waiting++;
    const p = this.chain.then(() => this.once(clean)).finally(() => this.waiting--);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private once(look: StickerJob): Promise<Buffer> {
    const w = workerPath();
    const t0 = Date.now();
    return new Promise((ok, fail) => {
      const child = fork(w.path, ['--sticker'], { execArgv: w.execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new Error('sticker_timeout'));
      }, this.o.timeoutMs ?? 30_000);
      child.once('message', (m: StickerReply) => {
        clearTimeout(timer);
        child.kill();
        if (m.ok) {
          this.o.log('info', 'sticker_rendered', { ms: Date.now() - t0, kb: Math.round(m.webm.length / 1024) });
          ok(Buffer.from(m.webm));
        } else fail(new Error(m.err));
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`sticker_worker_exit ${code}`));
      });
      child.send({ look, fonts: this.o.fonts, ffmpeg: this.o.ffmpeg } satisfies StickerMsg);
    });
  }
}
