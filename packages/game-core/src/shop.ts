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
  /** Эффект стикеров (не набор): накидывается на любой стикер пака (`fx:<стикер>:<эффект>`, у своих — поле `fx`). */
  effect?: boolean;
}

export const SHOP_ITEMS: ShopItem[] = [
  { id: 'kotBanan', stars: 49, was: 99, isNew: true },
  // эффекты — от простых к самым эффектным (цены — решение владельца 28.11.2026, минимум 19)
  { id: 'gold', stars: 39, isNew: true, effect: true },
  { id: 'holo', stars: 39, isNew: true, effect: true },
  { id: 'fire', stars: 35, isNew: true, effect: true },
  { id: 'vhs', stars: 29, isNew: true, effect: true },
  { id: 'noir', stars: 25, isNew: true, effect: true },
  { id: 'sepia', stars: 19, isNew: true, effect: true },
  { id: 'ice', stars: 19, isNew: true, effect: true },
];

/** Эффекты стикеров — товары гардероба категории «Эффекты» (решение владельца 28.11.2026). */
export const EFFECTS = ['gold', 'holo', 'fire', 'vhs', 'noir', 'sepia', 'ice'] as const satisfies readonly ShopItemId[];
export type EffectId = (typeof EFFECTS)[number];
export const isEffect = (x: unknown): x is EffectId => EFFECTS.includes(x as EffectId);
/** Отметка в учёте: на стандартный стикер `id` накинут эффект `fx`. */
export const fxMark = (id: StickerId, fx: EffectId) => `fx:${id}:${fx}`;
/** Эффект стандартного стикера: отмечен и куплен (вернул звёзды — стикер снова без эффекта). */
export function stickerFx(id: StickerId, items: readonly string[]): EffectId | null {
  return EFFECTS.find((fx) => items.includes(fxMark(id, fx)) && items.includes(fx)) ?? null;
}
/** Отметка в учёте: у стандартного стикера `id` надпись цвета `MY_COLORS[n]` (как у своих). */
export const colMark = (id: StickerId, n: number) => `col:${id}:${n}`;
/** Приманка «Собери свой пак!» — всегда в VHS, цвет не меняется (решение владельца 28.11.2026): витрина эффектов. */
export const LURE_FX: EffectId = 'vhs';
/** Облик стандартного стикера в паке: эффект (куплен и накинут) и цвет надписи (null — родной). */
export interface StdLook {
  fx: EffectId | null;
  color: number | null;
}
export function stdLook(id: StickerId, items: readonly string[]): StdLook {
  if (!canDrop(id)) return { fx: LURE_FX, color: null };
  const c = items.find((i) => i.startsWith(`col:${id}:`));
  const n = c ? Number(c.slice(c.lastIndexOf(':') + 1)) : NaN;
  return { fx: stickerFx(id, items), color: Number.isInteger(n) && n >= 0 && n < MY_COLORS.length ? n : null };
}
/** Запись в `issued` стандартного стикера: `aaa`, с эффектом — `aaa~holo`, с цветом — `aaa~c2` или `aaa~holo.c2`. */
export function lookIssued(id: StickerId, look: StdLook): string {
  const parts = [look.fx, look.color !== null ? `c${look.color}` : null].filter(Boolean);
  return parts.length ? `${id}~${parts.join('.')}` : id;
}
/** Совместимо со старыми записями `aaa~holo`. */
export const fxIssued = (id: StickerId, fx: EffectId | null) => lookIssued(id, { fx, color: null });
export const FX_ISSUED = /^([A-Za-z]{1,24})~(?:([a-z]{2,8})(?:\.c(\d))?|c(\d))$/;
/** Запись `issued` стандартного стикера с обликом: стикер есть, эффект и цвет — из списков. */
export function isLookIssued(x: string): boolean {
  const m = FX_ISSUED.exec(x);
  if (!m) return false;
  const col = m[3] ?? m[4];
  return isStickerId(m[1]) && (m[2] === undefined || isEffect(m[2])) && (col === undefined || Number(col) < MY_COLORS.length);
}
/** Какой стикер за записью `issued` (`aaa~holo` → `aaa`). */
export const issuedBase = (x: string) => x.split('~')[0];

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
  // остальные стартовые — по одному за следующие матчи (решение владельца 28.11.2026; у забравших пак раньше — все сразу, см. STARTER_DRIP)
  { id: 'dance', set: 'starter', emoji: ['💃', '🕺'], now: false, earn: 'played' },
  { id: 'oops', set: 'starter', emoji: ['😵', '💫'], now: false, earn: 'played' },
  { id: 'who', set: 'starter', emoji: ['🤨', '👀'], now: false, earn: 'played' },
  { id: 'lure', set: 'starter', emoji: ['🎁', '🎬'], now: true, lure: true },
  { id: 'justBanana', set: 'kotBanan', emoji: ['🍌', '😅'], now: true },
  { id: 'splat', set: 'kotBanan', emoji: ['🫠', '💫'], now: false, earn: 'cut' },
  { id: 'allGood', set: 'kotBanan', emoji: ['🌧', '🙂'], now: false, earn: 'lose' },
  // «ААААА!» — сразу при покупке (27.11.2026 заменил похожий «Я не плачу»)
  { id: 'aaa', set: 'kotBanan', emoji: ['😱', '😭'], now: true },
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

