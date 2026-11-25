import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { renderFilm } from '../src/film-render';
import type { FilmJob } from '../src/film-render';
import { MatchRecordings, RECORDING_NAME, readRecordingFile } from '../src/recordings';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

function job(seed: number): FilmJob {
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, seed, 'a');
  const takes: FilmJob['takes'] = [];
  let last = -1;
  for (let i = 0; i < 20 * 60 * 20 && s.phase !== 'match_end'; i++) {
    s.tick();
    const sum = s.summary;
    if (s.phase === 'reveal' && sum && s.round !== last) {
      last = s.round;
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), summary: sum, arena: s.arena });
    }
  }
  return { takes, players, match: s.match!, lang: 'ru', site: 'benobody.app', link: 'https://benobody.app/?src=film' };
}

describe('записи матчей', () => {
  it('файл — gzip JSON стабильного формата: без адреса сайта, сетка навигации — только клетка', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    try {
      const store = new MatchRecordings(dir, () => Date.UTC(2026, 10, 24, 19, 5, 7));
      const name = await store.save(job(13));
      expect(name).toMatch(RECORDING_NAME);
      expect(name.startsWith('20261124-190507-')).toBe(true);
      const raw = JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString('utf8'));
      expect(raw.format).toBe('massovka-match');
      expect(raw.v).toBe(1);
      expect(raw.job.site).toBeUndefined();
      expect(raw.job.takes[0].rec.nav).toEqual({ cell: expect.any(Number) });
      expect(raw.job.takes.length).toBeGreaterThan(1);
      const back = await readRecordingFile(join(dir, name));
      expect(back.job.players.map((p) => p.name)).toEqual(['Енот', 'Батон', 'Пиксель', 'Кот']);
      expect(await store.list()).toEqual([name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('старше двух суток — убираются', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    try {
      let now = Date.now();
      const store = new MatchRecordings(dir, () => now);
      const j = job(12);
      const old = await store.save(j);
      const t = (Date.now() - 49 * 3600_000) / 1000;
      utimesSync(join(dir, old), t, t);
      now += 1000;
      const fresh = await store.save(j);
      expect(await store.list()).toEqual([fresh]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)('по записи монтируется тот же фильм, что и по живому матчу', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    try {
      const j = job(12);
      const name = await new MatchRecordings(dir).save(j);
      const back = await readRecordingFile(join(dir, name));
      const opts = { fonts: join(__dirname, '../../web/assets/og'), tmp: dir };
      const a = await renderFilm(j, opts);
      const b = await renderFilm({ ...back.job, site: j.site, link: j.link, finale: 'board' }, opts);
      expect(a && b).toBeTruthy();
      expect(b!.durationMs).toBe(a!.durationMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
