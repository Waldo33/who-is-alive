import { describe, expect, it } from 'vitest';
import { matchStory } from '../src/story';
import type { StoryRound } from '../src/story';

const P = ['a', 'b', 'c', 'd'];
const r = (points: Record<string, number>, kills: [string, string][] = [], botHits: Record<string, number> = {}): StoryRound => ({
  points,
  kills: kills.map(([by, victim]) => ({ by, victim })),
  botHits,
});

describe('сюжет матча для финала фильма', () => {
  it('камбэк: отставал на 3+ и выиграл — самый сильный сюжет', () => {
    const s = matchStory([r({ b: 3 }), r({ b: 1, c: 1 }), r({ a: 4 }), r({ a: 4 })], P, ['a'])!;
    expect(s.kind).toBe('comeback');
    expect(s.value).toBe(4);
    expect(s.lowRound).toBe(2);
    expect(s.history.a).toEqual([0, 0, 0, 4, 8]);
  });

  it('фотофиниш: второе место в одном очке', () => {
    const s = matchStory([r({ a: 3, b: 2 }), r({ a: 2, b: 2 }), r({ a: 3, b: 3 })], P, ['a'])!;
    expect(s.kind).toBe('photo');
    expect(s.rival).toBe('b');
    expect(s.value).toBe(1);
  });

  it('дуэль: вырезали друг друга 4 раза, победитель — чаще', () => {
    const s = matchStory(
      [r({ a: 4, c: 1 }, [['a', 'c'], ['c', 'a']]), r({ a: 4 }, [['a', 'c'], ['a', 'c']]), r({ c: 1 }, [['c', 'b']])],
      P,
      ['a'],
    )!;
    expect(s.kind).toBe('duel');
    expect(s.rival).toBe('c');
    expect([s.value, s.value2]).toEqual([3, 1]);
  });

  it('гроза площадки: 4 вырезания — половина всех', () => {
    const s = matchStory([r({ a: 4 }, [['a', 'b'], ['a', 'c']]), r({ a: 4, b: 1 }, [['a', 'd'], ['a', 'b'], ['b', 'c']])], P, ['a'])!;
    expect(s.kind).toBe('hunter');
    expect(s.value).toBe(4);
    expect(s.victims).toEqual(['b', 'c', 'd', 'b']);
  });

  it('невидимка: ни разу не вырезан и не раскрыт', () => {
    const rounds = [r({ a: 3, b: 2 }, [['b', 'c']]), r({ a: 3 }), r({ a: 2, b: 2 }, [['c', 'b']])];
    expect(matchStory(rounds, P, ['a'])!.kind).toBe('ghost');
    // ударил массовку — уже раскрыт
    rounds[1] = r({ a: 3 }, [], { a: 1 });
    expect(matchStory(rounds, P, ['a'])!.kind).toBe('runaway');
  });

  it('«Слишком заметные» и пустой матч', () => {
    expect(matchStory([r({ a: 3 })], P, [], true)!.kind).toBe('star');
    expect(matchStory([], P, ['a'])).toBeNull();
  });

  it('одни и те же итоги — одна и та же история', () => {
    const rounds = [r({ b: 3, a: 1 }, [['a', 'b']]), r({ a: 3 }, [['b', 'a']]), r({ a: 4, b: 1 })];
    expect(matchStory(rounds, P, ['a'])).toEqual(matchStory(rounds, P, ['a']));
  });
});
