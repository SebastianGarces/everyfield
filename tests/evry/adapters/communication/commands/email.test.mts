import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { communicationWriter } from "../../../../../packages/domain/src/communication/index.ts";
import { runDueScheduled } from "../../../../../packages/domain/src/communication/delivery.ts";
import { readFileSync } from "node:fs";
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
import { receiveMailCallback, replayStoredCallbacks } from "../../../../../apps/web/src/server/jobs/webhook.ts";
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

const CALLBACK_SECRET = "whsec_" + randomBytes(32).toString("base64");
/** The email service's signed callback for one provider id, as the webhook route receives it. */
function signedCallback(messageId: string, kind: string) {
	const raw = JSON.stringify({
		type: "email." + kind,
		created_at: new Date().toISOString(),
		data: { email_id: messageId },
	});
	const eventKey = randomUUID();
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(CALLBACK_SECRET.slice(6), "base64"))
		.update(eventKey + "." + stamp + "." + raw)
		.digest("base64");
	return new Request("https://example.test/api/webhooks/resend", {
		method: "POST",
		body: raw,
		headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
	});
}

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
		cancel: [] as { ids: string[]; openTransactions: number }[],
		reschedule: [] as { ids: string[]; at: string; openTransactions: number }[],
	};
	const answers = {
		cancel: "done" as Answer | ((id: string, n: number) => Answer),
		reschedule: "done" as Answer,
		/** A schedule request that gets no answer, or that the email service refuses. */
		send: "ids" as "ids" | "unknown" | "refused",
		/** What asking again about an unanswered schedule request says. */
		lookup: "unknown" as "ids" | "unknown",
	};
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
				if (answers.send !== "ids") return { outcome: answers.send };
				return { outcome: "ids", ids: batch.messages.map(() => "re_" + randomUUID()) };
			},
			async lookup() {
				if (answers.lookup === "unknown") return { outcome: "unknown" };
				return { outcome: "ids", ids: Array.from({ length: 20 }, () => "re_" + randomUUID()) };
			},
			async cancel(ids) {
				calls.cancel.push({ ids: [...ids], openTransactions: await open() });
				const a = answers.cancel;
				return ids.map((id, n) => ({ outcome: typeof a === "function" ? a(id, n) : a }));
			},
			async reschedule(ids, at) {
				calls.reschedule.push({ ids: [...ids], at, openTransactions: await open() });
				return ids.map(() => ({ outcome: answers.reschedule }));
			},
		},
	};
	return { port, calls, answers };
}

/** The person unsubscribed from this church's email (the Messages opt-out the handoff honors, D-284). */
const unsubscribe = (person: string) =>
	admin.execute(sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${plant}, ${person})`);

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
	// Dana unsubscribed from this church's email.
	people.dana = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,linked_account_id)
		VALUES(${people.dana},${plant},${plant},'Dana Off','dana.off@example.test','other',clock_timestamp(),'prospect','unknown','unknown',9,'live',${accounts.member.id})`);
	await unsubscribe(people.dana);
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
const limits = JSON.parse(
	readFileSync(new URL("../../../../integration/writes/limits.json", import.meta.url), "utf8"),
) as Record<string, { limit: number }>;
/** A person who joins the launch team and has an address, the way a planter adds one in People. */
const stageOf = (id: string, stage: string) => admin.execute(sql`UPDATE person SET stage=${stage} WHERE id=${id}`);
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
const mailOf = (id: string) => `communication/${id}/%`;
/**
 * The email service holds the message's waiting recipients, as it does for a message scheduled before T-241 moved the
 * handoff to the send time: a cancel or a time change then has to ask it, and can go unconfirmed.
 */
const heldByService = (id: string) =>
	admin.execute(sql`UPDATE mail SET state='accepted',provider_message_id='re_'||id::text
		WHERE logical_key LIKE ${mailOf(id)} AND state='scheduled'`);
/**
 * A message scheduled through its reviews. It waits in Everyfield for its send time; `held` (the default) then puts it
 * with the email service, so the provider paths of a cancel, a time change and a replacement can be driven.
 */
async function scheduledMessage(
	who: EvryActor,
	service: ReturnType<typeof emailService>,
	subject = SUBJECT,
	sendAt = localAt(3),
	held = true,
) {
	const draft = await savedDraft(who, service.port, subject);
	const t = await turn(who, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt });
	assert.ok(proposal);
	const done = await approve(who, proposal, service.port);
	assert.equal(done.outcome, "completed");
	if (held) await heldByService(draft.id);
	return { id: draft.id, review: done.review };
}
/** Makes message `id` due and runs the minute runner once: it hands the message to the email service. */
async function sendWhenDue(id: string, service: ReturnType<typeof emailService>) {
	// The earliest due time, so the runner's one claim is this message.
	await admin.execute(
		sql`UPDATE mail SET scheduled_at='2000-01-01T00:00:00Z' WHERE logical_key LIKE ${mailOf(id)} AND state='scheduled'`,
	);
	return runDueScheduled(db, service.port.transport, service.port.keys, 1, Date.now() + 30_000);
}

/** A crash after the email service answered: the first step's saved mark stays, and no outcome was saved. */
const loseOutcome = (id: string) =>
	admin.execute(sql`UPDATE proposal SET outcome=NULL,receipt='{"reached":true}'::jsonb WHERE id=${id}`);

