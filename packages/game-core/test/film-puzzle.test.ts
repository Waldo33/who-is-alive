import { describe, expect, it } from 'vitest';
import type { PuzzleTake } from '../src';
import { PUZZLE_WATCH_MS, createLocalSession, findBestMoment, makeConfig, makeReplay, pickFilmPuzzle, puzzleHint, puzzleWorld, recordRound, worldOf, hasSanity } from '../src';

const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

/** Один дубль матча с ИИ (все четверо — ИИ-игроки, кроме «a», который стоит в толпе). */
function take(seed: number): PuzzleTake | null {
  const s = createLocalSession(makeConfig(), players, seed, 'a');
  if (hasSanity(s.theme)) return null;
  for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
  const sum = s.summary;
  if (!sum) return null;
  return { rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), arena: s.arena };
}

describe('загадка из фильма', () => {
  const takes = [11, 12, 13, 14, 15, 16, 21, 22].map(take).filter((t): t is PuzzleTake => !!t);

  it('находится в большинстве дублей и не пересекается с лучшим моментом', () => {
    let found = 0;
    for (const tk of takes) {
      const p = pickFilmPuzzle([tk]);
      if (!p) continue;
      found++;
      expect(p.pub.to - p.pub.from).toBe(PUZZLE_WATCH_MS);
      const m = findBestMoment(tk.rec)!;
      expect(p.pub.from >= m.to || p.pub.to <= m.from).toBe(true);
      expect(p.secret.answer.length).toBeGreaterThan(0);
      expect(p.secret.tells).toBeGreaterThanOrEqual(2);
    }
    expect(found).toBeGreaterThanOrEqual(Math.ceil(takes.length / 2));
  });

  it('в браузер не уходит ни ответ, ни связь игрок ↔ сущность', () => {
    const p = pickFilmPuzzle(takes)!;
    const json = JSON.stringify(p.pub);
    expect(json).not.toMatch(/"answer"|"players"|"pid"|"hintAt"|"attacker"/);
    expect(p.pub.kf.pending).toEqual([]);
    // открытого раскрытия в куске нет: ни удара по массовке, ни метки на актёре
    const actors = new Set(p.secret.answer);
    for (const ev of p.pub.log) {
      if (ev.at < p.pub.from - 1000) continue;
      expect(ev.t === 'hit' && ev.attacker !== undefined).toBe(false);
      if (ev.t === 'mark') expect(actors.has(ev.eid)).toBe(false);
    }
  });

  it('повтор из JSON совпадает с исходным матчем; ответ — в кадре на стоп-кадре', () => {
    const p = pickFilmPuzzle(takes)!;
    // дубль, из которого вырезана загадка, — по ключевому кадру (номер дубля у всех тестовых — 1)
    const kfKey = JSON.stringify(p.pub.kf.entities);
    const tk = takes.find((t) => t.rec.keyframes.some((k) => k.time === p.pub.kf.time && JSON.stringify(k.entities) === kfKey))!;
    const pub = JSON.parse(JSON.stringify(p.pub)) as typeof p.pub;
    const a = makeReplay(puzzleWorld(pub), pub.from, pub.to)!;
    const b = makeReplay(worldOf(tk.rec), pub.from, pub.to)!;
    while (a.time < pub.to) a.step();
    while (b.time < pub.to) b.step();
    const pos = (w: typeof a) => w.entities.map((e) => `${e.eid}:${e.alive ? 1 : 0}:${e.x.toFixed(2)},${e.y.toFixed(2)}`).join(' ');
    expect(pos(a)).toBe(pos(b));
    for (const eid of p.secret.answer) expect(a.get(eid)?.alive).toBe(true);
    const h1 = puzzleHint(pub, p.secret, 1)!;
    const h2 = puzzleHint(pub, p.secret, 2)!;
    const { x, y } = p.secret.hintAt;
    for (const h of [h1, h2]) expect(x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h).toBe(true);
  });

  it('детерминирована: одни и те же дубли — одна и та же загадка', () => {
    const p = pickFilmPuzzle(takes);
    const q = pickFilmPuzzle([11, 12, 13, 14, 15, 16, 21, 22].map(take).filter((t): t is PuzzleTake => !!t));
    expect(JSON.stringify(q)).toBe(JSON.stringify(p));
  });
});
