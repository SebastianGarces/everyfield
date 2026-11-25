import type { DocDocument, DocNode } from "@everyfield/contracts/documents";
import { EvryRefusal } from "../../context/errors.ts";

type Node = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: unknown[]; content?: Node[] };
type Unit = { text: string; node: Node };
type Block = { node: Node; parents: { node: Node; index: number }[]; cell: boolean };
export type Edit = { find: string; replace: string };
export type Passage = { before: string | null; after: string | null };

const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^[-*•]\s+(.+)$/;
const NUMBER = /^\d+[.)]\s+(.+)$/;

function inlineOf(text: string): Node[] {
	return text
		.split(/(\*\*[^*]+\*\*)/)
		.filter(Boolean)
		.map((part) =>
			/^\*\*[^*]+\*\*$/.test(part)
				? { type: "text", text: part.slice(2, -2), marks: [{ type: "bold" }] }
				: { type: "text", text: part },
		);
}

export function draftBody(text: string): unknown {
	const content: Node[] = [];
	for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = HEADING.exec(line);
		const bullet = BULLET.exec(line);
		const number = NUMBER.exec(line);
		const item = bullet ?? number;
		if (heading)
			content.push({
				type: "heading",
				attrs: { level: (heading[1] ?? "").length },
				content: inlineOf(heading[2] ?? ""),
			});
		else if (item) {
			const type = bullet ? "bulletList" : "orderedList";
			const entry = { type: "listItem", content: [{ type: "paragraph", content: inlineOf(item[1] ?? "") }] };
			const last = content.at(-1);
			if (last?.type === type) last.content?.push(entry);
			else content.push({ type, content: [entry] });
		} else content.push({ type: "paragraph", content: inlineOf(line) });
	}
	return { type: "doc", content };
}

export function shownText(body: DocNode): string {
	const plain = (node: Node): string => node.text ?? (node.content ?? []).map(plain).join("");
	return ((body as Node).content ?? [])
		.map((node) =>
			node.type === "bulletList"
				? (node.content ?? []).map((item) => `• ${plain(item)}`).join("\n")
				: node.type === "orderedList"
					? (node.content ?? []).map((item, n) => `${n + 1}. ${plain(item)}`).join("\n")
					: plain(node),
		)
		.join("\n\n");
}

export const plainField = (key: string) => `[${key}]`;
export function fieldText(doc: Pick<DocDocument, "fields" | "data">) {
	const named = new Map(doc.fields.map((f) => [f.key, f.label]));
	return (key: string) => {
		const value = doc.data?.[key];
		return typeof value === "string" && value.trim() ? value : `[${named.get(key) ?? key}]`;
	};
}

function blocksIn(root: Node): Block[] {
	const found: Block[] = [];
	const walk = (node: Node, parents: Block["parents"], columns: { type?: unknown }[] | null) => {
		if (node.type === "paragraph" || node.type === "heading") found.push({ node, parents, cell: false });
		else if (node.type === "cell") return;
		else
			(node.content ?? []).forEach((child, index) => {
				const next = [...parents, { node, index }];
				if (node.type === "row" && child.type === "cell" && columns?.[index]?.type === "text")
					found.push({ node: child, parents: next, cell: true });
				else
					walk(
						child,
						next,
						node.type === "table" ? ((node.attrs?.columns as { type?: unknown }[] | undefined) ?? null) : columns,
					);
			});
	};
	walk(root, [], null);
	return found;
}

function unitsOf(block: Node, field: (key: string) => string): Unit[] {
	const shown = (node: Node) =>
		node.type === "field" ? field(String(node.attrs?.key ?? "")) : node.type === "hardBreak" ? "\n" : "";
	return (block.content ?? []).map((node) => ({ text: node.type === "text" ? (node.text ?? "") : shown(node), node }));
}
const textOf = (units: readonly Unit[]) => units.map((u) => u.text).join("");
const refuse = (problem: string): never => {
	throw new EvryRefusal("invalid_input", problem);
};
const quoted = (text: string) => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);

