import "../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	cancelUnsubscribedHeld,
	communicationWriter,
	runDueScheduled,
} from "../../../packages/domain/src/communication/index.ts";
import type {
	DeliveryBatch,
	DeliveryMessage,
	DeliveryTransport,
	ProviderAnswer,
} from "../../../packages/domain/src/communication/delivery.ts";
import { GET, POST } from "../../../apps/web/src/app/api/webhooks/resend/route.ts";
import { resendWebhook } from "../../../apps/web/src/server/jobs/webhook-route.ts";
import { createMailService, MAIL_PASSES, runDueMail } from "../../../packages/domain/src/jobs/mail.ts";
import { sendDiscoveryAssociationReceipt } from "../../../packages/domain/src/jobs/notifications.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { replayStoredCallbacks } from "../../../packages/domain/src/jobs/webhook.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { notificationCategory } from "../../../packages/contracts/src/settings/index.ts";
import { ok, refused } from "../../support/fixture.mts";
import { failingWrite, recorded, untouched } from "../../support/recorded.mts";
import { pinSchemaClock } from "../../support/test-database.mts";
import { MAILING } from "./church-address.mts";
import {
	deliverAs,
	firstRow,
	readAs,
	rowsFrom,
	writeAs,
	type Church,
	type DeliveryOp,
	type Fixture,
	type Row,
	type Staff,
	type WriteOp,
} from "./communication-support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
	subcases?: (Pick<Case, "action" | "expected"> & { name: string })[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const NOW = new Date(caseOf("CASE-COM-006").clock.now);
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });

let f: Fixture;
let plant: Church;
let other: Church;
let owner: Staff;
let member: Staff;
let adminSeat: Staff;
let outsider: Staff;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const emptyAudience = { groups: [], teamIds: [], personIds: [] };
const key = () => randomUUID();
const rows = <R extends Row = Row>(query: SQL) => rowsFrom<R>(f, query);
const write = <K extends WriteOp>(who: Staff, op: K, input: unknown) => writeAs(f.db, who.actor, op, input);
const day = 86_400_000;
const onTheHour = (ms: number) => new Date(Math.ceil(ms / 3_600_000) * 3_600_000).toISOString();
const AT = onTheHour(Date.now() + 7 * day);
const LATER = onTheHour(Date.now() + 8 * day);

async function person(name: string, fields: { plant?: string; email?: string; state?: string } = {}) {
	const id = randomUUID();
	const plantId = fields.plant ?? plant.id;
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plantId},${plantId},${name},${fields.email ?? null},'other','prospect','unknown','unknown',0,
		${fields.state ?? "live"},clock_timestamp())`);
	return id;
}
async function scheduled(name: string, email: string, at: string, extraIds: string[] = []) {
	const personId = await person(name, { email });
	const saved = ok(
		await write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Welcome",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: [personId, ...extraIds] },
			},
		}),
	);
	const accepted = await write(owner, "scheduleReviewed", {
		requestKey: key(),
		expectedRevision: saved.revision,
		input: { communicationId: saved.communicationId, scheduledAt: at },
	});
	return { personId, saved, accepted, email };
}
type Send = DeliveryTransport["send"];
type Batch = Parameters<Send>[0];
type Calls = { send: number; cancel: number; reschedule: number };
type Behavior = {
	send?: (batch: Batch, calls: Calls) => Promise<DeliveryBatch>;
	cancel?: () => ProviderAnswer;
};
function port(behavior: Behavior) {
	const calls = { send: 0, cancel: 0, reschedule: 0 };
	const keys: string[] = [];
	const transport: DeliveryTransport = {
		paused: false,
		async send(batch) {
			calls.send += 1;
			keys.push(batch.key);
			assert.ok(behavior.send, "unexpected send");
			return behavior.send(batch, calls);
		},
		async cancel(ids) {
			calls.cancel += 1;
			return ids.map(() => (behavior.cancel ? behavior.cancel() : { outcome: "unknown" }));
		},
		async reschedule() {
			calls.reschedule += 1;
			throw new Error("provider_timeout");
		},
	};
	return Object.assign(transport, { calls, keys });
}
const handoff = (
	who: Staff,
	communicationId: string,
	revision: string,
	carrier: DeliveryTransport,
	op: DeliveryOp = "dispatchAttempt",
) =>
	deliverAs(
		f.db,
		who.actor,
		op,
		{ requestKey: key(), expectedRevision: revision, input: { communicationId } },
		carrier,
		keys,
	);
const secret = "whsec_" + randomBytes(32).toString("base64");
function signed(
	messageId: string,
	kind: string,
	eventKey: string = randomUUID(),
	bounce?: { type: string },
	createdAt = new Date().toISOString(),
) {
	const raw = JSON.stringify({
		type: "email." + kind,
		created_at: createdAt,
		data: bounce ? { email_id: messageId, bounce } : { email_id: messageId },
	});
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(eventKey + "." + stamp + "." + raw)
		.digest("base64");
	return new Request("https://example.test/api/webhooks/resend", {
		method: "POST",
		body: raw,
		headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
	});
}
async function mailFor(communicationId: string) {
	return rows<
		{ state: string; payload_hash: string; provider_message_id: string; provider_key: string } & Row
	>(sql`SELECT m.state, m.payload_hash, m.provider_message_id, m.logical_key, m.job_id,
		r.provider_key, r.first_dispatched_at, a.outcome
		FROM mail m
		LEFT JOIN mail_request_member mem ON mem.mail_id = m.id
		LEFT JOIN mail_request r ON r.id = mem.request_id
		LEFT JOIN mail_attempt a ON a.request_id = r.id AND a.attempt_number = 1
		WHERE m.logical_key LIKE ${"communication/" + communicationId + "/%"}
		ORDER BY mem.position`);
}

async function staff(church: Church, role: "owner" | "admin" | "member"): Promise<Staff> {
	const account = await f.account();
	await f.seat(account, church, role);
	return { ...account, actor: await f.actor(account.session) };
}
async function at(instant: Date) {
	await pinSchemaClock(f.admin, f.schema, instant);
	mock.timers.setTime(instant.getTime());
}
async function drafted(subject: string, count: number, who = adminSeat) {
	const emails = Array.from({ length: count }, (_, n) => `${subject.toLowerCase()}-${n}@example.test`);
	const ids = await Promise.all(emails.map((email, n) => person(`${subject} ${n}`, { email })));
	const saved = ok(
		await write(who, "saveDraft", {
			requestKey: key(),
			input: {
				subject,
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: ids },
			},
		}),
	);
	return { ids, emails, ...(await reviewed(saved.communicationId, saved.revision, who)) };
}
async function reviewed(id: string, revision: string, who = adminSeat) {
	const accepted = ok(
		await write(who, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: revision,
			input: { communicationId: id, scheduledAt: AT },
		}),
	);
	return { id, revision: accepted.revision };
}
async function suppress(email: string) {
	const event = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${event}::uuid,${"seed-" + event},${"seed-" + event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${createHmac("sha256", keys.addressKey).update(email).digest("hex")},'hard_bounce',${event}::uuid,clock_timestamp())`);
}
function idempotent() {
	const effects = new Map<string, readonly DeliveryMessage[]>();
	const ids = new Map<string, string[]>();
	const requests: string[] = [];
	const lose = { answer: true };
	const transport: DeliveryTransport = {
		paused: false,
		async send(batch) {
			requests.push(
				JSON.stringify([batch.key, batch.messages.map((m) => [m.to, m.subject, m.html, m.text, m.headers ?? null])]),
			);
			if (!effects.has(batch.key)) {
				effects.set(batch.key, batch.messages);
				ids.set(
					batch.key,
					batch.messages.map(() => "prov-" + randomUUID()),
				);
			}
			if (lose.answer) throw new Error("the answer was lost");
			return { outcome: "ids", ids: ids.get(batch.key)! };
		},
		cancel: async (list) => list.map(() => ({ outcome: "unknown" as const })),
		reschedule: async (list) => list.map(() => ({ outcome: "unknown" as const })),
	};
	return { transport, effects, ids, requests, lose };
}
async function backgroundMail(transport: DeliveryTransport) {
	const none = createMailService({
		db: f.db,
		encryptionKey: keys.encryptionKey,
		addressKey: keys.addressKey,
		from: keys.from,
		authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
		transport: {
			async send(payload, requestKey) {
				const sent = await transport.send(
					{ key: requestKey, messages: [payload], scheduledAt: null },
					AbortSignal.timeout(1000),
				);
				return sent.outcome === "ids" ? { kind: "accepted", id: sent.ids[0]! } : { kind: "unknown" };
			},
			lookup: async () => ({ kind: "unknown" }),
		},
	});
	await runDueScheduled(f.db, transport, keys, 50, Infinity);
	await cancelUnsubscribedHeld(f.db, transport, 50);
	for (const prefixes of [...Object.values(MAIL_PASSES), ["communication/"]])
		await runDueMail(f.db, none, prefixes, 50, Infinity);
	assert.deepEqual(await claimDue(f.db, ["mail"], 100), []);
	await replayStoredCallbacks(f.db);
}
const callback = (...args: Parameters<typeof signed>) => resendWebhook(signed(...args), () => f.db, secret);

