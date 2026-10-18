import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const config: NextConfig = {
  // The marketing copy lives in design/marketing-copy.json at the repository root.
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  transpilePackages: ["@everyfield/domain", "@everyfield/db", "@everyfield/ui"],
  // The Hugeicons free set is one barrel of about 6,000 icons; this rewrites its imports to the icons in use.
  experimental: { optimizePackageImports: ["@hugeicons/core-free-icons"] },
};

export default function nextConfig(phase: string): NextConfig {
  return {
    ...config,
    // Proof handlers must not exist in a production route manifest.
    pageExtensions: [...(phase === PHASE_DEVELOPMENT_SERVER ? ["dev.ts"] : []), "tsx", "ts", "jsx", "js"],
  };
}
