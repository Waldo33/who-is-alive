import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rng, killerExposed } from '@kto/game-core';
import type { PlayerInfo } from '@kto/game-core';
import { DelayedTransport, HostSession, LoopbackHub, RemoteSession } from '../src';
import type { RoomMsg } from '../src';

/**
 * Сетевой стенд (раздел 18): хост и 3 гостя на петле в памяти с задержкой и потерями.
 * Время — поддельное: один шаг цикла = 50 мс у всех.
 */
const players: PlayerInfo[] = ['h', 'g1', 'g2', 'g3'].map((pid, i) => ({ pid, name: 'Игрок ' + pid, color: i }));

interface Rig {
  hub: LoopbackHub;
  host: HostSession;
  guests: RemoteSession[];
  now: () => number;
  step: () => void;
  roomLog: { to: string; msg: RoomMsg }[];
  privLog: { to: string; msg: unknown }[];
  history: Map<number, Map<number, [number, number]>>;
}

function makeRig(latency: [number, number], loss = 0, seed = 1): Rig {
  let nowMs = 0;
  const clock = () => nowMs;
  const hub = new LoopbackHub(seed);
  hub.latency = latency;
  hub.loss = loss;
  const tHost = hub.join({ userId: 'h', name: 'h', color: 0, joinedAt: 0 });
  const tGuests = ['g1', 'g2', 'g3'].map((id, i) => hub.join({ userId: id, name: id, color: i + 1, joinedAt: i + 1 }));
  const roomLog: Rig['roomLog'] = [];
  const privLog: Rig['privLog'] = [];
  tGuests.forEach((t) =>
    t.onMessage((ch, msg) => {
      if (ch === 'room') roomLog.push({ to: t.selfId, msg: msg as RoomMsg });
      if (ch === 'private') privLog.push({ to: t.selfId, msg });
    }),
  );
  // гости подключаются раньше хоста, как в жизни: сообщение match_start пришло — сессия создана
  const guests = tGuests.map((t) => new RemoteSession({ transport: t, selfPid: t.selfId, hostPid: 'h', players, cfg: {}, clock }));
  const host = new HostSession({ transport: tHost, players, cfg: {}, seed, hostPid: 'h' });
  const history: Rig['history'] = new Map();
  const step = () => {
    nowMs += 50;
    vi.advanceTimersByTime(50);
    host.tick();
    const snap = new Map<number, [number, number]>();
    for (const e of host.world.entities) if (e.alive) snap.set(e.eid, [e.x, e.y]);
    history.set(host.world.time, snap);
    for (const g of guests) g.tick();
  };
  return { hub, host, guests, now: clock, step, roomLog, privLog, history };
}

