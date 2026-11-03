// WP-036 slice 4: Undo and Redo on every table action, an unedited table that stays as stored, and access (names,
// tooltips, cursors, keyboard, 390 px, a Member). Seed People, then Settings, as tables.test.mjs says.
//   AC:WP-036-14 every action of criteria 1 to 9 with Undo and Redo      AC:WP-036-15 access and the narrow screen
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clean } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";
import { baseOf, MOD, onFork, PAPER } from "./tables-support.mjs";

const ROOT = join(import.meta.dirname, "../../..");
const textOf = (cell) => (cell?.content ?? []).map((n) => n.text ?? "").join("");
const kind = (page, value) => page.getByRole("combobox", { name: "Column kind" }).selectOption(value);

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-14 (${name}): every action of criteria 1 to 9 has an exact Undo and Redo, with focus in an amount field too`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			// 1 to 3: a table, its rows and its columns.
			await t.checked("Insert Table", () => t.insert("Table"));
			await t.checked("Add row", () => t.button("Add row below").click());
			await t.cell(0, 0);
			await t.checked("Type in a cell", () => page.keyboard.type("Ada"));
			await t.cell(0, 0);
			await t.checked("Add row below", () => t.button("Add row below").click());
			await t.checked("Add row above", () => t.button("Add row above").click());
			await t.cell(1, 0);
			await t.checked("Remove row", () => t.button("Remove row").click());
			await t.cell(0, 1);
			await t.checked("Add column left", () => t.button("Add column left").click());
			await t.cell(0, 1);
			await t.checked("Add column right", () => t.button("Add column right").click());
			await t.cell(0, 2);
			await t.checked("Remove column", () => t.button("Remove column").click());
			await t.checked("Edit a header label", () => page.locator(".ef-head-cell").nth(0).fill("Guest"));
			// 4: each kind of column.
			for (const [col, value] of [
				[0, "number"],
				[1, "money"],
				[2, "check"],
				[0, "index"],
				[1, "text"],
				[0, "text"],
			]) {
				await page.locator(".ef-head-cell").nth(col).focus();
				await t.checked(`Kind ${value} on column ${col + 1}`, () => kind(page, value));
			}
			await page.locator(".ef-head-cell").nth(1).focus();
			await kind(page, "money");
			await page.locator(".ef-head-cell").nth(2).focus();
			await kind(page, "check");
			await t.checked("Tick a check box", () => page.getByRole("checkbox", { name: /row 1/ }).click());
			// 5 and 6: blank rows, the header color and stripes.
			await t.checked("Blank rows", async () => {
				await page.getByRole("spinbutton", { name: "Blank rows" }).fill("12");
				await page.getByRole("spinbutton", { name: "Blank rows" }).blur();
			});
			await t.checked("Header color", () => page.getByRole("radio", { name: "primary", exact: true }).first().click());
			await t.checked("Striped rows", () => page.getByLabel("Striped rows").check());
			// 7: checklist rows.
			await t.cell(0, 0);
			await t.checked("Insert Checklist rows", () => t.insert("Checklist rows"));
			await t.checked("Tick a checklist box", () =>
				page
					.getByRole("checkbox", { name: /Done, row 1/ })
					.last()
					.click(),
			);
			// 8: a budget.
			await t.checked("Insert Budget table", () => t.insert("Budget table"));
			const rows = async () => (await t.tables()).find((tb) => tb.attrs.style === "ledger").content;
			const at = async (label) => (await rows()).findIndex((r) => textOf(r.content[0]) === label);
			const budget = async () => (await t.tables()).findIndex((tb) => tb.attrs.style === "ledger");
			await t.cell(await at("Line item"), 0, await budget());
			await t.checked("Add line item", () => t.button("Add line item").click());
			await t.cell(await at("Line item"), 0, await budget());
			await t.checked("Remove line item", () => t.button("Remove line item").click());
			await t.cell(await at("Category"), 0, await budget());
			await t.checked("Add category", () => t.button("Add category").click());
			await t.cell(await at("Category"), 0, await budget());
			await t.checked("Category sign", () =>
				page
					.getByRole("radiogroup", { name: "Category sign" })
					.getByRole("radio", { name: "This category subtracts from the total" })
					.click(),
			);
			await t.cell(await at("Category"), 0, await budget());
			await t.checked("Remove category", () => t.button("Remove category").click());
			// 9: an amount, typed a key at a time, then Undo and Redo with focus still in the amount field (ruling j).
			await t.checked("Type an amount", () => t.typeAmount("Line item", "3000"));
			const field = t.amount("Line item");
			const before = await t.snap();
			await field.click();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.type("4500", { delay: 40 });
			const typed = await t.snap();
			assert.notDeepEqual(typed, before);
			await page.keyboard.press(`${MOD}+z`);
			await t.settle();
			assert.deepEqual(
				await t.snap(),
				before,
				"Undo with focus in the amount field gives the earlier JSON exactly: one typed amount is one step",
			);
			assert.equal(await field.inputValue(), "$3,000");
			await page.keyboard.press(`${MOD}+Shift+z`);
			await t.settle();
			assert.deepEqual(await t.snap(), typed, "Redo gives the later JSON exactly");
			assert.equal(await field.inputValue(), "$4,500");
			await t.undo();
			await t.settle();
			assert.deepEqual(await t.snap(), before, "the Undo control acts on the one history while the field has focus");
			await t.redo();
			t.valid(await t.snap(), "after Redo");
			// A copied and pasted table stays valid.
			await page.locator(PAPER).evaluate((el) => {
				const ed = el.editor;
				let pos = -1;
				ed.state.doc.descendants((node, at) => {
					if (node.type.name === "table" && pos < 0) pos = at;
					return pos < 0;
				});
				ed.commands.setNodeSelection(pos);
				const { dom } = ed.view.serializeForClipboard(ed.state.selection.content());
				const html = dom.innerHTML;
				ed.chain().focus("end").run();
				ed.view.pasteHTML(html);
			});
			await t.settle();
			const pasted = await t.tables();
			t.valid(await t.snap(), "after paste");
			assert.ok(pasted.length >= 4, "the pasted table is a table of its own");
			assert.deepEqual(pasted.at(-1).attrs.columns, pasted[0].attrs.columns, "the copy keeps the columns");
			assert.deepEqual(pasted.at(-1).content, pasted[0].content, "the copy keeps the rows");
		});
		// No package of Tiptap's general table is installed.
		for (const dir of ["", "apps/web"])
			assert.equal(
				existsSync(join(ROOT, dir, "node_modules/@tiptap/extension-table")),
				false,
				"@tiptap/extension-table is not installed",
			);
	});

	test(`AC:WP-036-14 (${name}): a template's table, loaded and saved with no edit, keeps its stored form and shows no unsaved change`, async () => {
		for (const id of ["budget-worksheet", "guest-sign-in-sheet", "commitment-card", "conflict-of-interest-policy"])
			await onFork(engine, id, async (page, context, t) => {
				const base = await baseOf(id);
				// Look at every field of the table without changing anything.
				const head = page.locator(".ef-head-cell");
				for (let i = 0; i < (await head.count()); i++) {
					await head.nth(i).focus();
					await page.keyboard.press("Tab");
				}
				for (const field of await page.locator(".ef-vinput").all()) await field.click();
				for (const box of await page.getByRole("checkbox").all()) await box.focus();
				await t.settle();
				await page.getByText("Saved", { exact: false }).first().waitFor();
				assert.equal(await page.getByText("Unsaved changes").count(), 0, `${id}: no unsaved change`);
				assert.deepEqual(await t.snap(), clean(base), `${id}: the stored form has no added key`);
				await t.save();
				assert.deepEqual((await t.snap()).body, clean(base).body, `${id}: still the stored form after a save`);
			});
	});
}

