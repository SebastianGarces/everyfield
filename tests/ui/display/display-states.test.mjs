// Display states that a silent break would turn into wrong numbers or lost work (WP-090). Each row fails when its
// guard is removed:
//   INV-count: an empty count is "Not recorded", never 0, and a typed 0 stays a real 0 (OutcomeField, Stat).
//   INV-loadable: loading, error and empty never draw stale rows, and Try again recovers (DataTable, LoadableView).
//   INV-selection: select-all, the bulk bar count and Clear selection agree (DataTable, BulkBar).
//   INV-email-light: emails keep the light palette on a dark product page (.ef-email in display.css).
//   INV-evry-focus: Esc closes the non-modal Evry panel and returns focus to its opener (EvryPanel).
// It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=http://wp-090-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const WHITE = "rgb(255, 255, 255)";

async function withPage(engine, { dark = false, group = "all" } = {}, run) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
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
	test(`INV-count (${name}): not recorded and zero stay different`, { timeout: 60_000 }, () =>
		withPage(engine, { group: "Domain" }, async (page) => {
			const shown = page.locator("[data-recorded]");
			assert.deepEqual(
				await shown.evaluateAll((els) => els.map((el) => [el.parentElement.textContent, el.dataset.recorded])),
				[
					["AdultsNot recorded", "false"],
					["Kids0", "true"],
				],
			);

			const status = page.getByText(/^Recorded: adults/);
			const adults = page.getByRole("textbox", { name: "Adults (edit)" });
			await adults.fill("0");
			assert.match(await status.textContent(), /adults 0,/, "typing 0 records a real zero");
			await adults.fill("");
			assert.match(await status.textContent(), /adults not recorded,/, "clearing records nothing, not zero");
			const guests = page.getByRole("textbox", { name: "First-time guests (edit)" });
			assert.equal(await guests.inputValue(), "0", "a recorded zero shows as 0, not as an empty field");
		}),
	);

	test(`INV-loadable (${name}): loading, error and empty never show rows`, { timeout: 60_000 }, () =>
		withPage(engine, { group: "Data" }, async (page) => {
			const table = page.getByRole("table", { name: "People" });
			const state = page.getByRole("group", { name: "Data state" });
			assert.equal(await table.getByRole("row").count(), 4, "ready: header and three rows");

			await state.getByRole("radio", { name: "Loading" }).click();
			assert.equal(await table.count(), 0, "loading draws no table");
			assert.equal(await page.locator('[aria-busy="true"]').count(), 1);
			assert.equal(await page.getByRole("status").filter({ hasText: "Loading people" }).count(), 1);

			await state.getByRole("radio", { name: "Error" }).click();
			assert.equal(await table.count(), 0, "error draws no stale rows");
			const alert = page.getByRole("alert").filter({ hasText: "People did not load" });
			assert.equal(await alert.count(), 1);
			await alert.getByRole("button", { name: "Try again" }).click();
			assert.equal(await table.getByRole("row").count(), 4, "Try again recovers the rows");

			await state.getByRole("radio", { name: "Empty" }).click();
			assert.equal(await table.count(), 0, "empty draws no table");
			assert.equal(await page.getByRole("heading", { name: "No people yet" }).count(), 1);
		}),
	);

	test(`INV-selection (${name}): select-all, bulk count and clear agree`, { timeout: 60_000 }, () =>
		withPage(engine, { group: "Data" }, async (page) => {
			const all = page.getByRole("checkbox", { name: "Select all people on this page" });
			assert.equal(await all.getAttribute("aria-checked"), "mixed", "one of three rows starts selected");
			const bar = page.getByRole("toolbar", { name: "Bulk actions" });
			assert.equal((await bar.getByRole("status").textContent()).trim(), "1 person selected");

			await all.click();
			assert.equal(await all.getAttribute("aria-checked"), "true");
			assert.equal((await bar.getByRole("status").textContent()).trim(), "3 people selected");

			await bar.getByRole("button", { name: "Clear selection" }).click();
			assert.equal(await bar.count(), 0, "the bar leaves when nothing is selected");
			assert.equal(await all.getAttribute("aria-checked"), "false");
		}),
	);

	test(`INV-email-light (${name}): emails stay light on a dark page`, { timeout: 60_000 }, () =>
		withPage(engine, { dark: true, group: "Email" }, async (page) => {
			const email = page.getByRole("article", { name: /^Email: You're invited/ });
			const card = email.locator("h1").locator("..");
			assert.equal(await card.evaluate((el) => getComputedStyle(el).backgroundColor), WHITE);
			const heading = await email.locator("h1").evaluate((el) => getComputedStyle(el).color);
			assert.equal(heading, "rgb(24, 29, 25)", "the heading is light-palette ink");
		}),
	);

	test(`INV-evry-focus (${name}): Esc closes the Evry panel and returns focus`, { timeout: 60_000 }, () =>
		withPage(engine, { group: "Evry" }, async (page) => {
			const opener = page.getByRole("button", { name: "Ask Evry" });
			await opener.focus();
			await page.keyboard.press("Enter");
			const panel = page.getByRole("dialog", { name: "Evry" });
			await panel.waitFor();
			assert.equal(await panel.getAttribute("aria-modal"), null, "the panel is non-modal");
			await page.keyboard.press("Escape");
			await panel.waitFor({ state: "detached" });
			const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
			assert.equal(focused, "Ask Evry");
		}),
	);
}