/**
 * Стикеры, убранные из наборов: id → первое эмодзи, по нему бот найдёт и удалит их из уже выданных паков.
 * Id больше не переиспользовать.
 */
export const RETIRED_STICKERS: Readonly<Record<string, string>> = { notCrying: '😭' };

export const shopItem = (id: unknown): ShopItem | undefined => SHOP_ITEMS.find((x) => x.id === id);

/**
 * Проверочная покупка (не набор, на витрине её нет): 1 звезда, ничего не даёт, сразу возвращается кнопкой
 * в своей карточке. Видна только по ссылке `startapp=shoptest` (флаг `shoptest`) — владельцу, чтобы
 * проверить оплату и возврат на живом боте.
 */
export const TEST_ITEM = { id: 'test', stars: 1 } as const;
export type BuyItem = ShopItem | typeof TEST_ITEM;
/** Что можно купить: набор витрины или проверочная покупка. */
export const buyItem = (id: unknown): BuyItem | undefined => (id === TEST_ITEM.id ? TEST_ITEM : shopItem(id));
/**
 * Отметка в учёте: бесплатный пак забран после 28.11.2026 — стартовые стикеры, кроме «Привет!», открываются по одному
 * за матч (`st:<id>`). У забравших раньше её нет — у них все стартовые открыты сразу.
 */
export const STARTER_DRIP = 'drip';
/** Стартовый стикер открыт: сразу (`now`), у старых паков — все, у новых — когда открыт в матче. */
export const starterOpen = (s: Pick<StickerMeta, 'id' | 'now'>, items: readonly string[]) => s.now || !items.includes(STARTER_DRIP) || items.includes(`st:${s.id}`);
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