before(async () => {
	f = await fixture({ clock: NOW });
	plant = await f.workspace("plant", MAILING);
	other = await f.workspace("plant", MAILING);
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
	const seated = await f.account();
	await f.seat(seated, plant, "member");
	member = { ...seated, actor: await f.actor(seated.session) };
	adminSeat = await staff(plant, "admin");
	outsider = await staff(other, "admin");
});
after(async () => {
	mock.timers.reset();
	await f?.close();
});

test("AC:GAP-COM-012 AC:MAIL51-002 AC:MAIL51-003 reviewed handoff sends once and refuses a stale or late schedule", async () => {
	const guest = await person("Alex", { email: "alex-window@example.test" });
	const draft = (subject: string) =>
		write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject,
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: [guest] },
			},
		});
	const late = ok(await draft("Late"));
	const past = refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: late.revision,
			input: {
				communicationId: late.communicationId,
				scheduledAt: new Date(Date.now() - day).toISOString(),
			},
		}),
		"schedule_window_exceeded",
	);
	assert.equal(past.details.providerHandoffs, 0);
	const far = ok(await draft("Far"));
	const over = refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: far.revision,
			input: {
				communicationId: far.communicationId,
				scheduledAt: new Date(Date.now() + 31 * day).toISOString(),
			},
		}),
		"schedule_window_exceeded",
	);
	assert.equal(over.details.providerHandoffs, 0);
	const edge = ok(await draft("Edge"));
	const onWindow = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: edge.revision,
			input: {
				communicationId: edge.communicationId,
				scheduledAt: new Date(Date.now() + 30 * day).toISOString(),
			},
		}),
	);
	assert.equal(onWindow.scheduleStatus, "accepted");
	assert.equal(onWindow.scheduleSent, false);
	assert.equal(onWindow.draftIntents, 0);
	const welcome = ok(await draft("Welcome"));
	const accepted = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: welcome.revision,
			input: { communicationId: welcome.communicationId, scheduledAt: AT },
		}),
	);
	assert.equal(accepted.scheduleSent, false);
	assert.equal(accepted.draftIntents, 0);
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-welcome"] };
		},
	});
	const sent = ok(await handoff(owner, welcome.communicationId, accepted.revision, carrier));
	assert.equal(sent.providerCalls, 1);
	assert.equal(sent.sentAt, null);
	assert.equal(sent.replayedWithNewKeys, 0);
	assert.equal(carrier.calls.send, 1);
	const body = firstRow(await rows(sql`SELECT body_text FROM communication WHERE id = ${welcome.communicationId}`));
	assert.equal(body.body_text, "Welcome Alex.");
	await f.admin.execute(sql`UPDATE person SET email = 'alex-moved@example.test' WHERE id = ${guest}`);
	const staleDraft = ok(await draft("Stale"));
	const staleSchedule = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: staleDraft.revision,
			input: { communicationId: staleDraft.communicationId, scheduledAt: AT },
		}),
	);
	await f.admin.execute(sql`UPDATE person SET email = 'alex-stale@example.test' WHERE id = ${guest}`);
	const stale = refused(
		await handoff(owner, staleDraft.communicationId, staleSchedule.revision, carrier),
		"stale_review",
	);
	assert.equal(stale.details.providerCalls, 0);
	assert.equal(stale.details.scriptExecution, false);
	assert.equal(carrier.calls.send, 1);
	const staleMail = await mailFor(staleDraft.communicationId);
	assert.equal(staleMail.length, 0);
});

test("INV-access: a member cannot send or schedule a message", async () => {
	const ready = await scheduled("Member", `member-${key().slice(0, 8)}@example.test`, AT);
	const scheduledId = ready.saved.communicationId;
	const scheduledRevision = ok(ready.accepted).revision;
	const draft = ok(
		await write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Not yet",
				bodyHtml: "<p>Not yet.</p>",
				audience: { ...emptyAudience, personIds: [ready.personId] },
			},
		}),
	);
	const stored = async (communicationId: string) => {
		const prefix = "communication/" + communicationId + "/%";
		const [row] = await rows(sql`SELECT c.state, c.revision::text AS revision,
			(SELECT count(*)::int FROM mail WHERE logical_key LIKE ${prefix}) AS mail,
			(SELECT count(DISTINCT mem.request_id)::int FROM mail m JOIN mail_request_member mem ON mem.mail_id = m.id
				WHERE m.logical_key LIKE ${prefix}) AS requests,
			(SELECT count(*)::int FROM audit_event WHERE subject_id = c.id) AS audits
			FROM communication c WHERE c.id = ${communicationId}::uuid`);
		return row!;
	};
	const before = { draft: await stored(draft.communicationId), ready: await stored(scheduledId) };
	assert.deepEqual(
		{ draft: before.draft.state, ready: before.ready.state, unsent: before.ready.requests },
		{ draft: "draft", ready: "scheduled", unsent: 0 },
	);
	const carrier = port({});

	refused(
		await write(member, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: draft.revision,
			input: { communicationId: draft.communicationId, scheduledAt: AT },
		}),
		"access_denied",
	);
	refused(await handoff(member, scheduledId, scheduledRevision, carrier, "sendReviewed"), "access_denied");
	refused(await handoff(member, scheduledId, scheduledRevision, carrier, "handOffScheduled"), "access_denied");

	assert.deepEqual({ draft: await stored(draft.communicationId), ready: await stored(scheduledId) }, before);
	assert.deepEqual(carrier.calls, { send: 0, cancel: 0, reschedule: 0 });
});

