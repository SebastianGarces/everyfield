import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import {
	peopleWriter as write,
	peopleReader as read,
	accountPersonProducer as accounts,
	getAccountLink,
	readColumnOrders,
	readPersonPage,
} from "../../../packages/domain/src/people/index.ts";

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
const schema = "wp011_" + randomUUID().replaceAll("-", ""),
	role = "wp011_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 6,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
let queries = [];

const plants = [randomUUID(), randomUUID()],
	organization = randomUUID(),
	actors = Array.from({ length: 5 }, () => ({
		id: randomUUID(),
		user: randomUUID(),
		session: randomUUID(),
	}));
const ctx = (who = 0, selected = { kind: "plant", id: plants[0] }) => ({
	session: actors[who].session,
	selected,
});
const orgCtx = () =>
	ctx(3, {
		kind: "organization",
		id: organization,
		organizationKind: "sending_church",
	});
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
};
async function tx(body) {
	return db.transaction(body);
}

async function create(name = "Jamie", fields = {}) {
	return ok(
		await tx((t) =>
			write.createPerson(t, ctx(), {
				requestKey: randomUUID(),
				input: { displayName: name, ...fields },
			}),
		),
	).person;
}
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
	db = createDatabase({
		connectionString: url.href,
		max: 6,
		options: `-c search_path=${schema},pg_catalog,pg_temp`,
	});
	db.$client.on("connect", (client) => {
		const query = client.query;
		client.query = function (...args) {
			queries.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
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
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(id)},'Synthetic','America/New_York',7,14,1,8,1,1)`,
		);
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${sql.param(organization)},'sending_church','Synthetic','America/New_York',1)`,
	);
	for (const [i, plant, organizationId, roleName] of [
		[0, plants[0], null, "owner"],
		[1, plants[0], null, "member"],
		[2, plants[1], null, "admin"],
		[3, null, organization, "owner"],
		[4, plants[0], null, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(organizationId)},${sql.param(roleName)},clock_timestamp())`,
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

test("AC:TARGET-PPL-002 AC:WP011-KNOW-099 AC:SEC-02 AC:TEN-002 minimal contact, explicit null, current tenancy and atomic retry", async () => {
	const input = {
		requestKey: randomUUID(),
		input: {
			displayName: "  Jamie  ",
			city: "Chicago",
			summaryNotes: "Operational",
		},
	};
	const first = ok(await tx((t) => write.createPerson(t, ctx(), input))),
		again = ok(await tx((t) => write.createPerson(t, ctx(), input)));
	assert.deepEqual(again, first);
	const replayCounts = (
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events`,
		)
	).rows[0];
	for (const changed of [
		(t) => write.createPerson(t, ctx(), { ...input, input: { displayName: "Different request body" } }),
		(t) => write.createPerson(t, ctx(4), input),
		(t) =>
			write.updatePerson(t, ctx(), {
				requestKey: input.requestKey,
				expectedRevision: first.person.revision,
				input: { personId: first.person.id, patch: { city: "Different operation" } },
			}),
	])
		refused(await tx(changed), "conflict");
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events`,
			)
		).rows[0],
		replayCounts,
	);
	assert.equal(first.person.displayName, "Jamie");
	assert.equal(first.person.adultClassification, "unknown");
	assert.deepEqual(first.person.commitment, { state: "unknown" });
	assert.equal(first.person.firstName, null);
	const changed = ok(
		await tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: first.person.revision,
				input: { personId: first.person.id, patch: { city: null } },
			}),
		),
	);
	assert.equal(changed.person.city, null);
	refused(
		await tx((t) =>
			write.updatePerson(t, ctx(1), {
				requestKey: randomUUID(),
				expectedRevision: changed.person.revision,
				input: { personId: first.person.id, patch: { displayName: "forged" } },
			}),
		),
	);
	refused(await tx((t) => read.getPerson(t, ctx(2), { personId: first.person.id })));
	refused(await tx((t) => read.getPerson(t, ctx(2), { personId: randomUUID() })));
	assert.equal(
		ok(await tx((t) => read.getPerson(t, ctx(1), { personId: first.person.id }))).person.displayName,
		"Jamie",
	);
	const event = (
		await admin.execute(
			sql`SELECT actor_id,reason,metadata->'diff' AS diff FROM audit_event WHERE command_id=${sql.param(changed.receiptId)}`,
		)
	).rows[0];
	assert.equal(event.actor_id, actors[0].id);
	assert.equal(event.reason, null);
	assert.equal(event.diff, null);
	assert.equal(
		(await admin.execute(sql`SELECT tenant_id FROM person WHERE id=${sql.param(first.person.id)}`)).rows[0].tenant_id,
		plants[0],
	);
	const n = (await admin.execute(sql`SELECT count(*)::int AS n FROM person`)).rows[0].n;
	await assert.rejects(
		tx(async (t) => {
			ok(
				await write.createPerson(t, ctx(), {
					requestKey: randomUUID(),
					input: { displayName: "rollback" },
				}),
			);
			throw Error("required_intent_fault");
		}),
		/required_intent_fault/,
	);
	assert.equal((await admin.execute(sql`SELECT count(*)::int AS n FROM person`)).rows[0].n, n);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[4].id)}`);
	refused(await tx((t) => write.createPerson(t, ctx(4), input)));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[4].id)}`);
});

test("AC:TARGET-PPL-001 literal search, tag intersection, full totals and page numbers past ties", async () => {
	const a = await create("Literal %_ person"),
		b = await create("Literal %_ person 2");
	await admin.execute(
		sql`UPDATE person SET created_at='2026-10-01T12:00:00Z' WHERE id=ANY(${sql.param([a.id, b.id])})`,
	);
	const req = { search: "%_", limit: 1 };
	const page = ok(await tx((t) => read.listPeople(t, ctx(1), req)));
	assert.equal(page.total, 2);
	assert.equal(page.items.length, 1);
	assert.equal(page.next, 2);
	const second = ok(await tx((t) => read.listPeople(t, ctx(1), { ...req, page: 2 })));
	assert.equal(second.items.length, 1);
	assert.notEqual(second.items[0].id, page.items[0].id);
	assert.equal(second.next, null);
	// D67: a page past the end is an empty page with the full total, never a refusal.
	const beyond = ok(await tx((t) => read.listPeople(t, ctx(1), { ...req, page: 3 })));
	assert.deepEqual([beyond.items, beyond.total, beyond.next], [[], 2, null]);
	// The church comes from the session, so another church's page 2 never shows these people.
	const other = ok(await tx((t) => read.listPeople(t, ctx(2, { kind: "plant", id: plants[1] }), { ...req, page: 2 })));
	assert.deepEqual([other.items, other.total], [[], 0]);
	refused(await tx((t) => read.listPeople(t, ctx(), { search: "Literal", privateNote: "CANARY" })), "invalid_input");
	const tags = [randomUUID(), randomUUID()];
	for (const [i, id] of tags.entries())
		await admin.execute(
			sql`INSERT INTO tag(id,plant_id,name,normalized_name,color) VALUES(${sql.param(id)},${sql.param(plants[0])},${sql.param("tag" + i)},${sql.param("tag" + i)},'blue')`,
		);
	for (const [person, tag] of [
		[a.id, tags[0]],
		[a.id, tags[1]],
		[b.id, tags[0]],
	])
		await admin.execute(
			sql`INSERT INTO person_tag(person_id,plant_id,tag_id) VALUES(${sql.param(person)},${sql.param(plants[0])},${sql.param(tag)})`,
		);
	const tagged = ok(await tx((t) => read.listPeople(t, ctx(), { tags })));
	assert.deepEqual(
		tagged.items.map((p) => p.id),
		[a.id],
	);
});

test("BUG-110: people pages retain microseconds across 25 equal timestamp keys", async (t) => {
	const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
	t.after(() => admin.execute(sql`DELETE FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`));
	for (const id of ids)
		await admin.execute(
			sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at) VALUES(${id},${plants[0]},${plants[0]},'Microsecond people','other','prospect','unknown','unknown',0,'live','2026-10-01T12:00:00.123456Z')`,
		);
	for (const view of ["list", "pipeline"]) {
		const first = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Microsecond people", view, limit: 24 })));
		assert.equal(first.total, 25);
		assert.deepEqual(
			first.items.map((p) => p.id),
			ids.slice(0, 24),
		);
		assert.equal(first.completeness, "partial");
		const last = ok(
			await tx((t) => read.listPeople(t, ctx(), { search: "Microsecond people", view, limit: 24, page: first.next })),
		);
		assert.deepEqual(
			last.items.map((p) => p.id),
			ids.slice(24),
		);
		assert.equal(last.total, 25);
		assert.equal(last.next, null);
		assert.equal(last.completeness, "complete");
	}
});

