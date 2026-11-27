import type { Dict } from './locale';

/**
 * Гардероб (за флагом shop): наборы за звёзды Telegram и стикеры к ним. Только данные — рисует стикеры
 * `apps/web/src/game/skins/stickers.ts`, выдаёт бот (`apps/server/src/shop.ts`).
 */
export type ShopItemId = keyof Dict['shop']['items'];
export type StickerId = keyof Dict['shop']['stickers'];
/**
 * `starter` — бесплатный пак с обычным актёром (после первого матча); `play` — бесплатные «за игру»:
 * открываются в матчах (выдачу за события матча делает связка с Telegram); остальные — наборы гардероба.
 */
export type StickerSet = 'starter' | 'play' | ShopItemId;

export interface ShopItem {
  id: ShopItemId;
  /** Цена в звёздах Telegram (XTR). */
  stars: number;
  /** Зачёркнутая «старая» цена на витрине. */
  was?: number;
}

export const SHOP_ITEMS: ShopItem[] = [{ id: 'kotBanan', stars: 199, was: 275 }];

export interface StickerMeta {
  id: StickerId;
  set: StickerSet;
  /** Эмодзи стикера (поиск в Telegram), 1–3 шт. */
  emoji: string[];
  /** Выдаётся сразу (стартовый пак — весь; набор — первые два, остальные — за награды в матче). */
  now: boolean;
}

/** Порядок — порядок в паке. Индексы не уходят в сеть: стикер называют по id. */
export const STICKER_LIST: StickerMeta[] = [
  { id: 'hi', set: 'starter', emoji: ['👋'], now: true },
  { id: 'dance', set: 'starter', emoji: ['💃', '🕺'], now: true },
  { id: 'oops', set: 'starter', emoji: ['😵', '💫'], now: true },
  { id: 'who', set: 'starter', emoji: ['🤨', '👀'], now: true },
  { id: 'notCrying', set: 'kotBanan', emoji: ['😭'], now: true },
  { id: 'justBanana', set: 'kotBanan', emoji: ['🍌', '😅'], now: true },
  { id: 'splat', set: 'kotBanan', emoji: ['🫠', '💫'], now: false },
  { id: 'allGood', set: 'kotBanan', emoji: ['🌧', '🙂'], now: false },
  { id: 'aaa', set: 'kotBanan', emoji: ['😱', '😭'], now: false },
  { id: 'happyTears', set: 'kotBanan', emoji: ['🥲', '👑'], now: false },
  { id: 'freeze', set: 'kotBanan', emoji: ['🥶', '🧊'], now: false },
  { id: 'meow', set: 'kotBanan', emoji: ['🐱', '❓'], now: false },
  // «за игру»: атрибуты площадки, потом костюмы тем
  { id: 'cut', set: 'play', emoji: ['✂️', '😵'], now: false },
  { id: 'star', set: 'play', emoji: ['⭐', '🤩'], now: false },
  { id: 'jackpot', set: 'play', emoji: ['🎰', '🤑'], now: false },
  { id: 'action', set: 'play', emoji: ['🎬'], now: false },
  { id: 'retake', set: 'play', emoji: ['📣', '🔁'], now: false },
  { id: 'extra', set: 'play', emoji: ['👥', '😐'], now: false },
  { id: 'offscreen', set: 'play', emoji: ['👻', '👀'], now: false },
  { id: 'still', set: 'play', emoji: ['⏸', '🥶'], now: false },
  { id: 'chef', set: 'play', emoji: ['😋', '🍲'], now: false },
  { id: 'penguin', set: 'play', emoji: ['🐧', '🥶'], now: false },
  { id: 'cosmo', set: 'play', emoji: ['🚀', '🧑‍🚀'], now: false },
  { id: 'office', set: 'play', emoji: ['📞', '💼'], now: false },
  { id: 'miami', set: 'play', emoji: ['🌴', '🥵'], now: false },
  { id: 'party', set: 'play', emoji: ['🥳', '🎉'], now: false },
  { id: 'kupala', set: 'play', emoji: ['🔥', '🌿'], now: false },
  { id: 'casino', set: 'play', emoji: ['🎲', '💰'], now: false },
];

export const shopItem = (id: unknown): ShopItem | undefined => SHOP_ITEMS.find((x) => x.id === id);
export const isStickerId = (id: unknown): id is StickerId => STICKER_LIST.some((s) => s.id === id);
