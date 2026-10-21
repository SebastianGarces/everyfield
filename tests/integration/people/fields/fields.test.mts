import { createDatabase, closeDatabase } from "../../../../packages/db/src/client.ts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import {
	peopleWriter as people,
	peopleReader,
	personFields as fields,
	readPersonPhoto,
	uploadPersonPhoto,
} from "../../../../packages/domain/src/people/index.ts";

// Households, tags, skills and the person photo through their public operations on a scratch schema.
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
const schema = "wp012_" + randomUUID().replaceAll("-", ""),
	role = "wp012_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;

const plants = [randomUUID(), randomUUID()],
	actors = Array.from({ length: 3 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
// 0: plant A owner, 1: plant A member, 2: plant B admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
};
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const audit = (subject) =>
	rows(
		sql`SELECT kind,action,subject_type,before_value,after_value FROM audit_event WHERE subject_id=${sql.param(subject)} AND command_id=id ORDER BY occurred_at,id`,
	);

async function person(name, fields = {}, who = 0) {
	return ok(
		await tx((t) => people.createPerson(t, ctx(who), { requestKey: key(), input: { displayName: name, ...fields } })),
	).person;
}
async function retire(p) {
	const review = ok(await tx((t) => peopleReader.getStatusWarnings(t, ctx(), { personId: p.id }))).reviewRevision;
	ok(
		await tx((t) =>
			people.retirePerson(t, ctx(), {
				requestKey: key(),
				expectedRevision: p.revision,
				input: { personId: p.id, reason: "Moved away", reviewRevision: review, handoffs: [] },
			}),
		),
	);
}
const revisionOf = async (id) => (await rows(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0].r;

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
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(roleName)},clock_timestamp())`,
		);
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

test("AC:GAP-PPL-010 AC:TARGET-PPL-010 AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-RETIRE plant-local tag names, nullable color, one link per pair and deletion with history", async () => {
	const alex = await person("Alex Rivera"),
		jamie = await person("Jamie Chen");
	const create = (name, color, who = 0) =>
		tx((t) =>
			fields.createTag(t, ctx(who), { requestKey: key(), input: color === undefined ? { name } : { name, color } }),
		);
	const family = ok(await create("family", null)).tag;
	const north = ok(await create(" Northside ", "#3A7BD5"));
	assert.deepEqual(
		{ name: north.tag.name, color: north.tag.color, outcome: north.outcome },
		{
			name: "Northside",
			color: "#3a7bd5",
			outcome: "changed",
		},
	);
	// Case and surrounding spaces share one plant-local key; another church may use the same name.
	const same = ok(await create("NORTHSIDE  ", "red"));
	assert.deepEqual([same.outcome, same.tag.id, same.tag.color], ["noop", north.tag.id, "#3a7bd5"]);
	const foreign = ok(await create("Northside", null, 2)).tag;
	assert.notEqual(foreign.id, north.tag.id);
	refused(await create("Northside", null, 1));
	// Two requests racing on one name create one tag.
	const raced = await Promise.all([create("Welcome", null), create(" welcome ", null)]);
	assert.deepEqual(raced.map((r) => ok(r).outcome).sort(), ["changed", "noop"]);
	assert.equal(new Set(raced.map((r) => ok(r).tag.id)).size, 1);
	// Omitted color keeps it, null clears it; internal spaces stay significant.
	const renamed = ok(
		await tx((t) =>
			fields.updateTag(t, ctx(), {
				requestKey: key(),
				expectedRevision: north.tag.revision,
				input: { tagId: north.tag.id, name: "North  side" },
			}),
		),
	).tag;
	assert.deepEqual([renamed.name, renamed.color], ["North  side", "#3a7bd5"]);
	const cleared = ok(
		await tx((t) =>
			fields.updateTag(t, ctx(), {
				requestKey: key(),
				expectedRevision: renamed.revision,
				input: { tagId: north.tag.id, color: null },
			}),
		),
	).tag;
	assert.deepEqual([cleared.name, cleared.color], ["North  side", null]);
	refused(
		await tx((t) =>
			fields.updateTag(t, ctx(), {
				requestKey: key(),
				expectedRevision: cleared.revision,
				input: { tagId: north.tag.id, name: "Family" },
			}),
		),
		"conflict",
	);

	// Assign: a retry returns the original result, a second request is a no-op and records no activity.
	const assign = { requestKey: key(), input: { personId: alex.id, tagId: north.tag.id } };
	ok(
		await tx((t) => fields.assignTag(t, ctx(), { requestKey: key(), input: { personId: alex.id, tagId: family.id } })),
	);
	const first = ok(await tx((t) => fields.assignTag(t, ctx(), assign)));
	assert.deepEqual(ok(await tx((t) => fields.assignTag(t, ctx(), assign))), first);
	const repeat = ok(await tx((t) => fields.assignTag(t, ctx(), { requestKey: key(), input: assign.input })));
	assert.deepEqual(
		first.tags.map((t) => t.name),
		["family", "North  side"],
	);
	assert.deepEqual([repeat.outcome, repeat.tags], ["noop", first.tags]);
	const links = await rows(sql`SELECT count(*)::int n FROM person_tag WHERE person_id=${sql.param(alex.id)}`);
	assert.equal(links[0].n, 2);
	assert.deepEqual(
		(await audit(alex.id)).filter((a) => a.kind !== "create").map((a) => [a.kind, a.after_value]),
		[
			["edit", { tags: ["family"] }],
			["edit", { tags: ["family", "North  side"] }],
			["noop", null],
		],
	);
	// Live same-plant Person and tag only.
	refused(
		await tx((t) => fields.assignTag(t, ctx(), { requestKey: key(), input: { personId: alex.id, tagId: foreign.id } })),
	);
	refused(
		await tx((t) =>
			fields.assignTag(t, ctx(2), { requestKey: key(), input: { personId: alex.id, tagId: foreign.id } }),
		),
	);
	refused(await tx((t) => fields.getPersonTags(t, ctx(2), { personId: alex.id })));

	// A retired Person leaves the operational count but keeps the history of its tags.
	ok(
		await tx((t) =>
			fields.assignTag(t, ctx(), { requestKey: key(), input: { personId: jamie.id, tagId: north.tag.id } }),
		),
	);
	await retire(jamie);
	refused(
		await tx((t) => fields.assignTag(t, ctx(), { requestKey: key(), input: { personId: jamie.id, tagId: family.id } })),
	);
	const listed = ok(await tx((t) => fields.listTags(t, ctx(1), {}))).items;
	assert.deepEqual(
		listed.map((t) => [t.name, t.linkedPeople]),
		[
			["family", 1],
			["North  side", 1],
			["Welcome", 0],
		],
	);
	const activity = ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId: jamie.id }))).items;
	assert.deepEqual(
		activity.map((a) => a.action),
		["created", "updated", "retired"],
	);

	// Delete previews the live count, removes every current link and keeps each Person's history.
	const deleted = ok(
		await tx((t) =>
			fields.deleteTag(t, ctx(), {
				requestKey: key(),
				expectedRevision: cleared.revision,
				input: { tagId: north.tag.id },
			}),
		),
	);
	assert.equal(deleted.removedLinks, 2);
	assert.deepEqual(
		ok(await tx((t) => fields.getPersonTags(t, ctx(), { personId: alex.id }))).tags.map((t) => t.name),
		["family"],
	);
	assert.equal((await audit(north.tag.id)).at(-1).action, "people.retired");
	// Removing twice removes one link and records one change.
	const remove = () =>
		tx((t) => fields.removeTag(t, ctx(), { requestKey: key(), input: { personId: alex.id, tagId: family.id } }));
	assert.deepEqual([ok(await remove()).tags, ok(await remove()).outcome], [[], "noop"]);
	assert.equal(
		(await audit(alex.id)).filter((a) => JSON.stringify(a.after_value ?? "").includes("North  side")).length,
		1,
	);
});

test("AC:GAP-PPL-011 AC:TARGET-PPL-011 skills keep closed categories, null clears and refuse stale or foreign edits", async () => {
	const alex = await person("Alex Rivera");
	const add = async (name, category, proficiency) =>
		ok(
			await tx((t) =>
				fields.addSkill(t, ctx(), {
					requestKey: key(),
					input: { personId: alex.id, name, category, proficiency, notes: "Sunday team" },
				}),
			),
		);
	await add("Music", "worship", "advanced");
	const added = await add(" Hospitality ", "hospitality", "beginner");
	const hospitality = added.skills.find((s) => s.name === "Hospitality");
	// Grouped by the closed category order, then name.
	assert.deepEqual(
		added.skills.map((s) => [s.category, s.name, s.proficiency]),
		[
			["worship", "Music", "advanced"],
			["hospitality", "Hospitality", "beginner"],
		],
	);
	const update = (rev, patch, who = 0) =>
		tx((t) =>
			fields.updateSkill(t, ctx(who), {
				requestKey: key(),
				expectedRevision: rev,
				input: { skillId: hospitality.id, patch },
			}),
		);
	const advanced = ok(await update(hospitality.revision, { proficiency: "advanced" }));
	assert.deepEqual(Object.fromEntries(advanced.skills.map((s) => [s.name, s.proficiency])), {
		Music: "advanced",
		Hospitality: "advanced",
	});
	// A stale edit changes nothing.
	const before = await rows(sql`SELECT count(*)::int n FROM audit_event`);
	refused(await update(hospitality.revision, { proficiency: null }), "conflict");
	refused(await update(hospitality.revision, { proficiency: null }, 2));
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM audit_event`), before);
	const current = advanced.skills.find((s) => s.id === hospitality.id);
	const cleared = ok(await update(current.revision, { proficiency: null, notes: null }));
	assert.deepEqual(
		ok(await tx((t) => fields.getPersonSkills(t, ctx(1), { personId: alex.id }))).skills.find(
			(s) => s.id === hospitality.id,
		),
		{ ...cleared.skills.find((s) => s.id === hospitality.id), proficiency: null, notes: null },
	);
	const latest = cleared.skills.find((s) => s.id === hospitality.id);
	const removed = ok(
		await tx((t) =>
			fields.removeSkill(t, ctx(), {
				requestKey: key(),
				expectedRevision: latest.revision,
				input: { skillId: hospitality.id },
			}),
		),
	);
	assert.deepEqual(
		removed.skills.map((s) => s.name),
		["Music"],
	);
	// History keeps every change, including the removed skill.
	assert.deepEqual(
		(await audit(alex.id))
			.filter((a) => a.kind === "edit")
			.map((a) => (a.after_value.skill === null ? "removed" : a.after_value.skill.proficiency)),
		["advanced", "beginner", "advanced", null, "removed"],
	);
});

