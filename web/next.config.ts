import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Para que funcione con los módulos ESM del monorepo
  transpilePackages: ['@duelodev/shared'],
};

export default nextConfig;
