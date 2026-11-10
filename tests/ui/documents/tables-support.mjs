// Shared by the WP-036 table tests (tables.test.mjs, tables-budget.test.mjs, tables-files.test.mjs). Not a test file.
// Every flow runs on a forked document in a real browser. `checked` is the heart of it: it runs one action, then Undo and
// Redo, and compares the whole document JSON at each step, as the ask requires.
import assert from "node:assert/strict";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { documentFrom } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { BASE, fixture, hydrated, signIn, withPage } from "../setup.mjs";

export const PAPER = ".ef-paper .ProseMirror";
export const MOD = "ControlOrMeta";

/** The text of a stored cell. */
export const textOf = (cell) => (cell?.content ?? []).map((n) => n.text ?? "").join("");

/** The stored form of each template the tests fork, for `documentFrom`. */
export const bases = {};
export async function baseOf(id) {
	return (bases[id] ??= await forkTemplate(docTemplateById(id), { data: {} }));
}

/** The title the library lists a template under. */
const TITLES = {
	"budget-worksheet": "Budget Worksheet",
	"guest-sign-in-sheet": "Guest Sign-in Sheet",
	"commitment-card": "Core Group Commitment Card",
	"conflict-of-interest-policy": "Conflict of Interest Policy",
};

/** Runs `run(page, context, ctx)` as the seeded Owner (or `who`) in one engine, on a freshly forked template. */
export function onFork(engine, templateId, run, { size, who = "owner", blank = false } = {}) {
	return withPage(
		engine,
		async (page, context) => {
			await signIn(context, fixture("people")[who].cookie);
			page.on("pageerror", (error) => assert.fail(`page error: ${error.message}`));
			const base = await baseOf(templateId);
			await page.goto(`${BASE}/documents/church`);
			await hydrated(page);
			await page.getByRole("button", { name: "New from template" }).first().click();
			await page.getByRole("button", { name: new RegExp(`^${TITLES[templateId]}`) }).click();
			await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 120_000 });
			await page.locator(PAPER).waitFor({ timeout: 120_000 });
			await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
			// The fork freezes the church's merge values into `data`, so the stored form is the template plus those values.
			const data = await page.locator(PAPER).evaluate((el) => el.editor.getJSON().attrs?.data);
			const ctx = helpers(page, data === undefined ? base : { ...base, data });
			if (blank) await ctx.deleteAll();
			await run(page, context, ctx);
		},
		size ? { width: size[0], height: size[1] } : undefined,
	);
}

