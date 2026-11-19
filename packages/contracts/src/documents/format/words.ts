import { sameKey, type DocDifference } from "./compare.ts";

export type WordRun = { op: "kept" | "removed" | "added"; text: string; from: number; to: number };
export type ChangeNote = "formatting" | "spacing" | "settings";
export type WordChanges =
	| { show: "words"; document: WordRun[][]; template: WordRun[][]; notes: ChangeNote[] }
	| { show: "notes"; notes: ChangeNote[] }
	| { show: "whole" };

type Rec = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: unknown[]; content?: Rec[] };
type Unit = { match: string; text: string; size: number; word: boolean };
type Line = { units: Unit[]; exact: string; marked: string };

const MIN_KEPT = 0.4;
const INLINE_BLOCKS = new Set(["paragraph", "heading"]);
const SPACE = /^\s+$/u;

function cut(text: string): Unit[] {
	return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu) ?? []).map((part) => ({
		match: SPACE.test(part) ? " " : part,
		text: part,
		size: part.length,
		word: !SPACE.test(part),
	}));
}

function lineOf(content: readonly Rec[] | undefined): Line {
	const units: Unit[] = [];
	let exact = "";
	const marked: unknown[] = [];
	for (const node of content ?? []) {
		if (node.type === "text") {
			const text = node.text ?? "";
			units.push(...cut(text));
			exact += text;
			marked.push([text, sameKey({ type: "text", text: "", marks: node.marks })]);
			continue;
		}
		const atom =
			node.type === "field"
				? { match: `\u0000field:${String(node.attrs?.key)}`, text: `{${String(node.attrs?.key)}}`, size: 1, word: true }
				: node.type === "hardBreak"
					? { match: " ", text: "\n", size: 1, word: false }
					: { match: `\u0000${node.type}:${JSON.stringify(node.attrs ?? {})}`, text: "", size: 1, word: true };
		units.push(atom);
		exact += atom.match;
		marked.push(atom.match);
	}
	return { units, exact, marked: JSON.stringify(joinRuns(marked)) };
}

function joinRuns(runs: unknown[]) {
	const out: unknown[] = [];
	for (const run of runs) {
		const last = out.at(-1);
		if (Array.isArray(run) && Array.isArray(last) && JSON.stringify(run[1]) === JSON.stringify(last[1]))
			out[out.length - 1] = [last[0] + run[0], last[1]];
		else out.push(run);
	}
	return out;
}

function walk(nodes: readonly Rec[]): { lines: Line[]; shape: string[]; settings: string[]; table: boolean } {
	const out = { lines: [] as Line[], shape: [] as string[], settings: [] as string[], table: false };
	const visit = (node: Rec, depth: number) => {
		if (node.type === "table") out.table = true;
		out.shape.push(`${depth}:${node.type}`);
		out.settings.push(sameKey({ type: node.type, attrs: node.attrs }));
		if (INLINE_BLOCKS.has(String(node.type))) {
			out.lines.push(lineOf(node.content));
			return;
		}
		for (const child of node.content ?? []) visit(child, depth + 1);
	};
	for (const node of nodes) visit(node, 0);
	return out;
}

type Op = { op: "kept"; unit: Unit; twin: Unit } | { op: "removed" | "added"; unit: Unit };

function diff(a: readonly Unit[], b: readonly Unit[]): Op[] {
	const n = a.length;
	const m = b.length;
	const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			lcs[i]![j] = a[i]!.match === b[j]!.match ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i]!.match === b[j]!.match) ops.push({ op: "kept", unit: a[i++]!, twin: b[j++]! });
		else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: "removed", unit: a[i++]! });
		else ops.push({ op: "added", unit: b[j++]! });
	}
	return absorbSpaces(ops);
}

