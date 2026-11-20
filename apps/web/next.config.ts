import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kto/game-core', '@kto/net', '@kto/assets'],
  poweredByHeader: false,
  // линтер запускается из корня монорепо в CI
  eslint: { ignoreDuringBuilds: true },
};

export default config;
