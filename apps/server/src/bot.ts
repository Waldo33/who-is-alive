import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { errFields } from './log';
import type { Logger } from './log';
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
  /** Подмена api.telegram.org (тесты). */
  fetchImpl?: typeof fetch;
}

/** Канал игры в Telegram (новости, ролики). */
const CHANNEL = 'https://t.me/benobody_app';

const T = {
  ru: {
    start: 'Массовка — пиксельная игра для компании: спрячься в толпе ботов и вычисли друзей раньше, чем они тебя.',
    startCasting: ' А каждый день — «Кастинг дня»: найди актёра в массовке.',
    play: '▶ Играть',
    friends: '👥 С друзьями',
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
    roomText: 'Заходи в «Массовку» — комната {code}. Спрячься в толпе и вычисли живых!',
    join: '▶ Войти в комнату',
    dailyTitle: 'Кастинг дня №{n}',
    dailyDesc: 'Найди актёра в массовке за три попытки',
    dailyText: 'Массовка · Кастинг №{n} · Найди актёра в массовке{squares}\nНайдёшь быстрее?',
    clipTitle: 'Лучший момент дубля',
    solve: '🎬 На кастинг',
    openApp: 'Открыть игру',
    filmText: '🎬 Фильм матча · комната {code}\n{result}\nЕщё дубль? Жми кнопку — та же комната.',
    filmWin: 'Победа: {names}',
    filmDraw: 'Ничья: {names}',
    filmAgain: '🎬 Ещё дубль',
    filmWatch: '▶ Смотреть фильм',
  },
  en: {
    start: 'Be Nobody is a pixel party game: hide in a crowd of bots and spot your friends before they spot you.',
    startCasting: ' Plus a daily casting: spot the actor among the extras.',
    play: '▶ Play',
    friends: '👥 With friends',
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
    roomText: 'Join me in Be Nobody — room {code}. Hide in the crowd and spot the humans!',
    join: '▶ Join the room',
    dailyTitle: 'Daily casting #{n}',
    dailyDesc: 'Spot the actor among the extras in three tries',
    dailyText: 'Be Nobody · Casting #{n} · Spot the actor{squares}\nCan you beat me?',
    clipTitle: 'Best moment of the take',
    solve: '🎬 Join the casting',
    openApp: 'Open the game',
    filmText: '🎬 Match film · room {code}\n{result}\nAnother take? Tap the button — same room.',
    filmWin: 'Winner: {names}',
    filmDraw: 'Draw: {names}',
    filmAgain: '🎬 Another take',
    filmWatch: '▶ Watch the film',
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
  message?: { chat: { id: number; type: string }; text?: string; from?: { language_code?: string } };
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
}

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
}

export class Bot {
  private readonly app: string;
  private readonly casting: boolean;
  private readonly f: typeof fetch;
  private me: { username: string; supports_inline_queries?: boolean } | null = null;
  private meAt = 0;
  readonly hookSecret: string;

  constructor(private readonly o: BotOptions) {
    this.app = o.app ?? 'play';
    this.casting = (o.features ?? []).includes('casting');
    this.f = o.fetchImpl ?? fetch;
    // секрет вебхука выводится из ключа бота — хранить отдельно не нужно (так же было в Supabase)
    this.hookSecret = createHash('sha256').update('kto-hook:' + o.token).digest('hex').slice(0, 48);
  }

  private get hookUrl(): string {
    return `${this.o.apiBase}/tg/hook`;
  }

