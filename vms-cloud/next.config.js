/** @type {import('next').NextConfig} */
const nextConfig = {
  optimizeFonts: false,
  experimental: {
    serverComponentsExternalPackages: ['undici'],
  },
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
