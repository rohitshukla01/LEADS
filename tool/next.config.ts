import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack root to this folder: with a lockfile in a parent folder, Next would
  // take the parent as the root and fail to resolve node_modules. __dirname is available
  // because package.json sets no "type" (CommonJS).
  turbopack: {
    root: __dirname,
  },
  // Load pdf-parse from node_modules instead of bundling it: when bundled, its entry file
  // tries to read a test PDF and the build fails.
  serverExternalPackages: ["pdf-parse"],
  reactStrictMode: false,
};

export default nextConfig;
