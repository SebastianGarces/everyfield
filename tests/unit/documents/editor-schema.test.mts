// WP-036 slice 2: the editor's free parts and its schema. No browser, no database.
//   AC:CASE-DOC-016: the plain document editor (OPS-87) holds a native body unchanged and has no template-only node.
//   AC:DOC-EDIT-FREE: every Tiptap package the workspace installs is MIT; no @tiptap-pro package. The private-registry
//   check is scripts/lint/check-repo-files.mjs, which `pnpm lint` runs.
//   AC:DOC-EDIT-SCHEMA: the editor's extensions hold the body of a fork of each built-in template unchanged.
//   BUG-T20: conditional text (the `if` node) loads and reads back unchanged; the editor refuses it where the format does.
//   BUG-T123: Insert never offers columns under a column, and a paste under a column brings no columns node in.
//   BUG-T50: a color swatch is named by its readable name, never by its raw token (Nora QA Nov 4, #420 criterion 13).
//   AC:CASE-DOC-016 (T-100): a plain document holds T-16's table in its plain set; Insert adds the plain table and
//   checklist rows and never a budget; a pasted Church Document table is reduced so the editor JSON stays a native body.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	docDocument,
	FORMAT_SCHEMA,
	forkTemplate,
	nativeBody,
} from "../../../packages/contracts/src/documents/index.ts";
import { DOC_TEMPLATES } from "../../../packages/domain/src/documents/doc-templates.ts";
import {
	clean,
	documentFrom,
	editorContent,
} from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { TOKEN_NAMES, TOKENS } from "../../../apps/web/src/features/documents/church/editor/layout.ts";
import { editorSchema, nativeSchema, stateAt } from "../../../apps/web/src/features/documents/church/editor/schema.ts";
import { conditionIssue } from "../../../apps/web/src/features/documents/church/editor/condition-extension.ts";
import { canInsert, insertBlock } from "../../../apps/web/src/features/documents/church/editor/blocks.ts";
import { pastedSlice, plainPastedSlice } from "../../../apps/web/src/features/documents/church/editor/extensions.ts";
import { blocksFromEditor, blocksToEditor } from "../../../apps/web/src/features/documents/church/editor/table-json.ts";
import { newBudget } from "../../../apps/web/src/features/documents/church/editor/table-ops.ts";

import { fieldValues, frozenData } from "../../../packages/domain/src/documents/doc-values.ts";

const ROOT = join(import.meta.dirname, "../../..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

/** Every workspace package.json: the root, apps/* and packages/*. */
function workspacePackages() {
	const dirs = [ROOT, ...["apps", "packages"].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => join(ROOT, d, n)))];
	return dirs.filter((d) => existsSync(join(d, "package.json")));
}

test("INV-license: each Tiptap package the workspace depends on is installed under the MIT license", () => {
	const found: string[] = [];
	for (const dir of workspacePackages()) {
		const manifest = readJson(join(dir, "package.json"));
		const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
		for (const name of Object.keys(deps)) {
			assert.ok(!name.startsWith("@tiptap-pro/"), `${dir}: ${name} is a paid Tiptap package`);
			if (!name.startsWith("@tiptap/")) continue;
			const installed = join(dir, "node_modules", name, "package.json");
			assert.ok(existsSync(installed), `${name} is not installed in ${dir}`);
			assert.equal(readJson(installed).license, "MIT", `${name} is not MIT`);
			found.push(name);
		}
	}
	assert.ok(found.includes("@tiptap/react"), "the web app depends on @tiptap/react");
});

const schema = editorSchema();

for (const template of DOC_TEMPLATES) {
	test(`AC:CASE-DOC-022 a fork of ${template.id} loads into the editor schema and reads back unchanged`, async () => {
		const doc = await forkTemplate(template);
		const node = schema.nodeFromJSON(editorContent(doc));
		node.check();
		const back = documentFrom(doc, node.toJSON());
		assert.deepStrictEqual(back, clean(doc));
		assert.equal(docDocument.safeParse(back).success, true, "the document parses with docDocument");
	});
}

