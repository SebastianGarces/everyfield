import { getViewer } from "@/server/request-context";
import { requestDatabase } from "@/server/database";
import { humanCredit, type WikiArticle } from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import { alias, and, eq, inArray } from "@everyfield/db/query";
import { article_editor_state, article_revision, organization, reading } from "@everyfield/db/tables";
import type { RequestActor } from "@everyfield/domain/access";
import { createWikiProducer } from "@everyfield/domain/wiki";
import { cache } from "react";
import "server-only";
import {
	type ArticleVersion,
	articlePath,
	listed,
	sourceInput,
	sourceRows,
	treeModel,
	type Listed,
	type SourceChoice,
	type SourceOrder,
	type SourceRow,
	type TreeModel,
} from "./model.ts";
import { isTransient, logFailure, logLine, type LogWord } from "@everyfield/domain/log";
import { parseJson } from "../../server/platform/json.ts";
import { mutatingRoute } from "../../server/platform/boundary.ts";
import { ServerConfigError } from "../../server/config.ts";
import { LOST, transient, unexpected } from "../../server/platform/transient.ts";

type Producer = ReturnType<typeof createWikiProducer>;
type Mount = { db: Database; producer: Producer };
type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };

const MOUNT: unique symbol = Symbol.for("everyfield.web.wiki");
const slot = globalThis as { [MOUNT]?: Mount };

export function wikiMount(): Mount {
	slot[MOUNT] ??= { db: requestDatabase(), producer: createWikiProducer() };
	return slot[MOUNT];
}

export async function wikiActor(): Promise<RequestActor | null> {
	const viewer = await getViewer();
	if (viewer.status !== "active" || !viewer.authority) return null;
	return viewer.authority;
}

export function plantContext(actor: RequestActor): { plantId?: string; canOrder: boolean } {
	const context = actor.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return { canOrder: false };
	return { plantId: context.owner.id, canOrder: context.role === "owner" || context.role === "admin" };
}

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

async function editorRevision(mount: Mount, organizationId: string, articleId: string): Promise<StoredEditor | "lost"> {
	const draft = alias(article_revision, "wiki_draft_revision");
	const current = alias(article_revision, "wiki_current_revision");
	return transient(
		{ component: "wiki", outcome: "editor-revision-failed" },
		async () => {
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
		},
		"lost",
	);
}

async function readingRevision(mount: Mount, actor: RequestActor, articleId: string): Promise<string> {
	const rows = await mount.db
		.select({ revision: reading.revision })
		.from(reading)
		.where(and(eq(reading.account_id, actor.actor.accountId), eq(reading.article_id, articleId)))
		.limit(1);
	return rows[0]?.revision ?? "0";
}

async function completedIds(mount: Mount, actor: RequestActor, articleIds: string[]): Promise<Set<string>> {
	if (articleIds.length === 0) return new Set();
	const rows = await mount.db
		.select({ articleId: reading.article_id, fraction: reading.observed_fraction, completedAt: reading.completed_at })
		.from(reading)
		.where(and(eq(reading.account_id, actor.actor.accountId), inArray(reading.article_id, articleIds)));
	return new Set(
		rows.filter((row) => row.completedAt != null && Number(row.fraction) > 0.8).map((row) => row.articleId),
	);
}

