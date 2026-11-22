// Сервер бота «Массовки» в Telegram (Supabase Edge Function, Deno).
//
// Маршруты (https://<проект>.supabase.co/functions/v1/tg-bot/...):
//   GET  /info   — юзернейм бота, имя прямой ссылки Mini App, включён ли инлайн-режим (для клиента);
//   GET  /setup  — привязать вебхук Telegram к /hook (владелец открывает один раз после того, как
//                  положил ключ бота в секреты Supabase); повторно — безвредно;
//   POST /hook   — обновления от Telegram: /start и инлайн-запросы «@бот …»;
//   POST /daily  — результат загадки дня из Mini App (подписанный initData) → рейтинг этого чата;
//   POST /board  — рейтинг загадки дня в чате;
//   POST /prepare — карточка «поделиться» для WebApp.shareMessage (комната, загадка, приглашение).
//
// Секреты: TELEGRAM_BOT_TOKEN (кладёт владелец в Supabase → Edge Functions → Secrets).
// Необязательно: TG_APP_NAME (короткое имя прямой ссылки, по умолчанию «play»), SITE_URL.
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase передаёт сам.
// JWT не проверяется (Telegram его не шлёт): вебхук проверяет секретный заголовок, Mini App — подпись initData.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const APP = Deno.env.get('TG_APP_NAME') ?? 'play';
const SITE = Deno.env.get('SITE_URL') ?? 'https://who-is-alive.vercel.app';
const FN_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/tg-bot`;
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** Секрет вебхука: выводится из ключа бота — хранить отдельно не нужно. */
async function hookSecret(): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode('kto-hook:' + TOKEN))).slice(0, 48);
}

async function api<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result as T;
}

// getMe кэшируется на 10 минут: инлайн-режим включают в BotFather — подхватится без передеплоя
let me: { username: string; supports_inline_queries?: boolean } | null = null;
let meAt = 0;
async function getMe() {
  if (!me || Date.now() - meAt > 600_000) {
    me = await api<{ username: string; supports_inline_queries?: boolean }>('getMe');
    meAt = Date.now();
  }
  return me;
}

// ───────────── тексты бота (ru/en по языку пользователя Telegram) ─────────────

const T = {
  ru: {
    start: 'Массовка — пиксельная игра для компании: спрячься в толпе ботов и вычисли друзей раньше, чем они тебя. А каждый день — загадка «Найди живого».',
    play: '▶ Играть',
    daily: '🔎 Загадка дня',
    inviteTitle: 'Позвать в «Массовку»',
    inviteDesc: 'Карточка с кнопкой: друзья откроют игру прямо в Telegram',
    inviteText: 'Сыграем в «Массовку»? 32 одинаковых человечка, среди них — мы. Кто кого вычислит первым?',
    roomTitle: 'Позвать в комнату {code}',
    roomDesc: 'Друзья попадут сразу в твою комнату',
    roomText: 'Заходи в «Массовку» — комната {code}. Спрячься в толпе и вычисли живых!',
    join: '▶ Войти в комнату',
    dailyTitle: 'Загадка дня №{n}',
    dailyDesc: 'Найди живого в толпе за три попытки',
    dailyText: 'Массовка · Загадка №{n} · Найди живого{squares}\nНайдёшь быстрее?',
    solve: '🔎 Решить загадку',
    openApp: 'Открыть игру',
  },
  en: {
    start: 'Be Nobody is a pixel party game: hide in a crowd of bots and spot your friends before they spot you. Plus a daily “Spot the human” puzzle.',
    play: '▶ Play',
    daily: '🔎 Daily puzzle',
    inviteTitle: 'Invite to Be Nobody',
    inviteDesc: 'A card with a button: friends open the game right in Telegram',
    inviteText: 'Play Be Nobody? 32 identical pixel people, and we are among them. Who spots whom first?',
    roomTitle: 'Invite to room {code}',
    roomDesc: 'Friends join your room directly',
    roomText: 'Join me in Be Nobody — room {code}. Hide in the crowd and spot the humans!',
    join: '▶ Join the room',
    dailyTitle: 'Daily puzzle #{n}',
    dailyDesc: 'Spot the human in the crowd in three tries',
    dailyText: 'Be Nobody · Puzzle #{n} · Spot the human{squares}\nCan you beat me?',
    solve: '🔎 Solve the puzzle',
    openApp: 'Open the game',
  },
};
type Lang = keyof typeof T;
const langOf = (code?: string): Lang => (code && /^(ru|uk|be|kk)/.test(code) ? 'ru' : 'en');
const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** Номер загадки дня (как в game-core › daily.ts): №1 — 23.11.2026, по дате UTC. */
function dailyNow(): number {
  return Math.max(1, Math.floor((Date.now() - Date.UTC(2026, 10, 23)) / 86_400_000) + 1);
}

async function link(start?: string): Promise<string> {
  const { username } = await getMe();
  return `https://t.me/${username}/${APP}${start ? `?startapp=${encodeURIComponent(start)}` : ''}`;
}

