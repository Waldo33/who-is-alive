import { describe, expect, it } from 'vitest';
import { DICTS, matchShareText, roundOutcome } from '../src';
import type { RoundSummary } from '../src';

const sum = (o: Partial<RoundSummary>): RoundSummary => ({
  round: 1, endReason: 'time', starWinner: null, reveal: [], accusations: [], points: {}, awards: [], replayFrom: 0, replayTo: 0, ...o,
});
const rv = (pid: string, alive: boolean) => ({ pid, eid: 1, alive, x: 0, y: 0 });

describe('«Поделиться» итогом матча', () => {
  it('свой итог дубля: 3 звезды или последний в кадре — выиграл; иначе дожил или вырезан', () => {
    expect(roundOutcome(sum({ endReason: 'stars', starWinner: 'a', reveal: [rv('a', true), rv('b', true)] }), 'a')).toBe('win');
    expect(roundOutcome(sum({ endReason: 'stars', starWinner: 'b', reveal: [rv('a', true), rv('b', true)] }), 'a')).toBe('alive');
    expect(roundOutcome(sum({ endReason: 'last_alive', reveal: [rv('a', true), rv('b', false)] }), 'a')).toBe('win');
    expect(roundOutcome(sum({ endReason: 'last_alive', reveal: [rv('a', true), rv('b', false)] }), 'b')).toBe('cut');
    expect(roundOutcome(sum({ endReason: 'time', reveal: [rv('a', true)] }), 'a')).toBe('alive');
    expect(roundOutcome(sum({ reveal: [rv('a', true)] }), 'zz')).toBeNull();
  });

  it('строка: «Массовка · имя — N очков», квадраты своих дублей, призыв (ru и en)', () => {
    const rounds = ['win', 'cut', 'alive', null] as const;
    expect(matchShareText(DICTS.ru, 'ru', { name: 'Евгений', score: 4, rounds })).toBe('Массовка · Евгений — 4 очка\n🟨🟥🟩⬛\nОбыграешь?');
    expect(matchShareText(DICTS.ru, 'ru', { name: 'Тостер', score: 5, rounds: ['cut'] })).toBe('Массовка · Тостер — 5 очков\n🟥\nОбыграешь?');
    expect(matchShareText(DICTS.en, 'en', { name: 'Toaster', score: 1, rounds: ['alive', 'win'] })).toBe('Be Nobody · Toaster — 1 point\n🟩🟨\nCan you beat me?');
  });

  it('если файл не ушёл, текст не обещает клип («найди меня»)', () => {
    for (const t of [DICTS.ru, DICTS.en]) {
      for (const s of [t.clip.deathTextNoFile, t.clip.deathTextByNoFile, t.clip.shareKoNoFile]) expect(s).not.toMatch(/найд|find|spot/i);
    }
  });
});
