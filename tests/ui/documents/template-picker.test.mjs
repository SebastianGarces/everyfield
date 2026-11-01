// WP-036: "New from template" with 60 templates (the /design/documents/templates fixture, no database). Search matches
// name, description and category; pages of ten keep the list short; the first card's ring is not clipped.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/template-picker.test.mjs
//   AC:DOC-PICKER-BROWSE  search and paging over 60 templates; the first card's top edge shows
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, hydrated, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function openPicker(page) {
	await page.goto(`${BASE}/design/documents/templates`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	return page.getByRole("dialog", { name: "New from template" });
}
const titles = (dialog) =>
	dialog
		.getByRole("list", { name: "Templates" })
		.getByRole("button")
		.evaluateAll((buttons) => buttons.map((b) => b.querySelector("span > span")?.textContent));

/** The titles once they equal `want`, or the last titles after 5 s: the list renders the search a frame later. */
async function settled(dialog, want, pick = (t) => t) {
	let last;
	for (let i = 0; i < 50; i++) {
		last = pick(await titles(dialog));
		if (JSON.stringify(last) === JSON.stringify(want)) break;
		await dialog.page().waitForTimeout(100);
	}
	return last;
}

for (const [name, engine] of ENGINES) {
	test(`AC:DOC-PICKER-BROWSE (${name}): search and pages over 60 templates`, async () => {
		await withPage(engine, async (page) => {
			const dialog = await openPicker(page);
			assert.equal((await titles(dialog)).length, 10, "page 1 holds ten");
			await dialog.getByText("Showing 1–10 of 60").waitFor({ timeout: 5_000 });
			// The first card's top edge sits inside the scroll area, so its ring is not clipped.
			const edges = await dialog.evaluate((el) => {
				const body = el.querySelector("ul[aria-label=Templates]").parentElement.getBoundingClientRect();
				const card = el.querySelector("ul[aria-label=Templates] button").getBoundingClientRect();
				return { body: body.top, card: card.top };
			});
			assert.ok(
				edges.card - edges.body >= 4,
				`the first card starts 4 px or more inside the scroll area: ${JSON.stringify(edges)}`,
			);

			await dialog.getByRole("button", { name: "Next page" }).click();
			await dialog.getByText("Showing 11–20 of 60").waitFor({ timeout: 5_000 });
			assert.equal(
				await settled(dialog, "Launch Team Covenant", (t) => t[0]),
				"Launch Team Covenant",
				"page 2 starts at the 11th",
			);

			const search = dialog.getByRole("searchbox", { name: "Search templates" });
			await search.fill("policy");
			const policies = ["Conflict of Interest Policy", "Child Safety Policy"];
			assert.deepEqual(await settled(dialog, policies, (t) => t.slice(0, 2)), policies);
			assert.equal(
				await dialog.getByRole("navigation", { name: "Template pages" }).count(),
				0,
				"ten results fit one page: no pager",
			);
			await search.fill("cut on the marks");
			const cards = [1, 2, 3, 4, 5].map((n) => `Core Group Commitment Card${n > 1 ? ` ${n}` : ""}`);
			assert.deepEqual(await settled(dialog, cards), cards);
			await search.fill("formal bylaws");
			assert.equal(await settled(dialog, 5, (t) => t.length), 5, "category and name words both match");
			await search.fill("zzz");
			await dialog.getByText("No template matches “zzz”.").waitFor({ timeout: 5_000 });
			await dialog.getByRole("button", { name: "Clear search" }).click();
			assert.equal(await search.inputValue(), "");
			assert.ok(await search.evaluate((el) => el === document.activeElement), "Clear search returns focus to the box");
			await dialog.getByText("Showing 1–10 of 60").waitFor({ timeout: 5_000 });
		});
	});
}
