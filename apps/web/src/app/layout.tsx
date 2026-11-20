import type { Metadata, Viewport } from 'next';
import '@fontsource/press-start-2p/400.css';
import './globals.css';
import PwaRegister from './PwaRegister';
import { SITE_URL } from '@/lib/env';
import { shareMetadata } from '@/lib/meta';

// превью по умолчанию — для любых адресов без своих метаданных (в том числе «страница не найдена»)
const defaults = shareMetadata('ru');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  openGraph: defaults.openGraph,
  twitter: defaults.twitter,
  title: 'Кто тут живой? · Who’s Alive?',
  description: 'Найди живых. Не выдай себя. Find the living. Don’t give yourself away.',
  applicationName: 'Кто тут живой? · Who’s Alive?',
  appleWebApp: { capable: true, title: 'Кто живой?', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32' },
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '192x192' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#181425',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
