import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { wrapLanguageModel } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	createConversation,
	executeProposal,
	readConversation,
	prepareProposal,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim, recoverLease, type Claim } from "../../../apps/web/src/server/jobs/queue.ts";
import {
	accounts,
	actor,
	admin,
	db,
	freshActor,
	people,
	plant,
	queries,
	role,
	setup,
	sql,
	teardown,
	work,
} from "../runtime/support.mts";

// The task reminder port of a stage change or retirement. These people hold no dated, assigned task, so a replan
// here would be a bug.
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(setup);
after(teardown);

const lease = (claim: Claim) => ({
	jobId: claim.id,
	tenantId: claim.tenant_id,
	leaseOwner: claim.lease_owner,
	generation: claim.claim_generation,
});
const counted = (start: number) =>
	queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;

/** Claims the next approved effect through the WP-031 queue and runs it, as the app worker does. */
async function effects() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const start = queries.length;
	const outcome = await executeProposal(db, lease(claim), noReminders);
	const statements = counted(start);
	if (outcome !== "lost")
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, statements };
}

/**
 * Runs the next approved effect while another transaction holds the plant row, so the executor passes its first
 * check and then waits for write authority. `during` runs while it waits; then the plant row is released.
 */
async function stalledEffect(during: (claim: Claim) => Promise<void>) {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	let running: Promise<string> | undefined;
	await admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM plant WHERE id=${plant} FOR UPDATE`);
		running = executeProposal(db, lease(claim), noReminders);
		for (let waiting = 0, deadline = Date.now() + 20_000; !waiting;) {
			assert.ok(Date.now() < deadline, "the executor never waited for write authority");
			const r = await admin.execute(
				sql`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND usename=${role} AND query LIKE '%write_gate%'`,
			);
			waiting = (r.rows[0] as { n: number }).n;
		}
		await during(claim);
	});
	const outcome = await running!;
	if (outcome !== "lost")
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

/** Asks Evry for a change in a new conversation, runs the turn and returns the proposal from its review card. */
async function propose(who: EvryActor, text: string) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text });
	assert.equal(await work(), "succeeded");
	const page = await readConversation(db, who, c.id);
	const card = page.events.find((e) => e.kind === "tool_result" && e.body.operation === "evry.prepareProposal");
	const said = page.events
		.filter((e) => e.kind === "assistant_text")
		.map((e) => e.body.text)
		.join("");
	assert.ok(card, said);
	return { proposal: await readReview(db, who, (card.body.result as { proposalId: string }).proposalId), said };
}

async function person(id: string) {
	const r = await admin.execute(sql`SELECT city,phone,revision::text FROM person WHERE id=${id}`);
	return r.rows[0] as { city: string | null; phone: string | null; revision: string };
}
async function effectAudits(proposalId: string) {
	const r = await admin.execute(
		sql`SELECT id,actor_id,action,after_value FROM audit_event WHERE request_key LIKE ${"evry:" + proposalId + ":%"}`,
	);
	return r.rows as { id: string; actor_id: string; action: string; after_value: Record<string, unknown> }[];
}
async function effectJobs(proposalId: string) {
	const r = await admin.execute(
		sql`SELECT state FROM job WHERE kind='evry_effect' AND producer_key LIKE ${proposalId + ":%"} ORDER BY eligible_at`,
	);
	return r.rows.map((row) => row.state as string);
}
/** The approval witness a trusted review control sends: the exact revision and digest the person saw. */
const witness = (p: { revision: number; digest: string }) => ({ revision: p.revision, digest: p.digest });
async function refusal(promise: Promise<unknown>) {
	return promise.then(
		() => "none",
		(error: { code?: string }) => error.code,
	);
}

test("AC:UI45-004 AC:UI45-003 AC:INH-REGRESSION-REVISED-APPROVAL AC:INH-REGRESSION-TEMPLATE-EDIT AC:INH-REGRESSION-CONFIRM-REPLAY AC:UI45-005 AC:AUDIT-002 INV-budget: nothing changes until the exact current revision is approved; then the change runs once with its own audit row", async () => {
	const owner = await actor("owner");
	const before = await person(people.casey);
	const { proposal, said } = await propose(owner, "Change Casey's city to Austin");
	assert.match(said, /Nothing changes until you approve it/);
	assert.deepEqual(
		[proposal.status, proposal.revision, proposal.outcome, proposal.review],
		[
			"pending",
			1,
			null,
			{
				target: { kind: "person", id: people.casey, label: "Casey Reed" },
				changes: [{ field: "city", before: null, after: "Austin" }],
			},
		],
	);
	assert.deepEqual([await person(people.casey), await effectAudits(proposal.id)], [before, []]);
	let start = queries.length;
	await readReview(db, owner, proposal.id);
	assert.equal(counted(start), 1);

	// Preparing a review inside a running turn is one statement, and needs that turn's current claim.
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [turn] = await claimDue(db, ["assistant_turn"], 1, 240);
	const run = {
		turnId: turn!.id,
		tenantId: turn!.tenant_id,
		leaseOwner: turn!.lease_owner,
		generation: turn!.claim_generation,
	};
	const call = { operation: "people.updatePerson", input: { personId: people.casey, patch: { city: "Elgin" } } };
	start = queries.length;
	assert.equal((await prepareProposal(db, owner, run, c.id, call))?.status, "pending");
	assert.equal(counted(start), 1);
	await cancelTurn(db, owner, c.id);
	assert.equal(await prepareProposal(db, owner, run, c.id, call), null);

	// Another account or context sees nothing, and cannot approve.
	for (const who of ["member", "foreign"] as const) {
		const other = await actor(who);
		assert.equal(await refusal(readReview(db, other, proposal.id)), "not_found");
		assert.equal(await refusal(approveProposal(db, other, proposal.id, witness(proposal), null)), "not_found");
	}

	// Editing a reviewed fact makes a new revision; the old approval witness no longer applies.
	start = queries.length;
	const revised = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 1,
		input: { personId: people.casey, patch: { city: "Denver" } },
	});
	assert.equal(counted(start), 1);
	assert.deepEqual([revised.revision, revised.review.changes], [2, [{ field: "city", before: null, after: "Denver" }]]);
	assert.notEqual(revised.digest, proposal.digest);
	assert.equal(await refusal(approveProposal(db, owner, proposal.id, witness(proposal), null)), "review_changed");
	assert.equal(
		await refusal(approveProposal(db, owner, proposal.id, { revision: 2, digest: proposal.digest }, null)),
		"review_changed",
	);
	assert.deepEqual(await effectJobs(proposal.id), []);

	// A double confirm queues one effect; the second returns the same approval.
	start = queries.length;
	const first = await approveProposal(db, owner, proposal.id, witness(revised), null);
	assert.equal(counted(start), 1);
	const [a, b] = await Promise.all([
		approveProposal(db, owner, proposal.id, witness(revised), null),
		approveProposal(db, owner, proposal.id, witness(revised), null),
	]);
	assert.deepEqual([first.replayed, a.replayed, b.replayed, first.proposal.status], [false, true, true, "approved"]);
	assert.deepEqual(await effectJobs(proposal.id), ["ready"]);

	// Two workers: the effect runs once, in a fixed number of statements.
	const runs = (await Promise.all([effects(), effects()])).filter((r) => r !== null);
	assert.deepEqual(
		runs.map((r) => r.outcome),
		["completed"],
	);
	assert.equal(runs[0]!.statements, 7);
	const audits = await effectAudits(proposal.id);
	const done = await readReview(db, owner, proposal.id);
	assert.deepEqual(
		[(await person(people.casey)).city, audits.length, audits[0]!.action, audits[0]!.actor_id],
		["Denver", 1, "people.updated", accounts.owner.id],
	);
	assert.deepEqual(audits[0]!.after_value, { city: "Denver" });
	assert.deepEqual(
		[done.status, done.outcome, done.executing, done.receipt?.receiptId],
		["approved", "completed", false, audits[0]!.id],
	);

	// Confirming, retrying or cancelling again returns the recorded outcome and repeats nothing.
	assert.equal((await approveProposal(db, owner, proposal.id, witness(revised), null)).proposal.outcome, "completed");
	assert.equal((await retryUnresolvedEffects(db, owner, proposal.id)).retried, false);
	const cancel = await cancelProposal(db, owner, proposal.id);
	assert.deepEqual([cancel.cancelled, cancel.proposal.outcome], [false, "completed"]);
	assert.equal(await effects(), null);
	assert.deepEqual([(await effectAudits(proposal.id)).length, await effectJobs(proposal.id)], [1, ["succeeded"]]);
});

test("AC:INH-REGRESSION-EXPIRED-APPROVAL AC:UI45-004 AC:SEC-12 an approval at or after expiry, even one that lapses while the effect waits, or a cancelled one, starts nothing", async () => {
	const owner = await actor("owner");
	const before = await person(people.casey);
	const { proposal } = await propose(owner, "Change Casey's phone to 555-0100");
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${proposal.id}`);
	assert.equal(await refusal(approveProposal(db, owner, proposal.id, witness(proposal), null)), "review_expired");
	assert.equal((await readReview(db, owner, proposal.id)).status, "expired");

	// A fresh review gets a new expiry; an approval that lapses before the effect starts still changes nothing.
	const fresh = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 1,
		input: { personId: people.casey, patch: { phone: "555-0100" } },
	});
	assert.ok(fresh.expiresAt.getTime() - Date.now() > 14 * 60_000);
	await approveProposal(db, owner, proposal.id, witness(fresh), null);
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${proposal.id}`);
	assert.equal((await effects())?.outcome, "expired");
	const lapsed = await readReview(db, owner, proposal.id);
	assert.deepEqual([lapsed.status, lapsed.outcome], ["expired", null]);
	assert.equal(await refusal(retryUnresolvedEffects(db, owner, proposal.id)), "review_expired");

	// An approval that lapses while the effect waits for write authority does not publish it either.
	const late = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 2,
		input: { personId: people.casey, patch: { phone: "555-0100" } },
	});
	await approveProposal(db, owner, proposal.id, witness(late), null);
	await admin.execute(
		sql`UPDATE proposal SET expires_at=clock_timestamp()+interval '1 second' WHERE id=${proposal.id}`,
	);
	const outcome = await stalledEffect(async () => {
		for (let passed = false; !passed;) {
			const r = await admin.execute(
				sql`SELECT expires_at<=clock_timestamp() AS passed FROM proposal WHERE id=${proposal.id}`,
			);
			passed = (r.rows[0] as { passed: boolean }).passed;
		}
	});
	const waited = await readReview(db, owner, proposal.id);
	assert.deepEqual(
		[outcome, waited.status, waited.outcome, await effectAudits(proposal.id)],
		["expired", "expired", null, []],
	);

	// Cancel before the effect starts: the queued effect never runs.
	const again = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 3,
		input: { personId: people.casey, patch: { phone: "555-0100" } },
	});
	await approveProposal(db, owner, proposal.id, witness(again), null);
	let start = queries.length;
	const cancelled = await cancelProposal(db, owner, proposal.id);
	assert.equal(counted(start), 1);
	assert.deepEqual([cancelled.cancelled, cancelled.proposal.status], [true, "cancelled"]);
	assert.equal(await effects(), null);
	assert.equal(await refusal(approveProposal(db, owner, proposal.id, witness(again), null)), "review_closed");
	assert.deepEqual(
		[await person(people.casey), await effectAudits(proposal.id), await effectJobs(proposal.id)],
		[before, [], ["succeeded", "succeeded", "cancelled"]],
	);
});

test("AC:INH-REGRESSION-REVOKED-SEAT AC:SEC-02 AC:B03-036 AC:SEC-12 INV-tenancy: live authority and the reviewed state are checked again when the effect starts", async () => {
	const owner = await actor("owner");
	const seat = sql`account_id=${accounts.owner.id} AND plant_id IS NOT NULL`;
	const cases: [string, () => Promise<unknown>, () => Promise<unknown>, string][] = [
		[
			"role changed",
			() => admin.execute(sql`UPDATE seat SET role='member' WHERE ${seat}`),
			() => admin.execute(sql`UPDATE seat SET role='owner' WHERE ${seat}`),
			"access_denied",
		],
		[
			"seat ended",
			() => admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE ${seat}`),
			() => admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE ${seat}`),
			"access_denied",
		],
		[
			"person changed since the review",
			() => admin.execute(sql`UPDATE person SET city='Elgin',revision=revision+1 WHERE id=${people.alexChen}`),
			async () => undefined,
			"revision_conflict",
		],
	];
	for (const [name, change, restore, code] of cases) {
		const { proposal } = await propose(owner, "Change Chen's city to Joliet");
		await approveProposal(db, owner, proposal.id, witness(proposal), null);
		await change();
		const expected = (await person(people.alexChen)).city;
		const ran = await effects();
		await restore();
		const after = await readReview(db, owner, proposal.id);
		assert.deepEqual(
			[
				ran?.outcome,
				after.outcome,
				after.receipt?.code,
				(await person(people.alexChen)).city,
				await effectAudits(proposal.id),
			],
			["refused", "refused", code, expected, []],
			name,
		);
		// A refused effect is never retried under the old approval.
		assert.equal(await refusal(retryUnresolvedEffects(db, owner, proposal.id)), "review_closed", name);
	}

	// Signing out the approving session refuses an effect that has not started.
	const session = randomUUID();
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${accounts.owner.user},${randomUUID()},clock_timestamp()+interval '1 hour')`,
	);
	const second = evryActor((await readViewer(db, session as never))!.authority!);
	const { proposal } = await propose(owner, "Change Chen's city to Joliet");
	await approveProposal(db, second, proposal.id, witness(proposal), null);
	await admin.execute(sql`DELETE FROM auth_session WHERE id=${session}`);
	assert.equal((await effects())?.outcome, "refused");
	assert.deepEqual(
		[(await readReview(db, owner, proposal.id)).receipt?.code, await effectAudits(proposal.id)],
		["access_denied", []],
	);
});

