import type { BlockNode, DocDocument, InlineNode, ParagraphNode } from "@everyfield/contracts/documents";

// DOC-020, CASE-DOC-020 `network-fills-slot`: a Church Document made from a template starts with the sending
// network's statement of faith in each slot keyed `statement-of-faith` (D-106). The text is read once, at creation
// (D-109): a later change to the network's text never reaches a document that already exists.

/** The slot key the network's statement of faith fills. */
export const STATEMENT_OF_FAITH_KEY = "statement-of-faith";

/** The network's text as paragraphs: one per blank-line-separated block, a single line break kept as a break. */
export function statementParagraphs(text: string): ParagraphNode[] {
	return text
		.replace(/\r\n?/g, "\n")
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
 * The document with every `statement-of-faith` slot holding the network's text under its label. With no text, the
 * document is returned unchanged, so the slot stays as the template authored it (the marked blank when empty). A slot
 * with no key or another key is never touched.
 */
export function fillStatementSlots(doc: DocDocument, statement: string | null): DocDocument {
	if (statement === null || statement.trim() === "") return doc;
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
