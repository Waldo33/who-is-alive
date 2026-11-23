import { randomBytes } from 'node:crypto';
import { jsonLogger } from './log';
import type { LogLevel } from './log';
import { Bot } from './bot';
import { GameServer } from './server';
import { MemoryStore, PgStore } from './store';
import type { Store } from './store';

/**
 * Запуск игрового сервера. Настройки — из окружения:
 *   PORT (8080), AUTH_SIGNING_KEY (обязателен в проде), INSTANCE (blue | green),
 *   PUBLIC_WS_BASE (wss://api.<домен>), ALLOWED_ORIGINS (через запятую), TRUST_PROXY=1, LOG_LEVEL.
 */
const env = process.env;
const log = jsonLogger((env.LOG_LEVEL as LogLevel) || 'info');
const prod = env.NODE_ENV === 'production';
let secret = env.AUTH_SIGNING_KEY ?? '';
if (!secret) {
  if (prod) {
    log('error', 'AUTH_SIGNING_KEY не задан');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  log('warn', 'AUTH_SIGNING_KEY не задан — временный ключ (токены умрут с перезапуском)');
}

let store: Store = new MemoryStore();
if (env.DATABASE_URL) {
  const pgStore = new PgStore(env.DATABASE_URL, log);
  try {
    await pgStore.migrate();
    store = pgStore;
    log('info', 'db_ready');
  } catch (e) {
    // без базы игра всё равно работает — только аналитика копится в памяти
    log('error', 'db_unavailable', { err: String(e) });
  }
} else log('warn', 'DATABASE_URL не задан — аналитика в памяти');

// Telegram-бот: ключ — в секретах сервера (/etc/massovka/secrets.env), без ключа бота нет
const bot = env.TELEGRAM_BOT_TOKEN
  ? new Bot({
      token: env.TELEGRAM_BOT_TOKEN,
      apiBase: env.PUBLIC_API_BASE || (env.PUBLIC_WS_BASE ?? '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
      site: env.SITE_URL || 'https://benobody.app',
      app: env.TG_APP_NAME || 'play',
      features: (env.FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      store,
      log,
      // клипы для Telegram: systemd StateDirectory=massovka-clips (/var/lib/massovka-clips)
      clipDir: env.CLIP_DIR || env.STATE_DIRECTORY || undefined,
    })
  : undefined;
if (!bot) log('warn', 'TELEGRAM_BOT_TOKEN не задан — бота нет');

const server = new GameServer({
  store,
  bot,
  authSecret: secret,
  instance: env.INSTANCE || 'blue',
  publicWsBase: env.PUBLIC_WS_BASE || undefined,
  allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : '*',
  trustProxy: env.TRUST_PROXY === '1',
  log,
});

const port = await server.listen(Number(env.PORT) || 8080);
log('info', 'listening', { port, instance: server.instance });

let stopping = false;
async function stop(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'stopping', { sig });
  // TODO этап 3: режим drain — доиграть матчи и перевезти лобби на новый экземпляр
  await server.close();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
