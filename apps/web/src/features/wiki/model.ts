import type { WikiArticle } from "@everyfield/contracts/wiki";
import { z } from "zod";

// View models for the wiki screens. The producer is the authority for entitlement.
// These helpers only shape text the screen already received.

export const PHASE_NAME = [
	"Discovery",
	"Core Group Development",
	"Launch Team Formation",
	"Training & Preparation",
	"Pre-Launch",
	"Launch Sunday",
	"Post-Launch",
] as const;

const uuid = z.uuid();

export type SourceChoice = { kind: "current" } | { kind: "global" } | { kind: "organization"; organizationId: string };

export type SourceInput = { kind: "current" } | { kind: "global" } | { kind: "organization"; organizationId: string };

/** A query source. Anything else is the reader's current source. */
export function parseSource(raw: string | string[] | undefined): SourceChoice {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (value === "global") return { kind: "global" };
	if (value && uuid.safeParse(value).success) return { kind: "organization", organizationId: value };
	return { kind: "current" };
}

export function sourceInput(choice: SourceChoice): SourceInput {
	return choice.kind === "current" ? { kind: "current" } : choice;
}

export function sourceQuery(choice: SourceChoice): string | null {
	if (choice.kind === "global") return "global";
	if (choice.kind === "organization") return choice.organizationId;
	return null;
}

/** Catch-all params back into the slug the producer stored. */
export function slugFromParts(parts: string[] | undefined): string {
	if (!parts?.length) return "";
	return parts
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		})
		.join("/");
}

/** One encoding per segment. Slashes in the slug stay as path separators. */
export function articlePath(slug: string): string {
	if (!slug) return "/wiki";
	return `/wiki/${slug
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
}

export function wikiReturn(path: string, choice: SourceChoice): string {
	const source = sourceQuery(choice);
	return source ? `${path}?source=${encodeURIComponent(source)}` : path;
}

const CRAWLER = /facebookexternalhit|Twitterbot|Slackbot|LinkedInBot|Googlebot|bingbot/i;

/** Same test as the wiki producer. The page uses it only to skip the session read. */
export function isCrawler(userAgent: string | null | undefined): boolean {
	if (!userAgent) return false;
	return userAgent === "crawler" || CRAWLER.test(userAgent);
}

export function fractionText(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1) return "1";
	const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
	return text.startsWith("0.") ? text : "0";
}

export function percentLabel(fraction: string): string {
	const n = Number(fraction);
	if (!Number.isFinite(n)) return "0% read";
	return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}% read`;
}

