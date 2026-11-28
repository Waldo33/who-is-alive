import type { Metadata, Viewport } from 'next';
import '@fontsource/press-start-2p/400.css';
import './globals.css';
import PwaRegister from './PwaRegister';
import TelegramBoot from '@/ui/TelegramBoot';
import { DICTS } from '@kto/game-core';
import { SITE_URL, STAGE } from '@/lib/env';
import { shareMetadata } from '@/lib/meta';

// превью по умолчанию — для любых адресов без своих метаданных (в том числе «страница не найдена»)
const defaults = shareMetadata('ru');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  openGraph: defaults.openGraph,
  twitter: defaults.twitter,
  title: 'Массовка · Be Nobody',
  description: 'Будь массовкой. Собирай звёзды. Everyone’s an extra. Someone’s acting.',
  applicationName: 'Массовка · Be Nobody',
  appleWebApp: { capable: true, title: 'Массовка', statusBarStyle: 'black-translucent' },
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
  // тестовый контур — не в поиск
  ...(STAGE ? { robots: { index: false, follow: false } } : {}),
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
        {STAGE && <div className="stage-badge" aria-hidden>{`${DICTS.ru.meta.stage} · ${DICTS.en.meta.stage}`}</div>}
        <PwaRegister />
        <TelegramBoot />
      </body>
    </html>
  );
}
