import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));

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

const PROOF_PAGES = [
	"app/(product)/(identity)/invitation/page.tsx",
	"app/(product)/connections/respond/page.tsx",
	"app/(product)/(identity)/reset-password/page.tsx",
	"app/(product)/(identity)/verify-email/page.tsx",
	"app/(product)/confirm-email/page.tsx",
	"app/(product)/rsvp/[token]/page.tsx",
	"app/(product)/unsubscribe/[token]/page.tsx",
	"app/(product)/email-preferences/[token]/page.tsx",
];
const ONE_CLICK = [
	"app/(product)/unsubscribe/[token]/one-click/route.ts",
	"app/(product)/email-preferences/[token]/one-click/route.ts",
];
const load = async (file: string) => (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>;

test("AC: every page a proof link opens tells search engines not to index or follow it", async () => {
	for (const file of PROOF_PAGES) {
		const { metadata } = (await load(file)) as { metadata?: { robots?: unknown } };
		assert.deepEqual(metadata?.robots, { index: false, follow: false }, `${file} can be indexed`);
	}
});

test("AC: a one-click route answers only POST, so a GET to its link never reaches it", async () => {
	for (const file of ONE_CLICK) {
		const handlers = Object.keys(await load(file));
		assert.deepEqual(handlers, ["POST"], file);
	}
});
