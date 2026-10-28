"use server";

import { revalidatePath } from "next/cache";
import { parseSource, sourceInput } from "./model.ts";
import { editorContext, logSearchLost, organizationNames, plantContext, runSearch, wikiActor, wikiMount } from "./server.ts";

// Browser writes for the wiki screens. The producer checks the session again and parses every input.
// Opening the guide or searching does not record a view.

type WriteOk = {
	status: "ok";
	revision: string;
	bookmarked: boolean;
	observedFraction: string;
	completed: boolean;
	updated: boolean;
};
export type WriteResult = WriteOk | { status: "denied" } | { status: "conflict" } | { status: "lost" };

type Envelope = { requestKey: string; expectedRevision: string; articleId: string; plantId?: string };

async function actorMount() {
	const actor = await wikiActor();
	const mount = wikiMount();
	if (actor === "down" || !mount) return { status: "lost" as const };
	if (!actor) return { status: "denied" as const };
	return { status: "ready" as const, actor, mount };
}

function mapReading(value: {
	errorCode: "content_access_denied" | null;
	revision: string;
	bookmarked: boolean;
	observedFraction: string;
	completed: boolean;
	meaningfulUpdateLabel: boolean;
}): WriteResult {
	if (value.errorCode) return { status: "denied" };
	return {
		status: "ok",
		revision: value.revision,
		bookmarked: value.bookmarked,
		observedFraction: value.observedFraction,
		completed: value.completed,
		updated: value.meaningfulUpdateLabel,
	};
}

export async function recordArticleView(envelope: Envelope): Promise<WriteResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	try {
		const reply = await ready.mount.producer.recordView(ready.mount.db, ready.actor, {
			requestKey: envelope.requestKey,
			expectedRevision: envelope.expectedRevision,
			input: { articleId: envelope.articleId, ...(envelope.plantId ? { plantId: envelope.plantId } : {}) },
		});
		if (reply.status !== "ok") return reply.error.code === "conflict" ? { status: "conflict" } : { status: "denied" };
		return mapReading(reply.value);
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "view-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function saveProgress(envelope: Envelope, fraction: string): Promise<WriteResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	try {
		const reply = await ready.mount.producer.updateProgress(ready.mount.db, ready.actor, {
			requestKey: envelope.requestKey,
			expectedRevision: envelope.expectedRevision,
			input: {
				articleId: envelope.articleId,
				fraction,
				...(envelope.plantId ? { plantId: envelope.plantId } : {}),
			},
		});
		if (reply.status !== "ok") return reply.error.code === "conflict" ? { status: "conflict" } : { status: "denied" };
		return mapReading(reply.value);
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "progress-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function saveBookmark(envelope: Envelope, desired: boolean): Promise<WriteResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	try {
		const reply = await ready.mount.producer.setBookmark(ready.mount.db, ready.actor, {
			requestKey: envelope.requestKey,
			expectedRevision: envelope.expectedRevision,
			input: { articleId: envelope.articleId, desired },
		});
		if (reply.status !== "ok") return reply.error.code === "conflict" ? { status: "conflict" } : { status: "denied" };
		return mapReading(reply.value);
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "bookmark-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type SearchResult =
	| {
			status: "results";
			hits: {
				articleId: string;
				title: string;
				slug: string;
				excerpt: string | null;
				observedFraction: string;
				completed: boolean;
			}[];
			nextPage: string | null;
	  }
	| { status: "empty" }
	| { status: "unavailable" }
	| { status: "denied" }
	| { status: "lost" };

export async function searchWiki(
	query: string,
	phase: number | null,
	page: number,
	sourceRaw: string | null,
): Promise<SearchResult> {
	const actor = await wikiActor();
	if (actor === "down") {
		logSearchLost("actor-down");
		return { status: "lost" };
	}
	if (!actor) return { status: "denied" };
	const result = await runSearch(actor, query, phase, page, parseSource(sourceRaw ?? undefined));
	if (result === "lost" || result === "denied") return { status: result };
	if (result.status === "empty") return { status: "empty" };
	if (result.status === "unavailable") return { status: "unavailable" };
	return { status: "results", hits: result.hits, nextPage: result.nextPage };
}

export type GuideResult =
	| { status: "found"; body: string | null; citation: string | null; href: string | null; title: string | null }
	| { status: "missing" }
	| { status: "gone" }
	| { status: "denied" }
	| { status: "unavailable" };

export async function loadGuide(route: string): Promise<GuideResult> {
	const ready = await actorMount();
	if (ready.status === "denied") return { status: "denied" };
	if (ready.status === "lost") return { status: "unavailable" };
	try {
		const reply = await ready.mount.producer.contextGuide(ready.mount.db, ready.actor, {
			route: route.slice(0, 200),
		});
		if (reply.status !== "ok")
			return reply.error.code === "access_denied" ? { status: "denied" } : { status: "unavailable" };
		if (reply.value.found && reply.value.articleId) {
			const article = await ready.mount.producer.getArticle(ready.mount.db, ready.actor, {
				articleId: reply.value.articleId,
			});
			const slug = article.status === "ok" ? article.value.article?.slug : null;
			return {
				status: "found",
				body: reply.value.body,
				citation: reply.value.citation,
				href: slug
					? `/wiki/${slug
							.split("/")
							.map((part) => encodeURIComponent(part))
							.join("/")}`
					: null,
				title: article.status === "ok" ? (article.value.article?.title ?? null) : null,
			};
		}
		if (reply.value.missing) return { status: "missing" };
		return { status: "gone" };
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "guide-failed", error: String(error) }));
		return { status: "unavailable" };
	}
}

