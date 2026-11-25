import {
	LEGAL_NOTICE,
	nativeBody,
	plainTable,
	type BlockNode,
	type DocNode,
	type DocTemplate,
	type InlineNode,
	type ParagraphNode,
	type TextNode,
} from "@everyfield/contracts/documents";
import { docTemplateById } from "./doc-templates.ts";

export const DISCOVERY_TEMPLATE_IDS = [
	"member-expectations",
	"launch-team-commitment",
	"follow-up-letter",
	"bylaws",
	"prayer-letter",
] as const;

export function discoveryTemplate(id: string): DocTemplate | null {
	if (!(DISCOVERY_TEMPLATE_IDS as readonly string[]).includes(id)) return null;
	return docTemplateById(id) ?? null;
}

export function discoveryTemplates() {
	return DISCOVERY_TEMPLATE_IDS.flatMap((id) => {
		const template = docTemplateById(id);
		return template ? [{ id, title: template.title, description: template.description ?? template.title }] : [];
	});
}

const OWN_NAME_SOURCES = new Set(["church.pastor"]);

export function ownFieldValues(template: DocTemplate, ownName: string | null): Record<string, string> {
	return Object.fromEntries(
		template.fields.map((field) => [
			field.key,
			field.source && OWN_NAME_SOURCES.has(field.source) && ownName?.trim()
				? ownName.trim()
				: `[${field.label.toLowerCase()}]`,
		]),
	);
}

const paragraph = (content: InlineNode[]): ParagraphNode =>
	content.length ? { type: "paragraph", content } : { type: "paragraph" };

function inline(nodes: readonly InlineNode[] | undefined, values: Record<string, string>): InlineNode[] {
	const out: InlineNode[] = [];
	for (const node of nodes ?? []) {
		if (node.type === "text") {
			const marks = (node.marks ?? []).filter((m) => m.type !== "tag");
			const text: TextNode = { type: "text", text: node.text, ...(marks.length ? { marks } : {}) };
			out.push(text);
		} else if (node.type === "field") out.push({ type: "text", text: values[node.attrs.key] ?? "[blank]" });
		else if (node.type === "hardBreak") out.push({ type: "hardBreak" });
	}
	return out;
}

function blocks(nodes: readonly BlockNode[] | undefined, values: Record<string, string>): BlockNode[] {
	return (nodes ?? []).flatMap((node): BlockNode[] => {
		switch (node.type) {
			case "paragraph":
				return node.attrs?.style === "kicker" ? [] : [paragraph(inline(node.content, values))];
			case "heading": {
				const content = inline(node.content, values);
				return [{ type: "heading", attrs: { level: node.attrs?.level ?? 2 }, ...(content.length ? { content } : {}) }];
			}
			case "bulletList":
			case "orderedList":
				return [
					{
						type: node.type,
						content: node.content.map((item) => ({
							type: "listItem",
							content: item.content.map((p) => paragraph(inline(p.content, values))),
						})),
					},
				];
			case "quote":
				return [{ type: "quote", content: node.content.map((p) => paragraph(inline(p.content, values))) }];
			case "divider":
				return [{ type: "divider" }];
			case "columns":
				return node.content.flatMap((column) => blocks(column.content, values));
			case "box":
				return blocks(node.content, values);
			case "writeIn":
				return [paragraph([{ type: "text", text: `${node.attrs?.label ?? "Write here"}: ____________________` }])];
			case "slot": {
				const inner = blocks(node.content, values);
				return inner.length ? inner : [paragraph([{ type: "text", text: `[${node.attrs?.label ?? "Write here"}]` }])];
			}
			case "table":
				return [plainTable(node)];
			case "if":
			case "image":
			case "spacer":
			case "pageBreak":
				return [];
		}
	});
}

export function ownTemplateBody(template: DocTemplate, ownName: string | null): DocNode {
	const values = ownFieldValues(template, ownName);
	const all = blocks(template.body.content, values);
	const content = all.slice(Math.max(0, all.findIndex((node) => node.type !== "divider")));
	const notice: BlockNode[] =
		template.class === "formal/legal"
			? [paragraph([{ type: "text", text: LEGAL_NOTICE, marks: [{ type: "bold" }] }])]
			: [];
	return nativeBody.parse({ type: "doc", content: [...notice, ...content] });
}
