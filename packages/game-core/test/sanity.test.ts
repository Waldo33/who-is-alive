import { describe, expect, it } from 'vitest';
import { MatchSim, ROTATION_THEMES, THEME_RULES, makeConfig, sanityStage } from '../src';
import type { WorldEvent } from '../src';

const players = ['a', 'b'].map((pid, i) => ({ pid, name: pid, color: i }));
const KUPALA = THEME_RULES.findIndex((r) => r.id === 'kupala');

function toPlay(sim: MatchSim): void {
  for (let i = 0; i < 20 * 20 && sim.phase !== 'play'; i++) sim.tick();
}

describe('рассудок («Купальская ночь»)', () => {
  it('тема спрятана из обычной очереди и выпадает только по fixedTheme', () => {
    expect(KUPALA).toBeGreaterThan(0);
    expect(ROTATION_THEMES).not.toContain(KUPALA);
    for (let seed = 1; seed <= 20; seed++) expect(new MatchSim(makeConfig(), players, seed).themeOrder).not.toContain(KUPALA);
    expect(new MatchSim(makeConfig({ fixedTheme: KUPALA }), players, 3).theme).toBe(KUPALA);
  });

  it('тает сам по себе, в других темах не меняется', () => {
    for (const [theme, falls] of [[KUPALA, true], [0, false]] as const) {
      const sim = new MatchSim(makeConfig({ fixedTheme: theme, endWhenLastAlive: false }), players, 11);
      toPlay(sim);
      for (let i = 0; i < 20 * 20; i++) sim.tick();
      for (const p of sim.pr) {
        if (falls) expect(p.sanity).toBeLessThan(100);
        else expect(p.sanity).toBe(100);
      }
    }
  });

  it('цветок поднимает, промах по боту отнимает', () => {
    const cfg = makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false });
    const sim = new MatchSim(cfg, players, 5);
    toPlay(sim);
    for (let i = 0; i < 20 * 10; i++) sim.tick();
    const p = sim.pr[0];
    const me = sim.world.get(p.eid)!;
    // цветок прямо под ногами
    sim.spawnStarAt(me.x, me.y);
    sim.world.step(); // цветок появился
    p.sanity = 50;
    const before = p.sanity;
    sim.tick();
    expect(p.stars).toBe(1);
    expect(p.sanity).toBeGreaterThan(before + cfg.sanityFlower - 2);
    // удар по ближайшему боту
    const pe = new Set(sim.pr.map((x) => x.eid));
    const bot = sim.world.alive().filter((e) => !pe.has(e.eid)).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    bot.x = me.x + 4;
    bot.y = me.y;
    const s0 = p.sanity;
    sim.intent('a', { k: 'attack', eid: bot.eid });
    sim.tick();
    expect(p.botHits).toBe(1);
    expect(p.sanity).toBeLessThan(s0 - cfg.sanityBotHit + 2);
  });

  it('на нуле — вырезан ударом без нападавшего; в детском режиме — нет', () => {
    for (const kidsMode of [false, true]) {
      const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false, kidsMode }), players, 9);
      toPlay(sim);
      const hits: WorldEvent[] = [];
      sim.world.listeners.push((ev) => ev.t === 'hit' && hits.push(ev));
      const p = sim.pr[1];
      p.sanity = 0.01;
      for (let i = 0; i < 5; i++) sim.tick();
      if (kidsMode) {
        expect(p.alive).toBe(true);
        expect(p.sanity).toBe(0);
      } else {
        expect(p.alive).toBe(false);
        const h = hits.find((e) => e.t === 'hit' && e.target === p.eid);
        expect(h && h.t === 'hit' && h.attacker).toBeUndefined();
        expect(h && h.t === 'hit' && h.result).toBe('player');
      }
    }
  });

  it('стадии по порогам', () => {
    const cfg = makeConfig();
    expect([100, 70, 69, 45, 44, 25, 24, 0].map((v) => sanityStage(cfg, v))).toEqual([0, 1, 1, 2, 2, 3, 3, 3]);
  });
});
