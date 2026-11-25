import type { Transaction } from "@everyfield/db/client";
import {
	APP_ROUTES,
	appPage,
	findGroup,
	phaseLabel,
	readCounts,
	treeGroups,
	treeModel,
} from "@everyfield/contracts/wiki";
import { articleHeadings } from "@everyfield/domain/wiki";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { present } from "../../../runtime/captured.ts";
import { articleRow, inPlant, read, shown, value, wiki } from "../shared.ts";

const PER_PAGE = 20;
const HEADINGS = 40;
const page = z.int().min(1).max(1000).optional().describe("The next page of an earlier result");
const pageInput = z.strictObject({ page });
const articleId = z.uuid().describe("An articleId from an earlier result or the article on the user's page");

type Bound = { total: number; page: number; next: number | null };
function bounded(operation: string, rows: SourceRow[], bound: Bound, exclusions: string[]): SourceResult {
	return {
		operation,
		status: "available",
		rows,
		...bound,
		completeness: bound.next === null ? "complete" : "partial",
		exclusions,
	};
}
function sliced<T>(items: readonly T[], at: number | undefined, size = PER_PAGE) {
	const current = at ?? 1;
	const next = current * size < items.length ? current + 1 : null;
	return {
		items: items.slice((current - 1) * size, current * size),
		bound: { total: items.length, page: current, next },
	};
}
const cursored = (listed: { total: number; nextCursor: string | null }, at: number | undefined): Bound => ({
	total: listed.total,
	page: at ?? 1,
	next: listed.nextCursor === null ? null : Number(listed.nextCursor),
});
const notFound = (operation: string): SourceResult => ({
	...bounded(operation, [], { total: 0, page: 1, next: null }, []),
	status: "not_found",
});

async function menu(tx: Transaction, actor: EvryActor) {
	const { groups } = value(await wiki.navigation(tx, actor.authority, {}));
	const articles = new Map(groups.flatMap((group) => group.articles).map((a) => [a.articleId, a]));
	const visible = treeGroups(treeModel(groups, new Set()))
		.map((group) => ({ ...group, items: group.items.filter((item) => !item.hidden) }))
		.filter((group) => group.items.length);
	return { groups: visible, articles };
}

export const navigation: ReadAdapter<Record<string, never>> = {
	operation: "wiki.navigation",
	description:
		"The Wiki's menu: its sections in the Wiki page's order, each with how many articles it holds. Use it for what is in the Wiki.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor): Promise<SourceResult> {
		const { groups } = await menu(tx, actor);
		const rows = groups.map((group, n): SourceRow => ({
			kind: "item",
			id: `section-${n + 1}`,
			label: group.label,
			fields: { articles: group.items.length },
		}));
		return {
			...bounded("wiki.navigation", rows, { total: rows.length, page: 1, next: null }, ["hidden articles"]),
			facts: { articles: groups.reduce((sum, group) => sum + group.items.length, 0), href: "/wiki" },
		};
	},
};

const listInput = z.strictObject({
	section: z.string().trim().min(1).max(120).optional().describe("A section or phase, like: Launch Team Formation"),
	page,
});
export const articlesList: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "wiki.articles.list",
	description:
		"List the Wiki's articles, all of them or one section's or phase's, with titles and links and no search words. Use it to browse; wiki.search finds a topic. When sectionFound is false the Wiki has no such section; with no rows the section is empty.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const { groups, articles } = await menu(tx, actor);
		const group = input.section === undefined ? null : findGroup(groups, input.section);
		const chosen = input.section === undefined ? groups : group ? [group] : [];
		const all = chosen.flatMap((g) => g.items.map((item) => ({ section: g.label, id: item.id })));
		const { items, bound } = sliced(all, input.page);
		const rows = items.flatMap(({ section, id }) => {
			const article = articles.get(id);
			return article ? [articleRow(article, { section })] : [];
		});
		return {
			...bounded("wiki.articles.list", rows, bound, ["article text", "drafts", "hidden articles"]),
			facts: {
				section: input.section === undefined ? null : (group?.label ?? input.section),
				sectionFound: input.section === undefined || group !== null,
				...(input.section !== undefined && !group ? { sections: groups.map((g) => g.label).join("; ") } : {}),
			},
		};
	},
};

const tocInput = z.strictObject({ articleId, page });
export const tableOfContents: ReadAdapter<z.infer<typeof tocInput>> = {
	operation: "wiki.tableOfContents",
	description:
		"One Wiki article's section headings, in order. To quote a section, pass its heading exactly to wiki.referenceExcerpt.",
	input: tocInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const article = await shown(tx, actor, input.articleId);
		if (!article) return notFound("wiki.tableOfContents");
		const { items, bound } = sliced(articleHeadings(article.contentType, present(article.body)), input.page, HEADINGS);
		const rows = items.map(({ text, level }, n) =>
			articleRow(article, { heading: text, level, position: (bound.page - 1) * HEADINGS + n + 1 }),
		);
		return bounded("wiki.tableOfContents", rows, bound, ["the sections' text"]);
	},
};

