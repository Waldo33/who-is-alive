import { describe, expect, it } from 'vitest';
import { hasSanity } from '@kto/game-core';
import type { ServerMsg } from '@kto/net';
import { MsgBudget, RateWindow } from '../src/limits';
import { silentLogger } from '../src/log';
import { BOT_AFTER_MS, HOLD_MS, Room, cleanName } from '../src/room';
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

  it('ушедшего посреди матча подменяет ИИ: очки за местом, вернулся — управление снова его', () => {
    const { room, advance } = makeRoom();
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    room.setReady('b', true);
    expect(room.start('a')).toBeNull();
    const h = room.runner!.host;
    for (let i = 0; i < 100; i++) room.runner!.step();
    expect(h.phase).toBe('play');
    h.sim.scores.b = 3;
    // обрыв связи: ИИ — не сразу
    room.disconnected('b', pb);
    advance(BOT_AFTER_MS - 1000);
    room.housekeeping();
    expect(h.sim.info('b')!.ai).toBeFalsy();
    advance(2000);
    room.housekeeping();
    expect(h.sim.info('b')!.ai).toBe(true);
    expect(h.sim.agents.some((x) => x.pid === 'b')).toBe(true);
    // всем ушёл новый состав (без сущностей)
    const pl = pa.got.filter((m) => m.t === 'g' && (m.m as { t: string }).t === 'players');
    expect(pl.length).toBe(1);
    expect(JSON.stringify(pl[0])).not.toContain('eid');
    for (let i = 0; i < 200; i++) room.runner!.step();
    expect(h.sim.scores.b).toBeGreaterThanOrEqual(3);
    // вернулся — снова человек
    room.join('b', 'B', fakePeer());
    expect(h.sim.info('b')!.ai).toBeFalsy();
    expect(h.sim.agents.some((x) => x.pid === 'b')).toBe(false);
    // ушёл сам («Назад») — ИИ сразу
    room.leave('b');
    expect(h.sim.info('b')!.ai).toBe(true);
    room.close('test');
  });

  it('новичок по ссылке посреди матча занимает место ИИ: очки и персонаж — от места', () => {
    const now = 1_000_000;
    // первая тема матча случайна (зерно комнаты); «Купальская ночь» — матч в один дубль, а тесту нужен второй:
    // такую комнату пересоздаём
    let room: Room;
    for (;;) {
      room = new Room({ code: 'ABCD', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: true }, lang: 'ru', now: () => now, log: silentLogger });
      room.join('a', 'A', fakePeer());
      expect(room.start('a')).toBeNull();
      if (!hasSanity(room.runner!.host.sim.theme)) break;
      room.close('test');
    }
    const h = room.runner!.host;
    expect(h.aiSeats().length).toBe(3);
    for (let i = 0; i < 100; i++) room.runner!.step();
    h.sim.scores['ai-1'] = 4;
    h.sim.scores['ai-2'] = 2;
    const eid1 = h.sim.playerRound('ai-1')!.eid;
    // старый клиент (без seat) — по-прежнему зритель
    expect(room.join('old', 'Old', fakePeer())).toBeNull();
    expect(room.spectators.has('old')).toBe(true);
    // ИИ-1 вырезан в этом дубле — новичок сядет на живого
    h.sim.playerRound('ai-1')!.alive = false;
    const pc = fakePeer();
    expect(room.join('c', 'Вася', pc, { seat: true })).toBeNull();
    expect(room.members.has('c')).toBe(true);
    expect(room.spectators.has('c')).toBe(false);
    const w = pc.got.find((m) => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(w.spectator).toBeFalsy();
    const seat = h.sim.info('c')!;
    expect(seat.name).toBe('Вася');
    expect(seat.ai).toBeFalsy();
    expect(h.sim.info('ai-2')).toBeUndefined();
    expect(h.sim.scores.c).toBe(2);
    expect(h.sim.playerRound('c')!.alive).toBe(true);
    expect(room.members.get('c')!.color).toBe(seat.color);
    // гость сам просит снимок — получает своего персонажа
    room.game('c', { t: 'resync' });
    const rs = pc.got.map((m) => (m.t === 'g' ? (m.m as { t: string; me?: { eid: number }; players?: { pid: string }[] }) : null)).find((m) => m?.t === 'resync');
    expect(rs?.players?.some((p) => p.pid === 'c')).toBe(true);
    // второй новичок — на место вырезанного ИИ: до конца дубля за кадром
    h.sim.playerRound('ai-3')!.alive = false;
    const pd = fakePeer();
    expect(room.join('d', 'Петя', pd, { seat: true })).toBeNull();
    const d = h.sim.playerRound('d')!;
    expect([eid1, h.sim.playerRound('d')!.eid]).toContain(d.eid);
    expect(d.alive).toBe(false);
    // играть дальше: следующий дубль — живые
    for (let i = 0; i < 6000 && h.round === 1; i++) room.runner!.step();
    expect(h.sim.playerRound('d')!.alive).toBe(true);
    room.close('test');
  });

  it('место ушедшего ждёт его 75 с, потом его занимает зритель; ушедший сам — сразу', () => {
    const { room, advance } = makeRoom();
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    room.setReady('b', true);
    room.start('a');
    const h = room.runner!.host;
    for (let i = 0; i < 100; i++) room.runner!.step();
    room.disconnected('b', pb);
    advance(BOT_AFTER_MS + 1000);
    room.housekeeping();
    const pc = fakePeer();
    expect(room.join('c', 'C', pc, { seat: true })).toBeNull();
    expect(room.spectators.has('c')).toBe(true);
    advance(HOLD_MS);
    room.housekeeping();
    expect(room.members.has('c')).toBe(true);
    expect(room.members.has('b')).toBe(false);
    expect(h.sim.info('c')).toBeTruthy();
    expect(h.sim.info('b')).toBeUndefined();
    // а теперь ушёл сам — зритель садится сразу
    const pe = fakePeer();
    room.join('e', 'E', pe, { seat: true });
    expect(room.spectators.has('e')).toBe(true);
    room.leave('a');
    expect(h.sim.info('e')).toBeTruthy();
    expect(room.directorId).not.toBe('a');
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
    // N6: невидимые и «переворачивающие» символы не проходят, эмодзи с ZWJ — проходят
    expect(cleanName('Оля\u202Eрогом\u200B', 'X')).toBe('Олярогом');
    expect(cleanName('\u200B\u2066', 'Player')).toBe('Player');
    expect(cleanName('Я👨\u200D👩', 'X')).toBe('Я👨\u200D👩');
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
      warm: () => {},
      // клип выбывшего заранее (в ночи игроки гибнут и без ударов) здесь не нужен
      preclip: () => null,
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
      onFilm: (r, f) => toChat.push({ code: r.code, ...f }),
      onCard: (_r, c) => cards.push(c),
    });
    const cards: import('../src/room').RoomCard[] = [];
    // комнату собрала карточка из Telegram — готовый фильм уйдёт и в тот чат
    const toChat: { code: string; id: string; winners: string[]; draw: boolean; awards: { id: string; names: string[] }[] }[] = [];
    room.invite = 'AbCd1234xyz9';
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
    const names = room.runner!.host.match!.winners.map((pid) => ({ a: 'A', b: 'B' })[pid]);
    expect(toChat).toMatchObject([{ code: 'FILM', id: 'f'.repeat(20), winners: names, draw: names.length > 1 }]);
    // награды — с именами, а не pid
    for (const a of toChat[0].awards) for (const n of a.names) expect(['A', 'B']).toContain(n);
    // карточка в чате: сбор 1 → 2 из 4 («Готов» её не трогает), потом съёмка со счётом по дублям
    expect(cards[0]).toEqual({ state: 'lobby', seats: [{ name: 'A', color: 0 }], max: 4 });
    expect(cards[1]).toEqual({ state: 'lobby', seats: [{ name: 'A', color: 0 }, { name: 'B', color: 1 }], max: 4 });
    expect(cards[2]).toMatchObject({ state: 'playing', take: 1, target: 8 });
    const plays = cards.filter((c) => c.state === 'playing');
    const last = plays.at(-1) as Extract<import('../src/room').RoomCard, { state: 'playing' }>;
    const scores = room.runner!.host.match!.scores;
    expect(last.scores.map((x) => x.score).sort()).toEqual(Object.values(scores).sort());
    // после конца матча сбор не возвращается (карточку занимает фильм), закрытие — без «отменили»
    const before = cards.length;
    expect(cards.every((c) => c.state !== 'lobby' || cards.indexOf(c) < 2)).toBe(true);
    room.close('test');
    expect(cards.length).toBe(before);
  });

  it('лобби по карточке закрылось без матча — карточке «съёмку отменили»; без приглашения — молчим', () => {
    const cards: import('../src/room').RoomCard[] = [];
    const mk = (invite?: string) => {
      const r = new Room({ code: 'CARD', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false }, lang: 'ru', now: () => 1, log: silentLogger, onCard: (_r, c) => cards.push(c) });
      r.invite = invite;
      return r;
    };
    const plain = mk();
    plain.join('a', 'A', fakePeer());
    plain.close('test');
    expect(cards).toEqual([]);
    const room = mk('AbCd1234xyz9');
    room.join('a', 'A', fakePeer());
    room.close('empty');
    expect(cards.map((c) => c.state)).toEqual(['lobby', 'closed']);
  });
});

