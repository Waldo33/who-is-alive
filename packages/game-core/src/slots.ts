import type { GameConfig } from './config';
import { aiLevel } from './config';
import type { Rng } from './rng';

/**
 * «Казино» — обычный дубль (ходишь, прячешься, бьёшь, угадываешь), только вместо «Море волнуется»
 * идёт «Крутка»: лампы мигают (cfg.slotWarnMs), мир замирает, у каждого живого игрока опускается
 * автомат — дёргаешь рычаг (или автомат дёрнет сам), барабаны крутятся, выпадает бонус, баф, дебаф
 * или череп. Своё вращение знает только сам игрок (личное сообщение); всё, что видно на поле
 * (молния, гиря, прожектор), с теми же шансами достаётся и статистам — по полю живого не вычислить.
 *
 * Сначала по весам выпадает исход, потом под него подбираются три символа на барабанах — только
 * для показа: «мимо» никогда не выглядит как выигрыш. Модуль чистый: Rng с зерном, без времени.
 */

/** Символы на ленте. Последние три — только для «мимо» (своих исходов нет). */
export const SLOT_SYMBOLS = ['seven', 'star', 'fist', 'camera', 'bolt', 'spot', 'weight', 'reel', 'skull', 'popcorn', 'clap', 'mask'] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

/**
 * Исход вращения. Индекс в SLOT_OUTCOMES уходит в сеть — новые только в конец.
 * - seven  «777» — +1 очко матча (в итогах дубля);
 * - star   три звезды — +1 звезда;
 * - fist   три кулака — +1 удар;
 * - peek   три камеры — на пару секунд подсвечен один живой соперник (видит только сам);
 * - bolt   молния — быстрее на время (видно всем, бывает и у статистов);
 * - spot   прожектор — круг света над тобой (видно всем, бывает и у статистов);
 * - weight гиря — медленнее на время (видно всем, бывает и у статистов);
 * - reel   «плёнка кончилась» — −1 удар;
 * - skull  три черепа — вырезан (лёгкая сложность — сгорает звезда);
 * - miss   мимо.
 */
export type SlotOutcome = 'seven' | 'star' | 'fist' | 'peek' | 'bolt' | 'spot' | 'weight' | 'reel' | 'skull' | 'miss';
export const SLOT_OUTCOMES: readonly SlotOutcome[] = ['seven', 'star', 'fist', 'peek', 'bolt', 'spot', 'weight', 'reel', 'skull', 'miss'];

/** Исходы, которые видно на поле: их с теми же шансами получают и статисты. */
export const SLOT_VISIBLE: readonly SlotOutcome[] = ['bolt', 'spot', 'weight'];

/** Символ тройки для исхода. */
const TRIPLE: Partial<Record<SlotOutcome, SlotSymbol>> = {
  seven: 'seven',
  star: 'star',
  fist: 'fist',
  peek: 'camera',
  bolt: 'bolt',
  spot: 'spot',
  weight: 'weight',
  reel: 'reel',
  skull: 'skull',
};

export interface SlotSpin {
  outcome: SlotOutcome;
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
}

/** Шанс черепа на этой сложности: лёгкая, обычная, жёсткая. */
export function skullChance(cfg: GameConfig): number {
  return cfg.slotSkull[aiLevel(cfg)];
}

