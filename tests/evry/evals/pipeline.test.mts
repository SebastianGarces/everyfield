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
import {
	programWriter,
	readProgram,
	readPrograms,
	readVersionReview,
} from "../../../packages/domain/src/organizations/programs.ts";
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
import {
	dayText,
	listPeople,
	readProgram as programRead,
} from "../../../packages/evry/src/adapters/pipeline/reads/index.ts";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { modelTools } from "../../../packages/evry/src/runtime/tools.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { evalDatabase, seedHope } from "./golden-church.mts";
import { ANA_NOTE, PEOPLE, RESIDENCY_READING, seedPipeline, sessionOf, type PipelineName } from "./pipeline-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number;
	question?: number;
	actor: PipelineName;
	ask: string;
	calls: string[];
	answer?: string[];
	absent?: string[];
	proposal?: { operation: string; target: string; changes?: Change[]; notes?: string[] };
	approve?: { reason?: string };
	outcome?: "completed" | "refused";
	page?: { stale?: boolean };
	native?: "move" | "createProgram";
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
	version1 = planOf((await residency()).published!);
});
after(() => close?.());

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

const board = async (who: PipelineName, query: object = {}) =>
	ok(await readPipelineBoard(db, await authority(who), query));
const names = (b: Awaited<ReturnType<typeof board>>) => b.stages.flatMap((s) => s.people.map((p) => p.name));
const movesOf = async (personId: string) =>
	ok(await readPipelinePersonRecord(db, await authority("dana"), { personId })).history.flatMap((h) =>
		h.kind === "moved" ? [{ from: h.from, to: h.to, reason: h.reason, actor: h.actor }] : [],
	);
const caseyMoves = () => movesOf(PEOPLE.casey);
const EVERYONE = ["Jordan Reyes", "Casey Lee", "Sam Patel", "Morgan Diaz"];

async function matchesPage(c: Case, answer: string) {
	const page = await board(c.actor, c.page);
	assert.ok(answer.includes(dayText(page.asOf)), `${c.id} as of ${page.asOf}: ${answer}`);
	assert.deepEqual(
		EVERYONE.filter((n) => answer.includes(n)),
		EVERYONE.filter((n) => names(page).includes(n)),
		`${c.id} names the people ${c.actor}'s Pipeline page shows: ${answer}`,
	);
	if (page.audience === "counts")
		for (const s of page.stages) assert.ok(answer.includes(`${s.label}: ${s.count}`), `${c.id} ${s.label}: ${answer}`);
}

async function refusedNatively(c: Case) {
	if (c.native === "move") {
		const before = ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.casey }));
		const reply = await pipelineWriter.movePerson(db, await authority(c.actor), {
			personId: PEOPLE.casey,
			expectedRevision: before.revision,
			stageId: stages.grace["Not continuing"]!,
			reason: "A move this seat may not make.",
		});
		assert.equal(reply.status, "refused", `${c.id}: ${c.actor} may not move anyone on the Pipeline page`);
		assert.equal(
			ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.casey })).revision,
			before.revision,
		);
	} else if (c.native === "createProgram") {
		const before = ok(await readPrograms(db, await authority("dana"))).programs.length;
		const reply = await programWriter.createProgram(db, await authority(c.actor), {
			programId: randomUUID(),
			kind: "apprenticeship",
			name: "12-month apprenticeship",
			directorSeatId: stages.anaSeat,
			plan: { rhythm: "every_two_weeks", expectedMonths: 12, stages: [], milestones: [], readings: [] },
		});
		assert.equal(reply.status, "refused", `${c.id}: ${c.actor} may not create a program on the Programs page`);
		assert.equal(
			ok(await readPrograms(db, await authority("dana"))).programs.length,
			before,
			`${c.id} created nothing`,
		);
	}
}

async function refusesText(who: PipelineName, conversation: string, code: string) {
	const actor = await actorOf(who);
	const lease = { turnId: randomUUID(), tenantId: actor.owner.id, leaseOwner: "test", generation: "0" };
	for (const extra of [{ reason: "He led the youth retreat." }, { note: "x" }, { text: "x" }])
		await assert.rejects(
			prepareProposal(db, actor, lease, conversation, {
				operation: "pipeline.proposeStageMove",
				input: { personId: PEOPLE.jordan, stageId: stages.grace.Apprentice, ...extra },
			}),
			{ code },
			`${who} ${JSON.stringify(extra)}`,
		);
}
const residency = async (who: PipelineName = "ana") =>
	ok(await readProgram(db, await authority(who), { programId: stages.residency.programId }));
