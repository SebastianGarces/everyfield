// Record a leadership candidate (WP-039, Nora's QA of qa-main-1528). The attestation must be a deliberate act: a new
// candidate starts with both "every week, unbroken" boxes unticked, each box ticks on its own, a save stores exactly what
// was ticked, and opening an existing candidate shows what its current statement recorded. Real producer state on a
// seeded preview: set UI_BASE_URL, then seed Attestations (tests/ui/intelligence/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const ATTENDED = "Attended every week, unbroken";
const VOLUNTEERED = "Volunteered every week, unbroken";
// Each engine saves a different seeded person, so the two engine runs never share a record.
const PERSON = { chromium: "Maria Santos", webkit: "Tom Baker" };
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

async function open(page, context) {
	await signIn(context, fixture("intelligence").owner.cookie);
	await page.goto(`${BASE}/intelligence/attestations`);
	await hydrated(page);
}

async function recordDialog(page) {
	await page.getByRole("button", { name: "Record a candidate" }).click();
	return page.getByRole("dialog", { name: "Record a leadership candidate" });
}

const status = (dialog) => dialog.locator("[aria-live=polite]").filter({ hasText: /stablished/ });

for (const [name, engine] of ENGINES) {
	test(`AC:WP-039-1 AC:WP-039-2 (${name}): a new candidate starts unticked and is established only after both deliberate ticks`, async () => {
		await withPage(engine, async (page, context) => {
			await open(page, context);
			const dialog = await recordDialog(page);
			const attended = dialog.getByRole("checkbox", { name: ATTENDED });
			const volunteered = dialog.getByRole("checkbox", { name: VOLUNTEERED });
			// Criterion 1: both boxes unticked; the status names both missing behaviors.
			assert.equal(await attended.isChecked(), false);
			assert.equal(await volunteered.isChecked(), false);
			const line = await status(dialog).innerText();
			assert.match(line, /Not established/);
			assert.match(line, /attendance is not attested/);
			assert.match(line, /volunteering is not attested/);

			// Criterion 2: a valid 60+ day period, then each box ticks on its own.
			await dialog.getByLabel("Period starts").fill(iso(75));
			await dialog.getByLabel("Period ends").fill(iso(5));
			assert.match(
				await status(dialog).innerText(),
				/71 days · Not established: attendance is not attested; volunteering is not attested\./,
			);
			await attended.click();
			assert.equal(await attended.isChecked(), true);
			assert.equal(await volunteered.isChecked(), false);
			assert.match(await status(dialog).innerText(), /Not established: volunteering is not attested\./);
			await attended.click();
			await volunteered.click();
			assert.equal(await attended.isChecked(), false);
			assert.equal(await volunteered.isChecked(), true);
			assert.match(await status(dialog).innerText(), /Not established: attendance is not attested\./);
			await attended.click();
			assert.equal(await attended.isChecked(), true);
			assert.equal(await volunteered.isChecked(), true);
			assert.match(await status(dialog).innerText(), /71 days · Established\./);
		});
	});

	test(`AC:WP-039-3 (${name}): a save stores each box exactly as ticked and the list shows the person as not established`, async () => {
		await withPage(engine, async (page, context) => {
			await open(page, context);
			const row = page
				.locator("section[aria-labelledby=att-candidates]")
				.getByRole("listitem")
				.filter({ hasText: PERSON[name] });
			// A rerun first retracts the statement an earlier run saved, so this save is always a new record.
			if ((await row.count()) && !(await row.innerText()).includes("Retracted")) {
				await row.getByRole("button", { name: `Update: ${PERSON[name]}` }).click();
				const earlier = page.getByRole("dialog", { name: PERSON[name] });
				await earlier.getByRole("button", { name: "Retract" }).click();
				await earlier.waitFor({ state: "detached" });
				await row.getByText("Retracted").waitFor();
			}
			const dialog = await recordDialog(page);
			await dialog.getByRole("combobox").click();
			await page.getByRole("option", { name: PERSON[name] }).click();
			await dialog.getByLabel("Period starts").fill(iso(75));
			await dialog.getByLabel("Period ends").fill(iso(5));
			// Tick attendance only; volunteering stays as it started.
			await dialog.getByRole("checkbox", { name: ATTENDED }).click();
			await dialog.getByRole("button", { name: "Record candidate" }).click();
			await dialog.waitFor({ state: "detached" });

			// The list after a reload reads the stored statement, not the optimistic one.
			await page.reload();
			await hydrated(page);
			const text = await row.innerText();
			assert.match(text, /Not established/);
			assert.match(text, /Volunteering is not attested/);
			assert.doesNotMatch(text, /Attendance is not attested/);

			// The stored values come back into the correction form: attended true, volunteered false.
			await row.getByRole("button", { name: `Update: ${PERSON[name]}` }).click();
			const fix = page.getByRole("dialog", { name: PERSON[name] });
			assert.equal(await fix.getByRole("checkbox", { name: ATTENDED }).isChecked(), true);
			assert.equal(await fix.getByRole("checkbox", { name: VOLUNTEERED }).isChecked(), false);
		});
	});

	test(`AC:WP-039-4 (${name}): an existing candidate opens with the values its current statement recorded`, async () => {
		await withPage(engine, async (page, context) => {
			await open(page, context);
			// Seeded: Alex Rivera attended and volunteered; Sam Ortiz attended but did not volunteer.
			for (const [person, attended, volunteered] of [
				["Alex Rivera", true, true],
				["Sam Ortiz", true, false],
			]) {
				await page.getByRole("button", { name: `Update: ${person}` }).click();
				const dialog = page.getByRole("dialog", { name: person });
				assert.equal(await dialog.getByRole("checkbox", { name: ATTENDED }).isChecked(), attended, person);
				assert.equal(await dialog.getByRole("checkbox", { name: VOLUNTEERED }).isChecked(), volunteered, person);
				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "detached" });
			}
		});
	});
}
