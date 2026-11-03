// The Guide and reference excerpt (WP-034). A section is read as markdown blocks and cut only between blocks, at a
// sentence end or at a word end, so the cut never splits a table row, a list item, an MDX component or an inline span.

/** The excerpt limit. A body this long or longer ends with a whole table row. */
const LIMIT = 500;
/** A table that starts inside the limit stays whole up to this length. */
const TABLE_CEILING = 1500;

type Block =
	| { kind: "blank" | "break" | "atomic" | "fence" | "paragraph"; lines: string[] }
	| { kind: "heading"; level: number; text: string; lines: string[] }
	| { kind: "list"; items: string[][]; lines: string[] }
	| { kind: "table"; head: number; lines: string[] };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const COMPONENT = /^\s*<([A-Za-z][\w.]*)/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+/;

function startsBlock(line: string): boolean {
	return (
		line.trim() === "" ||
		HEADING.test(line) ||
		BREAK.test(line) ||
		FENCE.test(line) ||
		COMPONENT.test(line) ||
		TABLE_ROW.test(line) ||
		LIST_ITEM.test(line)
	);
}

function heading(line: string): Block {
	const match = HEADING.exec(line);
	return { kind: "heading", level: match?.[1]?.length ?? 2, text: match?.[2] ?? "", lines: [line] };
}

/** Markdown text as blocks. The lines of all blocks, in order, are the input lines. */
function markdownBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let index = 0;
	const take = (stop: (line: string) => boolean) => {
		const start = index;
		while (index < lines.length && !stop(lines[index] ?? "")) index++;
		return lines.slice(start, index);
	};
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const fence = FENCE.exec(line)?.[1];
		const component = COMPONENT.exec(line)?.[1];
		if (line.trim() === "") {
			blocks.push({ kind: "blank", lines: [line] });
			index++;
		} else if (HEADING.test(line)) {
			blocks.push(heading(line));
			index++;
		} else if (BREAK.test(line)) {
			blocks.push({ kind: "break", lines: [line] });
			index++;
		} else if (fence || component) {
			// A fenced block or an MDX component is atomic, up to its closing line.
			const closes = fence
				? (text: string) => text.trim().startsWith(fence)
				: (text: string) => text.includes(`</${component}>`) || /\/>\s*$/.test(text);
			const start = index++;
			if (fence || !closes(line)) {
				take(closes);
				if (index < lines.length) index++;
			}
			blocks.push({ kind: fence ? "fence" : "atomic", lines: lines.slice(start, index) });
		} else if (TABLE_ROW.test(line)) {
			const rows = take((next) => !TABLE_ROW.test(next));
			blocks.push({ kind: "table", head: TABLE_SEPARATOR.test(rows[1] ?? "") ? 2 : 1, lines: rows });
		} else if (LIST_ITEM.test(line)) {
			const base = LIST_ITEM.exec(line)?.[1]?.length ?? 0;
			const rows = take((next) => next.trim() === "" || (!LIST_ITEM.test(next) && !/^\s{2,}\S/.test(next)));
			const items: string[][] = [];
			for (const row of rows) {
				const marker = LIST_ITEM.exec(row);
				if (marker && (marker[1]?.length ?? 0) <= base) items.push([row]);
				else items.at(-1)?.push(row);
			}
			blocks.push({ kind: "list", items, lines: rows });
		} else {
			index++;
			blocks.push({ kind: "paragraph", lines: [line, ...take(startsBlock)] });
		}
	}
	return blocks;
}

type Node = {
	type?: unknown;
	level?: unknown;
	text?: unknown;
	children?: unknown;
	content?: unknown;
	items?: unknown;
	rows?: unknown;
	blocks?: unknown;
};

function inline(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(inline).join("");
	if (!value || typeof value !== "object") return "";
	const node = value as Node;
	if (typeof node.text === "string") return node.text;
	return inline(node.children ?? node.content ?? "");
}

/** Organization nodes as blocks of markdown lines: headings keep their level, list items and table rows one line each. */
function nodeBlocks(value: unknown, out: Block[]): void {
	if (Array.isArray(value)) {
		for (const item of value) nodeBlocks(item, out);
		return;
	}
	if (!value || typeof value !== "object") return;
	const node = value as Node;
	const level = node.type === "h2" ? 2 : node.type === "h3" ? 3 : node.level;
	if (node.type === "heading" || node.type === "h2" || node.type === "h3" || level === 2 || level === 3) {
		out.push(heading(`${"#".repeat(level === 3 ? 3 : 2)} ${inline(node).trim()}`));
		return;
	}
	if (Array.isArray(node.items)) {
		const items = node.items.map((item) => [`- ${inline(item).trim()}`]);
		out.push({ kind: "list", items, lines: items.flat() });
		return;
	}
	if (Array.isArray(node.rows)) {
		const rows = node.rows.map((row) => (Array.isArray(row) ? row.map((cell) => inline(cell).trim()).join(" · ") : ""));
		out.push({ kind: "table", head: 1, lines: rows });
		return;
	}
	if (node.blocks !== undefined) return nodeBlocks(node.blocks, out);
	const text = inline(node).trim();
	if (text) out.push({ kind: "paragraph", lines: [text] });
}