export type ExportResult =
	| { status: "pdf"; bytes: string }
	| { status: "print"; html: string; fallback: boolean }
	| { status: "denied" }
	| { status: "lost" };

async function exportOf(articleId: string, sourceRaw: string | null, kind: "pdf" | "print"): Promise<ExportResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	const source = sourceInput(parseSource(sourceRaw ?? undefined));
	try {
		const reply =
			kind === "pdf"
				? await ready.mount.producer.exportPdf(ready.mount.db, ready.actor, { articleId, source })
				: await ready.mount.producer.printArticle(ready.mount.db, ready.actor, { articleId, source });
		if (reply.status !== "ok") return reply.error.code === "access_denied" ? { status: "denied" } : { status: "lost" };
		if (reply.value.errorCode || (kind === "pdf" && !reply.value.bytes && !reply.value.fontFailureOffersPrintFallback))
			return { status: "denied" };
		if (reply.value.bytes) return { status: "pdf", bytes: reply.value.bytes };
		if (reply.value.html)
			return { status: "print", html: reply.value.html, fallback: reply.value.fontFailureOffersPrintFallback };
		return { status: "denied" };
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "export-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function downloadPdf(articleId: string, sourceRaw: string | null): Promise<ExportResult> {
	return exportOf(articleId, sourceRaw, "pdf");
}

export async function printCopy(articleId: string, sourceRaw: string | null): Promise<ExportResult> {
	return exportOf(articleId, sourceRaw, "print");
}

export type OrderRow = { id: string; name: string };
export type OrderRead =
	| { status: "ok"; revision: string; churches: OrderRow[]; networks: OrderRow[] }
	| { status: "denied" }
	| { status: "lost" };

