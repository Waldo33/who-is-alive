import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DICTS } from '@kto/game-core';
import { RateWindow } from './limits';
import { errFields } from './log';
import type { Logger } from './log';
import { cleanName } from './room';
import { Shop, localLedger } from './shop';
import type { ShopDeps, ShopLedger, VerifyToken } from './shop';
import type { Store } from './store';

/**
 * Telegram-бот «Массовки» на своём сервере (раньше — Supabase Edge Function `tg-bot`).
 *
 * Маршруты (https://api.<домен>/tg/...):
 *   GET  /info    — юзернейм бота, имя прямой ссылки Mini App, включён ли инлайн-режим (для клиента);
 *   GET  /status  — диагностика: вебхук, ошибки доставки, инлайн-режим;
 *   GET  /setup   — привязать вебхук Telegram к /tg/hook и обновить профиль бота; повторно — безвредно;
 *   POST /hook    — обновления от Telegram: /start и инлайн-запросы «@бот …»;
 *   POST /daily   — результат «Кастинга дня» из Mini App (подписанный initData) → рейтинг этого чата;
 *   POST /board   — рейтинг «Кастинга дня» в чате;
 *   POST /film    — (только изнутри, /internal/tg/film) фильм матча готов — заменить им карточку «Собрать комнату»;
 *   POST /shop…  — гардероб: покупка за звёзды и личный стикерпак (shop.ts);
 *   POST /prepare — карточка «поделиться» для WebApp.shareMessage (комната, кастинг, приглашение,
 *                   клип — видео лежит на игровом сервере в Москве, `clips.ts`, сюда приходит только id).
 *
 * Вебхук проверяет секретный заголовок (выводится из ключа бота), Mini App — подпись initData.
 */
export interface BotOptions {
  token: string;
  /** Публичный адрес API (для вебхука): https://api.benobody.app */
  apiBase: string;
  /** Адрес сайта (кнопки web_app): https://benobody.app */
  site: string;
  /** Короткое имя прямой ссылки Mini App. */
  app?: string;
  /** Флаги: casting — «Кастинг дня» (без него бот о кастинге молчит). */
  features?: string[];
  store: Store;
  log: Logger;
  /** Где лежат клипы (игровой сервер в Москве, `clips.ts`): https://api.benobody.app. */
  clipBase?: string;
  /**
   * Прямые ссылки на клипы в S3 (`https://s3.twcstorage.ru/massovka-media/clips`): файл открыт для чтения —
   * Telegram берёт его из бакета, мимо игрового сервера. Нет файла по прямой ссылке — ссылка на сервер.
   */
  clipPublic?: string;
  /** Подмена api.telegram.org (тесты). */
  fetchImpl?: typeof fetch;
  /** Учёт гардероба (shop.ts): нет — своё хранилище (store). */
  shopLedger?: ShopLedger;
  /** Проверка токена игрока игрового сервера (учёт в своей базе): связь игрока с Telegram для стикеров за матчи. */
  verifyGameToken?: VerifyToken;
  /** Видеостикеры (<язык>/<id>.webm); нет — гардероб без выдачи стикеров. */
  stickersDir?: string;
  /** Чат поддержки (бот — его участник): сюда бот пересылает /paysupport, ответ на пересылку уходит игроку. */
  supportChat?: string;
  /** Нарисовать свой стикер игрока (WEBM): sticker-render.ts здесь или игровой сервер по туннелю. */
  drawMy?: ShopDeps['drawMy'];
  /** Аренда сверки оплат по расписанию (синий и зелёный — один сверяет). */
  lease?: ShopDeps['lease'];
}

/** Канал игры в Telegram (новости, ролики). */
const CHANNEL = 'https://t.me/benobody_app';
/** Группа «benobody alerts» (как ALERTS_CHAT в game-deploy.yml): id чата не секрет без ключа бота. */
const SUPPORT_CHAT = '-5387784292';
/** Сколько после /paysupport бот пересылает обычные сообщения игрока в поддержку. */
const SUPPORT_OPEN_MS = 30 * 60_000;

