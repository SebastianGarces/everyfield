import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import {
	approveProposal,
	checkProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readCatalog,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	submitTurn,
	type EvryActor,
	type MailPort,
	type Proposal,
} from "../../../../../packages/evry/src/index.ts";
import { listMessages } from "../../../../../packages/evry/src/adapters/communication/reads/index.ts";
import { transaction } from "../../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../../apps/web/src/server/jobs/queue.ts";
import {
	accounts,
	actor,
	admin,
	db,
	people,
	plant,
	queries,
	role,
	setup,
	sql,
	teardown,
} from "../../../runtime/support.mts";

// MAIL51-009 (WP-028 slice 2): Evry saves a draft and reviews a schedule, time change, cancel and replacement before any
// of it runs. The email service is a recording fake; the database is real. Every effect goes through the real queue.

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const addressKey = Buffer.alloc(32, 9);
const hashOf = (address: string) => createHmac("sha256", addressKey).update(address).digest("hex");

type Answer = "done" | "sent" | "unknown";
/** A fake email service. `openTransactions` is how many transactions the runtime login held open while it was called. */
function emailService() {
	const calls = {
		send: [] as {
			key: string;
			to: string[];
			subject: string;
			text: string[];
			scheduledAt: string | null;
			openTransactions: number;
		}[],
		cancel: [] as string[][],
		reschedule: [] as { ids: string[]; at: string }[],
	};
	const answers = { cancel: "done" as Answer | ((id: string, n: number) => Answer), reschedule: "done" as Answer };
	const open = async () =>
		Number(
			(
				await admin.execute(
					sql`SELECT count(*)::int n FROM pg_stat_activity WHERE usename=${role} AND state LIKE 'idle in transaction%'`,
				)
			).rows[0]!.n,
		);
	const port: MailPort = {
		keys: {
			encryptionKey: Buffer.alloc(32, 7),
			addressKey,
			from: "church@resend.dev",
			origin: "https://app.example.test",
		},
		transport: {
			async send(batch) {
				calls.send.push({
					key: batch.key,
					to: batch.messages.map((m) => m.to),
					subject: batch.messages[0]!.subject,
					text: batch.messages.map((m) => m.text),
					scheduledAt: batch.scheduledAt,
					openTransactions: await open(),
				});
				return { outcome: "ids", ids: batch.messages.map(() => "re_" + randomUUID()) };
			},
			async lookup() {
				return { outcome: "unknown" };
			},
			async cancel(ids) {
				calls.cancel.push([...ids]);
				const a = answers.cancel;
				return ids.map((id, n) => ({ outcome: typeof a === "function" ? a(id, n) : a }));
			},
			async reschedule(ids, at) {
				calls.reschedule.push({ ids: [...ids], at });
				return ids.map(() => ({ outcome: answers.reschedule }));
			},
		},
	};
	return { port, calls, answers };
}

before(async () => {
	await setup();
	const emails: [string, string][] = [
		[people.alexRivera!, "alex.rivera@example.test"],
		[people.alexChen!, "alex.chen@example.test"],
		[people.casey!, "casey.reed@example.test"],
	];
	for (const [id, email] of emails) await admin.execute(sql`UPDATE person SET email=${email} WHERE id=${id}`);
	// Casey's address bounced and is blocked.
	const event = randomUUID();
	await admin.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${event},${"seed-" + event},${"seed-" + event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${hashOf("casey.reed@example.test")},'hard_bounce',${event},clock_timestamp())`);
	// Dana turned off every update email on her account.
	people.dana = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,linked_account_id)
		VALUES(${people.dana},${plant},${plant},'Dana Off','dana.off@example.test','other',clock_timestamp(),'prospect','unknown','unknown',9,'live',${accounts.member.id})`);
	const { notificationCategory } = await import("../../../../../packages/contracts/src/settings/values.ts");
	for (const category of notificationCategory.options.filter((name: string) => name !== "wiki_upstream_review"))
		await admin.execute(sql`INSERT INTO notification_preference(id,account_id,category,channel,enabled,unsubscribe_revision)
			VALUES(${randomUUID()},${accounts.member.id},${category},'email',false,1)`);
	const [none] = (await admin.execute(sql`SELECT id FROM person WHERE plant_id=${plant} AND display_name='Member 001'`))
		.rows as { id: string }[];
	people.noAddress = none!.id;
});
after(teardown);

