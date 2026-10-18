// INV-overlay-theme: in dark mode, overlays keep the product theme and gradient cards keep their light ink (WP-089).
// Overlays portal into the product root, so the dark tokens and the product focus ring reach them; a portal to <body>
// would lose the scoped product rules. The InsightCard is a light-token island, so its ink text stays readable on
// the light gradient. It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=http://wp-089-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const LIGHT_INK = "rgb(24, 29, 25)";
const DARK_SURFACE_RAISED = "rgb(28, 32, 38)";
const DARK_FOCUS = "rgb(169, 207, 255)";

for (const [name, engine] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	test(
		`INV-overlay-theme (${name}): dark overlays stay in the product theme and gradient cards keep light ink`,
		{ timeout: 60_000 },
		async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			const browser = await engine.launch();
			try {
				const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
				await context.addCookies([{ name: "ef-theme", value: "dark", url: BASE }]);
				const page = await context.newPage();
				await page.goto(BASE + "/design/controls");

				const cardTitle = await page
					.locator(".ef-insight h2")
					.first()
					.evaluate((el) => getComputedStyle(el).color);
				assert.equal(cardTitle, LIGHT_INK, "the gradient card title keeps the light ink in dark mode");

				const trigger = page.getByRole("button", { name: "Move Maria to core group" });
				await trigger.focus();
				await page.keyboard.press("Enter");
				const dialog = page.getByRole("dialog", { name: "Move Maria to core group" });
				await dialog.waitFor();
				const state = await dialog.evaluate((el) => ({
					inRoot: Boolean(el.closest("[data-product-root]")),
					background: getComputedStyle(el).backgroundColor,
				}));
				assert.deepEqual(
					state,
					{ inRoot: true, background: DARK_SURFACE_RAISED },
					"the dialog renders inside the product root with dark tokens",
				);

				await page.keyboard.press("Tab");
				const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor);
				assert.equal(ring, DARK_FOCUS, "keyboard focus inside the dialog shows the product focus ring");

				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "detached" });
				// Focus returns in the commit after the dialog unmounts, so wait for it instead of reading it at once.
				const returned = await page
					.waitForFunction(() => document.activeElement?.textContent?.trim() === "Move Maria to core group", null, {
						timeout: 2000,
					})
					.then(
						() => true,
						() => false,
					);
				assert.ok(returned, "Esc returns focus to the trigger");
			} finally {
				await browser.close();
			}
		},
	);
}
