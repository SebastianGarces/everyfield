import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { APICallError } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4 } from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { claimDue, recoverLease } from "../../../packages/domain/src/jobs/queue.ts";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	checkProposal,
	executeProposal,
	LIMITS,
	observeConversation,
	readConversation,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
	type MailPort,
} from "../../../packages/evry/src/index.ts";
import { transientRetry, withTransientRetry } from "../../../packages/evry/src/runtime/model.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/index.ts";
import type { Actor } from "../../support/fixture.mts";
import {
	caseWorld,
	proposes,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Reply,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casereview");
});
after(() => w?.close());

const lease = (claim: Reply) => ({
	jobId: claim.id,
	tenantId: claim.tenant_id,
	leaseOwner: claim.lease_owner,
	generation: claim.claim_generation,
});
const PORTS = { reminders: async () => undefined as never, phaseNotices: async () => undefined };
async function review(c: Church, said: string, operation: string, input: object, who: Actor = c.A) {
	const asked = await w.ask(who, said, [proposes(operation, input)]);
	assert.ok(asked.proposals[0], JSON.stringify(asked.replies));
	return asked.proposals[0];
}
const city = (c: Church, said: string, to: string, person = c.casey) =>
	review(c, said, "people.updatePerson", { personId: person, patch: { city: to } });
const cityOf = async (person: string) => (await w.one(sql`SELECT city FROM person WHERE id=${person}`)).city;
const updates = (person: string) =>
	w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${person} AND action='people.updated'`);
const sends = () => w.count(sql`SELECT count(*)::int AS n FROM mail`);

test("AC:EVRY-LEASE-FENCE an executor that stalled before its reply cannot publish once another resumed the action: the saved outcome shows once and nothing repeats", async () => {
	const c = await w.church();
	const said = "A tries to publish after B resumed; B retries the same action";
	const p = await city(c, said, "Austin");
	const before = await updates(c.casey);
	await approveProposal(w.db, c.Aa, p.id, w.witness(p), null);
	const [stalled] = await claimDue(w.db, ["evry_effect"], 1, 60);
	await w.admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${stalled!.id}`);
	assert.equal(await recoverLease(w.admin), 1);
	assert.equal((await readReview(w.db, c.Aa, p.id)).outcome, "unknown");
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, p.id)).retried, true);
	assert.equal(await w.effect(), "completed");
	const saved = await readReview(w.db, c.Aa, p.id);
	assert.deepEqual(
		[saved.outcome, Boolean(saved.receipt?.receiptId), await cityOf(c.casey), await updates(c.casey)],
		["completed", true, "Austin", before + 1],
	);
	const [after, mails] = [await w.rows(sql`SELECT * FROM person WHERE id=${c.casey}`), await sends()];
	assert.equal(await executeProposal(w.db, lease(stalled), PORTS), "lost", "the first executor publishes nothing");
	const again = await retryUnresolvedEffects(w.db, c.Aa, p.id);
	assert.deepEqual(
		[again.retried, again.proposal.receipt?.receiptId],
		[false, saved.receipt?.receiptId],
		"the same saved outcome",
	);
	assert.equal(await w.effect(), null);
	assert.deepEqual(
		[await w.rows(sql`SELECT * FROM person WHERE id=${c.casey}`), await updates(c.casey), await sends()],
		[after, before + 1, mails],
	);
	await c.foreignReview(p);
	await c.foreign(said, [proposes("people.updatePerson", { personId: c.casey, patch: { city: "Austin" } })]);
	await c.effectOutage(await city(c, said, "Dallas"), "person");
	assert.equal(await cityOf(c.casey), "Austin");
});

