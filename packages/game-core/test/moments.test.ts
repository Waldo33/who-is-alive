import { describe, expect, it } from 'vitest';
import { MOMENT_MS, createLocalSession, findBestMoment, makeConfig, makeReplay, recordRound, worldOf } from '../src';

const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

describe('лучший момент', () => {
  it('находит окно 6 с внутри раунда, и его можно проиграть после начала следующего раунда', () => {
    let found = 0;
    for (const seed of [11, 12, 13]) {
      const s = createLocalSession(makeConfig(), players, seed, 'me');
      for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
      expect(s.phase).toBe('reveal');
      const sum = s.summary!;
      const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo });
      const m = findBestMoment(rec)!;
      expect(m).not.toBeNull();
      expect(m.to - m.from).toBeLessThanOrEqual(MOMENT_MS);
      expect(m.from).toBeGreaterThanOrEqual(rec.keyframes[0].time);
      expect(m.to).toBeLessThanOrEqual(sum.replayTo);
      if (m.score > 0) found++;
      // следующий раунд сбрасывает мир — запись должна остаться целой
      const logLen = rec.log.length;
      for (let i = 0; i < 20 * 60 && s.round === sum.round; i++) s.tick();
      expect(s.round).toBe(sum.round + 1);
      expect(rec.log.length).toBe(logLen);
      const w = makeReplay(worldOf(rec), m.from, m.to)!;
      expect(w.time).toBeGreaterThanOrEqual(m.from - 1000);
      const alive = sum.reveal.filter((r) => w.get(r.eid)).length;
      expect(alive).toBe(4);
    }
    // ИИ-игроки бьют и собирают звёзды — хоть в одном раунде из трёх момент должен набрать очки
    expect(found).toBeGreaterThan(0);
  });
});
