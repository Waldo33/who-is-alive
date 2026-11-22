import { AiPlayer } from './ai';
import { makeConfig } from './config';
import { MatchSim } from './match';
import { Rng } from './rng';
import { THEME_COUNT } from './themes';
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

function attempt(n: number, k: number): DailyPuzzle | null {
  const rng = new Rng(n * 7_919 + k * 104_729 + 17);
  const theme = rng.int(0, THEME_COUNT - 1);
  // без «Условий съёмки», без сужения в окне просмотра, дубль не кончается раньше времени
  const cfg = makeConfig({ fixedTheme: theme, roundMods: false, endWhenLastAlive: false, countdownSec: 1, roundSec: 75 });
  const sim = new MatchSim(cfg, [{ pid: 'actor', name: 'actor', color: 0 }], rng.int(1, 2 ** 30), 'actor');
  sim.addAgent(new AiPlayer('actor', rng.int(1, 2 ** 30)));
  while (sim.phase !== 'play') sim.tick();
  const from = sim.world.time + 1500;
  const to = from + DAILY_WATCH_MS;
  let crowd = false;
  sim.world.listeners.push((ev) => {
    if (ev.t === 'crowd' && ev.showAt >= from && ev.windowEnd <= to) crowd = true;
  });
  while (sim.world.time < to + 100) {
    sim.tick();
    if (sim.phase !== 'play') return null; // дубль кончился раньше (три звезды) — другая попытка
  }
  const me = sim.playerRound('actor');
  if (!me || !me.alive || !crowd) return null; // без «Море волнуется» загадка слишком сложная
  return { n, theme: sim.theme, world: sim.world, from, to, answer: me.eid, sim };
}

/** Загадка №n: одна и та же у всех. Перебирает варианты, пока не выйдет честный дубль. */
export function buildDaily(n: number): DailyPuzzle {
  for (let k = 0; k < 20; k++) {
    const p = attempt(n, k);
    if (p) return p;
  }
  throw new Error('daily: no puzzle');
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
