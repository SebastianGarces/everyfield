import { createDatabase, closeDatabase } from "../../../../packages/db/src/client.ts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import {
	assessments,
	checkForDuplicates,
	commitments,
	interviews,
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	peopleWriter as people,
	personFields,
	readPersonPage,
	recordCorrections,
} from "../../../../packages/domain/src/people/index.ts";

// Duplicate review, merge, guarded Unmerge and record corrections through their public operations on a scratch schema.
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp015e_" + randomUUID().replaceAll("-", ""),
	role = "wp015e_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
let today;
const day = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

const plants = [randomUUID(), randomUUID()],
	actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
// 0: plant A owner, 1: plant A member, 2: plant B admin, 3: plant A admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
	return result.error;
};
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const one = async (query) => (await rows(query))[0];
const personRow = (id) =>
	one(sql`SELECT state,merged_into_person_id,revision::text,display_name,email,stage,commitment_state,household_id
 FROM person WHERE id=${sql.param(id)}`);

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
const review = (sourceId, survivorId, who = 0) =>
	tx((t) => peopleMerge.getMergeReview(t, ctx(who), { sourceId, survivorId }));
async function merge(sourceId, survivorId, fieldChoices = {}, who = 0, requestKey = key()) {
	const r = ok(await review(sourceId, survivorId, who));
	return tx((t) =>
		peopleMerge.mergePeople(t, ctx(who), {
			requestKey,
			input: { sourceId, survivorId, reviewDigest: r.reviewDigest, fieldChoices },
		}),
	);
}
const addSkill = (personId, name, who = 3) =>
	tx((t) => personFields.addSkill(t, ctx(who), { requestKey: key(), input: { personId, name, category: "tech" } }));
const skillsOf = async (personId) =>
	(await rows(sql`SELECT name FROM person_skill WHERE person_id=${sql.param(personId)} ORDER BY name`)).map(
		(r) => r.name,
	);

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
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
	for (const id of plants)
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(id)},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
		);
	for (const [i, plant, roleName] of [
		[0, plants[0], "owner"],
		[1, plants[0], "member"],
		[2, plants[1], "admin"],
		[3, plants[0], "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(roleName)},clock_timestamp())`,
		);
	today = (await rows(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text d`))[0].d;
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
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
			assessments.createAssessment(t, ctx(3), {
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
const history = async (personId) => ok(await tx((t) => recordCorrections.listRecordCorrections(t, ctx(), { personId }))).items;
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

test("AC:TARGET-PPL-015 an edit with a reason keeps the trimmed reason in the history and the stage", async () => {
	const { p, a } = await assessed("Edit With Reason");
	ok(await edit(p.id, a, { reason: "  Typed the wrong score  " }));
	oneEntry(await history(p.id), a, "Typed the wrong score");
	assert.equal((await personRow(p.id)).stage, "leader");
});

test("AC:TARGET-PPL-015 an edit with a blank reason is saved with no reason", async () => {
	const { p, a } = await assessed("Edit Blank Reason");
	ok(await edit(p.id, a, { reason: " \n " }));
	oneEntry(await history(p.id), a, null);
	assert.equal((await personRow(p.id)).stage, "leader");
});

test("AC:TARGET-PPL-015 an edit with no reason is saved with no reason; a reason over 5000 characters is refused", async () => {
	const { p, a } = await assessed("Edit No Reason");
	refused(await edit(p.id, a, { reason: "x".repeat(5001) }), "invalid_input");
	assert.equal((await history(p.id)).length, 0);
	ok(await edit(p.id, a, {}));
	oneEntry(await history(p.id), a, null);
	assert.equal((await personRow(p.id)).stage, "leader");
});
