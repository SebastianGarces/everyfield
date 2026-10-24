import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { GET, POST, resendWebhook } from "../../../apps/web/src/app/api/webhooks/resend/route.ts";

let f, plant, other, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
};
const emptyAudience = { groups: [], teamIds: [], personIds: [] };
const key = () => randomUUID();
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const rows = async (query) => (await f.admin.execute(query)).rows;
const write = (who, op, input) =>
	withCommunicationWrite(f.db, who.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));
const day = 86_400_000;

async function person(name, fields = {}) {
	const id = randomUUID();
	const plantId = fields.plant ?? plant.id;
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plantId},${plantId},${name},${fields.email ?? null},'other','prospect','unknown','unknown',0,
		${fields.state ?? "live"},clock_timestamp())`);
	return id;
}
async function scheduled(name, email, at, extraIds = []) {
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
function port(behavior) {
	const calls = { send: 0, lookup: 0, cancel: 0, reschedule: 0 };
	return {
		calls,
		async send(batch) {
			calls.send += 1;
			return behavior.send(batch, calls);
		},
		async lookup(providerKey) {
			calls.lookup += 1;
			return behavior.lookup(providerKey, calls);
		},
		async cancel() {
			calls.cancel += 1;
			return behavior.cancel ? behavior.cancel() : { outcome: "unknown" };
		},
		async reschedule() {
			calls.reschedule += 1;
			if (behavior.reschedule) return behavior.reschedule();
			throw new Error("provider_timeout");
		},
	};
}
const handoff = (who, communicationId, revision, carrier, op = "dispatchAttempt") =>
	communicationWriter[op](
		f.db,
		who.actor,
		{ requestKey: key(), expectedRevision: revision, input: { communicationId } },
		carrier,
		keys,
	);
const secret = "whsec_" + randomBytes(32).toString("base64");
function signed(messageId, kind, eventKey = randomUUID(), bounce, createdAt = new Date().toISOString()) {
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
async function mailFor(communicationId) {
	return rows(sql`SELECT m.state, m.payload_hash, m.provider_message_id, m.logical_key, m.job_id,
		r.provider_key, r.first_dispatched_at, a.outcome
		FROM mail m
		LEFT JOIN mail_request_member mem ON mem.mail_id = m.id
		LEFT JOIN mail_request r ON r.id = mem.request_id
		LEFT JOIN mail_attempt a ON a.request_id = r.id AND a.attempt_number = 1
		WHERE m.logical_key LIKE ${"communication/" + communicationId + "/%"}
		ORDER BY mem.position`);
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	other = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

test("AC:GAP-COM-012 AC:MAIL51-002 AC:MAIL51-003 reviewed handoff sends once and refuses a stale or late schedule", async () => {
	const guest = await person("Alex", { email: "alex-window@example.test" });
	const draft = (subject) =>
		write(owner, "saveDraft", {
			requestKey: key(),
			input: { subject, bodyHtml: "<p>Welcome Alex.</p>", audience: { ...emptyAudience, personIds: [guest] } },
		});
	const late = ok(await draft("Late"));
	const past = refused(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: late.revision,
			input: { communicationId: late.communicationId, scheduledAt: new Date(Date.now() - day).toISOString() },
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
			input: { communicationId: welcome.communicationId, scheduledAt: "2026-11-11T16:00:00.000Z" },
		}),
	);
	assert.equal(accepted.scheduleSent, false);
	assert.equal(accepted.draftIntents, 0);
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-welcome"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-welcome"] };
		},
	});
	const sent = ok(await handoff(owner, welcome.communicationId, accepted.revision, carrier));
	assert.equal(sent.providerCalls, 1);
	assert.equal(sent.sentAt, null);
	assert.equal(sent.replayedWithNewKeys, 0);
	assert.equal(carrier.calls.send, 1);
	const [body] = await rows(sql`SELECT body_text FROM communication WHERE id = ${welcome.communicationId}`);
	assert.equal(body.body_text, "Welcome Alex.");
	await f.admin.execute(sql`UPDATE person SET email = 'alex-moved@example.test' WHERE id = ${guest}`);
	const staleDraft = ok(await draft("Stale"));
	const staleSchedule = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: staleDraft.revision,
			input: { communicationId: staleDraft.communicationId, scheduledAt: "2026-11-11T16:00:00.000Z" },
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
			input: { communicationId: saved.communicationId, scheduledAt: "2026-11-11T16:00:00.000Z" },
		}),
	);
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-0"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-0"] };
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
	assert.equal(carrier.calls.send, 1);
	assert.equal(again.providerCalls, 0);
	assert.equal(again.unknownCount, 99);
	assert.deepEqual(again.confirmedRecipientIds, [sorted[0]]);
	const stored = await mailFor(saved.communicationId);
	assert.equal(stored.length, 100);
	assert.equal(stored.filter((row) => row.state === "accepted").length, 1);
	assert.equal(stored[0].job_id, null);

	const refusedPair = await scheduled(
		"Refused",
		`refused-${key().slice(0, 8)}@example.test`,
		"2026-11-11T16:00:00.000Z",
	);
	assert.equal(refusedPair.accepted.status, "ok", JSON.stringify(refusedPair.accepted));
	const denyPort = port({
		async send() {
			return { outcome: "refused" };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	const failed = ok(
		await handoff(
			owner,
			refusedPair.saved.communicationId,
			refusedPair.accepted.value.revision,
			denyPort,
			"sendReviewed",
		),
	);
	assert.equal(failed.failed, true);
	assert.equal(failed.acceptedCount, 0);
	assert.equal(failed.sentAt, null);
	assert.equal(failed.status, "failed");
	assert.equal(failed.communicationId, refusedPair.saved.communicationId);

	const unknownPair = await scheduled(
		"Unknown",
		`unknown-${key().slice(0, 8)}@example.test`,
		"2026-11-11T16:00:00.000Z",
	);
	const lost = port({
		async send() {
			return { outcome: "unknown" };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	const uncertain = ok(
		await handoff(owner, unknownPair.saved.communicationId, unknownPair.accepted.value.revision, lost, "sendReviewed"),
	);
	assert.equal(uncertain.uncertain, true);
	assert.equal(uncertain.failed, false);
	assert.equal(uncertain.status, "uncertain");
	assert.equal(uncertain.unknownCount, 1);
});

test("AC:MAIL-LEDGER-001 a crashed send stays in flight and the next call looks up the same key", async () => {
	const made = await scheduled("Crash", `crash-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			throw new Error("provider down");
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	const first = ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	assert.equal(first.status, "accepted_unknown");
	assert.equal(first.providerCalls, 1);
	assert.equal(carrier.calls.send, 1);
	const mid = await mailFor(made.saved.communicationId);
	assert.equal(mid.length, 1);
	assert.equal(new Set(mid.map((row) => row.provider_key)).size, 1);
	assert.equal(mid[0].outcome, "in_flight");
	assert.equal(mid[0].state, "dispatched");
	const second = ok(
		await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier, "reconcileProviderOutcome"),
	);
	assert.equal(carrier.calls.send, 1);
	assert.equal(carrier.calls.lookup, 1);
	assert.equal(second.providerCalls, 0);
	assert.equal(second.replayedWithNewKeys, 0);
	const after = await mailFor(made.saved.communicationId);
	assert.equal(after.length, 1);
});

