// AC:TARGET-IDN-010 (WP-039 slice 2, ask criterion 8): an Admin with an unsaved settings change keeps the draft when
// moving to another settings section, and sees the discard warning when Back or a link (including a link to
// /intelligence/attestations) would leave settings. A failed save keeps what they typed. It runs against a running app
// seeded with tests/ui/intelligence/seed.mts through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const ATTESTATIONS = "/intelligence/attestations";

/** Opens the Attestations page, then Settings on Your account, and types a new name that is not saved. */
async function draft(page, context, name) {
	await signIn(context, fixture("intelligence").owner.cookie);
	await page.goto(`${BASE}${ATTESTATIONS}`, { waitUntil: "networkidle" });
	await hydrated(page);
	await page.getByRole("button", { name: /account menu$/ }).click();
	await page.getByRole("menuitem", { name: "Your account" }).click();
	const dialog = page.getByRole("dialog").first();
	await page.waitForURL("**/settings/account");
	const field = dialog.getByLabel("Your name");
	await field.fill(name);
	return { dialog, field };
}
const warning = (page) => page.getByRole("alertdialog", { name: "Discard unsaved changes?" });

for (const [engine, browser] of ENGINES) {
	test(`AC:TARGET-IDN-010 (${engine}): a draft survives a move to another section and a section link back`, async () => {
		await withPage(browser, async (page, context) => {
			const { dialog, field } = await draft(page, context, "Daniel Draft");
			await dialog.getByRole("link", { name: "Notifications" }).click();
			await page.waitForURL("**/settings/notifications");
			assert.equal(await warning(page).count(), 0);
			await dialog.getByRole("link", { name: "Your account" }).click();
			await page.waitForURL("**/settings/account");
			assert.equal(await field.inputValue(), "Daniel Draft");
		});
	});

	test(`AC:TARGET-IDN-010 (${engine}): Back warns before the draft is lost, Keep editing returns to it`, async () => {
		await withPage(browser, async (page, context) => {
			const { dialog, field } = await draft(page, context, "Daniel Back");
			await page.goBack();
			await warning(page).waitFor();
			await warning(page).getByRole("button", { name: "Keep editing" }).click();
			await page.waitForURL("**/settings/account");
			assert.equal(await field.inputValue(), "Daniel Back");
			void dialog;
		});
	});

	test(`AC:TARGET-IDN-010 (${engine}): Back then Discard leaves settings on the page behind`, async () => {
		await withPage(browser, async (page, context) => {
			const { dialog } = await draft(page, context, "Daniel Discard");
			await page.goBack();
			await warning(page).waitFor();
			await warning(page).getByRole("button", { name: "Discard changes" }).click();
			await dialog.waitFor({ state: "detached" });
			assert.equal(new URL(page.url()).pathname, ATTESTATIONS);
		});
	});

	test(`AC:TARGET-IDN-010 (${engine}): a link to /intelligence/attestations warns first and keeps the draft`, async () => {
		await withPage(browser, async (page, context) => {
			const { dialog, field } = await draft(page, context, "Daniel Link");
			await page.evaluate((to) => window.next.router.push(to), ATTESTATIONS);
			await warning(page).waitFor();
			await warning(page).getByRole("button", { name: "Keep editing" }).click();
			await page.waitForURL("**/settings/account");
			assert.equal(await field.inputValue(), "Daniel Link");
			void dialog;
		});
	});

	test(`AC:TARGET-IDN-010 (${engine}): a failed save keeps what the Admin typed`, async () => {
		await withPage(browser, async (page, context) => {
			const { dialog, field } = await draft(page, context, "Daniel Offline");
			await context.setOffline(true);
			await dialog.getByRole("button", { name: "Save" }).click();
			await page.waitForTimeout(1500);
			assert.equal(await field.inputValue(), "Daniel Offline");
			assert.equal(await dialog.getByText("No unsaved changes.").count(), 0);
			await context.setOffline(false);
		});
	});
}
