import { EFFECTS, STICKER_LIST, earnedEvents } from './shop';
import type { EarnId, EarnRound } from './shop';
import type { MatchSummary } from './match';
import { THEME_RULES } from './themes';
import type { ThemeId } from './themes';

/**
 * Личный эмодзи-пак игрока (решение владельца 28.11.2026): у каждого со связкой Telegram — свой набор custom
 * emoji `e<id>_by_<бот>`. В нём сразу 30 общих эмодзи (те же, что в наборе владельца для постов), а награды
 * докладываются за достижения: площадки, события матча, покупки. Ставить эмодзи в сообщения — Telegram Premium.
 *
 * Здесь — только правила: какие награды есть, за что и что уже открыто. Рисунки — apps/web/src/game/skins
 * (`post-emoji.ts` общие, `reward-emoji.ts` награды), набор собирает бот (apps/server/src/shop.ts).
 * У каждого эмодзи пака своё первое эмодзи: по нему бот узнаёт картинку в наборе (test/emoji-pack.test.ts).
 */

/** Общие эмодзи — в пак сразу (id файлов `apps/server/stickers/emoji/<id>`; порядок — порядок в паке). */
export const EMOJI_BASE: readonly { id: string; emoji: string }[] = [
  { id: 'camera', emoji: '📹' }, { id: 'rec', emoji: '🔴' }, { id: 'actor', emoji: '🧍' }, { id: 'stunned', emoji: '😵' },
  { id: 'popcorn', emoji: '🍿' }, { id: 'ticket', emoji: '🎟️' }, { id: 'fire', emoji: '🔥' }, { id: 'sparkles', emoji: '✨' },
  { id: 'bolt', emoji: '⚡' }, { id: 'eyes', emoji: '👀' }, { id: 'scissors', emoji: '✂️' }, { id: 'freeze', emoji: '❄️' },
  { id: 'crown', emoji: '👑' }, { id: 'medal', emoji: '🥇' }, { id: 'cinema', emoji: '🎦' }, { id: 'mic', emoji: '🎤' },
  { id: 'vhs', emoji: '📼' }, { id: 'banana', emoji: '🍌' }, { id: 'phone', emoji: '📱' }, { id: 'gift', emoji: '🎁' },
  { id: 'popper', emoji: '🎉' }, { id: 'heart', emoji: '❤️' }, { id: 'rocket', emoji: '🚀' }, { id: 'clock', emoji: '⏰' },
  { id: 'new', emoji: '🆕' }, { id: 'arrow', emoji: '👉' }, { id: 'check', emoji: '✅' }, { id: 'cross', emoji: '❌' },
  { id: 'question', emoji: '❓' }, { id: 'bang', emoji: '❗' },
];

export type RewardId =
  | 'th_caps' | 'th_chefs' | 'th_penguins' | 'th_cosmonauts' | 'th_office' | 'th_miami' | 'th_party' | 'th_kupala' | 'th_casino'
  | 'ev_clairvoyant' | 'ev_accuse' | 'ev_unsuspected' | 'ev_paranoid' | 'ev_stars' | 'ev_survive' | 'ev_cut' | 'ev_jackpot'
  | 'buy_kotBanan' | 'buy_effect';

export interface RewardMeta {
  id: RewardId;
  emoji: string;
  /** За что: дубль на площадке, событие матча или покупка. */
  theme?: ThemeId;
  event?: EarnId;
  buy?: 'kotBanan' | 'effect';
}

export const REWARDS: readonly RewardMeta[] = [
  { id: 'th_caps', emoji: '🧢', theme: 'caps' },
  { id: 'th_chefs', emoji: '🍳', theme: 'chefs' },
  { id: 'th_penguins', emoji: '🐧', theme: 'penguins' },
  { id: 'th_cosmonauts', emoji: '🪐', theme: 'cosmonauts' },
  { id: 'th_office', emoji: '☕', theme: 'office' },
  { id: 'th_miami', emoji: '🌴', theme: 'miami' },
  { id: 'th_party', emoji: '🪩', theme: 'party' },
  { id: 'th_kupala', emoji: '🌿', theme: 'kupala' },
  { id: 'th_casino', emoji: '🎲', theme: 'casino' },
  { id: 'ev_clairvoyant', emoji: '🔮', event: 'clairvoyant' },
  { id: 'ev_accuse', emoji: '🎯', event: 'accuse' },
  { id: 'ev_unsuspected', emoji: '🥸', event: 'unsuspected' },
  { id: 'ev_paranoid', emoji: '😱', event: 'paranoid' },
  { id: 'ev_stars', emoji: '💫', event: 'stars' },
  { id: 'ev_survive', emoji: '🛡️', event: 'survive' },
  { id: 'ev_cut', emoji: '🩹', event: 'cut' },
  { id: 'ev_jackpot', emoji: '🪙', event: 'jackpot' },
  { id: 'buy_kotBanan', emoji: '🐱', buy: 'kotBanan' },
  { id: 'buy_effect', emoji: '🎨', buy: 'effect' },
];

export const REWARD_IDS: readonly RewardId[] = REWARDS.map((r) => r.id);
export const isRewardId = (x: unknown): x is RewardId => REWARD_IDS.includes(x as RewardId);

/** Отметки в учёте гардероба (`ShopUser.items`): игрок забрал пак; награда открыта; эмодзи уже в наборе. */
export const EMOJI_PACK = 'epack';
export const rewardMark = (id: RewardId) => `em:${id}`;
export const emojiIssued = (id: string) => `ei:${id}`;

/** Награды за матч: площадки, на которых был дубль, и события игрока (те же, что открывают стикеры). */
export function earnedRewards(pid: string, rounds: EarnRound[], match: Pick<MatchSummary, 'winners'>): RewardId[] {
  const ev = earnedEvents(pid, rounds, match);
  if (!ev.size) return [];
  const themes = new Set(rounds.filter((r) => r.theme !== undefined).map((r) => THEME_RULES[r.theme!]?.id));
  return REWARDS.filter((r) => (r.theme ? themes.has(r.theme) : r.event ? ev.has(r.event) : false)).map((r) => r.id);
}

/**
 * Открытые награды. Кроме своих отметок (`em:`) засчитываем и то, что было до пака: открытые в матчах стикеры
 * той же площадки или того же события, покупки, выбитые 777 из счётчиков значков.
 */
export function openRewards(items: readonly string[], jackpots = 0): RewardId[] {
  const has = new Set(items);
  const stickerFor = (r: RewardMeta) =>
    STICKER_LIST.some((s) => has.has(`st:${s.id}`) && (r.theme ? s.earn === 'theme' && s.theme === r.theme : !!r.event && s.earn === r.event));
  return REWARDS.filter((r) => {
    if (has.has(rewardMark(r.id))) return true;
    if (r.buy === 'kotBanan') return has.has('kotBanan');
    if (r.buy === 'effect') return EFFECTS.some((f) => has.has(f));
    if (r.event === 'jackpot' && jackpots > 0) return true;
    return stickerFor(r);
  }).map((r) => r.id);
}

/** Что должно быть в личном паке: общие и открытые награды (id и эмодзи, по порядку). */
export function emojiWanted(items: readonly string[], jackpots = 0): { id: string; emoji: string }[] {
  if (!items.includes(EMOJI_PACK)) return [];
  const open = new Set(openRewards(items, jackpots));
  return [...EMOJI_BASE, ...REWARDS.filter((r) => open.has(r.id))];
}