test("BUG-110: activity pages retain microseconds across equal timestamp keys", async () => {
	const p = await create("Microsecond activities");
	const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
	for (const id of ids)
		await admin.execute(
			sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at) VALUES(${id},${plants[0]},${plants[0]},${p.id},${actors[0].id},'Microsecond note','2026-10-01T12:00:00.654321Z','2026-10-01T12:00:00.654321Z')`,
		);
	const first = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"], limit: 24 })));
	assert.deepEqual(
		first.items.map((a) => a.id),
		ids.slice(0, 24),
	);
	assert.equal(first.completeness, "partial");
	const last = ok(
		await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"], limit: 24, page: first.next })),
	);
	assert.deepEqual(
		last.items.map((a) => a.id),
		ids.slice(24),
	);
	assert.equal(last.next, null);
	assert.equal(last.completeness, "complete");
});

test("AC:TARGET-PPL-004 AC:ROLE43-003 exact account links, ambiguous contact selection and concurrent uniqueness", async () => {
	const contact = await create("Proven account", {
			email: actors[0].id + "@example.test",
		}),
		duplicate = await create("Another contact", {
			email: actors[0].id + "@example.test",
		});
	const input = {
		accountId: actors[0].id,
		owner: ctx().selected,
		selection: { kind: "resolve" },
	};
	const needs = ok(await tx((t) => accounts.ensureAccountPerson(t, input)));
	assert.equal(needs.status, "needs_selection");
	assert.deepEqual(new Set(needs.candidatePersonIds), new Set([contact.id, duplicate.id]));
	const selected = {
		...input,
		selection: {
			kind: "reviewed_contact",
			person: {
				owner: ctx().selected,
				personId: contact.id,
				revision: contact.revision,
				state: "live",
			},
		},
	};
	const results = await Promise.all([
		tx((t) => accounts.ensureAccountPerson(t, selected)),
		tx((t) => accounts.ensureAccountPerson(t, selected)),
	]);
	for (const r of results) assert.equal(ok(r).personId, contact.id);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM person WHERE linked_account_id=${sql.param(actors[0].id)} AND plant_id=${sql.param(plants[0])} AND state='live'`,
			)
		).rows[0].n,
		1,
	);
	assert.deepEqual(ok(await tx((t) => getAccountLink(t, ctx(), { personId: contact.id }))), {
		status: "linked",
		personId: contact.id,
	});
	assert.deepEqual(ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))), {
		status: "linked",
		personId: contact.id,
	});
	const dto = ok(await tx((t) => read.getPerson(t, ctx(), { personId: contact.id }))).person;
	assert.equal("linkedAccountId" in dto, false);
	assert.deepEqual(dto.commitment, { state: "unknown" });
	await tx((t) =>
		write.updatePerson(t, ctx(), {
			requestKey: randomUUID(),
			expectedRevision: dto.revision,
			input: { personId: contact.id, patch: { email: "crm@example.test" } },
		}),
	);
	assert.equal(ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))).personId, contact.id);
	const current = ok(await tx((t) => read.getPerson(t, ctx(), { personId: contact.id }))).person;
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: current.id }))).reviewRevision;
	const retired = ok(
		await tx((t) =>
			write.retirePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: { personId: current.id, reason: "Retire linked Person", reviewRevision: review, handoffs: [] },
			}),
		),
	);
	const replacement = ok(
		await tx((t) =>
			accounts.ensureAccountPerson(t, { ...input, selection: { kind: "create", displayName: "New linked Person" } }),
		),
	);
	assert.notEqual(replacement.personId, current.id);
	const bootstrap = (
		await admin.execute(
			sql`SELECT stage,adult_classification,commitment_state FROM person WHERE id=${sql.param(replacement.personId)}`,
		)
	).rows[0];
	assert.deepEqual(bootstrap, { stage: "leader", adult_classification: "unknown", commitment_state: "unknown" });
	const bootstrapHistory = (
		await admin.execute(
			sql`SELECT after_value->>'stage' AS stage FROM audit_event WHERE subject_id=${sql.param(replacement.personId)}`,
		)
	).rows;
	assert.deepEqual(bootstrapHistory, [{ stage: "leader" }]);
	const request = {
		requestKey: randomUUID(),
		expectedRevision: retired.person.revision,
		input: { personId: current.id },
	};
	const counts = (
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) history,(SELECT count(*)::int FROM audit_event) events`,
		)
	).rows[0];
	await tx(async (t) => {
		const refusal = await write.restorePerson(t, ctx(), request);
		refused(refusal, "conflict");
		assert.deepEqual(refusal.error.details, {});
		assert.equal(refusal.error.retry, "refresh");
		assert.equal((await t.execute(sql`SELECT 1 AS usable`)).rows[0].usable, 1);
	});
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT (SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) history,(SELECT count(*)::int FROM audit_event) events`,
			)
		).rows[0],
		counts,
	);
	assert.equal(ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))).personId, replacement.personId);
	assert.deepEqual(
		(await admin.execute(sql`SELECT state,revision,linked_account_id FROM person WHERE id=${sql.param(current.id)}`))
			.rows[0],
		{ state: "retired", revision: retired.person.revision, linked_account_id: actors[0].id },
	);
});

