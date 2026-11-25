import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import { PeopleReadContext, withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleReader, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { moveWarningLines, moveWarnings } from "../../../packages/contracts/src/people/index.ts";
import {
	approveProposal,
	cancelProposal,
	createConversation,
	evryActor,
	executeProposal,
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
import { getDraft } from "../../../packages/evry/src/adapters/communication/reads/index.ts";
import { getStatusWarnings } from "../../../packages/evry/src/adapters/people/reads/index.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { ACTOR_SPECS, byName, evalDatabase, OTHER_PLANT, PLANT, seedHope } from "./golden-church.mts";
import {
	authorityOf,
	planOf,
	reader,
	seedGuests,
	seedLaunched,
	seedOutcome,
	seedScheduled,
	writer,
} from "./launch-church.mts";

type Who = "owner" | "admin" | "member";
type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	operation: string;
	setup?: "merged" | "longDraft" | "launched" | "submitted";
	continue?: true;
	actor: Who;
	ask: string;
	calls: string[];
	answer?: string[];
	absent?: string[];
	card?: { operation: string; target: string; changes?: Change[]; notes?: string[]; refusal?: string };
	approve?: "completed";
	decline?: true;
};
const { cases } = JSON.parse(readFileSync(new URL("./planter-daily.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let actorMember: EvryActor;
const model = scriptedQualifiedModel();
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: Who) => (await freshActor(ACTOR_SPECS[who].session))!;
const LETTER = Array.from({ length: 1000 }, (_, n) => `Line ${n} of the letter.`);
const LONG_DRAFT = randomUUID();
const OTHER_DRAFT = randomUUID();

before(async () => {
	const database = await evalDatabase({ prefix: "evryplanter", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(database.admin, { seatNames: true });
	actorMember = await actorOf("member");
});
after(() => close?.());

async function draft(id: string, tenant: string, author: string, subject: string, html: string) {
	await admin.execute(sql`INSERT INTO communication(id,plant_id,author_id,revision,state,subject,body_html,body_text,audience,created_at)
		VALUES(${id},${tenant},${author},1,'draft',${subject},${html},${subject},'{"groups":[],"teamIds":[],"personIds":[]}'::jsonb,clock_timestamp())`);
}

async function claimed(conversationId: string, who: EvryActor, text: string) {
	await submitTurn(db, who, conversationId, { requestKey: randomUUID(), text });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	return {
		claim,
		lease: {
			turnId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		},
	};
}
async function propose(who: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	const { claim, lease } = await claimed(c.id, who, "hold this turn");
	try {
		return await prepareProposal(db, who, lease, c.id, { operation, input });
	} finally {
		await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	}
}
async function approve(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders: async () => undefined,
			phaseNotices: async () => {
				throw Error("unexpected phase notice");
			},
		},
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}
async function approved(who: EvryActor, operation: string, input: unknown) {
	const card = await propose(who, operation, input);
	assert.ok(card, operation);
	assert.equal(card.review.refusal, undefined, operation);
	const done = await approve(who, card);
	assert.equal(done.outcome, "completed", `${operation} ${JSON.stringify(done.review.receipt)}`);
	return done.review;
}
async function refused(who: EvryActor, operation: string, input: unknown, refusal: string | RegExp) {
	const card = await propose(who, operation, input);
	assert.ok(card?.review.refusal, operation);
	if (typeof refusal === "string") assert.equal(card.review.refusal, refusal);
	else assert.match(card.review.refusal, refusal);
	await assert.rejects(approveProposal(db, who, card.id, { revision: card.revision, digest: card.digest }, null), {
		code: "review_closed",
	});
}

async function ask(actor: EvryActor, conversationId: string, text: string) {
	const { claim, lease } = await claimed(conversationId, actor, text);
	const outcome = await runTurn({ db, model, freshActor, native: null }, lease, {
		claimStart: new Date(),
		claimEnd: new Date(),
	});
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const page = await readConversation(db, actor, conversationId);
	const turn = page.events.slice(page.events.findLastIndex((e) => e.kind === "user_message") + 1);
	const results = turn.filter((e) => e.kind === "tool_result");
	return {
		calls: results.map((e) => String(e.body.operation)).filter((op) => op !== "evry.prepareProposal"),
		answer: turn.flatMap((e) => (e.kind === "assistant_text" ? [String(e.body.text)] : [])).join(""),
		proposals: results.flatMap((e) => {
			const id = (e.body.result as { proposalId?: string }).proposalId;
			const review = id ? page.reviews[id] : null;
			return review ? [review] : [];
		}),
		events: page.events,
	};
}

const personRow = async (name: string) =>
	(
		await admin.execute(sql`SELECT id,state,stage,adult_classification,retired_at FROM person
			WHERE plant_id=${PLANT} AND display_name=${name}`)
	).rows[0]!;
const column = async (stage: string) =>
	(
		await admin.execute(sql`SELECT display_name AS name,id,revision::text AS revision FROM person WHERE plant_id=${PLANT} AND state='live'
			AND stage=${stage} ORDER BY pipeline_position,created_at,id`)
	).rows as { name: string; id: string; revision: string }[];
const history = async () => {
	const r = await reader.readJournal(db, await authorityOf(db, "owner"));
	assert.equal(r.status, "ok");
	return r.value.entries;
};

const SETUP: Record<NonNullable<Case["setup"]>, () => Promise<void>> = {
	merged: async () => {
		await approved(await actorOf("owner"), "people.mergePeople", {
			sourceId: byName("John Smith").id,
			survivorId: byName("Jon Smith").id,
		});
	},
	longDraft: async () => {
		await draft(
			LONG_DRAFT,
			PLANT,
			ACTOR_SPECS.owner.account,
			"The long letter",
			LETTER.map((l) => `<p>${l}</p>`).join(""),
		);
		await draft(OTHER_DRAFT, OTHER_PLANT, ACTOR_SPECS.other.account, "Their letter", "<p>Theirs</p>");
	},
	launched: async () => {
		await seedScheduled(admin, db);
		await seedLaunched(db);
		await seedOutcome(db, 150);
		await seedGuests(db);
	},
	submitted: async () => {
		const plan = await planOf(db);
		const saved = await writer.submitDebrief(db, await authorityOf(db, "owner"), {
			requestKey: randomUUID(),
			expectedRevision: plan.debrief!.draft!.revision,
			input: {
				draftId: plan.debrief!.draft!.id,
				answers: { ...plan.debrief!.draft!.answers, missingNames: "no" },
			},
		});
		assert.equal(saved.status, "ok");
	},
};

const kept: Record<string, unknown> = {};
const SETTLED: Record<string, { before?: () => Promise<void>; after?: () => Promise<void> }> = {
	"PD-01": {
		before: async () => {
			kept.tom = (
				await admin.execute(sql`SELECT (SELECT count(*)::int FROM person_note WHERE person_id=${byName("Tom Baker").id}) notes,
					(SELECT count(*)::int FROM audit_event WHERE subject_id=${byName("Tom Baker").id}) audits`)
			).rows[0];
		},
		after: async () => {
			const tom = await personRow("Tom Baker");
			assert.deepEqual([tom.state, tom.stage, tom.retired_at], ["live", "attendee", null]);
			const now = (
				await admin.execute(sql`SELECT (SELECT count(*)::int FROM person_note WHERE person_id=${byName("Tom Baker").id}) notes,
					(SELECT count(*)::int FROM audit_event WHERE subject_id=${byName("Tom Baker").id}) audits`)
			).rows[0]!;
			const was = kept.tom as { notes: number; audits: number };
			assert.deepEqual(now, { notes: was.notes, audits: was.audits + 1 }, "the same records, plus the restore");
		},
	},
	"PD-02": { after: async () => assert.equal((await personRow("Rosa Rivera")).state, "retired") },
	"PD-06": { after: async () => assert.equal((await personRow("Casey Morgan")).adult_classification, "adult") },
	"PD-08": { after: async () => assert.equal((await personRow("Casey Morgan")).adult_classification, "child") },
	"PD-10": { after: async () => assert.equal((await personRow("Kevin Walsh")).stage, "interviewed") },
	"PD-11": {
		before: async () => {
			kept.order = await column("attendee");
		},
		after: async () => {
			const was = kept.order as Awaited<ReturnType<typeof column>>;
			const now = await column("attendee");
			const joy = now[0]!;
			assert.equal(joy.name, "Joy Lee");
			assert.deepEqual(
				now.slice(1),
				was.filter((p) => p.id !== joy.id),
				"nobody else moved or changed",
			);
		},
	},
	"PD-13": {
		after: async () => {
			const { debrief } = await planOf(db);
			assert.deepEqual(
				[debrief?.submitted, debrief?.draft?.answers.wentWell, debrief?.draft?.answers.toChange],
				[null, "The welcome team was ready", "Open the doors earlier"],
			);
		},
	},
	"PD-14": {
		after: async () => {
			const { debrief, evidence } = await planOf(db);
			assert.deepEqual(
				[debrief?.submitted, evidence.submittedAt, debrief?.draft?.answers],
				[
					null,
					null,
					{
						wentWell: "The welcome team was ready",
						toChange: "Open the doors earlier",
						operations: null,
						followUpPlan: "Call every guest this week",
						supportNeeded: null,
						missingNames: null,
						missingCount: null,
					},
				],
			);
		},
	},
	"PD-16": {
		after: async () => {
			const { summary } = await planOf(db);
			assert.deepEqual([summary?.draft?.body, summary?.published], ["We launched with a full room.", []]);
		},
	},
	"PD-18": {
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual([plan.guests.count, plan.outcome?.attendance], [2, 150]);
			assert.equal((await personRow("Owen Price")).state, "live");
			const entry = (await history()).find((e) => e.change.kind === "guest_correction");
			assert.deepEqual(entry?.change, {
				kind: "guest_correction",
				event: "voided",
				from: "Owen Price",
				to: null,
				countBefore: 3,
				countAfter: 2,
			});
			assert.equal(entry?.actor?.displayName, "Lena Park");
		},
	},
	"PD-19": {
		after: async () => {
			const entry = (await history()).find((e) => e.change.kind === "guest_correction");
			assert.deepEqual(entry?.change, {
				kind: "guest_correction",
				event: "relinked",
				from: "Ruth Kim",
				to: "Maria Santos",
				countBefore: 2,
				countAfter: 2,
			});
		},
	},
	"PD-20": {
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual([plan.outcome?.attendance, plan.guests.count], [162, 2]);
			const entry = (await history()).find((e) => e.change.kind === "outcome" && e.change.event === "corrected");
			assert.deepEqual(entry?.change.kind === "outcome" ? entry.change.changes : null, [
				{ field: "attendance", before: 150, after: 162 },
			]);
		},
	},
};

test("INV-evry-planter: every planter case passes on the scripted model, and each approved change reads back", async () => {
	let conversation = "";
	for (const c of cases) {
		if (c.setup) await SETUP[c.setup]();
		const actor = await actorOf(c.actor);
		if (!c.continue) conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		const turn = await ask(actor, conversation, c.ask);
		assert.deepEqual(c.operation === "evry.composeReads" ? turn.calls.sort() : turn.calls, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer.slice(0, 600))} has ${text}`);
		for (const text of c.absent ?? [])
			assert.ok(!turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} leaves out ${text}`);
		assert.equal(turn.proposals.length, c.card ? 1 : 0, `${c.id} cards: ${turn.answer}`);
		const [card] = turn.proposals;
		if (!c.card || !card) continue;
		assert.deepEqual(
			[card.operation, card.review.target?.label, card.status, card.review.refusal],
			[c.card.operation, c.card.target, "pending", c.card.refusal],
			c.id,
		);
		if (c.card.changes) assert.deepEqual(card.review.changes, c.card.changes, `${c.id} changes`);
		for (const line of c.card.notes ?? [])
			assert.ok(card.review.notes?.includes(line), `${c.id} notes ${JSON.stringify(card.review.notes)} have ${line}`);
		await SETTLED[c.id]?.before?.();
		if (c.decline) assert.equal((await cancelProposal(db, actor, card.id)).cancelled, true, c.id);
		if (c.approve) {
			await assert.rejects(
				approveProposal(db, await actorOf("member"), card.id, { revision: card.revision, digest: card.digest }, null),
				{ code: "not_found" },
				`${c.id}: another account can't approve it`,
			);
			const done = await approve(actor, card);
			assert.deepEqual(
				[done.outcome, done.review.outcome],
				[c.approve, c.approve],
				`${c.id} ${JSON.stringify(done.review.receipt)}`,
			);
			if (c.card.operation === "people.restorePerson") assert.equal(done.review.review.target?.label, c.card.target);
		}
		await SETTLED[c.id]?.after?.();
	}
});

