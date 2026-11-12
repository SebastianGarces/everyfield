// T-228 (REQ-COM-005): a Messages email to more than 100 people goes to all of them. The handoff freezes the audience in
// person-id order as batches of at most 100, each its own mail_request with its own members, request hash, provider key
// and attempt. Send now, the minute runner and reconcile hand off every batch; cancel, time change, replace and the
// counts read every batch; a retry reuses each batch's stored key and frozen bytes. The statement count of each
// operation is the same for 1 batch and for 3: only provider calls grow.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import type { Database } from "../../../packages/db/src/client.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import {
	addressAad,
	openText,
	type DeliveryBatch,
	type DeliveryMessage,
	type DeliveryTransport,
	type ProviderAnswer,
} from "../../../packages/domain/src/communication/delivery.ts";
import { atSendTime } from "./scheduled-support.mts";
import { ok } from "../../support/fixture.mts";

let f, plant, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const DAY = 86_400_000;
const onTheHour = (ms: number) => new Date(Math.ceil(ms / 3_600_000) * 3_600_000).toISOString();
const AT = onTheHour(Date.now() + 7 * DAY);
const LATER = onTheHour(Date.now() + 8 * DAY);
const key = () => randomUUID();
const rows = async (query) => (await f.admin.execute(query)).rows;
const write = (op, input) =>
	withCommunicationWrite(f.db, owner.actor, (tx, ctx) => communicationWriter[op](tx, ctx, input));

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
});
after(() => f?.close());

/** A scheduled message to `n` new live people with an address each. `people` is their ids in person-id order. */
async function message(n: number, tag = "Batch") {
	const created =
		await rows(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		SELECT gen_random_uuid(), ${plant.id}, ${plant.id}, ${tag} || ' ' || i, ${tag.toLowerCase()} || '-' || i || '-' || ${key().slice(0, 8)} || '@example.test',
			'other', 'prospect', 'unknown', 'unknown', 0, 'live', clock_timestamp()
		FROM generate_series(1, ${n}::int) i
		RETURNING id`);
	const ids = created.map((row) => row.id as string);
	const saved = ok(
		await write("saveDraft", {
			requestKey: key(),
			input: {
				subject: "Sunday",
				bodyHtml: "<p>Hello {{name}}.</p>",
				audience: { groups: [], teamIds: [], personIds: ids },
			},
		}),
	);
	const scheduled = ok(
		await write("scheduleReviewed", {
			requestKey: key(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt: AT },
		}),
	);
	return { id: saved.communicationId as string, revision: scheduled.revision as string, people: ids.sort() };
}

type Sent = { key: string; messages: readonly DeliveryMessage[]; scheduledAt: string | null };
/**
 * A fake email service that keeps every call. `answer` decides each send by its 1-based call number; by default it
 * accepts every email with an id made from the key. Like the real one, a lookup of a key it accepted returns those ids.
 */
function carrier(answer?: (call: number, batch: Sent) => DeliveryBatch | Promise<DeliveryBatch>) {
	const sends: Sent[] = [];
	const lookups: string[] = [];
	const cancels: string[][] = [];
	const reschedules: string[][] = [];
	const accepted = new Map<string, DeliveryBatch>();
	const ids = (batch: Sent): DeliveryBatch => ({
		outcome: "ids",
		ids: batch.messages.map((_m, i) => `${batch.key}#${i}`),
	});
	const transport: DeliveryTransport & {
		cancelAnswer?: (id: string) => ProviderAnswer;
	} = {
		async send(batch) {
			sends.push(batch);
			const result = await (answer ? answer(sends.length, batch) : ids(batch));
			if (result.outcome === "ids") accepted.set(batch.key, result);
			return result;
		},
		async lookup(providerKey) {
			lookups.push(providerKey);
			return accepted.get(providerKey) ?? { outcome: "unknown" };
		},
		async cancel(providerIds) {
			cancels.push([...providerIds]);
			return providerIds.map((id) => transport.cancelAnswer?.(id) ?? { outcome: "done" });
		},
		async reschedule(providerIds) {
			reschedules.push([...providerIds]);
			return providerIds.map(() => ({ outcome: "done" }));
		},
	};
	return { transport, sends, lookups, cancels, reschedules, ids };
}

