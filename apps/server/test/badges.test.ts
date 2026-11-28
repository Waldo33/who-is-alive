import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANIMATED_BADGES, BADGE_IDS, STAR_MS, badgeEmoji, slotHits } from '@kto/game-core';
import { BadgeSet } from '../src/badges';
import { silentLogger } from '../src/log';
import { localLedger, shopLedgerOp } from '../src/shop';
import { MemoryStore } from '../src/store';

/** Значки для эмодзи-статуса: счётчики игрока Telegram и набор эмодзи у бота (badges.ts). */

const DIR = join(import.meta.dirname, '..', 'stickers', 'badges');

interface Call {
  method: string;
  body: Record<string, unknown>;
  files: string[];
}

function fakeApi(o: { set?: { emoji: string; custom_emoji_id: string; file_id?: string; is_video?: boolean }[] | null; fail?: string } = {}) {
  const calls: Call[] = [];
  let set = o.set === undefined ? null : o.set;
  let n = 0;
  const api = async <R>(method: string, body: Record<string, unknown> | FormData): Promise<R> => {
    const b: Record<string, unknown> = {};
    const files: string[] = [];
    if (body instanceof FormData) {
      for (const [k, v] of body.entries()) {
        if (typeof v === 'string') b[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
        else files.push(`${k}:${(v as File).name}:${(v as File).size}`);
      }
    } else Object.assign(b, body);
    calls.push({ method, body: b, files });
    if (o.fail && method === o.fail) throw new Error(`${method}: Bad Request: boom`);
    if (method === 'getStickerSet') {
      if (!set) throw new Error('getStickerSet: Bad Request: STICKERSET_INVALID');
      return { stickers: set } as R;
    }
    if (method === 'getChatAdministrators') return [{ status: 'administrator', user: { id: 5 } }, { status: 'creator', user: { id: 42 } }] as R;
    const add = (stk: { emoji_list: string[] }) => (set ??= []).push({ emoji: stk.emoji_list[0]! + '️', custom_emoji_id: `ce${++n}` });
    if (method === 'createNewStickerSet') for (const s of b.stickers as { emoji_list: string[] }[]) add(s);
    if (method === 'addStickerToSet') add(b.sticker as { emoji_list: string[] });
    if (method === 'replaceStickerInSet' && set) {
      const i = set.findIndex((x) => x.file_id === b.old_sticker);
      set[i] = { emoji: (b.sticker as { emoji_list: string[] }).emoji_list[0]!, custom_emoji_id: `ce${++n}`, is_video: (b.sticker as { format: string }).format === 'video' };
    }
    return true as R;
  };
  return { api, calls };
}

const deps = (api: ReturnType<typeof fakeApi>['api'], now = () => 0) => ({ api, username: async () => 'be_nobody_bot', log: silentLogger, dir: DIR, supportChat: '-1', now });

describe('значки: набор эмодзи у бота', () => {
  it('набора нет — бот создаёт его от имени владельца чата поддержки со всеми значками, потом знает id эмодзи', async () => {
    const { api, calls } = fakeApi();
    const b = new BadgeSet(deps(api));
    expect(b.ids()).toEqual({});
    await b.kick();
    const made = calls.find((c) => c.method === 'createNewStickerSet')!;
    expect(made.body).toMatchObject({ user_id: '42', name: 'massovka_badges_by_be_nobody_bot', sticker_type: 'custom_emoji' });
    // значки-слоты — видео-эмодзи (WEBM), остальные — картинки
    expect(made.files.map((f) => f.split(':')[1])).toEqual(BADGE_IDS.map((id) => `${id}.${ANIMATED_BADGES.includes(id) ? 'webm' : 'png'}`));
    const formats = (made.body.stickers as { format: string }[]).map((x) => x.format);
    expect(formats).toEqual(BADGE_IDS.map((id) => (ANIMATED_BADGES.includes(id) ? 'video' : 'static')));
    // картинки — настоящие файлы из apps/server/stickers/badges
    for (const f of made.files) expect(Number(f.split(':')[2])).toBeGreaterThan(100);
    const ids = b.ids();
    expect(Object.keys(ids).sort()).toEqual([...BADGE_IDS].sort());
    expect(new Set(Object.values(ids)).size).toBe(BADGE_IDS.length);
  });

  it('набор есть, но без нового значка — бот добавляет только его; всё есть — ничего не трогает', async () => {
    const have = BADGE_IDS.slice(0, -1).map((id, i) => ({ emoji: badgeEmoji(id), custom_emoji_id: `old${i}` }));
    const { api, calls } = fakeApi({ set: have });
    const b = new BadgeSet(deps(api));
    await b.kick();
    const adds = calls.filter((c) => c.method === 'addStickerToSet');
    expect(adds).toHaveLength(1);
    expect(adds[0]!.files[0]).toContain(`${BADGE_IDS.at(-1)}.png`);
    expect(calls.some((c) => c.method === 'createNewStickerSet')).toBe(false);
    expect(b.ids()[BADGE_IDS[0]!]).toBe('old0');
    const before = calls.length;
    b.ids();
    await b.kick();
    // всё на месте — Telegram больше не дёргаем (кроме повторной сверки не чаще раза в 10 минут)
    expect(calls.slice(before).some((c) => c.method !== 'getStickerSet')).toBe(false);
  });

  it('значок стал анимированным — картинку в наборе бот меняет на видео, id эмодзи берёт новый', async () => {
    const have = BADGE_IDS.map((id, i) => ({ emoji: badgeEmoji(id), custom_emoji_id: `old${i}`, file_id: `file${i}`, is_video: ANIMATED_BADGES.includes(id) && id !== 'star' }));
    const { api, calls } = fakeApi({ set: have });
    const b = new BadgeSet(deps(api));
    await b.kick();
    const rep = calls.filter((c) => c.method === 'replaceStickerInSet');
    expect(rep).toHaveLength(1);
    expect(rep[0]!.body).toMatchObject({ old_sticker: `file${BADGE_IDS.indexOf('star')}`, sticker: { format: 'video' } });
    expect(rep[0]!.files[0]).toContain('star.webm');
    expect(b.ids().star).not.toBe(`old${BADGE_IDS.indexOf('star')}`);
    // заменили — больше не трогаем
    const n = calls.length;
    b.ids();
    expect(calls.slice(n).some((c) => c.method === 'replaceStickerInSet')).toBe(false);
  });

  it('сбой Telegram — без падения, повтор не чаще раза в 10 минут', async () => {
    let t = 0;
    const { api, calls } = fakeApi({ fail: 'createNewStickerSet' });
    const b = new BadgeSet(deps(api, () => t));
    await b.kick();
    const n = calls.length;
    t += 60_000;
    await b.kick();
    expect(calls.length).toBe(n);
    t += 10 * 60_000;
    await b.kick();
    expect(calls.length).toBeGreaterThan(n);
  });
});

describe('значки: счётчики игрока', () => {
  it('матчи и победы копятся, последняя победа — самая поздняя; «Звезда дубля» — сутки', async () => {
    const store = new MemoryStore();
    await store.bumpTgStats(77, { matches: 1, wins: 1, rooms: 0, winAt: 5_000 });
    await store.bumpTgStats(77, { matches: 1, wins: 0, rooms: 1, winAt: null });
    await store.bumpTgStats(77, { matches: 1, wins: 1, rooms: 0, winAt: 3_000, jackpots: 2, skulls: 1 });
    expect(await store.tgStats(77)).toEqual({ matches: 3, wins: 2, rooms: 1, lastWin: 5_000, jackpots: 2, skulls: 1 });
    expect(await store.tgStats(78)).toEqual({ matches: 0, wins: 0, rooms: 0, lastWin: null, jackpots: 0, skulls: 0 });
    expect(STAR_MS).toBe(24 * 3600_000);
  });

  it('учёт по туннелю: op stats — только с числовым id игрока', async () => {
    const store = new MemoryStore();
    await store.bumpTgStats(77, { matches: 2, wins: 0, rooms: 0, winAt: null });
    expect(await shopLedgerOp(localLedger(store), { op: 'stats', userId: 77 })).toEqual({ status: 200, body: { result: { matches: 2, wins: 0, rooms: 0, lastWin: null, jackpots: 0, skulls: 0 } } });
    expect((await shopLedgerOp(localLedger(store), { op: 'stats', userId: '77; drop' })).status).toBe(400);
  });

  it('значки-слоты: 777 и черепа — только свои вращения, по связке игрок ↔ сущность из итогов дубля', () => {
    const rounds = [
      { reveal: [{ pid: 'a', eid: 3 }, { pid: 'b', eid: 9 }], slots: [{ eid: 3, outcome: 'seven' }, { eid: 9, outcome: 'skull' }, { eid: 3, outcome: 'seven' }, { eid: 9, outcome: 'star' }] },
      // в другом дубле у игрока другая сущность
      { reveal: [{ pid: 'a', eid: 9 }, { pid: 'b', eid: 3 }], slots: [{ eid: 9, outcome: 'skull' }] },
      { reveal: [{ pid: 'a', eid: 1 }] },
    ];
    expect(slotHits(rounds, 'a')).toEqual({ jackpots: 2, skulls: 1 });
    expect(slotHits(rounds, 'b')).toEqual({ jackpots: 0, skulls: 1 });
    expect(slotHits(rounds, 'c')).toEqual({ jackpots: 0, skulls: 0 });
  });
});
