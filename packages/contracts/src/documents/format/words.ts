import { sameKey, type DocDifference } from "./compare.ts";
import { backwards, pairs, scores } from "./scores.ts";

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
	const lcs = scores(a.length, b.length);
	const bBack = backwards(b);
	for (const [i, x] of backwards(a))
		for (const [j, y] of bBack)
			lcs.set(i, j, x.match === y.match ? lcs.at(i + 1, j + 1) + 1 : Math.max(lcs.at(i + 1, j), lcs.at(i, j + 1)));
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	for (;;) {
		const x = a[i];
		const y = b[j];
		if (x && y && x.match === y.match) {
			ops.push({ op: "kept", unit: x, twin: y });
			i++;
			j++;
		} else if (x && (!y || lcs.at(i + 1, j) >= lcs.at(i, j + 1))) {
			ops.push({ op: "removed", unit: x });
			i++;
		} else if (y) {
			ops.push({ op: "added", unit: y });
			j++;
		} else return absorbSpaces(ops);
	}
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
	const changedSpace = (k: number) => changed(k) && own[k]?.unit.word === false;
	for (let k = 0; k < own.length; k++) {
		if (!changedSpace(k)) continue;
		let start = k;
		while (changedSpace(start - 1)) start--;
		let end = k;
		while (changedSpace(end + 1)) end++;
		if (!changed(start - 1) || !changed(end + 1)) for (const item of own.slice(start, end + 1)) item.op = "kept";
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
	const lines = pairs(a.lines, b.lines);
	const ops = lines.map(([line, twin]) => diff(line.units, twin.units));
	const words = (side: "removed" | "added") =>
		ops.flat().filter((o) => o.unit.word && (o.op === "kept" || o.op === side)).length;
	const kept = ops.flat().filter((o) => o.op === "kept" && o.unit.word).length;
	const changed = ops.some((line) => line.some((o) => o.op !== "kept"));
	if (!changed) {
		const notes: ChangeNote[] = [];
		if (lines.some(([line, twin]) => line.exact !== twin.exact)) notes.push("spacing");
		else if (lines.some(([line, twin]) => line.marked !== twin.marked)) notes.push("formatting");
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
