// WP-027/ui read changes: the recipient search rule (Task 14), named audience recipients and the history times.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter, withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { chainSendNow } from "../../../apps/web/src/features/communication/sendNowChain.ts";
import { addressAad, mailAddressHash, sealText } from "../../../packages/domain/src/communication/delivery.ts";

let f, plant, owner;
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const read = (op, input, deliveryKeys) =>
	f.db.transaction((tx) => communicationWriter[op](tx, owner.actor, input, deliveryKeys));

async function person(name, email) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant.id},${plant.id},${name},${email},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
async function message(state, patch = {}) {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO communication (id, plant_id, author_id, revision, state, subject, body_html, body_text, audience, scheduled_at)
		VALUES(${id},${plant.id},${owner.id},1,${state},${patch.subject ?? "Hello"},'<p>Hello</p>','Hello',
		'{"groups":[],"teamIds":[],"personIds":[]}'::jsonb, ${patch.scheduledAt ?? null}::timestamptz)`);
	return id;
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	const account = await f.account();
	await f.seat(account, plant, "owner");
	owner = { ...account, actor: await f.actor(account.session) };
	const id = await person("Olivia Owner", "olivia@aud.test");
	await f.admin.execute(sql`UPDATE person SET linked_account_id = ${owner.id}::uuid WHERE id = ${id}::uuid`);
});
after(() => f?.close());

test("AC:CASE-COM-004 recipient search matches word prefixes of the name and the email local part, never the domain", async () => {
	await person("Sara Nunez", "sara.nunez@example.test");
	await person("Sebastian Garces", "sgarces@example.test");
	await person("Maria Santos", "maria@example.test");
	await person("Aisha Bello", "aisha@example.test");
	await person("Chloe Bennett", "chloe@example.test");
	const names = async (query) =>
		ok(await read("readRecipients", { query }))
			.people.map((p) => p.displayName)
			.sort();
	assert.deepEqual(await names("s"), ["Maria Santos", "Sara Nunez", "Sebastian Garces"]);
	assert.deepEqual(await names("maria s"), ["Maria Santos"]);
	assert.deepEqual(await names("test"), []);
	assert.deepEqual(await names("NUNEZ"), ["Sara Nunez"]);
	assert.deepEqual(await names("ez"), []);
	const none = await person("Pat NoMail", null);
	const found = ok(await read("readRecipients", { query: "NoMail" })).people;
	assert.deepEqual(found, [{ id: none, displayName: "Pat NoMail", email: null }]);
});

test("AC:CASE-COM-004 audience returns named reachable recipients, capped at 200", async () => {
	const ids = [];
	for (let i = 0; i < 3; i += 1) ids.push(await person(`Named ${String(i).padStart(3, "0")}`, `named${i}@aud.test`));
	const silent = await person("Named Silent", null);
	const result = ok(await read("readAudience", { groups: [], teamIds: [], personIds: [...ids, silent] }));
	assert.deepEqual(
		result.recipients.map((r) => r.displayName),
		["Named 000", "Named 001", "Named 002"],
	);
	assert.equal(result.complete, true);
	assert.deepEqual(result.missingEmailExclusions, ["Named Silent"]);
	const many = [];
	for (let i = 0; i < 205; i += 1) many.push(await person(`Crowd ${String(i).padStart(3, "0")}`, `crowd${i}@aud.test`));
	const big = ok(await read("readAudience", { groups: [], teamIds: [], personIds: many }));
	assert.equal(big.recipients.length, 200);
	assert.equal(big.complete, false);
	assert.equal(big.recipients[0].displayName, "Crowd 000");
});

test("AC:CASE-COM-001 history items and detail carry scheduled time, sent time and sender name", async () => {
	const draft = await message("draft", { subject: "T-draft" });
	const scheduled = await message("scheduled", { subject: "T-scheduled", scheduledAt: "2026-11-02T14:00:00Z" });
	const sent = await message("reviewed", { subject: "T-sent" });
	const target = await person("Receiver", "receiver@aud.test");
	const mailId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO mail (id, tenant_id, recipient_person_id, recipient_address_encrypted, purpose, logical_key,
		payload_hash, audience_hash, frozen_payload, state, address_hash, created_at, sent_at)
		VALUES(${mailId}, ${plant.id}, ${target}, ${sealText(keys.encryptionKey, "receiver@aud.test", addressAad(plant.id, mailId))},
		'communication', ${`communication/${sent}/${target}`}, 'p', 'a', ${JSON.stringify({ v: 1, sealed: "x" })}::jsonb, 'sent',
		${mailAddressHash(keys.addressKey, "receiver@aud.test")}, clock_timestamp(), '2026-11-01T15:00:00Z'::timestamptz)`);
	const page = ok(await read("listHistory", { query: "T-" }));
	const by = (subject) => page.items.find((item) => item.subject === subject);
	assert.equal(by("T-draft").scheduledAt, null);
	assert.equal(by("T-draft").sentAt, null);
	assert.equal(by("T-draft").senderName, "Olivia Owner");
	assert.equal(by("T-scheduled").scheduledAt, "2026-11-02T14:00:00.000Z");
	assert.equal(by("T-scheduled").sentAt, null);
	assert.equal(by("T-sent").sentAt, "2026-11-01T15:00:00.000Z");
	const detail = ok(await read("getDetail", { id: sent }, keys));
	assert.equal(detail.sentAt, "2026-11-01T15:00:00.000Z");
	assert.equal(detail.senderName, "Olivia Owner");
	assert.equal(ok(await read("getDetail", { id: scheduled }, keys)).scheduledAt, "2026-11-02T14:00:00.000Z");
	assert.equal(ok(await read("getDetail", { id: draft }, keys)).sentAt, null);
});