const request = (communicationId: string, revision: string) => ({
	requestKey: key(),
	expectedRevision: revision,
	input: { communicationId },
});
const sendNow = (m, transport, op = "sendReviewed") =>
	communicationWriter[op](f.db, owner.actor, request(m.id, m.revision), transport, keys);

/** The message's frozen requests in batch order (person-id order), each with its members by position. */
async function batchesOf(communicationId: string) {
	const found = await rows(sql`SELECT r.id, r.provider_key, r.request_hash, a.outcome AS attempt,
		jsonb_agg(jsonb_build_object('person', m.recipient_person_id, 'state', m.state, 'provider', m.provider_message_id,
			'refusal', m.refusal, 'id', m.id) ORDER BY mem.position) AS members
		FROM mail m
		JOIN mail_request_member mem ON mem.mail_id = m.id
		JOIN mail_request r ON r.id = mem.request_id
		JOIN mail_attempt a ON a.request_id = r.id AND a.attempt_number = 1
		WHERE m.communication_id = ${communicationId}
		GROUP BY r.id, r.provider_key, r.request_hash, a.outcome
		ORDER BY min(m.recipient_person_id::text)`);
	return found.map((row) => ({
		...row,
		members: (typeof row.members === "string" ? JSON.parse(row.members) : row.members) as {
			person: string;
			state: string;
			provider: string | null;
			refusal: string | null;
			id: string;
		}[],
	}));
}
/** The email the handoff froze for one mail row, as the email service gets it. */
async function frozenEmail(mailId: string) {
	const [row] = await rows(
		sql`SELECT tenant_id, frozen_payload, recipient_address_encrypted FROM mail WHERE id = ${mailId}`,
	);
	const body = JSON.parse(
		openText(keys.encryptionKey, row.frozen_payload.sealed, `${row.tenant_id}/${mailId}/communication`)!,
	);
	return {
		to: openText(keys.encryptionKey, row.recipient_address_encrypted, addressAad(row.tenant_id, mailId)),
		html: body.html,
	};
}
/**
 * Start a Send now whose second provider call never answers, as if the run stopped there, and wait until it is made.
 * A handoff that makes no second call fails here instead of waiting forever.
 */
async function stopAtSecondCall(m, fake: { transport: DeliveryTransport; sends: Sent[] }) {
	const run = sendNow(m, fake.transport).then((reply) => {
		throw new Error(`the handoff finished without a second call: ${JSON.stringify(reply)}`);
	});
	for (let turn = 0; fake.sends.length < 2; turn += 1) {
		if (turn > 10_000) throw new Error(`only ${fake.sends.length} provider call(s)`);
		await Promise.race([run, new Promise((resolve) => setImmediate(resolve))]);
	}
}
const states = (members: { state: string }[]) => [...new Set(members.map((row) => row.state))];

test("T-228 Send now to 250 people freezes 3 batches of 100, 100 and 50 in person-id order, one call each, all accepted", async () => {
	const m = await message(250);
	const fake = carrier();
	const result = ok(await sendNow(m, fake.transport));
	const batches = await batchesOf(m.id);
	assert.deepEqual(
		batches.map((batch) => batch.members.length),
		[100, 100, 50],
	);
	assert.deepEqual(
		batches.flatMap((batch) => batch.members.map((row) => row.person)),
		m.people,
		"the batches are cut from the audience in person-id order",
	);
	assert.equal(new Set(batches.map((batch) => batch.provider_key)).size, 3);
	assert.equal(new Set(batches.map((batch) => batch.request_hash)).size, 3);
	for (const batch of batches) assert.equal(batch.provider_key, `communication/${m.id}/${batch.request_hash}`);
	assert.deepEqual(
		fake.sends.map((call) => [call.key, call.messages.length]),
		batches.map((batch) => [batch.provider_key, batch.members.length]),
	);
	// Each call carries exactly its batch's frozen emails, in member order.
	for (const [index, batch] of batches.entries()) {
		const frozen = await Promise.all(batch.members.map((row) => frozenEmail(row.id)));
		assert.deepEqual(
			fake.sends[index]!.messages.map((sent) => ({ to: sent.to, html: sent.html })),
			frozen,
		);
	}
	assert.deepEqual(states(batches.flatMap((batch) => batch.members)), ["accepted"]);
	assert.deepEqual(
		batches.map((batch) => batch.attempt),
		["accepted", "accepted", "accepted"],
	);
	assert.equal(result.acceptedCount, 250);
	assert.equal(result.providerCalls, 3);
	assert.equal(result.status, "accepted");
	assert.equal(result.confirmedRecipientIds.length, 250);
});

