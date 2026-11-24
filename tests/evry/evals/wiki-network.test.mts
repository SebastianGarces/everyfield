import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import {
	approveProposal,
	cancelProposal,
	createConversation,
	evryActor,
	invokeRead,
	prepareProposal,
	readConversation,
	readReview,
	runTurn,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { scriptedQualifiedModel } from "../../../packages/evry-scripted/src/index.ts";
import { referenceExcerpt } from "../../../packages/evry/src/adapters/wiki/reads/index.ts";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { editorBlocksFromBody, editorWriteBody } from "../../../apps/web/src/features/wiki/model.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { evalDatabase, seedHope, WIKI } from "./golden-church.mts";
import { VISION_OPENING } from "../adapters/wiki/corpus.mts";
import { NETWORK, ROLES, seedWikiNetwork, sessionOf, VISION, type EditorName } from "./wiki-network-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number;
	actor: EditorName;
	ask: string;
	answer?: string[];
	proposal?: { operation: string; target: string; changes: Change[]; notes?: string[]; refusal?: string };
	approve?: true;
	decline?: true;
	outcome?: "completed" | "refused";
};
const { cases } = JSON.parse(readFileSync(new URL("./wiki-network.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

const wiki = createWikiProducer();
const RUTH = "Ruth Okafor, ruth.okafor@harvest.example.test";
const SAM = "Sam Ortiz, sam.ortiz@harvest.example.test";
const NATIVE = "Sam meets planters on Mondays.";
let close: () => Promise<void>;
let db: Database;
let admin: Database;
const model = scriptedQualifiedModel();
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: EditorName) => (await freshActor(sessionOf(who)))!;
const authority = (who: EditorName) => RequestActor.resolve(db, sessionOf(who) as never) as Promise<RequestActor>;

before(async () => {
	const database = await evalDatabase({ prefix: "evrywikiorg", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(database.admin, { seatNames: true });
	await seedWikiNetwork(database.admin);
});
after(() => close?.());

async function ask(actor: EvryActor, text: string) {
	const conversationId = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native: null },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, actor, conversationId);
	const start = read.events.findLastIndex((e) => e.kind === "user_message");
	const turn = read.events.slice(start + 1);
	const answer = turn
		.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
		.join("");
	const ids = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
			? [(e.body.result as { proposalId: string }).proposalId]
			: [],
	);
	return {
		answer,
		proposals: ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p)),
		conversationId,
	};
}

const stored = async (article = VISION) => {
	const rows = await admin.execute(sql`SELECT
		(SELECT count(*) FROM article_editor_state WHERE organization_id=${NETWORK} AND article_id=${article})::int AS editors,
		(SELECT count(*) FROM article_revision WHERE tenant_id=${NETWORK} AND article_id=${article})::int AS revisions`);
	return rows.rows[0] as { editors: number; revisions: number };
};
const editor = async (who: EditorName = "admin", article = VISION) =>
	wiki.readEditorState(db, NETWORK, article).then(async (state) => {
		const draft = await wiki.getOrganizationDraft(db, await authority(who), {
			articleId: article,
			organizationId: NETWORK,
		});
		assert.equal(draft.status, "ok");
		return { ...state, draft: draft.status === "ok" ? draft.value : null };
	});
const editorText = (body: string | null) => (body ? JSON.stringify(editorBlocksFromBody("safe_nodes", body)) : "");
async function churchSees(source?: { kind: "global" }) {
	const reply = await wiki.getArticle(db, await authority("church"), { articleId: VISION, ...(source && { source }) });
	assert.equal(reply.status, "ok");
	const article = reply.status === "ok" ? reply.value.article : null;
	const excerpt = await invokeRead(db, await actorOf("church"), referenceExcerpt as never, { articleId: VISION });
	return {
		source: article?.sourceKind,
		body: article?.body ?? "",
		excerpt: String(excerpt.rows[0]?.fields.excerpt ?? ""),
	};
}
async function churchSeesWiki() {
	const seen = await churchSees();
	assert.equal(seen.source, "global", JSON.stringify(seen));
	assert.ok(seen.body.startsWith(VISION_OPENING), seen.body);
	for (const text of [seen.body, seen.excerpt])
		for (const contact of ["Ruth Okafor", "Sam Ortiz", "Coaching contact"]) assert.ok(!text.includes(contact), text);
}

