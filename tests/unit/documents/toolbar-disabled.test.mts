import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { Editor } = await import(pathToFileURL(root + "apps/web/node_modules/@tiptap/core/dist/index.js").href);
const editorDir = "../../../apps/web/src/features/documents/church/editor/";
const { editorExtensions } = await import(editorDir + "extensions.ts");
const { MarkButton } = await import(editorDir + "tiptap/ui/mark-button.tsx");
const { ListButton } = await import(editorDir + "tiptap/ui/list-button.tsx");
const { BlockquoteButton } = await import(editorDir + "tiptap/ui/blockquote-button.tsx");
const { UndoRedoButton } = await import(editorDir + "tiptap/ui/undo-redo-button.tsx");

function editorWith({ imageSelected }: { imageSelected: boolean }) {
	const editor = new Editor({
		element: null,
		extensions: editorExtensions(),
		content: {
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Welcome" }] },
				{ type: "image", attrs: { source: "logo" } },
			],
		},
	});
	if (imageSelected) {
		assert.equal(editor.commands.setNodeSelection(editor.state.doc.child(0).nodeSize), true);
	} else {
		editor.commands.setTextSelection(2);
	}
	return editor;
}

function buttonTag(html: string) {
	const tag = html.match(/<button\b[^>]*>/)?.[0];
	assert.ok(tag, `no button in ${html}`);
	return tag;
}

const buttons = [
	["Bold", (editor: unknown) => createElement(MarkButton, { editor, type: "bold" })],
	["Bulleted list", (editor: unknown) => createElement(ListButton, { editor, type: "bulletList" })],
	["Quote", (editor: unknown) => createElement(BlockquoteButton, { editor })],
] as const;

for (const [label, button] of buttons) {
	test(`BUG-PR551: an enabled ${label} button renders no data-disabled attribute`, () => {
		const tag = buttonTag(renderToStaticMarkup(button(editorWith({ imageSelected: false }))));
		assert.match(tag, new RegExp(`aria-label="${label}"`));
		assert.doesNotMatch(tag, /\sdisabled=/);
		assert.doesNotMatch(tag, /data-disabled/);
	});

	test(`BUG-PR551: a disabled ${label} button renders data-disabled="true"`, () => {
		const tag = buttonTag(renderToStaticMarkup(button(editorWith({ imageSelected: true }))));
		assert.match(tag, new RegExp(`aria-label="${label}"`));
		assert.match(tag, /\sdisabled=""/);
		assert.match(tag, /\sdata-disabled="true"/);
	});
}

test('BUG-PR551: Undo with nothing to undo renders data-disabled="true"', () => {
	const tag = buttonTag(
		renderToStaticMarkup(
			createElement(UndoRedoButton, { editor: editorWith({ imageSelected: false }), action: "undo" }),
		),
	);
	assert.match(tag, /aria-label="Undo"/);
	assert.match(tag, /\sdata-disabled="true"/);
});
