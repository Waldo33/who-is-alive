import { describe, expect, it } from 'vitest';
import { MY_MAX, STICKER_LIST, THEME_RULES, earnedEvents, earnedStickers, mySlotIn, mySlots } from '../src';
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
    expect([...earnedEvents('a', rounds, { winners: ['a'] })].sort()).toEqual(['played', 'survive', 'unsuspected', 'win']);
    expect([...earnedEvents('b', rounds, { winners: ['a'] })].sort()).toEqual(['accuse', 'clairvoyant', 'cut', 'lose', 'paranoid', 'played']);
    expect(earnedStickers('a', rounds, { winners: ['a'] }).sort()).toEqual(['action', 'dance', 'extra', 'freeze', 'happyTears', 'oops', 'sfx', 'still', 'takeOn', 'who']);
    expect(earnedStickers('b', rounds, { winners: ['a'] }).sort()).toEqual(['action', 'allGood', 'cut', 'dance', 'fine', 'intended', 'meow', 'noDisturb', 'offscreen', 'oops', 'retake', 'splat', 'who']);
  });

  it('«за игру»: три звезды, «777» в казино, герой площадки за сыгранный на ней дубль', () => {
    const line = { kill: 0, survive: 0, stars: 0, accuse: 0, total: 0 };
    const casino = THEME_RULES.findIndex((t) => t.id === 'casino');
    const chefs = THEME_RULES.findIndex((t) => t.id === 'chefs');
    const rounds = [round({ starWinner: 'a', theme: chefs }), round({ points: { a: { ...line, slot: 3 }, b: line }, theme: casino })];
    const a = earnedStickers('a', rounds, { winners: [] });
    for (const id of ['star', 'jackpot', 'chef', 'casino']) expect(a).toContain(id);
    expect(a).not.toContain('penguin');
    const b = earnedStickers('b', rounds, { winners: [] });
    expect(b).not.toContain('star');
    expect(b).not.toContain('jackpot');
    expect(b).toContain('chef');
  });

  it('не игравший в матче ничего не получает; неверная метка — не в счёт', () => {
    const rounds = [round({ accusations: [{ pid: 'b', eid: 9, correct: false }] })];
    expect(earnedStickers('zz', rounds, { winners: ['zz'] })).toEqual([]);
    expect(earnedStickers('b', rounds, { winners: [] })).not.toContain('meow');
  });
});

describe('места под свои стикеры', () => {
  it('у старых паков — все сразу; у новых (drip) — 1 и +1 каждые 3 матча', () => {
    expect(mySlots(['starter', 'pack'])).toBe(MY_MAX);
    expect(mySlotIn(['starter', 'pack'])).toBeNull();
    const at = (n: number) => ['starter', 'pack', 'drip', `games:${n}`];
    expect([0, 2, 3, 6, 11, 12, 40].map((n) => mySlots(at(n)))).toEqual([1, 1, 2, 3, 4, 5, 5]);
    expect([0, 2, 3, 12].map((n) => mySlotIn(at(n)))).toEqual([3, 1, 3, null]);
  });
});