test("AC:CASE-DOC-020-EDIT a slot (a doctrinal section, in no built-in template) keeps every attribute and child", () => {
	const slot = {
		type: "doc",
		content: [
			{
				type: "slot",
				attrs: { label: "Statement of faith" },
				content: [{ type: "paragraph", content: [{ type: "text", text: "We believe." }] }],
			},
		],
	};
	assert.deepStrictEqual(clean(schema.nodeFromJSON(slot).toJSON()), slot);
});

test("BUG-9ff6b1a67: each color token of the format has a swatch with its own readable name, never the raw token", () => {
	const tokens = FORMAT_SCHEMA.tokens.color as readonly (keyof typeof TOKEN_NAMES)[];
	assert.deepEqual([...TOKENS], [...tokens], "one swatch for each color token, in the format's order");
	// A readable name is capitalized words, so a raw token such as "ink" or "muted-text" never passes.
	const unreadable = tokens.filter((token) => !/^[A-Z][a-z]*( [a-z]+)*$/.test(TOKEN_NAMES[token] ?? ""));
	assert.deepEqual(unreadable, []);
	assert.equal(new Set(tokens.map((token) => TOKEN_NAMES[token])).size, tokens.length, "no two swatches share a name");
});

test("BUG-64ca105ce: a commitment card with a stored empty contact_line shows nothing in the editor, not [Contact line]", async () => {
	const card = DOC_TEMPLATES.find((t) => t.id === "commitment-card")!;
	const sources = {
		churchName: "Harbor City Church",
		pastorName: null,
		tagline: null,
		legalName: null,
		contactLine: null,
		meetingDate: null,
	};
	const empty = await forkTemplate(card, { data: frozenData(card.fields, sources).data });
	assert.equal(empty.data?.contact_line, "");
	const values = fieldValues(empty);
	assert.equal(values.contact_line, "");
	assert.ok(!Object.values(values).some((v) => /\[contact line\]/i.test(v)));
	// A brand kit with a contact line prints it; a field with no value and no fallback still shows its label in brackets.
	const filled = await forkTemplate(card, {
		data: frozenData(card.fields, { ...sources, contactLine: "harborcity.church  ·  (555) 010-0199" }).data,
	});
	assert.equal(fieldValues(filled).contact_line, "harborcity.church  ·  (555) 010-0199");
	assert.equal(fieldValues(filled).church_name, "Harbor City Church");
	const bare = await forkTemplate(card, { data: {} });
	assert.equal(fieldValues(bare).church_name, "[church name]");
});

test("BUG-58bc5acb8: conditional text loads into the editor and reads back unchanged, in the body, a column and a box", async () => {
	const fork = await forkTemplate(
		DOC_TEMPLATES.find((t) => t.id === "commitment-card")!,
		{ data: {} },
	);
	const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
	const body = {
		type: "doc",
		content: [
			{ type: "if", attrs: { field: "church_tagline", test: "has-value" }, content: [p("A"), { type: "pageBreak" }] },
			{
				type: "columns",
				content: [
					{
						type: "column",
						content: [{ type: "if", attrs: { field: "contact_line", test: "is-empty" }, content: [p("B")] }],
					},
					{ type: "column", content: [p("C")] },
				],
			},
			{ type: "box", content: [{ type: "if", attrs: { field: "church_name", test: "has-value" }, content: [p("D")] }] },
		],
	};
	const doc = { ...fork, body } as typeof fork;
	assert.equal(docDocument.safeParse(doc).success, true, "the document parses with docDocument");
	const node = schema.nodeFromJSON(editorContent(doc));
	node.check();
	assert.equal(conditionIssue(node), null);
	assert.deepStrictEqual(documentFrom(doc, node.toJSON()), clean(doc));
});

