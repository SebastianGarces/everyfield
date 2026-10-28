import { getViewer } from "@/server/request-context";
import { requestDatabase } from "@/server/database";
import type { WikiArticle } from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { alias, and, eq, inArray } from "@everyfield/db/query";
import { article_editor_state, article_revision, organization, reading } from "@everyfield/db/tables";
import type { RequestActor } from "@everyfield/domain/access";
import { createWikiProducer } from "@everyfield/domain/wiki";
import "server-only";
import {
	articlePath,
	listed,
	sourceInput,
	sourceRows,
	treeModel,
	type Listed,
	type SourceChoice,
	type SourceRow,
	type TreeModel,
} from "./model.ts";

// Wiki pages reach the WP-034 producer here. Three reads are not on that contract: the reading-row revision,
// which bookmark and progress must send back, organization names, and which of the listed articles this account
// has completed. Each select uses only this signed-in account, and only ids the producer already returned.

type Producer = ReturnType<typeof createWikiProducer>;
type Mount = { db: Database; producer: Producer };
type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };

const MOUNT: unique symbol = Symbol.for("everyfield.web.wiki");
const slot = globalThis as { [MOUNT]?: Mount };

export function wikiMount(): Mount | null {
	const db = requestDatabase();
	if (!db) return null;
	if (!slot[MOUNT]) slot[MOUNT] = { db, producer: createWikiProducer() };
	return slot[MOUNT];
}

export async function wikiActor(): Promise<RequestActor | null | "down"> {
	const viewer = await getViewer();
	if (!viewer) return "down";
	if (viewer.status !== "active" || !viewer.authority) return null;
	return viewer.authority;
}

export function plantContext(actor: RequestActor): { plantId?: string; canOrder: boolean } {
	const context = actor.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return { canOrder: false };
	return { plantId: context.owner.id, canOrder: context.role === "owner" || context.role === "admin" };
}

/** Organization Owner or Admin. The seat owner kind is only a sending church or a sending network. */
export function editorContext(actor: RequestActor): { organizationId: string } | null {
	const context = actor.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "organization") return null;
	if (context.role !== "owner" && context.role !== "admin") return null;
	return { organizationId: context.owner.id };
}

type StoredEditor = {
	revision: string;
	state: "published" | "hide" | "draft" | "inherited" | null;
	draftBody: string | null;
	draftType: "safe_mdx" | "safe_nodes" | null;
	currentBody: string | null;
	currentType: "safe_mdx" | "safe_nodes" | null;
};

/** Editor revision. The draft read does not return it, and a write must send it back. */
async function editorRevision(mount: Mount, organizationId: string, articleId: string): Promise<StoredEditor | "lost"> {
	const draft = alias(article_revision, "wiki_draft_revision");
	const current = alias(article_revision, "wiki_current_revision");
	try {
		const rows = await mount.db
			.select({
				revision: article_editor_state.revision,
				state: article_editor_state.state,
				draftBody: draft.body,
				draftType: draft.content_type,
				currentBody: current.body,
				currentType: current.content_type,
			})
			.from(article_editor_state)
			.leftJoin(draft, eq(draft.id, article_editor_state.draft_revision_id))
			.leftJoin(current, eq(current.id, article_editor_state.current_revision_id))
			.where(
				and(eq(article_editor_state.organization_id, organizationId), eq(article_editor_state.article_id, articleId)),
			)
			.limit(1);
		const row = rows[0];
		if (!row) {
			return {
				revision: "0",
				state: null,
				draftBody: null,
				draftType: null,
				currentBody: null,
				currentType: null,
			};
		}
		return {
			revision: row.revision,
			state: row.state,
			draftBody: row.draftBody,
			draftType: row.draftType,
			currentBody: row.currentBody,
			currentType: row.currentType,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "editor-revision-failed", error: String(error) }));
		return "lost";
	}
}

/** The reading row revision. "0" means this account has no row yet. */
export async function readingRevision(actor: RequestActor, articleId: string): Promise<string> {
	const mount = wikiMount();
	if (!mount) return "0";
	try {
		const rows = await mount.db
			.select({ revision: reading.revision })
			.from(reading)
			.where(and(eq(reading.account_id, actor.actor.accountId), eq(reading.article_id, articleId)))
			.limit(1);
		return rows[0]?.revision ?? "0";
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "revision-failed", error: String(error) }));
		return "0";
	}
}

