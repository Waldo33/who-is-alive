import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorTracker, cleanFile, normalizeMessage, parseStack, scrub } from '../src/errors';
import type { ErrorRow } from '../src/errors';
import { silentLogger } from '../src/log';
import type { LogLevel } from '../src/log';
import { GameServer } from '../src/server';
import { MemoryStore } from '../src/store';

const SECRET = 'test-secret-test-secret-test-secret!!';
let servers: GameServer[] = [];
let trackers: ErrorTracker[] = [];
afterEach(async () => {
  for (const t of trackers) await t.close();
  for (const s of servers) await s.close();
  servers = [];
  trackers = [];
});

function tracker(o: Partial<ConstructorParameters<typeof ErrorTracker>[0]> = {}) {
  const store = new MemoryStore();
  const logs: { level: LogLevel; msg: string; f?: Record<string, unknown> }[] = [];
  const t = new ErrorTracker({ store, log: (level, msg, f) => void logs.push({ level, msg, f }), flushMs: 0, ...o });
  trackers.push(t);
  return { t, store: (o.store as MemoryStore | undefined) ?? store, logs };
}

/** Карта сборки: колонка 0 строки 1 куска → src/game/scene.ts:41, функция drawHud. */
function mapsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maps-'));
  mkdirSync(join(dir, 'abc1234', 'chunks', 'app'), { recursive: true });
  // AAAAA — [кол 0, исходник 0, строка 0, кол 0, имя 0]; ;;… — пропуск строк не нужен: смещаем строку через AAoCA
  writeFileSync(
    join(dir, 'abc1234', 'chunks', 'app', 'page-0123456789abcdef.js.map'),
    JSON.stringify({ version: 3, sources: ['webpack://_N_E/./src/game/scene.ts'], names: ['drawHud'], mappings: 'AAwCAA' }),
  );
  return dir;
}

describe('трекер ошибок: вычистка личного', () => {
  it('убирает tgWebAppData, параметры ссылок, почту, токены и длинные числа', () => {
    const s = scrub(
      'fail https://benobody.app/r/ABCD?startapp=g_xyz#tgWebAppData=user%3D%7B%22id%22%3A123456789%7D at ' +
        'mail ivan@example.com jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc user 123456789 bot 1234567:AAEhBP0av18cZHTtvVKpQmXL7xkLQ7k',
    );
    expect(s).toContain('https://benobody.app/r/ABCD');
    expect(s).not.toMatch(/startapp|tgWebAppData=|123456789|ivan@|eyJ|AAEhBP/);
  });
});

