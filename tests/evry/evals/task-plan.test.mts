import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/index.ts";
import {
	createTaskWriter,
	createTemplateReader,
	taskReader,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { followUpReader } from "../../../packages/domain/src/followups/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readCatalog,
	readConversation,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { PLAN_WRITES } from "../../../packages/evry/src/context/compile.ts";
import { REVIEWED_WRITES } from "../../../packages/evry/src/proposals/store.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { ACTOR_SPECS, byName, goldenChurch, PLANT, SEATS, taskId, type GoldenChurch } from "./golden-church.mts";
import { RECORDED } from "./golden-harness.mts";

type Who = "owner" | "admin" | "member" | "org";
type Expected = {
	operation: string;
	target: string;
	fields?: string[];
	changes?: [string, unknown, unknown?][];
	notes?: string[];
};
type Case = {
	id: string;
	operation: string;
	criterion: number;
	setup?: "openOffer";
	actor: Who;
	ask: string;
	calls: string[];
	answer?: string[];
	absent?: string[];
	proposal?: Expected;
	between?: "declineOffer" | "editTask";
	approve?: true;
	outcome?: "completed" | "refused";
	refusal?: string;
	check?: keyof typeof CHECKS;
};
const { cases } = JSON.parse(readFileSync(new URL("./task-plan.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let church: GoldenChurch;
let db: Database;
let admin: Database;
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const reminders = async () => undefined;
const templates = createTemplateReader();
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: Who) => (await freshActor(ACTOR_SPECS[who].session))!;
const authority = (who: Who) => RequestActor.resolve(db, ACTOR_SPECS[who].session as never) as Promise<RequestActor>;
const ok = <T,>(reply: { status: string; value?: T }) => {
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return reply.value as T;
};
const native = async <T,>(read: (tx: never, a: RequestActor) => Promise<{ status: string; value?: T }>) => {
	const a = await authority("owner");
	return ok<T>(await gatedTransaction(db, (tx) => read(tx as never, a)));
};

const DANIEL_CALL = "Left a voicemail about the Tuesday group.";
const PHASE_ONE = ["vision-meeting-preparation", "post-meeting-follow-up", "core-group-onboarding"];
const ANA_PEOPLE = ["Daniel Cruz", "Hannah Barnes"];

before(async () => {
	church = await goldenChurch();
	db = church.db;
	admin = church.admin;
	const call = randomUUID();
	await admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,task_id,outcome,occurred_at,recorded_at,contact_channel,notes)
		VALUES(${call},${PLANT},${byName("Daniel Cruz").id},${taskId("daniel")},'attempted_no_contact','2026-11-07T17:00:00.000Z',
			'2026-11-07T17:00:00.000Z','phone',${DANIEL_CALL})`);
	await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,after_revision)
		VALUES(${PLANT},${SEATS.ana.account},'followup.recorded','outcome','contact_outcome',${call},'2026-11-07T17:00:00.000Z','2026-11-07T17:00:00.000Z',1)`);
});
after(() => church?.close());

async function ask(actor: EvryActor, text: string) {
	const conversation = await createConversation(db, actor, { requestKey: randomUUID() });
	await submitTurn(db, actor, conversation.id, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native: null },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, actor, conversation.id);
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
	return { reads, answer, proposals: ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p)) };
}

async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders,
			phaseNotices: async () => {
				throw Error("unexpected phase notice");
			},
		},
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

const transitionId = async () =>
	String(
		(
			await admin.execute(
				sql`SELECT id FROM phase_transition WHERE plant_id=${PLANT} AND kind='movement' ORDER BY occurred_at DESC LIMIT 1`,
			)
		).rows[0]!.id,
	);
async function openOffer() {
	await admin.execute(sql`UPDATE task SET deleted_at=clock_timestamp() WHERE plant_id=${PLANT} AND id IN (
		SELECT jsonb_array_elements_text(after_value->'taskIds')::uuid FROM audit_event
		WHERE tenant_id=${PLANT} AND subject_type='phase_transition' AND kind='offer_answer')`);
	await admin.execute(
		sql`DELETE FROM audit_event WHERE tenant_id=${PLANT} AND subject_type='phase_transition' AND kind='offer_answer'`,
	);
	await admin.execute(
		sql`UPDATE phase_transition SET offer_answer=NULL,answered_at=NULL WHERE plant_id=${PLANT} AND kind='movement'`,
	);
}