test("AC:WP011-KNOW-098 named guest and explicit selection share the caller transaction", async () => {
	const guest = ok(await tx((t) => accounts.ensureGuest(t, ctx(), { kind: "new", displayName: "Guest" })));
	assert.equal(
		ok(
			await tx((t) =>
				accounts.ensureGuest(t, ctx(), {
					kind: "existing",
					personId: guest.personId,
				}),
			),
		).personId,
		guest.personId,
	);
	const n = (await admin.execute(sql`SELECT count(*)::int n FROM person`)).rows[0].n;
	await assert.rejects(
		tx(async (t) => {
			ok(
				await accounts.ensureGuest(t, ctx(), {
					kind: "new",
					displayName: "Attendance rollback",
				}),
			);
			throw Error("attendance_fault");
		}),
		/attendance_fault/,
	);
	assert.equal((await admin.execute(sql`SELECT count(*)::int n FROM person`)).rows[0].n, n);
});

test("AC:TARGET-PPL-006 AC:TARGET-PPL-007 AC:TARGET-PPL-003 stage skip, no-op, complete handoffs, retirement and guarded restore", async () => {
	let p = await create("Lifecycle");
	let result = ok(
		await tx((t) =>
			write.changeStatus(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					stage: "leader",
					reason: "Human chose a skip",
					handoffs: [],
				},
			}),
		),
	);
	p = result.person;
	assert.equal(p.stage, "leader");
	assert.deepEqual(p.commitment, { state: "unknown" });
	const noop = ok(
		await tx((t) =>
			write.changeStatus(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					stage: "leader",
					reason: "Same stage",
					handoffs: [],
				},
			}),
		),
	);
	assert.equal(noop.outcome, "noop");
	assert.equal(noop.person.revision, p.revision);
	const duty = randomUUID(),
		team = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source) VALUES(${sql.param(team)},${sql.param(plants[0])},'Retiring leader','active',0,${sql.param(p.id)},'explicit')`,
	);
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,assignee_id,due_kind,person_id) VALUES(${sql.param(duty)},${sql.param(plants[0])},'Call','follow_up','medium','not_started',clock_timestamp(),${sql.param(actors[0].id)},'undated',${sql.param(p.id)})`,
	);
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id }))).reviewRevision;
	refused(
		await tx((t) =>
			write.retirePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					reason: "Retire",
					reviewRevision: review,
					handoffs: [],
				},
			}),
		),
		"conflict",
	);
	const retired = ok(
		await tx((t) =>
			write.retirePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					reason: "Retire",
					reviewRevision: review,
					handoffs: [{ kind: "needs_owner", dutyId: duty, expectedRevision: "1" }],
				},
			}),
		),
	);
	assert.deepEqual(retired.needsOwner, [duty]);
	assert.equal(retired.person.lifecycle.state, "retired");
	assert.deepEqual(
		(
			await admin.execute(
				sql`SELECT leader_person_id,leader_source,leader_role_id,revision FROM team WHERE id=${sql.param(team)}`,
			)
		).rows[0],
		{ leader_person_id: null, leader_source: null, leader_role_id: null, revision: "2" },
	);
	assert.equal(ok(await tx((t) => read.listPeople(t, ctx(), { search: "Lifecycle" }))).total, 0);
	await assert.rejects(
		admin.execute(
			sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES(${sql.param(plants[0])},'New','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(p.id)})`,
		),
		(error) =>
			error instanceof Error &&
			error.cause instanceof Error &&
			"code" in error.cause &&
			error.cause.code === "23514" &&
			error.cause.message === "person_not_live",
	);
	const restored = ok(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: retired.person.revision,
				input: { personId: p.id },
			}),
		),
	);
	assert.equal(restored.person.lifecycle.state, "live");
	const warnings = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })));
	assert.equal(warnings.hardGate, false);
	assert.equal(warnings.allowedStages.length, 7);
	const pipeline = ok(await tx((t) => read.getPipelineData(t, ctx(1), {})));
	assert.equal(pipeline.groups.length, 5);
	assert.ok(pipeline.groups.find((g) => g.column === "core_group").cards.some((card) => card.person.id === p.id));
	// A person outside the named column is refused, never moved (D68: a move names one person).
	refused(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { column: "prospect", personId: p.id, afterId: null },
			}),
		),
		"conflict",
	);
	const survivor = await create("Survivor");
	await admin.execute(
		sql`UPDATE person SET state='merged',merged_into_person_id=${sql.param(survivor.id)},retired_at=clock_timestamp() WHERE id=${sql.param(p.id)}`,
	);
	refused(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: restored.person.revision,
				input: { personId: p.id },
			}),
		),
		"use_reviewed_unmerge",
	);
});

