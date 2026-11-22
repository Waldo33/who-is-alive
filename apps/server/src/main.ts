import { randomBytes } from 'node:crypto';
import { jsonLogger } from './log';
import type { LogLevel } from './log';
import { GameServer } from './server';

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

const server = new GameServer({
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
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
