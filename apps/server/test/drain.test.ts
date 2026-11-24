import { afterEach, describe, expect, it } from 'vitest';
import { ServerLink } from '@kto/net';
import type { RoomMsg } from '@kto/net';
import { silentLogger } from '../src/log';
import { GameServer } from '../src/server';

/**
 * Выкладка без обрыва (docs/infra-plan.md › этап 1): синий и зелёный экземпляры на localhost.
 * Старый уходит в drain — лобби переезжают к соседу, матч доигрывается на месте и переезжает после.
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

async function until(cond: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Все, кроме режиссёра, жмут «Готов»; ждём, пока режиссёр это увидит (без этого сервер не стартует). */
async function readyUp(director: ServerLink, others: ServerLink[]): Promise<void> {
  for (const l of others) l.setReady(true);
  await until(() => (director.room?.members.filter((m) => m.ready).length ?? 0) >= others.length, 3000, 'все «Готов»');
}

/** Пара экземпляров, знающих друг друга. */
async function pair(speed = 1, drainMs?: number) {
  const drained: string[] = [];
  const mk = (instance: string) => {
    const s = new GameServer({ authSecret: SECRET, log: silentLogger, speed, instance, drainMs, onDrained: () => drained.push(instance) });
    servers.push(s);
    return s;
  };
  const blue = mk('blue');
  const green = mk('green');
  const bp = await blue.listen(0, '127.0.0.1');
  const gp = await green.listen(0, '127.0.0.1');
  const b = { srv: blue, http: `http://127.0.0.1:${bp}`, ws: `ws://127.0.0.1:${bp}/i/blue/ws` };
  const g = { srv: green, http: `http://127.0.0.1:${gp}`, ws: `ws://127.0.0.1:${gp}/i/green/ws` };
  blue.setPeer({ http: g.http, wsUrl: g.ws });
  green.setPeer({ http: b.http, wsUrl: b.ws });
  return { b, g, drained };
}

async function anon(http: string): Promise<{ userId: string; token: string }> {
  return (await (await fetch(`${http}/v1/auth/anon`, { method: 'POST' })).json()) as { userId: string; token: string };
}

async function create(http: string, token: string, body: object = { name: 'Режиссёр' }): Promise<string> {
  const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { code: string }).code;
}

function link(ws: string, u: { userId: string; token: string }, code: string, name: string): ServerLink {
  const l = new ServerLink({ url: ws, token: u.token, selfId: u.userId, code, name, silenceMs: 60_000 });
  links.push(l);
  return l;
}

const SETTINGS = { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false };

