import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, ok } from "../../support/fixture.mts";
import { authorityOf, church, reads, type Reply } from "./people-support.mts";
import type { WriteContext } from "../../../packages/domain/src/people/core.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	accountPersonProducer,
	peopleWriter as people,
	personFields as fields,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { guestsWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const database = await fixture({ prefix: "t672", clock: new Date("2026-10-13T16:00:00Z") });
const { admin } = database;
const db = database.pools.runtime;
const plant = database.tenant;
const owner = database.actors.admin;
after(async () => {
	await database.close();
});

const CANARY = {
	name: "Zephyrine Canaryfield",
	renamed: "Zephyrine Q Canaryfield",
	email: "zephyrine.canary@example.test",
	phone: "555 0199 7311",
	street: "77 Canaryfield Lane",
	city: "Canaryville",
	household: "Canaryfield Nest",
	renamedHousehold: "Canaryfield Roost",
	guardian: "Orrin Canaryfield",
	child: "Wren Canaryfield",
	note: "Canary note body about a private matter",
	edited: "Canary note body corrected",
	guest: "Plover Canaryguest",
	guestEmail: "plover.canary@example.test",
	linked: "Linnet Canarylink",
	linkedEmail: "linnet.canary@example.test",
};

const key = () => randomUUID();
const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
const write = async <T,>(body: (t: WriteTx, c: WriteContext) => Promise<Reply<T>>) =>
	ok(await withPeopleWrite(db, await tx((t) => authorityOf(t, owner)), body));
const revisionOf = async (id: string) =>
	(await admin.execute<{ r: string }>(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`)).rows[0]!.r;
const create = async (input: Record<string, unknown>) =>
	(await write((t, c) => people.createPerson(t, c, { requestKey: key(), input }))).person;
const leaks = async () =>
	(
		await admin.execute<{ action: string; leaked: string }>(sql`SELECT a.action, c.value AS leaked
			FROM audit_event a CROSS JOIN unnest(${sql.param(Object.values(CANARY))}::text[]) c(value)
			WHERE a.tenant_id=${sql.param(plant.id)} AND strpos(lower(concat_ws(' ', a.before_value::text,
				a.after_value::text, a.metadata::text, a.reason)), lower(c.value))>0 ORDER BY a.action, c.value`)
	).rows;

test("people.created and people.updated audit rows hold no name, contact, address, household name or note text", async () => {
	const person = await create({
		displayName: CANARY.name,
		email: CANARY.email,
		phone: CANARY.phone,
		street: CANARY.street,
		city: CANARY.city,
		adultClassification: "adult",
	});
	await write((t, c) =>
		people.updatePerson(t, c, {
			requestKey: key(),
			expectedRevision: person.revision,
			input: {
				personId: person.id,
				patch: { displayName: CANARY.renamed, email: null, phone: null, street: null, city: CANARY.street },
			},
		}),
	);

	const revision1 = await revisionOf(person.id);
	const added = await write((t, c) =>
		people.addNote(t, c, {
			requestKey: key(),
			expectedRevision: revision1,
			input: { personId: person.id, body: CANARY.note },
		}),
	);
	const edited = await write((t, c) =>
		people.editNote(t, c, {
			requestKey: key(),
			expectedRevision: added.revision,
			input: { personId: person.id, noteId: added.noteId, body: CANARY.edited, reason: "Correction" },
		}),
	);
	await write((t, c) =>
		people.deleteNote(t, c, {
			requestKey: key(),
			expectedRevision: edited.revision,
			input: { personId: person.id, noteId: added.noteId, reason: "Removed" },
		}),
	);

	const guardian = await create({ displayName: CANARY.guardian, adultClassification: "adult" });
	const child = await create({ displayName: CANARY.child, adultClassification: "child" });
	const revision2 = await revisionOf(guardian.id);
	const home = await write((t, c) =>
		fields.createHouseholdWithHead(t, c, {
			requestKey: key(),
			expectedRevision: revision2,
			input: { name: CANARY.household, street: CANARY.street, city: CANARY.city, headPersonId: guardian.id },
		}),
	);
	assert.equal(home.result.status, "available");
	const householdId = home.result.status === "available" ? home.result.household.id : "";
	for (const [member, role] of [
		[child, "child"],
		[person, "other"],
	] as const) {
		const expectedRevision = await revisionOf(member.id);
		await write((t, c) =>
			fields.addToHousehold(t, c, {
				requestKey: key(),
				expectedRevision,
				input: { householdId, personId: member.id, role },
			}),
		);
	}
	const revision3 = await revisionOf(child.id);
	await write((t, c) =>
		fields.setGuardianContact(t, c, {
			requestKey: key(),
			expectedRevision: revision3,
			input: { personId: child.id, guardianPersonId: guardian.id, contact: true },
		}),
	);
	const householdRevision = async () =>
		(await admin.execute<{ r: string }>(sql`SELECT revision::text r FROM household WHERE id=${sql.param(householdId)}`))
			.rows[0]!.r;
	const revision4 = await householdRevision();
	await write((t, c) =>
		fields.updateHousehold(t, c, {
			requestKey: key(),
			expectedRevision: revision4,
			input: { householdId, patch: { name: CANARY.renamedHousehold, street: CANARY.renamed } },
		}),
	);
	const members = (
		await admin.execute<{ personId: string; revision: string }>(sql`SELECT id AS "personId",revision::text AS revision
			FROM person WHERE household_id=${sql.param(householdId)} ORDER BY id`)
	).rows;
	const householdAt = await householdRevision();
	await write((t, c) =>
		fields.propagateAddress(t, c, {
			requestKey: key(),
			expectedRevision: householdAt,
			input: { householdId, members },
		}),
	);
	const revision5 = await revisionOf(person.id);
	await write((t, c) =>
		fields.setHouseholdRole(t, c, {
			requestKey: key(),
			expectedRevision: revision5,
			input: { personId: person.id, role: "spouse" },
		}),
	);
	const revision6 = await revisionOf(child.id);
	await write((t, c) =>
		fields.setGuardianContact(t, c, {
			requestKey: key(),
			expectedRevision: revision6,
			input: { personId: child.id, guardianPersonId: guardian.id, contact: false },
		}),
	);
	const revision7 = await revisionOf(person.id);
	await write((t, c) =>
		fields.removeFromHousehold(t, c, {
			requestKey: key(),
			expectedRevision: revision7,
			input: { personId: person.id },
		}),
	);

	const meetingId = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${meetingId},${plant.id},'vision_meeting',NULL,'2026-10-01','18:00',
		'America/Chicago','2026-10-01T23:00:00Z','1','in_progress',1)`);
	const authority = await authorityOf(db, owner);
	ok(
		await withMeetingsWrite(db, authority, (t, c) =>
			guestsWriter.addGuests(t, c, {
				requestKey: key(),
				input: { meetingId, contacts: [{ displayName: CANARY.guest, email: CANARY.guestEmail, phone: CANARY.phone }] },
			}),
		),
	);
	ok(
		await withMeetingsWrite(db, authority, (t, c) =>
			guestsWriter.createGuestContact(t, c, {
				requestKey: key(),
				input: { meetingId, displayName: CANARY.guest, email: CANARY.guestEmail, phone: CANARY.phone },
			}),
		),
	);

	const reviewed = await database.actor(null, "owner", { email: CANARY.linkedEmail });
	const contact = await create({ displayName: CANARY.linked, email: CANARY.linkedEmail, phone: CANARY.phone });
	ok(
		await tx((t) =>
			accountPersonProducer.ensureAccountPerson(t, {
				accountId: reviewed.id as never,
				owner: church(plant.id),
				selection: {
					kind: "reviewed_contact",
					person: { owner: church(plant.id), personId: contact.id, revision: contact.revision },
				} as never,
			}),
		),
	);
	const fresh = await database.actor(null);
	ok(
		await tx((t) =>
			accountPersonProducer.ensureAccountPerson(t, {
				accountId: fresh.id as never,
				owner: church(plant.id),
				selection: { kind: "first", displayName: CANARY.linked },
			}),
		),
	);

	assert.deepEqual(await leaks(), []);

	const rows = (
		await admin.execute<{ action: string; before_value: unknown; after_value: unknown; metadata: unknown }>(
			sql`SELECT action,before_value,after_value,metadata FROM audit_event
				WHERE tenant_id=${sql.param(plant.id)} AND subject_id=${sql.param(person.id)} ORDER BY occurred_at,id`,
		)
	).rows;
	assert.deepEqual(
		rows.map((r) => [r.action, r.before_value, r.after_value]),
		[
			["people.created", null, { stage: "prospect" }],
			["people.updated", {}, { fields: ["city", "display_name", "email", "phone", "street"] }],
			["people.updated", null, null],
			["people.updated", null, null],
			["people.updated", null, null],
			["people.updated", { membership: null }, { membership: { householdId, role: "other" } }],
			[
				"people.updated",
				{ membership: { householdId, role: "other" } },
				{ membership: { householdId, role: "spouse" } },
			],
			["people.updated", { membership: { householdId, role: "spouse" } }, { membership: null }],
		],
		"a new key on person reaches audit only as a changed field name",
	);
	assert.deepEqual(
		rows.slice(2, 5).map((r) => r.metadata),
		[
			{ category: "note", noteId: added.noteId },
			{ category: "note", noteId: added.noteId, correction: true },
			{ category: "note", noteId: added.noteId, correction: true },
		],
	);

	const history = ok(
		await tx((t) =>
			reads.getActivities(t, { session: owner.session, selected: church(plant.id) }, { personId: child.id }),
		),
	);
	assert.deepEqual(
		history.items.flatMap((i) =>
			i.kind === "activity" && i.guardian ? [[i.guardian.change, i.guardian.displayName]] : [],
		),
		[
			["removed", CANARY.guardian],
			["added", CANARY.guardian],
		],
		"guardian names in history come from the current Person row",
	);
	const moves = ok(
		await tx((t) =>
			reads.getActivities(t, { session: owner.session, selected: church(plant.id) }, { personId: person.id }),
		),
	);
	assert.deepEqual(
		moves.items.flatMap((i) =>
			i.kind === "activity" && i.household ? [[i.household.from?.name ?? null, i.household.to?.name ?? null]] : [],
		),
		[
			[CANARY.renamedHousehold, null],
			[CANARY.renamedHousehold, CANARY.renamedHousehold],
			[null, CANARY.renamedHousehold],
		],
		"household names in history come from the current household row",
	);
});
