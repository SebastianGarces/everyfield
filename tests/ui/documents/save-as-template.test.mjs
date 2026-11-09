// T-18 Save as template, in Chromium against a real preview. An Owner saves an edited policy as the church's own template
// (saving the edit first), finds it in "New from template" beside Everyfield's templates, makes a document from it and
// deletes it; a Member sees no Save as template control.
//   UI_BASE_URL=https://t18-....localhost:1355 node --test tests/ui/documents/save-as-template.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). SHOT_DIR (outside the repository) collects screenshots at
// 390 and 1440 px in light and dark mode.
//   AC:DOC-TEMPLATE-SAVE    criteria 1, 2 and 4 (save first, confirm, the copy holds the edit and the church's details)
//   AC:DOC-TEMPLATE-PICKER  criterion 3 (the church's own group, search by name and description)
//   AC:DOC-TEMPLATE-DELETE  criterion 7 (delete after a confirmation; a document made from it still opens)
//   AC:DOC-TEMPLATE-MEMBER  criterion 9 (a Member sees no Save as template control)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const PAPER = ".ef-paper .ProseMirror";
const SHOTS = process.env.SHOT_DIR;
const run = randomUUID().slice(0, 8);
const MARK = `Adopted by the board on [date], run ${run}.`;
const NAME = `Board policy ${run}`;
const DESCRIPTION = `Our wording for meeting ${run}.`;
const LEGAL = `Harvest ${run} Church, Inc.`;
const state = {};

const as = (who, act, size) =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people")[who].cookie);
			await act(page, context);
		},
		size,
	);
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const paperText = (page) => page.locator(PAPER).innerText();
const status = (page) =>
	page
		.getByRole("status")
		.filter({ hasText: /Saved|Unsaved|Saving/ })
		.first();

async function shots(context, page, name, open) {
	if (!SHOTS) return;
	// Leaving a page with unsaved edits asks first (beforeunload); the shots leave on purpose.
	if (!page.listenerCount("dialog")) page.on("dialog", (dialog) => void dialog.accept());
	for (const theme of ["light", "dark"]) {
		await context.addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
		for (const width of [390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await open(page);
			await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png` });
		}
	}
	await context.addCookies([{ name: "ef-theme", value: "light", url: BASE }]);
	await page.setViewportSize({ width: 1440, height: 900 });
}

async function openPicker(page) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await button(page, "New from template").click();
	return page.getByRole("dialog", { name: "New from template" });
}

test("AC:DOC-TEMPLATE-SAVE: an unsaved edit is saved first, then the template holds it (Chromium)", async () => {
	await as("owner", async (page) => {
		const picker = await openPicker(page);
		await picker.getByRole("button", { name: /^Conflict of Interest Policy/ }).click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		const docPath = new URL(page.url()).pathname;
		await page.locator(PAPER).evaluate((el) => el.editor.commands.focus("end"));
		await page.keyboard.press("Enter");
		await page.keyboard.type(MARK);
		await status(page).getByText("Unsaved changes").waitFor();

		// Cancel makes nothing.
		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		let dialog = page.getByRole("dialog", { name: "Save as template" });
		await dialog.getByText("Your latest changes are not saved yet.", { exact: false }).waitFor();
		assert.equal(
			await dialog.getByRole("textbox", { name: "Template name" }).inputValue(),
			"Conflict of Interest Policy",
		);
		assert.ok(await button(dialog, "Save as template").isDisabled(), "Confirm waits for the save");
		await button(dialog, "Cancel").click();
		await dialog.waitFor({ state: "hidden" });

		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		dialog = page.getByRole("dialog", { name: "Save as template" });
		await button(dialog, "Save changes").click();
		await status(page).getByText("Saved").waitFor({ timeout: 30_000 });
		await dialog.getByText("Your latest changes are not saved yet.", { exact: false }).waitFor({ state: "hidden" });
		await dialog.getByText("The template copies revision 2", { exact: false }).waitFor();
		await dialog.getByRole("textbox", { name: "Template name" }).fill(NAME);
		await dialog.getByRole("textbox", { name: "Description" }).fill(DESCRIPTION);
		// A double click on Confirm makes one template (checked in the picker below).
		await button(dialog, "Save as template").dblclick();
		await dialog.waitFor({ state: "hidden", timeout: 30_000 });
		await page.getByText(`Saved “${NAME}” as your church's template.`, { exact: false }).waitFor();
		assert.equal(new URL(page.url()).pathname, docPath, "the document stays open");
		assert.match(await paperText(page), new RegExp(MARK.replace(/[[\].]/g, "\\$&")));
		await status(page).getByText("Saved").waitFor();
		state.docPath = docPath;
	});
});

