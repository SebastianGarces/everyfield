// BUG-PR109: actual editor change marks must distinguish added and changed blocks in both engines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage as onPreview } from "../setup.mjs";

/** Opens /design/display, in dark mode and on one display group when asked. */
const withPage = (engine, { dark = false, group = "all" } = {}, run) =>
	onPreview(engine, async (page, context) => {
		if (dark) await context.addCookies([{ name: "ef-theme", value: "dark", url: BASE }]);
		await page.goto(BASE + "/design/display");
		if (group !== "all") await page.getByRole("radio", { name: group, exact: true }).click();
		await run(page);
	});

for (const [name, engine] of ENGINES) {
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