function helpers(page, base) {
	const json = () => page.locator(PAPER).evaluate((el) => el.editor.getJSON());
	const snap = async () => documentFrom(base, await json());
	const body = async () => (await snap()).body.content ?? [];
	const tables = async () => (await body()).filter((n) => n.type === "table");
	const table = async (n = 0) => (await tables())[n];
	const valid = (doc, label) => {
		const parsed = docDocument.safeParse(doc);
		assert.ok(parsed.success, `${label}: the document parses with docDocument: ${parsed.error?.issues[0]?.message}`);
	};
	const undo = async () => {
		await page.getByRole("button", { name: "Undo", exact: true }).click();
	};
	const redo = async () => {
		await page.getByRole("button", { name: "Redo", exact: true }).click();
	};
	const button = (name) => page.getByRole("button", { name, exact: true });
	const settle = () =>
		page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

	/** One action with Undo and Redo: the whole document JSON after each step, valid every time. */
	async function checked(label, act, { same = false } = {}) {
		const before = await snap();
		valid(before, `${label} (before)`);
		await act();
		await settle();
		const done = await snap();
		valid(done, `${label} (after)`);
		if (!same) assert.notDeepStrictEqual(done, before, `${label} changed the document`);
		await undo();
		await settle();
		const undone = await snap();
		valid(undone, `${label} (after Undo)`);
		assert.deepStrictEqual(undone, before, `${label}: Undo gives the earlier JSON exactly`);
		await redo();
		await settle();
		const redone = await snap();
		valid(redone, `${label} (after Redo)`);
		assert.deepStrictEqual(redone, done, `${label}: Redo gives the later JSON exactly`);
		return done;
	}

	async function insert(name) {
		await button("Insert block").click();
		await page.getByRole("menuitem", { name, exact: true }).click();
		await settle();
	}
	async function deleteAll() {
		await page.getByRole("button", { name: "Delete all content" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Delete all content" }).click();
		await settle();
	}
	async function save() {
		// The save status line, not the "Saved exports" list below the page.
		const saved = page.getByRole("status").filter({ hasText: /^Saved/ });
		await button("Save").click();
		await saved.waitFor({ timeout: 60_000 });
	}
	/** Puts the cursor at the end of the text cell at `row`, `col` of the n-th table. */
	async function cell(row, col, n = 0, all = false) {
		await page.locator(PAPER).evaluate(
			(el, [r, c, index, all]) => {
				const ed = el.editor;
				let seen = -1;
				let at = null;
				ed.state.doc.descendants((node, pos) => {
					if (at !== null) return false;
					if (node.type.name !== "table") return true;
					if (++seen !== index) return false;
					let rowPos = pos + 1;
					for (let i = 0; i < r; i++) rowPos += node.child(i).nodeSize;
					const rowNode = node.child(r);
					let cellPos = rowPos + 1;
					for (let i = 0; i < c; i++) cellPos += rowNode.child(i).nodeSize;
					at = { cellPos, node: rowNode.child(c) };
					return false;
				});
				if (!at) throw new Error(`no table ${index}`);
				if (at.node.type.name === "valueCell") throw new Error("that is not a text cell");
				const end = at.cellPos + 1 + at.node.content.size;
				ed.chain()
					.focus()
					.setTextSelection(all ? { from: at.cellPos + 1, to: end } : end)
					.run();
			},
			[row, col, n, all],
		);
		await settle();
	}
	/** The amount field of the row whose label contains `label` (`nth` picks the column). */
	const amount = (label, nth = 0) =>
		page.locator(`${PAPER} [data-ef-node="row"]`).filter({ hasText: label }).first().locator(".ef-vinput").nth(nth);
	/** The computed numbers of the row whose label contains `label`, in column order. */
	const computed = (label) =>
		page
			.locator(`${PAPER} [data-ef-node="row"]`)
			.filter({ hasText: label })
			.first()
			.locator(".ef-computed")
			.evaluateAll((els) => els.map((e) => e.textContent));
	/** Types an amount one key at a time, as a person does, in the field of the row labelled `label`. */
	async function typeAmount(label, text, nth = 0) {
		const field = amount(label, nth);
		await field.click();
		await page.keyboard.press(`${MOD}+a`);
		await page.keyboard.press("Backspace");
		if (text) await page.keyboard.type(text);
		await settle();
	}
	/** The id of the open document and the revision the page shows as saved. */
	const where = async () => ({
		id: page.url().split("/").pop(),
		revision: (
			await page
				.getByRole("status")
				.filter({ hasText: /Revision \d+/ })
				.first()
				.innerText()
		).match(/Revision (\d+)/)?.[1],
	});
	/** The bytes the file route gives for the saved revision. `download` is the Download link, else the preview. */
	async function file(format, { download = true } = {}) {
		const { id, revision } = await where();
		const response = await page
			.context()
			.request.get(
				`${BASE}/documents/church/${id}/file?format=${format}&revision=${revision}${download ? "&download=1" : ""}`,
			);
		return { status: response.status(), bytes: new Uint8Array(await response.body()) };
	}
	const rowsDom = (n = 0) => page.locator(`${PAPER} [data-ef-node="table"]`).nth(n).locator('[data-ef-node="row"]');
	const reasons = () => page.locator("[data-table-reasons]");
	return {
		base,
		amount,
		computed,
		typeAmount,
		where,
		file,
		json,
		snap,
		body,
		tables,
		table,
		valid,
		undo,
		redo,
		button,
		settle,
		checked,
		insert,
		deleteAll,
		save,
		cell,
		rowsDom,
		reasons,
	};
}
