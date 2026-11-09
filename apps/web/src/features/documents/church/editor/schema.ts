import { getSchema } from "@tiptap/core";
import { editorExtensions, nativeExtensions } from "./extensions.ts";

/** The ProseMirror schema of the editor's extensions, for tests. */
export const editorSchema = () => getSchema(editorExtensions());
/** The schema of the plain document editor, for tests. */
export const nativeSchema = () => getSchema(nativeExtensions());
