import { describe, expect, it } from 'vitest';
import {
  Rng,
  SLOT_OUTCOMES,
  classifyReels,
  isLastLap,
  makeConfig,
  newSlotTable,
  reelsFor,
  resolveTurn,
  rollOutcome,
  slotAiChoice,
  slotOutcomeOf,
  slotWeights,
} from '../src';
import type { SlotChoice, SlotOutcome, SlotTable } from '../src';

const cfg = makeConfig();
const pull = (t: SlotTable): SlotChoice[] => t.seats.map(() => 'pull');
/** Круг с заданными исходами по местам (null — место пропускает). */
function turn(t: SlotTable, outs: (SlotOutcome | null)[], seed = 1, c = cfg) {
  const choices = outs.map((o) => (o ? 'pull' : 'pass')) as SlotChoice[];
  return resolveTurn(c, t, choices, new Rng(seed), (i) => outs[i] ?? undefined);
}

/** Один игрок крутит до конца дубля (или до вылета); остальные места — пустые соперники. */
function soloRun(seed: number): { halves: number; cut: boolean } {
  const t = newSlotTable(1);
  const rng = new Rng(seed);
  // одиночке не кончать дубль «последним живым»: стол на одного — правило 'last' не срабатывает
  while (!t.over) resolveTurn(cfg, t, ['pull'], rng);
  return { halves: t.seats[0].halves, cut: !t.seats[0].alive };
}

describe('слот-машина («Казино»): шансы', () => {
  it('веса — ровно 1, «мимо» забирает прибавку звёзд и черепов', () => {
    for (const mods of [{}, { clap: true }, { spot: true }, { last: true }, { clap: true, spot: true, last: true }]) {
      const w = slotWeights(cfg, mods);
      const sum = SLOT_OUTCOMES.reduce((a, k) => a + w[k], 0);
      expect(sum).toBeCloseTo(1, 9);
      for (const k of SLOT_OUTCOMES) expect(w[k]).toBeGreaterThanOrEqual(0);
    }
    const base = slotWeights(cfg);
    expect(base.jackpot).toBeCloseTo(0.08);
    expect(base.skull).toBeCloseTo(0.04);
    expect(slotWeights(cfg, { clap: true }).jackpot).toBeCloseTo(0.16);
    expect(slotWeights(cfg, { clap: true }).skull).toBeCloseTo(0.04);
    expect(slotWeights(cfg, { spot: true }).skull).toBeCloseTo(0.08);
    expect(slotWeights(cfg, { last: true }).jackpot).toBeCloseTo(0.16);
    expect(slotWeights(cfg, { last: true }).skull).toBeCloseTo(0.08);
    // хлопушка на последнем круге — ×4: «мимо» не хватает, веса нормируются, пропорции те же
    const both = slotWeights(cfg, { clap: true, last: true });
    expect(both.miss).toBe(0);
    expect(both.jackpot).toBeGreaterThan(0.25);
    expect(both.jackpot / both.half).toBeCloseTo(base.jackpot / base.half);
    expect(both.mask / both.camera).toBeCloseTo(base.mask / base.camera);
  });

  it('если «мимо» не хватает — веса нормируются', () => {
    const c = makeConfig({ slotClapMul: 10, slotLastMul: 10 });
    const w = slotWeights(c, { clap: true, last: true });
    expect(w.miss).toBe(0);
    expect(SLOT_OUTCOMES.reduce((a, k) => a + w[k], 0)).toBeCloseTo(1, 9);
    expect(w.jackpot).toBeGreaterThan(w.skull);
  });

  it('частоты исходов совпадают с весами', () => {
    const rng = new Rng(42);
    const w = slotWeights(cfg);
    const n = 200_000;
    const got = Object.fromEntries(SLOT_OUTCOMES.map((k) => [k, 0])) as Record<SlotOutcome, number>;
    for (let i = 0; i < n; i++) got[rollOutcome(w, rng)]++;
    for (const k of SLOT_OUTCOMES) expect(Math.abs(got[k] / n - w[k])).toBeLessThan(0.004);
  });

  it('барабаны честные: показ всегда даёт тот же исход', () => {
    const rng = new Rng(5);
    for (const o of SLOT_OUTCOMES)
      for (let i = 0; i < 500; i++) {
        const r = reelsFor(o, rng);
        expect(classifyReels(r)).toBe(o);
      }
    // «мимо» не бывает тремя одинаковыми и двумя звёздами
    for (let i = 0; i < 2000; i++) {
      const r = reelsFor('miss', rng);
      expect(r[0] === r[1] && r[1] === r[2]).toBe(false);
      expect(r.filter((s) => s === 'star').length).toBeLessThan(2);
      expect(r.filter((s) => s === 'skull').length).toBeLessThan(2);
    }
    expect(classifyReels(['popcorn', 'popcorn', 'popcorn'])).toBe('miss');
    expect(classifyReels(['star', 'skull', 'star'])).toBe('half');
  });
});

