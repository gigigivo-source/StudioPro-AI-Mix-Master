import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the sandboxed preview host (https://<port>-<sandbox>.e2b.app) to talk
  // to the dev server for HMR / RSC requests.
  allowedDevOrigins: ["*.e2b.app", "*.e2b.dev", "*.arena.ai"],
};

export default nextConfig;