/** Веса исходов на одно вращение; сумма ровно 1 («мимо» — остаток). */
export function slotWeights(cfg: GameConfig): Record<SlotOutcome, number> {
  const o = cfg.slotOdds;
  const w: Record<SlotOutcome, number> = {
    seven: o.seven,
    star: o.star,
    fist: o.fist,
    peek: o.peek,
    bolt: o.bolt,
    spot: o.spot,
    weight: o.weight,
    reel: o.reel,
    skull: skullChance(cfg),
    miss: 0,
  };
  let sum = 0;
  for (const k of SLOT_OUTCOMES) sum += w[k];
  if (sum <= 1) w.miss = 1 - sum;
  else for (const k of SLOT_OUTCOMES) w[k] /= sum;
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

/**
 * Что показать на барабанах. Выигрыш — три одинаковых; «мимо» — никогда не три одинаковых, а часто
 * «чуть-чуть»: первые два совпали, третий нет (третий барабан у клиента крутится дольше — дразнит).
 */
export function reelsFor(outcome: SlotOutcome, rng: Rng): [SlotSymbol, SlotSymbol, SlotSymbol] {
  const t = TRIPLE[outcome];
  if (t) return [t, t, t];
  if (rng.chance(0.4)) {
    const pair = rng.pick(SLOT_SYMBOLS.slice(0, 9));
    const odd = rng.pick(SLOT_SYMBOLS.filter((s) => s !== pair));
    return [pair, pair, odd];
  }
  for (;;) {
    const r: [SlotSymbol, SlotSymbol, SlotSymbol] = [rng.pick(SLOT_SYMBOLS), rng.pick(SLOT_SYMBOLS), rng.pick(SLOT_SYMBOLS)];
    if (!(r[0] === r[1] && r[1] === r[2])) return r;
  }
}

/** Обратное: какой исход видно по барабанам (проверка, что показ честный). */
export function classifyReels(r: readonly SlotSymbol[]): SlotOutcome {
  if (r[0] === r[1] && r[1] === r[2]) {
    for (const k of SLOT_OUTCOMES) if (TRIPLE[k] === r[0]) return k;
  }
  return 'miss';
}

/** Первые два барабана совпали — третий крутится дольше (у клиента). */
export function isTease(r: readonly SlotSymbol[]): boolean {
  return r[0] === r[1];
}

/** Вращение: исход по весам сложности и символы под него. `forced` — заданный исход (обучение, тесты). */
export function rollSlot(cfg: GameConfig, rng: Rng, forced?: SlotOutcome): SlotSpin {
  const outcome = forced ?? rollOutcome(slotWeights(cfg), rng);
  return { outcome, reels: reelsFor(outcome, rng) };
}

/** Вращений за одну «Крутку». */
export const SLOT_SPINS = 3;
/** Ход «Крутки» от стоп-кадра (мс мира): автомат падает, потом окна вращений одно за другим. */
export const SLOT_DROP_MS = 400;
/** Окно каждого вращения: первое длиннее — успеть понять, что происходит. */
export const SLOT_WIN_MS: readonly number[] = [2500, 2100, 2100];
/** Через сколько от начала окна автомат дёргает рычаг сам. */
export const SLOT_AUTO_MS: readonly number[] = [700, 300, 300];
/**
 * Барабаны (от рывка): когда начинает тормозить каждый; при паре третий дразнит дольше. Торможение —
 * не дольше SLOT_BRAKE_MS. Всё влезает в окно вращения.
 */
export const SLOT_STOP_MS: readonly number[] = [250, 500, 750];
export const SLOT_TEASE_MS = 350;
export const SLOT_BRAKE_MS = 650;

/** Окно вращения k: с какого мига можно дёргать, когда автомат дёрнет сам, когда окно кончится. */
export function slotWindow(showAt: number, k: number): { from: number; auto: number; to: number } {
  let from = showAt + SLOT_DROP_MS;
  for (let i = 0; i < k; i++) from += SLOT_WIN_MS[i];
  return { from, auto: from + SLOT_AUTO_MS[k], to: from + SLOT_WIN_MS[k] };
}

/** Сколько стоит мир на «Крутке»: падение и все окна вращений (cfg.slotPauseMs должен быть не меньше). */
export const SLOT_PAUSE_NEED = SLOT_DROP_MS + SLOT_WIN_MS.reduce((a, b) => a + b, 0);

/**
 * Все вращения игрока на одной «Крутке». Череп вырезает — после него не крутят (на лёгкой он сжигает
 * звезду, и вращения идут дальше).
 */
export function rollSpins(cfg: GameConfig, rng: Rng, forced?: SlotOutcome): SlotSpin[] {
  const out: SlotSpin[] = [];
  for (let k = 0; k < SLOT_SPINS; k++) {
    const s = rollSlot(cfg, rng, forced);
    out.push(s);
    if (s.outcome === 'skull' && !cfg.kidsMode) break;
  }
  return out;
}

/** Что видно на поле после всех вращений: молния против гири (перевес), прожектор — если выпал хоть раз. */
export function visibleOf(outcomes: readonly SlotOutcome[]): { speed: 'bolt' | 'weight' | null; spot: boolean } {
  let d = 0;
  for (const o of outcomes) d += o === 'bolt' ? 1 : o === 'weight' ? -1 : 0;
  return { speed: d > 0 ? 'bolt' : d < 0 ? 'weight' : null, spot: outcomes.includes('spot') };
}

/** Статисту — столько же «вращений», сколько игроку: только видимые исходы с теми же шансами. */
export function botSlotEffects(cfg: GameConfig, rng: Rng): SlotOutcome[] {
  const out: SlotOutcome[] = [];
  for (let k = 0; k < SLOT_SPINS; k++) {
    const o = botSlotEffect(cfg, rng);
    if (o) out.push(o);
  }
  return out;
}

/** Что достаётся статисту на «Крутке»: видимые исходы с теми же шансами, что у игрока, иначе ничего. */
export function botSlotEffect(cfg: GameConfig, rng: Rng): SlotOutcome | null {
  const w = slotWeights(cfg);
  let r = rng.next();
  for (const k of SLOT_VISIBLE) {
    if (r < w[k]) return k;
    r -= w[k];
  }
  return null;
}

/** Исход ↔ индекс для сети. */
export function slotOutcomeIndex(o: SlotOutcome): number {
  return SLOT_OUTCOMES.indexOf(o);
}
export function slotOutcomeAt(i: number): SlotOutcome {
  return SLOT_OUTCOMES[i] ?? 'miss';
}
export function slotSymbolIndex(s: SlotSymbol): number {
  return SLOT_SYMBOLS.indexOf(s);
}
export function slotSymbolAt(i: number): SlotSymbol {
  return SLOT_SYMBOLS[i] ?? 'popcorn';
}

/**
 * Свои вращения на «Крутке» (MeView.slot): к какой «Крутке» (warnAt) и что выпало в каждом (их меньше
 * SLOT_SPINS, если вырезал череп). Знает только сам игрок.
 */
export interface SlotMine {
  at: number;
  spins: SlotSpin[];
}

/** Вращение в итогах дубля и в записи для клипа: чьё (сущность), к какой «Крутке» (warnAt), какое по счёту, что выпало. */
export interface SlotRecord {
  eid: number;
  at: number;
  /** Номер вращения в «Крутке», с 0 (в записях до трёх вращений — нет: 0). */
  n?: number;
  outcome: SlotOutcome;
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
}

/** Череп вырезал: вращение с черепом у этой сущности, после которого её выбили в `hitAt`. */
export function skullSpin(slots: readonly SlotRecord[] | undefined, eid: number, hitAt: number, cfg: GameConfig): SlotRecord | undefined {
  return slots?.find((s) => {
    if (s.eid !== eid || s.outcome !== 'skull') return false;
    const due = slotWindow(s.at + cfg.slotWarnMs, s.n ?? 0).to;
    return hitAt >= due && hitAt <= due + 200;
  });
}

/** С какого мига клип показывает гибель от черепов: окно того вращения (рывок, барабаны, три черепа). */
export function skullClipFrom(s: SlotRecord, cfg: GameConfig): number {
  return slotWindow(s.at + cfg.slotWarnMs, s.n ?? 0).from - 300;
}
