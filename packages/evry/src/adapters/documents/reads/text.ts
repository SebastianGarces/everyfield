import type { DocDocument } from "@everyfield/contracts/documents";

// A Church Document's plain text in reading order, the way it prints: one line per paragraph, heading and list item,
// each merge field as its frozen value, a table as its header labels and rows. Images, dividers and page breaks carry
// no text. Pure, so a test can check every line.

type Node = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };

export function documentText(doc: Pick<DocDocument, "body" | "data" | "fields">): string {
	const data = doc.data ?? {};
	const label = new Map(doc.fields.map((f) => [f.key, f.label]));
	const value = (key: string) => {
		const v = data[key];
		return typeof v === "string" && v.trim() ? v : `[${label.get(key) ?? key}]`;
	};
	const inline = (node: Node): string => {
		if (node.type === "text") return node.text ?? "";
		if (node.type === "field") return value(String(node.attrs?.key ?? ""));
		if (node.type === "hardBreak") return "\n";
		return (node.content ?? []).map(inline).join("");
	};
	const lines: string[] = [];
	const walk = (node: Node) => {
		switch (node.type) {
			case "paragraph":
			case "heading":
				lines.push(inline(node));
				return;
			case "writeIn":
				lines.push(`${String(node.attrs?.label ?? "")} ________`.trim());
				return;
			case "table": {
				const columns = (node.attrs?.columns as { label: string }[] | undefined) ?? [];
				if (node.attrs?.header !== false) lines.push(columns.map((c) => c.label).join(" | "));
				for (const row of node.content ?? []) lines.push((row.content ?? []).map(inline).join(" | "));
				return;
			}
			default:
				for (const child of node.content ?? []) walk(child);
		}
	};
	walk(doc.body as Node);
	return lines
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}
