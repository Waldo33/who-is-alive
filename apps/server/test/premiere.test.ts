import { describe, expect, it } from 'vitest';
import { FRIEND_REWARD, dayTasks } from '@kto/game-core';
import type { PremiereFacts } from '@kto/game-core';
import { MemoryStore } from '../src/store';
import { bindPremiereRef, premiereAfterMatch, premiereView } from '../src/premiere';

const at = (day: string, h = 12) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+03:00`);
const none: PremiereFacts = { won: false, clean: 0, accused: 0, cuts: 0, survived: 0, stars: false, awards: [], themes: [] };
const links = (...tg: number[]) => tg.map((t) => ({ gameUser: 'g' + t, tgUser: t, name: 'n', lang: 'ru' as const }));
const facts = (...tg: number[]) => Object.fromEntries(tg.map((t) => ['g' + t, none]));

describe('премьера на сервере', () => {
  it('матч двух людей с Telegram — каждому контрамарки; до сезона и в одиночку — нет', async () => {
    const store = new MemoryStore();
    expect(await premiereAfterMatch(store, links(1, 2), { director: null, facts: facts(1, 2) }, at('2026-12-10'))).toBe(0);
    expect(await premiereAfterMatch(store, links(1), { director: null, facts: facts(1) }, at('2026-12-17'))).toBe(0);
    // один Telegram на двух телефонах — тоже один человек
    expect(await premiereAfterMatch(store, [...links(1), { gameUser: 'x', tgUser: 1, name: 'n', lang: 'ru' }], { director: null, facts: { ...facts(1), x: none } }, at('2026-12-17'))).toBe(0);
    expect(await premiereAfterMatch(store, links(1, 2), { director: null, facts: facts(1, 2) }, at('2026-12-17'))).toBe(4);
    expect((await store.premiere(1))?.tickets).toBe(2);
    expect(store.premiereLog.filter((l) => l.tgUser === 1).map((l) => l.reason)).toEqual(['match', 'shift']);
  });

  it('друг по ссылке: только новичок, не сам себя; засчитан после трёх матчей, плюс доля', async () => {
    const store = new MemoryStore();
    const now = at('2026-12-17');
    expect(await bindPremiereRef(store, 5, 5, now)).toBe(false);
    await store.bumpTgStats(6, { matches: 1, wins: 0, rooms: 0, winAt: null });
    expect(await bindPremiereRef(store, 6, 9, now)).toBe(false);
    expect(await bindPremiereRef(store, 7, 9, now)).toBe(true);
    expect(await bindPremiereRef(store, 7, 8, now)).toBe(false);

    const task = dayTasks('2026-12-17').find((t) => t.id === 'win');
    for (let i = 0; i < 3; i++) {
      const f = { ...facts(7, 1), ...(task && i === 0 ? { g7: { ...none, won: true } } : {}) };
      await premiereAfterMatch(store, links(7, 1), { director: null, facts: f }, now + i * 60_000);
    }
    const ref = (await store.premiere(9))!;
    expect(ref.friends).toBe(1);
    expect(ref.tickets).toBeGreaterThanOrEqual(FRIEND_REWARD);
    expect((await store.premiere(7))!.refPaid).toBe(true);
    // четвёртый матч — друг больше не засчитывается
    await premiereAfterMatch(store, links(7, 1), { director: null, facts: facts(7, 1) }, now + 5 * 60_000);
    expect((await store.premiere(9))!.friends).toBe(1);
  });

  it('экран: задания дня с прогрессом, участие — с 5 контрамарками и подпиской', async () => {
    const store = new MemoryStore();
    const now = at('2026-12-17');
    await premiereAfterMatch(store, links(1, 2), { director: null, facts: facts(1, 2) }, now);
    const v = await premiereView(store, 1, now, true);
    expect(v.phase).toBe('on');
    expect(v.day).toHaveLength(3);
    expect(v.week).toHaveLength(3);
    expect(v.tickets).toBe(2);
    expect(v.entered).toBe(false);
    expect(v.streak).toBe(1);
    const before = await premiereView(store, 3, at('2026-12-01'), false);
    expect(before.phase).toBe('before');
    expect(before.day).toEqual([]);
  });
});
