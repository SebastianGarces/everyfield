import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	withMeetingsWrite,
} from "../../../packages/domain/src/meetings/index.ts";
import { readPersonPage } from "../../../packages/domain/src/people/index.ts";
import { ok, refused } from "../../support/fixture.mts";

let f, plant, other, owner, member, foreign;
const attendance = createAttendanceWriter({ reminders: async () => {} });
const add = (input, requestKey = key(), who = owner) =>
	withMeetingsWrite(f.db, who.actor, (tx, ctx) => guestsWriter.addGuests(tx, ctx, { requestKey, input }));
const guestWrite = (op, input, who = owner) =>
	withMeetingsWrite(f.db, who.actor, (tx, ctx) => guestsWriter[op](tx, ctx, input));
const attend = (op, input) => withMeetingsWrite(f.db, owner.actor, (tx, ctx) => attendance[op](tx, ctx, input));
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const key = () => randomUUID();

async function person(name, w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${w.id},${w.id},${name},'other','prospect','unknown',
		'unknown',0,'live',clock_timestamp())`);
	return id;
}
async function meeting(w = plant) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${id},${w.id},'vision_meeting',NULL,'2026-10-01','18:00',
		'America/Chicago','2026-10-01T23:00:00Z','1','in_progress',1)`);
	return id;
}
const revision = async (meetingId) =>
	(await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${meetingId}`)).r;
const stored = (meetingId) =>
	rows(sql`SELECT p.display_name AS name, g.id, g.presence, g.removed_at IS NOT NULL AS removed, g.rsvp,
		g.inviter_person_id AS inviter FROM participation g JOIN person p ON p.id=g.person_id
		WHERE g.meeting_id=${meetingId} ORDER BY p.display_name`);
const peopleCount = async () => (await one(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${plant.id}`)).n;
const guestOf = async (meetingId, personId) =>
	ok(await meetingsReader.listGuests(f.db, owner.actor, { meetingId })).guests.find(
		(g) => g.person.personId === personId,
	);
async function removedWhileAttended(meetingId, personId) {
	ok(await attend("checkIn", { requestKey: key(), input: { meetingId, personId } }));
	const g = await guestOf(meetingId, personId);
	ok(
		await guestWrite("removeGuest", {
			requestKey: key(),
			expectedRevision: g.revision,
			input: { meetingId, personId },
		}),
	);
}

