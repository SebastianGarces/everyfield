// Word marks inside a "Changed" item of "Compare with template" (T-82). The block compare (compare.ts) decides what
// differs and what Accept takes; this only says which words of each side differ, so a person can read the change.
// Pure. Each side's text is cut into words, spaces, single punctuation characters and inline atoms (a merge field is
// one unit, by key), the two unit lists are aligned by a longest common subsequence, and the result is given per
// text line (a paragraph, a heading, one list item's paragraph) with offsets the editor can draw on.
import { sameKey, type DocDifference } from "./compare.ts";
import type { Region } from "./types.ts";

/**
 * One run of one side's line. `from` and `to` count the line's inline content as the editor does: one per character
 * of text and one per inline atom (a merge field, a line break, a page number).
 */
export type WordRun = { op: "kept" | "removed" | "added"; text: string; from: number; to: number };
/** What changed beside the words, in words: the marks on the text, the spaces, or a block's settings. */
export type ChangeNote = "formatting" | "spacing" | "settings";
/**
 * `words`: each side's lines in reading order, each a list of runs; the document's side has kept and removed runs,
 * the template's side kept and added runs. `notes`: no word differs, only what the notes name. `whole`: the sides do
 * not pair line by line or share too few words, so each reads best whole.
 */
export type WordChanges =
	| { show: "words"; document: WordRun[][]; template: WordRun[][]; notes: ChangeNote[] }
	| { show: "notes"; notes: ChangeNote[] }
	| { show: "whole" };

type Rec = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: unknown[]; content?: Rec[] };
/** One unit of a line: `match` compares, `text` shows, `size` is its length in the editor's count. */
type Unit = { match: string; text: string; size: number; word: boolean };
/** A text line: its units and, to tell formatting apart, its text runs with their marks. */
type Line = { units: Unit[]; exact: string; marked: string };

/** Below this share of words kept, the two versions read better whole than as a mix of marks. */
const MIN_KEPT = 0.4;
const INLINE_BLOCKS = new Set(["paragraph", "heading"]);
const SPACE = /^\s+$/u;

/** A string cut into words, runs of space and single other characters. */
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

/** Adjacent text runs with the same marks read as one, so how the editor splits them does not count. */
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

/**
 * A block's text lines in reading order and its shape: every node above the text, by type and attributes. A table
 * has no lines: its rows and value cells are not drawn as text lines, so it is compared whole.
 */
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

/** One aligned unit. A kept unit has its template twin, which may differ in spacing ("  " kept against " "). */
type Op = { op: "kept"; unit: Unit; twin: Unit } | { op: "removed" | "added"; unit: Unit };

/** The two lines' units aligned: the longest common subsequence, removed units before added ones at each gap. */
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

/**
 * A kept space between two changes reads as part of them: "quick brown" to "slow red" marks the phrase, not two
 * words with an unmarked space between. Within each changed stretch the removed units come before the added ones.
 */
function absorbSpaces(ops: readonly Op[]): Op[] {
	const out: Op[] = [];
	let stretch: Op[] = [];
	const flush = () => {
		const removed = stretch.filter((o) => o.op === "removed");
		const added = stretch.filter((o) => o.op === "added");
		stretch = [];
		// A space both sides start or end the stretch with is kept, so a mark starts and ends on a word.
		const space = (o: Op | undefined) => o !== undefined && !o.unit.word;
		const lead: Op[] = [];
		const trail: Op[] = [];
		while (space(removed[0]) && space(added[0]))
			lead.push({ op: "kept", unit: removed.shift()!.unit, twin: added.shift()!.unit });
		while (removed.length > 1 && added.length > 1 && space(removed.at(-1)) && space(added.at(-1)))
			trail.unshift({ op: "kept", unit: removed.pop()!.unit, twin: added.pop()!.unit });
		out.push(...lead, ...removed, ...added, ...trail);
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

/** One side's runs of a line: its own units, kept or changed, joined and placed. */
function runs(ops: readonly Op[], side: "removed" | "added"): WordRun[] {
	const out: WordRun[] = [];
	let at = 0;
	for (const op of ops) {
		if (op.op !== "kept" && op.op !== side) continue;
		const unit = op.op === "kept" && side === "added" ? op.twin : op.unit;
		const last = out.at(-1);
		if (last && last.op === op.op) {
			last.text += unit.text;
			last.to += unit.size;
		} else out.push({ op: op.op, text: unit.text, from: at, to: at + unit.size });
		at += unit.size;
	}
	return out;
}

/** The word marks of two versions of the same part, each a list of blocks or a plain string (the title). */
function compareSides(mine: readonly Rec[] | string, theirs: readonly Rec[] | string): WordChanges {
	const a =
		typeof mine === "string" ? walk([{ type: "paragraph", content: [{ type: "text", text: mine }] }]) : walk(mine);
	const b =
		typeof theirs === "string"
			? walk([{ type: "paragraph", content: [{ type: "text", text: theirs }] }])
			: walk(theirs);
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

/**
 * The word marks of a "Changed" item (or one changed in the template and in the document): its title, header,
 * footer or body block. Null when the item has no two sides to compare, or is the page setup, which lists its
 * settings in words.
 */
export function wordChanges(d: DocDifference): WordChanges | null {
	if (d.document === null || d.template === null || d.part === "page") return null;
	if (d.part === "title") return compareSides(d.document, d.template);
	if (d.part === "body") return compareSides([d.document as Rec], [d.template as Rec]);
	const region = (r: Region) => r.content as unknown as Rec[];
	const sides = compareSides(region(d.document), region(d.template));
	// Which pages a header prints on is a setting of the region.
	if (d.document.pages === d.template.pages || sides.show === "whole") return sides;
	return { ...sides, notes: [...new Set([...sides.notes, "settings" as const])] };
}
