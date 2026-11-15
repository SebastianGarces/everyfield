import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "../../apps/web/node_modules/playwright/index.mjs";

export const BASE = process.env.UI_BASE_URL;

export const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

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

export const fixturePath = (name) =>
	process.env[`${name.toUpperCase()}_UI_FIXTURE`] ?? `/tmp/everyfield-${name}-ui.json`;

export function fixture(name) {
	try {
		return JSON.parse(readFileSync(fixturePath(name), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		assert.fail(`No ${name} fixture at ${fixturePath(name)}. Seed the preview first (tests/ui/seed-env.mts).`);
	}
}

export async function signIn(context, cookie) {
	const [name, value] = cookie.split(/=(.*)/s);
	await context.addCookies([{ name, value, url: BASE, httpOnly: true, secure: BASE.startsWith("https:") }]);
}

export async function hydrated(page) {
	await page.locator("html[data-theme]").waitFor({ state: "attached", timeout: 60_000 });
}
