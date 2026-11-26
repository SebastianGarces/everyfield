import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));

const withExtension = (path: string) =>
	[path, `${path}.ts`, `${path}.tsx`].find((p) => existsSync(p) && statSync(p).isFile()) ?? path;
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
		if (specifier.startsWith("@/"))
			return next(pathToFileURL(withExtension(join(SRC, specifier.slice(2)))).href, context);
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.\w+$/.test(specifier))
			return next(
				pathToFileURL(withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier))).href,
				context,
			);
		return next(specifier, context);
	},
});

const load = async <T,>(file: string) => (await import(pathToFileURL(join(SRC, file)).href)) as T;

test("hidden /discovery is in neither the sitemap nor the robots allow list, and its page asks not to be indexed", async () => {
	const { default: sitemap } = await load<{ default: () => { url: string }[] }>("app/sitemap.ts");
	const { default: robots } = await load<{ default: () => { rules: { allow: string[]; disallow: string } } }>(
		"app/robots.ts",
	);
	const { PAGES, pageMetadata } =
		await load<typeof import("../../../apps/web/src/marketing/meta.ts")>("marketing/meta.ts");

	assert.equal(
		sitemap().some((e) => new URL(e.url).pathname.startsWith("/discovery")),
		false,
	);
	const { allow, disallow } = robots().rules;
	assert.equal(
		allow.some((p) => p.startsWith("/discovery")),
		false,
	);
	assert.equal(disallow, "/");
	assert.deepEqual(pageMetadata(PAGES.discovery).robots, { index: false, follow: false });
	assert.equal(pageMetadata(PAGES.oversight).robots, undefined);
});
