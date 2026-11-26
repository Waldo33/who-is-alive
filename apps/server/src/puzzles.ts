/**
 * Загадки «Найди актёра» из «Фильма матча» (страница сайта /c/<код>).
 *
 * Загадку вырезает game-core (`pickFilmPuzzle`) из дублей матча, когда комната ставит фильм на монтаж:
 * это доли секунды без рендера, поэтому загадка есть, даже если фильм смонтирует телефон.
 * Код — 5 знаков без путаницы (нет O/0, I/1): его набирают руками с экрана TikTok.
 *
 *   GET  /v1/puzzles/<код>      — то, что видит зритель (ключевой кадр и события), без ответа
 *   POST /v1/puzzles/<код>/tap  — { eid, n, d } → попал ли; после промаха — подсказка; в конце — ответ и доля нашедших
 *
 * Файл `<код>.json.gz` (gzip JSON { format, v, savedAt, lang, pub, secret }) лежит в подпапке клипов
 * (общая у синего и зелёного экземпляров) 30 суток и копией в S3 (`puzzles/`, срок ставит main.ts):
 * ролики в TikTok набирают просмотры неделями. Ответ (`secret`) из сервера не выходит до конца попыток.
 */
import { randomInt } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { PUZZLE_TRIES, betterPuzzle, buildFilmPuzzle, puzzleCandidate, puzzleHint } from '@kto/game-core';
import type { FilmPuzzle, FilmPuzzlePublic, FilmPuzzleSecret, HintRect, PuzzleCandidate, PuzzleTake } from '@kto/game-core';
import type { S3Client } from './s3';

export const PUZZLE_FORMAT = 'massovka-puzzle';
/** Алфавит кода: заглавные латинские и цифры без O/0, I/1 — 32 знака, 5 знаков ≈ 33 млн кодов. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PUZZLE_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const TTL_MS = 30 * 86_400_000;
const DIR_MAX = 200 * 1024 * 1024;
/** Сколько загадок держать в памяти (каждая ~30 КБ в разобранном виде). */
const CACHE_MAX = 64;
/** Ход попыток и устройства в итогах — сутки, не больше TAPS_MAX записей в памяти. */
const TAP_TTL_MS = 86_400_000;
const TAPS_MAX = 50_000;
const RESULT_DEVICES_PER_IP = 5;

const gz = promisify(gzip);
const gunz = promisify(gunzip);

export interface StoredPuzzle {
  format: typeof PUZZLE_FORMAT;
  v: number;
  savedAt: string;
  lang: 'ru' | 'en';
  pub: FilmPuzzlePublic;
  secret: FilmPuzzleSecret;
}

export interface PuzzleRemote {
  s3: S3Client;
  log?: (level: 'info' | 'warn' | 'error', msg: string, f?: Record<string, unknown>) => void;
}

/** Итоги загадки: сколько зрителей сыграло и сколько нашли (первая попытка с каждого телефона). */
export interface PuzzleStats {
  played: number;
  found: number;
}

export type TapResult =
  | { status: 200; body: { hit: boolean; hint?: HintRect; done: boolean; answer?: number[]; stats?: PuzzleStats } }
  | { status: 400 | 404; body: { error: string } };

