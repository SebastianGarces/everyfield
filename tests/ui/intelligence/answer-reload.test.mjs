// T-155 (messages/com-18): an open Answer dialog that loses to another tab, then loads the latest answers, shows the
// new entry and saves against it, instead of the copy it was opened with. Real producer state on a seeded preview: set
// UI_BASE_URL, then seed Attestations (tests/ui/intelligence/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

// Each engine corrects a different seeded signal, and puts it back, so the runs never share a record.
const SIGNAL = {
	chromium: { label: "Core values documented", from: "Yes", to: "Not yet" },
	webkit: { label: "Launch funding viable", from: "Not yet", to: "Yes" },
};

async function openAnswer(page, label) {
	await page.goto(`${BASE}/intelligence/attestations`);
	await hydrated(page);
	await page.getByRole("button", { name: new RegExp(`: ${label}$`) }).click();
	return page.getByRole("dialog", { name: label });
}

for (const [name, engine] of ENGINES) {
	const { label, from, to } = SIGNAL[name];
	test(`BUG-T155 messages/com-18 (${name}): after a conflict, the Answer dialog reads the reloaded entry and its save goes through`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("intelligence").owner.cookie);
			const mine = await openAnswer(page, label);
			const choice = (dialog, value) =>
				dialog.getByRole("radiogroup", { name: "Your answer" }).getByRole("radio", { name: value });

			// Another tab corrects the same signal first.
			const other = await context.newPage();
			const theirs = await openAnswer(other, label);
			await choice(theirs, to).click();
			await theirs.getByRole("button", { name: "Save answer" }).click();
			await other.getByText("Answer corrected.").first().waitFor();
			await other.close();

			await choice(mine, to).click();
			await mine.getByRole("button", { name: "Save answer" }).click();
			await mine.getByText("This signal changed in another window").waitFor();
			await mine.getByRole("button", { name: "Load the latest answers" }).click();
			// The dialog now shows the entry the page reloaded: their answer is the current one, and the refusal is gone.
			await mine.getByText("This is the current answer.", { exact: false }).waitFor();
			assert.equal(await choice(mine, to).getAttribute("aria-checked"), "true");
			assert.equal(await mine.getByText("This signal changed in another window").count(), 0);

			// Saving from here sends the reloaded revision: the correction back goes through the first time.
			await choice(mine, from).click();
			await mine.getByRole("button", { name: "Save answer" }).click();
			await page.getByText("Answer corrected.").first().waitFor();
			await mine.waitFor({ state: "detached" });
		});
	});
}
