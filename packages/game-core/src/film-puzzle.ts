import type { ArenaDef } from './arena';
import { dailyHint } from './daily';
import type { HintRect } from './daily';
import type { WorldEvent } from './events';
import { findBestMoment, worldOf } from './moments';
import type { RoundRecording } from './moments';
import { NavGrid } from './nav';
import { THEME_RULES } from './themes';
import { World, makeReplay } from './world';
import type { WorldSnapshot } from './world';

/**
 * Загадка из «Фильма матча»: 20 секунд того же матча, которых нет в фильме, — зритель смотрит и тапает
 * актёра (живого игрока) среди массовки, три попытки. Засчитывается любой актёр, оставшийся в кадре.
 *
 * Кусок выбирается честным: в нём есть приметы актёров, которые видно глазами (взял звезду, попал под
 * прожектор режиссёра, рядом кого-то вырезали), и нет открытого раскрытия (удар по массовке — оглушён
 * и помечен; метка промаха; убийца на виду в изнанке). Нет такого куска — загадки нет.
 *
 * Сервер хранит ответ у себя: в браузер уходит только `FilmPuzzlePublic` (ключевой кадр и события —
 * то же, что видит любой гость в сети, без связи «игрок ↔ сущность»).
 */

/** Сколько смотреть. */
export const PUZZLE_WATCH_MS = 20_000;
/** Сколько попыток. */
export const PUZZLE_TRIES = 3;
/** Сколько секунд на выбор после стоп-кадра. */
export const PUZZLE_PICK_SEC = 30;
/** Формат файла загадки (расширять только добавлением полей). */
export const PUZZLE_V = 1;

/** Сразу после появления все стоят у своих мест — смотреть нечего. */
const START_QUIET_MS = 5000;
/** Шаг, с которым перебираются начала окна. */
const STEP_MS = 1000;
/** Меньше стольких примет — загадка нечестная. */
const MIN_TELLS = 2;
/** «Море волнуется» целиком в окне — плюс: самое узнаваемое место игры. */
const CROWD_BONUS = 2;

/** Дубль для загадки: запись и площадь (как FilmTake на сервере). */
export interface PuzzleTake {
  rec: RoundRecording;
  arena: ArenaDef;
}

/** Что уходит в браузер: только видимое на поле. */
export interface FilmPuzzlePublic {
  v: number;
  theme: number;
  arena: ArenaDef;
  /** Размер клетки сетки навигации (сетку строят заново по площади). */
  cell: number;
  speed: number;
  from: number;
  to: number;
  /** Ключевой кадр не позже `from`, без очереди событий (она — в `log`). */
  kf: WorldSnapshot;
  /** События с времени кадра до `to`. */
  log: WorldEvent[];
}

/** Что знает только сервер. */
export interface FilmPuzzleSecret {
  /** Сущности актёров, которые в кадре на стоп-кадре, — любой из них засчитывается. */
  answer: number[];
  /** Позиция актёра для подсказки (у кого больше всего примет). */
  hintAt: { x: number; y: number };
  /** Номер дубля и сколько примет — для журнала. */
  round: number;
  tells: number;
}

export interface FilmPuzzle {
  pub: FilmPuzzlePublic;
  secret: FilmPuzzleSecret;
}

export interface PuzzleTell {
  at: number;
  eid: number;
}

/** Окно запрещено: в нём кто-то из актёров раскрыт открыто. */
function exposedAt(ev: WorldEvent, players: ReadonlySet<number>): boolean {
  if (ev.t === 'hit' && ev.attacker !== undefined) return true; // удар по массовке или убийца на виду
  if (ev.t === 'mark' && players.has(ev.eid)) return true; // метка промаха
  if (ev.t === 'boss' && ev.act === 'catch' && players.has(ev.eid)) return true;
  return false;
}

/**
 * Лучший кусок одного дубля или null. `avoid` — окна, которые уже есть в фильме (лучший момент дубля).
 */