test("AC:EVRY-RETRY-CANCEL budgets stop exactly, one read and two model retries at most, an unknown send is never repeated, a sent one is never called undone, and watching starts nothing", async () => {
	const c = await w.church();
	const said = "Exercise budget equality, read retry, model retry, cancel and reconnect";
	assert.deepEqual(
		[
			LIMITS.toolCalls,
			LIMITS.inputTokens,
			LIMITS.outputTokens,
			LIMITS.wallMs,
			LIMITS.readRetries,
			LIMITS.modelRetryDelaysMs.length,
		],
		[24, 128_000, 16_000, 180_000, 1, 2],
	);
	const list = reads("people.listPeople", { limit: 2 });
	const full = await w.ask(
		c.A,
		said,
		Array.from({ length: 30 }, () => list),
	);
	assert.deepEqual([full.cards.length, full.status.reason], [24, "tool_budget"], "at 24 no new tool is scheduled");

	w.cut.left = 1;
	const once = await w.ask(c.A, said, [list]);
	assert.deepEqual(
		[w.cut.left, once.cards.length, once.replies[0].error ?? null],
		[0, 1, null],
		"one transient failure is read again",
	);
	w.cut.left = 3;
	const twice = await w.ask(c.A, said, [list]);
	assert.deepEqual(
		[w.cut.left, twice.cards.length, twice.replies[0].error],
		[1, 0, "source_unavailable"],
		"a second is not",
	);
	w.cut.left = 0;

	const flaky = (failures: number) => {
		let left = failures;
		let tries = 0;
		const base = scriptedModel();
		const failing: LanguageModelV4 = {
			...base,
			async doStream(options) {
				tries++;
				if (left-- > 0)
					throw new APICallError({
						message: "overloaded",
						url: "https://provider.example.test",
						requestBodyValues: {},
						statusCode: 529,
						isRetryable: true,
					});
				return base.doStream(options);
			},
		};
		return {
			model: withTransientRetry(
				failing,
				transientRetry(async () => undefined),
			),
			tries: () => tries,
		};
	};
	const two = flaky(2);
	assert.equal((await w.ask(c.A, "hello", [], { model: two.model })).status.state, "completed");
	assert.equal(two.tries(), 3);
	const three = flaky(9);
	assert.deepEqual(
		[(await w.ask(c.A, "hello", [], { model: three.model })).status.error.code, three.tries()],
		["model_unavailable", 3],
	);

	const email = provider("unknown");
	const invitation = await invite(c);
	const sentOnce = await w.approve(c.A, invitation.card, email.port);
	assert.deepEqual([sentOnce.outcome, email.sent.length], ["completed", 1]);
	assert.equal(sentOnce.review.receipt?.report?.confirmation, "not_confirmed");
	const held = await footprint(c);
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, invitation.card.id)).retried, false);
	assert.deepEqual(
		[await w.effect(email.port), email.sent.length, await footprint(c)],
		[null, 1, held],
		"an unknown send is not repeated",
	);
	const undone = await cancelProposal(w.db, c.Aa, invitation.card.id);
	assert.deepEqual(
		[undone.cancelled, undone.proposal.outcome, undone.proposal.receipt],
		[false, "completed", sentOnce.review.receipt],
		"a sent message is never called undone",
	);

	const conversation = await w.converse(c.Aa);
	await submitTurn(w.db, c.Aa, conversation, { requestKey: randomUUID(), text: said });
	const jobs = () => w.rows(sql`SELECT id,state,attempt_count FROM job WHERE subject_record_id=${conversation}`);
	const queued = await jobs();
	for await (const _ of observeConversation(w.db, c.Aa, conversation, 0, AbortSignal.timeout(300), 50)) void _;
	await readConversation(w.db, c.Aa, conversation);
	assert.deepEqual(await jobs(), queued, "a GET starts no executor");
	assert.equal((await cancelTurn(w.db, c.Aa, conversation)).cancelled, true);
	let called = 0;
	const none = await w.work([() => (called++, "Done.")]);
	assert.deepEqual([none.outcome, called], [null, 0], "a cancelled turn starts nothing");

	await c.foreign(said, [list]);
	await c.outage(said, [list], "person");
});

