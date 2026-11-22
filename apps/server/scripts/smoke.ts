/**
 * Живой прогон против развёрнутого сервера: четверо анонимных игроков, комната, старт,
 * ~30 с игры с «пальцами». Проверяет HTTPS, WebSocket через Caddy, вход, матч, задержку.
 *
 *   pnpm --filter @kto/server smoke https://1-2-3-4.sslip.io
 */
import { Rng } from '@kto/game-core';
import { RemoteSession, ServerLink } from '@kto/net';
import type { RoomMsg } from '@kto/net';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('адрес: pnpm smoke https://host');
  process.exit(2);
}
const PLAY_MS = Number(process.env.SMOKE_PLAY_MS ?? 30_000);

function fail(msg: string): never {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) fail(`${r.url}: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const health = await json<{ ok: boolean }>(await fetch(`${base}/healthz`));
console.log('healthz:', health);
const users = await Promise.all([0, 1, 2, 3].map(async () => json<{ userId: string; token: string }>(await fetch(`${base}/v1/auth/anon`, { method: 'POST' }))));
const { code, wsUrl } = await json<{ code: string; wsUrl: string }>(
  await fetch(`${base}/v1/rooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${users[0].token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke', settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } }),
  }),
);
console.log('комната', code, wsUrl);

const sessions: (RemoteSession | null)[] = [null, null, null, null];
const links = users.map((u, i) => new ServerLink({ url: wsUrl, token: u.token, selfId: u.userId, code, name: `Smoke${i}` }));
links.forEach((l, i) =>
  l.onMessage((ch, m) => {
    const msg = m as RoomMsg;
    if (ch === 'room' && msg.t === 'match_start' && !sessions[i]) {
      sessions[i] = new RemoteSession({ transport: l, selfPid: users[i].userId, hostPid: msg.hostId, players: msg.players, cfg: msg.cfg });
    }
  }),
);
const t0 = Date.now();
for (const l of links) await l.connect();
console.log(`вошли за ${Date.now() - t0} мс`);
const until = async (cond: () => boolean, ms: number, what: string) => {
  const s = Date.now();
  while (!cond()) {
    if (Date.now() - s > ms) fail(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
await until(() => links[0].room!.members.filter((m) => m.online).length === 4, 5000, 'четверо на связи');
links[0].start();
await until(() => sessions.every(Boolean), 5000, 'старт матча');
const gs = sessions as RemoteSession[];
const rng = new Rng(Date.now() & 0xffff);
const frame = setInterval(() => {
  for (const g of gs) {
    g.tick();
    const me = g.me();
    if (!me?.alive || g.phase !== 'play') continue;
    if (g.crowdWindowOpen() && me.crowdAnswered !== g.world.crowd!.warnAt && rng.chance(0.3)) g.intent({ k: 'crowd', kind: g.world.crowd!.kind });
    else if (rng.chance(0.03)) g.intent({ k: 'move', x: rng.int(20, 160), y: rng.int(30, 240) });
  }
}, 50);
await until(() => gs.every((g) => g.phase === 'play'), 15_000, 'дубль начался');
await new Promise((r) => setTimeout(r, PLAY_MS));
clearInterval(frame);

const lat = gs.map((g) => Math.round(g.latency));
const stalls = gs.map((g) => g.stalls);
const worlds = gs.map((g) => g.world.time);
console.log('задержка, мс:', lat.join(', '));
console.log('замирания (шагов без данных):', stalls.join(', '));
console.log('время мира у игроков, мс:', worlds.join(', '));
if (gs.some((g) => !g.me())) fail('кто-то не получил свою сущность');
if (Math.max(...worlds) - Math.min(...worlds) > 1500) fail('миры игроков разошлись больше чем на 1,5 с');
if (Math.max(...worlds) < PLAY_MS * 0.5) fail('мир почти не двигался');
for (const l of links) l.leave();
for (const g of gs) g.dispose();
console.log('ok');
process.exit(0);
