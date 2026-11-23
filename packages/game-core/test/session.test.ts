import { describe, expect, it } from 'vitest';
import { createLocalSession, makeConfig } from '../src';
import type { ClientView } from '../src';

const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

function run(s: ReturnType<typeof createLocalSession>, until: () => boolean, max = 20 * 200) {
  for (let i = 0; i < max && !until(); i++) s.tick();
}

describe('ClientSession', () => {
  it('клиент видит только себя: никаких eid других игроков до разоблачения', () => {
    const s = createLocalSession(makeConfig(), players, 5, 'me');
    const view: ClientView = s;
    // в интерфейсе нет способа получить чужую сущность
    expect(Object.keys(view.me()!)).not.toContain('pid');
    expect('pr' in (Object.getPrototypeOf(view) as object)).toBe(false);
    run(s, () => s.phase === 'play', 20 * 10);
    expect(s.summary).toBeNull();
    run(s, () => s.phase === 'reveal', 20 * 100);
    expect(s.summary!.reveal.map((r) => r.pid).sort()).toEqual(['b', 'c', 'd', 'me']);
  });

  it('звёзды других — обезличенные числа по убыванию', () => {
    const s = createLocalSession(makeConfig(), players, 6, 'me');
    run(s, () => s.otherStars().some((n) => n > 0), 20 * 80);
    const o = s.otherStars();
    expect(o).toHaveLength(3);
    expect([...o].sort((a, b) => b - a)).toEqual(o);
  });

  it('отказы приходят только свои', () => {
    const s = createLocalSession(makeConfig(), players, 7, 'me');
    run(s, () => s.phase === 'play');
    for (let i = 0; i < 20 * 30; i++) {
      s.tick();
      for (const n of s.drainNotices()) if (n.t === 'denied') expect(n.pid).toBe('me');
    }
  });
});
