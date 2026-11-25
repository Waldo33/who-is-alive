import type { Dir } from './events';
import { WALK_TOP } from './arena';

/**
 * Шеф в офисе (themes.ts › twist.boss, решение владельца): ходит по офису с обходом,
 * останавливается и смотрит в одну сторону — кто в конусе взгляда шевелится, тому «выговор»
 * (метка на виду у всех и минус удары на подвал). Шеф ушёл за дверь — начался подвал, вернулся — офис.
 *
 * Состояние шефа — часть мира (World.boss): его шаги и взгляд приходят событиями `boss`,
 * одинаково у хоста, гостей и в повторе. Шеф — не сущность: не бьётся, не берёт звёзд.
 * Ловит и ботов (не все успевают «заработаться»), поэтому выговор — улика, а не указатель.
 */

/** Дверь шефа: середина верхней стены офиса (ноги — на полу перед стеной). */
export function bossDoor(arenaW: number): { x: number; y: number } {
  return { x: Math.round(arenaW / 2), y: WALK_TOP + 1 };
}

/** Взгляд: с `from` конус «горит» (до того шеф поворачивается — успей замереть), до `until`. */
export interface BossLook {
  dir: Dir;
  from: number;
  until: number;
}

export interface BossState {
  x: number;
  y: number;
  /** Позиция на прошлом шаге — для плавной отрисовки. */
  px: number;
  py: number;
  /** Путь по клеткам навигации (как у сущностей). */
  path: number[];
  pi: number;
  dir: Dir;
  /** Пройдено — фаза шага в анимации. */
  walk: number;
  moving: boolean;
  look: BossLook | null;
  /** Шеф за дверью (подвал) — его не видно. */
  out: boolean;
  /** Когда шеф последний раз вошёл или вышел в дверь — для анимации двери (в старых записях нет). */
  door?: number;
  /** Когда шеф собирается вернуться из кабинета (полоска под дверью мигает заранее). */
  back?: number;
  /** На кого и когда шеф последний раз указал рукавом (выговор или ложная тревога). */
  point?: { eid: number; at: number };
}

/** Второй выговор за дубль обнуляет удары подвала; до того каждый — минус `penalty`. */
export function bossFightLeft(left: number, reprimands: number, penalty: number, zeroAt: number): number {
  return reprimands >= zeroAt ? 0 : Math.max(0, left - penalty);
}

/** Дальность взгляда шефа и ширина конуса (на дальнем краю — в стороны на `along * BOSS_SPREAD`). */
export const BOSS_RANGE = 62;
export const BOSS_SPREAD = 0.75;
/** Шеф ходит медленнее толпы — вальяжно. */
export const BOSS_SPEED_MUL = 0.75;

/** Точка (x, y) — в конусе взгляда (геометрия, без времени). */
export function inBossCone(b: { x: number; y: number }, dir: Dir, x: number, y: number): boolean {
  const dx = x - b.x;
  const dy = y - b.y;
  // вдоль взгляда и поперёк; вверх/вниз по полю — тот же конус
  const along = dir === 0 ? dy : dir === 1 ? -dy : dir === 2 ? -dx : dx;
  const side = dir === 0 || dir === 1 ? dx : dy;
  if (along < 2 || along > BOSS_RANGE) return false;
  return Math.abs(side) <= 5 + along * BOSS_SPREAD;
}

/** Шеф сейчас смотрит и конус уже «горит». */
export function bossWatching(b: BossState | null, t: number): b is BossState & { look: BossLook } {
  return !!b && !b.out && !!b.look && t >= b.look.from && t < b.look.until;
}

/** Шеф поворачивается или смотрит (с предупреждения до конца взгляда). */
export function bossLooking(b: BossState | null, t: number): b is BossState & { look: BossLook } {
  return !!b && !b.out && !!b.look && t < b.look.until;
}

/**
 * Путь сущности из (x, y) по точкам `pts` (пути навигации — отрезки между опорными клетками)
 * заходит в конус взгляда: проверяем с шагом в 3 пикселя.
 */
export function pathInBossCone(b: { x: number; y: number }, dir: Dir, x: number, y: number, pts: readonly { x: number; y: number }[]): boolean {
  let ax = x;
  let ay = y;
  if (inBossCone(b, dir, ax, ay)) return true;
  for (const p of pts) {
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - ax, p.y - ay) / 3));
    for (let i = 1; i <= n; i++) if (inBossCone(b, dir, ax + ((p.x - ax) * i) / n, ay + ((p.y - ay) * i) / n)) return true;
    ax = p.x;
    ay = p.y;
  }
  return false;
}