test("BUG-58bc5acb8: the editor refuses conditional text where the format refuses it, each with its reason", () => {
	const p = { type: "paragraph", content: [{ type: "text", text: "x" }] };
	const cond = (content: unknown[]) => ({ type: "if", attrs: { field: "a", test: "has-value" }, content });
	const ledger = {
		type: "table",
		attrs: { style: "ledger", columns: [{ id: "item", label: "Item", type: "text", width: 0 }] },
		content: [{ type: "row", content: [{ type: "cell" }] }],
	};
	const cases: [unknown, RegExp][] = [
		[
			{ type: "doc", content: [{ type: "pageHeader", attrs: { pages: "all" }, content: [cond([p])] }] },
			/page header or footer/,
		],
		[{ type: "doc", content: [cond([cond([p])])] }, /another conditional text/],
		[{ type: "doc", content: [cond([{ type: "slot", content: [p] }])] }, /section slot/],
		[{ type: "doc", content: [cond([ledger])] }, /budget table/],
		[
			{ type: "doc", content: [{ type: "box", content: [cond([{ type: "box", content: [p] }])] }] },
			/cannot hold a box/,
		],
		[
			{
				type: "doc",
				content: [
					{
						type: "columns",
						content: [
							{ type: "column", content: [cond([{ type: "pageBreak" }])] },
							{ type: "column", content: [p] },
						],
					},
				],
			},
			/cannot hold a page break/,
		],
	];
	for (const [json, reason] of cases) assert.match(conditionIssue(schema.nodeFromJSON(json)) ?? "", reason);
});

test("AC:CASE-DOC-016: the plain document editor holds a native body unchanged, and its JSON is a native body", () => {
	const native = nativeSchema();
	const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
	const body = {
		type: "doc",
		content: [
			{ type: "heading", attrs: { level: 1 }, content: [text("Our values")] },
			{
				type: "paragraph",
				content: [
					text("We ", [{ type: "bold" }, { type: "italic" }]),
					text("serve", [{ type: "underline" }]),
					{ type: "hardBreak" },
					text("Austin", [{ type: "link", attrs: { href: "mailto:hello@example.org" } }]),
				],
			},
			{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("One")] }] }] },
			{
				type: "orderedList",
				content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("Two")] }] }],
			},
			{ type: "quote", content: [{ type: "paragraph", content: [text("Love")] }] },
			{ type: "divider" },
			{ type: "paragraph" },
		],
	};
	const json = clean(native.nodeFromJSON(body).toJSON());
	assert.deepEqual(json, body);
	assert.equal(nativeBody.safeParse(json).success, true);
	for (const name of ["slot", "field", "image", "columns", "box", "writeIn", "pageHeader", "spacer", "pageBreak", "if"])
		assert.equal(native.nodes[name], undefined, `the plain editor has a ${name} node`);
	assert.equal(native.marks.tag, undefined);
});

// BUG-T123: a body with a box in a column, a plain column and a body paragraph, each holding one marked word.
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const layoutBody = {
	type: "doc",
	content: [
		{
			type: "columns",
			content: [
				{ type: "column", content: [{ type: "box", content: [para("inbox")] }] },
				{ type: "column", content: [para("incolumn")] },
			],
		},
		para("inbody"),
	],
};
/** The editor state with the cursor at the end of the word. */
function caretIn(word: string) {
	const doc = schema.nodeFromJSON(layoutBody);
	let at = -1;
	doc.descendants((node, pos) => {
		if (node.isText && node.text === word) at = pos + word.length;
	});
	return stateAt(doc, at);
}
type Doc = ReturnType<typeof schema.nodeFromJSON>;
function columnsUnderColumn(doc: Doc) {
	let found = false;
	const walk = (node: Doc, inColumn: boolean) => {
		if (inColumn && node.type.name === "columns") found = true;
		node.forEach((child) => walk(child, inColumn || node.type.name === "column"));
	};
	walk(doc, false);
	return found;
}

test("BUG-58bc5acb8: Insert offers no columns in a box in a column or in a column, and still offers them in the body", () => {
	const kinds = ["columns2", "columns3", "columns4"] as const;
	for (const word of ["inbox", "incolumn"])
		for (const kind of kinds) assert.equal(canInsert(caretIn(word), kind), false, `${kind} at ${word}`);
	for (const kind of kinds) assert.equal(canInsert(caretIn("inbody"), kind), true, `${kind} in the body`);
	assert.equal(canInsert(caretIn("inbox"), "paragraph"), true, "other blocks still insert in the box");
});

