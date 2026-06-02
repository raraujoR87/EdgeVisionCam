/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['undici'],
  },
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