test("a draft review shows the subject, audience, recipient count and body, and saves nothing", async () => {
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

test("approving a draft saves it in Messages drafts with no mail and no email service call", async () => {
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

test("a schedule review names who gets it, who is left out and why, and refuses a time outside the window", async () => {
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
		{ name: "Dana Off", reason: "unsubscribed" },
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
	assert.match(far!.review.refusal!, /Everyfield can hold an email for up to 30 days/);
	await assert.rejects(
		approveProposal(db, owner, far!.id, { revision: far!.revision, digest: far!.digest }, null),
		{ code: "review_closed" },
		"a refused review cannot be approved",
	);
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${draft.id}`))[0]!.state, "draft");
});

test("the review leaves out who the handoff refuses: an unsubscribe after one review shows on the next", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const olive = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${olive},${plant},${plant},'Olive Org','olive.org@example.test','other',clock_timestamp(),'prospect','unknown','unknown',10,'live')`);
	const t = await turn(owner, service.port);
	const proposed = await t.propose("communication.saveDraft", {
		subject: "Opt-out rule",
		body: "Hello.",
		audience: { groups: [], teamIds: [], personIds: [people.dana!, olive] },
	});
	const saved = await approve(owner, proposed!, service.port);
	const id = saved.review.receipt!.receiptId!;
	const review = async () =>
		(await turn(owner, service.port)).propose("communication.scheduleReviewed", {
			communicationId: id,
			sendAt: localAt(3),
		});
	const before = await review();
	assert.deepEqual(change(before!, "leftOut")!.after, [{ name: "Dana Off", reason: "unsubscribed" }]);
	assert.deepEqual(change(before!, "recipients")!.after, [{ name: "Olive Org" }]);
	await unsubscribe(olive);
	const after = await review();
	assert.deepEqual(change(after!, "leftOut")!.after, [
		{ name: "Dana Off", reason: "unsubscribed" },
		{ name: "Olive Org", reason: "unsubscribed" },
	]);
	assert.equal(after!.review.refusal, "Nobody in this audience can get this email.");

	// More people than one email service call takes: the handoff sends them in batches, so the review allows it.
	const crowd = Array.from({ length: 101 }, () => randomUUID());
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT x::uuid,${plant},${plant},'Crowd '||x,x||'@example.test','other',clock_timestamp(),'prospect','unknown','unknown',12,'live'
		FROM unnest(${sql.param(crowd)}::text[]) x`);
	const big = await turn(owner, service.port);
	const proposedBig = await big.propose("communication.saveDraft", {
		subject: "Many",
		body: "Hello.",
		audience: { groups: [], teamIds: [], personIds: crowd },
	});
	const savedBig = await approve(owner, proposedBig!, service.port);
	const bigReview = await (
		await turn(owner, service.port)
	).propose("communication.scheduleReviewed", {
		communicationId: savedBig.review.receipt!.receiptId!,
		sendAt: localAt(3),
	});
	assert.equal(bigReview!.review.refusal, undefined);
	await admin.execute(sql`DELETE FROM person WHERE id = ANY(${sql.param(crowd)}::uuid[])`);
});

test("a schedule that is not approved, or whose approval lapsed, runs nothing and calls no email service", async () => {
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

test("approving a schedule saves it scheduled, reports counts without saying delivered, and the email service gets it at its time", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const sendAt = localAt(3);
	const { id, review } = await scheduledMessage(owner, service, "Scheduled once", sendAt, false);
	assert.equal(service.calls.send.length, 0, "the message waits in Everyfield until its send time (T-241)");
	const [expected] = await rows(
		sql`SELECT to_char((${sendAt}::timestamp AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`,
	);
	assert.deepEqual(
		{ ...review.receipt!.report, scheduledAt: undefined },
		// Casey's blocked address is refused; Dana unsubscribed, which Messages counts apart from refusals (D-284).
		{
			kind: "schedule",
			confirmation: "confirmed",
			accepted: 2,
			refused: 1,
			unknown: 0,
			// No email service call yet: two wait in Everyfield, and the review left Casey, Dana and Member 001 out (D-927).
			waiting: 2,
			leftOut: 3,
			scheduledAt: undefined,
		},
	);
	assert.equal(review.receipt!.report!.scheduledAt, expected!.at);
	assert.doesNotMatch(JSON.stringify(review.receipt), /delivered/i);
	const [message] = await rows(sql`SELECT state FROM communication WHERE id=${id}`);
	assert.equal(message!.state, "scheduled");
	const states = await rows(
		sql`SELECT m.state,count(*)::int n FROM mail m WHERE m.logical_key LIKE ${mailOf(id)} GROUP BY 1 ORDER BY 1`,
	);
	assert.deepEqual(states, [
		{ state: "refused", n: 2 },
		{ state: "scheduled", n: 2 },
	]);
	const found = await db.transaction((tx) =>
		listMessages.invoke(tx, owner, { state: "scheduled", subject: "Scheduled once" }),
	);
	assert.equal(found.rows[0]!.fields.handedOff, true);
	// At its send time the email service gets one request with the reviewed recipients and content.
	assert.equal(await sendWhenDue(id, service), 1);
	assert.equal(service.calls.send.length, 1);
	const call = service.calls.send[0]!;
	assert.deepEqual([...call.to].sort(), ["alex.chen@example.test", "alex.rivera@example.test"]);
	assert.equal(call.subject, "Scheduled once");
	assert.match(call.text.join("\n"), /Hi Alex (Chen|Rivera),/);
	assert.equal(call.openTransactions, 0, "the email service is called outside any open transaction");
});

test("the email service gets only the people the review showed", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const launchTeam = { groups: ["launch_team"], teamIds: [], personIds: [] };
	await stageOf(people.alexRivera!, "launch_team");
	const start = await turn(owner, service.port);
	const proposed = await start.propose("communication.saveDraft", {
		subject: "Reviewed people",
		body: "Hello.",
		audience: launchTeam,
	});
	const saved = await approve(owner, proposed!, service.port);
	const id = saved.review.receipt!.receiptId!;
	const t = await turn(owner, service.port);
	const sendAt = localAt(3);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: id, sendAt });
	assert.deepEqual(change(proposal!, "recipients")!.after, [{ name: "Alex Rivera" }]);
	// Alex Chen joins the launch team inside the 15 minutes: the approved effect refuses, the draft stays a draft.
	await stageOf(people.alexChen!, "launch_team");
	const done = await approve(owner, proposal!, service.port);
	assert.equal(done.review.outcome, "refused");
	assert.equal(done.review.receipt!.code, "stale_review");
	assert.equal(service.calls.send.length, 0, "the email service got no call");
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${id}`))[0]!.state, "draft");
	await stageOf(people.alexChen!, "prospect");

	// A person the review left out as blocked stays left out when their address is restored before the approval.
	const blockedDraft = await turn(owner, service.port);
	const p2 = await blockedDraft.propose("communication.saveDraft", {
		subject: "Left out stays out",
		body: "Hello.",
		audience: { groups: [], teamIds: [], personIds: [people.alexRivera!, people.casey!] },
	});
	const saved2 = await approve(owner, p2!, service.port);
	const t2 = await turn(owner, service.port);
	const review = await t2.propose("communication.scheduleReviewed", {
		communicationId: saved2.review.receipt!.receiptId!,
		sendAt,
	});
	assert.deepEqual(change(review!, "leftOut")!.after, [{ name: "Casey Reed", reason: "blocked" }]);
	const blockedHash = hashOf("casey.reed@example.test");
	await admin.execute(sql`UPDATE suppression SET cleared_at=clock_timestamp() WHERE address_hash=${blockedHash}`);
	await approve(owner, review!, service.port);
	assert.equal(await sendWhenDue(saved2.review.receipt!.receiptId!, service), 1);
	await admin.execute(sql`UPDATE suppression SET cleared_at=NULL WHERE address_hash=${blockedHash}`);
	assert.deepEqual(service.calls.send.at(-1)!.to, ["alex.rivera@example.test"]);
	await stageOf(people.alexRivera!, "prospect");
});

test("a message still waiting in Everyfield moves and cancels at once, with no email service call", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Waiting then moved", localAt(3), false);
	const move = await (
		await turn(owner, service.port)
	).propose("communication.rescheduleReviewed", { communicationId: id, sendAt: localAt(4) });
	assert.ok(move);
	const moved = await approve(owner, move, service.port);
	assert.equal(moved.review.receipt!.report!.confirmation, "confirmed");
	const at = (change(move, "sendAt")!.after as { at: string }).at;
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${mailOf(id)} AND scheduled_at=${at}`))[0]!
			.n,
		2,
	);
	const cancel = await (
		await turn(owner, service.port)
	).propose("communication.cancelScheduledReviewed", { communicationId: id });
	assert.ok(cancel);
	const cancelled = await approve(owner, cancel, service.port);
	assert.equal(cancelled.review.receipt!.report!.confirmation, "confirmed");
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${mailOf(id)} AND state='cancelled'`))[0]!
			.n,
		2,
	);
	assert.deepEqual(
		[service.calls.send.length, service.calls.reschedule.length, service.calls.cancel.length],
		[0, 0, 0],
	);
});