/** Сколько новых стикеров открывает один матч: условий за матч набирается много, весь пак не должен падать за пару игр. */
export const EARN_PER_MATCH = 2;
/** И не больше стольких за сутки (по Москве): весь пак за игру — не быстрее недели, а не за вечер. */
export const EARN_PER_DAY = 3;
/** Если условий набралось больше, чем `EARN_PER_MATCH`, — сначала редкие. */
const EARN_RANK: readonly EarnId[] = ['jackpot', 'clairvoyant', 'stars', 'unsuspected', 'paranoid', 'win', 'theme', 'cut', 'accuse', 'survive', 'lose', 'played'];
/** Какие из новых для игрока стикеров открыть за этот матч (порядок STICKER_LIST при равной редкости). */
export function pickEarned<T extends Pick<StickerMeta, 'earn'>>(fresh: readonly T[], n = EARN_PER_MATCH): T[] {
  const rank = (s: T) => (s.earn ? EARN_RANK.indexOf(s.earn) : EARN_RANK.length);
  return [...fresh].sort((a, b) => rank(a) - rank(b)).slice(0, n);
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
// ───────────── «Собери свой стикерпак»: выбор стикеров и свои стикеры ─────────────

/** Своих стикеров в паке — не больше. */
export const MY_MAX = 5;
/** Подпись своего стикера: строк и знаков в строке (стикер 96 пикс., шрифт 8 пикс.). */
export const MY_LINES = 2;
export const MY_LINE = 10;

/**
 * Фигурки конструктора: обычный актёр — у всех; Кот-банан — за покупку набора; герои площадок — когда
 * открыт стикер этой площадки (сыграл на ней дубль). Порядок — порядок на странице.
 */
export const MY_FIGS = [
  { id: 'actor' },
  { id: 'kotBanan', item: 'kotBanan' },
  { id: 'chef', sticker: 'chef', theme: 'chefs' },
  { id: 'penguin', sticker: 'penguin', theme: 'penguins' },
  { id: 'cosmo', sticker: 'cosmo', theme: 'cosmonauts' },
  { id: 'office', sticker: 'office', theme: 'office' },
  { id: 'miami', sticker: 'miami', theme: 'miami' },
  { id: 'party', sticker: 'party', theme: 'party' },
  { id: 'kupala', sticker: 'kupala', theme: 'kupala' },
  { id: 'casino', sticker: 'casino', theme: 'casino' },
] as const satisfies readonly { id: string; item?: ShopItemId; sticker?: StickerId; theme?: ThemeId }[];
export type MyFig = (typeof MY_FIGS)[number]['id'];

/** Позы (те же движения, что в игре) и эмодзи стикера для поиска в Telegram. */
export const MY_POSES = ['wave', 'dance', 'stun', 'startle', 'jump', 'freeze', 'ask'] as const;
export type MyPose = (typeof MY_POSES)[number];
export const MY_POSE_EMOJI: Record<MyPose, string> = { wave: '👋', dance: '💃', stun: '😵', startle: '😱', jump: '🤩', freeze: '🥶', ask: '🤔' };
/** Цвет подписи и искр — имена из палитры PAL (рисует клиент). */
export const MY_COLORS = ['white', 'yellow', 'orange', 'cyan', 'green', 'orchid'] as const;
/**
 * Первое эмодзи своего стикера — метка места (своё у каждого, нет у стандартных): по нему бот находит
 * стикер в паке, чтобы заменить или убрать. Второе — эмодзи позы.
 */
export const MY_MARKS = ['✏️', '🖍', '🖌', '🖊', '🖋'] as const;

export interface MySticker {
  /** Место 0…MY_MAX-1 (метка `MY_MARKS[slot]`). */
  slot: number;
  fig: MyFig;
  pose: MyPose;
  /** Индекс в MY_COLORS. */
  color: number;
  /** Строки подписи (0–2), уже проверенные `myCaption`. */
  text: string[];
  /** Номер правки: изменился — бот заменяет стикер в паке на месте. */
  rev: number;
  /** Эффект (купленный в гардеробе); нет — без эффекта. */
  fx?: EffectId;
}

/** Открыта ли фигурка игроку с такими предметами (items из учёта гардероба). */
export function myFigOpen(fig: MyFig, items: readonly string[]): boolean {
  const f = MY_FIGS.find((x) => x.id === fig) as { item?: string; sticker?: string } | undefined;
  if (!f) return false;
  if (f.item) return items.includes(f.item);
  if (f.sticker) return items.includes(`st:${f.sticker}`);
  return true;
}

/** Знаки подписи: буквы (кириллица, латиница), цифры, пробел и простая пунктуация — то, что есть в шрифте. */
const CAP_CHARS = /^[A-Za-zА-Яа-яЁё0-9 !?.,:;'"()+*-]*$/u;
/** Похожие латинские буквы и цифры → кириллица (обход фильтра «xуй», «3ае6ал»). */
const LOOK: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', u: 'и', '0': 'о', '3': 'з', '6': 'б', '4': 'ч', ё: 'е' };
/** Корни мата, где бы ни стояли в слове (после склейки букв). */
const RUDE_ANY = ['хуй', 'хуе', 'хуя', 'хуи', 'хуё', 'пизд', 'пезд', 'ебан', 'ебат', 'ебал', 'ебло', 'еблан', 'ебуч', 'ебну', 'ебош', 'заеб', 'выеб', 'уеб', 'въеб', 'наеб', 'бляд', 'блят', 'мудак', 'мудил', 'пидор', 'пидар', 'пидр', 'залуп', 'шлюх', 'гандон', 'гондон', 'дроч', 'манда', 'сучар'];
/** Корни, которые ловим только в начале слова (иначе «рубля», «херсон», «посуда»). */
const RUDE_START = ['бля', 'сука', 'суки', 'суке', 'сукой', 'сучк', 'ебу', 'ебе', 'еби', 'жоп', 'муда', 'член', 'срак', 'хер'];
const RUDE_EN = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'nigg', 'whore', 'slut', 'fag', 'asshole', 'porn', 'penis', 'sex'];
const RUDE_EN_WORD = ['ass', 'cum', 'tits'];
/** Исключения: обычные слова, в которых случайно есть корень. */
const RUDE_OK = ['херсон', 'херувим', 'мандарин', 'команд', 'мандат', 'class', 'pass', 'mass', 'grass', 'bass', 'assist', 'sussex', 'essex', 'dickens', 'cocktail', 'peacock', 'shitake', 'scunthorpe'];

/** Есть ли в тексте мат (по-русски и по-английски, с подменой похожих букв). */
export function rude(s: string): boolean {
  const low = s.toLowerCase().replace(/ё/g, 'е');
  const words = low.split(/[^a-zа-я0-9]+/u).filter(Boolean);
  const ok = (w: string) => RUDE_OK.some((x) => w.includes(x));
  for (const w of words) {
    if (!ok(w) && (RUDE_EN.some((r) => w.includes(r)) || RUDE_EN_WORD.includes(w))) return true;
    const ru = [...w].map((ch) => LOOK[ch] ?? ch).join('').replace(/(.)\1+/g, '$1');
    if (ok(ru)) continue;
    if (RUDE_ANY.some((r) => ru.includes(r)) || RUDE_START.some((r) => ru.startsWith(r))) return true;
  }
  // буквы через пробел или точку: «х у й», «бл.я» — склеиваем подряд идущие кусочки по 1–2 буквы
  let run = '';
  const check = () => {
    const ru = [...run].map((ch) => LOOK[ch] ?? ch).join('').replace(/(.)\1+/g, '$1');
    const hit = run.length > 2 && !ok(ru) && (RUDE_ANY.some((r) => ru.includes(r)) || RUDE_START.some((r) => ru.startsWith(r)) || RUDE_EN.some((r) => run.includes(r)));
    run = '';
    return hit;
  };
  for (const w of words) {
    if (w.length <= 2) run += w;
    else if (check()) return true;
  }
  return check();
}

/** Ошибки подписи: длинно, чужие знаки (@, ссылки, эмодзи), похоже на адрес сайта, мат. */
export type CaptionError = 'long' | 'chars' | 'link' | 'rude';

/**
 * Подпись своего стикера: одна строка с телефона → до двух строк по MY_LINE знаков (перенос по пробелу).
 * Решает сервер; клиент проверяет тем же кодом, чтобы сразу показать ошибку.
 */
export function myCaption(raw: unknown): { lines: string[] } | { error: CaptionError } {
  if (typeof raw !== 'string') return { error: 'chars' };
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length > MY_LINE * MY_LINES + 1) return { error: 'long' };
  if (!CAP_CHARS.test(s)) return { error: 'chars' };
  // адрес сайта: «что-то.ru», «www», «http»
  if (/[a-zа-я0-9]\.[a-zа-я]{2}/iu.test(s) || /www|https?/i.test(s)) return { error: 'link' };
  if (rude(s)) return { error: 'rude' };
  if (!s) return { lines: [] };
  if (s.length <= MY_LINE) return { lines: [s] };
  // перенос по последнему пробелу, который даёт обе строки не длиннее MY_LINE
  for (let i = Math.min(s.length - 1, MY_LINE); i > 0; i--) {
    if (s[i] !== ' ') continue;
    const a = s.slice(0, i);
    const b = s.slice(i + 1);
    if (a.length <= MY_LINE && b.length <= MY_LINE) return { lines: [a, b] };
  }
  return { error: 'long' };
}

