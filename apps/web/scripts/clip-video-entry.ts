/** Настоящий клип «Лучший момент» со звуком, как его получит игрок (запись MediaRecorder). См. clip-video.mjs. */
import { DICTS, createLocalSession, findBestMoment, makeConfig, recordRound } from '@kto/game-core';
import { getAudio } from '../src/game/audio';
import { ClipPlayerScene, pickClipMime, recordClip } from '../src/game/clip';
import { loadTheme } from '../src/game/themes';

const G = globalThis as unknown as { __seed: number; __theme: number; __out?: string; __info?: string };
void (async () => {
  const names = ['Сонный Пиксель', 'Злой Пельмень!', 'Тихий Джойстик', 'Ржавый Пингвин'];
  const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: names[i], color: i }));
  const s = createLocalSession(makeConfig(G.__theme >= 0 ? { fixedTheme: G.__theme } : {}), players, G.__seed, 'me');
  for (let i = 0; i < 20 * 200 && s.phase !== 'reveal'; i++) s.tick();
  const sum = s.summary!;
  const rec = recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills });
  const self = sum.reveal.find((r) => r.pid === 'me')!.eid;
  const moment = findBestMoment({ ...rec, kills: sum.kills }, self)!;
  await loadTheme(s.theme);
  const cp = sum.reveal.map((r) => ({ eid: r.eid, name: players.find((p) => p.pid === r.pid)!.name, color: players.find((p) => p.pid === r.pid)!.color }));
  const scene = new ClipPlayerScene({ rec, moment, arena: s.arena, players: cp, t: DICTS.ru, font: 'monospace', site: location.host || 'who-is-alive.vercel.app' });
  const audio = getAudio();
  audio.unlock();
  scene.sound = audio.clipSound();
  const res = await recordClip(scene, pickClipMime()!);
  const buf = new Uint8Array(await res.blob.arrayBuffer());
  let str = '';
  for (let i = 0; i < buf.length; i += 0x8000) str += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  G.__info = JSON.stringify({ mime: res.mime, sound: !!scene.sound, theme: s.theme, moment: moment.kind });
  G.__out = btoa(str);
})();