  async api<R = unknown>(method: string, body: Record<string, unknown> = {}): Promise<R> {
    const r = await this.f(`https://api.telegram.org/bot${this.o.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
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
        try {
          if (u?.message?.text?.startsWith('/start')) await this.onStart(u.message);
          else if (u?.inline_query) await this.onInline(u.inline_query);
          else if (u?.chosen_inline_result) await this.onChosen(u.chosen_inline_result);
        } catch (e) {
          this.o.log('error', 'tg_hook', errFields(e));
        }
        return { status: 200, body: { ok: true } };
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
    await this.api('setWebhook', { url: this.hookUrl, secret_token: this.hookSecret, allowed_updates: ['message', 'inline_query', 'chosen_inline_result'], drop_pending_updates: false });
    const P = {
      ru: {
        description:
          'Массовка — пиксельная игра для компании на 2–4 телефона. На площади 32 одинаковых человечка: почти все — боты, среди них — вы. Прячься в толпе, вычисляй живых по поведению и бей первым. Матч — 5 минут.',
        casting: ' А каждый день — «Кастинг дня»: найди актёра в массовке.',
        short: 'Спрячься в толпе ботов и вычисли друзей первым. 2–4 игрока, 5 минут.',
        name: 'Массовка',
        start: 'Играть в Массовку',
        menu: 'Играть',
      },
      en: {
        description:
          'Be Nobody is a pixel party game for 2–4 phones. 32 identical people on the square: almost all are bots, and you are among them. Hide in the crowd, spot the humans by how they move, and strike first. 5-minute matches.',
        casting: ' Plus a daily casting: spot the actor among the extras.',
        short: 'Hide in a crowd of bots and spot your friends first. 2–4 players, 5 minutes.',
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
      await soft('commands', () => this.api('setMyCommands', { commands: [{ command: 'start', description: p.start }], language_code }));
    }
    await soft('menu', () => this.api('setChatMenuButton', { menu_button: { type: 'web_app', text: P.ru.menu, web_app: { url: `${this.o.site}/?src=tg` } } }));
  }

  private async onStart(msg: NonNullable<Update['message']>): Promise<void> {
    const t = T[langOf(msg.from?.language_code)];
    const param = (msg.text ?? '').split(' ')[1] ?? '';
    const room = /^r_[A-Z]{4}$/.test(param);
    // «Играть» — сразу матч с ИИ (одно касание), «С друзьями» — новая комната, чтобы звать
    const path = room ? `/r/${param.slice(2)}` : param === 'daily' && this.casting ? '/daily' : '/sandbox?go';
    // кнопка web_app — только в личке; в группах — прямая ссылка Mini App
    const priv = msg.chat.type === 'private';
    const web = (text: string, p: string) => ({ text, web_app: { url: `${this.o.site}${p}${p.includes('?') ? '&' : '?'}src=tg` } });
    // канал игры — новости и ролики; кнопка ведёт в канал, игру не загораживает
    const channel = [{ text: t.channel, url: CHANNEL }];
    const rows = priv
      ? [[web(t.play, path)], ...(room ? [] : [[web(t.friends, '/?create=1')]]), ...(this.casting ? [[web(t.daily, '/daily')]] : []), channel]
      : [
          [{ text: t.play, url: await this.link(room ? param : 'play') }],
          ...(room ? [] : [[{ text: t.friends, url: await this.link('friends') }]]),
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

  /**
   * Фильм матча готов: карточка приглашения превращается в видео с итогом и кнопкой «Ещё дубль»
   * (та же метка — та же комната). Каждый следующий матч этой комнаты заменяет видео на новое.
   * Telegram не смог взять видео — хотя бы текст с итогом и ссылкой на ролик.
   */
  async film(n: FilmNotice): Promise<BotReply> {
    if (!INVITE_TAG.test(n.invite ?? '') || !CLIP_ID.test(n.id ?? '') || !/^[A-Z]{4}$/.test(n.code ?? '')) return { status: 400, body: { error: 'bad_film' } };
    if (!this.o.clipBase) return { status: 503, body: { error: 'no_clips' } };
    const card = await this.o.store.tgCard(n.invite);
    if (!card) return { status: 200, body: { sent: false } };
    const t = T[card.lang];
    const names = (Array.isArray(n.winners) ? n.winners : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 4).map((x) => x.trim().slice(0, 24));
    const result = names.length ? fmt(n.draw ? t.filmDraw : t.filmWin, { names: names.join(', ') }) : '';
    const caption = fmt(t.filmText, { code: n.code, result }).replace('\n\n', '\n');
    const video = `${this.o.clipBase}/v1/clips/${n.id}.mp4`;
    const again = { text: t.filmAgain, url: await this.link(`g_${n.invite}`) };
    try {
      await this.api('editMessageMedia', {
        inline_message_id: card.inlineId,
        media: { type: 'video', media: video, caption, supports_streaming: true },
        reply_markup: { inline_keyboard: [[again]] },
      });
      this.o.log('info', 'tg_film_sent', { room: n.code });
      return { status: 200, body: { sent: true } };
    } catch (e) {
      this.o.log('warn', 'tg_film_media', { room: n.code, err: String(e) });
    }
    await this.api('editMessageText', {
      inline_message_id: card.inlineId,
      text: caption,
      reply_markup: { inline_keyboard: [[{ text: t.filmWatch, url: video }], [again]] },
    });
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
      result = await this.clipCard(t, body.clip!, typeof body.text === 'string' ? body.text.slice(0, 200) : '', body.thumb === true);
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

  /** Видео-карточка: клип (mp4 в Москве — его забирает сервер Telegram), подпись и кнопка «Играть». */
  private async clipCard(t: Texts, id: string, text: string, thumb: boolean) {
    const base = `${this.o.clipBase}/v1/clips/${id}`;
    return {
      type: 'video',
      id: 'clip-' + id,
      video_url: `${base}.mp4`,
      mime_type: 'video/mp4',
      thumbnail_url: thumb ? `${base}.jpg` : `${this.o.site}/icons/icon-192.png`,
      title: t.clipTitle,
      caption: text || t.inviteText,
      reply_markup: { inline_keyboard: [[{ text: t.play, url: await this.link('play') }]] },
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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
