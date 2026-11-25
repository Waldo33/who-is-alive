import type { GameConfig } from './config';
import { TICK_MS } from './config';
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

/** Стоп-кадр «Тсс!» Лешего (а не обычная команда): длинный, без голосования, на «замри»; с watchUntil он ещё и смотрит. */
export function isLeshyCrowd(cfg: GameConfig, c: { kind: string; vote?: boolean; showAt: number; resumeAt: number; watchUntil?: number }): boolean {
  return !c.vote && c.kind === 'freeze' && (c.watchUntil !== undefined || c.resumeAt - c.showAt >= cfg.leshyPauseMs - TICK_MS);
}

/** Как в события crowd: время команды (warnAt = at), окна и сколько Леший смотрит. */
interface CrowdEv {
  t: 'crowd';
  kind: string;
  at: number;
  showAt: number;
  resumeAt: number;
  windowEnd: number;
  vote?: boolean;
  watchUntil?: number;
}

/** Смерть игрока в «Купальской ночи» по журналу: забрал Леший (при каком его «Тсс!») или сгинул в тумане. */
export interface NightDeath {
  target: number;
  at: number;
  x: number;
  y: number;
  /** warnAt «Тсс!» Лешего, при котором он забрал; нет — рассудок или кикимора. */
  leshy?: number;
  /** Когда Леший вышел на поляну (showAt его стоп-кадра). */
  showAt?: number;
}

/**
 * Смерти игроков не от рук игроков (kills — кто кого выбил, из итогов дубля) в теме с рассудком: удар Лешего — после окна его «Тсс!»
 * (приговор — в watchUntil или windowEnd + запас на сеть 600 мс; ещё секунда — запас), остальные — туман.
 * Только по журналу мира: клип, фильм и повтор знают это без новых сообщений.
 */
export function nightDeaths(cfg: GameConfig, log: readonly { t: string; at: number }[], kills?: readonly { victim: number; at: number }[]): NightDeath[] {
  const out: NightDeath[] = [];
  let lc: CrowdEv | null = null;
  for (const raw of log) {
    if (raw.t === 'crowd') {
      const c = raw as CrowdEv;
      lc = isLeshyCrowd(cfg, c) ? c : null;
      continue;
    }
    if (raw.t !== 'hit') continue;
    const ev = raw as { t: 'hit'; target: number; result: string; attacker?: number; x: number; y: number; at: number };
    // удар игрока по игроку в журнале тоже без нападавшего (тайна) — его знают итоги дубля (kills)
    if (ev.result !== 'player' || ev.attacker !== undefined || kills?.some((k) => k.victim === ev.target)) continue;
    const leshy = !!lc && ev.at > lc.windowEnd && ev.at <= (lc.watchUntil ?? lc.windowEnd + 600) + 1000;
    out.push({ target: ev.target, at: ev.at, x: ev.x, y: ev.y, ...(leshy ? { leshy: lc!.at, showAt: lc!.showAt } : {}) });
  }
  return out;
}

/**
 * Отчего погиб игрок eid в миг at («Купальская ночь»): 'leshy' — забрал Леший; 'mist' — туман (только если
 * kills из итогов дубля известны: иначе удар игрока от тумана по журналу не отличить); undefined — не ночь.
 */
export function nightCause(cfg: GameConfig, log: readonly { t: string; at: number }[], eid: number, at: number, kills?: readonly { victim: number; at: number }[]): 'leshy' | 'mist' | undefined {
  const d = nightDeaths(cfg, log, kills).find((x) => x.target === eid && x.at === at);
  if (!d) return undefined;
  return d.leshy !== undefined ? 'leshy' : kills ? 'mist' : undefined;
}
