import type { Database, Transaction } from "@everyfield/db/client";
import type { WikiArticle, WikiReply } from "@everyfield/contracts/wiki";
import { readCatalog as phaseCatalog } from "@everyfield/domain/phases";
import { createWikiProducer, sectionExcerpt } from "@everyfield/domain/wiki";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { present } from "../../../runtime/captured.ts";

const wiki = createWikiProducer();
export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const on = (tx: Transaction) => tx as unknown as Database;

export const articleHref = (slug: string) => `/wiki/${slug.split("/").map(encodeURIComponent).join("/")}`;
const pdfHref = (articleId: string) => `/api/wiki/pdf?article=${articleId}`;

function articleRow(article: WikiArticle, fields: SourceRow["fields"] = {}): SourceRow {
	return {
		kind: "article",
		id: article.revisionId,
		label: article.title,
		fields: { articleId: article.articleId, href: articleHref(article.slug), source: article.sourceKind, ...fields },
	};
}
function value<T>(reply: WikiReply<T>): T {
	if (reply.status === "ok") return reply.value;
	throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "source_unavailable");
}
const listed = (operation: string, rows: SourceRow[], exclusions: string[], more = false): SourceResult => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total: more ? null : rows.length,
	page: 1,
	next: null,
	completeness: more ? "partial" : "complete",
	exclusions,
});
async function shown(tx: Transaction, actor: EvryActor, articleId: string) {
	const { article } = value(await wiki.getArticle(on(tx), actor.authority, { articleId }));
	return article && !article.hidden && article.body != null ? article : null;
}

const SHOWN = 5;
const searchInput = z.strictObject({
	query: z.string().trim().min(1).max(200).describe("The topic's key words, like: vision meeting"),
});
export const search: ReadAdapter<z.infer<typeof searchInput>> = {
	operation: "wiki.search",
	description:
		"Search this church's Wiki by key words. Each row is an article as the church's Wiki page shows it: its title, link and a matching snippet. No row means the Wiki has nothing on it.",
	input: searchInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const found = value(await wiki.search(on(tx), actor.authority, { query: input.query }));
		if (found.status === "unavailable") throw new EvryRefusal("source_unavailable");
		const rows = found.results
			.slice(0, SHOWN)
			.map((a) => articleRow(a, { snippet: a.snippet?.replace(/<\/?b>/g, "") ?? a.excerpt }));
		const more = found.results.length > SHOWN || found.nextCursor !== null;
		return listed("wiki.search", rows, ["article text beyond the snippet", "drafts", "hidden articles"], more);
	},
};

const excerptInput = z.strictObject({
	articleId: z.uuid(),
	heading: z.string().trim().min(1).max(200).optional().describe("A section heading in the article"),
});
export const referenceExcerpt: ReadAdapter<z.infer<typeof excerptInput>> = {
	operation: "wiki.referenceExcerpt",
	description:
		"Read a short excerpt of one Wiki article, by an articleId from an earlier result: the start of the article or of one section. Quote it as the Wiki's words with the article's title and link.",
	input: excerptInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const article = await shown(tx, actor, input.articleId);
		const rows = article
			? [
					articleRow(article, {
						section: input.heading ?? null,
						excerpt: sectionExcerpt(article.contentType, present(article.body), input.heading),
					}),
				]
			: [];
		return listed("wiki.referenceExcerpt", rows, ["the rest of the article"]);
	},
};

const SUGGESTED = 4;
export const recommendForPhase: ReadAdapter<Record<string, never>> = {
	operation: "wiki.recommendForPhase",
	description:
		"The Wiki articles suggested for this church's current phase, the same ones the Wiki home suggests: what to read next.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor): Promise<SourceResult> {
		const picks = value(await wiki.recommendForPhase(on(tx), actor.authority, {}));
		const phase = picks.phase === null ? null : (await phaseCatalog()).phases[picks.phase]?.name;
		const rows = picks.articles
			.filter((a) => !a.hidden)
			.slice(0, SUGGESTED)
			.map((a) => articleRow(a, { phase: phase ?? null }));
		return listed("wiki.recommendForPhase", rows, ["articles of other phases"]);
	},
};

export const resume: ReadAdapter<Record<string, never>> = {
	operation: "wiki.reading.resume",
	description: "The Wiki article the user was last reading, with how far they read it: where they left off.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor): Promise<SourceResult> {
		const { article } = value(await wiki.readingResume(on(tx), actor.authority, {}));
		const read = (a: WikiArticle) => `${Math.round(Number(a.observedFraction) * 100)}%`;
		const rows = article ? [articleRow(article, { read: read(article), completed: article.completed })] : [];
		return listed("wiki.reading.resume", rows, ["other readers' progress"]);
	},
};

const pdfInput = z.strictObject({ articleId: z.uuid() });
export const exportPdf: ReadAdapter<z.infer<typeof pdfInput>> = {
	operation: "wiki.article.exportPdf",
	description:
		"A link to the Wiki's own PDF of one article, by an articleId from an earlier result. The PDF is made when the link is followed; nothing is saved.",
	input: pdfInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const article = await shown(tx, actor, input.articleId);
		const rows = article ? [articleRow(article, { pdfHref: pdfHref(article.articleId) })] : [];
		return listed("wiki.article.exportPdf", rows, ["the PDF itself"]);
	},
};

export const WIKI_READS = [search, referenceExcerpt, recommendForPhase, resume, exportPdf] as const;

export async function verifyArticles(db: Database, actor: EvryActor, slugs: readonly string[]) {
	if (!slugs.length || !inPlant(actor)) return [];
	const nav = await wiki.navigation(db, actor.authority, {});
	if (nav.status !== "ok") return [];
	const bySlug = new Map(nav.value.groups.flatMap((g) => g.articles).map((a) => [a.slug, a]));
	return slugs.flatMap((slug) => {
		const a = bySlug.get(slug);
		return a ? [{ kind: "article" as const, id: a.articleId, label: a.title }] : [];
	});
}
