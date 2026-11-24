/**
 * Процесс монтажа фильма матча (запускает film.ts › FilmService): одна задача — и выход,
 * чтобы память нативных модулей и ffmpeg возвращалась системе. Приоритет низкий, а при нехватке
 * памяти ядро первым убивает его, а не игровой сервер.
 *
 * `node film-worker.mjs --selftest` — самопроверка на сервере (её гоняет game-deploy после выкладки):
 * матч с ИИ до конца, фильм, время монтажа и размер файла.
 */
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { renderFilm } from './film-render';
import type { FilmJob, FilmRenderOpts } from './film-render';

try {
  writeFileSync('/proc/self/oom_score_adj', '1000');
} catch {
  // не Linux или нет доступа — не страшно
}

/** Матч с ИИ до конца — дубли так же, как их копит MatchRunner (room.ts). */
function selftestJob(): FilmJob {
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, 12, 'a');
  const takes: FilmJob['takes'] = [];
  let armed = false;
  for (let i = 0; i < 20 * 60 * 20 && s.phase !== 'match_end'; i++) {
    s.tick();
    if (s.phase === 'play') armed = true;
    const sum = s.summary;
    if (s.phase === 'reveal' && sum && armed) {
      armed = false;
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), summary: sum, arena: s.arena });
    }
  }
  return { takes, players, match: s.match!, lang: 'ru', site: 'benobody.app', link: 'https://benobody.app/?src=film' };
}

/** Самопроверка монтирует тем же путём, что сервер: Rust, если модуль рядом (FILM_RENDERER=skia — Skia). */
function selftestNative(here: string): string | undefined {
  const p = join(here, 'massovka-film.node');
  return process.env.FILM_RENDERER !== 'skia' && existsSync(p) ? p : undefined;
}

if (process.argv.includes('--selftest')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const job = selftestJob();
  const t0 = Date.now();
  const r = await renderFilm(job, { fonts: join(here, 'fonts'), tmp: tmpdir(), native: selftestNative(here) });
  if (!r) {
    console.error('нет фильма');
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, renderer: selftestNative(here) ? 'rust' : 'skia', ms: Date.now() - t0, render: r.renderMs, sec: +(r.durationMs / 1000).toFixed(1), mb: +(statSync(r.video).size / 1e6).toFixed(1), thumbKb: Math.round(r.thumb.length / 1024), rssMb: Math.round(process.memoryUsage().rss / 1e6) }));
  if (process.env.FILM_KEEP) console.log(r.video);
  else rmSync(r.video, { force: true });
  process.exit(0);
}

process.once('message', (msg: { job: FilmJob; opts: FilmRenderOpts }) => {
  void renderFilm(msg.job, msg.opts)
    .then((r) => ({ ok: true as const, r }))
    .catch((e: unknown) => ({ ok: false as const, err: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1500) }))
    .then((res) => process.send!(res, () => process.exit(0)));
});
