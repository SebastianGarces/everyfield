import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { systemTemplate } from "../../../packages/contracts/src/communication/catalog.ts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import { runDueScheduled } from "../../../packages/domain/src/communication/delivery.ts";
import { authorizeDigestMail, createDigestWorker, planDigests } from "../../../packages/domain/src/jobs/digest.ts";
import { claimUnknownMail, createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { sendDiscoveryAssociationReceipt } from "../../../packages/domain/src/jobs/notifications.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { createNotificationProducer, issueEmailOptOutToken } from "../../../packages/domain/src/notifications/index.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import { checkProposal, retryUnresolvedEffects, type MailPort } from "../../../packages/evry/src/index.ts";
import { ok, refused } from "../../support/fixture.mts";
import {
	caseWorld,
	propose,
	proposes,
	provider,
	read,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Reply,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familymail", { native: nativePorts() });
});
after(() => w?.close());

type Answer = "done" | "sent" | "unknown";
function emailService() {
	const calls = { send: [] as { key: string; to: string[]; text: string[] }[], cancel: [] as string[][] };
	const answers = { cancel: "done" as Answer, send: "ids" as "ids" | "unknown" | "refused" };
	const port: MailPort = {
		keys: provider("ids").port.keys,
		transport: {
			paused: false,
			async send(batch) {
				calls.send.push({
					key: batch.key,
					to: batch.messages.map((m) => m.to),
					text: batch.messages.map((m) => m.text),
				});
				if (answers.send !== "ids") return { outcome: answers.send };
				return { outcome: "ids", ids: batch.messages.map(() => "re_" + randomUUID()) };
			},
			async cancel(ids) {
				calls.cancel.push([...ids]);
				return ids.map(() => ({ outcome: answers.cancel }));
			},
			reschedule: async (ids) => ids.map(() => ({ outcome: "done" as const })),
		},
	};
	return { port, calls, answers };
}
const SHARED = "alex@example.test";
const SUPPRESSED = "suppressed@example.test";
const SUBJECT = "Sunday interest meeting";
const BODY = "Hi {{name}},\n\nCome on Sunday at 4 pm.";

