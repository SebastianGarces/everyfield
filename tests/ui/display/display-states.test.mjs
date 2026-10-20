// BUG-PR109: actual editor change marks must distinguish added and changed blocks in both engines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;

async function withPage(engine, { dark = false, group = "all" } = {}, run) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			reducedMotion: "reduce",
			// The portless preview uses a local certificate (same as the other tests/ui suites).
			ignoreHTTPSErrors: true,
		});
		if (dark) await context.addCookies([{ name: "ef-theme", value: "dark", url: BASE }]);
		const page = await context.newPage();
		await page.goto(BASE + "/design/display");
		if (group !== "all") await page.getByRole("radio", { name: group, exact: true }).click();
		await run(page);
	} finally {
		await browser.close();
	}
}

for (const [name, engine] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	test(`BUG-PR109 (${name}): editor marks added blocks green and changed blocks blue`, { timeout: 60_000 }, () =>
		withPage(engine, { group: "Content" }, async (page) => {
			const mark = (sel) =>
				page
					.locator(sel)
					.first()
					.evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
			// Engines may report a converted color space, so compare the dominant channel, not exact values.
			const rgb = (c) =>
				c
					.match(/[\d.]+/g)
					.slice(0, 3)
					.map(Number);
			const [ar, ag, ab] = rgb(await mark('[data-change="added"]'));
			const [cr, cg, cb] = rgb(await mark('[data-change="changed"]'));
			assert.ok(ag > ar && ag > ab, "added is the green bar");
			assert.ok(cb > cr && cb > cg, "changed is the blue bar");
		}),
	);
}
