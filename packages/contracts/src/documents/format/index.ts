import { z } from "zod";
import { validate } from "./rules.ts";
import type { DocDocument, DocTemplate, EveryfieldDoc } from "./types.ts";

export * from "./types.ts";
export { FORMAT_SCHEMA } from "./schema.ts";
export {
	attrsOf,
	blankDocument,
	computeTable,
	forkTemplate,
	pageBox,
	parseFormula,
	templateHash,
	tileBox,
	type Formula,
} from "./rules.ts";

/**
 * The zod parser for one everyfield.doc/1 file. It runs every schema and format rule and reports each fault as one
 * issue, "<path>: <message>", in the words of design/doc-format/approach-a/format.js.
 */
function docParser<T extends EveryfieldDoc>(kind?: T["kind"]) {
	return z.unknown().transform((value, ctx): T => {
		const result = validate(value);
		const errors = [...result.errors];
		if (kind && result.ok && (value as EveryfieldDoc).kind !== kind)
			errors.push(`kind: this place takes a ${kind}, not a ${(value as EveryfieldDoc).kind}`);
		for (const message of errors) ctx.addIssue({ code: "custom", message });
		return errors.length ? z.NEVER : (value as T);
	});
}

/** A template or a document. */
export const everyfieldDoc = docParser<EveryfieldDoc>();
/** A template: the file a document is forked from. */
export const docTemplate = docParser<DocTemplate>("template");
/** A document: what a Church Document revision stores. */
export const docDocument = docParser<DocDocument>("document");