/** Свой стикер с телефона → проверенный (без rev и slot — их ставит сервер) или код ошибки. */
export function parseMySticker(x: unknown, items: readonly string[]): Omit<MySticker, 'slot' | 'rev'> | { error: CaptionError | 'bad' | 'locked' } {
  const v = x as Partial<Record<keyof MySticker, unknown>> & { caption?: unknown } | null;
  if (!v || typeof v !== 'object') return { error: 'bad' };
  const fig = MY_FIGS.find((f) => f.id === v.fig)?.id;
  const pose = MY_POSES.find((p) => p === v.pose);
  const color = typeof v.color === 'number' && Number.isInteger(v.color) && v.color >= 0 && v.color < MY_COLORS.length ? v.color : -1;
  if (!fig || !pose || color < 0) return { error: 'bad' };
  if (!myFigOpen(fig, items)) return { error: 'locked' };
  // эффект — только купленный
  const fx = v.fx === undefined || v.fx === null ? undefined : isEffect(v.fx) ? v.fx : null;
  if (fx === null) return { error: 'bad' };
  if (fx && !items.includes(fx)) return { error: 'locked' };
  const cap = myCaption(v.caption ?? '');
  if ('error' in cap) return cap;
  return { fig, pose, color, text: cap.lines, ...(fx ? { fx } : {}) };
}