let statements = 0;
before(async () => {
	f = await fixture();
	f.db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			statements++;
			return Reflect.apply(query, this, args);
		};
	});
	plant = await f.workspace();
	other = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id IN (${plant.id},${other.id})`);
	const seated = async (w, role) => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	owner = await seated(plant, "owner");
	member = await seated(plant, "member");
	foreign = await seated(other, "owner");
});
after(() => f?.close());

test("AC:TARGET-MTG-007 AC:TARGET-MTG-011 one write adds People and new contacts, keeps each guest rule and names who was not added", async () => {
	const m = await meeting();
	const [alex, blair, casey, dana, ember] = [
		await person("Alex"),
		await person("Blair"),
		await person("Casey"),
		await person("Dana"),
		await person("Ember"),
	];
	ok(await guestWrite("inviteGuest", { requestKey: key(), input: { meetingId: m, personId: casey } }));
	await removedWhileAttended(m, dana);
	const dana0 = (await stored(m)).find((g) => g.name === "Dana");
	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${ember}`);
	const casey0 = await guestOf(m, casey);
	const attendanceBefore = await revision(m);
	const people0 = await peopleCount();

	const input = {
		meetingId: m,
		people: [alex, ember, casey, dana, blair],
		contacts: [{ displayName: "Mara", email: "mara@example.test" }, { displayName: "Noor" }],
	};
	const requestKey = key();
	const value = ok(await add(input, requestKey));

	assert.equal(value.outcome, "changed");
	assert.deepEqual(value.notAdded, [ember]);
	assert.deepEqual(
		value.guests.map((g) => [g.person.displayName, g.presence, g.rsvp, g.inviter]),
		[
			["Alex", "absent", "pending", null],
			["Casey", "absent", "pending", null],
			["Dana", "attended", "pending", null],
			["Blair", "absent", "pending", null],
			["Mara", "absent", "pending", null],
			["Noor", "absent", "pending", null],
		],
	);
	assert.deepEqual(value.guests[1], casey0);
	assert.equal(value.guests[2].id, dana0.id);
	assert.equal(await revision(m), String(BigInt(attendanceBefore) + 1n));
	assert.equal(value.attendanceRevision, await revision(m));
	assert.deepEqual(
		(await stored(m)).map((g) => [g.name, g.presence, g.removed]),
		[
			["Alex", "absent", false],
			["Blair", "absent", false],
			["Casey", "absent", false],
			["Dana", "attended", false],
			["Mara", "absent", false],
			["Noor", "absent", false],
		],
	);
	const listed = ok(await meetingsReader.listGuests(f.db, owner.actor, { meetingId: m })).guests;
	assert.deepEqual(
		[...listed].sort((a, b) => a.id.localeCompare(b.id)),
		[...value.guests].sort((a, b) => a.id.localeCompare(b.id)),
	);
	const [mara, noor] = value.guests.slice(4).map((g) => g.person.personId);
	assert.deepEqual(
		await rows(sql`SELECT display_name, email, stage, source, adult_classification, linked_account_id
			FROM person WHERE id IN (${mara},${noor}) ORDER BY display_name`),
		[
			{
				display_name: "Mara",
				email: "mara@example.test",
				stage: "prospect",
				source: "meeting_guest_list",
				adult_classification: "unknown",
				linked_account_id: null,
			},
			{
				display_name: "Noor",
				email: null,
				stage: "prospect",
				source: "meeting_guest_list",
				adult_classification: "unknown",
				linked_account_id: null,
			},
		],
	);
	assert.equal(await peopleCount(), people0 + 2);

	const audit = await rows(sql`SELECT action, kind, subject_type, subject_id, before_value, after_value, metadata,
		request_key FROM audit_event WHERE command_id=${value.receiptId} ORDER BY subject_type, subject_id`);
	const command = audit.find((a) => a.subject_type === "meeting");
	assert.deepEqual(
		[command.action, command.kind, command.subject_id, command.request_key],
		["meetings.changed", "edit", m, requestKey],
	);
	assert.deepEqual(command.after_value, {
		guestsInvited: [alex, blair],
		guestsRestored: [dana],
		contactsCreated: [mara, noor],
	});
	assert.deepEqual(command.metadata, { meetingId: m, notAdded: [ember] });
	assert.deepEqual(
		audit
			.filter((a) => a.subject_type === "person")
			.map((a) => [a.action, a.kind, a.subject_id, a.after_value.display_name, a.metadata.meetingId])
			.sort(),
		[
			["people.created", "create", mara, "Mara", m],
			["people.created", "create", noor, "Noor", m],
		].sort(),
	);
	assert.equal(audit.length, 3);
	const page = ok(
		await f.db.transaction((t) =>
			readPersonPage(t, { session: owner.session, selected: { kind: "plant", id: plant.id } }, { personId: mara }, 50),
		),
	);
	assert.deepEqual(
		page.activities.value.items.map((a) => [a.kind, a.action, a.actor.kind]),
		[["activity", "created", "current_account"]],
	);

	const rowsBefore = await stored(m);
	assert.deepEqual(ok(await add(input, requestKey)), value);
	assert.deepEqual(await stored(m), rowsBefore);
	assert.equal(await peopleCount(), people0 + 2);
	assert.equal(await revision(m), value.attendanceRevision);

	const again = ok(await add({ meetingId: m, people: [alex, casey] }));
	assert.equal(again.outcome, "noop");
	assert.deepEqual(
		again.guests.map((g) => g.person.displayName),
		["Alex", "Casey"],
	);
});

