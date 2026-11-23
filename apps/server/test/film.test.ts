import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { ClipStore } from '../src/clips';
import { FilmService } from '../src/film';
import type { FilmTake } from '../../web/src/game/film';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** Матч с ИИ до конца и дубли — как их копит MatchRunner (room.ts). */
function playMatch(seed: number) {
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, seed, 'a');
  const takes: FilmTake[] = [];
  let last = -1;
  for (let i = 0; i < 20 * 60 * 20 && s.phase !== 'match_end'; i++) {
    s.tick();
    const sum = s.summary;
    if (s.phase === 'reveal' && sum && s.round !== last) {
      last = s.round;
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), summary: sum, arena: s.arena });
    }
  }
  return { takes, players, match: s.match! };
}

describe.skipIf(!hasFfmpeg)('фильм матча на сервере', () => {
  it('монтирует mp4 со звуком и обложкой за разумное время', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'film-'));
    try {
      const store = new ClipStore(dir);
      const logs: string[] = [];
      const film = new FilmService({ store, site: 'benobody.app', fonts: join(__dirname, '../../web/assets/og'), log: (_l, m, d) => logs.push(`${m} ${JSON.stringify(d ?? {})}`) });
      const { takes, players, match } = playMatch(12);
      expect(takes.length).toBeGreaterThan(1);
      const t0 = Date.now();
      const done = await film.make({ takes, players, match, lang: 'ru' });
      expect(done, logs.join("\n")).not.toBeNull();
      if (process.env.KEEP_FILM) console.log(logs.join("\n"));
      const path = await store.file(done!.id, 'mp4');
      expect(path).not.toBeNull();
      expect(done!.thumb).toBe(true);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path!], { encoding: 'utf8' });
      const info = JSON.parse(probe.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
      const video = info.streams.find((x) => x.codec_type === 'video')!;
      expect([video.width, video.height]).toEqual([1080, 1920]);
      expect(info.streams.some((x) => x.codec_type === 'audio')).toBe(true);
      const dur = Number(info.format.duration);
      expect(dur).toBeGreaterThan(8);
      expect(dur).toBeLessThan(26);
      expect(statSync(path!).size).toBeLessThan(12 * 1024 * 1024);
      console.log(`фильм: ${dur.toFixed(1)} с, ${(statSync(path!).size / 1e6).toFixed(1)} МБ, монтаж ${Date.now() - t0} мс`);
    } finally {
      if (!process.env.KEEP_FILM) rmSync(dir, { recursive: true, force: true });
      else console.log(dir);
    }
  }, 120_000);
});