/** Completed articles among the ids on this page. The stats operation covers discovery slugs only. */
async function completedIds(actor: RequestActor, articleIds: string[]): Promise<Set<string>> {
	const mount = wikiMount();
	if (!mount || articleIds.length === 0) return new Set();
	try {
		const rows = await mount.db
			.select({ articleId: reading.article_id, fraction: reading.observed_fraction, completedAt: reading.completed_at })
			.from(reading)
			.where(and(eq(reading.account_id, actor.actor.accountId), inArray(reading.article_id, articleIds)));
		return new Set(
			rows.filter((row) => row.completedAt != null && Number(row.fraction) > 0.8).map((row) => row.articleId),
		);
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "completed-failed", error: String(error) }));
		return new Set();
	}
}

export async function organizationNames(ids: string[]): Promise<Map<string, string>> {
	const mount = wikiMount();
	const unique = [...new Set(ids)].filter((id) => id !== "00000000-0000-0000-0000-000000000000");
	if (!mount || unique.length === 0) return new Map();
	try {
		const rows = await mount.db
			.select({ id: organization.id, name: organization.name })
			.from(organization)
			.where(inArray(organization.id, unique));
		return new Map(rows.map((row) => [row.id, row.name]));
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "names-failed", error: String(error) }));
		return new Map();
	}
}

export type Preview = { crawler: boolean; allowed: boolean; title: string | null; excerpt: string | null };

export async function loadPreview(path: string, userAgent: string): Promise<Preview | null> {
	const mount = wikiMount();
	if (!mount) return null;
	try {
		const reply = await mount.producer.renderGlobalPreview(mount.db, { path, userAgent });
		if (reply.status !== "ok") return null;
		return {
			crawler: reply.value.crawler,
			allowed: reply.value.publicPreviewAllowed,
			title: reply.value.title,
			excerpt: reply.value.excerpt,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "preview-failed", error: String(error) }));
		return null;
	}
}

type Got = { article: WikiArticle | null; errorCode: "content_access_denied" | null };

