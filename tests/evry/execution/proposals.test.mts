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
	openLatestConversation,
	readConversation,
	prepareProposal,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { waitingOnLock } from "../../support/fixture.mts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import { scriptedModel } from "../../../packages/evry/src/runtime/scripted.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim, recoverLease, type Claim } from "../../../packages/domain/src/jobs/queue.ts";
import { accounts, actor, admin, db, people, plant, queries, setup, sql, teardown, work } from "../runtime/support.mts";

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

async function backendPid(tx: Parameters<Parameters<typeof admin.transaction>[0]>[0]) {
	const [row] = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows;
	assert.ok(row);
	return row.pid;
}

async function stalledEffect(during: (claim: Claim) => Promise<void>, leaseSeconds = 60) {
	const [claim] = await claimDue(db, ["evry_effect"], 1, leaseSeconds);
	assert.ok(claim);
	let running: Promise<string> | undefined;
	await admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM plant WHERE id=${plant} FOR UPDATE`);
		running = executeProposal(db, lease(claim), noReminders);
		await waitingOnLock(admin, { blockedBy: await backendPid(tx) });
		await during(claim);
	});
	const outcome = await running!;
	if (outcome !== "lost")
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

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

	for (const who of ["member", "foreign"] as const) {
		const other = await actor(who);
		assert.equal(await refusal(readReview(db, other, proposal.id)), "not_found");
		assert.equal(await refusal(approveProposal(db, other, proposal.id, witness(proposal), null)), "not_found");
	}

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

	start = queries.length;
	const first = await approveProposal(db, owner, proposal.id, witness(revised), null);
	assert.equal(counted(start), 1);
	const [a, b] = await Promise.all([
		approveProposal(db, owner, proposal.id, witness(revised), null),
		approveProposal(db, owner, proposal.id, witness(revised), null),
	]);
	assert.deepEqual([first.replayed, a.replayed, b.replayed, first.proposal.status], [false, true, true, "approved"]);
	assert.deepEqual(await effectJobs(proposal.id), ["ready"]);

	const runs = (await Promise.all([effects(), effects()])).filter((r) => r !== null);
	assert.deepEqual(
		runs.map((r) => r.outcome),
		["completed"],
	);
	assert.equal(runs[0]!.statements, 6);
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

	const fresh = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 1,
		input: { personId: people.casey, patch: { phone: "555-0100" } },
	});
	const [clock] = (await admin.execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`)).rows;
	assert.ok(clock);
	assert.ok(fresh.expiresAt.getTime() - Date.parse(clock.now) > 14 * 60_000);
	await approveProposal(db, owner, proposal.id, witness(fresh), null);
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${proposal.id}`);
	assert.equal((await effects())?.outcome, "expired");
	const lapsed = await readReview(db, owner, proposal.id);
	assert.deepEqual([lapsed.status, lapsed.outcome], ["expired", null]);
	assert.equal(await refusal(retryUnresolvedEffects(db, owner, proposal.id)), "review_expired");

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

	const again = await reviseProposal(db, owner, proposal.id, {
		operation: "people.updatePerson",
		revision: 3,
		input: { personId: people.casey, patch: { phone: "555-0100" } },
	});
	await approveProposal(db, owner, proposal.id, witness(again), null);
	const start = queries.length;
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
		assert.equal(await refusal(retryUnresolvedEffects(db, owner, proposal.id)), "review_closed", name);
	}

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
	let stalled: Claim | undefined;
	const outcome = await stalledEffect(async (claim) => {
		stalled = claim;
		for (let passed = false; !passed;) {
			const r = await admin.execute(sql`SELECT lease_until<=clock_timestamp() AS passed FROM job WHERE id=${claim.id}`);
			passed = (r.rows[0] as { passed: boolean }).passed;
		}
		assert.equal(await recoverLease(admin), 0);
	}, 2);
	assert.equal(outcome, "lost");
	assert.equal(await recoverLease(admin), 1);
	assert.deepEqual([await effectAudits(proposal.id), (await person(people.alexRivera)).city], [[], "Chicago"]);
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
	await admin.execute(
		sql.raw(`CREATE FUNCTION f6_retire() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
			UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id='${robin}' AND id::text=NEW.review->'target'->>'id';
			RETURN NULL; END$$`),
	);
	await admin.execute(
		sql.raw(`CREATE TRIGGER f6_retire AFTER INSERT ON proposal FOR EACH ROW EXECUTE FUNCTION f6_retire()`),
	);
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "Change Robin's city to Newtown" });
	try {
		assert.equal(await work({ status: "qualified", id: "test", model }), "succeeded");
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER f6_retire ON proposal; DROP FUNCTION f6_retire()`));
	}
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
	let running: Promise<string> | undefined;
	await admin.transaction(async (tx) => {
		await tx.execute(sql`SELECT id FROM job WHERE id=${claim.id} FOR UPDATE`);
		running = executeProposal(db, lease(claim), noReminders);
		await waitingOnLock(admin, { blockedBy: await backendPid(tx) });
		await tx.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=${claim.id}`);
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
		assert.equal((await readReview(tx as unknown as typeof db, owner, proposal.id)).status, "pending");
		await admin.transaction(async (other) => {
			await other.execute(sql`SET LOCAL lock_timeout = '2s'`);
			await other.execute(sql`UPDATE auth_session SET expires_at=expires_at WHERE id=${accounts.owner.session}`);
		});
	});
});

test("INV-effect-recovery: an approved effect that no worker took within 60 s reads as unconfirmed, not as saving; Try again's job is claimed first and runs it once", async () => {
	const owner = await actor("owner");
	const { proposal } = await propose(owner, "Change Casey's city to Elgin");
	await approveProposal(db, owner, proposal.id, witness(proposal), null);
	const queued = await readReview(db, owner, proposal.id);
	assert.deepEqual([queued.executing, queued.outcome], [true, null]);
	await admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '61 seconds' WHERE kind='evry_effect' AND producer_key LIKE ${proposal.id + ":%"}`,
	);
	const stale = await readReview(db, owner, proposal.id);
	assert.deepEqual([stale.executing, stale.outcome], [false, "unknown"]);
	const start = queries.length;
	assert.equal((await retryUnresolvedEffects(db, owner, proposal.id)).retried, true);
	assert.equal(counted(start), 1);
	assert.deepEqual(await effectJobs(proposal.id), ["superseded", "ready"]);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.equal(await executeProposal(db, lease(claim!), noReminders), "completed");
	const shown = await readReview(db, owner, proposal.id);
	assert.deepEqual([shown.outcome, shown.executing], ["completed", false]);
	assert.equal(await transaction(db, (tx) => finishClaim(tx, claim!, { state: "succeeded" })), true);
	assert.equal(await effects(), null);
	assert.deepEqual([(await effectAudits(proposal.id)).length, (await person(people.casey)).city], [1, "Elgin"]);
});

