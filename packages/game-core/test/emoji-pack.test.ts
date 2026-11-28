import { describe, expect, it } from 'vitest';
import { EMOJI_BASE, EMOJI_PACK, PLAY_BADGES, REWARDS, emojiWanted, earnedRewards, openRewards, rewardMark } from '../src';

const bare = (e: string) => e.replace(/️/g, '');

describe('личный эмодзи-пак', () => {
  it('у каждого эмодзи пака своё эмодзи (по нему бот узнаёт картинку), и не как у значков статуса', () => {
    const all = [...EMOJI_BASE, ...REWARDS].map((x) => bare(x.emoji));
    expect(new Set(all).size).toBe(all.length);
    for (const b of PLAY_BADGES) expect(all).not.toContain(bare(b.emoji));
    expect(all.length).toBeLessThanOrEqual(200);
  });

  it('без «забрал пак» — пусто; с ним — 30 общих и открытые награды', () => {
    expect(emojiWanted(['kotBanan'])).toEqual([]);
    const w = emojiWanted([EMOJI_PACK, 'kotBanan', rewardMark('th_miami')]);
    expect(w).toHaveLength(EMOJI_BASE.length + 2);
    expect(w.map((x) => x.id)).toEqual(expect.arrayContaining(['buy_kotBanan', 'th_miami']));
  });

  it('засчитывает прошлое: стикеры площадок и событий, эффекты, 777 из счётчиков', () => {
    const open = openRewards(['st:penguin', 'st:clairvoyant', 'holo'], 2);
    expect(open).toEqual(expect.arrayContaining(['th_penguins', 'buy_effect', 'ev_jackpot']));
    expect(openRewards([])).toEqual([]);
  });

  it('за матч: площадки дублей и события игрока', () => {
    const rounds = [
      { reveal: [{ pid: 'a', eid: 1, alive: true, color: 0, name: 'A' }], awards: [], accusations: [{ pid: 'a', target: 2, correct: true }], theme: 2 },
    ] as unknown as Parameters<typeof earnedRewards>[1];
    const r = earnedRewards('a', rounds, { winners: [] });
    expect(r).toEqual(expect.arrayContaining(['th_penguins', 'ev_survive', 'ev_accuse', 'ev_clairvoyant']));
    expect(earnedRewards('b', rounds, { winners: [] })).toEqual([]);
  });
});
