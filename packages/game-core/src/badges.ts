import { SKINS } from './shop';
import type { SkinId } from './shop';

/**
 * Значки для эмодзи-статуса Telegram (решение владельца 27.11.2026): игра выдаёт значок за игру или покупку,
 * игрок ставит его себе в статус из Mini App (`WebApp.setEmojiStatus`, Telegram Premium). Значки — один общий
 * набор эмодзи у бота (`apps/server/src/badges.ts`), картинки — `apps/web/src/game/skins/badges.ts`.
 * Скопировать эмодзи в Telegram может любой, поэтому «настоящий» значок — тот, что выдала игра.
 *
 * Счёт ведёт игровой сервер по связке «игрок ↔ Telegram» (`tg_stats`); здесь — только правила.
 */
export type PlayBadgeId = 'onSet' | 'star' | 'director' | 'reel' | 'oscar' | 'jackpot' | 'skulls';
export type BadgeId = PlayBadgeId | SkinId;

/** Счётчики игрока Telegram (`tg_stats`). */
export interface BadgeStats {
  /** Сыгранных матчей. */
  matches: number;
  /** Побед в матче (ничья — победа каждого из лидеров). */
  wins: number;
  /** Комнат, которые игрок собрал режиссёром и где матч сыграли не меньше `DIRECTOR_HUMANS` живых людей. */
  rooms: number;
  /** Последняя победа, мс; нет — null. */
  lastWin: number | null;
  /** Сколько раз выбил 777 в «Крутке» (площадка «Казино», slots.ts). */
  jackpots: number;
  /** Сколько раз выбил череп в «Крутке». */
  skulls: number;
}

export const NO_STATS: BadgeStats = { matches: 0, wins: 0, rooms: 0, lastWin: null, jackpots: 0, skulls: 0 };

/** «Звезда дубля» держится сутки после победы (и в статусе — на столько же). */
export const STAR_MS = 24 * 3600_000;
/** «Режиссёр»: в комнате — не меньше четырёх живых игроков (ИИ-актёры не считаются). */
export const DIRECTOR_HUMANS = 4;

interface PlayBadge {
  id: PlayBadgeId;
  /** Эмодзи значка в наборе Telegram (по нему бот находит свой значок в наборе). */
  emoji: string;
  /** Чего и сколько нужно. */
  of: number;
  count: (s: BadgeStats) => number;
}

export const PLAY_BADGES: readonly PlayBadge[] = [
  { id: 'onSet', emoji: '🎬', of: 1, count: (s) => s.matches },
  { id: 'star', emoji: '⭐', of: 1, count: (s) => s.wins },
  { id: 'director', emoji: '📣', of: 10, count: (s) => s.rooms },
  { id: 'reel', emoji: '🎥', of: 50, count: (s) => s.matches },
  { id: 'oscar', emoji: '🏆', of: 100, count: (s) => s.wins },
  // «Казино» (решение владельца 28.11.2026): значки-слоты, в статусе — анимация барабанов
  { id: 'jackpot', emoji: '🎰', of: 1, count: (s) => s.jackpots },
  { id: 'skulls', emoji: '💀', of: 1, count: (s) => s.skulls },
];

/** Значки с анимацией (видео-эмодзи): блик на звезде, автомат крутит барабаны. Картинки — `skins/badges.ts`, `skins/badge-slots.ts`. */
export const ANIMATED_BADGES: readonly BadgeId[] = ['star', 'jackpot', 'skulls'];

/**
 * Что выбил игрок в «Крутках» матча: по итогам дублей (вращения — по сущности, `reveal` связывает её с игроком).
 * Считаются вращения, а не «Крутки»: 777 во втором вращении той же «Крутки» — тоже джекпот.
 */
export function slotHits(rounds: readonly { reveal: readonly { pid: string; eid: number }[]; slots?: readonly { eid: number; outcome: string }[] }[], pid: string): { jackpots: number; skulls: number } {
  let jackpots = 0;
  let skulls = 0;
  for (const r of rounds) {
    const eid = r.reveal.find((x) => x.pid === pid)?.eid;
    if (eid === undefined) continue;
    for (const s of r.slots ?? []) {
      if (s.eid !== eid) continue;
      if (s.outcome === 'seven') jackpots++;
      if (s.outcome === 'skull') skulls++;
    }
  }
  return { jackpots, skulls };
}

/** Эмодзи значков скинов (голова скина). */
export const SKIN_BADGE_EMOJI: Record<SkinId, string> = { kotBanan: '🍌' };

export const BADGE_IDS: readonly BadgeId[] = [...PLAY_BADGES.map((b) => b.id), ...SKINS];
export const isBadgeId = (x: unknown): x is BadgeId => BADGE_IDS.includes(x as BadgeId);
export const badgeEmoji = (id: BadgeId): string => PLAY_BADGES.find((b) => b.id === id)?.emoji ?? SKIN_BADGE_EMOJI[id as SkinId];

export interface BadgeState {
  id: BadgeId;
  /** Заработан (можно ставить в статус). */
  have: boolean;
  /** Прогресс: n из of (у скинов — 0/1 или 1/1). */
  n: number;
  of: number;
  /** До какого времени значок держится (мс) — у «Звезды дубля»; иначе null. */
  until: number | null;
}

/** Значки игрока по счётчикам и покупкам (`items` из учёта гардероба). */
export function badgesOf(stats: BadgeStats, items: readonly string[], now: number): BadgeState[] {
  const play = PLAY_BADGES.map((b): BadgeState => {
    if (b.id === 'star') {
      const until = stats.lastWin !== null && now - stats.lastWin < STAR_MS ? stats.lastWin + STAR_MS : null;
      return { id: b.id, have: until !== null, n: until !== null ? 1 : 0, of: 1, until };
    }
    const n = Math.min(b.of, Math.max(0, b.count(stats)));
    return { id: b.id, have: n >= b.of, n, of: b.of, until: null };
  });
  const skins = SKINS.map((id): BadgeState => ({ id, have: items.includes(id), n: items.includes(id) ? 1 : 0, of: 1, until: null }));
  return [...play, ...skins];
}

/** Что прибавить к счётчикам игрока после матча. */
export interface StatsDelta {
  matches: number;
  wins: number;
  rooms: number;
  /** Победил в этом матче — время победы (мс). */
  winAt: number | null;
  /** 777 и черепа в «Крутках» матча (нет — 0; старые вызовы не шлют). */
  jackpots?: number;
  skulls?: number;
}
