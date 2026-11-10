// T-81 "Template changes" and "All differences", in Chromium against a real preview. An Owner saves a policy as the
// church's template and makes a document from it, then edits two paragraphs of the document: one the template will
// also reword, one it leaves alone. The template is updated to v2 (T-79) with its own wording of the first paragraph
// and a new closing paragraph. The compare opens on Template changes, which lists the paragraph both changed and the
// new one, not the church's own edit. All differences lists all three; accepting the church's own edit from there
// writes one revision, after which the notice is gone and Template changes says the document has every change.
//   UI_BASE_URL=https://t81-....localhost:1355 node --test tests/ui/documents/template-changes.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). SHOT_DIR (outside the repository) collects screenshots at
// 390 and 1440 px in light and dark mode.
//   AC:DOC-TEMPLATE-CHANGES  criteria 5, 8 and 14 (both views, a mark for each kind, accept from All differences)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const PAPER = ".ef-paper .ProseMirror";
const SHOTS = process.env.SHOT_DIR;
const run = randomUUID().slice(0, 8);
const NAME = `Board policy ${run}`;
// The policy's "Purpose" paragraph and its "What counts as an interest" paragraph, by how they start.
const PURPOSE = "The board makes decisions for the whole church plant.";
const INTEREST = "A board member has an interest when";
const OURS = `Our board decides for the whole church, run ${run}.`;
const THEIRS = `The board decides for the whole church plant and keeps those decisions fair, run ${run}.`;
const OWN = `Our own words on interests, run ${run}.`;
const CLOSING = `Questions about this policy go to the board chair, run ${run}.`;

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const notice = (page) => page.getByRole("region", { name: "Template updated" });
const compareView = (page) => page.getByRole("region", { name: "Compare with template" });
const viewSwitch = (page, name) => compareView(page).getByRole("radio", { name: new RegExp(`^${name}`) });
const list = (page, name) => compareView(page).getByRole("list", { name }).getByRole("listitem");
const status = (page) =>
	page
		.getByRole("status")
		.filter({ hasText: /Saved|Unsaved|Saving/ })
		.first();

/** Full-page shots at both widths and themes; with `part`, that element on its own too. */
async function shots(context, page, name, open, part) {
	if (!SHOTS) return;
	for (const theme of ["light", "dark"]) {
		await context.addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
		for (const width of [390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await open(page);
			await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
			if (part) await part(page).screenshot({ path: `${SHOTS}/${name}-part-${width}-${theme}.png` });
		}
	}
	await context.addCookies([{ name: "ef-theme", value: "light", url: BASE }]);
	await page.setViewportSize({ width: 1440, height: 900 });
}

async function openDocument(page, path) {
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
}
async function openCompare(page, path, view = "Template changes") {
	await openDocument(page, path);
	await button(page, "Compare with template").first().click();
	await compareView(page).getByText("Your church’s template", { exact: true }).waitFor({ timeout: 30_000 });
	if (view !== "Template changes") await viewSwitch(page, view).click();
	await viewSwitch(page, view).and(page.locator("[aria-checked=true]")).waitFor();
}
async function fromPicker(page, search) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await button(page, "New from template").click();
	const picker = page.getByRole("dialog", { name: "New from template" });
	await picker.getByRole("searchbox", { name: "Search templates" }).fill(search);
	await picker
		.getByRole("button", { name: new RegExp(`^${search}`) })
		.first()
		.click();
	await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
	return new URL(page.url()).pathname;
}
/** Replaces the top-level paragraph that starts with `start` by one plain paragraph of `text`. */
async function reword(page, start, text) {
	await page.locator(PAPER).evaluate(
		(el, [start, text]) => {
			const { editor } = el;
			let found = null;
			editor.state.doc.forEach((node, offset) => {
				if (!found && node.type.name === "paragraph" && node.textContent.startsWith(start))
					found = { from: offset, to: offset + node.nodeSize };
			});
			if (!found) throw new Error(`no paragraph starts with ${start}`);
			editor
				.chain()
				.insertContentAt(found, { type: "paragraph", content: [{ type: "text", text }] })
				.run();
		},
		[start, text],
	);
	await status(page).getByText("Unsaved changes").waitFor();
}
/** Adds a paragraph at the end of the body, before the page footer. */
async function append(page, text) {
	await page.locator(PAPER).evaluate((el, text) => {
		const { editor } = el;
		let at = editor.state.doc.content.size;
		editor.state.doc.forEach((node, offset) => {
			if (node.type.name === "pageFooter" && offset < at) at = offset;
		});
		editor
			.chain()
			.insertContentAt(at, { type: "paragraph", content: [{ type: "text", text }] })
			.run();
	}, text);
}