export async function organizationNames(mount: Mount, ids: string[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids)].filter((id) => id !== "00000000-0000-0000-0000-000000000000");
	if (unique.length === 0) return new Map();
	const rows = await mount.db
		.select({ id: organization.id, name: organization.name })
		.from(organization)
		.where(inArray(organization.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}

export type Preview = { crawler: boolean; allowed: boolean; title: string | null; excerpt: string | null };

export const loadPreview = cache(async (path: string, userAgent: string): Promise<Preview | null> => {
	return transient(
		{ component: "wiki", outcome: "preview-failed" },
		async () => {
			const mount = wikiMount();
			const reply = await mount.producer.renderGlobalPreview(mount.db, { path, userAgent });
			if (reply.status !== "ok") return null;
			return {
				crawler: reply.value.crawler,
				allowed: reply.value.publicPreviewAllowed,
				title: reply.value.title,
				excerpt: reply.value.excerpt,
			};
		},
		null,
	).catch((error: unknown) => {
		if (error instanceof ServerConfigError) return null;
		throw error;
	});
});

type Got = { article: WikiArticle | null; errorCode: "content_access_denied" | null };

async function articleOf(
	mount: Mount,
	actor: RequestActor,
	articleId: string,
	source: SourceChoice,
): Promise<Reply<Got> | { status: "lost" }> {
	return transient(
		{ component: "wiki", outcome: "article-failed" },
		async () => {
			return await mount.producer.getArticle(mount.db, actor, { articleId, source: sourceInput(source) });
		},
		LOST,
	);
}

type ArticleBlock = "denied" | "hidden" | "order" | null;

type ArticleView = {
	article: WikiArticle;
	sources: SourceRow[];
	currentSourceId: string;
	preferredSourceId: string;
	readingRevision: string;
	plantId?: string;
	canOrder: boolean;
	order: SourceOrder | null;
	block: ArticleBlock;
	version: ArticleVersion | null;
	orderPrompt: boolean;
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
	feedback: { vote: "helpful" | "unhelpful" | null } | null;
	editorName: string | null;
	editing: boolean;
	draft: WikiDraft | null;
	draftLost: boolean;
};

type WikiDraft = {
	organizationId: string;
	revision: string;
	state: "published" | "hide" | "draft" | "inherited" | null;
	initialBody: string | null;
	initialContentType: string;
	baselineBody: string | null;
	baselineContentType: string;
};

async function feedbackVote(
	mount: NonNullable<ReturnType<typeof wikiMount>>,
	actor: Parameters<typeof plantContext>[0],
	articleId: string,
): Promise<"helpful" | "unhelpful" | null> {
	return transient(
		{ component: "wiki", outcome: "feedback-failed" },
		async () => {
			const mine = await mount.producer.getMine(mount.db, actor, { articleId });
			return mine.status === "ok" && (mine.value.currentVote === "helpful" || mine.value.currentVote === "unhelpful")
				? mine.value.currentVote
				: null;
		},
		null,
	);
}

async function sourceOrder(
	mount: NonNullable<ReturnType<typeof wikiMount>>,
	actor: Parameters<typeof plantContext>[0],
): Promise<SourceOrder | null> {
	return transient(
		{ component: "wiki", outcome: "order-read-failed" },
		async () => {
			const reply = await mount.producer.listArticles(mount.db, actor, { page: 1 });
			if (reply.status !== "ok") return null;
			return { revision: reply.value.orderRevision, churches: reply.value.churches, networks: reply.value.networks };
		},
		null,
	);
}

export async function loadWiki(
	slug: string,
	source: SourceChoice,
	editing = false,
): Promise<WikiPageData | "lost" | "signed-out"> {
	const mount = wikiMount();
	const actor = await wikiActor();
	if (!actor) return "signed-out";
	const seat = plantContext(actor);
	const editor = editorContext(actor);
	try {
		const [nav, recent, marks, recommended] = await Promise.all([
			mount.producer.navigation(mount.db, actor, { source: { kind: "current" } }),
			slug ? Promise.resolve(null) : mount.producer.readingRecent(mount.db, actor, {}),
			slug ? Promise.resolve(null) : mount.producer.bookmarksList(mount.db, actor, {}),
			slug ? Promise.resolve(null) : mount.producer.recommendForPhase(mount.db, actor, {}),
		]);
		if (nav.status !== "ok") return "lost";
		const visibleIds = nav.value.groups.flatMap((group) => group.articles.map((item) => item.articleId));
		const hit = slug
			? nav.value.groups.flatMap((group) => group.articles).find((item) => item.slug === slug)
			: undefined;
		const [read, currentRead, sourceRead] = await Promise.all([
			completedIds(mount, actor, visibleIds),
			hit ? articleOf(mount, actor, hit.articleId, { kind: "current" }) : null,
			hit && source.kind !== "current" ? articleOf(mount, actor, hit.articleId, source) : null,
		]);
		const tree = treeModel(nav.value.groups, read);
		const articleCount = visibleIds.length;
		const readCount = visibleIds.filter((id) => read.has(id)).length;
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
			const current = currentRead!;
			if (current.status !== "ok") return "lost";
			const preferred = current.value.article;
			const viewedReply = sourceRead ?? current;
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
					feedback: null,
					editorName: null,
					editing,
					draft: null,
					draftLost: false,
				};
			}
			const block = !viewed
				? "denied"
				: shown.hidden || (shown.body == null && shown.state === "hidden")
					? "hidden"
					: shown.state === "source_order_required" && shown.body == null
						? "order"
						: shown.body == null
							? "denied"
							: null;
			const [names, revision, vote, order] = await Promise.all([
				organizationNames(mount, [
					preferred.sourceId,
					shown.sourceId,
					...preferred.alternates.map((item) => item.sourceId),
					...shown.alternates.map((item) => item.sourceId),
					...(editor ? [editor.organizationId] : []),
				]),
				readingRevision(mount, actor, shown.articleId),
				block === null && seat.plantId && !editing
					? feedbackVote(mount, actor, shown.articleId).then((v) => ({ vote: v }))
					: null,
				seat.canOrder && !editing ? sourceOrder(mount, actor) : null,
			]);
			feedback = vote;
			if (editor) editorName = names.get(editor.organizationId) ?? "Your organization";
			const titles = new Map(nav.value.groups.flatMap((group) => group.articles).map((item) => [item.articleId, item]));
			const phaseItems = tree.phases.find((phase) => phase.number === shown.phase)?.items ?? [];
			if (shown.phase != null && phaseItems.length) {
				phaseRead = {
					phase: shown.phase,
					done: phaseItems.filter((item) => item.read).length,
					total: phaseItems.length,
				};
			}
			article = {
				article: shown,
				sources: sourceRows(preferred, names),
				currentSourceId: shown.sourceId,
				preferredSourceId: preferred.sourceId,
				readingRevision: revision,
				plantId: seat.plantId,
				canOrder: seat.canOrder,
				order,
				block,
				version:
					shown.sourceKind === "global"
						? null
						: {
								kind: shown.sourceKind,
								name:
									names.get(shown.sourceId) ??
									humanCredit(shown.credit) ??
									(shown.sourceKind === "church" ? "Sending church" : "Network"),
							},
				orderPrompt: seat.canOrder && source.kind === "current" && preferred.state === "source_order_required",
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
						if (!isTransient(error)) throw unexpected({ component: "wiki", outcome: "draft-failed" }, error);
						logFailure({ component: "wiki", outcome: "draft-failed" }, error);
						draftLost = true;
					}
				}
			}
		}
		if (!article) editorName = null;
		return {
			tree,
			readCount,
			articleCount,
			phaseRead,
			resume: recent?.status === "ok" && recent.value.articles[0] ? listed(recent.value.articles[0]) : null,
			recent: recent && recent.status === "ok" ? recent.value.articles.slice(0, 5).map(listed) : [],
			bookmarks: marks && marks.status === "ok" ? marks.value.articles.map(listed) : [],
			recommended: recommended && recommended.status === "ok" ? recommended.value.articles.slice(0, 4).map(listed) : [],
			article,
			missing: false,
			feedback,
			editorName,
			editing,
			draft,
			draftLost,
		};
	} catch (error) {
		if (!isTransient(error)) throw unexpected({ component: "wiki", outcome: "page-failed" }, error);
		logFailure({ component: "wiki", outcome: "page-failed" }, error);
		return "lost";
	}
}