test("T-228 101 people schedule and send to all 101; a scheduled handoff of 101 waits in Everyfield in 2 batches", async () => {
	const now = await message(101, "Over");
	const fake = carrier();
	const sent = ok(await sendNow(now, fake.transport));
	assert.equal(sent.acceptedCount, 101);
	assert.equal(sent.status, "accepted");
	assert.deepEqual(
		fake.sends.map((call) => call.messages.length),
		[100, 1],
	);
	const held = await message(101, "Held");
	const waiting = ok(await sendNow(held, fake.transport, "handOffScheduled"));
	assert.equal(waiting.acceptedCount, 101);
	assert.equal(fake.sends.length, 2, "a scheduled handoff asks the email service nothing");
	const batches = await batchesOf(held.id);
	assert.deepEqual(
		batches.map((batch) => [batch.members.length, states(batch.members)]),
		[
			[100, ["scheduled"]],
			[1, ["scheduled"]],
		],
	);
});

test("T-228 the minute runner hands off a scheduled 250-person message one batch per claim and refuses the person who unsubscribed", async () => {
	const m = await message(250, "Runner");
	const fake = carrier();
	ok(await sendNow(m, fake.transport, "handOffScheduled"));
	const before = await batchesOf(m.id);
	const optedOut = before[1]!.members[37]!;
	await f.admin.execute(
		sql`INSERT INTO person_email_opt_out (plant_id, person_id) VALUES (${plant.id}, ${optedOut.person})`,
	);
	const frozen = new Map<string, { to: string | null; html: string }>();
	for (const row of before.flatMap((batch) => batch.members)) frozen.set(row.id, await frozenEmail(row.id));
	const handled = await atSendTime(f.admin, f.db as Database, m.id, fake.transport, keys);
	assert.equal(handled, 3, "one claim per batch");
	assert.deepEqual(
		fake.sends.map((call) => [call.key, call.messages.length]).sort(),
		[
			[before[0]!.provider_key, 100],
			[before[1]!.provider_key, 99],
			[before[2]!.provider_key, 50],
		].sort(),
	);
	for (const batch of before) {
		const call = fake.sends.find((sent) => sent.key === batch.provider_key)!;
		const expected = batch.members.filter((row) => row.id !== optedOut.id).map((row) => frozen.get(row.id));
		assert.deepEqual(
			call.messages.map((sent) => ({ to: sent.to, html: sent.html })),
			expected,
			"each batch goes under its own frozen key and bytes",
		);
	}
	const after = (await batchesOf(m.id)).flatMap((batch) => batch.members);
	const refused = after.filter((row) => row.state === "refused");
	assert.deepEqual(
		refused.map((row) => [row.id, row.refusal]),
		[[optedOut.id, "unsubscribed"]],
	);
	assert.equal(after.filter((row) => row.state === "accepted").length, 249);
});

