import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { RequestActor } from "@everyfield/domain/access";
import { randomUUID } from "node:crypto";
import { feedbackVote, setBookmarkRequest, feedbackSetMineRequest, type WikiReply } from "@everyfield/contracts/wiki";
import { createWikiProducer, wikiEffects } from "@everyfield/domain/wiki";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { approvedNow } from "../../native.ts";
import { articleHref, inPlant } from "../reads/index.ts";
import {
	bodyFits,
	editorBody,
	organizationVersion,
	replaceParagraph,
	withParagraph,
	type OrganizationVersion,
} from "../version.ts";

const wiki = createWikiProducer();
const articleId = z.uuid().describe("An articleId from an earlier Wiki result or from the user's page");

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
function done<T>(reply: WikiReply<T>, readable: (v: T) => boolean): EffectResult {
	if (reply.status !== "ok") return { refused: reply.error.code };
	return readable(reply.value) ? { own: true } : { refused: "access_denied" };
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
		return sql`SELECT jsonb_build_object('target',${JSON.stringify(article)}::jsonb,'changes',jsonb_build_array(
				jsonb_build_object('field','bookmarked','before',coalesce(r.bookmarked,false),'after',${desired}::boolean))) AS review,
			jsonb_build_object('expectedRevision',coalesce(r.revision::text,'0'),
				'input',jsonb_build_object('articleId',${value.articleId}::uuid,'desired',${desired}::boolean)) AS args
			FROM (SELECT 1) seed LEFT JOIN reading r ON r.account_id=${actor.accountId}::uuid AND r.article_id=${value.articleId}::uuid`;
	},
	async execute(tx, context, args, effectKey) {
		const request = setBookmarkRequest.parse({ ...z.object({}).loose().parse(args), requestKey: effectKey });
		return done(await wikiEffects.setBookmark(tx, context, request), (v) => !v.errorCode);
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
		return done(await wikiEffects.setMine(tx, context, request), () => true);
	},
};

type Mode = "add" | "edit" | "publish" | "hide";
type Change = { field: string; before: string | null; after: string };
const WRITERS = {
	add: wiki.addOrganizationArticle,
	edit: wiki.editOrganizationArticle,
	publish: wiki.publishOrganizationArticle,
	hide: wiki.hideOrganizationArticle,
} as const;
const saved = z.object({
	requestKey: z.uuid(),
	expectedRevision: z.string().regex(/^(0|[1-9]\d*)$/),
	articleId: z.uuid(),
	organizationId: z.uuid(),
	body: z.string().optional(),
});
async function save(mode: Mode, db: Database, authority: RequestActor, raw: unknown): Promise<EffectResult> {
	const a = saved.parse(raw);
	const reply = await WRITERS[mode](db, authority, {
		requestKey: a.requestKey,
		expectedRevision: a.expectedRevision,
		input: {
			articleId: a.articleId,
			organizationId: a.organizationId,
			...(a.body === undefined ? {} : { body: a.body }),
		},
	});
	if (reply.status !== "ok") return { refused: reply.error.code };
	const code = reply.value.errorCode;
	if (code) return { refused: code === "editorial_access_denied" ? "access_denied" : code };
	return { revision: (BigInt(a.expectedRevision) + 1n).toString() };
}

function card(v: OrganizationVersion, review: { changes: Change[]; notes: string[]; refusal?: string }, body?: string) {
	const target = { kind: "article", id: v.revisionId, label: v.title, articleId: v.articleId, href: v.href };
	const args = {
		requestKey: randomUUID(),
		expectedRevision: v.revision,
		articleId: v.articleId,
		organizationId: v.organizationId,
		...(body === undefined ? {} : { body }),
	};
	return sql`SELECT ${JSON.stringify({ target, ...review })}::jsonb AS review, ${JSON.stringify(args)}::jsonb AS args`;
}
const refused = (v: OrganizationVersion, refusal: string) => card(v, { changes: [], notes: [], refusal });
const seen = (v: OrganizationVersion) =>
	v.state === "published" ? `${v.organization}'s published version` : "the Wiki's version";
const TOO_LONG = "The article would be too long to save, so nothing would change.";

function versionText(v: OrganizationVersion, publishing: boolean) {
	if (v.state === "hidden") return "Hidden";
	if (v.state === "draft") return "Draft, not published";
	if (v.hasDraft && publishing) return "Draft, with an earlier version published";
	return "Published";
}

const article = z.string().trim().min(1).max(200).describe("The article's title or key words, like: vision meeting");
const userText = (what: string) =>
	z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.describe(`${what}, in the user's own words. Never write Wiki content of your own.`);
const addInput = z.strictObject({ article, text: userText("The text to add at the end of the article") });
const editInput = z.strictObject({
	article,
	about: z.string().trim().min(2).max(200).describe("Words in the one paragraph to change, like: coaching contact"),
	text: userText("That paragraph's new text"),
});
const articleInput = z.strictObject({ article });