test("AC:MAIL-KEYWINDOW-001 replay after the provider window looks up and a foreign person sends nothing", async () => {
	const made = await scheduled("Window", `window-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "unknown" };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	const first = ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	assert.equal(first.negativeEvidenceRequired, true);
	assert.equal(first.automaticReplayAllowed, false);
	assert.equal(first.firstDispatchClockReset, false);
	assert.equal(first.crossScopeBatchAllowed, false);
	for (const hours of ["23 hours 50 minutes", "23 hours 56 minutes"]) {
		await f.admin.execute(sql`UPDATE mail_request r SET first_dispatched_at = clock_timestamp() - ${hours}::interval
			FROM mail m JOIN mail_request_member mem ON mem.mail_id = m.id
			WHERE mem.request_id = r.id AND m.logical_key LIKE ${"communication/" + made.saved.communicationId + "/%"}`);
		const [before] = await rows(sql`SELECT r.first_dispatched_at FROM mail_request r
			JOIN mail_request_member mem ON mem.request_id = r.id
			JOIN mail m ON m.id = mem.mail_id
			WHERE m.logical_key LIKE ${"communication/" + made.saved.communicationId + "/%"}`);
		const again = ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
		assert.equal(again.automaticReplayAllowed, false);
		assert.equal(again.firstDispatchClockReset, false);
		assert.equal(again.providerCalls, 0);
		const [afterClock] = await rows(sql`SELECT r.first_dispatched_at FROM mail_request r
			JOIN mail_request_member mem ON mem.request_id = r.id
			JOIN mail m ON m.id = mem.mail_id
			WHERE m.logical_key LIKE ${"communication/" + made.saved.communicationId + "/%"}`);
		assert.equal(
			new Date(afterClock.first_dispatched_at).toISOString(),
			new Date(before.first_dispatched_at).toISOString(),
		);
	}
	assert.equal(carrier.calls.send, 1);
	assert.equal(carrier.calls.lookup, 2);
	const local = await person("Local", { email: `local-${key().slice(0, 8)}@example.test` });
	const outsider = await person("Outsider", { email: `out-${key().slice(0, 8)}@example.test`, plant: other.id });
	const mixed = ok(
		await write(owner, "saveDraft", {
			requestKey: key(),
			input: {
				subject: "Mixed",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { ...emptyAudience, personIds: [local, outsider] },
			},
		}),
	);
	const mixedSchedule = ok(
		await write(owner, "scheduleReviewed", {
			requestKey: key(),
			expectedRevision: mixed.revision,
			input: { communicationId: mixed.communicationId, scheduledAt: "2026-11-11T16:00:00.000Z" },
		}),
	);
	const denied = refused(await handoff(owner, mixed.communicationId, mixedSchedule.revision, carrier), "access_denied");
	assert.deepEqual(denied.details, {});
	assert.equal(Object.hasOwn(denied.details, "foreignManifest"), false);
	assert.equal((await mailFor(mixed.communicationId)).length, 0);
	assert.equal(carrier.calls.send, 1);
});

test("AC:DEL58-006 AC:MAIL51-004 AC:MAIL51-005 AC:MAIL51-007 cancel, replace, and reschedule do not send a new message", async () => {
	const made = await scheduled("Cancel", `cancel-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-cancel"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-cancel"] };
		},
		cancel() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	const sends = carrier.calls.send;
	const cancelled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: made.accepted.value.revision,
				input: { communicationId: made.saved.communicationId, signedUrlExpires: "2026-10-13T16:05:00.000Z" },
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

	const sentOne = await scheduled("Sent", `sent-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(sentOne.accepted.status, "ok");
	ok(await handoff(owner, sentOne.saved.communicationId, sentOne.accepted.value.revision, carrier));
	await f.admin.execute(sql`UPDATE mail SET state = 'sent', sent_at = clock_timestamp()
		WHERE logical_key LIKE ${"communication/" + sentOne.saved.communicationId + "/%"}`);
	const recalled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: sentOne.accepted.value.revision,
				input: { communicationId: sentOne.saved.communicationId, signedUrlExpires: "2026-10-13T16:05:00.000Z" },
			},
			carrier,
		),
	);
	assert.equal(recalled.sentRecalled, false);
	assert.equal(recalled.newSend, false);
	const [stillSent] = await rows(
		sql`SELECT state FROM mail WHERE logical_key LIKE ${"communication/" + sentOne.saved.communicationId + "/%"}`,
	);
	assert.equal(stillSent.state, "sent");
	const sentReplace = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: sentOne.accepted.value.revision,
			input: { communicationId: sentOne.saved.communicationId },
		}),
	);
	assert.equal(sentReplace.replacementAllowed, false);
	assert.equal(sentReplace.replacementIntents, 0);
	assert.equal(sentReplace.blindResends, 0);

	const unknownOne = await scheduled("Hold", `hold-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	const unknownPort = port({
		async send() {
			return { outcome: "unknown" };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, unknownOne.saved.communicationId, unknownOne.accepted.value.revision, unknownPort));
	const unknownReplace = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: unknownOne.accepted.value.revision,
			input: { communicationId: unknownOne.saved.communicationId },
		}),
	);
	assert.equal(unknownReplace.replacementAllowed, false);
	assert.equal(unknownReplace.blindResends, 0);

	const drop = await scheduled("Drop", `drop-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	const confirmPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-drop"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-drop"] };
		},
		cancel() {
			return { outcome: "cancelled" };
		},
	});
	ok(await handoff(owner, drop.saved.communicationId, drop.accepted.value.revision, confirmPort));
	ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: drop.accepted.value.revision,
				input: { communicationId: drop.saved.communicationId },
			},
			confirmPort,
		),
	);
	const replaced = ok(
		await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, {
			requestKey: key(),
			expectedRevision: drop.accepted.value.revision,
			input: { communicationId: drop.saved.communicationId },
		}),
	);
	assert.equal(replaced.replacementAllowed, true);
	assert.equal(replaced.replacementIntents, 0);
	assert.equal(replaced.blindResends, 0);
	assert.equal(confirmPort.calls.send, 1);

	const move = await scheduled("Move", `move-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	const movePort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-move"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-move"] };
		},
	});
	ok(await handoff(owner, move.saved.communicationId, move.accepted.value.revision, movePort));
	const beforeCount = (await rows(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`))[0].n;
	const moved = ok(
		await communicationWriter.rescheduleDispatched(
			f.db,
			owner.actor,
			{
				requestKey: key(),
				expectedRevision: move.accepted.value.revision,
				input: { communicationId: move.saved.communicationId, scheduledAt: "2026-11-12T16:00:00.000Z" },
			},
			movePort,
		),
	);
	assert.equal(moved.body, "Welcome Alex.");
	assert.equal(moved.rescheduleStatus, "unknown");
	assert.equal(moved.newCommunications, 0);
	assert.equal(movePort.calls.send, 1);
	const [kept] = await rows(sql`SELECT body_html FROM communication WHERE id = ${move.saved.communicationId}`);
	assert.equal(kept.body_html, "<p>Welcome Alex.</p>");
	const afterCount = (await rows(sql`SELECT count(*)::int AS n FROM communication WHERE plant_id = ${plant.id}`))[0].n;
	assert.equal(afterCount, beforeCount);
});

test("AC:CASE-NTF-010 AC:SEC-09 AC:SEC-06 AC:NOTIFY47-008 callbacks record one outcome and a bad signature writes nothing", async () => {
	const made = await scheduled("Callback", `callback-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-callback"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-callback"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	const events = async () =>
		(await rows(sql`SELECT count(*)::int AS n FROM provider_event WHERE message_id = 'prov-callback'`))[0].n;
	const suppressions = async () => (await rows(sql`SELECT count(*)::int AS n FROM suppression`))[0].n;
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
	const got = await GET();
	assert.equal(got.status, 405);
	assert.equal((await got.json()).code, "method_not_allowed");
	assert.equal(await events(), beforeEvents);
	assert.equal(await suppressions(), beforeSuppress);
	if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
	else process.env.RESEND_WEBHOOK_SECRET = previousSecret;

	const eventKey = randomUUID();
	const createdAt = "2026-10-24T12:00:00.000Z";
	const delivered = await resendWebhook(
		signed("prov-callback", "delivered", eventKey, undefined, createdAt),
		() => f.db,
		secret,
	);
	assert.equal(delivered.status, 200);
	const accepted = await resendWebhook(signed("prov-callback", "accepted"), () => f.db, secret);
	assert.equal(accepted.status, 200);
	const duplicate = await resendWebhook(
		signed("prov-callback", "delivered", eventKey, undefined, createdAt),
		() => f.db,
		secret,
	);
	assert.equal((await duplicate.json()).result, "duplicate");
	assert.equal(await events(), 2);
	const [mail] = await rows(
		sql`SELECT state, delivered_at, accepted_at FROM mail WHERE provider_message_id = 'prov-callback'`,
	);
	assert.notEqual(mail.state, "accepted");
	assert.ok(mail.delivered_at);
	const again = ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	assert.equal(again.providerCalls, 0);
	assert.equal(carrier.calls.send, 1);

	const soft = await scheduled("Soft", `soft-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	const softPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-soft"] };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, soft.saved.communicationId, soft.accepted.value.revision, softPort));
	const hash = createHmac("sha256", keys.addressKey).update(soft.email.trim().toLowerCase()).digest("hex");
	const active = async () =>
		(await rows(sql`SELECT count(*)::int AS n FROM suppression WHERE address_hash = ${hash} AND cleared_at IS NULL`))[0]
			.n;
	await resendWebhook(signed("prov-soft", "bounced", randomUUID(), { type: "Transient" }), () => f.db, secret);
	assert.equal(await active(), 0);
	await resendWebhook(signed("prov-soft", "bounced", randomUUID(), { type: "Permanent" }), () => f.db, secret);
	assert.equal(await active(), 1);
});

test("AC:CASE-NTF-011 a person clears only their own suppressed address", async () => {
	const made = await scheduled("Self", owner.email, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-self"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-self"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
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
	const [row] = await rows(sql`SELECT state FROM mail WHERE provider_message_id = 'prov-self'`);
	assert.equal(row.state, "cancelled");
	assert.equal(carrier.calls.send, before);
});

test("AC:CASE-NTF-013 AC:NOTIFY47-003 a password reset sends with category email off and hides the token", async () => {
	await f.admin
		.execute(sql`INSERT INTO notification_preference (id, account_id, category, channel, enabled, unsubscribe_revision)
		VALUES (${randomUUID()}, ${owner.id}, 'meeting_announcement', 'email', false, 1)
		ON CONFLICT (account_id, category, channel) DO UPDATE SET enabled = false`);
	const token = "reset-token-value-0123456789";
	const address = `reset-${key().slice(0, 8)}@example.test`;
	const carrier = port({
		async send() {
			return { outcome: "unknown" };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	const seen = [];
	const methods = ["log", "info", "warn", "error", "debug"];
	const originals = new Map(methods.map((name) => [name, console[name]]));
	for (const name of methods) {
		console[name] = (...args) => {
			seen.push(args.map((item) => String(item)).join(" "));
		};
	}
	try {
		const result = ok(
			await communicationWriter.sendTransactional(
				f.db,
				owner.actor,
				{ requestKey: key(), input: { purpose: "password_reset", token, address } },
				carrier,
				keys,
			),
		);
		assert.equal(result.purposeMailAttempted, true);
		assert.equal(result.deliveryStatus, "unknown");
		assert.equal(result.sentAt, null);
		assert.equal(JSON.stringify(result).includes(token), false);
		assert.equal(JSON.stringify(result).includes(address), false);
		const audits = await rows(sql`SELECT after_value::text AS text, metadata::text AS meta FROM audit_event
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
	} finally {
		for (const [name, fn] of originals) console[name] = fn;
	}
});

