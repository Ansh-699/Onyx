/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Solana wallet-adapter pulls in some node-ish deps; keep webpack happy.
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      os: false,
    };
    return config;
  },
};

export default nextConfig;