test("AC:CASE-COM-005 AC:CASE-COM-006 a short provider batch confirms only the answered recipient", async () => {
	const ids = [];
	for (let n = 0; n < 100; n += 1)
		ids.push(await person("Guest " + n, { email: `guest-${n}-${key().slice(0, 8)}@example.test` }));
	const sorted = [...ids].sort((a, b) => a.localeCompare(b));
	const saved = ok(
		await write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Batch",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: ids },
			},
		}),
	);
	const accepted = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: AT },
		}),
	);
	const carrier = port({
		async send(_batch, calls) {
			return calls.send === 1 ? { outcome: "ids", ids: ["prov-0"] } : { outcome: "unknown" };
		},
	});
	const first = ok(await handoff(owner, saved.communicationId, accepted.revision, carrier, "sendReviewed"));
	assert.equal(first.acceptedCount, 1);
	assert.equal(first.unknownCount, 99);
	assert.equal(first.sentAt, null);
	assert.deepEqual(first.confirmedRecipientIds, [sorted[0]]);
	assert.equal(first.replayedWithNewKeys, 0);
	assert.equal(first.status, "partial");
	const again = ok(await handoff(owner, saved.communicationId, accepted.revision, carrier));
	assert.equal(carrier.calls.send, 2);
	assert.equal(carrier.keys[1], carrier.keys[0]);
	assert.equal(again.providerCalls, 0);
	assert.equal(again.unknownCount, 99);
	assert.deepEqual(again.confirmedRecipientIds, [sorted[0]]);
	const stored = await mailFor(saved.communicationId);
	assert.equal(stored.length, 100);
	assert.equal(stored.filter((row) => row.state === "accepted").length, 1);
	assert.equal(stored[0]!.job_id, null);

	const refusedPair = await scheduled("Refused", `refused-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(refusedPair.accepted.status, "ok", JSON.stringify(refusedPair.accepted));
	const denyPort = port({
		async send() {
			return { outcome: "refused" };
		},
	});
	const failed = ok(
		await handoff(
			owner,
			refusedPair.saved.communicationId,
			ok(refusedPair.accepted).revision,
			denyPort,
			"sendReviewed",
		),
	);
	assert.equal(failed.failed, true);
	assert.equal(failed.acceptedCount, 0);
	assert.equal(failed.sentAt, null);
	assert.equal(failed.status, "failed");
	assert.equal(failed.communicationId, refusedPair.saved.communicationId);

	const unknownPair = await scheduled("Unknown", `unknown-${key().slice(0, 8)}@example.test`, AT);
	const lost = port({
		async send() {
			return { outcome: "unknown" };
		},
	});
	const uncertain = ok(
		await handoff(owner, unknownPair.saved.communicationId, ok(unknownPair.accepted).revision, lost, "sendReviewed"),
	);
	assert.equal(uncertain.uncertain, true);
	assert.equal(uncertain.failed, false);
	assert.equal(uncertain.status, "uncertain");
	assert.equal(uncertain.unknownCount, 1);
});

test("AC:CASE-COM-006 an immediate send and a reviewed non-opener resend each say exactly how many the email service took, refused or left unknown, and none reads as sent", async () => {
	const c = caseOf("CASE-COM-006");
	const named = c.subcases!.find((s) => s.name === "all-unknown-stays-unknown") ?? assert.fail("no subcase");
	const outcomes = [
		{ name: "Refused", expected: c.expected.result, send: "failed", people: 2, calls: 1 },
		{ name: "Unknown", expected: named.expected.result, send: "uncertain", people: 2, calls: 1 },
		{
			name: "Partial",
			expected: { communication: "C1", status: "partial", accepted: 1, refused: 1, unknown: 1 },
			send: "partial",
			people: 3,
			calls: 1,
		},
		{ name: "Blocked", expected: c.expected.result, send: "failed", people: 2, calls: 0 },
	];
	const resent = async (first: Awaited<ReturnType<typeof drafted>>) => {
		const ids = first.ids.map(() => "prov-" + randomUUID());
		ok(await handoff(adminSeat, first.id, first.revision, port({ send: async () => ({ outcome: "ids", ids }) })));
		const dayBefore = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
		for (const id of ids)
			for (const kind of ["sent", "delivered"])
				assert.equal((await callback(id, kind, randomUUID(), undefined, dayBefore)).status, 200);
		const made = ok(
			await write(adminSeat, "executeResend", {
				requestKey: key(),
				input: { communicationId: first.id, selection: "delivered_nonopeners" },
			}),
		);
		assert.deepEqual([...made.eligibleIds].sort(), [...first.ids].sort(), "every delivered non-opener is reviewed");
		return { ...first, ...(await reviewed(made.communicationId, "1")) };
	};
	for (const source of ["compose", "resend"] as const)
		for (const o of outcomes) {
			const label = `${source} ${o.name}`;
			const first = await drafted(`${o.name}${source}`, o.people);
			const m = source === "resend" ? await resent(first) : first;
			if (o.name === "Partial") await suppress(m.emails[0]!);
			if (o.name === "Blocked") for (const email of m.emails) await suppress(email);
			const carrier = port({
				async send(batch) {
					if (o.name === "Refused") return { outcome: "refused" };
					if (o.name === "Unknown") return { outcome: "unknown" };
					assert.equal(batch.messages.length, 2, "the blocked address never reaches the email service");
					return { outcome: "ids", ids: ["prov-" + randomUUID(), null] };
				},
			});
			const sent = ok(await handoff(adminSeat, m.id, m.revision, carrier, "sendReviewed"));
			assert.deepEqual(
				[
					sent.communicationId,
					sent.status,
					sent.sentAt,
					sent.acceptedCount,
					sent.rejectedCount,
					sent.unknownCount,
					sent.failed,
					sent.uncertain,
					carrier.calls.send,
				],
				[
					m.id,
					o.send,
					null,
					o.expected.accepted,
					o.expected.refused,
					o.expected.unknown,
					o.send === "failed",
					o.send === "uncertain",
					o.calls,
				],
				label,
			);
			const { value: answer, added } = await recorded(f.admin, () =>
				untouched(f.admin, () => readAs(f.db, adminSeat.actor, "getExecutionResult", { communicationId: m.id })),
			);
			const { communicationId, ...counts } = ok(answer);
			const { communication, ...expected } = o.expected;
			assert.deepEqual([communicationId, counts], [m.id, expected], label);
			assert.equal(communication, "C1");
			assert.deepEqual(added, { audits: [], jobs: [], notices: 0, mail: 0 }, "reading the result is no event");
			const saved = firstRow(
				await rows(sql`SELECT c.state, count(m.id)::int AS mail, count(m.sent_at)::int AS sent
					FROM communication c LEFT JOIN mail m ON m.communication_id=c.id WHERE c.id=${m.id} GROUP BY c.id`),
			);
			assert.deepEqual([saved.state, saved.mail, saved.sent], ["scheduled", o.people, 0], "the saved message, unsent");
			refused(await readAs(f.db, outsider.actor, "getExecutionResult", { communicationId: m.id }), "not_found");
			if (o.expected.unknown === 0) continue;
			const found = port({
				send: async (batch) => ({
					outcome: "ids",
					ids: batch.messages.map(() => "prov-" + randomUUID()),
				}),
			});
			const settled = ok(await handoff(adminSeat, m.id, m.revision, found, "reconcileProviderOutcome"));
			assert.deepEqual(
				[settled.unknownCount, settled.replayedWithNewKeys, found.keys],
				[0, 0, carrier.keys],
				"a missing provider id can still be settled, under the same request",
			);
		}
});

test("AC:MAIL-LEDGER-001 a send whose call throws is unknown, and Check result re-sends the same key and settles it", async () => {
	const made = await scheduled("Crash", `crash-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send(_batch, calls) {
			if (calls.send === 1) throw new Error("provider down");
			return { outcome: "ids", ids: ["prov-crash"] };
		},
	});
	const first = ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	assert.equal(first.status, "accepted_unknown");
	assert.equal(first.providerCalls, 1);
	assert.equal(carrier.calls.send, 1);
	const mid = await mailFor(made.saved.communicationId);
	assert.equal(mid.length, 1);
	assert.equal(new Set(mid.map((row) => row.provider_key)).size, 1);
	assert.equal(mid[0]!.outcome, "unknown");
	assert.equal(mid[0]!.state, "unknown");
	const second = ok(
		await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier, "reconcileProviderOutcome"),
	);
	assert.equal(carrier.calls.send, 2);
	assert.deepEqual(carrier.keys, [mid[0]!.provider_key, mid[0]!.provider_key]);
	assert.equal(second.providerCalls, 0);
	assert.equal(second.replayedWithNewKeys, 0);
	assert.equal(second.acceptedCount, 1);
	const after = await mailFor(made.saved.communicationId);
	assert.equal(after.length, 1);
	assert.equal(after[0]!.state, "accepted");
	assert.equal(after[0]!.provider_message_id, "prov-crash");
	assert.equal(after[0]!.outcome, "accepted");
});

