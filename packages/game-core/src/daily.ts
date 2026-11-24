import { AiPlayer } from './ai';
import type { AiPersona } from './ai';
import { makeConfig } from './config';
import { MatchSim } from './match';
import { Rng } from './rng';
import { ROTATION_THEMES } from './themes';
import type { World } from './world';

/**
 * Загадка дня «Найди живого»: каждый день у всех один и тот же короткий дубль — толпа ботов и
 * один живой (за него играет ИИ-игрок со «человеческими» ошибками). Смотришь ~20 с, потом
 * тапаешь, кто живой; три попытки. Всё детерминировано от номера дня — сервер не нужен.
 *
 * Номер дня — по календарной дате игрока (YYYY-MM-DD), первая загадка — 23.11.2026.
 */

const EPOCH = Date.UTC(2026, 10, 23);
/** Сколько секунд смотреть. */
export const DAILY_WATCH_MS = 20_000;
/** Сколько попыток. */
export const DAILY_TRIES = 3;

export interface DailyPuzzle {
  /** Номер загадки (1 — 23.11.2026). */
  n: number;
  theme: number;
  /** Мир дубля с журналом и ключевыми кадрами: смотреть — makeReplay(world, from, to). */
  world: World;
  from: number;
  to: number;
  /** Сущность живого игрока — ответ. */
  answer: number;
  sim: MatchSim;
}

/** Номер загадки по локальной дате «YYYY-MM-DD». */
export function dailyNumber(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - EPOCH) / 86_400_000) + 1;
}

/** Локальная дата игрока «YYYY-MM-DD». */
export function localDateKey(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Живой в загадке — «неуклюжий» игрок: чаще опаздывает на команды и тянется к звёздам, редко бьёт.
 * Так у него есть приметы, которые можно заметить за 20 секунд.
 */
const ACTOR: AiPersona = { lateChance: 0.5, greed: 0.8, aggression: 0.15 };

function attempt(n: number, k: number): DailyPuzzle | null {
  const rng = new Rng(n * 7_919 + k * 104_729 + 17);
  const theme = ROTATION_THEMES[rng.int(0, ROTATION_THEMES.length - 1)];
  // без «Условий съёмки», без сужения в окне просмотра, дубль не кончается раньше времени
  const cfg = makeConfig({ fixedTheme: theme, roundMods: false, endWhenLastAlive: false, countdownSec: 1, roundSec: 75 });
  const sim = new MatchSim(cfg, [{ pid: 'actor', name: 'actor', color: 0 }], rng.int(1, 2 ** 30), 'actor');
  sim.addAgent(new AiPlayer('actor', rng.int(1, 2 ** 30), ACTOR));
  while (sim.phase !== 'play') sim.tick();
  const from = sim.world.time + 1500;
  const to = from + DAILY_WATCH_MS;
  const eid = sim.playerRound('actor')?.eid ?? -1;
  let crowd = false;
  let tells = 0;
  sim.world.listeners.push((ev) => {
    const at = sim.world.time;
    if (at < from || at > to) return;
    if (ev.t === 'crowd' && ev.showAt >= from && ev.windowEnd <= to) crowd = true;
    // приметы живого, которые видно глазами: взял звезду, попал в прожектор режиссёра
    if (ev.t === 'star_taken' && ev.eid === eid) tells++;
    if (ev.t === 'spot') {
      const e = sim.world.entities.find((x) => x.eid === eid);
      if (e && Math.hypot(e.x - ev.x, e.y - ev.y) <= ev.r) tells++;
    }
  });
  while (sim.world.time < to + 100) {
    sim.tick();
    if (sim.phase !== 'play') return null; // дубль кончился раньше (три звезды) — другая попытка
  }
  const me = sim.playerRound('actor');
  // без «Море волнуется» и без явной приметы живого загадка нечестная — ищем другой дубль
  if (!me || !me.alive || !crowd || tells < (k < 30 ? 2 : 1)) return null;
  return { n, theme: sim.theme, world: sim.world, from, to, answer: me.eid, sim };
}

/** Загадка №n: одна и та же у всех. Перебирает варианты, пока не выйдет честный дубль. */
export function buildDaily(n: number): DailyPuzzle {
  for (let k = 0; k < 60; k++) {
    const p = attempt(n, k);
    if (p) return p;
  }
  throw new Error('daily: no puzzle');
}

export interface HintRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Подсказка после промаха — часть поля, где стоит живой: после первого промаха половина
 * (верх или низ), после второго — четверть. Сетка фиксированная, чтобы подсказка не выдавала точку.
 */
export function dailyHint(arena: { width: number; height: number }, x: number, y: number, misses: number): HintRect | null {
  if (misses <= 0) return null;
  const hh = Math.floor(arena.height / 2);
  const top = y < hh ? 0 : hh;
  if (misses === 1) return { x: 0, y: top, w: arena.width, h: arena.height - hh };
  const hw = Math.floor(arena.width / 2);
  return { x: x < hw ? 0 : hw, y: top, w: arena.width - hw, h: arena.height - hh };
}

/** Квадратики результата: 🟥 мимо, 🟩 нашёл, ⬜ не понадобилась. */
export function dailySquares(tries: number, won: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < DAILY_TRIES; i++) {
    if (i < tries - (won ? 1 : 0)) out.push('🟥');
    else if (won && i === tries - 1) out.push('🟩');
    else out.push('⬜');
  }
  return out.join('');
}
