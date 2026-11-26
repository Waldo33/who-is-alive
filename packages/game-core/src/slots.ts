import type { GameConfig } from './config';
import { Rng } from './rng';

/**
 * «Казино»: игроки сидят за автоматами и не могут встать, бить и угадывать нельзя — всё решает автомат.
 * Дубль идёт кругами (cfg.slotTurns). В каждом круге каждый живой игрок либо крутит, либо пропускает.
 *
 * Счёт — в половинках звезды: «три звезды» — звезда (2), «две звезды» — половинка (1).
 * Кто первым собрал cfg.starsToWin звёзд — выиграл дубль. «Три черепа» — вырезан, звёзды сгорают.
 *
 * Сначала выпадает исход вращения (по весам cfg.slotOdds с поправками), потом под него подбираются
 * три символа на барабанах — только для показа: «мимо» никогда не выглядит как выигрыш.
 * Модуль чистый: состояние стола, Rng с зерном, никакого времени.
 */

export const SLOT_SYMBOLS = ['star', 'skull', 'mask', 'clap', 'spot', 'camera', 'reel', 'popcorn'] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

/** Исход вращения. Тройки символов (кроме попкорна), «две звезды», «два черепа» и «мимо». */
export type SlotOutcome = 'jackpot' | 'half' | 'skull' | 'tease' | 'mask' | 'clap' | 'spot' | 'camera' | 'reel' | 'miss';
export const SLOT_OUTCOMES: readonly SlotOutcome[] = ['jackpot', 'half', 'skull', 'tease', 'mask', 'clap', 'spot', 'camera', 'reel', 'miss'];

/** Символ тройки для исхода. */
const TRIPLE: Partial<Record<SlotOutcome, SlotSymbol>> = {
  jackpot: 'star',
  skull: 'skull',
  mask: 'mask',
  clap: 'clap',
  spot: 'spot',
  camera: 'camera',
  reel: 'reel',
};

export type SlotChoice = 'pull' | 'pass';

export interface SlotSeat {
  /** Половинки звезды. */
  halves: number;
  alive: boolean;
  /** Маска: следующий череп не вырезает. */
  mask: boolean;
  /** Сколько ещё кругов без вращения («Плёнка»). */
  skip: number;
  /** На этот круг звёзды чаще («Хлопушка» прошлого круга). */
  clap: boolean;
  /** На этот круг черепа чаще (на него навели «Прожектор»). */
  spot: boolean;
}

export type SlotEndReason = 'stars' | 'turns' | 'last' | 'wiped';

export interface SlotResult {
  reason: SlotEndReason;
  /** Места (индексы игроков), выигравшие дубль; при ничьей — несколько. */
  winners: number[];
}

export interface SlotTable {
  /** Сыгранных кругов. */
  turn: number;
  seats: SlotSeat[];
  over: SlotResult | null;
}

export interface SlotSpin {
  outcome: SlotOutcome;
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
}

/** Что случилось за круг — для показа и событий. Порядок — порядок применения. */
export type SlotEffect =
  | { k: 'star'; seat: number }
  | { k: 'half'; seat: number }
  | { k: 'mask'; seat: number }
  | { k: 'steal'; seat: number; from: number }
  | { k: 'spot'; seat: number; target: number }
  | { k: 'clap'; seat: number }
  | { k: 'reel'; seat: number }
  | { k: 'saved'; seat: number }
  | { k: 'cut'; seat: number; lost: number };

export interface SlotTurnReport {
  /** По местам: вращение или null (пропустил, «Плёнка», вырезан). */
  spins: (SlotSpin | null)[];
  effects: SlotEffect[];
}

export function newSlotTable(players: number): SlotTable {
  const seats: SlotSeat[] = [];
  for (let i = 0; i < players; i++) seats.push({ halves: 0, alive: true, mask: false, skip: 0, clap: false, spot: false });
  return { turn: 0, seats, over: null };
}

/** Идёт ли «Последний круг» (номер круга turn считается с нуля). */
export function isLastLap(cfg: GameConfig, turn: number): boolean {
  return turn >= cfg.slotTurns - cfg.slotLastTurns;
}

/** Поправки к шансам на одно вращение. */
export interface SlotMods {
  clap?: boolean;
  spot?: boolean;
  last?: boolean;
}

/**
 * Веса исходов с поправками; сумма ровно 1. Прибавку звёзд и черепов забирает «мимо»;
 * если «мимо» не хватило — все веса нормируются.
 */
