import { randomBytes } from 'node:crypto';
import { jsonLogger } from './log';
import type { LogLevel } from './log';
import { Bot } from './bot';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClipStore } from './clips';
import { FilmService } from './film';
import { MatchRecordings } from './recordings';
import { GameServer } from './server';
import { MemoryStore, PgStore } from './store';
import type { Store } from './store';
import { loadGeo } from './geo';
import { VideoSwitch } from './video-switch';

/**
 * Запуск игрового сервера. Настройки — из окружения:
 *   PORT (8080), AUTH_SIGNING_KEY (обязателен в проде), INSTANCE (blue | green),
 *   PUBLIC_WS_BASE (wss://api.<домен>), PUBLIC_WS_HOSTS — свои входы через запятую (адрес WebSocket по Host запроса), ALLOWED_ORIGINS (через запятую), TRUST_PROXY=1, LOG_LEVEL,
 *   MAX_ROOMS — потолок комнат под память машины (~1,5 МБ на комнату, считает setup.sh; иначе 2000),
 *   REGION (msk | nl), GEOIP_DB — база стран для замера доступности, EVENTS_UPSTREAM — куда пересылать аналитику.
 *   LOAD_KEY — ключ нагрузочного прогона (load-test.yml), секрет рождается на сервере,
 *   PEER_HTTP + PEER_WS_URL — соседний экземпляр (синий ↔ зелёный): к нему переезжают комнаты при выкладке
 *   (POST /internal/drain изнутри машины), после drain процесс завершается сам.
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
      // клипы лежат на игровом сервере в Москве (clips.ts), бот только оформляет карточку
      clipBase: env.CLIP_BASE || env.PUBLIC_API_BASE || undefined,
    })
  : undefined;
if (!bot) log('warn', 'TELEGRAM_BOT_TOKEN не задан — бота нет');

// клипы для Telegram и фильмы матча: systemd StateDirectory=massovka-clips (/var/lib/massovka-clips)
const clips = new ClipStore(env.CLIP_DIR || env.STATE_DIRECTORY || undefined);

// «Фильм матча» монтирует сервер, если есть ffmpeg и шрифты (иначе — телефон, как раньше); FILM=off — выключить
const ffmpeg = env.FFMPEG || 'ffmpeg';
const fonts = env.FILM_FONTS || join(dirname(fileURLToPath(import.meta.url)), 'fonts');
let film: FilmService | undefined;
// аварийный выключатель видео: файл video-off в папке клипов (/var/lib/massovka-clips, общая у синего и
// зелёного; кнопка video-switch.yml) — не монтировать ничего и спрятать кнопки у телефонов
const video = new VideoSwitch(env.VIDEO_OFF_FILE || join(clips.dir, 'video-off'));
if (!video.on) log('warn', 'video_off');
if (env.FILM === 'off') log('info', 'film_off');
else if (spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status !== 0) log('warn', 'film_no_ffmpeg');
else if (!existsSync(join(fonts, 'press-start-2p-cyrillic-400-normal.woff'))) log('warn', 'film_no_fonts', { fonts });
else {
  // записи матчей (для перемонтажа фильма в других вариантах) — в подпапке клипов, 2 суток; MATCH_RECORDINGS=off — не писать
  const recordings = env.MATCH_RECORDINGS === 'off' ? undefined : new MatchRecordings(join(clips.dir, 'matches'));
  film = new FilmService({ store: clips, log, fonts, ffmpeg, recordings, enabled: () => video.on, site: (env.SITE_URL || 'https://benobody.app').replace(/^https?:\/\//, '').replace(/\/$/, '') });
  log('info', 'film_ready');
}

const server = new GameServer({
  store,
  bot,
  authSecret: secret,
  instance: env.INSTANCE || 'blue',
  publicWsBase: env.PUBLIC_WS_BASE || undefined,
  publicWsHosts: env.PUBLIC_WS_HOSTS ? env.PUBLIC_WS_HOSTS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined,
  allowedOrigins: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : '*',
  trustProxy: env.TRUST_PROXY === '1',
  maxRooms: Number(env.MAX_ROOMS) > 0 ? Number(env.MAX_ROOMS) : undefined,
  geo: loadGeo(env.GEOIP_DB || undefined, (msg, f) => log('info', msg, f)),
  region: env.REGION || undefined,
  eventsUpstream: env.EVENTS_UPSTREAM || undefined,
  loadKey: env.LOAD_KEY || undefined,
  peer: env.PEER_HTTP && env.PEER_WS_URL ? { http: env.PEER_HTTP, wsUrl: env.PEER_WS_URL } : undefined,
  // выкладка: все комнаты переехали к соседу или доиграли — выходим (systemd не перезапускает код 0)
  onDrained: () => void stop('drained'),
  log,
  clips,
  film,
  video,
});

const port = await server.listen(Number(env.PORT) || 8080);
log('info', 'listening', { port, instance: server.instance });

let stopping = false;
async function stop(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'stopping', { sig });
  // выкладка не останавливает старый экземпляр, а переводит его в drain (docs/infra-plan.md › этап 1);
  // SIGTERM — остановка руками или перезагрузка машины: идущие комнаты закрываются
  await server.close();
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
