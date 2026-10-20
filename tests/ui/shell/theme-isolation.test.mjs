// BUG-PR83: browser Back must retain the theme selected before leaving the product page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, hydrated, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES) {
	test(`BUG-PR83 (${name}): Back to a cached product page keeps the theme chosen there`, { timeout: 60_000 }, () =>
		withPage(engine, async (page) => {
			const themes = () =>
				page.evaluate(() => ({
					html: document.documentElement.getAttribute("data-theme"),
					root: document.querySelector("[data-product-root]")?.getAttribute("data-theme") ?? null,
				}));

			await page.goto(BASE + "/design/shell/owner");
			// A click before hydration reaches markup without its handler (flaky WebKit run on the UI round).
			await hydrated(page);
			await page.getByRole("radio", { name: "Dark mode" }).click();
			assert.deepEqual(await themes(), { html: "dark", root: "dark" }, "the switch selects dark");

			await page.getByRole("link", { name: "Open the marketing home page" }).click();
			await page.waitForURL(BASE + "/");
			assert.deepEqual(await themes(), { html: null, root: null }, "marketing stays light");

			await page.goBack();
			await page.waitForURL(BASE + "/design/shell/owner");
			await page.waitForTimeout(1000);
			assert.deepEqual(await themes(), { html: "dark", root: "dark" }, "the restored product page keeps dark");
		}),
	);
}
