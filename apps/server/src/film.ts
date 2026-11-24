/**
 * «Фильм матча» на сервере: дубли копит MatchRunner (room.ts), в конце матча комната ставит задачу сюда.
 * Монтаж — в отдельном процессе (film-worker.ts → film-render.ts), по одному за раз, с низким приоритетом;
 * готовый mp4 и обложка ложатся в хранилище клипов (clips.ts) и раздаются по /v1/clips/<id>.mp4 —
 * их сразу берут и «Поделиться», и Telegram (сторис, видео-карточка) без загрузки с телефона.
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClipStore } from './clips';
import type { MatchRecordings } from './recordings';
import type { FilmJob, FilmRendered } from './film-render';
import type { Logger } from './log';

export type { FilmJob } from './film-render';

export interface FilmDone {
  id: string;
  ext: 'mp4';
  thumb: boolean;
  ms: number;
}

export interface FilmServiceOptions {
  store: ClipStore;
  /** Адрес сайта в ролике и ссылка в QR: benobody.app. */
  site: string;
  log: Logger;
  /** Папка со шрифтами для титров (Press Start 2P, woff). */
  fonts: string;
  ffmpeg?: string;
  /** Не больше стольких задач в очереди; лишние — отказ (клиент смонтирует сам). */
  maxQueue?: number;
  timeoutMs?: number;
  /** Куда сохранять записи матчей (для перемонтажа); нет — не сохранять. */
  recordings?: MatchRecordings;
}

/** Где лежит процесс монтажа: рядом со сборкой (dist/film-worker.mjs) или исходник под tsx (dev, тесты). */
function workerPath(): { path: string; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  if (here.endsWith('.ts')) return { path: join(dir, 'film-worker.ts'), execArgv: ['--import', 'tsx'] };
  return { path: join(dir, 'film-worker.mjs'), execArgv: [] };
}

/**
 * Нативный модуль монтажа (apps/server/native, собирает game-deploy) — рядом с процессом монтажа.
 * FILM_RENDERER=skia — принудительно прежний путь.
 */
export function nativePath(): string | undefined {
  if (process.env.FILM_RENDERER === 'skia') return undefined;
  const p = join(dirname(workerPath().path), 'massovka-film.node');
  return existsSync(p) ? p : undefined;
}

export class FilmService {
  private queue: { job: FilmJob; done: (r: FilmDone | null) => void }[] = [];
  private busy = false;
  made = 0;
  failed = 0;
  lastMs = 0;

  constructor(private readonly o: FilmServiceOptions) {}

  get queued(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  /** Смонтировать фильм. null — не вышло (или очередь полна): клиент смонтирует сам. */
  make(req: Omit<FilmJob, 'site' | 'link'>): Promise<FilmDone | null> {
    const job: FilmJob = { ...req, site: this.o.site, link: `https://${this.o.site}/?src=film&l=${req.lang}` };
    // запись матча — даже если фильм не смонтируется: по ней его можно смонтировать потом
    this.o.recordings
      ?.save(job)
      .then((name) => this.o.log('info', 'match_recorded', { name }))
      .catch((e: unknown) => this.o.log('warn', 'match_record_failed', { err: String(e).slice(0, 300) }));
    if (this.queue.length >= (this.o.maxQueue ?? 4)) {
      this.o.log('warn', 'film_queue_full', { queued: this.queued });
      return Promise.resolve(null);
    }
    return new Promise((done) => {
      this.queue.push({ job, done });
      void this.next();
    });
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const task = this.queue.shift();
    if (!task) return;
    this.busy = true;
    const t0 = Date.now();
    let res: FilmDone | null = null;
    try {
      const preset = 'ultrafast';
      // монтаж на Rust (massovka-film.node рядом с процессом монтажа); не вышел — прежний путь через Skia
      const native = nativePath();
      let renderer = native ? 'rust' : 'skia';
      let r: FilmRendered | null;
      try {
        r = await this.render(task.job, preset, native);
      } catch (e) {
        if (!native) throw e;
        this.o.log('warn', 'film_native_failed', { err: String(e).slice(0, 600) });
        renderer = 'skia';
        r = await this.render(task.job, preset, undefined);
      }
      if (r) {
        const saved = await this.o.store.adopt(r.video, 'mp4', r.thumb);
        res = { ...saved, ext: 'mp4', ms: Date.now() - t0 };
        this.made++;
        this.lastMs = res.ms;
        this.o.log('info', 'film_made', { ms: res.ms, render: r.renderMs, dur: r.durationMs, preset, renderer, queued: this.queue.length });
      }
    } catch (e) {
      this.failed++;
      this.o.log('error', 'film_failed', { err: String(e).slice(0, 600) });
    }
    this.busy = false;
    task.done(res);
    void this.next();
  }

  private render(job: FilmJob, preset: string, native: string | undefined): Promise<FilmRendered | null> {
    const w = workerPath();
    if (!existsSync(w.path)) return Promise.reject(new Error(`нет ${w.path}`));
    return new Promise((resolve, reject) => {
      const child = fork(w.path, [], { execArgv: w.execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      try {
        if (child.pid) setPriority(child.pid, 15);
      } catch {
        // не дали понизить приоритет — монтаж всё равно идёт
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, this.o.timeoutMs ?? 90_000);
      child.once('message', (m: { ok: true; r: FilmRendered | null } | { ok: false; err: string }) => {
        clearTimeout(timer);
        if (m.ok) resolve(m.r ? { ...m.r, thumb: Buffer.from(m.r.thumb) } : null);
        else reject(new Error(m.err));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`монтаж завершился: ${code}`));
      });
      child.send({ job, opts: { fonts: this.o.fonts, tmp: this.o.store.dir, ffmpeg: this.o.ffmpeg, preset, native } });
    });
  }
}
