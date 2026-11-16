import { fenceMarker, wikiBlocks, type WikiBlock as Block } from "@everyfield/contracts/wiki";

const LIMIT = 500;
const TABLE_CEILING = 1500;

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

function cutBlock(block: Block, room: number): string[] {
	if (block.kind === "paragraph" || block.kind === "quote") {
		const cut = cutParagraph(block.lines.join("\n"), room);
		return cut == null ? [] : cut.split("\n");
	}
	if (block.kind === "code" || block.kind === "diagram") {
		const [open = "```", ...rest] = block.lines;
		const close = fenceMarker(open) ?? "```";
		const kept = [open];
		for (const line of rest.slice(0, -1)) {
			if ([...kept, line, close].join("\n").length > room) break;
			kept.push(line);
		}
		return kept.length > 1 ? [...kept, close] : [];
	}
	if (block.kind === "list") {
		const kept: string[] = [];
		for (const item of block.groups) {
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
				const rows = block.lines.slice(0, block.head);
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

export function sectionExcerpt(contentType: string, body: string, heading?: string): string {
	const blocks = wikiBlocks(contentType, body);
	const start = heading ? blocks.findIndex((block) => block.kind === "heading" && block.text === heading) : -1;
	const opening = blocks[start];
	if (opening?.kind !== "heading") return cut(blocks);
	const end = blocks.findIndex(
		(block, index) => index > start && block.kind === "heading" && block.level <= opening.level,
	);
	return cut(blocks.slice(start, end < 0 ? undefined : end));
}