test("AC:DOC-TEMPLATE-CHANGES: Template changes lists only the template's changes; All differences accepts one (Chromium)", async () => {
	await withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").owner.cookie);
		// The church's template, saved from a fresh policy, and a document made from it.
		const sourcePath = await fromPicker(page, "Conflict of Interest Policy");
		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		const dialog = page.getByRole("dialog", { name: "Save as template" });
		await dialog.getByRole("textbox", { name: "Template name" }).fill(NAME);
		await button(dialog, "Save as template").click();
		await page.getByText(`Saved “${NAME}” as your church's template.`, { exact: false }).waitFor({ timeout: 30_000 });
		const docPath = await fromPicker(page, NAME);

		// The church edits two paragraphs; Compare saves them first. Nothing in the template changed yet.
		await reword(page, PURPOSE, OURS);
		await reword(page, INTEREST, OWN);
		await button(page, "Compare with template").click();
		await compareView(page).getByText("Your document has every template change", { exact: true }).waitFor();
		assert.equal(await button(compareView(page), "Accept all").count(), 0, "no Accept controls");
		await shots(context, page, "t8-has-every-change", (p) => openCompare(p, docPath));
		await openDocument(page, docPath);
		assert.equal(await notice(page).count(), 0, "no Template updated notice");
		await shots(context, page, "t8-notice-not-shown", (p) => openDocument(p, docPath));

		// The church updates its template to v2: its own wording of Purpose and a new closing paragraph.
		await openDocument(page, sourcePath);
		await reword(page, PURPOSE, THEIRS);
		await append(page, CLOSING);
		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		const update = page.getByRole("dialog", { name: "Save as template" });
		await update.getByRole("radio", { name: "Update a template" }).click();
		await button(update, "Save changes").click();
		await status(page).getByText("Saved").waitFor({ timeout: 30_000 });
		await update.getByRole("radio", { name: new RegExp(`^${NAME}`) }).click();
		await button(update, "Update to v2").click();
		await page.getByText(`Updated “${NAME}” to v2.`, { exact: false }).waitFor({ timeout: 30_000 });

		// The notice shows: a template change is missing from the document.
		await openDocument(page, docPath);
		await notice(page).waitFor();
		await shots(context, page, "t8-notice-shown", (p) => openDocument(p, docPath));

		// Template changes, first: the paragraph both changed and the new one; the church's own edit is not listed.
		await openCompare(page, docPath);
		const changes = list(page, "Template changes");
		assert.equal(await changes.count(), 2);
		const both = changes.nth(0);
		await both.getByText("Changed in template and in your document", { exact: true }).waitFor();
		await both.getByText("Your document", { exact: true }).waitFor();
		await both.getByText("Template, new version", { exact: true }).waitFor();
		await both.getByText(OURS).waitFor();
		await both.getByText(THEIRS).waitFor();
		await changes.nth(1).getByText("In template only", { exact: true }).waitFor();
		await changes.nth(1).getByText(CLOSING).waitFor();
		assert.equal(await compareView(page).getByText(OWN).count(), 0, "the church's own edit is not listed");
		await shots(
			context,
			page,
			"t14-template-changes",
			(p) => openCompare(p, docPath),
			(p) => list(p, "Template changes").first(),
		);

		// All differences: T-19's full list, with the church's own edit.
		await viewSwitch(page, "All differences").click();
		const all = list(page, "All differences");
		assert.equal(await all.count(), 3);
		const own = all.filter({ hasText: OWN });
		await own.getByText("Changed", { exact: true }).waitFor();
		// Its template side is the template's paragraph, drawn afresh after the switch, not the other list's item.
		await own.getByText(INTEREST).waitFor();
		assert.equal(await own.getByText(CLOSING).count(), 0);
		await shots(context, page, "t14-all-differences", (p) => openCompare(p, docPath, "All differences"));

		// Accepting the template's version of that paragraph from All differences writes one revision.
		await own.getByRole("checkbox", { name: "Use the template's version" }).click();
		await button(compareView(page), "Accept 1 change").click();
		await page.getByText("Accepted 1 change from the template.").waitFor({ timeout: 30_000 });
		const text = await page.locator(PAPER).innerText();
		assert.ok(text.includes(INTEREST), "the template's paragraph is back");
		assert.ok(!text.includes(OWN));
		assert.ok(text.includes(OURS), "the declined change keeps the church's version");

		// The document now records v2: no notice, Template changes is empty, the declined ones are in All differences.
		await openDocument(page, docPath);
		await page.getByText(`from ${NAME} v2`).first().waitFor();
		assert.equal(await notice(page).count(), 0);
		await openCompare(page, docPath);
		await compareView(page).getByText("Your document has every template change", { exact: true }).waitFor();
		await viewSwitch(page, "All differences").click();
		assert.equal(await list(page, "All differences").count(), 2);
	});
});
