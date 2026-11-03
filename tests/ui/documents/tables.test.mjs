// WP-036 slice 4: tables in the Church Document editor, in a real browser against a preview. Every action runs on a
// forked document; after each action, after Undo and after Redo the whole document JSON is checked: Undo gives the
// earlier JSON exactly, Redo gives the later JSON exactly, and each one parses with docDocument.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/tables.test.mjs
// Seed People, then Settings (the Settings seed removes any brand kit, so the paper paints the neutral palette):
//   tests/ui/people/seed.mts up <preview-url>, then tests/ui/settings/seed.mts up
//   AC:WP-036-1 Table      AC:WP-036-2 Rows      AC:WP-036-3 Columns      AC:WP-036-4 Column kinds
//   AC:WP-036-5 Blank write-in rows              AC:WP-036-6 Header color and stripes      AC:WP-036-7 Checklist rows
import assert from "node:assert/strict";
import { test } from "node:test";
import { columnWidths, TABLE_LIMITS } from "../../../packages/contracts/src/documents/index.ts";
import { textOn } from "../../../packages/domain/src/documents/contrast.ts";
import { makePalette, NEUTRAL_THEME, tokenColor } from "../../../packages/domain/src/documents/theme.ts";
import { ENGINES } from "../setup.mjs";
import { MOD, onFork, PAPER } from "./tables-support.mjs";