function absorbSpaces(ops: readonly Op[]): Op[] {
	const out: Op[] = [];
	let stretch: Op[] = [];
	const flush = () => {
		out.push(...stretch.filter((o) => o.op === "removed"), ...stretch.filter((o) => o.op === "added"));
		stretch = [];
	};
	ops.forEach((op, k) => {
		const changed = (o: Op | undefined) => o !== undefined && o.op !== "kept";
		if (op.op === "kept" && !op.unit.word && changed(ops[k - 1]) && changed(ops[k + 1])) {
			stretch.push({ op: "removed", unit: op.unit }, { op: "added", unit: op.twin });
			return;
		}
		if (op.op !== "kept") {
			stretch.push(op);
			return;
		}
		flush();
		out.push(op);
	});
	flush();
	return out;
}

function runs(ops: readonly Op[], side: "removed" | "added"): WordRun[] {
	const own = ops
		.filter((op) => op.op === "kept" || op.op === side)
		.map((op) => ({ op: op.op, unit: op.op === "kept" && side === "added" ? op.twin : op.unit }));
	const changed = (k: number) => own[k] !== undefined && own[k].op !== "kept";
	for (let k = 0; k < own.length; k++) {
		if (!changed(k) || own[k]!.unit.word) continue;
		let start = k;
		while (changed(start - 1) && !own[start - 1]!.unit.word) start--;
		let end = k;
		while (changed(end + 1) && !own[end + 1]!.unit.word) end++;
		if (!changed(start - 1) || !changed(end + 1)) for (let i = start; i <= end; i++) own[i]!.op = "kept";
		k = end;
	}
	const out: WordRun[] = [];
	let at = 0;
	for (const { op, unit } of own) {
		const last = out.at(-1);
		if (last && last.op === op) {
			last.text += unit.text;
			last.to += unit.size;
		} else out.push({ op, text: unit.text, from: at, to: at + unit.size });
		at += unit.size;
	}
	return out;
}

function compareSides(mine: readonly Rec[] | string, theirs: readonly Rec[] | string): WordChanges {
	const blocks = (side: readonly Rec[] | string) =>
		typeof side === "string" ? [{ type: "paragraph", content: [{ type: "text", text: side }] }] : side;
	const a = walk(blocks(mine));
	const b = walk(blocks(theirs));
	if (a.table || b.table || a.lines.length === 0 || a.lines.length !== b.lines.length) return { show: "whole" };
	if (a.shape.join() !== b.shape.join()) return { show: "whole" };
	const settings = a.settings.join() !== b.settings.join();
	const ops = a.lines.map((line, k) => diff(line.units, b.lines[k]!.units));
	const words = (side: "removed" | "added") =>
		ops.flat().filter((o) => o.unit.word && (o.op === "kept" || o.op === side)).length;
	const kept = ops.flat().filter((o) => o.op === "kept" && o.unit.word).length;
	const changed = ops.some((line) => line.some((o) => o.op !== "kept"));
	if (!changed) {
		const notes: ChangeNote[] = [];
		if (a.lines.some((line, k) => line.exact !== b.lines[k]!.exact)) notes.push("spacing");
		else if (a.lines.some((line, k) => line.marked !== b.lines[k]!.marked)) notes.push("formatting");
		if (settings) notes.push("settings");
		return notes.length ? { show: "notes", notes } : { show: "whole" };
	}
	if (kept < MIN_KEPT * Math.max(words("removed"), words("added"))) return { show: "whole" };
	return {
		show: "words",
		document: ops.map((line) => runs(line, "removed")),
		template: ops.map((line) => runs(line, "added")),
		notes: settings ? ["settings"] : [],
	};
}

export function wordChanges(d: DocDifference): WordChanges | null {
	if (d.document === null || d.template === null || d.part === "page") return null;
	if (d.part === "title") return compareSides(d.document, d.template);
	if (d.part === "body") return compareSides([d.document], [d.template]);
	const sides = compareSides(d.document.content, d.template.content);
	if (d.document.pages === d.template.pages || sides.show === "whole") return sides;
	return { ...sides, notes: [...new Set([...sides.notes, "settings" as const])] };
}
