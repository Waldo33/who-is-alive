import { describe, expect, it } from 'vitest';
import {
  AiPlayer,
  DAILY_THEMES,
  LocalSession,
  MatchSim,
  ROTATION_THEMES,
  Rng,
  SLOT_OUTCOMES,
  SLOT_VISIBLE,
  THEME_RULES,
  botSlotEffect,
  classifyReels,
  hasSlots,
  makeConfig,
  momentEvents,
  recordRound,
  reelsFor,
  rollOutcome,
  skullChance,
  slotWeights,
} from '../src';
import type { SlotOutcome, WorldEvent } from '../src';

const cfg = makeConfig();
const CASINO = THEME_RULES.findIndex((r) => r.id === 'casino');
const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

describe('автомат: шансы и барабаны', () => {
  it('веса — ровно 1, «мимо» — остаток; череп зависит от сложности', () => {
    for (const c of [cfg, makeConfig({ kidsMode: true }), makeConfig({ strictCrowd: true })]) {
      const w = slotWeights(c);
      const sum = SLOT_OUTCOMES.reduce((a, k) => a + w[k], 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(w.miss).toBeGreaterThan(0.2);
      expect(w.skull).toBe(skullChance(c));
    }
    expect(skullChance(makeConfig({ strictCrowd: true }))).toBeGreaterThan(skullChance(cfg));
  });

  it('по броскам частоты сходятся с весами', () => {
    const rng = new Rng(7);
    const w = slotWeights(cfg);
    const n = 40000;
    const cnt = Object.fromEntries(SLOT_OUTCOMES.map((k) => [k, 0])) as Record<SlotOutcome, number>;
    for (let i = 0; i < n; i++) cnt[rollOutcome(w, rng)]++;
    for (const k of SLOT_OUTCOMES) expect(cnt[k] / n).toBeCloseTo(w[k], 1);
  });

  it('барабаны честные: выигрыш — три одинаковых, «мимо» — никогда', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 3000; i++) {
      for (const o of SLOT_OUTCOMES) {
        const r = reelsFor(o, rng);
        expect(classifyReels(r)).toBe(o);
        if (o === 'miss') expect(r[0] === r[1] && r[1] === r[2]).toBe(false);
      }
    }
  });

  it('статистам — только видимые исходы и с теми же шансами, что игроку', () => {
    const rng = new Rng(11);
    const w = slotWeights(cfg);
    const n = 40000;
    const cnt = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const o = botSlotEffect(cfg, rng);
      if (o) cnt.set(o, (cnt.get(o) ?? 0) + 1);
    }
    expect([...cnt.keys()].every((k) => SLOT_VISIBLE.includes(k as SlotOutcome))).toBe(true);
    for (const k of SLOT_VISIBLE) expect((cnt.get(k) ?? 0) / n).toBeCloseTo(w[k], 1);
  });
});