test("AC:TARGET-PPL-008 original author and exact note revisions preserve occurrence, tombstone and removed attribution", async () => {
	const p = await create("Notes");
	const added = ok(
		await tx((t) =>
			write.addNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body: "Original operational note" },
			}),
		),
	);
	const assertNoteFeed = async (kind) => {
		const feed = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id })));
		assert.deepEqual(
			feed.items.map((a) => (a.kind === "activity" ? a.action : a.kind)),
			["created", kind],
		);
	};
	await assertNoteFeed("note");
	const before = (
		await admin.execute(sql`SELECT occurred_at,author_id FROM person_note WHERE id=${sql.param(added.noteId)}`)
	).rows[0];
	refused(
		await tx((t) =>
			write.editNote(t, ctx(4), {
				requestKey: randomUUID(),
				expectedRevision: added.revision,
				input: {
					personId: p.id,
					noteId: added.noteId,
					body: "Not mine",
					reason: "Edit",
				},
			}),
		),
	);
	const edited = ok(
		await tx((t) =>
			write.editNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: added.revision,
				input: {
					personId: p.id,
					noteId: added.noteId,
					body: "Corrected operational note",
					reason: "Correction",
				},
			}),
		),
	);
	assert.deepEqual(
		(await admin.execute(sql`SELECT occurred_at,author_id FROM person_note WHERE id=${sql.param(added.noteId)}`))
			.rows[0],
		before,
	);
	const timeline = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] })));
	assert.equal(timeline.items[0].body, "Corrected operational note");
	await assertNoteFeed("note");
	const deleted = ok(
		await tx((t) =>
			write.deleteNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: edited.revision,
				input: { personId: p.id, noteId: added.noteId, reason: "Remove body" },
			}),
		),
	);
	assert.equal(deleted.revision, "3");
	await assertNoteFeed("note_removed");
	assert.deepEqual(
		(
			await admin.execute(sql`SELECT
			(SELECT count(*)::int FROM audit_event e JOIN audit_event o ON o.id=e.command_id WHERE e.subject_id=${p.id} AND o.request_identity->>'operation' IN ('people.addNote','people.editNote','people.deleteNote')) AS audits,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${p.id} AND metadata->>'correction'='true') AS corrections,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${p.id} AND action='people.updated' AND metadata->>'category' IS DISTINCT FROM 'note') AS updates`)
		).rows[0],
		{ audits: 3, corrections: 2, updates: 0 },
	);
	assert.equal(
		(await admin.execute(sql`SELECT body FROM person_note WHERE id=${sql.param(added.noteId)}`)).rows[0].body,
		"",
	);
	assert.equal(
		ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] }))).items[0].kind,
		"note_removed",
	);
});

