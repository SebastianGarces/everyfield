import { z } from "zod";
import { commandEnvelope } from "../common/writes.ts";
import { safeError } from "../common/values.ts";

export const wikiError = safeError;
export type WikiError = z.infer<typeof wikiError>;
export type WikiReply<T> = { status: "ok"; value: T } | { status: "refused"; error: WikiError };

export const sourceView = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("current") }),
	z.strictObject({ kind: z.literal("global") }),
	z.strictObject({ kind: z.literal("organization"), organizationId: z.uuid() }),
]);
export type SourceView = z.infer<typeof sourceView>;

const page = z.number().int().min(1).max(1000);
const phase = z.number().int().min(0).max(6);
const fraction = z.string().regex(/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/);

export const wikiArticle = z.strictObject({
	articleId: z.uuid(),
	sourceId: z.uuid(),
	sourceKind: z.enum(["church", "network", "global"]),
	hidden: z.boolean(),
	state: z.enum(["published", "hidden", "inherited", "source_order_required"]),
	body: z.string().nullable(),
	title: z.string(),
	slug: z.string(),
	excerpt: z.string().nullable(),
	phase: phase.nullable(),
	position: z.number().int(),
	revisionId: z.uuid(),
	revisionNumber: z.number().int(),
	meaningful: z.boolean(),
	meaningfulSequence: z.number().int(),
	contentType: z.enum(["safe_mdx", "safe_nodes"]),
	parentArticleId: z.uuid().nullable(),
	sectionKey: z.string(),
	publishedAt: z.string().nullable(),
	updatedLabel: z.boolean(),
	completed: z.boolean(),
	observedFraction: z.string(),
	bookmarked: z.boolean(),
	alternates: z.array(
		z.strictObject({
			sourceId: z.uuid(),
			sourceKind: z.enum(["church", "network", "global"]),
			state: z.enum(["published", "hidden", "inherited"]),
			title: z.string(),
		}),
	),
	credit: z.string(),
	relatedIds: z.array(z.uuid()),
	encodedSlug: z.string(),
	snippet: z.string().nullable(),
});
export type WikiArticle = z.infer<typeof wikiArticle>;

const listFields = {
	source: sourceView.optional(),
	page: page.optional(),
};
export const listArticlesRequest = z.strictObject(listFields);
export const getArticleRequest = z.strictObject({
	articleId: z.uuid(),
	source: sourceView.optional(),
});
export const searchRequest = z.strictObject({
	query: z.string().max(200),
	phase: phase.nullable().optional(),
	page: page.optional(),
	source: sourceView.optional(),
});
export const navigationRequest = z.strictObject({ source: sourceView.optional() });
export const neighborsRequest = getArticleRequest;
export const tocRequest = getArticleRequest;
export const contextGuideRequest = z.strictObject({
	route: z.string().min(1).max(200),
	source: sourceView.optional(),
});
export const referenceExcerptRequest = z.strictObject({
	articleId: z.uuid(),
	heading: z.string().max(200).optional(),
	source: sourceView.optional(),
});
export const recommendRequest = z.strictObject({
	phase: phase.optional(),
	source: sourceView.optional(),
});
export const publicPreviewRequest = z.strictObject({
	path: z.string().min(1).max(500),
	userAgent: z.string().max(500).optional(),
});
export const updateProgressRequest = commandEnvelope(
	z.strictObject({
		articleId: z.uuid(),
		fraction,
		plantId: z.uuid().optional(),
	}),
);
export const recordViewRequest = commandEnvelope(
	z.strictObject({
		articleId: z.uuid(),
		plantId: z.uuid().optional(),
	}),
);
export const setBookmarkRequest = commandEnvelope(
	z.strictObject({
		articleId: z.uuid(),
		desired: z.boolean(),
	}),
);
export const setSourceOrderRequest = commandEnvelope(
	z.strictObject({
		churches: z.array(z.uuid()).max(50),
		networks: z.array(z.uuid()).max(50),
	}),
);

