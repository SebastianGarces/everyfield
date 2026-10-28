// WP-027/ui read changes: the recipient search rule (Task 14), named audience recipients and the history times.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import { addressAad, mailAddressHash, sealText } from "../../../packages/domain/src/communication/delivery.ts";

let f, plant, owner;
const keys = { encryptionKey: Buffer.alloc(32, 7), addressKey: Buffer.alloc(32, 9), from: "news@example.test" };
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
		ok(await read("readRecipients", { query })).people.map((p) => p.displayName).sort();
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
	await f.admin.execute(sql`INSERT INTO mail (id, tenant_id, recipient_person_id, recipient_address_encrypted, purpose, logical_key,
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