test("AC:CA014 explicit adult classification retains genuine historical acquisition rather than creating a join today", async () => {
	const p = await create("Historical commitment");
	const commitment = randomUUID();
	await admin.execute(
		sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES(${sql.param(commitment)},${sql.param(plants[0])},${sql.param(p.id)},'core_group','2026-09-01',clock_timestamp())`,
	);
	await admin.execute(
		sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES(${sql.param(randomUUID())},${sql.param(plants[0])},${sql.param(p.id)},'launch_team','2026-10-05',clock_timestamp())`,
	);
	await admin.execute(sql`UPDATE person SET commitment_state='active' WHERE id=${sql.param(p.id)}`);
	const result = ok(
		await tx((t) =>
			write.recordAdultClassification(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					classification: "adult",
					occurredOn: "2026-10-13",
					reason: "Human recorded classification",
				},
			}),
		),
	);
	assert.equal(result.observation.classification, "adult");
	assert.equal(result.observation.current.state, "active");
	assert.equal(result.observation.firstAcquisition.occurredOn, "2026-09-01");
	assert.equal(result.observation.firstAcquisition.evidenceId, commitment);
	const before = (await admin.execute(sql`SELECT signed_on FROM commitment WHERE id=${sql.param(commitment)}`)).rows[0]
		.signed_on;
	const corrected = ok(
		await tx((t) =>
			write.correctAdultClassification(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: result.observation.sourceRevision,
				input: {
					personId: p.id,
					classification: "unknown",
					occurredOn: "2026-10-13",
					reason: "Correct unsupported classification",
				},
			}),
		),
	);
	assert.equal(corrected.observation.classification, "unknown");
	assert.equal(corrected.observation.current.state, "active");
	assert.deepEqual(corrected.observation.firstAcquisition, {
		status: "known",
		occurredOn: "2026-09-01",
		evidenceId: commitment,
	});
	assert.deepEqual(
		(await admin.execute(sql`SELECT signed_on FROM commitment WHERE id=${sql.param(commitment)}`)).rows[0].signed_on,
		before,
	);
});

test("INV-people: concurrent edits serialize to one current revision and one conflict without partial history", async () => {
	const p = await create("Concurrent");
	const change = (name) =>
		tx((t) =>
			write.updatePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, patch: { displayName: name } },
			}),
		);
	const results = await Promise.all([change("Winner A"), change("Winner B")]);
	assert.equal(results.filter((r) => r.status === "ok").length, 1);
	const failure = results.find((r) => r.status !== "ok");
	refused(failure, "conflict");
	const row = ok(await tx((t) => read.getPerson(t, ctx(), { personId: p.id }))).person;
	assert.equal(BigInt(row.revision), BigInt(p.revision) + 1n);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${sql.param(p.id)} AND action='people.updated'`,
			)
		).rows[0].n,
		1,
	);
});

test("AC:WP011-KNOW-069 account removal severs account links and preserves church-owned facts with minimal attribution", async () => {
	const { detachAccountPersonLinks } = await import("../../../packages/domain/src/people/index.ts");
	const linked = ok(
		await tx((t) =>
			accounts.ensureAccountPerson(t, {
				accountId: actors[4].id,
				owner: ctx().selected,
				selection: { kind: "create", displayName: "Shared church contact" },
			}),
		),
	);
	const p = ok(await tx((t) => read.getPerson(t, ctx(), { personId: linked.personId }))).person;
	const note = ok(
		await tx((t) =>
			write.addNote(t, ctx(4), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body: "Shared operational fact" },
			}),
		),
	);
	await admin.execute(
		sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,account_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state) VALUES('account',${sql.param(actors[4].id)},${sql.param(actors[4].id)},${sql.param(randomUUID())},1,'purging','2026-09-01Z','2026-10-01Z',1,'in_progress')`,
	);
	const retained = await tx((t) => detachAccountPersonLinks(t, actors[4].id));
	assert.ok(retained.retainedPersonIds.includes(p.id));
	const current = ok(await tx((t) => read.getPerson(t, ctx(), { personId: p.id }))).person;
	assert.equal(current.displayName, "Shared church contact");
	assert.equal(current.lifecycle.state, "live");
	assert.deepEqual(ok(await tx((t) => getAccountLink(t, ctx(), { personId: p.id }))), { status: "unlinked" });
	const notes = ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] })));
	assert.equal(notes.items[0].body, "Shared operational fact");
	assert.equal(notes.items[0].actor.kind, "former_account");
	assert.equal(
		(await admin.execute(sql`SELECT author_id FROM person_note WHERE id=${sql.param(note.noteId)}`)).rows[0].author_id,
		null,
	);
	refused(await tx((t) => read.getPerson(t, ctx(4), { personId: p.id })));
});

