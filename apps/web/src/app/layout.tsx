import type { Metadata, Viewport } from 'next';
import '@fontsource/press-start-2p/400.css';
import './globals.css';
import PwaRegister from './PwaRegister';
import { SITE_URL } from '@/lib/env';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  openGraph: {
    type: 'website',
    siteName: 'Кто тут живой? · Who’s Alive?',
    title: 'Кто тут живой? · Who’s Alive?',
    description: 'Пиксельная игра для компании: найди живых среди 32 одинаковых человечков и не выдай себя.',
    locale: 'ru_RU',
    alternateLocale: ['en_US'],
  },
  twitter: { card: 'summary_large_image' },
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