describe('трекер ошибок: стек и группы', () => {
  it('читает стеки Chrome и Safari', () => {
    expect(parseStack('TypeError: x\n    at drawHud (https://benobody.app/_next/static/chunks/a.js:1:20)\n    at https://benobody.app/b.js:2:3')).toEqual([
      { fn: 'drawHud', file: 'https://benobody.app/_next/static/chunks/a.js', line: 1, col: 20 },
      { fn: '', file: 'https://benobody.app/b.js', line: 2, col: 3 },
    ]);
    expect(parseStack('drawHud@https://benobody.app/_next/static/chunks/a.js:1:20\n@https://benobody.app/b.js:2:3\n[native code]')).toHaveLength(2);
  });

  it('путь без машины и хэшей, текст без чисел и минифицированных имён', () => {
    expect(cleanFile('webpack://_N_E/../../packages/game-core/src/match.ts')).toBe('packages/game-core/src/match.ts');
    expect(cleanFile('file:///opt/massovka/color/blue/../src/room.ts')).toBe('src/room.ts');
    expect(cleanFile('https://benobody.app/_next/static/chunks/app/page-0123456789abcdef.js')).toBe('chunks/app/page.js');
    expect(normalizeMessage("undefined is not an object (evaluating 'e.sim.round')")).toBe(normalizeMessage("undefined is not an object (evaluating 'xy.sim.round')"));
    expect(normalizeMessage('index 12 out of 40')).toBe('index N out of N');
  });

  it('разворачивает стек телефона по source map и группирует между версиями', () => {
    const { t } = tracker({ mapsDir: mapsDir() });
    const at = (col: number) => `TypeError: x\n    at Scene.drawHud (https://benobody.app/_next/static/chunks/app/page-0123456789abcdef.js:1:${col})`;
    const a = t.capture({ source: 'web', message: "TypeError: undefined is not an object (evaluating 'e.hud')", stack: at(1), build: 'abc1234' })!;
    expect(a.culprit).toBe('apps/web/src/game/scene.ts › drawHud');
    expect(a.sample.stack).toContain('apps/web/src/game/scene.ts:41:1');
    // другая версия, та же карта найдена поиском по свежим версиям; другое имя переменной — та же группа
    const b = t.capture({ source: 'web', message: "TypeError: undefined is not an object (evaluating 'q.hud')", stack: at(1), build: 'fff0000' })!;
    expect(b.fp).toBe(a.fp);
    const c = t.capture({ source: 'web', message: 'TypeError: other', stack: at(1), build: 'abc1234' })!;
    expect(c.fp).not.toBe(a.fp);
    // чужая папка в пути — не читаем
    const d = t.capture({ source: 'web', message: 'x', stack: 'at a (https://benobody.app/_next/static/../../etc/passwd.js:1:1)', build: 'abc1234' })!;
    expect(d.culprit).not.toContain('scene');
  });

  it('копит одинаковые, пишет в базу раз в сброс, новую группу отмечает один раз', async () => {
    const { t, store, logs } = tracker();
    for (let i = 0; i < 50; i++) t.capture({ source: 'web', message: `RangeError: index ${i}`, ctx: { os: 'ios', theme: 'miami', room: 'ABCD' } });
    await t.flush();
    expect(store.errors.size).toBe(1);
    const g = [...store.errors.values()][0];
    expect(g.count).toBe(50);
    expect(g.tags).toMatchObject({ 'os:ios': 50, 'theme:miami': 50 });
    expect(g.sample.ctx).toMatchObject({ room: 'ABCD' });
    expect(logs.filter((l) => l.msg === 'error_new')).toHaveLength(1);
    t.capture({ source: 'web', message: 'RangeError: index 3' });
    await t.flush();
    expect(logs.filter((l) => l.msg === 'error_new')).toHaveLength(1);
    expect([...store.errors.values()][0].count).toBe(51);
  });

  it('журнал: error — в трекер (бот, монтаж, сервер), warn — нет', async () => {
    const { t, store } = tracker();
    const log = t.wrap(silentLogger);
    log('error', 'tg_error', { path: '/hook', err: 'TypeError: boom', stack: 'TypeError: boom\n    at handle (file:///opt/massovka/color/blue/../src/bot.ts:10:5)' });
    log('error', 'film_native_failed', { err: 'Error: panic in rust\n    at render (file:///x/src/film-native.ts:3:1)' });
    log('error', 'db_down', {});
    log('warn', 'events_relay', { err: 'nope' });
    await t.flush();
    const rows = [...store.errors.values()];
    expect(rows.map((r) => r.source).sort()).toEqual(['bot', 'film', 'server']);
    expect(rows.find((r) => r.source === 'bot')!.culprit).toBe('apps/server/src/bot.ts › handle');
    expect(rows.find((r) => r.source === 'film')!.title).toBe('film_native_failed: Error: panic in rust');
    expect(rows.find((r) => r.source === 'server')!.culprit).toBe('db_down');
  });
});

describe('трекер ошибок: игровой сервер', () => {
  it('ошибка с телефона с контекстом — в группу; сервер бота пересылает свои группы по туннелю', async () => {
    const { t, store } = tracker();
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, errors: t });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    const body = {
      m: 'TypeError: x is undefined',
      k: 'error',
      s: 'TypeError: x\n    at hud (https://benobody.app/_next/static/chunks/a.js:1:20)',
      p: '/r/',
      b: 'abc1234',
      ua: 'iPhone',
      c: { theme: 'miami', room: 'ABCD', phase: 'play', os: 'ios', bad_key_with_long_name_here: 1, obj: { x: 1 } },
      bc: ['phase:play', 7],
    };
    expect((await fetch(`${http}/v1/errors`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) })).status).toBe(204);

    // сервер бота: без базы, группы — соседу
    const up = tracker({ upstream: http, host: 'nl' });
    up.t.wrap(silentLogger)('error', 'tg_hook', { err: 'Error: telegram 502' });
    await up.t.flush();
    expect(up.store.errors.size).toBe(0);
    await t.flush();

    const rows = [...store.errors.values()] as ErrorRow[];
    const web = rows.find((r) => r.source === 'web')!;
    expect(web.sample.ctx).toMatchObject({ theme: 'miami', room: 'ABCD', phase: 'play', path: '/r/' });
    expect(web.sample.ctx).not.toHaveProperty('obj');
    expect(web.sample.crumbs).toEqual(['phase:play']);
    const bot = rows.find((r) => r.source === 'bot')!;
    expect(bot.sample.ctx).toMatchObject({ host: 'nl' });
    expect(await (await fetch(`${http}/metrics`)).text()).toContain('game_errors_captured_total{instance="blue"} 2');
    // снаружи (не с 127.0.0.1 без X-Forwarded-For) внутренний вход закрыт
    const r = await fetch(`${http}/internal/errors`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: '[]' });
    expect(r.status).toBe(404);
  });
});
