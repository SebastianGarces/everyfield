import { fenceAt, fenceContent, type Diagram, type WikiArticle } from "@everyfield/contracts/wiki";
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

export type Step = { title: string; href: string; group: string };

/** The article before and after `currentId` in the order the sidenav draws: journey phases, then the other groups. */
export function stepsAround(tree: TreeModel, currentId: string): { previous: Step | null; next: Step | null } {
	const flat = [
		...tree.phases.map((phase) => ({ group: `Phase ${phase.number} · ${phase.name}`, items: phase.items })),
		...tree.more.map((group) => ({ group: group.name, items: group.items })),
	].flatMap((group) =>
		group.items.map((item) => ({ id: item.id, title: item.title, href: item.href, group: group.group })),
	);
	const index = flat.findIndex((item) => item.id === currentId);
	if (index < 0) return { previous: null, next: null };
	const here = flat[index]?.group;
	const step = (item: (typeof flat)[number] | undefined): Step | null =>
		item ? { title: item.title, href: item.href, group: item.group === here ? "" : item.group } : null;
	return { previous: step(flat[index - 1]), next: step(flat[index + 1]) };
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

/** A credit that names a person or church. Internal ids, source paths and digests never reach a reader. */
export function humanCredit(credit: string): string | null {
	if (!credit || /^(church|network|global):/i.test(credit)) return null;
	if (uuid.safeParse(credit).success) return null;
	if (/\.(json|mdx?|ya?ml)\b|\bdocs\/|@[0-9a-f]{7,}|\b[0-9a-f]{40,}\b/i.test(credit)) return null;
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
	| { kind: "callout"; label: string; text: string }
	| { kind: "code"; text: string }
	| { kind: "diagram"; diagram: Diagram };

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

/** The published markdown subset: headings, paragraphs, lists, tables, quotes, callouts and fenced blocks. */
export function markdownBlocks(body: string): Block[] {
	const blocks: Block[] = [];
	const lines = body.split(/\n/);
	let index = 0;
	while (index < lines.length) {
		const fence = fenceAt(lines, index);
		if (fence) {
			// Fence lines are never markdown.
			blocks.push(fenceContent(fence));
			index = fence.end;
			continue;
		}
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
		const editor = blocksFromEditorDocument(parsed);
		if (editor) return withIds(editor);
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

/** `/wiki/a/b/edit` opens the organization editor. A slug alone named edit stays an article. */
export function splitWikiPath(parts: string[] | undefined): { slug: string; editing: boolean } {
	if (parts && parts.length >= 2 && parts[parts.length - 1] === "edit") {
		return { slug: slugFromParts(parts.slice(0, -1)), editing: true };
	}
	return { slug: slugFromParts(parts), editing: false };
}

export function editPath(slug: string): string {
	return `${articlePath(slug)}/edit`;
}

export type EditorBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; level: 2 | 3; text: string }
	| { kind: "quote"; text: string }
	| { kind: "list"; ordered: boolean; text: string };

const EDITOR_FORMAT = "everyfield-editor-v1";
export const EDITOR_BODY_LIMIT = 20000;

function inlineText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const node = part as { type?: string; text?: string; children?: unknown };
			if (node.type === "text" && typeof node.text === "string") return node.text;
			if (node.type === "link") return inlineText(node.children);
			return "";
		})
		.join("");
}

function blocksFromEditorDocument(value: unknown): Block[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const doc = value as { format?: unknown; blocks?: unknown };
	if (doc.format !== EDITOR_FORMAT || !Array.isArray(doc.blocks)) return null;
	const blocks: Block[] = [];
	for (const raw of doc.blocks) {
		const block = contractToReader(raw);
		if (block) blocks.push(block);
	}
	return blocks;
}

function contractToReader(value: unknown): Block | null {
	if (!value || typeof value !== "object") return null;
	const node = value as {
		type?: string;
		level?: number;
		text?: string;
		ordered?: boolean;
		children?: unknown;
		items?: unknown;
		rows?: unknown;
	};
	if (node.type === "heading") {
		const text = inlineText(node.children).trim();
		if (!text) return null;
		if (node.level === 2 || node.level === 3) return { kind: "heading", level: node.level, text, id: "" };
		return { kind: "paragraph", text };
	}
	if (node.type === "paragraph" || node.type === "quote") {
		const text = inlineText(node.children).trim();
		if (!text) return null;
		return node.type === "quote" ? { kind: "quote", text } : { kind: "paragraph", text };
	}
	if (node.type === "list" && Array.isArray(node.items)) {
		const items = node.items.map((item) => inlineText(item).trim()).filter(Boolean);
		if (!items.length) return null;
		return { kind: "list", ordered: node.ordered === true, items };
	}
	if (node.type === "code" && typeof node.text === "string" && node.text.trim()) {
		return { kind: "paragraph", text: node.text.trim() };
	}
	if (node.type === "table" && Array.isArray(node.rows)) {
		const rows = node.rows
			.map((row) => (Array.isArray(row) ? row.map((cell) => inlineText(cell).trim()) : []))
			.filter((row) => row.some(Boolean));
		if (!rows.length) return null;
		return { kind: "table", rows };
	}
	return null;
}

