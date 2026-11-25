import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { Logger, LogLevel } from './log';
import type { Store } from './store';

/**
 * Свой трекер ошибок (docs/architecture.md › 7): телефоны (`POST /v1/errors`, lib/errors.ts на сайте),
 * игровой сервер, бот и монтаж (всё, что пишется в журнал с уровнем error, и непойманные исключения).
 *
 * - Стек с телефона разворачивается по source maps сайта (их кладёт web-deploy в SOURCEMAPS_DIR/<версия>/,
 *   наружу они не отдаются); стек сервера уже развёрнут Node (`--enable-source-maps`).
 * - Группа — отпечаток (fp): источник + вид ошибки + текст без чисел и имён переменных + место в нашем коде
 *   (файл и функция, без строк — чтобы группа жила между версиями).
 * - Копим в памяти и раз в 10 с пишем в базу (`error_groups`, `error_daily`): шквал одинаковых ошибок —
 *   одна строка. Сервер бота (Нидерланды, без базы) пересылает свои группы игровому серверу.
 * - Новая группа (или вернувшаяся после недели тишины) — сторож в Нидерландах шлёт в чат тревог (watch.sh).
 * - Личного не храним: ни IP, ни id, ни имён; из текстов и ссылок вычищаются параметры (в том числе
 *   tgWebAppData из Telegram), почта, токены и длинные числа.
 */
export type ErrorSource = 'web' | 'server' | 'bot' | 'film';

export interface ErrorReport {
  source: ErrorSource;
  /** «TypeError: x is undefined» */
  message: string;
  /** error | rejection (телефон), log (журнал сервера), crash (непойманное) */
  kind?: string;
  stack?: string;
  /** файл:строка:столбец из window.onerror */
  at?: string;
  /** версия: короткий sha сайта или сервера */
  build?: string;
  /** контекст: тема, комната, фаза, платформа… — короткие строки */
  ctx?: Record<string, string>;
  /** последние шаги перед ошибкой */
  crumbs?: string[];
  /** место, если стека нет (сообщение журнала: film_failed, tg_error…) */
  culpritHint?: string;
}

/** Строка группы — то, что уходит в базу (или соседу) за один сброс. */
export interface ErrorRow {
  fp: string;
  source: ErrorSource;
  title: string;
  culprit: string;
  count: number;
  build: string;
  /** сколько раз встречались значения контекста: «os:ios» → 3 */
  tags: Record<string, number>;
  /** последний случай целиком */
  sample: { message: string; kind?: string; stack?: string; at?: string; ctx?: Record<string, string>; crumbs?: string[] };
}

export interface ErrorTrackerOptions {
  store: Store;
  log: Logger;
  /** где лежат source maps сайта по версиям */
  mapsDir?: string;
  /** сервер без своей базы (бот в Нидерландах): куда пересылать группы, `http://127.0.0.1:28080` */
  upstream?: string;
  /** метка машины в контексте: eu, nl */
  host?: string;
  /** версия сервера */
  build?: string;
  flushMs?: number;
}

const SOURCES: ErrorSource[] = ['web', 'server', 'bot', 'film'];
/** Контекст, по которому считаем разбивку (tags): не больше этих ключей. */
const TAG_KEYS = ['os', 'br', 'app', 'theme', 'phase', 'mode', 'pwa', 'lang', 'host'];
const MAX_PENDING = 300;
const MAX_TAGS = 60;
const MAP_CACHE = 6;
const MAX_MAP_BYTES = 40 * 1024 * 1024;

// ───────────── вычистка личного ─────────────