const planOf = (v: NonNullable<Awaited<ReturnType<typeof residency>>["published"]>) => ({
	number: v.number,
	rhythm: v.rhythm,
	expectedMonths: v.expectedMonths,
	stages: v.stages.map((s) => [s.label, s.minMonths, s.maxMonths]),
	milestones: v.milestones.map((m) => [m.lineage, m.title]),
	readings: v.readings.map((r) => [r.revisionId, r.title]),
});
let version1: ReturnType<typeof planOf>;
let draftBefore: ReturnType<typeof planOf>;
const unchanged = async () => {
	const p = await residency();
	assert.deepEqual([planOf(p.published!), p.draft], [version1, null]);
	assert.deepEqual(
		p.enrollments.map((e) => [e.name, e.versionNumber]),
		[["Casey Lee", 1]],
	);
};
const programNamed = async (who: PipelineName, name: string) =>
	ok(await readPrograms(db, await authority(who))).programs.find((p) => p.name === name);
const kept = async (text: string) =>
	(
		await admin.execute(sql`SELECT
			(SELECT count(*) FROM conversation_event e WHERE e.body::text LIKE ${`%${text}%`})::int AS events,
			(SELECT count(*) FROM proposal p WHERE concat(p.input::text,p.review::text,p.receipt::text) LIKE ${`%${text}%`})::int AS proposals,
			(SELECT count(*) FROM audit_event a WHERE a.metadata::text LIKE ${`%${text}%`})::int AS audit`)
	).rows[0];