export function pdfFilename(slug: string): string {
	const clean = slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${clean || "article"}.pdf`;
}

export type NavItem = { id: string; title: string; href: string; read?: boolean; phase: number | null };

export type TreeModel = {
	phases: { number: number; name: string; items: NavItem[] }[];
	more: { name: string; items: NavItem[] }[];
};

type NavGroup = {
	name: string;
	articles: { articleId: string; title: string; slug: string; phase: number | null }[];
};

export function treeModel(groups: NavGroup[], read: ReadonlySet<string>): TreeModel {
	const byPhase = new Map<number, NavItem[]>();
	const more: TreeModel["more"] = [];
	for (const group of groups) {
		const items = group.articles.map((article) => ({
			id: article.articleId,
			title: article.title,
			href: articlePath(article.slug),
			read: read.has(article.articleId),
			phase: article.phase,
		}));
		const journey = /^Journey ([0-6])$/.exec(group.name);
		if (journey?.[1]) {
			if (items.length) byPhase.set(Number(journey[1]), items);
		} else if (items.length) more.push({ name: group.name, items });
	}
	const phases = [...byPhase.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([number, items]) => ({ number, name: PHASE_NAME[number] ?? "Journey", items }));
	return { phases, more };
}

export type SourceRow = {
	id: string;
	kind: "church" | "network" | "global";
	name: string;
	short: string;
	barKind: "network" | "global";
	meta: string;
};

function letters(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	const raw = words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : name.slice(0, 2);
	const text = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return text.slice(0, 2) || "SO";
}

export function humanCredit(credit: string): string | null {
	if (!credit || /^(church|network|global):/i.test(credit)) return null;
	if (uuid.safeParse(credit).success) return null;
	return credit;
}

export function sourceRows(article: WikiArticle, names: ReadonlyMap<string, string>): SourceRow[] {
	const seen = new Set<string>();
	const rows: SourceRow[] = [];
	const add = (id: string, kind: SourceRow["kind"], credit: string, state: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		const named = kind === "global" ? "Global" : names.get(id) || humanCredit(credit);
		const name = named || (kind === "church" ? "Church" : kind === "network" ? "Network" : "Global");
		const meta =
			state === "hidden"
				? "Hidden"
				: state === "inherited"
					? "Inherited"
					: state === "source_order_required"
						? "Order required"
						: "Published";
		rows.push({
			id,
			kind,
			name,
			short: letters(name),
			barKind: kind === "global" ? "global" : "network",
			meta: credit && humanCredit(credit) && kind !== "global" ? `${meta} · ${humanCredit(credit)}` : meta,
		});
	};
	add(article.sourceId, article.sourceKind, article.credit, article.state);
	for (const alternate of article.alternates) add(alternate.sourceId, alternate.sourceKind, "", alternate.state);
	return rows;
}

export type Block =
	| { kind: "heading"; level: 2 | 3; text: string; id: string }
	| { kind: "paragraph"; text: string }
	| { kind: "quote"; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "callout"; label: string; text: string };

function headingId(text: string, used: Map<string, number>): string {
	const base =
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "section";
	const n = used.get(base) ?? 0;
	used.set(base, n + 1);
	return n === 0 ? base : `${base}-${n + 1}`;
}

function withIds(blocks: Block[]): Block[] {
	const used = new Map<string, number>();
	return blocks.map((block) => (block.kind === "heading" ? { ...block, id: headingId(block.text, used) } : block));
}

function cells(line: string): string[] {
	return line
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell.length > 0 && !/^:?-+:?$/.test(cell));
}

/** The published markdown subset: headings, paragraphs, lists, tables, quotes and callouts. */
export function markdownBlocks(body: string): Block[] {
	const blocks: Block[] = [];
	const lines = body.split(/\n/);
	let index = 0;
	while (index < lines.length) {
		const trimmed = (lines[index] ?? "").trim();
		if (!trimmed) {
			index += 1;
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
		if (heading?.[1] && heading[2]) {
			const level = heading[1].length;
			if (level === 2 || level === 3) blocks.push({ kind: "heading", level, text: heading[2].trim(), id: "" });
			else blocks.push({ kind: "paragraph", text: heading[2].trim() });
			index += 1;
			continue;
		}
		if (/^<Callout\b/.test(trimmed)) {
			const type = /type="([A-Za-z]+)"/.exec(trimmed)?.[1] ?? "";
			const inline = trimmed
				.replace(/^<Callout\b[^>]*>/, "")
				.replace(/<\/Callout>\s*$/, "")
				.trim();
			const inner: string[] = inline ? [inline] : [];
			if (!trimmed.includes("</Callout>")) {
				index += 1;
				while (index < lines.length && !(lines[index] ?? "").includes("</Callout>")) {
					const text = (lines[index] ?? "").trim();
					if (text) inner.push(text);
					index += 1;
				}
			}
			blocks.push({
				kind: "callout",
				label: type ? type[0]!.toUpperCase() + type.slice(1) : "",
				text: inner.join("\n"),
			});
			index += 1;
			continue;
		}
		if (trimmed === "</Callout>" || trimmed === "---") {
			index += 1;
			continue;
		}
		if (trimmed.startsWith("|")) {
			const rows: string[][] = [];
			while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
				const row = cells(lines[index] ?? "");
				if (row.length) rows.push(row);
				index += 1;
			}
			if (rows.length) blocks.push({ kind: "table", rows });
			continue;
		}
		if (trimmed.startsWith(">")) {
			const quote: string[] = [];
			while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) {
				quote.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
				index += 1;
			}
			blocks.push({ kind: "quote", text: quote.join(" ") });
			continue;
		}
		const item = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(trimmed);
		if (item?.[1]) {
			const ordered = /^\d+\./.test(trimmed);
			const items: string[] = [];
			while (index < lines.length) {
				const next = /^(?:[-*]|\d+\.)\s+(.+)$/.exec((lines[index] ?? "").trim());
				if (!next?.[1]) break;
				items.push(next[1].trim());
				index += 1;
			}
			blocks.push({ kind: "list", ordered, items });
			continue;
		}
		blocks.push({ kind: "paragraph", text: trimmed });
		index += 1;
	}
	return withIds(blocks);
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("");
	if (!value || typeof value !== "object") return "";
	const node = value as { type?: string; text?: string; content?: unknown; children?: unknown };
	if (node.type === "script" || node.type === "import" || node.type === "mdxjsEsm") return "";
	if (typeof node.text === "string" && !node.content && !node.children) return node.text;
	return textOf(node.content ?? node.children ?? "");
}

function nodeBlocks(value: unknown, blocks: Block[]): void {
	if (Array.isArray(value)) {
		value.forEach((item) => nodeBlocks(item, blocks));
		return;
	}
	if (!value || typeof value !== "object") return;
	const node = value as {
		type?: string;
		level?: number;
		text?: string;
		content?: unknown;
		children?: unknown;
	};
	if (node.type === "script" || node.type === "import" || node.type === "mdxjsEsm") return;
	const kids = node.content ?? node.children;
	const heading =
		node.type === "h2" || node.type === "h3" || node.type === "heading" || node.level === 2 || node.level === 3;
	if (heading && (typeof node.text === "string" || kids)) {
		const level = node.type === "h3" || node.level === 3 ? 3 : 2;
		const text = typeof node.text === "string" ? node.text : textOf(kids);
		if (text && (level === 2 || level === 3)) blocks.push({ kind: "heading", level, text, id: "" });
		return;
	}
	if (
		node.type === "bulletList" ||
		node.type === "orderedList" ||
		node.type === "list" ||
		node.type === "ul" ||
		node.type === "ol"
	) {
		const items = (Array.isArray(kids) ? kids : [])
			.map((item) => textOf(item))
			.map((item) => item.trim())
			.filter(Boolean);
		if (items.length) blocks.push({ kind: "list", ordered: node.type === "orderedList" || node.type === "ol", items });
		return;
	}
	if (node.type === "callout") {
		const text = textOf(kids ?? node.text);
		if (text) blocks.push({ kind: "callout", label: "", text });
		return;
	}
	if (node.type === "blockquote") {
		const text = textOf(kids ?? node.text);
		if (text) blocks.push({ kind: "quote", text });
		return;
	}
	if (node.type === "paragraph" || node.type === "p") {
		const text = textOf(kids ?? node.text).trim();
		if (text) blocks.push({ kind: "paragraph", text });
		return;
	}
	if (kids) nodeBlocks(kids, blocks);
}

/** Organization nodes become the same blocks. Raw JSON is never shown. */
export function nodeDocument(body: string): Block[] | null {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const blocks: Block[] = [];
		nodeBlocks(parsed, blocks);
		if (!blocks.length) {
			const text = textOf(parsed).trim();
			if (!text) return [];
			return [{ kind: "paragraph", text }];
		}
		return withIds(blocks);
	} catch {
		return null;
	}
}

export function articleBlocks(contentType: string, body: string): Block[] {
	if (contentType === "safe_nodes") return nodeDocument(body) ?? markdownBlocks(body);
	return markdownBlocks(body);
}

export type Inline =
	{ kind: "text"; text: string } | { kind: "strong"; text: string } | { kind: "link"; text: string; href: string };

export function safeHref(raw: string): string | null {
	if (raw.startsWith("/wiki/") || raw.startsWith("#")) return raw;
	try {
		const url = new URL(raw);
		if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
	} catch {
		return null;
	}
	return null;
}

/** Bold and links only. Every other marker stays as text. */
export function inlineParts(text: string): Inline[] {
	const parts: Inline[] = [];
	const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
		if (match[1]) parts.push({ kind: "strong", text: match[1] });
		else if (match[2] && match[3]) {
			const href = safeHref(match[3]);
			if (href) parts.push({ kind: "link", text: match[2], href });
			else parts.push({ kind: "text", text: match[0] });
		}
		cursor = index + match[0].length;
	}
	if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
	return parts.length ? parts : [{ kind: "text", text }];
}

export type SnippetPart = { text: string; mark: boolean };

/** Postgres headlines wrap matches in b tags. Nothing else is treated as markup. */
export function snippetParts(raw: string): SnippetPart[] {
	const parts: SnippetPart[] = [];
	const pattern = /<b>(.*?)<\/b>/gi;
	let cursor = 0;
	for (const match of raw.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) parts.push({ text: stripTags(raw.slice(cursor, index)), mark: false });
		parts.push({ text: stripTags(match[1] ?? ""), mark: true });
		cursor = index + match[0].length;
	}
	if (cursor < raw.length) parts.push({ text: stripTags(raw.slice(cursor)), mark: false });
	return parts.filter((part) => part.text.length > 0);
}

function stripTags(text: string): string {
	return text.replace(/<[^>]*>/g, "");
}

export type Listed = {
	articleId: string;
	title: string;
	slug: string;
	excerpt: string | null;
	observedFraction: string;
	completed: boolean;
};

export function listed(article: WikiArticle): Listed {
	return {
		articleId: article.articleId,
		title: article.title,
		slug: article.slug,
		excerpt: article.excerpt,
		observedFraction: article.observedFraction,
		completed: article.completed,
	};
}
