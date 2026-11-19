import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import type { ExportResult, GuideResult, OrderRead, OrderRow, SearchResult } from "./actions.ts";
import { articlePath, parseSource, sourceInput } from "./model.ts";
import { mountFor, organizationNames, plantContext, runSearch, wikiActor } from "./server.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

const search = z.strictObject({
	query: z.string(),
	phase: z.number().nullable(),
	page: z.number(),
	source: z.string().nullable(),
});

async function exportOf(
	actor: Awaited<ReturnType<typeof wikiActor>>,
	articleId: string,
	sourceRaw: string | null,
	kind: "pdf" | "print",
): Promise<ExportResult> {
	const ready = mountFor(actor);
	if (ready.status !== "ready") return ready;
	const source = sourceInput(parseSource(sourceRaw ?? undefined));
	return transient(
		{ component: "wiki", outcome: "export-failed" },
		async () => {
			const reply =
				kind === "pdf"
					? await ready.mount.producer.exportPdf(ready.mount.db, ready.actor, { articleId, source })
					: await ready.mount.producer.printArticle(ready.mount.db, ready.actor, { articleId, source });
			if (reply.status !== "ok")
				return reply.error.code === "access_denied" ? { status: "denied" } : { status: "lost" };
			if (
				reply.value.errorCode ||
				(kind === "pdf" && !reply.value.bytes && !reply.value.fontFailureOffersPrintFallback)
			)
				return { status: "denied" };
			if (reply.value.bytes) return { status: "pdf", bytes: reply.value.bytes };
			if (reply.value.html)
				return { status: "print", html: reply.value.html, fallback: reply.value.fontFailureOffersPrintFallback };
			return { status: "denied" };
		},
		LOST,
	);
}

const exportInput = z.strictObject({ articleId: z.string(), source: z.string().nullable() });

export const GET = defineReads(
	async () => ({ actor: await wikiActor() }),
	"denied",
	(get) => ({
		search: get(search, async ({ actor }, v): Promise<SearchResult> => {
			if (!actor) return { status: "denied" };
			const result = await runSearch(actor, v.query, v.phase, v.page, parseSource(v.source ?? undefined));
			if (result === "lost" || result === "denied") return { status: result };
			if (result.status === "empty") return { status: "empty" };
			if (result.status === "unavailable") return { status: "unavailable" };
			return { status: "results", hits: result.hits, nextPage: result.nextPage };
		}),
		guide: get(z.strictObject({ route: z.string() }), async ({ actor }, v): Promise<GuideResult> => {
			const ready = mountFor(actor);
			if (ready.status === "denied") return { status: "denied" };
			return transient(
				{ component: "wiki", outcome: "guide-failed" },
				async () => {
					const reply = await ready.mount.producer.contextGuide(ready.mount.db, ready.actor, {
						route: v.route.slice(0, 200),
					});
					if (reply.status !== "ok")
						return reply.error.code === "access_denied" ? { status: "denied" } : { status: "unavailable" };
					const guide = reply.value;
					if (!guide.found || !guide.title || !guide.slug || !guide.body) return { status: "missing" };
					return {
						status: "found",
						title: guide.title,
						section: guide.citation,
						excerpt: guide.body,
						href: articlePath(guide.slug),
					};
				},
				{ status: "unavailable" },
			);
		}),
		pdf: get(exportInput, ({ actor }, v) => exportOf(actor, v.articleId, v.source, "pdf")),
		print: get(exportInput, ({ actor }, v) => exportOf(actor, v.articleId, v.source, "print")),
		order: get(z.undefined(), async ({ actor }): Promise<OrderRead> => {
			const ready = mountFor(actor);
			if (ready.status !== "ready") return ready;
			if (!plantContext(ready.actor).canOrder) return { status: "denied" };
			return transient(
				{ component: "wiki", outcome: "order-read-failed" },
				async () => {
					const reply = await ready.mount.producer.listArticles(ready.mount.db, ready.actor, { page: 1 });
					if (reply.status !== "ok") return { status: "denied" };
					const names = await organizationNames(ready.mount, [...reply.value.churches, ...reply.value.networks]);
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
				},
				LOST,
			);
		}),
	}),
);
