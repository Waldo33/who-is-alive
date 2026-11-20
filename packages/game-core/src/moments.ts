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
  /** Кем в главном событии был тот, для кого клип: выбил сам или выбили его. */
  selfRole?: 'attacker' | 'victim';
}

/** Окно момента: обычно ~6 с, но может растянуться, чтобы целиком вместить два события подряд или долгий подход. */
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
/** Нападавший — живой игрок не дальше этого от цели в момент удара (удар 14 пикс. плюс запас на сетевую перемотку). */
const ATTACKER_PX = 24;
/** «Охота» начинается, когда нападавший был дальше этого от жертвы. */
const APPROACH_PX = 40;
/** Подход показываем не короче и не длиннее этого. */
const APPROACH_MIN_MS = 2500;
const APPROACH_MAX_MS = 4500;
/** Второе выбивание тем же игроком вскоре после первого — серия. */
const COMBO_MS = 4000;
const COMBO_BONUS = 2;
/** Выбили того, кто только что ошибся и стоит оглушённый, — расплата. */
const PUNISH_MS = 3000;
const PUNISH_BONUS = 2;

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
  /** Участие того, для кого клип. */
  selfRole?: 'attacker' | 'victim';
}

/** Кадр события по умолчанию: [до, после]. У выбивания «до» растягивается на весь подход нападавшего. */
const CONTEXT: Record<Moment['kind'], [number, number]> = {
  knockout: [APPROACH_MIN_MS, 1200], // подход и удар + «поф» и реакция толпы
  hit_bot: [1500, 1200], // удар мимо и оглушение
  star3: [2000, 800], // путь к третьей звезде
  close: [0, 0],
  end: [0, 0],
};

/**
 * События раунда с очками по эвристике раздела 11 ТЗ. Раунд проигрывается заново один раз:
 * по позициям живых видно, кто кого выбил (в событии мира нападавшего нет — чтобы по сети не вычислить игроков),
 * откуда начался подход, кто стоял рядом.
 */
