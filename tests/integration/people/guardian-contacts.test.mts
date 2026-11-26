import { fixture, ok, refused } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import {
	authorityOf,
	church,
	isActivity,
	noReminders,
	reads,
	type Reply,
	type Row,
	withStatus,
} from "./people-support.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { WriteContext } from "../../../packages/domain/src/people/core.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	peopleWriter as people,
	personFields as fields,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const database = await fixture({ prefix: "t487", clock: new Date("2026-10-13T16:00:00Z") });
const { admin } = database;
const db = database.pools.runtime;
const otherChurch = (await database.plant()).id;
const actors = [
	database.actors.admin,
	database.actors.member,
	await database.actor({ kind: "plant", id: otherChurch }, "admin"),
	database.actors.owner,
] as const;
type Who = 0 | 1 | 2 | 3;
type Person = Awaited<ReturnType<typeof person>>;
const inHousehold = (result: Extract<Awaited<ReturnType<typeof fields.getHousehold>>, { status: "ok" }>["value"]) =>
	withStatus(result, "available");
const ctx = () => ({ session: actors[0].session, selected: church(database.tenant.id) });
const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
const write = async <T,>(who: Who, body: (t: WriteTx, c: WriteContext) => Promise<Reply<T>>) =>
	withPeopleWrite(db, await tx((t) => authorityOf(t, actors[who])), body);
const key = () => randomUUID();
const rows = async <T extends Row>(query: SQL) => (await admin.execute<T>(query)).rows;
const revisionOf = async (id: string) =>
	(await rows<{ r: string }>(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0]!.r;
const yearsAgo = (years: number) => `${2026 - years}-01-15`;

after(async () => {
	await database.close();
});

async function person(name: string, fields: Record<string, unknown> = {}, who: Who = 0) {
	return ok(
		await write(who, async (t, c) =>
			people.createPerson(t, c, { requestKey: key(), input: { displayName: name, ...fields } }),
		),
	).person;
}
async function home(head: Person, ...members: [Person, string][]) {
	const created = ok(
		await write(0, async (t, c) =>
			fields.createHouseholdWithHead(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(head.id),
				input: { name: `${head.displayName} household`, headPersonId: head.id },
			}),
		),
	).result;
	const { household } = inHousehold(created);
	for (const [p, role] of members)
		ok(
			await write(0, async (t, c) =>
				fields.addToHousehold(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { householdId: household.id, personId: p.id, role },
				}),
			),
		);
	return household;
}
async function retire(p: Person) {
	const { reviewRevision } = ok(await tx((t) => reads.getStatusWarnings(t, ctx(), { personId: p.id })));
	ok(
		await write(0, async (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { personId: p.id, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				noReminders,
			),
		),
	);
}
const contact = async (child: Person, guardian: { id: string }, on = true, who: Who = 0) =>
	write(who, async (t, c) =>
		fields.setGuardianContact(t, c, {
			requestKey: key(),
			expectedRevision: await revisionOf(child.id),
			input: { personId: child.id, guardianPersonId: guardian.id, contact: on },
		}),
	);
const card = async (child: Person) =>
	inHousehold(ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: child.id }))));
const shownContacts = (result: Parameters<typeof inHousehold>[0], child: Person) => {
	const { guardians, members } = inHousehold(result);
	return guardians
		.filter((link) => link.childPersonId === child.id)
		.map((link) => members.find((m) => m.personId === link.guardianPersonId)?.displayName)
		.sort();
};
const stored = (child: Person) =>
	rows(sql`SELECT count(*)::int n FROM guardian_contact WHERE child_person_id=${sql.param(child.id)}`);
const history = async (child: Person) =>
	ok(await tx((t) => reads.getActivities(t, ctx(), { personId: child.id })))
		.items.filter(isActivity)
		.filter((i) => i.guardian);