function bodyBlocks(contentType: string, body: string): Block[] {
	if (contentType === "safe_nodes") {
		try {
			const blocks: Block[] = [];
			nodeBlocks(JSON.parse(body), blocks);
			return blocks;
		} catch {
			// Older organization text is plain text, not nodes.
		}
	}
	return markdownBlocks(body.split("\n"));
}

/** The character ranges of inline spans: code, links and images, bold, italic and inline tags. */
function spans(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let masked = text;
	const mark = (pattern: RegExp) => {
		for (const match of masked.matchAll(pattern)) {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			ranges.push([start, end]);
			masked = masked.slice(0, start) + "x".repeat(end - start) + masked.slice(end);
		}
	};
	mark(/(`+)[\s\S]*?\1/g);
	mark(/<\/?[A-Za-z][^>]*>/g);
	mark(/!?\[[^\]]*\]\([^)]*\)/g);
	mark(/(\*\*|__)(?=\S)[\s\S]*?\S\1/g);
	mark(/(?<![\w*])\*(?=\S)[\s\S]*?\S\*(?!\*)|(?<!\w)_(?=\S)[\s\S]*?\S_(?!\w)/g);
	return ranges;
}

/**
 * The longest start of a paragraph within `room`: up to its last sentence end, else up to its last word end with
 * "…". Never inside an inline span. Null when nothing fits.
 */
function cutParagraph(text: string, room: number): string | null {
	const ranges = spans(text);
	const outside = (at: number) => !ranges.some(([start, end]) => at > start && at < end);
	let sentence: string | null = null;
	let word: string | null = null;
	for (let at = 1; at < text.length; at++) {
		if (!/\s/.test(text[at] ?? "") || /\s/.test(text[at - 1] ?? "") || !outside(at)) continue;
		const kept = text.slice(0, at);
		if (/[.!?][*_"'”’)]*$/.test(kept)) {
			if (kept.length <= room) sentence = kept;
		} else {
			const cut = `${kept.replace(/[\s,;:—–-]+$/, "")}…`;
			if (cut.length > 1 && cut.length <= room) word = cut;
		}
		if (kept.length > room) break;
	}
	return sentence ?? word;
}

/** The part of a block that crosses the limit, as lines that fit `room`. Empty when none fits. */
function cutBlock(block: Block, room: number): string[] {
	if (block.kind === "paragraph") {
		const cut = cutParagraph(block.lines.join("\n"), room);
		return cut == null ? [] : cut.split("\n");
	}
	if (block.kind === "fence") {
		// A code block keeps its opening line and the whole lines that fit, then closes again.
		const [open = "```", ...rest] = block.lines;
		const close = FENCE.exec(open)?.[1] ?? "```";
		const kept = [open];
		for (const line of rest.slice(0, -1)) {
			if ([...kept, line, close].join("\n").length > room) break;
			kept.push(line);
		}
		return kept.length > 1 ? [...kept, close] : [];
	}
	if (block.kind === "list") {
		const kept: string[] = [];
		for (const item of block.items) {
			if ([...kept, ...item].join("\n").length > room) break;
			kept.push(...item);
		}
		return kept;
	}
	return [];
}

function cut(blocks: Block[]): string {
	const out: Block[] = [];
	const length = (lines: string[]) => lines.join("\n").length;
	let used: string[] = [];
	for (const block of blocks) {
		const whole = [...used, ...block.lines];
		if (block.kind === "table") {
			if (length(whole) <= TABLE_CEILING) {
				out.push(block);
				used = whole;
			} else {
				const rows = [...block.lines.slice(0, block.head)];
				for (const row of block.lines.slice(block.head)) {
					if (length([...used, ...rows, row]) > TABLE_CEILING) break;
					rows.push(row);
				}
				if (length([...used, ...rows]) <= TABLE_CEILING) out.push({ ...block, lines: rows });
				break;
			}
			if (length(used) >= LIMIT) break;
			continue;
		}
		if (length(whole) < LIMIT) {
			out.push(block);
			used = whole;
			continue;
		}
		const room = LIMIT - 1 - (used.length ? length(used) + 1 : 0);
		const lines = cutBlock(block, room);
		if (lines.length) out.push({ ...block, lines });
		break;
	}
	while (out.length) {
		const last = out[out.length - 1];
		if (last?.kind !== "blank" && last?.kind !== "break" && last?.kind !== "heading") break;
		out.pop();
	}
	return out.flatMap((block) => block.lines).join("\n");
}

/**
 * The section under `heading`, up to the next heading of the same or higher level, cut to the excerpt limit at a
 * block, sentence or word end. Without the heading, the start of the text. Excerpts are never reading.
 */
export function sectionExcerpt(contentType: string, body: string, heading?: string): string {
	const blocks = bodyBlocks(contentType, body);
	const start = heading ? blocks.findIndex((block) => block.kind === "heading" && block.text === heading) : -1;
	const opening = blocks[start];
	if (opening?.kind !== "heading") return cut(blocks);
	const end = blocks.findIndex(
		(block, index) => index > start && block.kind === "heading" && block.level <= opening.level,
	);
	return cut(blocks.slice(start, end < 0 ? undefined : end));
}
