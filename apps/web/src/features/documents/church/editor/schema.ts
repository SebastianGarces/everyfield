import { getSchema } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { editorExtensions, nativeExtensions } from "./extensions.ts";

export const editorSchema = () => getSchema(editorExtensions());
export const nativeSchema = () => getSchema(nativeExtensions());
export const stateAt = (doc: PMNode, pos: number) =>
	EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
