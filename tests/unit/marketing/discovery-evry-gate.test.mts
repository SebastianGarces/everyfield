import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const web = createRequire(join(SRC, "../package.json"));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const REACT = JSON.stringify(pathToFileURL(web.resolve("react")).href);
const STUB: Record<string, string> = {
	link: `import { createElement } from ${REACT}; export default ({ href, prefetch, ...p }) => createElement("a", { href: String(href), ...p });`,
	image: `import { createElement } from ${REACT}; export default ({ src, priority, placeholder, quality, fill, preload, ...p }) => createElement("img", { src: src.src ?? src, ...p });`,
};
const withExtension = (path: string) =>
	[path, `${path}.ts`, `${path}.tsx`].find((p) => existsSync(p) && statSync(p).isFile()) ?? path;
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
		if (specifier === "next/link" || specifier === "next/image")
			return { url: `file:///next-stub/${specifier.slice(5)}.mjs`, shortCircuit: true };
		if (specifier.startsWith("@/"))
			return next(pathToFileURL(withExtension(join(SRC, specifier.slice(2)))).href, context);
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.\w+$/.test(specifier))
			return next(
				pathToFileURL(withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier))).href,
				context,
			);
		return next(specifier, context);
	},
	load: (url, context, next) =>
		url.startsWith("file:///next-stub/")
			? { format: "module", source: STUB[url.slice(18, -4)], shortCircuit: true }
			: /\.(?:jpg|png|webp|svg)$/.test(url)
			? { format: "module", source: `export default ${JSON.stringify({ src: url, width: 1, height: 1 })};`, shortCircuit: true }
			: next(url, context),
});

const { DiscoveryPage } = (await import(
	pathToFileURL(join(SRC, "marketing/discovery/DiscoveryPage.tsx")).href
)) as typeof import("../../../apps/web/src/marketing/discovery/DiscoveryPage.tsx");

const EVRY_SCREEN = "Evry in Discovery: next to your private document";
const EVRY_LINE = "Ask Evry, Everyfield's assistant, questions about the wiki and your own documents.";

function render(env: Record<string, string | undefined>) {
	const saved = { ...process.env };
	Object.assign(process.env, env);
	for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
	try {
		const html: string = renderToStaticMarkup(createElement(DiscoveryPage));
		return {
			html,
			tabs: [...html.matchAll(/id="tour-tab-([a-z]+)"/g)].map((m) => m[1]),
			text: html.replaceAll("&#x27;", "'"),
		};
	} finally {
		process.env = saved;
	}
}

test("with production Evry off, /discovery renders five tour tabs and no Evry line or Evry screen", () => {
	const page = render({ VERCEL_ENV: "production", AI_PROVIDER_RECORD: undefined });
	assert.deepEqual(page.tabs, ["wiki", "documents", "templates", "tasks", "ready"]);
	assert.equal(page.text.includes(EVRY_LINE), false);
	assert.equal(page.html.includes("tour-panel-evry"), false);
	assert.equal(page.text.includes(EVRY_SCREEN), false);
	assert.match(page.html, /--tabs:5/);
	assert.ok(page.text.includes("Everything you wrote in Discovery comes with you and stays private to you."));
	assert.ok(page.text.includes("What happens to my notes when I start my church plant?"));
});

test("with Evry available, /discovery renders the Evry tab after Tasks with its line, in six columns", () => {
	const page = render({ VERCEL_ENV: "preview" });
	assert.deepEqual(page.tabs, ["wiki", "documents", "templates", "tasks", "evry", "ready"]);
	assert.equal(page.text.split(EVRY_LINE).length - 1, 2);
	assert.ok(page.html.includes("tour-panel-evry"));
	assert.ok(page.text.includes(EVRY_SCREEN));
	assert.match(page.html, /--tabs:6/);
	assert.ok(page.text.includes("Everything you wrote in Discovery comes with you and stays private to you."));
});
