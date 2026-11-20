import type { WorldEvent } from './events';
import type { NavGrid } from './nav';
import { World, makeReplay } from './world';
import type { WorldSnapshot } from './world';

/** Всё, что нужно, чтобы позже проиграть кусок раунда (журнал мира сохраняется после смены раунда). */
export interface RoundRecording {
  round: number;
  theme: number;
  nav: NavGrid;
  speed: number;
  log: WorldEvent[];
  keyframes: WorldSnapshot[];
  /** Сущности живых игроков: eid → pid. */
  players: { pid: string; eid: number }[];
  playEnd: number;
}

export interface Moment {
  from: number;
  to: number;
  score: number;
  /** Главное событие окна — для подписи. */
  kind: 'knockout' | 'star3' | 'hit_bot' | 'close' | 'end';
  /** Время главного события. */
  at: number;
}

/** Окно момента: обычно ~6 с, но может растянуться, чтобы целиком вместить два события подряд. */
export const MOMENT_MIN_MS = 5000;
export const MOMENT_MS = 6000;
export const MOMENT_MAX_MS = 8000;
const STEP_MS = 250;
const CLOSE_PX = 20;
/** Штраф за каждую секунду сверх 6 с: длинное окно берём, только если оно правда насыщеннее. */
const LONG_PENALTY = 0.6;
/** Бонус событиям с участием того, кто делает клип (его выбили, он выбил). */
const SELF_BONUS = 3;
/** Близость живых — фон, а не событие: в окне даёт не больше этого, иначе толпа у точки появления «переигрывает» выбивание. */
const CLOSE_CAP = 3;
/** Сразу после появления все стоят рядом — это не напряжённый момент. */
const SPAWN_QUIET_MS = 5000;

/**
 * Событие с «кадром»: сколько нужно показать до и после него, чтобы оно читалось.
 * Очки окно получает, только если вмещает кадр целиком — так не бывает клипа, оборванного за миг до выбивания.
 */
export interface MomentEvent {
  at: number;
  pts: number;
  kind: Moment['kind'];
  /** Начало и конец кадра события (уже обрезаны границами раунда). */
  from: number;
  to: number;
}

const CONTEXT: Record<Moment['kind'], [number, number]> = {
  knockout: [2500, 1200], // подход и удар + «поф» и реакция толпы
  hit_bot: [1500, 1200], // удар мимо и оглушение
  star3: [2000, 800], // путь к третьей звезде
  close: [0, 0],
  end: [0, 0],
};

/** События раунда с очками по эвристике раздела 11 ТЗ (плюс бонус за участие selfEid). */
export function momentEvents(rec: RoundRecording, selfEid?: number): MomentEvent[] {
  const kf0 = rec.keyframes[0];
  if (!kf0) return [];
  const start = kf0.time;
  const end = rec.playEnd;
  const isPlayer = new Set(rec.players.map((p) => p.eid));
  const out: MomentEvent[] = [];
  const add = (at: number, pts: number, kind: Moment['kind']) => {
    const [pre, post] = CONTEXT[kind];
    out.push({ at, pts, kind, from: Math.max(start, at - pre), to: Math.min(end, at + post) });
  };
  const starsBy = new Map<number, number>();
  for (const ev of rec.log) {
    if (ev.at < start || ev.at > end) continue;
    if (ev.t === 'hit') {
      const mine = selfEid !== undefined && (ev.target === selfEid || ev.attacker === selfEid);
      if (ev.result === 'player') add(ev.at, 5 + (ev.at >= end - 3000 ? 3 : 0) + (mine ? SELF_BONUS : 0), 'knockout');
      else add(ev.at, 2 + (mine ? SELF_BONUS : 0), 'hit_bot');
    } else if (ev.t === 'star_taken' && isPlayer.has(ev.eid)) {
      const n = (starsBy.get(ev.eid) ?? 0) + 1;
      starsBy.set(ev.eid, n);
      if (n === 3) add(ev.at, 4 + (ev.eid === selfEid ? SELF_BONUS : 0), 'star3');
    }
  }
  // близость живых игроков: проигрываем раунд и раз в секунду меряем расстояния
  const w = makeReplay(worldOf(rec), start, end);
  if (w) {
    while (w.time < end) {
      w.step();
      if (w.time % 1000 !== 0 || w.time < start + SPAWN_QUIET_MS) continue;
      const alive = rec.players.map((p) => w.get(p.eid)).filter((e) => e && e.alive);
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          if (Math.hypot(alive[i]!.x - alive[j]!.x, alive[i]!.y - alive[j]!.y) < CLOSE_PX) add(w.time, 1, 'close');
        }
      }
    }
  }
  return out;
}

/**
 * Лучший момент раунда: окно 5–8 с с наибольшей суммой очков событий, вошедших в него целиком.
 * selfEid — сущность того, кто делает клип: его собственные события весят больше.
 */
export function findBestMoment(rec: RoundRecording, selfEid?: number): Moment | null {
  const kf0 = rec.keyframes[0];
  if (!kf0) return null;
  const start = kf0.time;
  const end = rec.playEnd;
  if (end - start < 1000) return null;
  const events = momentEvents(rec, selfEid);
  const fallback = (): Moment => {
    const from = Math.max(start, end - MOMENT_MS);
    return { from, to: end, score: 0, kind: 'end', at: end };
  };
  if (!events.length) return fallback();

  let best: Moment | null = null;
  let bestScore = 0;
  let bestLen = 0;
  const maxLen = Math.min(MOMENT_MAX_MS, end - start);
  const minLen = Math.min(MOMENT_MIN_MS, maxLen);
  for (let len = minLen; len <= maxLen; len += STEP_MS) {
    for (let from = start; from + len <= end; from += STEP_MS) {
      const to = from + len;
      let pts = 0;
      let main: MomentEvent | null = null;
      let cut = 0;
      let close = 0;
      for (const e of events) {
        if (e.to <= from || e.from >= to) continue;
        if (e.kind === 'close') {
          close += e.pts;
          if (!main) main = e;
          continue;
        }
        if (e.from < from || e.to > to) {
          // событие задето краем окна (виден подход, а удара нет, или наоборот) — хуже, чем не показать вовсе
          cut += e.pts;
          continue;
        }
        pts += e.pts;
        if (!main || main.kind === 'close' || e.pts > main.pts || (e.pts === main.pts && e.at > main.at)) main = e;
      }
      pts += Math.min(close, CLOSE_CAP);
      if (!main || (main.kind === 'close' && pts < 2)) continue;
      const score = pts - cut - (Math.max(0, len - MOMENT_MS) / 1000) * LONG_PENALTY;
      // при равенстве: короче, затем позже (ближе к развязке)
      if (!best || score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && (len < bestLen || (len === bestLen && from > best.from)))) {
        best = { from, to, score: pts, kind: main.kind, at: main.at };
        bestScore = score;
        bestLen = len;
      }
    }
  }
  return best ?? fallback();
}

/** Мир-источник для makeReplay из записи раунда. */
export function worldOf(rec: RoundRecording): World {
  const w = new World(rec.nav, rec.speed);
  w.log = rec.log;
  w.keyframes = rec.keyframes;
  return w;
}

/** Снять запись раунда с мира, пока следующий раунд её не сбросил (init создаёт новые массивы). */
export function recordRound(
  world: World,
  info: { round: number; theme: number; players: { pid: string; eid: number }[]; playEnd: number },
): RoundRecording {
  return { ...info, nav: world.nav, speed: world.speed, log: world.log, keyframes: world.keyframes };
}