describe('клип выбывшего на сервере (комната)', () => {
  it('сервер с монтажом объявляет caps clip; живому и вне матча — отказ, телефон пишет сам', () => {
    let now = 1_000_000;
    const asked: unknown[] = [];
    const film = { clip: (j: unknown) => (asked.push(j), null), preclip: () => null, warm: () => {} } as unknown as NonNullable<ConstructorParameters<typeof Room>[0]['film']>;
    const room = new Room({ code: 'ABCD', directorId: 'a', directorName: 'A', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false }, lang: 'ru', now: () => now, log: silentLogger, film });
    const [pa, pb] = [fakePeer(), fakePeer()];
    room.join('a', 'A', pa);
    room.join('b', 'B', pb);
    const w = pa.got.find((m) => m.t === 'welcome');
    expect(w?.t === 'welcome' && w.caps).toEqual(['clip']);
    room.clip('a', { n: 1, round: 1, lang: 'ru', mild: false });
    expect(pa.got.at(-1)).toEqual({ t: 'clip', n: 1, state: 'failed' });
    room.setReady('b', true);
    expect(room.start('a')).toBeNull();
    now += 10_000;
    room.runner!.pump();
    room.clip('a', { n: 2, round: room.runner!.host.round, lang: 'ru', mild: false });
    expect(pa.got.at(-1)).toEqual({ t: 'clip', n: 2, state: 'failed' });
    // никого не выбили — до монтажа дело не дошло
    expect(asked.length).toBe(0);
    // без монтажа на сервере caps нет: старый путь
    const plain = makeRoom().room;
    const pc = fakePeer();
    plain.join('c', 'C', pc);
    const w2 = pc.got.find((m) => m.t === 'welcome');
    expect(w2?.t === 'welcome' && w2.caps).toBeUndefined();
  });
});
