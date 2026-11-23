import { fixture, ok, refused } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	peopleWriter as people,
	peopleReader,
	personFields as fields,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const database = await fixture({ prefix: "t487" });
const { admin } = database;
const db = database.pools.runtime;
const otherChurch = (await database.plant()).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	await database.actor({ kind: "plant", id: otherChurch }, "admin"),
];
const ctx = () => ({ session: actors[0].session, selected: { kind: "plant", id: database.tenant.id } });
const tx = (body) => gatedTransaction(db, body);
const write = async (who, body) =>
	withPeopleWrite(db, await tx((t) => RequestActor.resolve(t, actors[who].session)), body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const revisionOf = async (id) => (await rows(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0].r;
const yearsAgo = (years: number) => `${new Date().getUTCFullYear() - years}-01-15`;

after(async () => {
	await database.close();
});

async function person(name: string, fields: Record<string, unknown> = {}, who = 0) {
	return ok(
		await write(who, async (t, c) =>
			people.createPerson(t, c, { requestKey: key(), input: { displayName: name, ...fields } }),
		),
	).person;
}
async function home(head, ...members: [any, string][]) {
	const created = ok(
		await write(0, async (t, c) =>
			fields.createHouseholdWithHead(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(head.id),
				input: { name: `${head.displayName} household`, headPersonId: head.id },
			}),
		),
	).result;
	for (const [p, role] of members)
		ok(
			await write(0, async (t, c) =>
				fields.addToHousehold(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { householdId: created.household.id, personId: p.id, role },
				}),
			),
		);
	return created.household;
}
const contact = async (child, guardian, on = true, who = 0) =>
	write(who, async (t, c) =>
		fields.setGuardianContact(t, c, {
			requestKey: key(),
			expectedRevision: await revisionOf(child.id),
			input: { personId: child.id, guardianPersonId: guardian.id, contact: on },
		}),
	);
const card = async (child) => ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: child.id })));
const shownContacts = (result, child) =>
	result.guardians
		.filter((link) => link.childPersonId === child.id)
		.map((link) => result.members.find((m) => m.personId === link.guardianPersonId)?.displayName)
		.sort();
const stored = (child) =>
	rows(sql`SELECT count(*)::int n FROM guardian_contact WHERE child_person_id=${sql.param(child.id)}`);
const history = async (child) =>
	ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId: child.id }))).items.filter((i) => i.guardian);

test("AC:CASE-PPL-009-GUARDIAN staff mark an adult in a child's household as the child's parent or guardian contact, and the change is in the child's history", async () => {
	const maria = await person("Maria Lopez", { adultClassification: "adult" });
	const ava = await person("Ava Lopez", { adultClassification: "child" });
	await home(maria, [ava, "child"]);
	const before = await revisionOf(ava.id);

	const saved = ok(await contact(ava, maria));
	assert.equal(saved.outcome, "changed");
	assert.deepEqual(shownContacts(saved.result, ava), ["Maria Lopez"]);
	assert.deepEqual(shownContacts(await card(ava), ava), ["Maria Lopez"]);
	assert.deepEqual(
		(await card(ava)).members.map((m) => [m.displayName, m.adult]),
		[
			["Maria Lopez", "adult"],
			["Ava Lopez", "child"],
		],
	);
	assert.equal(BigInt(await revisionOf(ava.id)), BigInt(before) + 1n);

	const entries = await history(ava);
	assert.deepEqual(
		entries.map((i) => [i.action, i.guardian]),
		[["updated", { change: "added", personId: maria.id, displayName: "Maria Lopez" }]],
	);
	const [audit] = await rows(sql`SELECT before_value, after_value FROM audit_event
		WHERE subject_id=${sql.param(ava.id)} AND after_value ? 'guardian'`);
	assert.deepEqual(audit, {
		before_value: { guardian: null },
		after_value: { guardian: { personId: maria.id, displayName: "Maria Lopez" } },
	});

	const again = ok(await contact(ava, maria));
	assert.equal(again.outcome, "noop", "a repeat add changes nothing");
	assert.deepEqual(await stored(ava), [{ n: 1 }]);
});