test("AC:AUDIT-007 AC:SCHEMA-013 runtime cannot change the audit log and mail states stay the stored names", async () => {
	const made = await scheduled("Audit", `audit-${key().slice(0, 8)}@example.test`, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-audit"] };
		},
		async lookup() {
			return { outcome: "unknown" };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	const delivered = await resendWebhook(signed("prov-audit", "delivered"), () => f.db, secret);
	assert.equal(delivered.status, 200);
	const [mail] = await rows(sql`SELECT id, state, delivered_at FROM mail WHERE provider_message_id = 'prov-audit'`);
	assert.ok(mail.delivered_at);
	const before = (await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${mail.id}`))[0].n;
	await assert.rejects(() =>
		f.db.execute(sql`UPDATE audit_event SET reason = 'changed' WHERE subject_id = ${mail.id}`),
	);
	await assert.rejects(() => f.db.execute(sql`DELETE FROM audit_event WHERE subject_id = ${mail.id}`));
	await assert.rejects(() =>
		f.db.execute(sql`INSERT INTO audit_event (tenant_id, system_cause, action, kind, subject_id, metadata)
			VALUES (${plant.id}, 'provider_callback', 'not-an-action', 'outcome', ${mail.id}, '{}'::jsonb)`),
	);
	const [afterMail] = await rows(sql`SELECT state, delivered_at FROM mail WHERE id = ${mail.id}`);
	assert.equal(afterMail.state, mail.state);
	assert.ok(afterMail.delivered_at);
	const after = (await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id = ${mail.id}`))[0].n;
	assert.equal(after, before);
	const dupes = (
		await rows(sql`SELECT count(*)::int AS n FROM (
		SELECT event_key FROM audit_event WHERE subject_id = ${mail.id} AND event_key IS NOT NULL
		GROUP BY event_key HAVING count(*) > 1) d`)
	)[0].n;
	assert.equal(dupes, 0);
	const [defs] = await rows(sql`SELECT string_agg(pg_get_constraintdef(oid), ' ') AS text
		FROM pg_constraint WHERE conrelid IN ('mail'::regclass, 'job'::regclass) AND contype = 'c'`);
	assert.equal(defs.text.includes("'blocked_unknown'"), false);
	assert.equal(defs.text.includes("'completed'"), false);
	assert.equal(defs.text.includes("'ready'"), true);
	assert.equal(defs.text.includes("'succeeded'"), true);
	assert.equal(defs.text.includes("'reconcile'"), true);
});