const neighborsInput = z.strictObject({ articleId, page });
export const articleNeighbors: ReadAdapter<z.infer<typeof neighborsInput>> = {
	operation: "wiki.articleNeighbors",
	description:
		"The previous and next articles of one Wiki article and its related articles, as its page shows them. wiki.recommendForPhase suggests what to read with no article in mind.",
	input: neighborsInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const around = value(await wiki.articleNeighbors(tx, actor.authority, { articleId: input.articleId }));
		if (around.errorCode) return notFound("wiki.articleNeighbors");
		const step = (relation: "previous" | "next", found: typeof around.next) =>
			found ? [articleRow(found, { relation, section: found.group || null })] : [];
		const { items, bound } = sliced(
			[
				...step("previous", around.previous),
				...step("next", around.next),
				...around.related.map((article) => articleRow(article, { relation: "related" })),
			],
			input.page,
		);
		return {
			...bounded("wiki.articleNeighbors", items, bound, ["other articles"]),
			facts: {
				firstArticle: around.previous === null,
				lastArticle: around.next === null,
				related: around.related.length,
			},
		};
	},
};

const guideInput = z.strictObject({
	route: z.enum(APP_ROUTES).describe("The page the user names, or else the page reference's id"),
});
export const contextGuide: ReadAdapter<z.infer<typeof guideInput>> = {
	operation: "wiki.contextGuide",
	description:
		"The Wiki's guide to one app page, the one the page's Guide shows: its article, section, short excerpt and link, whatever the church's phase. Messages is /communication and Plant Intelligence is /intelligence. No row means that page has no guide.",
	input: guideInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const guide = value(await wiki.contextGuide(tx, actor.authority, { route: input.route }));
		const { articleId: id, revisionId, sourceKind, title, slug, body } = guide;
		const rows =
			guide.found && id && revisionId && sourceKind && title && slug && body
				? [
						articleRow(
							{ articleId: id, revisionId, sourceKind, title, slug },
							{ section: guide.citation, excerpt: body },
						),
					]
				: [];
		return {
			...bounded("wiki.contextGuide", rows, { total: rows.length, page: 1, next: null }, ["the rest of the article"]),
			facts: { page: appPage(input.route)?.name ?? null },
		};
	},
};

export const bookmarksList: ReadAdapter<z.infer<typeof pageInput>> = {
	operation: "wiki.bookmarks.list",
	description: "The Wiki articles the user bookmarked, as their Wiki home lists them.",
	input: pageInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const listed = value(await wiki.bookmarksList(tx, actor.authority, { page: input.page ?? 1 }));
		const rows = listed.articles.map((a) => articleRow(a, { read: read(a), completed: a.completed }));
		return bounded("wiki.bookmarks.list", rows, cursored(listed, input.page), ["other readers' bookmarks"]);
	},
};

export const recent: ReadAdapter<z.infer<typeof pageInput>> = {
	operation: "wiki.reading.recent",
	description: "The Wiki articles the user read recently, latest first, with how far they read each.",
	input: pageInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const listed = value(await wiki.readingRecent(tx, actor.authority, { page: input.page ?? 1 }));
		const rows = listed.articles.map((a) => articleRow(a, { read: read(a), completed: a.completed }));
		return bounded("wiki.reading.recent", rows, cursored(listed, input.page), ["other readers' progress"]);
	},
};

export const stats: ReadAdapter<Record<string, never>> = {
	operation: "wiki.reading.stats",
	description:
		"How much of the Wiki the user has read: articles read of the total, the same for each phase, and their Discovery reading. Only their own reading counts.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor): Promise<SourceResult> {
		const { groups } = value(await wiki.navigation(tx, actor.authority, {}));
		const ids = groups.flatMap((group) => group.articles.map((article) => article.articleId));
		const counts = readCounts(treeModel(groups, await wiki.listCompletedArticles(tx, actor.authority, ids)));
		const discovery = value(await wiki.readingStats(tx, actor.authority, {}));
		const rows = counts.phases.map(({ phase, done, total }): SourceRow => ({
			kind: "item",
			id: `phase-${phase}`,
			label: phaseLabel(phase),
			fields: { read: done, total },
		}));
		return {
			...bounded("wiki.reading.stats", rows, { total: rows.length, page: 1, next: null }, ["other readers' progress"]),
			facts: {
				articlesRead: counts.done,
				articlesTotal: counts.total,
				churchPhase: discovery.phase,
				discoveryRead: discovery.articles.filter((a) => a.completed).length,
				discoveryTotal: discovery.articles.length,
				discoveryComplete: discovery.discoveryComplete,
			},
		};
	},
};

const mineInput = z.strictObject({ articleId: articleId.optional(), page });
export const myFeedback: ReadAdapter<z.infer<typeof mineInput>> = {
	operation: "wiki.feedback.getMine",
	description:
		"The user's own feedback on a Wiki article: helpful, unhelpful or none. With no articleId, the articles they left feedback on with their current vote.",
	input: mineInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const exclusions = ["other readers' feedback"];
		if (input.articleId) {
			const article = await shown(tx, actor, input.articleId);
			if (!article) return notFound("wiki.feedback.getMine");
			const mine = value(await wiki.getMine(tx, actor.authority, { articleId: input.articleId }));
			const rows = [articleRow(article, { vote: mine.currentVote ?? "none" })];
			return bounded("wiki.feedback.getMine", rows, { total: 1, page: 1, next: null }, exclusions);
		}
		const listed = value(await wiki.listMine(tx, actor.authority, { page: input.page ?? 1 }));
		const rows = listed.articles.map((a) => articleRow(a, { vote: a.vote }));
		return bounded("wiki.feedback.getMine", rows, cursored(listed, input.page), exclusions);
	},
};

export const BROWSE_READS = [
	navigation,
	articlesList,
	tableOfContents,
	articleNeighbors,
	contextGuide,
	bookmarksList,
	recent,
	stats,
	myFeedback,
] as const;
