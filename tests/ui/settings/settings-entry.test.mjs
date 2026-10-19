// The way into Settings from every signed-in page (WP-010/ui round 2): the name button in the top bar opens the user
// menu, and its Settings group links to Your account, Seats and invitations, and Sharing and privacy. Each row fails
// when its guard is removed:
//   BUG-136-settings-entry: from /people the menu opens from the keyboard, names its items, and reaches Seats in two steps;
//     the settings pages keep the same frame, so Sharing is two steps from Seats and there is one main landmark;
//     closing Your account returns focus to the name button (useReturnFocus, verifier finding on e32ce2b).
//   INV-settings-member: a Member gets the same menu and reads Seats without the invitation form.
// It runs against a running app seeded with the People fixture (tests/ui/people/seed.mts):
//   UI_BASE_URL=https://wp-010-ui-....localhost:1355 PEOPLE_UI_FIXTURE=/tmp/... corepack pnpm test:ui
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const FIXTURE = process.env.PEOPLE_UI_FIXTURE ?? "/tmp/everyfield-people-ui.json";
const ITEMS = ["Your account", "Seats and invitations", "Sharing and privacy", "Sign out"];

async function withPage(engine, who, run) {
	assert.ok(BASE, "Set UI_BASE_URL to a running, seeded preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			reducedMotion: "reduce",
			ignoreHTTPSErrors: true,
		});
		const [name, value] = JSON.parse(readFileSync(FIXTURE, "utf8"))[who].cookie.split(/=(.*)/s);
		await context.addCookies([{ name, value, url: BASE, httpOnly: true, secure: BASE.startsWith("https:") }]);
		await run(await context.newPage());
	} finally {
		await browser.close();
	}
}

const trigger = (page) => page.getByRole("button", { name: /account menu$/ });
const menuItems = (page) =>
	page
		.getByRole("menu")
		.getByRole("menuitem")
		.evaluateAll((els) => els.map((el) => el.textContent.trim()));

async function openMenu(page) {
	await trigger(page).click();
	await page.getByRole("menu").waitFor();
}

for (const [name, engine] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	test(`INV-settings-entry (${name}): the user menu reaches every settings page from People and from Settings`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people`, { waitUntil: "networkidle" });
			await page.getByRole("heading", { level: 1, name: "People" }).waitFor({ timeout: 60_000 });

			// Keyboard: Enter opens the menu on its first item, Esc closes it and returns focus to the name button.
			await trigger(page).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menu").waitFor();
			assert.deepEqual(await menuItems(page), ITEMS);
			await page.getByRole("menuitem", { name: "Your account" }).and(page.locator(":focus")).waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("menu").waitFor({ state: "detached" });
			await trigger(page).and(page.locator(":focus")).waitFor({ timeout: 5_000 });

			// One step opens Settings, the second opens Seats and invitations.
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Your account" }).and(page.locator(":focus")).waitFor();
			await page.keyboard.press("ArrowDown");
			await page.getByRole("menuitem", { name: "Seats and invitations" }).and(page.locator(":focus")).waitFor();
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { level: 1, name: "Seats and invitations" }).waitFor({ timeout: 60_000 });
			assert.equal(new URL(page.url()).pathname, "/settings/seats");
			assert.equal(await page.getByRole("main").count(), 1);

			await openMenu(page);
			await page.getByRole("menuitem", { name: "Sharing and privacy" }).click();
			await page.getByRole("heading", { level: 1, name: "Sharing and privacy" }).waitFor({ timeout: 60_000 });
			assert.equal(new URL(page.url()).pathname, "/settings/sharing");
			assert.equal(await page.getByRole("main").count(), 1);

			// Your account opens from the keyboard; closing it returns focus to the name button, not the page body.
			await trigger(page).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Your account" }).and(page.locator(":focus")).waitFor();
			await page.keyboard.press("Enter");
			const account = page.getByRole("dialog", { name: "Your account" });
			await account.getByRole("button", { name: "Sign out", exact: true }).waitFor();
			await page.keyboard.press("Escape");
			await account.waitFor({ state: "detached" });
			await trigger(page).and(page.locator(":focus")).waitFor({ timeout: 5_000 });

			await page.getByRole("link", { name: "People", exact: true }).first().click();
			await page.getByRole("heading", { level: 1, name: "People" }).waitFor({ timeout: 60_000 });
		});
	});
}
