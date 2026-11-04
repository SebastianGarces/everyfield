import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { communicationWriter } from "../../../../../packages/domain/src/communication/index.ts";
import { notificationCategory } from "../../../../../packages/contracts/src/settings/values.ts";
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

/**
 * The state after a person turns off every email switch Settings shows an account: Settings shows no oversight digest
 * switch without an organization seat, and with one it is already off with no row. tests/integration/settings drives
 * the real Settings command to this same state. Returns how many it turned off.
 */
async function turnOffEveryEmailSwitch(who: keyof typeof accounts) {
	const categories = notificationCategory.options.filter(
		(name) => name !== "wiki_upstream_review" && name !== "oversight_digest",
	);
	for (const category of categories)
		await admin.execute(sql`INSERT INTO notification_preference(id,account_id,category,channel,enabled,unsubscribe_revision)
			VALUES(${randomUUID()},${accounts[who]!.id},${category},'email',false,1)`);
	return categories.length;
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
	await turnOffEveryEmailSwitch("member");
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

/** A crash after the email service answered: the first step's saved mark stays, and no outcome was saved. */
const loseOutcome = (id: string) =>
	admin.execute(sql`UPDATE proposal SET outcome=NULL,receipt='{"reached":true}'::jsonb WHERE id=${id}`);

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

test("AC:WP-028-3 update emails count as off by the same rule Settings shows, and a review refuses what the handoff would", async () => {
	const owner = await actor("owner");
	const service = emailService();
	// orgOwner's account has an organization seat, so Settings shows the oversight digest switch, off by default.
	const orgPerson = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,linked_account_id)
		VALUES(${orgPerson},${plant},${plant},'Olive Org','olive.org@example.test','other',clock_timestamp(),'prospect','unknown','unknown',10,'live',${accounts.orgOwner.id})`);
	// The owner's linked account never turned anything off: they are not left out.
	const ownerPerson = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,linked_account_id)
		VALUES(${ownerPerson},${plant},${plant},'Owen Owner','owen.owner@example.test','other',clock_timestamp(),'prospect','unknown','unknown',11,'live',${accounts.owner.id})`);
	const t = await turn(owner, service.port);
	const proposed = await t.propose("communication.saveDraft", {
		subject: "Settings rule",
		body: "Hello.",
		audience: { groups: [], teamIds: [], personIds: [people.dana!, orgPerson, ownerPerson] },
	});
	const saved = await approve(owner, proposed!, service.port);
	const id = saved.review.receipt!.receiptId!;
	const review = async () =>
		(await turn(owner, service.port)).propose("communication.scheduleReviewed", {
			communicationId: id,
			sendAt: localAt(3),
		});
	const before = await review();
	assert.deepEqual(change(before!, "leftOut")!.after, [{ name: "Dana Off", reason: "updates_off" }]);
	assert.deepEqual(change(before!, "recipients")!.after, [{ name: "Olive Org" }, { name: "Owen Owner" }]);
	assert.equal(await turnOffEveryEmailSwitch("orgOwner"), 9, "the oversight digest is already off by default");
	const after = await review();
	assert.deepEqual(change(after!, "leftOut")!.after, [
		{ name: "Dana Off", reason: "updates_off" },
		{ name: "Olive Org", reason: "updates_off" },
	]);

	// Over the email service's batch limit: refused on the review, before Messages marks it scheduled.
	const crowd = Array.from({ length: 101 }, () => randomUUID());
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT x::uuid,${plant},${plant},'Crowd '||x,x||'@example.test','other',clock_timestamp(),'prospect','unknown','unknown',12,'live'
		FROM unnest(${sql.param(crowd)}::text[]) x`);
	const big = await turn(owner, service.port);
	const proposedBig = await big.propose("communication.saveDraft", {
		subject: "Too many",
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
	assert.match(bigReview!.review.refusal!, /at most 100 people/);
	await admin.execute(sql`DELETE FROM person WHERE id = ANY(${sql.param(crowd)}::uuid[])`);
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

test("AC:WP-028-5 the email service gets only the people the review showed", async () => {
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
	await admin.execute(sql`UPDATE suppression SET cleared_at=NULL WHERE address_hash=${blockedHash}`);
	assert.deepEqual(service.calls.send.at(-1)!.to, ["alex.rivera@example.test"]);
	await stageOf(people.alexRivera!, "prospect");
});

test("AC:WP-028-5 a schedule with no answer says not confirmed, Check again asks the email service, and a refused one says so", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const draft = await savedDraft(owner, service.port, "Schedule unanswered");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.scheduleReviewed", { communicationId: draft.id, sendAt: localAt(3) });
	service.answers.send = "unknown";
	const done = await approve(owner, proposal!, service.port);
	service.answers.send = "ids";
	assert.equal(done.review.receipt!.report!.confirmation, "not_confirmed");
	const still = await checkProposal(db, owner, proposal!.id, service.port);
	assert.equal(still.proposal.receipt!.report!.confirmation, "not_confirmed");
	service.answers.lookup = "ids";
	const checked = await checkProposal(db, owner, proposal!.id, service.port);
	assert.equal(checked.proposal.receipt!.report!.confirmation, "confirmed");
	assert.equal((checked.proposal.receipt!.report as { accepted: number }).accepted, 2);

	const refused = await savedDraft(owner, service.port, "Schedule refused");
	const t2 = await turn(owner, service.port);
	const p2 = await t2.propose("communication.scheduleReviewed", { communicationId: refused.id, sendAt: localAt(3) });
	service.answers.send = "refused";
	const r2 = await approve(owner, p2!, service.port);
	service.answers.send = "ids";
	assert.equal(r2.review.outcome, "completed");
	assert.equal(r2.review.receipt!.report!.confirmation, "refused");
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
	const asked = service.calls.reschedule.length;
	await checkProposal(db, owner, proposal.id, service.port);
	assert.equal(service.calls.reschedule.length, asked);
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
	assert.equal(report.kind, "replace");
	assert.equal(report.confirmation, "confirmed");
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
	assert.equal(r2.review.receipt!.report!.kind, "replace_stopped");
	assert.equal(r2.review.receipt!.report!.confirmation, "not_confirmed");
	const partialPeople = (r2.review.receipt!.report as { people: { name: string; outcome: string }[] }).people;
	assert.deepEqual(
		partialPeople.map((p) => p.outcome).sort(),
		["cancelled", "open"],
		"the person whose send is cancelled is listed too: their email is gone with no replacement",
	);
	assert.equal(service.calls.send.length, sendsBefore, "no replacement was scheduled");

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

test("AC:WP-028-8 a replacement the email service does not answer is not called confirmed, and Check again asks it", async () => {
	const owner = await actor("owner");
	const service = emailService();
	const { id } = await scheduledMessage(owner, service, "Replace unanswered");
	const t = await turn(owner, service.port);
	const proposal = await t.propose("communication.replaceScheduledReviewed", {
		communicationId: id,
		body: "New text.",
	});
	service.answers.send = "unknown";
	const done = await approve(owner, proposal!, service.port);
	service.answers.send = "ids";
	const report = done.review.receipt!.report!;
	assert.equal(report.kind, "replace");
	assert.equal(report.confirmation, "not_confirmed", "the old send is cancelled and the new one has no answer");
	assert.deepEqual(
		{ accepted: (report as { accepted: number }).accepted, unknown: (report as { unknown: number }).unknown },
		{ accepted: 0, unknown: 2 },
	);
	service.answers.lookup = "ids";
	const checked = await checkProposal(db, owner, proposal!.id, service.port);
	assert.equal(checked.proposal.receipt!.report!.confirmation, "confirmed");
	assert.equal((checked.proposal.receipt!.report as { accepted: number }).accepted, 2);
});

test("AC:WP-028-8 a replacement the handoff would refuse is refused on the review, and a later refusal says the old send is cancelled", async () => {
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

	// The email service refuses the new send after the old one is cancelled: the report says so.
	const proposal = await t.propose("communication.replaceScheduledReviewed", {
		communicationId: id,
		body: "New text.",
	});
	service.answers.send = "refused";
	const done = await approve(owner, proposal!, service.port);
	service.answers.send = "ids";
	assert.equal(done.review.outcome, "completed");
	const report = done.review.receipt!.report as {
		kind: string;
		confirmation: string;
		code: string;
		people: { outcome: string }[];
	};
	assert.equal(report.kind, "replace_stopped");
	assert.equal(report.confirmation, "refused");
	assert.equal(report.code, "provider_refused");
	assert.deepEqual(
		report.people.map((p) => p.outcome),
		["cancelled", "cancelled"],
	);
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

test("AC:WP-028-9 a message edited in Messages after the review refuses the approval and calls no email service", async () => {
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
		test(`AC:WP-028-9 a message ${name} in Messages refuses a ${operation} approval and calls no email service`, async () => {
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

test("AC:WP-028-9 a cancel that went out before the effect ran is refused by the effect, and an all-sent cancel never says Cancelled", async () => {
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

test("AC:WP-028-13 each read and effect stays within its budget in limits.json and no transaction is open during a provider call", async () => {
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
	assert.equal(service.calls.send.at(-1)!.openTransactions, 0);

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
	assert.equal(service.calls.send.at(-1)!.openTransactions, 0);
	const replaced = (await readReview(db, owner, replace.id)).receipt!.receiptId!;

	const cancel = await review("communication.cancelScheduledReviewed", { communicationId: replaced }, 1);
	await effect(cancel, ["communication.cancelScheduledReviewed"]);
	assert.equal(service.calls.cancel.at(-1)!.openTransactions, 0);
});
