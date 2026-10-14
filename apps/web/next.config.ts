import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // The marketing copy lives in design/marketing-copy.json at the repository root.
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  transpilePackages: ["@everyfield/early-access", "@everyfield/database"],
};

export default config;