export function slotWeights(cfg: GameConfig, mods: SlotMods = {}): Record<SlotOutcome, number> {
  const o = cfg.slotOdds;
  let starMul = 1;
  let skullMul = 1;
  if (mods.clap) starMul *= cfg.slotClapMul;
  if (mods.spot) skullMul *= cfg.slotSpotMul;
  if (mods.last) {
    starMul *= cfg.slotLastMul;
    skullMul *= cfg.slotLastMul;
  }
  const w: Record<SlotOutcome, number> = {
    jackpot: o.jackpot * starMul,
    half: o.half * starMul,
    skull: o.skull * skullMul,
    tease: o.tease,
    mask: o.mask,
    clap: o.clap,
    spot: o.spot,
    camera: o.camera,
    reel: o.reel,
    miss: 0,
  };
  let sum = 0;
  for (const k of SLOT_OUTCOMES) sum += w[k];
  if (sum <= 1) {
    w.miss = 1 - sum;
  } else {
    for (const k of SLOT_OUTCOMES) w[k] /= sum;
  }
  return w;
}

/** Один исход по весам. */
export function rollOutcome(w: Record<SlotOutcome, number>, rng: Rng): SlotOutcome {
  let r = rng.next();
  for (const k of SLOT_OUTCOMES) {
    if (r < w[k]) return k;
    r -= w[k];
  }
  return 'miss';
}

/** Что показать на барабанах для исхода. */
export function reelsFor(outcome: SlotOutcome, rng: Rng): [SlotSymbol, SlotSymbol, SlotSymbol] {
  const t = TRIPLE[outcome];
  if (t) return [t, t, t];
  if (outcome === 'half' || outcome === 'tease') {
    const pair: SlotSymbol = outcome === 'half' ? 'star' : 'skull';
    const odd = rng.pick(SLOT_SYMBOLS.filter((s) => s !== 'star' && s !== 'skull'));
    const r: [SlotSymbol, SlotSymbol, SlotSymbol] = [pair, pair, pair];
    r[rng.int(0, 2)] = odd;
    return r;
  }
  // «мимо»: не три одинаковых (и не три попкорна), не больше одной звезды и одного черепа (пара прочих — «чуть-чуть»)
  for (;;) {
    const r: [SlotSymbol, SlotSymbol, SlotSymbol] = [rng.pick(SLOT_SYMBOLS), rng.pick(SLOT_SYMBOLS), rng.pick(SLOT_SYMBOLS)];
    if (classifyReels(r) === 'miss' && !(r[0] === r[1] && r[1] === r[2])) return r;
  }
}

/** Обратное: какой исход видно по барабанам (для проверки, что показ честный). */
export function classifyReels(r: readonly SlotSymbol[]): SlotOutcome {
  if (r[0] === r[1] && r[1] === r[2]) {
    for (const k of SLOT_OUTCOMES) if (TRIPLE[k] === r[0]) return k;
    return 'miss'; // три попкорна — ничего
  }
  const stars = r.filter((s) => s === 'star').length;
  const skulls = r.filter((s) => s === 'skull').length;
  if (stars === 2) return 'half';
  if (skulls === 2) return 'tease';
  return 'miss';
}

/** Сколько половинок для победы. */
export function slotGoal(cfg: GameConfig): number {
  return cfg.starsToWin * 2;
}

/** Лидер среди живых соперников места `seat` (больше всех половинок; ничья — случайно). -1 — нет соперников. */
function leaderOf(t: SlotTable, seat: number, rng: Rng, needHalves: boolean): number {
  let best = -1;
  const top: number[] = [];
  t.seats.forEach((s, i) => {
    if (i === seat || !s.alive || (needHalves && s.halves <= 0)) return;
    if (s.halves > best) {
      best = s.halves;
      top.length = 0;
    }
    if (s.halves === best) top.push(i);
  });
  return top.length ? rng.pick(top) : -1;
}

/**
 * Один круг. choices — по местам; у вырезанных и пропускающих круг («Плёнка») выбор не важен.
 * Сначала крутятся все, потом исходы применяются по порядку: звёзды, маски, камеры, прожекторы,
 * хлопушки, плёнки, черепа — внутри вида по номеру места. Меняет стол, возвращает, что случилось.
 * `script` — заранее заданный исход для места (обучение, тесты); undefined — бросок по весам.
 */