export function logSearchLost<C extends string>(cause: LogWord<C>): void {
	logLine({ component: "wiki", outcome: "search-lost", cause });
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
	return transient(
		{ component: "wiki", outcome: "search-failed" },
		async () => {
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
				hits: reply.value.results.map((article) => ({
					...listed(article),
					excerpt: article.snippet ?? article.excerpt,
				})),
				nextPage: reply.value.nextCursor,
			};
		},
		"lost",
	);
}

export const progressRoute = mutatingRoute(async function progressRoute(request: Request): Promise<Response> {
	const text = await request.text();
	if (text.length > 1000) return new Response(null, { status: 413 });
	const body = parseJson(text) as
		{ requestKey?: unknown; articleId?: unknown; fraction?: unknown; plantId?: unknown } | undefined;
	if (body === undefined) return new Response(null, { status: 400 });
	const actor = await wikiActor();
	if (!actor) return new Response(null, { status: 401 });
	const mount = wikiMount();
	try {
		const reply = await mount.producer.updateProgress(mount.db, actor, {
			requestKey: body.requestKey,
			input: {
				articleId: body.articleId,
				fraction: body.fraction,
				...(body.plantId ? { plantId: body.plantId } : {}),
			},
		});
		return new Response(null, { status: reply.status === "ok" && !reply.value.errorCode ? 204 : 409 });
	} catch (error) {
		if (!isTransient(error)) throw unexpected({ component: "wiki", outcome: "progress-beacon-failed" }, error);
		logFailure({ component: "wiki", outcome: "progress-beacon-failed" }, error);
		return new Response(null, { status: 400 });
	}
});

export function mountFor(actor: Awaited<ReturnType<typeof wikiActor>>) {
	if (!actor) return { status: "denied" as const };
	return { status: "ready" as const, actor, mount: wikiMount() };
}