export function momentEvents(rec: RoundRecording, selfEid?: number): MomentEvent[] {
  const kf0 = rec.keyframes[0];
  if (!kf0) return [];
  const start = kf0.time;
  const end = rec.playEnd;
  const isPlayer = new Set(rec.players.map((p) => p.eid));
  const out: MomentEvent[] = [];
  const add = (at: number, pts: number, kind: Moment['kind'], pre?: number, selfRole?: MomentEvent['selfRole']) => {
    const [p0, post] = CONTEXT[kind];
    out.push({ at, pts, kind, from: Math.max(start, at - (pre ?? p0)), to: Math.min(end, at + post), selfRole });
  };

  // позиции живых игроков на каждом шаге (их всего 2–4) и близость раз в секунду
  const track = new Map<number, { t: number; x: number; y: number }[]>();
  for (const eid of isPlayer) track.set(eid, []);
  const w = makeReplay(worldOf(rec), start, end);
  if (w) {
    while (w.time <= end) {
      for (const eid of isPlayer) {
        const e = w.get(eid);
        if (e && e.alive) track.get(eid)!.push({ t: w.time, x: e.x, y: e.y });
      }
      if (w.time % 1000 === 0 && w.time >= start + SPAWN_QUIET_MS) {
        const alive = rec.players.map((p) => w.get(p.eid)).filter((e) => e && e.alive);
        for (let i = 0; i < alive.length; i++) {
          for (let j = i + 1; j < alive.length; j++) {
            if (Math.hypot(alive[i]!.x - alive[j]!.x, alive[i]!.y - alive[j]!.y) < CLOSE_PX) add(w.time, 1, 'close');
          }
        }
      }
      if (w.time >= end) break;
      w.step();
    }
  }
  const posAt = (eid: number, t: number) => {
    const tr = track.get(eid);
    if (!tr) return null;
    for (let i = tr.length - 1; i >= 0; i--) if (tr[i].t <= t) return tr[i].t > t - 200 ? tr[i] : null;
    return null;
  };
  /** Кто выбил: ближайший к цели живой игрок (боты игроков не бьют). */
  const attackerOf = (target: number, at: number, x: number, y: number): number | undefined => {
    let best: number | undefined;
    let bd = ATTACKER_PX;
    for (const eid of isPlayer) {
      if (eid === target) continue;
      const p = posAt(eid, at);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bd) {
        bd = d;
        best = eid;
      }
    }
    return best;
  };
  /** С какого момента нападавший шёл к жертве: последний раз был дальше APPROACH_PX. */
  const approachFrom = (attacker: number, victim: number, at: number): number => {
    const ta = track.get(attacker) ?? [];
    for (let i = ta.length - 1; i >= 0; i--) {
      const a = ta[i];
      if (a.t > at) continue;
      if (a.t < at - APPROACH_MAX_MS) return at - APPROACH_MAX_MS;
      const v = posAt(victim, a.t);
      if (v && Math.hypot(a.x - v.x, a.y - v.y) > APPROACH_PX) return a.t;
    }
    return at - APPROACH_MIN_MS;
  };

  const starsBy = new Map<number, number>();
  const lastKoBy = new Map<number, number>();
  const missAt = new Map<number, number>(); // игрок → когда последний раз ударил бота
  for (const ev of rec.log) {
    if (ev.at < start || ev.at > end) continue;
    if (ev.t === 'hit') {
      if (ev.result === 'player') {
        const attacker = ev.attacker ?? attackerOf(ev.target, ev.at, ev.x, ev.y);
        const role = selfEid === undefined ? undefined : ev.target === selfEid ? 'victim' : attacker === selfEid ? 'attacker' : undefined;
        let pts = 5 + (ev.at >= end - 3000 ? 3 : 0) + (role ? SELF_BONUS : 0);
        const miss = missAt.get(ev.target);
        if (miss !== undefined && ev.at - miss <= PUNISH_MS) pts += PUNISH_BONUS;
        let pre = APPROACH_MIN_MS;
        if (attacker !== undefined) {
          const prev = lastKoBy.get(attacker);
          if (prev !== undefined && ev.at - prev <= COMBO_MS) pts += COMBO_BONUS;
          lastKoBy.set(attacker, ev.at);
          pre = Math.min(APPROACH_MAX_MS, Math.max(APPROACH_MIN_MS, ev.at - approachFrom(attacker, ev.target, ev.at) + 300));
        }
        add(ev.at, pts, 'knockout', pre, role);
      } else {
        const mine = selfEid !== undefined && ev.attacker === selfEid;
        if (ev.attacker !== undefined) missAt.set(ev.attacker, ev.at);
        add(ev.at, 2 + (mine ? SELF_BONUS : 0), 'hit_bot', undefined, mine ? 'attacker' : undefined);
      }
    } else if (ev.t === 'star_taken' && isPlayer.has(ev.eid)) {
      const n = (starsBy.get(ev.eid) ?? 0) + 1;
      starsBy.set(ev.eid, n);
      if (n === 3) add(ev.at, 4 + (ev.eid === selfEid ? SELF_BONUS : 0), 'star3', undefined, ev.eid === selfEid ? 'attacker' : undefined);
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
    // начала окон: сетка от начала раунда, конец раунда и края кадров событий —
    // иначе событие у самого конца раунда (третья звезда, последнее выбивание) не помещалось бы ни в одно окно
    const froms = new Set<number>();
    for (let from = start; from + len <= end; from += STEP_MS) froms.add(from);
    froms.add(end - len);
    for (const e of events) {
      if (e.kind === 'close') continue;
      froms.add(e.from);
      froms.add(e.to - len);
    }
    for (const from of froms) {
      const to = from + len;
      if (from < start || to > end) continue;
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
        best = { from, to, score: pts, kind: main.kind, at: main.at, selfRole: main.selfRole };
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
