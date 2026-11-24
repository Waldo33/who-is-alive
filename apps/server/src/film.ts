/**
 * «Фильм матча» на сервере: дубли копит MatchRunner (room.ts), в конце матча комната ставит задачу сюда.
 * Монтаж — в отдельном процессе (film-worker.ts → film-render.ts), по одному за раз, с низким приоритетом;
 * процесс живёт между задачами (прогревается в начале матча, гаснет после 10 минут простоя);
 * готовый mp4 и обложка ложатся в хранилище клипов (clips.ts) и раздаются по /v1/clips/<id>.mp4 —
 * их сразу берут и «Поделиться», и Telegram (сторис, видео-карточка) без загрузки с телефона.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClipStore } from './clips';
import type { MatchRecordings } from './recordings';
import type { ClipJob, FilmJob, FilmRenderOpts, FilmRendered } from './film-render';
import type { WorkerMsg } from './film-worker';
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
  /** Аварийный выключатель видео (video-switch.ts): false — не монтировать ничего. */
  enabled?: () => boolean;
  /** Сколько процесс монтажа живёт без задач, мс (по умолчанию 10 минут). */
  idleMs?: number;
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
/** Заготовку берём, только если монтаж свободен (или вот-вот освободится). */
const PRECLIP_MAX_WAIT_MS = 1500;

type Task = ({ kind: 'film'; job: FilmJob } | { kind: 'clip'; job: ClipJob; pre?: boolean }) & {
  done: (r: FilmDone | null) => void;
  p?: Promise<FilmDone | null>;
};

export class FilmService {
  private queue: Task[] = [];
  private busy: { kind: Task['kind']; since: number; p?: Promise<FilmDone | null> } | null = null;
  made = 0;
  failed = 0;
  lastMs = 0;
  clipsMade = 0;
  clipsFailed = 0;
  clipsRejected = 0;
  lastClipMs = 0;
  /** Заготовлено клипов (до нажатия «Клип»). */
  preclips = 0;
  /** Сколько раз запускали процесс монтажа (живёт между задачами — обычно раз на матч или реже). */
  workerStarts = 0;
  /** Сколько обычно монтируется (скользящее среднее, мс): для оценки очереди. */
  private est = { film: 15_000, clip: 6_000 };

  constructor(private readonly o: FilmServiceOptions) {}

