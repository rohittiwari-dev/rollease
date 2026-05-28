import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Rollease server components rely on React server actions — enable them.
  experimental: {},
};

export default nextConfig;
