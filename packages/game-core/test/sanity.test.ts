import { describe, expect, it } from 'vitest';
import { CROWD_ACT, LAG_GRACE_MS, LESHY_HUNT_SEC, MatchSim, ROTATION_THEMES, THEME_RULES, leshySec, leshySpot, leshyVisits, makeConfig, sanityStage } from '../src';
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

  it('кикиморы: ниже «Кошмара» вылезают из воды и идут к игроку; касание — вырезан', () => {
    const cfg = makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false });
    const sim = new MatchSim(cfg, players, 21);
    toPlay(sim);
    const p = sim.pr[0];
    p.sanity = 60;
    sim.tick();
    expect(p.kiki.length).toBe(0);
    p.sanity = 20;
    sim.tick();
    expect(p.kiki.length).toBe(1);
    const k = p.kiki[0];
    expect(k.id).toBeLessThan(0);
    const e = sim.world.get(p.eid)!;
    const d0 = Math.hypot(k.x - e.x, k.y - e.y);
    expect(d0).toBeGreaterThanOrEqual(cfg.kikiSpawnMinDist - 1);
    // пока рябь — стоит
    for (let i = 0; i < 10; i++) sim.tick();
    expect(Math.hypot(k.x - e.x, k.y - e.y)).toBeCloseTo(d0, 0);
    for (let i = 0; i < 40; i++) {
      p.sanity = 20;
      sim.tick();
    }
    const e2 = sim.world.get(p.eid)!;
    expect(Math.hypot(k.x - e2.x, k.y - e2.y)).toBeLessThan(d0);
    // вплотную — вырезан ударом без нападавшего
    k.x = e2.x + 3;
    k.y = e2.y;
    p.sanity = 20;
    sim.tick();
    expect(p.alive).toBe(false);
  });

  it('кикимору отбивают двумя ударами (+рассудок, удары дубля целы), цветок отгоняет; рассудок выше порога — тают', () => {
    const cfg = makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false });
    const sim = new MatchSim(cfg, players, 23);
    toPlay(sim);
    const p = sim.pr[0];
    p.sanity = 20;
    sim.tick();
    const k = p.kiki[0];
    const e = sim.world.get(p.eid)!;
    k.at = sim.world.time + 10_000; // стоит на месте
    k.x = e.x + 8;
    k.y = e.y;
    const atk = p.attacksLeft;
    sim.intent('a', { k: 'attack', eid: k.id });
    sim.tick();
    k.x = e.x + 8;
    sim.intent('a', { k: 'attack', eid: k.id });
    p.sanity = 20;
    sim.tick();
    expect(p.kiki.find((o) => o.id === k.id)).toBeUndefined();
    expect(p.sanity).toBeGreaterThan(20 + cfg.kikiBanish - 2);
    expect(p.attacksLeft).toBe(atk);
    // выше порога — тают все
    p.sanity = 20;
    for (let i = 0; i < 70; i++) {
      p.sanity = 20;
      sim.tick();
    }
    expect(p.kiki.length).toBeGreaterThan(0);
    p.sanity = 60;
    sim.tick();
    expect(p.kiki.length).toBe(0);
  });

  it('ночь до последнего: кончается, когда сгинули все; побеждает продержавшийся дольше, матч в одну ночь', () => {
    const cfg = makeConfig({ fixedTheme: KUPALA });
    const sim = new MatchSim(cfg, players, 7);
    toPlay(sim);
    const [a, b] = sim.pr;
    const ea = sim.world.get(a.eid)!;
    for (let n = 0; n < 3; n++) {
      sim.spawnStarAt(ea.x, ea.y);
      sim.world.step();
      sim.tick();
    }
    expect(a.stars).toBe(3);
    expect(sim.phase).toBe('play');
    // у b рассудок кончился — a остался один, но ночь идёт дальше
    b.sanity = 0.01;
    for (let i = 0; i < 20 * 5; i++) sim.tick();
    expect(b.alive).toBe(false);
    expect(sim.phase).toBe('play');
    // сгинул и a — ночь кончилась, a продержался дольше: бонус победителя и очко за b
    a.sanity = 0.01;
    for (let i = 0; i < 20 * 30 && sim.phase === 'play'; i++) sim.tick();
    for (let i = 0; i < 20 * 30 && !sim.summary; i++) sim.tick();
    expect(sim.summary?.starWinner).toBe('a');
    expect(sim.summary?.points.a.stars).toBe(cfg.points.stars);
    expect(sim.summary?.points.a.survive).toBe(1);
    expect(sim.summary?.points.b.stars).toBe(0);
    expect(sim.summary?.points.b.survive).toBe(0);
    expect(sim.lastRound).toBe(true);
  });

  it('факел: рассудок растёт, кикимора не подходит ближе света; «Факел!» вовремя зажигает его', () => {
    const cfg = makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false });
    const sim = new MatchSim(cfg, players, 21);
    toPlay(sim);
    for (let i = 0; i < 20 * 120 && sim.cfg.nightMaxSec - sim.timeLeft() / 1000 < leshySec(sim.round) + 10; i++) {
      // глухая ночь, Леший уже прошёл, костёр прогорел; на «Тсс!» Лешего замираем
      sim.pr[0].sanity = 100;
      const c = sim.world.crowd;
      if (c && !c.vote && sim.world.time >= c.showAt + 100 && sim.pr[0].crowdAnswered !== c.warnAt) sim.intent('a', { k: 'crowd', kind: c.kind });
      sim.tick();
    }
    const p = sim.pr[0];
    // ждём, пока кикимора вылезет (Леший мог ещё не уйти)
    for (let i = 0; i < 20 * 20 && !p.kiki.length; i++) {
      p.sanity = 20;
      sim.tick();
    }
    const k = p.kiki[0];
    expect(k).toBeDefined();
    p.torchUntil = sim.world.time + 5000;
    const e = sim.world.get(p.eid)!;
    k.x = e.x + 10;
    k.y = e.y;
    k.at = 0;
    const s0 = p.sanity;
    for (let i = 0; i < 20; i++) sim.tick();
    expect(p.alive).toBe(true);
    expect(p.sanity).toBeGreaterThan(s0);
    const e2 = sim.world.get(p.eid)!;
    expect(Math.hypot(k.x - e2.x, k.y - e2.y)).toBeGreaterThan(10);

    // команда «Факел!»: кто повторил вовремя — с факелом
    const sim2 = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false }), players, 5);
    toPlay(sim2);
    sim2.planCrowd('jump', 3000);
    let lit = false;
    for (let i = 0; i < 20 * 160 && !lit; i++) {
      sim2.pr[0].sanity = 100;
      const c = sim2.world.crowd;
      if (c && !c.vote && sim2.world.time >= c.showAt + 100 && sim2.pr[0].crowdAnswered !== c.warnAt) sim2.intent('a', { k: 'crowd', kind: c.kind });
      sim2.tick();
      lit = sim2.pr[0].torchUntil > sim2.world.time;
    }
    expect(lit).toBe(true);
  });
  it('Леший: кто не замер на его «Тсс!» — забран; обычный «Тсс!» не убивает; дети — живы', () => {
    for (const kidsMode of [false, true]) {
      const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false, kidsMode }), players, 13);
      toPlay(sim);
      const [a, b] = sim.pr;
      let leshyAt = -1;
      for (let i = 0; i < 20 * 120 && leshyAt < 0; i++) {
        a.sanity = b.sanity = 100;
        const c = sim.world.crowd;
        if (c && !c.vote && sim.world.time >= c.showAt + 100 && b.crowdAnswered !== c.warnAt) sim.intent('b', { k: 'crowd', kind: c.kind });
        if ((sim as unknown as { leshyWarn: number }).leshyWarn >= 0) leshyAt = (sim as unknown as { leshyWarn: number }).leshyWarn;
        if (leshyAt < 0) expect(a.alive).toBe(true);
        sim.tick();
      }
      expect(leshyAt).toBeGreaterThan(0);
      for (let i = 0; i < 20 * 9; i++) {
        const c = sim.world.crowd;
        if (c && !c.vote && sim.world.time >= c.showAt + 100 && b.crowdAnswered !== c.warnAt) sim.intent('b', { k: 'crowd', kind: c.kind });
        sim.tick();
      }
      expect(b.alive).toBe(true);
      expect(a.alive).toBe(kidsMode);
    }
  });
  it('пока идёт Леший, кикимор нет', () => {
    const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false }), players, 17);
    toPlay(sim);
    const p = sim.pr[0];
    let hidden = false;
    let back = false;
    for (let i = 0; i < 20 * 120 && p.alive && !back; i++) {
      p.sanity = 20;
      for (const k of p.kiki) k.at = sim.world.time + 1000; // стоят в воде, не подходят
      const c = sim.world.crowd;
      if (c && !c.vote && sim.world.time >= c.showAt + 100 && p.crowdAnswered !== c.warnAt) sim.intent('a', { k: 'crowd', kind: c.kind });
      sim.tick();
      const left = sim.timeLeft() / 1000;
      const clockSec = sim.cfg.nightMaxSec - left;
      if (clockSec > leshySec(sim.round) - 6 && clockSec < leshySec(sim.round) - 2) {
        expect(p.kiki.length).toBe(0);
        hidden = true;
      }
      if (clockSec > leshySec(sim.round) + 12 && p.kiki.length > 0) back = true;
    }
    expect(hidden).toBe(true);
    expect(back).toBe(true); // Леший ушёл — вернулись
  });
  it('за неправильный жест вырезает только Леший: уровень «сложно» в этой теме не режет', () => {
    const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, strictCrowd: true, endWhenLastAlive: false }), players, 5);
    toPlay(sim);
    const warn = () => (sim as unknown as { leshyWarn: number }).leshyWarn;
    let missed = 0;
    // до первого прихода Лешего никто не отвечает на команды — и никого не вырезают
    for (let i = 0; i < 20 * 120 && warn() < 0; i++) {
      for (const p of sim.pr) p.sanity = 100;
      const c = sim.world.crowd;
      if (c && sim.world.time === c.windowEnd) missed++;
      sim.tick();
    }
    expect(missed).toBeGreaterThan(0);
    expect(sim.pr.every((p) => p.alive)).toBe(true);
  });
  it('приходы Лешего: несколько за ночь, ложных двух подряд нет, первый настоящий не раньше 24-й секунды', () => {
    let falses = 0;
    for (let r = 1; r <= 40; r++) {
      const v = leshyVisits(r);
      expect(v).toEqual(leshyVisits(r));
      expect(v.length).toBeGreaterThanOrEqual(3);
      expect(v[v.length - 1].sec).toBeGreaterThan(250); // охота до самого потолка ночи
      expect(v[0].sec).toBeGreaterThanOrEqual(24);
      for (let i = 1; i < v.length; i++) {
        // до охоты — не чаще раза в 22 с, на охоте — раз в 14–18 с и без ложных
        expect(v[i].sec - v[i - 1].sec).toBeGreaterThanOrEqual(v[i - 1].sec >= LESHY_HUNT_SEC ? 14 : 22);
        if (v[i].sec >= LESHY_HUNT_SEC) expect(v[i].real).toBe(true);
        expect(!v[i].real && !v[i - 1].real).toBe(false);
      }
      falses += v.filter((x) => !x.real).length;
    }
    expect(falses).toBeGreaterThan(20);
  });
  it('Леший бьёт одного — ближайшего к себе из не замерших; дальнего только подсвечивает', () => {
    const three = ['a', 'b', 'c'].map((pid, i) => ({ pid, name: pid, color: i }));
    const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false }), three, 13);
    toPlay(sim);
    const [a, b, c] = sim.pr;
    const warn = () => (sim as unknown as { leshyWarn: number }).leshyWarn;
    for (let i = 0; i < 20 * 120 && warn() < 0; i++) {
      for (const p of sim.pr) p.sanity = 100;
      const cr = sim.world.crowd;
      if (cr && !cr.vote && sim.world.time >= cr.showAt + 100) for (const p of sim.pr) if (p.crowdAnswered !== cr.warnAt) sim.intent(p.pid, { k: 'crowd', kind: cr.kind });
      sim.tick();
    }
    expect(warn()).toBeGreaterThan(0);
    const spot = leshySpot(warn(), sim.arena.width);
    const ea = sim.world.get(a.eid)!;
    const ec = sim.world.get(c.eid)!;
    [ea.x, ea.y] = [spot.x + 6, spot.y];
    [ec.x, ec.y] = [spot.x - 60, spot.y - 90];
    for (let i = 0; i < 20 * 9; i++) {
      const cr = sim.world.crowd;
      if (cr && !cr.vote && sim.world.time >= cr.showAt + 100 && b.crowdAnswered !== cr.warnAt) sim.intent('b', { k: 'crowd', kind: cr.kind });
      sim.tick();
    }
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    expect(c.alive).toBe(true);
  });
  it('замер, но шевельнулся, пока Леший смотрит, — забирает ближайшего из дёрнувшихся; стоящих не трогает', () => {
    const three = ['a', 'b', 'c'].map((pid, i) => ({ pid, name: pid, color: i }));
    const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false }), three, 13);
    toPlay(sim);
    const [a, b, c] = sim.pr;
    const warn = () => (sim as unknown as { leshyWarn: number }).leshyWarn;
    const answer = () => {
      const cr = sim.world.crowd;
      if (cr && !cr.vote && sim.world.time >= cr.showAt + 100) for (const p of sim.pr) if (p.alive && p.crowdAnswered !== cr.warnAt) sim.intent(p.pid, { k: 'crowd', kind: cr.kind });
    };
    for (let i = 0; i < 20 * 120 && warn() < 0; i++) {
      for (const p of sim.pr) p.sanity = 100;
      answer();
      sim.tick();
    }
    expect(warn()).toBeGreaterThan(0);
    const spot = leshySpot(warn(), sim.arena.width);
    // b — ближе всех к Лешему, но стоит; a и c дёрнутся, a ближе
    const place = (eid: number, x: number, y: number) => Object.assign(sim.world.get(eid)!, { x, y });
    place(b.eid, spot.x + 4, spot.y);
    place(a.eid, spot.x + 30, spot.y);
    place(c.eid, spot.x - 60, spot.y - 90);
    const cr = sim.world.crowd!;
    expect(cr.watchUntil).toBe(cr.windowEnd + LAG_GRACE_MS + sim.cfg.leshyWatchMs);
    let moved = false;
    for (let i = 0; i < 20 * 10; i++) {
      answer();
      if (!moved && sim.world.time >= cr.windowEnd + 300) {
        moved = true;
        for (const p of [a, c]) {
          const e = sim.world.get(p.eid)!;
          sim.intent(p.pid, { k: 'move', x: e.x + 12, y: e.y });
        }
      }
      // замерший держит позу, пока Леший не ушёл
      if (sim.world.time === cr.watchUntil! - 50) expect(sim.world.get(b.eid)!.act).toBe(CROWD_ACT.freeze);
      sim.tick();
    }
    expect(a.alive).toBe(false);
    expect(a.diedAt!).toBeGreaterThan(cr.watchUntil!);
    expect(b.alive).toBe(true);
    expect(c.alive).toBe(true);
  });
  it('провинности: прожектора нет, пропуск жеста — провинность; с двумя Леший забирает и замершего, остальным одна прощается', () => {
    const three = ['a', 'b', 'c'].map((pid, i) => ({ pid, name: pid, color: i }));
    const sim = new MatchSim(makeConfig({ fixedTheme: KUPALA, endWhenLastAlive: false }), three, 29);
    toPlay(sim);
    const [a, b, c] = sim.pr;
    const spots: WorldEvent[] = [];
    sim.world.listeners.push((ev) => ev.t === 'spot' && spots.push(ev));
    const warn = () => (sim as unknown as { leshyWarn: number }).leshyWarn;
    // a не повторяет обычные жесты, b и c — повторяют
    for (let i = 0; i < 20 * 120 && warn() < 0; i++) {
      for (const p of sim.pr) p.sanity = 100;
      const cr = sim.world.crowd;
      if (cr && !cr.vote && sim.world.time >= cr.showAt + 100) for (const p of [b, c]) if (p.crowdAnswered !== cr.warnAt) sim.intent(p.pid, { k: 'crowd', kind: cr.kind });
      sim.tick();
    }
    expect(spots.length).toBe(0);
    a.sins = 2; // накопил (команд до Лешего могло быть мало)
    c.sins = 1;
    // на «Тсс!» Лешего замирают все
    for (let i = 0; i < 20 * 8; i++) {
      const cr = sim.world.crowd;
      if (cr && !cr.vote && sim.world.time >= cr.showAt + 100) for (const p of sim.pr) if (p.alive && p.crowdAnswered !== cr.warnAt) sim.intent(p.pid, { k: 'crowd', kind: cr.kind });
      sim.tick();
    }
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    expect(c.alive).toBe(true);
    expect(c.sins).toBe(0);
    expect(spots.length).toBe(0);
  });
});
