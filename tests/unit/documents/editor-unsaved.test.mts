import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { Editor } = await import(pathToFileURL(root + "apps/web/node_modules/@tiptap/core/dist/index.js").href);
const documents = "../../../apps/web/src/features/documents/";
const { forkTemplate } = await import("../../../packages/contracts/src/documents/index.ts");
const { DOC_TEMPLATES } = await import("../../../packages/domain/src/documents/doc-templates.ts");
const { createChurchEditorStore } = await import(documents + "church/editor/ChurchEditor.store.ts");
const { createNativeEditorStore } = await import(documents + "written/NativeEditor.store.ts");
const { editorContent } = await import(documents + "church/editor/document-json.ts");
const { editorExtensions, nativeExtensions } = await import(documents + "church/editor/extensions.ts");

const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Opening line." }] }] };
const church = await forkTemplate(
	DOC_TEMPLATES.find((t) => t.id === "commitment-card")!,
	{ data: {} },
);
const held = () => {
	let answer: (value: unknown) => void = () => {};
	const reply = new Promise((resolve) => (answer = resolve));
	return { reply, answer: (value: unknown) => answer(value) };
};

const EDITORS = {
	"church document": () => {
		const { reply, answer } = held();
		const editor = new Editor({ element: null, extensions: editorExtensions(), content: editorContent(church) });
		const store = createChurchEditorStore({
			docId: "d",
			revision: "1",
			body: church,
			port: { save: () => reply },
		});
		store.setState({ saved: { ...store.getState().saved, doc: editor.state.doc } });
		const save = () => store.getState().actions.save(editor, () => {});
		return { editor, store, save, saved: () => answer({ status: "saved", revision: "2" }) };
	},
	"written document": () => {
		const { reply, answer } = held();
		const editor = new Editor({ element: null, extensions: nativeExtensions(), content });
		const store = createNativeEditorStore({
			doc: { id: "d", revision: "1", title: "Plan", kind: "native", textRevision: false } as never,
			port: { save: () => reply } as never,
		});
		store.setState({ saved: { ...store.getState().saved, doc: editor.state.doc } });
		const save = () => store.getState().actions.save(editor);
		return {
			editor,
			store,
			save,
			saved: () => answer({ status: "ok", value: { id: "d", revision: "2", kind: "native" } }),
		};
	},
};

for (const [name, open] of Object.entries(EDITORS))
	test(`INV-save-order: ${name}: the editor is unsaved while its save chain runs a save, whatever its phase says`, async () => {
		const { editor, store, save, saved } = open();
		const unsaved = () => store.getState().actions.unsaved(editor);
		assert.equal(unsaved(), false, "nothing to save");
		store.setState({ phase: { kind: "saving" } });
		assert.equal(unsaved(), false, "the phase alone is not a save");

		const running = save();
		assert.equal(unsaved(), true, "a save runs");
		store.setState({ phase: { kind: "idle" } });
		assert.equal(unsaved(), true, "a save still runs");
		saved();
		assert.equal(await running, true);
		assert.equal(unsaved(), false, "the save is done");
	});