test("T-228 a lost second batch leaves only its 100 recipients unknown; the others keep their ids and totals count every batch", async () => {
	for (const lose of ["unknown", "throw"] as const) {
		const m = await message(250, "Lost");
		const fake = carrier((call, batch) => {
			if (call !== 2) return fake.ids(batch);
			if (lose === "throw") throw new Error("provider down");
			return { outcome: "unknown" };
		});
		const result = ok(await sendNow(m, fake.transport));
		assert.equal(fake.sends.length, 3, "a lost batch does not stop the batches after it");
		const batches = await batchesOf(m.id);
		assert.deepEqual(
			batches.map((batch) => states(batch.members)),
			[["accepted"], ["unknown"], ["accepted"]],
		);
		assert.deepEqual(
			batches[0]!.members.map((row) => row.provider),
			batches[0]!.members.map((_row, i) => `${batches[0]!.provider_key}#${i}`),
		);
		assert.ok(batches[1]!.members.every((row) => row.provider === null));
		assert.deepEqual([result.acceptedCount, result.unknownCount, result.rejectedCount], [150, 100, 0]);
		assert.equal(result.status, lose === "throw" ? "accepted_unknown" : "partial");
		assert.equal(result.failed, false);
		const totals = ok(
			await f.db.transaction((tx) => communicationWriter.getDeliveryTotals(tx, owner.actor, { communicationId: m.id })),
		);
		assert.deepEqual(
			{ selected: totals.selected, accepted: totals.accepted, unknown: totals.unknown },
			{ selected: 250, accepted: 150, unknown: 100 },
		);
	}
});

test("T-228 a retry reuses every batch's stored key and frozen bytes: a stopped run resumes, an unknown batch is only looked up, an expired one never resent", async () => {
	const m = await message(250, "Resume");
	// The run stops after the first batch: the second call never answers, so nothing of this run is stored.
	const stopped = carrier((call, batch) => (call === 1 ? stopped.ids(batch) : new Promise<DeliveryBatch>(() => {})));
	await stopAtSecondCall(m, stopped);
	const frozen = await batchesOf(m.id);
	assert.deepEqual(
		frozen.map((batch) => states(batch.members)),
		[["dispatched"], ["dispatched"], ["dispatched"]],
	);
	// The retry hands off every batch under the key and bytes frozen the first time; the email service's idempotency
	// on that key answers the first batch with the ids it already gave, so nobody gets it twice.
	const retry = carrier();
	const resumed = ok(await sendNow(m, retry.transport, "dispatchAttempt"));
	assert.deepEqual(
		retry.sends.map((call) => call.key),
		frozen.map((batch) => batch.provider_key),
	);
	assert.deepEqual(retry.sends[0]!.messages, stopped.sends[0]!.messages);
	assert.deepEqual(retry.sends[1]!.messages, stopped.sends[1]!.messages);
	assert.equal(resumed.acceptedCount, 250);
	const afterRetry = await batchesOf(m.id);
	assert.deepEqual(
		afterRetry.map((batch) => [batch.id, batch.provider_key, batch.request_hash]),
		frozen.map((batch) => [batch.id, batch.provider_key, batch.request_hash]),
		"never regrouped, re-frozen or given a new key",
	);
	// Every batch is answered now: another retry sends nothing and asks nothing.
	const quiet = carrier();
	ok(await sendNow(m, quiet.transport, "dispatchAttempt"));
	assert.deepEqual([quiet.sends.length, quiet.lookups.length], [0, 0]);

	// A batch answered with unknown is reconciled by its own key, and the answered batches are not sent again.
	const u = await message(250, "Reconcile");
	const lossy = carrier((call, batch) => (call === 2 ? { outcome: "unknown" } : lossy.ids(batch)));
	ok(await sendNow(u, lossy.transport));
	const uBatches = await batchesOf(u.id);
	const reconcile = carrier();
	const reconciled = ok(await sendNow(u, reconcile.transport, "reconcileProviderOutcome"));
	assert.deepEqual(reconcile.sends, []);
	assert.deepEqual(reconcile.lookups, [uBatches[1]!.provider_key]);
	assert.equal(reconciled.unknownCount, 100);

	// Past the 23 h 55 min window from first handoff, a batch never answered is only looked up, never resent.
	const late = await message(250, "Late");
	const lateStop = carrier((call, batch) => (call === 1 ? lateStop.ids(batch) : new Promise<DeliveryBatch>(() => {})));
	await stopAtSecondCall(late, lateStop);
	await f.admin
		.execute(sql`UPDATE mail_request r SET first_dispatched_at = clock_timestamp() - interval '23 hours 56 minutes'
		FROM mail_request_member mem JOIN mail m ON m.id = mem.mail_id
		WHERE mem.request_id = r.id AND m.communication_id = ${late.id}`);
	const expired = carrier();
	ok(await sendNow(late, expired.transport, "dispatchAttempt"));
	assert.deepEqual(expired.sends, []);
	assert.deepEqual(
		expired.lookups,
		(await batchesOf(late.id)).map((batch) => batch.provider_key),
	);
});

