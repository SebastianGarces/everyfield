// Your account and your notification choices share the account's one revision (people/peo-3). Each row fails when its
// guard is removed:
//   people/peo-3 name then notification: a name save moves the revision the next notification toggle sends. Without
//     the store copying a saved section's revision onto the other cached account-scope section, the toggle sends
//     the old revision and the fixture refuses it with a conflict.
//   people/peo-3 time zone then name: a time zone save moves the account revision too. Without Your account
//     reading itself again after the save, the name save sends the old revision and is refused.
// It runs on the settings design preview (/design/settings), whose fixture keeps the server's shared revision, so it
// needs no seed: UI_BASE_URL=<preview> node --test tests/ui/settings/account-scope-revisions.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, hydrated, withPage } from "../setup.mjs";

const CONFLICT = "Someone changed this after you opened it.";

async function open(page, section) {
	await page.goto(`${BASE}/design/settings/${section}?as=owner&delay=150`, { waitUntil: "networkidle" });
	await hydrated(page);
	await page
		.getByRole("heading", { level: 2, name: section === "account" ? "Your account" : "Notifications" })
		.waitFor();
}

/** Every save so far was accepted: no refusal shows anywhere on the page. */
async function noRefusal(page) {
	assert.equal(await page.getByRole("alert").filter({ hasText: CONFLICT }).count(), 0, "a conflict shows");
	assert.equal(await page.getByRole("alert").count(), 0, await page.getByRole("alert").allInnerTexts().then(String));
}

/** Waits for a control's save: it turns busy when the save starts and stops being busy when the reply lands. */
async function settled(control) {
	await control.and(control.page().locator("[aria-busy=true]")).waitFor({ timeout: 15_000 });
	await control.and(control.page().locator(":not([aria-busy])")).waitFor({ timeout: 15_000 });
}

async function saveName(page, name) {
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Your name").fill(name);
	const save = dialog.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await settled(save);
	await noRefusal(page);
	// A refusal would leave the draft unsaved and Save enabled.
	assert.equal(await save.isDisabled(), true, "the name saved");
	assert.equal(await dialog.getByLabel("Your name").inputValue(), name);
}

async function goTo(page, label) {
	await page.getByRole("dialog").getByRole("link", { name: label }).click();
	await page.getByRole("heading", { level: 2, name: label }).waitFor();
}

async function toggle(page, label) {
	const control = page.getByRole("switch", { name: label });
	const before = await control.getAttribute("aria-checked");
	await control.click();
	await settled(control);
	await noRefusal(page);
	// A refusal would put the switch back.
	assert.notEqual(await control.getAttribute("aria-checked"), before, "the switch kept its new value");
}

async function chooseZone(page, search, city) {
	await page.getByLabel("Your time zone").getByRole("button", { name: "Change", exact: true }).click();
	const zoneDialog = page.getByRole("dialog", { name: "Change your time zone" });
	await zoneDialog.getByRole("combobox").click();
	await page.getByRole("combobox", { name: "Search time zones" }).fill(search);
	await page.getByRole("option").first().click();
	const use = zoneDialog.getByRole("button", { name: `Use ${city} time` });
	await use.waitFor();
	await use.click();
	await zoneDialog.waitFor({ state: "detached" });
	await page.locator("[data-personal-zone]").filter({ hasText: city }).waitFor();
	await page
		.getByRole("status")
		.filter({ hasText: "Saving…" })
		.waitFor({ state: "detached" })
		.catch(() => undefined);
	// The section reads itself again after the save.
	await page.waitForTimeout(600);
	await noRefusal(page);
}

for (const [name, engine] of ENGINES) {
	test(`people/peo-3 (${name}): save a name, then toggle a notification, and neither conflicts`, async () => {
		await withPage(engine, async (page) => {
			// Both sections are read, and so cached, before either saves.
			await open(page, "notifications");
			await goTo(page, "Your account");
			await saveName(page, "Jordan Rivera Ellis");
			await goTo(page, "Notifications");
			const first = page.getByRole("switch").first();
			await toggle(page, await first.getAttribute("aria-label"));
			// And back the other way: the notification save's revision reaches Your account.
			await goTo(page, "Your account");
			await saveName(page, "Jordan Rivera");
		});
	});

	test(`people/peo-3 (${name}): save a time zone, then a name, and neither conflicts`, async () => {
		await withPage(engine, async (page) => {
			await open(page, "account");
			await chooseZone(page, "Denver", "Denver");
			await saveName(page, "Jordan Rivera Ellis");
			await goTo(page, "Notifications");
			await toggle(page, await page.getByRole("switch").first().getAttribute("aria-label"));
		});
	});
}
