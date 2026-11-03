// WP-030 criterion 14: the bell announces that it opens a dialog and whether that dialog is open. Escape, a click
// outside and choosing a link close it; aria-expanded returns to "false" and focus returns to the bell. Needs a
// People-seeded preview: set UI_BASE_URL and PEOPLE_UI_FIXTURE (tests/ui/people/seed.mts). Both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

/** Opens the drop-down from the bell and waits until it holds focus and its list has loaded, as a person sees it. */
async function open(page, bell, dialog) {
	await bell.click();
	await dialog
		.getByRole("list", { name: "Latest notifications" })
		.or(dialog.getByText("No notifications yet"))
		.waitFor();
	await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') !== null);
}

/** The bell's aria-expanded settles on `value`: the drop-down closes after its exit transition. */
async function expanded(bell, value) {
	for (let tries = 0; tries < 50 && (await bell.getAttribute("aria-expanded")) !== value; tries++)
		await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(await bell.getAttribute("aria-expanded"), value);
}

for (const [name, engine] of ENGINES)
	for (const width of [390, 1440])
		test(`WP-030 bell (${name}, ${width} px): a collapsed dialog button that expands, collapses and keeps focus`, async () => {
			await withPage(
				engine,
				async (page, context) => {
					await signIn(context, fixture("people").owner.cookie);
					await page.goto(`${BASE}/people`);
					await hydrated(page);
					const bell = page.getByRole("button", { name: /^Notifications/ });
					const dialog = page.getByRole("dialog", { name: "Notifications" });
					assert.equal(await bell.getAttribute("aria-haspopup"), "dialog");
					await expanded(bell, "false");

					await open(page, bell, dialog);
					await expanded(bell, "true");
					await page.keyboard.press("Escape");
					await dialog.waitFor({ state: "detached" });
					await expanded(bell, "false");
					assert.equal(await bell.evaluate((el) => el === document.activeElement), true, "Escape returns focus");

					await open(page, bell, dialog);
					await page.mouse.click(5, 880);
					await dialog.waitFor({ state: "detached" });
					await expanded(bell, "false");

					await open(page, bell, dialog);
					await dialog.getByRole("link", { name: "See all notifications" }).click();
					await page.waitForURL(/\/notifications$/);
					await expanded(bell, "false");
				},
				{ width },
			);
		});
