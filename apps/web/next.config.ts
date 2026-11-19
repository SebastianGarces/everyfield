import path from "node:path";
import { BODY_JSON_MAX, IMPORT_BYTES_MAX } from "@everyfield/contracts/documents";
import type { NextConfig } from "next";

const LINK_PAGES = [
	"/invitation",
	"/connections/respond",
	"/reset-password",
	"/verify-email",
	"/confirm-email",
	"/signin",
	"/rsvp/:path*",
	"/unsubscribe/:path*",
	"/email-preferences/:path*",
];

const config: NextConfig = {
	turbopack: { root: path.join(import.meta.dirname, "../..") },
	outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
	outputFileTracingIncludes: {
		"/**": [
			"../../packages/reference/src/freeze.json",
			"../../packages/reference/src/artifacts.json",
			"../../packages/domain/src/documents/fonts/*.ttf",
		],
	},
	typescript: { ignoreBuildErrors: true },
	poweredByHeader: false,
	logging: {
		serverFunctions: false,
		incomingRequests: {
			ignore: [/\/email-preferences\//, /\/unsubscribe\//, /\/rsvp\//, /(?:[?&]|%3F|%26)token(?:=|%3D)/i],
		},
	},
	images: { formats: ["image/avif", "image/webp"], qualities: [70], minimumCacheTTL: 31536000 },
	serverExternalPackages: ["@formepdf/core", "@formepdf/react"],
	transpilePackages: [
		"@everyfield/domain",
		"@everyfield/db",
		"@everyfield/ui",
		"@everyfield/evry",
		"@everyfield/contracts",
	],
	experimental: {
		optimizePackageImports: ["@hugeicons/core-free-icons"],
		serverActions: { bodySizeLimit: 3 * BODY_JSON_MAX + 64 * 1024 },
		proxyClientMaxBodySize: IMPORT_BYTES_MAX + 64 * 1024,
		...(process.env.EVF_NEXT_WORKERS ? { cpus: Number(process.env.EVF_NEXT_WORKERS) } : {}),
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
				],
			},
			...LINK_PAGES.map((source) => ({ source, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] })),
			{ source: "/invitation", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
		];
	},
};

export default config;