test("AC:TARGET-PPL-009 AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-RETIRE households: coherent head, address copy only when blank, deliberate propagation and safe deletion", async () => {
	const head = await person("Alex Rivera"),
		casey = await person("Casey Reed", { street: "1 Own St", city: "Evanston" }),
		jamie = await person("Jamie Chen"),
		retiring = await person("Riley Stone");
	await retire(retiring);
	const create = (p, rev) =>
		tx((t) =>
			fields.createHouseholdWithHead(t, ctx(), {
				requestKey: key(),
				expectedRevision: rev,
				input: { name: "Rivera household", street: "9 Elm St", city: "Chicago", headPersonId: p.id },
			}),
		);
	// A retired Person cannot head a household; no orphan household remains.
	refused(await create(retiring, await revisionOf(retiring.id)));
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM household`), [{ n: 0 }]);
	const created = ok(await create(head, head.revision)).result;
	const h = created.household;
	assert.deepEqual(
		created.members.map((m) => [m.displayName, m.role, m.street, m.city]),
		[["Alex Rivera", "head", "9 Elm St", "Chicago"]],
	);
	const join = async (p, role, rev) =>
		tx(async (t) =>
			fields.addToHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: rev ?? (await revisionOf(p.id)),
				input: { householdId: h.id, personId: p.id, role },
			}),
		);
	// A person with a meaningful address keeps it; a blank one gets the household's.
	ok(await join(casey, "spouse"));
	const joined = ok(await join(jamie, "child")).result;
	assert.deepEqual(
		joined.members.map((m) => [m.displayName, m.role, m.street]),
		[
			["Alex Rivera", "head", "9 Elm St"],
			["Casey Reed", "spouse", "1 Own St"],
			["Jamie Chen", "child", "9 Elm St"],
		],
	);
	refused(await join(head, "head", "1"), "conflict");
	// Cross-tenant membership is unavailable.
	refused(await tx((t) => fields.getHousehold(t, ctx(2), { householdId: h.id })));
	refused(
		await tx((t) =>
			fields.addToHousehold(t, ctx(2), {
				requestKey: key(),
				expectedRevision: "1",
				input: { householdId: h.id, personId: jamie.id, role: "other" },
			}),
		),
	);

	// Preview, then a stale household edit: the propagation writes nothing.
	const preview = ok(await tx((t) => fields.getHouseholdMembers(t, ctx(), { householdId: h.id })));
	const edited = ok(
		await tx((t) =>
			fields.updateHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: preview.household.revision,
				input: { householdId: h.id, patch: { street: "10 Oak Ave" } },
			}),
		),
	).result;
	const reviewed = preview.members.map((m) => ({ personId: m.personId, revision: m.revision }));
	const propagate = (rev, members = reviewed) =>
		tx((t) =>
			fields.propagateAddress(t, ctx(), {
				requestKey: key(),
				expectedRevision: rev,
				input: { householdId: h.id, members },
			}),
		);
	refused(await propagate(preview.household.revision), "conflict");
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0].street, "1 Own St");
	refused(await propagate(edited.household.revision, reviewed.slice(1)), "conflict");
	// A member's own edit after the preview makes it stale too: nothing is written and nothing is audited.
	ok(
		await tx(async (t) =>
			people.updatePerson(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(casey.id),
				input: { personId: casey.id, patch: { street: "2 New St" } },
			}),
		),
	);
	const audited = await rows(sql`SELECT count(*)::int n FROM audit_event`);
	refused(await propagate(edited.household.revision), "conflict");
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0].street, "2 New St");
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM audit_event`), audited);
	const fresh = ok(await tx((t) => fields.getHouseholdMembers(t, ctx(), { householdId: h.id })));
	const propagated = ok(
		await propagate(
			fresh.household.revision,
			fresh.members.map((m) => ({ personId: m.personId, revision: m.revision })),
		),
	);
	assert.equal(propagated.updatedPeople, 3);
	assert.deepEqual(new Set(propagated.result.members.map((m) => m.street)), new Set(["10 Oak Ave"]));
	assert.deepEqual(await rows(sql`SELECT DISTINCT street FROM person WHERE household_id=${sql.param(h.id)}`), [
		{ street: "10 Oak Ave" },
	]);

	// Leaving keeps the person's address; deleting refuses live members.
	const left = ok(
		await tx(async (t) =>
			fields.removeFromHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(casey.id),
				input: { personId: casey.id },
			}),
		),
	);
	assert.equal(left.result.household.memberCount, 2);
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0].street, "10 Oak Ave");
	const current = ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: head.id }))).household;
	refused(
		await tx((t) =>
			fields.deleteHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: current.revision,
				input: { householdId: h.id },
			}),
		),
		"conflict",
	);

	// Retired members leave current membership; the household still shows in their history after deletion.
	const role = ok(
		await tx(async (t) =>
			fields.setHouseholdRole(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(jamie.id),
				input: { personId: jamie.id, role: "other" },
			}),
		),
	);
	assert.deepEqual(
		role.result.members.map((m) => m.role),
		["head", "other"],
	);
	await retire({ id: jamie.id, revision: await revisionOf(jamie.id) });
	ok(
		await tx(async (t) =>
			fields.removeFromHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(head.id),
				input: { personId: head.id },
			}),
		),
	);
	const empty = ok(await tx((t) => fields.getHousehold(t, ctx(), { householdId: h.id })));
	assert.deepEqual([empty.household.memberCount, empty.members], [0, []]);
	// A join racing the deletion: exactly one wins and no Person points at a missing household.
	const raced = await Promise.all([
		join(casey, "other"),
		tx((t) =>
			fields.deleteHousehold(t, ctx(), {
				requestKey: key(),
				expectedRevision: empty.household.revision,
				input: { householdId: h.id },
			}),
		),
	]);
	assert.deepEqual(raced.map((r) => r.status).sort(), ["ok", "refused"]);
	if (raced[0].status === "ok") {
		const again = ok(
			await tx(async (t) =>
				fields.removeFromHousehold(t, ctx(), {
					requestKey: key(),
					expectedRevision: await revisionOf(casey.id),
					input: { personId: casey.id },
				}),
			),
		);
		ok(
			await tx((t) =>
				fields.deleteHousehold(t, ctx(), {
					requestKey: key(),
					expectedRevision: again.result.household.revision,
					input: { householdId: h.id },
				}),
			),
		);
	}
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM person WHERE household_id IS NOT NULL`), [{ n: 0 }]);
	assert.deepEqual(ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: jamie.id }))), { status: "none" });
	// The public history still names the household the retired person belonged to.
	const history = ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId: jamie.id }))).items;
	assert.deepEqual(
		history.filter((a) => a.kind === "household_changed").map((a) => [a.from?.role ?? null, a.to?.name, a.to?.role]),
		[
			[null, "Rivera household", "child"],
			["child", "Rivera household", "other"],
		],
	);
	assert.equal((await audit(h.id)).at(-1).action, "people.retired");
	assert.equal(ok(await tx((t) => fields.listHouseholds(t, ctx(), {}))).total, 0);
});

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
test("AC:TARGET-PPL-005 AC:PROVIDER48-002 AC:PROVIDER48-003 person photo: verified private bytes, exact-version reads, replace, remove and revoked or foreign access", async () => {
	const objects = new Map();
	const storage = {
		bucket: "synthetic-only",
		client: {
			send: async (command) => {
				const i = command.input;
				switch (command.constructor.name) {
					case "GetBucketAclCommand":
						return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
					case "PutObjectCommand":
						assert.match(i.Key, new RegExp(`^private/${plants[0]}/[a-f0-9-]{36}$`));
						assert.equal(i.ACL, "private");
						objects.set(i.Key, Buffer.from(i.Body));
						return {};
					case "GetObjectCommand": {
						const body = objects.get(i.Key);
						return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
					}
					default:
						throw Error("unexpected provider operation");
				}
			},
		},
	};
	const alex = await person("Alex Rivera");
	const upload = async (bytes, who = 0) => {
		const pending = ok(
			await tx((t) =>
				fields.requestPersonPhotoUpload(t, ctx(who), {
					personId: alex.id,
					mime: "image/png",
					byteLength: bytes.length,
				}),
			),
		);
		return { pending, stored: await uploadPersonPhoto(db, storage, ctx(who), { uploadId: pending.uploadId, bytes }) };
	};
	const set = async (uploadId, who = 0) =>
		tx(async (t) =>
			fields.setPersonPhoto(t, ctx(who), {
				requestKey: key(),
				expectedRevision: await revisionOf(alex.id),
				input: { personId: alex.id, uploadId },
			}),
		);
	const first = await upload(png);
	ok(first.stored);
	ok(await set(first.pending.uploadId));
	const version = { personId: alex.id, versionId: first.pending.uploadId };
	assert.deepEqual(ok(await tx((t) => fields.getPersonPhoto(t, ctx(1), { personId: alex.id }))), {
		status: "available",
		...version,
	});
	const delivered = ok(await readPersonPhoto(db, storage, ctx(1), version));
	assert.deepEqual([Buffer.from(delivered.bytes), delivered.mediaType], [png, "image/png"]);

	// A failed upload keeps the current photo; a member cannot upload; a foreign church reads nothing.
	const broken = ok(
		await tx((t) => fields.requestPersonPhotoUpload(t, ctx(), { personId: alex.id, mime: "image/png", byteLength: 9 })),
	);
	refused(
		await uploadPersonPhoto(db, storage, ctx(), { uploadId: broken.uploadId, bytes: Buffer.from("not a png") }),
		"invalid_input",
	);
	refused(await set(broken.uploadId));
	refused(
		await tx((t) =>
			fields.requestPersonPhotoUpload(t, ctx(1), { personId: alex.id, mime: "image/png", byteLength: png.length }),
		),
	);
	assert.deepEqual(ok(await tx((t) => fields.getPersonPhoto(t, ctx(), { personId: alex.id }))), {
		status: "available",
		...version,
	});
	refused(await readPersonPhoto(db, storage, ctx(2), version));
	refused(await tx((t) => fields.getPersonPhoto(t, ctx(2), { personId: alex.id })));

	// Replacing points at the new exact version; the old one is unavailable and queued for cleanup.
	const second = await upload(png);
	const replaced = ok(await set(second.pending.uploadId));
	assert.equal(replaced.photo.versionId, second.pending.uploadId);
	refused(await readPersonPhoto(db, storage, ctx(), version));
	assert.ok(
		ok(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: second.pending.uploadId })).bytes
			.length,
	);
	const cleanup = await rows(
		sql`SELECT subject_record_id FROM job WHERE kind='object_cleanup' AND eligible_at<=clock_timestamp()`,
	);
	assert.ok(cleanup.some((j) => j.subject_record_id === first.pending.uploadId));
	// An upload already in use by another Person cannot be claimed again.
	const other = await person("Casey Reed");
	refused(
		await tx((t) =>
			fields.setPersonPhoto(t, ctx(), {
				requestKey: key(),
				expectedRevision: other.revision,
				input: { personId: other.id, uploadId: second.pending.uploadId },
			}),
		),
	);
	// Revoked access ends delivery: the member's seat ends, and no storage link exists to outlive it.
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[1].id)}`);
	refused(await readPersonPhoto(db, storage, ctx(1), { personId: alex.id, versionId: second.pending.uploadId }));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[1].id)}`);

	const removed = ok(
		await tx(async (t) =>
			fields.removePersonPhoto(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(alex.id),
				input: { personId: alex.id },
			}),
		),
	);
	assert.deepEqual(removed.photo, { status: "absent" });
	refused(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: second.pending.uploadId }));
	// A retired Person's photo is unavailable.
	const third = await upload(png);
	ok(await set(third.pending.uploadId));
	await retire({ id: alex.id, revision: await revisionOf(alex.id) });
	refused(await tx((t) => fields.getPersonPhoto(t, ctx(), { personId: alex.id })));
	refused(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: third.pending.uploadId }));
});