export const addOrganizationArticle = approvedNow({
	operation: "wiki.organizationArticles.add",
	description:
		"Propose your organization's own draft of one Wiki article it has no version of yet: the Wiki's version with the user's text added at the end. It saves a draft only: churches keep seeing the Wiki's version until it is published. Nothing changes until the user approves",
	input: addInput,
	async review(actor, value, { db }) {
		const v = await organizationVersion(db, actor, value.article);
		if (v.state !== "none")
			return refused(
				v,
				`${v.organization} already has its own version of ${v.title}. Ask me to change its text instead.`,
			);
		const nodes = withParagraph(v.nodes, value.text);
		if (!bodyFits(nodes)) return refused(v, TOO_LONG);
		return card(
			v,
			{
				changes: [{ field: "addedText", before: null, after: value.text }],
				notes: [
					`This saves a draft of ${v.organization}'s own version of ${v.title}: the Wiki's version with this text added at the end.`,
					`Churches connected to ${v.organization} keep seeing the Wiki's version until you publish it.`,
				],
			},
			editorBody(nodes),
		);
	},
	reason: false,
	run: (db, authority, args) => save("add", db, authority, args),
});

export const editOrganizationArticle = approvedNow({
	operation: "wiki.organizationArticles.edit",
	description:
		"Propose a change to your organization's own version of one Wiki article: the one paragraph that mentions the given words gets the user's new text. It updates the draft only: churches keep seeing what they see now until it is published. Nothing changes until the user approves",
	input: editInput,
	async review(actor, value, { db }) {
		const v = await organizationVersion(db, actor, value.article);
		if (v.state === "none")
			return refused(v, `${v.organization} has no version of ${v.title} yet. Ask me to draft one first.`);
		const where = `${v.organization}'s ${v.hasDraft ? "draft" : "version"} of ${v.title}`;
		const replaced = replaceParagraph(v.nodes, value.about, value.text);
		if ("found" in replaced)
			return refused(
				v,
				replaced.found
					? `More than one paragraph in ${where} mentions ${value.about}. Say which one to change.`
					: `No paragraph in ${where} mentions ${value.about}, so nothing would change.`,
			);
		if (replaced.before === replaced.after) return refused(v, `${where} already says that, so nothing would change.`);
		if (!bodyFits(replaced.nodes)) return refused(v, TOO_LONG);
		return card(
			v,
			{
				changes: [{ field: "articleText", before: replaced.before, after: replaced.after }],
				notes: [
					`This updates the draft of ${v.organization}'s version of ${v.title}.`,
					`Churches connected to ${v.organization} keep seeing ${seen(v)} until you publish it.`,
				],
			},
			editorBody(replaced.nodes),
		);
	},
	reason: false,
	run: (db, authority, args) => save("edit", db, authority, args),
});

export const publishOrganizationArticle = approvedNow({
	operation: "wiki.organizationArticles.publish",
	description:
		"Propose publishing your organization's draft of one Wiki article, so churches that share your organization's Wiki see it in place of the Wiki's version. Nothing changes until the user approves",
	input: articleInput,
	async review(actor, value, { db }) {
		const v = await organizationVersion(db, actor, value.article);
		if (v.state === "none")
			return refused(v, `${v.organization} has no version of ${v.title} yet. Ask me to draft one first.`);
		if (v.state === "published" && !v.hasDraft)
			return refused(v, `${v.organization}'s version of ${v.title} is already published, and it has no newer draft.`);
		return card(
			v,
			{
				changes: [{ field: "organizationVersion", before: versionText(v, true), after: "Published" }],
				notes: [
					`Churches connected to ${v.organization} that share its Wiki will see this version of ${v.title} in place of the Wiki's.`,
				],
			},
			v.body,
		);
	},
	reason: false,
	run: (db, authority, args) => save("publish", db, authority, args),
});

export const hideOrganizationArticle = approvedNow({
	operation: "wiki.organizationArticles.hide",
	description:
		"Propose hiding your organization's own version of one Wiki article from the churches that share your Wiki: their Wiki page says your source is hidden, and they can still open another source, such as the Wiki's standard version. Its version history is kept. Nothing changes until the user approves",
	input: articleInput,
	async review(actor, value, { db }) {
		const v = await organizationVersion(db, actor, value.article);
		if (v.state === "none") return refused(v, `${v.organization} has no version of ${v.title} to hide.`);
		if (v.state === "hidden") return refused(v, `${v.organization}'s version of ${v.title} is already hidden.`);
		return card(v, {
			changes: [{ field: "organizationVersion", before: versionText(v, false), after: "Hidden" }],
			notes: [
				`Churches connected to ${v.organization} no longer see its version of ${v.title}. Their Wiki page says this source is hidden, and they can open another source, such as the Wiki's standard version.`,
				`${v.organization}'s version history is kept.`,
			],
		});
	},
	reason: false,
	run: (db, authority, args) => save("hide", db, authority, args),
});

export const WIKI_COMMANDS = {
	"wiki.bookmarks.set": setBookmark,
	"wiki.feedback.setMine": setFeedback,
	"wiki.organizationArticles.add": addOrganizationArticle,
	"wiki.organizationArticles.edit": editOrganizationArticle,
	"wiki.organizationArticles.publish": publishOrganizationArticle,
	"wiki.organizationArticles.hide": hideOrganizationArticle,
} as const;