function provider(answer: "ids" | "unknown") {
	const sent: string[][] = [];
	const port: MailPort = {
		keys: {
			encryptionKey: Buffer.alloc(32, 7),
			addressKey: Buffer.alloc(32, 9),
			from: "church@example.test",
			origin: "https://app.example.test",
		},
		transport: {
			paused: false,
			async send(batch) {
				sent.push(batch.messages.map((m) => m.to));
				return answer === "unknown"
					? { outcome: "unknown" }
					: { outcome: "ids", ids: batch.messages.map(() => "re_" + randomUUID()) };
			},
			cancel: async (ids) => ids.map(() => ({ outcome: "unknown" as const })),
			reschedule: async (ids) => ids.map(() => ({ outcome: "unknown" as const })),
		},
	};
	return { port, sent };
}
async function invite(c: Church) {
	await w.admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id=${c.P.id}`,
	);
	await w.admin.execute(sql`UPDATE person SET email='casey@example.test' WHERE id=${c.casey}`);
	const venue = randomUUID();
	await w.admin.execute(sql`INSERT INTO venue(id,plant_id,name,address) VALUES(${venue},${c.P.id},'Hall','1 Main St')`);
	const card = await review(c, "Invite Casey", "evry.prepareMeetingInvitation", {
		meeting: { type: "vision_meeting", date: "2026-10-27", time: "19:00", venueId: venue },
		audience: { personIds: [c.casey] },
	});
	return { card };
}
const footprint = (c: Church) =>
	w.one(sql`SELECT (SELECT count(*)::int FROM meeting WHERE plant_id=${c.P.id}) AS meetings,
		(SELECT count(*)::int FROM participation WHERE plant_id=${c.P.id}) AS guests,(SELECT count(*)::int FROM communication WHERE plant_id=${c.P.id}) AS messages,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${c.P.id}) AS mail`);

test("AC:INH-EDGES-12 retrying a confirmation after a disconnect observes the saved effects: no new meeting, guest or send, and the unknown send is checked, not repeated", async () => {
	const c = await w.church();
	const said = "Retry the confirmation after my laptop disconnected.";
	const email = provider("unknown");
	const { card } = await invite(c);
	await w.approve(c.A, card, email.port);
	const held = await footprint(c);
	assert.deepEqual([held.meetings, held.guests, email.sent.length], [1, 1, 1]);
	for (let n = 0; n < 2; n++) {
		const again = await approveProposal(w.db, await w.actorOf(c.A), card.id, w.witness(card), null);
		assert.deepEqual([again.replayed, again.proposal.outcome], [true, "completed"]);
		assert.equal((await retryUnresolvedEffects(w.db, c.Aa, card.id)).retried, false);
		const { reviews } = await w.eventsOf(
			c.Aa,
			(await w.one<{ id: string }>(sql`SELECT conversation_id AS id FROM proposal WHERE id=${card.id}`)).id,
		);
		assert.equal(
			reviews[card.id]?.receipt?.report?.confirmation,
			"not_confirmed",
			"the reopened page shows it as not confirmed",
		);
		assert.equal(await w.effect(email.port), null);
	}
	assert.deepEqual([await footprint(c), email.sent.length], [held, 1], "nothing new");
	const found = provider("ids");
	const checked = await checkProposal(w.db, c.Aa, card.id, found.port);
	assert.deepEqual(
		{ ...(await footprint(c)), mail: 0 },
		{ ...held, mail: 0 },
		"checking adds no meeting, guest or message",
	);
	assert.equal(checked.proposal.outcome, "completed");
	const status = await w.ask(c.A, said, [() => ({ tool: "read_review", input: { proposalId: card.id } })], {
		conversation: (await w.one<{ id: string }>(sql`SELECT conversation_id AS id FROM proposal WHERE id=${card.id}`)).id,
	});
	assert.equal(rowsOf(status.replies[0])[0].fields.status, "approved");
	await c.foreignReview(card);
	await c.foreign(said, [reads("meetings.list", {})], { secrets: ["Vision Meeting 1"] });
	await c.effectOutage(await city(c, said, "Dallas"), "person");
	assert.deepEqual(await footprint(c), await footprint(c));
});

test("AC:INH-REGRESSION-RETRY a retry runs only the unresolved effect under its valid approval: completed work, an unknown send and a stale approval are not repeated", async () => {
	const c = await w.church();
	const said = "Retry the failed request.";
	const done = await city(c, said, "Austin");
	await w.approve(c.A, done);
	const count = await updates(c.casey);
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, done.id)).retried, false);
	assert.deepEqual([await w.effect(), await updates(c.casey)], [null, count], "effect-1 is not replayed");

	const second = await city(c, said, "Naperville", c.rivera);
	const before = await updates(c.rivera);
	await c.effectOutage(second, "person");
	const retried = await retryUnresolvedEffects(w.db, c.Aa, second.id);
	assert.deepEqual(
		[retried.retried, retried.proposal.digest, retried.proposal.revision],
		[true, second.digest, second.revision],
		"the same unchanged approval",
	);
	assert.equal(await w.effect(), "completed");
	assert.deepEqual([await cityOf(c.rivera), await updates(c.rivera)], ["Naperville", before + 1]);
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key LIKE ${`evry:${second.id}:${second.revision}%`} AND action='people.updated'`,
		),
		1,
		"under effect-2's own key",
	);

	const email = provider("unknown");
	const { card } = await invite(c);
	await w.approve(c.A, card, email.port);
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, card.id)).retried, false);
	assert.deepEqual([await w.effect(email.port), email.sent.length], [null, 1], "effect-3 is not sent again");

	const stale = await city(c, said, "Elgin", c.chen);
	await approveProposal(w.db, c.Aa, stale.id, w.witness(stale), null);
	await w.admin.execute(sql`UPDATE person SET revision=revision+1 WHERE id=${c.chen}`);
	await w.effect();
	const old = await readReview(w.db, c.Aa, stale.id);
	assert.notEqual(old.outcome, "completed");
	assert.equal(await cityOf(c.chen), "Evanston");
	if (old.status === "pending") assert.notEqual(old.digest, stale.digest, "the new state needs a new approval");
	else assert.equal(await refusal(retryUnresolvedEffects(w.db, c.Aa, stale.id)), "review_closed");
	const late = await city(c, said, "Joliet", c.chen);
	await approveProposal(w.db, c.Aa, late.id, w.witness(late), null);
	await w.admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${late.id}`);
	await w.effect();
	assert.equal(await refusal(retryUnresolvedEffects(w.db, c.Aa, late.id)), "review_expired");
	await c.foreignReview(second);
	await c.foreign(said, [reads("launch.readCountdown", {})], { found: ["Launch Sunday"] });
});

test("AC:INH-REGRESSION-REVOKED-SEAT a seat that ends between two approved steps keeps the first receipt and refuses the second, with nothing written or sent", async () => {
	const c = await w.church();
	const said = "Finish the changes I approved.";
	const one = await city(c, said, "Austin");
	const two = await city(c, said, "Naperville", c.rivera);
	const first = await w.approve(c.A, one);
	assert.equal(first.review.outcome, "completed");
	await approveProposal(w.db, c.Aa, two.id, w.witness(two), null);
	const mails = await sends();
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.A.id}`);
	assert.equal(await w.effect(), "refused");
	await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${c.A.id}`);
	const [kept, denied] = [await readReview(w.db, c.Aa, one.id), await readReview(w.db, c.Aa, two.id)];
	assert.deepEqual([kept.outcome, kept.receipt], ["completed", first.review.receipt]);
	assert.deepEqual([denied.outcome, denied.receipt?.code], ["refused", "access_denied"]);
	assert.deepEqual([await cityOf(c.casey), await cityOf(c.rivera), await sends()], ["Austin", "Chicago", mails]);
	assert.equal(await refusal(retryUnresolvedEffects(w.db, c.Aa, two.id)), "review_closed");
	await c.foreignReview(two);
	await c.foreign(said, [proposes("people.updatePerson", { personId: c.rivera, patch: { city: "Naperville" } })]);
	await c.effectOutage(await city(c, said, "Dallas"), "person");
	assert.equal(await cityOf(c.casey), "Austin");
});

test("AC:UI45-003 an edited review gets a new digest, the old approval is refused, and only the approved fields of the second revision save", async () => {
	const c = await w.church();
	const said = "Edit card, validate, attempt old approval then new exact approval";
	const audience = { groups: ["core_group"], teamIds: [], personIds: [] };
	const draft = (subject: string) => ({ subject, body: "Hi {{name}}", audience });
	const p = await review(c, said, "communication.saveDraft", draft("Old"));
	const old = w.witness(p);
	const subjects = () => w.rows(sql`SELECT subject FROM communication WHERE plant_id=${c.P.id}`);
	assert.equal(
		await refusal(
			reviseProposal(w.db, c.Aa, p.id, { operation: "communication.saveDraft", revision: 1, input: draft("") }),
		),
		"invalid_input",
		"the form's own validation",
	);
	const edited = await reviseProposal(w.db, c.Aa, p.id, {
		operation: "communication.saveDraft",
		revision: 1,
		input: draft("New"),
	});
	assert.deepEqual([edited.revision, edited.status, edited.digest === p.digest], [2, "pending", false]);
	assert.equal(edited.review.changes.find((x) => x.field === "subject")!.after, "New");
	assert.equal(await refusal(approveProposal(w.db, c.Aa, p.id, old, null)), "review_changed");
	assert.equal(
		await refusal(approveProposal(w.db, c.Aa, p.id, { revision: 2, digest: old.digest }, null)),
		"review_changed",
	);
	assert.deepEqual([await w.effect(), await subjects()], [null, []]);
	assert.equal((await w.approve(c.A, edited)).review.outcome, "completed");
	assert.deepEqual(await subjects(), [{ subject: "New" }]);
	await c.foreignReview(edited);
	await c.foreign(said, [reads("communication.list", {})], { secrets: ['"New"'] });
	await c.effectOutage(await review(c, said, "communication.saveDraft", draft("Third")), "communication");
	assert.deepEqual(await subjects(), [{ subject: "New" }]);
});

test("AC:UI45-004 an unapproved, cancelled, expired, revoked, foreign or stale review has no effect, and one fresh approval runs once", async () => {
	const c = await w.church();
	const said = "Press trusted confirm/execute on each invalid witness";
	const held = async () => [await cityOf(c.casey), await updates(c.casey), await sends()];
	const before = await held();
	const effects: number[] = [];
	const none = async (attempt: () => Promise<unknown>) => {
		await attempt();
		await w.effect();
		assert.deepEqual(await held(), before);
		effects.push(0);
	};
	const card = () => city(c, said, "Austin");
	const unapproved = await card();
	await none(async () =>
		assert.equal(await refusal(retryUnresolvedEffects(w.db, c.Aa, unapproved.id)), "review_closed"),
	);
	const cancelled = await card();
	await none(async () => {
		await cancelProposal(w.db, c.Aa, cancelled.id);
		assert.equal(await refusal(approveProposal(w.db, c.Aa, cancelled.id, w.witness(cancelled), null)), "review_closed");
	});
	const expired = await card();
	await none(async () => {
		await w.admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp() WHERE id=${expired.id}`);
		assert.equal(await refusal(approveProposal(w.db, c.Aa, expired.id, w.witness(expired), null)), "review_expired");
	});
	const revoked = await card();
	await none(async () => {
		await approveProposal(w.db, c.Aa, revoked.id, w.witness(revoked), null);
		await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.A.id}`);
		assert.equal(await w.effect(), "refused");
		await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${c.A.id}`);
	});
	const foreign = await card();
	await none(() => c.foreignReview(foreign));
	const stale = await card();
	await none(async () => {
		await approveProposal(w.db, c.Aa, stale.id, w.witness(stale), null);
		await w.admin.execute(sql`UPDATE person SET revision=revision+1 WHERE id=${c.casey}`);
	});
	assert.deepEqual(effects, [0, 0, 0, 0, 0, 0]);
	const fresh = await card();
	const ran = await w.approve(c.A, fresh);
	assert.equal(ran.review.outcome, "completed");
	assert.equal((await approveProposal(w.db, c.Aa, fresh.id, w.witness(fresh), null)).replayed, true);
	assert.equal(await w.effect(), null);
	assert.deepEqual(await held(), ["Austin", Number(before[1]) + 1, before[2]], "once");
	await c.foreign(said, [proposes("people.updatePerson", { personId: c.casey, patch: { city: "Austin" } })]);
	await c.effectOutage(await city(c, said, "Dallas"), "person");
	assert.equal(await cityOf(c.casey), "Austin");
});
