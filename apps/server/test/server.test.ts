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

/** Все, кроме режиссёра, жмут «Готов»; ждём, пока режиссёр это увидит (без этого сервер не стартует). */
async function readyUp(director: ServerLink, others: ServerLink[]): Promise<void> {
  for (const l of others) l.setReady(true);
  await until(() => (director.room?.members.filter((m) => m.ready).length ?? 0) >= others.length, 3000, 'все «Готов»');
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

describe('игровой сервер: приглашение из Telegram', () => {
  it('по одной метке все попадают в одну комнату; комната закрылась — первый создаёт новую', async () => {
    const { srv, http } = await boot();
    const a = await anon(http);
    const b = await anon(http);
    const first = await create(http, a.token, { name: 'Аня', invite: 'AbCd1234xyz9' });
    const second = await create(http, b.token, { name: 'Боря', invite: 'AbCd1234xyz9' });
    expect(second.code).toBe(first.code);
    expect(srv.rooms.get(first.code)!.directorId).toBe(a.userId);
    // другая метка и без метки — свои комнаты
    expect((await create(http, b.token, { invite: 'Other5678abc' })).code).not.toBe(first.code);
    expect((await create(http, b.token)).code).not.toBe(first.code);
    // кривая метка — как без неё
    expect((await create(http, a.token, { invite: '../x' })).code).not.toBe(first.code);
    // метка переезжает вместе с лобби (выкладка без обрыва)
    expect(srv.rooms.get(first.code)!.snapshot().invite).toBe('AbCd1234xyz9');
    srv.rooms.get(first.code)!.members.clear();
    srv.housekeeping();
    expect(srv.rooms.has(first.code)).toBe(false);
    const again = await create(http, b.token, { invite: 'AbCd1234xyz9' });
    expect(srv.rooms.get(again.code)!.directorId).toBe(b.userId);
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

describe('игровой сервер: замер доступности', () => {
  it('/v1/probe отвечает регионом и отдаёт ?kb= случайных байт', async () => {
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, region: 'msk' });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    expect(await (await fetch(`${http}/v1/probe`)).json()).toMatchObject({ ok: true, region: 'msk' });
    const big = await fetch(`${http}/v1/probe?kb=64`);
    expect((await big.arrayBuffer()).byteLength).toBe(64 * 1024);
    expect((await (await fetch(`${http}/v1/probe?kb=9999`)).arrayBuffer()).byteLength).toBe(64 * 1024);
  });

  it('net_probe получает страну; сервер в Нидерландах пересылает события в Москву', async () => {
    const geo = { country: (ip: string) => (ip === '5.6.7.8' ? 'NL' : 'RU') };
    const msk = new GameServer({ authSecret: SECRET, log: silentLogger, trustProxy: true, geo, region: 'msk' });
    servers.push(msk);
    const mskHttp = `http://127.0.0.1:${await msk.listen(0, '127.0.0.1')}`;
    const nl = new GameServer({ authSecret: SECRET, log: silentLogger, trustProxy: true, geo, region: 'nl', eventsUpstream: mskHttp });
    servers.push(nl);
    const nlHttp = `http://127.0.0.1:${await nl.listen(0, '127.0.0.1')}`;
    const body = (n: string, cc?: string) => JSON.stringify({ d: 'dev-12345678', s: 'sess-1234567', e: [{ n, p: { msk_http: 0, ...(cc ? { cc } : {}) } }] });
    // напрямую в Москву, клиент пытается подсунуть страну — сервер ставит свою
    let r = await fetch(`${mskHttp}/v1/events`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: body('net_probe', 'XX') });
    expect(r.status).toBe(204);
    // через Нидерланды: страна — по адресу у Нидерландов, Москва её сохраняет
    r = await fetch(`${nlHttp}/v1/events`, { method: 'POST', headers: { 'x-forwarded-for': '5.6.7.8' }, body: body('net_probe') });
    expect(r.status).toBe(204);
    const store = msk.store as unknown as { events: { name: string; props: Record<string, unknown> }[] };
    expect(store.events.map((e) => [e.props.cc, e.props.via])).toEqual([
      ['RU', 'msk'],
      ['NL', 'nl'],
    ]);
    expect((nl.store as unknown as { events: unknown[] }).events).toHaveLength(0);
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

describe('игровой сервер: комнаты нагрузочного прогона', () => {
  it('пустая тестовая комната закрывается через 15 секунд, обычная держится 10 минут', async () => {
    let t = 1_000_000;
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, loadKey: 'k'.repeat(24), now: () => t });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    const mk = async (load: boolean) => {
      const u = (await (await fetch(`${http}/v1/auth/anon`, { method: 'POST' })).json()) as { token: string };
      const r = await fetch(`${http}/v1/rooms`, {
        method: 'POST',
        headers: { authorization: `Bearer ${u.token}`, ...(load ? { 'x-kto-load': 'k'.repeat(24) } : {}) },
        body: '{}',
      });
      return ((await r.json()) as { code: string }).code;
    };
    const test = await mk(true);
    const real = await mk(false);
    srv.housekeeping();
    t += 16_000;
    srv.housekeeping();
    expect(srv.rooms.has(test)).toBe(false);
    expect(srv.rooms.has(real)).toBe(true);
    t += 10 * 60_000;
    srv.housekeeping();
    expect(srv.rooms.has(real)).toBe(false);
  });
});

describe('игровой сервер: метрики', () => {
  it('изнутри машины — и напрямую, и через внутренний вход Caddy; с внешним адресом — 404', async () => {
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, trustProxy: true });
    servers.push(srv);
    const http = `http://127.0.0.1:${await srv.listen(0, '127.0.0.1')}`;
    expect((await fetch(`${http}/metrics`)).status).toBe(200);
    // внутренний вход Caddy (127.0.0.1:8080) ставит X-Forwarded-For с адресом клиента — 127.0.0.1
    const viaFront = await fetch(`${http}/metrics`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
    expect(viaFront.status).toBe(200);
    expect(await viaFront.text()).toContain('game_rooms{');
    expect((await fetch(`${http}/metrics`, { headers: { 'x-forwarded-for': '203.0.113.5' } })).status).toBe(404);
  });
});

describe('игровой сервер: лимиты по игроку, а не по адресу', () => {
  it('один игрок — не больше 5 комнат в минуту; другие с того же адреса создают свободно', async () => {
    const { http } = await boot();
    const a = await anon(http);
    for (let i = 0; i < 5; i++) await create(http, a.token);
    const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: '{}' });
    expect(r.status).toBe(429);
    // соседи по мобильному оператору (тот же адрес) не страдают
    for (let i = 0; i < 12; i++) await create(http, (await anon(http)).token);
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
    // B ещё не нажал «Готов» — рано
    la.start();
    await until(() => errs.includes('not_ready'), 3000, 'не все готовы');
    await readyUp(la, [lb]);
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
    await readyUp(ls[0], ls.slice(1));
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
    await readyUp(la, [lb]);
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
    await readyUp(la, [lb]);
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

describe('игровой сервер: место ИИ посреди матча', () => {
  it('новичок по ссылке садится на место ИИ и играет по снимку; ушёл — снова ИИ', async () => {
    const { http, ws, srv } = await boot(4);
    const [a, c] = await Promise.all([anon(http), anon(http)]);
    const { code } = await create(http, a.token, { name: 'A' });
    const la = link(ws, a, code, 'A');
    await la.connect();
    la.start();
    const room = srv.rooms.get(code)!;
    await until(() => room.runner?.host.phase === 'play', 8000, 'дубль');
    const names: string[][] = [];
    la.onMessage((_ch, m) => {
      const x = m as { t: string; players?: { name: string }[] };
      if (x.t === 'players') names.push(x.players!.map((p) => p.name));
    });
    const lc = new ServerLink({ url: ws, token: c.token, selfId: c.userId, code, name: 'Вася', silenceMs: 60_000, seat: true });
    links.push(lc);
    const r = await lc.connect();
    expect(lc.spectator).toBe(false);
    expect(r.status).toBe('playing');
    expect(r.members.map((m) => m.userId)).toContain(c.userId);
    const s = new RemoteSession({ transport: lc, selfPid: c.userId, hostPid: r.directorId, players: [], cfg: {}, resync: true });
    try {
      await until(() => !!s.info(c.userId) && !!s.me(), 3000, 'снимок с местом');
      expect(s.info(c.userId)!.name).toBe('Вася');
      await until(() => names.some((n) => n.includes('Вася')), 3000, 'остальным — новый состав');
      lc.leave();
      await until(() => !!room.runner?.host.sim.info(c.userId)?.ai, 3000, 'ИИ вместо ушедшего');
    } finally {
      s.dispose();
    }
  }, 30_000);
});

describe('игровой сервер: адрес WebSocket по входу', () => {
  it('свой вход из списка — wss://<тот же хост>, чужой — основной адрес', async () => {
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger, publicWsBase: 'wss://api.example', publicWsHosts: ['api.example', '1-2-3-4.sslip.io'] });
    servers.push(srv);
    const port = await srv.listen(0, '127.0.0.1');
    const { request } = await import('node:http');
    const post = (host: string, path: string, body: string, auth?: string) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((ok, bad) => {
        const rq = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host, 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) } }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => ok({ status: res.statusCode ?? 0, json: d ? (JSON.parse(d) as Record<string, unknown>) : {} }));
        });
        rq.on('error', bad);
        rq.end(body);
      });
    const { json: u } = await post('1-2-3-4.sslip.io', '/v1/auth/anon', '');
    const viaAlt = await post('1-2-3-4.sslip.io', '/v1/rooms', '{}', u.token as string);
    expect(viaAlt.json.wsUrl).toBe('wss://1-2-3-4.sslip.io/i/blue/ws');
    const viaOther = await post('evil.example', '/v1/rooms', '{}', u.token as string);
    expect(viaOther.json.wsUrl).toBe('wss://api.example/i/blue/ws');
  });
});


