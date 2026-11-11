import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
	// The marketing copy lives in design/marketing-copy.json at the repository root.
	turbopack: { root: path.join(import.meta.dirname, "../..") },
	outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
	// The reference loader and the document fonts read these files at run time through a computed path, which the tracer cannot see.
	// A literal `new URL` does not help: in a page chunk Turbopack turns it into a public /_next/static URL (WP-032).
	// tests/reference/server-trace.test.mjs fails the build check when a route that bundles the loader drops them.
	outputFileTracingIncludes: {
		"/**": [
			"../../packages/reference/src/freeze.json",
			"../../packages/reference/src/artifacts.json",
			// The document fonts, read the same way (packages/domain/src/documents/fonts.ts).
			"../../packages/domain/src/documents/fonts/*.ttf",
		],
	},
	// `pnpm typecheck` checks every package before `pnpm build` in `pnpm check` and in the CI app job, so the build skips
	// its own second pass over the same types (T-43: a third of the build's time).
	typescript: { ignoreBuildErrors: true },
	poweredByHeader: false,
	// `next dev` prints each server action call with its arguments, which carry passwords and proofs (BUG-PR199), and
	// each request path; an email opt-out or Messages unsubscribe path carries its token (REQ-NTF-012, REQ-NTF-016), so
	// those requests are not logged.
	logging: { serverFunctions: false, incomingRequests: { ignore: [/\/email-preferences\//, /\/unsubscribe\//] } },
	// Marketing photos (next/image, static imports): AVIF first, WebP fallback, one quality, and a year of cache for the
	// optimized copies (their URLs carry the content hash of the source file).
	images: { formats: ["image/avif", "image/webp"], qualities: [70], minimumCacheTTL: 31536000 },
	// Forme's WASM layout engine runs from node_modules: bundling it builds a renderer that returns 0 pages (WP-036/api).
	serverExternalPackages: ["@formepdf/core", "@formepdf/react"],
	transpilePackages: [
		"@everyfield/domain",
		"@everyfield/db",
		"@everyfield/ui",
		"@everyfield/evry",
		"@everyfield/contracts",
	],
	// The Hugeicons free set is one barrel of about 6,000 icons; this rewrites its imports to the icons in use.
	// `evf verify` sets the worker count from its budget (OPS-151); with it unset, as in GitHub CI, Next picks its default.
	experimental: {
		optimizePackageImports: ["@hugeicons/core-free-icons"],
		...(process.env.EVF_NEXT_WORKERS ? { cpus: Number(process.env.EVF_NEXT_WORKERS) } : {}),
	},
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

export default config;
