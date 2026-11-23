/** Кадры «Фильма матча» без записи видео: безголовый матч с ИИ до конца, фильм из всех дублей, кадры через равные промежутки. */
import { DICTS, createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { FilmScene, filmInput } from '../src/game/film';
import type { FilmTake } from '../src/game/film';
import { loadAllThemes } from '../src/game/themes';

const G = globalThis as unknown as { __seed: number; __theme?: number; __frames?: number; __from?: number; __out: unknown };
void (async () => {
  await loadAllThemes();
  const cfg = makeConfig(G.__theme !== undefined && G.__theme >= 0 ? { fixedTheme: G.__theme } : {});
  const players = ['me', 'b', 'c', 'd'].map((pid, i) => ({ pid, name: ['Быстрый Енот', 'Тихий Батон', 'Злой Пиксель', 'Шустрый Кот'][i], color: i }));
  const s = createLocalSession(cfg, players, G.__seed, 'me');
  const takes: FilmTake[] = [];
  let last = -1;
  for (let i = 0; i < 20 * 60 * 20 && s.phase !== 'match_end'; i++) {
    s.tick();
    if (s.phase === 'reveal' && s.round !== last && s.summary) {
      last = s.round;
      const sum = s.summary;
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo }), summary: sum, arena: s.arena });
    }
  }
  const inp = filmInput(takes, players, s.match!, { t: DICTS.ru, lang: 'ru', font: '"Press Start 2P"', site: 'benobody.app', link: 'https://benobody.app/?src=film' });
  if (!inp) {
    G.__out = [{ name: 'info', url: 'data:text/plain,' + encodeURIComponent('нет фильма') }];
    return;
  }
  const film = new FilmScene(inp);
  const out: { name: string; url: string }[] = [];
  const n = G.__frames ?? 24;
  // FILM_FROM=мс — кадры только с этого места (посмотреть концовку подробнее)
  const from = G.__from ?? 0;
  for (let k = 0; k < n; k++) {
    const ms = from + ((film.duration - from) * k) / n;
    film.draw(ms);
    out.push({ name: `f${G.__seed}_${String(k).padStart(2, '0')}_${Math.round(ms)}`, url: film.c.toDataURL('image/png') });
  }
  const info = { dur: Math.round(film.duration), takes: takes.length, rounds: inp.rounds.map((r) => [r.rec.round, r.moment.kind, r.moment.score]), hook: inp.hook.rec.round, cast: inp.cast };
  out.push({ name: `f${G.__seed}_info`, url: 'data:text/plain,' + encodeURIComponent(JSON.stringify(info)) });
  G.__out = out;
})();