describe('выкладка без обрыва: drain и переезд комнат', () => {
  it('лобби переезжает к соседу: тот же состав, цвета, «Готов», режиссёр, настройки', async () => {
    const { b, g, drained } = await pair();
    const [a, c] = await Promise.all([anon(b.http), anon(b.http)]);
    const code = await create(b.http, a.token, { name: 'Аня', settings: { ...SETTINGS, roundSec: 90 } });
    const la = link(b.ws, a, code, 'Аня');
    const lc = link(b.ws, c, code, 'Костя');
    await la.connect();
    await lc.connect();
    lc.setReady(true);
    await until(() => la.room?.members.find((m) => m.userId === c.userId)?.ready === true, 3000, 'готов');
    const before = la.room!;

    b.srv.drain();
    await until(() => g.srv.rooms.has(code) && la.moves === 1 && lc.moves === 1, 5000, 'переезд');
    await until(() => !!g.srv.rooms.get(code)?.members.get(a.userId)?.peer && !!g.srv.rooms.get(code)?.members.get(c.userId)?.peer, 5000, 'оба на зелёном');
    // рассылка состава после второго входа может прийти чуть позже — ждём, пока режиссёр увидит обоих
    await until(() => !!la.room && la.room.members.length === 2 && la.room.members.every((m) => m.online), 5000, 'режиссёр видит обоих на связи');
    const after = la.room!;
    expect(after.code).toBe(code);
    expect(after.directorId).toBe(a.userId);
    expect(after.settings.roundSec).toBe(90);
    expect(after.members.map((m) => [m.userId, m.name, m.color, m.ready])).toEqual(before.members.map((m) => [m.userId, m.name, m.color, m.ready]));
    expect(after.members.every((m) => m.online)).toBe(true);
    expect(b.srv.rooms.size).toBe(0);
    await until(() => drained.includes('blue'), 3000, 'drain закончен');
    // синий больше не создаёт комнат
    expect((await fetch(`${b.http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: '{}' })).status).toBe(503);
  });

  it('матч доигрывается на старом экземпляре, потом комната переезжает, и «Ещё дубль» идёт на новом', async () => {
    const { b, g } = await pair(40);
    const [a, c] = await Promise.all([anon(b.http), anon(b.http)]);
    const code = await create(b.http, a.token, { name: 'A', settings: SETTINGS });
    const la = link(b.ws, a, code, 'A');
    const lc = link(b.ws, c, code, 'C');
    await la.connect();
    await lc.connect();
    const starts: RoomMsg[] = [];
    la.onMessage((ch, m) => {
      if (ch === 'room' && (m as RoomMsg).t === 'match_start') starts.push(m as RoomMsg);
    });
    await readyUp(la, [lc]);
    la.start();
    await until(() => starts.length === 1, 3000, 'старт');
    const room = b.srv.rooms.get(code)!;
    b.srv.drain();
    // пока идёт матч — никуда не едем
    await new Promise((r) => setTimeout(r, 300));
    expect(b.srv.rooms.has(code)).toBe(true);
    expect(g.srv.rooms.has(code)).toBe(false);
    expect(room.status).toBe('playing');
    let ended = false;
    la.onEnd(() => (ended = true));
    await until(() => g.srv.rooms.has(code) && la.moves === 1, 60_000, 'переезд после матча');
    expect(ended).toBe(false);
    await until(() => !!g.srv.rooms.get(code)?.members.get(a.userId)?.peer, 5000, 'режиссёр на зелёном');
    // «Ещё дубль» на новом экземпляре — новый матч (раннера прошлого матча здесь нет)
    la.send('host', { t: 'i', i: { k: 'rematch' } });
    await until(() => starts.length === 2, 5000, 'новый матч на зелёном');
    expect(g.srv.rooms.get(code)!.status).toBe('playing');
  }, 90_000);

  it('опоздавший по старому адресу получает «переезжай»; /v1/rooms у соседа отдаёт его адрес', async () => {
    const { b, g } = await pair();
    const [a, c] = await Promise.all([anon(b.http), anon(b.http)]);
    const code = await create(b.http, a.token, { name: 'A', settings: SETTINGS });
    const la = link(b.ws, a, code, 'A');
    await la.connect();
    // зелёный не знает комнату, но спрашивает синего
    const info = (await (await fetch(`${g.http}/v1/rooms/${code}`)).json()) as { wsUrl: string; status: string };
    expect(info).toMatchObject({ status: 'lobby', wsUrl: b.ws });
    expect((await fetch(`${g.http}/v1/rooms/ZZZZ`)).status).toBe(404);
    b.srv.drain();
    await until(() => g.srv.rooms.has(code) && !b.srv.rooms.has(code), 5000, 'переезд');
    // второй игрок открыл ссылку раньше и подключается по старому адресу синего
    const lc = link(b.ws, c, code, 'C');
    const r = await lc.connect();
    expect(lc.moves).toBe(1);
    expect(r.members.map((m) => m.userId).sort()).toEqual([a.userId, c.userId].sort());
  });

  it('коды синего и зелёного не пересекаются; срок drain закрывает недоигранное', async () => {
    const { b, g, drained } = await pair(1, 400);
    const u = await anon(b.http);
    const half = 'ABCDEFGHJKMN';
    // комнат на игрока — 5 в минуту: каждую пару создают разные игроки
    for (let i = 0; i < 8; i++) {
      const x = await anon(b.http);
      expect(half).toContain((await create(b.http, x.token)).charAt(0));
      expect(half).not.toContain((await create(g.http, x.token)).charAt(0));
    }
    await create(b.http, u.token);
    // без соседа лобби не уезжают — закрываются по сроку
    b.srv.setPeer(undefined);
    const la = link(b.ws, u, [...b.srv.rooms.keys()][0], 'U');
    await la.connect();
    let why = '';
    la.onEnd((w) => (why = w));
    b.srv.drain();
    await until(() => drained.includes('blue'), 3000, 'срок drain');
    expect(b.srv.rooms.size).toBe(0);
    await until(() => why === 'closed', 2000, 'закрыто');
  });
  it('пустые комнаты при переезде не держат место заново: тестовая закрывается через 15 с, обычная досчитывает свои 10 минут', async () => {
    let t = 1_000_000;
    const KEY = 'k'.repeat(24);
    const mk = (instance: string) => {
      const s = new GameServer({ authSecret: SECRET, log: silentLogger, instance, loadKey: KEY, now: () => t });
      servers.push(s);
      return s;
    };
    const blue = mk('blue');
    const green = mk('green');
    const bh = `http://127.0.0.1:${await blue.listen(0, '127.0.0.1')}`;
    const gh = `http://127.0.0.1:${await green.listen(0, '127.0.0.1')}`;
    blue.setPeer({ http: gh, wsUrl: `${gh.replace('http', 'ws')}/i/green/ws` });
    green.setPeer({ http: bh, wsUrl: `${bh.replace('http', 'ws')}/i/blue/ws` });
    const room = async (load: boolean) => {
      const u = await anon(bh);
      const r = await fetch(`${bh}/v1/rooms`, {
        method: 'POST',
        headers: { authorization: `Bearer ${u.token}`, ...(load ? { 'x-kto-load': KEY } : {}) },
        body: '{}',
      });
      return ((await r.json()) as { code: string }).code;
    };
    const test = await room(true);
    const real = await room(false);
    blue.housekeeping(); // обе пустые с этого момента
    t += 5 * 60_000 - 16_000; // обычная пустует почти 5 минут, первая тестовая уже закрыта; вторую создаём только что
    const test2 = await room(true);
    blue.housekeeping();
    expect(blue.rooms.has(test)).toBe(false);
    expect(blue.rooms.has(test2)).toBe(true);
    await fetch(`${bh}/internal/drain`, { method: 'POST' });
    blue.housekeeping();
    await until(() => green.rooms.has(test2) && green.rooms.has(real), 3000, 'переезд');
    green.housekeeping();
    t += 17_000;
    green.housekeeping();
    expect(green.rooms.has(test2)).toBe(false);
    expect(green.rooms.has(real)).toBe(true);
    t += 5 * 60_000; // обычная: всего чуть больше 10 минут пустоты — закрыта, а не держится ещё 10 после переезда
    green.housekeeping();
    expect(green.rooms.has(real)).toBe(false);
  });
  it('переезд на другой сервер: drain с адресом соседа в теле — лобби Москвы уезжает в Европу', async () => {
    const mk = () => {
      const s = new GameServer({ authSecret: SECRET, log: silentLogger, instance: 'blue' });
      servers.push(s);
      return s;
    };
    const msk = mk();
    const eu = mk();
    const mh = `http://127.0.0.1:${await msk.listen(0, '127.0.0.1')}`;
    const eh = `http://127.0.0.1:${await eu.listen(0, '127.0.0.1')}`;
    const [a, c] = await Promise.all([anon(mh), anon(mh)]);
    const code = await create(mh, a.token, { name: 'Аня', settings: SETTINGS });
    const la = link(`${mh.replace('http', 'ws')}/i/blue/ws`, a, code, 'Аня');
    const lc = link(`${mh.replace('http', 'ws')}/i/blue/ws`, c, code, 'Костя');
    await la.connect();
    await lc.connect();
    // у Европы уже есть своя комната — она остаётся как была
    const other = await create(eh, (await anon(eh)).token, { name: 'Чужой' });
    const r = await fetch(`${mh}/internal/drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: { http: eh, wsUrl: `${eh.replace('http', 'ws')}/ws` } }),
    });
    expect(r.status).toBe(200);
    await until(() => eu.rooms.has(code) && la.moves === 1 && lc.moves === 1, 5000, 'переезд в Европу');
    await until(() => !!la.room && la.room.members.length === 2 && la.room.members.every((m) => m.online), 5000, 'оба на связи в Европе');
    expect(la.room!.directorId).toBe(a.userId);
    expect(msk.rooms.size).toBe(0);
    expect(eu.rooms.has(other)).toBe(true);
    // по старому адресу Москвы опоздавший тоже попадает в Европу
    const info = (await (await fetch(`${mh}/v1/rooms/${code}`)).json()) as { wsUrl: string };
    expect(info.wsUrl).toBe(`${eh.replace('http', 'ws')}/ws`);
  });

  it('чужая комната с тем же кодом у соседа: не переезжаем, доживаем на месте', async () => {
    const mk = () => {
      const s = new GameServer({ authSecret: SECRET, log: silentLogger, instance: 'blue', drainMs: 60_000 });
      servers.push(s);
      return s;
    };
    const msk = mk();
    const eu = mk();
    const mh = `http://127.0.0.1:${await msk.listen(0, '127.0.0.1')}`;
    const eh = `http://127.0.0.1:${await eu.listen(0, '127.0.0.1')}`;
    const a = await anon(mh);
    const code = await create(mh, a.token, { name: 'A' });
    // подделываем занятый код у соседа: снимок той же комнаты с другим режиссёром
    const snap = { ...msk.rooms.get(code)!.snapshot(), directorId: 'someone-else' };
    expect((await fetch(`${eh}/internal/import`, { method: 'POST', body: JSON.stringify(snap) })).status).toBe(204);
    const la = link(`${mh.replace('http', 'ws')}/i/blue/ws`, a, code, 'A');
    await la.connect();
    await fetch(`${mh}/internal/drain`, { method: 'POST', body: JSON.stringify({ peer: { http: eh, wsUrl: 'wss://eu.example/ws' } }) });
    await new Promise((r) => setTimeout(r, 500));
    expect(msk.rooms.has(code)).toBe(true);
    expect(la.moves).toBe(0);
  });
});
