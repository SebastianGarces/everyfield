import { getSchema } from "@tiptap/core";
import { editorExtensions } from "./extensions.ts";

/** The ProseMirror schema of the editor's extensions, for tests. */
export const editorSchema = () => getSchema(editorExtensions());