test("AC:MAIL-KEYWINDOW-001 an unknown whole batch is never replayed by itself late in the provider window, a check stops at the cutoff, and no batch holds another church's or a security message", async () => {
	const c = caseOf("MAIL-KEYWINDOW-001");
	const input = c.action.arguments as {
		hours_since_first_dispatch: number[];
		foreign_batch_member: boolean;
	};
	assert.deepEqual(input.hours_since_first_dispatch, [23 + 50 / 60, 23 + 56 / 60]);
	const m = await drafted("Window", 2);
	const provider = idempotent();
	const first = ok(await handoff(adminSeat, m.id, m.revision, provider.transport));
	assert.deepEqual(
		[first.status, first.unknownCount, first.negativeEvidenceRequired, first.crossScopeBatchAllowed],
		["accepted_unknown", 2, true, false],
	);
	assert.deepEqual([provider.requests.length, provider.effects.size], [1, 1]);
	const dispatchedAt = async () =>
		new Date(
			firstRow(
				await rows<{
					at: string;
				}>(sql`SELECT DISTINCT r.first_dispatched_at AS at FROM mail_request r
					JOIN mail_request_member mem ON mem.request_id=r.id JOIN mail x ON x.id=mem.mail_id WHERE x.communication_id=${m.id}`),
			).at,
		).getTime();
	const start = await dispatchedAt();
	const attempts = async () =>
		(
			await rows(sql`SELECT count(*)::int AS n FROM mail_attempt a JOIN mail_request_member mem ON mem.request_id=a.request_id
				JOIN mail x ON x.id=mem.mail_id WHERE x.communication_id=${m.id}`)
		)[0]!.n;
	const tried = await attempts();
	const allowed: boolean[] = [];
	const outcomes: unknown[] = [];
	try {
		for (const hours of input.hours_since_first_dispatch) {
			await at(new Date(start + Math.round(hours * 3_600_000)));
			const before = provider.requests.length;
			await backgroundMail(provider.transport);
			allowed.push(provider.requests.length > before);
			const again = ok(await handoff(adminSeat, m.id, m.revision, provider.transport, "reconcileProviderOutcome"));
			outcomes.push([
				again.automaticReplayAllowed,
				again.negativeEvidenceRequired,
				again.firstDispatchClockReset,
				again.crossScopeBatchAllowed,
				again.unknownCount,
				again.providerCalls,
				again.replayedWithNewKeys,
				provider.requests.length - before,
			]);
			assert.equal(await dispatchedAt(), start, "the first handoff keeps its instant");
			assert.equal(await attempts(), tried);
		}
		provider.lose.answer = false;
		const late = provider.requests.length;
		const last = ok(await handoff(adminSeat, m.id, m.revision, provider.transport, "sendReviewed"));
		assert.deepEqual(
			[last.unknownCount, last.acceptedCount, provider.requests.length],
			[2, 0, late],
			"after the cutoff even a provider that would answer is not asked",
		);
	} finally {
		await at(new Date(NOW.getTime() + 600_000));
	}
	assert.deepEqual(allowed, c.expected.result.automatic_replay_allowed);
	assert.deepEqual(outcomes, [
		[false, true, false, false, 2, 0, 0, 1],
		[false, true, false, false, 2, 0, 0, 0],
	]);
	assert.deepEqual(new Set(provider.requests).size, 1, "a person's check carries the first handoff's key and bytes");
	assert.equal(provider.effects.size, 1);

	const canary = String(c.given["private-A"]!.note);
	const local = await person("Local", { email: "local-window@example.test" });
	const foreign = await person(canary, { email: "foreign-window@example.test", plant: other.id });
	const mixed = ok(
		await write(adminSeat, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Mixed",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: [local, foreign] },
			},
		}),
	);
	const ready = await reviewed(mixed.communicationId, mixed.revision);
	const held = provider.requests.length;
	const denied = refused(
		await untouched(f.admin, () => handoff(adminSeat, ready.id, ready.revision, provider.transport)),
		"access_denied",
	);
	assert.deepEqual([denied.details, provider.requests.length], [{}, held], "nothing about the foreign member is told");
	assert.equal(JSON.stringify(denied).includes(canary), false);

	const security = "security-window@example.test";
	provider.lose.answer = true;
	ok(
		await communicationWriter.sendTransactional(
			f.db,
			adminSeat.actor,
			{
				requestKey: key(),
				input: { purpose: "password_reset", token: "reset-token-value-window", address: security },
			},
			provider.transport,
			keys,
		),
	);
	assert.deepEqual(
		[...provider.effects.values()].map((batch) => batch.map((message) => message.to)),
		[[...m.ids].sort((a, b) => a.localeCompare(b)).map((id) => m.emails[m.ids.indexOf(id)]!), [security]],
		"a security message is its own request",
	);
	const members = await rows<{ request: string; tenants: number; purposes: string[] } & Row>(
		sql`SELECT mem.request_id AS request, count(DISTINCT x.tenant_id)::int AS tenants, array_agg(DISTINCT x.purpose) AS purposes
			FROM mail_request_member mem JOIN mail x ON x.id=mem.mail_id GROUP BY 1`,
	);
	assert.ok(members.every((r) => r.tenants === 1 && r.purposes.length === 1));
	const own = firstRow(
		await rows<{ request: string } & Row>(sql`SELECT mem.request_id AS request FROM mail_request_member mem
			JOIN mail x ON x.id=mem.mail_id WHERE x.communication_id=${m.id}`),
	);
	ok(
		await communicationWriter.sendTransactional(
			f.db,
			outsider.actor,
			{
				requestKey: key(),
				input: { purpose: "password_reset", token: "reset-token-value-abroad", address: security },
			},
			provider.transport,
			keys,
		),
	);
	const abroad = firstRow(
		await rows<{ id: string } & Row>(sql`SELECT id FROM mail WHERE tenant_id=${other.id} AND purpose='password_reset'`),
	).id;
	await assert.rejects(
		f.admin.execute(sql`INSERT INTO mail_request_member(request_id,tenant_id,mail_id,position)
			VALUES(${own.request},${plant.id},${abroad},2)`),
		(e: Error) => /foreign key/.test(String(e.cause)),
		"the database refuses another church's security message in this batch",
	);
	assert.equal(JSON.stringify([...provider.effects.values()]).includes(canary), false);
});

test("AC:DEL58-006 AC:MAIL51-004 AC:MAIL51-005 AC:MAIL51-007 cancel, replace, and reschedule do not send a new message", async () => {
	const made = await scheduled("Cancel", `cancel-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-cancel"] };
		},
		cancel() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	const sends = carrier.calls.send;
	const cancelled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: ok(made.accepted).revision,
				input: {
					communicationId: made.saved.communicationId,
					signedUrlExpires: "2026-10-13T16:05:00.000Z",
				},
			},
			carrier,
		),
	);
	assert.equal(cancelled.newHandoffs, 0);
	assert.equal(cancelled.scheduledCancel, "reconcile");
	assert.equal(cancelled.sentRecalled, false);
	assert.equal(cancelled.cancelRequested, true);
	assert.equal(cancelled.recallGuaranteed, false);
	assert.equal(cancelled.newSend, false);
	assert.equal(cancelled.existingUrlMayWorkUntil, "2026-10-13T16:05:00.000Z");
	assert.equal(carrier.calls.send, sends);

	const sentOne = await scheduled("Sent", `sent-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(sentOne.accepted.status, "ok");
	ok(await handoff(owner, sentOne.saved.communicationId, ok(sentOne.accepted).revision, carrier));
	await f.admin.execute(sql`UPDATE mail SET state = 'sent', sent_at = clock_timestamp()
		WHERE logical_key LIKE ${"communication/" + sentOne.saved.communicationId + "/%"}`);
	const recalled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: ok(sentOne.accepted).revision,
				input: {
					communicationId: sentOne.saved.communicationId,
					signedUrlExpires: "2026-10-13T16:05:00.000Z",
				},
			},
			carrier,
		),
	);
	assert.equal(recalled.sentRecalled, false);
	assert.equal(recalled.newSend, false);
	const stillSent = firstRow(
		await rows(
			sql`SELECT state FROM mail WHERE logical_key LIKE ${"communication/" + sentOne.saved.communicationId + "/%"}`,
		),
	);
	assert.equal(stillSent.state, "sent");
	const sentReplace = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: ok(sentOne.accepted).revision,
			input: { communicationId: sentOne.saved.communicationId },
		}),
	);
	assert.equal(sentReplace.replacementAllowed, false);
	assert.equal(sentReplace.replacementIntents, 0);
	assert.equal(sentReplace.blindResends, 0);

	const unknownOne = await scheduled("Hold", `hold-${key().slice(0, 8)}@example.test`, AT);
	const unknownPort = port({
		async send() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, unknownOne.saved.communicationId, ok(unknownOne.accepted).revision, unknownPort));
	const unknownReplace = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: ok(unknownOne.accepted).revision,
			input: { communicationId: unknownOne.saved.communicationId },
		}),
	);
	assert.equal(unknownReplace.replacementAllowed, false);
	assert.equal(unknownReplace.blindResends, 0);

	const drop = await scheduled("Drop", `drop-${key().slice(0, 8)}@example.test`, AT);
	const confirmPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-drop"] };
		},
		cancel() {
			return { outcome: "done" };
		},
	});
	ok(await handoff(owner, drop.saved.communicationId, ok(drop.accepted).revision, confirmPort));
	ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: ok(drop.accepted).revision,
				input: { communicationId: drop.saved.communicationId },
			},
			confirmPort,
		),
	);
	const replaced = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: ok(drop.accepted).revision,
			input: { communicationId: drop.saved.communicationId },
		}),
	);
	assert.equal(replaced.replacementAllowed, true);
	assert.equal(replaced.replacementIntents, 0);
	assert.equal(replaced.blindResends, 0);
	assert.equal(confirmPort.calls.send, 1);

	const move = await scheduled("Move", `move-${key().slice(0, 8)}@example.test`, AT);
	const movePort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-move"] };
		},
	});
	ok(await handoff(owner, move.saved.communicationId, ok(move.accepted).revision, movePort, "handOffScheduled"));
	const beforeCount = (await rows(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`))[0]!
		.n;
	const moved = ok(
		await communicationWriter.rescheduleDispatched(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: ok(move.accepted).revision,
				input: { communicationId: move.saved.communicationId, scheduledAt: LATER },
			},
			movePort,
		),
	);
	assert.equal(moved.body, "Welcome Alex.");
	assert.equal(moved.rescheduleStatus, "accepted");
	assert.equal(moved.newCommunications, 0);
	assert.equal(movePort.calls.send, 0);
	const kept = firstRow(await rows(sql`SELECT body_html FROM communication WHERE id = ${move.saved.communicationId}`));
	assert.equal(kept.body_html, "<p>Welcome Alex.</p>");
	const afterCount = (await rows(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`))[0]!.n;
	assert.equal(afterCount, beforeCount);
});

