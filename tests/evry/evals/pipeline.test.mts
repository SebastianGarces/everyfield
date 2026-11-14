// The pipeline and program evals (WP-101) on the scripted model. Each case in pipeline.cases.json is asked the way the
// app asks it: a real turn (runTurn) with the real catalog, reads and review cards, for the Grace Austin and Hill Country
// Network seats seeded next to Hope Fellowship (pipeline-church.mts). A case with `approve` is then approved the way the
// card approves it, which runs the native pipeline or program command in the approval request; its check reads the
// result back through the Pipeline and Programs pages' own reads. No paid model, network or recording.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelinePersonRecord,
} from "../../../packages/domain/src/organizations/pipeline.ts";
import { readProgram, readPrograms } from "../../../packages/domain/src/organizations/programs.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	invokeRead,
	prepareProposal,
	readConversation,
	readReview,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { listPeople } from "../../../packages/evry/src/adapters/pipeline/reads/index.ts";
import { modelTools } from "../../../packages/evry/src/runtime/tools.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { evalDatabase, seedHope } from "./golden-church.mts";
import { ANA_NOTE, PEOPLE, seedPipeline, sessionOf, type PipelineName } from "./pipeline-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number;
	actor: PipelineName;
	ask: string;
	calls: string[];
	answer?: string[];
	/** Text the answer never holds: another person's name, a note's words, a reason the user gave. */
	absent?: string[];
	proposal?: { operation: string; target: string; changes?: Change[]; notes?: string[] };
	/** Approved on the card, with the reason typed there when the card asks for one. */
	approve?: { reason?: string };
	outcome?: "completed" | "refused";
};
const { cases } = JSON.parse(readFileSync(new URL("./pipeline.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let stages: Awaited<ReturnType<typeof seedPipeline>>;
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: PipelineName) => (await freshActor(sessionOf(who)))!;
const authority = (who: PipelineName) => RequestActor.resolve(db, sessionOf(who) as never) as Promise<RequestActor>;
const ok = <T,>(r: { status: string; value?: T }) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};

before(async () => {
	const database = await evalDatabase({ prefix: "evrypip", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(database.admin, { seatNames: true });
	stages = await seedPipeline(database.admin, db);
});
after(() => close?.());

/** One turn as the app runs it: submitted, claimed from the queue, run on the scripted model and finished. */
async function ask(actor: EvryActor, conversationId: string, text: string) {
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
	const reads = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal"
			? [e.body.operation]
			: [],
	);
	const answer = turn
		.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
		.join("");
	const ids = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
			? [(e.body.result as { proposalId: string }).proposalId]
			: [],
	);
	const proposals = ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { reads, answer, proposals };
}

/** The Pipeline page as a seat sees it: each stage's people, or counts only. */
const board = async (who: PipelineName, query: object = {}) =>
	ok(await readPipelineBoard(db, await authority(who), query));
const names = (b: Awaited<ReturnType<typeof board>>) => b.stages.flatMap((s) => s.people.map((p) => p.name));
/** Casey's record as Dana's Pipeline page shows it: the moves, newest first. */
const caseyMoves = async () =>
	ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.casey })).history.flatMap((h) =>
		h.kind === "moved" ? [{ from: h.from, to: h.to, reason: h.reason, actor: h.actor }] : [],
	);
const programNamed = async (who: PipelineName, name: string) =>
	ok(await readPrograms(db, await authority(who))).programs.find((p) => p.name === name);
/** Every row Evry keeps for a conversation, proposal or receipt, as text, that holds `text`. */
const kept = async (text: string) =>
	(
		await admin.execute(sql`SELECT
			(SELECT count(*) FROM conversation_event e WHERE e.body::text LIKE ${`%${text}%`})::int AS events,
			(SELECT count(*) FROM proposal p WHERE concat(p.input::text,p.review::text,p.receipt::text) LIKE ${`%${text}%`})::int AS proposals,
			(SELECT count(*) FROM audit_event a WHERE a.metadata::text LIKE ${`%${text}%`})::int AS audit`)
	).rows[0];

