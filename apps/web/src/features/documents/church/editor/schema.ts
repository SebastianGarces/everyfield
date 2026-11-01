import { getSchema } from "@tiptap/core";
import { editorExtensions, type FieldValues } from "./extensions.ts";

/** The ProseMirror schema of the editor's extensions, for tests. */
export const editorSchema = (values: FieldValues = {}) => getSchema(editorExtensions(values));