type Listed = { items: { id: string; title: string; status: string; assignees: { displayName: string }[] }[] };
const tasksPage = async () => {
	const all: Listed["items"] = [];
	for (let page = 1; ; page++) {
		const found = await native<Listed & { next: number | null }>((tx, a) =>
			taskReader.list(tx, a, { limit: 100, page, statuses: ["not_started", "in_progress", "blocked"] }),
		);
		all.push(...found.items);
		if (!found.next) return all;
	}
};
const titlesOf = async (keys: string[]) => {
	const titles: string[] = [];
	for (const key of keys) {
		const p = await native<{ checklist: { tasks: { title: string }[] } }>((tx, a) =>
			templates.previewTemplate(tx, a, { checklistKey: key }),
		);
		titles.push(...p.checklist.tasks.map((t) => t.title));
	}
	return titles;
};
type Offer = { status: string; answer?: { answer: string; accepted: string[]; declined: string[]; tasks: unknown[] } };
const offerOf = async () =>
	native<Offer>(async (tx, a) => templates.readPhaseOffer(tx, a, { transitionId: await transitionId() }));
const prerequisitesOf = async (key: Parameters<typeof taskId>[0]) =>
	(
		await native<{ items: { title: string }[] }>((tx, a) =>
			taskReader.listPrerequisites(tx, a, { taskId: taskId(key) }),
		)
	).items.map((p) => p.title);
const followUpsOf = async () =>
	(
		await native<{ items: { person: { label: string }; owners: { displayName: string }[] }[] }>((tx, a) =>
			followUpReader.listFollowUpOwners(tx, a, { limit: 100 }),
		)
	).items.map((d) => [d.person.label, d.owners.map((o) => o.displayName).join(", ")] as const);
const historyOf = async (name: string) =>
	native<unknown>((tx, a) =>
		followUpReader.listContactHistory(tx, a, { personId: byName(name).id, limit: 50, page: 1 }),
	);
const notesOf = async () =>
	(await admin.execute(sql`SELECT jsonb_agg(n ORDER BY n.id) AS notes FROM person_note n WHERE n.plant_id=${PLANT}`))
		.rows[0]!.notes;

type Snapshot = {
	tasks: Listed["items"];
	follow: readonly (readonly [string, string])[];
	history: unknown;
	notes: unknown;
};
const snapshot = async (): Promise<Snapshot> => ({
	tasks: await tasksPage(),
	follow: await followUpsOf(),
	history: await historyOf("Daniel Cruz"),
	notes: await notesOf(),
});
const added = (before: Snapshot, after: Snapshot) =>
	after.tasks.filter((t) => !before.tasks.some((b) => b.id === t.id)).map((t) => t.title);

const CHECKS = {
	async offerAccepted(before: Snapshot, after: Snapshot) {
		const offer = await offerOf();
		assert.equal(offer.answer?.answer, "accepted");
		assert.deepEqual(offer.answer?.accepted, PHASE_ONE);
		assert.deepEqual(offer.answer?.declined, []);
		assert.deepEqual(added(before, after).sort(), (await titlesOf(PHASE_ONE)).sort());
		const nate = after.tasks.filter((t) => added(before, after).includes(t.title));
		assert.ok(nate.every((t) => t.assignees.map((a) => a.displayName).join() === "Nate Ellis"));
	},
	async offerPartial(before: Snapshot, after: Snapshot) {
		const offer = await offerOf();
		assert.equal(offer.answer?.answer, "accepted");
		assert.deepEqual(offer.answer?.accepted, ["core-group-onboarding"]);
		assert.deepEqual(offer.answer?.declined, ["vision-meeting-preparation", "post-meeting-follow-up"]);
		assert.deepEqual(added(before, after).sort(), (await titlesOf(["core-group-onboarding"])).sort());
		const declined = await titlesOf(["vision-meeting-preparation", "post-meeting-follow-up"]);
		assert.ok(!after.tasks.some((t) => declined.includes(t.title)), "no declined checklist's task exists");
	},
	async offerDeclined(before: Snapshot, after: Snapshot) {
		const offer = await offerOf();
		assert.equal(offer.answer?.answer, "declined");
		assert.deepEqual(offer.answer?.declined, PHASE_ONE);
		assert.equal(after.tasks.length, before.tasks.length);
	},
	async offerStale(before: Snapshot, after: Snapshot) {
		assert.equal((await offerOf()).answer?.answer, "declined", "the Tasks page's own answer stands");
		assert.equal(after.tasks.length, before.tasks.length, "nothing was created");
	},
	async imported(before: Snapshot, after: Snapshot) {
		assert.deepEqual(added(before, after).sort(), [
			"Pick a target launch Sunday",
			"Tell the core group the launch date",
		]);
	},
	async handedOff(before: Snapshot, after: Snapshot) {
		const of = (s: Snapshot, name: string) => s.follow.find(([p]) => p === name)?.[1];
		for (const name of ANA_PEOPLE) {
			assert.equal(of(before, name), "Ana Rivera", name);
			assert.equal(of(after, name), "Lena Park", name);
		}
		assert.deepEqual(after.history, before.history, "contact history is unchanged");
		assert.deepEqual(after.notes, before.notes, "people's notes are unchanged");
	},
	async prerequisitesSet() {
		assert.deepEqual(await prerequisitesOf("insurance"), ["Order launch banners", "Confirm the school rental"]);
	},
	async prerequisitesCleared() {
		assert.deepEqual(await prerequisitesOf("insurance"), []);
	},
	async prerequisitesStale() {
		assert.deepEqual(await prerequisitesOf("insurance"), [], "the stale card changed nothing");
	},
	async nothing(before: Snapshot, after: Snapshot) {
		assert.deepEqual(after, before);
	},
};

