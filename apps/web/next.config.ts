import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kto/game-core', '@kto/net', '@kto/assets'],
  poweredByHeader: false,
  // свой сервер: один каталог с сервером и нужными модулями (docs/server-migration.md › 9)
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
  // шрифт и фон для картинок превью читаются с диска — берём их в серверную сборку
  outputFileTracingIncludes: { '/**': ['./assets/og/**'] },
  // метаданные (заголовок и картинка превью) — сразу в <head> для всех, а не потоком в конце страницы:
  // Next отдаёт их в <head> только знакомым ботам, а Telegram, Viber и прочие в его список не входят
  htmlLimitedBots: /.*/,
  // линтер запускается из корня монорепо в CI
  eslint: { ignoreDuringBuilds: true },
  // сервис-воркер всегда свежий: иначе обновления игры доходили бы до установленного приложения с опозданием
  // сайт переехал на свой сервер (benobody.app): сборка на Vercel только перенаправляет старые ссылки,
  // с путём и параметрами (комнаты /r/КОД, ?startapp из Telegram); фрагмент (#tgWebAppData) браузер сохраняет сам
  async redirects() {
    if (!process.env.VERCEL) return [];
    return [{ source: '/:path*', destination: 'https://benobody.app/:path*', permanent: false }];
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default config;
