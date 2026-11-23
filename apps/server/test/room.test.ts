import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '@kto/net';
import { MsgBudget, RateWindow } from '../src/limits';
import { silentLogger } from '../src/log';
import { HOLD_MS, Room, cleanName } from '../src/room';
import type { Peer } from '../src/room';
import { GameServer } from '../src/server';

/** Комната без сети: заглушки соединений и ручные часы. */
function fakePeer() {
  const got: ServerMsg[] = [];
  const peer: Peer & { got: ServerMsg[]; closed: string } = {
    got,
    closed: '',
    send: (t) => got.push(JSON.parse(t) as ServerMsg),
    close: (_c, r) => (peer.closed = r ?? 'closed'),
  };
  return peer;
}

function makeRoom() {
  let now = 1_000_000;
  const room = new Room({ code: 'ABCD', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false }, lang: 'ru', now: () => now, log: silentLogger });
  return { room, advance: (ms: number) => (now += ms) };
}

describe('комната', () => {
  it('отключившийся держит место 75 с, потом место свободно; режиссёр в лобби не теряет роль сразу', () => {
    const { room, advance } = makeRoom();
    const pa = fakePeer();
    const pb = fakePeer();
    expect(room.join('a', 'A', pa)).toBeNull();
    expect(room.join('b', 'B', pb)).toBeNull();
    room.disconnected('b', pb);
    advance(HOLD_MS - 1000);
    room.housekeeping();
    expect(room.members.has('b')).toBe(true);
    // вернулся вовремя — то же место и цвет
    const pb2 = fakePeer();
    expect(room.join('b', 'B', pb2)).toBeNull();
    expect(room.members.get('b')!.color).toBe(1);
    room.disconnected('b', pb2);
    advance(HOLD_MS + 1000);
    room.housekeeping();
    expect(room.members.has('b')).toBe(false);
    // режиссёр ушёл в мессенджер позвать друзей — роль не теряет, пока никого нет
    room.disconnected('a', pa);
    advance(HOLD_MS * 3);
    room.housekeeping();
    expect(room.directorId).toBe('a');
  });

  it('во время матча пропавший режиссёр через 10 с передаёт роль; перезаход в матч разрешён, новичок — зритель', () => {
    const { room, advance } = makeRoom();
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    room.setReady('b', true);
    expect(room.start('a')).toBeNull();
    expect(room.status).toBe('playing');
    room.disconnected('a', pa);
    advance(5000);
    room.housekeeping();
    expect(room.directorId).toBe('a');
    advance(6000);
    room.housekeeping();
    expect(room.directorId).toBe('b');
    expect(room.runner!.host.sim.hostPid).toBe('b');
    expect(room.join('c', 'C', fakePeer())).toBeNull();
    expect(room.spectators.has('c')).toBe(true);
    expect(room.members.has('c')).toBe(false);
    expect(room.join('a', 'A', fakePeer())).toBeNull();
    room.close('test');
  });

  it('второе соединение того же игрока вытесняет первое', () => {
    const { room } = makeRoom();
    const p1 = fakePeer();
    const p2 = fakePeer();
    room.join('a', 'A', p1);
    room.join('a', 'A', p2);
    expect(p1.closed).toBe('replaced');
    // старое соединение закрылось позже нового — игрок остаётся на связи
    room.disconnected('a', p1);
    expect(room.members.get('a')!.peer).toBe(p2);
  });

  it('имя: без управляющих символов, до 14 знаков, пустое — запасное', () => {
    expect(cleanName('  Вася\u0000\u0007 ', 'X')).toBe('Вася');
    expect(cleanName('   ', 'Player')).toBe('Player');
    expect(cleanName('абвгдеёжзийклмноп', 'X')).toHaveLength(14);
  });
});

describe('лимиты', () => {
  it('окно частоты и бюджет сообщений', () => {
    const w = new RateWindow(2, 60_000);
    expect(w.take('ip', 0)).toBe(true);
    expect(w.take('ip', 1)).toBe(true);
    expect(w.take('ip', 2)).toBe(false);
    expect(w.take('ip', 60_001)).toBe(true);
    const b = new MsgBudget(30);
    let ok = 0;
    for (let i = 0; i < 40; i++) if (b.take(5000)) ok++;
    expect(ok).toBe(30);
    expect(b.strikes).toBe(1);
  });

  it('сервер закрывает пустые и заброшенные комнаты', async () => {
    let now = 0;
    const srv = new GameServer({ authSecret: 'x'.repeat(32), log: silentLogger, now: () => now });
    const port = await srv.listen(0, '127.0.0.1');
    const http = `http://127.0.0.1:${port}`;
    const u = (await (await fetch(`${http}/v1/auth/anon`, { method: 'POST' })).json()) as { token: string };
    const r = await fetch(`${http}/v1/rooms`, { method: 'POST', headers: { authorization: `Bearer ${u.token}` }, body: '{}' });
    const { code } = (await r.json()) as { code: string };
    srv.housekeeping();
    expect(srv.rooms.has(code)).toBe(true);
    // создатель так и не подключился: через 10 минут комнаты нет
    now += 11 * 60_000;
    srv.housekeeping();
    expect(srv.rooms.has(code)).toBe(false);
    await srv.close();
  });
});

describe('фильм матча в комнате', () => {
  it('монтаж ставится на разоблачении последнего дубля, готовый фильм приходит всем на конце матча', async () => {
    let now = 1_000_000;
    const jobs: { takes: unknown[]; match: { winners: string[] } }[] = [];
    const film = {
      make: (job: (typeof jobs)[number]) => {
        jobs.push(job);
        return Promise.resolve({ id: 'f'.repeat(20), ext: 'mp4' as const, thumb: true, ms: 1 });
      },
    };
    const room = new Room({
      code: 'FILM',
      directorId: 'a',
      directorName: 'A',
      settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false },
      lang: 'ru',
      now: () => now,
      log: silentLogger,
      speed: 50,
      film: film as unknown as import('../src/film').FilmService,
    });
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    room.setReady('b', true);
    expect(room.start('a')).toBeNull();
    let jobAt = '';
    for (let i = 0; i < 20000 && room.runner?.host.phase !== 'match_end'; i++) {
      now += 50;
      room.pump();
      // на поле играют боты-заглушки: игроки стоят, дубль кончается по времени
      if (jobs.length && !jobAt) jobAt = room.runner!.host.phase;
      await Promise.resolve();
    }
    expect(room.runner!.host.phase).toBe('match_end');
    // монтаж начался заранее — на разоблачении, а не на конце матча
    expect(jobAt).toBe('reveal');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].takes.length).toBe(room.runner!.host.roundsPlayed);
    expect(jobs[0].match.winners).toEqual(room.runner!.host.match!.winners);
    await new Promise((r) => setTimeout(r, 0));
    for (const p of [pa, pb]) {
      const f = p.got.filter((m) => m.t === 'film');
      expect(f.at(-1)).toEqual({ t: 'film', state: 'ready', id: 'f'.repeat(20), ext: 'mp4', thumb: true });
    }
  });
});
