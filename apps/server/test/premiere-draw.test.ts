import { describe, expect, it } from 'vitest';
import { newPremiere } from '@kto/game-core';
import { silentLogger } from '../src/log';
import { Shop, localLedger } from '../src/shop';
import { MemoryStore } from '../src/store';
import { PRIZES, drandRound, drandTime, drawWinners, entrantsText, sha256 } from '../src/premiere-draw';

const R = 'a'.repeat(64);

describe('жеребьёвка премьеры', () => {
  it('список канонический: порядок входа не важен', () => {
    const a = entrantsText([{ tg: 5, tickets: 7 }, { tg: 2, tickets: 9 }]);
    expect(a).toBe('2 9\n5 7');
    expect(sha256(a)).toBe(sha256(entrantsText([{ tg: 2, tickets: 9 }, { tg: 5, tickets: 7 }])));
  });

  it('воспроизводимо, без повторов, призов не больше участников', () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ tg: 1000 + i, tickets: 5 + (i % 7) }));
    const w = drawWinners(list, R);
    expect(w).toEqual(drawWinners([...list].reverse(), R));
    expect(w).toHaveLength(PRIZES.length);
    expect(new Set(w).size).toBe(w.length);
    expect(drawWinners(list.slice(0, 2), R)).toHaveLength(2);
    expect(drawWinners(list, 'b'.repeat(64))).not.toEqual(w);
    expect(() => drawWinners(list, 'zz')).toThrow();
  });

  it('шанс — по контрамаркам', () => {
    const list = [{ tg: 1, tickets: 90 }, { tg: 2, tickets: 10 }];
    let first = 0;
    for (let i = 0; i < 400; i++) if (drawWinners(list, sha256(String(i)), 1)[0] === 1) first++;
    expect(first / 400).toBeGreaterThan(0.8);
    expect(first / 400).toBeLessThan(0.97);
  });

  it('раунды drand: время ↔ номер', () => {
    const t = Date.parse('2026-12-31T18:00:00+03:00');
    const r = drandRound(t);
    expect(drandTime(r)).toBeGreaterThanOrEqual(t);
    expect(drandTime(r) - t).toBeLessThan(30_000);
  });
});

describe('жеребьёвка: шаги на сервере', () => {
  it('freeze → draw → gift: только подписанные с 5+, повтор не дарит дважды', async () => {
    const store = new MemoryStore();
    const calls: { m: string; b: Record<string, unknown> }[] = [];
    const subs: Record<number, string> = { 1: 'member', 2: 'left', 3: 'member' };
    const api = async (m: string, b: Record<string, unknown> | FormData) => {
      const body = b as Record<string, unknown>;
      calls.push({ m, b: body });
      if (m === 'getChatMember') return { status: subs[body.user_id as number] ?? 'left' } as never;
      return true as never;
    };
    const rand = 'c'.repeat(64);
    let round = 0;
    const shop = new Shop({ api, username: async () => 'b', ledger: localLedger(store), log: silentLogger, stickersDir: '', channel: 'https://t.me/x', channelId: '-100', fetchJson: async () => ({ round, randomness: rand }) });
    for (const [tg, n] of [[1, 9], [2, 9], [3, 5], [4, 4]] as const) {
      await store.premiereUpdate(tg, () => ({ state: { ...newPremiere(), tickets: n }, log: [] }));
    }
    const during = Date.parse('2026-12-20T12:00:00+03:00');
    expect((await shop.premiereAdmin({ action: 'freeze' }, during)).status).toBe(409);
    const after = Date.parse('2026-12-31T10:00:00+03:00');
    const f = await shop.premiereAdmin({ action: 'freeze' }, after);
    expect(f.body).toMatchObject({ count: 2, tickets: 14, digest: sha256('1 9\n3 5') });
    round = (f.body as { round: number }).round;
    expect((await shop.premiereAdmin({ action: 'draw' }, after)).status).toBe(409);
    const d = await shop.premiereAdmin({ action: 'draw' }, drandTime(round) + 1000);
    expect((d.body as { winners: number[] }).winners).toEqual(drawWinners([{ tg: 1, tickets: 9 }, { tg: 3, tickets: 5 }], rand));
    await shop.premiereAdmin({ action: 'gift' }, drandTime(round) + 2000);
    await shop.premiereAdmin({ action: 'gift' }, drandTime(round) + 3000);
    const gifts = calls.filter((c) => c.m === 'giftPremiumSubscription');
    expect(gifts).toHaveLength(2);
    expect(gifts.map((g) => g.b.month_count)).toEqual([12, 3]);
    // после розыгрыша список не пересобрать
    expect((await shop.premiereAdmin({ action: 'freeze' }, drandTime(round) + 4000)).status).toBe(409);
  });
});
