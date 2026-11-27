import type { Dict } from './locale';
import type { MatchSummary, RoundSummary } from './match';

/**
 * Гардероб (за флагом shop): наборы за звёзды Telegram и стикеры к ним. Только данные — рисует стикеры
 * `apps/web/src/game/skins/stickers.ts`, выдаёт бот (`apps/server/src/shop.ts`).
 */
export type ShopItemId = keyof Dict['shop']['items'];
export type StickerId = keyof Dict['shop']['stickers'];
/** `starter` — бесплатный пак с обычным актёром (после первого матча); остальные — наборы гардероба. */
export type StickerSet = 'starter' | ShopItemId;

export interface ShopItem {
  id: ShopItemId;
  /** Цена в звёздах Telegram (XTR). */
  stars: number;
  /** Зачёркнутая «старая» цена на витрине. */
  was?: number;
  /** Ярлык «НОВОЕ» на витрине и точка на ячейке в списке. */
  isNew?: boolean;
}

export const SHOP_ITEMS: ShopItem[] = [{ id: 'kotBanan', stars: 199, was: 275, isNew: true }];

export interface StickerMeta {
  id: StickerId;
  set: StickerSet;
  /** Эмодзи стикера (поиск в Telegram), 1–3 шт. */
  emoji: string[];
  /** Выдаётся сразу (стартовый пак — весь; набор — первые два, остальные — за события в матче, `earn`). */
  now: boolean;
  /** За что открывается в матче (если не `now`). */
  earn?: EarnId;
}

/**
 * События матча, за которые открываются стикеры. Считает сервер по итогам дублей (то же видят все после
 * разоблачения), телефон ничего не присылает. Стикеры дают и за неудачи — новичок получает их с первого вечера.
 */
export type EarnId =
  /** Вырезан хотя бы в одном дубле. */
  | 'cut'
  /** «Параноик»: два удара мимо (по ботам) в одном дубле. */
  | 'paranoid'
  /** Победа в матче (и ничья на первом месте). */
  | 'win'
  /** Матч сыгран, но не первое место. */
  | 'lose'
  /** «Чистая массовка»: дожил до конца дубля вне подозрений. */
  | 'unsuspected'
  /** Угадал актёра меткой «?» из-за кадра. */
  | 'clairvoyant';

/** Порядок — порядок в паке. Индексы не уходят в сеть: стикер называют по id. */
export const STICKER_LIST: StickerMeta[] = [
  { id: 'hi', set: 'starter', emoji: ['👋'], now: true },
  { id: 'dance', set: 'starter', emoji: ['💃', '🕺'], now: true },
  { id: 'oops', set: 'starter', emoji: ['😵', '💫'], now: true },
  { id: 'who', set: 'starter', emoji: ['🤨', '👀'], now: true },
  { id: 'notCrying', set: 'kotBanan', emoji: ['😭'], now: true },
  { id: 'justBanana', set: 'kotBanan', emoji: ['🍌', '😅'], now: true },
  { id: 'splat', set: 'kotBanan', emoji: ['🫠', '💫'], now: false, earn: 'cut' },
  { id: 'allGood', set: 'kotBanan', emoji: ['🌧', '🙂'], now: false, earn: 'lose' },
  { id: 'aaa', set: 'kotBanan', emoji: ['😱', '😭'], now: false, earn: 'paranoid' },
  { id: 'happyTears', set: 'kotBanan', emoji: ['🥲', '👑'], now: false, earn: 'win' },
  { id: 'freeze', set: 'kotBanan', emoji: ['🥶', '🧊'], now: false, earn: 'unsuspected' },
  { id: 'meow', set: 'kotBanan', emoji: ['🐱', '❓'], now: false, earn: 'clairvoyant' },
];

export const shopItem = (id: unknown): ShopItem | undefined => SHOP_ITEMS.find((x) => x.id === id);
export const isStickerId = (id: unknown): id is StickerId => STICKER_LIST.some((s) => s.id === id);

/** Итоги дубля, которых хватает для `earnedEvents` (RoundSummary целиком или запись матча). */
export type EarnRound = Pick<RoundSummary, 'reveal' | 'awards' | 'accusations'>;

/** Какие события матча случились с игроком `pid`. */
export function earnedEvents(pid: string, rounds: EarnRound[], match: Pick<MatchSummary, 'winners'>): Set<EarnId> {
  const out = new Set<EarnId>();
  if (!rounds.some((r) => r.reveal.some((x) => x.pid === pid))) return out;
  out.add(match.winners.includes(pid) ? 'win' : 'lose');
  for (const r of rounds) {
    if (r.reveal.some((x) => x.pid === pid && !x.alive)) out.add('cut');
    if (r.accusations.some((a) => a.pid === pid && a.correct)) out.add('clairvoyant');
    for (const a of r.awards) {
      if (!a.pids.includes(pid)) continue;
      if (a.id === 'paranoid') out.add('paranoid');
      if (a.id === 'botlike') out.add('unsuspected');
    }
  }
  return out;
}

/** Стикеры, которые открывает матч игроку `pid` (все наборы; что из них положено — решает бот по покупкам). */
export function earnedStickers(pid: string, rounds: EarnRound[], match: Pick<MatchSummary, 'winners'>): StickerId[] {
  const ev = earnedEvents(pid, rounds, match);
  return STICKER_LIST.filter((s) => s.earn && ev.has(s.earn)).map((s) => s.id);
}