test("BUG-58bc5acb8: a pasted columns node under a column gives way to its blocks, and the document saves", async () => {
	const fork = await forkTemplate(
		DOC_TEMPLATES.find((t) => t.id === "commitment-card")!,
		{ data: {} },
	);
	// The copied content: a whole columns node, as a slice of a source document.
	const source = schema.nodeFromJSON({
		type: "doc",
		content: [
			{
				type: "columns",
				content: [
					{ type: "column", content: [para("left")] },
					{ type: "column", content: [para("right"), { type: "box", content: [para("boxed")] }] },
				],
			},
		],
	});
	const whole = source.slice(0, source.content.size);
	for (const word of ["inbox", "incolumn"]) {
		const state = caretIn(word);
		const raw = state.apply(state.tr.replaceSelection(whole));
		const slice = pastedSlice(whole, state);
		const after = state.apply(state.tr.replaceSelection(slice)).doc;
		after.check();
		assert.equal(columnsUnderColumn(after), false, `no columns under a column at ${word}`);
		assert.match(after.textContent, /left/);
		assert.match(after.textContent, /right/);
		const doc = documentFrom(fork, after.toJSON());
		assert.equal(docDocument.safeParse(doc).success, true, `the document saves after a paste at ${word}`);
		if (word === "inbox") {
			// Without the transform the paste lands a columns node in the box, which Save refuses.
			assert.equal(columnsUnderColumn(raw.doc), true);
			assert.equal(docDocument.safeParse(documentFrom(fork, raw.doc.toJSON())).success, false);
		}
	}
	// A slice copied from inside a column, open through columns and column, pastes as its text.
	const state = caretIn("inbox");
	// Copied from inside "left" to inside "boxed": with its columns parent, as the editor copies, and as bare columns.
	for (const open of [source.slice(4, source.content.size - 4, true), source.slice(4, source.content.size - 4)]) {
		const after = state.apply(state.tr.replaceSelection(pastedSlice(open, state))).doc;
		after.check();
		assert.equal(columnsUnderColumn(after), false);
		assert.match(after.textContent, /ftrightbox/);
		assert.equal(docDocument.safeParse(documentFrom(fork, after.toJSON())).success, true);
	}
	// Outside a column a pasted columns node stays.
	const body = caretIn("inbody");
	const kept = pastedSlice(whole, body);
	assert.equal(kept.content.firstChild?.type.name, "columns");
});

// T-100: a plain body with a table of every column kind, marks in a cell, stripes and a checklist.
const cell = (text?: string, marks?: unknown[]) =>
	text ? { type: "cell", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] } : { type: "cell" };
const everyKind = {
	type: "table",
	attrs: {
		style: "grid",
		header: true,
		zebra: true,
		columns: [
			{ id: "name", label: "Name", type: "text", width: 0 },
			{ id: "count", label: "Count", type: "number", width: 0 },
			{ id: "cost", label: "Cost", type: "money", width: 0 },
			{ id: "done", label: "Done", type: "check", width: 0 },
			{ id: "n", label: "No.", type: "index", width: 0 },
		],
	},
	content: [
		{
			type: "row",
			content: [
				cell("Chairs", [{ type: "link", attrs: { href: "https://example.org" } }, { type: "bold" }]),
				{ type: "cell", attrs: { value: 40 } },
				{ type: "cell", attrs: { value: 1250.5 } },
				{ type: "cell", attrs: { checked: true } },
				cell(),
			],
		},
		{ type: "row", content: [cell("Tables", [{ type: "italic" }]), cell(), cell(), cell(), cell()] },
	],
};
const checklist = {
	type: "table",
	attrs: {
		style: "rows",
		header: false,
		columns: [
			{ id: "done", label: "Done", type: "check", width: 18 },
			{ id: "commitment", label: "Commitment", type: "text", width: 0 },
		],
	},
	content: [
		{ type: "row", content: [{ type: "cell", attrs: { checked: true } }, cell("Pray", [{ type: "underline" }])] },
	],
};
const plainWithTables = {
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text: "Setup" }] }, everyKind, checklist],
};

/** The plain editor's document as the stored body node, as NativeEditor saves it. */
const storedOf = (doc: Doc) => {
	const json = clean(doc.toJSON()) as { content?: unknown[] };
	return { ...json, content: blocksFromEditor(json.content ?? []) };
};

