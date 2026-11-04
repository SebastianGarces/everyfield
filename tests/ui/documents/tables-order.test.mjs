// WP-036 slice 4: a table used in the order a person uses it. Nothing here sets focus or the cursor by script between two
// actions: every action starts from where the one before it left the person. Seed as tables.test.mjs says.
//   AC:WP-036-1 to -5, -7, -8, -14 and -15 use these flows as well as the ones in the other table tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { SP } from "../../../packages/domain/src/documents/theme.ts";
import { ENGINES } from "../setup.mjs";
import { MOD, onFork, PAPER } from "./tables-support.mjs";

const textOf = (cell) => (cell?.content ?? []).map((n) => n.text ?? "").join("");
const labelsOf = (table) => table.attrs.columns.map((c) => c.label);
const firstCol = (table) => (table.content ?? []).map((r) => textOf(r.content[0]));

/** axe-core from the web app's own install, as the capture script finds it. */
const axeSource = () => {
	let r = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
	for (const m of ["eslint-config-next", "eslint-plugin-jsx-a11y"]) r = createRequire(r.resolve(m));
	return readFileSync(r.resolve("axe-core/axe.min.js"), "utf8");
};
const axeRun = async (page) => {
	await page.addScriptTag({ content: axeSource() });
	return page.evaluate(() =>
		window.axe.run(document, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
		}),
	);
};