test("BUG-f52e88212: an effect that ends with an error Evry cannot classify stays unconfirmed instead of 'failed, nothing was changed'; Try again saves it once", async () => {
	const owner = await actor("owner");
	const { proposal } = await propose(owner, "Change Chen's city to Joliet");
	await approveProposal(db, owner, proposal.id, witness(proposal), null);
	await admin.execute(
		sql.raw(`CREATE FUNCTION f6_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic'; END$$`),
	);
	await admin.execute(
		sql.raw(`CREATE TRIGGER f6_fail BEFORE UPDATE ON person FOR EACH ROW EXECUTE FUNCTION f6_fail()`),
	);
	try {
		assert.equal((await effects())?.outcome, "failed");
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER f6_fail ON person; DROP FUNCTION f6_fail()`));
	}
	const after = await readReview(db, owner, proposal.id);
	assert.deepEqual([after.outcome, after.receipt, after.executing], ["unknown", null, false]);
	assert.equal((await retryUnresolvedEffects(db, owner, proposal.id)).retried, true);
	assert.equal((await effects())?.outcome, "completed");
	assert.deepEqual([(await effectAudits(proposal.id)).length, (await person(people.alexChen)).city], [1, "Joliet"]);
});

test("INV-budget: a conversation's page read brings every review card's current review, as readReview reads it, in its one statement", async () => {
	const owner = await actor("owner");
	const names = ["Wren Halloway", "Juno Pike", "Indigo Marsh"];
	const ids: Record<string, string> = {};
	for (const [i, name] of names.entries()) {
		ids[name] = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
			VALUES(${ids[name]},${plant},${plant},${name},'Oldtown','other',clock_timestamp(),'prospect','unknown','unknown',${600 + i},'live')`);
	}
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	for (const name of names) {
		await submitTurn(db, owner, c.id, {
			requestKey: randomUUID(),
			text: `Change ${name.split(" ")[0]}'s city to Newtown`,
		});
		assert.equal(await work(), "succeeded");
	}
	const cards = (page: { events: { kind: string; sequence: number; body: Record<string, unknown> }[] }) =>
		page.events.flatMap((e) =>
			e.kind === "tool_result" && (e.body.result as { proposalId?: string }).proposalId
				? [{ sequence: e.sequence, id: (e.body.result as { proposalId: string }).proposalId }]
				: [],
		);
	const [pending, expired, withheld] = cards(await readConversation(db, owner, c.id));
	assert.ok(pending && expired && withheld, "each turn prepared one review");
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${expired.id}`);
	await admin.execute(
		sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${ids["Indigo Marsh"]}`,
	);
	const { proposal: theirs } = await propose(await actor("foreign"), "Change Quinn's city to Springfield");
	await admin.execute(sql`WITH c AS (
			UPDATE conversation SET last_sequence=last_sequence+1,updated_at=clock_timestamp() WHERE id=${c.id} RETURNING id,last_sequence
		) INSERT INTO conversation_event(conversation_id,sequence,turn_id,kind,body)
		SELECT id,last_sequence,NULL,'tool_result',${JSON.stringify({ operation: "evry.prepareProposal", result: { operation: "evry.prepareProposal", status: "available", rows: [], total: 0, page: 1, next: null, completeness: "complete", exclusions: [], proposalId: theirs.id } })}::jsonb FROM c`);

	const start = queries.length;
	const page = await readConversation(db, owner, c.id);
	assert.equal(counted(start), 1, "the reviews come in the page read's one statement");
	const opened = await openLatestConversation(db, owner);
	assert.equal(opened?.conversation.id, c.id);
	for (const read of [page, opened!]) {
		assert.deepEqual(Object.keys(read.reviews).sort(), [pending.id, expired.id, withheld.id, theirs.id].sort());
		for (const card of [pending, expired, withheld]) {
			const { now, ...shown } = read.reviews[card.id]!;
			const { now: alsoNow, ...current } = await readReview(db, owner, card.id);
			assert.deepEqual(shown, current);
			assert.ok(now <= alsoNow, "now is the database clock when the page was read");
		}
		assert.deepEqual(
			[pending, expired, withheld].map((card) => [
				read.reviews[card.id]!.status,
				read.reviews[card.id]!.review.withheld,
			]),
			[
				["pending", undefined],
				["expired", undefined],
				["pending", true],
			],
		);
		assert.equal(read.reviews[theirs.id], null);
	}
	assert.equal(await refusal(readReview(db, owner, theirs.id)), "not_found");

	const later = await readConversation(db, owner, c.id, pending.sequence);
	assert.deepEqual(Object.keys(later.reviews).sort(), [expired.id, withheld.id, theirs.id].sort());

	const seat = sql`account_id=${accounts.owner.id} AND plant_id IS NOT NULL`;
	await admin.execute(sql`UPDATE seat SET role='member' WHERE ${seat}`);
	try {
		const member = await actor("owner");
		const read = await readConversation(db, member, c.id);
		assert.deepEqual(Object.values(read.reviews), [null, null, null, null]);
		assert.equal(await refusal(readReview(db, member, pending.id)), "not_found");
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE ${seat}`);
	}
});