async function articleOf(
	mount: Mount,
	actor: RequestActor,
	articleId: string,
	source: SourceChoice,
): Promise<Reply<Got> | { status: "lost" }> {
	try {
		return await mount.producer.getArticle(mount.db, actor, { articleId, source: sourceInput(source) });
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "article-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type ArticleBlock = "denied" | "hidden" | "order" | null;

export type ArticleView = {
	article: WikiArticle;
	sources: SourceRow[];
	currentSourceId: string;
	preferredSourceId: string;
	readingRevision: string;
	plantId?: string;
	canOrder: boolean;
	block: ArticleBlock;
	siblings: { articleId: string; title: string; slug: string }[];
	related: { articleId: string; title: string; href: string }[];
};

export type WikiPageData = {
	tree: TreeModel;
	readCount: number;
	articleCount: number;
	phaseRead: { phase: number; done: number; total: number } | null;
	resume: Listed | null;
	recent: Listed[];
	bookmarks: Listed[];
	recommended: Listed[];
	article: ArticleView | null;
	missing: boolean;
	order: boolean;
	feedback: { vote: "helpful" | "unhelpful" | null } | null;
	editorName: string | null;
	editing: boolean;
	draft: WikiDraft | null;
	draftLost: boolean;
};

export type WikiDraft = {
	organizationId: string;
	revision: string;
	state: "published" | "hide" | "draft" | "inherited" | null;
	initialBody: string | null;
	initialContentType: string;
	baselineBody: string | null;
	baselineContentType: string;
};

export async function loadWiki(
	slug: string,
	source: SourceChoice,
	order: boolean,
	editing = false,
): Promise<WikiPageData | "lost" | "signed-out"> {
	const mount = wikiMount();
	const actor = await wikiActor();
	if (actor === "down" || !mount) return "lost";
	if (!actor) return "signed-out";
	const seat = plantContext(actor);
	const editor = editorContext(actor);
	try {
		const [nav, resume, recent, marks, recommended] = await Promise.all([
			mount.producer.navigation(mount.db, actor, { source: { kind: "current" } }),
			slug ? Promise.resolve(null) : mount.producer.readingResume(mount.db, actor, {}),
			slug ? Promise.resolve(null) : mount.producer.readingRecent(mount.db, actor, {}),
			slug ? Promise.resolve(null) : mount.producer.bookmarksList(mount.db, actor, {}),
			slug ? Promise.resolve(null) : mount.producer.recommendForPhase(mount.db, actor, {}),
		]);
		if (nav.status !== "ok") return "lost";
		const visibleIds = nav.value.groups.flatMap((group) => group.articles.map((item) => item.articleId));
		const read = await completedIds(actor, visibleIds);
		const tree = treeModel(nav.value.groups, read);
		const articleCount = visibleIds.length;
		const readCount = visibleIds.filter((id) => read.has(id)).length;
		const hit = slug
			? nav.value.groups.flatMap((group) => group.articles).find((item) => item.slug === slug)
			: undefined;
		if (slug && !hit) {
			return {
				tree,
				readCount,
				articleCount,
				phaseRead: null,
				resume: null,
				recent: [],
				bookmarks: [],
				recommended: [],
				article: null,
				missing: true,
				order,
				feedback: null,
				editorName: null,
				editing,
				draft: null,
				draftLost: false,
			};
		}
		let article: ArticleView | null = null;
		let phaseRead: WikiPageData["phaseRead"] = null;
		let editorName: string | null = null;
		let draft: WikiDraft | null = null;
		let draftLost = false;
		let feedback: WikiPageData["feedback"] = null;
		if (hit) {
			const current = await articleOf(mount, actor, hit.articleId, { kind: "current" });
			if (current.status !== "ok") return "lost";
			const preferred = current.value.article;
			const viewedReply = source.kind === "current" ? current : await articleOf(mount, actor, hit.articleId, source);
			if (viewedReply.status !== "ok") return "lost";
			const viewed = source.kind === "current" ? preferred : viewedReply.value.article;
			const shown = viewed ?? preferred;
			if (!shown || !preferred) {
				return {
					tree,
					readCount,
					articleCount,
					phaseRead: null,
					resume: null,
					recent: [],
					bookmarks: [],
					recommended: [],
					article: null,
					missing: true,
					order,
					feedback: null,
					editorName: null,
					editing,
					draft: null,
					draftLost: false,
				};
			}
			const names = await organizationNames([
				preferred.sourceId,
				shown.sourceId,
				...preferred.alternates.map((item) => item.sourceId),
				...shown.alternates.map((item) => item.sourceId),
				...(editor ? [editor.organizationId] : []),
			]);
			if (editor) editorName = names.get(editor.organizationId) ?? "Your organization";
			const neighbors = await mount.producer.articleNeighbors(mount.db, actor, {
				articleId: hit.articleId,
				source: sourceInput(viewed ? source : { kind: "current" }),
			});
			const titles = new Map(nav.value.groups.flatMap((group) => group.articles).map((item) => [item.articleId, item]));
			const phaseItems = tree.phases.find((phase) => phase.number === shown.phase)?.items ?? [];
			if (shown.phase != null && phaseItems.length) {
				phaseRead = {
					phase: shown.phase,
					done: phaseItems.filter((item) => item.read).length,
					total: phaseItems.length,
				};
			}
			const block = !viewed
				? "denied"
				: shown.hidden || (shown.body == null && shown.state === "hidden")
					? "hidden"
					: shown.state === "source_order_required"
						? "order"
						: shown.body == null
							? "denied"
							: null;
			article = {
				article: shown,
				sources: sourceRows(preferred, names),
				currentSourceId: shown.sourceId,
				preferredSourceId: preferred.sourceId,
				readingRevision: await readingRevision(actor, shown.articleId),
				plantId: seat.plantId,
				canOrder: seat.canOrder,
				block,
				siblings: neighbors.status === "ok" ? neighbors.value.articles : [],
				related: shown.relatedIds.flatMap((id) => {
					const item = titles.get(id);
					return item ? [{ articleId: id, title: item.title, href: articlePath(item.slug) }] : [];
				}),
			};
		}
		if (article && editor) {
			if (!editorName) editorName = "Your organization";
			if (editing) {
				const stored = await editorRevision(mount, editor.organizationId, article.article.articleId);
				if (stored === "lost") draftLost = true;
				else {
					try {
						const reply = await mount.producer.getOrganizationDraft(mount.db, actor, {
							articleId: article.article.articleId,
							organizationId: editor.organizationId,
						});
						if (reply.status !== "ok") {
							if (reply.error.code !== "access_denied") draftLost = true;
						} else if (!reply.value.errorCode) {
							const fromDraft = reply.value.body ?? stored.draftBody;
							const initialBody =
								fromDraft ?? stored.currentBody ?? (article.block === null ? article.article.body : null);
							const initialContentType = reply.value.body
								? "safe_nodes"
								: stored.draftBody
									? (stored.draftType ?? "safe_nodes")
									: stored.currentBody
										? (stored.currentType ?? article.article.contentType)
										: article.article.contentType;
							draft = {
								organizationId: editor.organizationId,
								revision: stored.revision,
								state: reply.value.state ?? stored.state,
								initialBody,
								initialContentType,
								baselineBody: stored.currentBody ?? (article.block === null ? article.article.body : null),
								baselineContentType: stored.currentType ?? article.article.contentType,
							};
						}
					} catch (error) {
						console.error(JSON.stringify({ component: "wiki", outcome: "draft-failed", error: String(error) }));
						draftLost = true;
					}
				}
			}
		}
		if (article && article.block === null && seat.plantId && !editing) {
			let vote: "helpful" | "unhelpful" | null = null;
			try {
				const mine = await mount.producer.getMine(mount.db, actor, { articleId: article.article.articleId });
				if (mine.status === "ok" && (mine.value.currentVote === "helpful" || mine.value.currentVote === "unhelpful"))
					vote = mine.value.currentVote;
			} catch (error) {
				console.error(JSON.stringify({ component: "wiki", outcome: "feedback-failed", error: String(error) }));
			}
			feedback = { vote };
		}
		if (!article) editorName = null;
		return {
			tree,
			readCount,
			articleCount,
			phaseRead,
			resume: resume && resume.status === "ok" && resume.value.article ? listed(resume.value.article) : null,
			recent: recent && recent.status === "ok" ? recent.value.articles.slice(0, 5).map(listed) : [],
			bookmarks: marks && marks.status === "ok" ? marks.value.articles.map(listed) : [],
			recommended: recommended && recommended.status === "ok" ? recommended.value.articles.slice(0, 4).map(listed) : [],
			article,
			missing: false,
			order,
			feedback,
			editorName,
			editing,
			draft,
			draftLost,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "page-failed", error: String(error) }));
		return "lost";
	}
}