// ───────────── обновления Telegram ─────────────

interface Update {
  message?: { chat: { id: number; type: string }; text?: string; from?: { language_code?: string } };
  inline_query?: { id: string; query: string; from: { language_code?: string } };
}

async function onStart(msg: NonNullable<Update['message']>): Promise<void> {
  const t = T[langOf(msg.from?.language_code)];
  const param = (msg.text ?? '').split(' ')[1] ?? '';
  const path = /^r_[A-Z]{4}$/.test(param) ? `/r/${param.slice(2)}` : param === 'daily' ? '/daily' : '/';
  // кнопка web_app — только в личке; в группах — прямая ссылка Mini App
  const priv = msg.chat.type === 'private';
  const web = (text: string, p: string) => ({ text, web_app: { url: `${SITE}${p}?src=tg` } });
  await api('sendMessage', {
    chat_id: msg.chat.id,
    text: t.start,
    reply_markup: {
      inline_keyboard: priv
        ? [[web(t.play, path)], [web(t.daily, '/daily')]]
        : [[{ text: t.play, url: await link(param || undefined) }], [{ text: t.daily, url: await link('daily') }]],
    },
  });
}

type Texts = (typeof T)['ru'];

/** Карточка «статья» с кнопкой-ссылкой в игру — для инлайн-ответа и для «поделиться» из Mini App. */
function article(id: string, title: string, description: string, text: string, button: string, url: string) {
  return {
    type: 'article',
    id,
    title,
    description,
    thumbnail_url: `${SITE}/icons/icon-192.png`,
    input_message_content: { message_text: text },
    reply_markup: { inline_keyboard: [[{ text: button, url }]] },
  };
}

const roomCard = async (t: Texts, code: string) =>
  article('room-' + code, fmt(t.roomTitle, { code }), t.roomDesc, fmt(t.roomText, { code }), t.join, await link(`r_${code}`));

async function dailyCard(t: Texts, squares: string) {
  const n = dailyNow();
  const text = fmt(t.dailyText, { n, squares: squares ? `\n${squares}` : '' });
  const id = [...squares].map((c) => (c === '🟩' ? 'g' : c === '🟥' ? 'r' : 'w')).join('');
  return article(`daily-${n}-${id}`, fmt(t.dailyTitle, { n }), t.dailyDesc, text, t.solve, await link('daily'));
}

const inviteCard = async (t: Texts) => article('invite', t.inviteTitle, t.inviteDesc, t.inviteText, t.play, await link());

const SQUARES = /^[🟥🟩⬜]{1,6}$/u;

async function onInline(q: NonNullable<Update['inline_query']>): Promise<void> {
  const t = T[langOf(q.from.language_code)];
  const query = q.query.trim();
  const room = /^([A-Za-z]{4})$/.exec(query);
  const daily = /^daily\b\s*(\S*)/u.exec(query);
  const squares = daily && SQUARES.test(daily[1]) ? daily[1] : '';
  const results: unknown[] = [];
  if (room) results.push(await roomCard(t, room[1].toUpperCase()));
  if (daily) results.push(await dailyCard(t, squares));
  if (!room && !daily) results.push(await inviteCard(t), await dailyCard(t, ''));
  await api('answerInlineQuery', {
    inline_query_id: q.id,
    results,
    cache_time: room || daily ? 0 : 300,
    is_personal: true,
    button: { text: t.openApp, web_app: { url: `${SITE}/?src=tg` } },
  });
}

/**
 * «Поделиться» из Mini App (Bot API 8.0, WebApp.shareMessage): готовим карточку для этого игрока —
 * Telegram покажет выбор чата поверх игры, не закрывая её. Не вышло — клиент откроет обычное окно.
 */