const T = {
  ru: {
    start: 'Массовка — пиксельная игра для компании: спрячься в толпе ботов и вычисли друзей раньше, чем они тебя.\n\n🎁 Сыграй первый матч — и получишь бесплатный стикерпак со своим актёром.',
    stickersText: '🎨 Твой стикерпак: какие стикеры в паке и свои стикеры с подписью.',
    startCasting: ' А каждый день — «Кастинг дня»: найди актёра в массовке.',
    play: '▶ Играть',
    friends: '👥 С друзьями',
    stickers: '🎨 Мой стикерпак',
    wardrobe: '👗 Гардероб',
    channel: '📣 Канал игры',
    daily: '🎬 Кастинг дня',
    inviteTitle: 'Позвать в «Массовку»',
    inviteDesc: 'Карточка с кнопкой: друзья откроют игру прямо в Telegram',
    inviteText: 'Сыграем в «Массовку»? 32 одинаковых человечка, среди них — мы. Кто кого вычислит первым?',
    lobbyTitle: 'Собрать комнату',
    lobbyDesc: 'Новое лобби: все, кто нажмёт кнопку, попадут в одну комнату',
    lobbyText: 'Сыграем в «Массовку»? Жми кнопку — соберёмся в одной комнате. 32 одинаковых человечка, среди них — мы.',
    lobbyJoin: '👥 В комнату',
    roomTitle: 'Позвать в комнату {code}',
    roomDesc: 'Друзья попадут сразу в твою комнату',
    roomText: 'Заходи в «Массовку» — комната {code}. Спрячься в массовке и вычисли актёров!',
    join: '▶ Войти в комнату',
    dailyTitle: 'Кастинг дня №{n}',
    dailyDesc: 'Найди актёра в массовке за три попытки',
    dailyText: 'Массовка · Кастинг №{n} · Найди актёра в массовке{squares}\nНайдёшь быстрее?',
    clipTitle: 'Лучший момент дубля',
    solve: '🎬 На кастинг',
    openApp: 'Открыть игру',
    filmAgain: '🎬 Реванш',
    filmWatch: '▶ Смотреть фильм',
    filmPuzzle: '🔎 Найди актёра',
    filmDone: '🎬 Снято! Звезда фильма — {name}',
    filmDoneDraw: '🎬 Снято! Ничья: {names}',
    filmAward: '🏅 {title} — {names}',
    filmRoom: 'Комната {code}. Реванш? Жми кнопку — та же комната.',
    cardGather: '🎬 Массовка · режиссёр собирает съёмку',
    cardSeats: 'В кадре: {names} · {n} из {max}',
    cardWait1: 'Ждём друзей — жми кнопку и заходи!',
    cardWait2: 'Можно начинать — или подождать ещё.',
    cardWait3: 'Осталось одно место!',
    cardFull: 'Все в сборе. Ждём «Мотор!»',
    cardShooting: '🔴 Идёт съёмка · комната {code} · дубль {take}',
    cardTarget: 'Играют до {n} очков.',
    cardWatch: '👀 Смотреть',
    cardClosed: '🎬 Съёмку отменили. Жми кнопку — соберёмся заново.',
  },
  en: {
    start: 'Be Nobody is a pixel party game: hide in a crowd of bots and spot your friends before they spot you.\n\n🎁 Play your first match and get a free sticker pack with your actor.',
    stickersText: '🎨 Your sticker pack: pick what goes in it and make your own with a caption.',
    startCasting: ' Plus a daily casting: spot the actor among the extras.',
    play: '▶ Play',
    friends: '👥 With friends',
    stickers: '🎨 My sticker pack',
    wardrobe: '👗 Wardrobe',
    channel: '📣 Game channel',
    daily: '🎬 Daily casting',
    inviteTitle: 'Invite to Be Nobody',
    inviteDesc: 'A card with a button: friends open the game right in Telegram',
    inviteText: 'Play Be Nobody? 32 identical pixel people, and we are among them. Who spots whom first?',
    lobbyTitle: 'Start a room',
    lobbyDesc: 'A new lobby: everyone who taps the button lands in the same room',
    lobbyText: 'Play Be Nobody? Tap the button and we all meet in one room. 32 identical pixel people, and we are among them.',
    lobbyJoin: '👥 Join the room',
    roomTitle: 'Invite to room {code}',
    roomDesc: 'Friends join your room directly',
    roomText: 'Join me in Be Nobody — room {code}. Hide in the crowd and spot the actors!',
    join: '▶ Join the room',
    dailyTitle: 'Daily casting #{n}',
    dailyDesc: 'Spot the actor among the extras in three tries',
    dailyText: 'Be Nobody · Casting #{n} · Spot the actor{squares}\nCan you beat me?',
    clipTitle: 'Best moment of the take',
    solve: '🎬 Join the casting',
    openApp: 'Open the game',
    filmAgain: '🎬 Rematch',
    filmWatch: '▶ Watch the film',
    filmPuzzle: '🔎 Find the actor',
    filmDone: "🎬 That's a wrap! Star of the film: {name}",
    filmDoneDraw: "🎬 That's a wrap! Draw: {names}",
    filmAward: '🏅 {title}: {names}',
    filmRoom: 'Room {code}. Rematch? Tap the button — same room.',
    cardGather: '🎬 Be Nobody · the director is casting',
    cardSeats: 'On set: {names} · {n} of {max}',
    cardWait1: 'Waiting for friends — tap the button to join!',
    cardWait2: 'Ready to roll — or wait for more.',
    cardWait3: 'One spot left!',
    cardFull: 'Full cast. Waiting for “Action!”',
    cardShooting: '🔴 Shooting · room {code} · take {take}',
    cardTarget: 'First to {n} points wins.',
    cardWatch: '👀 Watch',
    cardClosed: '🎬 Shoot cancelled. Tap the button to start again.',
  },
};
type Lang = keyof typeof T;
type Texts = (typeof T)['ru'];
const langOf = (code?: string): Lang => (code && /^(ru|uk|be|kk)/.test(code) ? 'ru' : 'en');
const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
const SQUARES = /^[🟥🟩⬜]{1,6}$/u;
const TAG_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Метка приглашения: 12 случайных букв и цифр (startapp допускает A-Za-z0-9_-, до 64 символов). */
function inviteTag(): string {
  return [...randomBytes(12)].map((b) => TAG_ABC[b % TAG_ABC.length]).join('');
}

/** Номер «Кастинга дня» (как в game-core › daily.ts): №1 — 23.11.2026, по дате UTC. */
export function dailyNow(now = Date.now()): number {
  return Math.max(1, Math.floor((now - Date.UTC(2026, 10, 23)) / 86_400_000) + 1);
}

interface Update {
  message?: {
    message_id?: number;
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; first_name?: string; username?: string; language_code?: string; is_bot?: boolean };
    /** Ответ на сообщение (в чате поддержки — на пересылку бота). */
    reply_to_message?: { text?: string; from?: { id: number; is_bot?: boolean } };
    successful_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string };
  };
  callback_query?: { id: string; from: { id: number; first_name?: string; username?: string; language_code?: string }; data?: string };
  pre_checkout_query?: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string };
  inline_query?: { id: string; query: string; from: { language_code?: string } };
  /** Карточку выбрали и отправили в чат (нужна «обратная связь» инлайн-режима в BotFather: /setinlinefeedback). */
  chosen_inline_result?: { result_id: string; inline_message_id?: string; from: { language_code?: string } };
}

/** Фильм матча из комнаты по приглашению (игровой сервер → /internal/tg/film). */
export interface FilmNotice {
  invite: string;
  /** id ролика в хранилище клипов (clips.ts). */
  id: string;
  code: string;
  winners: string[];
  draw: boolean;
  /** Награды матча с именами (необязательное — старые версии игрового сервера не шлют). */
  awards?: { id: string; names: string[] }[];
  /** Готовая строка счёта компании в чате («Енот 5 : 3 Голубь») — необязательное. */
  score?: string;
  /** Код загадки из фильма (puzzles.ts) — кнопка «Найди актёра» под видео (необязательное). */
  puzzle?: string;
}

