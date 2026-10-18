import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import {
	peopleWriter as write,
	peopleReader as read,
	organizationPeople as org,
	accountPersonProducer as accounts,
	getAccountLink,
	downloadOrganizationExport,
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
	purpose: "native",
	origin: { kind: "native" },
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
			sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM operation) operations,(SELECT count(*)::int FROM event) events`,
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
				sql`SELECT (SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM operation) operations,(SELECT count(*)::int FROM event) events`,
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
		await admin.execute(sql`SELECT actor_id,reason,diff FROM event WHERE operation_id=${sql.param(changed.receiptId)}`)
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

test("AC:TARGET-PPL-001 literal search, tag intersection, full totals and bound tie cursors", async () => {
	const a = await create("Literal %_ person"),
		b = await create("Literal %_ person 2");
	await admin.execute(
		sql`UPDATE person SET created_at='2026-10-01T12:00:00Z' WHERE id=ANY(${sql.param([a.id, b.id])})`,
	);
	const req = { search: "%_", limit: 1 };
	const page = ok(await tx((t) => read.listPeople(t, ctx(1), req)));
	assert.equal(page.total, 2);
	assert.equal(page.items.length, 1);
	assert.ok(page.next);
	const second = ok(await tx((t) => read.listPeople(t, ctx(1), { ...req, after: page.next })));
	assert.equal(second.items.length, 1);
	assert.notEqual(second.items[0].id, page.items[0].id);
	assert.equal(second.next, null);
	refused(
		await tx((t) =>
			read.listPeople(t, ctx(1), {
				search: "Literal",
				limit: 1,
				after: page.next,
			}),
		),
		"invalid_input",
	);
	refused(
		await tx((t) =>
			read.listPeople(t, ctx(2, { kind: "plant", id: plants[1] }), {
				...req,
				after: page.next,
			}),
		),
		"invalid_input",
	);
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
			sql`SELECT after_value->>'stage' AS stage FROM people_history WHERE person_id=${sql.param(replacement.personId)}`,
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
			sql`SELECT (SELECT count(*)::int FROM operation) operations,(SELECT count(*)::int FROM people_history) history,(SELECT count(*)::int FROM event) events`,
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
				sql`SELECT (SELECT count(*)::int FROM operation) operations,(SELECT count(*)::int FROM people_history) history,(SELECT count(*)::int FROM event) events`,
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
	const empty = ok(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { column: "prospect", personIds: [] },
			}),
		),
	);
	assert.equal(empty.outcome, "noop");
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
	assert.equal(
		(await admin.execute(sql`SELECT body FROM person_note WHERE id=${sql.param(added.noteId)}`)).rows[0].body,
		"",
	);
	assert.equal(
		ok(await tx((t) => read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] }))).items[0].kind,
		"note_removed",
	);
});

test("AC:ADR1-001 AC:WP011-MUL-001 AC:ADR1-005 AC:WP011-MUL-005 organization projection, safe fresh downloads and immediate removal", async () => {
	const request = {
		requestKey: randomUUID(),
		input: { displayName: "=2+3", email: "contact@example.test" },
	};
	const created = ok(await tx((t) => org.create(t, orgCtx(), request)));
	assert.equal("stage" in created.person, false);
	assert.equal("adultClassification" in created.person, false);
	const p = created.person;
	refused(await tx((t) => read.getPerson(t, ctx(), { personId: p.id })));
	const exp = { personId: p.id, format: "csv" };
	const data = ok(await tx((t) => org.export(t, orgCtx(), exp)));
	assert.equal(data.contact.displayName, "=2+3");
	assert.equal("notes" in data, false);
	const csv = ok(await tx((t) => downloadOrganizationExport(t, orgCtx(), exp)));
	assert.match(csv.bytes.toString(), /"'=2\+3"/);
	const retired = ok(
		await tx((t) =>
			org.retire(t, orgCtx(), {
				requestKey: randomUUID(),
				expectedRevision: p.revision,
				input: {
					personId: p.id,
					reviewRevision: p.revision,
					reason: "Retire",
					handoffs: [],
				},
			}),
		),
	);
	assert.equal(retired.person.lifecycle.state, "retired");
	const restored = ok(
		await tx((t) =>
			org.restore(t, orgCtx(), {
				requestKey: randomUUID(),
				expectedRevision: retired.person.revision,
				input: { personId: p.id },
			}),
		),
	);
	const removed = ok(
		await tx((t) =>
			org.remove(t, orgCtx(), {
				requestKey: randomUUID(),
				expectedRevision: restored.person.revision,
				input: { personId: p.id, reason: "Person requested removal" },
			}),
		),
	);
	assert.equal(removed.witness.personRecordId, p.id);
	assert.equal("cancelUntil" in removed, false);
	refused(await tx((t) => downloadOrganizationExport(t, orgCtx(), exp)));
	refused(await tx((t) => org.read(t, orgCtx(), { personId: p.id })));
	refused(await tx((t) => org.create(t, orgCtx(), request)));
	const row = (
		await admin.execute(sql`SELECT display_name,email,notes,linked_account_id FROM person WHERE id=${sql.param(p.id)}`)
	).rows[0];
	assert.deepEqual(row, {
		display_name: "Former participant",
		email: null,
		notes: null,
		linked_account_id: null,
	});
	const history = (
		await admin.execute(
			sql`SELECT before_value,after_value,reason FROM people_history WHERE person_id=${sql.param(p.id)}`,
		)
	).rows;
	assert.ok(history.every((h) => h.before_value === null && h.reason === null));
	assert.equal(JSON.stringify(history).includes("contact@example.test"), false);
});

test("AC:TARGET-PPL-023 distinct transition units preserve repeated historical moves and unknown denominators", async () => {
	let p = await create("Metrics");
	for (const stage of ["attendee", "prospect", "attendee"])
		p = ok(
			await tx((t) =>
				write.changeStatus(t, ctx(), {
					requestKey: randomUUID(),
					expectedRevision: p.revision,
					input: {
						personId: p.id,
						stage,
						reason: "Recorded move",
						handoffs: [],
					},
				}),
			),
		).person;
	const now = new Date().toISOString(),
		day = now.slice(0, 10);
	const metrics = ok(
		await tx((t) =>
			read.readPipelineMetrics(t, ctx(), {
				asOf: now,
				from: day,
				through: day,
			}),
		),
	);
	assert.equal(metrics.unit, "distinct_canonical_people");
	assert.equal(metrics.transitions.find((t) => t.from === "prospect").distinctPeople >= 1, true);
	assert.equal(metrics.currentStages.length, 7);
	assert.equal(metrics.transitions[0].conversion.status, "unknown");
	refused(
		await tx((t) =>
			read.readPipelineMetrics(t, { ...ctx(), purpose: "model" }, { asOf: now, from: day, through: day }),
		),
	);
	const artifact = await migrationArtifact();
	assert.ok(artifact.every((m) => /^[a-f0-9]{64}$/.test(m.sha256)));
	assert.deepEqual(await migrate(admin, schema), []);
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
				sql`SELECT count(*)::int n FROM people_history WHERE person_id=${sql.param(p.id)} AND action='people.updated'`,
			)
		).rows[0].n,
		1,
	);
});

test("INV-people: reviewed assistant writes bind the exact actor, arguments, current review and fresh revision", async () => {
	const { hash } = await import("../../../packages/domain/src/people/core.ts");
	const p = await create("Reviewed"),
		input = {
			requestKey: randomUUID(),
			expectedRevision: p.revision,
			input: { personId: p.id, patch: { displayName: "Reviewed change" } },
		},
		name = "people.updatePerson";
	const conversation = randomUUID(),
		review = randomUUID(),
		effect = randomUUID(),
		digest = "b".repeat(64);
	await admin.execute(
		sql`INSERT INTO conversation(id,tenant_id,owner_id,title,state) VALUES(${sql.param(conversation)},${sql.param(plants[0])},${sql.param(actors[0].id)},'Synthetic review','open')`,
	);
	await admin.execute(
		sql`INSERT INTO review(id,tenant_id,conversation_id,proposal_number,digest,effect_manifest_hash,published_at,approved_by_id,approved_at,witness_hash) VALUES(${sql.param(review)},${sql.param(plants[0])},${sql.param(conversation)},1,${sql.param(digest)},${sql.param(hash({ name, input }))},clock_timestamp(),${sql.param(actors[0].id)},clock_timestamp(),${sql.param(hash({ name, input }))})`,
	);
	await admin.execute(
		sql`INSERT INTO effect(id,tenant_id,review_id,effect_key,kind,payload_hash,state,arguments) VALUES(${sql.param(effect)},${sql.param(plants[0])},${sql.param(review)},'people-effect',${sql.param(name)},${sql.param(hash({ name, input }))},'unstarted',${sql.param(JSON.stringify({ operation: name, input }))})`,
	);
	const model = {
		...ctx(),
		purpose: "model",
		origin: {
			kind: "assistant",
			reviewId: review,
			conversationId: conversation,
			planDigest: digest,
		},
	};
	refused(
		await tx((t) =>
			write.updatePerson(t, model, {
				...input,
				input: { ...input.input, patch: { displayName: "Forged effects" } },
			}),
		),
	);
	const changed = ok(await tx((t) => write.updatePerson(t, model, input)));
	assert.equal(changed.person.displayName, "Reviewed change");
	await admin.execute(
		sql`UPDATE review SET approved_at=clock_timestamp()-interval '16 minutes' WHERE id=${sql.param(review)}`,
	);
	assert.deepEqual(ok(await tx((t) => write.updatePerson(t, model, input))), changed);
	refused(
		await tx((t) =>
			write.updatePerson(t, model, {
				...input,
				requestKey: randomUUID(),
				expectedRevision: changed.person.revision,
			}),
		),
	);
});

test("AC:GAP-PPL-023 reconstructs the actual historical cohort and counts each forward transition once", async () => {
	const plant = randomUUID(),
		actor = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(actor.user)},${sql.param(actor.id + "@example.test")},true,'Synthetic metrics')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(actor.id)},${sql.param(actor.user)},'active','planter')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(actor.session)},${sql.param(actor.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
	);
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(plant)},'Metrics fixture','America/New_York',7,14,1,8,1,1)`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actor.id)},${sql.param(plant)},'owner',clock_timestamp())`,
	);
	const context = {
		session: actor.session,
		selected: { kind: "plant", id: plant },
		purpose: "native",
		origin: { kind: "native" },
	};
	const people = [];
	for (const name of ["Alex", "Casey", "Jamie"])
		people.push(
			ok(
				await tx((t) =>
					write.createPerson(t, context, {
						requestKey: randomUUID(),
						input: { displayName: name },
					}),
				),
			).person,
		);
	for (const [index, moves] of [
		[0, ["attendee", "prospect", "attendee", "prospect"]],
		[1, ["attendee"]],
	]) {
		for (const stage of moves)
			people[index] = ok(
				await tx((t) =>
					write.changeStatus(t, context, {
						requestKey: randomUUID(),
						expectedRevision: people[index].revision,
						input: {
							personId: people[index].id,
							stage,
							reason: "Historical fixture",
							handoffs: [],
						},
					}),
				),
			).person;
	}
	for (const [index, p] of people.entries()) {
		await admin.execute(sql`UPDATE person SET created_at='2026-09-01T12:00:00Z' WHERE id=${sql.param(p.id)}`);
		const history = (
			await admin.execute(
				sql`SELECT id,action FROM people_history WHERE person_id=${sql.param(p.id)} ORDER BY occurred_at,id`,
			)
		).rows;
		for (const [i, event] of history.entries()) {
			const at =
				i === 0 ? "2026-09-01T12:00:00Z" : `2026-10-${String(index === 0 ? i + 1 : 6).padStart(2, "0")}T12:00:00Z`;
			await admin.execute(sql`UPDATE people_history SET occurred_at=${sql.param(at)} WHERE id=${sql.param(event.id)}`);
		}
	}
	const query = {
		asOf: "2026-10-13T16:00:00Z",
		from: "2026-10-01",
		through: "2026-10-13",
	};
	const result = ok(await tx((t) => read.readPipelineMetrics(t, context, query)));
	assert.deepEqual(
		result.currentStages.map((r) => [r.stage, r.distinctPeople]),
		[
			["prospect", 2],
			["attendee", 1],
			["following_up", 0],
			["interviewed", 0],
			["core_group", 0],
			["launch_team", 0],
			["leader", 0],
		],
	);
	assert.deepEqual(result.transitions[0], {
		from: "prospect",
		to: "attendee",
		distinctPeople: 2,
		conversion: { status: "known", cohortPeople: 3, cohortTransitionPeople: 2 },
	});
	const empty = ok(
		await tx((t) =>
			read.readPipelineMetrics(t, context, {
				...query,
				from: "2026-07-01",
				through: "2026-07-31",
			}),
		),
	);
	assert.deepEqual(empty.transitions[0].conversion, {
		status: "unknown",
		reason: "empty_cohort",
	});
	const review = ok(await tx((t) => read.getStatusWarnings(t, context, { personId: people[0].id }))).reviewRevision;
	ok(
		await tx((t) =>
			write.retirePerson(t, context, {
				requestKey: randomUUID(),
				expectedRevision: people[0].revision,
				input: {
					personId: people[0].id,
					reviewRevision: review,
					reason: "Historical retirement",
					handoffs: [],
				},
			}),
		),
	);
	await admin.execute(sql`UPDATE person SET retired_at='2026-10-07T12:00:00Z' WHERE id=${sql.param(people[0].id)}`);
	await admin.execute(
		sql`UPDATE people_history SET occurred_at='2026-10-07T12:00:00Z' WHERE person_id=${sql.param(people[0].id)} AND action='people.retired'`,
	);
	const retired = ok(await tx((t) => read.readPipelineMetrics(t, context, query)));
	assert.equal(retired.currentStages[0].distinctPeople, 1);
	assert.equal(retired.transitions[0].distinctPeople, 2);
	await admin.execute(
		sql`DELETE FROM people_history WHERE person_id=${sql.param(people[0].id)} AND action='people.created'`,
	);
	const missing = ok(await tx((t) => read.readPipelineMetrics(t, context, query)));
	assert.equal(missing.transitions[0].distinctPeople, 2);
	assert.deepEqual(missing.transitions[0].conversion, {
		status: "unknown",
		reason: "cohort_unavailable",
	});
	refused(await tx((t) => read.readPipelineMetrics(t, { ...ctx(2), selected: context.selected }, query)));
});

test("INV-organization-removal: fresh consent gates progress and removal revokes links while preserving reported independent facts", async () => {
	const created = ok(
		await tx((t) =>
			org.create(t, orgCtx(), {
				requestKey: randomUUID(),
				input: {
					displayName: "Resident fixture",
					email: "resident@example.test",
				},
			}),
		),
	).person;
	const p = created.id,
		invite = randomUUID(),
		affiliation = randomUUID(),
		link = randomUUID(),
		program = randomUUID(),
		version = randomUUID(),
		stage = randomUUID(),
		enrollment = randomUUID(),
		milestone = randomUUID(),
		completion = randomUUID(),
		feedback = randomUUID();
	const director = (
		await admin.execute(sql`SELECT id FROM seat WHERE account_id=${sql.param(actors[3].id)} AND ended_at IS NULL`)
	).rows[0].id;
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(actors[1].id)} WHERE id=${sql.param(p)}`);
	await admin.execute(
		sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,accepted_account_id,resident_person_id) VALUES(${sql.param(invite)},${sql.param(organization)},'residency_link','resident@example.test',${sql.param(randomUUID())},'accepted',clock_timestamp(),${sql.param(actors[1].id)},${sql.param(p)})`,
	);
	await admin.execute(
		sql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,invitation_id,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings) VALUES(${sql.param(affiliation)},${sql.param(actors[1].id)},${sql.param(organization)},clock_timestamp(),${sql.param(invite)},false,false,false,false,false,false,false)`,
	);
	await admin.execute(
		sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,accepted_at,consent_revision,share_foundations,share_milestones,revision) VALUES(${sql.param(link)},${sql.param(organization)},${sql.param(p)},${sql.param(actors[1].id)},${sql.param(affiliation)},${sql.param(invite)},clock_timestamp(),1,false,true,1)`,
	);
	await admin.execute(
		sql`INSERT INTO development_program(id,organization_id,kind,name,director_seat_id,revision) VALUES(${sql.param(program)},${sql.param(organization)},'residency','Synthetic program',${sql.param(director)},1)`,
	);
	await admin.execute(
		sql`INSERT INTO development_program_version(id,organization_id,program_id,version_number,rhythm,expected_months,published_at,revision) VALUES(${sql.param(version)},${sql.param(organization)},${sql.param(program)},1,'Monthly',12,clock_timestamp(),1)`,
	);
	await admin.execute(
		sql`INSERT INTO development_stage(id,organization_id,version_id,label,position,min_months,max_months,revision) VALUES(${sql.param(stage)},${sql.param(organization)},${sql.param(version)},'Training',0,2,3,1)`,
	);
	await admin.execute(
		sql`INSERT INTO development_enrollment(id,organization_id,person_id,program_id,version_id,cohort_label,started_on,expected_end_on,status,current_stage_id,meeting_timezone,revision) VALUES(${sql.param(enrollment)},${sql.param(organization)},${sql.param(p)},${sql.param(program)},${sql.param(version)},'Synthetic','2026-01-01','2026-12-31','active',${sql.param(stage)},'America/New_York',1)`,
	);
	await admin.execute(
		sql`INSERT INTO development_milestone(id,organization_id,version_id,description,stage_id,position,revision) VALUES(${sql.param(milestone)},${sql.param(organization)},${sql.param(version)},'Synthetic milestone',${sql.param(stage)},0,1)`,
	);
	await admin.execute(
		sql`INSERT INTO enrollment_plan(id,organization_id,enrollment_id,program_id,version_id,adopted_at,adopted_by,revision) VALUES(${sql.param(randomUUID())},${sql.param(organization)},${sql.param(enrollment)},${sql.param(program)},${sql.param(version)},clock_timestamp(),${sql.param(actors[3].id)},1)`,
	);
	await admin.execute(
		sql`INSERT INTO enrollment_milestone(id,organization_id,enrollment_id,version_id,milestone_id,completed_by,completed_at,completion_source,revision) VALUES(${sql.param(completion)},${sql.param(organization)},${sql.param(enrollment)},${sql.param(version)},${sql.param(milestone)},${sql.param(actors[1].id)},clock_timestamp(),'resident_self',1)`,
	);
	await admin.execute(
		sql`INSERT INTO assignment_feedback(id,organization_id,enrollment_milestone_id,author_id,recorded_at,body,revision) VALUES(${sql.param(feedback)},${sql.param(organization)},${sql.param(completion)},${sql.param(actors[3].id)},clock_timestamp(),${sql.param("PRIVATE-FEEDBACK-CANARY")},1)`,
	);
	const note = ok(
		await tx((t) =>
			write.addNote(t, orgCtx(), {
				requestKey: randomUUID(),
				expectedRevision: created.revision,
				input: { personId: p, body: "PRIVATE-STAFF-NOTE-CANARY" },
			}),
		),
	);
	const exportInput = { personId: p, format: "csv" };
	const shared = ok(await tx((t) => org.export(t, orgCtx(), exportInput)));
	assert.equal(shared.completions.length, 1);
	assert.equal(JSON.stringify(shared).includes("CANARY"), false);
	await admin.execute(
		sql`UPDATE residency_link SET share_milestones=false,consent_revision=consent_revision+1 WHERE id=${sql.param(link)}`,
	);
	const withdrawn = ok(await tx((t) => org.export(t, orgCtx(), exportInput)));
	assert.deepEqual(withdrawn.completions, []);
	assert.equal(withdrawn.consentRevision, "2");
	const current = ok(await tx((t) => org.read(t, orgCtx(), { personId: p })));
	const removed = ok(
		await tx((t) =>
			org.remove(t, orgCtx(), {
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: { personId: p, reason: "Removal requested" },
			}),
		),
	);
	assert.deepEqual(
		new Set(removed.retained.map((x) => x.category)),
		new Set(["enrollment", "program_completion", "relationship_receipt"]),
	);
	const ended = (
		await admin.execute(
			sql`SELECT ended_at,share_foundations,share_milestones FROM residency_link WHERE id=${sql.param(link)}`,
		)
	).rows[0];
	assert.ok(ended.ended_at);
	assert.equal(ended.share_milestones, false);
	assert.equal(
		(await admin.execute(sql`SELECT body FROM person_note WHERE id=${sql.param(note.noteId)}`)).rows[0].body,
		"",
	);
	assert.equal(
		(await admin.execute(sql`SELECT body FROM assignment_feedback WHERE id=${sql.param(feedback)}`)).rows[0].body,
		"",
	);
	assert.ok(
		(await admin.execute(sql`SELECT completed_at FROM enrollment_milestone WHERE id=${sql.param(completion)}`)).rows[0]
			.completed_at,
	);
	refused(await tx((t) => downloadOrganizationExport(t, orgCtx(), exportInput)));
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

test("INV-pipeline: complete native and reviewed orders persist, retry once, and invalidate stale cursors", async () => {
	await create("Order A");
	await create("Order B");
	const all = ok(await tx((t) => read.listPeople(t, ctx(), { stages: ["prospect"], limit: 100 }))).items.map(
		(p) => p.id,
	);
	const oldPage = ok(
		await tx((t) =>
			read.listPeople(t, ctx(), {
				view: "pipeline",
				stages: ["prospect"],
				limit: 1,
			}),
		),
	);
	assert.ok(oldPage.next);
	const order = {
		requestKey: randomUUID(),
		expectedRevision: "1",
		input: { column: "prospect", personIds: [...all].reverse() },
	};
	refused(await tx((t) => write.reorderPipeline(t, ctx(1), order)));
	refused(
		await tx((t) =>
			write.reorderPipeline(t, ctx(), {
				...order,
				input: { ...order.input, personIds: [...all.slice(1), randomUUID()] },
			}),
		),
		"conflict",
	);
	const saved = ok(await tx((t) => write.reorderPipeline(t, ctx(), order)));
	assert.equal(saved.outcome, "changed");
	assert.deepEqual(ok(await tx((t) => write.reorderPipeline(t, ctx(), order))), saved);
	const ordered = ok(
		await tx((t) =>
			read.listPeople(t, ctx(), {
				view: "pipeline",
				stages: ["prospect"],
				limit: 100,
			}),
		),
	);
	assert.deepEqual(
		ordered.items.map((p) => p.id),
		order.input.personIds,
	);
	refused(await tx((t) => write.reorderPipeline(t, ctx(), { ...order, requestKey: randomUUID() })), "conflict");
	refused(
		await tx((t) =>
			read.listPeople(t, ctx(), {
				view: "pipeline",
				stages: ["prospect"],
				limit: 1,
				after: oldPage.next,
			}),
		),
		"invalid_input",
	);
	const { hash } = await import("../../../packages/domain/src/people/core.ts"),
		input = {
			requestKey: randomUUID(),
			expectedRevision: "2",
			input: { column: "prospect", personIds: all },
		},
		name = "people.reorderPipeline",
		conversation = randomUUID(),
		review = randomUUID(),
		digest = "c".repeat(64);
	await admin.execute(
		sql`INSERT INTO conversation(id,tenant_id,owner_id,title,state) VALUES(${sql.param(conversation)},${sql.param(plants[0])},${sql.param(actors[0].id)},'Synthetic order','open')`,
	);
	await admin.execute(
		sql`INSERT INTO review(id,tenant_id,conversation_id,proposal_number,digest,effect_manifest_hash,published_at,approved_by_id,approved_at,witness_hash) VALUES(${sql.param(review)},${sql.param(plants[0])},${sql.param(conversation)},1,${sql.param(digest)},${sql.param(hash({ name, input }))},clock_timestamp(),${sql.param(actors[0].id)},clock_timestamp(),${sql.param(hash({ name, input }))})`,
	);
	await admin.execute(
		sql`INSERT INTO effect(tenant_id,review_id,effect_key,kind,payload_hash,state,arguments) VALUES(${sql.param(plants[0])},${sql.param(review)},'order',${sql.param(name)},${sql.param(hash({ name, input }))},'cancelled',${sql.param(JSON.stringify({ operation: name, input }))})`,
	);
	const model = {
		...ctx(),
		purpose: "model",
		origin: {
			kind: "assistant",
			reviewId: review,
			conversationId: conversation,
			planDigest: digest,
		},
	};
	refused(await tx((t) => write.reorderPipeline(t, model, input)));
	await admin.execute(sql`UPDATE effect SET state='unstarted' WHERE review_id=${sql.param(review)}`);
	const reviewed = ok(await tx((t) => write.reorderPipeline(t, model, input)));
	assert.equal(reviewed.outcome, "changed");
	assert.deepEqual(
		ok(
			await tx((t) =>
				read.listPeople(t, ctx(), {
					view: "pipeline",
					stages: ["prospect"],
					limit: 100,
				}),
			),
		).items.map((p) => p.id),
		all,
	);
});