test("a time change shows old and new time and says Saturday only after the email service confirms", async () => {
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
	const asked = service.calls.reschedule.length;
	await checkProposal(db, owner, proposal.id, service.port);
	assert.equal(service.calls.reschedule.length, asked);
});

test("a schedule the email service did not answer refuses a time change on the review, and no time moves", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await scheduledMessage(owner, service, "Unanswered then moved");
	// The email service never answered about any recipient it was handed.
	await admin.execute(
		sql`UPDATE mail SET state='unknown',provider_message_id=NULL WHERE logical_key LIKE ${mailOf(draft.id)} AND state='accepted'`,
	);
	const t2 = await turn(owner, service.port);
	const move = await t2.propose("communication.rescheduleReviewed", { communicationId: draft.id, sendAt: localAt(5) });
	assert.match(move!.review.refusal!, /has not answered about every recipient/);
	const before = (await rows(sql`SELECT scheduled_at,revision FROM communication WHERE id=${draft.id}`))[0];
	await assert.rejects(
		approveProposal(db, owner, move!.id, { revision: move!.revision, digest: move!.digest }, null),
		"a refused review cannot be approved",
	);
	assert.equal(await runNext(service.port), null, "no effect is queued");
	assert.equal(service.calls.reschedule.length, 0);
	assert.deepEqual((await rows(sql`SELECT scheduled_at,revision FROM communication WHERE id=${draft.id}`))[0], before);
});

test("one unanswered recipient beside an accepted one refuses a time change", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Mixed then moved");
	await admin.execute(
		sql`UPDATE mail SET state='unknown' WHERE id=(SELECT id FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND state='accepted' LIMIT 1)`,
	);
	const t = await turn(owner, service.port);
	const move = await t.propose("communication.rescheduleReviewed", { communicationId: id, sendAt: localAt(5) });
	assert.match(move!.review.refusal!, /has not answered about every recipient/);
	await assert.rejects(approveProposal(db, owner, move!.id, { revision: move!.revision, digest: move!.digest }, null));
	assert.equal(service.calls.reschedule.length, 0);
});

