// T-80 Compare with the church's own template, in Chromium against a real preview. An Owner saves a policy as the
// church's template and makes a document from it: the document matches, so there is no notice, but Compare is offered
// and says there are no differences. The template is updated to v2 (T-79): the document shows "Template updated",
// names the church's template, and Accept all takes the change as one revision. A Member sees neither.
//   UI_BASE_URL=https://t80-....localhost:1355 node --test tests/ui/documents/church-template-compare.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). SHOT_DIR (outside the repository) collects screenshots at
// 390 and 1440 px in light and dark mode.
//   AC:DOC-COMPARE-CHURCH         criteria 1, 2, 3, 5 (no notice when current, the church's template named, accept all)
//   AC:DOC-COMPARE-CHURCH-MEMBER  criterion 10 (a Member sees no notice and no Compare action)
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
const MARK = `Adopted by the board at the spring meeting, run ${run}.`;
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
const notice = (page) => page.getByRole("region", { name: "Template updated" });
const compareView = (page) => page.getByRole("region", { name: "Compare with template" });
const status = (page) =>
	page
		.getByRole("status")
		.filter({ hasText: /Saved|Unsaved|Saving/ })
		.first();

async function shots(context, page, name, open) {
	if (!SHOTS) return;
	for (const theme of ["light", "dark"]) {
		await context.addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
		for (const width of [390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await open(page);
			await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
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
async function openDocument(page, path) {
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
}
async function openCompare(page, path) {
	await openDocument(page, path);
	await button(page, "Compare with template").first().click();
	await compareView(page).waitFor();
	await compareView(page).getByText("Your church’s template", { exact: true }).waitFor({ timeout: 30_000 });
}
async function fromPicker(page, search) {
	const picker = await openPicker(page);
	await picker.getByRole("searchbox", { name: "Search templates" }).fill(search);
	await picker
		.getByRole("button", { name: new RegExp(`^${search}`) })
		.first()
		.click();
	await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
	return new URL(page.url()).pathname;
}

test("AC:DOC-COMPARE-CHURCH: a document from the church's template compares with it and accepts its update (Chromium)", async () => {
	await as("owner", async (page, context) => {
		// The church's template, saved from a fresh policy, and a document made from it.
		state.sourcePath = await fromPicker(page, "Conflict of Interest Policy");
		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		const dialog = page.getByRole("dialog", { name: "Save as template" });
		await dialog.getByRole("textbox", { name: "Template name" }).fill(NAME);
		await button(dialog, "Save as template").click();
		await page.getByText(`Saved “${NAME}” as your church's template.`, { exact: false }).waitFor({ timeout: 30_000 });
		state.docPath = await fromPicker(page, NAME);

		// It matches its template: no notice, but Compare is in the editor's actions and lists nothing.
		await page.getByText(`from ${NAME} v1`).waitFor();
		assert.equal(await notice(page).count(), 0, "no Template updated notice");
		await button(page, "Compare with template").waitFor();
		await shots(context, page, "c1-current", (p) => openDocument(p, state.docPath));
		await openCompare(page, state.docPath);
		const view = compareView(page);
		await view.getByText(`your church’s own template “${NAME}”, version 1`, { exact: false }).waitFor();
		await view.getByText("Your document has every template change", { exact: true }).waitFor();
		assert.equal(await button(view, "Accept all").count(), 0, "no Accept controls");
		await shots(context, page, "c3-no-differences", (p) => openCompare(p, state.docPath));

		// The church updates its template to v2 from the source document, with one new paragraph.
		await openDocument(page, state.sourcePath);
		// The new paragraph goes at the end of the body, before the page footer.
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
		}, MARK);
		await status(page).getByText("Unsaved changes").waitFor();
		await button(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		const update = page.getByRole("dialog", { name: "Save as template" });
		await update.getByRole("radio", { name: "Update a template" }).click();
		await button(update, "Save changes").click();
		await status(page).getByText("Saved").waitFor({ timeout: 30_000 });
		await update.getByRole("radio", { name: new RegExp(`^${NAME}`) }).click();
		await button(update, "Update to v2").click();
		await page.getByText(`Updated “${NAME}” to v2.`, { exact: false }).waitFor({ timeout: 30_000 });

		// The document is behind: the notice names the church's template.
		await openDocument(page, state.docPath);
		await notice(page)
			.getByText(`Your church’s template “${NAME}” has changed since this document was made from it.`, {
				exact: false,
			})
			.waitFor();
		await shots(context, page, "c1-behind", (p) => openDocument(p, state.docPath));

		// Compare lists the new paragraph as in the template only, beside the church template's name.
		await openCompare(page, state.docPath);
		await view.getByText(`your church’s own template “${NAME}”, version 2`, { exact: false }).waitFor();
		const items = view.getByRole("list", { name: "Template changes" }).getByRole("listitem");
		assert.equal(await items.count(), 1);
		await items.first().getByText("In template only", { exact: true }).waitFor();
		await items.first().getByText(MARK).waitFor();
		await shots(context, page, "c2-differences", (p) => openCompare(p, state.docPath));

		// Accept all saves one revision and the notice is gone, also after a reload.
		await button(view, "Accept all").click();
		await page.getByText("Accepted 1 change from the template.").waitFor({ timeout: 30_000 });
		assert.match(await page.locator(PAPER).innerText(), new RegExp(MARK.replace(/[.]/g, "\\.")));
		assert.equal(await notice(page).count(), 0);
		await openDocument(page, state.docPath);
		await page.getByText(`from ${NAME} v2`).first().waitFor();
		assert.equal(await notice(page).count(), 0, "the document now follows v2");
		await shots(context, page, "c5-accepted", (p) => openDocument(p, state.docPath));
	});
});

test("AC:DOC-COMPARE-CHURCH-MEMBER: a Member sees no notice and no Compare action (Chromium)", async () => {
	assert.ok(state.docPath, "AC:DOC-COMPARE-CHURCH made the document");
	await as("member", async (page, context) => {
		const open = async (p) => {
			await p.goto(`${BASE}${state.docPath}`);
			await hydrated(p);
			await p.getByRole("region", { name: "Preview" }).waitFor({ timeout: 90_000 });
		};
		await open(page);
		assert.equal(await notice(page).count(), 0);
		assert.equal(await button(page, "Compare with template").count(), 0);
		await shots(context, page, "c10-member", open);
	});
});