describe('слот-машина: стол', () => {
  it('одно зерно — один и тот же дубль', () => {
    const play = (seed: number) => {
      const t = newSlotTable(4);
      const rng = new Rng(seed);
      const log: string[] = [];
      while (!t.over) {
        const ch = t.seats.map((_, i) => slotAiChoice(cfg, t, i, rng));
        const r = resolveTurn(cfg, t, ch, rng);
        log.push(JSON.stringify(r));
      }
      return JSON.stringify({ log, t });
    };
    expect(play(9)).toBe(play(9));
    expect(play(9)).not.toBe(play(10));
  });

  it('звезда и половинка', () => {
    const t = newSlotTable(2);
    const r = turn(t, ['jackpot', 'half']);
    expect(t.seats.map((s) => s.halves)).toEqual([2, 1]);
    expect(r.effects).toEqual([
      { k: 'star', seat: 0 },
      { k: 'half', seat: 1 },
    ]);
    expect(r.spins[0]?.reels).toEqual(['star', 'star', 'star']);
    expect(t.turn).toBe(1);
  });

  it('пропуск — без вращения и без риска', () => {
    const t = newSlotTable(2);
    const rng = new Rng(3);
    for (let i = 0; i < 10; i++) resolveTurn(cfg, t, ['pass', 'pass'], rng);
    expect(t.seats.every((s) => s.alive && s.halves === 0)).toBe(true);
    expect(t.turn).toBe(10);
  });

  it('череп вырезает, звёзды сгорают', () => {
    const t = newSlotTable(3);
    turn(t, ['jackpot', 'half', null]);
    const r = turn(t, ['skull', null, null]);
    expect(t.seats[0].alive).toBe(false);
    expect(t.seats[0].halves).toBe(0);
    expect(r.effects).toEqual([{ k: 'cut', seat: 0, lost: 2 }]);
    // вырезанный больше не крутит
    const r2 = turn(t, ['jackpot', null, null]);
    expect(r2.spins[0]).toBeNull();
    expect(t.seats[0].halves).toBe(0);
  });

  it('маска спасает от одного черепа', () => {
    const t = newSlotTable(2);
    turn(t, ['mask', null]);
    expect(t.seats[0].mask).toBe(true);
    const r = turn(t, ['skull', null]);
    expect(r.effects).toEqual([{ k: 'saved', seat: 0 }]);
    expect(t.seats[0].alive).toBe(true);
    expect(t.seats[0].mask).toBe(false);
    turn(t, ['skull', null]);
    expect(t.seats[0].alive).toBe(false);
  });

  it('камера уводит половинку у лидера', () => {
    const t = newSlotTable(3);
    turn(t, [null, 'jackpot', 'half']);
    const r = turn(t, ['camera', null, null]);
    expect(r.effects).toEqual([{ k: 'steal', seat: 0, from: 1 }]);
    expect(t.seats.map((s) => s.halves)).toEqual([1, 1, 1]);
    // лидер с камерой крадёт у сильнейшего из соперников
    const t2 = newSlotTable(3);
    turn(t2, ['jackpot', 'half', null]);
    turn(t2, ['camera', null, null]);
    expect(t2.seats.map((s) => s.halves)).toEqual([3, 0, 0]);
    // красть не у кого — ничего
    const t3 = newSlotTable(2);
    expect(turn(t3, ['camera', null]).effects).toEqual([]);
  });

  it('прожектор: лидеру на следующий круг черепа ×2, потом снова как было', () => {
    const t = newSlotTable(3);
    turn(t, [null, 'half', 'jackpot']);
    const r = turn(t, ['spot', null, null]);
    expect(r.effects).toEqual([{ k: 'spot', seat: 0, target: 2 }]);
    expect(t.seats[2].spot).toBe(true);
    turn(t, [null, null, 'miss']);
    expect(t.seats[2].spot).toBe(false);
    // прожектор действует один круг, даже если тот пропустил
    turn(t, ['spot', null, null]);
    expect(t.seats[2].spot).toBe(true);
    turn(t, [null, null, null]);
    expect(t.seats[2].spot).toBe(false);
  });

  it('прожектор и хлопушка правда меняют шансы броска', () => {
    const n = 40_000;
    const count = (setup: (t: SlotTable) => void, o: SlotOutcome) => {
      const rng = new Rng(77);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const t = newSlotTable(2);
        setup(t);
        if (resolveTurn(cfg, t, ['pull', 'pass'], rng).spins[0]?.outcome === o) k++;
      }
      return k / n;
    };
    expect(count(() => {}, 'skull')).toBeCloseTo(0.04, 1);
    expect(count((t) => (t.seats[0].spot = true), 'skull')).toBeGreaterThan(0.07);
    expect(count((t) => (t.seats[0].clap = true), 'jackpot')).toBeGreaterThan(0.14);
    expect(count((t) => (t.turn = cfg.slotTurns - 1), 'jackpot')).toBeGreaterThan(0.14);
  });

  it('хлопушка — себе на следующий круг', () => {
    const t = newSlotTable(2);
    expect(turn(t, ['clap', null]).effects).toEqual([{ k: 'clap', seat: 0 }]);
    expect(t.seats[0].clap).toBe(true);
    turn(t, ['miss', null]);
    expect(t.seats[0].clap).toBe(false);
  });

  it('плёнка: два круга без вращения', () => {
    const t = newSlotTable(2);
    turn(t, ['reel', null]);
    expect(t.seats[0].skip).toBe(2);
    const a = turn(t, ['skull', null]);
    const b = turn(t, ['skull', null]);
    expect(a.spins[0]).toBeNull();
    expect(b.spins[0]).toBeNull();
    expect(t.seats[0].alive).toBe(true);
    expect(turn(t, ['half', null]).spins[0]?.outcome).toBe('half');
  });

  it('«Последний круг» — последние три', () => {
    expect(isLastLap(cfg, 11)).toBe(false);
    expect(isLastLap(cfg, 12)).toBe(true);
    expect(isLastLap(cfg, 14)).toBe(true);
  });
});

