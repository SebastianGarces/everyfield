import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const config: NextConfig = {
	// The marketing copy lives in design/marketing-copy.json at the repository root.
	turbopack: { root: path.join(import.meta.dirname, "../..") },
	outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
	poweredByHeader: false,
	// `next dev` prints each server action call with its arguments, which carry passwords and proofs (BUG-PR199).
	logging: { serverFunctions: false },
	// Marketing photos (next/image, static imports): AVIF first, WebP fallback, one quality, and a year of cache for the
	// optimized copies (their URLs carry the content hash of the source file).
	images: { formats: ["image/avif", "image/webp"], qualities: [70], minimumCacheTTL: 31536000 },
	// Forme's WASM layout engine runs from node_modules: bundling it builds a renderer that returns 0 pages (WP-036/api).
	serverExternalPackages: ["@formepdf/core", "@formepdf/react"],
	transpilePackages: ["@everyfield/domain", "@everyfield/db", "@everyfield/ui", "@everyfield/evry"],
	// The Hugeicons free set is one barrel of about 6,000 icons; this rewrites its imports to the icons in use.
	experimental: { optimizePackageImports: ["@hugeicons/core-free-icons"] },
	// The invitation page handles a proof (WP-008/ui ruling D54): no Referer leaves it.
	async headers() {
		return [
			{
				source: "/invitation",
				headers: [
					{ key: "Referrer-Policy", value: "no-referrer" },
					{ key: "X-Robots-Tag", value: "noindex, nofollow" },
				],
			},
		];
	},
};

export default function nextConfig(phase: string): NextConfig {
	return {
		...config,
		// Proof handlers must not exist in a production route manifest.
		pageExtensions: [...(phase === PHASE_DEVELOPMENT_SERVER ? ["dev.ts"] : []), "tsx", "ts", "jsx", "js"],
	};
}