test("AC:CASE-NTF-010 AC:SEC-09 AC:SEC-06 callbacks in any order keep one outcome, a soft bounce blocks nobody, and a bad signature or an unsaved event writes nothing", async () => {
	const made = await scheduled("Callback", `callback-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-callback"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	const events = async () =>
		(await rows(sql`SELECT count(*)::int AS n FROM provider_event WHERE message_id = 'prov-callback'`))[0]!.n;
	const suppressions = async () => (await rows(sql`SELECT count(*)::int AS n FROM suppression`))[0]!.n;
	const beforeEvents = await events();
	const beforeSuppress = await suppressions();
	const previousSecret = process.env.RESEND_WEBHOOK_SECRET;
	delete process.env.RESEND_WEBHOOK_SECRET;
	const missing = await POST(signed("prov-callback", "delivered"));
	assert.equal(missing.status, 404);
	assert.equal((await missing.json()).code, "unavailable");
	process.env.RESEND_WEBHOOK_SECRET = secret;
	const bad = await POST(
		new Request("https://example.test/api/webhooks/resend", {
			method: "POST",
			body: "{}",
			headers: {
				"svix-id": "bad",
				"svix-timestamp": String(Math.floor(Date.now() / 1000)),
				"svix-signature": "v1,aaaa",
			},
		}),
	);
	assert.equal(bad.status, 401);
	assert.equal((await bad.json()).code, "invalid_signature");
	const allEvents = async () => (await rows(sql`SELECT count(*)::int AS n FROM provider_event`))[0]!.n;
	const beforeAll = await allEvents();
	const chunks = 64;
	let pulled = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled === chunks) return controller.close();
			pulled++;
			controller.enqueue(new Uint8Array(1024).fill(0x20));
		},
		cancel() {
			cancelled = true;
		},
	});
	const oversize = await POST(
		new Request("https://example.test/api/webhooks/resend", {
			method: "POST",
			body: stream,
			duplex: "half",
			headers: { "svix-id": "oversize", "svix-timestamp": String(Math.floor(Date.now() / 1000)) },
		} as RequestInit),
	);
	assert.equal(oversize.status, 413);
	assert.equal((await oversize.json()).code, "invalid_input");
	assert.ok(pulled < chunks, `pulled ${pulled} of ${chunks} chunks`);
	assert.ok(cancelled);
	assert.equal(await allEvents(), beforeAll);
	const got = await GET();
	assert.equal(got.status, 405);
	assert.equal((await got.json()).code, "method_not_allowed");
	assert.equal(await events(), beforeEvents);
	assert.equal(await suppressions(), beforeSuppress);
	if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
	else process.env.RESEND_WEBHOOK_SECRET = previousSecret;

	const c = caseOf("CASE-NTF-010");
	const input = c.action.arguments as { events: string[]; event_ids: string[]; fault: string };
	assert.deepEqual(
		[input.events, input.event_ids, input.fault],
		[["delivered", "accepted", "delivered"], ["e1", "e2", "e1"], "required_write_before_commit"],
	);
	const status = async () =>
		ok(await readAs(f.db, adminSeat.actor, "getDetail", { id: made.saved.communicationId }, keys)).recipients.map(
			(row) => row.deliveryStatus,
		);
	const deliver = (n: number) =>
		callback("prov-callback", input.events[n]!, input.event_ids[n], undefined, c.clock.now);
	assert.deepEqual(await status(), ["accepted"]);
	const error = console.error;
	console.error = () => undefined;
	try {
		for (const table of ["provider_event", "mail", "audit_event"]) {
			const before = await events();
			const failed = await failingWrite(
				f.admin,
				{ on: table, event: table === "mail" ? "UPDATE" : "INSERT" },
				async () => (table === "provider_event" ? untouched(f.admin, () => deliver(0)) : deliver(0)),
			);
			assert.deepEqual([failed.status, (await failed.json()).code], [503, "unavailable"], table);
			assert.deepEqual(
				[await events(), await status()],
				[table === "provider_event" ? before : Number(beforeEvents) + 1, ["accepted"]],
				`a failed ${table} write asks for the event again and applies nothing`,
			);
		}
	} finally {
		console.error = error;
	}
	const delivered = await recorded(f.admin, () => deliver(0));
	assert.equal(delivered.value.status, 200);
	assert.deepEqual(delivered.added, { audits: ["mail.delivered"], jobs: [], notices: 0, mail: 0 });
	const accepted = await recorded(f.admin, () => deliver(1));
	assert.equal(accepted.value.status, 200);
	assert.deepEqual(accepted.added, { audits: ["mail.reconciled"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(await status(), [c.expected.result.effective_delivery], "a late accepted never takes it back");
	const duplicate = await untouched(f.admin, () => deliver(2));
	assert.equal((await duplicate.json()).result, "duplicate");
	assert.equal(await events(), c.expected.result.unique_provider_events);
	assert.equal(
		(
			await rows(sql`SELECT count(*)::int AS n FROM audit_event a JOIN mail m ON m.id=a.subject_id
				WHERE m.provider_message_id='prov-callback' AND a.action='mail.delivered'`)
		)[0]!.n,
		1,
		"the repeated event adds no second effect",
	);
	const mail = firstRow(
		await rows(sql`SELECT state, delivered_at, accepted_at FROM mail WHERE provider_message_id = 'prov-callback'`),
	);
	assert.notEqual(mail.state, "accepted");
	assert.ok(mail.delivered_at);
	const delayed = await resendWebhook(signed("prov-callback", "delivery_delayed"), () => f.db, secret);
	assert.equal(delayed.status, 200);
	assert.deepEqual(await delayed.json(), { stored: false, result: "ignored" });
	const forged = await resendWebhook(
		signed("prov-callback", "delivery_delayed"),
		() => f.db,
		"whsec_" + randomBytes(32).toString("base64"),
	);
	assert.equal(forged.status, 401);
	assert.equal(await events(), 2);
	assert.deepEqual(
		await rows(sql`SELECT state, delivered_at, accepted_at FROM mail WHERE provider_message_id = 'prov-callback'`),
		[mail],
	);
	const again = ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	assert.equal(again.providerCalls, 0);
	assert.equal(carrier.calls.send, 1);

	const soft = await scheduled("Soft", `soft-${key().slice(0, 8)}@example.test`, AT);
	const softPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-soft"] };
		},
	});
	ok(await handoff(owner, soft.saved.communicationId, ok(soft.accepted).revision, softPort));
	const hash = createHmac("sha256", keys.addressKey).update(soft.email.trim().toLowerCase()).digest("hex");
	const active = async () =>
		(
			await rows(sql`SELECT count(*)::int AS n FROM suppression WHERE address_hash = ${hash} AND cleared_at IS NULL`)
		)[0]!.n;
	await callback("prov-soft", "bounced", randomUUID(), { type: "Transient" });
	assert.equal(Number(await active()) > 0, c.expected.result.soft_bounce_creates_hard_suppression);
	await callback("prov-soft", "bounced", randomUUID(), { type: "Permanent" });
	assert.equal(await active(), 1);
});

test("AC:NOTIFY47-008 a lost acceptance is checked under its own key, one signed callback counts once however often and early it comes, an unsaved one is asked for again, and a blocked address gets nothing", async () => {
	const c = caseOf("NOTIFY47-008");
	const input = c.action.arguments as {
		callback_id: string;
		repeat: number;
		provider_status: string;
	};
	const m = await drafted("Lost", 1);
	const provider = idempotent();
	const lost = ok(await handoff(adminSeat, m.id, m.revision, provider.transport, "sendReviewed"));
	assert.deepEqual([lost.status, lost.unknownCount], ["accepted_unknown", 1]);
	const [only] = await mailFor(m.id);
	assert.equal(only!.state, input.provider_status);
	await backgroundMail(provider.transport);
	assert.equal(provider.requests.length, 1, "no pass sends it again");
	const messageId = provider.ids.get(only!.provider_key)![0]!;
	const eventId = input.callback_id + "-lost";
	const arrive = () => callback(messageId, "delivered", eventId, undefined, c.clock.now);
	const callbacks = async () =>
		(await rows(sql`SELECT count(*)::int AS n FROM provider_event WHERE event_key=${eventId}`))[0]!.n;
	const error = console.error;
	console.error = () => undefined;
	try {
		const outage = await failingWrite(f.admin, { on: "provider_event", event: "INSERT" }, () =>
			untouched(f.admin, arrive),
		);
		assert.equal(outage.status, 503, "an unsaved callback is not acknowledged");
	} finally {
		console.error = error;
	}
	assert.equal(await callbacks(), 0);
	for (let n = 0; n < input.repeat; n++) {
		assert.deepEqual(await (await arrive()).json(), { stored: true, result: "unmatched" }, "it is kept for later");
		assert.equal(await callbacks(), c.expected.result.callback_rows);
	}
	assert.equal((await mailFor(m.id))[0]!.state, "unknown");
	provider.lose.answer = false;
	const found = ok(await handoff(adminSeat, m.id, m.revision, provider.transport, "reconcileProviderOutcome"));
	assert.deepEqual(
		[found.acceptedCount, found.replayedWithNewKeys, provider.effects.size, new Set(provider.requests).size],
		[1, c.expected.result.blind_resends, 1, 1],
		"one check under the first key and bytes, one provider message",
	);
	assert.equal(provider.requests.length, 2);
	assert.equal(await replayStoredCallbacks(f.db), 1);
	const outcomes = () =>
		rows(sql`SELECT count(*) FILTER (WHERE a.action='mail.delivered')::int AS n FROM audit_event a JOIN mail x ON x.id=a.subject_id
			WHERE x.communication_id=${m.id}`);
	const settled = await untouched(f.admin, async () => {
		assert.equal((await (await arrive()).json()).result, "duplicate");
		assert.equal(await replayStoredCallbacks(f.db), 0);
		return { rows: await callbacks(), outcomes: (await outcomes())[0]!.n };
	});
	assert.deepEqual(settled, {
		rows: c.expected.result.callback_rows,
		outcomes: c.expected.result.recorded_outcome_count,
	});
	const early = { created: "2026-10-13T15:59:00.000Z" };
	assert.equal((await callback(messageId, "sent", randomUUID(), undefined, early.created)).status, 200);
	const row = firstRow(await rows(sql`SELECT state, delivered_at, sent_at FROM mail WHERE communication_id=${m.id}`));
	assert.deepEqual(
		[row.state, new Date(row.delivered_at as string).toISOString(), new Date(row.sent_at as string).toISOString()],
		["sent", new Date(c.clock.now).toISOString(), early.created],
		"a late earlier event keeps the delivery",
	);
	const calls = provider.requests.length;
	ok(await handoff(adminSeat, m.id, m.revision, provider.transport, "sendReviewed"));
	await backgroundMail(provider.transport);
	assert.equal(provider.requests.length, calls, "a settled send is not repeated");

	assert.equal((await callback(messageId, "bounced", randomUUID(), { type: "Permanent" })).status, 200);
	const next = ok(
		await write(adminSeat, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Again",
				bodyHtml: "<p>Again</p>",
				audience: { ...emptyAudience, personIds: m.ids },
			},
		}),
	);
	const ready = await reviewed(next.communicationId, next.revision);
	const blocked = ok(await handoff(adminSeat, ready.id, ready.revision, provider.transport, "sendReviewed"));
	assert.deepEqual([blocked.status, blocked.rejectedCount, provider.requests.length], ["failed", 1, calls]);
});

test("INV-webhook: a callback whose message id matches no mail, or more than one, stays pending and never routes by request id", async () => {
	const twin = `prov-twin-${key().slice(0, 8)}`;
	const sent: string[] = [];
	for (const name of ["Twin A", "Twin B"]) {
		const made = await scheduled(name, `${name.replace(" ", "-").toLowerCase()}-${key().slice(0, 8)}@example.test`, AT);
		const carrier = port({
			async send() {
				return { outcome: "ids", ids: [twin] };
			},
		});
		ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
		sent.push(made.saved.communicationId);
	}
	const settled = async () =>
		(await Promise.all(sent.map(mailFor))).flat().map((m) => ({ state: m.state, id: m.provider_message_id }));
	const beforeMail = await settled();
	assert.deepEqual(
		beforeMail.map((m) => m.id),
		[twin, twin],
	);
	const pendingEvents = async (messageId: string) =>
		(
			await rows(
				sql`SELECT count(*)::int AS n FROM provider_event WHERE message_id = ${messageId} AND processed_at IS NULL`,
			)
		)[0]!.n;
	const ambiguous = await resendWebhook(signed(twin, "delivered"), () => f.db, secret);
	assert.equal(ambiguous.status, 200);
	assert.deepEqual(await ambiguous.json(), { stored: true, result: "unmatched" });
	assert.equal(await pendingEvents(twin), 1);
	const first = firstRow(await mailFor(sent[0]!));
	const byRequest = await resendWebhook(signed(first.provider_key, "delivered"), () => f.db, secret);
	assert.deepEqual(await byRequest.json(), { stored: true, result: "unmatched" });
	assert.equal(await pendingEvents(first.provider_key), 1);
	assert.deepEqual(await settled(), beforeMail);
	const delivered = await rows(
		sql`SELECT count(*)::int AS n FROM mail WHERE provider_message_id = ${twin} AND delivered_at IS NOT NULL`,
	);
	assert.equal(delivered[0]!.n, 0);
});

test("AC:CASE-NTF-011 a person clears only their own suppressed address", async () => {
	const made = await scheduled("Self", owner.email, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-self"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	await resendWebhook(signed("prov-self", "bounced", randomUUID(), { type: "Permanent" }), () => f.db, secret);
	const listed = ok(await communicationWriter.listForSelf(f.db, owner.actor, { address: owner.email }, keys));
	assert.equal(listed.address, owner.email);
	assert.equal(listed.active, true);
	assert.equal(listed.suppressionClears, 0);
	assert.equal(listed.newSends, 0);
	refused(
		await communicationWriter.listForSelf(f.db, owner.actor, { address: "other-person@example.test" }, keys),
		"access_denied",
	);
	const before = carrier.calls.send;
	refused(
		await communicationWriter.requestRestore(
			f.db,
			owner.actor,
			{ requestKey: key(), input: { address: "other-person@example.test", reason: "Not mine" } },
			keys,
		),
		"access_denied",
	);
	assert.equal(listed.active, true);
	const cleared = ok(
		await communicationWriter.requestRestore(
			f.db,
			owner.actor,
			{ requestKey: key(), input: { address: owner.email, reason: "Please send mail again" } },
			keys,
		),
	);
	assert.equal(cleared.suppressionClears, 1);
	assert.equal(cleared.newSends, 0);
	await f.admin.execute(sql`UPDATE mail SET state = 'cancelled' WHERE provider_message_id = 'prov-self'`);
	const repeat = ok(
		await communicationWriter.requestRestore(
			f.db,
			owner.actor,
			{ requestKey: key(), input: { address: owner.email, reason: "Again" } },
			keys,
		),
	);
	assert.equal(repeat.suppressionClears, 0);
	assert.equal(repeat.newSends, 0);
	const row = firstRow(await rows(sql`SELECT state FROM mail WHERE provider_message_id = 'prov-self'`));
	assert.equal(row.state, "cancelled");
	assert.equal(carrier.calls.send, before);
});

test("AC:CASE-NTF-011 a Member reads only their own address's block and still cannot restore it", async () => {
	const blocked = async (address: string) => {
		const event = randomUUID();
		await f.admin
			.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
			VALUES(${event}::uuid,${"seed-" + event},${"seed-" + event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
		await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
			VALUES(${createHmac("sha256", keys.addressKey).update(address).digest("hex")},'hard_bounce',${event}::uuid,clock_timestamp())
			ON CONFLICT (address_hash) DO NOTHING`);
	};
	await blocked(member.email.trim().toLowerCase());
	await blocked("someone-else@example.test");
	const own = ok(await communicationWriter.listForSelf(f.db, member.actor, { address: member.email }, keys));
	assert.deepEqual(
		[own.address, own.active, own.restores, own.suppressionClears, own.newSends],
		[member.email.trim().toLowerCase(), true, [], 0, 0],
	);
	for (const address of ["someone-else@example.test", owner.email])
		refused(await communicationWriter.listForSelf(f.db, member.actor, { address }, keys), "access_denied");
	refused(
		await communicationWriter.requestRestore(
			f.db,
			member.actor,
			{ requestKey: key(), input: { address: member.email, reason: "Please send mail again" } },
			keys,
		),
		"access_denied",
	);
	const still = firstRow(
		await rows(
			sql`SELECT cleared_at IS NULL AS active FROM suppression WHERE address_hash = ${createHmac("sha256", keys.addressKey).update(member.email.trim().toLowerCase()).digest("hex")}`,
		),
	);
	assert.equal(still.active, true);
});

