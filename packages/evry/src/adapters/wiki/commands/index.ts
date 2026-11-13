import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { feedbackVote, setBookmarkRequest, feedbackSetMineRequest, type WikiReply } from "@everyfield/contracts/wiki";
import { createWikiProducer, wikiEffects } from "@everyfield/domain/wiki";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { articleHref, inPlant } from "../reads/index.ts";

// The Wiki reviewed writes (WP-078): a bookmark and the reader's own helpful or not helpful vote. Each review reads the
// article as the planter's Wiki page shows it now, so a draft, hidden or foreign version can never be the target. On
// approval the executor runs the same native command the Wiki page's button runs, for the approving session, with the
// effect key as its request key. Churches keep their own writing in Church Documents: no Evry tool edits the Wiki.

const wiki = createWikiProducer();
const articleId = z.uuid().describe("An articleId from an earlier Wiki result or from the user's page");

/** The article's review target, or null when the planter cannot read it now. */
async function target(db: Database, actor: EvryActor, id: string) {
	const reply = await wiki.getArticle(db, actor.authority, { articleId: id });
	const article = reply.status === "ok" ? reply.value.article : null;
	if (!article || article.hidden || article.body == null) return null;
	return {
		kind: "article",
		id: article.revisionId,
		label: article.title,
		articleId: article.articleId,
		href: articleHref(article.slug),
	};
}
/** The native reply as an effect: `revision` is the saved revision, or null when the article was not readable. */
function done<T>(reply: WikiReply<T>, revision: (v: T) => string | null): EffectResult {
	if (reply.status !== "ok") return { refused: reply.error.code };
	const saved = revision(reply.value);
	return saved === null ? { refused: "access_denied" } : { revision: saved };
}

const bookmarkInput = z.strictObject({
	articleId,
	desired: z.boolean().optional().describe("false removes the bookmark; it is added otherwise"),
});
export const setBookmark: ReviewedWrite<z.infer<typeof bookmarkInput>> = {
	operation: "wiki.bookmarks.set",
	description:
		"Propose bookmarking one Wiki article for the user, or removing the bookmark. It shows in the user's Wiki bookmarks. Nothing changes until the user approves the exact review.",
	input: bookmarkInput,
	allowed: inPlant,
	async review(actor, value, { db }) {
		const article = await target(db, actor, value.articleId);
		if (!article) return null;
		const desired = value.desired ?? true;
		// The reading revision the Wiki page's own button sends: a bookmark changed since the review refuses.
		return sql`SELECT jsonb_build_object('target',${JSON.stringify(article)}::jsonb,'changes',jsonb_build_array(
				jsonb_build_object('field','bookmarked','before',coalesce(r.bookmarked,false),'after',${desired}::boolean))) AS review,
			jsonb_build_object('expectedRevision',coalesce(r.revision::text,'0'),
				'input',jsonb_build_object('articleId',${value.articleId}::uuid,'desired',${desired}::boolean)) AS args
			FROM (SELECT 1) seed LEFT JOIN reading r ON r.account_id=${actor.accountId}::uuid AND r.article_id=${value.articleId}::uuid`;
	},
	async execute(tx, context, args, effectKey) {
		const request = setBookmarkRequest.parse({ ...z.object({}).loose().parse(args), requestKey: effectKey });
		return done(await wikiEffects.setBookmark(tx, context, request), (v) => (v.errorCode ? null : v.revision));
	},
};

const feedbackInput = z.strictObject({ articleId, vote: feedbackVote.describe("helpful or unhelpful") });
export const setFeedback: ReviewedWrite<z.infer<typeof feedbackInput>> = {
	operation: "wiki.feedback.setMine",
	description:
		"Propose the user's own feedback on one Wiki article: helpful or unhelpful, as the article's feedback buttons record it. Nothing changes until the user approves the exact review.",
	input: feedbackInput,
	allowed: inPlant,
	async review(actor, value, { db }) {
		const article = await target(db, actor, value.articleId);
		if (!article) return null;
		const mine = await wiki.getMine(db, actor.authority, { articleId: value.articleId });
		const before = mine.status === "ok" ? mine.value.currentVote : null;
		return sql`SELECT jsonb_build_object('target',${JSON.stringify(article)}::jsonb,'changes',jsonb_build_array(
				jsonb_build_object('field','feedback','before',${before}::text,'after',${value.vote}::text))) AS review,
			jsonb_build_object('expectedRevision','0',
				'input',jsonb_build_object('articleId',${value.articleId}::uuid,'vote',${value.vote}::text)) AS args`;
	},
	async execute(tx, context, args, effectKey) {
		const request = feedbackSetMineRequest.parse({ ...z.object({}).loose().parse(args), requestKey: effectKey });
		return done(await wikiEffects.setMine(tx, context, request), (v) => String(v.ownHistoryVotes.length));
	},
};

/** The installed Wiki reviewed writes, keyed by operation. */
export const WIKI_COMMANDS = {
	"wiki.bookmarks.set": setBookmark,
	"wiki.feedback.setMine": setFeedback,
} as const;