// Send now from a draft chains the existing commands: save and schedule in one transaction, then send the new revision
// with its own request key (chainSendNow in apps/web/src/features/communication/sendNowChain.ts, run by the web action).
function carrier(behavior) {
	const calls = { send: 0 };
	return {
		calls,
		async send() {
			calls.send += 1;
			return behavior();
		},
		async lookup() {
			return { outcome: "unknown" };
		},
		async cancel() {
			return { outcome: "unknown" };
		},
		async reschedule() {
			throw new Error("provider_timeout");
		},
	};
}
/** The real Send now chain with the real commands: save and schedule one transaction, then send. */
function chain(personId, transport, keysFor, sendRevision = (revision) => revision) {
	return chainSendNow({
		schedule: async (at) => {
			const result = await withCommunicationWrite(f.db, owner.actor, async (tx, ctx) => {
				const saved = await communicationWriter.saveDraft(tx, ctx, {
					requestKey: keysFor.save,
					input: {
						subject: "Send now chain",
						bodyHtml: "<p>Hello {{name}}.</p>",
						audience: { groups: [], teamIds: [], personIds: [personId] },
					},
				});
				if (saved.status !== "ok") return saved;
				return communicationWriter.scheduleReviewed(tx, ctx, {
					requestKey: keysFor.schedule,
					expectedRevision: saved.value.revision,
					input: { communicationId: saved.value.communicationId, scheduledAt: at },
				});
			});
			return result.status === "ok" ? result : { status: "refused", code: result.code };
		},
		send: async (revision, communicationId) => {
			const sent = await communicationWriter.sendReviewed(
				f.db,
				owner.actor,
				{ requestKey: keysFor.send, expectedRevision: sendRevision(revision), input: { communicationId } },
				transport,
				keys,
			);
			if (sent.status !== "ok") return { status: "refused", code: sent.code };
			const { status, acceptedCount, rejectedCount, unknownCount } = sent.value;
			return { status: "ok", value: { status, acceptedCount, rejectedCount, unknownCount } };
		},
	});
}
const stateOf = async (id) =>
	(
		await f.admin.execute(
			sql`SELECT state, (SELECT count(*)::int FROM mail m WHERE m.logical_key LIKE 'communication/' || c.id::text || '/%' AND m.state = 'accepted') AS accepted
			FROM communication c WHERE c.id = ${id}::uuid`,
		)
	).rows[0];
const newKeys = () => ({ save: randomUUID(), schedule: randomUUID(), send: randomUUID() });

test("AC:CASE-COM-012 the real Send now chain sends once for a double confirm", async () => {
	const personId = await person("Chain Once", `once-${randomUUID().slice(0, 8)}@example.test`);
	const transport = carrier(async () => ({ outcome: "ids", ids: ["prov-chain"] }));
	const requestKeys = newKeys();
	const once = ok(await chain(personId, transport, requestKeys));
	const twice = ok(await chain(personId, transport, requestKeys));
	assert.equal(transport.calls.send, 1, "one provider send for a double confirm");
	assert.equal(once.sendIssue, null);
	assert.equal(once.report?.acceptedCount, 1);
	assert.equal(twice.communicationId, once.communicationId, "the same request keys find the same message");
	assert.equal((await stateOf(once.communicationId)).accepted, 1);
});

test("AC:CASE-COM-012 a refused send step leaves the message scheduled and names the issue", async () => {
	const personId = await person("Chain Refused", `refused-${randomUUID().slice(0, 8)}@example.test`);
	const transport = carrier(async () => ({ outcome: "ids", ids: ["never"] }));
	// A stale revision on the send step is refused by the domain before any provider call.
	const refused = ok(await chain(personId, transport, newKeys(), () => "999999"));
	assert.equal(refused.report, null);
	assert.notEqual(refused.sendIssue, null);
	assert.equal(transport.calls.send, 0, "no provider call after a refused send");
	const row = await stateOf(refused.communicationId);
	assert.equal(row.state, "scheduled");
	assert.equal(row.accepted, 0);

	// A provider that throws leaves an unknown result, never an acceptance, and the message stays scheduled.
	const personTwo = await person("Chain Down", `down-${randomUUID().slice(0, 8)}@example.test`);
	const down = carrier(async () => {
		throw new Error("provider_down");
	});
	const unknown = ok(await chain(personTwo, down, newKeys()));
	assert.notEqual(unknown.report?.acceptedCount, 1);
	const after = await stateOf(unknown.communicationId);
	assert.equal(after.state, "scheduled");
	assert.equal(after.accepted, 0);
});

test("AC:CASE-COM-001 the church name read returns the plant name through the seat check", async () => {
	await f.admin.execute(sql`UPDATE plant SET name = 'Grace Church' WHERE id = ${plant.id}::uuid`);
	assert.equal(ok(await read("readChurchName")).churchName, "Grace Church");
});
