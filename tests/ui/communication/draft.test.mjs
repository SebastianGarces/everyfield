import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const SUBJECT = "Sunday lunch";
const BODY = "Bring a dish to share after the service.";

async function openSettings(page, phone) {
	if (phone) await page.getByRole("button", { name: "Menu", exact: true }).click();
	await page.getByRole("link", { name: "Settings", exact: true }).click();
	await page.waitForURL(/\/settings\//);
	await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
	await page.waitForURL(/\/communication\?/);
}

async function writeDraft(page) {
	await page.getByRole("combobox", { name: "Add a person" }).fill("Ana");
	await page.getByRole("option", { name: /^Ana Lee/ }).click();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page.getByLabel("Subject").fill(SUBJECT);
	await page.getByRole("combobox", { name: "Message" }).fill(BODY);
}

for (const [engine, launcher] of ENGINES) {
	for (const [width, height] of [
		[1440, 900],
		[390, 844],
	]) {
		const phone = width < 600;
		test(`BUG-PR836 (${engine}, ${width}px): a message draft is as it was after Settings opens and closes, and gone once discarded`, () =>
			withPage(
				launcher,
				async (page, context) => {
					await signIn(context, fixture("people").owner.cookie);
					await page.goto(`${BASE}/communication?compose=new&step=who`);
					await hydrated(page);
					await writeDraft(page);

					await openSettings(page, phone);

					assert.equal(new URL(page.url()).searchParams.get("step"), "write");
					assert.equal(await page.getByLabel("Subject").inputValue(), SUBJECT);
					assert.equal(await page.getByRole("combobox", { name: "Message" }).inputValue(), BODY);
					await page.getByRole("button", { name: "Who (done)" }).click();
					await page.getByRole("button", { name: "Remove Ana Lee" }).waitFor();

					await page.getByRole("button", { name: "Back to messages" }).click();
					await page.getByRole("button", { name: "Leave", exact: true }).click();
					await page.getByRole("button", { name: "New message" }).click();
					await page.getByRole("heading", { name: "Who is this for?" }).waitFor();
					assert.equal(await page.getByRole("button", { name: "Remove Ana Lee" }).count(), 0);
				},
				{ width, height },
			));
	}
}