/** What each case shows or changes, read back as the Pipeline and Programs pages show it. */
const SETTLED: Record<string, { before?: (p?: Proposal) => Promise<void>; after?: (p?: Proposal) => Promise<void> }> = {
	"PIP-01": {
		// The same people as the Pipeline page's "no move in six months" filter, and its as-of date.
		after: async () => assert.deepEqual(names(await board("dana", { stale: true })), ["Jordan Reyes"]),
	},
	"PIP-06": { after: async () => assert.deepEqual(names(await board("ben")), []) },
	"PIP-07": { after: async () => assert.deepEqual(names(await board("ana")), ["Casey Lee"]) },
	"PIP-12": {
		after: async () =>
			assert.deepEqual(
				ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.jordan })).conversations,
				[],
			),
	},
	"PIP-13": {
		before: async () => assert.equal(await programNamed("dana", "12-month apprenticeship"), undefined),
		after: async () => {
			const program = (await programNamed("dana", "12-month apprenticeship"))!;
			assert.deepEqual(
				[program.kind, program.director.name, program.publishedNumber, program.draft, program.activeEnrollments],
				["apprenticeship", "Ana Ruiz", null, true, 0],
			);
			// An unpublished draft that only Ana, its director, can publish (WP-099).
			for (const [who, director] of [
				["dana", false],
				["ana", true],
			] as const) {
				const read = ok(await readProgram(db, await authority(who), { programId: program.id }));
				assert.deepEqual(
					[read.published, read.draft?.milestones.length, read.enrollments, read.viewer.director],
					[null, 5, [], director],
					who,
				);
			}
		},
	},
	"PIP-14": {
		after: async () =>
			assert.deepEqual(
				ok(await readPrograms(db, await authority("dana"))).programs.map((p) => p.name),
				["12-month apprenticeship"],
			),
	},
	"PIP-15": {
		before: async (p) => {
			// The card can't be approved without a typed reason, and nothing moves.
			await assert.rejects(
				approveProposal(db, await actorOf("luis"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "invalid_input" },
			);
			assert.equal((await readReview(db, await actorOf("luis"), p!.id)).status, "pending");
			assert.equal((await caseyMoves()).length, 1);
		},
		after: async () => {
			const reason = cases.find((c) => c.id === "PIP-15")!.approve!.reason!;
			assert.deepEqual((await caseyMoves())[0], { from: "Apprentice", to: "Resident", reason, actor: "Luis Ortega" });
			// The typed reason reached the native move only: no conversation, proposal, receipt or audit row holds it.
			assert.deepEqual(await kept(reason), { events: 0, proposals: 0, audit: 0 });
			assert.deepEqual(await kept("finished her apprenticeship"), { events: 1, proposals: 0, audit: 0 });
		},
	},
	"PIP-16": {
		// Dana moves Casey on the Pipeline page while Luis's card waits.
		before: async () => {
			const record = ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.casey }));
			ok(
				await pipelineWriter.movePerson(db, await authority("dana"), {
					personId: PEOPLE.casey,
					expectedRevision: record.revision,
					stageId: stages.grace.Commissioned!,
					reason: "Commissioned at the fall sending service.",
				}),
			);
		},
		after: async (p) => {
			const card = await readReview(db, await actorOf("luis"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current],
				["revision_conflict", [{ id: PEOPLE.casey, label: "Casey Lee", value: "Commissioned" }]],
			);
			// Nothing moved twice: Dana's move is the newest, and Luis's reason is nowhere.
			const moves = await caseyMoves();
			assert.deepEqual(moves[0], {
				from: "Resident",
				to: "Commissioned",
				reason: "Commissioned at the fall sending service.",
				actor: "Dana Brooks",
			});
			assert.equal(moves.length, 3);
			assert.deepEqual(await kept("Luis's reason that must never be saved."), { events: 0, proposals: 0, audit: 0 });
		},
	},
};