export function newPuzzleCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export class PuzzleStore {
  readonly dir: string;
  private readonly cache = new Map<string, StoredPuzzle>();
  private readonly pending = new Set<Promise<void>>();
  /**
   * Ход попыток зрителя (код|устройство → сущности по порядку) — на сервере, а не со слов страницы:
   * иначе номер попытки присылал бы телефон и мог бы перебирать всех 32 человечков «первой попыткой»
   * (ревью безопасности, M4). Только в памяти, сутки: после перезапуска счёт начинается заново.
   */
  private readonly taps = new Map<string, { eids: number[]; at: number }>();
  /** Сколько разных устройств с одного адреса попало в итоги загадки (накрутка «доли нашедших»). */
  private readonly ipDevices = new Map<string, { devices: Set<string>; at: number }>();

  constructor(
    dir?: string,
    private readonly now: () => number = Date.now,
    private readonly remote?: PuzzleRemote,
  ) {
    this.dir = dir ?? join(tmpdir(), 'massovka-puzzles');
  }

  /**
   * Вырезать загадку из дублей и сохранить; null — честного куска нет.
   * Перебор окон — десятки миллисекунд на дубль: дубли разбираем по одному и между ними отдаём ход
   * (setImmediate), чтобы такты идущих матчей других комнат не вставали.
   */
  async create(takes: readonly PuzzleTake[], lang: 'ru' | 'en'): Promise<{ code: string; puzzle: FilmPuzzle } | null> {
    let best: PuzzleCandidate | null = null;
    for (const tk of takes) {
      await new Promise<void>((r) => setImmediate(r));
      best = betterPuzzle(best, puzzleCandidate(tk));
    }
    if (!best) return null;
    await new Promise<void>((r) => setImmediate(r));
    const puzzle = buildFilmPuzzle(best);
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    let code = newPuzzleCode();
    for (let i = 0; i < 5 && (await stat(this.path(code)).catch(() => null)); i++) code = newPuzzleCode();
    const doc: StoredPuzzle = { format: PUZZLE_FORMAT, v: puzzle.pub.v, savedAt: new Date(this.now()).toISOString(), lang, pub: puzzle.pub, secret: puzzle.secret };
    const body = await gz(JSON.stringify(doc), { level: 6 });
    await writeFile(this.path(code), body);
    this.remember(code, doc);
    this.mirror(code, body);
    return { code, puzzle };
  }

  /** Загадка по коду: память → диск → S3. */
  async get(code: string): Promise<StoredPuzzle | null> {
    if (!PUZZLE_CODE.test(code)) return null;
    const hit = this.cache.get(code);
    if (hit) return hit;
    let raw: Buffer | null = await readFile(this.path(code)).catch(() => null);
    if (!raw && this.remote) {
      raw = await this.remote.s3.get(this.key(code)).catch((e: unknown) => {
        this.remote?.log?.('warn', 's3_get_failed', { key: this.key(code), err: String(e).slice(0, 300) });
        return null;
      });
    }
    if (!raw) return null;
    try {
      const doc = JSON.parse((await gunz(raw)).toString('utf8')) as StoredPuzzle;
      if (doc.format !== PUZZLE_FORMAT || !doc.pub || !doc.secret) return null;
      if (this.now() - Date.parse(doc.savedAt) > TTL_MS) return null;
      this.remember(code, doc);
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * Тап зрителя: `eid` — сущность под пальцем (или -1 — время вышло), `n` — номер попытки по счёту страницы
   * (1…3), `viewer` — устройство (или адрес). Номер попытки считает сервер: повтор того же тапа (сеть
   * моргнула) отвечает так же, любой другой — следующая попытка. `tries` в ответе — номер по счёту сервера.
   */
  async tap(code: string, eid: number, n: number, viewer = ''): Promise<{ doc: StoredPuzzle; res: TapResult; tries: number; first: boolean } | null> {
    const doc = await this.get(code);
    if (!doc) return null;
    if (!Number.isInteger(eid) || !Number.isInteger(n) || n < 1 || n > PUZZLE_TRIES) return { doc, res: { status: 400, body: { error: 'bad_tap' } }, tries: 0, first: false };
    const now = this.now();
    const key = `${code}|${viewer}`;
    let st = this.taps.get(key);
    if (!st || now - st.at > TAP_TTL_MS) {
      st = { eids: [], at: now };
      this.taps.set(key, st);
      if (this.taps.size > TAPS_MAX) for (const [k, v] of this.taps) if (now - v.at > TAP_TTL_MS || this.taps.size > TAPS_MAX) this.taps.delete(k);
    }
    const replay = n <= st.eids.length && st.eids[n - 1] === eid;
    let first = false;
    if (!replay && st.eids.length >= PUZZLE_TRIES) {
      // попытки кончились — только ответ, без новой проверки
      return { doc, res: { status: 200, body: { hit: false, done: true, answer: doc.secret.answer } }, tries: st.eids.length, first: false };
    } else if (!replay) {
      st.eids.push(eid);
      n = st.eids.length;
      first = true;
    }
    const hit = doc.secret.answer.includes(eid);
    const done = hit || n >= PUZZLE_TRIES;
    // угадал — дальше попыток нет: повторный «первый тап» другим человечком не пройдёт
    if (hit && first) while (st.eids.length < PUZZLE_TRIES) st.eids.push(eid);
    if (done) return { doc, res: { status: 200, body: { hit, done, answer: doc.secret.answer } }, tries: n, first };
    const hint = puzzleHint(doc.pub, doc.secret, n) ?? undefined;
    return { doc, res: { status: 200, body: { hit, done, hint } }, tries: n, first };
  }

  /**
   * Можно ли записать итог этого устройства в «долю нашедших»: с одного адреса — не больше
   * RESULT_DEVICES_PER_IP разных устройств на загадку (иначе долю накручивают, меняя id устройства).
   */
  resultAllowed(code: string, ip: string, device: string): boolean {
    const now = this.now();
    const key = `${code}|${ip}`;
    let e = this.ipDevices.get(key);
    if (!e || now - e.at > TAP_TTL_MS) {
      e = { devices: new Set(), at: now };
      this.ipDevices.set(key, e);
      if (this.ipDevices.size > TAPS_MAX) for (const [k, v] of this.ipDevices) if (now - v.at > TAP_TTL_MS || this.ipDevices.size > TAPS_MAX) this.ipDevices.delete(k);
    }
    if (e.devices.has(device)) return true;
    if (e.devices.size >= RESULT_DEVICES_PER_IP) return false;
    e.devices.add(device);
    return true;
  }

  /** Дождаться фоновых загрузок в S3 (тесты). */
  async flushRemote(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  /** Убрать старше 30 суток и лишнее сверх 200 МБ (сначала старые). */
  async sweep(): Promise<void> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json.gz'));
    const files: { path: string; mtime: number; size: number }[] = [];
    for (const n of names) {
      const st = await stat(join(this.dir, n)).catch(() => null);
      if (st) files.push({ path: join(this.dir, n), mtime: st.mtimeMs, size: st.size });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (this.now() - f.mtime > TTL_MS || total > DIR_MAX) await rm(f.path, { force: true });
    }
  }

  private path(code: string): string {
    return join(this.dir, `${code}.json.gz`);
  }

  private key(code: string): string {
    return `puzzles/${code}.json.gz`;
  }

  private remember(code: string, doc: StoredPuzzle): void {
    this.cache.delete(code);
    this.cache.set(code, doc);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }

  private mirror(code: string, body: Buffer): void {
    const r = this.remote;
    if (!r) return;
    const job = r.s3
      .putBytes(this.key(code), body, 'application/gzip')
      .catch((e: unknown) => r.log?.('warn', 's3_put_failed', { key: this.key(code), err: String(e).slice(0, 300) }))
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }
}
