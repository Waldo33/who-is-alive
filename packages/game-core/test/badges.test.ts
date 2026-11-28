import { describe, expect, it } from 'vitest';
import { BADGE_IDS, DICTS, NO_STATS, STAR_MS, badgeEmoji, badgesOf } from '../src';

const by = (list: ReturnType<typeof badgesOf>, id: string) => list.find((b) => b.id === id)!;

describe('значки для статуса', () => {
  it('новичку ничего, кроме прогресса', () => {
    const b = badgesOf(NO_STATS, [], 1000);
    expect(b.every((x) => !x.have)).toBe(true);
    expect(by(b, 'director')).toMatchObject({ n: 0, of: 10 });
  });

  it('первый матч — «На площадке», 50 матчей — «Киноплёнка»', () => {
    expect(by(badgesOf({ ...NO_STATS, matches: 1 }, [], 0), 'onSet').have).toBe(true);
    expect(by(badgesOf({ ...NO_STATS, matches: 49 }, [], 0), 'reel')).toMatchObject({ have: false, n: 49 });
    expect(by(badgesOf({ ...NO_STATS, matches: 70 }, [], 0), 'reel')).toMatchObject({ have: true, n: 50 });
  });

  it('«Звезда дубля» — сутки после победы, со сроком', () => {
    const won = 5_000_000;
    expect(by(badgesOf({ ...NO_STATS, wins: 1, lastWin: won }, [], won + 1000), 'star')).toMatchObject({ have: true, until: won + STAR_MS });
    expect(by(badgesOf({ ...NO_STATS, wins: 1, lastWin: won }, [], won + STAR_MS), 'star')).toMatchObject({ have: false, until: null });
  });

  it('«Режиссёр» — 10 комнат, «Статуэтка» — 100 побед', () => {
    expect(by(badgesOf({ ...NO_STATS, rooms: 10 }, [], 0), 'director').have).toBe(true);
    expect(by(badgesOf({ ...NO_STATS, wins: 99 }, [], 0), 'oscar').have).toBe(false);
    expect(by(badgesOf({ ...NO_STATS, wins: 100 }, [], 0), 'oscar').have).toBe(true);
  });

  it('значок скина — за покупку набора', () => {
    expect(by(badgesOf(NO_STATS, ['kotBanan'], 0), 'kotBanan').have).toBe(true);
    expect(by(badgesOf(NO_STATS, ['starter'], 0), 'kotBanan').have).toBe(false);
  });

  it('у каждого значка своё эмодзи и тексты на обоих языках', () => {
    expect(new Set(BADGE_IDS.map(badgeEmoji)).size).toBe(BADGE_IDS.length);
    for (const d of Object.values(DICTS)) for (const id of BADGE_IDS) expect(d.shop.badges.names[id] && d.shop.badges.how[id]).toBeTruthy();
  });
});
