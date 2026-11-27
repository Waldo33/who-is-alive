import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Вход на сайт через бота (браузер, не Mini App) — как в других приложениях: сайт берёт одноразовый код
 * (`POST /tg/login/start`), кнопка открывает бота `t.me/<бот>?start=login_<код>`, игрок жмёт «Войти» в
 * чате с ботом, сайт опрашивает `POST /tg/login/poll { code, secret }` и получает данные входа.
 *
 * Данные входа — в формате Telegram Login Widget ({ id, first_name, username, auth_date, hash }), подписанные
 * тем же ключом SHA256(токен бота): дальше их проверяет `bot.ts › verifyLogin`, как будто вход прошёл через
 * виджет. Ни номера телефона, ни окна oauth.telegram.org.
 *
 * Код из ссылки виден в чате, поэтому забрать вход можно только с секретом, который знает лишь браузер.
 * Подтверждение — кнопкой, а не самим /start: чужая ссылка «войти» не впустит чужой браузер молча.
 * Коды живут в памяти 10 минут (перезапуск бота — просто «попробуй ещё раз»).
 */

export interface WebLoginUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface Pending {
  secret: string;
  at: number;
  user: WebLoginUser | null;
}

export const LOGIN_CODE = /^[A-Za-z0-9_-]{22}$/;
const TTL_MS = 10 * 60_000;
const MAX = 5000;

const rnd = () => randomBytes(16).toString('base64url');

export class WebLogins {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {}

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (t - p.at > TTL_MS) this.pending.delete(k);
  }

  /** Новый код (в ссылку на бота) и секрет (только браузеру). null — слишком много ожидающих входов. */
  start(): { code: string; secret: string } | null {
    this.sweep();
    if (this.pending.size >= MAX) return null;
    const code = rnd();
    const secret = rnd();
    this.pending.set(code, { secret, at: this.now(), user: null });
    return { code, secret };
  }

  /** Код ещё ждёт подтверждения (для сообщения бота «Войти?»). */
  waiting(code: string): boolean {
    this.sweep();
    const p = this.pending.get(code);
    return !!p && !p.user;
  }

  /** Игрок нажал «Войти» в чате с ботом. false — код устарел или уже использован. */
  confirm(code: string, user: WebLoginUser): boolean {
    this.sweep();
    const p = this.pending.get(code);
    if (!p || p.user) return false;
    p.user = { id: user.id, ...(user.first_name ? { first_name: user.first_name.slice(0, 64) } : {}), ...(user.username ? { username: user.username.slice(0, 64) } : {}) };
    return true;
  }

  /** Опрос сайта: 'wait' — ещё не подтвердил, 'gone' — код устарел или не тот секрет, иначе — данные входа (один раз). */
  poll(code: unknown, secret: unknown): 'wait' | 'gone' | Record<string, string | number> {
    this.sweep();
    if (typeof code !== 'string' || typeof secret !== 'string' || !LOGIN_CODE.test(code)) return 'gone';
    const p = this.pending.get(code);
    if (!p || !safeEq(p.secret, secret)) return 'gone';
    if (!p.user) return 'wait';
    this.pending.delete(code);
    return this.sign(p.user);
  }

  /** Подпись как у Telegram Login Widget: HMAC-SHA256(строка проверки, SHA256(токен)). */
  sign(user: WebLoginUser): Record<string, string | number> {
    const d: Record<string, string | number> = { ...user, auth_date: Math.floor(this.now() / 1000) };
    const check = Object.entries(d)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    d.hash = createHmac('sha256', createHash('sha256').update(this.token).digest()).update(check).digest('hex');
    return d;
  }
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
