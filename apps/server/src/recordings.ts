/**
 * Записи сыгранных матчей — то, из чего монтируется «Фильм матча» (FilmJob без адреса сайта):
 * дубли (ключевые кадры мира и журнал событий), итоги дублей, игроки, итог матча, язык.
 * По записи матч можно смонтировать заново сколько угодно раз — с другим финалом, темпом, темой —
 * не играя его снова (scripts/film-variants.ts, .github/workflows/film-variants.yml).
 *
 * Формат файла — стабильный, его читают и другие монтажёры (не только этот код):
 *   <ГГГГММДД-ччммсс>-<10 hex>.match.json.gz — gzip от JSON
 *   { "format": "massovka-match", "v": 1, "savedAt": "<ISO>", "job": { takes, players, match, lang } }
 *   В takes[i].rec.nav — только { "cell": N }: сетку навигации строят заново по takes[i].arena.
 * Расширять — только добавлением полей; несовместимая правка — новый "v".
 *
 * Хранится 2 суток (как фильмы), папка не больше 300 МБ — сначала уходят старые.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { FilmJob } from './film-render';

export const RECORDING_FORMAT = 'massovka-match';
export const RECORDING_V = 1;
const TTL_MS = 48 * 3600_000;
const DIR_MAX = 300 * 1024 * 1024;
export const RECORDING_NAME = /^\d{8}-\d{6}-[0-9a-f]{10}\.match\.json\.gz$/;

export type MatchJob = Omit<FilmJob, 'site' | 'link' | 'finale'>;

export interface MatchRecording {
  format: typeof RECORDING_FORMAT;
  v: number;
  savedAt: string;
  job: MatchJob;
}

const gz = promisify(gzip);
const gunz = promisify(gunzip);

/** Запись матча в JSON: без адреса сайта, сетка навигации — только размер клетки. */
export function encodeRecording(job: FilmJob | MatchJob, savedAt: Date): string {
  const { takes, players, match, lang } = job;
  const rec: MatchRecording = {
    format: RECORDING_FORMAT,
    v: RECORDING_V,
    savedAt: savedAt.toISOString(),
    job: { takes: takes.map((tk) => ({ ...tk, rec: { ...tk.rec, nav: { cell: tk.rec.nav.cell } as unknown as typeof tk.rec.nav } })), players, match, lang },
  };
  return JSON.stringify(rec);
}

/** Прочитать запись матча (сетку навигации строит renderFilm). */
export function decodeRecording(json: string): MatchRecording {
  const r = JSON.parse(json) as MatchRecording;
  if (r?.format !== RECORDING_FORMAT || typeof r.v !== 'number' || !r.job?.takes) throw new Error('не запись матча');
  if (r.v > RECORDING_V) throw new Error(`запись версии ${r.v}, умею до ${RECORDING_V}`);
  return r;
}

export async function readRecordingFile(path: string): Promise<MatchRecording> {
  return decodeRecording((await gunz(await readFile(path))).toString('utf8'));
}

const pad = (n: number) => String(n).padStart(2, '0');

export class MatchRecordings {
  readonly dir: string;

  constructor(dir?: string, private readonly now: () => number = Date.now) {
    this.dir = dir ?? join(tmpdir(), 'massovka-matches');
  }

  /** Сохранить запись; вернуть имя файла. */
  async save(job: FilmJob | MatchJob): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    const d = new Date(this.now());
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const name = `${stamp}-${randomBytes(5).toString('hex')}.match.json.gz`;
    await writeFile(join(this.dir, name), await gz(encodeRecording(job, d), { level: 6 }));
    return name;
  }

  /** Записи от новых к старым. */
  async list(): Promise<string[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => RECORDING_NAME.test(n));
    return names.sort().reverse();
  }

  /** Убрать старше 2 суток и лишнее сверх 300 МБ (сначала старые). */
  async sweep(): Promise<void> {
    const now = this.now();
    let total = 0;
    for (const name of await this.list()) {
      const path = join(this.dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      total += st.size;
      if (now - st.mtimeMs > TTL_MS || total > DIR_MAX) await rm(path, { force: true });
    }
  }
}
