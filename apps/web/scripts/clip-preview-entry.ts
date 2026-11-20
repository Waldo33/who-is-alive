/** Кадры клипа «Лучший момент» без записи видео: безголовый матч с ИИ, лучший момент, кадры через равные промежутки. */
import { createLocalSession, findBestMoment, makeConfig, recordRound } from '@kto/game-core';
import { DICTS } from '@kto/game-core';
import { ClipPlayerScene } from '../src/game/clip';

const out: { name: string; url: string }[] = [];
const seeds = (globalThis as unknown as { __seeds: number[] }).__seeds;
for (const seed of seeds) {
  const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Быстрый Енот', 'Тихий Батон', 'Злой Пиксель', 'Шустрый Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, seed, 'me');
  for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
  const sum = s.summary!;
  const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo });
  const self = sum.reveal.find((r) => r.pid === 'me')!.eid;
  const moment = findBestMoment({ ...rec, kills: sum.kills }, self)!;
  const cp = sum.reveal.map((r) => ({ eid: r.eid, name: players.find((p) => p.pid === r.pid)!.name, color: players.find((p) => p.pid === r.pid)!.color }));
  const scene = new ClipPlayerScene({ rec, moment, arena: s.arena, players: cp, t: DICTS.ru, font: 'monospace', site: 'who-is-alive.vercel.app' });
  const n = 10;
  for (let k = 0; k < n; k++) {
    const ms = (scene.duration * k) / n;
    scene.draw(ms);
    out.push({ name: `s${seed}_${String(k).padStart(2, '0')}_${Math.round(ms)}`, url: scene.c.toDataURL('image/png') });
  }
  out.push({ name: `s${seed}_info`, url: 'data:text/plain,' + encodeURIComponent(JSON.stringify({ moment, dur: scene.duration })) });
}
(globalThis as unknown as { __out: unknown }).__out = out;