async function block(address: string) {
	const event = randomUUID();
	const hash = createHmac("sha256", Buffer.alloc(32, 9)).update(address).digest("hex");
	await w.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${event},${"seed-" + event},${"seed-" + event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await w.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${hash},'hard_bounce',${event},clock_timestamp()) ON CONFLICT DO NOTHING`);
}
async function audienceChurch() {
	const c = await w.church({ street: "12 Mill Road", city: "Austin", country: "United States" });
	const address = (id: string, email: string | null) =>
		w.admin.execute(sql`UPDATE person SET email=${email} WHERE id=${id}`);
	const none = await c.person("Nora Noaddress");
	const stopped = await c.person("Sam Suppressed", { email: SUPPRESSED });
	await address(c.rivera, SHARED);
	await address(c.chen, SHARED);
	await block(SUPPRESSED);
	const audience = { personIds: [c.rivera, c.chen, none, stopped] };
	return { c, none, stopped, audience, address };
}
const change = (review: Reply, field: string) =>
	review.changes.find((x: { field: string }) => x.field === field)?.after;
const leftOut = (review: Reply) =>
	(change(review, "leftOut") as { name: string; reason: string }[]).map((p) => `${p.name}: ${p.reason}`).sort();
const counts = (c: Church) =>
	w.one(sql`SELECT (SELECT count(*)::int FROM communication WHERE plant_id=${c.P.id}) AS saves,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${c.P.id}) AS mail,
		(SELECT count(*)::int FROM contact_outcome WHERE plant_id=${c.P.id}) AS contacts`);
const mailOf = (id: string) =>
	w.rows(sql`SELECT m.state,p.display_name AS name,m.accepted_at IS NOT NULL OR m.sent_at IS NOT NULL AS accepted,
		m.delivered_at IS NOT NULL AS delivered FROM mail m LEFT JOIN person p ON p.id=m.recipient_person_id
		WHERE m.communication_id=${id} ORDER BY p.display_name`);

test("AC:EVRY-FAMILY-COMMUNICATION the reviewed audience and words are what is handed off, an unknown send is never repeated blindly, and acceptance is not contact", async () => {
	const { c, none, audience, address } = await audienceChurch();
	const email = emailService();
	const mail = { mail: email.port };

	const at0 = await counts(c);
	const before = await w.quiet(() => w.look(c.A, "communication.preview", { subject: SUBJECT, body: BODY, audience }));
	assert.deepEqual(
		rowsOf(before, "person")
			.map((r) => `${r.label}: ${r.fields.leftOut ?? "gets it"}`)
			.sort(),
		["Alex Chen: gets it", "Alex Rivera: duplicate_address", "Nora Noaddress: no_address", "Sam Suppressed: gets it"],
	);
	assert.ok(
		before.exclusions.some((e: string) => /blocks/.test(e)),
		"it says it cannot see blocked addresses",
	);
	const after = await counts(c);
	assert.deepEqual(
		{
			preview_sends: Number(after.mail) - Number(at0.mail),
			preview_saves: Number(after.saves) - Number(at0.saves),
			sent: email.calls.send.length,
		},
		{ preview_sends: 0, preview_saves: 0, sent: 0 },
	);

	const saved = await w.apply(c.A, "communication.saveDraft", { subject: SUBJECT, body: BODY, audience });
	const D = saved.receipt!.receiptId!;
	const drafts = await w.look(c.A, "communication.list", { state: "draft" });
	assert.deepEqual(
		rowsOf(drafts).map((r) => [r.id, r.label, r.fields.state]),
		[[D, SUBJECT, "draft"]],
	);
	const [held] = rowsOf(await w.look(c.A, "communication.getDraft", { communicationId: D }));
	assert.deepEqual([held.id, held.fields.subject, held.fields.body.trim()], [D, SUBJECT, BODY]);

	const day = async (sendAt: string) => {
		const card = await w.prepare(c.A, "communication.scheduleReviewed", { communicationId: D, sendAt });
		return { card, allowed: !card.review.refusal };
	};
	const [d29, d31] = [await day("2026-11-11T10:00"), await day("2026-11-13T10:00")];
	assert.deepEqual([d29.allowed, d31.allowed], [true, false], "29 days is inside the window, 31 is not");
	assert.match(d31.card.review.refusal!, /30 days/);
	await assert.rejects(w.approve(c.A, d31.card, email.port), { code: "review_closed" });
	const excluded = leftOut(d29.card.review);
	assert.deepEqual(excluded, [
		"Alex Rivera: duplicate_address",
		"Nora Noaddress: no_address",
		"Sam Suppressed: blocked",
	]);
	const tally = (reason: string) => excluded.filter((x) => x.endsWith(reason)).length;
	assert.deepEqual([tally("duplicate_address"), tally("no_address"), tally("blocked")], [1, 1, 1]);
	assert.deepEqual(
		change(d29.card.review, "recipients").map((p: { name: string }) => p.name ?? p),
		["Alex Chen"],
	);
	assert.match(
		change(d29.card.review, "content"),
		/^Hi Alex Chen,\n\nCome on Sunday at 4 pm\./,
		"merge fields are filled in",
	);

	assert.equal((await w.approve(c.A, d29.card, email.port)).outcome, "completed");
	assert.equal(email.calls.send.length, 0, "it waits for its time");
	await c.person("Late Joiner", { email: "late@example.test" });
	await address(none, "now@example.test");
	await w.admin.execute(
		sql`UPDATE mail SET scheduled_at='2026-10-12T00:00:00Z' WHERE communication_id=${D} AND state='scheduled'`,
	);
	const handOff = () => runDueScheduled(w.db, email.port.transport, email.port.keys, 1, Infinity);
	assert.equal(await handOff(), 1);
	assert.deepEqual(
		email.calls.send.flatMap((s) => s.to),
		[SHARED],
		"the frozen eligible address only",
	);
	assert.match(email.calls.send[0]!.text[0]!, /^Hi Alex Chen,\s+Come on Sunday at 4 pm\./);
	assert.equal(await handOff(), 0);
	assert.equal(
		(await mailOf(D)).some((m) => m.name === "Late Joiner"),
		false,
	);

	const [sentRow] = (await mailOf(D)).filter((m) => m.name === "Alex Chen");
	assert.deepEqual([sentRow!.accepted, sentRow!.delivered], [true, false], "accepted is not delivered");
	const got = await w.look(c.A, "communication.get", { communicationId: D });
	assert.deepEqual(
		rowsOf(got, "person").map((r) => `${r.label}: ${r.fields.result}`),
		["Alex Chen: sent", "Sam Suppressed: failed"],
		"who it went to and who it did not",
	);
	assert.equal(rowsOf(got, "message")[0].fields.results, "sent 1, failed 1", "the blocked one is told apart");
	const history = await w.look(c.A, "communication.forPerson", { personId: c.chen });
	assert.deepEqual(
		rowsOf(history).map((r) => [r.kind, r.id, r.fields.result]),
		[["message", D, "sent"]],
	);
	await w.admin.execute(
		sql`UPDATE mail SET delivered_at=clock_timestamp() WHERE communication_id=${D} AND recipient_person_id=${c.chen}`,
	);
	const totals = await w.look(c.A, "communication.deliveryTotals", { communicationId: D });
	assert.deepEqual(
		[rowsOf(totals)[0].fields.delivered, rowsOf(totals)[0].fields.opened],
		[1, 0],
		JSON.stringify(rowsOf(totals)),
	);
	assert.equal((await counts(c)).contacts, 0, "no acceptance, delivery or open is a contact");
	const log = await w.look(c.A, "followups.listContactHistory", { personId: c.chen });
	assert.deepEqual([rowsOf(log), log.total], [[], 0]);
	const hard = await w.look(c.A, "communication.resendCandidates", { communicationId: D, selection: "proven_failed" });
	assert.deepEqual(
		rowsOf(hard, "person")
			.filter((r) => r.fields.leftOut === null)
			.map((r) => r.label),
		[],
	);

	const scheduled = async (subject: string) => {
		const draft = await w.apply(c.A, "communication.saveDraft", { subject, body: BODY, audience });
		const id = draft.receipt!.receiptId!;
		await w.apply(c.A, "communication.scheduleReviewed", { communicationId: id, sendAt: "2026-10-20T10:00" }, mail);
		await w.admin.execute(sql`UPDATE mail SET state='accepted',provider_message_id='re_'||id::text
			WHERE communication_id=${id} AND state='scheduled'`);
		return id;
	};
	const moved = await scheduled("Move me");
	await w.apply(c.A, "communication.rescheduleReviewed", { communicationId: moved, sendAt: "2026-10-21T10:00" }, mail);
	const [movedRow] = rowsOf(await w.look(c.A, "communication.list", { subject: "Move me" }));
	assert.match(movedRow.fields.sendsAt ?? JSON.stringify(movedRow.fields), /2026-10-21/);
	const gone = await w.apply(c.A, "communication.cancelScheduledReviewed", { communicationId: moved }, mail);
	assert.equal(gone.receipt!.report!.confirmation, "confirmed");
	assert.ok((await mailOf(moved)).filter((m) => m.name === "Alex Chen").every((m) => m.state === "cancelled"));

	const kept = await scheduled("Replace me");
	email.answers.cancel = "unknown";
	const sends = email.calls.send.length;
	const stopped = await w.prepare(c.A, "communication.replaceScheduledReviewed", {
		communicationId: kept,
		body: "Different words.",
	});
	const { review: halted } = await w.approve(c.A, stopped, email.port);
	assert.deepEqual(
		[halted.receipt!.report!.kind, halted.receipt!.report!.confirmation],
		["replace_stopped", "not_confirmed"],
	);
	assert.deepEqual(
		[
			await w.count(
				sql`SELECT count(*)::int AS n FROM communication WHERE plant_id=${c.P.id} AND body_text LIKE '%Different words.%'`,
			),
			email.calls.send.length,
		],
		[0, sends],
		"no replacement intent on an unknown cancellation",
	);
	email.answers.cancel = "done";
	const replaced = await scheduled("Swap me");
	await w.apply(
		c.A,
		"communication.replaceScheduledReviewed",
		{ communicationId: replaced, body: "We meet at 5 pm." },
		mail,
	);
	assert.deepEqual(
		await w.rows(sql`SELECT state FROM communication WHERE plant_id=${c.P.id} AND body_text LIKE '%5 pm%'`),
		[{ state: "scheduled" }],
	);

	await w.admin.execute(sql`UPDATE person SET email='chen@example.test' WHERE id=${c.chen}`);
	const send = async (subject: string, answer: typeof email.answers.send) => {
		email.answers.send = answer;
		const card = await w.prepare(c.A, "communication.sendReviewed", { subject, body: BODY, audience });
		const { review } = await w.approve(c.A, card, email.port);
		return { card, review, id: review.receipt!.receiptId! };
	};
	const unknown = await send("No answer", "unknown");
	assert.equal(unknown.review.receipt!.report!.confirmation, "not_confirmed");
	const first = email.calls.send.at(-1)!;
	const blind = await w.ask(c.A, "Send it again to those that failed", [
		proposes("communication.retryProvenFailed", { communicationId: unknown.id }),
	]);
	assert.deepEqual(blind.proposals, [], "an unknown outcome is not a proven failure");
	const again = await w.ask(c.A, "Resend it", [
		proposes("communication.executeResend", { communicationId: unknown.id }),
	]);
	assert.deepEqual(again.proposals, []);
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, unknown.card.id)).retried, false);
	assert.equal(email.calls.send.at(-1), first, "no blind resend");
	const checked = await checkProposal(w.db, c.Aa, unknown.card.id, email.port);
	assert.equal(checked.proposal.outcome, "completed");
	assert.deepEqual(
		[email.calls.send.at(-1)!.key, email.calls.send.at(-1)!.to],
		[first.key, first.to],
		"the same stable key",
	);
	await w.admin.execute(sql`UPDATE mail_request SET first_dispatched_at=clock_timestamp()-interval '24 hours'
		WHERE id IN(SELECT request_id FROM mail_request_member m JOIN mail ON mail.id=m.mail_id WHERE mail.communication_id=${unknown.id})`);
	const tried = email.calls.send.length;
	await checkProposal(w.db, c.Aa, unknown.card.id, email.port);
	assert.equal(email.calls.send.length, tried, "past its window the key is never sent again");
	assert.equal(
		(await mailOf(unknown.id)).some((m) => m.state === "sent" || m.accepted),
		false,
		"nor called sent",
	);

	const failed = await send("Refused once", "refused");
	assert.equal(failed.review.receipt!.report!.confirmation, "refused");
	await block(SHARED);
	await w.admin.execute(
		sql`UPDATE mail SET bounced_at=clock_timestamp(),state='failed' WHERE communication_id=${failed.id} AND recipient_person_id=${c.rivera}`,
	);
	email.answers.send = "ids";
	const retry = await w.prepare(c.A, "communication.retryProvenFailed", { communicationId: failed.id });
	assert.deepEqual(
		change(retry.review, "recipients").map((p: { name: string }) => p.name),
		["Alex Chen", "Nora Noaddress"],
	);
	assert.deepEqual(
		leftOut(retry.review),
		["Alex Rivera: blocked", "Sam Suppressed: blocked"],
		"a bounce is not retried",
	);
	const n = email.calls.send.length;
	await address(c.chen, "changed@example.test");
	const changed = await w.approve(c.A, retry, email.port);
	assert.deepEqual(
		[changed.outcome, changed.review.receipt?.code, email.calls.send.length],
		["refused", "stale_review", n],
		"a changed address is not mailed on the old review",
	);
	const fresh = await w.prepare(c.A, "communication.retryProvenFailed", { communicationId: failed.id });
	assert.equal((await w.approve(c.A, fresh, email.port)).outcome, "completed");
	assert.deepEqual(
		email.calls.send
			.slice(n)
			.flatMap((s) => s.to)
			.sort(),
		["changed@example.test", "now@example.test"],
	);
	const opened = (
		await w.one<{ id: string }>(
			sql`SELECT communication_id AS id FROM mail WHERE tenant_id=${c.P.id} ORDER BY created_at DESC,id LIMIT 1`,
		)
	).id;
	await w.admin
		.execute(sql`UPDATE mail SET sent_at=clock_timestamp()-interval '30 hours',delivered_at=clock_timestamp()-interval '30 hours',
		opened_at=CASE WHEN recipient_person_id=${none} THEN clock_timestamp() END WHERE communication_id=${opened}`);
	const unopened = await w.look(c.A, "communication.resendCandidates", {
		communicationId: opened,
		selection: "delivered_nonopeners",
	});
	assert.deepEqual(
		rowsOf(unopened, "person")
			.filter((r) => r.fields.leftOut === null)
			.map((r) => r.label),
		["Alex Chen"],
	);
	const resendFrom = email.calls.send.length;
	await w.apply(c.A, "communication.executeResend", { communicationId: opened }, mail);
	assert.deepEqual(
		email.calls.send.slice(resendFrom).map((s) => s.to),
		[["changed@example.test"]],
	);

	const meeting = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
		VALUES(${meeting},${c.P.id},'vision_meeting','Vision night','2026-10-27','19:00','America/Chicago','2026-10-28T00:00:00Z','v1','planning',1)`);
	const invited = await w.apply(
		c.A,
		"communication.sendReviewed",
		{ subject: "Vision night", body: BODY, meetingId: meeting, audience: { personIds: [c.chen] } },
		mail,
	);
	const about = await w.look(c.A, "communication.forMeeting", { meetingId: meeting });
	assert.deepEqual(
		rowsOf(about, "message").map((r) => r.id),
		[invited.receipt!.receiptId],
	);
	const tracking = await w.look(c.A, "communication.meetingRecipientTracking", { meetingId: meeting });
	assert.deepEqual(
		rowsOf(tracking, "person").map((r) => [r.label, r.fields.result]),
		[["Alex Chen", "sent"]],
	);
	const team = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${c.P.id},'Worship','active',1)`,
	);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "communication.listAudienceTeams", {})).map((r) => [r.id, r.label]),
		[[team, "Worship"]],
	);
	const found = rowsOf(await w.look(c.A, "communication.searchRecipients", { query: "Alex" }), "person");
	assert.deepEqual(found.map((r) => r.id).sort(), [c.rivera, c.chen].sort());

	const spare = await w.apply(c.A, "communication.saveDraft", { subject: "Throw away", body: BODY, audience });
	await w.apply(c.A, "communication.deleteDraft", { communicationId: spare.receipt!.receiptId });
	assert.deepEqual(rowsOf(await w.look(c.A, "communication.list", { state: "draft" })), []);

	const source = systemTemplate("orientation-invitation")!;
	const forked = await w.apply(c.A, "communication.templates.fork", { sourceKey: source.sourceKey });
	const own = () =>
		w.one(sql`SELECT name,subject,body_html,source_key FROM message_template WHERE id=${forked.receipt!.receiptId}`);
	assert.deepEqual(
		await own(),
		{ name: source.name, subject: source.subject, body_html: source.bodyHtml, source_key: source.sourceKey },
		"the fork has the exact words and placeholders",
	);
	const templates = rowsOf(await w.look(c.A, "communication.templates.list", {}));
	const copy = templates.find((t) => t.id === forked.receipt!.receiptId);
	assert.deepEqual(
		[copy.fields.origin, copy.fields.subject, copy.fields.meetingType],
		["church", source.subject, "orientation"],
	);
	assert.deepEqual(
		copy.fields.placeholders.split(", ").sort(),
		[...new Set([...source.bodyHtml.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))].sort(),
	);
	await w.apply(c.A, "communication.templates.update", { templateId: copy.id, subject: "Our own welcome" });
	assert.deepEqual([(await own()).subject, (await own()).body_html], ["Our own welcome", source.bodyHtml]);
	assert.equal(systemTemplate("orientation-invitation")!.subject, source.subject);
	const made = await w.apply(c.A, "communication.templates.create", {
		name: "Notes",
		category: "announcement",
		subject: "S",
		body: BODY,
	});
	await w.apply(c.A, "communication.templates.archiveOrDelete", { templateId: made.receipt!.receiptId });
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM message_template WHERE id=${made.receipt!.receiptId}`),
		0,
	);

	const call = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,outcome,occurred_at,recorded_at,contact_channel)
		VALUES(${call},${c.P.id},${c.chen},'contacted','2026-10-12T15:00:00Z','2026-10-12T15:00:00Z','phone')`);
	await w.admin
		.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,after_revision)
		VALUES(${c.P.id},${c.A.id},'followup.recorded','outcome','contact_outcome',${call},'2026-10-12T15:00:00Z','2026-10-12T15:00:00Z',1)`);
	await w.apply(c.A, "communication.correctContactLog", {
		outcomeId: call,
		outcome: "attempted_no_contact",
		reason: "Voicemail",
	});
	assert.deepEqual(
		await w.rows(
			sql`SELECT outcome,voided_at IS NULL AS live FROM contact_outcome WHERE person_id=${c.chen} ORDER BY recorded_at,live`,
		),
		[
			{ outcome: "contacted", live: false },
			{ outcome: "attempted_no_contact", live: true },
		],
	);

	await block(c.A.email);
	const mine = await w.look(c.A, "mail.suppression.listForSelf", {});
	assert.equal(JSON.stringify(mine).includes(SUPPRESSED), false, "only their own address");
	assert.equal(rowsOf(mine)[0]?.fields.blocked ?? mine.facts?.blocked, true, JSON.stringify(mine));
	const other = await w.ask(c.A, "Is theirs blocked?", [
		() => read("mail.suppression.listForSelf", { address: SUPPRESSED }),
	]);
	assert.deepEqual([other.replies[0].error, other.cards], ["not_offered", []]);
	const restore = (who: typeof c.A, to: string) =>
		w
			.authorityOf(who)
			.then((authority) =>
				communicationWriter.requestRestore(
					w.db,
					authority,
					{ requestKey: randomUUID(), input: { address: to, reason: "Mine" } },
					email.port.keys,
				),
			);
	refused(await restore(c.A, SUPPRESSED), "access_denied");
	assert.equal((await restore(c.A, c.A.email)).status, "ok");
	const blockedNow = await w.prepare(c.A, "communication.sendReviewed", { subject: SUBJECT, body: BODY, audience });
	assert.ok(
		leftOut(blockedNow.review).includes("Sam Suppressed: blocked"),
		"restoring one's own address frees nobody else",
	);

	await c.foreignReview(blockedNow);
	await c.foreign(
		"Send that email",
		[
			() => [read("communication.get", { communicationId: D }), read("communication.forPerson", { personId: c.chen })],
			() => [read("communication.list", {}), read("communication.deliveryTotals", { communicationId: D })],
			() => propose("communication.sendReviewed", { subject: "Theirs", body: "Hello", audience }),
			() => propose("communication.retryProvenFailed", { communicationId: failed.id }),
		],
		{ secrets: [SUBJECT, SHARED, "Nora Noaddress"], on: { onError: "go_on" } },
	);
	const handed = email.calls.send.length;
	await c.failedWrite(blockedNow, "communication", { mail: email.port });
	assert.deepEqual(
		email.calls.send.slice(handed).map((s) => [...s.to].sort()),
		[["changed@example.test", "now@example.test"]],
		"the failed try sent nothing, the kept one sent once",
	);
});