async function onPrepare(body: { initData?: string; kind?: string; code?: string; squares?: string }): Promise<Response> {
  const init = await verify(body.initData ?? '');
  if (!init) return json({ error: 'bad_init' }, 401);
  const t = T[langOf(init.user.language_code)];
  let result;
  if (body.kind === 'room' && /^[A-Z]{4}$/.test(body.code ?? '')) result = await roomCard(t, body.code!);
  else if (body.kind === 'daily') result = await dailyCard(t, SQUARES.test(body.squares ?? '') ? body.squares! : '');
  else result = await inviteCard(t);
  const msg = await api<{ id: string }>('savePreparedInlineMessage', {
    user_id: init.user.id,
    result,
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
  });
  return json({ id: msg.id });
}

// ───────────── Mini App: подпись initData и рейтинг загадки в чате ─────────────

interface Init {
  user: { id: number; first_name?: string; username?: string; language_code?: string };
  chat_instance?: string;
}

/** Проверка initData по документации Telegram: HMAC-SHA256 с ключом HMAC("WebAppData", токен); не старше суток. */
async function verify(initData: string): Promise<Init | null> {
  if (!initData || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = new Uint8Array(await hmac(enc.encode('WebAppData'), TOKEN));
  if (hex(await hmac(secret, check)) !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get('auth_date') ?? 0);
  if (!(age >= -60 && age < 86_400)) return null;
  try {
    const user = JSON.parse(p.get('user') ?? 'null');
    if (!user?.id) return null;
    return { user, chat_instance: p.get('chat_instance') ?? undefined };
  } catch {
    return null;
  }
}

async function board(chat: string, n: number, self: number) {
  const { data } = await db
    .from('tg_daily_scores')
    .select('tg_user_id, name, tries, won')
    .eq('chat_instance', chat)
    .eq('n', n)
    .order('won', { ascending: false })
    .order('tries', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(20);
  return (data ?? []).map((r) => ({ name: r.name, tries: r.tries, won: r.won, me: r.tg_user_id === self }));
}

async function onDaily(body: { initData?: string; n?: number; tries?: number; won?: boolean }, save: boolean): Promise<Response> {
  const init = await verify(body.initData ?? '');
  if (!init) return json({ error: 'bad_init' }, 401);
  const n = Number(body.n);
  if (!Number.isInteger(n) || Math.abs(n - dailyNow()) > 1) return json({ error: 'bad_day' }, 400);
  if (!init.chat_instance) return json({ board: [], chat: false });
  if (save) {
    const tries = Number(body.tries);
    if (!Number.isInteger(tries) || tries < 1 || tries > 3) return json({ error: 'bad_tries' }, 400);
    const name = (init.user.first_name || init.user.username || '?').slice(0, 32);
    // первый результат за день — окончательный (как в самой загадке)
    await db.from('tg_daily_scores').upsert(
      { chat_instance: init.chat_instance, tg_user_id: init.user.id, name, n, tries, won: !!body.won },
      { onConflict: 'chat_instance,n,tg_user_id', ignoreDuplicates: true },
    );
  }
  return json({ board: await board(init.chat_instance, n, init.user.id), chat: true });
}

// ───────────── вход ─────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/tg-bot/, '') || '/';
  if (!TOKEN) return json({ error: 'no_token', hint: 'Supabase → Edge Functions → Secrets: TELEGRAM_BOT_TOKEN' }, 503);
  try {
    if (req.method === 'GET' && path === '/info') {
      const b = await getMe();
      return json({ username: b.username, app: APP, inline: !!b.supports_inline_queries });
    }
    if (req.method === 'GET' && path === '/setup') {
      await api('setWebhook', { url: `${FN_URL}/hook`, secret_token: await hookSecret(), allowed_updates: ['message', 'inline_query'], drop_pending_updates: true });
      const b = await getMe();
      return json({ ok: true, bot: b.username, inline: !!b.supports_inline_queries, webhook: `${FN_URL}/hook` });
    }
    if (req.method === 'POST' && path === '/hook') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== (await hookSecret())) return json({ error: 'forbidden' }, 403);
      const u = (await req.json()) as Update;
      if (u.message?.text?.startsWith('/start')) await onStart(u.message);
      else if (u.inline_query) await onInline(u.inline_query);
      return json({ ok: true });
    }
    if (req.method === 'POST' && path === '/prepare') return await onPrepare(await req.json());
    if (req.method === 'POST' && (path === '/daily' || path === '/board')) return await onDaily(await req.json(), path === '/daily');
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    console.error(e);
    // вебхуку всегда 200: иначе Telegram будет повторять одно и то же обновление
    return path === '/hook' ? json({ ok: false }) : json({ error: 'server' }, 500);
  }
});
