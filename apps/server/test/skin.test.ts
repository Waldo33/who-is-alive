import { afterEach, describe, expect, it } from 'vitest';
import { ServerLink } from '@kto/net';
import type { RoomMsg, ServerMsg } from '@kto/net';
import { silentLogger } from '../src/log';
import { Room } from '../src/room';
import type { Peer } from '../src/room';
import { GameServer } from '../src/server';

/**
 * Скин гардероба в комнате: сервер берёт его из покупок (tg_links → shop_users), а не с телефона;
 * в составе лобби и матча он идёт по игроку — сущность на поле остаётся тайной (netplay.test.ts).
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

function fakePeer() {
  const got: ServerMsg[] = [];
  const peer: Peer & { got: ServerMsg[] } = { got, send: (t) => got.push(JSON.parse(t) as ServerMsg), close: () => {} };
  return peer;
}

async function until(cond: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('скин гардероба', () => {
  it('комната: скин — в составе лобби и в составе матча по игроку', () => {
    const room = new Room({ code: 'SKIN', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false }, lang: 'ru', now: () => 1, log: silentLogger });
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    room.setSkin('b', 'kotBanan');
    room.setSkin('a', null);
    const last = [...pa.got].reverse().find((m) => m.t === 'room') as Extract<ServerMsg, { t: 'room' }>;
    expect(last.room.members.find((m) => m.userId === 'b')?.skin).toBe('kotBanan');
    expect(last.room.members.find((m) => m.userId === 'a')?.skin).toBeUndefined();
    room.setReady('b', true);
    expect(room.start('a')).toBeNull();
    const start = pa.got.find((m) => m.t === 'g' && (m.m as RoomMsg).t === 'match_start') as Extract<ServerMsg, { t: 'g' }>;
    const players = (start.m as Extract<RoomMsg, { t: 'match_start' }>).players;
    expect(players.find((p) => p.pid === 'b')?.skin).toBe('kotBanan');
    expect(players.find((p) => p.pid === 'a')?.skin).toBeUndefined();
    room.close('test');
  });

  it('сервер: скин берётся из покупок связанного Telegram; чужой телефон его не наденет', async () => {
    const srv = new GameServer({ authSecret: SECRET, log: silentLogger });
    servers.push(srv);
    const port = await srv.listen(0, '127.0.0.1');
    const http = `http://127.0.0.1:${port}`;
    const ws = `ws://127.0.0.1:${port}/i/blue/ws`;
    const anon = async () => (await (await fetch(`${http}/v1/auth/anon`, { method: 'POST' })).json()) as { userId: string; token: string };
    const [a, b] = [await anon(), await anon()];
    // у b куплен Кот-банан (как после оплаты в боте), a — без покупок
    await srv.store.linkTelegram({ gameUser: b.userId, tgUser: 777, name: 'B', lang: 'ru' });
    await srv.store.saveShopUser({ userId: 777, lang: 'ru', name: 'B', items: ['starter', 'kotBanan'], pack: null, issued: [] });
    const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A' }) });
    const { code } = (await r.json()) as { code: string };
    const la = new ServerLink({ url: ws, token: a.token, selfId: a.userId, code, name: 'A', silenceMs: 60_000 });
    const lb = new ServerLink({ url: ws, token: b.token, selfId: b.userId, code, name: 'B', silenceMs: 60_000 });
    links.push(la, lb);
    await la.connect();
    await lb.connect();
    await until(() => la.room?.members.find((m) => m.userId === b.userId)?.skin === 'kotBanan', 3000, 'скин b в лобби у a');
    expect(la.room!.members.find((m) => m.userId === a.userId)?.skin).toBeUndefined();
  });
});
