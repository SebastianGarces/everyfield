import type { Database } from "@everyfield/db/client";
import { EDITOR_FORMAT, organizationBodyFits, wikiBlocks, type WikiBlock } from "@everyfield/contracts/wiki";
import { createWikiProducer } from "@everyfield/domain/wiki";
import type { EvryActor } from "../../context/actor.ts";
import { EvryRefusal } from "../../context/errors.ts";
import { organizationAdmin } from "../native.ts";

const wiki = createWikiProducer();

type Run = { type: "text"; text: string; marks: [] };
type TextNode = { type: "paragraph" | "heading" | "quote" | "callout"; children: Run[]; level?: 2 | 3; label?: string };
type ListNode = { type: "list"; ordered: boolean; items: Run[][] };
type FixedNode =
	| { type: "table"; rows: Run[][][] }
	| { type: "code"; language: "text"; text: string }
	| { type: "diagram"; info: string; source: string };
type EditorNode = TextNode | ListNode | FixedNode;

const run = (text: string): Run[] => [{ type: "text", text, marks: [] }];
const paragraph = (text: string): TextNode => ({ type: "paragraph", children: run(text) });

function nodesOf(blocks: readonly WikiBlock[]): EditorNode[] {
	return blocks.flatMap((b): EditorNode[] => {
		if (b.kind === "heading")
			return b.level === 2 || b.level === 3
				? [{ type: "heading", level: b.level, children: run(b.text) }]
				: b.text
					? [paragraph(b.text)]
					: [];
		if (b.kind === "paragraph") return b.paragraphs.map(paragraph);
		if (b.kind === "component") return b.text.split("\n").filter(Boolean).map(paragraph);
		if (b.kind === "quote") return [{ type: "quote", children: run(b.text) }];
		if (b.kind === "list") return [{ type: "list", ordered: b.ordered, items: b.items.map(run) }];
		if (b.kind === "table") return b.rows.length ? [{ type: "table", rows: b.rows.map((r) => r.map(run)) }] : [];
		if (b.kind === "callout") return [{ type: "callout", label: b.label, children: run(b.text) }];
		if (b.kind === "code") return [{ type: "code", language: "text", text: b.text }];
		if (b.kind === "diagram") return [{ type: "diagram", info: b.info, source: b.source }];
		return [];
	});
}

const texts = (node: EditorNode): string[] =>
	node.type === "list"
		? node.items.map((item) => item[0]?.text ?? "")
		: "children" in node
			? [node.children[0]?.text ?? ""]
			: [];

function withTexts(node: EditorNode, next: string[]): EditorNode {
	if (node.type === "list") return { ...node, items: next.map(run) };
	return "children" in node ? { ...node, children: run(next[0] ?? "") } : node;
}

export const editorBody = (nodes: readonly EditorNode[]) => JSON.stringify({ format: EDITOR_FORMAT, blocks: nodes });
export const bodyFits = (nodes: readonly EditorNode[]) => organizationBodyFits(editorBody(nodes));
export const withParagraph = (nodes: readonly EditorNode[], text: string) => [...nodes, paragraph(text)];
type Replaced = { nodes: EditorNode[]; before: string; after: string } | { found: number };
export function replaceParagraph(nodes: readonly EditorNode[], about: string, text: string): Replaced {
	const words = about.toLowerCase();
	const found = nodes.flatMap(texts).filter((t) => t.toLowerCase().includes(words)).length;
	if (found !== 1) return { found };
	let before = "";
	const next = nodes.map((node) => {
		const own = texts(node);
		if (!own.some((t) => t.toLowerCase().includes(words))) return node;
		return withTexts(
			node,
			own.map((t) => {
				if (!t.toLowerCase().includes(words)) return t;
				before = t;
				return text;
			}),
		);
	});
	return { nodes: next, before, after: text };
}

type VersionState = "none" | "draft" | "published" | "hidden";
export type OrganizationVersion = {
	articleId: string;
	revisionId: string;
	title: string;
	href: string;
	organizationId: string;
	organization: string;
	revision: string;
	state: VersionState;
	hasDraft: boolean;
	body: string;
	nodes: EditorNode[];
};

const WIKI_VIEW = { kind: "global" } as const;
const editorHref = (slug: string) => `/wiki/${slug.split("/").map(encodeURIComponent).join("/")}/edit`;

export async function organizationVersion(db: Database, actor: EvryActor, query: string): Promise<OrganizationVersion> {
	if (!organizationAdmin(actor)) throw new EvryRefusal("access_denied");
	const organizationId = actor.owner.id;
	const found = await wiki.search(db, actor.authority, { query, source: WIKI_VIEW });
	if (found.status !== "ok" || found.value.status === "unavailable") throw new EvryRefusal("source_unavailable");
	const articleId = found.value.results[0]?.articleId;
	if (!articleId) throw new EvryRefusal("not_found");
	const draft = await wiki.getOrganizationDraft(db, actor.authority, { articleId, organizationId });
	if (draft.status !== "ok" || draft.value.errorCode) throw new EvryRefusal("access_denied");
	const reply = await wiki.getArticle(db, actor.authority, { articleId, source: WIKI_VIEW });
	const article = reply.status === "ok" ? reply.value.article : null;
	if (!article) throw new EvryRefusal("not_found");
	const stored = await wiki.readEditorState(db, organizationId, articleId);
	const names = await wiki.listOrganizationNames(db, [organizationId]);
	const state: VersionState =
		stored.state === "published" ? "published" : stored.state === "hide" ? "hidden" : stored.state ? "draft" : "none";
	const base = stored.draftBody
		? { body: stored.draftBody, type: stored.draftType ?? "safe_nodes" }
		: stored.currentBody
			? { body: stored.currentBody, type: stored.currentType ?? article.contentType }
			: article.body
				? { body: article.body, type: article.contentType }
				: null;
	if (!base) throw new EvryRefusal("not_found");
	return {
		articleId,
		revisionId: article.revisionId,
		title: article.title,
		href: editorHref(article.slug),
		organizationId,
		organization: names.get(organizationId) ?? "Your organization",
		revision: stored.revision,
		state,
		hasDraft: stored.draftBody !== null,
		body: base.body,
		nodes: nodesOf(wikiBlocks(base.type, base.body)),
	};
}