test("INV-pipeline: native moves place one person, persist and retry once", async () => {
	await create("Order A");
	await create("Order B");
	const column = async () =>
		ok(await tx((t) => read.listPeople(t, ctx(), { view: "pipeline", stages: ["prospect"], limit: 100 }))).items.map(
			(p) => p.id,
		);
	const all = await column();
	const last = all.at(-1);
	const initialPipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), {})));
	const seen = initialPipeline.groups.find((g) => g.column === "prospect").revision;
	const order = {
		requestKey: randomUUID(),
		expectedRevision: seen,
		input: { column: "prospect", personId: last, afterId: null },
	};
	refused(await tx((t) => write.reorderPipeline(t, ctx(1), order)));
	refused(
		await tx((t) => write.reorderPipeline(t, ctx(), { ...order, input: { ...order.input, afterId: randomUUID() } })),
		"conflict",
	);
	const audits = async () => (await admin.execute(sql`SELECT count(*)::int AS n FROM audit_event`)).rows[0].n;
	const before = await audits();
	const saved = ok(await tx((t) => write.reorderPipeline(t, ctx(), order)));
	assert.equal(saved.outcome, "changed");
	assert.deepEqual(ok(await tx((t) => write.reorderPipeline(t, ctx(), order))), saved);
	assert.equal((await audits()) - before, 1, "one audit event for the move; the retry replays without writing");
	const first = [last, ...all.slice(0, -1)];
	assert.deepEqual(await column(), first);
	refused(await tx((t) => write.reorderPipeline(t, ctx(), { ...order, requestKey: randomUUID() })), "conflict");
	const refreshedPipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), { stages: ["leader"] })));
	assert.equal(refreshedPipeline.groups.find((g) => g.column === "prospect").revision, String(Number(seen) + 1));
});

test("AC:TARGET-PPL-007 INV-stale-view (D68): joining or leaving a column refuses a move from the older view", async () => {
	const revision = async (column) => (await tx(async (t) => (await readColumnOrders(t, ctx(), [column]))[0])).revision;
	// A move with the given column revision; refused when the column changed since that view (verifier finding on 93cf953).
	const moveWith = (rev, personId, afterId) =>
		tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: rev,
				input: { column: "following_up", personId, afterId },
			}),
		);
	const a = await create("Stale A", { stage: "following_up" });
	const b = await create("Stale B", { stage: "following_up" });
	const c = await create("Stale C", { stage: "following_up" });
	// Create: someone joins the column.
	let seen = await revision("following_up");
	await create("Stale D", { stage: "following_up" });
	refused(await moveWith(seen, a.id, c.id), "conflict");
	// Stage change: B leaves for attendee; both columns move on, so a view of either is outdated.
	seen = await revision("following_up");
	const attendeeSeen = await revision("attendee");
	const moved = ok(
		await tx((t) =>
			write.changeStatus(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: b.revision,
				input: { personId: b.id, stage: "attendee", reason: "Stale view", handoffs: [] },
			}),
		),
	);
	assert.notEqual(await revision("attendee"), attendeeSeen, "the column B joined moves on");
	refused(await moveWith(seen, a.id, c.id), "conflict");
	// Retire and restore: C leaves, then comes back.
	seen = await revision("following_up");
	const review = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: c.id }))).reviewRevision;
	const retired = ok(
		await tx((t) =>
			write.retirePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: c.revision,
				input: { personId: c.id, reason: "Stale view", reviewRevision: review, handoffs: [] },
			}),
		),
	);
	refused(await moveWith(seen, a.id, null), "conflict");
	seen = await revision("following_up");
	ok(
		await tx((t) =>
			write.restorePerson(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: retired.person.revision,
				input: { personId: c.id },
			}),
		),
	);
	refused(await moveWith(seen, a.id, null), "conflict");
	// The current view saves.
	ok(await moveWith(await revision("following_up"), a.id, null));
	// A change inside the committed column (core group to leader) keeps that column's order and revision.
	const core = await create("Stale core", { stage: "core_group" });
	const coreSeen = await revision("core_group");
	ok(
		await tx((t) =>
			write.changeStatus(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: core.revision,
				input: { personId: core.id, stage: "leader", reason: "Milestone", handoffs: [] },
			}),
		),
	);
	assert.equal(await revision("core_group"), coreSeen);
	assert.equal(moved.person.stage, "attendee");
});