const counted = (start: number) =>
	queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;

async function turn(who: EvryActor, mail: MailPort | null) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return {
		async propose(operation: string, input: unknown) {
			return prepareProposal(db, who, run, c.id, { operation, input }, mail);
		},
	};
}
async function runNext(mail: MailPort | null) {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
		mail,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}
/** The trusted approval of the exact revision shown, then the effect run once through the queue. */
async function approve(who: EvryActor, proposal: Proposal, mail: MailPort | null) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const outcome = await runNext(mail);
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const change = (proposal: Proposal, field: string) => proposal.review.changes.find((c) => c.field === field);
const rows = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows as Record<string, any>[];
/** A future local send time in the church's zone: `days` from now at `hhmm`. */
function localAt(days: number, hhmm = "09:00") {
	const d = new Date(Date.now() + days * 86_400_000);
	return `${d.toISOString().slice(0, 10)}T${hhmm}`;
}
const audience = (extra: string[] = []) => ({
	groups: [],
	teamIds: [],
	personIds: [people.alexRivera!, people.alexChen!, people.casey!, people.noAddress!, people.dana!, ...extra],
});
const SUBJECT = "Sunday's interest meeting";
const BODY = "Hi {{name}},\n\nCome to Sunday's interest meeting at 4 pm.";

/** Saves a draft through a review and returns its id and revision. */
async function savedDraft(who: EvryActor, mail: MailPort, subject = SUBJECT, body = BODY) {
	const t = await turn(who, mail);
	const proposal = await t.propose("communication.saveDraft", { subject, body, audience: audience() });
	assert.ok(proposal);
	const done = await approve(who, proposal, mail);
	assert.equal(done.outcome, "completed");
	return { id: done.review.receipt!.receiptId!, revision: done.review.receipt!.revision! };
}
/** A message scheduled through its reviews and handed to the email service. */
async function scheduledMessage(
	who: EvryActor,
	service: ReturnType<typeof emailService>,
	subject = SUBJECT,
	sendAt = localAt(3),
) {
	const draft = await savedDraft(who, service.port, subject);
	const t = await turn(who, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt });
	assert.ok(proposal);
	const done = await approve(who, proposal, service.port);
	assert.equal(done.outcome, "completed");
	return { id: draft.id, review: done.review };
}

test("AC:WP-028-1 a draft review shows the subject, audience, recipient count and body, and saves nothing", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const t = await turn(owner, service.port);
	const before = (await rows(sql`SELECT count(*)::int n FROM communication WHERE plant_id=${plant}`))[0]!.n;
	const start = queries.length;
	const proposal = await t.propose("communication.saveDraft", { subject: SUBJECT, body: BODY, audience: audience() });
	assert.ok(proposal);
	assert.equal(proposal.operation, "communication.saveDraft");
	assert.equal(change(proposal, "subject")!.after, SUBJECT);
	const shown = change(proposal, "audience")!.after as { recipients: number; noAddress: number; personIds: string[] };
	assert.equal(shown.recipients, 4, "four of the five people have an address");
	assert.equal(shown.noAddress, 1);
	assert.match(String(change(proposal, "body")!.after), /Come to Sunday's interest meeting at 4 pm\./);
	assert.equal(proposal.status, "pending");
	assert.equal((await rows(sql`SELECT count(*)::int n FROM communication WHERE plant_id=${plant}`))[0]!.n, before);
	assert.equal(counted(start), 1, "one statement to prepare a draft review");
});

