// WP-036 slice 2: the editor's free parts and its schema. No browser, no database.
//   AC:CASE-DOC-016: the plain document editor (OPS-87) holds a native body unchanged and has no template-only node.
//   AC:DOC-EDIT-FREE: every Tiptap package the workspace installs is MIT; no @tiptap-pro package. The private-registry
//   check is scripts/lint/check-repo-files.mjs, which `pnpm lint` runs.
//   AC:DOC-EDIT-SCHEMA: the editor's extensions hold the body of a fork of each built-in template unchanged.
//   BUG-T20: conditional text (the `if` node) loads and reads back unchanged; the editor refuses it where the format does.
//   BUG-T123: Insert never offers columns under a column, and a paste under a column brings no columns node in.
//   BUG-T50: a color swatch is named by its readable name, never by its raw token (Nora QA Nov 4, #420 criterion 13).
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
import { canInsert } from "../../../apps/web/src/features/documents/church/editor/blocks.ts";
import { pastedSlice } from "../../../apps/web/src/features/documents/church/editor/extensions.ts";

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
	for (const name of [
		"slot",
		"field",
		"image",
		"table",
		"columns",
		"box",
		"writeIn",
		"pageHeader",
		"spacer",
		"pageBreak",
		"if",
	])
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