type Hook = (p: Proposal | undefined) => Promise<void>;
let afterEdit = 0;
const HOOKS: Record<string, { before?: Hook; after?: Hook }> = {
	"WNE-01": {
		before: async () =>
			assert.deepEqual(await stored(), { editors: 0, revisions: 0 }, "nothing is saved before approval"),
		after: async () => assert.deepEqual(await stored(), { editors: 0, revisions: 0 }, "declining saves nothing"),
	},
	"WNE-02": { after: async () => assert.deepEqual(await stored(), { editors: 0, revisions: 0 }) },
	"WNE-03": {
		before: async () => assert.deepEqual(await stored(), { editors: 0, revisions: 0 }),
		after: async () => {
			const state = await editor();
			assert.deepEqual(
				[state.state, state.revision, state.draft?.state, state.draftType],
				["draft", "1", "draft", "safe_nodes"],
			);
			assert.ok(state.draft?.body, "the network's Wiki editor opens the draft");
			const body = state.draft!.body!;
			assert.equal(
				editorWriteBody(body, "safe_nodes", editorBlocksFromBody("safe_nodes", body)),
				body,
				"the native editor saves it back unchanged",
			);
			const blocks = editorBlocksFromBody("safe_nodes", body);
			assert.deepEqual(blocks.at(-1), { kind: "paragraph", text: `Coaching contact: ${RUTH}` });
			assert.deepEqual(
				blocks.slice(0, 3).map((b) => b.kind),
				["paragraph", "heading", "paragraph"],
				"the Wiki's version is kept, headings included",
			);
			const [row] = (
				await admin.execute(sql`SELECT r.upstream_revision_id AS upstream, r.published_at AS published, e.based_on_upstream_id AS based
					FROM article_revision r JOIN article_editor_state e ON e.draft_revision_id=r.id
					WHERE r.tenant_id=${NETWORK} AND r.article_id=${VISION}`)
			).rows as { upstream: string; published: unknown; based: string }[];
			assert.deepEqual(row, { upstream: WIKI.vision.global, published: null, based: WIKI.vision.global });
			await churchSeesWiki();
		},
	},
	"WNE-04": {
		after: async () => {
			const state = await editor();
			assert.deepEqual([state.state, state.revision], ["draft", "2"], "the draft only");
			assert.ok(editorText(state.draft!.body).includes(`Coaching contact: ${SAM}`));
			assert.ok(!editorText(state.draft!.body).includes("Ruth Okafor"));
			await churchSeesWiki();
		},
	},
	"WNE-05": {
		before: async () => {
			const state = await editor();
			const body = state.draftBody!.replace("Coaching contact:", `${NATIVE} Coaching contact:`);
			const reply = await wiki.editOrganizationArticle(db, await authority("admin"), {
				requestKey: randomUUID(),
				expectedRevision: state.revision,
				input: { articleId: VISION, organizationId: NETWORK, body },
			});
			assert.equal(reply.status, "ok", JSON.stringify(reply));
			afterEdit = (await stored()).revisions;
		},
		after: async (p) => {
			const card = await readReview(db, await actorOf("admin"), p!.id);
			assert.equal(card.receipt?.code, "revision_conflict", "the user is told the article changed");
			assert.equal((await stored()).revisions, afterEdit, "no new revision");
			const text = editorText((await editor()).draft!.body);
			assert.ok(text.includes(NATIVE) && text.includes(SAM) && !text.includes("Lee Grant"), text);
		},
	},
	"WNE-06": {
		after: async () => {
			const state = await editor();
			assert.deepEqual([state.state, state.draft?.body], ["published", null]);
			const seen = await churchSees();
			assert.equal(seen.source, "network");
			for (const text of [seen.body, seen.excerpt]) assert.ok(text.includes(`Coaching contact: ${SAM}`), text);
		},
	},
	"WNE-07": {
		after: async () => {
			assert.equal((await editor()).state, "hide");
			const seen = await churchSees();
			assert.deepEqual(
				seen,
				{ source: "network", body: "", excerpt: "" },
				"the church's page says the network's source is hidden",
			);
			const wikiVersion = await churchSees({ kind: "global" });
			assert.ok(wikiVersion.body.startsWith(VISION_OPENING) && !wikiVersion.body.includes("Coaching contact"));
			assert.deepEqual(await stored(), { editors: 1, revisions: 4 }, "the network's version history is kept");
		},
	},
	"WNE-08": { after: async () => assert.deepEqual(await stored(), { editors: 1, revisions: 4 }) },
	"WNE-09": {
		before: async () => assert.deepEqual(await stored(ROLES), { editors: 0, revisions: 0 }),
		after: async () => {
			const state = await editor("owner", ROLES);
			assert.equal(state.state, "draft");
			assert.ok(editorText(state.draft!.body).includes(`Coaching contact: ${RUTH}`));
		},
	},
};
const untouched = async () => {
	assert.deepEqual(await stored(), { editors: 1, revisions: 4 });
	assert.deepEqual(await stored(ROLES), { editors: 1, revisions: 1 });
};
HOOKS["WNE-10"] = { after: untouched };
HOOKS["WNE-11"] = { after: untouched };