const palette = makePalette(NEUTRAL_THEME);
const rgb = (hex) => {
	const n = Number.parseInt(hex.replace("#", ""), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const textOf = (cell) => (cell?.content ?? []).map((n) => n.text ?? "").join("");

for (const [name, engine] of ENGINES) {
	test(`AC:WP-036-1 (${name}): Insert offers Table; a cell takes typing, the text tools, Tab and Enter; a pasted block is one line`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			const doc = await t.checked("Insert Table", () => t.insert("Table"));
			const table = doc.body.content.find((n) => n.type === "table");
			assert.equal(table.attrs.style, "grid");
			assert.equal(table.attrs.header, true);
			assert.equal(table.attrs.writeInRows, 5);
			assert.deepEqual(
				table.attrs.columns.map((c) => c.type),
				["text", "text", "text"],
			);
			assert.equal(table.content, undefined, "a new table holds no typed row; its 5 rows are blank write-in rows");

			await t.checked("Add row", () => t.button("Add row below").click());
			// Typing, then the toolbar's text tools in a cell: bold with its shortcut, a tag label with its button.
			await t.checked(
				"Type, bold and a tag label in a cell",
				async () => {
					await page.keyboard.type("Hello ");
					await page.keyboard.press(`${MOD}+b`);
					await page.keyboard.type("bold ");
					await page.keyboard.press(`${MOD}+b`);
					await t.button("Tag").click();
					await page.keyboard.type("GROW");
				},
				{ same: false },
			);
			const typed = (await t.table()).content[0].content[0];
			assert.deepEqual(
				typed.content.map((n) => [n.text, (n.marks ?? []).map((m) => m.type)]),
				[
					["Hello ", []],
					["bold ", ["bold"]],
					["GROW", ["tag"]],
				],
			);

			// Tab and Shift+Tab move between cells; Enter adds no paragraph.
			await t.cell(0, 0);
			await page.keyboard.press("Tab");
			await page.keyboard.type("second");
			await page.keyboard.press("Tab");
			await page.keyboard.type("third");
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.type("!");
			await page.keyboard.press("Enter");
			await page.keyboard.press("Shift+Enter");
			await t.settle();
			const row = (await t.table()).content[0];
			assert.deepEqual(row.content.map(textOf), ["Hello bold GROW!", "second", "third"]);
			assert.equal(JSON.stringify(row).includes('"paragraph"'), false, "Enter adds no paragraph");
			assert.equal(JSON.stringify(row).includes("hardBreak"), false, "Shift+Enter adds no line break");
			assert.equal(row.content.length, 3, "Enter does not split the cell");

			// A multi-line paste lands in one cell as one line.
			await t.cell(0, 2);
			await t.checked("Paste lines", () =>
				page.locator(PAPER).evaluate((el) => el.editor.view.pasteText("one\ntwo\r\nthree")),
			);
			assert.equal(textOf((await t.table()).content[0].content[2]), "thirdone two three");
			await page.locator(PAPER).evaluate((el) => el.editor.view.pasteHTML("<p>alpha</p><p>beta</p>"));
			const pasted = (await t.table()).content[0];
			assert.equal(pasted.content.length, 3);
			assert.equal(textOf(pasted.content[2]), "thirdone two threealpha beta");
		});
	});

	test(`AC:WP-036-1 (${name}): a forked sign-in sheet, card, policy and budget table is editable the same way`, async () => {
		const edits = {
			"guest-sign-in-sheet": async (page, t) => {
				await page.locator(".ef-head-cell").first().focus();
				await t.checked("Add row to the sign-in sheet", () => t.button("Add row below").click());
				await t.cell(0, 1);
				await t.checked("Type in the sign-in sheet", () => page.keyboard.type("Ada"));
			},
			"commitment-card": async (page, t) => {
				await t.cell(0, 1);
				await t.checked("Type in the card", () => page.keyboard.type(" and pray"));
			},
			"conflict-of-interest-policy": async (page, t) => {
				await page.locator(".ef-head-cell").first().focus();
				await t.checked("Add row to the policy", () => t.button("Add row above").click());
				await t.cell(0, 0);
				await t.checked("Type in the policy", () => page.keyboard.type("Board member"));
			},
			"budget-worksheet": async (page, t) => {
				await t.cell(1, 0);
				await t.checked("Type in the budget", () => page.keyboard.type(" (rent)"));
			},
		};
		for (const [id, edit] of Object.entries(edits))
			await onFork(engine, id, async (page, context, t) => {
				const before = JSON.stringify(await t.table());
				await edit(page, t);
				assert.notEqual(JSON.stringify(await t.table()), before, `${id}: the table changed`);
			});
	});

	test(`AC:WP-036-2 (${name}): a table control adds a row above or below and removes a row; a list table and the 1000-row limit disable Add row with a reason`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.checked("Add the first row", () => t.button("Add row below").click());
			await t.cell(0, 0);
			await page.keyboard.type("one");
			await t.checked("Add a row below", () => t.button("Add row below").click());
			await page.keyboard.type("two");
			await t.cell(0, 0);
			await t.checked("Add a row above", () => t.button("Add row above").click());
			assert.deepEqual(
				(await t.table()).content.map((r) => textOf(r.content[0])),
				["", "one", "two"],
			);
			await t.cell(1, 0);
			await t.checked("Remove the current row", () => t.button("Remove row").click());
			assert.deepEqual(
				(await t.table()).content.map((r) => textOf(r.content[0])),
				["", "two"],
			);

			// A table of a list field has no typed rows: Add row is off with its reason; the other controls work.
			await page.locator(PAPER).evaluate((el) => {
				const ed = el.editor;
				let pos = -1;
				ed.state.doc.descendants((node, at) => {
					if (node.type.name === "table" && pos < 0) pos = at;
					return pos < 0;
				});
				const node = ed.state.doc.nodeAt(pos);
				ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, source: "attendees" }));
			});
			await t.cell(0, 0);
			assert.equal(await t.button("Add row above").isDisabled(), true);
			assert.equal(await t.button("Add row below").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /lists the "attendees" field, so it has no typed rows/);
			assert.equal(await t.button("Add column right").isDisabled(), false);
			// (The document would need the list field declared to parse; the control is what is checked here.)
			await t.button("Add column right").click();
			assert.equal((await t.table()).attrs.columns.length, 4);

			// At the format's 1000-row limit, Add row is off with its reason; one fewer row turns it back on.
			await page.locator(PAPER).evaluate((el, limit) => {
				const ed = el.editor;
				let pos = -1;
				ed.state.doc.descendants((node, at) => {
					if (node.type.name === "table" && pos < 0) pos = at;
					return pos < 0;
				});
				const node = ed.state.doc.nodeAt(pos);
				const columns = node.attrs.columns.slice(0, 2);
				const rows = Array.from({ length: limit }, () => ({
					type: "row",
					content: columns.map(() => ({ type: "cell" })),
				}));
				const next = ed.schema.nodeFromJSON({
					type: "table",
					attrs: { columns, style: "grid", header: true, writeInRows: 0 },
					content: rows,
				});
				ed.view.dispatch(ed.state.tr.replaceWith(pos, pos + node.nodeSize, next));
			}, TABLE_LIMITS.rows);
			await t.cell(5, 0);
			assert.equal(await t.button("Add row below").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /at most 1000 rows/);
			await t.checked("Remove a row at the limit", () => t.button("Remove row").click());
			assert.equal(await t.button("Add row below").isDisabled(), false);
		});
	});

	test(`AC:WP-036-3 (${name}): a table control adds a column left or right and removes one; the header edits the label; limits disable with a reason; columns have the PDF's widths`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.checked("Add the first row", () => t.button("Add row below").click());
			await t.cell(0, 1);
			await page.keyboard.type("mid");
			const ids = async () => (await t.table()).attrs.columns.map((c) => c.id);
			await t.checked("Add a column left", () => t.button("Add column left").click());
			assert.deepEqual(await ids(), ["column_1", "column_4", "column_2", "column_3"]);
			await t.cell(0, 2);
			await t.checked("Add a column right", () => t.button("Add column right").click());
			assert.deepEqual(await ids(), ["column_1", "column_4", "column_2", "column_5", "column_3"]);
			const grown = await t.table();
			assert.ok(grown.content.every((r) => r.content.length === 5), "each row gains the cell");
			assert.equal(textOf(grown.content[0].content[2]), "mid");
			assert.deepEqual(
				grown.attrs.columns.map((c) => [c.type, c.width]),
				Array(5).fill(["text", 0]),
				"a new column is text with a free width",
			);
			await t.cell(0, 2);
			await t.checked("Remove the current column", () => t.button("Remove column").click());
			const shrunk = await t.table();
			assert.deepEqual(await ids(), ["column_1", "column_4", "column_5", "column_3"]);
			assert.ok(shrunk.content.every((r) => r.content.length === 4), "each row loses the cell");

			// The header cell edits the label.
			await t.checked("Edit a header label", async () => {
				const head = page.locator(".ef-head-cell").nth(1);
				await head.fill("Phone number");
			});
			assert.equal((await t.table()).attrs.columns[1].label, "Phone number");

			// The editor lays the columns out by the PDF's own rule.
			const measured = await page.locator(`${PAPER} .ef-table-scroll`).first().evaluate((el) => ({
				width: el.clientWidth,
				cols: getComputedStyle(el.querySelector(".ef-table-grid")).getPropertyValue("--ef-cols").trim(),
				cells: [...el.querySelectorAll(".ef-head-cell")].map((c) => c.getBoundingClientRect().width),
			}));
			const expected = columnWidths((await t.table()).attrs.columns, measured.width * 0.75).map((pt) => (pt * 4) / 3);
			assert.deepEqual(
				measured.cols.split(" ").map((v) => Math.round(Number.parseFloat(v))),
				expected.map(Math.round),
			);
			measured.cells.forEach((w, i) => assert.ok(Math.abs(w - (expected[i] ?? 0)) < 2, `column ${i + 1} is ${w}px wide`));

			// 16 columns is the most; the last column cannot be removed.
			while ((await t.table()).attrs.columns.length < TABLE_LIMITS.columns) {
				await t.cell(0, 0);
				await t.button("Add column right").click();
				await t.settle();
			}
			assert.equal(await t.button("Add column left").isDisabled(), true);
			assert.equal(await t.button("Add column right").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /at most 16 columns/);
			while ((await t.table()).attrs.columns.length > 1) {
				await t.cell(0, 0);
				await t.button("Remove column").click();
				await t.settle();
			}
			assert.equal(await t.button("Remove column").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /keeps at least one column/);
		});
	});

	test(`AC:WP-036-4 (${name}): a column control sets the kind; cells convert and still parse; amounts, check boxes and row numbers behave`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.checked("Add the first row", () => t.button("Add row below").click());
			await page.keyboard.type("12");
			await t.cell(0, 1);
			await page.keyboard.type("note");
			const kind = (value) => page.getByRole("combobox", { name: "Column kind" }).selectOption(value);
			const cellOf = async (col) => (await t.table()).content[0].content[col];

			// Text that reads as a number becomes the value; the value keeps across number and money; it becomes text again.
			await t.cell(0, 0);
			await t.checked("Kind: number", () => kind("number"));
			assert.equal((await cellOf(0)).attrs.value, 12);
			await t.checked("Kind: money", () => kind("money"));
			assert.equal((await cellOf(0)).attrs.value, 12);
			await t.checked("Kind: text", () => kind("text"));
			assert.equal(textOf(await cellOf(0)), "$12");
			// Anything else clears.
			await t.cell(0, 1);
			await t.checked("Kind: number clears text that is no number", () => kind("number"));
			assert.equal((await cellOf(1)).attrs, undefined);
			await t.checked("Kind: check box", () => kind("check"));
			await t.checked("Kind: row number", () => kind("index"));
			assert.deepEqual((await t.table()).attrs.columns.map((c) => c.type), ["text", "index", "text"]);

			// A number or money cell takes an amount; a check box ticks with a click and with the keyboard.
			await t.checked("Kind: money", async () => {
				await page.locator(".ef-head-cell").nth(2).focus();
				await kind("money");
			});
			const amount = page.locator(".ef-vinput").first();
			await amount.click();
			await page.keyboard.type("$3,000");
			assert.equal((await cellOf(2)).attrs.value, 3000);
			await page.locator(".ef-head-cell").nth(0).focus();
			await kind("check");
			const box = page.getByRole("checkbox", { name: /row 1/ });
			await box.click();
			assert.equal((await cellOf(0)).attrs.checked, true);
			await box.focus();
			await page.keyboard.press("Space");
			assert.equal((await cellOf(0)).attrs.checked, false);
			await t.checked("Tick with the keyboard", async () => {
				await box.focus();
				await page.keyboard.press("Space");
			});
			assert.equal((await cellOf(0)).attrs.checked, true);

			// A row number cell shows the number the PDF prints and takes no input.
			await page.locator(".ef-head-cell").nth(0).focus();
			await kind("index");
			const first = page.locator(`${PAPER} [data-ef-node="row"]`).first().locator('[data-ef-cell="value"]').first();
			assert.equal((await first.innerText()).trim(), "1");
			assert.equal(await first.locator("input, button").count(), 0, "a row number takes no input");
			assert.equal(await page.locator(".ef-blank-cell[data-kind='index']").first().innerText(), "2", "blank rows count on");
		});
	});

	test(`AC:WP-036-4 (${name}): a column a formula reads, a formula column and a budget's last text column keep their kind and place`, async () => {
		await onFork(engine, "budget-worksheet", async (page, context, t) => {
			const kind = page.getByRole("combobox", { name: "Column kind" });
			await t.cell(1, 0);
			assert.equal(await kind.isDisabled(), true, "the label column is the budget's only text column");
			assert.equal(await t.button("Remove column").isDisabled(), true);
			await page.locator(".ef-head-cell").nth(1).focus();
			assert.equal(await kind.isDisabled(), true);
			assert.equal(await t.button("Remove column").isDisabled(), true);
			assert.match(await t.reasons().innerText(), /The "Annual" column reads this column/);
			await page.locator(".ef-head-cell").nth(2).focus();
			assert.equal(await kind.isDisabled(), true, "a formula column keeps its kind");
			assert.equal(await t.button("Remove column").isDisabled(), false, "nothing reads the formula column");
			await t.checked("Remove the formula column", () => t.button("Remove column").click());
			await page.locator(".ef-head-cell").nth(1).focus();
			assert.equal(await kind.isDisabled(), false, "with the formula gone, nothing reads the amount column");
		});
	});

	test(`AC:WP-036-5 (${name}): a table control sets the blank write-in rows from 0 to 200 and refuses a count outside it`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			await t.checked("Add a typed row", () => t.button("Add row below").click());
			const count = page.getByRole("spinbutton", { name: "Blank rows" });
			const blanks = page.locator(`${PAPER} .ef-blank-row`);
			assert.equal(await blanks.count(), 5);
			await t.checked("Set the blank rows to 40", async () => {
				await count.fill("40");
			});
			assert.equal((await t.table()).attrs.writeInRows, 40);
			assert.equal(await blanks.count(), 40, "the editor shows every blank row, above the cap of 8 it had");
			// A count outside the range shows the format's message next to the field and is not applied.
			await count.fill("250");
			assert.match(await page.getByRole("alert").filter({ hasText: "250" }).innerText(), /250 is outside 0 to 200/);
			assert.equal((await t.table()).attrs.writeInRows, 40);
			assert.equal(await blanks.count(), 40);
			await count.fill("-1");
			assert.match(await page.getByRole("alert").filter({ hasText: "-1" }).innerText(), /-1 is outside 0 to 200/);
			await count.fill("2.5");
			assert.match(await page.getByRole("alert").filter({ hasText: /whole number/ }).innerText(), /must be a whole number/);
			assert.equal((await t.table()).attrs.writeInRows, 40);
			await count.fill("200");
			assert.equal(await blanks.count(), 200);
			await count.blur();
			await t.checked("Set the blank rows to 0", async () => {
				await count.fill("0");
			});
			assert.equal(await blanks.count(), 0);
			// Remove row on a blank row lowers the count.
			await count.fill("3");
			await page.locator(".ef-table-blanks").focus();
			await t.checked("Remove a blank row", () => t.button("Remove row").click());
			assert.equal((await t.table()).attrs.writeInRows, 2);
		});
	});

	test(`AC:WP-036-6 (${name}): a table control sets the header color from the token swatches and toggles striped rows, painted as the PDF paints them`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			await t.insert("Table");
			for (let i = 0; i < 4; i++) await t.button("Add row below").click();
			await t.cell(0, 0);
			assert.equal(await page.locator('input[type="color"]').count(), 0, "no color picker");
			assert.equal(await page.getByRole("textbox", { name: /hex|color/i }).count(), 0, "no hex field");
			const head = page.locator(`${PAPER} .ef-table-head`).first();
			const paint = (el) => {
				const s = getComputedStyle(el);
				return { bg: s.backgroundColor, color: s.color };
			};
			for (const token of ["primary", "accent", "ink", "muted-text", "border", "muted", "none"]) {
				await t.checked(`Header color ${token}`, () => page.getByRole("radio", { name: token, exact: true }).first().click(), {
					same: token === "muted",
				});
				const fill = tokenColor(palette, token);
				const seen = await head.evaluate(paint);
				if (fill) {
					assert.equal(seen.bg, rgb(fill), `${token}: the header fill is the color the PDF prints`);
					assert.equal(seen.color, rgb(textOn(fill, palette.ink)), `${token}: its text is the contrast color`);
				} else assert.equal(seen.bg, "rgba(0, 0, 0, 0)");
			}
			await t.checked("Striped rows", () => page.getByLabel("Striped rows").check());
			assert.equal((await t.table()).attrs.zebra, true);
			// The PDF stripes every second item row, the blank rows included: typed rows 2 and 4, then blank row 2 (item 6).
			const striped = await page.locator(`${PAPER} .ef-table [data-role="item"]`).evaluateAll((rows) =>
				rows.map((r) => getComputedStyle(r).backgroundColor),
			);
			assert.equal(striped.length, 9, "four typed rows and five blank rows");
			striped.forEach((bg, i) =>
				assert.equal(bg === rgb(palette.muted), (i + 1) % 2 === 0, `row ${i + 1} is ${(i + 1) % 2 === 0 ? "" : "not "}striped`),
			);
			await t.checked("Stripes off", () => page.getByLabel("Striped rows").uncheck());
			assert.equal((await t.table()).attrs.zebra, false);
		});
	});

	test(`AC:WP-036-7 (${name}): Insert offers Checklist rows; a commitment, a tag label, a tick and added and removed rows all work`, async () => {
		await onFork(engine, "guest-sign-in-sheet", async (page, context, t) => {
			await t.deleteAll();
			const doc = await t.checked("Insert Checklist rows", () => t.insert("Checklist rows"));
			const table = doc.body.content.find((n) => n.type === "table");
			assert.equal(table.attrs.style, "rows");
			assert.equal(table.attrs.header, false);
			assert.deepEqual(
				table.attrs.columns.map((c) => c.type),
				["check", "text"],
			);
			assert.equal(table.content.length, 3);
			await t.checked("Type a commitment with a tag label", async () => {
				await page.keyboard.type("Pray daily ");
				await t.button("Tag").click();
				await page.keyboard.type("GROW");
			});
			assert.deepEqual(
				(await t.table()).content[0].content[1].content.map((n) => [n.text, (n.marks ?? []).map((m) => m.type)]),
				[
					["Pray daily ", []],
					["GROW", ["tag"]],
				],
			);
			await t.checked("Tick the first box", () => page.getByRole("checkbox", { name: /row 1/ }).click());
			assert.equal((await t.table()).content[0].content[0].attrs.checked, true);
			await t.cell(0, 1);
			await t.checked("Add a row", () => t.button("Add row below").click());
			assert.equal((await t.table()).content.length, 4);
			await t.checked("Remove a row", () => t.button("Remove row").click());
			assert.equal((await t.table()).content.length, 3);
		});
	});
}
