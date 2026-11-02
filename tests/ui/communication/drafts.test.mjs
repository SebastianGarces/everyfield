// WP-027: a planter deletes a draft, and a new message is saved only on purpose. The tests count draft rows in the
// database, not component state. Seed with tests/ui/people/seed.mts, then meetings, then communication; set UI_BASE_URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const owner = () => fixture("people").owner.cookie;

let db = null;
/** The seeded database, opened on first use. Rows are counted with the admin connection. */
async function database() {
	if (db) return db;
	const { openSeedEnvironment } = await import("../seed-env.mts");
	const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
	const env = await openSeedEnvironment(fixture("people").origin);
	const plant = fixture("people").plant;
	const count = async (state, subject) => {
		const result = await env.admin.execute(
			subject === undefined
				? sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant}::uuid AND state = ${state}`
				: sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant}::uuid AND state = ${state} AND subject = ${subject}`,
		);
		return result.rows[0].n;
	};
	db = { count, close: () => env.close() };
	return db;
}
test.after(async () => {
	if (db) await db.close();
});

const open = async (page, path) => {
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
};
const heading = (page, name) => page.getByRole("heading", { level: 2, name });
const next = (page) => page.getByRole("button", { name: "Next", exact: true });
const draftsTile = async (page) => {
	const text = await page.getByLabel("Message counts").innerText();
	return Number(/(\d+)\s*Drafts/.exec(text)?.[1]);
};

async function chooseEveryone(page) {
	await page.getByLabel("Groups and teams").click();
	await page.getByRole("option", { name: /All people/ }).click();
	await page.keyboard.press("Escape");
	await page.getByText("Will get this email").waitFor();
	await page.waitForFunction(() => !document.querySelector('button[aria-describedby="step-reason"][disabled]'));
}

/** A new message at Write with a subject and body, unsaved. */
async function startWrite(page, subject) {
	await open(page, "/communication?compose=new&step=who");
	await chooseEveryone(page);
	await next(page).click();
	await heading(page, "Write the message").waitFor();
	await page.waitForURL(/compose=new&step=write/);
	if (subject !== undefined) {
		await page.getByLabel("Subject").fill(subject);
		await page.getByRole("combobox", { name: "Message" }).fill("Hello {{name}}.");
	}
}

/** Saves the message on purpose and waits for its own address. Returns the draft id. */
async function saveDraft(page) {
	await page.getByRole("button", { name: "Save draft" }).first().click();
	await page.getByText("Draft saved.").waitFor();
	await page.waitForURL(/compose=[0-9a-f-]{36}&step=write/);
	await page.waitForLoadState("networkidle");
	return new URL(page.url()).searchParams.get("compose");
}

