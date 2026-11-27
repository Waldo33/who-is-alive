import { describe, expect, it } from 'vitest';
import { STICKER_LIST, earnedEvents, earnedStickers } from '../src';
import type { EarnRound } from '../src';

/** Стикеры за события матча (shop.ts › earn): считаются по итогам дублей, одинаково на любом сервере. */

const round = (over: Partial<EarnRound> = {}): EarnRound => ({
  reveal: [
    { pid: 'a', eid: 1, alive: true, x: 0, y: 0 },
    { pid: 'b', eid: 2, alive: false, x: 0, y: 0 },
  ],
  awards: [],
  accusations: [],
  ...over,
});

describe('стикеры за матч', () => {
  it('у каждого закрытого стикера набора есть условие, у выдаваемых сразу — нет', () => {
    for (const s of STICKER_LIST) expect(!!s.earn).toBe(!s.now);
  });

  it('победа, поражение, вырезан, «Параноик», «Чистая массовка», метка из-за кадра', () => {
    const rounds = [
      round({ awards: [{ id: 'paranoid', pids: ['b'], value: 2 }, { id: 'botlike', pids: ['a'], value: 0 }], accusations: [{ pid: 'b', eid: 1, correct: true }] }),
      round(),
    ];
    expect([...earnedEvents('a', rounds, { winners: ['a'] })].sort()).toEqual(['unsuspected', 'win']);
    expect([...earnedEvents('b', rounds, { winners: ['a'] })].sort()).toEqual(['clairvoyant', 'cut', 'lose', 'paranoid']);
    expect(earnedStickers('a', rounds, { winners: ['a'] }).sort()).toEqual(['freeze', 'happyTears']);
    expect(earnedStickers('b', rounds, { winners: ['a'] }).sort()).toEqual(['aaa', 'allGood', 'meow', 'splat']);
  });

  it('не игравший в матче ничего не получает; неверная метка — не в счёт', () => {
    const rounds = [round({ accusations: [{ pid: 'b', eid: 9, correct: false }] })];
    expect(earnedStickers('zz', rounds, { winners: ['zz'] })).toEqual([]);
    expect(earnedStickers('b', rounds, { winners: [] })).not.toContain('meow');
  });
});