test("AC:CASE-NTF-013 AC:NOTIFY47-003 a password reset, an invitation and a Discovery receipt go out with every category email off, a blocked address gets none, and no log, audit or stored mail shows the token", async () => {
	const c = caseOf("NOTIFY47-003");
	const input = c.action.arguments as {
		purpose: "password_reset";
		category_email: boolean;
		address_suppressed: boolean;
	};
	assert.deepEqual(input, {
		category_email: false,
		purpose: "password_reset",
		address_suppressed: false,
	});
	const invited = await f.setup();
	const seatless = await f.account();
	const inAppOnly = new Set(["wiki_upstream_review", "scheduled_email_unsubscribe"]);
	const emailed = notificationCategory.options.filter((name) => !inAppOnly.has(name));
	const off = async (account: string) => {
		for (const category of emailed)
			await f.admin
				.execute(sql`INSERT INTO notification_preference (id, account_id, category, channel, enabled, unsubscribe_revision)
				VALUES (${randomUUID()}, ${account}, ${category}, 'email', ${input.category_email}, 1)
				ON CONFLICT (account_id, category, channel) DO UPDATE SET enabled = excluded.enabled`);
	};
	for (const account of [owner.id, invited.recipient.id, seatless.id]) await off(account);
	const token = "reset-token-value-0123456789";
	const address = `reset-${key().slice(0, 8)}@example.test`;
	const carrier = port({
		async send() {
			return { outcome: "unknown" };
		},
	});
	const seen: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug"] as const;
	const originals = methods.map((name) => [name, console[name]] as const);
	for (const name of methods) {
		console[name] = (...args: unknown[]) => {
			seen.push(args.map((item) => String(item)).join(" "));
		};
	}
	try {
		const result = ok(
			await communicationWriter.sendTransactional(
				f.db,
				owner.actor,
				{ requestKey: key(), input: { purpose: input.purpose, token, address } },
				carrier,
				keys,
			),
		);
		assert.equal(carrier.calls.send === 1, c.expected.result.security_mail_eligible);
		assert.equal(result.purposeMailAttempted, true);
		assert.equal(result.deliveryStatus, "unknown");
		assert.equal(result.sentAt, null);
		assert.equal(JSON.stringify(result).includes(token), false);
		assert.equal(JSON.stringify(result).includes(address), false);
		const audits = await rows<{
			text: string;
			meta: string;
		}>(sql`SELECT after_value::text AS text, metadata::text AS meta FROM audit_event
			WHERE actor_id = ${owner.id} AND action = 'communication.send_intended' AND after_value->>'purpose' = 'password_reset'`);
		assert.ok(audits.length >= 1);
		for (const audit of audits) {
			assert.equal(audit.text.includes(token), false);
			assert.equal(audit.text.includes(address), false);
			assert.equal(audit.meta.includes(token), false);
		}
		assert.equal(
			seen.some((line) => line.includes(token) || line.includes(address)),
			false,
		);
		assert.equal(carrier.calls.send, 1);
		const stored = await rows(
			sql`SELECT row_to_json(m)::text AS text FROM mail m WHERE m.purpose='password_reset' AND m.recipient_account_id=${owner.id}`,
		);
		assert.ok(stored.length >= 1);
		assert.equal(
			stored.some((row) => String(row.text).includes(token) || String(row.text).includes(address)),
			false,
			"the stored mail is sealed",
		);
		await suppress("blocked-reset@example.test");
		const blocked = ok(
			await communicationWriter.sendTransactional(
				f.db,
				owner.actor,
				{
					requestKey: key(),
					input: { purpose: input.purpose, token, address: "blocked-reset@example.test" },
				},
				carrier,
				keys,
			),
		);
		assert.deepEqual([blocked.deliveryStatus, carrier.calls.send], ["refused", 1], "a blocked address gets no mail");

		const { proof } = await f.invitation(invited);
		assert.equal(
			f.effects.filter((e) => e.to === invited.recipient.email).length,
			1,
			"an invitation goes out with every category off",
		);
		const receipts: string[] = [];
		const mail = createMailService({
			db: f.db,
			encryptionKey: keys.encryptionKey,
			addressKey: keys.addressKey,
			from: keys.from,
			authorize: async (_tx, list) => new Set(list.map((m) => m.id)),
			transport: {
				async send(payload) {
					receipts.push(payload.to);
					return { kind: "accepted", id: randomUUID() };
				},
				lookup: async () => ({ kind: "unknown" }),
			},
		});
		const receipt = async (occurrence: string) => {
			await gatedTransaction(f.db, (tx) =>
				sendDiscoveryAssociationReceipt(tx, mail, {
					organization: other.id,
					account: seatless.id,
					occurrence,
					operation: randomUUID(),
					content: { subject: "Association accepted", text: "Your association was accepted." },
					address: async (_tx, accounts) => new Map(accounts.map((id) => [id, seatless.email])),
					now: c.clock.now,
					verifyOccurrence: async () => true,
				}),
			);
			for (const claim of await claimDue(f.db, ["mail"], 100)) await mail.dispatch(claim);
		};
		await receipt("accepted");
		assert.deepEqual(receipts, [seatless.email], "the seatless account's one receipt goes out with every category off");
		await suppress(seatless.email);
		await receipt("changed");
		assert.deepEqual(receipts, [seatless.email], "and stops for a blocked address");
		const logged = JSON.stringify([
			seen,
			await rows(sql`SELECT to_jsonb(a)::text AS text FROM audit_event a`),
			await rows(sql`SELECT to_jsonb(m)::text AS text FROM mail m`),
			await rows(sql`SELECT to_jsonb(j)::text AS text FROM job j`),
		]);
		for (const secretText of [token, proof])
			assert.equal(logged.includes(secretText), c.expected.result.token_in_logs !== null);
	} finally {
		for (const [name, fn] of originals) console[name] = fn;
	}
});