test("AC:WP-028-2 approving a draft saves it in Messages drafts with no mail and no email service call", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.saveDraft", {
		subject: "Draft only",
		body: "Hello team.",
		audience: audience(),
	});
	assert.ok(proposal);
	const done = await approve(owner, proposal, service.port);
	assert.equal(done.outcome, "completed");
	assert.equal(done.review.outcome, "completed");
	const [draft] = await rows(
		sql`SELECT subject,state,body_text,audience FROM communication WHERE id=${done.review.receipt!.receiptId!}`,
	);
	assert.equal(draft!.subject, "Draft only");
	assert.equal(draft!.state, "draft");
	assert.match(draft!.body_text, /Hello team\./);
	assert.deepEqual(draft!.audience.personIds, audience().personIds);
	const found = await db.transaction((tx) => listMessages.invoke(tx, owner, { state: "draft", subject: "Draft only" }));
	assert.equal(found.rows[0]!.id, done.review.receipt!.receiptId);
	assert.deepEqual(
		(
			await rows(
				sql`SELECT (SELECT count(*)::int FROM mail WHERE tenant_id=${plant}) m,(SELECT count(*)::int FROM mail_attempt WHERE tenant_id=${plant}) a`,
			)
		)[0],
		{ m: 0, a: 0 },
	);
	assert.equal(service.calls.send.length + service.calls.cancel.length + service.calls.reschedule.length, 0);
});

test("AC:WP-028-3 a schedule review names who gets it, who is left out and why, and refuses a time outside the window", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Schedule review");
	const t = await turn(owner, service.port);
	const sendAt = localAt(4);
	const start = queries.length;
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt });
	assert.ok(proposal);
	assert.ok(counted(start) <= 4, "the audience read, the blocked-address read and the review statement");
	assert.equal(change(proposal, "subject")!.after, "Schedule review");
	assert.deepEqual(change(proposal, "recipients")!.after, [{ name: "Alex Chen" }, { name: "Alex Rivera" }]);
	assert.deepEqual(change(proposal, "leftOut")!.after, [
		{ name: "Casey Reed", reason: "blocked" },
		{ name: "Dana Off", reason: "updates_off" },
		{ name: "Member 001", reason: "no_address" },
	]);
	assert.match(String(change(proposal, "content")!.after), /Come to Sunday's interest meeting at 4 pm\./);
	const [expected] = await rows(
		sql`SELECT to_char((${sendAt}::timestamp AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`,
	);
	assert.deepEqual(change(proposal, "sendAt")!.after, { at: expected!.at, zone: "America/Chicago" });
	assert.equal(proposal.review.refusal, undefined);
	const past = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(-2) });
	assert.match(past!.review.refusal!, /already passed/);
	const far = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(45) });
	assert.match(far!.review.refusal!, /at most 30 days/);
	await assert.rejects(
		approveProposal(db, owner, far!.id, { revision: far!.revision, digest: far!.digest }, null),
		{ code: "review_closed" },
		"a refused review cannot be approved",
	);
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${draft.id}`))[0]!.state, "draft");
});

test("AC:WP-028-4 a schedule that is not approved, or whose approval lapsed, runs nothing and calls no email service", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Not approved");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) });
	assert.ok(proposal);
	// Not approved: no effect job exists, so nothing can run it.
	assert.equal(await runNext(service.port), null);
	// Approved, then the approval lapses before the effect starts.
	await approveProposal(db, owner, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	await admin.execute(
		sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${proposal.id}`,
	);
	assert.equal(await runNext(service.port), "expired");
	const [row] = await rows(sql`SELECT state,revision::text,scheduled_at FROM communication WHERE id=${draft.id}`);
	assert.deepEqual({ state: row!.state, scheduled: row!.scheduled_at }, { state: "draft", scheduled: null });
	assert.equal(row!.revision, draft.revision, "the draft is unchanged");
	assert.equal(service.calls.send.length, 0);
	assert.equal((await readReview(db, owner, proposal.id)).status, "expired");
});