export const listResult = z.strictObject({
	articles: z.array(wikiArticle),
	nextCursor: z.string().nullable(),
	churches: z.array(z.uuid()),
	networks: z.array(z.uuid()),
	orderRevision: z.string(),
});
export const searchResult = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("results"),
		results: z.array(wikiArticle).max(20),
		nextCursor: z.string().nullable(),
	}),
	z.strictObject({
		status: z.literal("empty"),
		results: z.array(wikiArticle).max(0),
		nextCursor: z.null(),
	}),
	z.strictObject({
		status: z.literal("unavailable"),
		results: z.null(),
	}),
]);
export const navigationResult = z.strictObject({
	groups: z.array(
		z.strictObject({
			name: z.string(),
			articles: z.array(
				z.strictObject({
					articleId: z.uuid(),
					title: z.string(),
					slug: z.string(),
					encodedSlug: z.string(),
					phase: phase.nullable(),
				}),
			),
		}),
	),
	breadcrumbs: z.array(z.strictObject({ articleId: z.uuid(), crumbs: z.array(z.string()) })),
	relatedIds: z.array(z.uuid()),
});
export const neighborsResult = z.strictObject({
	articles: z.array(
		z.strictObject({
			articleId: z.uuid(),
			title: z.string(),
			slug: z.string(),
			position: z.number().int(),
		}),
	),
	errorCode: z.literal("content_access_denied").nullable(),
});
export const tocResult = z.strictObject({
	headings: z.array(z.strictObject({ level: z.union([z.literal(2), z.literal(3)]), text: z.string() })),
	errorCode: z.literal("content_access_denied").nullable(),
});
export const guideResult = z.strictObject({
	found: z.boolean(),
	missing: z.boolean(),
	citation: z.string().nullable(),
	articleId: z.uuid().nullable(),
	body: z.string().nullable(),
});
export const excerptResult = z.strictObject({
	excerpt: z.string().nullable(),
	errorCode: z.literal("content_access_denied").nullable(),
});
export const recommendResult = z.strictObject({
	phase: phase.nullable(),
	articles: z.array(wikiArticle),
});
export const previewResult = z.strictObject({
	publicPreviewAllowed: z.boolean(),
	crawler: z.boolean(),
	title: z.string().nullable(),
	excerpt: z.string().nullable(),
});
export const readingResult = z.strictObject({
	errorCode: z.literal("content_access_denied").nullable(),
	written: z.boolean(),
	revision: z.string(),
	completed: z.boolean(),
	observedFraction: z.string(),
	bookmarked: z.boolean(),
	meaningfulUpdateLabel: z.boolean(),
	earnedCreditRetained: z.boolean(),
});
export const sourceOrderResult = z.strictObject({
	errorCode: z.enum(["access_denied", "invalid_source_order", "revision_conflict", "source_order_required"]).nullable(),
	historyAdded: z.number().int().nonnegative(),
	churches: z.array(z.uuid()),
	networks: z.array(z.uuid()),
	revision: z.string(),
	orderUnchanged: z.boolean(),
});
export const exportResult = z.strictObject({
	bytes: z.string().nullable(),
	html: z.string().nullable(),
	errorCode: z.literal("content_access_denied").nullable(),
	fontFailureOffersPrintFallback: z.boolean(),
});
export const statsResult = z.strictObject({
	discoveryComplete: z.boolean(),
	ownerRereadRequired: z.boolean(),
	qualifyingReader: z.boolean(),
	completionAtRatio: z.strictObject({ owner: z.boolean(), caller: z.boolean() }),
	phase: phase.nullable(),
	articles: z.array(
		z.strictObject({
			articleId: z.uuid(),
			slug: z.string(),
			ratio: z.string(),
			completed: z.boolean(),
		}),
	),
});
export const recentResult = z.strictObject({ articles: z.array(wikiArticle) });
export const resumeResult = z.strictObject({ article: wikiArticle.nullable() });

export const feedbackVote = z.enum(["helpful", "unhelpful"]);
export const feedbackMine = z.strictObject({
	articleId: z.uuid(),
	currentVote: feedbackVote.nullable(),
	ownHistoryVotes: z.array(feedbackVote),
	phantomPlants: z.number().int().nonnegative(),
	foreignVoteBody: z.string().nullable(),
});
export const feedbackGetMineRequest = z.strictObject({ articleId: z.uuid() });
export const feedbackSetMineRequest = commandEnvelope(
	z.strictObject({ articleId: z.uuid(), vote: feedbackVote }),
);

export const organizationArticleError = z.enum([
	"editorial_access_denied",
	"review_required",
	"revision_conflict",
]);
export const organizationArticleResult = z.strictObject({
	errorCode: organizationArticleError.nullable(),
	publishedRevision: z.number().int().nullable(),
	organizationId: z.uuid().nullable(),
	additionalHistoryEntries: z.number().int().nonnegative(),
	publicationsAdded: z.number().int().nonnegative(),
	invalidationCalls: z.number().int().nonnegative(),
	state: z.enum(["published", "hide", "draft", "inherited"]).nullable(),
});
export const organizationArticleCommand = commandEnvelope(
	z.strictObject({
		articleId: z.uuid(),
		organizationId: z.string().min(1).max(80),
		body: z.string().max(20000).optional(),
		adapter: z.enum(["Evry", "human"]).optional(),
		cachePath: z.string().max(400).optional(),
	}),
);
export const organizationDraftRequest = z.strictObject({
	articleId: z.uuid(),
	organizationId: z.string().min(1).max(80),
});
export const organizationDraft = z.strictObject({
	errorCode: z.literal("editorial_access_denied").nullable(),
	articleId: z.uuid(),
	organizationId: z.uuid().nullable(),
	body: z.string().nullable(),
	revisionNumber: z.number().int().nullable(),
	state: z.enum(["published", "hide", "draft", "inherited"]).nullable(),
});
export const upstreamReviewRequest = commandEnvelope(z.strictObject({ articleId: z.uuid() }));
export const upstreamReviewResult = z.strictObject({
	inAppCues: z.number().int().nonnegative(),
	emailIntents: z.number().int().nonnegative(),
	autoAdoptions: z.number().int().nonnegative(),
	recipientIds: z.array(z.uuid()),
});
