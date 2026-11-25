import { describe, expect, it } from 'vitest';
import {
  AiPlayer,
  MatchSim,
  NavGrid,
  Rng,
  World,
  makeConfig,
  makeReplay,
  pickRoundAwards,
  plazaArena,
  planPath,
  ROTATION_THEMES,
  WALK_TOP,
  THEME_COUNT,
  THEME_RULES,
  seasonLeadTheme,
  themeRules,
} from '../src';
import type { WorldEvent } from '../src';

const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: pid, color: i }));

/** Вырезать игрока сразу (как «Пробный дубль»): без удара, чтобы не зависеть от позиций. */
function cut(sim: MatchSim, p: { alive: boolean; diedAt: number | null; eid: number }): void {
  p.alive = false;
  p.diedAt = sim.world.time;
  sim.world.push({ t: 'remove', eid: p.eid, cause: 'player', at: sim.world.time });
  sim.world.step();
}

function runUntil(sim: MatchSim, pred: () => boolean, maxTicks = 20 * 200): void {
  for (let i = 0; i < maxTicks && !pred(); i++) sim.tick();
}

describe('Rng', () => {
  it('одно зерно — одна последовательность', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const xs = Array.from({ length: 50 }, () => a.next());
    const ys = Array.from({ length: 50 }, () => b.next());
    expect(xs).toEqual(ys);
    expect(new Rng(43).next()).not.toEqual(xs[0]);
  });
  it('int включает границы', () => {
    const r = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(0, 3));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('NavGrid / A*', () => {
  const nav = new NavGrid(plazaArena(), 4);
  it('фонтан непроходим', () => {
    expect(nav.walkable(nav.cellAt(90, 130))).toBe(false);
    expect(nav.walkable(nav.cellAt(90, 100))).toBe(true);
  });
  it('путь обходит фонтан и не проходит через препятствия', () => {
    const path = nav.findPath(nav.cellAt(90, 100), nav.cellAt(90, 160));
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
    let prev = nav.cellAt(90, 100);
    for (const c of path!) {
      expect(nav.walkable(c)).toBe(true);
      expect(nav.lineClear(prev, c)).toBe(true);
      prev = c;
    }
  });
  it('нет пути в непроходимую клетку', () => {
    expect(nav.findPath(nav.cellAt(90, 100), nav.cellAt(90, 130))).toBeNull();
  });
  it('у стен нет укрытий: ни в стене, ни за деревом или ларьком человечка не спрятать', () => {
    // габариты спрайтов предметов (ширина × высота над точкой основания) — как их рисуют темы;
    // фонарь — тонкий столб, за ним всё видно
    const SIZE: Record<string, [number, number]> = {
      tree: [22, 30], stall: [34, 30], planter: [32, 13], fountain: [34, 34], benchH: [22, 10], benchV: [9, 24],
    };
    const arena = plazaArena();
    let worst = 0;
    for (let i = 0; i < nav.cols * nav.rows; i++) {
      if (!nav.walkable(i)) continue;
      const x = nav.cx(i);
      const y = nav.cy(i);
      expect(y).toBeGreaterThanOrEqual(WALK_TOP);
      // человечек 12×16, ноги в (x, y); предмет с основанием ниже рисуется поверх
      for (const p of arena.props) {
        const sz = SIZE[p.kind];
        if (!sz || p.y <= y) continue;
        const ox = Math.max(0, Math.min(x + 6, p.x + sz[0] / 2) - Math.max(x - 6, p.x - sz[0] / 2));
        const oy = Math.max(0, Math.min(y, p.y) - Math.max(y - 16, p.y - sz[1]));
        worst = Math.max(worst, (ox * oy) / (12 * 16));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.5);
  });
});

describe('World', () => {
  it('движение детерминировано и со скоростью 18 пикс./с', () => {
    const nav = new NavGrid(plazaArena(), 4);
    const mk = () => {
      const w = new World(nav, 18);
      w.init([{ eid: 1, x: nav.cx(nav.cellAt(30, 80)), y: nav.cy(nav.cellAt(30, 80)), dir: 0 }], 0);
      const path = planPath(w, 1, 150, 80, null)!;
      w.push({ t: 'move', eid: 1, path, at: 0 });
      for (let i = 0; i < 20; i++) w.step();
      return w.get(1)!;
    };
    const a = mk();
    const b = mk();
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.walk).toBeCloseTo(18, 5);
  });
});

describe('MatchSim', () => {
  it('32 сущности, у игроков разные eid, свои у каждого', () => {
    const sim = new MatchSim(makeConfig(), players, 7);
    expect(sim.world.entities.length).toBe(32);
    const eids = new Set(sim.pr.map((p) => p.eid));
    expect(eids.size).toBe(4);
  });

  it('удар по боту: 0 очков, оглушение, метка «!», лимит уменьшился', () => {
    const sim = new MatchSim(makeConfig(), players, 11);
    runUntil(sim, () => sim.phase === 'play');
    const me = sim.playerRound('a')!;
    const mine = sim.world.get(me.eid)!;
    const botEids = new Set(sim.pr.map((p) => p.eid));
    // ставим бота вплотную
    const bot = sim.world.entities.find((e) => !botEids.has(e.eid))!;
    bot.x = mine.x + 6;
    bot.y = mine.y;
    sim.bots.remove(bot.eid);
    sim.intent('a', { k: 'attack', eid: bot.eid });
    sim.tick();
    sim.tick();
    expect(me.attacksLeft).toBe(2);
    expect(me.botHits).toBe(1);
    expect(me.stunUntil).toBeGreaterThan(sim.world.time);
    expect(sim.scores.a).toBe(0);
    expect(sim.world.get(bot.eid)!.alive).toBe(false);
    expect(sim.world.get(me.eid)!.markUntil).toBeGreaterThan(sim.world.time);
  });

  it('удар по игроку: +1, жертва становится призраком, нападающий не раскрыт в событии', () => {
    const sim = new MatchSim(makeConfig(), players, 12);
    runUntil(sim, () => sim.phase === 'play');
    const a = sim.playerRound('a')!;
    const b = sim.playerRound('b')!;
    const ea = sim.world.get(a.eid)!;
    const eb = sim.world.get(b.eid)!;
    eb.x = ea.x + 5;
    eb.y = ea.y;
    const hits: unknown[] = [];
    sim.world.listeners.push((ev) => ev.t === 'hit' && hits.push(ev));
    sim.intent('a', { k: 'attack', eid: b.eid });
    sim.tick();
    sim.tick();
    expect(b.alive).toBe(false);
    expect(sim.scores.a).toBe(1);
    expect(hits).toHaveLength(1);
    expect((hits[0] as { attacker?: number }).attacker).toBeUndefined();
  });

  it('вне радиуса удара — отказ, лимит не тратится', () => {
    const sim = new MatchSim(makeConfig(), players, 13);
    runUntil(sim, () => sim.phase === 'play');
    const a = sim.playerRound('a')!;
    const ea = sim.world.get(a.eid)!;
    const far = sim.world.entities.find((e) => Math.hypot(e.x - ea.x, e.y - ea.y) > 40)!;
    sim.intent('a', { k: 'attack', eid: far.eid });
    sim.tick();
    expect(a.attacksLeft).toBe(3);
    expect(sim.notices.some((n) => n.t === 'denied' && n.reason === 'out_of_range')).toBe(true);
  });

  it('три звезды заканчивают раунд и дают +2', () => {
    const sim = new MatchSim(makeConfig(), players.slice(0, 2), 21);
    runUntil(sim, () => sim.phase === 'play');
    const a = sim.playerRound('a')!;
    const ea = sim.world.get(a.eid)!;
    for (let k = 0; k < 3; k++) {
      const st = [...sim.world.stars.values()][0];
      if (!st) {
        // ждём респавн
        runUntil(sim, () => sim.world.stars.size > 0, 20 * 10);
      }
      const s2 = [...sim.world.stars.values()][0];
      ea.x = s2.x;
      ea.y = s2.y;
      sim.tick();
      sim.tick();
    }
    expect(a.stars).toBe(3);
    // отдельного экрана обвинения нет: сразу разоблачение
    expect(sim.phase).toBe('reveal');
    expect(sim.summary!.endReason).toBe('stars');
    expect(sim.summary!.points.a.stars).toBe(2);
  });

  it('«Море волнуется»: стоп-кадр, нажатие в паузе выполняется вместе с толпой, один раз', () => {
    const sim = new MatchSim(makeConfig(), players, 31);
    runUntil(sim, () => sim.phase === 'play');
    runUntil(sim, () => !!sim.world.crowd);
    const c = sim.world.crowd!;
    expect(sim.world.isFrozen()).toBe(true);
    // в стоп-кадре никто не двигается
    const before = sim.world.entities.map((e) => [e.x, e.y]);
    sim.tick();
    sim.tick();
    expect(sim.world.entities.map((e) => [e.x, e.y])).toEqual(before);
    const a = sim.playerRound('a')!;
    sim.intent('a', { k: 'crowd', kind: c.kind });
    sim.tick();
    expect(a.crowdAnswered).toBe(c.warnAt);
    expect(a.crowdQueued!.at).toBeGreaterThanOrEqual(c.resumeAt);
    expect(a.crowdQueued!.at).toBeLessThanOrEqual(c.resumeAt + 300);
    sim.intent('a', { k: 'crowd', kind: 'jump' });
    sim.tick();
    expect(a.crowdQueued!.kind).toBe(c.kind);
    let acted = false;
    sim.world.listeners.push((ev) => {
      if (ev.t === 'act' && ev.eid === a.eid) acted = true;
    });
    runUntil(sim, () => acted, 20 * 4);
    expect(acted).toBe(true);
    expect(sim.world.time).toBeGreaterThanOrEqual(c.resumeAt);
  });

  it('пауза не съедает время раунда', () => {
    const sim = new MatchSim(makeConfig(), players, 32);
    runUntil(sim, () => sim.phase === 'play');
    const left0 = sim.timeLeft();
    runUntil(sim, () => !!sim.world.crowd);
    const leftAtCrowd = sim.timeLeft();
    runUntil(sim, () => !sim.world.isFrozen(), 20 * 4);
    expect(Math.abs(sim.timeLeft() - leftAtCrowd)).toBeLessThanOrEqual(100);
    expect(left0).toBeGreaterThan(leftAtCrowd);
  });

  it('по событиям мира нельзя отличить бота от игрока: команды одного формата', () => {
    const sim = new MatchSim(makeConfig(), players, 41);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, i + 1)));
    const shapes = new Map<string, Set<string>>();
    const playerEids = () => new Set(sim.pr.map((p) => p.eid));
    sim.world.listeners.push((ev) => {
      if (ev.t !== 'move' && ev.t !== 'act' && ev.t !== 'face' && ev.t !== 'stop') return;
      const who = playerEids().has(ev.eid) ? 'player' : 'bot';
      const key = ev.t + (ev.t === 'act' ? ':' + ev.kind : '');
      if (!shapes.has(key)) shapes.set(key, new Set());
      shapes.get(key)!.add(who + ':' + Object.keys(ev).sort().join(','));
    });
    runUntil(sim, () => sim.phase === 'reveal', 20 * 90);
    const move = [...(shapes.get('move') ?? [])].map((s) => s.split(':')[1]);
    expect(new Set(move).size).toBe(1);
  });

  it('удар по сети проверяется по тому, где цель была на экране нападавшего (не дальше LAG_GRACE_MS)', () => {
    const sim = new MatchSim(makeConfig(), players, 44);
    runUntil(sim, () => sim.phase === 'play' && sim.world.time > 3000, 20 * 30);
    const a = sim.pr[0];
    const ea = sim.world.get(a.eid)!;
    const bot = sim.world.alive().find((e) => !sim.pr.some((p) => p.eid === e.eid))!;
    const place = (x: number, y: number) => {
      Object.assign(bot, { x, y, px: x, py: y, path: [], pi: 0 });
      sim.bots.remove(bot.eid); // чтобы бот не ушёл сам
    };
    place(ea.x + 6, ea.y);
    for (let i = 0; i < 4; i++) sim.tick();
    const seenAt = sim.world.time;
    for (let i = 0; i < 4; i++) sim.tick();
    place(ea.x + 60, ea.y); // ушёл далеко «за время доставки»
    sim.intent(a.pid, { k: 'attack', eid: bot.eid, wt: seenAt });
    sim.tick();
    expect(bot.alive).toBe(false);
    expect(sim.notices.some((n) => n.t === 'attack' && n.pid === a.pid && n.result === 'bot')).toBe(true);
  });

  it('вычислили живого: метка вырезанного по ходу дубля — +1, у обвинённого нет очка за выживание', () => {
    const sim = new MatchSim(makeConfig(), players, 43);
    runUntil(sim, () => sim.phase === 'play' && sim.world.time > 2000, 20 * 30);
    const [a, b, c, d] = sim.pr;
    // живой обвинять не может
    sim.intent(b.pid, { k: 'accuse', eid: c.eid });
    sim.tick();
    expect(b.accused).toBeNull();
    cut(sim, a);
    sim.intent(a.pid, { k: 'accuse', eid: d.eid });
    sim.tick();
    expect(a.accused).toBe(d.eid);
    sim.intent(a.pid, { k: 'accuse', eid: -1 }); // снял метку
    sim.tick();
    expect(a.accused).toBeNull();
    sim.intent(a.pid, { k: 'accuse', eid: b.eid }); // перенёс — верно
    sim.tick();
    runUntil(sim, () => sim.phase === 'reveal', 20 * 90);
    expect(b.alive && c.alive).toBe(true);
    const pts = sim.summary!.points;
    expect(pts[a.pid].accuse).toBe(1);
    expect(sim.summary!.accusations).toEqual([{ pid: a.pid, eid: b.eid, correct: true }]);
    expect(pts[b.pid].survive).toBe(0);
    expect(pts[c.pid].survive).toBe(1);
  });

  it('чудачества ботов: случаются, все виды, бот остаётся ботом', () => {
    const sim = new MatchSim(makeConfig({ botQuirkPerMin: 20 }), players, 71);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, i + 3)));
    runUntil(sim, () => sim.phase === 'reveal', 20 * 90);
    const kinds = new Set(sim.bots.quirkLog.map((q) => q.kind));
    expect(sim.bots.quirkLog.length).toBeGreaterThan(10);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    const playerEids = new Set(sim.pr.map((p) => p.eid));
    expect(sim.bots.quirkLog.every((q) => !playerEids.has(q.eid))).toBe(true);
  });

  it('при botQuirkPerMin = 0 чудачеств нет', () => {
    const sim = new MatchSim(makeConfig({ botQuirkPerMin: 0 }), players, 72);
    runUntil(sim, () => sim.phase === 'reveal', 20 * 90);
    expect(sim.bots.quirkLog).toHaveLength(0);
  });

  it('повтор из журнала воспроизводит позиции', () => {
    const sim = new MatchSim(makeConfig(), players, 51);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, i + 5)));
    runUntil(sim, () => sim.phase === 'reveal', 20 * 90);
    const to = sim.playEnd;
    const from = Math.max(sim.playStart, to - 20000);
    const rep = makeReplay(sim.world, from, to)!;
    while (rep.time < sim.world.time) rep.step();
    for (const e of sim.world.entities) {
      const r = rep.get(e.eid)!;
      expect(r.alive).toBe(e.alive);
      if (e.alive) {
        expect(Math.abs(r.x - e.x)).toBeLessThan(0.01);
        expect(Math.abs(r.y - e.y)).toBeLessThan(0.01);
      }
    }
  });

  it('темы перемешаны в матче и не повторяются подряд, пока не пройдут все', () => {
    const firsts = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new MatchSim(makeConfig(), players, seed);
      firsts.add(sim.theme);
      expect([...sim.themeOrder].sort()).toEqual([...ROTATION_THEMES]);
    }
    expect(firsts.size).toBeGreaterThan(1);
  });

  it('изнанка темы: включается и выключается, толпа в ней оживает, повтор совпадает', () => {
    const office = themeRules(4);
    expect(office.id).toBe('office');
    const sim = new MatchSim(makeConfig({ fixedTheme: 4 }), players, 5);
    expect(sim.theme).toBe(4);
    const twists: WorldEvent[] = [];
    const acts: { on: boolean; at: number }[] = [];
    sim.world.listeners.push((ev) => {
      if (ev.t === 'twist') twists.push(ev);
      // команды «Море волнуется» не считаем — только эмоции толпы
      const c = sim.world.crowd;
      const crowdAct = !!c && ev.at >= c.showAt && ev.at <= c.windowEnd + 2500;
      if (ev.t === 'act' && !crowdAct && ['wave', 'dance', 'jump', 'jab'].includes(ev.kind)) acts.push({ on: sim.world.twist, at: ev.at });
    });
    runUntil(sim, () => sim.phase === 'play');
    const start = sim.world.time;
    // смена облика — никогда посреди команды «Море волнуется» (стоп-кадр и позы толпы)
    const busyAtTwist: number[] = [];
    sim.world.listeners.push((ev) => {
      if (ev.t === 'twist' && ev.on !== undefined && sim.phase === 'play') {
        const c = sim.world.crowd;
        if (c && ev.at >= c.showAt && ev.at <= c.windowEnd) busyAtTwist.push(ev.at);
      }
    });
    runUntil(sim, () => sim.phase !== 'play');
    expect(busyAtTwist).toEqual([]);
    const end = sim.world.time;
    const ons = twists.filter((e) => e.t === 'twist' && e.on).length;
    expect(ons).toBeGreaterThanOrEqual(1);
    expect(ons).toBeLessThanOrEqual(office.twist!.max);
    // к обвинению свет обратно
    expect(sim.world.twist).toBe(false);
    // в изнанке эмоций заметно больше (emoteMul)
    let onMs = 0;
    for (let i = 0; i < twists.length; i++) {
      const e = twists[i];
      if (e.t === 'twist' && e.on) onMs += (twists[i + 1]?.at ?? end) - e.at;
    }
    const rate = (n: number, ms: number) => n / Math.max(1, ms);
    const inside = acts.filter((a) => a.on).length;
    const outside = acts.length - inside;
    expect(rate(inside, onMs)).toBeGreaterThan(1.2 * rate(outside, end - start - onMs));
    // повтор из журнала видит изнанку там же
    const ev = twists.find((e) => e.t === 'twist' && e.on)!;
    const r = makeReplay(sim.world, ev.at - 2000, ev.at + 1000)!;
    expect(r.twist).toBe(false);
    while (r.time < ev.at + 500) r.step();
    expect(r.twist).toBe(true);
  });

  it('плавная изнанка (Майами): «Море волнуется» не начинается, пока идёт закат', () => {
    const rules = themeRules(5);
    expect(rules.id).toBe('miami');
    const quiet = rules.twist!.quietSec! * 1000;
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = new MatchSim(makeConfig({ fixedTheme: 5 }), players, seed);
      const twists: number[] = [];
      const bad: number[] = [];
      sim.world.listeners.push((ev) => {
        if (ev.t === 'twist') twists.push(ev.at);
        if (ev.t === 'crowd' && twists.some((at) => ev.at >= at && ev.at < at + quiet)) bad.push(ev.at);
      });
      runUntil(sim, () => sim.phase === 'reveal');
      expect(bad).toEqual([]);
      checked += twists.length;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('матч заканчивается, счёт сходится', () => {
    const sim = new MatchSim(makeConfig(), players, 61);
    players.forEach((p, i) => sim.addAgent(new AiPlayer(p.pid, i + 9)));
    runUntil(sim, () => sim.phase === 'match_end', 20 * 60 * 20);
    expect(sim.phase).toBe('match_end');
    expect(sim.match!.winners.length).toBeGreaterThan(0);
  });
});

