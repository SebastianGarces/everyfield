import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { guestsWriter, meetingsReader, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { readAvatar } from "../../../packages/domain/src/settings/index.ts";
import { ok } from "../../support/fixture.mts";

// T-274: a meeting's guest list shows each guest's photo as the People list does (REQ-PPL-005, REQ-IDN-006). A live
// guest's own People photo wins; otherwise the photo of the account the guest links to, while that account holds a
// live seat in this church. Everyone else keeps the initials, and the payload names no photo for them.

let f, plant, other, owner, member;
const key = () => randomUUID();
const PNG = Buffer.from("synthetic photo bytes");
const objects = new Map();
/** A private bucket that holds the bytes of every photo this file stores. */
const storage = {
	bucket: "synthetic-only",
	client: {
		send: async (command) => {
			const i = command.input;
			if (command.constructor.name === "GetBucketAclCommand")
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			if (command.constructor.name !== "GetObjectCommand") throw Error("unexpected provider operation");
			const body = objects.get(i.Key);
			return { ContentLength: body.length, ContentType: "image/png", Body: { transformToByteArray: async () => body } };
		},
	},
};

/** A ready private file of `purpose` owned by `tenant`; its id is the photo version. */
async function file(tenant, purpose) {
	const id = randomUUID(),
		opaque = `private/${tenant}/${randomUUID()}`;
	objects.set(opaque, PNG);
	await f.admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,
		sha256,state,upload_key,claim_generation) VALUES(${id},${tenant},${purpose},${opaque},'image/png',${PNG.length},
		${PNG.length},${createHash("sha256").update(PNG).digest("hex")},'ready',${id},0)`);
	return id;
}
/** The account's photo is now a new version, as Settings' finalize leaves it. */
async function setAvatar(a) {
	const versionId = await file(a.id, "avatar");
	await f.admin.execute(sql`UPDATE account SET avatar_object_id=${versionId} WHERE id=${a.id}`);
	return { accountId: a.id, versionId };
}
async function account(w = plant, role = "member") {
	const a = await f.account();
	if (w) await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function person(name, linked = null, w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${id},${w.id},${w.id},${name},'other',
		'prospect','unknown','unknown',0,'live',clock_timestamp(),${linked?.id ?? null})`);
	return id;
}
async function meeting() {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${id},${plant.id},'vision_meeting',NULL,'2026-10-01','18:00',
		'UTC','2026-10-01T23:00:00Z','1','in_progress',1)`);
	return id;
}
const invite = (meetingId, personId) =>
	withMeetingsWrite(f.db, owner.actor, (tx, ctx) =>
		guestsWriter.inviteGuest(tx, ctx, { requestKey: key(), input: { meetingId, personId } }),
	);
/** The guest list as `who` reads it: each guest's name and photo, and the list itself. */
async function photos(meetingId, who = member) {
	const list = ok(await meetingsReader.listGuests(f.db, who.actor, { meetingId }));
	const name = new Map(list.guests.map((g) => [g.person.personId, g.person.displayName]));
	return {
		list,
		byName: Object.fromEntries(list.photos.map((p) => [name.get(p.personId), p.photo])),
	};
}

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	other = await f.workspace();
	owner = await account(plant, "owner");
	member = await account(plant, "member");
});
after(() => f?.close());

test("AC:TARGET-IDN-006: the guest list names the photo each guest shows, and only for live guests seated here", async () => {
	const m = await meeting();
	const holder = await account(),
		bare = await account(),
		ownPhoto = await account(),
		elsewhere = await account(other),
		retiredHolder = await account(),
		mergedHolder = await account();
	const holderPhoto = await setAvatar(holder);
	await setAvatar(ownPhoto);
	await setAvatar(elsewhere);
	await setAvatar(retiredHolder);
	await setAvatar(mergedHolder);
	const guests = {
		Holder: await person("Holder", holder),
		Bare: await person("Bare", bare),
		Unlinked: await person("Unlinked"),
		Own: await person("Own", ownPhoto),
		Elsewhere: await person("Elsewhere", elsewhere),
		Retired: await person("Retired", retiredHolder),
		Merged: await person("Merged", mergedHolder),
	};
	for (const id of Object.values(guests)) ok(await invite(m, id));
	const crm = await file(plant.id, "person_photo");
	await f.admin.execute(sql`UPDATE person SET photo_object_id=${crm} WHERE id=${guests.Own}`);
	// A retired or merged guest stays on the list, with the initials.
	await f.admin.execute(
		sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${guests.Retired}`,
	);
	await f.admin.execute(
		sql`UPDATE person SET state='merged', merged_into_person_id=${guests.Unlinked} WHERE id=${guests.Merged}`,
	);

	const { list, byName } = await photos(m);
	assert.equal(list.guests.length, 7);
	assert.deepEqual(byName, {
		Holder: { kind: "account", ...holderPhoto },
		Own: { kind: "person", personId: guests.Own, versionId: crm },
	});
	// The Owner reads the same photos, and the meeting page's one read carries the same list.
	assert.deepEqual((await photos(m, owner)).byName, byName);
	assert.deepEqual(ok(await meetingsReader.pageGuests(f.db, member.actor, { meetingId: m })).guests, list);
	// Every account photo offered is one the photo route serves this viewer (workspaceAvatar on both sides).
	const served = await readAvatar(
		f.db,
		storage,
		{ session: member.session, selected: { kind: "account", id: member.id } },
		holderPhoto,
	);
	assert.ok(Buffer.from(served).equals(PNG));
	// The payload names photos by person or account and version only: no storage key or bearer URL.
	assert.doesNotMatch(JSON.stringify(list), /private\/|https?:/);
});

test("AC:TARGET-IDN-006: an ended seat, a replaced photo and a removed photo show on the next read", async () => {
	const m = await meeting();
	const holder = await account(),
		leaving = await account();
	const first = await setAvatar(holder);
	await setAvatar(leaving);
	const h = await person("Holder", holder),
		l = await person("Leaving", leaving);
	ok(await invite(m, h));
	ok(await invite(m, l));
	assert.deepEqual(Object.keys((await photos(m)).byName).sort(), ["Holder", "Leaving"]);

	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${leaving.id}`);
	const replaced = await setAvatar(holder);
	assert.notEqual(replaced.versionId, first.versionId);
	assert.deepEqual((await photos(m)).byName, { Holder: { kind: "account", ...replaced } });

	await f.admin.execute(sql`UPDATE account SET avatar_object_id=NULL WHERE id=${holder.id}`);
	assert.deepEqual((await photos(m)).byName, {});
});