/** Проверка уже сохранённого своего стикера (учёт по туннелю: всё, что пришло по сети, — снова проверяем). */
export function isMySticker(x: unknown): x is MySticker {
  const v = x as MySticker | null;
  if (!v || typeof v !== 'object') return false;
  if (!Number.isInteger(v.slot) || v.slot < 0 || v.slot >= MY_MAX || !Number.isInteger(v.rev) || v.rev < 0 || v.rev > 1e6) return false;
  if (!MY_FIGS.some((f) => f.id === v.fig) || !MY_POSES.includes(v.pose) || !Number.isInteger(v.color) || v.color < 0 || v.color >= MY_COLORS.length) return false;
  if (!Array.isArray(v.text) || v.text.length > MY_LINES) return false;
  if (v.fx !== undefined && !isEffect(v.fx)) return false;
  const cap = myCaption(v.text.join(' '));
  return !('error' in cap) && cap.lines.join(' ') === v.text.join(' ');
}

/** Запись «свой стикер в паке» в `issued`: место и номер правки (`my2.5`). */
export const myIssued = (s: Pick<MySticker, 'slot' | 'rev'>) => `my${s.slot}.${s.rev}`;
export const MY_ISSUED = /^my([0-4])\.(\d{1,7})$/;

/** Стандартные стикеры, которые игрок убрал из пака (`off:<id>` в предметах). Приманку убрать нельзя. */
export const offSticker = (id: StickerId) => `off:${id}`;
export const canDrop = (id: StickerId) => !STICKER_LIST.find((s) => s.id === id)?.lure;