test("AC:WP-028-5 approving a schedule makes one schedule request and reports counts without saying delivered", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const sendAt = localAt(3);
	const { id, review } = await scheduledMessage(owner, service, "Scheduled once", sendAt);
	assert.equal(service.calls.send.length, 1);
	const call = service.calls.send[0]!;
	assert.deepEqual([...call.to].sort(), ["alex.chen@example.test", "alex.rivera@example.test"]);
	assert.equal(call.subject, "Scheduled once");
	assert.equal(call.openTransactions, 0, "the email service is called outside any open transaction");
	assert.match(call.text.join("\n"), /Hi Alex (Chen|Rivera),/);
	const [expected] = await rows(
		sql`SELECT to_char((${sendAt}::timestamp AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`,
	);
	assert.equal(call.scheduledAt, expected!.at);
	assert.deepEqual(
		{ ...review.receipt!.report, scheduledAt: undefined },
		{ kind: "schedule", confirmation: "confirmed", accepted: 2, refused: 2, unknown: 0, scheduledAt: undefined },
	);
	assert.equal(review.receipt!.report!.scheduledAt, expected!.at);
	assert.doesNotMatch(JSON.stringify(review.receipt), /delivered/i);
	const [message] = await rows(sql`SELECT state FROM communication WHERE id=${id}`);
	assert.equal(message!.state, "scheduled");
	const states = await rows(
		sql`SELECT m.state,count(*)::int n FROM mail m WHERE m.logical_key LIKE ${"communication/" + id + "/%"} GROUP BY 1`,
	);
	assert.deepEqual(states, [
		{ state: "accepted", n: 2 },
		{ state: "refused", n: 2 },
	]);
	const found = await db.transaction((tx) =>
		listMessages.invoke(tx, owner, { state: "scheduled", subject: "Scheduled once" }),
	);
	assert.equal(found.rows[0]!.fields.handedOff, true);
});

test("AC:WP-028-6 a time change shows old and new time and says Saturday only after the email service confirms", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Move me", localAt(3));
	const t = await turn(owner, service.port);
	const later = localAt(4, "09:00");
	const proposal = await t.propose("communication.rescheduleReviewed", { communicationId: id, sendAt: later });
	assert.ok(proposal);
	const time = change(proposal, "sendAt")!;
	assert.notDeepEqual(time.before, time.after);
	assert.equal((time.before as { zone: string }).zone, "America/Chicago");
	assert.equal(change(proposal, "recipientCount")!.after, 2);
	assert.equal(service.calls.reschedule.length, 0, "nothing reaches the email service before approval");
	service.answers.reschedule = "unknown";
	const first = await approve(owner, proposal, service.port);
	assert.equal(first.review.receipt!.report!.confirmation, "not_confirmed");
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND scheduled_at=${(time.after as { at: string }).at}`,
			)
		)[0]!.n,
		0,
		"no recipient holds the new time yet",
	);
	service.answers.reschedule = "done";
	const checked = await checkProposal(db, owner, proposal.id, service.port);
	assert.equal(checked.proposal.receipt!.report!.confirmation, "confirmed");
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND scheduled_at=${(time.after as { at: string }).at}`,
			)
		)[0]!.n,
		2,
	);
	assert.equal(
		new Date((await rows(sql`SELECT scheduled_at FROM communication WHERE id=${id}`))[0]!.scheduled_at).toISOString(),
		(time.after as { at: string }).at,
	);
	// A confirmed time change is not checked again.
	const again = await checkProposal(db, owner, proposal.id, service.port);
	assert.equal(again.checked, false);
});

test("AC:WP-028-7 a cancel review shows subject, time and count; Cancelled needs the email service's confirmation", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Cancel me");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.cancelScheduledReviewed", { communicationId: id });
	assert.ok(proposal);
	assert.equal(change(proposal, "subject")!.after, "Cancel me");
	assert.equal(change(proposal, "recipientCount")!.after, 2);
	assert.ok(change(proposal, "sendAt")!.before);
	service.answers.cancel = "unknown";
	const first = await approve(owner, proposal, service.port);
	assert.deepEqual(
		{ confirmation: first.review.receipt!.report!.confirmation, open: first.review.receipt!.report!.open },
		{ confirmation: "not_confirmed", open: 2 },
	);
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND state='cancelled'`,
			)
		)[0]!.n,
		0,
	);
	service.answers.cancel = "done";
	const checked = await checkProposal(db, owner, proposal.id, service.port);
	assert.equal(checked.proposal.receipt!.report!.confirmation, "confirmed");
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND state='cancelled'`,
			)
		)[0]!.n,
		2,
	);
});

