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
 *
 * Есть S3 (s3.ts, бакет из infra/terraform/storage.tf) — видео живёт там (`clips/<id>.<ext>`, бакет сам
 * удаляет через 2 суток), а GET отдаёт его с этого же адреса — сервер тянет файл из бакета потоком
 * (не 302: 26.11 Telegram не смог отправить карточку с фильмом по перенаправлению на подписанную ссылку):
 *   - фильм и клип выбывшего (монтаж на сервере, `adopt`) кладутся в S3 сразу, ссылка выдаётся после
 *     загрузки, на диске копии не остаётся;
 *   - клип с телефона: POST /v1/clips/direct { ext, size } → { id, ext, put } — телефон кладёт файл в бакет
 *     сам, по подписанной ссылке PUT (тип и размер — в подписи); обложка — POST /v1/clips/<id>/thumb-url;
 *   - S3 не ответил — файл остаётся на диске и отдаётся отсюда, как без S3 (запасной путь, и POST /v1/clips
 *     для старых вкладок).
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { S3Client } from './s3';

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

/** Копия в S3: куда класть и как сообщать о сбоях. */
export interface ClipRemote {
  s3: S3Client;
  log?: (level: 'info' | 'warn' | 'error', msg: string, f?: Record<string, unknown>) => void;
}

/** Ссылка из S3 живёт столько же, сколько сам файл. */
export const REMOTE_URL_TTL_S = 48 * 3600;
/** Ссылка на загрузку с телефона: 10 минут хватит и медленной сети. */
export const REMOTE_PUT_TTL_S = 600;

export class ClipStore {
  readonly dir: string;
  private readonly uploads = new Map<string, number[]>();
  private usageCache: { at: number; v: { bytes: number; count: number } } | null = null;
  /** Что уже точно лежит в S3 (ключ → когда положили) — чтобы не спрашивать бакет на каждый GET. */
  private readonly inRemote = new Map<string, number>();
  /** Идущие загрузки в S3 (тесты ждут их через `flushRemote`). */
  private readonly pending = new Set<Promise<void>>();
  readonly remoteStats = { uploaded: 0, failed: 0, redirects: 0, direct: 0 };
  /** Клипы, которые телефон грузит прямо в S3: id → когда выдали ссылку (для обложки к нему). */
  private readonly issued = new Map<string, number>();
  /**
   * Чей клип: id → игрок, которому выдали id. Обложку меняет только он — id виден в каждой расшаренной
   * ссылке, и без этой проверки любой подменил бы обложку чужой видео-карточки (ревью безопасности, M2).
   * Только в памяти: после перезапуска обложку к старому клипу не поменять (её шлют сразу после клипа).
   */
  private readonly owners = new Map<string, { user: string; at: number }>();

  constructor(dir?: string, private readonly now: () => number = Date.now, private readonly remote?: ClipRemote) {
    this.dir = dir ?? join(tmpdir(), 'massovka-clips');
  }

  get hasRemote(): boolean {
    return !!this.remote;
  }

  /** Положить файл в S3; true — лежит там. Сбой S3 не ломает клип — он остаётся на диске, как раньше. */
  private async put(id: string, ext: string): Promise<boolean> {
    const r = this.remote;
    if (!r) return false;
    const key = `clips/${id}.${ext}`;
    try {
      await r.s3.putFile(key, join(this.dir, `${id}.${ext}`), CLIP_MIME[ext]);
    } catch (e) {
      this.remoteStats.failed++;
      r.log?.('warn', 's3_put_failed', { key, err: String(e).slice(0, 300) });
      return false;
    }
    this.inRemote.set(key, this.now());
    this.remoteStats.uploaded++;
    if (this.inRemote.size > 50_000) this.inRemote.clear();
    return true;
  }

