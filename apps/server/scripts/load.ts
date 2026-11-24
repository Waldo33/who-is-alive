/**
 * Нагрузочный прогон игрового сервера (docs/infra-plan.md › этап 4): N комнат × 4 игрока играют
 * настоящие матчи — ходят, пингуют. Отчёт каждые 10 секунд и в конце: сколько комнат поднялось
 * (и сколько получили «сервер занят»), сообщения и трафик на игрока, задержка ответа сервера (пинг через
 * матч — по ней видно, успевает ли сервер), а локально — процессор, память и шаг матча.
 *
 *   pnpm --filter @kto/server build && pnpm --filter @kto/server load -- --local --rooms 200 --seconds 90
 *   LOAD_KEY=… pnpm --filter @kto/server load -- https://api.benobody.app --rooms 100 --seconds 120
 *
 * --local — поднимает сервер из dist/server.mjs рядом (замер процессора и памяти именно сервера).
 * Против прода нужен LOAD_KEY (он на сервере в secrets.env; load-test.yml читает его по SSH):
 * с ним лимиты по адресу не действуют, а фильм матча для тестовых комнат не монтируется.
 * Прод — только ночью: тестовые комнаты занимают места под потолком MAX_ROOMS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const LOCAL = args.includes('--local');
const ROOMS = flag('rooms', 50);
const SECONDS = flag('seconds', 90);
const RAMP = flag('ramp', 5); // комнат в секунду при заходе
let base = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/$/, '');
let key = process.env.LOAD_KEY ?? '';

let server: ChildProcess | null = null;
async function startLocal(): Promise<void> {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.mjs');
  const port = 18_000 + Math.floor(Math.random() * 1000);
  key = randomBytes(12).toString('hex');
  server = spawn(process.execPath, [dist], {
    env: { ...process.env, PORT: String(port), AUTH_SIGNING_KEY: randomBytes(32).toString('hex'), LOAD_KEY: key, FILM: 'off', LOG_LEVEL: 'warn', MAX_ROOMS: String(ROOMS + 10) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) return;
    } catch {
      /* ещё стартует */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('локальный сервер не поднялся (сначала pnpm --filter @kto/server build)');
}

const H = (): Record<string, string> => (key ? { 'x-kto-load': key } : {});