test("INV-evry-pipeline: every pipeline and program case passes on the scripted model, and each approved change reads back on the Pipeline and Programs pages", async () => {
	for (const c of cases) {
		const actor = await actorOf(c.actor);
		const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		const turn = await ask(actor, conversation, c.ask);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		for (const text of c.absent ?? [])
			assert.ok(!turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} leaves out ${text}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
			await SETTLED[c.id]?.after?.();
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
		const [proposal] = turn.proposals as [Proposal];
		const expected = c.proposal;
		assert.equal(proposal.operation, expected.operation, c.id);
		assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
		assert.equal(proposal.review.target?.label, expected.target, `${c.id} target`);
		if (expected.changes) assert.deepEqual(proposal.review.changes, expected.changes, `${c.id} changes`);
		for (const line of expected.notes ?? [])
			assert.ok(
				proposal.review.notes?.some((n) => n.includes(line)),
				`${c.id} notes ${JSON.stringify(proposal.review.notes)} have ${line}`,
			);
		await SETTLED[c.id]?.before?.(proposal);
		if (!c.approve) continue;
		const approved = await approveProposal(
			db,
			actor,
			proposal.id,
			{ revision: proposal.revision, digest: proposal.digest, ...c.approve },
			null,
		);
		assert.equal(approved.proposal.outcome, c.outcome, `${c.id} outcome ${JSON.stringify(approved.proposal.receipt)}`);
		// These writes ran in the approval request: no effect job was queued.
		assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], `${c.id} queues no job`);
		// Approving the same card again changes nothing more.
		const again = await approveProposal(
			db,
			actor,
			proposal.id,
			{ revision: proposal.revision, digest: proposal.digest, ...c.approve },
			null,
		);
		assert.deepEqual([again.replayed, again.proposal.outcome], [true, c.outcome], `${c.id} replay`);
		await SETTLED[c.id]?.after?.(proposal);
	}
});

test("INV-evry-pipeline-read: the pipeline read takes no search text and answers as each seat's Pipeline page does", async () => {
	for (const who of ["dana", "luis", "ana", "ben"] as const) {
		const actor = await actorOf(who);
		// The model's tool schema has no search field: the Pipeline page's search also matches note text.
		const tool = modelTools(actor, { read: async () => ({}), select: async () => ({}), propose: async () => ({}) })
			.pipeline_read!;
		const schema = (tool.inputSchema as { safeParse?: (v: unknown) => { success: boolean } }).safeParse
			? (tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } })
			: null;
		assert.ok(schema, "the read tool has a zod schema");
		assert.equal(schema.safeParse({ operation: "pipeline.listPeople", input: {} }).success, true, who);
		for (const input of [{ search: "Casey" }, { q: "youth" }, { stale: true, q: "Casey" }])
			assert.equal(schema.safeParse({ operation: "pipeline.listPeople", input }).success, false, JSON.stringify(input));
		for (const stale of [false, true]) {
			const native = await board(who, { stale });
			const read = await invokeRead(db, actor, listPeople as never, { stale });
			assert.deepEqual(
				read.rows.filter((r) => r.kind === "person").map((r) => r.label),
				names(native),
				`${who} stale=${stale}`,
			);
			assert.deepEqual(
				read.rows.filter((r) => r.kind === "stage").map((r) => [r.label, r.fields.count]),
				native.stages.map((s) => [s.label, s.count]),
				`${who} counts`,
			);
			assert.equal(read.facts?.asOf, native.asOf);
			assert.ok(!JSON.stringify(read).includes(ANA_NOTE.slice(0, 20)), `${who} reads no note`);
		}
	}
});

test("INV-evry-pipeline-move: a stage move proposal takes a person and a stage only and refuses any reason or text", async () => {
	const actor = await actorOf("luis");
	const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
	const lease = { turnId: randomUUID(), tenantId: actor.owner.id, leaseOwner: "test", generation: "0" };
	for (const extra of [{ reason: "She finished." }, { note: "x" }, { text: "x" }])
		await assert.rejects(
			prepareProposal(db, actor, lease, conversation, {
				operation: "pipeline.proposeStageMove",
				input: { personId: PEOPLE.jordan, stageId: stages.grace.Apprentice, ...extra },
			}),
			{ code: "invalid_input" },
			JSON.stringify(extra),
		);
	// A Member may not move anyone natively, so Evry offers her no move.
	const ana = modelTools(await actorOf("ana"), {
		read: async () => ({}),
		select: async () => ({}),
		propose: async () => ({}),
	});
	assert.equal(ana.propose_change, undefined);
	// No tool logs a conversation, writes a note or records a milestone, for any seat.
	for (const who of ["dana", "luis", "ana", "ben", "hill"] as const) {
		const tools = JSON.stringify(
			Object.values(
				modelTools(await actorOf(who), { read: async () => ({}), select: async () => ({}), propose: async () => ({}) }),
			).map((t) => t.description),
		);
		for (const op of [
			"pipeline.logConversation",
			"pipeline.correctConversation",
			"pipeline.moveStage",
			"pipeline.recordAssessmentOccurrence",
			"development.completeMilestone",
			"development.confirmMilestone",
			"development.recordFeedback",
			"development.publishVersion",
			"development.enroll",
		])
			assert.ok(!tools.includes(op), `${who} has no ${op}`);
	}
});