type Hook = (p: Proposal | undefined, conversation: string) => Promise<void>;
const SETTLED: Record<string, { before?: Hook; after?: Hook }> = {
	"PIP-01": {
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
				["12-month apprenticeship", "Church planting residency"],
			),
	},
	"PIP-15": {
		before: async (p) => {
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
			assert.deepEqual(await kept(reason), { events: 0, proposals: 0, audit: 0 });
			assert.deepEqual(await kept("finished her apprenticeship"), { events: 2, proposals: 0, audit: 0 });
		},
	},
	"PIP-16": {
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
	"PIP-17": {
		before: async (p) => {
			await assert.rejects(
				approveProposal(db, await actorOf("dana"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "invalid_input" },
			);
			assert.equal((await readReview(db, await actorOf("dana"), p!.id)).status, "pending");
			assert.equal((await caseyMoves()).length, 1);
			assert.deepEqual(await kept("finished her apprenticeship"), { events: 1, proposals: 0, audit: 0 });
		},
	},
	"PIP-20": {
		after: async () => assert.deepEqual(names(await board("dana", { q: "youth group" })), ["Casey Lee"]),
	},
	"PIP-29": {
		before: async (_p, conversation) => {
			await refusesText("dana", conversation, "invalid_input");
			assert.deepEqual(await kept("led the youth retreat"), { events: 1, proposals: 0, audit: 0 });
		},
	},
	"PIP-30": { after: (_p, conversation) => refusesText("ana", conversation, "access_denied") },
	"PIP-31": { after: (_p, conversation) => refusesText("ben", conversation, "access_denied") },
	"PIP-32": {
		before: async () => {
			const record = ok(await readPipelinePersonRecord(db, await authority("luis"), { personId: PEOPLE.sam }));
			ok(
				await pipelineWriter.movePerson(db, await authority("luis"), {
					personId: PEOPLE.sam,
					expectedRevision: record.revision,
					stageId: stages.grace.Resident!,
					reason: "Moved on the Pipeline page.",
				}),
			);
		},
		after: async (p) => {
			const card = await readReview(db, await actorOf("dana"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current],
				["revision_conflict", [{ id: PEOPLE.sam, label: "Sam Patel", value: "Resident" }]],
			);
			const moves = await movesOf(PEOPLE.sam);
			assert.deepEqual(moves[0], {
				from: "Potential leader",
				to: "Resident",
				reason: "Moved on the Pipeline page.",
				actor: "Luis Ortega",
			});
			assert.equal(moves.length, 1);
			assert.deepEqual(await kept("Dana's reason that must never be saved."), { events: 0, proposals: 0, audit: 0 });
		},
	},
	"PIP-33": {
		after: async () =>
			assert.deepEqual(
				(await board("ana")).stages.flatMap((s) => s.people.map((p) => [p.name, s.label])),
				[["Casey Lee", "Commissioned"]],
			),
	},
	"PRG-01": { after: unchanged },
	"PRG-02": { after: unchanged },
	"PRG-03": { after: unchanged },
	"PRG-04": { after: unchanged },
	"PRG-05": { after: unchanged },
	"PRG-06": { after: unchanged },
	"PRG-07": {
		before: unchanged,
		after: async () => {
			const p = await residency();
			assert.deepEqual(planOf(p.published!), version1, "Version 1 stays as it is");
			const [group, vision, prospectus] = version1.milestones;
			const draft = planOf(p.draft!);
			assert.deepEqual(
				{ ...draft, milestones: draft.milestones.slice(0, 3) },
				{ ...version1, number: 2, rhythm: "every_two_weeks", milestones: [group, vision, prospectus] },
			);
			assert.deepEqual(
				draft.milestones.slice(3).map(([, title]) => title),
				["Lead a vision night"],
			);
			assert.ok(!version1.milestones.some(([l]) => l === draft.milestones[3]![0]), "a new milestone has a new lineage");
			assert.deepEqual(
				[p.enrollments.map((e) => e.versionNumber), (await programNamed("ana", p.name))?.publishedNumber],
				[[1], 1],
			);
			draftBefore = draft;
		},
	},
	"PRG-08": {
		after: async () => {
			const draft = planOf((await residency()).draft!);
			assert.deepEqual(draft, {
				...draftBefore,
				milestones: draftBefore.milestones.map(([l, t]) =>
					t === "Write a church planting prospectus" ? [l, "Write and present a church planting prospectus"] : [l, t],
				),
			});
			draftBefore = draft;
		},
	},
	"PRG-09": {
		before: async () => {
			const p = await residency();
			const d = p.draft!;
			ok(
				await programWriter.savePlan(db, await authority("ana"), {
					programId: p.id,
					expectedRevision: p.revision,
					plan: {
						rhythm: d.rhythm,
						expectedMonths: 20,
						stages: d.stages.map((s) => ({ label: s.label, minMonths: s.minMonths, maxMonths: s.maxMonths })),
						milestones: d.milestones.map((m) => ({
							lineage: m.lineage,
							title: m.title,
							description: m.description,
							handsOn: m.handsOn,
						})),
						readings: d.readings.map((r) => ({ revisionId: r.revisionId })),
					},
				}),
			);
		},
		after: async (p) => {
			assert.equal((await readReview(db, await actorOf("ana"), p!.id)).receipt?.code, "revision_conflict");
			assert.deepEqual(planOf((await residency()).draft!), { ...draftBefore, expectedMonths: 20 });
		},
	},
	"PRG-10": {
		after: async () => {
			const p = await residency();
			ok(
				await programWriter.publishVersion(db, await authority("ana"), {
					programId: p.id,
					expectedRevision: p.revision,
				}),
			);
			const published = await residency();
			assert.deepEqual(
				[published.published?.number, published.draft, published.enrollments[0]?.versionNumber],
				[2, null, 1],
			);
			const review = ok(
				await readVersionReview(db, await authority("ana"), { enrollmentId: stages.residency.enrollmentId }),
			);
			const titles = (ms: { title: string }[]) => ms.map((m) => m.title);
			assert.deepEqual(
				{
					carried: review.carried,
					added: titles(review.added),
					removed: titles(review.removed),
					changed: review.changed.map((c) => [c.before.title, c.after.title]),
				},
				{
					carried: ["Start a small group and raise a replacement"],
					added: ["Lead a vision night"],
					removed: [],
					changed: [["Write a church planting prospectus", "Write and present a church planting prospectus"]],
				},
			);
		},
	},
};

test("AC:ADR1-015 INV-evry-pipeline: every pipeline and program case passes on the scripted model, each asker's answers and refusals match their own Pipeline page and native writes, and each approved change reads back on the Pipeline and Programs pages", async () => {
	for (const who of ["dana", "ana", "ben"] as const)
		assert.deepEqual(
			cases.flatMap((c) => (c.actor === who && c.question ? [c.question] : [])).toSorted(),
			[1, 2, 3, 4, 5, 6, 7],
			`${who} asks all seven questions`,
		);
	for (const c of cases) {
		const actor = await actorOf(c.actor);
		const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		const turn = await ask(actor, conversation, c.ask);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		for (const text of c.absent ?? [])
			assert.ok(!turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} leaves out ${text}`);
		if (c.page) await matchesPage(c, turn.answer);
		await refusedNatively(c);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
			await SETTLED[c.id]?.after?.(undefined, conversation);
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
		await SETTLED[c.id]?.before?.(proposal, conversation);
		if (!c.approve) continue;
		const approved = await approveProposal(
			db,
			actor,
			proposal.id,
			{ revision: proposal.revision, digest: proposal.digest, ...c.approve },
			null,
		);
		assert.equal(approved.proposal.outcome, c.outcome, `${c.id} outcome ${JSON.stringify(approved.proposal.receipt)}`);
		assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], `${c.id} queues no job`);
		const again = await approveProposal(
			db,
			actor,
			proposal.id,
			{ revision: proposal.revision, digest: proposal.digest, ...c.approve },
			null,
		);
		assert.deepEqual([again.replayed, again.proposal.outcome], [true, c.outcome], `${c.id} replay`);
		await SETTLED[c.id]?.after?.(proposal, conversation);
	}
});

test("INV-evry-pipeline-read: the pipeline read takes no search text and answers as each seat's Pipeline page does", async () => {
	for (const who of ["dana", "luis", "ana", "ben"] as const) {
		const actor = await actorOf(who);
		const tool = modelTools(actor, {
			read: async () => ({}),
			select: async () => ({}),
			propose: async () => ({}),
		}).pipeline_read!;
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

test("AC:ADR1-015 INV-evry-pipeline-move: a stage move proposal takes a person and a stage only and refuses any reason or text", async () => {
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
	for (const who of ["ana", "ben"] as const)
		assert.deepEqual(
			readCatalog(await actorOf(who)).reviewedWrites.map((w) => w.operation),
			["development.draftNextVersion"],
			who,
		);
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
			"development.applyVersion",
			"development.recordMilestone",
			"development.addFeedback",
		])
			assert.ok(!tools.includes(op), `${who} has no ${op}`);
	}
});

test("INV-evry-program-read: the program read returns plans and who directs them, never who is enrolled or their progress, and the draft write takes only a program and a plan", async () => {
	for (const who of ["dana", "luis", "ana", "ben"] as const) {
		const actor = await actorOf(who);
		const list = await invokeRead(db, actor, programRead as never, {});
		const row = list.rows.find((r) => r.label === "Church planting residency")!;
		assert.equal(row.fields.directedByYou, who === "ana", who);
		const read = await invokeRead(db, actor, programRead as never, { programId: row.id });
		assert.equal(read.facts?.directedByYou, who === "ana", who);
		const page = await residency(who);
		const plans = [page.published, page.draft].flatMap((v) => (v ? [v] : []));
		assert.deepEqual(
			read.rows.filter((r) => r.fields.part === "milestone").map((r) => [r.id, r.fields.lineage, r.label]),
			plans.flatMap((v) => v.milestones.map((m) => [m.id, m.lineage, m.title])),
			who,
		);
		assert.ok(
			read.rows.some((r) => r.fields.part === "reading" && r.label === RESIDENCY_READING),
			who,
		);
		const text = JSON.stringify([list, read]);
		for (const absent of ["Casey", "Fall cohort", ANA_NOTE.slice(0, 20), stages.residency.enrollmentId, "completed"])
			assert.ok(!text.includes(absent), `${who} reads no ${absent}`);
	}
	await assert.rejects(
		invokeRead(db, await actorOf("hill"), programRead as never, { programId: stages.residency.programId }),
		{ code: "access_denied" },
	);
	const actor = await actorOf("ana");
	const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
	const lease = { turnId: randomUUID(), tenantId: actor.owner.id, leaseOwner: "test", generation: "0" };
	const plan = { rhythm: "monthly", expectedMonths: 18, stages: [], milestones: [] };
	for (const input of [
		{ programId: stages.residency.programId, plan, name: "Renamed" },
		{ programId: stages.residency.programId, plan, directorSeatId: stages.anaSeat },
		{ programId: stages.residency.programId, plan, publish: true },
		{ programId: stages.residency.programId, plan: { ...plan, readings: [] } },
		{
			programId: stages.residency.programId,
			plan: { ...plan, milestones: [{ title: "x", enrollmentId: randomUUID() }] },
		},
	])
		await assert.rejects(
			prepareProposal(db, actor, lease, conversation, { operation: "development.draftNextVersion", input }),
			{ code: "invalid_input" },
			JSON.stringify(input),
		);
});