test("AC:TARGET-MTG-007 a refusal for the meeting, the seat or the whole list adds nobody", async () => {
	const m = await meeting();
	const [alex, blair] = [await person("Alex"), await person("Blair")];
	const people0 = await peopleCount();
	const input = (meetingId) => ({ meetingId, people: [alex], contacts: [{ displayName: "Orphan" }] });
	refused(await add(input(m), key(), member), "unavailable");
	refused(await add(input(await meeting(other))), "unavailable");
	refused(await add(input(m), key(), foreign), "unavailable");
	const gone = await meeting();
	await f.admin.execute(sql`UPDATE meeting SET retired_at=clock_timestamp() WHERE id=${gone}`);
	refused(await add(input(gone)), "unavailable");
	const archived = await person("Archived");
	await f.admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${archived}`);
	refused(await add({ meetingId: m, people: [await person("Elsewhere", other), archived] }), "invalid_subject");
	refused(await add({ meetingId: m, people: [], contacts: [] }), "invalid_input");
	refused(await add({ meetingId: m, people: [alex, alex] }), "invalid_input");
	assert.deepEqual(await stored(m), []);
	assert.equal(await peopleCount(), people0 + 1, "only the Archived fixture was made");

	await removedWhileAttended(m, blair);
	ok(await attend("checkIn", { requestKey: key(), input: { meetingId: m, personId: alex } }));
	ok(
		await attend("finalizeAttendance", {
			requestKey: key(),
			expectedRevision: await revision(m),
			input: { meetingId: m, attendeeIds: [alex] },
		}),
	);
	const before = await stored(m);
	const people1 = await peopleCount();
	refused(await add({ meetingId: m, people: [blair], contacts: [{ displayName: "Late" }] }), "status_transition");
	assert.deepEqual(await stored(m), before);
	assert.equal(await peopleCount(), people1);
});

test("INV-statements: adding 1 person and adding 6 (some new contacts) send the same statements", async () => {
	const counted = async (input) => {
		const start = statements;
		ok(await add(input));
		return statements - start;
	};
	const oneGuest = await counted({ meetingId: await meeting(), people: [await person("Solo")] });
	const six = await counted({
		meetingId: await meeting(),
		people: [await person("A"), await person("B"), await person("C")],
		contacts: [{ displayName: "D" }, { displayName: "E", phone: "555 0100" }, { displayName: "F" }],
	});
	assert.equal(six, oneGuest);
	assert.ok(oneGuest <= 6, `${oneGuest} statements`);
	const direct = (input, requestKey = key()) =>
		f.db.transaction((t) =>
			guestsWriter.addGuests(
				t,
				{ session: owner.session, selected: { kind: "plant", id: plant.id } },
				{ requestKey, input },
			),
		);
	const m = await meeting();
	const input = { meetingId: m, people: [await person("G")], contacts: [{ displayName: "H" }] };
	const requestKey = key();
	const first = ok(await direct(input, requestKey));
	assert.deepEqual(ok(await direct(input, requestKey)), first);
	assert.equal((await stored(m)).length, 2);
	refused(await direct({ meetingId: await meeting(other), people: [await person("I")] }), "unavailable");
});

test("the operation catalog lists meetings.addGuests as an Owner/Admin command Evry does not offer", async () => {
	const catalog = JSON.parse(readFileSync(new URL("../../../docs/catalog/operations.json", import.meta.url), "utf8"));
	const op = (id) => catalog.operations.find((o) => o.id === id);
	const added = op("meetings.addGuests");
	assert.deepEqual(
		[added.kind, added.feature_ids, added.authority[0].actors, added.evry, added.model_tool],
		["command", ["MTG-007", "MTG-011"], ["plant_owner", "plant_admin"], false, false],
	);
	for (const id of ["meetings.inviteGuest", "meetings.createGuestContact"])
		assert.deepEqual([op(id).evry, op(id).model_tool], [true, true], id);
});
