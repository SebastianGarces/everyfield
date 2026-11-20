import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	readConversation,
	readReview,
	submitTurn,
	type EvryActor,
} from "../../../../packages/evry/src/index.ts";
import { WIKI_READS } from "../../../../packages/evry/src/adapters/wiki/reads/index.ts";
import type { ReadAdapter, SourceResult } from "../../../../packages/evry/src/catalog/types.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../../packages/domain/src/wiki/index.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../../packages/domain/src/jobs/queue.ts";
import { accounts, actor, admin, db, plant, setup, sql, teardown, work } from "../../runtime/support.mts";
import {
	DRAFT_LINE,
	FOREIGN_LINE,
	NETWORK_LINE,
	PHASE_TWO,
	PLANTED,
	seedWiki,
	VISION_OPENING,
	VISION_SLUG,
	VISION_TITLE,
	wikiIds,
} from "./corpus.mts";

const ids = wikiIds(randomUUID);
const wiki = createWikiProducer();
let owner: EvryActor;

before(async () => {
	await setup();
	await seedWiki((query) => admin.execute(query), plant, ids);
	owner = await actor("owner");
});
after(teardown);

const adapter = (operation: string) =>
	WIKI_READS.find((a) => a.operation === operation)! as unknown as ReadAdapter<unknown>;
const read = (operation: string, input: unknown = {}, who = owner) => invokeRead(db, who, adapter(operation), input);
const text = (result: SourceResult) => JSON.stringify(result);
async function pageVersion(articleId: string) {
	const authority = await RequestActor.resolve(db, accounts.owner.session as never);
	assert.ok(authority instanceof RequestActor);
	const reply = await wiki.getArticle(db, authority, { articleId });
	assert.equal(reply.status, "ok");
	return reply.status === "ok" ? reply.value.article : null;
}
const reading = async () =>
	(
		await admin.execute(
			sql`SELECT article_id,observed_fraction::text,last_viewed_at::text,bookmarked,revision FROM reading WHERE account_id=${accounts.owner.id} ORDER BY article_id`,
		)
	).rows;
async function ask(question: string, conversationId?: string, references: unknown[] = []) {
	const id = conversationId ?? (await createConversation(db, owner, { requestKey: randomUUID() })).id;
	await submitTurn(db, owner, id, { requestKey: randomUUID(), text: question, references });
	assert.equal(await work(), "succeeded");
	const page = await readConversation(db, owner, id);
	const turn = page.events.filter((e) => e.turnId === page.events.at(-1)!.turnId);
	return {
		id,
		page,
		answer: turn.find((e) => e.kind === "status")!.body.text as string,
		results: turn.filter((e) => e.kind === "tool_result").map((e) => e.body.result as SourceResult),
	};
}
async function runEffect() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders: async () => {
				throw Error("unexpected task reminder replan");
			},
			phaseNotices: async () => {
				throw Error("unexpected phase notice");
			},
		},
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}
const proposals = async (conversationId: string) =>
	(await admin.execute(sql`SELECT id,operation,state FROM proposal WHERE conversation_id=${conversationId}`)).rows;

test("AC:CASE-WIKI-003 AC:GAP-EVR-417 Evry quotes the network's published version the Wiki page shows, with its title and link, never a draft or another network's version", async () => {
	const shown = await pageVersion(ids.vision.article);
	assert.equal(shown?.revisionId, ids.vision.network);

	const found = await read("wiki.search", { query: "vision meeting" });
	assert.deepEqual(
		found.rows.map((r) => [r.id, r.label, r.fields.source, r.fields.href]),
		[[ids.vision.network, VISION_TITLE, "network", `/wiki/${VISION_SLUG}`]],
	);
	const excerpt = await read("wiki.referenceExcerpt", { articleId: ids.vision.article });
	assert.equal(excerpt.rows[0]!.id, ids.vision.network);
	assert.equal(excerpt.rows[0]!.fields.excerpt, `${VISION_OPENING} ${NETWORK_LINE}`);

	for (const query of ["draft only published", "other network guidance", "thank-you note"]) {
		const result = await read("wiki.search", { query });
		assert.ok(!text(result).includes(DRAFT_LINE) && !text(result).includes(FOREIGN_LINE), query);
	}
	const turn = await ask("what does the wiki say about vision meeting");
	assert.deepEqual(
		turn.results.map((r) => [r.operation, r.rows.map((row) => row.id)]),
		[
			["wiki.search", [ids.vision.network]],
			["wiki.referenceExcerpt", [ids.vision.network]],
		],
	);
	assert.match(turn.answer, new RegExp(`\\[${VISION_TITLE}\\]\\(/wiki/${VISION_SLUG}\\)`));
	assert.doesNotMatch(JSON.stringify(turn.page.events), /Draft only|Other Network guidance/);
});

