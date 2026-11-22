import { describe, expect, it } from 'vitest';
import { AiPlayer, MatchSim, makeConfig, roundMod } from '../src';
import type { CrowdKind, WorldEvent } from '../src';

const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));
const KINDS: CrowdKind[] = ['freeze', 'jump', 'dance'];

function runUntil(sim: MatchSim, pred: () => boolean, maxTicks = 20 * 200): void {
  for (let i = 0; i < maxTicks && !pred(); i++) sim.tick();
}

/** Доступ к закрытому для настройки сценария (только в тестах). */
type Inner = { round: number; crowdCount: number; mod: number; scheduleCrowd(from: number): void };
const inner = (sim: MatchSim) => sim as unknown as Inner;

describe('Напряжение: новые механики', () => {
  it('статисты тоже берут звёзды — подбор звезды не доказывает, что это игрок', () => {
    let byBots = 0;
    let byPlayers = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const sim = new MatchSim(makeConfig(), players, 500 + seed);
      players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, seed * 10 + i)));
      sim.world.listeners.push((ev) => {
        if (ev.t !== 'star_taken') return;
        if (sim.pr.some((p) => p.eid === ev.eid)) byPlayers++;
        else byBots++;
      });
      runUntil(sim, () => sim.phase === 'match_end', 20 * 60 * 12);
    }
    expect(byBots).toBeGreaterThan(0);
    expect(byPlayers).toBeGreaterThan(0);
  });

  it('первый дубль матча — без «Условий съёмки», дальше они бывают', () => {
    const sim = new MatchSim(makeConfig({ roundModChance: 1 }), players, 77);
    expect(sim.mod).toBe(0);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, 70 + i)));
    runUntil(sim, () => sim.round === 2, 20 * 60 * 5);
    expect(sim.round).toBe(2);
    expect(sim.mod).toBeGreaterThan(0);
    if (roundMod(sim.mod) === 'onehit') for (const p of sim.pr) expect(p.attacksLeft).toBe(1);
  });

  it('нарастание: к концу дубля команды чаще', () => {
    const first: number[] = [];
    const last: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new MatchSim(makeConfig({ roundMods: false }), players, 900 + seed);
      const shows: number[] = [];
      sim.world.listeners.push((ev) => ev.t === 'crowd' && shows.push(ev.resumeAt));
      runUntil(sim, () => sim.phase === 'accuse', 20 * 120);
      if (shows.length < 3) continue;
      first.push(shows[1] - shows[0]);
      last.push(shows[shows.length - 1] - shows[shows.length - 2]);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(first.length).toBeGreaterThan(5);
    expect(avg(last)).toBeLessThan(avg(first));
  });

  it('«Толпа решает»: жест не назван, перед ним толпа разогревается, большинство ботов делает kind', () => {
    const sim = new MatchSim(makeConfig({ crowdVoteChance: 1 }), players, 41);
    runUntil(sim, () => sim.phase === 'play');
    const pe = new Set(sim.pr.map((p) => p.eid));
    const log: WorldEvent[] = [];
    sim.world.listeners.push((ev) => log.push(ev));
    inner(sim).round = 2;
    inner(sim).crowdCount = 1;
    inner(sim).scheduleCrowd(sim.world.time);
    runUntil(sim, () => !!sim.world.crowd);
    const c = sim.world.crowd!;
    expect(c.vote).toBe(true);
    // разогрев: в 3 с до команды — жест настроения (или тишина перед «замри»)
    const lead = log.filter((e) => e.at >= c.showAt - 3100 && e.at < c.showAt);
    if (c.kind === 'freeze') expect(lead.filter((e) => e.t === 'stop').length).toBeGreaterThan(3);
    else expect(lead.filter((e) => e.t === 'act' && e.kind === c.kind && !pe.has(e.eid)).length).toBeGreaterThan(3);
    // после паузы: большинство ботов — kind, но не все
    runUntil(sim, () => sim.world.time > c.resumeAt + 400);
    const acts = log.filter((e): e is Extract<WorldEvent, { t: 'act' }> => e.t === 'act' && e.at >= c.resumeAt && e.at <= c.resumeAt + 350 && !pe.has(e.eid) && KINDS.includes(e.kind as CrowdKind));
    const share = acts.filter((e) => e.kind === c.kind).length / acts.length;
    expect(acts.length).toBeGreaterThan(15);
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.9);
    // за неугаданный жест в «Толпа решает» прожектора нет
    runUntil(sim, () => sim.world.time > c.windowEnd + 800);
    expect(log.some((e) => e.t === 'spot' && e.at > c.showAt)).toBe(false);
  });

  it('прожектор: над не повторившим жест — круг со смещённым центром; повторившие вовремя — без него', () => {
    const sim = new MatchSim(makeConfig({ roundMods: false, botQuirkPerMin: 0 }), players, 52);
    runUntil(sim, () => sim.phase === 'play');
    const spots: Extract<WorldEvent, { t: 'spot' }>[] = [];
    sim.world.listeners.push((ev) => ev.t === 'spot' && spots.push(ev));
    runUntil(sim, () => !!sim.world.crowd);
    const c = sim.world.crowd!;
    for (const pid of ['a', 'c', 'd']) sim.intent(pid, { k: 'crowd', kind: c.kind });
    runUntil(sim, () => sim.world.time > c.windowEnd + 900);
    expect(spots).toHaveLength(1);
    const b = sim.world.get(sim.playerRound('b')!.eid)!;
    expect(Math.hypot(spots[0].x - b.x, spots[0].y - b.y)).toBeLessThanOrEqual(sim.cfg.spotJitter + 1);
    expect(spots[0].r).toBe(sim.cfg.spotRadius);
    expect(sim.playerRound('b')!.alive).toBe(true);
  });

  it('«Жёсткий дубль»: не повторил или ошибся — вырезан, опоздавший — только подсвечен', () => {
    const sim = new MatchSim(makeConfig({ roundMods: false }), players, 63);
    runUntil(sim, () => sim.phase === 'play');
    inner(sim).mod = 1; // hard
    runUntil(sim, () => !!sim.world.crowd);
    const c = sim.world.crowd!;
    const wrong = KINDS.find((k) => k !== c.kind)!;
    sim.intent('a', { k: 'crowd', kind: c.kind });
    sim.intent('b', { k: 'crowd', kind: wrong });
    runUntil(sim, () => sim.world.time >= c.resumeAt + 200);
    sim.intent('d', { k: 'crowd', kind: c.kind }); // опоздал, но повторил
    runUntil(sim, () => sim.world.time > c.windowEnd + 900);
    expect(sim.playerRound('a')!.alive).toBe(true);
    expect(sim.playerRound('b')!.alive).toBe(false);
    expect(sim.playerRound('c')!.alive).toBe(false);
    expect(sim.playerRound('d')!.alive).toBe(true);
  });

  it('«Хлопушка»: вырезанный подаёт команду толпе; живой не может; перезарядка', () => {
    const sim = new MatchSim(makeConfig({ roundMods: false }), players, 84);
    runUntil(sim, () => sim.phase === 'play');
    const a = sim.playerRound('a')!;
    const b = sim.playerRound('b')!;
    const ea = sim.world.get(a.eid)!;
    const eb = sim.world.get(b.eid)!;
    eb.x = ea.x + 5;
    eb.y = ea.y;
    sim.intent('a', { k: 'attack', eid: b.eid });
    sim.tick();
    sim.tick();
    expect(b.alive).toBe(false);
    // живой не подаёт
    const crowds: WorldEvent[] = [];
    sim.world.listeners.push((ev) => ev.t === 'crowd' && crowds.push(ev));
    runUntil(sim, () => sim.crowdCanStart());
    sim.intent('a', { k: 'clap', kind: 'jump' });
    sim.tick();
    expect(crowds).toHaveLength(0);
    sim.intent('b', { k: 'clap', kind: 'jump' });
    sim.tick();
    expect(crowds).toHaveLength(1);
    expect((crowds[0] as { kind: string }).kind).toBe('jump');
    expect(b.clapsLeft).toBe(sim.cfg.ghostClaps - 1);
    sim.notices = [];
    sim.intent('b', { k: 'clap', kind: 'dance' });
    sim.tick();
    expect(crowds).toHaveLength(1);
    expect(sim.notices.some((n) => n.t === 'denied' && n.reason === 'not_now')).toBe(true);
  });

  it('ночь Майами: кто бил, видно всем (attacker в hit); днём и в детском режиме — тайна', () => {
    const hitOf = (kids: boolean, twist: boolean) => {
      const sim = new MatchSim(makeConfig({ roundMods: false, fixedTheme: 5, kidsMode: kids }), players, 91);
      runUntil(sim, () => sim.phase === 'play');
      if (twist) sim.world.push({ t: 'twist', on: true, at: sim.world.time });
      sim.tick();
      expect(sim.world.twist).toBe(twist);
      const a = sim.playerRound('a')!;
      const b = sim.playerRound('b')!;
      const ea = sim.world.get(a.eid)!;
      const eb = sim.world.get(b.eid)!;
      eb.x = ea.x + 5;
      eb.y = ea.y;
      const hits: WorldEvent[] = [];
      sim.world.listeners.push((ev) => ev.t === 'hit' && hits.push(ev));
      sim.intent('a', { k: 'attack', eid: b.eid });
      sim.tick();
      sim.tick();
      expect(hits).toHaveLength(1);
      return hits[0] as Extract<WorldEvent, { t: 'hit' }>;
    };
    expect(hitOf(false, true).attacker).toBeDefined();
    expect(hitOf(false, false).attacker).toBeUndefined();
    expect(hitOf(true, true).attacker).toBeUndefined();
  });
});