test("AC:AUDIT-007 AC:SCHEMA-013 runtime cannot change the audit log and mail states stay the stored names", async () => {
	const made = await scheduled("Audit", `audit-${key().slice(0, 8)}@example.test`, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-audit"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	const delivered = await resendWebhook(signed("prov-audit", "delivered"), () => f.db, secret);
	assert.equal(delivered.status, 200);
	const mail = firstRow(
		await rows(sql`SELECT id, state, delivered_at FROM mail WHERE provider_message_id = 'prov-audit'`),
	);
	assert.ok(mail.delivered_at);
	const before = (await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${mail.id}`))[0]!.n;
	await assert.rejects(() =>
		f.db.execute(sql`UPDATE audit_event SET reason = 'changed' WHERE subject_id = ${mail.id}`),
	);
	await assert.rejects(() => f.db.execute(sql`DELETE FROM audit_event WHERE subject_id = ${mail.id}`));
	await assert.rejects(() =>
		f.db.execute(sql`INSERT INTO audit_event (tenant_id, system_cause, action, kind, subject_id, metadata)
			VALUES (${plant.id}, 'provider_callback', 'not-an-action', 'outcome', ${mail.id}, '{}'::jsonb)`),
	);
	const afterMail = firstRow(await rows(sql`SELECT state, delivered_at FROM mail WHERE id = ${mail.id}`));
	assert.equal(afterMail.state, mail.state);
	assert.ok(afterMail.delivered_at);
	const after = (await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${mail.id}`))[0]!.n;
	assert.equal(after, before);
	const dupes = (
		await rows(sql`SELECT count(*)::int AS n FROM (
		SELECT event_key FROM audit_event WHERE subject_id = ${mail.id} AND event_key IS NOT NULL
		GROUP BY event_key HAVING count(*) > 1) d`)
	)[0]!.n;
	assert.equal(dupes, 0);
	const defs = firstRow(
		await rows<{ text: string }>(sql`SELECT string_agg(pg_get_constraintdef(oid), ' ') AS text
		FROM pg_constraint WHERE conrelid IN ('mail'::regclass, 'job'::regclass) AND contype = 'c'`),
	);
	assert.equal(defs.text.includes("'blocked_unknown'"), false);
	assert.equal(defs.text.includes("'completed'"), false);
	assert.equal(defs.text.includes("'ready'"), true);
	assert.equal(defs.text.includes("'succeeded'"), true);
	assert.equal(defs.text.includes("'reconcile'"), true);
});

