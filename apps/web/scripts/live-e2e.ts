/**
 * Живой сквозной прогон через настоящий Supabase: хост и два гостя (три анонимных игрока)
 * создают комнату настоящим классом Room, хост запускает матч, все играют один раунд.
 * Проверяет права каналов, задержку, совпадение мира у гостей с хостом и доставку намерений.
 *
 * Сборка и запуск (нужна сеть до Supabase):
 *   pnpm --filter web live-e2e
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Rng } from '@kto/game-core';
import type { ClientSession } from '@kto/game-core';
import { HostSession, RemoteSession } from '@kto/net';
import { Room, createRoom } from '../src/net/room';

const URL = process.env.SUPABASE_URL || 'https://wivildtgfkpuxvqoamqg.supabase.co';
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_H7jmJUYfYmVIPXF15mr1gQ_PYNXmtdN';
const PLAY_SEC = Number(process.env.PLAY_SEC || 40);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = detail ?? ok;
  console.log(ok ? 'OK  ' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail));
  if (!ok) fail.push(name);
};

async function player(): Promise<{ sb: SupabaseClient; uid: string }> {
  const sb = createClient(URL, KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 40 } } });
  const { data, error } = await sb.auth.signInAnonymously();
  if (error || !data.user) throw new Error('anon sign-in: ' + error?.message);
  return { sb, uid: data.user.id };
}

async function canSubscribe(sb: SupabaseClient, topic: string): Promise<boolean> {
  await sb.realtime.setAuth();
  const ch = sb.channel(topic, { config: { private: true } });
  const ok = await new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), 8000);
    ch.subscribe((s) => {
      if (s !== 'SUBSCRIBED' && s !== 'CHANNEL_ERROR' && s !== 'TIMED_OUT') return;
      clearTimeout(t);
      res(s === 'SUBSCRIBED');
    });
  });
  await sb.removeChannel(ch);
  return ok;
}

async function main(): Promise<void> {
  const [A, B, C, X] = await Promise.all([player(), player(), player(), player()]);
  check('anonymous sign-in', true);

  const code = await createRoom(A.sb, 'Хост', { roundSec: 60, maxRounds: 3, kidsMode: false });
  check('create_room', /^[A-Z]{4}$/.test(code), code);

  const rooms = [new Room(A.sb, code, A.uid), new Room(B.sb, code, B.uid), new Room(C.sb, code, C.uid)];
  await rooms[0].join('Хост');
  await rooms[1].join('Гость1');
  await rooms[2].join('Гость2');
  check('all joined lobby', rooms.every((r) => r.state.status === 'lobby'), rooms.map((r) => r.state.status));

  // ждём, пока все увидят всех в Presence
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000 && !rooms.every((r) => r.state.members.filter((m) => m.online).length === 3)) await sleep(100);
  check('presence: everyone sees 3 online', rooms.every((r) => r.state.members.filter((m) => m.online).length === 3), {
    ms: Date.now() - t0,
    seen: rooms.map((r) => r.state.members.filter((m) => m.online).length),
  });
  check('colors unique', new Set(rooms[0].state.members.map((m) => m.color)).size === 3, rooms[0].state.members.map((m) => m.color));

  // права: чужой не войдёт в общий канал, гость — в личный канал другого гостя
  check('stranger cannot join room channel', !(await canSubscribe(X.sb, `room:${code}`)));
  check('guest cannot join other guest private', !(await canSubscribe(B.sb, `room:${code}:p:${C.uid}`)));
  check('guest cannot join host private', !(await canSubscribe(B.sb, `room:${code}:p:${A.uid}`)));

  await rooms[1].setReady(true);
  await rooms[2].setReady(true);
  await sleep(800);
  check('host sees ready flags', rooms[0].state.members.filter((m) => m.ready).length === 2);

  await rooms[0].startMatch();
  const t1 = Date.now();
  while (Date.now() - t1 < 8000 && !rooms.every((r) => r.state.status === 'game' && r.session)) await sleep(50);
  check('match_start reached guests', rooms.every((r) => r.state.status === 'game'), { ms: Date.now() - t1 });

  const host = rooms[0].session as HostSession;
  const intentsFrom: Record<string, number> = {};
  rooms[0].transport!.onMessage((ch, msg, from) => {
    if (ch === 'host' && (msg as { t?: string }).t === 'i') intentsFrom[from] = (intentsFrom[from] ?? 0) + 1;
  });
  const guests = [rooms[1].session as RemoteSession, rooms[2].session as RemoteSession];
  const sessions: ClientSession[] = [host, ...guests];

  // игровой цикл 20 Гц, как в сцене; история позиций хоста для сравнения
  const history = new Map<number, Map<number, [number, number]>>();
  let maxDiff = 0;
  let compared = 0;
  let far = 0;
  const rng = new Rng(42);
  let guestMoves = 0;
  let guestCrowd = 0;
  const loopStart = Date.now();
  let ticks = 0;
  while (Date.now() - loopStart < PLAY_SEC * 1000 && host.phase !== 'accuse') {
    const due = loopStart + ticks * 50;
    if (due > Date.now()) await sleep(due - Date.now());
    ticks++;
    for (const s of sessions) s.tick();
    const snap = new Map<number, [number, number]>();
    for (const e of host.world.entities) if (e.alive) snap.set(e.eid, [e.x, e.y]);
    history.set(host.world.time, snap);
    for (const g of guests) {
      const me = g.me();
      if (!me) continue;
      if (g.phase === 'play' && me.alive) {
        if (g.crowdWindowOpen() && me.crowdAnswered !== g.world.crowd!.warnAt && rng.chance(0.2)) {
          g.intent({ k: 'crowd', kind: g.world.crowd!.kind });
          guestCrowd++;
        } else if (rng.chance(0.03)) {
          g.intent({ k: 'move', x: rng.int(20, 160), y: rng.int(30, 240) });
          guestMoves++;
        }
      }
      const h = history.get(g.world.time);
      if (!h || g.phase !== 'play') continue;
      for (const e of g.world.entities) {
        if (!e.alive || e.eid === me.eid) continue;
        const p = h.get(e.eid);
        if (!p) continue;
        const d = Math.hypot(p[0] - e.x, p[1] - e.y);
        maxDiff = Math.max(maxDiff, d);
        if (d > 1) far++;
        compared++;
      }
    }
  }
  check('guests reached play', guests.every((g) => g.phase === 'play' || g.phase === 'accuse'), guests.map((g) => g.phase));
  check('guest world matches host', compared > 1000 && far / compared < 0.02, { compared, far, maxDiff: +maxDiff.toFixed(2) });
  check('guest knows own entity', guests.every((g, i) => g.me()?.eid === host.sim.playerRound([B.uid, C.uid][i])!.eid));
  check('guest intents sent', guestMoves > 5, { guestMoves, guestCrowd });
  const got = [B.uid, C.uid].map((pid) => intentsFrom[pid] ?? 0);
  check('host received guest intents (sender = channel owner)', got.every((n) => n > 0) && got[0] + got[1] >= guestMoves * 0.9, got);
  const lag = guests.map((g) => Math.round(g.latency));
  check('latency (half RTT) < 250 ms', lag.every((l) => l > 0 && l < 250), lag);
  const behind = guests.map((g) => host.world.time - g.world.time);
  check('guest render delay < 800 ms', behind.every((b) => b >= 0 && b < 800), behind);
  check('stalls small', guests.every((g) => g.stalls < ticks * 0.1), guests.map((g) => g.stalls));

  // уход хоста: следующий по входу забирает роль и продолжает матч
  await rooms[0].leave();
  const t2 = Date.now();
  while (Date.now() - t2 < 15_000 && rooms[1].state.hostId !== B.uid) {
    for (const s of [rooms[1].session, rooms[2].session]) s?.tick();
    await sleep(50);
  }
  check('host migration: guest1 became host', rooms[1].state.hostId === B.uid, { ms: Date.now() - t2 });
  const t3 = Date.now();
  let g2phase = '';
  while (Date.now() - t3 < 12_000) {
    rooms[1].session?.tick();
    rooms[2].session?.tick();
    g2phase = rooms[2].session?.phase ?? '';
    if (rooms[2].session instanceof RemoteSession && rooms[2].session.hostPid === B.uid && rooms[2].session.world.entities.length && g2phase === 'play') break;
    await sleep(50);
  }
  check('guest2 follows new host', rooms[2].session instanceof RemoteSession && (rooms[2].session as RemoteSession).hostPid === B.uid && g2phase === 'play', {
    g2phase,
    ms: Date.now() - t3,
  });

  for (const r of rooms.slice(1)) await r.leave();
  await Promise.all([A, B, C].map((p) => p.sb.rpc('leave_room', { p_code: code })));
  console.log(fail.length ? `FAILED: ${fail.join(', ')}` : 'ALL OK');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
