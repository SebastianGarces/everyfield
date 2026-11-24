import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { NodeSelection } = await import(
	pathToFileURL(root + "apps/web/node_modules/@tiptap/pm/dist/state/index.js").href
);
const dir = "../../../apps/web/src/features/documents/church/editor/";
const { canInsert, canMove, canWrap, currentBlock, deleteBlock, insertBlock, moveBlock, removeCondition, wrapBlock } =
	await import(dir + "blocks.ts");
const { editorSchema, stateAt } = await import(dir + "schema.ts");
const { conditionIssue } = await import(dir + "condition-extension.ts");
const { Swatches } = await import(dir + "ControlParts.tsx");
const { TOKEN_NAMES, TOKENS } = await import(dir + "layout.ts");

const schema = editorSchema();
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const CONDITION = { field: "field", test: "has-value" };
const doc = schema.nodeFromJSON({
	type: "doc",
	content: [
		{ type: "pageHeader", attrs: { pages: "all" }, content: [para("header")] },
		para("first"),
		{ type: "if", attrs: CONDITION, content: [para("conditional")] },
		para("last"),
		{ type: "pageFooter", attrs: { pages: "all" }, content: [para("footer")] },
	],
});
type Node = typeof doc;
const posOf = (word: string) => {
	let at = -1;
	doc.descendants((node: Node, pos: number) => {
		if (node.isText && node.text === word) at = pos + 1;
	});
	assert.ok(at >= 0, word);
	return at;
};
const caret = (word: string) => stateAt(doc, posOf(word));
const selected = (index: number) => {
	let pos = 0;
	for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
	const state = stateAt(doc, posOf("first"));
	return state.apply(state.tr.setSelection(NodeSelection.create(doc, pos)));
};
function editorOn(state: ReturnType<typeof caret>) {
	const editor = {
		state,
		view: {
			focus() {},
			dispatch(tr: { doc: Node }) {
				editor.state = editor.state.apply(tr);
			},
		},
	};
	return editor;
}
const regions = (at: Node) => [at.firstChild?.toJSON(), at.lastChild?.toJSON()];
const own = regions(doc);

test("INV-page-regions: with the caret in, or a selection on, the page header or footer, no body command has a block to select, move or delete", () => {
	for (const state of [caret("header"), caret("footer"), selected(0), selected(doc.childCount - 1)]) {
		assert.ok(currentBlock(state) === null);
		for (const direction of [-1, 1] as const) {
			assert.equal(canMove(state, direction), false);
			const editor = editorOn(state);
			assert.equal(moveBlock(editor, direction), false);
			assert.ok(editor.state.doc.eq(doc));
		}
		const editor = editorOn(state);
		assert.equal(deleteBlock(editor), false);
		assert.ok(editor.state.doc.eq(doc));
	}
});

test("INV-page-regions: the first and last body blocks never trade places with the header or footer", () => {
	assert.equal(canMove(caret("first"), -1), false);
	assert.equal(canMove(caret("last"), 1), false);
	assert.equal(canMove(caret("first"), 1), true);
	assert.equal(canMove(caret("last"), -1), true);
	for (const word of ["first", "conditional", "last"])
		for (const run of [
			deleteBlock,
			(e: unknown) => moveBlock(e, -1),
			(e: unknown) => moveBlock(e, 1),
			(e: unknown) => insertBlock(e, "divider"),
		]) {
			const editor = editorOn(caret(word));
			run(editor);
			assert.deepEqual(regions(editor.state.doc), own, word);
		}
});

test("INV-page-regions: a block inserted while the header or footer is selected lands in the body", () => {
	for (const state of [selected(0), selected(doc.childCount - 1)]) {
		const editor = editorOn(state);
		assert.equal(insertBlock(editor, "divider"), true);
		assert.deepEqual(regions(editor.state.doc), own);
	}
});

test("INV-conditional-text: conditional text is not offered, and is refused, in the page header, the page footer and other conditional text", () => {
	for (const word of ["header", "footer"]) {
		const editor = editorOn(caret(word));
		assert.equal(canInsert(editor.state, "if"), false, word);
		assert.equal(canWrap(editor.state), false, word);
		assert.equal(insertBlock(editor, "if", "", CONDITION), false, word);
		assert.equal(wrapBlock(editor, CONDITION), false, word);
		assert.ok(editor.state.doc.eq(doc), word);
	}
	assert.equal(canWrap(caret("conditional")), false);
	assert.equal(wrapBlock(editorOn(caret("conditional")), CONDITION), false);
	const beside = editorOn(caret("conditional"));
	insertBlock(beside, "if", "", CONDITION);
	assert.equal(conditionIssue(beside.state.doc), null, "a new condition goes beside the one the caret is in");
	assert.equal(canInsert(caret("first"), "if"), true);
	assert.equal(canWrap(caret("first")), true);
	const unwrapped = editorOn(caret("conditional"));
	assert.equal(removeCondition(unwrapped, 0), false, "the header is no condition");

	const nested = (type: string) =>
		schema.nodeFromJSON({
			type: "doc",
			content: [
				{
					type,
					...(type === "if" ? { attrs: CONDITION } : { attrs: { pages: "all" } }),
					content: [{ type: "if", attrs: CONDITION, content: [para("x")] }],
				},
			],
		});
	assert.match(conditionIssue(nested("pageHeader")), /page header or footer/);
	assert.match(conditionIssue(nested("pageFooter")), /page header or footer/);
	assert.match(conditionIssue(nested("if")), /another conditional text/);
});

test("INV-color-tokens: the color control offers exactly the format's tokens, with no hex field and no color picker", () => {
	const palette = Object.fromEntries(
		["ink", "mutedText", "primary", "accent", "muted", "border"].map((name) => [name, "rgb(0 0 0)"]),
	);
	const html: string = renderToStaticMarkup(
		createElement(Swatches, { label: "Color", value: "ink", palette, onChange: () => {} }),
	);
	const controls = [...html.matchAll(/<(button|input|select|textarea|a)\b([^>]*)>/g)].map(([, tag, attributes]) => ({
		tag,
		token: /data-token="([^"]*)"/.exec(attributes!)?.[1],
		name: /aria-label="([^"]*)"/.exec(attributes!)?.[1],
	}));
	assert.deepEqual(
		controls,
		TOKENS.map((token: keyof typeof TOKEN_NAMES) => ({ tag: "button", token, name: TOKEN_NAMES[token] })),
	);
	assert.doesNotMatch(html, /contenteditable/i);
});
