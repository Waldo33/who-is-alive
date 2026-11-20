import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Кто тут живой? · Who’s Alive?',
    short_name: 'Кто живой?',
    description: 'Найди живых. Не выдай себя. Find the living. Don’t give yourself away.',
    lang: 'ru',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
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