test("AC:CASE-PPL-009-GUARDIAN an admin marks an adult in a child's household as the child's parent or guardian contact, and the change is in the child's history", async () => {
	const maria = await person("Maria Lopez", { adultClassification: "adult" });
	const ava = await person("Ava Lopez", { adultClassification: "child" });
	await home(maria, [ava, "child"]);
	const before = await revisionOf(ava.id);
	assert.deepEqual(
		shownContacts(await card(ava), ava),
		[],
		"the head of the household is no contact until staff say so",
	);
	assert.deepEqual(await stored(ava), [{ n: 0 }]);

	const request = {
		requestKey: key(),
		expectedRevision: before,
		input: { personId: ava.id, guardianPersonId: maria.id, contact: true },
	};
	const mark = () => write(0, (t, c) => fields.setGuardianContact(t, c, request));
	const { value, added } = await recorded(admin, mark);
	const saved = ok(value);
	assert.deepEqual(added, { audits: ["people.updated"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual(ok(await untouched(admin, mark)), saved, "a retry of the same save adds nothing");
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
		after_value: { guardian: { personId: maria.id } },
	});

	const again = ok(await contact(ava, maria));
	assert.equal(again.outcome, "noop", "a repeat add changes nothing");
	assert.deepEqual(await stored(ava), [{ n: 1 }]);
	assert.equal((await history(ava)).length, 1);
});

test("AC:CASE-PPL-009-GUARDIAN a second adult can be added, and either contact can be removed, leaving the other", async () => {
	const dan = await person("Dan Park", { adultClassification: "adult" });
	const eve = await person("Eve Park", { birthDate: yearsAgo(40) });
	const kai = await person("Kai Park", { birthDate: yearsAgo(9) });
	await home(dan, [eve, "spouse"], [kai, "child"]);

	ok(await contact(kai, dan));
	const both = ok(await contact(kai, eve)).result;
	assert.deepEqual(shownContacts(both, kai), ["Dan Park", "Eve Park"]);

	const removal = await recorded(admin, () => contact(kai, dan, false));
	assert.deepEqual(removal.added, { audits: ["people.updated"], jobs: [], notices: 0, mail: 0 });
	const removed = ok(removal.value);
	assert.equal(removed.outcome, "changed");
	assert.deepEqual(shownContacts(removed.result, kai), ["Eve Park"]);
	assert.deepEqual(shownContacts(await card(kai), kai), ["Eve Park"]);
	assert.deepEqual(
		(await history(kai)).map((i) => [i.guardian?.change, i.guardian?.displayName]),
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
	await retire(gone);
	const before = await revisionOf(liv.id);

	const ineligible = (guardian: { id: string }, child = liv, who: Who = 0) =>
		untouched(admin, () => contact(child, guardian, true, who));
	for (const [who, reason] of [
		[kid, "not_adult"],
		[unknown, "not_adult"],
		[young, "not_adult"],
		[outside, "not_in_household"],
	] as const)
		assert.equal(refused(await ineligible(who), "invalid_input").details.reason, reason, who.displayName);
	for (const gap of [gone, far, { id: key(), displayName: "Nobody" }])
		assert.deepEqual(refused(await ineligible(gap)).details, {}, gap.displayName);
	refused(await ineligible(liv), "invalid_subject");
	assert.equal(refused(await ineligible(liv, gus), "invalid_input").details.reason, "not_child");
	refused(await ineligible(gus, liv, 1));
	refused(await ineligible(gus, liv, 2));
	refused(await ineligible(far, liv, 2));

	assert.deepEqual(await stored(liv), [{ n: 0 }]);
	assert.equal(await revisionOf(liv.id), before);
	assert.deepEqual(await history(liv), []);
	const eligible = (await card(liv)).members.filter((m) => m.adult === "adult").map((m) => m.displayName);
	assert.deepEqual(eligible, ["Gus Hale"], "only live adults in the household are offered");
	assert.deepEqual(shownContacts(ok(await contact(liv, gus)).result, liv), ["Gus Hale"]);
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int n FROM guardian_contact g JOIN person a ON a.id=g.guardian_person_id
			JOIN person c ON c.id=g.child_person_id WHERE a.tenant_id<>c.tenant_id OR a.tenant_id<>g.plant_id`),
		[{ n: 0 }],
	);
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
	const leave = async (p: Person) =>
		ok(
			await write(0, async (t, c) =>
				fields.removeFromHousehold(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { personId: p.id },
				}),
			),
		).result;

	const { value: left, added } = await recorded(admin, () => leave(ann));
	assert.deepEqual(added, { audits: ["people.updated"], jobs: [], notices: 0, mail: 0 });
	assert.deepEqual([shownContacts(left, cy), shownContacts(left, di)], [["Bo Vale"], []]);
	assert.deepEqual([shownContacts(await card(cy), cy), shownContacts(await card(di), di)], [["Bo Vale"], []]);
	assert.deepEqual(await stored(cy), [{ n: 1 }]);
	assert.deepEqual(shownContacts(await leave(cy), cy), []);
	assert.deepEqual(shownContacts(await card(bo), cy), []);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM guardian_contact WHERE child_person_id IN (${sql.param(cy.id)}, ${sql.param(di.id)})`,
		),
		[{ n: 0 }],
	);
});