test("AC:DOC-TEMPLATE-PICKER: the church's templates have their own group, and search finds them (Chromium)", async () => {
	await as("owner", async (page) => {
		// A church detail changes after the template was saved: the brand kit's legal name.
		await page.goto(`${BASE}/settings/brand`, { waitUntil: "networkidle" });
		await hydrated(page);
		await page.getByRole("textbox", { name: "Primary color", exact: true }).fill("#1F4E79");
		await page.getByRole("textbox", { name: "Legal name" }).fill(LEGAL);
		await button(page, "Save").click();
		await page.getByText("No unsaved changes.").waitFor({ timeout: 30_000 });

		const picker = await openPicker(page);
		const mine = picker.getByRole("list", { name: "Your church's templates" });
		const theirs = picker.getByRole("list", { name: "Everyfield templates" });
		await mine.waitFor();
		assert.equal(await mine.getByRole("button", { name: new RegExp(`^${NAME}`) }).count(), 1, "one template");
		const card = mine.getByRole("listitem").filter({ hasText: NAME });
		await card.getByText(DESCRIPTION).waitFor();
		await card.getByText("Your church", { exact: true }).waitFor();
		await card.getByText("Formal or legal", { exact: true }).waitFor();
		await card.getByText("Letter · PDF and Word", { exact: true }).waitFor();
		assert.ok((await theirs.getByRole("button").count()) >= 4, "Everyfield's templates stay in their own group");
		await picker.getByText("Your church's templates", { exact: true }).waitFor();
		await picker.getByText("Everyfield templates", { exact: true }).waitFor();

		const search = picker.getByRole("searchbox", { name: "Search templates" });
		await search.fill(`meeting ${run}`);
		assert.equal(await mine.getByRole("button", { name: new RegExp(`^${NAME}`) }).count(), 1, "found by description");
		assert.equal(await theirs.count(), 0, "no Everyfield template has these words");
		await search.fill(`board policy ${run}`);
		assert.equal(await mine.getByRole("button", { name: new RegExp(`^${NAME}`) }).count(), 1, "found by name");
		await search.fill("");

		// A document from the church template holds the saved edit and names the template.
		await mine.getByRole("button", { name: new RegExp(`^${NAME}`) }).click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		assert.notEqual(new URL(page.url()).pathname, state.docPath);
		assert.match(await paperText(page), new RegExp(MARK.replace(/[[\].]/g, "\\$&")));
		await page.getByText(`from ${NAME} v1`).waitFor();
		state.copyPath = new URL(page.url()).pathname;
		// The merge field shows the church's details as they are now, not the value the source document froze.
		assert.match(await page.locator(".ef-paper").innerText(), new RegExp(LEGAL.replace(/[.,]/g, "\\$&")));
		const source = await page.request.get(`${BASE}${state.docPath}`);
		assert.ok(!(await source.text()).includes(LEGAL), "the source document keeps the value it froze");
		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		await page
			.getByRole("link")
			.filter({ hasText: `from ${NAME} v1` })
			.first()
			.waitFor();
	});
});