export function logSearchLost(cause: string): void {
	console.error(JSON.stringify({ component: "wiki", outcome: "search-lost", cause }));
}

export async function runSearch(
	actor: RequestActor,
	query: string,
	phase: number | null,
	page: number,
	source: SourceChoice,
): Promise<
	| "lost"
	| "denied"
	| { status: "empty" }
	| { status: "unavailable" }
	| { status: "results"; hits: Listed[]; nextPage: string | null }
> {
	const mount = wikiMount();
	if (!mount) {
		logSearchLost("no-mount");
		return "lost";
	}
	try {
		const reply = await mount.producer.search(mount.db, actor, {
			query: query.slice(0, 200),
			phase,
			page,
			source: sourceInput(source),
		});
		if (reply.status !== "ok") {
			if (reply.error.code === "access_denied") return "denied";
			logSearchLost(reply.error.code);
			return "lost";
		}
		if (reply.value.status === "unavailable") return { status: "unavailable" };
		if (reply.value.status === "empty") return { status: "empty" };
		return {
			status: "results",
			hits: reply.value.results.map((article) => ({ ...listed(article), excerpt: article.snippet ?? article.excerpt })),
			nextPage: reply.value.nextCursor,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "search-failed", error: String(error) }));
		return "lost";
	}
}
