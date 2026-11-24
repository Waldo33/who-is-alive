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
import type { ClipJob, FilmJob, FilmRendered } from './film-render';
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

/** Клип выбывшего ждёт не дольше: дольше — телефон смонтирует сам (у него ~13–16 с). */
const CLIP_MAX_WAIT_MS = 8000;

type Task =
  | { kind: 'film'; job: FilmJob; done: (r: FilmDone | null) => void }
  | { kind: 'clip'; job: ClipJob; done: (r: FilmDone | null) => void };

export class FilmService {
  private queue: Task[] = [];
  private busy: { kind: Task['kind']; since: number } | null = null;
  made = 0;
  failed = 0;
  lastMs = 0;
  clipsMade = 0;
  clipsFailed = 0;
  clipsRejected = 0;
  lastClipMs = 0;
  /** Сколько обычно монтируется (скользящее среднее, мс): для оценки очереди. */
  private est = { film: 15_000, clip: 6_000 };

  constructor(private readonly o: FilmServiceOptions) {}

  get queued(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  /** Через сколько мс начнётся новый клип: текущая задача + клипы в очереди (фильмы встают после клипов). */
  clipWait(now = Date.now()): number {
    const cur = this.busy ? Math.max(0, this.est[this.busy.kind] - (now - this.busy.since)) : 0;
    return cur + this.queue.filter((t) => t.kind === 'clip').length * this.est.clip;
  }

  /**
   * Смонтировать клип выбывшего. null сразу — очередь длинная (телефон смонтирует быстрее сам),
   * иначе onQueued(eta, мс до готовности) и обещание с клипом (null — не вышло).
   */
  clip(req: Omit<ClipJob, 'site' | 'link'>, onQueued?: (etaMs: number) => void): Promise<FilmDone | null> | null {
    const wait = this.clipWait();
    if (wait > CLIP_MAX_WAIT_MS) {
      this.clipsRejected++;
      this.o.log('info', 'clip_busy', { wait, queued: this.queued });
      return null;
    }
    const job: ClipJob = { ...req, site: this.o.site, link: `https://${this.o.site}/?src=clip&l=${req.lang}` };
    onQueued?.(wait + this.est.clip);
    return new Promise((done) => {
      // клип ждёт игрок прямо сейчас — вперёд фильмов (фильм монтируется, пока идут итоги)
      const i = this.queue.findIndex((t) => t.kind === 'film');
      const task: Task = { kind: 'clip', job, done };
      if (i < 0) this.queue.push(task);
      else this.queue.splice(i, 0, task);
      void this.next();
    });
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
      this.queue.push({ kind: 'film', job, done });
      void this.next();
    });
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    const task = this.queue.shift();
    if (!task) return;
    const t0 = Date.now();
    this.busy = { kind: task.kind, since: t0 };
    const res = task.kind === 'film' ? await this.makeFilm(task.job, t0) : await this.makeClip(task.job, t0);
    if (res) this.est[task.kind] = Math.round(this.est[task.kind] * 0.7 + res.ms * 0.3);
    this.busy = null;
    task.done(res);
    void this.next();
  }

  /** Rust, а при сбое — ещё раз на Skia (модуль не загрузился, упал): фильм всё равно будет. */
  private async renderAny(kind: 'film' | 'clip', job: FilmJob | ClipJob, preset: string): Promise<{ r: FilmRendered | null; renderer: string }> {
    const native = nativePath();
    if (native) {
      try {
        return { r: await this.render(kind, job, preset, native), renderer: 'rust' };
      } catch (e) {
        this.o.log('warn', 'film_native_failed', { kind, err: String(e).slice(0, 600) });
      }
    }
    return { r: await this.render(kind, job, preset), renderer: 'skia' };
  }

  private async makeFilm(job: FilmJob, t0: number): Promise<FilmDone | null> {
    try {
      const preset = 'ultrafast';
      const { r, renderer } = await this.renderAny('film', job, preset);
      if (!r) return null;
      const saved = await this.o.store.adopt(r.video, 'mp4', r.thumb);
      const res: FilmDone = { ...saved, ext: 'mp4', ms: Date.now() - t0 };
      this.made++;
      this.lastMs = res.ms;
      this.o.log('info', 'film_made', { ms: res.ms, render: r.renderMs, dur: r.durationMs, preset, renderer, queued: this.queue.length });
      return res;
    } catch (e) {
      this.failed++;
      this.o.log('error', 'film_failed', { err: String(e).slice(0, 600) });
      return null;
    }
  }

  private async makeClip(job: ClipJob, t0: number): Promise<FilmDone | null> {
    try {
      const { r, renderer } = await this.renderAny('clip', job, 'ultrafast');
      if (!r) return null;
      const saved = await this.o.store.adopt(r.video, 'mp4', r.thumb);
      const res: FilmDone = { ...saved, ext: 'mp4', ms: Date.now() - t0 };
      this.clipsMade++;
      this.lastClipMs = res.ms;
      this.o.log('info', 'clip_made', { ms: res.ms, render: r.renderMs, dur: r.durationMs, renderer, known: job.known, queued: this.queue.length });
      return res;
    } catch (e) {
      this.clipsFailed++;
      this.o.log('error', 'clip_failed', { err: String(e).slice(0, 600) });
      return null;
    }
  }

  private render(kind: 'film' | 'clip', job: FilmJob | ClipJob, preset: string, native?: string): Promise<FilmRendered | null> {
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
      }, kind === 'clip' ? 45_000 : (this.o.timeoutMs ?? 90_000));
      child.once('message', (m: { ok: true; r: FilmRendered | null } | { ok: false; err: string }) => {
        clearTimeout(timer);
        if (m.ok) resolve(m.r ? { ...m.r, thumb: Buffer.from(m.r.thumb) } : null);
        else reject(new Error(m.err));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`монтаж завершился: ${code}`));
      });
      child.send({ [kind === 'clip' ? 'clip' : 'job']: job, opts: { fonts: this.o.fonts, tmp: this.o.store.dir, ffmpeg: this.o.ffmpeg, preset, native } });
    });
  }
}