test("AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-RETIRE AC:TEN-004 a changed email and a closed seat leave the sent mail alone", async () => {
	const email = `frozen-${key().slice(0, 8)}@example.test`;
	const made = await scheduled("Frozen", email, AT);
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-frozen"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, ok(made.accepted).revision, carrier));
	const before = firstRow(
		await rows(sql`SELECT payload_hash, frozen_payload FROM mail WHERE provider_message_id = 'prov-frozen'`),
	);
	await f.admin.execute(sql`UPDATE person SET email = ${"moved-" + email} WHERE id = ${made.personId}`);
	const afterRow = firstRow(
		await rows(sql`SELECT payload_hash, frozen_payload FROM mail WHERE provider_message_id = 'prov-frozen'`),
	);
	assert.equal(afterRow.payload_hash, before.payload_hash);
	assert.equal(JSON.stringify(afterRow.frozen_payload), JSON.stringify(before.frozen_payload));

	const account = await f.account();
	const seatId = await f.seat(account, plant, "admin");
	const who = { ...account, actor: await f.actor(account.session) };
	const secondEmail = `seat-${key().slice(0, 8)}@example.test`;
	const personId = await person("Seat", { email: secondEmail });
	const saved = ok(
		await write(who, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Seat",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: [personId] },
			},
		}),
	);
	const accepted = ok(
		await write(who, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: AT },
		}),
	);
	const seatPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-seat"] };
		},
	});
	const done = ok(await handoff(who, saved.communicationId, accepted.revision, seatPort));
	assert.equal(done.status, "accepted");
	const count = async () =>
		(
			await rows(
				sql`SELECT count(*)::int AS n FROM mail WHERE logical_key LIKE ${"communication/" + saved.communicationId + "/%"}`,
			)
		)[0]!.n;
	assert.equal(await count(), 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE id = ${seatId}`);
	const blocked = await handoff(who, saved.communicationId, accepted.revision, seatPort);
	assert.equal(blocked.status, "refused");
	assert.equal(blocked.error.code, "access_denied");
	assert.equal(await count(), 1);
	assert.equal(seatPort.calls.send, 1);
});

test("INV-plain-text: the text part reads like the message: Tom & Ann, never &amp;, and each mail row names its message", async () => {
	const tom = await person("Tom", { email: "tom-text@example.test" });
	const saved = ok(
		await write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Dinner",
				bodyHtml: "<p>Dinner with Tom &amp; Ann, 6 &lt; 7.</p>",
				audience: { ...emptyAudience, personIds: [tom] },
			},
		}),
	);
	assert.equal(saved.bodyText, "Dinner with Tom & Ann, 6 < 7.");
	const stored = (await rows(sql`SELECT body_text FROM communication WHERE id = ${saved.communicationId}`))[0]!;
	assert.equal(stored.body_text, "Dinner with Tom & Ann, 6 < 7.");
	const accepted = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: AT },
		}),
	);
	const texts: string[] = [];
	const carrier = port({
		async send(batch) {
			texts.push(...batch.messages.map((message) => message.text));
			return { outcome: "ids", ids: batch.messages.map(() => "prov-tom-text") };
		},
	});
	ok(await handoff(owner, saved.communicationId, accepted.revision, carrier));
	assert.equal(texts.length, 1);
	assert.ok(texts[0]!.includes("Dinner with Tom & Ann, 6 < 7."), texts[0]);
	assert.equal(texts[0]!.includes("&amp;"), false, texts[0]);
	const linked = await rows(
		sql`SELECT communication_id FROM mail WHERE logical_key LIKE ${"communication/" + saved.communicationId + "/%"}`,
	);
	assert.deepEqual(
		linked.map((row) => row.communication_id),
		[saved.communicationId],
	);
});

test("AC:DEL58-006 a plant pending deletion hands off, replaces and cancels nothing, then sends once the witness is gone", async () => {
	const made = await scheduled("Wren", "wren-witness@example.test", AT);
	const revision = ok(made.accepted).revision;
	const id = made.saved.communicationId;
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-witness"] };
		},
	});
	const witness = randomUUID();
	await f.admin.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_revision,state,
		witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until) VALUES(${witness},'plant',${plant.id},${plant.id},1,
		'pending_deletion',1,'not_started',${randomUUID()},statement_timestamp(),statement_timestamp()+interval '720 hours')`);
	try {
		refused(await handoff(owner, id, revision, carrier), "access_denied");
		refused(
			await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
				requestKey: key(),
				expectedRevision: revision,
				input: { communicationId: id },
			}),
			"access_denied",
		);
		refused(
			await communicationWriter.cancelScheduledReviewed(
				f.db,
				owner.actor,
				{ requestKey: key(), expectedRevision: revision, input: { communicationId: id } },
				carrier,
			),
			"access_denied",
		);
		assert.equal(carrier.calls.send, 0);
		assert.equal((await mailFor(id)).length, 0);
	} finally {
		await f.admin.execute(sql`DELETE FROM lifecycle_witness WHERE id=${witness}`);
	}
	ok(await handoff(owner, id, revision, carrier));
	assert.equal(carrier.calls.send, 1);
});