test("AC:CASE-PPL-009-GUARDIAN a second adult can be added, and either contact can be removed, leaving the other", async () => {
	const dan = await person("Dan Park", { adultClassification: "adult" });
	const eve = await person("Eve Park", { birthDate: yearsAgo(40) });
	const kai = await person("Kai Park", { birthDate: yearsAgo(9) });
	await home(dan, [eve, "spouse"], [kai, "child"]);

	ok(await contact(kai, dan));
	const both = ok(await contact(kai, eve)).result;
	assert.deepEqual(shownContacts(both, kai), ["Dan Park", "Eve Park"]);

	const removed = ok(await contact(kai, dan, false));
	assert.equal(removed.outcome, "changed");
	assert.deepEqual(shownContacts(removed.result, kai), ["Eve Park"]);
	assert.deepEqual(shownContacts(await card(kai), kai), ["Eve Park"]);
	assert.deepEqual(
		(await history(kai)).map((i) => [i.guardian.change, i.guardian.displayName]),
		[
			["removed", "Dan Park"],
			["added", "Eve Park"],
			["added", "Dan Park"],
		],
	);
	assert.equal(ok(await contact(kai, dan, false)).outcome, "noop");
});

test("AC:CASE-PPL-009-GUARDIAN a contact who is not marked as an adult, outside the household, retired or in another church is refused and nothing is stored", async () => {
	const gus = await person("Gus Hale", { adultClassification: "adult" });
	const liv = await person("Liv Hale", { adultClassification: "child" });
	const kid = await person("Mo Hale", { adultClassification: "child" });
	const unknown = await person("Pat Hale");
	const young = await person("Rae Hale", { birthDate: yearsAgo(15) });
	const gone = await person("Sam Hale", { adultClassification: "adult" });
	const outside = await person("Ty Ross", { adultClassification: "adult" });
	const far = await person("Uma Far", { adultClassification: "adult" }, 2);
	await home(gus, [liv, "child"], [kid, "child"], [unknown, "other"], [young, "child"], [gone, "spouse"]);
	await home(outside);
	await admin.execute(sql`UPDATE person SET state='retired' WHERE id=${sql.param(gone.id)}`);
	const before = await revisionOf(liv.id);

	for (const [who, reason] of [
		[kid, "not_adult"],
		[unknown, "not_adult"],
		[young, "not_adult"],
		[outside, "not_in_household"],
	] as const)
		assert.equal(refused(await contact(liv, who), "invalid_input").details.reason, reason, who.displayName);
	refused(await contact(liv, gone));
	refused(await contact(liv, far));
	refused(await contact(liv, liv), "invalid_subject");
	assert.equal(
		refused(await contact(gus, liv), "invalid_input").details.reason,
		"not_child",
		"only a child gets a contact",
	);
	refused(await contact(liv, gus, true, 1), "unavailable");

	assert.deepEqual(await stored(liv), [{ n: 0 }]);
	assert.equal(await revisionOf(liv.id), before);
	assert.deepEqual(await history(liv), []);
	const eligible = (await card(liv)).members.filter((m) => m.adult === "adult").map((m) => m.displayName);
	assert.deepEqual(eligible, ["Gus Hale"], "only live adults in the household are offered");
});

test("AC:CASE-PPL-009-GUARDIAN when the adult or the child leaves the household, the contact is gone", async () => {
	const ann = await person("Ann Vale", { adultClassification: "adult" });
	const bo = await person("Bo Vale", { adultClassification: "adult" });
	const cy = await person("Cy Vale", { adultClassification: "child" });
	const di = await person("Di Vale", { adultClassification: "child" });
	await home(ann, [bo, "spouse"], [cy, "child"], [di, "child"]);
	ok(await contact(cy, ann));
	ok(await contact(cy, bo));
	ok(await contact(di, ann));
	const leave = async (p) =>
		ok(
			await write(0, async (t, c) =>
				fields.removeFromHousehold(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { personId: p.id },
				}),
			),
		).result;

	const left = await leave(ann);
	assert.deepEqual([shownContacts(left, cy), shownContacts(left, di)], [["Bo Vale"], []]);
	assert.deepEqual([shownContacts(await card(cy), cy), shownContacts(await card(di), di)], [["Bo Vale"], []]);
	await leave(cy);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM guardian_contact WHERE child_person_id IN (${sql.param(cy.id)}, ${sql.param(di.id)})`,
		),
		[{ n: 0 }],
	);
});
