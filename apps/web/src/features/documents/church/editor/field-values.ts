import type { DocDocument } from "@everyfield/contracts/documents";
import { fieldValues as printedValues } from "@everyfield/domain/documents/values";
import type { FieldValues } from "./extensions.ts";

/**
 * The text each merge field shows on the editor's paper page: the same text the PDF and the Word file print. A stored
 * empty value (an empty fallback) shows nothing, never the field's label in brackets.
 */
export function fieldValues(doc: DocDocument): FieldValues {
	return printedValues(doc);
}
