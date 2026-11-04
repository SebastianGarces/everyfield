// WP-036 slice 4: budget tables in the Church Document editor, in a real browser against a preview. A budget is a `table`
// with style "ledger": categories, line items, category totals and a grand total. Seed People, then Settings, as
// tables.test.mjs says.
//   AC:WP-036-8  line items, categories and signs      AC:WP-036-9  totals update as amounts change
//   AC:WP-036-12 the Excel download follows the budget
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINES } from "../setup.mjs";
import { docxParts, pdfPages, wordText } from "../../integration/documents/fixtures/readers.mts";
import { MOD, onFork, PAPER } from "./tables-support.mjs";

const roles = (table) => (table.content ?? []).map((r) => r.attrs?.role ?? "item");
const textOf = (cell) => (cell?.content ?? []).map((n) => n.text ?? "").join("");
const labels = (table) => (table.content ?? []).map((r) => textOf(r.content[0]));

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-8 (${name}): Insert offers Budget table in the body only; a plain table offers no budget control`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			// The sign-in sheet's plain table offers none of the budget controls.
			await page.locator(".ef-head-cell").first().focus();
			for (const label of ["Add line item", "Remove line item", "Add category", "Remove category"])
				assert.equal(await t.button(label).count(), 0, `${label} is not on a plain table`);
			assert.equal(await page.getByRole("radiogroup", { name: "Category sign" }).count(), 0);
			// The page footer's Insert menu offers a Table but no Budget table.
			await page.locator(PAPER).evaluate((el) => {
				const ed = el.editor;
				const footer = ed.state.doc.lastChild;
				const start = ed.state.doc.content.size - footer.nodeSize;
				let at = null;
				footer.descendants((n, o) => {
					if (at === null && n.isTextblock) at = start + 1 + o + 1;
					return at === null;
				});
				ed.chain().focus().setTextSelection(at).run();
			});
			await t.button("Insert block").click();
			assert.equal(await page.getByRole("menuitem", { name: "Table", exact: true }).count(), 1);
			assert.equal(await page.getByRole("menuitem", { name: "Budget table", exact: true }).count(), 0);
			await page.keyboard.press("Escape");
			// In the body, Insert offers it.
			await page.locator(PAPER).evaluate((el) => el.editor.chain().focus().setTextSelection(1).run());
			await t.button("Insert block").click();
			assert.equal(await page.getByRole("menuitem", { name: "Budget table", exact: true }).count(), 1);
			await page.keyboard.press("Escape");
		});
	});

	test(`AC:WP-036-8 (${name}): Add line item, Remove line item, Add category, Remove category and the sign follow the rulings`, async () => {
		await onFork(
			engine,
			"guest-sign-in-sheet",
			async (page, context, t) => {
				const doc = await t.checked("Insert Budget table", () => t.insert("Budget table"));
				const budget = doc.body.content.find((n) => n.type === "table");
				assert.equal(budget.attrs.style, "ledger");
				assert.deepEqual(
					budget.attrs.columns.map((c) => c.type),
					["text", "money"],
				);
				assert.deepEqual(roles(budget), ["group", "item", "subtotal", "total"]);
				assert.deepEqual(labels(budget), ["Category", "Line item", "Category total", "Total"]);
				assert.equal(JSON.stringify(budget).includes('"value"'), false, "no row holds a typed amount yet");

				// Every label edits in place.
				await t.checked("Edit a label in place", async () => {
					await t.cell(0, 0, 0, true);
					await page.keyboard.type("Housing");
				});
				assert.equal(labels(await t.table())[0], "Housing");

				// A line item goes after the current item and before its category total.
				await t.cell(1, 0);
				await t.checked("Add line item after an item", () => t.button("Add line item").click());
				assert.deepEqual(roles(await t.table()), ["group", "item", "item", "subtotal", "total"]);
				await t.cell(0, 0);
				await t.checked("Add line item from the category row", () => t.button("Add line item").click());
				assert.deepEqual(roles(await t.table()), ["group", "item", "item", "item", "subtotal", "total"]);
				await t.cell(4, 0);
				await t.checked("Add line item from the category total", () => t.button("Add line item").click());
				assert.deepEqual(roles(await t.table()), ["group", "item", "item", "item", "item", "subtotal", "total"]);
				await t.cell(1, 0);
				await t.checked("Remove line item", () => t.button("Remove line item").click());
				assert.deepEqual(roles(await t.table()), ["group", "item", "item", "item", "subtotal", "total"]);
				await t.cell(4, 0);
				assert.equal(await t.button("Remove line item").isDisabled(), true, "the category total is no line item");

				// A budget's only category cannot be removed.
				await t.cell(1, 0);
				assert.equal(await t.button("Remove category").isDisabled(), true);
				assert.match(await t.reasons().innerText(), /only category cannot be removed/);

				// A new category has one line item and a total, after the current category and before the grand total.
				await t.checked("Add category", () => t.button("Add category").click());
				const two = await t.table();
				assert.deepEqual(roles(two), [
					...["group", "item", "item", "item", "subtotal"],
					...["group", "item", "subtotal"],
					"total",
				]);
				assert.deepEqual(labels(two).slice(5, 8), ["Category", "Line item", "Category total"]);

				// The category sign is its own control: a budget with expenses needs it.
				await t.cell(5, 0);
				const sign = page.getByRole("radiogroup", { name: "Category sign" });
				await t.checked("Category subtracts", () =>
					sign.getByRole("radio", { name: "This category subtracts from the total" }).click(),
				);
				assert.equal((await t.table()).content[5].attrs.sign, "subtract");
				await t.checked("Category adds", () =>
					sign.getByRole("radio", { name: "This category adds to the total" }).click(),
				);
				assert.notEqual((await t.table()).content[5].attrs?.sign, "subtract");

				await t.cell(6, 0);
				await t.checked("Remove category", () => t.button("Remove category").click());
				assert.deepEqual(roles(await t.table()), ["group", "item", "item", "item", "subtotal", "total"]);
			},
			{ blank: true },
		);
	});

	test(`AC:WP-036-8 (${name}): on a forked budget a line item lands before its category total and a category before the grand total`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const before = await t.table();
			const at = (r, label) => r.findIndex((row) => textOf(row.content[0]) === label);
			await t.cell(at(before.content, "Other income"), 0);
			await t.checked("Add a line item to Income", () => t.button("Add line item").click());
			const next = await t.table();
			assert.equal(textOf(next.content[at(next.content, "Total income") - 1].content[0]), "Line item");
			assert.equal(at(next.content, "Other income") + 1, at(next.content, "Total income") - 1);
			await t.cell(at(next.content, "Total expenses") - 1, 0);
			await t.checked("Add a category", () => t.button("Add category").click());
			const grown = await t.table();
			assert.deepEqual(roles(grown).slice(-5), ["subtotal", "group", "item", "subtotal", "total"]);
		});
	});

	test(`AC:WP-036-9 (${name}): totals update on each keystroke with no request, hold no typed total, and equal what the PDF prints`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const requests = [];
			page.on("request", (r) => {
				// The navigation bar's link prefetches run on their own schedule, whatever the person types.
				if (r.headers()["next-router-prefetch"]) return;
				if (["fetch", "xhr", "document"].includes(r.resourceType())) requests.push(`${r.method()} ${r.url()}`);
			});
			await t.checked("Type Tithes 3000", () => t.typeAmount("Tithes and offerings", "3000"));
			await t.typeAmount("Sending church support", "1200");
			await t.typeAmount("Pastor and staff pay", "1500");
			assert.deepEqual(await t.computed("Total income"), ["$4,200", "$50,400"]);
			assert.equal((await t.computed("Net (income"))[0], "$2,700");
			// 3000 to 3500: every computed cell follows.
			await t.checked("Change 3000 to 3500", () => t.typeAmount("Tithes and offerings", "3500"));
			assert.equal((await t.computed("Total income"))[0], "$4,700");
			assert.equal((await t.computed("Net (income"))[0], "$3,200");
			// A key at a time: the total follows each key, with no request to the server.
			const field = t.amount("Grants");
			await field.click();
			const seen = [];
			for (const key of "2500") {
				await page.keyboard.type(key);
				seen.push((await t.computed("Total income"))[0]);
			}
			assert.deepEqual(seen, ["$4,702", "$4,725", "$4,950", "$7,200"]);
			assert.deepEqual(requests, [], "typing amounts sends no request");
			await field.blur();
			// The stored JSON holds only typed amounts.
			const table = await t.table();
			for (const row of table.content) {
				const role = row.attrs?.role ?? "item";
				if (role !== "item")
					assert.ok(
						row.content.every((c) => c.attrs?.value === undefined),
						`a ${role} row holds no typed amount`,
					);
			}
			// Accepted forms and the refusal of the rest. A blank amount stores null.
			for (const [typed, stored] of [
				["$3,000", 3000],
				["3000.50", 3000.5],
				["-20", -20],
				["10.126", 10.13],
				["", null],
			]) {
				await t.typeAmount("Other income", typed);
				const row = (await t.table()).content.find((r) => textOf(r.content[0]) === "Other income");
				assert.equal(row.content[1].attrs.value, stored, `"${typed}" stores ${stored}`);
			}
			await t.typeAmount("Other income", "100");
			await t.amount("Other income").click();
			for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
			await page.keyboard.type("x");
			assert.match(
				await page.locator(`${PAPER} .ef-vnote`).filter({ hasText: "not an amount" }).first().innerText(),
				/"100x" is not an amount/,
			);
			const row = (await t.table()).content.find((r) => textOf(r.content[0]) === "Other income");
			assert.equal(row.content[1].attrs.value, 100, "an input that is no amount is not stored");

			// 0.20 + 0.70 + 0.10 prints $1 in the editor, the PDF and the Word file.
			await t.typeAmount("Tithes and offerings", "0.20");
			await t.typeAmount("Sending church support", "0.70");
			await t.typeAmount("Network or denominational support", "0.10");
			for (const label of ["Grants", "Other income", "Pastor and staff pay"]) await t.typeAmount(label, "");
			assert.equal((await t.computed("Total income"))[0], "$1");
			await t.amount("Network or denominational support").blur();
			await t.save();
			const pdf = (await pdfPages((await t.file("pdf")).bytes)).join(" ");
			assert.match(pdf, /Total income \$1 \$12\b/, "the PDF prints $1");
			const word = wordText(docxParts((await t.file("docx")).bytes)["word/document.xml"]);
			assert.match(word, /Total income \$1 \$12\b/, "the Word file prints $1");
			assert.doesNotMatch(pdf + word, /\$0\.100/);
		});
	});

	test(`AC:WP-036-12 (${name}): the download list follows the budget on save, on Delete block, on Delete all content and on Undo`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const excel = page.getByRole("link", { name: "Download Excel" });
			assert.equal(await excel.count(), 1, "a forked budget offers Excel");
			const exportsOf = async () => (await t.snap()).exports;
			assert.deepEqual(await exportsOf(), ["xlsx", "pdf", "docx"], "the stored order stays while the budget stays");
			await t.cell(1, 0);
			await t.button("Delete block").click();
			await t.settle();
			assert.deepEqual(await exportsOf(), ["pdf", "docx"]);
			await t.save();
			await page.getByText(/^Saved/).waitFor();
			assert.equal(await excel.count(), 0, "Download Excel goes away after the save");
			await t.undo();
			await t.settle();
			assert.deepEqual(await exportsOf(), ["xlsx", "pdf", "docx"]);
			await t.save();
			assert.equal(await excel.count(), 1, "Undo brings the budget back and the next save offers Excel again");
			await page.reload();
			await page.locator(PAPER).waitFor();
			assert.equal(await excel.count(), 1, "the stored document still offers Excel");
			// Delete all content removes the last budget table: no refusal.
			await t.deleteAll();
			await t.save();
			assert.equal(await excel.count(), 0);
			assert.deepEqual(await exportsOf(), ["pdf", "docx"]);
			await t.undo();
			await t.save();
			assert.equal(await excel.count(), 1);
		});
		await onFork(
			engine,
			"guest-sign-in-sheet",
			async (page, context, t) => {
				const excel = page.getByRole("link", { name: "Download Excel" });
				assert.equal(await excel.count(), 0);
				await t.insert("Budget table");
				assert.deepEqual((await t.snap()).exports, ["pdf", "docx", "xlsx"]);
				await t.save();
				assert.equal(await excel.count(), 1, "the first budget table offers Download Excel after the save");
				await t.cell(1, 0);
				await t.button("Delete block").click();
				await t.save();
				assert.equal(await excel.count(), 0);
				assert.deepEqual((await t.snap()).exports, ["pdf", "docx"], "a document with no budget keeps its export order");
			},
			{ blank: true },
		);
	});
}