test("AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-RETIRE AC:TEN-004 a changed email and a closed seat leave the sent mail alone", async () => {
	const email = `frozen-${key().slice(0, 8)}@example.test`;
	const made = await scheduled("Frozen", email, "2026-11-11T16:00:00.000Z");
	assert.equal(made.accepted.status, "ok");
	const carrier = port({
		async send() {
			return { outcome: "ids", ids: ["prov-frozen"] };
		},
		async lookup() {
			return { outcome: "ids", ids: ["prov-frozen"] };
		},
	});
	ok(await handoff(owner, made.saved.communicationId, made.accepted.value.revision, carrier));
	const [before] = await rows(
		sql`SELECT payload_hash, frozen_payload FROM mail WHERE provider_message_id = 'prov-frozen'`,
	);
	await f.admin.execute(sql`UPDATE person SET email = ${"moved-" + email} WHERE id = ${made.personId}`);
	const [afterRow] = await rows(
		sql`SELECT payload_hash, frozen_payload FROM mail WHERE provider_message_id = 'prov-frozen'`,
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
			input: { communicationId: saved.communicationId, scheduledAt: "2026-11-11T16:00:00.000Z" },
		}),
	);
	const seatPort = port({
		async send() {
			return { outcome: "ids", ids: ["prov-seat"] };
		},
		async lookup() {
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
		)[0].n;
	assert.equal(await count(), 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at = clock_timestamp() WHERE id = ${seatId}`);
	const blocked = await handoff(who, saved.communicationId, accepted.revision, seatPort);
	assert.equal(blocked.status, "refused");
	assert.equal(blocked.error.code, "access_denied");
	assert.equal(await count(), 1);
	assert.equal(seatPort.calls.send, 1);
	assert.equal(seatPort.calls.lookup, 0);
});