/** Живая карточка «Собрать комнату» (игровой сервер → /internal/tg/card): сбор, съёмка, отмена. */
export type CardNotice = { invite: string; code: string } & (
  | { state: 'lobby'; seats: { name: string; color: number }[]; max: number }
  | { state: 'playing'; take: number; target: number; scores: { name: string; color: number; score: number }[] }
  | { state: 'closed' }
);

/** Правка одной карточки — не чаще (Telegram режет частые правки одного сообщения). */
const CARD_GAP_MS = 3_000;
/** Цвета игроков (PLAYER_COLORS: красный, синий, жёлтый, зелёный) — квадратиками. */
const SEAT = ['🟥', '🟦', '🟨', '🟩'];
/** Имя игрока в карточке: без @ и ссылок (сообщение без разметки, но Telegram сам подсвечивает адреса). */
const cardName = (x: unknown): string =>
  typeof x === 'string'
    ? x
        .replace(/https?:|[@/\\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 16)
    : '';

export interface InitData {
  user: { id: number; first_name?: string; username?: string; language_code?: string };
  chat_instance?: string;
}

export interface BotReply {
  status: number;
  body: unknown;
}

const CLIP_ID = /^[0-9a-f]{20}$/;
const INVITE_TAG = /^[A-Za-z0-9]{12}$/;

interface PrepareBody {
  initData?: string;
  kind?: string;
  code?: string;
  squares?: string;
  /** kind 'clip': id клипа на игровом сервере, подпись, есть ли обложка. */
  clip?: string;
  text?: string;
  thumb?: boolean;
  /** kind 'clip' (фильм матча): кнопка «Реванш» — в ту же комнату (метка карточки или код). */
  invite?: string;
}

export class Bot {
  private readonly app: string;
  private readonly casting: boolean;
  private readonly f: typeof fetch;
  private me: { username: string; supports_inline_queries?: boolean } | null = null;
  private meAt = 0;
  readonly hookSecret: string;
  readonly shop: Shop;
  private readonly supportChat: string;
  /** Кто недавно написал /paysupport: id → до какого времени пересылать его сообщения. */
  private readonly supportUntil = new Map<number, number>();
  private readonly supportRate = new RateWindow(5, 10 * 60_000);

  constructor(private readonly o: BotOptions) {
    this.app = o.app ?? 'play';
    this.casting = (o.features ?? []).includes('casting');
    this.f = o.fetchImpl ?? fetch;
    // секрет вебхука выводится из ключа бота — хранить отдельно не нужно (так же было в Supabase)
    this.supportChat = o.supportChat ?? SUPPORT_CHAT;
    this.hookSecret = createHash('sha256').update('kto-hook:' + o.token).digest('hex').slice(0, 48);
    this.shop = new Shop({
      api: (m, b) => this.api(m, b),
      username: async () => (await this.getMe()).username,
      ledger: o.shopLedger ?? localLedger(o.store, o.verifyGameToken),
      log: o.log,
      stickersDir: o.stickersDir ?? '',
      channel: CHANNEL,
      site: o.site,
      channelId: '@' + CHANNEL.split('/').pop(),
      drawMy: o.drawMy,
      lease: o.lease,
    });
  }

  private supportOpen(id: number): boolean {
    const until = this.supportUntil.get(id);
    if (until !== undefined && until < Date.now()) this.supportUntil.delete(id);
    return (this.supportUntil.get(id) ?? 0) >= Date.now();
  }

  /**
   * /paysupport и сообщения после него: игроку — «запрос передан», в чат поддержки — кто, что куплено и текст
   * (без чужих ссылок и @упоминаний). Метка #u<id> в пересылке — по ней ответ из чата уходит игроку.
   */
  private async onSupport(from: { id: number; first_name?: string; username?: string; language_code?: string }, raw: string, command: boolean): Promise<void> {
    const text = safeCaption(raw, this.o.site ?? '').slice(0, 1000);
    if (command) this.supportUntil.set(from.id, Date.now() + SUPPORT_OPEN_MS);
    // пустой /paysupport: игроку — подсказка, в поддержку — пока ничего
    if (!text) {
      if (command) await this.shop.support(from.id, from.language_code, false);
      return;
    }
    if (!this.supportRate.take(String(from.id), Date.now())) return;
    const items = await this.shop.itemsOf(from.id);
    const name = cleanName(safeCaption(from.first_name ?? '', ''), '—');
    const user = from.username && /^\w{3,32}$/.test(from.username) ? ` · ${from.username}` : '';
    const card = [
      `🧾 Поддержка: ${name}${user}`,
      `Номер покупателя: ${from.id}`,
      `Куплено: ${items.length ? items.join(', ') : 'ничего'}`,
      '',
      text,
      '',
      `Ответь на это сообщение — ответ уйдёт игроку. Возврат: Actions → shop-refund, номер ${from.id}.`,
      `#u${from.id}`,
    ].join('\n');
    try {
      await this.api('sendMessage', { chat_id: this.supportChat, text: card, disable_web_page_preview: true });
    } catch (e) {
      // бот не в чате поддержки — игроку всё равно ответим; тревога — по журналу
      this.o.log('error', 'tg_support', errFields(e));
    }
    if (command) await this.shop.support(from.id, from.language_code, true);
  }

  /** Ответ в чате поддержки на пересылку бота — игроку, чей #u<id> в пересылке. */
  private async onSupportReply(m: NonNullable<Update['message']>): Promise<void> {
    const re = m.reply_to_message;
    const to = re?.from?.is_bot ? /#u(\d{1,16})\s*$/.exec(re.text ?? '')?.[1] : undefined;
    if (!to || !m.text || m.from?.is_bot) return;
    try {
      await this.api('sendMessage', { chat_id: Number(to), text: m.text.slice(0, 3000) });
      if (m.message_id) await this.api('setMessageReaction', { chat_id: this.supportChat, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
    } catch (e) {
      this.o.log('warn', 'tg_support_reply', errFields(e));
    }
  }

  private get hookUrl(): string {
    return `${this.o.apiBase}/tg/hook`;
  }

  /** Метод Bot API; FormData — с файлами (стикеры). */
  async api<R = unknown>(method: string, body: Record<string, unknown> | FormData = {}): Promise<R> {
    const form = body instanceof FormData;
    const r = await this.f(`https://api.telegram.org/bot${this.o.token}/${method}`, {
      method: 'POST',
      ...(form ? {} : { headers: { 'Content-Type': 'application/json' } }),
      body: form ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(form ? 60_000 : 15_000),
    });
    const j = (await r.json()) as { ok: boolean; result?: R; description?: string };
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result as R;
  }

  // getMe кэшируется на 10 минут: инлайн-режим включают в BotFather — подхватится без перезапуска
  private async getMe() {
    if (!this.me || Date.now() - this.meAt > 600_000) {
      this.me = await this.api<{ username: string; supports_inline_queries?: boolean }>('getMe');
      this.meAt = Date.now();
    }
    return this.me;
  }

  private async link(start?: string): Promise<string> {
    const { username } = await this.getMe();
    return `https://t.me/${username}/${this.app}${start ? `?startapp=${encodeURIComponent(start)}` : ''}`;
  }

  /** Маршрут /tg/<path>. Ошибка вебхука — всё равно 200, иначе Telegram повторяет обновление. */
  async handle(method: string, path: string, headers: Record<string, string | string[] | undefined>, body: unknown): Promise<BotReply> {
    try {
      if (method === 'GET' && path === '/info') {
        const b = await this.getMe();
        return { status: 200, body: { username: b.username, app: this.app, inline: !!b.supports_inline_queries } };
      }
      if (method === 'GET' && path === '/status') {
        const w = await this.api<{ url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string }>('getWebhookInfo');
        this.me = null;
        const b = await this.getMe();
        return {
          status: 200,
          body: {
            bot: b.username,
            inline: !!b.supports_inline_queries,
            webhook: w.url === this.hookUrl,
            pending: w.pending_update_count ?? 0,
            lastError: w.last_error_message ?? null,
            lastErrorAt: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : null,
          },
        };
      }
      if (method === 'GET' && path === '/setup') {
        await this.setup();
        const b = await this.getMe();
        return { status: 200, body: { ok: true, bot: b.username, inline: !!b.supports_inline_queries, webhook: this.hookUrl } };
      }
      if (method === 'POST' && path === '/hook') {
        const got = String(headers['x-telegram-bot-api-secret-token'] ?? '');
        if (!safeEqual(got, this.hookSecret)) return { status: 403, body: { error: 'forbidden' } };
        const u = body as Update;
        // оплата: ошибка учёта — не 200, чтобы Telegram повторил обновление (повтор не выдаст набор дважды)
        if (u?.message?.successful_payment) {
          try {
            await this.shop.paid(u.message);
          } catch (e) {
            this.o.log('error', 'shop_paid', errFields(e));
            return { status: 500, body: { error: 'retry' } };
          }
          return { status: 200, body: { ok: true } };
        }
        try {
          if (u?.pre_checkout_query) await this.shop.preCheckout(u.pre_checkout_query);
          else if (u?.callback_query) await this.shop.onCallback(u.callback_query);
          // бесплатный стикерпак по внешней ссылке t.me/<бот>?start=stickers (только в личке: пак — этого игрока)
          else if (u?.message?.text === '/start stickers' && u.message.chat.type === 'private' && u.message.from) await this.shop.claimInChat(u.message.from);
          else if (u?.message?.text?.startsWith('/paysupport') && u.message.chat.type === 'private' && u.message.from) await this.onSupport(u.message.from, u.message.text.slice('/paysupport'.length), true);
          else if (u?.message && String(u.message.chat.id) === this.supportChat) await this.onSupportReply(u.message);
          else if (u?.message?.text?.startsWith('/stickers') && u.message.chat.type === 'private') await this.onStickers(u.message);
          else if (u?.message?.text?.startsWith('/start')) await this.onStart(u.message);
          else if (u?.message?.text && u.message.chat.type === 'private' && u.message.from && this.supportOpen(u.message.from.id)) await this.onSupport(u.message.from, u.message.text, false);
          else if (u?.inline_query) await this.onInline(u.inline_query);
          else if (u?.chosen_inline_result) await this.onChosen(u.chosen_inline_result);
        } catch (e) {
          this.o.log('error', 'tg_hook', errFields(e));
        }
        return { status: 200, body: { ok: true } };
      }
      if (method === 'POST' && (path === '/shop' || path.startsWith('/shop/'))) {
        const b = (body ?? {}) as { initData?: string; item?: unknown; mode?: unknown; token?: unknown; id?: unknown; on?: unknown; slot?: unknown; sticker?: unknown };
        const init = this.verify(b.initData ?? '');
        if (!init) return { status: 401, body: { error: 'bad_init' } };
        return await this.shop.route(path, init, b);
      }
      if (method === 'POST' && path === '/prepare') return await this.onPrepare(body as PrepareBody);
      if (method === 'POST' && (path === '/daily' || path === '/board')) return await this.onDaily(body as { initData?: string; n?: number; tries?: number; won?: boolean }, path === '/daily');
      return { status: 404, body: { error: 'not_found' } };
    } catch (e) {
      this.o.log('error', 'tg_error', { path, ...errFields(e) });
      return { status: 500, body: { error: 'server' } };
    }
  }

  /** Вебхук на этот сервер и профиль бота на двух языках. */
  async setup(): Promise<void> {
    await this.api('setWebhook', { url: this.hookUrl, secret_token: this.hookSecret, allowed_updates: ['message', 'inline_query', 'chosen_inline_result', 'pre_checkout_query', 'callback_query'], drop_pending_updates: false });
    const P = {
      ru: {
        description:
          'Массовка — пиксельная игра для компании на 2–4 телефона. На площадке 32 одинаковых человечка: почти все — массовка, среди них — вы. Прячься в толпе, вычисляй актёров и бей первым. Матч — 5 минут. Друзей нет рядом — места займут ИИ-актёры.\n\n🎬 После первого матча — бесплатный стикерпак с твоим актёром. Собирай стикеры за дубли и площадки, делай свои с подписью и отправляй в любой чат.',
        casting: ' А каждый день — «Кастинг дня»: найди актёра в массовке.',
        short: 'Пати-игра на 2–4 телефона и свой стикерпак: собери стикеры из дублей и шли друзьям.',
        stickersCmd: 'Мой стикерпак',
        supportCmd: 'Помощь с покупкой',
        name: 'Массовка',
        start: 'Играть в Массовку',
        menu: 'Играть',
      },
      en: {
        description:
          'Be Nobody is a pixel party game for 2–4 phones. 32 identical people on set: almost all are extras, and you are among them. Hide in the crowd, spot the actors and strike first. 5-minute matches. No friends around? AI actors take the empty seats.\n\n🎬 After your first match you get a free sticker pack with your actor. Collect stickers for takes and sets, make your own with a caption, and send them to any chat.',
        casting: ' Plus a daily casting: spot the actor among the extras.',
        short: 'A party game for 2–4 phones and your own sticker pack: collect stickers from your takes.',
        stickersCmd: 'My sticker pack',
        supportCmd: 'Purchase help',
        name: 'Be Nobody',
        start: 'Play Be Nobody',
        menu: 'Play',
      },
    };
    // Telegram разрешает менять имя и описания лишь несколько раз в сутки: меняем только то, что отличается,
    // и сбой профиля не мешает вебхуку
    const soft = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        this.o.log('warn', 'tg_profile', { what, err: String(e) });
      }
    };
    for (const [lang, p] of Object.entries(P)) {
      const language_code = lang === 'en' ? undefined : lang; // английский — по умолчанию для всех языков
      const description = p.description + (this.casting ? p.casting : '');
      await soft('name', async () => {
        const cur = await this.api<{ name: string }>('getMyName', { language_code });
        if (cur.name !== p.name) await this.api('setMyName', { name: p.name, language_code });
      });
      await soft('description', async () => {
        const cur = await this.api<{ description: string }>('getMyDescription', { language_code });
        if (cur.description !== description) await this.api('setMyDescription', { description, language_code });
      });
      await soft('short', async () => {
        const cur = await this.api<{ short_description: string }>('getMyShortDescription', { language_code });
        if (cur.short_description !== p.short) await this.api('setMyShortDescription', { short_description: p.short, language_code });
      });
      await soft('commands', () => this.api('setMyCommands', { commands: [{ command: 'start', description: p.start }, { command: 'stickers', description: p.stickersCmd }, { command: 'paysupport', description: p.supportCmd }], language_code }));
    }
    await soft('menu', () => this.api('setChatMenuButton', { menu_button: { type: 'web_app', text: P.ru.menu, web_app: { url: `${this.o.site}/?create=1&src=tg` } } }));
  }

  /** /stickers: кнопка на страницу «Мой стикерпак» в Mini App (там замок, свои стикеры, покупка набора). */
  private async onStickers(msg: NonNullable<Update['message']>): Promise<void> {
    const t = T[langOf(msg.from?.language_code)];
    await this.api('sendMessage', {
      chat_id: msg.chat.id,
      text: t.stickersText,
      reply_markup: { inline_keyboard: [[{ text: t.stickers, web_app: { url: `${this.o.site}/stickers?src=tg` } }]] },
    });
  }

  private async onStart(msg: NonNullable<Update['message']>): Promise<void> {
    const t = T[langOf(msg.from?.language_code)];
    const param = (msg.text ?? '').split(' ')[1] ?? '';
    const room = /^r_[A-Z]{4}$/.test(param);
    // «Играть» — новая комната (лобби): друзья приходят по приглашению, одному — свободные места займут ИИ-актёры.
    // Песочница с ботами — только дев-режим (startapp=dev…). Второй кнопкой — свой стикерпак.
    const path = room ? `/r/${param.slice(2)}` : param === 'daily' && this.casting ? '/daily' : '/?create=1';
    // кнопка web_app — только в личке; в группах — прямая ссылка Mini App
    const priv = msg.chat.type === 'private';
    const web = (text: string, p: string) => ({ text, web_app: { url: `${this.o.site}${p}${p.includes('?') ? '&' : '?'}src=tg` } });
    // канал игры — новости и ролики; кнопка ведёт в канал, игру не загораживает
    const channel = [{ text: t.channel, url: CHANNEL }];
    const rows = priv
      ? [[web(t.play, path)], ...(room ? [] : [[web(t.stickers, '/stickers'), web(t.wardrobe, '/wardrobe')]]), ...(this.casting ? [[web(t.daily, '/daily')]] : []), channel]
      : [
          [{ text: t.play, url: await this.link(room ? param : 'friends') }],
          ...(room ? [] : [[{ text: t.stickers, url: await this.link('stickers') }, { text: t.wardrobe, url: await this.link('shop') }]]),
          ...(this.casting ? [[{ text: t.daily, url: await this.link('daily') }]] : []),
          channel,
        ];
    await this.api('sendMessage', {
      chat_id: msg.chat.id,
      text: t.start + (this.casting ? t.startCasting : ''),
      reply_markup: { inline_keyboard: rows },
    });
  }

  /** Карточка «статья» с кнопкой-ссылкой в игру — для инлайн-ответа и для «поделиться» из Mini App. */
  private article(id: string, title: string, description: string, text: string, button: string, url: string) {
    return {
      type: 'article',
      id,
      title,
      description,
      thumbnail_url: `${this.o.site}/icons/icon-192.png`,
      input_message_content: { message_text: text },
      reply_markup: { inline_keyboard: [[{ text: button, url }]] },
    };
  }

  private async roomCard(t: Texts, code: string) {
    return this.article('room-' + code, fmt(t.roomTitle, { code }), t.roomDesc, fmt(t.roomText, { code }), t.join, await this.link(`r_${code}`));
  }

  private async dailyCard(t: Texts, squares: string) {
    const n = dailyNow();
    const text = fmt(t.dailyText, { n, squares: squares ? `\n${squares}` : '' });
    const id = [...squares].map((c) => (c === '🟩' ? 'g' : c === '🟥' ? 'r' : 'w')).join('');
    return this.article(`daily-${n}-${id}`, fmt(t.dailyTitle, { n }), t.dailyDesc, text, t.solve, await this.link('daily'));
  }

  /**
   * «Собрать комнату»: кнопка с меткой приглашения (startapp=g_<метка>). Первый нажавший создаёт комнату
   * на игровом сервере, остальные по той же карточке попадают в неё же (server.ts › createRoom, `invite`).
   */
  private async lobbyCard(t: Texts) {
    const tag = inviteTag();
    return this.article('lobby-' + tag, t.lobbyTitle, t.lobbyDesc, t.lobbyText, t.lobbyJoin, await this.link(`g_${tag}`));
  }

  private async inviteCard(t: Texts) {
    return this.article('invite', t.inviteTitle, t.inviteDesc, t.inviteText, t.play, await this.link());
  }

  private async onInline(q: NonNullable<Update['inline_query']>): Promise<void> {
    const t = T[langOf(q.from.language_code)];
    const query = q.query.trim();
    const room = /^([A-Za-z]{4})$/.exec(query);
    const daily = this.casting ? /^daily\b\s*(\S*)/u.exec(query) : null;
    const squares = daily && SQUARES.test(daily[1]) ? daily[1] : '';
    const results: unknown[] = [];
    // код комнаты набран руками — карточка этой комнаты; иначе первой — «Собрать комнату» (новое лобби)
    if (room) results.push(await this.roomCard(t, room[1].toUpperCase()));
    if (daily) results.push(await this.dailyCard(t, squares));
    if (!daily) results.push(await this.lobbyCard(t));
    if (!room && !daily) results.push(await this.inviteCard(t), ...(this.casting ? [await this.dailyCard(t, '')] : []));
    await this.api('answerInlineQuery', {
      inline_query_id: q.id,
      results,
      // у каждой карточки «Собрать комнату» своя метка — без кэша, иначе две компании попадут в одно лобби
      cache_time: 0,
      is_personal: true,
      button: { text: t.openApp, web_app: { url: `${this.o.site}/?src=tg` } },
    });
  }

  /**
   * Карточку «Собрать комнату» отправили в чат: запомнить её inline_message_id по метке — в конце матча
   * бот заменит карточку фильмом (в чат, где бота нет, писать нельзя, а своё инлайн-сообщение править можно).
   */
  private async onChosen(c: NonNullable<Update['chosen_inline_result']>): Promise<void> {
    const m = /^lobby-([A-Za-z0-9]{12})$/.exec(c.result_id);
    if (!m || !c.inline_message_id) return;
    await this.o.store.saveTgCard({ tag: m[1], inlineId: c.inline_message_id, lang: langOf(c.from.language_code) });
    this.o.log('info', 'tg_card_sent', {});
  }

  // ───────────── живая карточка «Собрать комнату» ─────────────

  /** Очередь правок карточек: когда правили последний раз и что поставить следующим (только самое свежее). */
  private edits = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null; job: (() => Promise<void>) | null }>();
  /** Карточки, ставшие видео (фильм): дальше правится подпись, а не текст. */
  private media = new Set<string>();

  /**
   * Игровой сервер: что сейчас на карточке комнаты по приглашению — состав лобби («2 из 4»), счёт съёмки
   * по дублям или «съёмку отменили». Правка уходит сразу, если карточку давно не трогали, иначе — самая
   * свежая через CARD_GAP_MS (промежуточные состояния пропускаем).
   */
  async card(n: CardNotice): Promise<BotReply> {
    if (!INVITE_TAG.test(n?.invite ?? '') || !/^[A-Z]{4}$/.test(n?.code ?? '') || !['lobby', 'playing', 'closed'].includes(n?.state)) return { status: 400, body: { error: 'bad_card' } };
    const card = await this.o.store.tgCard(n.invite);
    if (!card) return { status: 200, body: { sent: false } };
    const t = T[card.lang];
    const join = await this.link(`g_${n.invite}`);
    let text: string;
    let button: string;
    if (n.state === 'lobby') {
      const seats = (Array.isArray(n.seats) ? n.seats : []).slice(0, 8);
      const max = Math.max(2, Math.min(8, Number(n.max) || 4));
      const names = seats.map((x) => cardName(x?.name)).filter(Boolean);
      const k = seats.length;
      const squares = Array.from({ length: max }, (_, i) => (i < k ? (SEAT[Number(seats[i]?.color)] ?? '⬛') : '⬜')).join('');
      const hint = k >= max ? t.cardFull : k === max - 1 ? t.cardWait3 : k >= 2 ? t.cardWait2 : t.cardWait1;
      text = [t.cardGather, fmt(t.cardSeats, { names: names.join(', ') || '…', n: k, max }), squares, hint].join('\n');
      button = t.lobbyJoin;
    } else if (n.state === 'playing') {
      const take = Math.max(1, Math.min(99, Math.floor(Number(n.take)) || 1));
      const rows = (Array.isArray(n.scores) ? n.scores : []).slice(0, 8);
      const line = rows.map((x) => `${SEAT[Number(x?.color)] ?? ''}${cardName(x?.name)} ${Math.max(0, Math.floor(Number(x?.score)) || 0)}`).join(' · ');
      const target = Math.max(1, Math.min(99, Math.floor(Number(n.target)) || 8));
      text = [fmt(t.cardShooting, { code: n.code, take }), line, fmt(t.cardTarget, { n: target })].filter(Boolean).join('\n');
      // опоздавший по карточке попадёт в комнату зрителем (или на место ИИ)
      button = t.cardWatch;
    } else {
      text = t.cardClosed;
      button = t.lobbyJoin;
    }
    const markup = { inline_keyboard: [[{ text: button, url: join }]] };
    const job = () => this.editCard(n.invite, card.inlineId, text, markup);
    const e = this.edits.get(n.invite) ?? { at: 0, timer: null, job: null };
    this.edits.set(n.invite, e);
    e.job = job;
    if (e.timer) return { status: 200, body: { sent: true, queued: true } };
    const wait = e.at + CARD_GAP_MS - Date.now();
    if (wait <= 0) {
      await this.flushCard(n.invite);
      return { status: 200, body: { sent: true } };
    }
    e.timer = setTimeout(() => void this.flushCard(n.invite), wait);
    e.timer.unref?.();
    return { status: 200, body: { sent: true, queued: true } };
  }

  private async flushCard(tag: string): Promise<void> {
    const e = this.edits.get(tag);
    if (!e) return;
    e.timer = null;
    const job = e.job;
    e.job = null;
    if (!job) return;
    e.at = Date.now();
    try {
      await job();
    } catch (err) {
      const msg = String(err);
      // «не изменилось» — не ошибка (то же состояние пришло дважды, например после переезда комнаты)
      if (/not modified/i.test(msg)) return;
      this.o.log('warn', 'tg_card_edit', { err: msg });
      // Telegram просит подождать — повторить это же состояние, если новее не пришло
      if (/Too Many Requests/i.test(msg) && !e.job && !e.timer) {
        e.job = job;
        e.timer = setTimeout(() => void this.flushCard(tag), 5_000);
        e.timer.unref?.();
      }
    }
  }

  /** Текст карточки; если она уже видео (фильм прошлого матча) — подпись под ним. */
  private async editCard(tag: string, inlineId: string, text: string, markup: unknown): Promise<void> {
    if (!this.media.has(tag)) {
      try {
        await this.api('editMessageText', { inline_message_id: inlineId, text, reply_markup: markup });
        return;
      } catch (err) {
        if (!/no text in the message/i.test(String(err))) throw err;
        this.media.add(tag);
      }
    }
    await this.api('editMessageCaption', { inline_message_id: inlineId, caption: text, reply_markup: markup });
  }

  /** Подпись «Снято!»: звезда фильма (или ничья), до двух наград, счёт компании, комната. */
  private filmCaption(t: Texts, lang: Lang, n: FilmNotice): string {
    const names = (Array.isArray(n.winners) ? n.winners : []).map(cardName).filter(Boolean).slice(0, 4);
    const head = !names.length ? '🎬' : n.draw ? fmt(t.filmDoneDraw, { names: names.join(', ') }) : fmt(t.filmDone, { name: names[0] });
    const titles = DICTS[lang].awards as Record<string, { title: string } | undefined>;
    const awards = (Array.isArray(n.awards) ? n.awards : [])
      .map((a) => ({ title: titles[String(a?.id)]?.title, names: (Array.isArray(a?.names) ? a.names : []).map(cardName).filter(Boolean).slice(0, 3) }))
      .filter((a) => a.title && a.names.length)
      .slice(0, 2)
      .map((a) => fmt(t.filmAward, { title: a.title!, names: a.names.join(', ') }));
    const score = typeof n.score === 'string' ? n.score.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return [head, ...awards, score, fmt(t.filmRoom, { code: n.code })].filter(Boolean).join('\n');
  }

  /**
   * Фильм матча готов: карточка приглашения превращается в видео «Снято!» со звездой, наградами и кнопкой
   * «Реванш» (та же метка — та же комната). Каждый следующий матч этой комнаты заменяет видео на новое.
   * Telegram не смог взять видео — хотя бы текст с итогом и ссылкой на ролик.
   */
  async film(n: FilmNotice): Promise<BotReply> {
    if (!INVITE_TAG.test(n.invite ?? '') || !CLIP_ID.test(n.id ?? '') || !/^[A-Z]{4}$/.test(n.code ?? '')) return { status: 400, body: { error: 'bad_film' } };
    if (!this.o.clipBase) return { status: 503, body: { error: 'no_clips' } };
    const card = await this.o.store.tgCard(n.invite);
    if (!card) return { status: 200, body: { sent: false } };
    const t = T[card.lang];
    // недоставленный счёт съёмки больше не нужен — карточку займёт фильм
    const e = this.edits.get(n.invite);
    if (e) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      e.job = null;
      e.at = Date.now();
    }
    const caption = this.filmCaption(t, card.lang, n);
    const video = await this.clipUrl(n.id, 'mp4');
    const again = { text: t.filmAgain, url: await this.link(`g_${n.invite}`) };
    // загадка из этого фильма — для тех в чате, кто не играл
    const puzzle = n.puzzle && /^[A-Z2-9]{5}$/.test(n.puzzle) ? { text: t.filmPuzzle, url: await this.link(`c_${n.puzzle}`) } : null;
    const rows = puzzle ? [[again], [puzzle]] : [[again]];
    try {
      await this.api('editMessageMedia', {
        inline_message_id: card.inlineId,
        media: { type: 'video', media: video, caption, supports_streaming: true },
        reply_markup: { inline_keyboard: rows },
      });
      this.media.add(n.invite);
      this.o.log('info', 'tg_film_sent', { room: n.code });
      return { status: 200, body: { sent: true } };
    } catch (err) {
      this.o.log('warn', 'tg_film_media', { room: n.code, err: String(err) });
    }
    await this.editCard(n.invite, card.inlineId, caption, { inline_keyboard: [[{ text: t.filmWatch, url: video }], ...rows] });
    this.o.log('info', 'tg_film_sent', { room: n.code, text: true });
    return { status: 200, body: { sent: true, text: true } };
  }

  /**
   * «Поделиться» из Mini App (Bot API 8.0, WebApp.shareMessage): готовим карточку для этого игрока —
   * Telegram покажет выбор чата поверх игры, не закрывая её. Не вышло — клиент откроет обычное окно.
   */
  private async onPrepare(body: PrepareBody): Promise<BotReply> {
    const init = this.verify(body?.initData ?? '');
    if (!init) return { status: 401, body: { error: 'bad_init' } };
    const t = T[langOf(init.user.language_code)];
    let result;
    if (body.kind === 'room' && /^[A-Z]{4}$/.test(body.code ?? '')) result = await this.roomCard(t, body.code!);
    else if (body.kind === 'daily' && this.casting) result = await this.dailyCard(t, SQUARES.test(body.squares ?? '') ? body.squares! : '');
    else if (body.kind === 'clip' && CLIP_ID.test(body.clip ?? '')) {
      if (!this.o.clipBase) return { status: 503, body: { error: 'no_clips' } };
      // фильм матча из комнаты — кнопка «Реванш» туда же (по метке карточки или по коду комнаты)
      const again = INVITE_TAG.test(body.invite ?? '') ? `g_${body.invite}` : /^[A-Z]{4}$/.test(body.code ?? '') ? `r_${body.code}` : '';
      result = await this.clipCard(t, body.clip!, typeof body.text === 'string' ? safeCaption(body.text.slice(0, 300), this.o.site) : '', body.thumb === true, again);
    } else result = await this.inviteCard(t);
    const msg = await this.api<{ id: string }>('savePreparedInlineMessage', {
      user_id: init.user.id,
      result,
      allow_user_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
    });
    return { status: 200, body: { id: msg.id } };
  }

  // ───────────── клипы ─────────────

  /**
   * Адрес клипа для Telegram: прямая ссылка в S3, если файл там открыт (проверка HEAD, 4 с), иначе — игровой
   * сервер (`/v1/clips`, отдаёт с диска или из бакета). Без перенаправлений: по 302 Telegram видео не взял (26.11).
   */
  private async clipUrl(id: string, ext: 'mp4' | 'jpg'): Promise<string> {
    const server = `${this.o.clipBase}/v1/clips/${id}.${ext}`;
    if (!this.o.clipPublic) return server;
    const url = `${this.o.clipPublic}/${id}.${ext}`;
    try {
      const r = await this.f(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      if (r.ok) return url;
      this.o.log('warn', 'clip_public_miss', { id, ext, status: r.status });
    } catch (e) {
      this.o.log('warn', 'clip_public_miss', { id, ext, err: String(e).slice(0, 200) });
    }
    return server;
  }

  /** Видео-карточка: клип (его забирает сервер Telegram — из S3 или с игрового сервера), подпись и кнопка «Играть». */
  private async clipCard(t: Texts, id: string, text: string, thumb: boolean, again = '') {
    const [video, cover] = await Promise.all([this.clipUrl(id, 'mp4'), thumb ? this.clipUrl(id, 'jpg') : null]);
    return {
      type: 'video',
      id: 'clip-' + id,
      video_url: video,
      mime_type: 'video/mp4',
      thumbnail_url: cover ?? `${this.o.site}/icons/icon-192.png`,
      title: t.clipTitle,
      caption: text || t.inviteText,
      reply_markup: { inline_keyboard: [[again ? { text: t.filmAgain, url: await this.link(again) } : { text: t.play, url: await this.link('play') }]] },
    };
  }

  /** Проверка initData по документации Telegram: HMAC-SHA256 с ключом HMAC("WebAppData", токен); не старше суток. */
  verify(initData: string, nowSec = Date.now() / 1000): InitData | null {
    if (!initData || initData.length > 4096) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(this.o.token).digest();
    const want = createHmac('sha256', secret).update(check).digest('hex');
    if (!safeEqual(want, hash)) return null;
    const age = nowSec - Number(p.get('auth_date') ?? 0);
    if (!(age >= -60 && age < 86_400)) return null;
    try {
      const user = JSON.parse(p.get('user') ?? 'null');
      if (!user?.id) return null;
      return { user, chat_instance: p.get('chat_instance') ?? undefined };
    } catch {
      return null;
    }
  }

  private async onDaily(body: { initData?: string; n?: number; tries?: number; won?: boolean }, save: boolean): Promise<BotReply> {
    const init = this.verify(body?.initData ?? '');
    if (!init) return { status: 401, body: { error: 'bad_init' } };
    const n = Number(body.n);
    if (!Number.isInteger(n) || Math.abs(n - dailyNow()) > 1) return { status: 400, body: { error: 'bad_day' } };
    const chat = init.chat_instance;
    if (!chat || chat.length > 64) return { status: 200, body: { board: [], chat: false } };
    if (save) {
      const tries = Number(body.tries);
      if (!Number.isInteger(tries) || tries < 1 || tries > 3) return { status: 400, body: { error: 'bad_tries' } };
      const name = (init.user.first_name || init.user.username || '?').slice(0, 32);
      await this.o.store.saveDailyScore({ chat, day: n, userId: init.user.id, name, tries, won: !!body.won });
    }
    const rows = await this.o.store.dailyBoard(chat, n);
    return { status: 200, body: { board: rows.map((r) => ({ name: r.name, tries: r.tries, won: r.won, me: r.userId === init.user.id })), chat: true } };
  }
}

/**
 * Подпись видео-карточки приходит с телефона, а карточка уходит в чаты «через бота»: без чистки это обёртка
 * для спама и фишинга под брендом игры (ревью безопасности, M3). Оставляем только ссылки на свой сайт;
 * чужие адреса, домены и @упоминания вырезаем, невидимые и «переворачивающие» символы — тоже.
 */
export function safeCaption(text: string, site: string): string {
  let own = '';
  try {
    own = new URL(site).hostname.toLowerCase();
  } catch {
    /* сайт не задан — свои ссылки тоже вырезаются */
  }
  const ok = (host: string) => !!own && (host === own || host.endsWith('.' + own));
  return text
    // ZWJ (U+200D) оставляем: им склеены составные эмодзи
    .replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, (c) => (c === '\n' || c === '\u200d' ? c : ''))
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#]\S*)?/giu, (m) => {
      const host = m.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#:]/)[0].toLowerCase();
      return ok(host) ? m : '';
    })
    .replace(/(^|[^\p{L}\p{N}_])@[\p{L}\p{N}_]{3,}/gu, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
