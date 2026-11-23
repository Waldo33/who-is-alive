/**
 * Клипы «Лучший момент» для Telegram: телефон грузит готовый клип сюда (Москва — быстро),
 * а дальше все берут его по ссылке: Telegram на телефоне (сторис, «Сохранить») и сервер Telegram
 * (видео-карточка в чат; до Москвы он достаёт — проверено 23.11.2026, `infra/game/tg-reach.py`).
 *
 *   POST /v1/clips              — тело: видео (mp4/webm, до 12 МБ), Bearer-токен игрока → { id, ext }
 *   POST /v1/clips/<id>/thumb   — обложка JPEG (до 400 КБ)
 *   GET  /v1/clips/<id>.<ext>   — файл (mp4 | webm | jpg)
 *
 * Хранится 2 суток под случайным именем, папка не больше 1 ГБ (сначала уходят старые).
 * Тело пишется на диск потоком — в памяти 1-гигабайтного сервера не копится.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const CLIP_MAX = 12 * 1024 * 1024;
export const THUMB_MAX = 400 * 1024;
const CLIP_TTL_MS = 48 * 3600_000;
export const CLIPS_DIR_MAX = 1024 * 1024 * 1024;
const DIR_MAX = CLIPS_DIR_MAX;
/** Загрузок клипов на игрока: не больше 12 за 10 минут. */
const PER_USER = 12;
const PER_USER_MS = 600_000;

export const CLIP_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg' };
export const CLIP_ID = /^[0-9a-f]{20}$/;

export type ClipResult = { status: number; body: unknown };

export class ClipStore {
  readonly dir: string;
  private readonly uploads = new Map<string, number[]>();
  private usageCache: { at: number; v: { bytes: number; count: number } } | null = null;

  constructor(dir?: string, private readonly now: () => number = Date.now) {
    this.dir = dir ?? join(tmpdir(), 'massovka-clips');
  }

  /** Клип из тела запроса. */
  async upload(user: string, req: IncomingMessage): Promise<ClipResult> {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const ext = type === 'video/mp4' ? 'mp4' : type === 'video/webm' ? 'webm' : null;
    if (!ext) return { status: 400, body: { error: 'bad_clip' } };
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > CLIP_MAX) return { status: 413, body: { error: 'too_big' } };
    if (!this.rateOk(user)) return { status: 429, body: { error: 'rate_limited' } };
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    const id = randomBytes(10).toString('hex');
    const size = await this.save(req, join(this.dir, `${id}.${ext}`), CLIP_MAX);
    if (size < 1000) {
      await rm(join(this.dir, `${id}.${ext}`), { force: true });
      return { status: size < 0 ? 413 : 400, body: { error: size < 0 ? 'too_big' : 'bad_clip' } };
    }
    return { status: 200, body: { id, ext } };
  }

  /** Обложка к уже загруженному клипу. */
  async thumb(id: string, req: IncomingMessage): Promise<ClipResult> {
    if (!(await this.file(id, 'mp4')) && !(await this.file(id, 'webm'))) return { status: 404, body: { error: 'no_clip' } };
    const path = join(this.dir, `${id}.jpg`);
    const size = await this.save(req, path, THUMB_MAX, (head) => head[0] === 0xff && head[1] === 0xd8);
    if (size <= 0) {
      await rm(path, { force: true });
      return { status: 400, body: { error: 'bad_thumb' } };
    }
    return { status: 200, body: { ok: true } };
  }

  /** Путь к файлу клипа или null. */
  async file(id: string, ext: string): Promise<string | null> {
    if (!CLIP_ID.test(id) || !CLIP_MIME[ext]) return null;
    const path = join(this.dir, `${id}.${ext}`);
    const st = await stat(path).catch(() => null);
    return st?.isFile() ? path : null;
  }

  /** Сколько занято (для /metrics и тревоги «место под клипы»): раз в минуту, не чаще. */
  async usage(): Promise<{ bytes: number; count: number; limit: number }> {
    const now = this.now();
    if (!this.usageCache || now - this.usageCache.at > 60_000) {
      let bytes = 0;
      let count = 0;
      for (const name of await readdir(this.dir).catch(() => [] as string[])) {
        const st = await stat(join(this.dir, name)).catch(() => null);
        if (!st?.isFile()) continue;
        bytes += st.size;
        if (!name.endsWith('.jpg')) count++;
      }
      this.usageCache = { at: now, v: { bytes, count } };
    }
    return { ...this.usageCache.v, limit: DIR_MAX };
  }

  private rateOk(user: string): boolean {
    const now = this.now();
    const list = (this.uploads.get(user) ?? []).filter((t) => now - t < PER_USER_MS);
    if (list.length >= PER_USER) return false;
    list.push(now);
    this.uploads.set(user, list);
    if (this.uploads.size > 10_000) this.uploads.clear();
    return true;
  }

  /** Поток тела → файл. Размер, -1 — больше limit, 0 — не прошло проверку начала файла. */
  private async save(req: IncomingMessage, path: string, limit: number, headOk?: (head: Buffer) => boolean): Promise<number> {
    let size = 0;
    let bad = false;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (size === 0 && headOk && !headOk(chunk)) {
          bad = true;
          return cb(new Error('bad_head'));
        }
        size += chunk.length;
        if (size > limit) return cb(new Error('too_big'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, guard, createWriteStream(path));
      return size;
    } catch {
      return bad ? 0 : size > limit ? -1 : 0;
    }
  }

  /** Убрать клипы старше двух суток; папка больше 1 ГБ — сначала самые старые. */
  async sweep(): Promise<void> {
    const files: { path: string; t: number; size: number }[] = [];
    try {
      for (const name of await readdir(this.dir)) {
        const path = join(this.dir, name);
        const st = await stat(path).catch(() => null);
        if (st?.isFile()) files.push({ path, t: st.mtimeMs, size: st.size });
      }
    } catch {
      return;
    }
    files.sort((a, b) => a.t - b.t);
    let total = files.reduce((n, f) => n + f.size, 0);
    const now = this.now();
    for (const f of files) {
      if (now - f.t < CLIP_TTL_MS && total < DIR_MAX) break;
      await rm(f.path, { force: true });
      total -= f.size;
    }
  }
}
