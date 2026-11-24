/**
 * Живой прогон против развёрнутого сервера: четверо анонимных игроков, комната, старт,
 * ~30 с игры с «пальцами». Проверяет HTTPS, WebSocket через Caddy, вход, матч, задержку.
 *
 *   pnpm --filter @kto/server smoke https://1-2-3-4.sslip.io
 *
 * SMOKE_THROUGH=1 — «матч через выкладку» (game-deploy запускает его до переключения экземпляров):
 * играем SMOKE_PLAY_MS через все дубли, и связь не должна закрыться (closed) — матч доигрывается на старом.
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
const THROUGH = process.env.SMOKE_THROUGH === '1';

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
// комната закрылась посреди матча (выкладка оборвала) — провал
links.forEach((l, i) => l.onEnd((why) => fail(`игрок ${i}: связь закрыта сервером (${why})`)));
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
// режиссёр стартует только когда остальные нажали «Готов»
for (const l of links.slice(1)) l.setReady(true);
await until(() => links[0].room!.members.filter((m) => m.ready).length === 3, 5000, 'трое «Готов»');
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
// игрок 0 — «живой»: ходит, останавливается и жмёт жесты; считаем сдвиги своего персонажа стоя
const probe = gs[0];
const gaps: number[] = [];
let lastEv = 0;
links[0].onMessage((ch, m) => {
  if (ch === 'room' && (m as { t: string }).t === 'ev') {
    const n = performance.now();
    if (lastEv) gaps.push(n - lastEv);
    lastEv = n;
  }
});
let shifts = 0;
let maxShift = 0;
const shiftLog: string[] = [];
const tEnd = Date.now() + PLAY_MS;
let lastPos: [number, number] | null = null;
let standSince = 0;
let phaseI = 0;
while (Date.now() < tEnd && (THROUGH ? probe.phase !== 'match_end' : probe.phase === 'play')) {
  const me = probe.me();
  const e = me ? probe.world.get(me.eid) : undefined;
  if (e && me?.alive) {
    const cycle = Math.floor((Date.now() / 1000) % 6);
    if (cycle === 0 && phaseI !== 1) {
      phaseI = 1;
      probe.intent({ k: 'move', x: Math.round(e.x < 90 ? e.x + 25 : e.x - 25), y: Math.round(e.y) });
    } else if (cycle >= 2 && cycle % 1 === 0 && phaseI !== cycle) {
      phaseI = cycle;
      probe.intent({ k: 'emote', kind: (['wave', 'dance', 'jump'] as const)[cycle % 3] });
    }
    if (!e.moving) {
      standSince ||= Date.now();
      if (lastPos && Date.now() - standSince > 300) {
        const d = Math.hypot(e.x - lastPos[0], e.y - lastPos[1]);
        if (d > 0.01) {
          shifts++;
          maxShift = Math.max(maxShift, d);
          if (shiftLog.length < 10) shiftLog.push(`  стоя сдвиг ${d.toFixed(2)} пикс., act=${e.act ?? "-"}, задержка ${Math.round(probe.latency)} мс`);
        }
      }
    } else standSince = 0;
    lastPos = [e.x, e.y];
  }
  await new Promise((r) => setTimeout(r, 25));
}
clearInterval(frame);
gaps.sort((a, b) => a - b);
const q = (p: number) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0);
console.log(`пакеты ev: ${gaps.length}, интервал p50 ${q(0.5)} мс, p95 ${q(0.95)} мс, p99 ${q(0.99)} мс, макс ${q(1)} мс`);
console.log(`сдвиги своего персонажа стоя: ${shifts}, макс ${maxShift.toFixed(2)} пикс.`);
for (const l of shiftLog) console.log(l);

const lat = gs.map((g) => Math.round(g.latency));
const stalls = gs.map((g) => g.stalls);
const worlds = gs.map((g) => g.world.time);
console.log('задержка, мс:', lat.join(', '));
console.log('замирания (шагов без данных):', stalls.join(', '));
console.log('время мира у игроков, мс:', worlds.join(', '));
console.log('переподключений:', links.map((l) => l.reconnects).join(', '), '· переездов:', links.map((l) => l.moves).join(', '));
if (gs.some((g) => !g.me())) fail('кто-то не получил свою сущность');
if (Math.max(...worlds) - Math.min(...worlds) > 1500) fail('миры игроков разошлись больше чем на 1,5 с');
if (Math.max(...worlds) < PLAY_MS * 0.5) fail('мир почти не двигался');
for (const l of links) l.leave();
for (const g of gs) g.dispose();
console.log('ok');
process.exit(0);