test("a cancel review shows subject, time and count; Cancelled needs the email service's confirmation", async () => {
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
	// The card lists everyone the email service still holds, so the owner sees who may still get it.
	const held = first.review.receipt!.report!;
	assert.ok(held.kind === "cancel");
	assert.deepEqual(
		held.people?.map((p) => p.outcome),
		["open", "open"],
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

test("a replacement is scheduled only when every original send is confirmed cancelled", async () => {
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
	// The review names who the new audience leaves out before approval, as the schedule review does.
	assert.ok(Array.isArray(change(proposal, "leftOut")!.after));
	const sends = service.calls.send.length;
	const done = await approve(owner, proposal, service.port);
	const report = done.review.receipt!.report!;
	assert.equal(report.kind, "replace");
	assert.equal(report.confirmation, "confirmed");
	// The replacement waits in Everyfield like any schedule, and goes to the email service at its time.
	const [replacement] = await rows(
		sql`SELECT id,state FROM communication WHERE plant_id=${plant} AND body_text LIKE '%5 pm%' ORDER BY created_at DESC LIMIT 1`,
	);
	assert.equal(replacement!.state, "scheduled");
	assert.equal(await sendWhenDue(replacement!.id, service), 1);
	assert.equal(service.calls.send.length, sends + 1, "one new send request");
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
	assert.equal(r2.review.receipt!.report!.kind, "replace_stopped");
	assert.equal(r2.review.receipt!.report!.confirmation, "not_confirmed");
	const partialPeople = (r2.review.receipt!.report as { people: { name: string; outcome: string }[] }).people;
	assert.deepEqual(
		partialPeople.map((p) => p.outcome).sort(),
		["cancelled", "open"],
		"the person whose send is cancelled is listed too: their email is gone with no replacement",
	);
	assert.equal(service.calls.send.length, sendsBefore);
	assert.equal(
		(
			await rows(
				sql`SELECT count(*)::int n FROM communication WHERE plant_id=${plant} AND body_text LIKE '%Different text.%'`,
			)
		)[0]!.n,
		0,
		"no replacement was saved or scheduled",
	);

	// One recipient's email already went out: also no replacement.
	service.answers.cancel = "done";
	const sentMessage = await scheduledMessage(owner, service, "Replace sent");
	service.answers.cancel = (_id, n) => (n === 0 ? "sent" : "done");
	const sendsAfter = service.calls.send.length;
	const t3 = await turn(owner, service.port);
	const p3 = await t3.propose("communication.replaceScheduledReviewed", {
		communicationId: sentMessage.id,
		body: "Late change.",
	});
	const r3 = await approve(owner, p3!, service.port);
	assert.equal(r3.review.receipt!.report!.kind, "replace_stopped");
	assert.deepEqual(
		(r3.review.receipt!.report as { people: { outcome: string }[] }).people.map((p) => p.outcome).sort(),
		["cancelled", "sent"],
	);
	assert.equal(service.calls.send.length, sendsAfter);
	service.answers.cancel = "done";
});

test("a replacement the handoff would refuse is refused on the review, and a changed audience stops before the cancel", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Replace nobody");
	const t = await turn(owner, service.port);
	// Casey is blocked and Member 001 has no address: nobody can get it, so the old send is left alone.
	const nobody = await t.propose("communication.replaceScheduledReviewed", {
		communicationId: id,
		audience: { groups: [], teamIds: [], personIds: [people.casey!, people.noAddress!] },
	});
	assert.match(nobody!.review.refusal!, /Nobody in this audience/);
	await assert.rejects(
		approveProposal(db, owner, nobody!.id, { revision: nobody!.revision, digest: nobody!.digest }, null),
		{
			code: "review_closed",
		},
	);
	assert.equal(service.calls.cancel.length, 0);

	// A changed audience stops before the cancel.
	await stageOf(people.alexChen!, "launch_team");
	const grown = await t.propose("communication.replaceScheduledReviewed", {
		communicationId: id,
		audience: { groups: ["launch_team"], teamIds: [], personIds: [] },
	});
	assert.equal(grown!.review.refusal, undefined);
	await stageOf(people.alexRivera!, "launch_team");
	const stale = await approve(owner, grown!, service.port);
	await stageOf(people.alexRivera!, "prospect");
	await stageOf(people.alexChen!, "prospect");
	assert.equal(stale.review.outcome, "refused");
	assert.equal(stale.review.receipt!.code, "stale_review");
	assert.equal(service.calls.cancel.length, 0, "the old send was not cancelled");
});

/** Each change the criterion names, made by the native command Messages or the email service callback runs. */
const inMessages = {
	async edit(who: EvryActor, id: string) {
		const [row] = await rows(sql`SELECT revision::text AS r,body_html,audience FROM communication WHERE id=${id}`);
		const context = { session: who.session, selected: who.owner };
		const reply = await db.transaction(async (tx) =>
			communicationWriter.saveDraft(tx, context as never, {
				requestKey: randomUUID(),
				expectedRevision: row!.r,
				input: {
					communicationId: id,
					subject: "Edited in Messages",
					bodyHtml: row!.body_html,
					audience: row!.audience,
				},
			}),
		);
		assert.equal(reply.status, "ok", JSON.stringify(reply));
	},
	async reschedule(who: EvryActor, id: string, service: ReturnType<typeof emailService>) {
		const [row] = await rows(sql`SELECT revision::text AS r FROM communication WHERE id=${id}`);
		const reply = await communicationWriter.rescheduleDispatched(
			db,
			who.authority,
			{
				requestKey: randomUUID(),
				expectedRevision: row!.r,
				input: { communicationId: id, scheduledAt: new Date(Date.now() + 9 * 86_400_000).toISOString() },
			},
			service.port.transport,
		);
		assert.equal(reply.status, "ok", JSON.stringify(reply));
	},
	async cancel(who: EvryActor, id: string, service: ReturnType<typeof emailService>) {
		const [row] = await rows(sql`SELECT revision::text AS r FROM communication WHERE id=${id}`);
		const reply = await communicationWriter.cancelScheduledReviewed(
			db,
			who.authority,
			{ requestKey: randomUUID(), expectedRevision: row!.r, input: { communicationId: id } },
			service.port.transport,
		);
		assert.equal(reply.status, "ok", JSON.stringify(reply));
	},
	/** The email service's sent callback for each held recipient, through the recorder the webhook route uses. */
	async sent(id: string) {
		const held = await rows(
			sql`SELECT provider_message_id AS id FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND state='accepted'`,
		);
		for (const mail of held) {
			const reply = await receiveMailCallback(db, signedCallback(mail.id, "sent"), CALLBACK_SECRET);
			assert.ok(reply.ok ?? true);
		}
		await replayStoredCallbacks(db);
		assert.equal(
			(
				await rows(
					sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + id + "/%"} AND state='sent'`,
				)
			)[0]!.n,
			held.length,
			"the callback marked each held recipient sent",
		);
	},
};

test("a message edited in Messages after the review refuses the approval and calls no email service", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Changed after review");
	const t = await turn(owner, service.port);
	const sendAt = localAt(3);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt });
	assert.ok(proposal);
	await inMessages.edit(owner, draft.id);
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
			input: { communicationId: draft.id, sendAt },
		},
		service.port,
	);
	assert.equal(again.stale, false);
	assert.equal(change(again, "subject")!.after, "Edited in Messages");
	// A change that lands after the approval, while the effect waits, is refused by the effect itself.
	await approveProposal(db, owner, again.id, { revision: again.revision, digest: again.digest }, null);
	await inMessages.edit(owner, draft.id);
	assert.equal(await runNext(service.port), "refused");
	const waited = await readReview(db, owner, again.id);
	assert.equal(waited.receipt!.code, "revision_conflict");
	assert.equal(service.calls.send.length, 0);
	assert.equal((await rows(sql`SELECT state FROM communication WHERE id=${draft.id}`))[0]!.state, "draft");
});

for (const [name, changeIt] of [
	["rescheduled", (who, id, service) => inMessages.reschedule(who, id, service)],
	["cancelled", (who, id, service) => inMessages.cancel(who, id, service)],
	["sent", (_who, id) => inMessages.sent(id)],
] as [string, (who: EvryActor, id: string, service: ReturnType<typeof emailService>) => Promise<void>][])
	for (const [operation, input] of [
		["communication.rescheduleReviewed", (id: string) => ({ communicationId: id, sendAt: localAt(5) })],
		["communication.cancelScheduledReviewed", (id: string) => ({ communicationId: id })],
		["communication.replaceScheduledReviewed", (id: string) => ({ communicationId: id, body: "New text." })],
	] as [string, (id: string) => unknown][])
		test(`a message ${name} in Messages refuses a ${operation} approval and calls no email service`, async () => {
			const owner = await actor("owner");
			const service = emailService();
			const { id } = await scheduledMessage(owner, service, `${name} before ${operation}`);
			const t = await turn(owner, service.port);
			const proposal = await t.propose(operation, input(id));
			assert.ok(proposal);
			assert.equal((await readReview(db, owner, proposal.id)).stale, false);
			await changeIt(owner, id, service);
			const before = [service.calls.send.length, service.calls.cancel.length, service.calls.reschedule.length];
			assert.equal((await readReview(db, owner, proposal.id)).stale, true);
			await assert.rejects(
				approveProposal(db, owner, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null),
				{ code: "review_changed" },
			);
			assert.equal(await runNext(service.port), null, "no effect was queued");
			assert.deepEqual(
				[service.calls.send.length, service.calls.cancel.length, service.calls.reschedule.length],
				before,
			);
			// A cancelled or sent message has nothing left to review again, and the card says so.
			if (name !== "rescheduled")
				await assert.rejects(
					reviseProposal(
						db,
						owner,
						proposal.id,
						{ operation, revision: proposal.revision, input: input(id) },
						service.port,
					),
					{ code: "not_found" },
				);
		});

test("a cancel that went out before the effect ran is refused by the effect, and an all-sent cancel never says Cancelled", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Sent while waiting");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.cancelScheduledReviewed", { communicationId: id });
	await approveProposal(db, owner, proposal!.id, { revision: proposal!.revision, digest: proposal!.digest }, null);
	await inMessages.sent(id);
	const calls = service.calls.cancel.length;
	assert.equal(await runNext(service.port), "refused");
	assert.equal((await readReview(db, owner, proposal!.id)).receipt!.code, "revision_conflict");
	assert.equal(service.calls.cancel.length, calls);

	// The email service itself answers "already sent" to the approved cancel: the report counts no cancel.
	const late = await scheduledMessage(owner, service, "Sent at the service");
	const t2 = await turn(owner, service.port);
	const p2 = await t2.propose("communication.cancelScheduledReviewed", { communicationId: late.id });
	service.answers.cancel = "sent";
	const done = await approve(owner, p2!, service.port);
	assert.deepEqual(done.review.receipt!.report, {
		kind: "cancel",
		confirmation: "confirmed",
		cancelled: 0,
		sent: 2,
		open: 0,
	});
});

test("Evry finds messages by subject and send time; a member reads but cannot write; no write sends unreviewed", async () => {
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
	assert.equal(
		new Date(byDate.rows[0]!.fields.sendsAtInstant as string).toISOString().slice(0, 10),
		friday.slice(0, 10),
	);
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
		"communication.deleteDraft",
		"communication.executeResend",
		"communication.replaceScheduledReviewed",
		"communication.rescheduleReviewed",
		"communication.retryProvenFailed",
		"communication.saveDraft",
		"communication.scheduleReviewed",
		"communication.sendReviewed",
		"communication.templates.create",
		"communication.templates.fork",
		"communication.templates.update",
	]);
	assert.ok(readCatalog(member).domains.some((d) => d.operations.some((o) => o.operation === "communication.list")));
	const everything = JSON.stringify(readCatalog(owner));
	// Sending is only ever a reviewed write; the email service's own handoff and check are never model tools.
	assert.doesNotMatch(everything, /dispatchAttempt|reconcileProviderOutcome|handOffScheduled/);
	await assert.rejects(
		(async () => {
			const t = await turn(member, service.port);
			await t.propose("communication.saveDraft", { subject: "x", body: "y", audience: audience() });
		})(),
		{ code: "access_denied" },
	);
});

test("the read offers only a message that can still go out, so a replaced original never beats its replacement", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const when = localAt(6);
	const sendOn = when.slice(0, 10);
	const list = () => db.transaction((tx) => listMessages.invoke(tx, owner, { sendOn }));

	const cancelled = await scheduledMessage(owner, service, "Read cancelled", when);
	const t = await turn(owner, service.port);
	const cancel = await t.propose("communication.cancelScheduledReviewed", { communicationId: cancelled.id });
	assert.equal((await approve(owner, cancel!, service.port)).review.receipt!.report!.confirmation, "confirmed");

	// The original and its replacement have the same subject and day: only the replacement can still go out.
	const original = await scheduledMessage(owner, service, "Read replaced", when);
	const t2 = await turn(owner, service.port);
	const replace = await t2.propose("communication.replaceScheduledReviewed", {
		communicationId: original.id,
		body: "New words",
	});
	const replaced = await approve(owner, replace!, service.port);
	assert.equal(replaced.review.receipt!.report!.confirmation, "confirmed");

	const sent = await scheduledMessage(owner, service, "Read sent", when);
	await admin.execute(
		sql`UPDATE mail SET state='sent' WHERE logical_key LIKE ${"communication/" + sent.id + "/%"} AND state='accepted'`,
	);
	// Sent to one recipient and still held for the other: it can still go out.
	const partly = await scheduledMessage(owner, service, "Read partly sent", when);
	await admin.execute(
		sql`UPDATE mail SET state='sent' WHERE id=(SELECT id FROM mail WHERE logical_key LIKE ${"communication/" + partly.id + "/%"} AND state='accepted' LIMIT 1)`,
	);
	// The email service did not answer: it may hold them, so it may still go out.
	const draft = await savedDraft(owner, service.port, "Read unanswered");
	const t3 = await turn(owner, service.port);
	const unanswered = await t3.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: when });
	service.answers.send = "unknown";
	await approve(owner, unanswered!, service.port);
	service.answers.send = "ids";

	const found = (await list()).rows.filter((r) => r.label.startsWith("Read "));
	assert.deepEqual(found.map((r) => r.label).sort(), ["Read partly sent", "Read replaced", "Read unanswered"]);
	const row = found.find((r) => r.label === "Read replaced")!;
	assert.equal(row.id, replaced.review.receipt!.receiptId, "the replacement, not the original");
	assert.equal(row.fields.handedOff, true);
	for (const r of found) assert.equal(r.fields.state, "scheduled");
});

test("a second approval, a double click or a retried effect makes one draft, one schedule request and one cancel", async () => {
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
	await loseOutcome(cancel!.id);
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
	await loseOutcome(sched!.id);
	await admin.execute(sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${sched!.id})`);
	await retryUnresolvedEffects(db, owner, sched!.id);
	assert.equal(await runNext(service.port), "completed");
	assert.equal(service.calls.send.length, scheduled, "the stored provider key resumes instead of sending again");
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM mail WHERE logical_key LIKE ${"communication/" + draft.id + "/%"}`))[0]!
			.n,
		4,
	);

	// The same for a time change: the recipients already at the new time are not asked again.
	const { id: movedId } = await scheduledMessage(owner, service, "Move retry");
	const t4 = await turn(owner, service.port);
	const move = await t4.propose("communication.rescheduleReviewed", { communicationId: movedId, sendAt: localAt(5) });
	const moved = await approve(owner, move!, service.port);
	assert.equal(moved.review.receipt!.report!.confirmation, "confirmed");
	const moves = service.calls.reschedule.length;
	await loseOutcome(move!.id);
	await admin.execute(sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${move!.id})`);
	await retryUnresolvedEffects(db, owner, move!.id);
	assert.equal(await runNext(service.port), "completed");
	assert.equal(service.calls.reschedule.length, moves, "no second time change request");
	assert.equal((await readReview(db, owner, move!.id)).receipt!.report!.confirmation, "confirmed");

	// A retry after a partial first run: the time change's own revision does not refuse it as changed.
	const { id: partId } = await scheduledMessage(owner, service, "Cancel retry partial");
	const t5 = await turn(owner, service.port);
	const part = await t5.propose("communication.cancelScheduledReviewed", { communicationId: partId });
	service.answers.cancel = (_id, n) => (n === 0 ? "unknown" : "done");
	await approve(owner, part!, service.port);
	service.answers.cancel = "done";
	await loseOutcome(part!.id);
	await admin.execute(sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${part!.id})`);
	await retryUnresolvedEffects(db, owner, part!.id);
	assert.equal(
		await runNext(service.port),
		"completed",
		"its own earlier cancel does not make the message look changed",
	);
	assert.equal((await readReview(db, owner, part!.id)).receipt!.report!.confirmation, "confirmed");
});

test("a retry that runs after the approval lapsed reports what the email service holds, never that nothing was done", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Reached then lapsed");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", {
		communicationId: draft.id,
		sendAt: localAt(3),
	});
	await approve(owner, proposal!, service.port);
	const sends = service.calls.send.length;
	await loseOutcome(proposal!.id);
	await admin.execute(
		sql`UPDATE job SET state='failed' WHERE id=(SELECT job_id FROM proposal WHERE id=${proposal!.id})`,
	);
	await retryUnresolvedEffects(db, owner, proposal!.id);
	await admin.execute(
		sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=${proposal!.id}`,
	);
	assert.equal(await runNext(service.port), "completed");
	const review = await readReview(db, owner, proposal!.id);
	assert.equal(review.status, "approved");
	assert.equal(review.outcome, "completed");
	assert.equal(review.receipt!.report!.confirmation, "confirmed");
	assert.equal(review.receipt!.report!.accepted, 2);
	assert.equal(service.calls.send.length, sends, "no second schedule request");

	// An effect that has not started still expires: nothing ran, so the card may say so.
	const other = await savedDraft(owner, service.port, "Lapsed before it started");
	const t2 = await turn(owner, service.port);
	const fresh = await t2.propose("communication.scheduleReviewed", { communicationId: other.id, sendAt: localAt(3) });
	await approveProposal(db, owner, fresh!.id, { revision: fresh!.revision, digest: fresh!.digest }, null);
	await admin.execute(sql`UPDATE proposal SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=${fresh!.id}`);
	assert.equal(await runNext(service.port), "expired");
	assert.equal(service.calls.send.length, sends);
});

test("each read and effect stays within its budget in limits.json and no transaction is open during a provider call", async () => {
	const owner = await actor("owner");
	const service = emailService();
	// The Evry read: its own row in limits.json, which counts the BEGIN and COMMIT of its read transaction.
	await scheduledMessage(owner, service, "Budget read");
	const start = queries.length;
	await db.transaction((tx) => listMessages.invoke(tx, owner, { state: "scheduled" }));
	const sent = queries.length - start;
	assert.ok(sent <= limits["communication.list"]!.limit, `communication.list sent ${sent} statements`);

	// A review reads at most: the message, the audience and the review statement. Set-based, not per recipient.
	const draft = await savedDraft(owner, service.port, "Budget");
	const t = await turn(owner, service.port);
	const review = async (operation: string, input: unknown, reads: number) => {
		const before = queries.length;
		const proposal = await t.propose(operation, input);
		assert.ok(proposal, operation);
		assert.ok(counted(before) <= reads, `${operation} prepared in ${counted(before)} statements, budget ${reads}`);
		return proposal;
	};
	const sched = await review("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) }, 4);

	/** Runs one approved effect and holds it to the native rows of limits.json plus the executor's fixed work. */
	const EXECUTOR = 12; // claim the job, lock and authority, the saved mark, the publication locks and the save
	const effect = async (proposal: Proposal, native: string[]) => {
		await approveProposal(db, owner, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
		const before = queries.length;
		assert.equal(await runNext(service.port), "completed");
		const budget = EXECUTOR + native.reduce((sum, name) => sum + limits[name]!.limit, 0);
		assert.ok(counted(before) <= budget, `${proposal.operation} sent ${counted(before)} statements, budget ${budget}`);
	};
	await effect(sched, ["communication.scheduleReviewed", "communication.handOffScheduled"]);
	// The send itself happens at the send time (the schedule approval test checks its open transactions). From here the email service
	// holds the message, so each later effect calls it.
	await heldByService(draft.id);

	const move = await review("communication.rescheduleReviewed", { communicationId: draft.id, sendAt: localAt(4) }, 1);
	await effect(move, ["communication.rescheduleDispatched"]);
	assert.equal(service.calls.reschedule.at(-1)!.openTransactions, 0);

	const replace = await review(
		"communication.replaceScheduledReviewed",
		{ communicationId: draft.id, body: "New." },
		3,
	);
	await effect(replace, [
		"communication.cancelScheduledReviewed",
		"communication.replaceScheduledReviewed",
		"communication.saveDraft",
		"communication.scheduleReviewed",
		"communication.handOffScheduled",
	]);
	assert.equal(service.calls.cancel.at(-1)!.openTransactions, 0);
	const replaced = (await readReview(db, owner, replace.id)).receipt!.receiptId!;
	await heldByService(replaced);

	const cancel = await review("communication.cancelScheduledReviewed", { communicationId: replaced }, 1);
	await effect(cancel, ["communication.cancelScheduledReviewed"]);
	assert.equal(service.calls.cancel.at(-1)!.openTransactions, 0);
});

// T-322 (WP-071, WP-072): Evry shows who an email reaches before anything is saved, sends it only after one exact
// review, says what happened to it, resends and retries by Messages' own rules, deletes drafts and keeps templates.

/** A second person at Alex Rivera's address, the way an unmerged duplicate record shares it. */
async function twin() {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${plant},${plant},'Alex Twin','Alex.Rivera@example.test','other',clock_timestamp(),'prospect','unknown','unknown',10,'live')`);
	return id;
}
const reads = async () => import("../../../../../packages/evry/src/adapters/communication/reads/index.ts");
const sent = (service: ReturnType<typeof emailService>) => service.calls.send.flatMap((c) => c.to).sort();
const leftOutOf = (proposal: Proposal) =>
	(change(proposal, "leftOut")!.after as { name: string; reason: string }[]).map((p) => `${p.name}: ${p.reason}`);
const namesOf = (proposal: Proposal) =>
	(change(proposal, "recipients")!.after as { name: string }[]).map((p) => p.name);
/** A new email sent now through its review, and the review's result. */
async function sentEmail(
	who: EvryActor,
	service: ReturnType<typeof emailService>,
	subject: string,
	extra: string[] = [],
) {
	const t = await turn(who, service.port);
	const proposal = await t.propose("communication.sendReviewed", { subject, body: BODY, audience: audience(extra) });
	assert.ok(proposal);
	const done = await approve(who, proposal, service.port);
	assert.equal(done.outcome, "completed");
	return { proposal, review: done.review, id: done.review.receipt!.receiptId! };
}

test("the audience read names who gets an email and who is left out and why, and saves and sends nothing", async () => {
	const owner = await actor("owner");
	const { resolveAudience } = await reads();
	const extra = await twin();
	const before = await rows(sql`SELECT (SELECT count(*)::int FROM communication) c,(SELECT count(*)::int FROM mail) m`);
	const r = await db.transaction((tx) => resolveAudience.invoke(tx, owner, { audience: audience([extra]) }));
	assert.deepEqual(
		r.rows.map((p) => `${p.label}: ${p.fields.leftOut ?? "gets it"}`),
		[
			"Alex Chen: gets it",
			"Alex Rivera: gets it",
			"Alex Twin: duplicate_address",
			"Casey Reed: gets it",
			"Dana Off: unsubscribed",
			"Member 001: no_address",
		],
	);
	assert.ok(
		r.exclusions.some((e) => /blocks/.test(e)),
		"the read says it cannot see blocked addresses",
	);
	assert.doesNotMatch(JSON.stringify(r), /example\.test/, "no address reaches the model");
	assert.deepEqual(
		await rows(sql`SELECT (SELECT count(*)::int FROM communication) c,(SELECT count(*)::int FROM mail) m`),
		before,
	);
	await admin.execute(sql`DELETE FROM person WHERE id=${extra}`);
});

test("a send review lists the exact recipients, the left out and the content; only Approve sends, one email per address", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const extra = await twin();
	const t = await turn(owner, service.port);
	const before = await rows(sql`SELECT (SELECT count(*)::int FROM communication) c,(SELECT count(*)::int FROM mail) m`);
	const proposal = await t.propose("communication.sendReviewed", {
		subject: "Vision night",
		body: BODY,
		audience: audience([extra]),
	});
	assert.ok(proposal);
	assert.deepEqual(namesOf(proposal), ["Alex Chen", "Alex Rivera"]);
	assert.deepEqual(leftOutOf(proposal), [
		"Alex Twin: duplicate_address",
		"Casey Reed: blocked",
		"Dana Off: unsubscribed",
		"Member 001: no_address",
	]);
	assert.match(String(change(proposal, "content")!.after), /^Hi Alex Chen,\n\nCome to Sunday's interest meeting/);
	// The review is all that exists: nothing saved, nothing handed to the email service.
	assert.deepEqual(
		await rows(sql`SELECT (SELECT count(*)::int FROM communication) c,(SELECT count(*)::int FROM mail) m`),
		before,
	);
	assert.equal(service.calls.send.length, 0);
	const done = await approve(owner, proposal, service.port);
	assert.equal(done.outcome, "completed");
	assert.deepEqual(done.review.receipt!.report, {
		kind: "send",
		confirmation: "confirmed",
		accepted: 2,
		refused: 0,
		unknown: 0,
		leftOut: 4,
	});
	assert.deepEqual(sent(service), ["alex.chen@example.test", "alex.rivera@example.test"]);
	const id = done.review.receipt!.receiptId!;
	// A crash after the email service answered: the retry replays every step and sends nothing again.
	await loseOutcome(proposal.id);
	await retryUnresolvedEffects(db, owner, proposal.id);
	assert.equal(await runNext(service.port), "completed");
	assert.equal(service.calls.send.length, 1, "one email service call, however often the effect runs");
	// What happened to it: sent, and delivered only once the email service says so.
	const { getMessage } = await reads();
	const asked = async () =>
		(await db.transaction((tx) => getMessage.invoke(tx, owner, { communicationId: id }))).rows
			.filter((r) => r.kind === "person")
			.map((r) => `${r.label}: ${r.fields.result}`);
	assert.deepEqual(await asked(), [
		"Alex Chen: sent",
		"Alex Rivera: sent",
		"Alex Twin: failed",
		"Casey Reed: failed",
		"Dana Off: unsubscribed",
	]);
	await admin.execute(
		sql`UPDATE mail SET delivered_at=clock_timestamp() WHERE communication_id=${id} AND recipient_person_id=${people.alexRivera!}`,
	);
	assert.deepEqual((await asked()).slice(0, 2), ["Alex Chen: sent", "Alex Rivera: delivered"]);
	// The latest email handed off is the one "did you send it?" finds.
	const latest = await db.transaction((tx) => getMessage.invoke(tx, owner, {}));
	assert.equal(latest.rows[0]!.id, id);
});

test("a resend goes to delivered non-openers only after 24 hours; a retry goes only to recipients that failed for certain", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await sentEmail(owner, service, "Resend me");
	const { resendCandidates } = await reads();
	const candidates = (selection: "delivered_nonopeners" | "proven_failed") =>
		db.transaction((tx) => resendCandidates.invoke(tx, owner, { communicationId: id, selection }));
	const at = (hours: number) =>
		admin.execute(sql`UPDATE mail SET sent_at=clock_timestamp()-make_interval(hours=>${hours}),
			delivered_at=CASE WHEN state='accepted' THEN clock_timestamp()-make_interval(hours=>${hours}) END
			WHERE communication_id=${id}`);
	await at(10);
	const early = await candidates("delivered_nonopeners");
	assert.equal(early.rows[0]!.fields.tooSoon, true);
	assert.match(String(early.rows[0]!.fields.resendFrom), /^\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	const t = await turn(owner, service.port);
	assert.equal(
		await t.propose("communication.executeResend", { communicationId: id }),
		null,
		"no review before 24 hours",
	);
	await at(30);
	await admin.execute(
		sql`UPDATE mail SET opened_at=clock_timestamp() WHERE communication_id=${id} AND recipient_person_id=${people.alexChen!}`,
	);
	const proposal = await t.propose("communication.executeResend", { communicationId: id });
	assert.ok(proposal);
	assert.deepEqual(namesOf(proposal), ["Alex Rivera"]);
	assert.deepEqual(leftOutOf(proposal), ["Alex Chen: opened", "Casey Reed: blocked", "Dana Off: unsubscribed"]);
	const calls = service.calls.send.length;
	const done = await approve(owner, proposal, service.port);
	assert.equal(done.outcome, "completed");
	assert.deepEqual(
		service.calls.send.slice(calls).flatMap((c) => c.to),
		["alex.rivera@example.test"],
	);
	// An email the email service never answered is still being checked: nothing to retry.
	service.answers.send = "unknown";
	const unknown = await sentEmail(owner, service, "Never answered");
	const t2 = await turn(owner, service.port);
	assert.equal(await t2.propose("communication.retryProvenFailed", { communicationId: unknown.id }), null);
	// One the email service refused for certain is retried through its own review, to those recipients only.
	service.answers.send = "refused";
	const refused = await sentEmail(owner, service, "Refused once");
	assert.equal(refused.review.receipt!.report!.confirmation, "refused");
	service.answers.send = "ids";
	const retry = await t2.propose("communication.retryProvenFailed", { communicationId: refused.id });
	assert.ok(retry);
	assert.deepEqual(namesOf(retry), ["Alex Chen", "Alex Rivera"]);
	const before = service.calls.send.length;
	assert.equal((await approve(owner, retry, service.port)).outcome, "completed");
	assert.deepEqual(
		service.calls.send
			.slice(before)
			.flatMap((c) => c.to)
			.sort(),
		["alex.chen@example.test", "alex.rivera@example.test"],
	);
});

test("deleting a draft waits for Approve; templates list system and church, a system template is copied, never edited", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Delete me");
	const t = await turn(owner, service.port);
	const del = await t.propose("communication.deleteDraft", { communicationId: draft.id });
	assert.ok(del);
	assert.equal(change(del, "draft")!.before, "Delete me");
	assert.equal((await rows(sql`SELECT count(*)::int n FROM communication WHERE id=${draft.id}`))[0]!.n, 1);
	assert.equal((await approve(owner, del, service.port)).outcome, "completed");
	assert.equal((await rows(sql`SELECT count(*)::int n FROM communication WHERE id=${draft.id}`))[0]!.n, 0);

	const { listTemplates } = await reads();
	const listed = async () =>
		(await db.transaction((tx) => listTemplates.invoke(tx, owner, {}))).rows.map(
			(r) => `${r.label} (${String(r.fields.origin)})`,
		);
	assert.ok((await listed()).every((l) => l.endsWith("(system)")));
	const create = await t.propose("communication.templates.create", {
		name: "Vision night invite",
		category: "meeting_invitation",
		subject: "Vision night",
		body: BODY,
	});
	assert.ok(create);
	assert.equal((await approve(owner, create, service.port)).outcome, "completed");
	assert.ok((await listed()).includes("Vision night invite (church)"));
	const system = (await db.transaction((tx) => listTemplates.invoke(tx, owner, {}))).rows.find(
		(r) => r.fields.origin === "system",
	)!;
	const edit = await t.propose("communication.templates.update", { templateId: system.id, subject: "Changed" });
	assert.ok(edit);
	assert.match(edit.review.refusal ?? "", /can't be edited\. Copy it/);
	await assert.rejects(approveProposal(db, owner, edit.id, { revision: edit.revision, digest: edit.digest }, null), {
		code: "review_closed",
	});
	const fork = await t.propose("communication.templates.fork", { sourceKey: String(system.fields.sourceKey) });
	assert.ok(fork);
	assert.equal((await approve(owner, fork, service.port)).outcome, "completed");
	assert.ok((await listed()).includes(`${system.label} (church)`), "the copy is the church's own");
	const copy = (await db.transaction((tx) => listTemplates.invoke(tx, owner, {}))).rows.find(
		(r) => r.label === system.label,
	)!;
	const change2 = await t.propose("communication.templates.update", {
		templateId: copy.id,
		subject: "Our own subject",
	});
	assert.ok(change2 && !change2.review.refusal);
	assert.equal((await approve(owner, change2, service.port)).outcome, "completed");
	const [saved] = await rows(sql`SELECT subject FROM message_template WHERE id=${copy.id}`);
	assert.equal(saved!.subject, "Our own subject");
});

test("one person's emails are listed apart from recorded calls, and the never-emailed list says how it checked", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await sentEmail(owner, service, "For one person");
	await admin.execute(sql`INSERT INTO contact_outcome(plant_id,person_id,outcome,occurred_at,recorded_at,contact_channel)
		VALUES(${plant},${people.alexRivera!},'contacted',clock_timestamp()-interval '1 day',clock_timestamp(),'phone')`);
	const { forPerson } = await reads();
	const mine = await db.transaction((tx) => forPerson.invoke(tx, owner, { personId: people.alexRivera! }));
	const email = mine.rows.find((r) => r.kind === "message" && r.id === id)!;
	assert.equal(email.fields.result, "sent");
	const calls = mine.rows.filter((r) => r.kind === "activity");
	assert.deepEqual(
		calls.map((r) => [r.label, r.fields.channel]),
		[["Recorded contact: contacted", "phone"]],
	);
	assert.ok(mine.exclusions.some((e) => /an email is never a call/.test(e)));
	const never = await db.transaction((tx) => forPerson.invoke(tx, owner, {}));
	const names = never.rows.map((r) => r.label);
	assert.ok(!names.includes("Alex Rivera") && !names.includes("Alex Chen"), "emailed people are not listed");
	assert.ok(names.includes("Member 001"));
	assert.ok(never.rows.every((r) => r.fields.email === "no email recorded"));
	assert.ok(
		never.exclusions.some((e) => /^checked: /.test(e)) && never.exclusions.some((e) => /^not checked: /.test(e)),
	);
});