describe('игровой сервер: клип выбывшего', () => {
  it('по WebSocket: caps clip, выбитый получает готовый клип по ссылке; без монтажа — null сразу', async () => {
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return;
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ClipStore } = await import('../src/clips');
    const { FilmService } = await import('../src/film');
    const dir = mkdtempSync(join(tmpdir(), 'clip-ws-'));
    try {
      const store = new ClipStore(dir);
      const film = new FilmService({ store, site: 'benobody.app', fonts: join(__dirname, '../../web/assets/og'), log: () => {} });
      const srv = new GameServer({ authSecret: SECRET, log: silentLogger, film, clips: store });
      servers.push(srv);
      const port = await srv.listen(0, '127.0.0.1');
      const http = `http://127.0.0.1:${port}`;
      const ws = `ws://127.0.0.1:${port}/i/blue/ws`;
      const [a, b] = await Promise.all([anon(http), anon(http)]);
      const { code } = await create(http, a.token, { name: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } });
      const [la, lb] = [link(ws, a, code, 'A'), link(ws, b, code, 'B')];
      await la.connect();
      await lb.connect();
      expect(lb.caps).toEqual(['clip']);
      await readyUp(la, [lb]);
      la.start();
      const room = srv.rooms.get(code)!;
      await until(() => room.runner?.host.phase === 'play', 15_000, 'дубль начался');
      const h = room.runner!.host;
      const eb = h.sim.playerRound(b.userId)!.eid;
      const A = h.world.get(h.sim.playerRound(a.userId)!.eid)!;
      const B = h.world.get(eb)!;
      await new Promise((r) => setTimeout(r, 1500));
      A.x = B.x + 4;
      A.y = B.y;
      h.sim.intent(a.userId, { k: 'attack', eid: eb });
      await until(() => !h.sim.playerRound(b.userId)!.alive, 2000, 'b выбит');
      await new Promise((r) => setTimeout(r, 1700));
      let eta = 0;
      const c = await lb.deathClip(h.round, 'ru', false, (ms) => (eta = ms));
      expect(eta).toBeGreaterThan(0);
      expect(c).not.toBeNull();
      const r = await fetch(`${http}/v1/clips/${c!.id}.${c!.ext}`);
      expect(r.status).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
      // живой просит — отказ (сервер сам решает, чей клип)
      expect(await la.deathClip(h.round, 'ru', false)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // сервер без монтажа: caps нет — телефон пишет сам, не спрашивая
    const { http, ws } = await boot();
    const u = await anon(http);
    const { code } = await create(http, u.token);
    const l = link(ws, u, code, 'U');
    await l.connect();
    expect(l.caps).toEqual([]);
    expect(await l.deathClip(1, 'ru', false)).toBeNull();
  }, 120_000);
});