test("BUG-FB-review-1: full People pages and pipeline use fixed database round trips", async (t) => {
	const ids = Array.from({ length: 101 }, () => randomUUID()).sort();
	t.after(async () => {
		await admin.execute(sql`DELETE FROM task WHERE person_id=ANY(${sql.param(ids)}::uuid[])`);
		await admin.execute(sql`DELETE FROM commitment WHERE person_id=ANY(${sql.param(ids)}::uuid[])`);
		await admin.execute(sql`DELETE FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`);
	});
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
		SELECT id,${plants[0]}::uuid,${plants[0]}::uuid,'Batch regression','other','prospect','unknown','unknown',0,'live','2026-10-01T12:00:00.123456Z'::timestamptz
		FROM unnest(${sql.param(ids)}::uuid[]) id`);
	const counts = { list: [], card: [], pipeline: [] };
	for (const limit of [25, 50, 100]) {
		for (const view of ["list", "card", "pipeline"]) {
			queries = [];
			const result = ok(
				await tx((t) =>
					view === "pipeline"
						? read.getPipelineData(t, ctx(), { search: "Batch regression", limit })
						: read.listPeople(t, ctx(), { search: "Batch regression", limit, view }),
				),
			);
			counts[view].push(queries.length);
			const page = view === "pipeline" ? result.groups.find((g) => g.column === "prospect") : result;
			const items = view === "pipeline" ? page.cards.map((c) => c.person) : page.items;
			assert.deepEqual(
				items.map((p) => p.id),
				ids.slice(0, limit),
			);
			assert.equal(page.total, 101);
			assert.equal(page.next, 2);
			assert.deepEqual(
				items.map((p) => p.commitment),
				Array.from({ length: limit }, () => ({ state: "unknown" })),
			);
			if (view === "pipeline")
				assert.deepEqual(
					page.cards.map((c) => ({ duties: c.activeParentDuties, coverage: c.coverage })),
					Array.from({ length: limit }, () => ({ duties: [], coverage: "uncovered" })),
				);
		}
	}
	t.diagnostic(JSON.stringify(counts));
	assert.deepEqual(counts.list, [counts.list[0], counts.list[0], counts.list[0]]);
	assert.deepEqual(counts.card, counts.list);
	assert.ok(counts.list[0] <= 9, "list round-trip budget includes authorization and transaction overhead");
	assert.deepEqual(counts.pipeline, [counts.pipeline[0], counts.pipeline[0], counts.pipeline[0]]);
	assert.ok(counts.pipeline[0] <= 32, "pipeline round-trip budget includes all columns");
	const evidence = [randomUUID(), randomUUID()].sort();
	await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
		SELECT id,${plants[0]}::uuid,${ids[0]}::uuid,'launch_team','2099-01-01',clock_timestamp() FROM unnest(${sql.param(evidence)}::uuid[]) id`);
	await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,voided_at)
		VALUES(${randomUUID()},${plants[0]},${ids[0]},'core_group','2099-02-01',clock_timestamp(),clock_timestamp())`);
	await admin.execute(sql`UPDATE person SET commitment_state='withdrawn' WHERE id=${ids[0]}`);
	const projected = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Batch regression", limit: 25 })));
	assert.deepEqual(projected.items[0].commitment, {
		state: "withdrawn",
		evidenceId: evidence[1],
		kind: "launch_team",
		occurredOn: "2099-01-01",
		revision: "1",
	});
	assert.deepEqual(projected.items[1].commitment, { state: "unknown" });
	assert.deepEqual(ok(await tx((t) => read.getPerson(t, ctx(), { personId: ids[0] }))).person, projected.items[0]);
	const duties = Array.from({ length: 100 }, () => randomUUID()).sort();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		SELECT id,${plants[0]}::uuid,'Call','follow_up','medium','not_started',clock_timestamp(),'undated',${ids[0]}::uuid FROM unnest(${sql.param(duties)}::uuid[]) id`);
	const overdue = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id)
		VALUES(${overdue},${plants[0]},'Call','follow_up','medium','not_started',clock_timestamp(),'date_only','2000-01-01',${ids[1]})`);
	const pipeline = ok(await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25 })));
	const cards = pipeline.groups.find((g) => g.column === "prospect").cards;
	assert.deepEqual(cards[0], {
		person: projected.items[0],
		activeParentDuties: duties.map((id) => ({ id, dueOn: null, warning: "missing_due_date" })),
		coverage: "covered",
	});
	assert.deepEqual(cards[1].activeParentDuties, [{ id: overdue, dueOn: "2000-01-01", warning: "overdue" }]);
	assert.equal(cards[1].coverage, "covered");
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		VALUES(${randomUUID()},${plants[0]},'Overflow','follow_up','medium','not_started',clock_timestamp(),'undated',${ids[0]})`);
	refused(
		await tx((t) => read.getPipelineData(t, ctx(), { search: "Batch regression", limit: 25 })),
		"source_unavailable",
	);
});