/** Простые «пальцы» гостей: ходят, жмут команды, иногда бьют. */
function botFingers(rig: Rig, rng: Rng): void {
  for (const g of rig.guests) {
    const me = g.me();
    if (!me) continue;
    if (g.phase === 'play' && me.alive) {
      if (g.crowdWindowOpen() && me.crowdAnswered !== g.world.crowd!.warnAt && rng.chance(0.2)) {
        g.intent({ k: 'crowd', kind: g.world.crowd!.kind });
      } else if (rng.chance(0.03)) {
        g.intent({ k: 'move', x: rng.int(20, 160), y: rng.int(30, 240) });
      } else if (rng.chance(0.004)) {
        const mine = g.world.get(me.eid);
        const near = g.world.alive().find((e) => e.eid !== me.eid && mine && Math.hypot(e.x - mine.x, e.y - mine.y) < 12);
        if (near) g.intent({ k: 'attack', eid: near.eid });
      }
    }
    if (g.phase === 'accuse' && me.accused === null && rng.chance(0.05)) {
      const any = g.world.alive().find((e) => e.eid !== me.eid);
      if (any) g.intent({ k: 'accuse', eid: any.eid });
    }
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('сетевая игра', () => {
  it('позиции у гостей совпадают с хостом (кроме своего предсказанного персонажа)', () => {
    const rig = makeRig([80, 200], 0, 3);
    const rng = new Rng(9);
    let compared = 0;
    let maxDiff = 0;
    for (let i = 0; i < 20 * 70 && rig.host.phase !== 'accuse'; i++) {
      rig.step();
      botFingers(rig, rng);
      for (const g of rig.guests) {
        const h = rig.history.get(g.world.time);
        if (!h || g.phase !== 'play') continue;
        const own = g.me()?.eid;
        for (const e of g.world.entities) {
          if (!e.alive || e.eid === own) continue;
          const p = h.get(e.eid);
          if (!p) continue;
          maxDiff = Math.max(maxDiff, Math.hypot(p[0] - e.x, p[1] - e.y));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it('гость играет весь матч: фазы, итоги, конец матча', () => {
    const rig = makeRig([60, 160], 0, 4);
    const rng = new Rng(4);
    const seenPhases = new Set<string>();
    for (let i = 0; i < 20 * 60 * 12 && rig.guests[0].phase !== 'match_end'; i++) {
      rig.step();
      botFingers(rig, rng);
      // хост жмёт «Дальше» сам по таймеру — этого достаточно
      seenPhases.add(rig.guests[0].phase);
    }
    const g = rig.guests[0];
    expect([...seenPhases].sort()).toEqual(['accuse', 'countdown', 'match_end', 'play', 'results', 'reveal'].sort());
    expect(g.match).not.toBeNull();
    expect(g.scores).toEqual(rig.host.scores);
    expect(g.match!.winners).toEqual(rig.host.match!.winners);
  });

  it('зритель: подключился посреди дубля — смотрит со следующего, с задержкой, ничего не шлёт и не знает игроков', () => {
    const rig = makeRig([40, 90], 0, 7);
    const rng = new Rng(7);
    // первый дубль уже идёт
    for (let i = 0; i < 20 * 20; i++) {
      rig.step();
      botFingers(rig, rng);
    }
    const raw = rig.hub.join({ userId: 'spy', name: 'spy', color: 9, joinedAt: 9 });
    const sent: unknown[] = [];
    const origSend = raw.send.bind(raw);
    raw.send = async (c, m, to) => {
      sent.push(m);
      return origSend(c, m, to);
    };
    const DELAY = 3000;
    const spy = new RemoteSession({ transport: new DelayedTransport(raw, DELAY), selfPid: 'spy', hostPid: 'h', players, cfg: {}, clock: rig.now, spectator: true });
    const round0 = rig.host.round;
    for (let i = 0; i < 20 * 200 && rig.host.round === round0; i++) {
      rig.step();
      botFingers(rig, rng);
      spy.tick();
      // пока не начался новый дубль, зритель ничего не видит
      expect(spy.watching).toBe(false);
    }
    expect(rig.host.round).toBe(round0 + 1);
    for (let i = 0; i < 20 * 20; i++) {
      rig.step();
      botFingers(rig, rng);
      spy.tick();
    }
    expect(spy.watching).toBe(true);
    expect(spy.round).toBe(rig.host.round);
    expect(spy.me()).toBeUndefined();
    // отстаёт примерно на задержку
    const lag = rig.host.world.time - spy.world.time;
    expect(lag).toBeGreaterThan(DELAY - 500);
    expect(lag).toBeLessThan(DELAY + 1500);
    // мир зрителя совпадает с прошлым хоста
    const past = rig.history.get(spy.world.time);
    expect(past).toBeDefined();
    let far = 0;
    for (const e of spy.world.entities) {
      const p = past!.get(e.eid);
      if (e.alive && p && Math.hypot(p[0] - e.x, p[1] - e.y) > 2) far++;
    }
    expect(far).toBeLessThanOrEqual(2);
    expect(sent).toHaveLength(0);
    spy.dispose();
  });

  it('по сети не узнать, кто живой: ни события мира, ни ключевые кадры не содержат игроков', () => {
    const rig = makeRig([50, 120], 0, 5);
    const rng = new Rng(5);
    for (let i = 0; i < 20 * 70 && rig.host.phase !== 'accuse'; i++) {
      rig.step();
      botFingers(rig, rng);
    }
    const pidRe = /:"(h|g1|g2|g3)"/; // значение-строка с id игрока (ключ "h" у прямоугольника — не то)
    let twist = false;
    for (const { msg } of rig.roomLog) {
      if (msg.t === 'ev' || msg.t === 'snap' || msg.t === 'round') expect(JSON.stringify(msg)).not.toMatch(pidRe);
      if (msg.t === 'ev') {
        for (const ev of msg.ev) {
          if (ev.t === 'twist') twist = ev.on;
          // кто бил, виден только там, где это решила тема (ночь Майами)
          if (ev.t === 'hit' && ev.result === 'player' && !killerExposed(rig.host.sim.theme, twist, false)) expect(ev.attacker).toBeUndefined();
        }
      }
    }
    // личное сообщение каждого гостя упоминает только его собственную сущность
    for (const { to, msg } of rig.privLog) {
      const m = msg as { t: string; me?: { eid: number } };
      if (m.t === 'me') expect(m.me!.eid).toBe(rig.host.sim.playerRound(to)!.eid);
    }
  });

  it('оптимистичный интерфейс: свой удар и его итог видны раньше, чем мир гостя дойдёт до удара', () => {
    const rig = makeRig([120, 250], 0, 8);
    const g = rig.guests[0];
    let target = -1;
    for (let i = 0; i < 20 * 70 && target < 0; i++) {
      rig.step();
      const me = g.me();
      if (!me || g.phase !== 'play' || !me.alive || g.world.time < 3000) continue;
      const mine = g.world.get(me.eid)!;
      const near = g.world.alive().find((e) => e.eid !== me.eid && Math.hypot(e.x - mine.x, e.y - mine.y) < 9);
      if (!near) continue;
      const before = me.attacksLeft;
      g.intent({ k: 'attack', eid: near.eid });
      // кулак гаснет сразу, не дожидаясь хоста
      expect(g.me()!.attacksLeft).toBe(before - 1);
      target = near.eid;
    }
    expect(target).toBeGreaterThanOrEqual(0);
    let shownWt = -1;
    let resultAt = -1;
    for (let i = 0; i < 40; i++) {
      rig.step();
      const atk = rig.privLog.find((m) => m.to === 'g1' && (m.msg as { t: string }).t === 'atk');
      if (atk) resultAt = (atk.msg as { at: number }).at;
      if (shownWt < 0 && !g.world.get(target)!.alive) shownWt = g.world.time;
    }
    const denied = rig.privLog.some((m) => m.to === 'g1' && (m.msg as { t: string }).t === 'denied');
    if (denied) return; // цель успела уйти и по перемотке — тогда итога нет, это честно
    expect(resultAt).toBeGreaterThan(0);
    expect(shownWt).toBeGreaterThan(0);
    // «поф» показан, когда мир гостя ещё не дошёл до момента удара у хоста
    expect(shownWt).toBeLessThan(resultAt);
    // итог удара получает только нападавший
    expect(rig.privLog.filter((m) => (m.msg as { t: string }).t === 'atk').every((m) => m.to === 'g1')).toBe(true);
  });

  it('новые механики по сети: условия съёмки доходят до гостей, «Хлопушка» вырезанного гостя тайно загадывает жест', () => {
    const rig = makeRig([60, 140], 0, 8);
    const rng = new Rng(8);
    const sim = (rig.host as unknown as { sim: { playerRound(pid: string): { alive: boolean } | undefined } }).sim;
    let modChecked = 0;
    // до второго дубля: условия съёмки у гостей те же, что у хоста
    for (let i = 0; i < 20 * 60 * 6 && rig.host.round < 3; i++) {
      rig.step();
      botFingers(rig, rng);
      if (rig.host.phase === 'play' && rig.guests[0].phase === 'play' && rig.guests[0].round === rig.host.round) {
        expect(rig.guests[0].mod).toBe(rig.host.mod);
        modChecked++;
      }
    }
    expect(modChecked).toBeGreaterThan(100);
    // вырезанный гость подаёт команду: она приходит всем одинаковой
    for (let i = 0; i < 20 * 30 && rig.host.phase !== 'play'; i++) rig.step();
    const g1 = sim.playerRound('g1')!;
    g1.alive = false;
    for (let i = 0; i < 20 * 30 && !(rig.host.crowdCanStart() && rig.guests[0].me()?.alive === false); i++) rig.step();
    const before = rig.host.world.crowd?.warnAt ?? -1;
    rig.guests[0].intent({ k: 'clap', kind: 'dance' });
    // жест вырезанного не назван и начинается после разогрева толпы (~3,4 с)
    for (let i = 0; i < 20 * 5; i++) rig.step();
    const c = rig.host.world.crowd!;
    expect(c.warnAt).toBeGreaterThan(before);
    expect(c.kind).toBe('dance');
    expect(c.vote).toBe(true);
    expect(c.ghost).toBe(true);
    for (let i = 0; i < 20 * 2; i++) rig.step();
    for (const g of rig.guests) expect(g.world.crowd?.warnAt).toBe(c.warnAt);
    expect(rig.guests[0].me()!.clapsLeft).toBe(rig.host.cfg.ghostClaps - 1);
  });

  it('нагрузка: не больше 35 доставленных сообщений в секунду на комнату', () => {
    const rig = makeRig([50, 100], 0, 6);
    const rng = new Rng(6);
    const before = rig.hub.delivered;
    let ticks = 0;
    for (; ticks < 20 * 60; ticks++) {
      rig.step();
      botFingers(rig, rng);
    }
    const perSec = (rig.hub.delivered - before) / (ticks / 20);
    expect(perSec).toBeLessThanOrEqual(35);
  });

  it('потери 5%: ключевые кадры возвращают гостей к хосту', () => {
    const rig = makeRig([80, 250], 0.05, 7);
    const rng = new Rng(7);
    let late = 0;
    let total = 0;
    for (let i = 0; i < 20 * 70 && rig.host.phase !== 'accuse'; i++) {
      rig.step();
      botFingers(rig, rng);
      if (i < 20 * 20) continue;
      for (const g of rig.guests) {
        const h = rig.history.get(g.world.time);
        if (!h || g.phase !== 'play') continue;
        const own = g.me()?.eid;
        for (const e of g.world.entities) {
          const p = h.get(e.eid);
          if (!p || !e.alive || e.eid === own) continue;
          total++;
          if (Math.hypot(p[0] - e.x, p[1] - e.y) > 1) late++;
        }
      }
    }
    // потерянный пакет событий портит позиции до ближайшего ключевого кадра (≤ 2 с) — доля таких кадров небольшая
    expect(late / total).toBeLessThan(0.15);
  });

  it('переподключение: новая вкладка того же игрока получает снимок и догоняет хоста', () => {
    const rig = makeRig([60, 120], 0, 8);
    const rng = new Rng(8);
    for (let i = 0; i < 20 * 25; i++) {
      rig.step();
      botFingers(rig, rng);
    }
    // гость g1 «перезагрузил страницу»: старая сессия умерла, новая просит снимок
    const old = rig.guests[0];
    old.dispose();
    const t = rig.hub.join({ userId: 'g1', name: 'g1', color: 1, joinedAt: 9 });
    const fresh = new RemoteSession({ transport: t, selfPid: 'g1', hostPid: 'h', players, cfg: {}, clock: rig.now, resync: true });
    rig.guests[0] = fresh;
    let maxDiff = 0;
    let compared = 0;
    for (let i = 0; i < 20 * 15; i++) {
      rig.step();
      if (i < 20 * 3) continue;
      const h = rig.history.get(fresh.world.time);
      if (!h || fresh.phase !== 'play') continue;
      for (const e of fresh.world.entities) {
        const p = h.get(e.eid);
        if (!p || !e.alive || e.eid === fresh.me()?.eid) continue;
        maxDiff = Math.max(maxDiff, Math.hypot(p[0] - e.x, p[1] - e.y));
        compared++;
      }
    }
    expect(fresh.me()?.eid).toBe(rig.host.sim.playerRound('g1')!.eid);
    expect(compared).toBeGreaterThan(1000);
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it.each([
    { lat: [40, 90] as [number, number], loss: 0, seed: 12 },
    { lat: [120, 350] as [number, number], loss: 0, seed: 13 },
    { lat: [200, 600] as [number, number], loss: 0.03, seed: 14 },
  ])('свой персонаж у гостя не отбрасывает назад и он приходит туда, куда нажали последним ($lat мс, потери $loss)', ({ lat, loss, seed }) => {
    const rig = makeRig(lat, loss, seed);
    const g = rig.guests[0];
    const rng = new Rng(seed);
    while (g.phase !== 'play' || !g.me()) rig.step();
    for (let i = 0; i < 20 * 3; i++) rig.step();
    const speed = g.cfg.entitySpeed;
    const maxStep = (speed * 50) / 1000;
    let jumps = 0;
    let worst = 0;
    let prev: [number, number] | null = null;
    let last: [number, number] = [0, 0];
    const zone = () => g.world.zoneRect() ?? g.arena.walk;
    for (let i = 0; i < 20 * 30 && rig.host.phase === 'play'; i++) {
      // тап каждые 0,4–1,2 с, иногда очень часто — как на телефоне
      if (i % 20 === 0 || (i % 7 === 0 && rng.chance(0.4))) {
        const z = zone();
        last = [rng.int(Math.ceil(z.x) + 4, Math.floor(z.x + z.w) - 4), rng.int(Math.ceil(z.y) + 4, Math.floor(z.y + z.h) - 4)];
        g.intent({ k: 'move', x: last[0], y: last[1] });
      }
      rig.step();
      const me = g.world.get(g.me()!.eid)!;
      if (!me.alive || g.world.isFrozen()) {
        prev = null;
        continue;
      }
      if (prev) {
        const d = Math.hypot(me.x - prev[0], me.y - prev[1]);
        worst = Math.max(worst, d);
        // два шага мира (догоняем хоста) + плавная поправка — больше уже рывок
        if (d > maxStep * 3 + 0.01) jumps++;
      }
      prev = [me.x, me.y];
    }
    // за кадр персонаж смещается не больше чем на три шага ходьбы: никаких телепортов назад
    expect(jumps, `worst ${worst.toFixed(2)} px per tick, step ${maxStep}`).toBe(0);
    // остановились — гость и хост сходятся в одной точке, рядом с последним нажатием
    for (let i = 0; i < 20 * 10; i++) rig.step();
    const eid = g.me()!.eid;
    const mine = g.world.get(eid)!;
    const auth = rig.host.world.get(eid)!;
    if (mine.alive && auth.alive && rig.host.phase === 'play') {
      expect(Math.hypot(mine.x - auth.x, mine.y - auth.y)).toBeLessThanOrEqual(1);
      expect(Math.hypot(mine.x - last[0], mine.y - last[1])).toBeLessThanOrEqual(10);
    }
  });

  it('ИИ-актёры: хост играет за них, гость видит их в составе, но не знает их сущностей', () => {
    const hub = new LoopbackHub(31);
    hub.latency = [40, 90];
    const tHost = hub.join({ userId: 'h', name: 'h', color: 0, joinedAt: 0 });
    const tGuest = hub.join({ userId: 'g1', name: 'g1', color: 1, joinedAt: 1 });
    const roster: PlayerInfo[] = [
      { pid: 'h', name: 'h', color: 0 },
      { pid: 'g1', name: 'g1', color: 1 },
      { pid: 'ai-1', name: 'ИИ Батон', color: 2, ai: true },
      { pid: 'ai-2', name: 'ИИ Енот', color: 3, ai: true },
    ];
    let nowMs = 0;
    const leaks: unknown[] = [];
    tGuest.onMessage((_ch, msg) => leaks.push(msg));
    const guest = new RemoteSession({ transport: tGuest, selfPid: 'g1', hostPid: 'h', players: roster, cfg: {}, clock: () => nowMs });
    const host = new HostSession({ transport: tHost, players: roster, cfg: {}, seed: 31, hostPid: 'h' });
    const moved = new Set<number>();
    host.world.listeners.push((ev) => {
      if (ev.t === 'move') moved.add(ev.eid);
    });
    for (let i = 0; i < 20 * 200 && host.phase !== 'results'; i++) {
      nowMs += 50;
      vi.advanceTimersByTime(50);
      host.tick();
      guest.tick();
    }
    // за ИИ-актёров играет хост: их сущности ходят, дубль доходит до итогов
    const aiEids = host.sim.pr.filter((p) => p.pid.startsWith('ai-')).map((p) => p.eid);
    expect(aiEids.length).toBe(2);
    expect(aiEids.some((e) => moved.has(e))).toBe(true);
    expect(host.phase).toBe('results');
    expect(guest.players.filter((p) => p.ai).map((p) => p.pid)).toEqual(['ai-1', 'ai-2']);
    // гостю ничто не сообщает, какая сущность у ИИ-актёра, до итогов дубля
    const early = leaks.filter((m) => (m as { t?: string }).t === 'ev' || (m as { t?: string }).t === 'snap');
    expect(JSON.stringify(early)).not.toMatch(/ai-1|ai-2/);
    host.dispose();
    guest.dispose();
  });

  it('смена хоста: матч продолжается со счётом, раунд начинается заново', () => {
    const rig = makeRig([40, 80], 0, 10);
    for (let i = 0; i < 20 * 60 * 3 && rig.host.round < 2; i++) rig.step();
    const scores = { ...rig.guests[0].scores };
    const round = rig.guests[0].round;
    const { HostSession: H } = { HostSession };
    const next = new H({ transport: rig.hub.join({ userId: 'g1', name: 'g1', color: 1, joinedAt: 1 }), players: players.filter((p) => p.pid !== 'h'), cfg: {}, seed: 99, hostPid: 'g1', resume: { scores, round } });
    expect(next.round).toBe(round);
    for (const p of players.filter((p) => p.pid !== 'h')) expect(next.scores[p.pid]).toBe(scores[p.pid]);
    expect(next.phase).toBe('countdown');
  });
});

