// WP-088 T28: Guide sits in the rail's bottom group, directly above Settings, with the prototype's book icon
// (design/everyfield-ui.html, hgi-book-open-02). Needs a People-seeded preview: set UI_BASE_URL and PEOPLE_UI_FIXTURE
// (tests/ui/people/seed.mts). Both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BookOpen02Icon } from "../../../apps/web/node_modules/@hugeicons/core-free-icons/dist/esm/index.js";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const PATHS = BookOpen02Icon.map(([, attrs]) => attrs.d).filter(Boolean);

/** The labels and icon paths of the items in each rail group, read in the page. */
const rail = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('aside[aria-label="Secondary"] > div')]
			.filter((group) => group.querySelector("a, button:not([role=radio])") && !group.querySelector("[role=radio]"))
			.map((group) =>
				[...group.querySelectorAll("a, button")].map((item) => ({
					label: item.getAttribute("aria-label") ?? item.textContent.trim(),
					paths: [...item.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
					cursor: getComputedStyle(item).cursor,
					href: item.getAttribute("href"),
				})),
			),
	);

/** The button's aria-expanded settles on `value`: the sheet closes after its exit transition. */
async function expanded(button, value) {
	for (let tries = 0; tries < 50; tries++) {
		if ((await button.getAttribute("aria-expanded")) === value) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.equal(await button.getAttribute("aria-expanded"), value);
}

for (const [name, engine] of ENGINES) {
	test(`AC:RAIL-GUIDE: Guide is in the bottom rail group above Settings with the book icon (${name})`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/people`);
			await hydrated(page);
			const [middle, bottom] = await rail(page);
			assert.deepEqual(
				middle.map((item) => item.label),
				["Documents"],
			);
			assert.deepEqual(
				bottom.map((item) => item.label),
				["Guide", "Settings"],
			);
			const [guide, settings] = bottom;
			assert.deepEqual(guide.paths, PATHS);
			assert.equal(guide.cursor, "pointer");
			assert.equal(settings.href, "/settings");

			const button = page.locator('aside[aria-label="Secondary"] button', { hasText: "Guide" });
			assert.equal(await button.getAttribute("aria-expanded"), "false");
			await button.click();
			await expanded(button, "true");
			await button.click();
			await expanded(button, "false");
		});
	});
}
