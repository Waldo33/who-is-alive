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
 * Длина дубля по плану, с. В теме с рассудком таймера нет: ночь идёт, пока не сгинут все,
 * `nightMaxSec` — только потолок на всякий случай (тогда к концу сужается изгородь).
 */
export function playLenSec(cfg: GameConfig, theme: number): number {
  return hasSanity(theme) ? cfg.nightMaxSec : cfg.roundSec;
}

/**
 * С этой секунды ночи — охота: Леший приходит каждые 14–18 с и забирает ближайшего, даже замершего.
 * Ночь кончается, только когда сгинут все; так у самого стойкого она кончится не позже ~3,5 минут.
 */
export const LESHY_HUNT_SEC = 140;

/** Один приход Лешего: на какой секунде «часов дубля» шаги ближе всего; real — выйдет ли он на поляну. */
export interface LeshyVisit {
  sec: number;
  real: boolean;
}

/** Целочисленный хеш 0–1 (одинаковый в любом движке JS — без Math.sin). */
function ih(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/**
 * Приходы Лешего за ночь (секунды «часов дубля»: playLenSec − осталось, без пауз стоп-кадров). Каждый раз за
 * `leshyLeadSec` до `sec` у всех слышны шаги, перед `sec` — тишина; real — он выходит, ядро даёт его «Тсс!»,
 * иначе шаги уходят (ложная тревога: не знаешь, выйдет ли). Две ложные подряд не бывает, к концу ночи
 * приходы чаще. Зависит только от номера дубля — клиент знает это сам, без новых сообщений по сети.
 */
export function leshyVisits(round: number): LeshyVisit[] {
  const out: LeshyVisit[] = [];
  let sec = 24 + Math.floor(ih(round, 1) * 8);
  // ночь идёт до последнего (никто не выживает): приходы до самого потолка, к глухой ночи — чаще,
  // а с охоты (LESHY_HUNT_SEC) ложных уже нет
  for (let i = 0; i < 24 && sec < 295; i++) {
    const r = ih(round, 10 + i);
    // первый — чаще ложный, дальше — чаще настоящий; две ложные подряд не бывает
    const real = sec >= LESHY_HUNT_SEC || (i === 0 ? r < 0.35 : out[i - 1].real ? r < 0.55 : true);
    out.push({ sec, real });
    sec += (sec >= LESHY_HUNT_SEC ? 14 : Math.max(22, 34 - i * 2)) + Math.floor(ih(round, 30 + i) * (sec >= LESHY_HUNT_SEC ? 5 : 8));
  }
  return out;
}

/**
 * Где Леший встаёт на поляне в свой стоп-кадр (warnAt — время его команды): посреди поля, чуть в сторону
 * того края, к которому уйдёт. Ядро бьёт ближайшего к этой точке, сцена рисует его здесь же.
 */
export function leshySpot(warnAt: number, arenaW: number): { x: number; y: number; dir: 1 | -1 } {
  const dir = Math.floor(warnAt / 50) % 2 ? 1 : -1;
  return { x: Math.round(arenaW / 2) + dir * 10, y: 176, dir };
}

/** Первый настоящий приход Лешего (секунда «часов дубля»). */
export function leshySec(round: number): number {
  return leshyVisits(round).find((v) => v.real)!.sec;
}

/** Горит ли костёр (и сколько от него осталось, 0–1): к глухой ночи прогорает. */
export function fireLevel(cfg: GameConfig, sec: number): number {
  const out = cfg.sanityFireOutSec;
  return Math.max(0, Math.min(1, (out - sec) / 10));
}