describe('слот-машина: конец дубля', () => {
  it('три звезды — победа сразу; ничья — побеждают оба', () => {
    const t = newSlotTable(3);
    turn(t, ['jackpot', 'jackpot', null]);
    turn(t, ['jackpot', 'jackpot', null]);
    expect(t.over).toBeNull();
    turn(t, ['jackpot', 'jackpot', null]);
    expect(t.over).toEqual({ reason: 'stars', winners: [0, 1] });
    // после конца стол не меняется
    const r = turn(t, ['jackpot', 'jackpot', 'jackpot']);
    expect(r.spins.every((s) => s === null)).toBe(true);
  });

  it('добрали в один круг — выигрывает тот, у кого больше', () => {
    const t = newSlotTable(2);
    t.seats[0].halves = 5;
    t.seats[1].halves = 4;
    turn(t, ['half', 'jackpot']);
    expect(t.over).toEqual({ reason: 'stars', winners: [0, 1] });
    const t2 = newSlotTable(2);
    t2.seats[0].halves = 5;
    t2.seats[1].halves = 5;
    turn(t2, ['half', 'jackpot']);
    expect(t2.over).toEqual({ reason: 'stars', winners: [1] });
  });

  it('круги кончились — у кого больше звёзд; ни у кого нет — нет победителя', () => {
    const t = newSlotTable(3);
    turn(t, ['half', 'jackpot', 'half']);
    for (let i = 1; i < cfg.slotTurns; i++) turn(t, [null, null, null]);
    expect(t.over).toEqual({ reason: 'turns', winners: [1] });
    const t2 = newSlotTable(2);
    for (let i = 0; i < cfg.slotTurns; i++) turn(t2, [null, null]);
    expect(t2.over).toEqual({ reason: 'turns', winners: [] });
  });

  it('остался один живой — он и выиграл; вырезаны все — никто', () => {
    const t = newSlotTable(3);
    turn(t, ['skull', 'skull', null]);
    expect(t.over).toEqual({ reason: 'last', winners: [2] });
    const t2 = newSlotTable(2);
    turn(t2, ['skull', 'skull']);
    expect(t2.over).toEqual({ reason: 'wiped', winners: [] });
    // на одного (песочница без соперников) — «последний живой» не срабатывает
    const t3 = newSlotTable(1);
    turn(t3, ['half']);
    expect(slotOutcomeOf(cfg, t3)).toBeNull();
  });
});