test("AC:DOC-TEMPLATE-DELETE: deleting a template asks first; documents made from it still open (Chromium)", async () => {
	await as("owner", async (page) => {
		const picker = await openPicker(page);
		const mine = picker.getByRole("list", { name: "Your church's templates" });
		await button(mine, `Delete template ${NAME}`).click();
		const confirm = page.getByRole("alertdialog", { name: `Delete the template "${NAME}"?` });
		await confirm.getByText("Documents already made from it keep their content", { exact: false }).waitFor();
		await button(confirm, "Delete template").click();
		await confirm.waitFor({ state: "hidden", timeout: 30_000 });
		assert.equal(await picker.getByRole("button", { name: new RegExp(`^${NAME}`) }).count(), 0, "it leaves the picker");
		// After a reload it stays gone.
		const again = await openPicker(page);
		assert.equal(await again.getByRole("button", { name: new RegExp(`^${NAME}`) }).count(), 0);
		await page.goto(`${BASE}${state.copyPath}`);
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		assert.match(await paperText(page), new RegExp(MARK.replace(/[[\].]/g, "\\$&")));
		await page.getByText(`from ${NAME} v1`).waitFor();
	});
});

test("AC:DOC-TEMPLATE-MEMBER: a Member sees no Save as template control (Chromium)", async () => {
	await as("member", async (page) => {
		await page.goto(`${BASE}${state.docPath}`);
		await hydrated(page);
		await page.getByRole("region", { name: "Preview" }).waitFor({ timeout: 90_000 });
		assert.equal(await button(page, "More actions").count(), 0);
		assert.equal(await page.getByText("Save as template").count(), 0);
		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		assert.equal(await button(page, "New from template").count(), 0);
	});
});

test("screenshots of each state at 390 and 1440 px, light and dark", { skip: !SHOTS }, async () => {
	await as("owner", async (page, context) => {
		const docPage = async (p) => {
			await p.goto(`${BASE}${state.docPath}`);
			await hydrated(p);
			await p.locator(PAPER).waitFor({ timeout: 90_000 });
		};
		await shots(context, page, "01-menu", async (p) => {
			await docPage(p);
			await button(p, "More actions").click();
			await p.getByRole("menuitem", { name: "Save as template" }).waitFor();
		});
		const openDialog = async (p, edit) => {
			await docPage(p);
			if (edit) {
				await p.locator(PAPER).evaluate((el) => el.editor.commands.focus("start"));
				await p.keyboard.type("Draft. ");
			}
			await button(p, "More actions").click();
			await p.getByRole("menuitem", { name: "Save as template" }).click();
			await p.getByRole("dialog", { name: "Save as template" }).waitFor();
		};
		await shots(context, page, "02-dialog-saved", (p) => openDialog(p, false));
		await shots(context, page, "03-dialog-unsaved", (p) => openDialog(p, true));
		await shots(context, page, "04-confirmation", async (p) => {
			await openDialog(p, false);
			const dialog = p.getByRole("dialog", { name: "Save as template" });
			await dialog.getByRole("textbox", { name: "Template name" }).fill(`Shot template ${run}`);
			await button(dialog, "Save as template").click();
			await p.getByText("as your church's template.", { exact: false }).waitFor({ timeout: 30_000 });
		});
		await shots(context, page, "05-picker-both-groups", async (p) => {
			await openPicker(p);
			await p.getByRole("list", { name: "Your church's templates" }).waitFor();
		});
		await shots(context, page, "06-delete-confirm", async (p) => {
			const picker = await openPicker(p);
			await button(picker, `Delete template Shot template ${run}`).first().click();
			await p.getByRole("alertdialog").waitFor();
		});
	});
	await as("member", async (page, context) => {
		await shots(context, page, "07-member-document", async (p) => {
			await p.goto(`${BASE}${state.docPath}`);
			await hydrated(p);
			await p.getByRole("region", { name: "Preview" }).waitFor({ timeout: 90_000 });
		});
	});
});
