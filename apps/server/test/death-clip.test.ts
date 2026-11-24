import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalSession, makeConfig } from '@kto/game-core';
import type { LocalSession } from '@kto/game-core';
import { ClipStore } from '../src/clips';
import { deathClipJob } from '../src/death-clip';
import { FilmService } from '../src/film';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** Матч с ИИ до первого выбитого игрока; потом — до разоблачения этого дубля. */
function untilKnockout(seed: number) {
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, seed, 'a') as LocalSession;
  for (let i = 0; i < 20 * 60 * 20; i++) {
    s.tick();
    if (s.phase !== 'play') continue;
    const hit = s.world.log.find((e) => e.t === 'hit' && e.result === 'player');
    if (hit?.t !== 'hit') continue;
    const victim = players.find((p) => s.sim.playerRound(p.pid)?.eid === hit.target);
    if (!victim) continue;
    // как телефон: кнопка «Клип» появляется через 3,4 с после удара
    for (let k = 0; k < 70 && s.phase === 'play'; k++) s.tick();
    return { s, pid: victim.pid, eid: hit.target, round: s.round };
  }
  throw new Error('никого не выбили');
}

describe('клип выбывшего на сервере: что монтировать', () => {
  it('посреди дубля — подсвечен только сам выбывший, остальные не раскрыты', () => {
    const { s, pid, eid } = untilKnockout(7);
    const job = deathClipJob(s, pid, eid, { lang: 'ru', noGore: false })!;
    expect(job).not.toBeNull();
    expect(job.known).toBe(false);
    expect(job.hero).toBe(eid);
    expect(job.players.map((p) => p.eid)).toEqual([eid]);
    expect(job.rec.players).toEqual([]);
    expect(job.moment.victim).toBe(eid);
    expect(job.moment.to - job.moment.from).toBeGreaterThanOrEqual(1500);
  });

  it('после разоблачения — все живые с именами и тот, кто выбил', () => {
    const { s, pid, eid, round } = untilKnockout(7);
    for (let i = 0; i < 20 * 120 && s.phase !== 'reveal'; i++) s.tick();
    expect(s.round).toBe(round);
    const job = deathClipJob(s, pid, eid, { lang: 'ru', noGore: true })!;
    expect(job.known).toBe(true);
    expect(job.players.length).toBe(4);
    expect(job.moment.attacker).toBeDefined();
    expect(job.noGore).toBe(true);
  });

  it('не выбит — клипа нет', () => {
    const { s, pid } = untilKnockout(7);
    const other = ['a', 'b', 'c', 'd'].find((p) => p !== pid && s.sim.playerRound(p)?.alive)!;
    expect(deathClipJob(s, other, s.sim.playerRound(other)!.eid, { lang: 'ru', noGore: false })).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('клип выбывшего на сервере: монтаж', () => {
  it('mp4 1080×1920 со звуком; длинная очередь — отказ (монтирует телефон)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clip-'));
    try {
      const store = new ClipStore(dir);
      const logs: string[] = [];
      const film = new FilmService({ store, site: 'benobody.app', fonts: join(__dirname, '../../web/assets/og'), log: (_l, m, d) => logs.push(`${m} ${JSON.stringify(d ?? {})}`) });
      const { s, pid, eid } = untilKnockout(7);
      const job = deathClipJob(s, pid, eid, { lang: 'ru', noGore: false })!;
      const etas: number[] = [];
      const t0 = Date.now();
      const p1 = film.clip(job, (e) => etas.push(e));
      const p2 = film.clip(job, (e) => etas.push(e));
      // третий ждал бы дольше 8 с — сразу отказ
      expect(film.clip(job)).toBeNull();
      expect(p1).not.toBeNull();
      expect(p2).not.toBeNull();
      expect(etas.length).toBe(2);
      expect(etas[1]).toBeGreaterThan(etas[0]);
      const done = await p1!;
      expect(done, logs.join('\n')).not.toBeNull();
      const ms = Date.now() - t0;
      await p2;
      const path = await store.file(done!.id, 'mp4');
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path!], { encoding: 'utf8' });
      const info = JSON.parse(probe.stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
      const video = info.streams.find((x) => x.codec_type === 'video')!;
      expect([video.width, video.height]).toEqual([1080, 1920]);
      expect(info.streams.some((x) => x.codec_type === 'audio')).toBe(true);
      const dur = Number(info.format.duration);
      expect(dur).toBeGreaterThan(5);
      expect(done!.thumb).toBe(true);
      console.log(`клип: ${dur.toFixed(1)} с, монтаж ${ms} мс; ${logs.filter((l) => l.startsWith('clip_made')).join(' | ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!hasFfmpeg)('клип выбывшего: комната целиком', () => {
  it('выбитый просит клип — making с eta, потом ready с файлом; живой — отказ', async () => {
    const { Room } = await import('../src/room');
    const { silentLogger } = await import('../src/log');
    const dir = mkdtempSync(join(tmpdir(), 'clip-room-'));
    try {
      const store = new ClipStore(dir);
      const film = new FilmService({ store, site: 'benobody.app', fonts: join(__dirname, '../../web/assets/og'), log: () => {} });
      let now = 1_000_000;
      const room = new Room({ code: 'ABCD', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false }, lang: 'ru', now: () => now, log: silentLogger, film });
      const got: Record<string, { t: string; n?: number; state?: string; eta?: number; id?: string }[]> = { a: [], b: [] };
      for (const u of ['a', 'b']) room.join(u, u.toUpperCase(), { send: (t) => got[u].push(JSON.parse(t)), close: () => {} });
      room.setReady('b', true);
      expect(room.start('a')).toBeNull();
      const h = room.runner!.host;
      const step = (ms: number) => {
        now += ms;
        room.runner!.pump();
      };
      for (let i = 0; i < 400 && h.phase !== 'play'; i++) step(50);
      step(3000);
      // a подходит к b вплотную и бьёт
      const ea = h.sim.playerRound('a')!.eid;
      const eb = h.sim.playerRound('b')!.eid;
      const A = h.world.get(ea)!;
      const B = h.world.get(eb)!;
      A.x = B.x + 4;
      A.y = B.y;
      h.sim.intent('a', { k: 'attack', eid: eb });
      step(50);
      expect(h.sim.playerRound('b')!.alive).toBe(false);
      step(3400);
      room.clip('a', { n: 1, round: h.round, lang: 'ru', mild: false });
      expect(got.a.at(-1)).toMatchObject({ t: 'clip', n: 1, state: 'failed' });
      room.clip('b', { n: 7, round: h.round, lang: 'en', mild: true });
      const making = got.b.find((m) => m.t === 'clip' && m.state === 'making');
      expect(making?.eta).toBeGreaterThan(1000);
      for (let i = 0; i < 300 && !got.b.some((m) => m.t === 'clip' && m.state !== 'making'); i++) await new Promise((r) => setTimeout(r, 100));
      const ready = got.b.find((m) => m.t === 'clip' && m.state === 'ready');
      expect(ready?.n).toBe(7);
      expect(await store.file(ready!.id!, 'mp4')).not.toBeNull();
      room.runner?.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
