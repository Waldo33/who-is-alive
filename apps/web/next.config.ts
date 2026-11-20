import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kto/game-core', '@kto/net', '@kto/assets'],
  poweredByHeader: false,
  // шрифт и фон для картинок превью читаются с диска — берём их в серверную сборку
  outputFileTracingIncludes: { '/**': ['./assets/og/**'] },
  // линтер запускается из корня монорепо в CI
  eslint: { ignoreDuringBuilds: true },
  // сервис-воркер всегда свежий: иначе обновления игры доходили бы до установленного приложения с опозданием
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