/** Убрать из текста то, что может указать на человека: параметры ссылок, tgWebAppData, почту, токены, длинные числа. */
export function scrub(s: string): string {
  return (
    s
      // параметры и фрагменты ссылок (там tgWebAppData с именем и id игрока, метки приглашений)
      .replace(/(\b(?:https?|file|webpack):\/\/[^\s?#()'"]*)[?#][^\s()'"]*/g, '$1')
      .replace(/tgWebApp\w*=[^\s&'"]*/g, 'tgWebApp…')
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
      .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '<jwt>')
      .replace(/\b(?:bot)?\d{6,}:[\w-]{20,}/g, '<token>')
      .replace(/\b[A-Fa-f0-9-]{32,}\b/g, '<id>')
      .replace(/\b\d{7,}\b/g, '<n>')
  );
}

// ───────────── стек ─────────────

export interface Frame {
  fn: string;
  file: string;
  line: number;
  col: number;
}

const CHROME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const SAFARI = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Кадры стека Chrome/Node («at fn (file:1:2)») и Safari/Firefox («fn@file:1:2»). */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const out: Frame[] = [];
  for (const line of stack.split('\n').slice(0, 60)) {
    const m = CHROME.exec(line) ?? SAFARI.exec(line);
    if (!m) continue;
    out.push({ fn: (m[1] ?? '').replace(/^async /, '').trim(), file: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  return out;
}

/** Путь файла без машины и хэшей: packages/game-core/src/match.ts, apps/web/src/game/scene.ts, chunks/page.js. */
export function cleanFile(file: string): string {
  let f = file.replace(/^(?:file:\/\/|webpack:\/\/[^/]*\/)/, '').replace(/[?#].*$/, '');
  f = f.replace(/^https?:\/\/[^/]+/, '');
  const m = /(?:^|\/)((?:apps|packages)\/.*)$/.exec(f) ?? /(?:^|\/)(node_modules\/.*)$/.exec(f);
  if (m) f = m[1];
  else if (/\/src\//.test(f)) f = f.slice(f.lastIndexOf('/src/') + 1);
  else f = f.replace(/^(?:\.\.?\/)+/, '');
  // хэш в имени куска сборки: page-3f2a1b9c4d5e6f70.js → page.js
  return f.replace(/^\/_next\/static\//, '').replace(/[-.][0-9a-f]{8,}(?=\.js$)/, '');
}

/** Имя функции без класса и без сжатых сборщиком имён (одна-две буквы — не имя). */
function fnName(fn: string): string {
  const last = fn.replace(/^new /, '').split('.').pop() ?? '';
  return last.length > 2 && last !== '<anonymous>' ? last : '';
}

/** src/… сайта и сервера — с приложением: apps/web/src/game/scene.ts, apps/server/src/room.ts. */
function appFile(source: ErrorSource, f: string): string {
  return f.startsWith('src/') ? `apps/${source === 'web' ? 'web' : 'server'}/${f}` : f;
}

/** Наш ли это код (а не React, Next, Phaser, сборщика или самого Node). */
function inApp(file: string): boolean {
  return !/node_modules|next\/dist|webpack|react-dom|\bphaser\b|^node:|^internal\/|<anonymous>|^native$/.test(file);
}

/** Текст без чисел, адресов и минифицированных имён: «'e.foo.bar'» → «'….bar'». */
export function normalizeMessage(m: string): string {
  return m
    .replace(/'([^']*)'|"([^"]*)"/g, (_s, a: string | undefined, b: string | undefined) => {
      const v = a ?? b ?? '';
      const i = v.lastIndexOf('.');
      return `'${i >= 0 ? '…' + v.slice(i) : v.length > 40 ? '…' : v}'`;
    })
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b0x[0-9a-f]+\b/gi, 'N')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// ───────────── source maps сайта ─────────────

/** Развернуть кадры телефона по картам сборки сайта. Без карт — как есть. */
export class SourceMaps {
  private readonly cache = new Map<string, TraceMap | null>();

  constructor(private readonly dir: string | undefined) {}

  /** Файл карты для куска сборки: сначала версия ошибки, потом свежие версии (имена кусков с хэшем). */
  private find(build: string, rel: string): string | null {
    if (!this.dir) return null;
    const root = resolve(this.dir);
    const inside = (p: string) => (p.startsWith(root + sep) ? p : null);
    const direct = /^[0-9a-f]{7,12}$/.test(build) ? inside(resolve(root, build.slice(0, 7), rel + '.map')) : null;
    if (direct && existsSync(direct)) return direct;
    let builds: string[];
    try {
      builds = readdirSync(root)
        .filter((d) => /^[0-9a-f]{7}$/.test(d))
        .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
        .slice(0, 10);
    } catch {
      return null;
    }
    for (const b of builds) {
      const p = inside(resolve(root, b, rel + '.map'));
      if (p && existsSync(p)) return p;
    }
    return null;
  }

  private load(path: string): TraceMap | null {
    if (this.cache.has(path)) {
      const v = this.cache.get(path)!;
      this.cache.delete(path);
      this.cache.set(path, v);
      return v;
    }
    let map: TraceMap | null = null;
    try {
      if (statSync(path).size <= MAX_MAP_BYTES) map = new TraceMap(readFileSync(path, 'utf8'));
    } catch {
      map = null;
    }
    this.cache.set(path, map);
    while (this.cache.size > MAP_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return map;
  }

  /** Кадр с адресом /_next/static/… → исходник, строка и имя функции. */
  frame(f: Frame, build: string): Frame {
    const m = /\/_next\/static\/(.+\.js)$/.exec(f.file.replace(/[?#].*$/, ''));
    if (!m || m[1].includes('..')) return f;
    const path = this.find(build, decodeURIComponent(m[1]));
    const map = path ? this.load(path) : null;
    if (!map) return f;
    try {
      const o = originalPositionFor(map, { line: f.line, column: Math.max(0, f.col - 1) });
      if (!o.source || o.line == null) return f;
      return { fn: f.fn || (o.name ?? ''), file: o.source, line: o.line, col: (o.column ?? 0) + 1 };
    } catch {
      return f;
    }
  }
}

// ───────────── трекер ─────────────

export class ErrorTracker {
  private pending = new Map<string, ErrorRow>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maps: SourceMaps;
  private flushing: Promise<void> | null = null;
  private lastCleanup = 0;
  /** Счётчики для /metrics. */
  readonly stats = { captured: 0, dropped: 0, groupsNew: 0 };

  constructor(private readonly o: ErrorTrackerOptions) {
    this.maps = new SourceMaps(o.mapsDir);
    const ms = o.flushMs ?? 10_000;
    if (ms > 0) {
      this.timer = setInterval(() => void this.flush(), ms);
      this.timer.unref?.();
    }
  }

  /** Принять случай. Никогда не бросает. */
  capture(r: ErrorReport): ErrorRow | null {
    try {
      const row = this.toRow(r);
      if (row) this.add(row);
      return row;
    } catch {
      return null;
    }
  }

  /** Строки от соседа без базы (сервер бота) — внутренний вход `/internal/errors`. */
  ingest(raw: unknown): number {
    if (!Array.isArray(raw)) return 0;
    let n = 0;
    for (const x of raw.slice(0, 100)) {
      const r = parseRow(x);
      if (r) {
        this.add(r);
        n++;
      }
    }
    return n;
  }

  /** Логгер, который заодно отдаёт трекеру всё уровня error. */
  wrap(log: Logger): Logger {
    return (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
      log(level, msg, fields);
      if (level !== 'error') return;
      let err = typeof fields?.err === 'string' ? fields.err : '';
      let stack = typeof fields?.stack === 'string' ? fields.stack : undefined;
      // стек внутри текста (ошибка из процесса монтажа приходит строкой): первая строка — текст
      const nl = err.indexOf('\n');
      if (nl > 0) {
        stack ??= err;
        err = err.slice(0, nl);
      }
      const source: ErrorSource = /^tg_/.test(msg) ? 'bot' : /^(film|clip)_/.test(msg) ? 'film' : 'server';
      this.capture({ source, kind: 'log', message: err ? `${msg}: ${err}` : msg, stack, build: this.o.build, culpritHint: msg });
    };
  }

  private toRow(r: ErrorReport): ErrorRow | null {
    const source = SOURCES.includes(r.source) ? r.source : 'server';
    const message = scrub(String(r.message ?? '')).slice(0, 400).trim();
    if (!message) return null;
    const build = /^[0-9a-f]{7,40}$/.test(r.build ?? '') ? r.build!.slice(0, 7) : (r.build ?? '').replace(/[^\w.-]/g, '').slice(0, 16);
    let frames = parseStack(r.stack);
    if (!frames.length && r.at) {
      const m = /^(.*):(\d+):(\d+)$/.exec(r.at);
      if (m) frames = [{ fn: '', file: m[1], line: Number(m[2]), col: Number(m[3]) }];
    }
    if (source === 'web') frames = frames.slice(0, 30).map((f) => this.maps.frame(f, build));
    // имя функции — из самого стека (методы классов сборщик не сжимает: «tw.onNotice» → onNotice); имя из карты —
    // это слово под курсором, а не функция, поэтому только как запасное для кадров без имени
    const clean = frames.map((f) => ({ ...f, fn: fnName(f.fn), file: appFile(source, cleanFile(f.file)) }));
    const top = clean.find((f) => inApp(f.file)) ?? clean[0];
    // журнал сервера без стека: место — само сообщение (film_failed, tg_error…)
    const culprit = top ? `${top.file}${top.fn ? ' › ' + top.fn : ''}` : (r.culpritHint ?? '');
    const kind = /^(\w*Error|\w*Exception)\b/.exec(message)?.[1] ?? '';
    const norm = normalizeMessage(message);
    const fp = createHash('sha1').update([source, kind, norm, top ? `${top.file}|${top.fn}` : ''].join('\n')).digest('hex').slice(0, 16);
    const ctx: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.ctx ?? {}).slice(0, 20)) {
      if (!/^[a-z]\w{0,15}$/i.test(k) || v == null || v === '') continue;
      ctx[k] = scrub(String(v)).slice(0, 120);
    }
    if (this.o.host && !ctx.host) ctx.host = this.o.host;
    const tags: Record<string, number> = {};
    for (const k of TAG_KEYS) if (ctx[k]) tags[`${k}:${ctx[k].slice(0, 24)}`] = 1;
    const stack = clean.length
      ? clean.map((f) => `  at ${f.fn || '?'} (${f.file}:${f.line}:${f.col})`).join('\n')
      : r.stack
        ? scrub(r.stack).slice(0, 3000)
        : undefined;
    return {
      fp,
      source,
      title: message.slice(0, 200),
      culprit: culprit.slice(0, 200),
      count: 1,
      build,
      tags,
      sample: {
        message,
        kind: r.kind?.slice(0, 16),
        stack: stack?.slice(0, 3000),
        at: r.at ? cleanFile(scrub(r.at)).slice(0, 200) : undefined,
        ctx,
        crumbs: (r.crumbs ?? []).slice(-12).map((c) => scrub(String(c)).slice(0, 80)),
      },
    };
  }

  private add(row: ErrorRow): void {
    this.stats.captured++;
    const have = this.pending.get(row.fp);
    if (have) {
      have.count += row.count;
      have.build = row.build || have.build;
      have.sample = row.sample;
      for (const [k, v] of Object.entries(row.tags)) if (have.tags[k] || Object.keys(have.tags).length < MAX_TAGS) have.tags[k] = (have.tags[k] ?? 0) + v;
      return;
    }
    if (this.pending.size >= MAX_PENDING) {
      this.stats.dropped++;
      return;
    }
    this.pending.set(row.fp, row);
  }

  /** Записать накопленное: в базу или соседу. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.pending.size) return Promise.resolve();
    const rows = [...this.pending.values()];
    this.pending = new Map();
    this.flushing = this.write(rows).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(rows: ErrorRow[]): Promise<void> {
    try {
      if (this.o.upstream) {
        const r = await fetch(`${this.o.upstream}/internal/errors`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rows),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`upstream ${r.status}`);
        return;
      }
      const fresh = await this.o.store.saveErrors(rows);
      this.stats.groupsNew += fresh.length;
      for (const fp of fresh) {
        const r = rows.find((x) => x.fp === fp);
        // не error: иначе запись о записи снова попала бы в трекер
        if (r) this.o.log('warn', 'error_new', { fp, source: r.source, title: r.title, culprit: r.culprit });
      }
      const now = Date.now();
      if (now - this.lastCleanup > 6 * 3600_000) {
        this.lastCleanup = now;
        await this.o.store.cleanupErrors();
      }
    } catch (e) {
      this.o.log('warn', 'errors_store', { err: String(e).slice(0, 300), rows: rows.length });
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** Строка от соседа: проверяем всё, ему верим не больше, чем телефону. */
function parseRow(x: unknown): ErrorRow | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  if (typeof o.fp !== 'string' || !/^[0-9a-f]{16}$/.test(o.fp)) return null;
  if (!SOURCES.includes(o.source as ErrorSource)) return null;
  const title = s(o.title, 200);
  if (!title) return null;
  const tags: Record<string, number> = {};
  if (o.tags && typeof o.tags === 'object')
    for (const [k, v] of Object.entries(o.tags as Record<string, unknown>).slice(0, MAX_TAGS)) if (typeof v === 'number' && v > 0) tags[k.slice(0, 40)] = Math.min(v, 1e6);
  const sample = o.sample && typeof o.sample === 'object' ? (o.sample as ErrorRow['sample']) : { message: title };
  const json = JSON.stringify(sample);
  return {
    fp: o.fp,
    source: o.source as ErrorSource,
    title,
    culprit: s(o.culprit, 200),
    count: typeof o.count === 'number' && o.count > 0 ? Math.min(Math.floor(o.count), 1e6) : 1,
    build: s(o.build, 16),
    tags,
    sample: json.length <= 8000 ? sample : { message: title },
  };
}