describe('Награды', () => {
  it('приоритет и максимум 2 карточки', () => {
    const base = { alive: true, diedAtFromStart: null, kills: 0, killTimes: [], botHits: 0, stars: 0, accused: null, accuseCorrect: false, accusedAsGhost: false, timesAccused: 1 };
    const cards = pickRoundAwards({
      stats: [
        { ...base, pid: 'a', botHits: 2 },
        { ...base, pid: 'b', stars: 2, timesAccused: 0 },
        { ...base, pid: 'c', alive: false, diedAtFromStart: 5000 },
      ],
      neighbors: [{ a: 'a', b: 'b', ms: 9000, hit: false }],
      crowdShowTimes: [],
      plannedPlayEnd: 100000,
    });
    expect(cards.map((c) => c.id)).toEqual(['blindNeighbors', 'paranoid']);
    expect(cards[0].value).toBe(9);
  });
});

describe('загадка дня', () => {
  it('одна и та же у всех: детерминирована от номера, живой цел, в окне есть «Море волнуется»', async () => {
    const { buildDaily, dailyNumber, dailySquares } = await import('../src/daily');
    expect(dailyNumber('2026-11-23')).toBe(1);
    expect(dailyNumber('2026-12-31')).toBe(39);
    for (const n of [1, 2, 40]) {
      const a = buildDaily(n);
      const b = buildDaily(n);
      expect(a.answer).toBe(b.answer);
      expect(a.world.log.length).toBe(b.world.log.length);
      expect(a.world.get(a.answer)?.alive).toBe(true);
      expect(a.world.log.some((e) => e.t === 'crowd' && e.showAt >= a.from && e.windowEnd <= a.to)).toBe(true);
    }
    expect(dailySquares(2, true)).toBe('🟥🟩⬜');
    expect(dailySquares(3, false)).toBe('🟥🟥🟥');
  });

  it('у живого есть приметы, подсказка после промаха накрывает его', async () => {
    const { buildDaily, dailyHint } = await import('../src/daily');
    for (let n = 1; n <= 30; n++) {
      const p = buildDaily(n);
      const me = p.world.get(p.answer)!;
      const tells = p.world.log.filter(
        (e) => (e.t === 'star_taken' && e.eid === p.answer) || e.t === 'spot',
      ).length;
      expect(tells).toBeGreaterThan(0);
      for (const m of [1, 2]) {
        const r = dailyHint(p.sim.arena, me.x, me.y, m)!;
        expect(me.x >= r.x && me.x < r.x + r.w && me.y >= r.y && me.y < r.y + r.h).toBe(true);
      }
    }
    expect(dailyHint({ width: 180, height: 260 }, 10, 10, 0)).toBeNull();
  });
});


