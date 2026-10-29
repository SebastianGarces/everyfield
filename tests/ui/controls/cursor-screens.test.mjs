// S2 task 29b: two product controls that set their own cursor class now follow the rule. The check-in guest row and the
// task done box (its label) show a pointer when enabled and not-allowed or progress while a save holds them.
// Seed the preview with tests/ui/people/seed.mts, then tests/ui/meetings/seed.mts; set UI_BASE_URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const cursorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).cursor);

/** Holds every write for `ms` so a save stays in flight while the test reads the cursor. */
const holdSaves = (page, ms) =>
	page.route("**/*", async (route) => {
		if (route.request().method() !== "GET") await new Promise((r) => setTimeout(r, ms));
		await route.continue();
	});

for (const [name, engine] of ENGINES) {
	test(
		`BUG-S2-T29b (${name}): the check-in guest row shows pointer, then not-allowed while it saves`,
		{ timeout: 120_000 },
		() =>
			withPage(engine, async (page, context) => {
				const { meetingId, guests } = fixture("meetings").past[name];
				await signIn(context, fixture("people").owner.cookie);
				await page.goto(`${BASE}/meetings/${meetingId}/check-in`);
				await hydrated(page);
				const row = page.getByRole("button", { name: new RegExp(`^${guests[0]}`) });
				assert.equal(await cursorOf(row), "pointer", `guest row "${guests[0]}": cursor`);
				await holdSaves(page, 4000);
				await row.click();
				// The tapped row leaves "Not here yet" at once and waits for the server in the "Here" list.
				await page.getByRole("radio", { name: /^Here/ }).click();
				const saving = page.getByRole("button", { name: new RegExp(`^${guests[0]}`) });
				await saving.and(page.locator('[aria-disabled="true"]')).waitFor();
				assert.equal(await cursorOf(saving), "not-allowed", `saving guest row "${guests[0]}": cursor`);
				await page.unroute("**/*");
			}),
	);

	test(
		`BUG-S2-T29b (${name}): the task done box shows pointer, then progress while it saves`,
		{ timeout: 120_000 },
		() =>
			withPage(engine, async (page, context) => {
				await signIn(context, fixture("people").owner.cookie);
				await page.goto(`${BASE}/tasks`);
				await hydrated(page);
				const title = `Cursor check ${name} ${Date.now()}`;
				await page.getByRole("button", { name: "New task", exact: true }).first().click();
				const dialog = page.getByRole("dialog");
				await dialog.getByLabel("Title", { exact: true }).fill(title);
				await dialog.getByRole("button", { name: "Add task", exact: true }).click();
				await dialog.waitFor({ state: "detached", timeout: 30_000 });
				// The list renders the box twice (one copy per breakpoint); only one is visible.
				const box = page.getByRole("checkbox", { name: `Complete ${title}` }).and(page.locator(":visible"));
				await box.waitFor({ timeout: 30_000 });
				const labelCursor = () => box.evaluate((el) => getComputedStyle(el.closest("label")).cursor);
				assert.equal(await labelCursor(), "pointer", `done box label "${title}": cursor`);
				await holdSaves(page, 4000);
				await box.click();
				// The tapped box turns into "Reopen" at once and stays busy until the server answers.
				const saving = page.getByRole("checkbox", { name: `Reopen ${title}` }).and(page.locator('[aria-busy="true"]'));
				await saving.waitFor();
				assert.equal(
					await saving.evaluate((el) => getComputedStyle(el.closest("label")).cursor),
					"progress",
					`saving done box label "${title}": cursor`,
				);
				await page.unroute("**/*");
			}),
	);
}