export function resolveTurn(
  cfg: GameConfig,
  t: SlotTable,
  choices: readonly SlotChoice[],
  rng: Rng,
  script?: (seat: number) => SlotOutcome | undefined,
): SlotTurnReport {
  const n = t.seats.length;
  const spins: (SlotSpin | null)[] = new Array(n).fill(null);
  const effects: SlotEffect[] = [];
  if (t.over) return { spins, effects };
  const last = isLastLap(cfg, t.turn);

  for (let i = 0; i < n; i++) {
    const s = t.seats[i];
    if (!s.alive) continue;
    if (s.skip > 0) {
      s.skip--;
      s.clap = false;
      s.spot = false;
      continue;
    }
    if (choices[i] === 'pull') {
      const outcome = script?.(i) ?? rollOutcome(slotWeights(cfg, { clap: s.clap, spot: s.spot, last }), rng);
      spins[i] = { outcome, reels: reelsFor(outcome, rng) };
    }
    // поправки действуют один круг, даже если пропустил
    s.clap = false;
    s.spot = false;
  }

  const each = (o: SlotOutcome, fn: (i: number) => void): void => {
    for (let i = 0; i < n; i++) if (spins[i]?.outcome === o) fn(i);
  };
  each('jackpot', (i) => {
    t.seats[i].halves += 2;
    effects.push({ k: 'star', seat: i });
  });
  each('half', (i) => {
    t.seats[i].halves += 1;
    effects.push({ k: 'half', seat: i });
  });
  each('mask', (i) => {
    t.seats[i].mask = true;
    effects.push({ k: 'mask', seat: i });
  });
  each('camera', (i) => {
    const from = leaderOf(t, i, rng, true);
    if (from < 0) return;
    t.seats[from].halves--;
    t.seats[i].halves++;
    effects.push({ k: 'steal', seat: i, from });
  });
  each('spot', (i) => {
    const target = leaderOf(t, i, rng, false);
    if (target < 0) return;
    t.seats[target].spot = true;
    effects.push({ k: 'spot', seat: i, target });
  });
  each('clap', (i) => {
    t.seats[i].clap = true;
    effects.push({ k: 'clap', seat: i });
  });
  each('reel', (i) => {
    t.seats[i].skip = cfg.slotReelSkip;
    effects.push({ k: 'reel', seat: i });
  });
  each('skull', (i) => {
    const s = t.seats[i];
    if (s.mask) {
      s.mask = false;
      effects.push({ k: 'saved', seat: i });
      return;
    }
    effects.push({ k: 'cut', seat: i, lost: s.halves });
    s.alive = false;
    s.halves = 0;
    s.mask = false;
    s.skip = 0;
    s.clap = false;
    s.spot = false;
  });

  t.turn++;
  t.over = slotOutcomeOf(cfg, t);
  return { spins, effects };
}

/** Кончился ли дубль и кто выиграл. null — играем дальше. */
export function slotOutcomeOf(cfg: GameConfig, t: SlotTable): SlotResult | null {
  const alive = t.seats.map((s, i) => (s.alive ? i : -1)).filter((i) => i >= 0);
  const goal = slotGoal(cfg);
  const top = (ids: number[]): number[] => {
    const m = Math.max(...ids.map((i) => t.seats[i].halves));
    return ids.filter((i) => t.seats[i].halves === m);
  };
  const done = alive.filter((i) => t.seats[i].halves >= goal);
  if (done.length) return { reason: 'stars', winners: top(done) };
  if (!alive.length) return { reason: 'wiped', winners: [] };
  if (alive.length === 1 && t.seats.length > 1) return { reason: 'last', winners: alive };
  if (t.turn >= cfg.slotTurns) {
    const w = top(alive);
    return { reason: 'turns', winners: t.seats[w[0]].halves > 0 ? w : [] };
  }
  return null;
}

/**
 * Выбор ИИ-игрока (песочница, подмена ушедших). Риск растёт к концу и у отстающих:
 * под прожектором без маски — чаще пропускает, близко к победе без маски — осторожничает,
 * на «Последнем круге» отстающий крутит всегда.
 */
export function slotAiChoice(cfg: GameConfig, t: SlotTable, seat: number, rng: Rng): SlotChoice {
  const s = t.seats[seat];
  if (!s.alive || s.skip > 0) return 'pass';
  let best = 0;
  t.seats.forEach((o, i) => {
    if (i !== seat && o.alive) best = Math.max(best, o.halves);
  });
  const behind = s.halves < best;
  if (isLastLap(cfg, t.turn) && behind) return 'pull';
  if (s.mask) return 'pull';
  if (s.spot && rng.chance(0.6)) return 'pass';
  if (s.halves >= slotGoal(cfg) - 2 && !behind && rng.chance(0.35)) return 'pass';
  return rng.chance(0.08) ? 'pass' : 'pull';
}