describe('новогодний сезон', () => {
  const party = THEME_RULES.findIndex((r) => r.id === 'party');

  it('«Корпоратив» — с 1 декабря по 14 января', () => {
    expect(seasonLeadTheme(10, 30)).toBe(-1);
    expect(seasonLeadTheme(11, 1)).toBe(party);
    expect(seasonLeadTheme(0, 14)).toBe(party);
    expect(seasonLeadTheme(0, 15)).toBe(-1);
  });

  it('в сезон матч открывается «Корпоративом», остальные темы на месте', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sim = new MatchSim(makeConfig({ leadTheme: party }), players, seed);
      expect(sim.themeOrder[0]).toBe(party);
      expect([...sim.themeOrder].sort((a, b) => a - b)).toEqual([...ROTATION_THEMES]);
    }
  });

  it('реванш после дубля «Корпоратив» начинается с другой темы, «Корпоратив» — вторым', () => {
    const sim = new MatchSim(makeConfig({ leadTheme: party }), players, 5);
    sim.theme = party;
    (sim as unknown as { rematch(): void }).rematch();
    expect(sim.themeOrder[0]).not.toBe(party);
    expect(sim.themeOrder[1]).toBe(party);
    expect(sim.theme).not.toBe(party);
  });

  it('вне сезона порядок тем как раньше', () => {
    const a = new MatchSim(makeConfig(), players, 9).themeOrder;
    const b = new MatchSim(makeConfig({ leadTheme: -1 }), players, 9).themeOrder;
    expect(b).toEqual(a);
  });
});