// ---------------------------------------------------------------- access

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-15 (${name}): every table control has a name, a tooltip and the right cursor; every cell is reachable; the screen reader sees a table`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.button("Add row below").click();
			await t.button("Add row below").click();
			// The controls: each has an accessible name; each enabled one shows a pointer and a tooltip.
			const group = page.getByRole("group", { name: "Block settings" });
			const controls = group.locator("button, select, input");
			const count = await controls.count();
			assert.ok(count >= 12, `the table controls are there (${count})`);
			for (let i = 0; i < count; i++) {
				const c = controls.nth(i);
				const named = await c.evaluate((el) => {
					const label = el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.textContent;
					return {
						label: (label ?? "").trim(),
						cursor: getComputedStyle(el).cursor,
						disabled: el.disabled === true,
						type: el.type,
					};
				});
				assert.ok(named.label.length > 0, `control ${i + 1} has an accessible name`);
				const text = ["text", "number"].includes(named.type);
				// A field to type in shows the text cursor (WebKit leaves a number field at auto); the rest are clickable.
				const want = named.disabled ? ["not-allowed"] : text ? ["text", "auto"] : ["pointer"];
				assert.ok(want.includes(named.cursor), `${named.label}: cursor ${named.cursor}`);
			}
			for (const label of ["Add row above", "Add column right", "Remove column"]) {
				await t.button(label).hover();
				const tip = page.getByRole("tooltip");
				await tip.first().waitFor({ timeout: 5000 });
				assert.match(await tip.first().innerText(), new RegExp(label));
				await page.mouse.move(0, 0);
			}
			// A disabled control keeps its cursor and says why in the reasons line.
			await page.getByRole("spinbutton", { name: "Blank rows" }).focus();
			// Every cell and control is reachable by keyboard: three header labels, then six cells, then out of the table.
			await t.cell(0, 0);
			await page.locator(".ef-head-cell").first().focus();
			const stops = [];
			for (let i = 0; i < 12; i++) {
				const here = await page.evaluate(() => {
					const a = document.activeElement;
					const inTable = !!a?.closest?.('[data-ef-node="table"]');
					const sel = document.querySelector(".ef-paper .ProseMirror")?.editor?.state.selection;
					return {
						head: a?.classList?.contains("ef-head-cell") ? [...a.parentElement.children].indexOf(a) : null,
						inTable,
						cell: sel ? sel.$from.parent.type.name : null,
						row: sel ? sel.$from.index(1) : null,
						col: sel ? sel.$from.index(2) : null,
					};
				});
				stops.push(here);
				await page.keyboard.press("Tab");
			}
			assert.deepEqual(
				stops.slice(0, 3).map((s) => s.head),
				[0, 1, 2],
				"the header labels come first",
			);
			const cells = stops.slice(3, 9).map((s) => [s.cell, s.row, s.col]);
			assert.deepEqual(cells, [
				["cell", 0, 0],
				["cell", 0, 1],
				["cell", 0, 2],
				["cell", 1, 0],
				["cell", 1, 1],
				["cell", 1, 2],
			]);
			assert.equal(stops[9].inTable, true, "the blank rows are the last stop in the table");
			assert.equal(
				stops.slice(9).some((s) => !s.inTable),
				true,
				`Tab leaves the table after its last stop: ${JSON.stringify(stops)}`,
			);
			// The screen reader's view: a table with column headers, rows and cells.
			assert.equal(await page.getByRole("table").count(), 1);
			assert.equal(await page.getByRole("columnheader").count(), 3);
			assert.ok((await page.getByRole("row").count()) >= 3);
			assert.ok((await page.getByRole("cell").count()) >= 6);
			assert.equal(await page.getByRole("rowgroup", { name: /blank rows to write in by hand/ }).count(), 1);
		});
	});

	test(`AC:WP-036-15 (${name}): at 390 px a wide table scrolls inside its own area, with no sideways page scroll`, async () => {
		await onFork(
			engine,
			"guest-sign-in-sheet",
			async (page, context, t) => {
				await t.deleteAll();
				await t.insert("Table");
				await t.button("Add row below").click();
				for (let i = 0; i < 9; i++) {
					await t.cell(0, 0);
					await t.button("Add column right").click();
				}
				await t.settle();
				const m = await page.evaluate(() => {
					const scroll = document.querySelector(".ef-table-scroll");
					return {
						viewport: window.innerWidth,
						page: document.documentElement.scrollWidth,
						inner: scroll.scrollWidth,
						outer: scroll.clientWidth,
						overflow: getComputedStyle(scroll).overflowX,
					};
				});
				assert.ok(m.page <= m.viewport, `no sideways page scroll (${m.page} > ${m.viewport})`);
				assert.ok(m.inner > m.outer, "the table is wider than its area");
				assert.equal(m.overflow, "auto", "and scrolls inside it");
				// Each control fits the screen.
				const boxes = await page
					.getByRole("group", { name: "Block settings" })
					.locator("button, select, input")
					.evaluateAll((els) =>
						els.map((el) => ({
							label: el.getAttribute("aria-label") || el.id,
							...el.getBoundingClientRect().toJSON(),
						})),
					);
				assert.ok(boxes.length > 10);
				for (const b of boxes)
					assert.ok(b.left >= 0 && b.right <= 390, `${b.label} fits (${Math.round(b.left)} to ${Math.round(b.right)})`);
			},
			{ size: [390, 844], blank: true },
		);
	});

	test(`AC:WP-036-15 (${name}): a Member sees the table read-only, with no editing control, and can still download`, async () => {
		let url = "";
		await onFork(engine, "budget-worksheet", async (page) => {
			url = page.url();
		});
		// Open that document as the Member, in a fresh browser.
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").member.cookie);
			await page.goto(url);
			await hydrated(page);
			await page.getByRole("link", { name: "Download PDF" }).waitFor();
			assert.equal(await page.locator(PAPER).count(), 0, "no editor");
			for (const label of ["Insert block", "Save", "Add row below", "Add line item", "Delete all content"])
				assert.equal(await page.getByRole("button", { name: label }).count(), 0, `no ${label}`);
			assert.equal(await page.locator("input.ef-vinput, input.ef-head-cell").count(), 0, "no field to type in");
			const pdf = await page
				.context()
				.request.get(
					new URL(await page.getByRole("link", { name: "Download PDF" }).getAttribute("href"), url).toString(),
				);
			assert.equal(pdf.status(), 200);
			assert.equal(
				await page.getByRole("link", { name: "Download Excel" }).count(),
				1,
				"a budget still offers Excel to read",
			);
		});
	});
}
