import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // The marketing copy lives in design/marketing-copy.json at the repository root.
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  transpilePackages: ["@everyfield/domain", "@everyfield/db", "@everyfield/ui"],
  // The Hugeicons free set is one barrel of about 6,000 icons; this rewrites its imports to the icons in use.
  experimental: { optimizePackageImports: ["@hugeicons/core-free-icons"] },
};

export default config;
