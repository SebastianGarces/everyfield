import type { BlockNode, ChurchBlock, DocDocument, InlineNode, ParagraphNode } from "@everyfield/contracts/documents";
import { sql } from "@everyfield/db/query";

// DOC-020, CASE-DOC-020 `network-fills-slot`: a Church Document made from a template starts with the sending
// network's statement of faith in each slot keyed `statement-of-faith` (D-106). The text is read once, at creation
// (D-109): a later change to the network's text never reaches a document that already exists. A preview or a saved
// file of the template prints the text as it stands when that action runs (T-85, D-417, D-418).

/** The slot key the network's statement of faith fills. */
const STATEMENT_OF_FAITH_KEY = "statement-of-faith";

/**
 * A scalar subquery for a SELECT list: the statement of the plant's earliest-accepted active affiliation whose
 * organization has one (D-108). An ended affiliation never fills. The database never holds blank text.
 */
export const networkStatementSql = (plantId: string) =>
	sql`SELECT o.statement_of_faith FROM affiliation a JOIN organization o ON o.id = a.organization_id
		WHERE a.plant_id = ${plantId}::uuid AND a.ended_at IS NULL AND o.statement_of_faith IS NOT NULL
		ORDER BY a.accepted_at, a.id LIMIT 1`;

/**
 * A template preview's body with every `statement-of-faith` slot holding the network's text, which the layout prints
 * one paragraph per blank-line-separated block. With no text the body is returned unchanged: the marked blank.
 */
export function fillStatementBlocks(body: ChurchBlock[], statement: string | null): ChurchBlock[] {
	if (statement === null) return body;
	return body.map((block) =>
		block.kind === "slot" && block.slotId === STATEMENT_OF_FAITH_KEY ? { ...block, text: statement } : block,
	);
}

/**
 * The network's text as paragraphs: one per blank-line-separated block, a single line break kept as a break. The
 * organization write already turned CRLF into LF and trimmed it.
 */
export function statementParagraphs(text: string): ParagraphNode[] {
	return text
		.split(/\n[ \t]*\n/)
		.map((block) => block.replace(/^\n+|\n+$/g, ""))
		.filter((block) => block.trim() !== "")
		.map((block) => ({
			type: "paragraph",
			content: block.split("\n").flatMap((line, i): InlineNode[] => {
				const text: InlineNode[] = line ? [{ type: "text", text: line }] : [];
				return i === 0 ? text : [{ type: "hardBreak" }, ...text];
			}),
		}));
}

/**
 * The document with every `statement-of-faith` slot holding the network's text under its label. With no text (the
 * database never holds blank text), the document is returned unchanged, so the slot stays as the template authored it
 * (the marked blank when empty). A slot with no key or another key is never touched.
 */
export function fillStatementSlots(doc: DocDocument, statement: string | null): DocDocument {
	if (statement === null) return doc;
	const paragraphs = statementParagraphs(statement);
	const fill = (node: BlockNode): BlockNode => {
		switch (node.type) {
			case "slot":
				return node.attrs?.key === STATEMENT_OF_FAITH_KEY ? { ...node, content: structuredClone(paragraphs) } : node;
			case "box":
				return node.content ? { ...node, content: node.content.map(fill) } : node;
			case "columns":
				return {
					...node,
					content: node.content.map((column) =>
						column.content ? { ...column, content: column.content.map(fill) } : column,
					),
				};
			default:
				return node;
		}
	};
	return doc.body.content ? { ...doc, body: { ...doc.body, content: doc.body.content.map(fill) } } : doc;
}
