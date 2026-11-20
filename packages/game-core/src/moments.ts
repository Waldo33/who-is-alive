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

export const MOMENT_MS = 6000;
/** Главное событие ставится ближе к концу окна: перед ним видно, как к нему шли. */
const LEAD_MS = 4000;
const CLOSE_PX = 20;

interface Point {
  at: number;
  pts: number;
  kind: Moment['kind'];
}

/**
 * Эвристика «лучшего момента» (раздел 11 ТЗ): выбивание +5, выбивание в последние 3 с +3,
 * удар по боту +2, два живых ближе 20 пикселей +1 за секунду, третья звезда +4.
 * Возвращает окно 6 с с наибольшей суммой.
 */
export function findBestMoment(rec: RoundRecording): Moment | null {
  const kf0 = rec.keyframes[0];
  if (!kf0) return null;
  const start = kf0.time;
  const end = rec.playEnd;
  if (end - start < 1000) return null;
  const isPlayer = new Set(rec.players.map((p) => p.eid));
  const points: Point[] = [];
  const starsBy = new Map<number, number>();
  for (const ev of rec.log) {
    if (ev.at < start || ev.at > end) continue;
    if (ev.t === 'hit') {
      if (ev.result === 'player') {
        points.push({ at: ev.at, pts: 5 + (ev.at >= end - 3000 ? 3 : 0), kind: 'knockout' });
      } else {
        points.push({ at: ev.at, pts: 2, kind: 'hit_bot' });
      }
    } else if (ev.t === 'star_taken' && isPlayer.has(ev.eid)) {
      const n = (starsBy.get(ev.eid) ?? 0) + 1;
      starsBy.set(ev.eid, n);
      if (n === 3) points.push({ at: ev.at, pts: 4, kind: 'star3' });
    }
  }
  // близость живых игроков: проигрываем раунд и раз в секунду меряем расстояния
  const w = makeReplay(worldOf(rec), start, end);
  if (w) {
    while (w.time < end) {
      w.step();
      if (w.time % 1000 !== 0) continue;
      const alive = rec.players.map((p) => w.get(p.eid)).filter((e) => e && e.alive);
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          if (Math.hypot(alive[i]!.x - alive[j]!.x, alive[i]!.y - alive[j]!.y) < CLOSE_PX) {
            points.push({ at: w.time, pts: 1, kind: 'close' });
          }
        }
      }
    }
  }
  const clamp = (from: number) => Math.max(start, Math.min(from, end - MOMENT_MS));
  if (!points.length) {
    const from = clamp(end - MOMENT_MS);
    return { from, to: Math.min(end, from + MOMENT_MS), score: 0, kind: 'end', at: end };
  }
  let best: Moment | null = null;
  for (const p of points) {
    const from = clamp(p.at - LEAD_MS);
    const to = Math.min(end, from + MOMENT_MS);
    let score = 0;
    let main = p;
    for (const q of points) {
      if (q.at < from || q.at > to) continue;
      score += q.pts;
      if (q.pts > main.pts) main = q;
    }
    // при равенстве — более поздний момент: ближе к развязке
    if (!best || score > best.score || (score === best.score && p.at > best.at)) {
      best = { from, to, score, kind: main.kind, at: main.at };
    }
  }
  return best;
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
