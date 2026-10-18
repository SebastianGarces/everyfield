import { z } from "zod";
import foundations from "../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { accountId, owner, personId, recordId, revision } from "../common/values.ts";
import { plantOwner } from "../organizations/subjects.ts";
import { instant } from "../common/time.ts";

const canonicalIds = new Set(foundations.articles.map((article) => article.id));
const sourceOwner = owner.transform((value, ctx) => {
	if (value.kind === "global" || value.kind === "organization") return value;
	ctx.addIssue({ code: "custom", message: "Expected a published Wiki source" });
	return z.NEVER;
});
// Provenance is retained reading credit, never a present source-body grant.
export const articleReading = z.strictObject({
	readerAccountId: accountId,
	articleId: recordId.refine((id) => canonicalIds.has(id)),
	source: z.strictObject({ owner: sourceOwner, publishedRevisionId: recordId, revision }),
	scrollRatio: z.number().min(0).max(1),
	readAt: instant,
});
const individualReadings = z
	.array(articleReading)
	.max(foundations.article_count)
	.refine((rows) => new Set(rows.map((r) => r.articleId)).size === rows.length);
const completeReadings = individualReadings.refine(
	(rows) => rows.length === foundations.article_count && rows.every((row) => row.scrollRatio > 0.8),
);
export const foundationReading = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("incomplete") }),
	// Eligibility is loaded now by the producer, never accepted in a command.
	// One outer reader owns the entire six-item set; partial sets cannot be pooled.
	z
		.strictObject({
			status: z.literal("complete"),
			plant: plantOwner,
			readerAccountId: accountId,
			eligibility: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("current_owner") }),
				z.strictObject({ kind: z.literal("current_admin_lead"), personId }),
			]),
			articles: completeReadings,
		})
		.refine((value) => value.articles.every((article) => article.readerAccountId === value.readerAccountId)),
]);
export const ownDiscoveryReading = z
	.strictObject({ readerAccountId: accountId, articles: individualReadings })
	.refine((value) => value.articles.every((article) => article.readerAccountId === value.readerAccountId));
