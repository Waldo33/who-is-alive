/** Кадры «Фильма матча» без записи видео: безголовый матч с ИИ до конца, фильм из всех дублей, кадры через равные промежутки. */
import { DICTS, createLocalSession, makeConfig, recordRound } from '@kto/game-core';
import { FilmScene, filmInput } from '../src/game/film';
import type { FilmTake } from '../src/game/film';
import { loadAllThemes } from '../src/game/themes';

const G = globalThis as unknown as { __seed: number; __kind?: string; __theme?: number; __frames?: number; __from?: number; __finale?: string; __puzzle?: string; __out: unknown };
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
      takes.push({ rec: recordRound(s.world, { round: s.round, theme: s.theme, players: sum.reveal, playEnd: sum.replayTo, kills: sum.kills }), summary: sum, arena: s.arena });
    }
  }
  const inp = filmInput(takes, players, s.match!, { t: DICTS.ru, lang: 'ru', font: '"Press Start 2P"', site: 'benobody.app', link: G.__puzzle ? `https://benobody.app/${G.__puzzle}?src=film_qr` : 'https://benobody.app/?src=film', puzzle: G.__puzzle });
  if (!inp) {
    G.__out = [{ name: 'info', url: 'data:text/plain,' + encodeURIComponent('нет фильма') }];
    return;
  }
  // FILM_KIND=ghost — посмотреть финал другого сюжета на этом матче
  if (G.__kind && inp.story) inp.story.kind = G.__kind as typeof inp.story.kind;
  // FILM_FINALE=board|race|podium — другой показ очков в финале
  if (G.__finale) inp.finale = G.__finale as typeof inp.finale;
  const film = new FilmScene(inp);
  const out: { name: string; url: string }[] = [];
  const n = G.__frames ?? 24;
  // FILM_FROM=мс — кадры только с этого места (посмотреть концовку подробнее)
  // отрицательный FILM_FROM — от конца: −8600 — финал и титры
  const from = G.__from === undefined ? 0 : G.__from < 0 ? Math.max(0, film.duration + G.__from) : G.__from;
  for (let k = 0; k < n; k++) {
    const ms = from + ((film.duration - from) * k) / n;
    film.draw(ms);
    out.push({ name: `f${G.__seed}_${String(k).padStart(2, '0')}_${Math.round(ms)}`, url: film.c.toDataURL('image/png') });
  }
  const info = { dur: Math.round(film.duration), takes: takes.length, rounds: inp.rounds.map((r) => [r.rec.round, r.moment.kind, r.moment.score]), hook: inp.hook.rec.round, story: inp.story && { kind: inp.story.kind, hero: inp.story.hero.name, rival: inp.story.rival?.name, value: inp.story.value, value2: inp.story.value2 }, cast: inp.cast.map((c) => [c.name, c.points]) };
  out.push({ name: `f${G.__seed}_info`, url: 'data:text/plain,' + encodeURIComponent(JSON.stringify(info)) });
  G.__out = out;
})();
