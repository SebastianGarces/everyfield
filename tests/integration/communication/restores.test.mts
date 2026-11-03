import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";

// REQ-NTF-011 (WP-028): "Your address" lists every earlier restore of the viewer's own blocked address, newest first,
// with the date, who restored it and their reason, in a fixed number of statements.

let f, plant, owner, other;
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

/** A hard bounce blocks the address, as the bounce callback does: a new block or a block again after a restore. */
async function bounce(address) {
	const hash = createHmac("sha256", keys.addressKey).update(address).digest("hex");
	const eventId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${eventId},${"seed-" + eventId},${"seed-" + eventId},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await f.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${hash},'hard_bounce',${eventId},clock_timestamp()) ON CONFLICT(address_hash) DO UPDATE
		SET reason=excluded.reason,source_event_id=excluded.source_event_id,suppressed_at=excluded.suppressed_at,
		cleared_at=NULL,clear_operation_id=NULL,revision=suppression.revision+1`);
}
const restore = async (who, reason) =>
	ok(
		await communicationWriter.requestRestore(
			f.db,
			who.actor,
			{ requestKey: randomUUID(), input: { address: who.email, reason } },
			keys,
		),
	);
/** The read through a database handle that counts its statements. */
async function listed(who) {
	let statements = 0;
	const counted = new Proxy(f.db, {
		get(target, name) {
			const value = Reflect.get(target, name);
			if (name !== "execute") return typeof value === "function" ? value.bind(target) : value;
			return (...args) => {
				statements += 1;
				return value.apply(target, args);
			};
		},
	});
	const value = ok(await communicationWriter.listForSelf(counted, who.actor, { address: who.email }, keys));
	return { value, statements };
}
async function seated(name) {
	const account = await f.account();
	await f.seat(account, plant, name === "Pat Owner" ? "owner" : "admin");
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${randomUUID()},${plant.id},${plant.id},${name},${account.email},'other','prospect','unknown','unknown',0,'live',
		clock_timestamp(),${account.id})`);
	return { ...account, actor: await f.actor(account.session) };
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	owner = await seated("Pat Owner");
	other = await seated("Robin Admin");
});
after(() => f?.close());

test("AC:CASE-NTF-011 Your address lists each past restore of the viewer's own address, newest first, in fixed statements", async () => {
	await bounce(owner.email);
	const none = await listed(owner);
	assert.deepEqual({ active: none.value.active, restores: none.value.restores }, { active: true, restores: [] });

	assert.equal((await restore(owner, "I fixed my mailbox")).suppressionClears, 1);
	await bounce(owner.email);
	assert.equal((await restore(owner, "Inbox full, now cleared")).suppressionClears, 1);
	await bounce(owner.email);
	// Another person's block and restore stay out of this list.
	await bounce(other.email);
	await restore(other, "Robin's own reason");

	const two = await listed(owner);
	assert.equal(two.value.address, owner.email);
	assert.equal(two.value.active, true);
	assert.deepEqual(
		two.value.restores.map(({ actorName, reason }) => ({ actorName, reason })),
		[
			{ actorName: "Pat Owner", reason: "Inbox full, now cleared" },
			{ actorName: "Pat Owner", reason: "I fixed my mailbox" },
		],
	);
	const [newest, oldest] = two.value.restores.map((row) => Date.parse(row.at));
	assert.ok(newest > oldest);
	assert.ok(two.value.restores.every((row) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.at)));
	assert.ok(!JSON.stringify(two.value).includes("Robin"));
	assert.equal(two.statements, none.statements);
	assert.equal(two.statements, 2);

	const theirs = await listed(other);
	assert.deepEqual(
		theirs.value.restores.map(({ actorName, reason }) => ({ actorName, reason })),
		[{ actorName: "Robin Admin", reason: "Robin's own reason" }],
	);
	assert.equal(theirs.value.active, false);
});
