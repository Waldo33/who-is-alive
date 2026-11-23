import { afterEach, describe, expect, it } from 'vitest';
import { Rng, killerExposed } from '@kto/game-core';
import { RemoteSession, ServerLink } from '@kto/net';
import type { RoomMsg, WireRoom } from '@kto/net';
import { silentLogger } from '../src/log';
import { GameServer } from '../src/server';

/**
 * Живой стенд: настоящий HTTP + WebSocket на localhost, клиенты — те же `ServerLink` и
 * `RemoteSession`, что в браузере. Матч ускорен (speed), чтобы пройти его за секунды.
 */

const SECRET = 'test-secret-test-secret-test-secret!!';
let servers: GameServer[] = [];
let links: ServerLink[] = [];

afterEach(async () => {
  for (const l of links) await l.close();
  links = [];
  for (const s of servers) await s.close();
  servers = [];
});

async function boot(speed = 1) {
  const srv = new GameServer({ authSecret: SECRET, log: silentLogger, speed });
  servers.push(srv);
  const port = await srv.listen(0, '127.0.0.1');
  return { srv, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/i/blue/ws` };
}

async function anon(http: string): Promise<{ userId: string; token: string }> {
  const r = await fetch(`${http}/v1/auth/anon`, { method: 'POST' });
  expect(r.status).toBe(200);
  return (await r.json()) as { userId: string; token: string };
}

async function create(http: string, token: string, body: object = { name: 'Режиссёр' }): Promise<{ code: string; wsUrl: string }> {
  const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return (await r.json()) as { code: string; wsUrl: string };
}

function link(ws: string, u: { userId: string; token: string }, code: string, name: string): ServerLink {
  const l = new ServerLink({ url: ws, token: u.token, selfId: u.userId, code, name, silenceMs: 60_000 });
  links.push(l);
  return l;
}

async function until(cond: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('игровой сервер: вход и HTTP', () => {
  it('анонимный токен, создание комнаты, превью; чужой токен — отказ', async () => {
    const { http } = await boot();
    const u = await anon(http);
    expect(u.userId).toMatch(/^[0-9a-f-]{36}$/);
    const bad = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const { code, wsUrl } = await create(http, u.token);
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(wsUrl).toMatch(/\/i\/blue\/ws$/);
    const p = await fetch(`${http}/v1/rooms/${code.toLowerCase()}`);
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ code, status: 'lobby', players: [{ name: 'Режиссёр', color: 0 }] });
    expect((await fetch(`${http}/v1/rooms/ZZZZ`)).status).toBe(404);
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
  });
});

describe('игровой сервер: аналитика', () => {
  it('принимает пачку событий как text/plain, проверяет имена, комнату и игрока', async () => {
    const { http, srv } = await boot();
    const u = await anon(http);
    const body = {
      d: 'dev-12345678',
      s: 'sess-1234567',
      t: u.token,
      e: [
        { n: 'page_view', p: { page: 'home' } },
        { n: 'room_join', p: { members: 2 }, r: 'ABCD' },
        { n: 'Bad Name', p: {} },
        { n: 'big', p: { x: 'y'.repeat(3000) } },
      ],
    };
    const r = await fetch(`${http}/v1/events`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(r.status).toBe(204);
    const store = srv.store as unknown as { events: { name: string; room: string | null; userId: string | null; props: object }[] };
    expect(store.events.map((e) => e.name)).toEqual(['page_view', 'room_join', 'big']);
    expect(store.events[1].room).toBe('ABCD');
    expect(store.events[0].userId).toBe(u.userId);
    expect(store.events[2].props).toEqual({});
    const bad = await fetch(`${http}/v1/events`, { method: 'POST', body: JSON.stringify({ d: '!', e: [] }) });
    expect(bad.status).toBe(400);
  });
});

describe('игровой сервер: ошибки с телефонов', () => {
  it('пишет ошибку в журнал, считает в метриках, пустое отбрасывает', async () => {
    const logs: { msg: string; f?: Record<string, unknown> }[] = [];
    const srv = new GameServer({ authSecret: SECRET, log: (_lvl, msg, f) => void logs.push({ msg, f }), maxRooms: 3 });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    const body = { m: 'TypeError: x is undefined', k: 'error', f: '/_next/static/chunks/a.js:1:20', s: 'at a\n'.repeat(1000), p: '/r/', b: 'abc1234', ua: 'iPhone', extra: 'drop' };
    const r = await fetch(`${http}/v1/errors`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    expect(r.status).toBe(204);
    const e = logs.find((l) => l.msg === 'client_error')!.f!;
    expect(e).toMatchObject({ msg: 'TypeError: x is undefined', kind: 'error', path: '/r/', build: 'abc1234' });
    expect(String(e.stack).length).toBe(2000);
    expect(e.extra).toBeUndefined();
    expect((await fetch(`${http}/v1/errors`, { method: 'POST', body: JSON.stringify({ k: 'error' }) })).status).toBe(400);
    expect(await (await fetch(`${http}/metrics`)).text()).toContain('game_client_errors_total{instance="blue"} 1');
  });
});

describe('игровой сервер: потолок комнат', () => {
  it('больше MAX_ROOMS — «сервер занят» (503), идущие комнаты живут', async () => {
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, maxRooms: 2 });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    const u = await anon(http);
    await create(http, u.token);
    await create(http, u.token);
    const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: '{}' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'server_busy' });
  });
});

describe('игровой сервер: лобби', () => {
  it('четверо входят, пятый — «комната полна»; готов, имя, настройки, кик, уход режиссёра', async () => {
    const { http, ws } = await boot();
    const users = await Promise.all([0, 1, 2, 3, 4].map(() => anon(http)));
    const { code } = await create(http, users[0].token);
    const ls = users.slice(0, 4).map((u, i) => link(ws, u, code, `Игрок${i}`));
    for (const l of ls) await l.connect();
    const last = () => ls[0].room!;
    await until(() => last().members.filter((m) => m.online).length === 4, 3000, 'четверо на связи');
    expect(last().members.map((m) => m.color)).toEqual([0, 1, 2, 3]);
    expect(last().directorId).toBe(users[0].userId);

    // пятый — не влезает
    const fifth = link(ws, users[4], code, 'Пятый');
    await expect(fifth.connect()).rejects.toThrow('room_full');

    // «Готов» и имя видят все
    ls[1].setReady(true);
    ls[2].rename('  Новое  имя-очень-длинное ');
    await until(() => !!ls[3].room?.members.find((m) => m.userId === users[1].userId)?.ready, 3000, 'готов');
    await until(() => ls[3].room?.members.find((m) => m.userId === users[2].userId)?.name === 'Новое  имя-оче', 3000, 'имя');

    // настройки — только режиссёр
    const errs: string[] = [];
    ls[1].onError((e) => errs.push(e));
    ls[1].updateSettings({ roundSec: 60, maxRounds: 3, kidsMode: true, aiFill: false });
    await until(() => errs.includes('not_director'), 3000, 'отказ не режиссёру');
    ls[0].updateSettings({ roundSec: 90, maxRounds: 7, kidsMode: false, strictCrowd: true, aiFill: false });
    await until(() => ls[2].room?.settings.roundSec === 90, 3000, 'настройки');

    // кик
    let ended = '';
    ls[3].onEnd((why) => (ended = why));
    ls[0].kick(users[3].userId);
    await until(() => ended === 'kicked', 3000, 'кик');
    await until(() => ls[0].room!.members.length === 3, 3000, 'место освободилось');

    // режиссёр ушёл — роль у следующего
    ls[0].leave();
    await until(() => ls[1].room?.directorId === users[1].userId, 3000, 'новый режиссёр');
    expect(ls[1].room!.members.map((m) => m.userId)).toEqual([users[1].userId, users[2].userId]);
  });

  it('часы сервера для оркестра: сдвиг относительно своих часов и настройки оркестра и музыки', async () => {
    const { http, ws } = await boot();
    const [a, b] = await Promise.all([anon(http), anon(http)]);
    const { code } = await create(http, a.token);
    const la = link(ws, a, code, 'А');
    const lb = link(ws, b, code, 'Б');
    await la.connect();
    await lb.connect();
    // сервер и клиенты на одной машине: сдвиг — почти ноль
    const off = await la.serverClock(4);
    expect(off).not.toBeNull();
    expect(Math.abs(off!)).toBeLessThan(50);
    la.updateSettings({ roundSec: 75, maxRounds: 5, kidsMode: false, aiFill: false, roomMusic: 'all', orchestra: true });
    await until(() => !!lb.room?.settings.orchestra && lb.room.settings.roomMusic === 'all', 3000, 'настройки звука дошли');
  });

  it('старт — только режиссёр и только если игроков хватает; пока идёт матч, новый — зритель', async () => {
    const { http, ws } = await boot();
    const [a, b, c] = await Promise.all([anon(http), anon(http), anon(http)]);
    // без ИИ-актёров: нужен второй живой
    const { code } = await create(http, a.token, { name: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } });
    const la = link(ws, a, code, 'A');
    await la.connect();
    const errs: string[] = [];
    la.onError((e) => errs.push(e));
    la.start();
    await until(() => errs.includes('not_enough_players'), 3000, 'мало игроков');
    const lb = link(ws, b, code, 'B');
    await lb.connect();
    const berrs: string[] = [];
    lb.onError((e) => berrs.push(e));
    lb.start();
    await until(() => berrs.includes('not_director'), 3000, 'не режиссёр');
    la.start();
    await until(() => la.room?.status === 'playing', 3000, 'матч начался');
    const lc = link(ws, c, code, 'C');
    await lc.connect();
    expect(lc.spectator).toBe(true);
    const p = (await (await fetch(`${http}/v1/rooms/${code}`)).json()) as { status: string };
    expect(p.status).toBe('playing');
  });

  it('по умолчанию в комнате ИИ-актёры: режиссёр начинает и один', async () => {
    const { http, ws } = await boot();
    const a = await anon(http);
    const { code } = await create(http, a.token);
    const la = link(ws, a, code, 'A');
    await la.connect();
    expect(la.room?.settings.aiFill).toBe(true);
    la.start();
    await until(() => la.room?.status === 'playing', 3000, 'матч начался');
  });
});

describe('игровой сервер: матч', () => {
  it('четверо проходят матч целиком; по сети не узнать, кто живой; обрыв — снимок и игра дальше', async () => {
    const SPEED = 20;
    const { http, ws, srv } = await boot(SPEED);
    const users = await Promise.all([0, 1, 2, 3].map(() => anon(http)));
    const { code } = await create(http, users[0].token, { name: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } });
    const ls = users.map((u, i) => link(ws, u, code, `P${i}`));
    for (const l of ls) await l.connect();
    await until(() => ls[0].room!.members.filter((m) => m.online).length === 4, 3000, 'все на связи');

    // как в браузере: пришёл match_start — создаём сессию гостя на этой же связи
    const clock = () => performance.now() * SPEED;
    const sessions: (RemoteSession | null)[] = [null, null, null, null];
    const roomLog: RoomMsg[] = [];
    const privLog: { to: string; m: { t: string; me?: { eid: number } } }[] = [];
    ls.forEach((l, i) =>
      l.onMessage((ch, m) => {
        const msg = m as RoomMsg;
        if (ch === 'room' && msg.t === 'match_start' && !sessions[i]) {
          sessions[i] = new RemoteSession({ transport: l, selfPid: users[i].userId, hostPid: msg.hostId, players: msg.players, cfg: msg.cfg, clock });
        }
        if (ch === 'room' && i === 1) roomLog.push(msg);
        if (ch === 'private') privLog.push({ to: users[i].userId, m: m as { t: string } });
      }),
    );
    ls[0].start();
    await until(() => sessions.every(Boolean), 3000, 'сессии созданы');
    const gs = sessions as RemoteSession[];

    // «пальцы» и кадры гостей: шаг гостя = 50 мс игрового времени
    const rng = new Rng(3);
    let ticks = 0;
    const t0 = clock();
    let dropped = false;
    const frame = setInterval(() => {
      const due = Math.floor((clock() - t0) / 50);
      while (ticks < due) {
        ticks++;
        for (const g of gs) {
          g.tick();
          const me = g.me();
          if (!me || !me.alive) continue;
          if (g.phase === 'play') {
            if (g.crowdWindowOpen() && me.crowdAnswered !== g.world.crowd!.warnAt && rng.chance(0.2)) g.intent({ k: 'crowd', kind: g.world.crowd!.kind });
            else if (rng.chance(0.03)) g.intent({ k: 'move', x: rng.int(20, 160), y: rng.int(30, 240) });
          }
          if (g.phase === 'play' && !me.alive && me.accused === null && rng.chance(0.05)) {
            const any = g.world.alive().find((e) => e.eid !== me.eid);
            if (any) g.intent({ k: 'accuse', eid: any.eid });
          }
        }
      }
    }, 2);
    try {
      // посреди первого дубля у игрока 2 обрывается связь
      await until(() => gs[2].phase === 'play' && gs[2].world.time > 20_000, 20_000, 'середина дубля');
      const raw = (ls[2] as unknown as { ws: WebSocket }).ws;
      raw.close();
      dropped = true;
      await until(() => ls[2].reconnects === 1, 5000, 'переподключение');
      // после снимка мир игрока 2 снова совпадает с сервером
      await new Promise((r) => setTimeout(r, 300));
      const host = srv.rooms.get(code)!.runner!.host;
      let far = 0;
      let seen = 0;
      const own = gs[2].me()?.eid;
      const lag = host.world.time - gs[2].world.time;
      expect(lag).toBeLessThan(3000);
      for (const e of gs[2].world.entities) {
        if (!e.alive || e.eid === own) continue;
        const h = host.world.get(e.eid);
        if (!h?.alive) continue;
        seen++;
        // мир гостя чуть позади сервера: сравниваем грубо
        if (Math.hypot(h.x - e.x, h.y - e.y) > 30) far++;
      }
      expect(seen).toBeGreaterThan(10);
      expect(far).toBeLessThanOrEqual(3);

      await until(() => gs.every((g) => g.phase === 'match_end'), 60_000, 'конец матча');
    } finally {
      clearInterval(frame);
    }
    expect(dropped).toBe(true);
    const room = srv.rooms.get(code)!;
    expect(room.status).toBe('lobby');
    for (const g of gs) {
      expect(g.match).not.toBeNull();
      expect(g.scores).toEqual(room.runner!.host.scores);
    }

    // правило 2: в общем канале нет id игроков, удар по игроку — без нападавшего
    const ids = users.map((u) => u.userId);
    let twist = false;
    for (const msg of roomLog) {
      if (msg.t === 'ev' || msg.t === 'snap' || msg.t === 'round') {
        const s = JSON.stringify(msg);
        for (const id of ids) expect(s).not.toContain(id);
      }
      if (msg.t === 'ev') {
        for (const ev of msg.ev) {
          if (ev.t === 'twist') twist = ev.on;
          if (ev.t === 'hit' && ev.result === 'player' && !killerExposed(room.runner!.host.sim.theme, twist)) expect(ev.attacker).toBeUndefined();
        }
      }
    }
    // личные сообщения — только про свою сущность (по раундам она своя у каждого)
    const meCount = privLog.filter((p) => p.m.t === 'me').length;
    expect(meCount).toBeGreaterThan(10);
    for (const g of gs) g.dispose();
  }, 90_000);

  it('после конца матча новичок входит, и «Ещё дубль» начинает новый матч уже с ним', async () => {
    const SPEED = 40;
    const { http, ws, srv } = await boot(SPEED);
    const [a, b, c] = await Promise.all([anon(http), anon(http), anon(http)]);
    const { code } = await create(http, a.token, { name: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } });
    const la = link(ws, a, code, 'A');
    const lb = link(ws, b, code, 'B');
    await la.connect();
    await lb.connect();
    const starts: RoomMsg[] = [];
    la.onMessage((ch, m) => {
      if (ch === 'room' && (m as RoomMsg).t === 'match_start') starts.push(m as RoomMsg);
    });
    la.start();
    await until(() => starts.length === 1, 3000, 'старт');
    const room = srv.rooms.get(code)!;
    await until(() => room.runner?.host.phase === 'match_end', 60_000, 'конец матча');
    let r: WireRoom | null = null;
    const lc = link(ws, c, code, 'C');
    r = await lc.connect();
    expect(r.members).toHaveLength(3);
    // режиссёр жмёт «Ещё дубль» — состав поменялся, значит новый матч
    la.send('host', { t: 'i', i: { k: 'rematch' } });
    await until(() => starts.length === 2, 3000, 'новый матч');
    const s2 = starts[1] as Extract<RoomMsg, { t: 'match_start' }>;
    expect(s2.players.map((p) => p.pid).sort()).toEqual([a.userId, b.userId, c.userId].sort());
  }, 90_000);

  it('опоздавший смотрит матч зрителем (только общий канал), после матча занимает место', async () => {
    const { http, ws, srv } = await boot(40);
    const [a, b, c] = await Promise.all([anon(http), anon(http), anon(http)]);
    const { code } = await create(http, a.token, { name: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } });
    const la = link(ws, a, code, 'A');
    const lb = link(ws, b, code, 'B');
    await la.connect();
    await lb.connect();
    la.start();
    const room = srv.rooms.get(code)!;
    await until(() => room.runner?.host.phase === 'play', 5000, 'дубль');
    const lc = link(ws, c, code, 'C');
    const r = await lc.connect();
    expect(lc.spectator).toBe(true);
    expect(r.members.map((m) => m.userId)).not.toContain(c.userId);
    const got: { ch: string; t: string }[] = [];
    lc.onMessage((ch, m) => got.push({ ch, t: (m as { t: string }).t }));
    await until(() => got.some((g) => g.t === 'ev'), 3000, 'трансляция');
    expect(got.every((g) => g.ch === 'room')).toBe(true);
    // зритель не управляет: его намерения сервер не принимает
    lc.send('host', { t: 'i', i: { k: 'move', x: 50, y: 50 } });
    // занять место посреди матча нельзя
    const errs: string[] = [];
    lc.onError((e) => errs.push(e));
    lc.join();
    await until(() => errs.includes('not_now'), 3000, 'не сейчас');
    await until(() => room.status === 'lobby', 60_000, 'конец матча');
    lc.join();
    await until(() => !lc.spectator && !!lc.room?.members.some((m) => m.userId === c.userId), 3000, 'занял место');
    expect(lc.reconnects).toBe(0);
  }, 90_000);
});