/** A diagram as plain lines for the editor, which has no diagram block: its title, then each node label. */
function diagramLines(diagram: Diagram): string[] {
	const labels = (nodes: readonly { label: string; children?: readonly unknown[] }[]): string[] =>
		nodes.flatMap((node) => [node.label, ...labels((node.children ?? []) as typeof nodes)]);
	return [diagram.title, ...labels(diagram.nodes)];
}

function readerToEditor(block: Block): EditorBlock {
	if (block.kind === "heading") return { kind: "heading", level: block.level, text: block.text };
	if (block.kind === "quote") return { kind: "quote", text: block.text };
	if (block.kind === "list") return { kind: "list", ordered: block.ordered, text: block.items.join("\n") };
	if (block.kind === "table") return { kind: "paragraph", text: block.rows.map((row) => row.join(" · ")).join("\n") };
	if (block.kind === "callout")
		return { kind: "paragraph", text: block.label ? `${block.label}: ${block.text}` : block.text };
	if (block.kind === "diagram") return { kind: "paragraph", text: diagramLines(block.diagram).join("\n") };
	return { kind: "paragraph", text: block.text };
}

function editorFromContract(value: unknown): EditorBlock[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const doc = value as { format?: unknown; blocks?: unknown };
	if (doc.format !== EDITOR_FORMAT || !Array.isArray(doc.blocks)) return null;
	const blocks: EditorBlock[] = [];
	for (const raw of doc.blocks) {
		const reader = contractToReader(raw);
		if (reader) blocks.push(readerToEditor(reader));
	}
	return blocks;
}

/** Draft JSON first. Published markdown and older plain text become the same blocks. */
export function editorBlocksFromBody(contentType: string, body: string): EditorBlock[] {
	try {
		const parsed = editorFromContract(JSON.parse(body) as unknown);
		if (parsed && parsed.length) return parsed;
	} catch {
		// Plain text and markdown are not editor JSON.
	}
	return articleBlocks(contentType, body).map(readerToEditor);
}

function contractBlock(block: EditorBlock): unknown {
	const text = [{ type: "text", text: block.text, marks: [] }];
	if (block.kind === "heading") return { type: "heading", level: block.level, children: text };
	if (block.kind === "quote") return { type: "quote", children: text };
	if (block.kind === "list") {
		const items = block.text
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean)
			.map((item) => [{ type: "text", text: item, marks: [] }]);
		return {
			type: "list",
			ordered: block.ordered,
			items: items.length ? items : [[{ type: "text", text: "", marks: [] }]],
		};
	}
	return { type: "paragraph", children: text };
}

export function editorDocumentJson(blocks: EditorBlock[]): string {
	return JSON.stringify({ format: EDITOR_FORMAT, blocks: blocks.map(contractBlock) });
}

/**
 * The body to store. An unchanged editor keeps the loaded text, so a save does not turn
 * markdown or a table into editor JSON. An edit stores everyfield-editor-v1.
 */
export function editorWriteBody(initialBody: string | null, initialContentType: string, blocks: EditorBlock[]): string {
	if (initialBody) {
		const seeded = editorBlocksFromBody(initialContentType, initialBody);
		if (seeded.length > 0 && editorDocumentJson(seeded) === editorDocumentJson(blocks)) return initialBody;
	}
	return editorDocumentJson(blocks);
}

export function editorHasText(blocks: EditorBlock[]): boolean {
	return blocks.some((block) => block.text.trim().length > 0);
}

export function changedSectionLabels(before: EditorBlock[], after: EditorBlock[]): string[] {
	const previous = before.flatMap((block) =>
		block.kind === "heading" && block.text.trim() ? [block.text.trim()] : [],
	);
	const next = after.flatMap((block) => (block.kind === "heading" && block.text.trim() ? [block.text.trim()] : []));
	const labels: string[] = [];
	const count = Math.max(previous.length, next.length);
	for (let index = 0; index < count; index += 1) {
		const prior = previous[index];
		const current = next[index];
		if (prior === current) continue;
		if (current) labels.push(current);
		else if (prior) labels.push(`Removed: ${prior}`);
	}
	return labels;
}

export function articleTextChanged(before: EditorBlock[], after: EditorBlock[]): boolean {
	return editorDocumentJson(before) !== editorDocumentJson(after);
}