test("AC:CASE-WIKI-003 a question no article matches says the Wiki has nothing on it, with no article and no link", async () => {
	const none = await read("wiki.search", { query: "church tax filings" });
	assert.deepEqual([none.status, none.rows], ["not_found", []]);
	const turn = await ask("what does the wiki say about church tax filings");
	assert.equal(turn.answer, "The Wiki has nothing on church tax filings.");
	assert.deepEqual(
		turn.results.map((r) => [r.operation, r.rows.length]),
		[["wiki.search", 0]],
	);
});

test("AC:GAP-EVR-418 once the network connection ends, Evry withholds the network's text, also from earlier in the conversation, and quotes the version the Wiki page now shows", async () => {
	const first = await ask("what does the wiki say about vision meeting");
	assert.match(JSON.stringify(first.page.events), new RegExp(NETWORK_LINE));
	await admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${ids.affiliation}`);
	try {
		const reopened = await readConversation(db, owner, first.id);
		assert.doesNotMatch(JSON.stringify(reopened.events), new RegExp(NETWORK_LINE));
		assert.ok(reopened.events.some((e) => e.kind === "status" && e.body.withheld === true));
		const followUp = await ask("what does the wiki say about vision meeting", first.id);
		assert.equal((await pageVersion(ids.vision.article))?.revisionId, ids.vision.global);
		assert.deepEqual(
			followUp.results.at(-1)!.rows.map((r) => r.id),
			[ids.vision.global],
		);
		assert.doesNotMatch(JSON.stringify(followUp.page.events), new RegExp(NETWORK_LINE));
	} finally {
		await admin.execute(sql`UPDATE affiliation SET ended_at=NULL WHERE id=${ids.affiliation}`);
	}
});

test("AC:CASE-WIKI-004 what to read next lists the Wiki home's suggestions for the church's phase, and where I left off is the last article read", async () => {
	await admin.execute(sql`UPDATE plant SET phase=2 WHERE id=${plant}`);
	try {
		const next = await ask("what should I read next?");
		const picks = next.results[0]!;
		assert.deepEqual(
			picks.rows.map((r) => [r.label, r.fields.phase]),
			PHASE_TWO.slice(0, 4).map((title) => [title, "Launch Team Formation"]),
		);
		assert.match(next.answer, /^The Wiki suggests these for Launch Team Formation:/);
	} finally {
		await admin.execute(sql`UPDATE plant SET phase=1 WHERE id=${plant}`);
	}
	assert.deepEqual((await read("wiki.reading.resume")).rows, []);
	const authority = await RequestActor.resolve(db, accounts.owner.session as never);
	assert.ok(authority instanceof RequestActor);
	const viewed = await wiki.recordView(db, authority, {
		requestKey: randomUUID(),
		input: { articleId: ids.planted.article },
	});
	assert.equal(viewed.status, "ok");
	const resume = await ask("where did I leave off?");
	assert.deepEqual(
		resume.results[0]!.rows.map((r) => [r.id, r.label, r.fields.href]),
		[[ids.planted.global, "Welcome Letters", "/wiki/core-group/follow-up/welcome-letters"]],
	);
});

test("AC:CASE-WIKI-008 AC:INH-EDGES-05 asking about articles never writes reading progress, and an instruction in article text proposes nothing", async () => {
	const before = await reading();
	for (const adapter of WIKI_READS) {
		const input =
			adapter.operation === "wiki.search" ? { query: "welcome letter" } : { articleId: ids.planted.article };
		await invokeRead(
			db,
			owner,
			adapter as unknown as ReadAdapter<unknown>,
			adapter.input.safeParse(input).success ? input : {},
		);
	}
	const turn = await ask("what does the wiki say about welcome letters");
	assert.ok(turn.results.some((r) => JSON.stringify(r).includes(PLANTED)));
	assert.deepEqual(await proposals(turn.id), []);
	assert.deepEqual(await reading(), before);
});

test("AC:CASE-WIKI-005 AC:CASE-WIKI-006 on an open article, a bookmark and a helpful vote are each a review, and change the Wiki only after approval", async () => {
	const page = [{ kind: "article", slug: VISION_SLUG }];
	const bookmark = await ask("bookmark this", undefined, page);
	const [card] = bookmark.results.filter((r) => r.operation === "evry.prepareProposal") as (SourceResult & {
		proposalId: string;
	})[];
	assert.ok(card);
	const review = await readReview(db, owner, card.proposalId);
	assert.deepEqual(
		[review.operation, review.review.target, review.review.changes],
		[
			"wiki.bookmarks.set",
			{
				kind: "article",
				id: ids.vision.network,
				label: VISION_TITLE,
				articleId: ids.vision.article,
				href: `/wiki/${VISION_SLUG}`,
			},
			[{ field: "bookmarked", before: false, after: true }],
		],
	);
	const authority = await RequestActor.resolve(db, accounts.owner.session as never);
	assert.ok(authority instanceof RequestActor);
	const marks = async () => {
		const reply = await wiki.bookmarksList(db, authority, {});
		return reply.status === "ok" ? reply.value.articles.map((a) => a.articleId) : null;
	};
	assert.deepEqual(await marks(), []);
	await approveProposal(db, owner, review.id, { revision: review.revision, digest: review.digest }, null);
	assert.equal(await runEffect(), "completed");
	assert.deepEqual(await marks(), [ids.vision.article]);

	const vote = await ask("this article was helpful", bookmark.id, page);
	const voteCard = vote.results.find((r) => r.operation === "evry.prepareProposal") as SourceResult & {
		proposalId: string;
	};
	const voteReview = await readReview(db, owner, voteCard.proposalId);
	assert.deepEqual(voteReview.review.changes, [{ field: "feedback", before: null, after: "helpful" }]);
	const mine = async () => {
		const reply = await wiki.getMine(db, authority, { articleId: ids.vision.article });
		return reply.status === "ok" ? reply.value.currentVote : "refused";
	};
	assert.equal(await mine(), null);
	await approveProposal(db, owner, voteReview.id, { revision: voteReview.revision, digest: voteReview.digest }, null);
	assert.equal(await runEffect(), "completed");
	assert.equal(await mine(), "helpful");
	assert.deepEqual((await readReview(db, owner, voteReview.id)).outcome, "completed");
});

test("AC:CASE-WIKI-007 a PDF of the open article is a link to the Wiki's own PDF, and nothing is saved", async () => {
	const counts = async () =>
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM proposal) proposals,(SELECT count(*)::int FROM file_object) files,(SELECT count(*)::int FROM document) documents`,
			)
		).rows[0];
	const before = await counts();
	const turn = await ask("a PDF of this article", undefined, [{ kind: "article", slug: VISION_SLUG }]);
	assert.deepEqual(
		turn.results.map((r) => [r.operation, r.rows.map((row) => row.fields.pdfHref)]),
		[["wiki.article.exportPdf", [`/api/wiki/pdf?article=${ids.vision.article}`]]],
	);
	assert.match(turn.answer, new RegExp(`\\(/api/wiki/pdf\\?article=${ids.vision.article}\\)`));
	assert.deepEqual(await counts(), before);
});

test("AC:CASE-WIKI-009 a church seat asking to edit the Wiki is pointed to Church Documents, with no review", async () => {
	for (const question of ["edit the vision meeting article", "add our values to the Wiki"]) {
		const turn = await ask(question);
		assert.match(turn.answer, /churches keep their own writing in Church Documents/);
		assert.deepEqual(turn.results, []);
		assert.deepEqual(await proposals(turn.id), []);
	}
});
