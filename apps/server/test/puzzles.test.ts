import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PUZZLE_TRIES, createLocalSession, hasSanity, makeConfig, recordRound } from '@kto/game-core';
import type { PuzzleTake } from '@kto/game-core';
import { PUZZLE_CODE, PuzzleStore } from '../src/puzzles';
import { S3Client } from '../src/s3';
import { GameServer } from '../src/server';

const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));
function take(seed: number): PuzzleTake | null {
  const s = createLocalSession(makeConfig(), players, seed, 'a');
  if (hasSanity(s.theme)) return null;
  for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
  const sum = s.summary;
  if (!sum) return null;
  return { rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), arena: s.arena };
}

/** S3 в памяти: PUT кладёт, GET отдаёт (подпись не проверяем — это делает s3.test.ts). */
function memS3() {
  const objects = new Map<string, Buffer>();
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const key = new URL(String(url)).pathname.replace(/^\/b\//, '');
    if (init?.method === 'PUT') {
      objects.set(key, Buffer.from(init.body as Uint8Array));
      return new Response('', { status: 200 });
    }
    const o = objects.get(key);
    return o ? new Response(new Uint8Array(o), { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  return { objects, s3: new S3Client({ endpoint: 'https://s3.test', region: 'ru-1', bucket: 'b', accessKey: 'k', secretKey: 's' }, fake) };
}

const silent = () => undefined;

describe('загадки из фильма: хранилище и маршрут', () => {
  const takes = [11, 12, 13, 14, 15, 16].map(take).filter((t): t is PuzzleTake => !!t);
  const dirs: string[] = [];
  const tmp = async () => {
    const d = await mkdtemp(join(tmpdir(), 'pz-'));
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('сохраняет на диск и в S3, второй экземпляр поднимает загадку из S3; через 30 суток — нет', async () => {
    const { s3, objects } = memS3();
    let now = Date.parse('2026-11-25T10:00:00Z');
    const a = new PuzzleStore(await tmp(), () => now, { s3 });
    const made = await a.create(takes, 'ru');
    expect(made).not.toBeNull();
    expect(made!.code).toMatch(PUZZLE_CODE);
    await a.flushRemote();
    expect(objects.has(`puzzles/${made!.code}.json.gz`)).toBe(true);
    const b = new PuzzleStore(await tmp(), () => now, { s3 });
    const doc = await b.get(made!.code);
    expect(doc?.pub.from).toBe(made!.puzzle.pub.from);
    now += 31 * 86_400_000;
    expect(await new PuzzleStore(await tmp(), () => now, { s3 }).get(made!.code)).toBeNull();
  });

  it('GET без ответа; тап: промах — подсказка, попал — ответ и доля нашедших', async () => {
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silent, puzzles: new PuzzleStore(await tmp()) });
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    try {
      const made = (await srv.puzzles.create(takes, 'en'))!;
      const code = made.code;
      const g = await fetch(`${http}/v1/puzzles/${code.toLowerCase()}`);
      expect(g.status).toBe(200);
      const text = await g.text();
      expect(text).not.toMatch(/"answer"|"hintAt"|"pid"/);
      expect(JSON.parse(text)).toMatchObject({ code, lang: 'en' });
      expect((await fetch(`${http}/v1/puzzles/ZZZZZ`)).status).toBe(404);

      const answer = made.puzzle.secret.answer;
      const miss = made.puzzle.pub.kf.entities.map((e) => e.eid).find((id) => !answer.includes(id))!;
      const tap = (eid: number, n: number, d: string) =>
        fetch(`${http}/v1/puzzles/${code}/tap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ eid, n, d }) }).then((r) => r.json());
      const r1 = await tap(miss, 1, 'device-0001');
      expect(r1).toMatchObject({ hit: false, done: false });
      expect(r1.answer).toBeUndefined();
      const r2 = await tap(answer[0], 2, 'device-0001');
      expect(r2).toMatchObject({ hit: true, done: true, answer, stats: { played: 1, found: 1 } });
      // второй зритель не нашёл за три попытки (время вышло трижды)
      for (let n = 1; n < PUZZLE_TRIES; n++) expect(await tap(-1, n, 'device-0002')).toMatchObject({ hit: false, done: false });
      const r3 = await tap(-1, PUZZLE_TRIES, 'device-0002');
      expect(r3).toMatchObject({ hit: false, done: true, stats: { played: 2, found: 1 } });
      // повтор с того же телефона не накручивает итоги и не даёт новых попыток
      expect(await tap(answer[0], 1, 'device-0002')).toMatchObject({ hit: false, done: true, stats: { played: 2, found: 1 } });

      // M4: номер попытки считает сервер. «Третья попытка» первым же тапом ответа не даёт…
      const s1 = await tap(miss, PUZZLE_TRIES, 'device-0003');
      expect(s1).toMatchObject({ hit: false, done: false });
      expect(s1.answer).toBeUndefined();
      // …повтор того же тапа (сеть моргнула) отвечает так же, а перебор «первой попыткой» — это вторая и третья
      expect(await tap(miss, 1, 'device-0003')).toMatchObject({ hit: false, done: false });
      expect(await tap(miss + 1000, 1, 'device-0003')).toMatchObject({ done: false });
      // третья (последняя) попытка может попасть, но четвёртой нет
      expect(await tap(answer[0], 1, 'device-0003')).toMatchObject({ hit: true, done: true, stats: { played: 3, found: 2 } });
      // повтор того же тапа с номером страницы — тот же ответ, итоги не удваиваются
      expect(await tap(answer[0], 3, 'device-0003')).toMatchObject({ hit: true, done: true, stats: { played: 3, found: 2 } });
      expect(await tap(answer[1] ?? answer[0], 2, 'device-0003')).toMatchObject({ hit: false, done: true });
    } finally {
      await srv.close();
    }
  });
});
