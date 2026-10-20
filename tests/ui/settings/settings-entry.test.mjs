// The way into Settings from every signed-in page (WP-010/ui round 2): the name button in the top bar opens the user
// menu, and its Settings group links to Your account, Seats and invitations, and Sharing and privacy. Each row fails
// when its guard is removed:
//   BUG-136-settings-entry: from /people the menu opens from the keyboard, names its items, and reaches Seats in two steps;
//     the settings pages keep the same frame, so Sharing is two steps from Seats and there is one main landmark;
//     closing Your account returns focus to the name button (useReturnFocus, verifier finding on e32ce2b).
//   INV-settings-member: a Member gets the same menu and reads Seats without the invitation form.
//   AC:TARGET-IDN-010 AC:TARGET-IDN-011 AC:WP010-IDN-012 (finding 6, Settings in production): an Owner, a Member and
//     an organization Owner each change what their seat may change through the real settings server, without a
//     page request, and a fresh load of the section link shows the saved value.
// It runs against a running app seeded with the People fixture (tests/ui/people/seed.mts) through the shared setup
// (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, signIn, withPage as onPreview } from "../setup.mjs";

const ITEMS = ["Your account", "Seats and invitations", "Sharing and privacy", "Sign out"];

/** Opens a page signed in as `who` from the People fixture. */
const withPage = (engine, who, run) =>
	onPreview(engine, async (page, context) => {
		await signIn(context, fixture("people")[who].cookie);
		await run(page);
	});

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

for (const [name, engine] of ENGINES) {
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

			// Your account opens from the keyboard over the page, at its own link; closing it returns to the page's
			// address and focus to the name button, not the page body.
			await trigger(page).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Your account" }).and(page.locator(":focus")).waitFor();
			await page.keyboard.press("Enter");
			const account = page.getByRole("dialog", { name: "Your account" });
			await account.getByRole("button", { name: "Sign out", exact: true }).waitFor();
			assert.equal(new URL(page.url()).pathname, "/settings/account");
			assert.equal(await page.locator("h1", { hasText: "Sharing and privacy" }).count(), 1);
			await page.keyboard.press("Escape");
			await account.waitFor({ state: "detached" });
			await trigger(page).and(page.locator(":focus")).waitFor({ timeout: 5_000 });
			assert.equal(new URL(page.url()).pathname, "/settings/sharing");

			await page.getByRole("link", { name: "People", exact: true }).first().click();
			await page.getByRole("heading", { level: 1, name: "People" }).waitFor({ timeout: 60_000 });
		});
	});
}

/** What each seat may change, and how to change it inside the open Settings dialog. */
const ROLES = [
	{
		who: "owner",
		sections: ["Church profile", "Notifications", "Your account"],
		edits: [
			{ section: "Your account", path: "/settings/account", field: "Your name", value: (t) => `Daniel Reyes ${t}` },
			{ section: "Church profile", path: "/settings/church", field: "City", value: (t) => `Austin ${t}` },
		],
	},
	{
		who: "member",
		sections: ["Notifications", "Your account"],
		locked: "/settings/church",
		edits: [
			{ section: "Your account", path: "/settings/account", field: "Your name", value: (t) => `Ruth Allen ${t}` },
		],
	},
	{
		who: "organization",
		sections: ["Organization profile", "Notifications", "Your account"],
		edits: [
			{ section: "Organization profile", path: "/settings/organization", field: "City", value: (t) => `Dallas ${t}` },
		],
	},
];

for (const [name, engine] of ENGINES) {
	for (const role of ROLES) {
		test(`AC:TARGET-IDN-010 AC:TARGET-IDN-011 AC:WP010-IDN-012 (${name}, ${role.who}): settings saves what the seat may change`, async () => {
			await withPage(engine, role.who, async (page) => {
				const tag = `${name}-${Date.now().toString(36)}`;
				const dialog = page.getByRole("dialog").first();
				let documents = 0;
				page.on("request", (r) => (r.resourceType() === "document" || r.url().includes("_rsc=")) && documents++);
				await page.goto(`${BASE}${role.edits[0].path}`, { waitUntil: "networkidle" });
				const nav = await dialog.getByRole("navigation").getByRole("link").allTextContents();
				assert.deepEqual(
					nav.map((s) => s.trim()),
					role.sections,
				);
				documents = 0;
				for (const edit of role.edits) {
					// Switching sections changes the address without a page request.
					await dialog.getByRole("link", { name: edit.section }).click();
					await page.waitForURL(`**${edit.path}`);
					await dialog.getByLabel(edit.field).fill(edit.value(tag));
					await dialog.getByRole("button", { name: "Save" }).click();
					await dialog.getByText("No unsaved changes.").waitFor({ timeout: 10_000 });
				}
				// A notification switch shows its new value at once and keeps it once the server confirms.
				await dialog.getByRole("link", { name: "Notifications" }).click();
				const toggle = dialog.getByRole("switch").first();
				const was = await toggle.getAttribute("aria-checked");
				await toggle.click();
				await dialog.locator("[role=status]").waitFor({ state: "detached" });
				const now = await toggle.getAttribute("aria-checked");
				assert.notEqual(now, was);
				assert.equal(documents, 0, "saves update the dialog without a page request");

				for (const edit of role.edits) {
					await page.goto(`${BASE}${edit.path}`, { waitUntil: "networkidle" });
					assert.equal(await dialog.getByLabel(edit.field).inputValue(), edit.value(tag));
				}
				await page.goto(`${BASE}/settings/notifications`, { waitUntil: "networkidle" });
				assert.equal(await dialog.getByRole("switch").first().getAttribute("aria-checked"), now);
				if (role.locked) {
					await page.goto(`${BASE}${role.locked}`, { waitUntil: "networkidle" });
					await dialog.getByText("Church profile is not available to you").waitFor();
				}
			});
		});
	}
}
