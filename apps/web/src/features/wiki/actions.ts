"use server";

import { parseSource, sourceInput } from "./model.ts";
import { organizationNames, plantContext, runSearch, wikiActor, wikiMount } from "./server.ts";

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
	if (actor === "down") return { status: "lost" };
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
