import { getSchema } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { editorExtensions, nativeExtensions } from "./extensions.ts";

/** The ProseMirror schema of the editor's extensions, for tests. */
export const editorSchema = () => getSchema(editorExtensions());
/** The schema of the plain document editor, for tests. */
export const nativeSchema = () => getSchema(nativeExtensions());
/** An editor state of this document with the cursor at `pos`, for tests. */
export const stateAt = (doc: PMNode, pos: number) =>
	EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
