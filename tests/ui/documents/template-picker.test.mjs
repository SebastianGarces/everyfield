// WP-036: "New from template" with 60 templates (the /design/documents/templates fixture, no database). Search matches
// name, description and category; pages of ten keep the list short; the first card's ring is not clipped.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/template-picker.test.mjs
//   AC:DOC-PICKER-BROWSE  search and paging over 60 templates; the first card's top edge shows; the dialog keeps its
//   place and height for many, one and no results
// T-87 Rename a church template or change its description, in Chromium against a seeded preview (tests/ui/people/seed.mts).
// SHOT_DIR (outside the repository) collects screenshots at 390 and 1440 px in light and dark mode.
//   AC:DOC-TEMPLATE-EDIT          criteria 1-3, 5 and 6: the filled dialog, Cancel and Escape send nothing, an empty name
//                                 holds Save, both fields, the description alone and a cleared one; the library lines
//   AC:DOC-TEMPLATE-EDIT-MEMBER   criterion 10: a Member sees no edit control
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function openPicker(page) {
	await page.goto(`${BASE}/design/documents/templates`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	return page.getByRole("dialog", { name: "New from template" });
}
const box = (dialog) =>
	dialog.evaluate(async (el) => {
		await Promise.all(el.getAnimations().map((a) => a.finished));
		const { top, height } = el.getBoundingClientRect();
		return { top: Math.round(top), height: Math.round(height) };
	});
const titles = (dialog) =>
	dialog
		.getByRole("list", { name: "Everyfield templates" })
		.getByRole("button")
		.evaluateAll((buttons) => buttons.map((b) => b.querySelector("span > span")?.textContent));

for (const [name, engine] of ENGINES) {
	test(`AC:DOC-PICKER-BROWSE (${name}): search and pages over 60 templates`, async () => {
		await withPage(engine, async (page) => {
			const dialog = await openPicker(page);
			assert.equal((await titles(dialog)).length, 10, "page 1 holds ten");
			await dialog.getByText("Showing 1–10 of 60").waitFor({ timeout: 5_000 });
			const full = await box(dialog);
			// The first card's top edge sits inside the scroll area, so its ring is not clipped.
			const edges = await dialog.evaluate((el) => {
				const body = el
					.querySelector("ul[aria-label='Everyfield templates']")
					.parentElement.parentElement.getBoundingClientRect();
				const card = el.querySelector("ul[aria-label='Everyfield templates'] button").getBoundingClientRect();
				return { body: body.top, card: card.top };
			});
			assert.ok(
				edges.card - edges.body >= 4,
				`the first card starts 4 px or more inside the scroll area: ${JSON.stringify(edges)}`,
			);

			await dialog.getByRole("button", { name: "Next page" }).click();
			await dialog.getByText("Showing 11–20 of 60").waitFor({ timeout: 5_000 });
			assert.equal((await titles(dialog))[0], "Launch Team Covenant", "page 2 starts at the 11th");

			const search = dialog.getByRole("searchbox", { name: "Search templates" });
			await search.fill("policy");
			const policies = ["Conflict of Interest Policy", "Child Safety Policy"];
			assert.deepEqual((await titles(dialog)).slice(0, 2), policies);
			assert.equal(
				await dialog.getByRole("navigation", { name: "Template pages" }).count(),
				0,
				"ten results fit one page: no pager",
			);
			await search.fill("cut on the marks");
			const cards = [1, 2, 3, 4, 5].map((n) => `Core Group Commitment Card${n > 1 ? ` ${n}` : ""}`);
			assert.deepEqual(await titles(dialog), cards);
			await search.fill("formal bylaws");
			assert.equal((await titles(dialog)).length, 5, "category and name words both match");
			await search.fill("budget worksheet 2");
			assert.deepEqual(await titles(dialog), ["Budget Worksheet 2"]);
			// Owner item 5: the top edge stays put and the height holds while the results shrink to one and to none.
			assert.deepEqual(await box(dialog), full, "one result: same top and height as the full list");
			await search.fill("zzz");
			await dialog.getByText("No template matches “zzz”.").waitFor({ timeout: 5_000 });
			assert.deepEqual(await box(dialog), full, "no result: same top and height as the full list");
			await search.fill("");
			await dialog.getByText("Showing 1–10 of 60").waitFor({ timeout: 5_000 });
		});
	});
}

// T-87: one church template, renamed and described again from its card. Chromium, on the People seed.
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const SHOTS = process.env.SHOT_DIR;
const run = randomUUID().slice(0, 8);
const NAME = `Volunteer policy ${run}`;
const DESCRIPTION = `The first description, run ${run}.`;
const RENAMED = `Volunteer and staff policy ${run}`;
const DESCRIBED = `For everyone who serves, run ${run}.`;
const ONLY = `Read by every new volunteer, run ${run}.`;
const exact = (scope, name) => scope.getByRole("button", { name, exact: true });
const as = (who, act) =>
	withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people")[who].cookie);
		await act(page, context);
	});