  get queued(): number {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  /** Через сколько мс начнётся новый клип: текущая задача + клипы в очереди (фильмы встают после клипов). */
  clipWait(now = Date.now()): number {
    const cur = this.busy ? Math.max(0, this.est[this.busy.kind] - (now - this.busy.since)) : 0;
    return cur + this.queue.filter((t) => t.kind === 'clip' && !t.pre).length * this.est.clip;
  }

  /**
   * Смонтировать клип выбывшего. null сразу — очередь длинная (телефон смонтирует быстрее сам),
   * иначе onQueued(eta, мс до готовности) и обещание с клипом (null — не вышло).
   */
  clip(req: Omit<ClipJob, 'site' | 'link'>, onQueued?: (etaMs: number) => void): Promise<FilmDone | null> | null {
    if (this.o.enabled && !this.o.enabled()) return null;
    const wait = this.clipWait();
    if (wait > CLIP_MAX_WAIT_MS) {
      this.clipsRejected++;
      this.o.log('info', 'clip_busy', { wait, queued: this.queued });
      return null;
    }
    onQueued?.(wait + this.est.clip);
    // клип ждёт игрок прямо сейчас — вперёд заготовок и фильмов (фильм монтируется, пока идут итоги)
    return this.enqueue(req, false);
  }

  /**
   * Заготовить клип выбывшего, пока он ещё не попросил (кнопка «Клип» появится через 3,4 с после
   * удара — к нажатию клип уже готов). Только когда монтажу нечего делать: заготовка не должна
   * задерживать тех, кто уже ждёт. null — не взялись.
   */
  preclip(req: Omit<ClipJob, 'site' | 'link'>): Promise<FilmDone | null> | null {
    if (this.o.enabled && !this.o.enabled()) return null;
    if (this.clipWait() > PRECLIP_MAX_WAIT_MS || this.queue.some((t) => t.kind === 'clip')) return null;
    this.preclips++;
    return this.enqueue(req, true);
  }

  /** Сколько мс ещё ждать задачу, уже стоящую в очереди или в работе (оценка). */
  etaOf(p: Promise<FilmDone | null>, now = Date.now()): number {
    const cur = this.busy ? Math.max(500, this.est[this.busy.kind] - (now - this.busy.since)) : 0;
    if (this.busy?.p === p) return cur;
    const i = this.queue.findIndex((t) => t.p === p);
    if (i < 0) return this.est.clip;
    return cur + this.queue.slice(0, i + 1).reduce((a, t) => a + this.est[t.kind], 0);
  }

  private enqueue(req: Omit<ClipJob, 'site' | 'link'>, pre: boolean): Promise<FilmDone | null> {
    const job: ClipJob = { ...req, site: this.o.site, link: `https://${this.o.site}/?src=clip&l=${req.lang}` };
    let task!: Task;
    const p = new Promise<FilmDone | null>((done) => {
      task = { kind: 'clip', job, done, pre };
    });
    task.p = p;
    const i = this.queue.findIndex((t) => t.kind === 'film' || (!pre && t.kind === 'clip' && t.pre));
    if (i < 0) this.queue.push(task);
    else this.queue.splice(i, 0, task);
    void this.next();
    return p;
  }

  /** Смонтировать фильм. null — не вышло (или очередь полна): клиент смонтирует сам. */
  make(req: Omit<FilmJob, 'site' | 'link'>): Promise<FilmDone | null> {
    const job: FilmJob = { ...req, site: this.o.site, link: `https://${this.o.site}/?src=film&l=${req.lang}` };
    // запись матча — даже если фильм не смонтируется: по ней его можно смонтировать потом
    this.o.recordings
      ?.save(job)
      .then((name) => this.o.log('info', 'match_recorded', { name }))
      .catch((e: unknown) => this.o.log('warn', 'match_record_failed', { err: String(e).slice(0, 300) }));
    if (this.o.enabled && !this.o.enabled()) return Promise.resolve(null);
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
    this.busy = { kind: task.kind, since: t0, p: task.p };
    const res = task.kind === 'film' ? await this.makeFilm(task.job, t0) : await this.makeClip(task.job, t0, !!task.pre);
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

  private async makeClip(job: ClipJob, t0: number, pre: boolean): Promise<FilmDone | null> {
    try {
      const { r, renderer } = await this.renderAny('clip', job, 'ultrafast');
      if (!r) return null;
      const saved = await this.o.store.adopt(r.video, 'mp4', r.thumb);
      const res: FilmDone = { ...saved, ext: 'mp4', ms: Date.now() - t0 };
      this.clipsMade++;
      this.lastClipMs = res.ms;
      this.o.log('info', 'clip_made', { ms: res.ms, render: r.renderMs, dur: r.durationMs, renderer, known: job.known, pre, queued: this.queue.length });
      return res;
    } catch (e) {
      this.clipsFailed++;
      this.o.log('error', 'clip_failed', { err: String(e).slice(0, 600) });
      return null;
    }
  }

  /** Процесс монтажа: живёт между задачами (модули, шрифты и темы — один раз), гаснет после простоя. */
  private worker: Worker | null = null;

  /** Прогреть процесс монтажа заранее (начался матч): первый клип не ждёт загрузки. */
  warm(): void {
    if (this.o.enabled && !this.o.enabled()) return;
    try {
      this.ensureWorker(nativePath());
    } catch (e) {
      this.o.log('warn', 'film_warm_failed', { err: String(e).slice(0, 300) });
    }
    this.armIdle();
  }

  /** Погасить процесс монтажа (сервер выходит). */
  stop(): void {
    this.dropWorker();
  }

  private ensureWorker(native: string | undefined): Worker {
    const cur = this.worker;
    if (cur && cur.native === native && cur.jobs < WORKER_MAX_JOBS && cur.rssMb < WORKER_MAX_RSS_MB) return cur;
    this.dropWorker();
    const w = workerPath();
    if (!existsSync(w.path)) throw new Error(`нет ${w.path}`);
    const child = fork(w.path, [], { execArgv: w.execArgv, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      if (child.pid) setPriority(child.pid, 15);
    } catch {
      // не дали понизить приоритет — монтаж всё равно идёт
    }
    this.workerStarts++;
    const wk: Worker = { child, native, jobs: 0, rssMb: 0, seq: 0, wait: new Map() };
    child.on('message', (m: WorkerReply) => {
      const cb = wk.wait.get(m.id);
      if (!cb) return;
      wk.wait.delete(m.id);
      wk.rssMb = m.rssMb ?? 0;
      cb(m);
    });
    child.once('exit', (code, sig) => {
      if (this.worker === wk) this.worker = null;
      for (const cb of wk.wait.values()) cb({ id: -1, ok: false, err: `монтаж завершился: ${code ?? sig}` });
      wk.wait.clear();
    });
    child.on('error', () => {
      // упал при запуске — придёт exit
    });
    const opts: Pick<FilmRenderOpts, 'fonts' | 'native'> = { fonts: this.o.fonts, native };
    child.send({ warm: opts } satisfies WorkerMsg);
    hold(wk, false);
    this.worker = wk;
    return wk;
  }

  private dropWorker(): void {
    const wk = this.worker;
    this.worker = null;
    if (!wk) return;
    if (wk.wait.size) wk.child.kill('SIGKILL');
    else wk.child.disconnect();
  }

  private idle: ReturnType<typeof setTimeout> | null = null;

  /** Простоял без задач — погасить (память — игре и сайту). */
  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.busy && !this.queue.length) this.dropWorker();
    }, this.o.idleMs ?? WORKER_IDLE_MS);
    this.idle.unref?.();
  }

  private render(kind: 'film' | 'clip', job: FilmJob | ClipJob, preset: string, native?: string): Promise<FilmRendered | null> {
    let wk: Worker;
    try {
      wk = this.ensureWorker(native);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    wk.jobs++;
    const id = ++wk.seq;
    hold(wk, true);
    return new Promise<FilmRendered | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        wk.wait.delete(id);
        // зависший процесс — в утиль, следующая задача поднимет новый
        if (this.worker === wk) this.worker = null;
        wk.child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, kind === 'clip' ? 45_000 : (this.o.timeoutMs ?? 90_000));
      wk.wait.set(id, (m) => {
        clearTimeout(timer);
        if (m.ok) resolve(m.r ? { ...m.r, thumb: Buffer.from(m.r.thumb) } : null);
        else reject(new Error(m.err));
      });
      const msg: WorkerMsg = { id, [kind === 'clip' ? 'clip' : 'job']: job, opts: { fonts: this.o.fonts, tmp: this.o.store.dir, ffmpeg: this.o.ffmpeg, preset, native } };
      wk.child.send(msg);
    }).finally(() => {
      if (!wk.wait.size) hold(wk, false);
      this.armIdle();
    });
  }
}

/** Процесс монтажа отслужил столько задач — новый (память нативных модулей не копится). */
const WORKER_MAX_JOBS = 40;
const WORKER_MAX_RSS_MB = 700;
/** Без задач столько — погасить процесс монтажа. */
const WORKER_IDLE_MS = 10 * 60_000;

interface Worker {
  child: ChildProcess;
  native: string | undefined;
  jobs: number;
  rssMb: number;
  seq: number;
  wait: Map<number, (m: WorkerReply) => void>;
}

/** Пока процесс монтажа занят, он держит сервер (скрипт) живым; без задач — нет: выход не ждёт его. */
function hold(wk: Worker, on: boolean): void {
  const ch = wk.child as ChildProcess & { channel?: { ref(): void; unref(): void } | null };
  if (on) {
    wk.child.ref();
    ch.channel?.ref();
  } else {
    wk.child.unref();
    ch.channel?.unref();
  }
}

type WorkerReply = { id: number; rssMb?: number } & ({ ok: true; r: FilmRendered | null } | { ok: false; err: string });
