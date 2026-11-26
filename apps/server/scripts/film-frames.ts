/**
 * Кадры «Фильма матча» одним файлом RGBA (540×960, каждый N-й кадр) — для сверки рендеров.
 *   tsx scripts/film-frames.ts <skia|rust> <out.rgba> [каждый N-й кадр] [зерно]
 * Rust — модуль из FILM_NATIVE_PATH (по умолчанию dist/massovka-film.node). Рендер выбирается на
 * процесс (фабрика холстов и кеш спрайтов — общие), поэтому сверка гоняет скрипт дважды.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS, createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { FilmScene, filmInput } from '../../web/src/game/film';
import type { FilmTake } from '../../web/src/game/film';
import { setCanvasFactory } from '../../web/src/game/pixels';
import { loadAllThemes } from '../../web/src/game/themes';
import { makeEngine } from '../src/film-native';
import type { NCanvas } from '../src/film-native';

const here = dirname(fileURLToPath(import.meta.url));
const [mode, out, everyArg, seedArg] = process.argv.slice(2);
if ((mode !== 'skia' && mode !== 'rust') || !out) {
  console.error('tsx scripts/film-frames.ts <skia|rust> <out.rgba> [N] [зерно]');
  process.exit(2);
}
const every = Number(everyArg ?? 6);
const W = 540;
const H = 960;
const fonts = ['press-start-2p-cyrillic-400-normal.woff', 'press-start-2p-latin-400-normal.woff'].map((f) => join(here, '../../web/assets/og', f));

let read: (c: unknown) => Buffer;
if (mode === 'rust') {
  const rec = makeEngine(process.env.FILM_NATIVE_PATH ?? join(here, '../dist/massovka-film.node'), fonts);
  setCanvasFactory(() => rec.canvas() as unknown as HTMLCanvasElement);
  read = (c) => (c as NCanvas).pixels();
} else {
  const napi = await import('@napi-rs/canvas');
  napi.GlobalFonts.registerFromPath(fonts[0], 'Press Start 2P');
  napi.GlobalFonts.registerFromPath(fonts[1], 'Press Start 2P Latin');
  setCanvasFactory(() => napi.createCanvas(1, 1) as unknown as HTMLCanvasElement);
  read = (c) => {
    const d = (c as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, W, H).data;
    return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  };
}
await loadAllThemes();

const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
const s = createLocalSession(makeConfig(), players, Number(seedArg ?? 12), 'a');
const takes: FilmTake[] = [];
let armed = false;
for (let i = 0; i < 20 * 60 * 20 && s.phase !== 'match_end'; i++) {
  s.tick();
  if (s.phase === 'play') armed = true;
  const sum = s.summary;
  if (s.phase === 'reveal' && sum && armed) {
    armed = false;
    takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills, slots: sum.slots }), summary: sum, arena: s.arena });
  }
}
const inp = filmInput(takes, players, s.match!, {
  t: DICTS.ru,
  lang: 'ru',
  font: '"Press Start 2P", "Press Start 2P Latin"',
  site: 'benobody.app',
  link: 'https://benobody.app/?src=film',
  noGore: true,
  scale: 3,
});
if (!inp) throw new Error('нет фильма');
const film = new FilmScene(inp);
const frames = Math.ceil((film.duration / 1000) * 24);
const bufs: Buffer[] = [];
for (let k = 0; k < frames; k++) {
  const c = film.frame(Math.min((k * 1000) / 24, film.duration));
  if (k % every === 0) bufs.push(Buffer.from(read(c)));
}
writeFileSync(out, Buffer.concat(bufs));
console.log(JSON.stringify({ mode, frames: bufs.length }));
