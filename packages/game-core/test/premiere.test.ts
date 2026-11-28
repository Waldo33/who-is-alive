import { describe, expect, it } from 'vitest';
import {
  BASE_PER_DAY,
  DAY_TASKS,
  FRIEND_MAX,
  SHARE_MAX,
  dayTasks,
  friendReady,
  newPremiere,
  premiereDay,
  premiereFacts,
  premiereFriend,
  premiereMatch,
  premierePhase,
  premiereShare,
  premiereWeek,
  weekTasks,
} from '../src/premiere';
import type { FactsRound, PremiereFacts, PremiereState } from '../src/premiere';

/** Полдень по Москве в этот день. */
const at = (day: string, h = 12) => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+03:00`);
const none: PremiereFacts = { won: false, clean: 0, accused: 0, cuts: 0, survived: 0, stars: false, awards: [], themes: [] };
const others = [111];

describe('премьера: сроки', () => {
  it('сутки и сезон — по Москве', () => {
    expect(premiereDay(Date.parse('2026-12-16T21:30:00Z'))).toBe('2026-12-17');
    expect(premierePhase(at('2026-12-16', 23))).toBe('before');
    expect(premierePhase(at('2026-12-17', 0))).toBe('on');
    expect(premierePhase(at('2026-12-30', 23))).toBe('on');
    expect(premierePhase(at('2026-12-31', 0))).toBe('after');
  });
  it('недели — с четверга', () => {
    expect(premiereWeek(at('2026-12-16'))).toBe(-1);
    expect(premiereWeek(at('2026-12-17', 0))).toBe(0);
    expect(premiereWeek(at('2026-12-23', 23))).toBe(0);
    expect(premiereWeek(at('2026-12-24', 0))).toBe(1);
  });
  it('задания дня одинаковые у всех, три разных; меняются по дням', () => {
    const a = dayTasks('2026-12-17').map((t) => t.id);
    expect(a).toEqual(dayTasks('2026-12-17').map((t) => t.id));
    expect(new Set(a).size).toBe(3);
    const days = Array.from({ length: 14 }, (_, i) => dayTasks(premiereDay(at('2026-12-17') + i * 86400_000)).map((t) => t.id).join());
    expect(new Set(days).size).toBeGreaterThan(5);
    expect(weekTasks(0)).toHaveLength(3);
  });
});

describe('премьера: начисление', () => {
  it('вне сезона и в одиночку — ничего', () => {
    expect(premiereMatch(newPremiere(), none, { others, directed: false }, at('2026-12-10')).gains).toEqual([]);
    expect(premiereMatch(newPremiere(), none, { others: [], directed: false }, at('2026-12-18')).gains).toEqual([]);
  });

  it('за матч — 1, не больше трёх в сутки; первый матч дня — смена', () => {
    let s = newPremiere();
    const got: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = premiereMatch(s, none, { others, directed: false }, at('2026-12-17') + i * 60_000);
      s = r.state;
      got.push(r.gains.filter((g) => g.reason === 'match').length);
    }
    expect(got).toEqual([1, 1, 1, 0, 0]);
    expect(got.filter(Boolean)).toHaveLength(BASE_PER_DAY);
    // 3 матча + смена
    expect(s.tickets).toBe(4);
  });

  it('серия: 3 дня подряд — +3, разрыв — заново', () => {
    let s = newPremiere();
    const streak = (day: string) => {
      const r = premiereMatch(s, none, { others, directed: false }, at(day));
      s = r.state;
      return r.gains.find((g) => g.reason === 'streak')?.n ?? 0;
    };
    expect([streak('2026-12-17'), streak('2026-12-18'), streak('2026-12-19')]).toEqual([0, 0, 3]);
    expect(streak('2026-12-21')).toBe(0);
    expect(s.streak).toBe(1);
  });

  it('задание дня выполняется один раз; во вторую неделю — вдвое', () => {
    const day = '2026-12-17';
    const task = dayTasks(day)[0];
    const f = factsFor(task.id);
    const r1 = premiereMatch(newPremiere(), f, { others, directed: false }, at(day));
    expect(r1.gains.find((g) => g.ref === task.id)?.n).toBe(task.reward);
    const r2 = premiereMatch(r1.state, f, { others, directed: false }, at(day, 13));
    expect(r2.gains.find((g) => g.ref === task.id)).toBeUndefined();

    const late = '2026-12-25';
    const t2 = dayTasks(late)[0];
    const r3 = premiereMatch(newPremiere(), factsFor(t2.id), { others, directed: false }, at(late));
    expect(r3.gains.find((g) => g.ref === t2.id)?.n).toBe(t2.reward * 2);
  });

  it('новые люди копятся за неделю, повторные не считаются', () => {
    let s = newPremiere();
    s = premiereMatch(s, none, { others: [1, 2], directed: false }, at('2026-12-17')).state;
    s = premiereMatch(s, none, { others: [1, 2], directed: false }, at('2026-12-17', 13)).state;
    expect(s.seen).toEqual([1, 2]);
    if (weekTasks(0).some((t) => t.id === 'faces')) expect(s.prog.faces).toBe(2);
  });

  it('друг и доля — с потолками, доля только с игры', () => {
    let s = newPremiere();
    for (let i = 0; i < FRIEND_MAX + 3; i++) s = premiereFriend(s).state;
    expect(s.friends).toBe(FRIEND_MAX);
    let t = newPremiere();
    t = premiereShare(t, [{ reason: 'task', n: 10 }, { reason: 'friend', n: 5 }]).state;
    expect(t.shared).toBe(2);
    for (let i = 0; i < 100; i++) t = premiereShare(t, [{ reason: 'task', n: 10 }]).state;
    expect(t.shared).toBe(SHARE_MAX);
  });

  it('пришедший по ссылке засчитывается после трёх матчей', () => {
    let s: PremiereState = { ...newPremiere(), refBy: 42 };
    for (let i = 0; i < 3; i++) {
      expect(friendReady(s)).toBe(false);
      s = premiereMatch(s, none, { others, directed: false }, at('2026-12-17') + i * 60_000).state;
    }
    expect(friendReady(s)).toBe(true);
  });
});

describe('премьера: факты матча', () => {
  it('считает метки, вырезанных, чистую работу, площадки', () => {
    const round: FactsRound = {
      reveal: [
        { pid: 'a', eid: 1, alive: true, x: 0, y: 0 },
        { pid: 'b', eid: 2, alive: false, x: 0, y: 0 },
      ],
      accusations: [{ pid: 'b', eid: 1, correct: true }],
      awards: [{ id: 'ninja', pids: ['a'], value: 1 }],
      starWinner: null,
      kills: [{ by: 1, victim: 2, at: 10 }],
      rec: { theme: 4, players: [], log: [] },
    };
    const missed: FactsRound = { ...round, rec: { theme: 0, players: [], log: [{ t: 'mark', eid: 1, until: 5, at: 1 }] } };
    const a = premiereFacts('a', [round, missed], { winners: ['a'] });
    expect(a).toMatchObject({ won: true, cuts: 2, clean: 1, survived: 2, awards: ['ninja'], themes: ['office', 'caps'] });
    expect(premiereFacts('b', [round], { winners: ['a'] })).toMatchObject({ accused: 1, cuts: 0, survived: 0 });
  });
});

/** Факты, которые точно выполняют задание дня `id`. */
function factsFor(id: string): PremiereFacts {
  const f: PremiereFacts = { ...none, awards: [] };
  const t = DAY_TASKS.find((x) => x.id === id)!;
  const set: Record<string, () => void> = {
    clean: () => (f.clean = t.goal),
    accuse: () => (f.accused = t.goal),
    ninja: () => f.awards.push('ninja'),
    botlike: () => f.awards.push('botlike'),
    stars: () => (f.stars = true),
    cuts: () => (f.cuts = t.goal),
    win: () => (f.won = true),
    survive: () => (f.survived = t.goal),
  };
  set[id]();
  return f;
}