test("AC:WP-028-8 a replacement is scheduled only when every original send is confirmed cancelled", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const ok = await scheduledMessage(owner, service, "Replace me");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.replaceScheduledReviewed", {
		communicationId: ok.id,
		body: "New plan: we meet at 5 pm.",
		audience: { groups: [], teamIds: [], personIds: [people.alexRivera!] },
	});
	assert.ok(proposal);
	assert.match(String(change(proposal, "body")!.before), /4 pm/);
	assert.match(String(change(proposal, "body")!.after), /5 pm/);
	assert.equal((change(proposal, "audience")!.before as { recipients: number }).recipients, 4);
	assert.equal((change(proposal, "audience")!.after as { recipients: number }).recipients, 1);
	const sends = service.calls.send.length;
	const done = await approve(owner, proposal, service.port);
	const report = done.review.receipt!.report!;
	assert.equal(report.replaced, true);
	assert.equal(service.calls.send.length, sends + 1, "one new schedule request");
	assert.deepEqual(service.calls.send.at(-1)!.to, ["alex.rivera@example.test"]);
	assert.match(service.calls.send.at(-1)!.text[0]!, /5 pm/);
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + ok.id + "/%"} AND state='cancelled'`,
			)
		)[0]!.n,
		2,
	);

	// One cancel unknown: nothing is scheduled and the affected recipient is named.
	const partial = await scheduledMessage(owner, service, "Replace partial");
	service.answers.cancel = (_id, n) => (n === 0 ? "unknown" : "done");
	const sendsBefore = service.calls.send.length;
	const blocked = await turn(owner, service.port);
	const p2 = await blocked.propose("communication.replaceScheduledReviewed", {
		communicationId: partial.id,
		body: "Different text.",
	});
	const r2 = await approve(owner, p2!, service.port);
	assert.equal(r2.review.receipt!.report!.replaced, false);
	assert.equal(r2.review.receipt!.report!.confirmation, "not_confirmed");
	assert.deepEqual(
		(r2.review.receipt!.report!.people as { outcome: string }[]).map((p) => p.outcome),
		["Cancel not confirmed"],
	);
	assert.equal(service.calls.send.length, sendsBefore, "no replacement was scheduled");

	// One recipient's email already went out: also no replacement.
	service.answers.cancel = (_id, n) => (n === 0 ? "sent" : "done");
	const sentMessage = await scheduledMessage(owner, service, "Replace sent");
	const sendsAfter = service.calls.send.length;
	const t3 = await turn(owner, service.port);
	const p3 = await t3.propose("communication.replaceScheduledReviewed", {
		communicationId: sentMessage.id,
		body: "Late change.",
	});
	const r3 = await approve(owner, p3!, service.port);
	assert.equal(r3.review.receipt!.report!.replaced, false);
	assert.deepEqual(
		(r3.review.receipt!.report!.people as { outcome: string }[]).map((p) => p.outcome),
		["Already sent"],
	);
	assert.equal(service.calls.send.length, sendsAfter);
});

test("AC:WP-028-9 a message that changed after the review refuses the approval and calls no email service", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Changed after review");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) });
	assert.ok(proposal);
	// The message is edited in Messages before the approval: the approval is refused and nothing is queued.
	await admin.execute(
		sql`UPDATE communication SET subject='Edited elsewhere',revision=revision+1 WHERE id=${draft.id}`,
	);
	assert.equal((await readReview(db, owner, proposal.id)).stale, true);
	await assert.rejects(
		approveProposal(db, owner, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null),
		{ code: "review_changed" },
	);
	assert.equal(await runNext(service.port), null, "no effect was queued");
	assert.equal(service.calls.send.length, 0);
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${draft.id}`))[0]!.state, "draft");
	// Reviewing again reads the message as it is now and can be approved.
	const again = await reviseProposal(
		db,
		owner,
		proposal.id,
		{
			operation: "communication.scheduleReviewed",
			revision: proposal.revision,
			input: { communicationId: draft.id, sendAt: localAt(3) },
		},
		service.port,
	);
	assert.equal(again.stale, false);
	assert.equal(change(again, "subject")!.after, "Edited elsewhere");
	// A change that lands after the approval, while the effect waits, is refused by the effect itself.
	await approveProposal(db, owner, again.id, { revision: again.revision, digest: again.digest }, null);
	await admin.execute(sql`UPDATE communication SET subject='Edited again',revision=revision+1 WHERE id=${draft.id}`);
	assert.equal(await runNext(service.port), "refused");
	const done = { review: await readReview(db, owner, again.id) };
	assert.equal(done.review.outcome, "refused");
	assert.equal(done.review.receipt!.code, "revision_conflict");
	assert.equal(service.calls.send.length, 0);
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${draft.id}`))[0]!.state, "draft");
	// A scheduled message that was cancelled elsewhere refuses a time change the same way.
	const moved = await scheduledMessage(owner, service, "Moved elsewhere");
	const t2 = await turn(owner, service.port);
	const p2 = await t2.propose("communication.rescheduleReviewed", { communicationId: moved.id, sendAt: localAt(5) });
	await admin.execute(
		sql`UPDATE communication SET scheduled_at=scheduled_at+interval '1 hour',revision=revision+1 WHERE id=${moved.id}`,
	);
	const calls = service.calls.reschedule.length;
	await assert.rejects(approveProposal(db, owner, p2!.id, { revision: p2!.revision, digest: p2!.digest }, null), {
		code: "review_changed",
	});
	assert.equal(await runNext(service.port), null);
	assert.equal(service.calls.reschedule.length, calls);
});

test("AC:WP-028-10 Evry finds messages by subject and send time; a member reads but cannot write; no write sends unreviewed", async () => {
	const owner = await actor("owner");
	const member = await actor("member");
	const service = emailService();
	const friday = localAt(2, "09:00");
	await scheduledMessage(owner, service, "Friday volunteer reminder", friday);
	await scheduledMessage(owner, service, "Saturday cookout", localAt(3, "12:00"));
	const byDate = await db.transaction((tx) => listMessages.invoke(tx, owner, { sendOn: friday.slice(0, 10) }));
	assert.deepEqual(
		byDate.rows.map((r) => r.label),
		["Friday volunteer reminder"],
	);
	assert.equal(byDate.rows[0]!.fields.zone, "America/Chicago");
	const bySubject = await db.transaction((tx) =>
		listMessages.invoke(tx, owner, { subject: "cookout", state: "scheduled" }),
	);
	assert.deepEqual(
		bySubject.rows.map((r) => r.label),
		["Saturday cookout"],
	);
	assert.doesNotMatch(JSON.stringify(byDate), /example\.test|Come to Sunday/, "no address or body reaches the model");
	const memberReads = await db.transaction((tx) => listMessages.invoke(tx, member, {}));
	assert.ok(memberReads.rows.length >= 2, "a member reads drafts and scheduled messages");
	const writes = (who: EvryActor) =>
		readCatalog(who)
			.reviewedWrites.map((w) => w.operation)
			.filter((op) => op.startsWith("communication."));
	assert.deepEqual(writes(member), []);
	assert.deepEqual(writes(owner).sort(), [
		"communication.cancelScheduledReviewed",
		"communication.replaceScheduledReviewed",
		"communication.rescheduleReviewed",
		"communication.saveDraft",
		"communication.scheduleReviewed",
	]);
	assert.ok(readCatalog(member).domains.some((d) => d.operations.some((o) => o.operation === "communication.list")));
	const everything = JSON.stringify(readCatalog(owner));
	assert.doesNotMatch(everything, /sendReviewed|dispatchAttempt|executeResend|retryProvenFailed/);
	await assert.rejects(
		(async () => {
			const t = await turn(member, service.port);
			await t.propose("communication.saveDraft", { subject: "x", body: "y", audience: audience() });
		})(),
		{ code: "access_denied" },
	);
});

test("AC:WP-028-11 a second approval, a double click or a retried effect makes one draft, one schedule request and one cancel", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const t = await turn(owner, service.port);
	const draftProposal = await t.propose("communication.saveDraft", {
		subject: "Only once",
		body: "One draft.",
		audience: audience(),
	});
	const witness = { revision: draftProposal!.revision, digest: draftProposal!.digest };
	const [a, b] = await Promise.all([
		approveProposal(db, owner, draftProposal!.id, witness, null),
		approveProposal(db, owner, draftProposal!.id, witness, null),
	]);
	assert.equal([a.replayed, b.replayed].filter(Boolean).length, 1, "one approval queues the effect, the other replays");
	assert.equal(await runNext(service.port), "completed");
	assert.equal(await runNext(service.port), null, "one effect job");
	assert.equal((await rows(sql`SELECT count(*)::int n FROM communication WHERE subject='Only once'`))[0]!.n, 1);

	// A retried effect job after the first run's outcome was lost: the work replays and nothing is repeated.
	const { id } = await scheduledMessage(owner, service, "Retried effect");
	const sends = service.calls.send.length;
	const t2 = await turn(owner, service.port);
	const cancel = await t2.propose("communication.cancelScheduledReviewed", { communicationId: id });
	const first = await approve(owner, cancel!, service.port);
	assert.equal(first.review.receipt!.report!.confirmation, "confirmed");
	const cancelCalls = service.calls.cancel.length;
	// The outcome never reached the proposal (a crash after the email service answered): clear it and retry the job.
	await admin.execute(sql`UPDATE proposal SET outcome=NULL,receipt=NULL WHERE id=${cancel!.id}`);
	await admin.execute(sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${cancel!.id})`);
	await retryUnresolvedEffects(db, owner, cancel!.id);
	assert.equal(await runNext(service.port), "completed");
	assert.equal(service.calls.cancel.length, cancelCalls, "no recipient is asked twice: they are already confirmed");
	assert.equal(service.calls.send.length, sends, "no new schedule request");
	assert.equal((await readReview(db, owner, cancel!.id)).receipt!.report!.confirmation, "confirmed");

	// The same for the schedule: a retried job makes no second schedule request.
	const t3 = await turn(owner, service.port);
	const draft = await savedDraft(owner, service.port, "Schedule retry");
	const sched = await t3.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) });
	await approve(owner, sched!, service.port);
	const scheduled = service.calls.send.length;
	await admin.execute(sql`UPDATE proposal SET outcome=NULL,receipt=NULL WHERE id=${sched!.id}`);
	await admin.execute(sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${sched!.id})`);
	await retryUnresolvedEffects(db, owner, sched!.id);
	assert.equal(await runNext(service.port), "completed");
	assert.equal(service.calls.send.length, scheduled, "the stored provider key resumes instead of sending again");
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + draft.id + "/%"}`))[0]!
			.n,
		4,
	);
});

