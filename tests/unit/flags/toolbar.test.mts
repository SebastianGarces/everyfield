import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const fake = (source: string) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only" || specifier.endsWith(".css")) return fake("");
		if (specifier === "next/font/google")
			return fake(
				`const font = () => ({ variable: "font" }); export const DM_Sans = font, DM_Serif_Display = font, DM_Serif_Text = font;`,
			);
		return next(specifier, context);
	},
});

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { HeadManagerContext } = web("next/dist/shared/lib/head-manager-context.shared-runtime");
const { default: RootLayout } = await import("../../../apps/web/src/app/layout.tsx");

const TOOLBAR_SCRIPT = "https://vercel.live/_next-live/feedback/feedback.js";
const render = (VERCEL_ENV?: string) => {
	if (VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = VERCEL_ENV;
	return renderToStaticMarkup(
		createElement(HeadManagerContext.Provider, { value: { appDir: true } }, RootLayout({ children: "page" })),
	) as string;
};

afterEach(() => delete process.env.VERCEL_ENV);

test("on a Vercel preview every page loads the Vercel Toolbar script from the app, with no project opt-in", () => {
	const html = render("preview");
	assert.ok(html.includes(`<link rel="preload" href="${TOOLBAR_SCRIPT}" as="script"/>`), html);
});

test("in production, off Vercel and on the local stack no page loads the Vercel Toolbar", () => {
	for (const env of ["production", undefined, "development"]) {
		const html = render(env);
		assert.ok(html.includes("page"), html);
		assert.ok(!html.includes("vercel.live"), `${env ?? "unset"}: ${html}`);
	}
});
