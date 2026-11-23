import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setServerEnv } from "../../support/server-env.mts";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
setServerEnv({ IDENTITY_ORIGIN: "https://app.everyfield.test" });

const withExtension = (path: string) =>
	[path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile()) ??
	path;
registerHooks({
	resolve: (specifier, given, next) => {
		const context = { ...given, conditions: given.conditions.filter((c) => c !== "react-server") };
		if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
		if (specifier.startsWith("@/"))
			return next(pathToFileURL(withExtension(join(SRC, specifier.slice(2)))).href, context);
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.\w+$/.test(specifier))
			return next(
				pathToFileURL(withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier))).href,
				context,
			);
		try {
			return next(specifier, context);
		} catch {
			return next(`${specifier}.js`, context);
		}
	},
});

const { default: config } = await import("../../../apps/web/next.config.ts");
const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { getPathMatch } = web("next/dist/shared/lib/router/utils/path-match.js");
type Header = { key: string; value: string };
const rules: { source: string; headers: Header[] }[] = await config.headers!();
const served = (pathname: string, key: string) => {
	let found: string | undefined;
	for (const rule of rules)
		if (getPathMatch(rule.source)(pathname)) found = rule.headers.find((h) => h.key === key)?.value ?? found;
	return found;
};

const TOKEN = "Sentinel_tok-123";
const PROOF_PAGES = [
	["app/(product)/(identity)/invitation/page.tsx", "/invitation"],
	["app/(product)/connections/respond/page.tsx", "/connections/respond"],
	["app/(product)/(identity)/reset-password/page.tsx", "/reset-password"],
	["app/(product)/(identity)/verify-email/page.tsx", "/verify-email"],
	["app/(product)/confirm-email/page.tsx", "/confirm-email"],
	["app/(product)/rsvp/[token]/page.tsx", `/rsvp/${TOKEN}`],
	["app/(product)/unsubscribe/[token]/page.tsx", `/unsubscribe/${TOKEN}`],
	["app/(product)/email-preferences/[token]/page.tsx", `/email-preferences/${TOKEN}`],
] as const;
const ONE_CLICK = [
	"app/(product)/unsubscribe/[token]/one-click/route.ts",
	"app/(product)/email-preferences/[token]/one-click/route.ts",
];
const load = async (file: string) => (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>;

test("AC: every page a proof link opens tells search engines not to index or follow it and sends no Referer", async () => {
	for (const [file, pathname] of PROOF_PAGES) {
		const { metadata } = (await load(file)) as { metadata?: { robots?: unknown } };
		assert.deepEqual(metadata?.robots, { index: false, follow: false }, `${file} can be indexed`);
		assert.equal(served(pathname, "Referrer-Policy"), "no-referrer", `${pathname} sends a Referer`);
	}
});

test("AC: a one-click route answers only POST, so a GET to its link never reaches it", async () => {
	for (const file of ONE_CLICK) {
		const handlers = Object.keys(await load(file));
		assert.deepEqual(handlers, ["POST"], file);
	}
});