/** The width in points the saved PDF gives a column: its empty form field in the first item row, and the cell's padding. */
async function pdfColumn(pdfBytes, id) {
	const form = (await PDFDocument.load(pdfBytes)).getForm();
	const field = form.getFields().find((f) => new RegExp(`row_1_${id}`).test(f.getName()));
	assert.ok(field, `the PDF has a field for ${id}`);
	return field.acroField.getWidgets()[0].getRectangle().width + 2 * SP[2];
}

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-1 (${name}): keys typed right after Insert Table go into the first header label, and the table stays`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await page.keyboard.type("Name");
			await t.settle();
			assert.equal((await t.tables()).length, 1, "the table is still there");
			assert.deepEqual(labelsOf(await t.table()), ["Name", "Column 2", "Column 3"]);
			// A key typed while the whole table is selected, as Undo can leave it, does not replace the table either.
			await t.button("Add row below").click();
			await page.keyboard.type("Ada");
			assert.deepEqual(firstCol(await t.table()), ["Ada"]);
			await page.keyboard.press(`${MOD}+z`);
			await page.keyboard.press(`${MOD}+z`);
			await t.settle();
			await page.keyboard.type("x");
			await t.settle();
			assert.equal((await t.tables()).length, 1, "the table survives a key after Undo");
			assert.equal(labelsOf(await t.table())[0], "x", "and the key lands in the first header label");
		});
	});

	test(`AC:WP-036-1 (${name}): select all in a cell selects the cell, so the next key keeps the document`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const blocks = (await t.body()).length;
			await page.locator(`${PAPER} [data-ef-cell="text"]`).nth(1).click();
			await t.settle();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.type("Rent");
			await t.settle();
			assert.equal((await t.body()).length, blocks, "the document keeps its blocks");
			assert.equal(firstCol(await t.table())[1], "Rent");
		});
	});

	test(`AC:WP-036-2 (${name}): Remove row acts on the blank rows until they are gone, and never on a typed row by surprise`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.button("Add row below").click();
			await page.keyboard.type("keep me");
			await t.button("Add row below").click();
			await page.keyboard.type("keep me too");
			const count = page.getByRole("spinbutton", { name: "Blank rows" });
			await count.click();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.type("3");
			await page.locator(".ef-table-blanks").click();
			for (const left of [2, 1, 0]) {
				await t.button("Remove row").click();
				await t.settle();
				const table = await t.table();
				assert.equal(table.attrs.writeInRows, left);
				assert.deepEqual(firstCol(table), ["keep me", "keep me too"], "the typed rows stay");
			}
			assert.equal(
				await page.evaluate(() => document.activeElement?.closest?.(".ProseMirror") !== null),
				true,
				"the person is on the last typed row",
			);
			await page.keyboard.type("!");
			assert.deepEqual(firstCol(await t.table()), ["keep me", "keep me too!"]);
		});
	});

	test(`AC:WP-036-2 (${name}): a table with no header cannot lose its last row, and says why`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Checklist rows");
			await t.button("Remove row").click();
			await t.button("Remove row").click();
			await t.settle();
			assert.equal((await t.table()).content.length, 1);
			assert.equal(await t.button("Remove row").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /keeps at least one row/);
			assert.ok((await page.locator(`${PAPER} [data-ef-node="table"]`).boundingBox()).height > 10, "the table shows");
		});
	});

	test(`AC:WP-036-3 (${name}): Remove column after typing a header label removes that column, and the controls stay on a new table`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await page.locator(".ef-head-cell").nth(2).click();
			await page.keyboard.press(`${MOD}+a`);
			await page.keyboard.type("Phone");
			assert.deepEqual(labelsOf(await t.table()), ["Column 1", "Column 2", "Phone"]);
			await t.button("Add column right").click();
			await t.settle();
			assert.deepEqual(labelsOf(await t.table()).slice(0, 3), ["Column 1", "Column 2", "Phone"]);
			assert.equal((await t.table()).attrs.columns.length, 4);
			await page.keyboard.type("Next");
			assert.equal(labelsOf(await t.table())[3], "Next", "focus went to the new column's label");
			await t.button("Remove column").click();
			await t.settle();
			assert.deepEqual(labelsOf(await t.table()), ["Column 1", "Column 2", "Phone"]);
			await t.button("Remove column").click();
			await t.settle();
			assert.deepEqual(labelsOf(await t.table()), ["Column 1", "Column 2"], "Phone is the column removed");
			assert.equal(await t.button("Remove column").isDisabled(), false, "the controls are still here");
		});
	});

	for (const [size, wide] of [
		[[1440, 900], false],
		[[390, 844], true],
	]) {
		test(`AC:WP-036-3 (${name}): at ${size[0]} px the columns of a budget have the widths the PDF gives them`, async () => {
			await onFork(
				engine,
				"budget-worksheet",
				async (page, context, t) => {
					// An empty label leaves a form field in the PDF, which gives the free column's width.
					await t.cell(1, 0, 0, true);
					await page.keyboard.press("Backspace");
					await t.settle();
					await t.save();
					const { bytes } = await t.file("pdf");
					const table = await t.table();
					const editor = await page
						.locator(`${PAPER} .ef-head-wrap`)
						.evaluateAll((els) => els.map((el) => (el.getBoundingClientRect().width * 3) / 4));
					for (const [i, column] of table.attrs.columns.entries()) {
						if (column.type === "formula") continue;
						const pdf = await pdfColumn(bytes, column.id);
						assert.ok(
							Math.abs((editor[i] ?? 0) - pdf) < 1.5,
							`${column.id}: the editor shows ${editor[i]} pt and the PDF ${pdf} pt`,
						);
					}
					const m = await page.evaluate(() => {
						const scroll = document.querySelector(".ef-table-scroll");
						return {
							page: document.documentElement.scrollWidth,
							viewport: window.innerWidth,
							inner: scroll.scrollWidth,
							outer: scroll.clientWidth,
						};
					});
					assert.ok(m.page <= m.viewport, "no sideways page scroll");
					assert.equal(m.inner > m.outer, wide, "the table scrolls inside its own area when the screen is narrow");
				},
				{ size },
			);
		});
	}

	test(`AC:WP-036-4 (${name}): the header color and the stripes keep the column the person is in`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await page.locator(".ef-head-cell").nth(2).click();
			await page.getByRole("radio", { name: "accent", exact: true }).first().click();
			await page.getByRole("checkbox", { name: "Striped rows" }).click();
			await page.getByRole("combobox", { name: "Column kind" }).selectOption("money");
			await t.settle();
			const table = await t.table();
			assert.deepEqual(
				table.attrs.columns.map((c) => c.type),
				["text", "text", "money"],
			);
			assert.equal(table.attrs.headerFill, "accent");
			assert.equal(table.attrs.zebra, true);
		});
	});

	test(`AC:WP-036-5 (${name}): on a new table, Blank rows takes a number key by key, with one Undo, and the shortcut works from the blank rows`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			const count = page.getByRole("spinbutton", { name: "Blank rows" });
			await t.checked("Type a count key by key", async () => {
				await count.click();
				await page.keyboard.press(`${MOD}+a`);
				await page.keyboard.type("12");
			});
			assert.equal((await t.table()).attrs.writeInRows, 12);
			assert.equal(await count.inputValue(), "12");
			assert.equal(await page.locator(`${PAPER} .ef-blank-row`).count(), 12);

			await count.click();
			await page.keyboard.press(`${MOD}+z`);
			await t.settle();
			assert.equal((await t.table()).attrs.writeInRows, 5, "the shortcut undoes in the field too");
			assert.equal(await count.inputValue(), "5");

			await page.locator(".ef-table-blanks").click();
			await t.button("Remove row").click();
			await t.settle();
			assert.equal((await t.table()).attrs.writeInRows, 4);
			await page.keyboard.press(`${MOD}+z`);
			await t.settle();
			assert.equal((await t.table()).attrs.writeInRows, 5, "the shortcut undoes from the blank rows");
			await page.keyboard.press(`${MOD}+Shift+z`);
			await t.settle();
			assert.equal((await t.table()).attrs.writeInRows, 4, "and redoes");
		});
	});

	test(`AC:WP-036-7 (${name}): Remove row after a tick removes the row of that tick`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Checklist rows");
			await page.keyboard.type("first");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
			await page.keyboard.type("second");
			await page.getByRole("checkbox", { name: /row 2/ }).click();
			await t.settle();
			assert.equal((await t.table()).content[1].content[0].attrs.checked, true);
			await t.button("Remove row").click();
			await t.settle();
			assert.deepEqual(
				(await t.table()).content.map((r) => textOf(r.content[1])),
				["first", ""],
			);
		});
	});

	test(`AC:WP-036-8 (${name}): Remove line item after typing an amount removes that line; the sign shows only in a category`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const before = await t.table();
			const label = textOf(before.content[1].content[0]);
			await t.typeAmount(label, "100");
			await t.button("Remove line item").click();
			await t.settle();
			const after = await t.table();
			assert.equal(after.content.length, before.content.length - 1);
			assert.equal(firstCol(after).includes(label), false, `${label} is the row removed`);

			// The cursor stays on a line item, so the same control works again.
			const items = () => t.table().then((table) => table.content.filter((r) => !r.attrs?.role).length);
			const left = await items();
			await t.button("Remove line item").click();
			await t.settle();
			assert.equal(await items(), left - 1, "Remove line item works twice from one place");

			const sign = page.getByRole("radiogroup", { name: "Category sign" });
			assert.equal(await sign.count(), 1, "a category shows its sign");
			const total = (await t.table()).content.findIndex((r) => r.attrs?.role === "total");
			if (total >= 0) {
				await t.cell(total, 0);
				assert.equal(await sign.count(), 0, "a grand total has none");
			}
		});
	});

	test(`AC:WP-036-14 (${name}): a run of actions from one place has an exact Undo and Redo at each step`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.checked("Insert Table", () => t.insert("Table"));
			await page.locator(".ef-head-cell").nth(2).click();
			await t.checked("Type a label", () => page.keyboard.type(" Phone"));
			await t.checked("Header color", () => page.getByRole("radio", { name: "primary", exact: true }).first().click());
			await t.checked("Stripes", () => page.getByRole("checkbox", { name: "Striped rows" }).click());
			await t.checked("Kind", () => page.getByRole("combobox", { name: "Column kind" }).selectOption("number"));
			assert.equal((await t.table()).attrs.columns[2].type, "number", "the third column changed");
			await t.checked("Add column right", () => t.button("Add column right").click());
			assert.equal((await t.table()).attrs.columns[3].label, "Column 4");
			await t.checked("Remove column", () => t.button("Remove column").click());
			assert.equal((await t.table()).attrs.columns.length, 3);
			await page.locator(".ef-table-blanks").click();
			await t.checked("Remove a blank row", () => t.button("Remove row").click());
			assert.equal((await t.table()).attrs.writeInRows, 4);
			await t.checked("Remove another blank row", () => t.button("Remove row").click());
			assert.equal((await t.table()).attrs.writeInRows, 3);
		});
	});

	// A selection that crosses a table's edge, by real mouse and keys. Each result is either no change with a note, or a
	// document that parses and saves. Nothing leaves a document Save refuses.
	const paragraph = (page) => page.locator(`${PAPER} p`).first();
	const budgetCell = (page, label) => page.locator(`${PAPER} [data-ef-cell="text"]`).filter({ hasText: label }).first();
	const shiftClick = async (page, box, x = 30) => {
		await page.keyboard.down("Shift");
		await page.mouse.click(box.x + x, box.y + box.height / 2);
		await page.keyboard.up("Shift");
	};
	const saves = async (t) => {
		t.valid(await t.snap(), "the document");
		await t.save();
		assert.equal((await t.file("pdf")).status, 200, "the PDF of the result");
		assert.equal((await t.file("docx")).status, 200, "the Word file of the result");
	};
	const refusedNote = (page) => page.locator("[data-table-refused]");

	for (const [how, press] of [
		["Backspace", (page) => page.keyboard.press("Backspace")],
		["Delete", (page) => page.keyboard.press("Delete")],
		["a typed key", (page) => page.keyboard.type("x")],
		["Cut", (page) => page.keyboard.press(`${MOD}+x`)],
	]) {
		test(`AC:WP-036-14 (${name}): ${how} on a selection from a paragraph's start into a budget's first line item changes nothing and says why`, async () => {
			await onFork(engine, "budget-worksheet", async (page, context, t) => {
				const before = await t.snap();
				const start = await paragraph(page).boundingBox();
				await page.mouse.click(start.x + 1, start.y + 6);
				await t.settle();
				const selectedFrom = await page.locator(PAPER).evaluate((el) => el.editor.state.selection.$from.parentOffset);
				assert.equal(selectedFrom, 0, "the click put the cursor at the start of the paragraph");
				await shiftClick(page, await budgetCell(page, "Tithes").boundingBox());
				await t.settle();
				await press(page);
				await t.settle();
				assert.deepStrictEqual(await t.snap(), before, "the document is the same");
				await refusedNote(page).waitFor();
				assert.match(await refusedNote(page).innerText(), /would break a table, so nothing changed/);
				const table = await t.table();
				assert.equal(table.content[0].attrs?.role, "group", "the category row stays");
				// The next move of the cursor takes the note away, and the page still saves.
				await budgetCell(page, "Tithes").click();
				await t.settle();
				assert.equal(await refusedNote(page).count(), 0, "a cursor move clears the note");
				await page.keyboard.type("!");
				await saves(t);
			});
		});
	}

	test(`AC:WP-036-14 (${name}): a selection from a paragraph's middle into a table changes nothing and says why`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const before = await t.snap();
			const start = await paragraph(page).boundingBox();
			await page.mouse.click(start.x + 40, start.y + 6);
			await t.settle();
			await shiftClick(page, await budgetCell(page, "Tithes").boundingBox());
			await t.settle();
			await page.keyboard.press("Backspace");
			await t.settle();
			assert.deepStrictEqual(await t.snap(), before, "the document is the same");
			await refusedNote(page).waitFor();
		});
	});

	test(`AC:WP-036-14 (${name}): a selection across a budget's rows leaves a budget that saves, or no change`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const before = await t.snap();
			const rows = (await t.table()).content;
			const group = rows.find((r) => r.attrs?.role === "group");
			const groupBox = await budgetCell(page, textOf(group.content[0])).boundingBox();
			await page.mouse.click(groupBox.x + 1, groupBox.y + groupBox.height / 2);
			await t.settle();
			const lastItem = rows[rows.findIndex((r) => r.attrs?.role === "subtotal") - 1];
			await shiftClick(page, await budgetCell(page, textOf(lastItem.content[0])).boundingBox());
			await t.settle();
			await page.keyboard.press("Backspace");
			await t.settle();
			const after = await t.snap();
			if (JSON.stringify(after) === JSON.stringify(before)) await refusedNote(page).waitFor();
			await saves(t);
		});
	});

	/** A paragraph after the table, added and typed by the person, since each template's table ends the body. */
	const paragraphAfter = async (page, t) => {
		await t.insert("Paragraph");
		await page.keyboard.type("After the table");
		await t.settle();
		return page.locator(`${PAPER} p`).filter({ hasText: "After the table" });
	};

	test(`AC:WP-036-14 (${name}): a selection from a budget's last rows into the paragraph after them leaves a budget that saves, or no change`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			await budgetCell(page, "Tithes").click();
			const after = await paragraphAfter(page, t);
			const before = await t.snap();
			const count = await t.rowsDom().count();
			const lastItem = t
				.rowsDom()
				.nth(count - 3)
				.locator('[data-ef-cell="text"]')
				.first();
			const from = await lastItem.boundingBox();
			await page.mouse.click(from.x + 2, from.y + from.height / 2);
			await t.settle();
			const to = await after.boundingBox();
			await shiftClick(page, to, 40);
			await t.settle();
			await page.keyboard.press("Backspace");
			await t.settle();
			if (JSON.stringify(await t.snap()) === JSON.stringify(before)) await refusedNote(page).waitFor();
			await saves(t);
			assert.equal((await t.file("xlsx")).status, 200, "the Excel file of the result");
		});
	});

	test(`AC:WP-036-14 (${name}): a selection from a plain table's typed row into the paragraph after it leaves a table that saves, or no change`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await page.locator(".ef-table-blanks").click();
			await t.button("Add row below").click();
			await page.keyboard.type("Ada");
			const after = await paragraphAfter(page, t);
			const before = await t.snap();
			const from = await t.rowsDom().first().locator('[data-ef-cell="text"]').first().boundingBox();
			await page.mouse.click(from.x + 2, from.y + from.height / 2);
			await t.settle();
			await shiftClick(page, await after.boundingBox(), 40);
			await t.settle();
			await page.keyboard.press("Backspace");
			await t.settle();
			if (JSON.stringify(await t.snap()) === JSON.stringify(before)) await refusedNote(page).waitFor();
			await saves(t);
		});
	});

	test(`AC:WP-036-14 (${name}): a selection from before a table to after it removes the whole table, with an exact Undo`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			await budgetCell(page, "Tithes").click();
			const after = await paragraphAfter(page, t);
			const before = await t.snap();
			const start = await paragraph(page).boundingBox();
			await page.mouse.click(start.x + 1, start.y + 6);
			await t.settle();
			await shiftClick(page, await after.boundingBox(), 40);
			await t.settle();
			await page.keyboard.press("Backspace");
			await t.settle();
			assert.equal((await t.tables()).length, 0, "the table is gone");
			assert.equal(await refusedNote(page).count(), 0, "no note: the change happened");
			await saves(t);
			await t.undo();
			await t.settle();
			assert.deepStrictEqual(await t.snap(), before, "Undo gives the earlier JSON exactly");
		});
	});

	test(`AC:WP-036-15 (${name}): a table's cells and labels pass axe, and a header label is a text box inside a column header`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			await t.cell(1, 0);
			const { violations } = await axeRun(page);
			const tableFaults = violations
				.filter((v) => ["target-size", "aria-allowed-role", "empty-table-header"].includes(v.id))
				.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`);
			assert.deepEqual(tableFaults, []);
			const header = page.locator(PAPER).getByRole("columnheader").first();
			assert.equal(await header.getByRole("textbox", { name: "Label of column 1" }).count(), 1);
		});
	});
}