test("AC:EVRY-LEASE-FENCE AC:INH-REGRESSION-RETRY AC:INH-EDGES-12: an executor stalled before or after its first check cannot publish once its claim is replaced; a retry never repeats a completed effect", async () => {
	const owner = await actor("owner");
	const { proposal } = await propose(owner, "Change Rivera's city to Naperville");
	await approveProposal(db, owner, proposal.id, witness(proposal), null);
	assert.equal((await readReview(db, owner, proposal.id)).executing, true);
	// The executor passes its first check, then waits for the plant lock while its lease expires and recovery
	// replaces the claim. When the lock frees, it must not publish the change, its audit row or an outcome.
	let stalled: Claim | undefined;
	const outcome = await stalledEffect(async (claim) => {
		stalled = claim;
		await admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${claim.id}`);
		assert.equal(await recoverLease(admin), 1);
	});
	assert.equal(outcome, "lost");
	assert.deepEqual([await effectAudits(proposal.id), (await person(people.alexRivera)).city], [[], "Chicago"]);
	// The outcome is unknown, not failed: the retry resumes the same effect key.
	assert.equal((await readReview(db, owner, proposal.id)).outcome, "unknown");
	const start = queries.length;
	assert.equal((await retryUnresolvedEffects(db, owner, proposal.id)).retried, true);
	assert.equal(counted(start), 1);
	assert.equal((await effects())?.outcome, "completed");
	assert.equal(await executeProposal(db, lease(stalled!), noReminders), "lost");
	const retry = await retryUnresolvedEffects(db, owner, proposal.id);
	assert.deepEqual([retry.retried, retry.proposal.outcome], [false, "completed"]);
	assert.equal(await effects(), null);
	const audits = await effectAudits(proposal.id);
	assert.deepEqual([audits.length, (await person(people.alexRivera)).city], [1, "Naperville"]);
});

test("AC:UI45-006 AC:EVRY-CONTEXT-BOUNDS a review's fields leave model input once its target is retired during the turn", async () => {
	const owner = await actor("owner");
	const robin = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${robin},${plant},${plant},'Robin Vale','Oldtown','other',clock_timestamp(),'prospect','unknown','unknown',500,'live')`);
	const calls: LanguageModelV4CallOptions[] = [];
	const model = wrapLanguageModel({
		model: scriptedModel(),
		middleware: { specificationVersion: "v4", transformParams: async ({ params }) => (calls.push(params), params) },
	}) as LanguageModelV4;
	// Robin is retired right after the review is saved, before the next model call reads its input.
	const retiring = async (session: string) => {
		await admin.execute(sql`UPDATE person SET state='retired',retired_at=clock_timestamp()
			WHERE id=${robin} AND state='live' AND EXISTS(SELECT FROM proposal WHERE review->'target'->>'id'=${robin})`);
		return freshActor(session);
	};
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Change Robin's city to Newtown" });
	assert.equal(await work({ status: "qualified", id: "test", model }, { freshActor: retiring }), "succeeded");
	const page = await readConversation(db, owner, c.id);
	const card = page.events.find((e) => e.kind === "tool_result" && e.body.operation === "evry.prepareProposal");
	assert.ok(card, "a review was prepared before the retirement");
	const last = JSON.stringify(calls.at(-1)!.prompt);
	assert.ok(
		!last.includes("Oldtown") && !last.includes("Robin Vale"),
		"no retired source fields reach the next model call",
	);
	assert.ok(
		JSON.stringify(calls[calls.length - 2]!.prompt).includes("Robin Vale"),
		"the earlier call did see the live row",
	);
	assert.equal(
		(await readReview(db, owner, (card.body.result as { proposalId: string }).proposalId)).review.withheld,
		true,
	);
});

test("AC:EVRY-LEASE-FENCE an executor whose lease expires while it waits for the publication locks does not publish", async () => {
	const owner = await actor("owner");
	const { proposal } = await propose(owner, "Change Chen's city to Aurora");
	await approveProposal(db, owner, proposal.id, witness(proposal), null);
	const before = await person(people.alexChen);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	await admin.execute(
		sql`UPDATE job SET lease_until=clock_timestamp()+interval '2000 milliseconds' WHERE id=${claim.id}`,
	);
	let running: Promise<string> | undefined;
	// Another transaction holds the job row unchanged; the executor reaches publication and waits for its share lock
	// until the lease has passed.
	await admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM job WHERE id=${claim.id} FOR UPDATE`);
		running = executeProposal(db, lease(claim), noReminders);
		// The executor's session (the test runtime role) waits on a lock; its query text is too long to match reliably.
		for (let waiting = 0, deadline = Date.now() + 20_000; !waiting;) {
			assert.ok(Date.now() < deadline, "the executor never waited for the job row");
			const r = await admin.execute(
				sql`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND usename=${role}`,
			);
			waiting = (r.rows[0] as { n: number }).n;
		}
		for (let passed = false; !passed;) {
			const r = await admin.execute(sql`SELECT lease_until<=clock_timestamp() AS passed FROM job WHERE id=${claim.id}`);
			passed = (r.rows[0] as { passed: boolean }).passed;
		}
	});
	assert.equal(await running!, "lost");
	const after = await readReview(db, owner, proposal.id);
	assert.deepEqual(
		[await effectAudits(proposal.id), (await person(people.alexChen)).city, after.outcome],
		[[], before.city, "unknown"],
	);
});

test("AC:SEC-02 INV-tenancy: a review read takes no lock that a sign-out or session update waits for (C32)", async () => {
	const owner = await actor("owner");
	const { proposal } = await propose(owner, "Change Casey's city to Wheaton");
	await db.transaction(async (tx) => {
		// The read's transaction stays open while another connection changes the reader's session.
		assert.equal((await readReview(tx as unknown as typeof db, owner, proposal.id)).status, "pending");
		await admin.transaction(async (other) => {
			await other.execute(sql`SET LOCAL lock_timeout = '2s'`);
			await other.execute(sql`UPDATE auth_session SET expires_at=expires_at WHERE id=${accounts.owner.session}`);
		});
	});
});