test("INV-evry-planter: a restore or an adult or child status through Evry stores what the native command stores", async () => {
	const owner = await actorOf("owner");
	const twin = async (name: string, retired: boolean) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
			VALUES(${id},${PLANT},${PLANT},${name},'other',clock_timestamp(),'attendee','unknown','unknown',900,${retired ? "retired" : "live"},${retired ? "2026-11-01T00:00:00Z" : null})`);
		return id;
	};
	const stored = async (id: string) => ({
		person: (
			await admin.execute(
				sql`SELECT state,stage,adult_classification,retired_at,revision::text AS revision FROM person WHERE id=${id}`,
			)
		).rows[0],
		audit: (
			await admin.execute(sql`SELECT action,kind,subject_type,actor_id,reason,
				before_value-'pipeline_position' AS before,after_value-'pipeline_position' AS after
				FROM audit_event WHERE subject_id=${id} ORDER BY recorded_at,id`)
		).rows,
	});
	const native = async (
		method: "restorePerson" | "recordAdultClassification" | "correctAdultClassification",
		id: string,
		input: object,
	) => {
		const { revision } = (await admin.execute(sql`SELECT revision::text AS revision FROM person WHERE id=${id}`))
			.rows[0]!;
		const reply = await withPeopleWrite(db, owner.authority, (tx, ctx) =>
			peopleWriter[method](
				tx,
				ctx as never,
				{ requestKey: randomUUID(), expectedRevision: revision, input: { personId: id, ...input } } as never,
			),
		);
		assert.equal(reply.status, "ok", JSON.stringify(reply));
	};
	const adult = { classification: "adult", occurredOn: "2026-11-01", reason: "They told us." };
	const child = { classification: "child", occurredOn: "2026-11-02", reason: "Wrong card." };
	const [screen, evry] = [await twin("Screen Twin", true), await twin("Evry Twin", true)];
	await native("restorePerson", screen, {});
	await approved(owner, "people.restorePerson", { personId: evry });
	assert.deepEqual(await stored(evry), await stored(screen), "restore");
	await native("recordAdultClassification", screen, adult);
	await approved(owner, "people.recordAdultClassification", { personId: evry, ...adult });
	assert.deepEqual(await stored(evry), await stored(screen), "record");
	await native("correctAdultClassification", screen, child);
	await approved(owner, "people.correctAdultClassification", { personId: evry, ...child });
	assert.deepEqual(await stored(evry), await stored(screen), "correct");

	await refused(
		owner,
		"people.restorePerson",
		{ personId: evry },
		"Evry Twin is already in People, so there's nothing to bring back.",
	);
	await refused(
		owner,
		"people.recordAdultClassification",
		{ personId: evry, ...adult },
		"Evry Twin is already recorded as Child. Ask Evry to correct it.",
	);
	const fresh = await twin("Fresh Twin", false);
	await refused(
		owner,
		"people.correctAdultClassification",
		{ personId: fresh, ...child },
		"Nothing is recorded for Fresh Twin yet, so there's nothing to correct. Ask Evry to record it.",
	);
	for (const operation of ["people.recordAdultClassification", "people.correctAdultClassification"]) {
		await refused(
			owner,
			operation,
			{ personId: fresh, ...adult, occurredOn: "2027-01-01" },
			"This date is after today at your church. Choose an earlier date.",
		);
		await assert.rejects(propose(actorMember, operation, { personId: fresh, ...adult }), { code: "access_denied" });
	}
	const pending = await propose(owner, "people.recordAdultClassification", { personId: fresh, ...adult });
	await admin.execute(sql`UPDATE person SET birth_date='2015-01-01',revision=revision+1 WHERE id=${fresh}`);
	const again = await approve(owner, pending!);
	assert.equal(again.outcome, "reviewing", "a birth date saved since the card");
	assert.match(again.review.review.refusal ?? "", /^Fresh Twin's birth date decides adult or child/);
	for (const operation of ["people.recordAdultClassification", "people.correctAdultClassification"])
		await refused(owner, operation, { personId: fresh, ...adult }, /^Fresh Twin's birth date decides adult or child/);
	assert.equal((await stored(fresh)).person!.adult_classification, "unknown");
});

test("INV-evry-planter: two deleted people of one name are listed to choose from, and one card restores the one picked", async () => {
	const owner = await actorOf("owner");
	const ids = [randomUUID(), randomUUID()];
	for (const [n, id] of ids.entries())
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
			VALUES(${id},${PLANT},${PLANT},'Lee Same','other',clock_timestamp(),'prospect','unknown','unknown',950,'retired',${`2026-11-0${n + 1}T18:00:00Z`})`);
	await assert.rejects(
		propose(owner, "people.restorePerson", { name: "lee same" }),
		(error: { code: string; problem: string }) => {
			assert.equal(error.code, "invalid_input");
			for (const id of ids) assert.ok(error.problem.includes(id), error.problem);
			return true;
		},
	);
	await assert.rejects(propose(owner, "people.restorePerson", { name: "Nobody Here" }), { code: "not_found" });
	await approved(owner, "people.restorePerson", { personId: ids[0] });
	const states = await admin.execute(sql`SELECT id,state FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`);
	assert.deepEqual(
		new Map(states.rows.map((r) => [r.id, r.state])),
		new Map([
			[ids[0], "live"],
			[ids[1], "retired"],
		]),
	);
	const theirs = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
		VALUES(${theirs},${OTHER_PLANT},${OTHER_PLANT},'Their Person','other',clock_timestamp(),'prospect','unknown','unknown',1,'retired','2026-11-01T18:00:00Z')`);
	await assert.rejects(propose(owner, "people.restorePerson", { personId: theirs }), { code: "not_found" });
});

test("INV-evry-planter: a move's card and the stage dialog show the same warnings, for a skipped stage, a full record and a move out of the committed stages", async () => {
	const owner = await actorOf("owner");
	const screen = async (personId: string, from: string, to: string) => {
		const reply = await gatedTransaction(db, (tx) =>
			peopleReader.getStatusWarnings(tx, new PeopleReadContext(owner.authority), { personId } as never),
		);
		assert.equal(reply.status, "ok");
		return moveWarningLines(moveWarnings(from as never, to as never, reply.value as never));
	};
	const card = async (personId: string, to: string) => {
		const found = await propose(owner, "people.changeStatus", { personId, stage: to, reason: "We talked." });
		assert.equal(found!.review.refusal, undefined, "warnings never block");
		return found!.review.notes ?? [];
	};
	const jessica = byName("Jessica Wu").id;
	const skipped = await card(jessica, "core_group");
	assert.deepEqual(skipped, await screen(jessica, "attendee", "core_group"));
	assert.equal(skipped[0], "Skips 2 stages: Following up, Interviewed");
	const read = await invokeRead(db, actorMember, getStatusWarnings as never, {
		personId: jessica,
		stage: "core_group",
	});
	assert.equal(read.rows[0]!.fields.reminders, skipped.join("\n"));

	const james = byName("James Okafor").id;
	const given = { rating: "pass", notes: "Given" };
	const scored = { score: 3, notes: "Given" };
	await approved(owner, "people.createInterview", {
		personId: james,
		occurredOn: "2026-10-01",
		maturity: given,
		gifted: given,
		chemistry: given,
		rightReasons: given,
		season: given,
		result: "qualified",
	});
	await approved(owner, "people.createAssessment", {
		personId: james,
		occurredOn: "2026-10-01",
		committed: scored,
		compelled: scored,
		contagious: scored,
		courageous: scored,
	});
	await approved(owner, "people.createCommitment", { personId: james, kind: "core_group", occurredOn: "2026-10-01" });
	assert.deepEqual(await card(james, "core_group"), []);
	assert.deepEqual(await screen(james, "interviewed", "core_group"), []);

	const sam = byName("Sam Patel").id;
	const leaving = await card(sam, "attendee");
	assert.deepEqual(leaving, await screen(sam, "core_group", "attendee"));
	assert.ok(leaving.includes("1 open duty needs an owner"), JSON.stringify(leaving));
});

test("INV-evry-planter: a column that changed after the card refuses the approval and moves nobody", async () => {
	const owner = await actorOf("owner");
	const start = await column("prospect");
	const [first, second, third] = start;
	const stale = (await propose(owner, "people.reorderPipeline", { personId: third!.id, afterId: null }))!;
	await approved(owner, "people.reorderPipeline", { personId: first!.id, afterId: second!.id });
	const now = await column("prospect");
	assert.deepEqual(
		now.slice(0, 3).map((p) => p.id),
		[second!.id, first!.id, third!.id],
	);
	const done = await approve(owner, stale);
	assert.deepEqual([done.outcome, done.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.deepEqual(await column("prospect"), now);
	await refused(
		owner,
		"people.reorderPipeline",
		{ personId: second!.id, afterId: null },
		`${second!.name} is already first in the Prospect column.`,
	);
	await refused(
		owner,
		"people.reorderPipeline",
		{ personId: second!.id, afterId: byName("Joy Lee").id },
		`Name someone else in the Prospect column to place ${second!.name} after.`,
	);
	await assert.rejects(propose(actorMember, "people.reorderPipeline", { personId: second!.id, afterId: null }), {
		code: "access_denied",
	});
});

test("INV-evry-planter: a draft over the section limit is read whole in parts, with its paragraphs, and another church's draft is not found", async () => {
	const member = await actorOf("member");
	const whole: string[] = [];
	for (let page: number | null = 1; page !== null;) {
		const part: Awaited<ReturnType<typeof invokeRead>> = await invokeRead(db, member, getDraft as never, {
			communicationId: LONG_DRAFT,
			page,
		});
		assert.deepEqual([part.status, part.completeness], ["available", part.next === null ? "complete" : "partial"]);
		assert.ok(JSON.stringify(part).length < 16_000);
		whole.push(String(part.rows[0]!.fields.body));
		page = part.next;
	}
	assert.ok(whole.length > 2);
	assert.equal(whole.join(""), LETTER.join("\n\n"));
	const native = await gatedTransaction(db, (tx) =>
		communicationWriter.getDraft(tx, member.authority, { id: LONG_DRAFT }),
	);
	assert.equal(native.status, "ok", "a Member reads it in Messages too");
	const theirs = await invokeRead(db, member, getDraft as never, { communicationId: OTHER_DRAFT });
	assert.deepEqual([theirs.status, theirs.rows], ["not_found", []]);
});

test("INV-evry-planter: a debrief or summary draft saved elsewhere since the card is never overwritten", async () => {
	const owner = await actorOf("owner");
	const before = await planOf(db);
	const version = before.debrief!.submitted!.version;
	const stale = (await propose(owner, "launch.saveDebriefDraft", { operations: "Two more greeters" }))!;
	assert.ok(stale.review.notes?.includes(`The submitted debrief (version ${version}) stays as it is.`));
	await approved(owner, "launch.saveDebriefDraft", { supportNeeded: "A drummer" });
	const saved = await planOf(db);
	const done = await approve(owner, stale);
	assert.deepEqual([done.outcome, done.review.receipt?.code], ["refused", "revision_conflict"]);
	const after = await planOf(db);
	assert.deepEqual(after.debrief, saved.debrief);
	assert.deepEqual([after.debrief?.submitted, after.evidence], [before.debrief?.submitted, before.evidence]);
	assert.deepEqual(
		[
			after.debrief?.draft?.answers.supportNeeded,
			after.debrief?.draft?.answers.wentWell,
			after.debrief?.draft?.answers.operations,
		],
		["A drummer", "The welcome team was ready", null],
	);
	const summary = (await propose(owner, "launch.saveDebriefSummaryDraft", { body: "Older words" }))!;
	await approved(owner, "launch.saveDebriefSummaryDraft", { body: "Newer words" });
	assert.equal((await approve(owner, summary)).review.receipt?.code, "revision_conflict");
	assert.deepEqual(
		[(await planOf(db)).summary?.draft?.body, (await planOf(db)).summary?.published],
		["Newer words", []],
	);
	await refused(owner, "launch.saveDebriefDraft", {}, "Say what to save for at least one area of the debrief.");
	await refused(
		owner,
		"launch.saveDebriefSummaryDraft",
		{ body: "x".repeat(4001) },
		"Keep the summary to 4,000 characters or fewer.",
	);
	await assert.rejects(propose(actorMember, "launch.saveDebriefDraft", { wentWell: "No" }), { code: "access_denied" });
});

test("INV-evry-planter: a guest changed since the card, or already on the list, is refused with the counts as they are", async () => {
	const owner = await actorOf("owner");
	const [maya, maria] = (await planOf(db)).guests.named!.map((g) => g.personId);
	const joy = byName("Joy Lee").id;
	const stale = (await propose(owner, "launch.correctGuestAttendance", { personId: maya, correctPersonId: null }))!;
	await approved(owner, "launch.correctGuestAttendance", { personId: maya, correctPersonId: joy });
	const done = await approve(owner, stale);
	assert.deepEqual([done.outcome, done.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.deepEqual(done.review.receipt?.current, [{ id: PLANT, label: "Guests named", value: "2" }]);
	await refused(
		owner,
		"launch.correctGuestAttendance",
		{ personId: joy, correctPersonId: maria },
		"Maria Santos is already named as a Launch Sunday guest. To drop the extra name, take Joy Lee off the list.",
	);
	assert.equal(await propose(owner, "launch.correctGuestAttendance", { personId: maya, correctPersonId: null }), null);
});