async function notice(account: string, plant: string, title: string, minute: number) {
	const id = randomUUID();
	const task = randomUUID();
	await w.admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${task},${plant},${title},'general','medium','not_started',clock_timestamp(),'date_only','2026-10-13')`);
	await w.admin
		.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,source_revision,title,eligible_at,created_at,timezone)
		VALUES(${id},${plant},${account},'task','task_due',${`${plant}/task_due/${id}`},${task},1,${title},${`2026-10-13T15:0${minute}:00Z`},clock_timestamp(),'America/Chicago')`);
	return id;
}
const OPT_OUT = randomBytes(32);
const unread = async (account: string) =>
	(
		await w.rows<{ id: string }>(
			sql`SELECT id FROM notice WHERE recipient_id=${account} AND read_at IS NULL ORDER BY eligible_at`,
		)
	).map((r) => r.id);
const preferences = (account: string) =>
	w.rows(
		sql`SELECT category,channel,enabled FROM notification_preference WHERE account_id=${account} ORDER BY category,channel`,
	);

test("AC:EVRY-FAMILY-NOTIFICATIONS reading marks nothing, only the reviewed notices are marked, one dated catch-up digest goes out, an opt-out only turns off, and an unknown receipt is replayed under its own key", async () => {
	const c = await w.church({ digest_cadence: "daily", digest_hour: 7 });
	const B = await w.seated(c.P, "member", { user: { name: "Other Member" } });
	const N = [];
	for (let n = 1; n <= 4; n++) N.push(await notice(c.A.id, c.P.id, `Notice ${n}`, n));
	const [N1, N2, N3, N4] = N as [string, string, string, string];
	const old = await notice(c.A.id, c.P.id, "Already read", 5);
	await w.admin.execute(sql`UPDATE notice SET read_at='2026-10-13T15:30:00Z' WHERE id=${old}`);
	const theirs = await notice(B.id, c.P.id, "For B only", 6);
	await w.admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${c.P.id},${c.P.id},${c.casey},${c.A.id},'CARE-CANARY',clock_timestamp(),clock_timestamp())`);

	const marks = await w.quiet(() => w.look(c.A, "notifications.feed", { unread: true }));
	assert.deepEqual(
		rowsOf(marks)
			.map((r) => r.id)
			.sort(),
		[...N].sort(),
	);
	assert.deepEqual(
		[marks.total, (await unread(c.A.id)).length - 4, (await unread(B.id)).length],
		[4, 0, 1],
		"reading marks none",
	);
	assert.equal(JSON.stringify(marks).includes("For B only"), false);

	const card = await w.prepare(c.A, "notifications.markSelectedRead", { noticeIds: [N1, N2, N3, theirs] });
	assert.deepEqual(
		card.review.changes.map((x: Reply) => x.before.id).sort(),
		[N1, N2, N3].sort(),
		"another account's notice is not in the review",
	);
	const foreignOnly = await w.ask(c.A, "Mark theirs", [
		proposes("notifications.markSelectedRead", { noticeIds: [theirs] }),
	]);
	const madeUp = await w.ask(c.A, "Mark it", [
		proposes("notifications.markSelectedRead", { noticeIds: [randomUUID()] }),
	]);
	assert.deepEqual(
		[foreignOnly.proposals, foreignOnly.replies],
		[madeUp.proposals, madeUp.replies],
		"theirs answers as a made-up one",
	);
	const stale = await w.prepare(c.A, "notifications.markSelectedRead", { noticeIds: [N1, N2, N3] });
	assert.equal((await w.approve(c.A, card)).review.outcome, "completed");
	assert.deepEqual([await unread(c.A.id), await unread(B.id)], [[N4], [theirs]]);
	const one = await notice(c.A.id, c.P.id, "One more", 7);
	await w.apply(c.A, "notifications.markSelectedRead", { noticeIds: [one] });
	assert.deepEqual(await unread(c.A.id), [N4], "a single notice is marked the same way");

	const kept = await preferences(B.id);
	const was = rowsOf(await w.look(c.A, "notifications.preferences.get", {}));
	const choice = await w.apply(c.A, "notifications.setPreferences", {
		choices: [{ category: "task_due", channel: "email", enabled: false }],
	});
	assert.ok(choice);
	const now = rowsOf(await w.look(c.A, "notifications.preferences.get", {}));
	assert.deepEqual(
		now.map((r) => [r.id, r.fields]),
		was.map((r) => [r.id, r.id === "task_due" ? { ...r.fields, email: "off" } : r.fields]),
		"every other choice is preserved",
	);
	assert.deepEqual(await preferences(B.id), kept);
	const invented = await w.ask(c.A, "Alert me on every giving change", [
		proposes("notifications.setPreferences", {
			choices: [{ category: "giving_alert", channel: "email", enabled: true }],
		}),
	]);
	assert.deepEqual([invented.replies[0].error, invented.proposals], ["not_offered", []], "no new alert family");
	const staleRun = await w.approve(c.A, stale);
	assert.deepEqual(
		[staleRun.outcome, staleRun.review.receipt?.code],
		["refused", "revision_conflict"],
		"a stale selection",
	);
	const authority = await w.authorityOf(c.A);
	const producer = createNotificationProducer({ optOutKey: OPT_OUT });
	const accountRevision = String((await w.one(sql`SELECT revision::text AS r FROM account WHERE id=${c.A.id}`)).r);
	refused(
		await producer.markRead(w.db, authority, {
			requestKey: randomUUID(),
			expectedRevision: accountRevision,
			input: { noticeId: theirs },
		}),
		"access_denied",
	);
	assert.deepEqual([await unread(c.A.id), await unread(B.id)], [[N4], [theirs]]);

	await w.apply(c.A, "notifications.digestCadence.set", { cadence: "daily" });
	await w.apply(c.A, "church.digestSchedule.set", { schedule: { cadence: "daily", hour: 8 } });
	assert.deepEqual(await w.one(sql`SELECT digest_cadence,digest_hour FROM plant WHERE id=${c.P.id}`), {
		digest_cadence: "daily",
		digest_hour: 8,
	});
	const preview = await w.look(c.A, "notifications.previewPlanterDigest", {});
	assert.equal(rowsOf(preview)[0].kind, "digest");
	const S = await w.organization("sending_network", { name: "Network", timezone: "America/Chicago" });
	const director = await w.seated(S, "owner");
	await w.apply(director, "notifications.oversightDigestCadence.set", { cadence: "weekly" });
	await w.apply(director, "notifications.oversightDigestCadence.set", { cadence: "daily" });
	const orgPreview = await w.look(director, "notifications.previewOversightDigest", {});
	assert.equal(rowsOf(orgPreview)[0].kind, "digest");

	const last = await w.prepare(c.A, "notifications.markSelectedRead", { noticeIds: [N4] });
	await c.foreignReview(last);
	await c.foreign(
		"Mark those notices read",
		[
			() => [read("notifications.feed", { unread: true }), read("notifications.feed", {})],
			() => propose("notifications.markSelectedRead", { noticeIds: [N4, theirs] }),
		],
		{ secrets: ["Notice 4", "For B only"], on: { onError: "go_on" } },
	);
	assert.deepEqual([await unread(c.A.id), await unread(B.id)], [[N4], [theirs]]);
	await c.failedWrite(last, "notice");
	assert.deepEqual(await unread(c.A.id), []);
	const fifth = await notice(c.A.id, c.P.id, "Fifth", 8);
	await w.apply(c.A, "notifications.markAllVisibleRead", {});
	assert.deepEqual([await unread(c.A.id), await unread(B.id), Boolean(fifth)], [[], [theirs], true]);

	const sessions = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM auth_session) AS sessions,(SELECT count(*)::int FROM seat) AS seats`);
	const held = await sessions();
	const token = issueEmailOptOutToken(OPT_OUT, {
		purpose: "disable",
		accountId: c.A.id,
		category: "task_overdue",
		iat: new Date().toISOString(),
		unsubscribeRevision: "0",
	} as never);
	const described = ok<Reply>(await producer.describeEmailOptOut(w.db, { token }));
	assert.deepEqual([described.category, described.emailEnabled, described.changed], ["task_overdue", true, false]);
	const optedOut = ok<Reply>(await producer.applyEmailOptOut(w.db, { token }));
	assert.deepEqual([optedOut.emailEnabled, optedOut.changed], [false, true]);
	refused(await producer.undoEmailOptOut(w.db, { token }), "access_denied");
	assert.equal(JSON.stringify([described, optedOut]).includes(c.A.session), false);
	assert.deepEqual(await sessions(), held, "the link signs nobody in and grants nothing");
	assert.deepEqual(
		(await preferences(c.A.id))
			.filter((p) => p.channel === "email" && p.category === "task_overdue")
			.map((p) => p.enabled),
		[false],
	);

	const sent: { key: string; to: string; subject: string; text: string }[] = [];
	const answer = { kind: "accepted" as "accepted" | "unknown" };
	const mail = createMailService({
		db: w.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "notices@example.test",
		authorize: async (tx, rows) =>
			rows.every((m) => m.notice) ? authorizeDigestMail(tx, rows) : new Set(rows.map((m) => m.id)),
		transport: {
			async send(payload, key) {
				sent.push({ key: String(key), to: payload.to, subject: payload.subject, text: payload.text });
				return answer.kind === "accepted" ? { kind: "accepted", id: randomUUID() } : { kind: "unknown" };
			},
			lookup: async () => ({ kind: "unknown" }),
		},
	});
	const dispatch = async () => {
		for (let [claim] = await claimDue(w.db, ["mail"], 1); claim; [claim] = await claimDue(w.db, ["mail"], 1))
			await mail.dispatch(claim);
	};

	const D = await w.actor(null);
	await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${D.id})`);
	const association = randomUUID();
	const operation = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${association},${D.id},${S.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	await w.admin
		.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,request_key,metadata)
		VALUES(${operation},${S.id},${director.id},'affiliation.approved','edit','command',${S.id},clock_timestamp(),clock_timestamp(),${operation},jsonb_build_object('outcome',NULL))`);
	const queueReceipt = () =>
		transaction(w.db, (tx) =>
			sendDiscoveryAssociationReceipt(tx, mail, {
				organization: S.id,
				account: D.id,
				operation,
				occurrence: `${association}/1/accepted`,
				content: { subject: "Association accepted", text: "Your association was accepted." },
				address: async (_tx, accounts) => new Map(accounts.map((id) => [id, id === D.id ? D.email : director.email])),
				now: new Date().toISOString(),
				verifyOccurrence: async () => true,
			}),
		);
	const queued = await queueReceipt();
	const receipt = String((await w.one(sql`SELECT id FROM mail WHERE recipient_account_id=${D.id}`)).id);
	assert.ok(queued.includes(receipt));
	answer.kind = "unknown";
	await dispatch();
	const receipts = () => sent.filter((m) => m.to === D.email);
	const state = async () => (await w.one(sql`SELECT state FROM mail WHERE id=${receipt}`)).state;
	assert.deepEqual([await state(), receipts().length], ["unknown", 1]);
	assert.deepEqual(await queueReceipt(), queued, "the same occurrence queues no second receipt");
	await dispatch();
	assert.deepEqual([await state(), receipts().length], ["unknown", 1], "no blind retry");
	assert.deepEqual(await mail.reconcileUnknownOutcome(receipt), { kind: "unknown" });
	assert.equal(receipts().length, 1, "reconciling only asks");
	answer.kind = "accepted";
	const { p: prefix } = await w.one<{ p: string }>(
		sql`SELECT split_part(logical_key,'/',1)||'/' AS p FROM mail WHERE id=${receipt}`,
	);
	for (const claim of await claimUnknownMail(w.db, [prefix], 5)) await mail.dispatch(claim);
	assert.deepEqual(
		[await state(), receipts().length, receipts()[1]!.key],
		["accepted", 2, receipts()[0]!.key],
		"replayed under its own key",
	);

	const T = await w.plant({ name: "Sharing Church" });
	const U = await w.plant({ name: "Closed Church" });
	for (const [plant, share] of [
		[T, true],
		[U, false],
	] as const)
		await w.admin
			.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${plant.id},${S.id},clock_timestamp(),false,false,false,false,false,${share},false)`);
	const worker = createDigestWorker({ mail, origin: "https://everyfield.test" });
	const tick = async (at: string) => {
		await w.at(at);
		const { started } = await planDigests(w.db, at);
		await worker.run(w.db, at, undefined, Date.now() + 30_000);
		await dispatch();
		return started;
	};
	await tick("2026-10-13T16:30:00Z");
	const all = await w.rows(
		sql`SELECT title,category,purpose FROM notice WHERE recipient_id IN(${director.id},${c.A.id}) AND purpose LIKE '%digest'`,
	);
	assert.deepEqual(all, [], "nothing is owed yet");
	for (const day of ["2026-10-13", "2026-10-14", "2026-10-15"])
		for (const plant of [T, U])
			await w.admin
				.execute(sql`INSERT INTO audit_event(tenant_id,actor_token,action,kind,subject_type,subject_id,occurred_at,reason,metadata)
				VALUES(${plant.id},'synthetic','people.updated','edit','record',${plant.id},${`${day}T18:00:00Z`}::timestamptz,'CARE-CANARY','{"note":"CARE-CANARY"}'::jsonb)`);
	await tick("2026-10-16T14:00:00Z");
	await tick("2026-10-16T14:05:00Z");
	const org = await w.rows<{ title: string; safe_body: string }>(
		sql`SELECT title,safe_body FROM notice WHERE recipient_id=${director.id} AND purpose='oversight_digest'`,
	);
	assert.equal(org.length, 1, "one dated catch-up covers the missed days");
	assert.match(org[0]!.title, /Oct 13, 2026 to Oct 15, 2026/);
	assert.equal(org[0]!.safe_body.includes("Closed Church"), false, "a church that does not share gives nothing");
	const everything = JSON.stringify([sent, await w.rows(sql`SELECT title,safe_body FROM notice`)]);
	assert.equal(/CARE-CANARY|private care|pray/i.test(everything), false, "no private-care nudge");
});