test("INV-evry-wiki-network: a network Admin or Owner drafts, changes, publishes and hides the network's own version of a Wiki article, each through its own exact review on the scripted model, with the native writer's rows; a stale review changes nothing; a Member and a church seat are refused", async () => {
	for (const c of cases) {
		const actor = await actorOf(c.actor);
		const turn = await ask(actor, c.ask);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review: ${turn.answer}`);
			await HOOKS[c.id]?.after?.(undefined);
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
		const [proposal] = turn.proposals as [Proposal];
		assert.equal(proposal.operation, c.proposal.operation, c.id);
		assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
		assert.equal(proposal.review.target?.label, c.proposal.target, `${c.id} target`);
		assert.deepEqual(proposal.review.changes, c.proposal.changes, `${c.id} changes`);
		assert.equal(proposal.review.refusal, c.proposal.refusal, `${c.id} refusal`);
		for (const line of c.proposal.notes ?? [])
			assert.ok(
				proposal.review.notes?.some((n) => n.includes(line)),
				`${c.id} notes ${JSON.stringify(proposal.review.notes)} have ${line}`,
			);
		await HOOKS[c.id]?.before?.(proposal);
		if (c.decline) assert.equal((await cancelProposal(db, actor, proposal.id)).cancelled, true, c.id);
		if (c.approve) {
			const witness = { revision: proposal.revision, digest: proposal.digest };
			const approved = await approveProposal(db, actor, proposal.id, witness, null);
			assert.equal(approved.proposal.outcome, c.outcome, `${c.id} ${JSON.stringify(approved.proposal.receipt)}`);
			assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], `${c.id} queues no job`);
			const again = await approveProposal(db, actor, proposal.id, witness, null);
			assert.deepEqual([again.replayed, again.proposal.outcome], [true, c.outcome], `${c.id} replay`);
		}
		await HOOKS[c.id]?.after?.(proposal);
	}
});

test("INV-evry-wiki-network-gate: only an organization Owner or Admin is offered or may prepare the organization Wiki writes", async () => {
	const ops = [
		"wiki.organizationArticles.add",
		"wiki.organizationArticles.edit",
		"wiki.organizationArticles.publish",
		"wiki.organizationArticles.hide",
	];
	for (const who of ["owner", "admin", "member", "church"] as const) {
		const actor = await actorOf(who);
		const offered = readCatalog(actor).reviewedWrites.map((w) => w.operation);
		assert.deepEqual(
			ops.filter((op) => offered.includes(op)),
			who === "owner" || who === "admin" ? ops : [],
			who,
		);
	}
	for (const who of ["member", "church"] as const) {
		const actor = await actorOf(who);
		const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		const lease = { turnId: randomUUID(), tenantId: actor.owner.id, leaseOwner: "test", generation: "0" };
		for (const operation of ops)
			await assert.rejects(
				prepareProposal(db, actor, lease, conversation, { operation, input: { article: "vision meeting" } }),
				{ code: "access_denied" },
				`${who} ${operation}`,
			);
	}
	const reply = await wiki.addOrganizationArticle(db, await authority("member"), {
		requestKey: randomUUID(),
		expectedRevision: "0",
		input: { articleId: VISION, organizationId: NETWORK, body: "x" },
	});
	assert.equal(
		reply.status === "ok" && reply.value.errorCode,
		"editorial_access_denied",
		"the native writer refuses a Member too",
	);
});
