import type { Metadata, Viewport } from 'next';
import '@fontsource/press-start-2p/400.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Кто тут живой? · Who’s Alive?',
  description: 'Найди живых. Не выдай себя. Find the living. Don’t give yourself away.',
  applicationName: 'Кто тут живой? · Who’s Alive?',
  appleWebApp: { capable: true, title: 'Кто живой?', statusBarStyle: 'black-translucent' },
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
      <body>{children}</body>
    </html>
  );
}