describe('слот-машина: баланс (Монте-Карло)', () => {
  it('кто крутит все круги: ~1 из 6 — три звезды, ~1 из 3 — вырезан', () => {
    const n = 20_000;
    let win = 0;
    let cut = 0;
    let halves = 0;
    for (let s = 1; s <= n; s++) {
      const r = soloRun(s * 7919);
      if (r.halves >= 6) win++;
      if (r.cut) cut++;
      halves += r.halves;
    }
    expect(win / n).toBeGreaterThan(0.12);
    expect(win / n).toBeLessThan(0.3);
    expect(cut / n).toBeGreaterThan(0.25);
    expect(cut / n).toBeLessThan(0.45);
    expect(halves / n / 2).toBeGreaterThan(0.8);
  });

  it('стол на четверых с ИИ: дубль всегда кончается, обычно не раньше середины', () => {
    const reasons: Record<string, number> = {};
    let turns = 0;
    const n = 4000;
    for (let s = 1; s <= n; s++) {
      const t = newSlotTable(4);
      const rng = new Rng(s);
      while (!t.over) resolveTurn(cfg, t, t.seats.map((_, i) => slotAiChoice(cfg, t, i, rng)), rng);
      expect(t.turn).toBeLessThanOrEqual(cfg.slotTurns);
      reasons[t.over.reason] = (reasons[t.over.reason] ?? 0) + 1;
      turns += t.turn;
    }
    // дубль ~минуту: в среднем не меньше 8 кругов по 4 с
    expect(turns / n).toBeGreaterThan(8);
    // все пути к концу встречаются
    for (const k of ['stars', 'turns', 'last']) expect(reasons[k]).toBeGreaterThan(n * 0.03);
  });

  it('ИИ: вырезанный и на «Плёнке» не крутит, отстающий на последнем круге крутит всегда', () => {
    const t = newSlotTable(2);
    const rng = new Rng(1);
    t.seats[0].alive = false;
    expect(slotAiChoice(cfg, t, 0, rng)).toBe('pass');
    t.seats[1].skip = 1;
    expect(slotAiChoice(cfg, t, 1, rng)).toBe('pass');
    const t2 = newSlotTable(2);
    t2.turn = cfg.slotTurns - 1;
    t2.seats[1].halves = 4;
    t2.seats[0].spot = true;
    for (let i = 0; i < 50; i++) expect(slotAiChoice(cfg, t2, 0, rng)).toBe('pull');
    void pull;
  });
});
