import type { NextConfig } from 'next';

const mempoolHost = process.env.NEXT_PUBLIC_MEMPOOL_HOST || 'http://127.0.0.1:3006';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/mempool/:path*',
        destination: `${mempoolHost}/:path*`,
      },
    ];
  },
};

export default nextConfig;