test("AC:TARGET-PPL-007 INV-move-round-trips (D68): a pipeline move is one transaction with a constant round-trip count", async (t) => {
	const ids = Array.from({ length: 10 }, () => randomUUID()).sort();
	// No cleanup: the disposable schema is dropped after the suite.
	// People with keys 1, 2, 3, ... in id order, as the writer leaves a column.
	const insert = (some, from) =>
		admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			SELECT id,${plants[0]}::uuid,${plants[0]}::uuid,'Move regression','other','interviewed','unknown','unknown',${from}::int + n,'live',clock_timestamp()
			FROM unnest(${sql.param(some)}::uuid[]) WITH ORDINALITY AS t(id, n)`);
	// Every audit row in the schema: the move must add exactly one, whatever its subject (D70).
	const history = async () => (await admin.execute(sql`SELECT count(*)::int AS n FROM audit_event`)).rows[0].n;
	// The reorder action: the producer's command plus one column read, in one transaction.
	const move = async (personId, afterId) => {
		const column = await tx(async (t) => (await readColumnOrders(t, ctx(), ["interviewed"]))[0]);
		const rows = await history();
		queries = [];
		const order = ok(
			await tx(async (t) => {
				const done = await write.reorderPipeline(t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision: column.revision,
					input: { column: "interviewed", personId, afterId },
				});
				return done.status === "ok"
					? { status: "ok", value: (await readColumnOrders(t, ctx(), ["interviewed"]))[0] }
					: done;
			}),
		);
		const count = queries.length;
		assert.equal(order.revision, String(Number(column.revision) + 1));
		return { count, order: order.personIds, history: (await history()) - rows };
	};
	await insert(ids.slice(0, 3), 0);
	const few = await move(ids[2], null);
	assert.deepEqual(few.order, [ids[2], ids[0], ids[1]]);
	await insert(ids.slice(3), 3);
	const many = await move(ids[9], ids[0]);
	assert.deepEqual(many.order, [ids[2], ids[0], ids[9], ids[1], ...ids.slice(3, 9)]);
	t.diagnostic(JSON.stringify({ reorder: [few.count, many.count] }));
	assert.equal(many.count, few.count, "a move in a column of 10 costs the same as in a column of 3");
	assert.deepEqual([few.history, many.history], [1, 1], "a move changes one person and writes one audit event");
	assert.ok(few.count <= 10, `reorder round trips: ${few.count}`);
	// Legacy ties: 30 people who all share key 0, as every person had before migration 0015. After the migration a move
	// between any two neighbours still changes exactly one row and writes one audit event.
	const legacy = Array.from({ length: 20 }, () => randomUUID()).sort();
	ids.push(...legacy);
	await insert(legacy, 0);
	await admin.execute(sql`UPDATE person SET pipeline_position=0 WHERE id=ANY(${sql.param(ids)}::uuid[])`);
	const tied = (await tx(async (t) => (await readColumnOrders(t, ctx(), ["interviewed"]))[0])).personIds;
	await admin.execute(
		sql.raw(
			await readFile(
				new URL("../../../packages/db/migrations/0015_unique_pipeline_positions.sql", import.meta.url),
				"utf8",
			),
		),
	);
	const positions = async () =>
		new Map(
			(
				await admin.execute(
					sql`SELECT id, pipeline_position::text AS k FROM person WHERE id=ANY(${sql.param(ids)}::uuid[])`,
				)
			).rows.map((r) => [r.id, r.k]),
		);
	const spread = await positions();
	assert.equal(new Set(spread.values()).size, 30, "the migration gives every person a key of their own");
	assert.deepEqual(
		(await tx(async (t) => (await readColumnOrders(t, ctx(), ["interviewed"]))[0])).personIds,
		tied,
		"and keeps the order",
	);
	const [mover, anchor] = [tied[25], tied[3]];
	const legacyMove = await move(mover, anchor);
	const expected = tied.filter((x) => x !== mover);
	expected.splice(expected.indexOf(anchor) + 1, 0, mover);
	assert.deepEqual(legacyMove.order, expected);
	const changedRows = [...(await positions())].filter(([pid, k]) => spread.get(pid) !== k).map(([pid]) => pid);
	assert.deepEqual(changedRows, [mover], "exactly one row changed");
	assert.equal(legacyMove.history, 1, "one audit event");
	assert.equal(legacyMove.count, few.count, "the same statements in a column of 30");
	// 200 alternating moves into the same gap (verifier repro on 38c508f failed at move 59): each move halves the gap,
	// lands strictly between its neighbours, changes exactly one row and writes one audit event.
	const [top, m1, m2] = legacyMove.order;
	let keys = await positions();
	for (let i = 0; i < 200; i++) {
		const [mover, other] = i % 2 ? [m1, m2] : [m2, m1];
		const step = await move(mover, top);
		assert.deepEqual(step.order.slice(0, 3), [top, mover, other], `move ${i + 1} keeps the requested order`);
		const now = await positions();
		assert.deepEqual(
			[...now].filter(([pid, k]) => keys.get(pid) !== k).map(([pid]) => pid),
			[mover],
			`move ${i + 1} changes one row`,
		);
		assert.equal(new Set(now.values()).size, 30, `move ${i + 1} keeps every key distinct`);
		assert.equal(step.history, 1, `move ${i + 1} writes one audit event`);
		keys = now;
	}
	const [first] = ok(await tx((t) => read.listPeople(t, ctx(), { search: "Move regression", limit: 1 }))).items;
	queries = [];
	// The stage-change action: the producer's command plus the target column's saved order, in one transaction.
	const moved = ok(
		await tx(async (t) => {
			const done = await write.changeStatus(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: first.revision,
				input: { personId: first.id, stage: "attendee", reason: "Moved back", handoffs: [] },
			});
			return done.status === "ok"
				? { status: "ok", value: { ...done.value, column: (await readColumnOrders(t, ctx(), ["attendee"]))[0] } }
				: done;
		}),
	);
	t.diagnostic(JSON.stringify({ changeStatus: queries.length }));
	assert.equal(moved.person.stage, "attendee");
	assert.ok(moved.column.personIds.includes(first.id));
	assert.equal(moved.column.personRevisions[first.id], moved.person.revision);
	assert.ok(queries.length <= 9, `stage change round trips: ${queries.length}`);
});

test("INV-reads: the person page and the status warnings use a fixed number of statements without locks", async () => {
	const p = await create("Reads person");
	ok(
		await tx((t) =>
			write.addNote(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: { personId: p.id, body: "A note with an actor" },
			}),
		),
	);
	queries = [];
	const page = ok(await tx((t) => readPersonPage(t, ctx(), { personId: p.id }, 50)));
	const pageStatements = queries.length;
	assert.equal(page.found.person.id, p.id);
	assert.deepEqual(page.link, { status: "ok", value: { status: "unlinked" } });
	assert.deepEqual(
		page.activities.value.items.map((a) => [a.kind === "activity" ? a.action : a.kind, a.actor.kind]),
		[
			["created", "current_account"],
			["note", "current_account"],
		],
	);
	queries = [];
	const warnings = ok(await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })));
	const warningStatements = queries.length;
	assert.deepEqual(warnings.warnings, ["interview_not_recorded", "commitment_not_recorded"]);
	assert.deepEqual(warnings.openDuties, []);
	// BEGIN, actor, person, activities (or warnings), COMMIT; a commitment projection may add one.
	assert.ok(pageStatements <= 6, `person page: ${pageStatements} statements`);
	assert.ok(warningStatements <= 5, `status warnings: ${warningStatements} statements`);
	assert.equal(
		queries.some((q) => /for\s+(update|share)/i.test(q)),
		false,
		"a dialog read must not lock rows",
	);
});