test("AC:WP-028-13 each review and effect stays within its statement budget and no transaction is open during a provider call", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Budget");
	const t = await turn(owner, service.port);
	const budget = async (operation: string, input: unknown, reads: number) => {
		const start = queries.length;
		const proposal = await t.propose(operation, input);
		assert.ok(proposal, operation);
		assert.ok(counted(start) <= reads, `${operation} prepared in ${counted(start)} statements, budget ${reads}`);
		return proposal;
	};
	const sched = await budget("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) }, 4);
	await approveProposal(db, owner, sched.id, { revision: sched.revision, digest: sched.digest }, null);
	const start = queries.length;
	assert.equal(await runNext(service.port), "completed");
	// claim, lock + authority + schedule, hand off (load, insert, record), publish: set-based, not per recipient.
	assert.ok(counted(start) <= 24, `schedule effect sent ${counted(start)} statements`);
	assert.equal(service.calls.send.at(-1)!.openTransactions, 0);
	const move = await budget("communication.rescheduleReviewed", { communicationId: draft.id, sendAt: localAt(4) }, 1);
	const cancel = await budget("communication.cancelScheduledReviewed", { communicationId: draft.id }, 1);
	await approveProposal(db, owner, move.id, { revision: move.revision, digest: move.digest }, null);
	assert.equal(await runNext(service.port), "completed");
	assert.deepEqual(service.calls.reschedule.length > 0, true);
	await assert.rejects(
		approveProposal(db, owner, cancel.id, { revision: cancel.revision, digest: cancel.digest }, null),
		{ code: "review_changed" },
		"the message moved after the cancel review",
	);
});
