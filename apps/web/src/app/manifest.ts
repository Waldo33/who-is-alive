import type { MetadataRoute } from 'next';

/**
 * Ссылки на комнату открывают установленное приложение, а не вкладку браузера:
 * Android (Chrome, установлено с главного экрана) — ссылки сайта уходят в приложение само;
 * `launch_handler` — переиспользовать уже открытое окно игры, а не плодить новые;
 * `handle_links` — то же для Chrome на компьютере. На iPhone так нельзя: iOS всегда
 * открывает ссылки в Safari (или в браузере мессенджера), приложение с экрана «Домой» их не ловит.
 * Полей нет в типе Next — добавляем сверху.
 */
type Manifest = MetadataRoute.Manifest & {
  launch_handler?: { client_mode: 'navigate-existing' | 'focus-existing' | 'navigate-new' | 'auto' };
  handle_links?: 'preferred' | 'auto' | 'not-preferred';
};

export default function manifest(): Manifest {
  return {
    id: '/',
    name: 'Массовка · Be Nobody',
    short_name: 'Массовка',
    description: 'Будь массовкой. Собирай звёзды. Everyone’s an extra. Someone’s acting.',
    lang: 'ru',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    launch_handler: { client_mode: 'navigate-existing' },
    handle_links: 'preferred',
    orientation: 'portrait',
    background_color: '#181425',
    theme_color: '#181425',
    categories: ['games', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Создать игру · New game', url: '/?source=shortcut', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Играть с ботами · Play with bots', url: '/sandbox', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
