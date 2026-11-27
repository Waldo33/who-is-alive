/**
 * Процесс монтажа фильма матча и клипов выбывших (запускает film.ts › FilmService). Живёт между
 * задачами: модули, шрифты и темы грузятся один раз (~0,5 с на каждом клипе), а FilmService
 * сам гасит его после простоя или многих задач — чтобы память возвращалась системе.
 * Приоритет низкий, а при нехватке памяти ядро первым убивает его, а не игровой сервер.
 *
 * `node film-worker.mjs --selftest` — самопроверка на сервере (её гоняет game-deploy после выкладки):
 * матч с ИИ до конца, фильм, время монтажа и размер файла. `--selftest-clip` — то же для клипа выбывшего.
 */
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import type { LocalSession } from '@kto/game-core';
import { deathClipJob } from './death-clip';
import { renderClip, renderFilm, warmRender } from './film-render';
import type { ClipJob, FilmJob, FilmRenderOpts } from './film-render';
import { renderMyWebm } from './sticker-draw';
import type { StickerMsg, StickerReply } from './sticker-render';

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
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills, slots: sum.slots }), summary: sum, arena: s.arena });
    }
  }
  return { takes, players, match: s.match!, lang: 'ru', site: 'benobody.app', link: 'https://benobody.app/?src=film' };
}

/** Самопроверка монтирует тем же путём, что сервер: Rust, если модуль рядом (FILM_RENDERER=skia — Skia). */
function selftestNative(here: string): string | undefined {
  const p = join(here, 'massovka-film.node');
  return process.env.FILM_RENDERER !== 'skia' && existsSync(p) ? p : undefined;
}

/** Клип первого выбитого игрока (как просит телефон: через 3,4 с после удара). */
function selftestClip(): ClipJob {
  const players = ['a', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Енот', 'Батон', 'Пиксель', 'Кот'][i], color: i }));
  const s = createLocalSession(makeConfig(), players, 7, 'a') as LocalSession;
  for (let i = 0; i < 20 * 60 * 20; i++) {
    s.tick();
    const hit = s.phase === 'play' ? s.world.log.find((e) => e.t === 'hit' && e.result === 'player') : undefined;
    const victim = hit?.t === 'hit' ? players.find((p) => s.sim.playerRound(p.pid)?.eid === hit.target) : undefined;
    if (!victim || hit?.t !== 'hit') continue;
    for (let k = 0; k < 70 && s.phase === 'play'; k++) s.tick();
    const job = deathClipJob(s, victim.pid, hit.target, { lang: 'ru', noGore: false });
    if (job) return { ...job, site: 'benobody.app', link: 'https://benobody.app/?src=clip' };
  }
  throw new Error('никого не выбили');
}

if (process.argv.includes('--selftest-clip')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const t0 = Date.now();
  const r = await renderClip(selftestClip(), { fonts: join(here, 'fonts'), tmp: tmpdir(), native: selftestNative(here) });
  if (!r) {
    console.error('нет клипа');
    process.exit(1);
  }
  const ms = Date.now() - t0;
  const mb = +(statSync(r.video).size / 1e6).toFixed(1);
  rmSync(r.video, { force: true });
  // второй клип тем же процессом — как на сервере, где процесс монтажа живёт между задачами
  const t1 = Date.now();
  const r2 = await renderClip(selftestClip(), { fonts: join(here, 'fonts'), tmp: tmpdir(), native: selftestNative(here) });
  const warmMs = Date.now() - t1;
  if (r2) rmSync(r2.video, { force: true });
  console.log(JSON.stringify({ ok: true, clip: true, renderer: selftestNative(here) ? 'rust' : 'skia', ms, warmMs, render: r.renderMs, sec: +(r.durationMs / 1000).toFixed(1), mb, rssMb: Math.round(process.memoryUsage().rss / 1e6) }));
  process.exit(0);
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

/** Сообщение от FilmService: задача (фильм — job, клип — clip) или «прогреться» (warm). */
export type WorkerMsg = { id: number; job?: FilmJob; clip?: ClipJob; opts: FilmRenderOpts } | { warm: Pick<FilmRenderOpts, 'fonts' | 'native'> };

/** Прогреть: модули, шрифты, темы и звук — до первой задачи. */
async function warm(o: Pick<FilmRenderOpts, 'fonts' | 'native'>): Promise<void> {
  await Promise.all([warmRender(o), import('node-web-audio-api')]);
}

if (process.argv.includes('--sticker')) {
  // свой стикер игрока (sticker-render.ts): одна задача — и выход
  process.once('message', (msg: StickerMsg) => {
    void renderMyWebm(msg.look, { fonts: msg.fonts, ffmpeg: msg.ffmpeg })
      .then((webm): StickerReply => ({ ok: true, webm }))
      .catch((e: unknown): StickerReply => ({ ok: false, err: String(e instanceof Error ? e.message : e).slice(0, 600) }))
      .then((r) => process.send!(r, () => process.exit(0)));
  });
} else process.on('message', (msg: WorkerMsg) => {
  if ('warm' in msg) {
    void warm(msg.warm).catch(() => {
      // прогрев не вышел — задача попробует сама и скажет, что не так
    });
    return;
  }
  void (msg.clip ? renderClip(msg.clip, msg.opts) : renderFilm(msg.job!, msg.opts))
    .then((r) => ({ ok: true as const, r }))
    .catch((e: unknown) => ({ ok: false as const, err: String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 1500) }))
    .then((res) => process.send!({ id: msg.id, rssMb: Math.round(process.memoryUsage().rss / 1e6), ...res }));
});
// FilmService ушёл (сервер перезапускается) — уходим и мы
process.on('disconnect', () => process.exit(0));