async function between(kind: NonNullable<Case["between"]>) {
	const a = await authority("owner");
	const tasks = createTaskWriter({ reminders });
	if (kind === "declineOffer")
		ok(
			await withTaskWrite(db, a, async (tx, ctx) =>
				tasks.declinePhaseOffer(tx, ctx, {
					requestKey: randomUUID(),
					input: { transitionId: await transitionId() },
				}),
			),
		);
	else {
		const t = await native<{ task: { revision: string } }>((tx, x) =>
			taskReader.get(tx, x, { taskId: taskId("insurance") }),
		);
		ok(
			await withTaskWrite(db, a, (tx, ctx) =>
				tasks.edit(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: t.task.revision,
					input: { taskId: taskId("insurance"), patch: { priority: "high" } },
				}),
			),
		);
	}
}

const cardOf = (p: Proposal) => p.review.changes.map((c) => [c.field, c.after, c.before]);
function checkCard(id: string, p: Proposal, want: Expected) {
	assert.equal(p.operation, want.operation, id);
	assert.equal(p.review.target?.label, want.target, id);
	if (want.fields)
		assert.deepEqual(
			p.review.changes.map((c) => c.field),
			want.fields,
			`${id} card rows: ${JSON.stringify(cardOf(p))}`,
		);
	for (const [field, after, before] of want.changes ?? []) {
		const row = p.review.changes.find((c) => c.field === field);
		assert.ok(row, `${id} has a ${field} row: ${JSON.stringify(cardOf(p))}`);
		assert.deepEqual(row.after, after, `${id} ${field} after`);
		if (before !== undefined) assert.deepEqual(row.before, before, `${id} ${field} before`);
	}
	if (want.notes) assert.deepEqual(p.review.notes, want.notes, id);
}

test("CASE-EVR-PLAN-00: the six writes are reviewed writes for plant Owners and Admins only, left out of the recorded suites", async () => {
	for (const op of PLAN_WRITES) {
		assert.ok(op in REVIEWED_WRITES, op);
		assert.equal(RECORDED(op), false, `${op} stays out of the recorded suites`);
	}
	const writes = async (who: Who) =>
		readCatalog(await actorOf(who))
			.reviewedWrites.map((w) => w.operation)
			.filter((op) => (PLAN_WRITES as readonly string[]).includes(op));
	assert.deepEqual(
		await writes("owner"),
		[...PLAN_WRITES].sort((a, b) => order(a) - order(b)),
	);
	assert.deepEqual(await writes("admin"), await writes("owner"));
	assert.deepEqual(await writes("member"), []);
	assert.deepEqual(await writes("org"), []);
});
const order = (op: string) => Object.keys(REVIEWED_WRITES).indexOf(op);

for (const c of cases)
	test(`${c.id} (criterion ${c.criterion}): ${c.ask}`, async () => {
		if (c.setup === "openOffer") await openOffer();
		const actor = await actorOf(c.actor);
		const start = await snapshot();
		const turn = await ask(actor, c.ask);
		const seen = `observed answer: ${turn.answer}\nreads: ${turn.reads.join(", ")}`;
		assert.deepEqual(turn.reads, c.calls, seen);
		for (const want of c.answer ?? []) assert.ok(turn.answer.includes(want), `${c.id} says "${want}"\n${seen}`);
		for (const not of c.absent ?? []) assert.ok(!turn.answer.includes(not), `${c.id} never says "${not}"\n${seen}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} makes no card\n${seen}`);
			assert.deepEqual(await snapshot(), start, `${c.id} changes nothing`);
			return;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} makes one card\n${seen}`);
		const card = turn.proposals[0]!;
		checkCard(c.id, card, c.proposal);
		if (!c.approve) return;
		if (c.between) await between(c.between);
		const before = await snapshot();
		const outcome = await approveAndRun(actor, card);
		assert.equal(outcome, c.outcome ?? "completed", c.id);
		if (c.refusal) {
			const receipt = await admin.execute(sql`SELECT receipt->>'code' AS code FROM proposal WHERE id=${card.id}::uuid`);
			assert.equal(receipt.rows[0]!.code, c.refusal, c.id);
		}
		if (c.check) await CHECKS[c.check](before, await snapshot());
	});
