import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Кто тут живой? · Who’s Alive?',
    short_name: 'Кто живой?',
    description: 'Найди живых. Не выдай себя. Find the living. Don’t give yourself away.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#181425',
    theme_color: '#181425',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