// ───────────── статистика ─────────────
const st = { rooms: 0, busy: 0, failed: 0, joined: 0, closed: 0, msgs: 0, bytes: 0, rtt: [] as number[], matches: 0 };
function pct(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

interface Player {
  ws: WebSocket;
  director: boolean;
}

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...H(), ...(init.headers as Record<string, string>) } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function room(i: number): Promise<Player[] | null> {
  const users = await Promise.all([0, 1, 2, 3].map(() => json('/v1/auth/anon', { method: 'POST' })));
  if (users.some((u) => u.status !== 200)) {
    st.failed++;
    return null;
  }
  const tok = (k: number) => String(users[k].body.token);
  const c = await json('/v1/rooms', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok(0)}` },
    body: JSON.stringify({ name: `load${i}`, settings: { roundSec: 60, maxRounds: 3, kidsMode: false, aiFill: false } }),
  });
  if (c.status === 503) {
    st.busy++;
    return null;
  }
  if (c.status !== 200) {
    st.failed++;
    return null;
  }
  const code = String(c.body.code);
  const wsUrl = String(c.body.wsUrl);
  const players = await Promise.all(
    [0, 1, 2, 3].map(
      (k) =>
        new Promise<Player | null>((resolve) => {
          const ws = new WebSocket(wsUrl, { headers: H() });
          const done = (p: Player | null) => {
            clearTimeout(t);
            resolve(p);
          };
          const t = setTimeout(() => done(null), 10_000);
          ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, token: tok(k), code, name: `P${k}` })));
          ws.on('message', (d: Buffer) => {
            st.msgs++;
            st.bytes += d.length;
            const s = d.toString();
            if (s.startsWith('{"t":"welcome"')) {
              st.joined++;
              done({ ws, director: k === 0 });
            } else if (s.includes('"t":"pong"')) {
              const m = /"c":(\d+(?:\.\d+)?)/.exec(s);
              if (m) st.rtt.push(Date.now() - Number(m[1]));
            } else if (s.includes('"t":"match_start"') && k === 0) st.matches++;
            else if (k === 0 && s.includes('"phase":"match_end"')) {
              // матч кончился раньше прогона — «Ещё дубль», нагрузка не падает
              ws.send(JSON.stringify({ t: 'g', m: { t: 'i', i: { k: 'rematch' } } }));
            }
          });
          ws.on('close', () => {
            st.closed++;
            done(null);
          });
          ws.on('error', () => done(null));
        }),
    ),
  );
  if (players.some((p) => !p)) {
    st.failed++;
    for (const p of players) p?.ws.terminate();
    return null;
  }
  st.rooms++;
  players[0]!.ws.send(JSON.stringify({ t: 'start' }));
  return players as Player[];
}

/** Игрок ходит раз в 0,4–0,8 с и пингует раз в 2 с — пинг идёт через матч (pong шлёт хост). */
function drive(players: Player[]): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const p of players) {
    const move = () => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ t: 'g', m: { t: 'i', i: { k: 'move', x: Math.floor(Math.random() * 180), y: Math.floor(Math.random() * 260) } } }));
      timers.push(setTimeout(move, 400 + Math.random() * 400));
    };
    timers.push(setTimeout(move, Math.random() * 800));
    timers.push(
      setInterval(() => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ t: 'g', m: { t: 'ping', c: Date.now() } }));
      }, 2000),
    );
  }
  return () => timers.forEach((t) => clearTimeout(t));
}

// ───────────── замер сервера (только локально) ─────────────
function cpuTicks(pid: number): number {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(f[11]) + Number(f[12]);
}
function rssMb(pid: number): number {
  const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : NaN;
}
async function metric(name: string): Promise<string> {
  try {
    const t = await (await fetch(`${base}/metrics`)).text();
    return t.split('\n').find((l) => l.startsWith(name))?.split(' ').pop() ?? '?';
  } catch {
    return '?';
  }
}

async function main(): Promise<void> {
  if (LOCAL) await startLocal();
  if (!base) throw new Error('адрес сервера: https://… или --local');
  console.log(`нагрузка: ${ROOMS} комнат × 4 игрока, ${SECONDS} с, заход ${RAMP} комнат/с → ${base}${LOCAL ? ' (локально)' : ''}`);
  const all: Player[][] = [];
  const stops: (() => void)[] = [];
  const t0 = Date.now();
  for (let i = 0; i < ROOMS; i += RAMP) {
    const batch = await Promise.all(Array.from({ length: Math.min(RAMP, ROOMS - i) }, (_, j) => room(i + j)));
    for (const p of batch) {
      if (!p) continue;
      all.push(p);
      stops.push(drive(p));
    }
    const wait = 1000 - ((Date.now() - t0) % 1000);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`заход за ${((Date.now() - t0) / 1000).toFixed(1)} с: комнат ${st.rooms}, «сервер занят» ${st.busy}, не вошли ${st.failed}`);

  const pid = server?.pid;
  let ticks = pid ? cpuTicks(pid) : 0;
  let last = Date.now();
  const end = Date.now() + SECONDS * 1000;
  const reports: { cpu: number; rss: number; p99: number }[] = [];
  while (Date.now() < end) {
    st.msgs = 0;
    st.bytes = 0;
    st.rtt = [];
    await new Promise((r) => setTimeout(r, Math.min(10_000, end - Date.now())));
    const dt = (Date.now() - last) / 1000;
    last = Date.now();
    const players = all.length * 4;
    let line = `игроков ${players}: ${(st.msgs / dt).toFixed(0)} сообщ/с, ${(st.bytes / dt / 1024 / Math.max(1, players)).toFixed(2)} КБ/с на игрока, пинг p50 ${pct(st.rtt, 50)} p95 ${pct(st.rtt, 95)} p99 ${pct(st.rtt, 99)} мс`;
    if (pid) {
      const now = cpuTicks(pid);
      const cpu = Math.round((now - ticks) / dt);
      ticks = now;
      const rss = rssMb(pid);
      reports.push({ cpu, rss, p99: pct(st.rtt, 99) });
      line += ` · сервер: процессор ${cpu}% ядра, память ${rss} МБ, шаг p99 ${await metric('game_step_ms_p99')} мс`;
    } else reports.push({ cpu: NaN, rss: NaN, p99: pct(st.rtt, 99) });
    console.log(line);
  }
  stops.forEach((s) => s());
  for (const r of all) for (const p of r) p.ws.terminate();
  const worst = Math.max(...reports.map((r) => r.p99).filter((x) => !Number.isNaN(x)));
  console.log(
    `итог: комнат ${st.rooms} из ${ROOMS} (занято ${st.busy}, не вошли ${st.failed}), закрылось соединений ${st.closed}, худший пинг p99 ${worst} мс` +
      (pid ? `, процессор до ${Math.max(...reports.map((r) => r.cpu))}% ядра, память до ${Math.max(...reports.map((r) => r.rss))} МБ (${(Math.max(...reports.map((r) => r.rss)) / Math.max(1, st.rooms)).toFixed(2)} МБ на комнату с базой)` : ''),
  );
  server?.kill('SIGTERM');
  // провал — если больше 5% комнат не вошли по ошибке (не «занято») или соединения рвались
  const bad = st.failed > ROOMS * 0.05;
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server?.kill('SIGTERM');
  process.exit(1);
});
