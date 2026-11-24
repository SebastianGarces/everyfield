import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { existsSync, globSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { prerender } = web("react-dom/static");
const { createElement, Fragment } = web("react");
const at = (path: string) => pathToFileURL(join(SRC, path)).href;
const unread = () => assert.fail("a crawler's render reads no session and no article");
const passThrough = ({ children }: { children: unknown }) => children;
const frame = ({ children }: { children: unknown }) => createElement("div", { "data-frame": "" }, children);
const USER_AGENT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "server-only" ? { url: "data:text/javascript,", shortCircuit: true } : next(specifier, context),
});
mock.module(pathToFileURL(web.resolve("next/headers")).href, {
	namedExports: {
		headers: async () => new Headers({ "user-agent": USER_AGENT }),
		cookies: async () => ({ get: () => undefined }),
	},
});
mock.module(pathToFileURL(web.resolve("next/script")).href, { defaultExport: () => null });
mock.module(pathToFileURL(web.resolve("next/link")).href, { defaultExport: passThrough });
mock.module(at("features/shell/routes.tsx"), { namedExports: { ProductFrameLayout: frame } });
mock.module(at("server/sign-in.ts"), { namedExports: { signIn: unread } });
mock.module(at("features/wiki/screen.tsx"), { namedExports: { WikiScreen: unread } });
mock.module(at("features/wiki/server.ts"), {
	namedExports: {
		loadWiki: unread,
		loadPreview: async () => ({ crawler: true, allowed: true, title: "Launch basics", excerpt: "Start here." }),
	},
});

const page = globSync("app/**/wiki/[[][[]...slug[]][]]/page.tsx", { cwd: SRC });

test("INV-privacy: /wiki renders outside the product frame: through every layout above it, a crawler gets only the public preview", async () => {
	assert.deepEqual(page, ["app/(product)/wiki/[[...slug]]/page.tsx"]);
	const { default: WikiPage } = await import(at(page[0]!));
	const props = { params: Promise.resolve({ slug: ["launch"] }), searchParams: Promise.resolve({}) };
	let tree = createElement(WikiPage, props);
	const passed: string[] = [];
	for (let dir = dirname(page[0]!); dir !== "app"; dir = dirname(dir)) {
		const file = join(dir, "layout.tsx");
		if (!existsSync(join(SRC, file))) continue;
		passed.push(file);
		tree = createElement((await import(at(file))).default, null, tree);
	}
	assert.ok(passed.includes("app/(product)/layout.tsx"));
	const { prelude } = await prerender(createElement(Fragment, null, tree));
	const html = await new Response(prelude).text();
	assert.doesNotMatch(html, /data-frame/);
	assert.match(html, /<main[^>]*><h1[^>]*>Launch basics<\/h1><p[^>]*>Start here\.<\/p><\/main>/);
	assert.equal(
		html.replace(/<(script|style|template)\b[^>]*>.*?<\/\1>/gs, "").replace(/<[^>]*>/g, ""),
		"Launch basicsStart here.",
	);
});
