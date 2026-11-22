/**
 * Telegram Mini App: «бот/приложение» (ссылка t.me/<это>?startapp=…) или просто «бот», если приложение —
 * главное у бота. Пусто — ссылки ведут на сайт.
 */
export const TG_APP = process.env.NEXT_PUBLIC_TG_APP ?? 'be_nobody_bot/play';

/** Адрес сайта для абсолютных ссылок в превью (og:image и т. п.). */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://benobody.app';

/** Свой игровой сервер (комнаты и матчи; docs/server-migration.md). */
export const GAME_API = (process.env.NEXT_PUBLIC_GAME_API || 'https://api.benobody.app').replace(/\/$/, '');
