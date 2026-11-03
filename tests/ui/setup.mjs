// The one browser setup for every tests/ui suite. The preview URL comes from UI_BASE_URL. Portless previews use a local
// certificate the test browsers do not know, so every context ignores HTTPS errors. UI_ENGINE=chromium|webkit limits a
// run to one engine. Seeded suites read the fixture their seed wrote (tests/ui/seed-env.mts).
//   UI_BASE_URL=https://wp-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "../../apps/web/node_modules/playwright/index.mjs";

export const BASE = process.env.UI_BASE_URL;

export const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

/**
 * Launches `engine`, opens one context on the preview and gives `run` its page and context, then closes the browser.
 * `width` and `height` set the viewport; `launch` passes browser launch options.
 */
export async function withPage(engine, run, { width = 1440, height = 900, launch = {} } = {}) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch(launch);
	try {
		const context = await browser.newContext({
			viewport: { width, height },
			reducedMotion: "reduce",
			ignoreHTTPSErrors: true,
		});
		await run(await context.newPage(), context);
	} finally {
		await browser.close();
	}
}

/** Where the seed named `name` writes its fixture: $<NAME>_UI_FIXTURE or /tmp/everyfield-<name>-ui.json. */
export const fixturePath = (name) =>
	process.env[`${name.toUpperCase()}_UI_FIXTURE`] ?? `/tmp/everyfield-${name}-ui.json`;

/** The fixture the seed named `name` wrote. Seed the preview first when it is missing. */
export function fixture(name) {
	try {
		return JSON.parse(readFileSync(fixturePath(name), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		assert.fail(`No ${name} fixture at ${fixturePath(name)}. Seed the preview first (tests/ui/seed-env.mts).`);
	}
}

/** Signs the context in with a seeded session cookie ("name=value"). */
export async function signIn(context, cookie) {
	const [name, value] = cookie.split(/=(.*)/s);
	await context.addCookies([{ name, value, url: BASE, httpOnly: true, secure: BASE.startsWith("https:") }]);
}

/**
 * Waits until the product page has hydrated: the product root sets the theme on <html> from an effect, which runs only
 * once React owns the page. Keyboard input before that reaches markup without its handlers.
 */
export async function hydrated(page) {
	await page.locator("html[data-theme]").waitFor({ state: "attached", timeout: 60_000 });
}
