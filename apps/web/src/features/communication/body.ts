const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescapeText = (value: string) =>
	value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&");

function group(match: RegExpMatchArray, n: number): string {
	const value = match[n];
	if (value === undefined) throw new Error(`Group ${n} did not take part in the match "${match[0]}"`);
	return value;
}

const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()"<>]+)\)/g;

function styled(escaped: string): string {
	return escaped
		.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "<em>$1</em>");
}

function inline(line: string): string {
	let out = "";
	let last = 0;
	for (const match of line.matchAll(LINK)) {
		const at = match.index ?? 0;
		out += styled(escapeText(line.slice(last, at)));
		out += `<a href="${escapeText(group(match, 2))}">${styled(escapeText(group(match, 1)))}</a>`;
		last = at + match[0].length;
	}
	return out + styled(escapeText(line.slice(last)));
}

const BULLET = /^- (.*)$/;
const NUMBER = /^\d+\. (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;
const QUOTE = /^> ?(.*)$/;

export function textToBody(text: string): string {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const blocks: string[] = [];
	let i = 0;
	const run = (pattern: RegExp) => {
		const found: string[] = [];
		let next: string | undefined;
		let match: RegExpExecArray | null;
		while ((next = lines[i]) !== undefined && (match = pattern.exec(next))) {
			found.push(inline(group(match, 1)));
			i += 1;
		}
		return found;
	};
	let line: string | undefined;
	while ((line = lines[i]) !== undefined) {
		if (!line.trim()) {
			i += 1;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = group(heading, 1).length;
			blocks.push(`<h${level}>${inline(group(heading, 2))}</h${level}>`);
			i += 1;
			continue;
		}
		const list = BULLET.test(line) ? BULLET : NUMBER.test(line) ? NUMBER : null;
		if (list) {
			const items = run(list).map((item) => `<li>${item}</li>`);
			const tag = list === BULLET ? "ul" : "ol";
			blocks.push(`<${tag}>${items.join("")}</${tag}>`);
			continue;
		}
		if (QUOTE.test(line)) {
			blocks.push(`<blockquote>${run(QUOTE).join("<br />")}</blockquote>`);
			continue;
		}
		const parts: string[] = [];
		let next: string | undefined;
		while (
			(next = lines[i]) !== undefined &&
			next.trim() &&
			!HEADING.test(next) &&
			!BULLET.test(next) &&
			!NUMBER.test(next) &&
			!QUOTE.test(next)
		) {
			parts.push(inline(next));
			i += 1;
		}
		blocks.push(`<p>${parts.join("<br />")}</p>`);
	}
	return blocks.join("");
}

type BodyText = { text: string; lossy: boolean };

const TOKEN = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;

export function bodyToTextResult(html: string): BodyText {
	let lossy = false;
	const blocks: { text: string; list: number }[] = [];
	let list = 0;
	let line = "";
	let listKind: "ul" | "ol" | null = null;
	let listIndex = 0;
	let inQuote = false;
	let heading = 0;
	const href: string[] = [];
	const flush = () => {
		const text = line.trim() ? line.replace(/\n+$/, "") : "";
		line = "";
		return text;
	};
	const closeBlock = (prefix: (text: string) => string, inList = false) => {
		const text = flush();
		if (text) blocks.push({ text: prefix(text), list: inList ? list : 0 });
	};
	for (const match of html.matchAll(TOKEN)) {
		if (match[4] !== undefined) {
			line += unescapeText(match[4].replace(/\s*\n\s*/g, " "));
			continue;
		}
		const closing = match[1] === "/";
		const tag = group(match, 2).toLowerCase();
		if (tag === "b" || tag === "strong") line += "**";
		else if (tag === "i" || tag === "em") line += "*";
		else if (tag === "br") line += "\n";
		else if (tag === "u" || tag === "span") lossy = true;
		else if (tag === "a") {
			if (!closing) {
				const target = /href\s*=\s*"([^"]*)"/i.exec(group(match, 3))?.[1] ?? "";
				href.push(unescapeText(target));
				line += "[";
			} else {
				const target = href.pop();
				line += target ? `](${target})` : "]";
			}
		} else if (/^h[1-3]$/.test(tag)) {
			if (!closing) heading = Number(tag[1]);
			else {
				const level = heading;
				closeBlock((text) => `${"#".repeat(level)} ${text}`);
				heading = 0;
			}
		} else if (tag === "ul" || tag === "ol") {
			if (!closing) {
				listKind = tag;
				listIndex = 0;
				list += 1;
			} else listKind = null;
		} else if (tag === "li") {
			if (!closing) listIndex += 1;
			else {
				const n = listIndex;
				const kind = listKind;
				closeBlock((text) => (kind === "ol" ? `${n}. ${text}` : `- ${text}`), true);
			}
		} else if (tag === "blockquote") {
			if (!closing) inQuote = true;
			else {
				closeBlock((text) =>
					text
						.split("\n")
						.map((part) => `> ${part}`)
						.join("\n"),
				);
				inQuote = false;
			}
		} else if (tag === "p" && closing) {
			if (inQuote) line += "\n";
			else closeBlock((text) => text);
		}
	}
	closeBlock((text) => text);
	let out = "";
	blocks.forEach((block, index) => {
		const previous = blocks[index - 1];
		out += index === 0 ? "" : previous && block.list && previous.list === block.list ? "\n" : "\n\n";
		out += block.text;
	});
	return { text: out, lossy };
}
