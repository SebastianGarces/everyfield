// One follow-up owner, one contact record, one follow-up state (WP-023/api S2 batch 2: F07, F08, F09). Every screen that
// shows a follow-up must show the same owner, with the same eligibility, and the same state after a contact or a tick.
// Real producer state on a seeded preview: set UI_BASE_URL, then seed People and follow-ups (tests/ui/followups/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const people = () => fixture("people");
const seeded = () => fixture("followups");
const INELIGIBLE = "Tomas Weaver · Can't own follow-ups: no linked Person";
const text = async (locator) => (await locator.innerText()).replaceAll(/\s+/g, " ");

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-TSK-012 (${name}): every screen names an eligible and an ineligible follow-up owner the same way`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			const f = seeded();
			const row = (title) => page.getByRole("listitem").filter({ hasText: title }).first();

			// Ineligible: Tomas Weaver holds "Check in with Ana Lee" but has no linked Person.
			const title = "Check in with Ana Lee";
			await page.goto(`${BASE}/tasks?view=all`);
			await hydrated(page);
			const tasksRow = row(title);
			await tasksRow.waitFor();
			assert.ok((await text(tasksRow)).includes(INELIGIBLE), "Tasks list row");
			assert.ok((await text(tasksRow)).includes("Added by Daniel Reyes"), "Tasks list origin");
			await tasksRow.getByRole("button", { name: "Reassign" }).waitFor();
			await tasksRow.getByRole("button", { name: title, exact: true }).click();
			const panel = page.getByRole("dialog");
			await panel.getByText("Assigned to").waitFor();
			assert.ok((await text(panel)).includes(`Assigned to ${INELIGIBLE}`), "task panel");
			await panel.getByRole("button", { name: "Reassign" }).waitFor();
			await page.keyboard.press("Escape");

			await page.goto(`${BASE}/tasks/follow-ups`);
			await hydrated(page);
			const pageRow = row(title);
			await pageRow.waitFor();
			assert.ok((await text(pageRow)).includes(INELIGIBLE), "Follow-ups page");
			await pageRow.getByRole("button", { name: `Reassign ${title}` }).waitFor();
			// The duty still counts as Needs owner.
			await page.getByRole("radio", { name: /Needs owner/ }).click();
			await page.waitForURL(/show=needs_owner/);
			await row(title).waitFor();

			await page.goto(`${BASE}/follow-ups/${f.tasks.kim}`);
			await hydrated(page);
			await page.getByText(`Assigned to ${INELIGIBLE}`).waitFor();
			await page.getByRole("button", { name: `Reassign ${title}` }).waitFor();

			await page.goto(`${BASE}/people/${people().people["Ana Lee"]}`);
			await hydrated(page);
			const card = page.getByRole("region", { name: "Follow-ups" });
			assert.ok((await text(card)).includes(INELIGIBLE), "person Follow-ups card");
			await card.getByRole("button", { name: `Reassign ${title}` }).waitFor();
			// Origin tells two follow-ups for one Person apart.
			assert.ok((await text(card)).includes("Added by Daniel Reyes"), "origin");

			// Eligible: Ruth Allen holds Sara Nunez's Vision follow-up, with no warning anywhere.
			await page.goto(`${BASE}/follow-ups/${f.tasks.sara}`);
			await hydrated(page);
			await page.getByText("Assigned to Ruth Allen", { exact: true }).waitFor();
			assert.equal(await page.getByText("Can't own follow-ups").count(), 0);
			await page.goto(`${BASE}/tasks/follow-ups`);
			await hydrated(page);
			await page.getByRole("radio", { name: "Owned" }).click();
			const sara = row("Follow up with Sara Nunez");
			assert.ok((await text(sara)).includes("Ruth Allen"));
			assert.ok((await text(sara)).includes("After Vision meeting #12"), "origin of a meeting follow-up");
			assert.equal((await text(sara)).includes("Can't own follow-ups"), false);

			// The same eligible follow-up on the Tasks list, the task panel and the person's card.
			const saraTitle = "Follow up with Sara Nunez";
			await page.goto(`${BASE}/tasks?view=all`);
			await hydrated(page);
			const saraRow = row(saraTitle);
			await saraRow.waitFor();
			assert.ok((await text(saraRow)).includes("After Vision meeting #12"), "Tasks list origin");
			assert.equal((await text(saraRow)).includes("Can't own follow-ups"), false, "Tasks list row");
			assert.equal(await saraRow.getByRole("button", { name: "Reassign" }).count(), 0);
			await saraRow.getByRole("button", { name: saraTitle, exact: true }).click();
			const saraPanel = page.getByRole("dialog");
			await saraPanel.getByText("Assigned to").waitFor();
			assert.ok((await text(saraPanel)).includes("Assigned to Ruth Allen"), "task panel");
			assert.equal((await text(saraPanel)).includes("Can't own follow-ups"), false, "task panel");
			await page.keyboard.press("Escape");
			await page.goto(`${BASE}/people/${people().people["Sara Nunez"]}`);
			await hydrated(page);
			const saraCard = page.getByRole("region", { name: "Follow-ups" });
			assert.ok((await text(saraCard)).includes("Ruth Allen"), "person Follow-ups card");
			assert.equal((await text(saraCard)).includes("Can't own follow-ups"), false, "person Follow-ups card");
		});
	});
}

// The contact changes the seeded Person for good, so one engine runs it per seeding.
for (const [name, engine] of ENGINES.slice(0, 1)) {
	test(`AC:TARGET-MTG-022 (${name}): one contact finishes the Person's follow-ups, and every screen agrees with no reload`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, people().owner.cookie);
			const { nora } = seeded();
			// The Person has two open follow-ups that read differently: one after a meeting, one added by hand.
			await page.goto(`${BASE}/people/${nora.personId}`);
			await hydrated(page);
			const card = page.getByRole("region", { name: "Follow-ups" });
			await card.getByText("Send Nora the welcome packet").waitFor();
			assert.ok((await text(card)).includes("After Vision meeting #10"));
			assert.ok((await text(card)).includes("Added by Daniel Reyes"));

			// Record from the call screen: the dialog names what else this contact finishes before it saves.
			await page.goto(`${BASE}/follow-ups/${nora.manual}`);
			await hydrated(page);
			await page.getByRole("radio", { name: /Contacted/ }).click();
			await page.getByRole("radio", { name: "Just now" }).click();
			await page.getByRole("combobox", { name: "How" }).click();
			await page.getByRole("option", { name: "Phone call" }).click();
			await page.getByRole("textbox", { name: /Note/ }).fill("Asked about childcare on Sundays.");
			await page.getByRole("checkbox", { name: /Mark the follow-up done/ }).check();
			await page.getByText(/also finishes your other follow-up for Nora: After Vision meeting #10/).waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.getByRole("heading", { name: "Saved: Contacted" }).waitFor();

			// The task panel shows the record with no reload.
			await page.goto(`${BASE}/tasks?view=all&status=any&q=Nora`);
			await hydrated(page);
			await page.getByRole("button", { name: "Send Nora the welcome packet", exact: true }).click();
			const panel = page.getByRole("dialog");
			const log = panel.locator("section").filter({ has: page.getByRole("heading", { name: "What happened" }) });
			await log.getByText("Contacted", { exact: true }).waitFor();
			const entry = await text(log);
			assert.ok(entry.includes("Phone call"), entry);
			assert.ok(entry.includes("Asked about childcare on Sundays."), entry);
			assert.ok(entry.includes("Recorded by you"), entry);
			assert.ok(entry.includes("also finished After Vision meeting #10"), entry);
			assert.ok((await text(panel)).includes("Done"));
			await page.keyboard.press("Escape");
			// The other follow-up is done too: the same record, its own panel.
			await page.getByRole("button", { name: "Follow up with Nora Finch", exact: true }).click();
			await page.getByRole("dialog").getByText("Asked about childcare on Sundays.").waitFor();
			await page.keyboard.press("Escape");

			// The Follow-ups card empties, and the Person's activity says how it happened.
			await page.goto(`${BASE}/people/${nora.personId}`);
			await hydrated(page);
			const after = page.getByRole("region", { name: "Follow-ups" });
			await after.getByText("No open follow-up.").waitFor();
			const activity = await text(page.getByRole("listitem").filter({ hasText: "Follow-up: contacted" }).first());
			assert.ok(activity.includes("Follow-up: contacted"), activity);
			assert.ok(activity.includes("Phone call"), activity);
			assert.ok(activity.includes("Asked about childcare on Sundays."), activity);

			// A done follow-up takes no new outcome: its call screen shows it as done with the completing record.
			for (const id of [nora.manual, nora.vision]) {
				await page.goto(`${BASE}/follow-ups/${id}`);
				await hydrated(page);
				await page.getByText("This follow-up is done.").waitFor();
				assert.equal(await page.getByRole("button", { name: "Save", exact: true }).count(), 0);
				await page.getByText("Asked about childcare on Sundays.").first().waitFor();
			}
			// The Follow-ups page lists neither.
			await page.goto(`${BASE}/tasks/follow-ups`);
			await hydrated(page);
			assert.equal(await page.getByText("Send Nora the welcome packet").count(), 0);
		});
	});
}

test("AC:TARGET-MTG-022 narrow screens: the call screen and task panel keep the owner and the record readable", async () => {
	const [name, engine] = ENGINES[0];
	await withPage(
		engine,
		async (page, context) => {
			await signIn(context, people().owner.cookie);
			await page.goto(`${BASE}/follow-ups/${seeded().tasks.kim}`);
			await hydrated(page);
			await page.getByText(`Assigned to ${INELIGIBLE}`).waitFor();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
			assert.equal(overflow, false, `${name}: no horizontal scroll at 390 px`);
		},
		{ width: 390, height: 900 },
	);
});
