import type { Dict } from './locale';
import type { MatchSummary, RoundSummary } from './match';
import { THEME_RULES } from './themes';
import type { ThemeId } from './themes';

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
  /** Ярлык «НОВОЕ» на витрине и точка на ячейке в списке. */
  isNew?: boolean;
}

export const SHOP_ITEMS: ShopItem[] = [{ id: 'kotBanan', stars: 49, was: 99, isNew: true }];

export interface StickerMeta {
  id: StickerId;
  set: StickerSet;
  /** Эмодзи стикера (поиск в Telegram), 1–3 шт. */
  emoji: string[];
  /** Выдаётся сразу (стартовый пак — весь; набор — первые два, остальные — за события в матче, `earn`). */
  now: boolean;
  /** За что открывается в матче (если не `now`). */
  earn?: EarnId;
  /** Для `earn: 'theme'`: id площадки из THEME_RULES — сыграл на ней дубль. */
  theme?: ThemeId;
  /** Приманка: хлопушка «Собери свой пак» — всегда последней в паке (бот переставляет), зовёт в игру. Первое эмодзи — только у неё. */
  lure?: boolean;
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
  | 'clairvoyant'
  /** Сыграл матч (первый же). */
  | 'played'
  /** Три звезды: выиграл дубль звёздами. */
  | 'stars'
  /** «Казино»: «777» на «Крутке». */
  | 'jackpot'
  /** Поставил метку «?» из-за кадра (любую). */
  | 'accuse'
  /** Дожил до конца дубля. */
  | 'survive'
  /** Сыграл дубль на площадке `theme`. */
  | 'theme';

/** Порядок — порядок в паке. Индексы не уходят в сеть: стикер называют по id. */
export const STICKER_LIST: StickerMeta[] = [
  { id: 'hi', set: 'starter', emoji: ['👋'], now: true },
  { id: 'dance', set: 'starter', emoji: ['💃', '🕺'], now: true },
  { id: 'oops', set: 'starter', emoji: ['😵', '💫'], now: true },
  { id: 'who', set: 'starter', emoji: ['🤨', '👀'], now: true },
  { id: 'lure', set: 'starter', emoji: ['🎁', '🎬'], now: true, lure: true },
  { id: 'notCrying', set: 'kotBanan', emoji: ['😭'], now: true },
  { id: 'justBanana', set: 'kotBanan', emoji: ['🍌', '😅'], now: true },
  { id: 'splat', set: 'kotBanan', emoji: ['🫠', '💫'], now: false, earn: 'cut' },
  { id: 'allGood', set: 'kotBanan', emoji: ['🌧', '🙂'], now: false, earn: 'lose' },
  { id: 'aaa', set: 'kotBanan', emoji: ['😱', '😭'], now: false, earn: 'paranoid' },
  { id: 'happyTears', set: 'kotBanan', emoji: ['🥲', '👑'], now: false, earn: 'win' },
  { id: 'freeze', set: 'kotBanan', emoji: ['🥶', '🧊'], now: false, earn: 'unsuspected' },
  { id: 'meow', set: 'kotBanan', emoji: ['🐱', '❓'], now: false, earn: 'clairvoyant' },
  // «за игру»: атрибуты площадки, потом костюмы тем
  { id: 'cut', set: 'play', emoji: ['✂️', '😵'], now: false, earn: 'cut' },
  { id: 'star', set: 'play', emoji: ['⭐', '🤩'], now: false, earn: 'stars' },
  { id: 'jackpot', set: 'play', emoji: ['🎰', '🤑'], now: false, earn: 'jackpot' },
  { id: 'action', set: 'play', emoji: ['🎬'], now: false, earn: 'played' },
  { id: 'retake', set: 'play', emoji: ['📣', '🔁'], now: false, earn: 'lose' },
  { id: 'extra', set: 'play', emoji: ['👥', '😐'], now: false, earn: 'unsuspected' },
  { id: 'offscreen', set: 'play', emoji: ['👻', '👀'], now: false, earn: 'accuse' },
  { id: 'still', set: 'play', emoji: ['⏸', '🥶'], now: false, earn: 'survive' },
  { id: 'chef', set: 'play', emoji: ['😋', '🍲'], now: false, earn: 'theme', theme: 'chefs' },
  { id: 'penguin', set: 'play', emoji: ['🐧', '🥶'], now: false, earn: 'theme', theme: 'penguins' },
  { id: 'cosmo', set: 'play', emoji: ['🚀', '🧑‍🚀'], now: false, earn: 'theme', theme: 'cosmonauts' },
  { id: 'office', set: 'play', emoji: ['📞', '💼'], now: false, earn: 'theme', theme: 'office' },
  { id: 'miami', set: 'play', emoji: ['🌴', '🥵'], now: false, earn: 'theme', theme: 'miami' },
  { id: 'party', set: 'play', emoji: ['🥳', '🎉'], now: false, earn: 'theme', theme: 'party' },
  { id: 'kupala', set: 'play', emoji: ['🔥', '🌿'], now: false, earn: 'theme', theme: 'kupala' },
  { id: 'casino', set: 'play', emoji: ['🎲', '💰'], now: false, earn: 'theme', theme: 'casino' },
];

export const shopItem = (id: unknown): ShopItem | undefined => SHOP_ITEMS.find((x) => x.id === id);
export const isStickerId = (id: unknown): id is StickerId => STICKER_LIST.some((s) => s.id === id);

/** Итоги дубля, которых хватает для `earnedEvents` (RoundSummary целиком или запись матча). */
export type EarnRound = Pick<RoundSummary, 'reveal' | 'awards' | 'accusations'> &
  Partial<Pick<RoundSummary, 'starWinner' | 'points'>> & {
    /** Площадка дубля (индекс THEME_RULES). */
    theme?: number;
  };

/** Какие события матча случились с игроком `pid`. */
export function earnedEvents(pid: string, rounds: EarnRound[], match: Pick<MatchSummary, 'winners'>): Set<EarnId> {
  const out = new Set<EarnId>();
  if (!rounds.some((r) => r.reveal.some((x) => x.pid === pid))) return out;
  out.add('played');
  out.add(match.winners.includes(pid) ? 'win' : 'lose');
  for (const r of rounds) {
    if (r.reveal.some((x) => x.pid === pid && !x.alive)) out.add('cut');
    if (r.reveal.some((x) => x.pid === pid && x.alive)) out.add('survive');
    if (r.accusations.some((a) => a.pid === pid && a.correct)) out.add('clairvoyant');
    if (r.accusations.some((a) => a.pid === pid)) out.add('accuse');
    if (r.starWinner === pid) out.add('stars');
    if ((r.points?.[pid]?.slot ?? 0) > 0) out.add('jackpot');
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
  if (!ev.size) return [];
  const themes = new Set(rounds.filter((r) => r.theme !== undefined).map((r) => THEME_RULES[r.theme!]?.id));
  return STICKER_LIST.filter((s) => (s.earn === 'theme' ? !!s.theme && themes.has(s.theme) : s.earn && ev.has(s.earn))).map((s) => s.id);
}

/** Скины гардероба — наборы, которые меняют самого актёра (сейчас один: Кот-банан). */
export type SkinId = 'kotBanan';
export const SKINS: readonly SkinId[] = ['kotBanan'];
export const isSkin = (x: unknown): x is SkinId => SKINS.includes(x as SkinId);
/**
 * Какой скин надет у игрока с этими покупками (`ShopUser.items`). Выбор в гардеробе — отметка `wear:<скин>`
 * или `wear:none` («Снять»); без отметки — последний купленный (после покупки скин сразу надет).
 */
export function skinOf(items: readonly string[]): SkinId | undefined {
  const mark = items.find((x) => x.startsWith('wear:'))?.slice(5);
  if (mark === 'none') return undefined;
  if (isSkin(mark) && items.includes(mark)) return mark;
  for (let i = items.length - 1; i >= 0; i--) if (isSkin(items[i])) return items[i] as SkinId;
  return undefined;
}

/** Покупки после «Надеть» (скин) или «Снять» (null): отметка `wear:` одна. */
export function wearItems(items: readonly string[], skin: SkinId | null): string[] {
  return [...items.filter((x) => !x.startsWith('wear:')), `wear:${skin ?? 'none'}`];
}