/** Make `count` recipients of a batch held at the email service with the old send time, as before T-241. */
async function holdAtProvider(members: { id: string }[], tag: string) {
	const held = members.map((row, i) => ({ id: row.id, provider: `${tag}-${i}` }));
	await f.admin
		.execute(sql`UPDATE mail m SET state = 'accepted', provider_message_id = x.provider, accepted_at = clock_timestamp()
		FROM jsonb_to_recordset(${JSON.stringify(held)}::jsonb) AS x(id uuid, provider text) WHERE m.id = x.id`);
	return held.map((row) => row.provider);
}

test("T-228 cancel and replace read every batch: waiting recipients cancel at once, held ones by their own ids", async () => {
	const m = await message(250, "Cancel");
	const fake = carrier();
	ok(await sendNow(m, fake.transport, "handOffScheduled"));
	const batches = await batchesOf(m.id);
	const first = await holdAtProvider(batches[0]!.members.slice(0, 3), "first");
	const third = await holdAtProvider(batches[2]!.members.slice(0, 2), "third");
	const cancel = () =>
		communicationWriter.cancelScheduledReviewed(f.db, owner.actor, request(m.id, m.revision), fake.transport);
	const replace = () => communicationWriter.replaceScheduledReviewed(f.db, owner.actor, request(m.id, m.revision));
	assert.equal(ok(await replace()).replacementAllowed, false);
	fake.transport.cancelAnswer = (id) => ({ outcome: id.startsWith("third") ? "unknown" : "done" });
	const partly = ok(await cancel());
	assert.deepEqual(fake.cancels, [[...first, ...third]], "one call for the held recipients of every batch");
	assert.deepEqual(
		[partly.confirmedCount, partly.sentCount, partly.openCount, partly.scheduledCancel],
		[248, 0, 2, "reconcile"],
	);
	assert.equal(ok(await replace()).replacementAllowed, false, "a batch still holds a recipient");
	fake.transport.cancelAnswer = (id) => ({ outcome: id === "third-1" ? "sent" : "done" });
	const done = ok(await cancel());
	assert.deepEqual(fake.cancels[1], third, "the next check asks only about the recipients still open");
	assert.deepEqual([done.confirmedCount, done.sentCount, done.openCount], [249, 1, 0]);
	const after = (await batchesOf(m.id)).flatMap((batch) => batch.members);
	assert.deepEqual(
		[after.filter((row) => row.state === "cancelled").length, after.filter((row) => row.state === "sent").length],
		[249, 1],
	);
	assert.equal(fake.sends.length, 0);

	// Replace is allowed once no batch holds anyone and nothing went out.
	const clean = await message(250, "Replace");
	ok(await sendNow(clean, fake.transport, "handOffScheduled"));
	await holdAtProvider((await batchesOf(clean.id))[1]!.members.slice(0, 1), "second");
	fake.transport.cancelAnswer = () => ({ outcome: "done" });
	const cancelled = ok(
		await communicationWriter.cancelScheduledReviewed(
			f.db,
			owner.actor,
			request(clean.id, clean.revision),
			fake.transport,
		),
	);
	assert.deepEqual([cancelled.confirmedCount, cancelled.openCount], [250, 0]);
	assert.equal(
		ok(await communicationWriter.replaceScheduledReviewed(f.db, owner.actor, request(clean.id, clean.revision)))
			.replacementAllowed,
		true,
	);
});