for (const [name, engine] of ENGINES) {
	test(`AC:CASE-COM-003 (${name}): a new message is not saved by the move to Write or by leaving it`, async () => {
		const rows = await database();
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const before = await rows.count("draft");
			await startWrite(page);
			// Criterion 1: no row after Who to Write.
			assert.equal(await rows.count("draft"), before);
			const subject = `Left unsaved ${name} ${Date.now().toString(36)}`;
			await page.getByLabel("Subject").fill(subject);
			await page.getByRole("combobox", { name: "Message" }).fill("Body kept.");

			// Criterion 3: the prompt shows and Cancel keeps the message as it was.
			await page.getByRole("button", { name: "Back to messages" }).click();
			const dialog = page.getByRole("alertdialog");
			await dialog.getByText("Leave without saving?").waitFor();
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await heading(page, "Write the message").waitFor();
			assert.equal(await page.getByLabel("Subject").inputValue(), subject);
			assert.equal(await page.getByRole("combobox", { name: "Message" }).inputValue(), "Body kept.");

			// Criterion 2: Leave removes nothing because nothing was saved.
			await page.getByRole("button", { name: "Back to messages" }).click();
			await dialog.getByRole("button", { name: "Leave" }).click();
			await page.getByRole("button", { name: "New message" }).first().waitFor();
			assert.equal(await rows.count("draft", subject), 0);
			assert.equal(await rows.count("draft"), before);
		});
	});

	test(`AC:CASE-COM-003 (${name}): Save draft and Review save one row, and later saves update it`, async () => {
		const rows = await database();
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const subject = `One row ${name} ${Date.now().toString(36)}`;
			await startWrite(page, subject);
			assert.equal(await rows.count("draft", subject), 0);
			const id = await saveDraft(page);
			assert.equal(await rows.count("draft", subject), 1);
			// A second save and a step move update the same row.
			await page.getByRole("button", { name: "Save draft" }).first().click();
			await page.getByText("Draft saved.").waitFor();
			await next(page).click();
			await heading(page, "Review and send").waitFor();
			await page.waitForURL(new RegExp(`compose=${id}&step=review`));
			assert.equal(await rows.count("draft", subject), 1);
			await open(page, "/communication");
			const tile = await draftsTile(page);
			assert.ok(tile >= 1);
			const listed = page.getByRole("region", { name: "History" }).getByRole("button", { name: new RegExp(subject) });
			assert.equal(await listed.count(), 1);
		});
	});

	test(`AC:CASE-COM-003 (${name}): the form survives Write to Who to Write, and a reload opens a new message at Who`, async () => {
		const rows = await database();
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const before = await rows.count("draft", "");
			const subject = `Round trip ${name} ${Date.now().toString(36)}`;
			await startWrite(page, subject);
			await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Who/ }).click();
			await heading(page, "Who is this for?").waitFor();
			await page.getByText("Will get this email").waitFor();
			await next(page).click();
			await heading(page, "Write the message").waitFor();
			assert.equal(await page.getByLabel("Subject").inputValue(), subject);
			assert.equal(await page.getByRole("combobox", { name: "Message" }).inputValue(), "Hello {{name}}.");

			// Criterion 6: reload at Write opens Who with a blank form and no error.
			await open(page, "/communication?compose=new&step=write");
			await heading(page, "Who is this for?").waitFor();
			await page.waitForURL(/compose=new&step=who/);
			assert.equal(await page.getByRole("alert").count(), 0);
			await open(page, "/communication?compose=new&step=review");
			await heading(page, "Who is this for?").waitFor();
			assert.equal(await rows.count("draft", ""), before);
			assert.equal(await rows.count("draft", subject), 0);
		});
	});

	test(`AC:CASE-COM-003 AC:CASE-COM-012 (${name}): a planter deletes a draft, the row and the tile follow, and a stale delete is refused`, async () => {
		const rows = await database();
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			const run = Date.now().toString(36);
			const subject = `Delete me ${name} ${run}`;

			// Criterion 10: a new unsaved message has no Delete draft.
			await startWrite(page, subject);
			assert.equal(await page.getByRole("button", { name: "Delete draft" }).count(), 0);
			await saveDraft(page);
			assert.equal(await rows.count("draft", subject), 1);

			// Criterion 7: the saved draft shows Delete draft at every step; the dialog names the subject.
			await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Who/ }).click();
			await heading(page, "Who is this for?").waitFor();
			await page.getByRole("button", { name: "Delete draft" }).waitFor();
			await page.getByRole("navigation", { name: "Steps" }).getByRole("button", { name: /Write/ }).click();
			await heading(page, "Write the message").waitFor();

			// Criterion 9: a stale revision is refused, the draft stays and the message says what to do.
			const other = await context.newPage();
			await open(other, page.url().replace(BASE, ""));
			await other.getByLabel("Subject").fill(`${subject} changed`);
			await other.getByRole("button", { name: "Save draft" }).first().click();
			await other.getByText("Draft saved.").waitFor();
			await other.close();
			await page.getByRole("button", { name: "Delete draft" }).click();
			const dialog = page.getByRole("alertdialog");
			await dialog.getByText(`"${subject}"`).waitFor();
			await dialog.getByText("The draft is removed for good.").waitFor();
			await dialog.getByRole("button", { name: "Delete draft" }).click();
			await dialog.getByText("This record changed. Reload it, then try again.").waitFor();
			assert.equal(await rows.count("draft", `${subject} changed`), 1);
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await heading(page, "Write the message").waitFor();

			// Criterion 8: after a reload the delete goes through, the row and the tile drop without a reload.
			await open(page, page.url().replace(BASE, ""));
			await heading(page, "Write the message").waitFor();
			const changed = `${subject} changed`;
			await page.getByRole("button", { name: "Back to messages" }).click();
			await page.getByRole("button", { name: "New message" }).first().waitFor();
			const tileBefore = await draftsTile(page);
			await page.getByRole("button", { name: new RegExp(changed) }).click();
			await heading(page, "Write the message").waitFor();
			await page.getByRole("button", { name: "Delete draft" }).click();
			await dialog.getByText(`"${changed}"`).waitFor();
			await dialog.getByRole("button", { name: "Delete draft" }).click();
			await page.getByText("Draft deleted.").waitFor();
			await page.getByRole("button", { name: "New message" }).first().waitFor();
			assert.equal(await rows.count("draft", changed), 0);
			assert.equal(await page.getByRole("button", { name: new RegExp(changed) }).count(), 0);
			assert.equal(await draftsTile(page), tileBefore - 1);
			await open(page, "/communication");
			assert.equal(await page.getByRole("button", { name: new RegExp(changed) }).count(), 0);
			assert.equal(await draftsTile(page), tileBefore - 1);
		});
	});

	test(`AC:CASE-COM-012 (${name}): a reviewed follow-up has no Delete draft`, async () => {
		const { reviewed } = fixture("communication");
		await withPage(engine, async (page, context) => {
			await signIn(context, owner());
			await open(page, `/communication?compose=${reviewed}&step=review`);
			await heading(page, "Review and send").waitFor();
			assert.equal(await page.getByRole("button", { name: "Delete draft" }).count(), 0);
		});
	});
}