/** Opens New from template on the library and narrows it to this run's template. */
async function churchPicker(page) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await exact(page, "New from template").click();
	const dialog = page.getByRole("dialog", { name: "New from template" });
	await dialog.getByRole("searchbox", { name: "Search templates" }).fill(run);
	return dialog;
}
const cardOf = (picker, title) =>
	picker.getByRole("list", { name: "Your church's templates" }).getByRole("listitem").filter({ hasText: title });
async function openEdit(page, title) {
	const picker = await churchPicker(page);
	await exact(cardOf(picker, title), `Edit template ${title}`).click();
	const dialog = page.getByRole("dialog", { name: "Edit template" });
	await dialog.waitFor();
	return { picker, dialog };
}
/** The card's own text, without its buttons' names. */
const cardText = (card) => card.getByRole("button").first().innerText();

async function shots(context, page, name, open) {
	if (!SHOTS) return;
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

test("AC:DOC-TEMPLATE-EDIT: rename a church template and change its description from its card (Chromium)", async () => {
	await as("owner", async (page, context) => {
		// The church saves a policy as its template, and makes one document from it before the edit.
		const first = await churchPicker(page);
		await first.getByRole("searchbox", { name: "Search templates" }).fill("Conflict of Interest Policy");
		await first.getByRole("button", { name: /^Conflict of Interest Policy/ }).click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		await page.locator(".ef-paper .ProseMirror").waitFor({ timeout: 90_000 });
		await exact(page, "More actions").click();
		await page.getByRole("menuitem", { name: "Save as template" }).click();
		const save = page.getByRole("dialog", { name: "Save as template" });
		await save.getByRole("textbox", { name: "Template name" }).fill(NAME);
		await save.getByRole("textbox", { name: "Description" }).fill(DESCRIPTION);
		await exact(save, "Save as template").click();
		await save.waitFor({ state: "hidden", timeout: 30_000 });
		const before = await churchPicker(page);
		await cardOf(before, NAME)
			.getByRole("button", { name: new RegExp(`^${NAME}`) })
			.click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		const earlierPath = new URL(page.url()).pathname;

		// The card has its edit button beside Delete.
		let picker = await churchPicker(page);
		let card = cardOf(picker, NAME);
		await exact(card, `Delete template ${NAME}`).waitFor();
		await shots(context, page, "t87-card-edit-button", churchPicker);

		// The dialog opens with the current name and description.
		let { dialog } = await openEdit(page, NAME);
		const name = dialog.getByRole("textbox", { name: "Template name" });
		const description = dialog.getByRole("textbox", { name: "Description" });
		assert.equal(await name.inputValue(), NAME);
		assert.equal(await description.inputValue(), DESCRIPTION);
		await shots(context, page, "t87-edit-dialog", (p) => openEdit(p, NAME));

		// Cancel and Escape send no request and leave the card as it was.
		picker = await churchPicker(page);
		card = cardOf(picker, NAME);
		const shown = await cardText(card);
		await exact(card, `Edit template ${NAME}`).click();
		dialog = page.getByRole("dialog", { name: "Edit template" });
		const posts = [];
		const count = (request) => request.method() === "POST" && posts.push(request.url());
		page.on("request", count);
		await dialog.getByRole("textbox", { name: "Template name" }).fill("Not this name");
		await dialog.getByRole("textbox", { name: "Description" }).fill("Not this description");
		await exact(dialog, "Cancel").click();
		await dialog.waitFor({ state: "hidden" });
		assert.equal(await cardText(card), shown);
		await exact(card, `Edit template ${NAME}`).click();
		dialog = page.getByRole("dialog", { name: "Edit template" });
		assert.equal(await dialog.getByRole("textbox", { name: "Template name" }).inputValue(), NAME, "reopened afresh");
		await dialog.getByRole("textbox", { name: "Template name" }).fill("Not this either");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		assert.ok(await picker.isVisible(), "Escape closes the edit dialog only");
		assert.equal(await cardText(card), shown);
		page.off("request", count);
		assert.deepEqual(posts, [], "Cancel and Escape send nothing");

		// An empty name says a name is needed and holds Save.
		await exact(card, `Edit template ${NAME}`).click();
		dialog = page.getByRole("dialog", { name: "Edit template" });
		await dialog.getByRole("textbox", { name: "Template name" }).fill("   ");
		await dialog.getByText("Give the template a name.").waitFor();
		assert.ok(await exact(dialog, "Save").isDisabled());
		await shots(context, page, "t87-empty-name", async (p) => {
			const { dialog: d } = await openEdit(p, NAME);
			await d.getByRole("textbox", { name: "Template name" }).fill("");
			await d.getByText("Give the template a name.").waitFor();
		});

		// Both fields change; a double click saves once. The card shows them at once, at the same version.
		({ picker, dialog } = await openEdit(page, NAME));
		await dialog.getByRole("textbox", { name: "Template name" }).fill(RENAMED);
		await dialog.getByRole("textbox", { name: "Description" }).fill(DESCRIBED);
		await exact(dialog, "Save").dblclick();
		await dialog.waitFor({ state: "hidden", timeout: 30_000 });
		await picker.getByRole("status").getByText(`Saved “${RENAMED}”.`, { exact: false }).waitFor();
		card = cardOf(picker, RENAMED);
		await card.getByText(DESCRIBED).waitFor();
		await card.getByText("v1 · Letter · PDF and Word", { exact: true }).waitFor();
		assert.equal(await cardOf(picker, NAME).count(), 0, "the old name is gone");
		await shots(context, page, "t87-card-saved", async (p) => {
			const { picker: pk, dialog: d } = await openEdit(p, RENAMED);
			await exact(d, "Save").click();
			await d.waitFor({ state: "hidden", timeout: 30_000 });
			await pk.getByRole("status").getByText(`Saved “${RENAMED}”.`, { exact: false }).waitFor();
		});

		// The description alone, then cleared: the name stays.
		({ picker, dialog } = await openEdit(page, RENAMED));
		await dialog.getByRole("textbox", { name: "Description" }).fill(ONLY);
		await exact(dialog, "Save").click();
		await dialog.waitFor({ state: "hidden", timeout: 30_000 });
		card = cardOf(picker, RENAMED);
		await card.getByText(ONLY).waitFor();
		({ picker, dialog } = await openEdit(page, RENAMED));
		await dialog.getByRole("textbox", { name: "Description" }).fill("");
		await exact(dialog, "Save").click();
		await dialog.waitFor({ state: "hidden", timeout: 30_000 });
		card = cardOf(picker, RENAMED);
		await card.getByText("v1 · Letter · PDF and Word", { exact: true }).waitFor();
		assert.ok(!(await cardText(card)).includes(ONLY), "no description");

		// After a reload the picker reads the same from the server.
		picker = await churchPicker(page);
		card = cardOf(picker, RENAMED);
		await card.getByText("v1 · Letter · PDF and Word", { exact: true }).waitFor();
		assert.ok(!(await cardText(card)).includes(ONLY));

		// A document made now takes the new name; the earlier one keeps its title and names the template's new name.
		await card.getByRole("button", { name: new RegExp(`^${RENAMED}`) }).click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		const laterPath = new URL(page.url()).pathname;
		await page.getByText(`from ${RENAMED} v1`).first().waitFor({ timeout: 90_000 });
		await page.goto(`${BASE}${earlierPath}`);
		await page.getByText(`from ${RENAMED} v1`).first().waitFor({ timeout: 90_000 });
		const library = async (p) => {
			await p.goto(`${BASE}/documents/church`);
			await hydrated(p);
			await p
				.getByRole("link")
				.filter({ hasText: `from ${RENAMED} v1` })
				.first()
				.waitFor();
		};
		await library(page);
		const later = page.locator(`a[href="${laterPath}"]`);
		const earlier = page.locator(`a[href="${earlierPath}"]`);
		assert.match(await later.innerText(), new RegExp(`^${RENAMED}\\s+from ${RENAMED} v1`));
		assert.match(await earlier.innerText(), new RegExp(`^${NAME}\\s+from ${RENAMED} v1`));
		await shots(context, page, "t87-library-lines", library);
	});
});

test("AC:DOC-TEMPLATE-EDIT-MEMBER: a Member sees no edit control (Chromium)", async () => {
	await as("member", async (page) => {
		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		await page.getByRole("heading", { name: "Church documents" }).waitFor();
		assert.equal(await exact(page, "New from template").count(), 0);
		assert.equal(await page.getByRole("button", { name: /^Edit template/ }).count(), 0);
	});
});