describe('игровой сервер: аварийный выключатель видео', () => {
  it('файл video-off — телефоны узнают сразу (flags и /v1/flags), клипа на сервере нет; убрали — вернулось', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { VideoSwitch } = await import('../src/video-switch');
    const dir = mkdtempSync(join(tmpdir(), 'video-'));
    const file = join(dir, 'video-off');
    try {
      const srv = new GameServer({ authSecret: SECRET, log: silentLogger, video: new VideoSwitch(file, 0) });
      servers.push(srv);
      const port = await srv.listen(0, '127.0.0.1');
      const http = `http://127.0.0.1:${port}`;
      const ws = `ws://127.0.0.1:${port}/i/blue/ws`;
      expect(await (await fetch(`${http}/v1/flags`)).json()).toEqual({ video: true });
      const u = await anon(http);
      const { code } = await create(http, u.token);
      const l = link(ws, u, code, 'U');
      const seen: boolean[] = [];
      l.onFlags((f) => seen.push(f.video));
      await l.connect();
      await until(() => seen.length > 0, 2000, 'flags после входа');
      expect(l.video).toBe(true);
      writeFileSync(file, 'x');
      await until(() => l.video === false, 3000, 'видео выключено');
      expect(await (await fetch(`${http}/v1/flags`)).json()).toEqual({ video: false });
      expect(await l.deathClip(1, 'ru', false)).toBeNull();
      rmSync(file);
      await until(() => l.video === true, 3000, 'видео вернулось');
      expect(seen).toEqual([true, false, true]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
