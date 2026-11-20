import { describe, expect, it } from 'vitest';
import type { WorldEvent } from '../src';
import { MOMENT_MAX_MS, MOMENT_MIN_MS, coreFrom, createLocalSession, findBestMoment, makeConfig, makeReplay, momentEvents, recordRound, worldOf } from '../src';

const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

describe('лучший момент', () => {
  it('находит окно 6 с внутри раунда, и его можно проиграть после начала следующего раунда', () => {
    let found = 0;
    for (const seed of [11, 12, 13, 14, 15, 16, 21, 22, 23, 24]) {
      const s = createLocalSession(makeConfig(), players, seed, 'me');
      for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
      expect(s.phase).toBe('reveal');
      const sum = s.summary!;
      const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo });
      const self = sum.reveal.find((r) => r.pid === 'me')!.eid;
      const m = findBestMoment(rec, self)!;
      expect(m).not.toBeNull();
      expect(m.to - m.from).toBeLessThanOrEqual(MOMENT_MAX_MS);
      if (m.score > 0) expect(m.to - m.from).toBeGreaterThanOrEqual(Math.min(MOMENT_MIN_MS, m.to - rec.keyframes[0].time));
      // главное: ни одно выбивание не обрезано краем окна — ни удар без подхода, ни подход без удара
      for (const e of momentEvents(rec, self)) {
        if (e.kind !== 'knockout') continue;
        const overlaps = e.to > m.from && e.from < m.to;
        if (overlaps) expect(coreFrom(e) >= m.from && e.to <= m.to, `knockout at ${e.at} cut by window ${m.from}..${m.to}`).toBe(true);
      }
      expect(m.from).toBeGreaterThanOrEqual(rec.keyframes[0].time);
      expect(m.to).toBeLessThanOrEqual(sum.replayTo);
      if (m.score > 0) found++;
      // следующий раунд сбрасывает мир — запись должна остаться целой
      const logLen = rec.log.length;
      // выбивание того, кто делает клип, в клип попадает (если оно было в раунде)
      const myDeath = momentEvents(rec, self).find((e) => e.kind === 'knockout' && e.pts >= 8);
      if (myDeath && m.kind === 'knockout') expect(m.score).toBeGreaterThanOrEqual(myDeath.pts);
      // было выбивание — клип про выбивание (или звезду/удар), а не про то, как все постояли рядом
      if (momentEvents(rec, self).some((e) => e.kind === 'knockout')) expect(m.kind).not.toBe('close');
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

  it('событие у самого конца раунда помещается в окно: третья звезда завершает раунд', () => {
    const s = createLocalSession(makeConfig(), players, 31, 'me');
    for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
    const sum = s.summary!;
    const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo });
    const end = rec.playEnd + 30; // конец раунда не на сетке окон
    const who = sum.reveal[1].eid;
    const log: WorldEvent[] = rec.log.filter((e) => e.t !== 'hit' && e.t !== 'star_taken');
    for (const [i, dt] of [3000, 1500, 0].entries()) log.push({ t: 'star_taken', id: 900 + i, eid: who, at: end - dt });
    const m = findBestMoment({ ...rec, log, playEnd: end })!;
    expect(m.kind).toBe('star3');
    expect(m.to).toBe(end);
  });

  it('своё выбивание узнаётся по месту удара, хотя в событии нападавшего нет', () => {
    let checked = 0;
    for (const seed of [41, 42, 43, 44, 45, 46]) {
      const s = createLocalSession(makeConfig(), players, seed, 'me');
      for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
      const sum = s.summary!;
      const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo });
      for (const r of sum.reveal) {
        const evs = momentEvents(rec, r.eid).filter((e) => e.kind === 'knockout');
        // кого-то выбили — у кого-то из игроков это его удар
        for (const e of evs) if (e.selfRole === 'attacker') checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