export async function readSourceOrder(): Promise<OrderRead> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	if (!plantContext(ready.actor).canOrder) return { status: "denied" };
	try {
		const reply = await ready.mount.producer.listArticles(ready.mount.db, ready.actor, { page: 1 });
		if (reply.status !== "ok") return { status: "denied" };
		const names = await organizationNames([...reply.value.churches, ...reply.value.networks]);
		const row = (id: string, kind: "church" | "network"): OrderRow => ({
			id,
			name: names.get(id) ?? `${kind === "church" ? "Church" : "Network"} ${id.slice(0, 4)}`,
		});
		return {
			status: "ok",
			revision: reply.value.orderRevision,
			churches: reply.value.churches.map((id) => row(id, "church")),
			networks: reply.value.networks.map((id) => row(id, "network")),
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "order-read-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type OrderSave =
	| { status: "ok"; revision: string }
	| { status: "denied" }
	| { status: "invalid" }
	| { status: "conflict"; revision: string }
	| { status: "required" }
	| { status: "lost" };

export async function saveSourceOrder(
	requestKey: string,
	expectedRevision: string,
	churches: string[],
	networks: string[],
): Promise<OrderSave> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	if (!plantContext(ready.actor).canOrder) return { status: "denied" };
	try {
		const reply = await ready.mount.producer.setSourceOrder(ready.mount.db, ready.actor, {
			requestKey,
			expectedRevision,
			input: { churches, networks },
		});
		if (reply.status !== "ok")
			return reply.error.code === "conflict" ? { status: "conflict", revision: expectedRevision } : { status: "lost" };
		if (reply.value.errorCode === "revision_conflict") return { status: "conflict", revision: reply.value.revision };
		if (reply.value.errorCode === "source_order_required") return { status: "required" };
		if (reply.value.errorCode === "invalid_source_order") return { status: "invalid" };
		if (reply.value.errorCode) return { status: "denied" };
		return { status: "ok", revision: reply.value.revision };
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "order-save-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type FeedbackResult =
	{ status: "ok"; vote: "helpful" | "unhelpful" } | { status: "denied" } | { status: "conflict" } | { status: "lost" };

export async function setFeedback(input: {
	requestKey: string;
	articleId: string;
	vote: "helpful" | "unhelpful";
}): Promise<FeedbackResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	if (!plantContext(ready.actor).plantId) return { status: "denied" };
	try {
		const reply = await ready.mount.producer.setMine(ready.mount.db, ready.actor, {
			requestKey: input.requestKey,
			expectedRevision: "0",
			input: { articleId: input.articleId, vote: input.vote },
		});
		if (reply.status !== "ok") return reply.error.code === "conflict" ? { status: "conflict" } : { status: "denied" };
		const vote = reply.value.currentVote;
		if (vote !== "helpful" && vote !== "unhelpful") return { status: "lost" };
		return { status: "ok", vote };
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "feedback-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export type OrgResult =
	| { status: "ok"; revision: string; state: "published" | "hide" | "draft" | "inherited" | null }
	| { status: "denied" }
	| { status: "invalid" }
	| { status: "conflict" }
	| { status: "review" }
	| { status: "lost" };

type OrgCommand = {
	requestKey: string;
	expectedRevision: string;
	articleId: string;
	organizationId: string;
	body?: string;
	cachePath?: string;
};

function nextRevision(current: string): string {
	return (BigInt(current) + 1n).toString();
}

/** Refresh the article the editor just wrote. Ignore any other path. */
function refreshWiki(path: string | undefined) {
	if (!path || path.length > 400 || !path.startsWith("/wiki")) return;
	if (path.includes("..") || path.includes("//") || path.includes("\\") || path.includes("?")) return;
	revalidatePath(path);
	if (!path.endsWith("/edit")) revalidatePath(path === "/wiki" ? "/wiki/edit" : `${path}/edit`);
}

async function orgWrite(mode: "add" | "edit" | "publish" | "hide", command: OrgCommand): Promise<OrgResult> {
	const ready = await actorMount();
	if (ready.status !== "ready") return ready;
	const editor = editorContext(ready.actor);
	if (!editor || editor.organizationId !== command.organizationId) return { status: "denied" };
	if (!/^(0|[1-9]\d*)$/.test(command.expectedRevision)) return { status: "invalid" };
	if (mode !== "hide" && (!command.body || command.body.length > 20000)) return { status: "invalid" };
	const cachePath = command.cachePath?.slice(0, 400);
	const input = {
		articleId: command.articleId,
		organizationId: command.organizationId,
		...(mode === "hide" || !command.body ? {} : { body: command.body }),
		...(cachePath ? { cachePath } : {}),
	};
	try {
		const reply = await (
			mode === "add"
				? ready.mount.producer.addOrganizationArticle
				: mode === "edit"
					? ready.mount.producer.editOrganizationArticle
					: mode === "publish"
						? ready.mount.producer.publishOrganizationArticle
						: ready.mount.producer.hideOrganizationArticle
		)(ready.mount.db, ready.actor, {
			requestKey: command.requestKey,
			expectedRevision: command.expectedRevision,
			input,
		});
		if (reply.status !== "ok") {
			if (reply.error.code === "conflict") return { status: "conflict" };
			if (reply.error.code === "invalid_input" || reply.error.code === "invalid_subject") return { status: "invalid" };
			if (reply.error.code === "access_denied") return { status: "denied" };
			return { status: "lost" };
		}
		if (reply.value.errorCode === "editorial_access_denied") return { status: "denied" };
		if (reply.value.errorCode === "review_required") return { status: "review" };
		if (reply.value.errorCode === "revision_conflict") return { status: "conflict" };
		if (reply.value.errorCode) return { status: "lost" };
		try {
			refreshWiki(cachePath);
		} catch (refreshError) {
			console.error(JSON.stringify({ component: "wiki", outcome: "revalidate-failed", error: String(refreshError) }));
		}
		return { status: "ok", revision: nextRevision(command.expectedRevision), state: reply.value.state };
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "organization-write-failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function saveWikiDraft(command: OrgCommand): Promise<OrgResult> {
	return orgWrite(command.expectedRevision === "0" ? "add" : "edit", command);
}

export async function publishWikiArticle(command: OrgCommand): Promise<OrgResult> {
	return orgWrite("publish", command);
}

export async function hideWikiSource(command: OrgCommand): Promise<OrgResult> {
	if (command.expectedRevision === "0") return { status: "invalid" };
	return orgWrite("hide", command);
}
