import type { GameConfig } from './config';
import { hasSanity } from './themes';

/**
 * Рассудок («Купальская ночь», themes.ts › sanity). Шкала 0–100 у каждого живого игрока, у ботов её нет.
 * Падает сам — тем быстрее, чем темнее ночь; в толпе медленнее, у костра (пока он горит) растёт.
 * Разом: цветок +, верный жест толпы +, промах по боту −, не повторил жест −, рядом кого-то вырезали −.
 * На нуле игрок вырезан («потерялся в тумане»), в детском режиме — нет.
 *
 * Значение знает только сам игрок (личное сообщение `me`): по нему видно, что игрок живой.
 */

/** Стадии: 0 «Ясно», 1 «Шёпот», 2 «Морок», 3 «Кошмар». */
export type SanityStage = 0 | 1 | 2 | 3;

export function sanityStage(cfg: GameConfig, v: number): SanityStage {
  const [a, b, c] = cfg.sanityStages;
  return v > a ? 0 : v > b ? 1 : v > c ? 2 : 3;
}

/** Базовое падение, ед./с, через `sec` секунд дубля: сумерки → ночь → глухая ночь. */
export function sanityDrain(cfg: GameConfig, sec: number): number {
  const at = cfg.sanityDrainAtSec;
  const r = cfg.sanityDrainRate;
  for (let i = 0; i < at.length; i++) if (sec < at[i]) return r[i];
  return r[r.length - 1];
}

/** Насколько темно через `sec` секунд дубля: 0 — светлые сумерки, 1 — глухая ночь (плавно). */
export function nightLevel(cfg: GameConfig, sec: number): number {
  return Math.max(0, Math.min(1, sec / cfg.sanityNightSec));
}

/**
 * Длина дубля по плану, с. В теме с рассудком таймера нет: ночь идёт, пока в живых не останется один,
 * `nightMaxSec` — только потолок на всякий случай (тогда к концу сужается изгородь).
 */
export function playLenSec(cfg: GameConfig, theme: number): number {
  return hasSanity(theme) ? cfg.nightMaxSec : cfg.roundSec;
}

/**
 * Леший проходит мимо: на какой секунде «часов дубля» (playLenSec − осталось, без пауз стоп-кадров) он над
 * лугом — тогда ядро даёт команду «Тсс!». За `leshyLeadSec` до этого у всех слышны его шаги. Зависит
 * только от номера дубля, поэтому клиент знает это сам — без новых сообщений по сети.
 */
export function leshySec(round: number): number {
  return 34 + ((round * 5) % 4) * 4;
}

/** Горит ли костёр (и сколько от него осталось, 0–1): к глухой ночи прогорает. */
export function fireLevel(cfg: GameConfig, sec: number): number {
  const out = cfg.sanityFireOutSec;
  return Math.max(0, Math.min(1, (out - sec) / 10));
}