test("AC:CASE-DOC-016: a plain body with tables loads into the plain editor and reads back unchanged", () => {
	const native = nativeSchema();
	assert.equal(nativeBody.safeParse(plainWithTables).success, true);
	const node = native.nodeFromJSON({ ...plainWithTables, content: blocksToEditor(plainWithTables.content) });
	node.check();
	assert.deepEqual(storedOf(node), plainWithTables);
});

test("AC:CASE-DOC-016: Insert in a plain document adds the plain table and checklist rows, and never a budget", () => {
	const native = nativeSchema();
	const start = native.nodeFromJSON({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
	});
	assert.equal(canInsert(stateAt(start, 3), "budget"), false, "a plain document offers no budget table");
	assert.equal(canInsert(caretIn("inbody"), "budget"), true, "a Church Document keeps its budget table");
	const inserted = (kind: "table" | "checklist") => {
		let state = stateAt(start, 3);
		const editor = {
			get state() {
				return state;
			},
			view: { dispatch: (tr: Parameters<typeof state.apply>[0]) => void (state = state.apply(tr)), focus() {} },
		};
		assert.equal(insertBlock(editor as never, kind), true);
		const body = storedOf(state.doc);
		assert.equal(nativeBody.safeParse(body).success, true, `${kind} keeps the body native`);
		return (body.content as unknown[])[1];
	};
	const empty = (n: number) => ({ type: "row", content: Array.from({ length: n }, () => ({ type: "cell" })) });
	assert.deepEqual(inserted("table"), {
		type: "table",
		attrs: {
			style: "grid",
			header: true,
			columns: [1, 2, 3].map((i) => ({ id: `column_${i}`, label: `Column ${i}`, type: "text", width: 0 })),
		},
		content: [empty(3), empty(3), empty(3)],
	});
	assert.deepEqual(inserted("checklist"), { ...checklist, content: [empty(2), empty(2), empty(2)] });
});

test("AC:CASE-DOC-016: a pasted budget, header color or write-in table is reduced to a native table", () => {
	const native = nativeSchema();
	const tagged = { ...cell("Gifts"), content: [{ type: "text", text: "Gifts" }] };
	const budget = newBudget();
	budget.content![1]!.content = [tagged as never, { type: "cell", attrs: { value: 500 } }];
	const colored = { ...everyKind, attrs: { ...everyKind.attrs, headerFill: "primary" } };
	const writeIns = { ...checklist, attrs: { ...checklist.attrs, headerFill: "none", writeInRows: 2 } };
	const start = native.nodeFromJSON({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
	});
	// What the plain schema parses from a Church Document's clipboard: T-16's table with every attribute it has.
	const copied = (table: unknown) => {
		const source = native.nodeFromJSON({ type: "doc", content: blocksToEditor([table]) });
		return source.slice(0, source.content.size);
	};
	const paste = (table: unknown) => stateAt(start, 3).tr.replaceSelection(plainPastedSlice(copied(table))).doc;
	for (const table of [budget, colored, writeIns]) {
		const raw = stateAt(start, 3).tr.replaceSelection(copied(table)).doc;
		assert.equal(nativeBody.safeParse(storedOf(raw)).success, false, "without the reduction the body is refused");
		const after = paste(table);
		after.check();
		const body = storedOf(after);
		assert.equal(nativeBody.safeParse(body).success, true, JSON.stringify(body));
	}
	// The budget keeps what each cell showed: its labels and amounts, totals included, in plain rows.
	const after = paste(budget);
	const table = (
		storedOf(after).content as { type: string; content?: { content: { attrs?: { value?: number } }[] }[] }[]
	).find((n) => n.type === "table")!;
	assert.deepEqual(
		table.content!.map((row) => row.content[1]!.attrs?.value ?? null),
		[null, 500, 500, 500],
	);
	// Write-in rows become typed rows: the checklist's row and its two blank rows.
	const fromWriteIns = paste(writeIns);
	const rows = (storedOf(fromWriteIns).content as { type: string; content?: unknown[] }[]).find(
		(n) => n.type === "table",
	)!.content!;
	assert.equal(rows.length, 3);
});