function split(units: readonly Unit[], from: number, to: number) {
	const before: Node[] = [];
	const after: Node[] = [];
	let marks: unknown[] | undefined;
	let at = 0;
	for (const { text, node } of units) {
		const start = at;
		const end = (at += text.length);
		if (node.type !== "text") {
			if (end <= from || start === end) (start >= to && end > from ? after : before).push(node);
			else if (start >= to) after.push(node);
			else
				refuse(
					"That text holds a detail the church's records fill in, such as the church name. Change the words around it, or change the detail itself where it is kept.",
				);
			continue;
		}
		const head = text.slice(0, Math.max(0, from - start));
		const tail = text.slice(Math.max(0, to - start));
		if (head) before.push({ ...node, text: head });
		if (tail) after.push({ ...node, text: tail });
		if (from < to ? start <= from && end > from : start < from && end >= from) marks = node.marks;
	}
	return { before, after, marks };
}

function joined(nodes: Node[]): Node[] {
	const out: Node[] = [];
	for (const node of nodes) {
		const last = out.at(-1);
		if (
			last?.type === "text" &&
			node.type === "text" &&
			JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
		)
			out[out.length - 1] = { ...last, text: `${last.text ?? ""}${node.text ?? ""}` };
		else out.push(node);
	}
	return out;
}

const fill = (node: Node, content: Node[]) => {
	if (content.length) node.content = content;
	else delete node.content;
};

function applyOne(root: Node, edit: Edit, field: (key: string) => string): Passage {
	const hits = blocksIn(root).flatMap((block) => {
		const units = unitsOf(block.node, field);
		const text = textOf(units);
		const at: number[] = [];
		for (let i = text.indexOf(edit.find); i >= 0; i = text.indexOf(edit.find, i + 1)) at.push(i);
		return at.map((from) => ({ block, units, text, from }));
	});
	const [hit] = hits;
	if (!hit)
		return refuse(
			`The text ${quoted(edit.find)} is not in one paragraph or cell Evry can change. Quote the document's exact words from documents.read, within one paragraph.`,
		);
	if (hits.length > 1)
		return refuse(`The text ${quoted(edit.find)} is in the document ${hits.length} times. Quote more words around it.`);
	const replace = edit.replace.replace(/\r\n?/g, "\n");
	let head = 0;
	while (head < edit.find.length && head < replace.length && edit.find[head] === replace[head]) head++;
	let tail = 0;
	while (
		tail < edit.find.length - head &&
		tail < replace.length - head &&
		edit.find[edit.find.length - 1 - tail] === replace[replace.length - 1 - tail]
	)
		tail++;
	const from = hit.from + head;
	const to = hit.from + edit.find.length - tail;
	const added = replace.slice(head, replace.length - tail);
	if (from === to && !added) return refuse("This edit changes nothing.");

	const { before, after, marks } = split(hit.units, from, to);
	const words = (text: string): Node[] => (text ? [{ type: "text", text, ...(marks?.length && { marks }) }] : []);
	const parts = added.split(/\n+/);
	if (parts.length > 1 && hit.block.cell) return refuse("A table cell holds one line of text.");

	const { node, parents } = hit.block;
	const [first = "", ...more] = parts;
	const last = more.pop();
	fill(node, joined([...before, ...words(first), ...(last === undefined ? after : [])]));
	const lines =
		last === undefined ? [] : [...more.map(words), [...words(last), ...after]].map(joined).filter((l) => l.length);
	const result = [
		textOf(unitsOf(node, field)),
		...lines.map((line) => textOf(unitsOf({ type: "paragraph", content: line }, field))),
	].filter((line) => line.trim());
	if (!hit.block.cell) {
		const parent = parents.at(-1);
		const inItem = parent?.node.type === "listItem" ? parents.at(-2) : undefined;
		const made = lines.map((line): Node => {
			const paragraph: Node = {
				type: "paragraph",
				...(node.type === "paragraph" && node.attrs && { attrs: node.attrs }),
				content: line,
			};
			return inItem ? { type: "listItem", content: [paragraph] } : paragraph;
		});
		const spot = inItem ?? parent;
		const list = spot?.node.content;
		if (spot && list) {
			const gone = !node.content && (!inItem || parent?.node.content?.length === 1) && list.length + made.length > 1;
			list.splice(gone ? spot.index : spot.index + 1, gone ? 1 : 0, ...made);
		}
	}
	return { before: hit.text, after: result.join("\n") || null };
}

export function applyEdits(body: DocNode, edits: readonly Edit[], field: (key: string) => string) {
	const next = structuredClone(body) as Node;
	const passages = edits.map((edit) => applyOne(next, edit, field));
	const changed: unknown = next;
	return { body: changed, passages };
}