describe('«Казино» в матче', () => {
  /** Дубль казино с ИИ на всех местах; forced — исход каждой «Крутки». */
  const run = (seed: number, extra: Parameters<typeof makeConfig>[0] = {}, forced?: SlotOutcome) => {
    const sim = new MatchSim(makeConfig({ fixedTheme: CASINO, ...extra }), players, seed);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, seed * 31 + i)));
    const events: WorldEvent[] = [];
    sim.world.listeners.push((ev) => events.push(ev));
    const phases: string[] = [];
    for (let i = 0; i < 20 * 60 * 4 && sim.round === 1; i++) {
      if (phases[phases.length - 1] !== sim.phase) phases.push(sim.phase);
      if (sim.phase === 'results') break;
      if (forced) sim.forceSlot(forced);
      sim.tick();
    }
    return { sim, events, phases };
  };

  it('обычная тема в очереди (не финал); в загадке дня её нет', () => {
    expect(hasSlots(CASINO)).toBe(true);
    expect(ROTATION_THEMES).toContain(CASINO);
    expect(DAILY_THEMES).not.toContain(CASINO);
    expect(THEME_RULES[CASINO].finaleOnly).toBeFalsy();
  });

  it('обычный дубль: ходят и бьют, есть обвинение; вместо жестов — 2–3 «Крутки» со стоп-кадром', () => {
    const { events, phases } = run(5);
    expect(phases).toContain('accuse');
    expect(events.some((e) => e.t === 'move')).toBe(true);
    const crowd = events.filter((e): e is Extract<WorldEvent, { t: 'crowd' }> => e.t === 'crowd');
    expect(crowd.length).toBeGreaterThanOrEqual(2);
    expect(crowd.length).toBeLessThanOrEqual(4);
    for (const c of crowd) {
      expect(c.slot).toBe(true);
      expect(c.showAt - c.at).toBe(cfg.slotWarnMs);
      expect(c.resumeAt - c.showAt).toBe(cfg.slotPauseMs);
    }
    // на «Крутку» никто не делает жест толпы: поз «замри» нет вовсе
    expect(events.some((e) => e.t === 'act' && e.kind === 'freeze')).toBe(false);
  });

  it('своё вращение знает только сам: в событиях мира исходов нет', () => {
    const sim = new MatchSim(makeConfig({ fixedTheme: CASINO }), players, 9);
    const s = new LocalSession(sim, 'a', 9);
    const events: WorldEvent[] = [];
    sim.world.listeners.push((ev) => events.push(ev));
    let mine = s.me()?.slot ?? null;
    for (let i = 0; i < 20 * 60 && !mine; i++) {
      s.tick();
      mine = s.me()?.slot ?? null;
    }
    expect(mine).not.toBeNull();
    expect(classifyReels(mine!.reels)).toBe(mine!.outcome);
    expect(mine!.at).toBe(sim.world.crowd!.warnAt);
    for (const e of events) expect(JSON.stringify(e)).not.toMatch(/outcome|reels|seven|skull/);
  });

  it('молния и гиря достаются и статистам; скорость меняется только после стоп-кадра', () => {
    const { sim, events } = run(21);
    const sp = events.filter((e): e is Extract<WorldEvent, { t: 'speed' }> => e.t === 'speed');
    const pe = new Set(sim.pr.map((p) => p.eid));
    expect(sp.some((e) => !pe.has(e.eid))).toBe(true);
    const crowd = events.filter((e): e is Extract<WorldEvent, { t: 'crowd' }> => e.t === 'crowd');
    for (const e of sp) expect(crowd.some((c) => c.resumeAt === e.from)).toBe(true);
  });

  it('череп вырезает (на лёгкой — сжигает звезду, но не вырезает)', () => {
    const hard = run(4, {}, 'skull');
    expect(hard.sim.pr.every((p) => !p.alive)).toBe(true);
    const kids = run(4, { kidsMode: true }, 'skull');
    expect(kids.sim.pr.some((p) => p.alive)).toBe(true);
  });

  it('итоги дубля знают все вращения; клип вырезанного черепами — вся «Крутка», без «кто вырезал»', () => {
    const hard = run(4, {}, 'skull');
    const sum = hard.sim.summary!;
    const crowd = hard.events.filter((e): e is Extract<WorldEvent, { t: 'crowd' }> => e.t === 'crowd');
    expect(sum.slots?.length).toBe(players.length);
    for (const r of sum.slots!) {
      expect(r.outcome).toBe('skull');
      expect(r.at).toBe(crowd[0].at);
    }
    const victim = sum.slots![0].eid;
    const rec = recordRound(hard.sim.world, { round: 1, theme: CASINO, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills, slots: sum.slots });
    const ko = momentEvents(rec, victim).find((m) => m.victim === victim)!;
    expect(ko.by).toBe('slot');
    expect(ko.attacker).toBeUndefined();
    expect(ko.from).toBeLessThanOrEqual(crowd[0].showAt);
  });

  it('«777» — очко в итогах дубля; три звезды на «Крутке» — звезда', () => {
    const r7 = run(6, { endWhenLastAlive: false, attacksPerRound: 0 }, 'seven');
    const s = r7.sim.summary!;
    for (const p of r7.sim.pr) expect(s.points[p.pid].slot).toBeGreaterThanOrEqual(2);
    const rs = run(6, { endWhenLastAlive: false, attacksPerRound: 0 }, 'star');
    expect(rs.sim.pr.some((p) => p.stars >= 2)).toBe(true);
  });

  it('кулак — +1 удар, плёнка — −1', () => {
    // потраченные удары — выбитые и удары по статистам
    const had = (p: { attacksLeft: number; kills: number; botHits: number }) => p.attacksLeft + p.kills + p.botHits;
    const f = run(8, { endWhenLastAlive: false, attacksPerRound: 0 }, 'fist');
    const alive = f.sim.pr.filter((p) => p.alive);
    expect(alive.length).toBeGreaterThan(0);
    expect(alive.every((p) => had(p) >= 2)).toBe(true);
    const r = run(8, { endWhenLastAlive: false, attacksPerRound: 10 }, 'reel');
    expect(r.sim.pr.filter((p) => p.alive).every((p) => had(p) <= 8)).toBe(true);
  });

  it('по зерну — один и тот же дубль', () => {
    const a = run(13);
    const b = run(13);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});
