// A small, safe markdown subset for Evry's answers (WP-051): paragraphs, line breaks, bold, italic, bulleted and
// numbered lists, links and inline code. It parses to plain data; markdown.tsx draws React elements. Nothing here
// produces HTML, and a link renders as a link only for http, https, mailto and app-relative addresses.
//
// While an answer streams, a marker that is still open at the end never shows as a literal character: it is hidden and
// the text after it already takes the style it will have, so nothing reflows when the marker closes. A finished answer
// shows a really unmatched marker as text.

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "strong"; children: Inline[] }
	| { kind: "em"; children: Inline[] }
	| { kind: "code"; text: string }
	| { kind: "link"; href: string; external: boolean; children: Inline[] };

export type Block = { kind: "paragraph"; lines: Inline[][] } | { kind: "list"; ordered: boolean; items: Inline[][] };

/** The address a link may point to, or null: http, https, mailto or app-relative only. */
export function safeHref(raw: string): { href: string; external: boolean } | null {
	const href = raw.trim();
	// Control characters and spaces hide schemes ("java\nscript:").
	if (!href || /[\u0000- \u007f-\u009f]/.test(href)) return null;
	if (/^https?:\/\/[^/?#]/i.test(href)) return { href, external: true };
	if (/^mailto:[^\s]+$/i.test(href)) return { href, external: true };
	if (href.startsWith("/") && !href.startsWith("//") && !href.includes("\\")) return { href, external: false };
	return null;
}

const ESCAPABLE = "\\`*[]()_";

/** `text` is the whole inline source; `open` marks the answer as still streaming. */
export function parseInline(text: string, open = false): Inline[] {
	const out: Inline[] = [];
	let buffer = "";
	const flush = () => {
		if (buffer) out.push({ kind: "text", text: buffer });
		buffer = "";
	};
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		if (c === "\\" && i + 1 < text.length && ESCAPABLE.includes(text[i + 1]!)) {
			buffer += text[i + 1];
			i += 2;
			continue;
		}
		if (c === "`") {
			const end = text.indexOf("`", i + 1);
			if (end > i + 1) {
				flush();
				out.push({ kind: "code", text: text.slice(i + 1, end) });
				i = end + 1;
				continue;
			}
			if (end === -1 && open) {
				flush();
				const rest = text.slice(i + 1);
				if (rest) out.push({ kind: "code", text: rest });
				return out;
			}
		} else if (c === "*" && text[i + 1] === "*") {
			const end = text.indexOf("**", i + 2);
			if (end > i + 2) {
				flush();
				out.push({ kind: "strong", children: parseInline(text.slice(i + 2, end), false) });
				i = end + 2;
				continue;
			}
			if (end === -1 && open) {
				flush();
				const rest = text.slice(i + 2);
				if (rest.trim()) out.push({ kind: "strong", children: parseInline(rest, true) });
				return out;
			}
		} else if (c === "*") {
			if (open && i === text.length - 1) return (flush(), out); // may be the first half of "**"
			if (text[i + 1] && !/\s/.test(text[i + 1]!) && text[i + 1] !== "*") {
				let end = i + 1;
				while ((end = text.indexOf("*", end + 1)) !== -1 && (/\s/.test(text[end - 1]!) || text[end + 1] === "*"));
				if (end > i + 1) {
					flush();
					out.push({ kind: "em", children: parseInline(text.slice(i + 1, end), false) });
					i = end + 1;
					continue;
				}
				if (end === -1 && open) {
					flush();
					out.push({ kind: "em", children: parseInline(text.slice(i + 1), true) });
					return out;
				}
			}
		} else if (c === "[") {
			const close = text.indexOf("](", i + 1);
			if (close > i + 1) {
				const end = text.indexOf(")", close + 2);
				if (end !== -1) {
					const label = text.slice(i + 1, close);
					const safe = safeHref(text.slice(close + 2, end));
					if (safe) {
						flush();
						out.push({ kind: "link", ...safe, children: parseInline(label, false) });
					} else buffer += text.slice(i, end + 1);
					i = end + 1;
					continue;
				}
				if (open) {
					// "[text](" and its address so far: the label shows, the address waits for its closing bracket.
					flush();
					out.push(...parseInline(text.slice(i + 1, close), true));
					return out;
				}
			} else if (open && text.indexOf("]", i + 1) === -1) {
				// "[text" so far: it may become a link, so the bracket waits.
				flush();
				out.push(...parseInline(text.slice(i + 1), true));
				return out;
			} else if (open && text.indexOf("]", i + 1) === text.length - 1) {
				flush();
				out.push(...parseInline(text.slice(i + 1, -1), true));
				return out;
			}
		}
		buffer += c;
		i++;
	}
	flush();
	return out;
}

const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const NUMBER = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;

export function parseMarkdown(text: string, open = false): Block[] {
	const blocks: Block[] = [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let paragraph: string[] = [];
	let list: { ordered: boolean; items: string[] } | null = null;
	const last = (index: number) => open && index === lines.length - 1;
	const endParagraph = (finalIndex: number) => {
		if (paragraph.length)
			blocks.push({
				kind: "paragraph",
				lines: paragraph.map((line, n) => parseInline(line, last(finalIndex - paragraph.length + 1 + n))),
			});
		paragraph = [];
	};
	const endList = (finalIndex: number) => {
		if (list)
			blocks.push({
				kind: "list",
				ordered: list.ordered,
				items: list.items.map((item, n) => parseInline(item, last(finalIndex - list!.items.length + 1 + n))),
			});
		list = null;
	};
	lines.forEach((line, index) => {
		const bullet = BULLET.exec(line);
		const number = bullet ? null : NUMBER.exec(line);
		const item = bullet ?? number;
		if (item) {
			endParagraph(index - 1);
			const ordered = number !== null;
			if (list && list.ordered !== ordered) endList(index - 1);
			(list ??= { ordered, items: [] }).items.push(item[1]!);
		} else if (!line.trim()) {
			endParagraph(index - 1);
			endList(index - 1);
		} else if (list && /^\s{2,}\S/.test(line)) {
			// An indented line continues the list item above.
			list.items[list.items.length - 1] += " " + line.trim();
		} else {
			endList(index - 1);
			paragraph.push(line);
		}
	});
	endParagraph(lines.length - 1);
	endList(lines.length - 1);
	return blocks;
}
