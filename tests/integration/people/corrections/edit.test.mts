import { testDatabase } from "../../../support/test-database.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
	assessments,
	peopleWriter as people,
	recordCorrections,
} from "../../../../packages/domain/src/people/index.ts";

// Editing a record with an optional reason, through the public operations on a scratch schema.
const database = await testDatabase({ prefix: "wp015e" });
const { admin, schema } = database;
const db = database.pools.runtime;
let today;
const day = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

const plant = randomUUID(),
	actors = Array.from({ length: 2 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
// 0: owner who edits, 1: admin who records the assessment.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plant } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code) => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
	return result.error;
};
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const one = async (query) => (await rows(query))[0];
const personRow = (id) => one(sql`SELECT stage FROM person WHERE id=${sql.param(id)}`);

async function person(name, input = {}) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, adultClassification: "adult", ...input },
			}),
		),
	).person;
}

before(async () => {
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(a.user)},${sql.param(a.id + "@example.test")},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(a.id)},${sql.param(a.user)},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(a.session)},${sql.param(a.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
		);
	}
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(plant)},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
	);
	for (const [i, roleName] of [
		[0, "owner"],
		[1, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(roleName)},clock_timestamp())`,
		);
	today = (await rows(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text d`))[0].d;
});
after(async () => {
	await database.close();
});

const lens = (score, notes = null) => ({ score, notes });
const edit = (personId, a, reason, who = 0) =>
	tx((t) =>
		recordCorrections.correctPersonRecord(t, ctx(who), {
			requestKey: key(),
			expectedRevision: a.revision,
			// A reason of undefined leaves the key out, as the browser does for a blank field.
			input: { recordType: "assessment", personId, recordId: a.id, changes: { committed: lens(5) }, ...reason },
		}),
	);
async function assessed(name) {
	const p = await person(name, { stage: "leader" });
	const a = ok(
		await tx((t) =>
			assessments.createAssessment(t, ctx(1), {
				requestKey: key(),
				input: {
					personId: p.id,
					occurredOn: day(6),
					committed: lens(3),
					compelled: lens(3),
					contagious: lens(3),
					courageous: lens(3),
				},
			}),
		),
	).assessment;
	return { p, a };
}
const history = async (personId) =>
	ok(await tx((t) => recordCorrections.listRecordCorrections(t, ctx(), { personId }))).items;
const oneEntry = (items, a, reason) => {
	assert.equal(items.length, 1);
	const [entry] = items;
	assert.deepEqual(
		[entry.recordType, entry.recordId, entry.actor, entry.reason, entry.changes],
		[
			"assessment",
			a.id,
			{ kind: "current_account", accountId: actors[0].id },
			reason,
			[{ field: "committed", old: lens(3), new: lens(5) }],
		],
	);
};

const cases = [
	["a reason is kept trimmed", { reason: "  Typed the wrong score  " }, "Typed the wrong score"],
	["a blank reason is saved as no reason", { reason: " \n " }, null],
	["an omitted reason is saved as no reason", {}, null],
] as const;
for (const [name, reason, stored] of cases)
	test(`AC:TARGET-PPL-015 INV-optional-reason an edit where ${name}`, async () => {
		const { p, a } = await assessed(name);
		ok(await edit(p.id, a, reason));
		oneEntry(await history(p.id), a, stored);
		assert.equal((await personRow(p.id)).stage, "leader");
	});

test("AC:TARGET-PPL-015 a reason over 5000 characters is refused and nothing is saved", async () => {
	const { p, a } = await assessed("Edit Long Reason");
	refused(await edit(p.id, a, { reason: "x".repeat(5001) }), "invalid_input");
	assert.equal((await history(p.id)).length, 0);
});