test("T-228 a time change moves the waiting recipients of every batch and the held ones by their own ids", async () => {
	const m = await message(250, "Move");
	const fake = carrier();
	ok(await sendNow(m, fake.transport, "handOffScheduled"));
	const batches = await batchesOf(m.id);
	const held = [
		...(await holdAtProvider(batches[1]!.members.slice(0, 2), "second")),
		...(await holdAtProvider(batches[2]!.members.slice(0, 1), "third")),
	];
	const moved = ok(
		await communicationWriter.rescheduleDispatched(
			f.db,
			owner.actor,
			{ requestKey: key(), expectedRevision: m.revision, input: { communicationId: m.id, scheduledAt: LATER } },
			fake.transport,
		),
	);
	assert.deepEqual(fake.reschedules, [held]);
	assert.deepEqual(
		[moved.rescheduleStatus, moved.confirmedCount, moved.sentCount, moved.openCount],
		["accepted", 250, 0, 0],
	);
	const times =
		await rows(sql`SELECT DISTINCT to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
		FROM mail WHERE communication_id = ${m.id}`);
	assert.deepEqual(
		times.map((row) => row.at),
		[LATER],
	);
});

/** The database a delivery operation is given, counting the statements it sends. */
function counting(db: Database) {
	const counter = { n: 0 };
	const wrapped = new Proxy(db, {
		get(target, property) {
			if (property === "execute")
				return (...args: unknown[]) => {
					counter.n += 1;
					return (target.execute as (...a: unknown[]) => unknown)(...args);
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: wrapped as Database, counter };
}

test("T-228 every delivery operation sends as many statements for 3 batches as for 1", async () => {
	async function measure(n: number) {
		const counts: Record<string, number> = {};
		const run = async (name: string, call: (db: Database) => Promise<unknown>) => {
			const { db, counter } = counting(f.db);
			ok(await call(db));
			counts[name] = counter.n;
		};
		// Send now with every batch answered unknown, then a retry and a reconcile that look each batch up.
		const now = await message(n, "Census");
		const lost = carrier(() => ({ outcome: "unknown" }));
		const call = (op: string, m) => (db: Database) =>
			communicationWriter[op](db, owner.actor, request(m.id, m.revision), lost.transport, keys);
		await run("sendReviewed", call("sendReviewed", now));
		await run("dispatchAttempt", call("dispatchAttempt", now));
		await run("reconcileProviderOutcome", call("reconcileProviderOutcome", now));
		assert.equal(lost.sends.length, Math.ceil(n / 100));
		// A scheduled handoff with one held recipient in the last batch, then a time change, a cancel and a replace.
		const held = await message(n, "Held");
		await run("handOffScheduled", call("handOffScheduled", held));
		const batches = await batchesOf(held.id);
		await holdAtProvider(batches.at(-1)!.members.slice(0, 1), `census-${n}`);
		await run("rescheduleDispatched", (db) =>
			communicationWriter.rescheduleDispatched(
				db,
				owner.actor,
				{ requestKey: key(), expectedRevision: held.revision, input: { communicationId: held.id, scheduledAt: LATER } },
				lost.transport,
			),
		);
		const [{ revision }] = await rows(sql`SELECT revision::text AS revision FROM communication WHERE id = ${held.id}`);
		await run("cancelScheduledReviewed", (db) =>
			communicationWriter.cancelScheduledReviewed(db, owner.actor, request(held.id, revision), lost.transport),
		);
		await run("replaceScheduledReviewed", (db) =>
			communicationWriter.replaceScheduledReviewed(db, owner.actor, request(held.id, revision)),
		);
		return counts;
	}
	const one = await measure(3);
	const three = await measure(250);
	assert.deepEqual(three, one);
	assert.deepEqual(one, {
		sendReviewed: 4,
		dispatchAttempt: 3,
		reconcileProviderOutcome: 3,
		handOffScheduled: 3,
		rescheduleDispatched: 3,
		cancelScheduledReviewed: 3,
		replaceScheduledReviewed: 1,
	});
});
