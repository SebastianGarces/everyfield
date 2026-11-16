import type { BlockNode, DocDocument, InlineNode, ParagraphNode } from "@everyfield/contracts/documents";
import { sql } from "@everyfield/db/query";

const STATEMENT_OF_FAITH_KEY = "statement-of-faith";

export const networkStatementSql = (plantId: string) =>
	sql`SELECT o.statement_of_faith FROM affiliation a JOIN organization o ON o.id = a.organization_id
		WHERE a.plant_id = ${plantId}::uuid AND a.ended_at IS NULL AND o.statement_of_faith IS NOT NULL
		ORDER BY a.accepted_at, a.id LIMIT 1`;

function statementParagraphs(text: string): ParagraphNode[] {
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
