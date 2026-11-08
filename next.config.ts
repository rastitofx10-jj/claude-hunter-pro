import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Round 4: build is HONEST. ignoreBuildErrors was removed — 12 real type errors
  // were shipping silently to production (typecheck caught them, next build hid
  // them). From now on, typecheck/lint must be green for the build to pass.
  reactStrictMode: false,
};

export default nextConfig;