  /** Копия в S3 в фоне (клип, пришедший с телефона через сервер): локальный файл остаётся. */
  private mirror(id: string, ext: string): void {
    if (!this.remote) return;
    const job = this.put(id, ext).then(() => undefined).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Положить в S3 и убрать с диска; не вышло — файл остаётся на диске и отдаётся отсюда. */
  private async moveToRemote(id: string, ext: string): Promise<void> {
    if (await this.put(id, ext)) await rm(join(this.dir, `${id}.${ext}`), { force: true });
  }

  /** Дождаться фоновых загрузок в S3 (тесты, остановка сервера). */
  async flushRemote(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /**
   * Подписанная ссылка на файл в S3 или null (S3 нет, файла там нет, бакет не ответил).
   * Локальной копии уже нет — сюда приходит GET /v1/clips/<id>.<ext>.
   */
  async remoteUrl(id: string, ext: string): Promise<string | null> {
    const r = this.remote;
    if (!r || !CLIP_ID.test(id) || !CLIP_MIME[ext]) return null;
    const key = `clips/${id}.${ext}`;
    const at = this.inRemote.get(key);
    if (at === undefined || this.now() - at > CLIP_TTL_MS) {
      const ok = await r.s3.has(key).catch((e: unknown) => {
        r.log?.('warn', 's3_head_failed', { key, err: String(e).slice(0, 300) });
        return false;
      });
      if (!ok) return null;
      this.inRemote.set(key, this.now());
    }
    this.remoteStats.redirects++;
    return r.s3.presignGet(key, REMOTE_URL_TTL_S, { disposition: `attachment; filename="massovka-${id.slice(0, 6)}.${ext}"` });
  }

  /**
   * Файл из S3 потоком (локальной копии нет): ответ бакета со статусом 200 или null (S3 нет, файла нет,
   * бакет не ответил). Отсюда его отдаёт GET /v1/clips/<id>.<ext> — для Telegram адрес тот же, что с диска.
   */
  async remoteOpen(id: string, ext: string, method: string): Promise<Response | null> {
    const r = this.remote;
    if (!r || !CLIP_ID.test(id) || !CLIP_MIME[ext]) return null;
    const key = `clips/${id}.${ext}`;
    try {
      const res = await r.s3.open(key, method === 'HEAD' ? 'HEAD' : 'GET');
      if (res.status === 200) {
        this.remoteStats.redirects++;
        return res;
      }
      await res.body?.cancel();
      if (res.status !== 404) r.log?.('warn', 's3_get_failed', { key, status: res.status });
    } catch (e) {
      r.log?.('warn', 's3_get_failed', { key, err: String(e).slice(0, 300) });
    }
    return null;
  }

  /**
   * Клип с телефона прямо в S3: выдать id и подписанную ссылку PUT (тип и размер — в подписи).
   * S3 нет — 404 `no_s3`: телефон грузит по-старому, POST /v1/clips.
   */
  direct(user: string, b: { ext?: unknown; size?: unknown } | null): ClipResult {
    const r = this.remote;
    if (!r) return { status: 404, body: { error: 'no_s3' } };
    const ext = b?.ext === 'mp4' || b?.ext === 'webm' ? b.ext : null;
    const size = typeof b?.size === 'number' && Number.isInteger(b.size) ? b.size : 0;
    if (!ext || size < 1000) return { status: 400, body: { error: 'bad_clip' } };
    if (size > CLIP_MAX) return { status: 413, body: { error: 'too_big' } };
    if (!this.rateOk(user)) return { status: 429, body: { error: 'rate_limited' } };
    const id = randomBytes(10).toString('hex');
    this.issued.set(id, this.now());
    this.own(id, user);
    if (this.issued.size > 20_000) for (const [k, t] of this.issued) if (this.now() - t > 3600_000) this.issued.delete(k);
    this.remoteStats.direct++;
    const put = r.s3.presignPut(`clips/${id}.${ext}`, REMOTE_PUT_TTL_S, { type: CLIP_MIME[ext], length: size });
    return { status: 200, body: { id, ext, put, type: CLIP_MIME[ext] } };
  }

  /** Запомнить автора клипа (держим час: обложка приходит сразу за клипом). */
  private own(id: string, user: string): void {
    this.owners.set(id, { user, at: this.now() });
    if (this.owners.size > 20_000) for (const [k, o] of this.owners) if (this.now() - o.at > 3600_000) this.owners.delete(k);
  }

  /** Клип этого игрока и выдан не больше часа назад. */
  private owns(id: string, user: string): boolean {
    const o = this.owners.get(id);
    return !!o && o.user === user && this.now() - o.at <= 3600_000;
  }

  /** Обложка к клипу, который телефон грузит прямо в S3: ссылка PUT на JPEG (выдаётся в течение часа, только автору). */
  directThumb(id: string, b: { size?: unknown } | null, user: string): ClipResult {
    const r = this.remote;
    const t = this.issued.get(id);
    if (!r || t === undefined || this.now() - t > 3600_000 || !this.owns(id, user)) return { status: 404, body: { error: 'no_clip' } };
    const size = typeof b?.size === 'number' && Number.isInteger(b.size) ? b.size : 0;
    if (size < 100 || size > THUMB_MAX) return { status: 400, body: { error: 'bad_thumb' } };
    return { status: 200, body: { put: r.s3.presignPut(`clips/${id}.jpg`, REMOTE_PUT_TTL_S, { type: 'image/jpeg', length: size }), type: 'image/jpeg' } };
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
    this.own(id, user);
    this.mirror(id, ext);
    return { status: 200, body: { id, ext } };
  }

  /**
   * Готовый файл с этого же сервера (фильм матча, film.ts): переложить в хранилище под случайным именем.
   * Файл уже лежит в этой папке (монтаж пишет сюда же — переименование без копирования).
   * Есть S3 — сначала в бакет, и только потом ответ (ссылка сразу ведёт в S3), копия с диска убирается.
   */
  async adopt(path: string, ext: 'mp4', thumb?: Buffer | null): Promise<{ id: string; thumb: boolean }> {
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    const id = randomBytes(10).toString('hex');
    await rename(path, join(this.dir, `${id}.${ext}`));
    let hasThumb = false;
    if (thumb && thumb.length <= THUMB_MAX) {
      await writeFile(join(this.dir, `${id}.jpg`), thumb);
      hasThumb = true;
    }
    await Promise.all([this.moveToRemote(id, ext), hasThumb ? this.moveToRemote(id, 'jpg') : null]);
    return { id, thumb: hasThumb };
  }

  /** Обложка к уже загруженному клипу (только автору). */
  async thumb(id: string, req: IncomingMessage, user: string): Promise<ClipResult> {
    if (!this.owns(id, user)) return { status: 404, body: { error: 'no_clip' } };
    if (!(await this.file(id, 'mp4')) && !(await this.file(id, 'webm'))) return { status: 404, body: { error: 'no_clip' } };
    const path = join(this.dir, `${id}.jpg`);
    const size = await this.save(req, path, THUMB_MAX, (head) => head[0] === 0xff && head[1] === 0xd8);
    if (size <= 0) {
      await rm(path, { force: true });
      return { status: 400, body: { error: 'bad_thumb' } };
    }
    this.mirror(id, 'jpg');
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
