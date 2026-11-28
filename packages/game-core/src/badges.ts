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
export type PlayBadgeId = 'onSet' | 'star' | 'director' | 'reel' | 'oscar';
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
}

export const NO_STATS: BadgeStats = { matches: 0, wins: 0, rooms: 0, lastWin: null };

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
];

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
}
