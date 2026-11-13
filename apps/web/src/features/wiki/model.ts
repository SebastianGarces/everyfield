import {
	EDITOR_FORMAT,
	editorDocumentBlocks,
	humanCredit,
	wikiBlocks,
	type Diagram,
	type WikiArticle,
	type WikiBlock,
} from "@everyfield/contracts/wiki";
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

function sourceQuery(choice: SourceChoice): string | null {
	if (choice.kind === "global") return "global";
	if (choice.kind === "organization") return choice.organizationId;
	return null;
}

/** Catch-all params back into the slug the producer stored. */
function slugFromParts(parts: string[] | undefined): string {
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

type NavItem = { id: string; title: string; href: string; read?: boolean; phase: number | null };

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

/** The church's stored Wiki source order, as wiki.setSourceOrder keeps it. Revision "0": no order is stored yet. */
export type SourceOrder = { revision: string; churches: string[]; networks: string[] };

/** The list with `id` first and the rest in the order they had. */
export const toHead = (ids: readonly string[], id: string): string[] => [id, ...ids.filter((item) => item !== id)];

/**
 * The order that makes `source` the preferred one in its own list, or null when "Set as preferred" is not offered:
 * no order to change (not an Owner or Admin), the Global source, the source already preferred here, or already first
 * in its list. With two or more churches and no stored order, any church can be chosen, even the first one listed.
 */
export function preferredOrder(
	order: SourceOrder | null,
	source: Pick<SourceRow, "id" | "kind">,
	preferredId: string,
): (SourceOrder & { list: "churches" | "networks" }) | null {
	if (!order || source.kind === "global" || source.id === preferredId) return null;
	const list = source.kind === "church" ? "churches" : "networks";
	const index = order[list].indexOf(source.id);
	const unordered = list === "churches" && order.revision === "0" && order.churches.length > 1;
	if (index < 0 || (index === 0 && !unordered)) return null;
	return { ...order, list, [list]: toHead(order[list], source.id) };
}

export type Block =
	| { kind: "heading"; level: 2 | 3; text: string; id: string }
	| { kind: "paragraph"; text: string }
	| { kind: "quote"; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "table"; rows: string[][] }
	| { kind: "callout"; label: string; text: string }
	| { kind: "code"; text: string }
	/** `info` and `source` are the fence as written, so a save keeps the diagram as its author wrote it. */
	| { kind: "diagram"; diagram: Diagram; info: string; source: string };

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

/** The reader's view of the shared blocks: headings 2 and 3 with ids, one paragraph per line, no blanks or breaks. */
function readerBlocks(blocks: readonly WikiBlock[]): Block[] {
	const out: Block[] = [];
	for (const block of blocks) {
		if (block.kind === "heading") {
			if (block.level === 2 || block.level === 3)
				out.push({ kind: "heading", level: block.level, text: block.text, id: "" });
			else if (block.text) out.push({ kind: "paragraph", text: block.text });
		} else if (block.kind === "paragraph")
			out.push(...block.paragraphs.map((text) => ({ kind: "paragraph" as const, text })));
		else if (block.kind === "component")
			out.push(...block.text.split("\n").flatMap((text) => (text ? [{ kind: "paragraph" as const, text }] : [])));
		else if (block.kind === "quote") out.push({ kind: "quote", text: block.text });
		else if (block.kind === "list") out.push({ kind: "list", ordered: block.ordered, items: block.items });
		else if (block.kind === "table") {
			if (block.rows.length) out.push({ kind: "table", rows: block.rows });
		} else if (block.kind === "callout") out.push({ kind: "callout", label: block.label, text: block.text });
		else if (block.kind === "code") out.push({ kind: "code", text: block.text });
		else if (block.kind === "diagram")
			out.push({ kind: "diagram", diagram: block.diagram, info: block.info, source: block.source });
	}
	return withIds(out);
}

/** A stored body as the reader shows it (wikiBlocks, the one parser the excerpt, PDF and print export also read). */
export function articleBlocks(contentType: string, body: string): Block[] {
	return readerBlocks(wikiBlocks(contentType, body));
}

export type Inline =
	{ kind: "text"; text: string } | { kind: "strong"; text: string } | { kind: "link"; text: string; href: string };

function safeHref(raw: string): string | null {
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

/** Whose text an article shows, when it is not the global article. */
export type ArticleVersion = { kind: "church" | "network"; name: string };

export type Listed = {
	articleId: string;
	title: string;
	slug: string;
	excerpt: string | null;
	observedFraction: string;
	completed: boolean;
	/** A meaningful revision came after this reader finished it. */
	updated: boolean;
};

export function listed(article: WikiArticle): Listed {
	return {
		articleId: article.articleId,
		title: article.title,
		slug: article.slug,
		excerpt: article.excerpt,
		observedFraction: article.observedFraction,
		completed: article.completed,
		updated: article.updatedLabel,
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

/** A block the editor shows as the reader renders it and saves unchanged. */
export type FixedBlock = Extract<Block, { kind: "table" | "callout" | "code" | "diagram" }>;

export type EditorBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; level: 2 | 3; text: string }
	| { kind: "quote"; text: string }
	| { kind: "list"; ordered: boolean; text: string }
	| { kind: "fixed"; block: FixedBlock };

function readerToEditor(block: Block): EditorBlock {
	if (block.kind === "heading") return { kind: "heading", level: block.level, text: block.text };
	if (block.kind === "quote") return { kind: "quote", text: block.text };
	if (block.kind === "list") return { kind: "list", ordered: block.ordered, text: block.items.join("\n") };
	if (block.kind === "paragraph") return { kind: "paragraph", text: block.text };
	return { kind: "fixed", block };
}

function editorFromContract(value: unknown): EditorBlock[] | null {
	const blocks = editorDocumentBlocks(value);
	return blocks && readerBlocks(blocks).map(readerToEditor);
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

const run = (text: string) => [{ type: "text", text, marks: [] }];

function fixedNode(block: FixedBlock): unknown {
	if (block.kind === "table") return { type: "table", rows: block.rows.map((row) => row.map(run)) };
	if (block.kind === "callout") return { type: "callout", label: block.label, children: run(block.text) };
	if (block.kind === "code") return { type: "code", language: "text", text: block.text };
	return { type: "diagram", info: block.info, source: block.source };
}

function contractBlock(block: EditorBlock): unknown {
	if (block.kind === "fixed") return fixedNode(block.block);
	const text = run(block.text);
	if (block.kind === "heading") return { type: "heading", level: block.level, children: text };
	if (block.kind === "quote") return { type: "quote", children: text };
	if (block.kind === "list") {
		const items = block.text
			.split("\n")
			.map((item) => item.trim())
			.filter(Boolean)
			.map(run);
		return { type: "list", ordered: block.ordered, items: items.length ? items : [run("")] };
	}
	return { type: "paragraph", children: text };
}

function editorDocumentJson(blocks: EditorBlock[]): string {
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
	return blocks.some((block) => block.kind === "fixed" || block.text.trim().length > 0);
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