function bestWindow(tk: PuzzleTake, avoid: { from: number; to: number } | null): { from: number; score: number; tells: PuzzleTell[]; alive: number[] } | null {
  const rec = tk.rec;
  if (THEME_RULES[rec.theme]?.sanity) return null; // своя механика (рассудок) — повтор её не покажет
  const kf0 = rec.keyframes[0];
  if (!kf0) return null;
  const start = kf0.time + START_QUIET_MS;
  const end = rec.playEnd;
  if (end - start < PUZZLE_WATCH_MS) return null;
  const players = new Set(rec.players.map((p) => p.eid));
  const tells: PuzzleTell[] = [];
  const exposed: number[] = [];
  const crowds: { from: number; to: number }[] = [];
  const removed = new Map<number, number>();
  const w = makeReplay(worldOf(rec), kf0.time, end);
  if (!w) return null;
  w.listeners.push((ev) => {
    const at = w.time;
    if (exposedAt(ev, players)) exposed.push(at);
    if (ev.t === 'star_taken' && players.has(ev.eid)) tells.push({ at, eid: ev.eid });
    if (ev.t === 'spot') {
      for (const eid of players) {
        const e = w.get(eid);
        if (e && e.alive && Math.hypot(e.x - ev.x, e.y - ev.y) <= ev.r) tells.push({ at, eid });
      }
    }
    // актёра вырезали на глазах — рядом с ним был другой актёр
    if (ev.t === 'remove' && players.has(ev.eid)) {
      removed.set(ev.eid, at);
      tells.push({ at, eid: -1 });
    }
    if (ev.t === 'crowd' && !ev.ghost) crowds.push({ from: ev.showAt, to: ev.windowEnd });
  });
  // ключевые кадры: раскрытые на начало окна (оглушён, помечен) видны по снимку
  const stunnedAt = (time: number): boolean => {
    const k = [...rec.keyframes].reverse().find((x) => x.time <= time);
    if (!k) return false;
    return k.entities.some((e) => players.has(e.eid) && e.alive && ((e.act === 'stun' && e.actEnd > time) || e.markUntil > time));
  };
  while (w.time < end) w.step();

  let best: { from: number; score: number; tells: PuzzleTell[]; alive: number[] } | null = null;
  for (let from = start; from + PUZZLE_WATCH_MS <= end; from += STEP_MS) {
    const to = from + PUZZLE_WATCH_MS;
    if (avoid && from < avoid.to && to > avoid.from) continue;
    // окно с запасом на секунду назад: повтор начинается с ключевого кадра до `from`
    if (exposed.some((t) => t >= from - STEP_MS && t <= to)) continue;
    if (stunnedAt(from)) continue;
    // в кадре на стоп-кадре — те, кого не вырезали до его конца
    const inFrame = [...players].filter((eid) => (removed.get(eid) ?? Infinity) > to);
    if (!inFrame.length) continue;
    const inside = tells.filter((t) => t.at >= from && t.at <= to && (t.eid < 0 || inFrame.includes(t.eid)));
    if (inside.length < MIN_TELLS) continue;
    const crowd = crowds.some((c) => c.from >= from && c.to <= to);
    const score = inside.length + (crowd ? CROWD_BONUS : 0);
    if (!best || score > best.score) best = { from, score, tells: inside, alive: inFrame };
  }
  return best;
}

/**
 * Загадка из дублей матча или null (нет честного куска). Детерминирована: одни и те же дубли —
 * одна и та же загадка.
 */
export function pickFilmPuzzle(takes: readonly PuzzleTake[]): FilmPuzzle | null {
  let best: PuzzleCandidate | null = null;
  for (const tk of takes) best = betterPuzzle(best, puzzleCandidate(tk));
  return best ? buildFilmPuzzle(best) : null;
}

/** Лучший кусок одного дубля (или null). Сервер перебирает дубли по одному, отдавая ход другим комнатам. */
export interface PuzzleCandidate {
  tk: PuzzleTake;
  from: number;
  score: number;
  tells: PuzzleTell[];
  alive: number[];
}

export function puzzleCandidate(tk: PuzzleTake): PuzzleCandidate | null {
  const moment = findBestMoment(tk.rec);
  const b = bestWindow(tk, moment ? { from: moment.from, to: moment.to } : null);
  return b ? { tk, ...b } : null;
}

/** Из двух кандидатов — лучший (при равенстве — первый: раньше снятый дубль). */
export function betterPuzzle(a: PuzzleCandidate | null, b: PuzzleCandidate | null): PuzzleCandidate | null {
  return b && (!a || b.score > a.score) ? b : a;
}

export function buildFilmPuzzle(best: PuzzleCandidate): FilmPuzzle {
  const { tk, from } = best;
  const to = from + PUZZLE_WATCH_MS;
  const rec = tk.rec;
  const kf = [...rec.keyframes].reverse().find((k) => k.time <= from) ?? rec.keyframes[0]!;
  const log = rec.log.filter((ev) => ev.at >= kf.time && ev.at <= to);
  // позиция актёра с наибольшим числом примет на стоп-кадре — для подсказки
  const count = new Map<number, number>();
  for (const t of best.tells) if (t.eid >= 0) count.set(t.eid, (count.get(t.eid) ?? 0) + 1);
  const target = [...best.alive].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0) || a - b)[0]!;
  const w = makeReplay(worldOf(rec), from, to);
  while (w && w.time < to) w.step();
  const e = w?.get(target);
  return {
    pub: {
      v: PUZZLE_V,
      theme: rec.theme,
      arena: tk.arena,
      cell: rec.nav.cell,
      speed: rec.speed,
      from,
      to,
      kf: { ...kf, pending: [] },
      log,
    },
    secret: { answer: [...best.alive].sort((a, b) => a - b), hintAt: { x: e?.x ?? 0, y: e?.y ?? 0 }, round: rec.round, tells: best.tells.length },
  };
}

/** Мир загадки для повтора в браузере: сетка навигации заново, события — в журнал. */
export function puzzleWorld(p: FilmPuzzlePublic): World {
  const w = new World(new NavGrid(p.arena, p.cell), p.speed);
  w.log = p.log;
  w.keyframes = [p.kf];
  return w;
}

/** Подсказка после промаха (как в «Кастинге дня»): половина поля, потом четверть. */
export function puzzleHint(p: Pick<FilmPuzzlePublic, 'arena'>, s: Pick<FilmPuzzleSecret, 'hintAt'>, misses: number): HintRect | null {
  return dailyHint(p.arena, s.hintAt.x, s.hintAt.y, misses);
}
