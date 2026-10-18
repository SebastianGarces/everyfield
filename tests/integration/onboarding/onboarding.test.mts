import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { sql, eq, and } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const ci =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved development or disposable CI database allowed");
if (!ci) source.searchParams.set("sslmode", "verify-full");
const schema = "wp009_" + randomUUID().replaceAll("-", ""),
	role = "wp009_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 6,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db, api, mail;
let faults = false;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const denied = (r, code = "unavailable") => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	assert.deepEqual(r.error.details, {});
};
const command = (input = {}, expectedRevision = "1", requestKey = randomUUID()) => ({
	requestKey,
	expectedRevision,
	input,
});
const ctx = (a, selected = { kind: "account", id: a.id }) => ({
	session: a.session,
	selected,
	purpose: "native",
	origin: { kind: "native" },
});
const call = (name, a, q, selected) => db.transaction((tx) => api[name](tx, ctx(a, selected), q));
async function actor(kind = "planter", state = "active") {
	const a = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES(${a.user},'Synthetic',${a.user + "@example.test"},true)`,
	);
	await admin
		.insert(t.account)
		.values({ id: a.id, auth_user_id: a.user, registration_kind: kind, registration_state: state });
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	return a;
}
async function makePlant(a = undefined) {
	a ??= await actor();
	const q = command({ name: "  Harvest Point  ", locality: { city: "  Boston  " }, confirmed: true });
	const result = ok(await call("createPlant", a, q));
	return { a, q, result, p: result.plant };
}
async function counts() {
	const r = await admin.execute(
		sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM operation) operations,(SELECT count(*)::int FROM event) events,(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs`,
	);
	return r.rows[0];
}
async function resume(f) {
	return ok(await call("getResume", f.a, {}, f.p));
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
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "test@example.test",
		authorize: async () => true,
		transport: {
			send: async () => {
				throw Error("No provider calls in producer transaction");
			},
			lookup: async () => {
				throw Error("No lookup");
			},
		},
	});
	api = createOnboardingProducer({
		async enqueue(tx, input) {
			const contact = await tx.execute(sql`SELECT * FROM access_account_contact(${input.accountId})`);
			await mail.enqueue(tx, {
				owner: { kind: "account", id: input.accountId },
				purpose: input.kind === "discovery_created" ? "discovery_receipt" : "notification",
				logicalKey: `onboarding/${input.operationId}/${input.kind}/${input.relationshipId ?? ""}`,
				recipient: input.accountId,
				address: contact.rows[0].email,
				content: { subject: "Onboarding saved", text: "Your selected onboarding changes were saved." },
				operation: input.operationId,
				notice: null,
				eligibleAt: new Date().toISOString(),
			});
			if (faults) throw Error("required_intent_fault");
		},
	});
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

test("AC:TARGET-IDN-013 AC:ROLE43-003 AC:ROLE43-014 AC:DC-021 AC:DC-027 AC:DC-029 AC:DC-031 creation is atomic, ungated, leader bootstrap and replay never demote", async () => {
	const a = await actor("planter", "pending_domain");
	const q = command({ name: "  Harvest Point  ", locality: { city: "  Boston  ", country: null }, confirmed: true });
	const results = await Promise.all([call("createPlant", a, q), call("createPlant", a, q)]);
	const first = ok(results[0]),
		second = ok(results[1]);
	assert.equal(first.plant.id, second.plant.id);
	assert.deepEqual(new Set([first.status, second.status]), new Set(["created", "existing"]));
	assert.deepEqual(first.receipt, second.receipt);
	const [plant] = await admin.select().from(t.plant).where(eq(t.plant.id, first.plant.id));
	assert.equal(plant.name, "Harvest Point");
	assert.equal(plant.city, "Boston");
	assert.equal(plant.country, null);
	assert.equal(plant.state_province, null);
	assert.equal(plant.phase, 1);
	const [person] = await admin.select().from(t.person).where(eq(t.person.id, first.ownerSeat.personId));
	assert.equal(person.stage, "leader");
	assert.equal(person.adult_classification, "unknown");
	assert.equal(person.commitment_state, "unknown");
	assert.equal(person.linked_account_id, a.id);
	const history = await admin.select().from(t.people_history).where(eq(t.people_history.person_id, person.id));
	assert.equal(history[0].after_value.stage, "leader");
	const entries = await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, plant.id));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].kind, "creation");
	assert.equal(entries[0].from_phase, null);
	assert.equal(entries[0].to_phase, 1);
	const f = { a, p: first.plant };
	const r = await resume(f);
	assert.equal(r.reading.status, "incomplete");
	assert.equal(r.values, "missing");
	assert.deepEqual(r.completion, { status: "unfinished" });
	assert.deepEqual(r.lead, { answer: "pending" });
	assert.deepEqual(first.initialSharing, {
		people: false,
		meetings: false,
		tasks: false,
		ministry_teams: false,
		wiki: false,
		activity: false,
		shared_findings: false,
	});
	assert.equal((await admin.select().from(t.affiliation).where(eq(t.affiliation.plant_id, plant.id))).length, 0);
	const declaration = ok(
		await call(
			"declareJourney",
			a,
			command({ journey: { answer: "existing", phase: 4 }, launch: { answer: "skip" } }, r.revision),
			first.plant,
		),
	);
	const before = await counts();
	const replay = ok(await call("createPlant", a, q));
	assert.equal(replay.currentPhase, 4);
	assert.deepEqual(replay.creation, first.creation);
	assert.deepEqual(await counts(), before);
	denied(await call("createPlant", a, { ...q, input: { ...q.input, name: "Changed" } }), "idempotency_conflict");
	assert.equal(declaration.currentPhase, 4);
	denied(await call("createPlant", a, command(q.input, "2")), "active_seat_conflict");
});

test("AC:TARGET-IDN-013 required mail-intent failure rolls back plant, seat, Person, phase, history and receipt", async () => {
	const a = await actor("planter", "pending_domain"),
		before = await counts();
	faults = true;
	try {
		await assert.rejects(
			call("createPlant", a, command({ name: "Failure", confirmed: true })),
			/required_intent_fault/,
		);
	} finally {
		faults = false;
	}
	assert.deepEqual(await counts(), before);
	assert.equal(
		(await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0].registration_state,
		"pending_domain",
	);
	const created = ok(await call("createPlant", a, command({ name: "Retry", confirmed: true })));
	assert.equal(created.status, "created");
});

test("AC:WP009-MUL-006 AC:ADR1-006 self confirmation, exact identity, live account, no seat transfer or organization creation", async () => {
	const a = await actor(),
		other = await actor(),
		q = command({ name: "Boundary", confirmed: true });
	for (const input of [
		{ ...q.input, confirmed: false },
		{ ...q.input, phase: 4 },
		{ ...q.input, commissioning: true },
		{ ...q.input, seatTransfer: true },
	])
		denied(await call("createPlant", a, { ...q, input }), "invalid_input");
	denied(await call("createPlant", a, q, { kind: "account", id: other.id }));
	const before = await counts();
	await admin.execute(sql`UPDATE auth_user SET email_verified=false WHERE id=${a.user}`);
	denied(await call("createPlant", a, q));
	await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE id=${a.user}`);
	await admin.execute(
		sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${a.session}`,
	);
	denied(await call("createPlant", a, q));
	assert.deepEqual(await counts(), before);
	const f = await makePlant();
	await admin
		.insert(t.seat)
		.values({ account_id: other.id, plant_id: f.p.id, role: "member", accepted_at: new Date() });
	denied(await call("createPlant", other, q), "active_seat_conflict");
	denied(await call("createPlant", f.a, q, f.p));
	denied(await call("createPlant", f.a, q, { kind: "organization", id: f.p.id, organizationKind: "sending_church" }));
	denied(await call("complete", other, command({}, "1"), f.p));
});

test("AC:DC-022 explicit journey allows 0..6 once with fixed reason; launch and phase commit together", async () => {
	for (const phase of [0, 4, 6]) {
		const f = await makePlant(),
			r = await resume(f),
			q = command(
				{
					journey: { answer: "existing", phase },
					launch: { answer: "planned", date: "2026-11-10", expectedScheduleRevision: "1" },
				},
				r.revision,
			);
		const saved = ok(await call("declareJourney", f.a, q, f.p));
		assert.equal(saved.currentPhase, phase);
		assert.equal(saved.scheduledLaunchDate, "2026-11-10");
		assert.deepEqual(ok(await call("declareJourney", f.a, q, f.p)).receipt, saved.receipt);
		const entries = await admin
			.select()
			.from(t.phase_transition)
			.where(and(eq(t.phase_transition.plant_id, f.p.id), eq(t.phase_transition.kind, "initial_declaration")));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].reason, "Declared at setup — where this plant already was when it joined EveryField.");
		assert.equal(entries[0].from_phase, 1);
		assert.equal(entries[0].to_phase, phase);
		denied(await call("declareJourney", f.a, command(q.input, saved.revision), f.p), "already_declared");
		for (const input of [
			{ ...q.input, journey: { answer: "existing", phase: 7 } },
			{ ...q.input, journey: { answer: "existing", phase: 2.5 } },
			{ ...q.input, journey: { answer: "existing", phase, reason: "mine" } },
			{ ...q.input, journey: { answer: "existing", phase, kind: "initial_declaration" } },
		])
			denied(await call("declareJourney", f.a, command(input, saved.revision), f.p), "invalid_input");
	}
	const f = await makePlant(),
		q = command({
			journey: { answer: "existing", phase: 4 },
			launch: { answer: "planned", date: "2026-11-10", expectedScheduleRevision: "9" },
		});
	denied(await call("declareJourney", f.a, q, f.p), "conflict");
	assert.equal((await resume(f)).currentPhase, 1);
	assert.equal(
		(await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, f.p.id))).length,
		1,
	);
});

test("AC:TARGET-IDN-015 AC:DC-018 AC:DC-030 AC:DC-032 unsure, discerning and skip preserve phase and launch; finish preserves real gaps", async () => {
	for (const answer of ["unsure", "discerning", "skip"]) {
		const f = await makePlant();
		await admin.insert(t.launch).values({ plant_id: f.p.id, target_date: "2026-11-10", status: "scheduled" });
		const journey = ok(
			await call("declareJourney", f.a, command({ journey: { answer }, launch: { answer: "no_date" } }), f.p),
		);
		assert.equal(journey.currentPhase, 1);
		assert.equal(journey.scheduledLaunchDate, "2026-11-10");
		assert.equal(journey.journey.value.answer, answer);
		const q = command({}, journey.revision),
			done = ok(await call("complete", f.a, q, f.p));
		assert.deepEqual(ok(await call("complete", f.a, q, f.p)), done);
		const r = await resume(f);
		assert.equal(r.currentPhase, 1);
		assert.equal(r.scheduledLaunchDate, "2026-11-10");
		assert.equal(r.reading.status, "incomplete");
		assert.equal(r.values, "missing");
		assert.equal(r.peopleStep, "pending");
		assert.deepEqual(r.lead, { answer: "pending" });
		assert.equal(r.completion.completedAt, done.completion.completedAt);
		assert.equal(
			(await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, f.p.id))).length,
			1,
		);
		const again = ok(await call("complete", f.a, command({}, r.revision), f.p));
		assert.deepEqual(again.completion, done.completion);
		assert.equal(again.receipt.outcome, "noop");
	}
});

test("AC:TARGET-IDN-014 AC:ROLE43-004 AC:ROLE43-005 lead answer uses the linked Owner, ordinary role only, and occupied roles conflict", async () => {
	const f = await makePlant();
	let r = await resume(f);
	for (const answer of ["no", "skip"]) {
		const result = ok(await call("answerLead", f.a, command({ answer }, r.revision), f.p));
		r = await resume(f);
		assert.equal(result.lead.answer, answer);
		assert.equal((await admin.select().from(t.team).where(eq(t.team.plant_id, f.p.id))).length, 0);
	}
	const q = command(
		{
			answer: "yes",
			assignment: {
				kind: "minimal_role",
				roleName: "Lead planter",
				container: { kind: "minimal", name: "Plant leadership" },
			},
		},
		r.revision,
	);
	const result = ok(await call("answerLead", f.a, q, f.p));
	assert.equal(result.lead.assignment.personId, f.result.ownerSeat.personId);
	assert.deepEqual(ok(await call("answerLead", f.a, q, f.p)), result);
	const [team] = await admin.select().from(t.team).where(eq(t.team.id, result.lead.assignment.teamId));
	assert.equal(team.leader_person_id, f.result.ownerSeat.personId);
	assert.equal(team.template_version_id, null);
	const [seat] = await admin.select().from(t.seat).where(eq(t.seat.id, f.result.ownerSeat.seatId));
	assert.equal(seat.role, "owner");
	const person = randomUUID();
	await admin.insert(t.person).values({
		id: person,
		tenant_id: f.p.id,
		plant_id: f.p.id,
		display_name: "Other leader",
		source: "other",
		stage: "leader",
		adult_classification: "unknown",
		commitment_state: "unknown",
		pipeline_position: "1",
		state: "live",
		created_at: new Date(),
	});
	await admin.update(t.team).set({ leader_person_id: person, leader_source: "explicit" }).where(eq(t.team.id, team.id));
	const rr = await resume(f),
		before = await counts();
	denied(
		await call(
			"answerLead",
			f.a,
			command(
				{
					answer: "yes",
					assignment: {
						kind: "existing_role",
						teamId: team.id,
						roleId: result.lead.assignment.roleId,
						expectedTeamRevision: team.revision,
						expectedRoleRevision: "1",
					},
				},
				rr.revision,
			),
			f.p,
		),
		"conflict",
	);
	assert.deepEqual(await counts(), before);
});

async function discovery() {
	const a = await actor("discovery", "pending_domain");
	const result = ok(await call("createDiscovery", a, command()));
	return { a, result };
}
async function relationship(account, kind = "sending_church") {
	const org = randomUUID();
	await admin
		.insert(t.organization)
		.values({ id: org, kind, name: "Sending partner", timezone: "UTC", material_revision: "1" });
	const [link] = await admin
		.insert(t.affiliation)
		.values({
			account_id: account.id,
			organization_id: org,
			accepted_at: new Date(),
			share_people: false,
			share_meetings: false,
			share_tasks: false,
			share_ministry_teams: false,
			share_wiki: false,
			share_activity: false,
			shared_findings: false,
		})
		.returning();
	return {
		relationshipId: link.id,
		organization: { kind: "organization", id: org, organizationKind: kind },
		expectedRelationshipRevision: link.revision,
		expectedConsentRevision: link.consent_revision,
		choices: {
			people: false,
			meetings: false,
			tasks: false,
			ministry_teams: false,
			wiki: true,
			activity: false,
			shared_findings: false,
		},
	};
}
test("AC:TARGET-IDN-016 AC:AF-012 AC:DC-001 Discovery is explicit and seatless; conversion transfers only selected current pairs", async () => {
	const former = await actor("discovery");
	assert.deepEqual(ok(await call("getDiscoveryProfile", former, {})), { status: "unavailable" });
	const d = await discovery();
	const beforePlants = (await counts()).plants;
	const first = await relationship(d.a),
		second = await relationship(d.a, "sending_network");
	const p = ok(await call("getDiscoveryProfile", d.a, {}));
	assert.equal(p.profile.relationships.length, 2);
	assert.equal((await counts()).plants, beforePlants);
	const q = command(
		{ discoveryId: d.result.profile.discoveryId, name: "New plant", confirmed: true, relationships: [first] },
		p.profile.revision,
	);
	const converted = ok(await call("convertDiscovery", d.a, q));
	assert.equal(converted.status, "converted");
	assert.equal(converted.currentPhase, 1);
	assert.equal(converted.relationships.length, 1);
	assert.equal(converted.relationships[0].organization.id, first.organization.id);
	assert.deepEqual(converted.relationships[0].choices, first.choices);
	const ended = await admin.select().from(t.affiliation).where(eq(t.affiliation.account_id, d.a.id));
	assert.equal(ended.filter((x) => x.ended_at).length, 2);
	const chosen = await admin.select().from(t.affiliation).where(eq(t.affiliation.plant_id, converted.plant.id));
	assert.equal(chosen.length, 1);
	assert.equal(chosen[0].organization_id, first.organization.id);
	assert.notEqual(chosen[0].organization_id, second.organization.id);
	const before = await counts(),
		replay = ok(await call("convertDiscovery", d.a, q));
	assert.equal(replay.status, "existing");
	assert.deepEqual(replay.receipt, converted.receipt);
	assert.deepEqual(await counts(), before);
	const r = await resume({ a: d.a, p: converted.plant });
	assert.equal(r.reading.status, "incomplete");
	assert.equal(r.completion.status, "unfinished");
	assert.deepEqual(ok(await call("getDiscoveryProfile", d.a, {})), {
		status: "converted",
		discoveryId: d.result.profile.discoveryId,
		plant: converted.plant,
		convertedAt: converted.convertedAt,
	});
});

test("AC:TARGET-IDN-016 conversion refuses stale, foreign, ended and revoked links and rolls back selected effects", async () => {
	const d = await discovery(),
		link = await relationship(d.a),
		other = await discovery();
	const q = command({
		discoveryId: d.result.profile.discoveryId,
		name: "New plant",
		confirmed: true,
		relationships: [link],
	});
	const before = await counts();
	denied(await call("convertDiscovery", other.a, q));
	denied(await call("convertDiscovery", d.a, { ...q, requestKey: randomUUID(), expectedRevision: "99" }), "conflict");
	for (const patch of [
		{ expectedRelationshipRevision: "99" },
		{ expectedConsentRevision: "99" },
		{ organization: { ...link.organization, id: randomUUID() } },
		{ organization: { ...link.organization, organizationKind: "sending_network" } },
	])
		denied(
			await call("convertDiscovery", d.a, command({ ...q.input, relationships: [{ ...link, ...patch }] })),
			patch.expectedRelationshipRevision || patch.expectedConsentRevision ? "conflict" : "unavailable",
		);
	await admin.update(t.affiliation).set({ ended_at: new Date() }).where(eq(t.affiliation.id, link.relationshipId));
	denied(await call("convertDiscovery", d.a, q));
	await admin.update(t.affiliation).set({ ended_at: null }).where(eq(t.affiliation.id, link.relationshipId));
	faults = true;
	try {
		await assert.rejects(call("convertDiscovery", d.a, q), /required_intent_fault/);
	} finally {
		faults = false;
	}
	assert.deepEqual(await counts(), before);
	assert.equal(
		(await admin.select().from(t.discovery).where(eq(t.discovery.id, d.result.profile.discoveryId)))[0].converted_at,
		null,
	);
});

let readingSource;
async function seedArticles() {
	if (readingSource) return;
	const org = randomUUID(),
		section = foundations.articles[0].section_id;
	await admin
		.insert(t.organization)
		.values({ id: org, kind: "sending_network", name: "Published source", timezone: "UTC", material_revision: "1" });
	await admin
		.insert(t.reference_item)
		.values({ id: section, kind: "section", canonical_key: "discovery-fixture-section", tenant_id: org });
	const revisions = [];
	for (const article of foundations.articles) {
		await admin
			.insert(t.reference_item)
			.values({ id: article.id, kind: "article", canonical_key: article.slug, tenant_id: org });
		const [row] = await admin
			.insert(t.article_revision)
			.values({
				article_id: article.id,
				tenant_id: org,
				revision_number: 1,
				title: article.title,
				slug: article.slug,
				body: "Synthetic published body",
				content_type: "safe_nodes",
				position: article.sort_order,
				content_hash: "a".repeat(64),
				published_at: new Date(),
				meaningful: true,
				meaningful_sequence: "1",
				section_id: section,
			})
			.returning();
		revisions.push(row);
	}
	readingSource = { org, revisions };
}
async function reading(a, positions = [0, 1, 2, 3, 4, 5], fraction = "0.81") {
	await seedArticles();
	for (const position of positions) {
		const row = readingSource.revisions[position];
		await admin
			.insert(t.reading)
			.values({
				account_id: a.id,
				article_id: row.article_id,
				last_revision_id: row.id,
				observed_fraction: fraction,
				last_viewed_at: new Date(),
				completed_at: new Date(),
				completed_revision_id: row.id,
				completed_fraction: fraction,
				policy_version: "foundations-v1",
				last_read_meaningful_sequence: "1",
				bookmarked: false,
			})
			.onConflictDoUpdate({
				target: [t.reading.account_id, t.reading.article_id],
				set: { completed_fraction: fraction },
			});
	}
}
async function reader(f, role = "admin") {
	const a = await actor();
	await admin.insert(t.seat).values({ account_id: a.id, plant_id: f.p.id, role, accepted_at: new Date() });
	const [p] = await admin
		.insert(t.person)
		.values({
			tenant_id: f.p.id,
			plant_id: f.p.id,
			display_name: "Reader",
			source: "other",
			stage: "leader",
			adult_classification: "unknown",
			commitment_state: "unknown",
			pipeline_position: "2",
			state: "live",
			created_at: new Date(),
			linked_account_id: a.id,
		})
		.returning();
	return { ...a, person: p };
}

test("AC:DC-028 AC:DC-001 preplant reading belongs to actual account with no plant and survives creation", async () => {
	const d = await discovery(),
		before = await counts();
	await reading(d.a);
	const own = ok(await call("getDiscoveryProfile", d.a, {}));
	assert.equal(own.profile.reading.articles.length, 6);
	assert.equal(own.profile.reading.readerAccountId, d.a.id);
	assert.equal((await counts()).plants, before.plants);
	const converted = ok(
		await call(
			"convertDiscovery",
			d.a,
			command({
				discoveryId: d.result.profile.discoveryId,
				name: "Read before creation",
				confirmed: true,
				relationships: [],
			}),
		),
	);
	assert.equal(converted.currentPhase, 1);
	const r = await resume({ a: d.a, p: converted.plant });
	assert.equal(r.reading.status, "complete");
	assert.equal(r.reading.readerAccountId, d.a.id);
	assert.equal(r.values, "missing");
	assert.equal(r.completion.status, "unfinished");
	denied(await call("createDiscovery", d.a, command()), "active_seat_conflict");
});

test("INV-reading: a single current eligible reader must finish all six strictly above 80 percent", async () => {
	const f = await makePlant(),
		adminReader = await reader(f),
		member = await reader(f, "member");
	await reading(f.a, [0, 1, 2]);
	await reading(adminReader, [3, 4, 5]);
	assert.equal((await resume(f)).reading.status, "incomplete");
	await reading(f.a, [3, 4, 5], "0.80");
	assert.equal((await resume(f)).reading.status, "incomplete");
	await reading(member);
	assert.equal((await resume(f)).reading.status, "incomplete");
	await reading(adminReader);
	assert.equal((await resume(f)).reading.status, "incomplete");
	const [ministry] = await admin
		.insert(t.team)
		.values({
			plant_id: f.p.id,
			name: "Worship",
			state: "active",
			sort_order: 3,
			leader_person_id: adminReader.person.id,
			leader_source: "explicit",
		})
		.returning();
	const [ministryRole] = await admin
		.insert(t.team_role)
		.values({ plant_id: f.p.id, team_id: ministry.id, name: "Worship leader", leadership: true, sort_order: 0 })
		.returning();
	await admin
		.insert(t.team_tenure)
		.values({ plant_id: f.p.id, role_id: ministryRole.id, person_id: adminReader.person.id, started_on: "2026-10-18" });
	assert.equal((await resume(f)).reading.status, "incomplete");
	// Select the ordinary lead role, then assign its current occupant normally.
	const r = await resume(f),
		lead = ok(
			await call(
				"answerLead",
				f.a,
				command(
					{
						answer: "yes",
						assignment: {
							kind: "minimal_role",
							roleName: "Lead planter",
							container: { kind: "minimal", name: "Leadership" },
						},
					},
					r.revision,
				),
				f.p,
			),
		);
	await admin
		.update(t.team_tenure)
		.set({ person_id: adminReader.person.id })
		.where(eq(t.team_tenure.role_id, lead.lead.assignment.roleId));
	await admin
		.update(t.team)
		.set({ leader_person_id: adminReader.person.id })
		.where(eq(t.team.id, lead.lead.assignment.teamId));
	const complete = await resume(f);
	assert.equal(complete.reading.status, "complete");
	assert.equal(complete.reading.readerAccountId, adminReader.id);
	assert.deepEqual(complete.reading.eligibility, { kind: "current_admin_lead", personId: adminReader.person.id });
	const [adminSeat] = await admin.select().from(t.seat).where(eq(t.seat.account_id, adminReader.id));
	const [tenure] = await admin
		.select()
		.from(t.team_tenure)
		.where(eq(t.team_tenure.role_id, lead.lead.assignment.roleId));
	for (const [table, id, patch, restore] of [
		[t.account, adminReader.id, { registration_state: "pending_domain" }, { registration_state: "active" }],
		[t.seat, adminSeat.id, { accepted_at: new Date(Date.now() + 60000) }, { accepted_at: adminSeat.accepted_at }],
		[t.team, lead.lead.assignment.teamId, { archived_at: new Date() }, { archived_at: null }],
		[t.team_role, lead.lead.assignment.roleId, { retired_at: new Date() }, { retired_at: null }],
		[t.team_role, lead.lead.assignment.roleId, { leadership: false }, { leadership: true }],
		[t.team_tenure, tenure.id, { ended_on: "2026-10-18" }, { ended_on: null }],
	]) {
		await admin.update(table).set(patch).where(eq(table.id, id));
		assert.equal((await resume(f)).reading.status, "incomplete");
		await admin.update(table).set(restore).where(eq(table.id, id));
	}

	await admin.update(t.seat).set({ role: "member" }).where(eq(t.seat.account_id, adminReader.id));
	assert.equal((await resume(f)).reading.status, "incomplete");
	await admin.update(t.seat).set({ role: "admin" }).where(eq(t.seat.account_id, adminReader.id));
	await admin
		.update(t.team_tenure)
		.set({ person_id: member.person.id })
		.where(eq(t.team_tenure.role_id, lead.lead.assignment.roleId));
	assert.equal((await resume(f)).reading.status, "incomplete");
	await admin
		.update(t.team_tenure)
		.set({ person_id: adminReader.person.id })
		.where(eq(t.team_tenure.role_id, lead.lead.assignment.roleId));
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, adminReader.id));
	assert.equal((await resume(f)).reading.status, "incomplete");
	await reading(f.a);
	const ownerReading = (await resume(f)).reading;
	assert.equal(ownerReading.status, "complete");
	assert.equal(ownerReading.readerAccountId, f.a.id);
	assert.deepEqual(ownerReading.eligibility, { kind: "current_owner" });
	assert.equal(JSON.stringify(ownerReading).includes("Synthetic published body"), false);
});

test("INV-onboarding-authority: lifecycle, registration, current Owner and linked Person are rechecked before replay", async () => {
	const f = await makePlant(),
		r = await resume(f),
		q = command({ answer: "no" }, r.revision);
	ok(await call("answerLead", f.a, q, f.p));
	await admin.update(t.seat).set({ role: "admin" }).where(eq(t.seat.id, f.result.ownerSeat.seatId));
	denied(await call("answerLead", f.a, q, f.p));
	denied(await call("createPlant", f.a, f.q));
	await admin.update(t.seat).set({ role: "owner" }).where(eq(t.seat.id, f.result.ownerSeat.seatId));
	await admin.update(t.person).set({ linked_account_id: null }).where(eq(t.person.id, f.result.ownerSeat.personId));
	denied(await call("answerLead", f.a, q, f.p));
	await admin.update(t.person).set({ linked_account_id: f.a.id }).where(eq(t.person.id, f.result.ownerSeat.personId));
	await admin.update(t.account).set({ registration_state: "pending_domain" }).where(eq(t.account.id, f.a.id));
	denied(await call("answerLead", f.a, q, f.p));
	await admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, f.a.id));
	const other = await actor("network", "pending_domain");
	denied(await call("createPlant", other, command({ name: "Wrong type", confirmed: true })));
	const hidden = await actor(),
		requested = new Date();
	await admin.insert(t.lifecycle_witness).values({
		kind: "account",
		opaque_subject_id: hidden.id,
		account_id: hidden.id,
		state: "pending_deletion",
		requested_at: requested,
		cancel_until: new Date(requested.getTime() + 30 * 86400000),
		request_id: randomUUID(),
		request_revision: "1",
		witness_checkpoint: "1",
		cleanup_state: "not_started",
	});
	denied(await call("createPlant", hidden, command({ name: "Hidden", confirmed: true })));
});

test("INV-onboarding-review: model writes require current exact approved effects", async () => {
	const a = await actor(),
		q = command({ name: "Unreviewed", confirmed: true }),
		before = await counts();
	denied(
		await db.transaction((tx) =>
			api.createPlant(
				tx,
				{
					...ctx(a),
					purpose: "model",
					origin: {
						kind: "assistant",
						reviewId: randomUUID(),
						conversationId: randomUUID(),
						planDigest: "f".repeat(64),
					},
				},
				q,
			),
		),
	);
	assert.deepEqual(await counts(), before);
});

test("INV-onboarding-review: exact approved model intent executes and each changed review fact refuses", async () => {
	const { hash } = await import("../../../packages/domain/src/onboarding/core.ts");
	const a = await actor(),
		other = await actor(),
		q = command({ name: "Reviewed plant", confirmed: true }),
		name = "onboarding.createPlant";
	const conversation = randomUUID(),
		review = randomUUID(),
		effect = randomUUID(),
		digest = "c".repeat(64),
		manifest = hash({ name, input: q });
	await admin
		.insert(t.conversation)
		.values({ id: conversation, tenant_id: a.id, owner_id: a.id, title: "Review", state: "open" });
	await admin.insert(t.review).values({
		id: review,
		tenant_id: a.id,
		conversation_id: conversation,
		proposal_number: 1,
		digest,
		effect_manifest_hash: manifest,
		published_at: new Date(),
		approved_by_id: a.id,
		approved_at: new Date(),
		witness_hash: manifest,
	});
	await admin.insert(t.effect).values({
		id: effect,
		tenant_id: a.id,
		review_id: review,
		effect_key: "onboarding",
		kind: name,
		payload_hash: manifest,
		state: "unstarted",
		arguments: { operation: name, input: q },
	});
	const context = {
		...ctx(a),
		purpose: "model",
		origin: { kind: "assistant", reviewId: review, conversationId: conversation, planDigest: digest },
	};
	const execute = (input = q, contextOverride = context) =>
		db.transaction((tx) => api.createPlant(tx, contextOverride, input));
	const before = await counts();
	for (const [table, id, patch, restore] of [
		[t.review, review, { approved_by_id: other.id }, { approved_by_id: a.id }],
		[
			t.review,
			review,
			{ approved_at: null, approved_by_id: null, witness_hash: null },
			{ approved_at: new Date(), approved_by_id: a.id, witness_hash: manifest },
		],
		[t.review, review, { approved_at: new Date(Date.now() - 16 * 60000) }, { approved_at: new Date() }],
		[t.review, review, { approved_at: new Date(Date.now() + 60000) }, { approved_at: new Date() }],
		[t.review, review, { cancelled_at: new Date() }, { cancelled_at: null }],
		[t.review, review, { superseded_at: new Date() }, { superseded_at: null }],
		[t.review, review, { digest: "d".repeat(64) }, { digest }],
		[t.conversation, conversation, { state: "archived" }, { state: "open" }],
		[t.conversation, conversation, { owner_id: other.id }, { owner_id: a.id }],
		[t.effect, effect, { kind: "discovery.create" }, { kind: name }],
		[t.effect, effect, { state: "cancelled" }, { state: "unstarted" }],
		[t.effect, effect, { payload_hash: "e".repeat(64) }, { payload_hash: manifest }],
		[
			t.effect,
			effect,
			{ arguments: { operation: name, input: { ...q, input: { name: "Other", confirmed: true } } } },
			{ arguments: { operation: name, input: q } },
		],
	]) {
		await admin.update(table).set(patch).where(eq(table.id, id));
		denied(await execute());
		await admin.update(table).set(restore).where(eq(table.id, id));
	}
	for (const origin of [
		{ ...context.origin, reviewId: randomUUID() },
		{ ...context.origin, conversationId: randomUUID() },
	])
		denied(await execute(q, { ...context, origin }));
	denied(await execute({ ...q, input: { name: "Forged", confirmed: true } }));
	assert.deepEqual(await counts(), before);
	const created = ok(await execute());
	assert.equal(created.status, "created");
	assert.equal(created.receipt.request.origin.kind, "assistant");
	assert.equal(created.receipt.request.origin.reviewId, review);
	await admin.update(t.review).set({ cancelled_at: new Date() }).where(eq(t.review.id, review));
	const beforeReplay = await counts();
	const replay = ok(await execute());
	assert.deepEqual(replay.receipt, created.receipt);
	assert.deepEqual(await counts(), beforeReplay);
});

test("INV-discovery-race: conversion and organization ending serialize account, profile, affiliation without deadlock", async () => {
	const { createOrganizationAdapter } = await import("../../../packages/domain/src/organizations/index.ts");
	const { enqueueJob } = await import("../../../apps/web/src/server/jobs/queue.ts");
	const d = await discovery(),
		link = await relationship(d.a),
		orgActor = await actor("sending_church");
	await admin
		.insert(t.seat)
		.values({ account_id: orgActor.id, organization_id: link.organization.id, role: "owner", accepted_at: new Date() });
	const associations = createOrganizationAdapter(
		{
			async invitation() {
				throw Error("Invitation is outside this race");
			},
			async notice(tx, input) {
				await mail.enqueue(tx, {
					owner: { kind: "account", id: d.a.id },
					purpose: "discovery_receipt",
					logicalKey: "race/" + input.eventId,
					recipient: d.a.id,
					address: d.a.user + "@example.test",
					content: { subject: "Relationship ended", text: "Your relationship ended." },
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				});
			},
			async invalidate(tx, input) {
				await enqueueJob(tx, {
					tenant: input.owner.id,
					kind: "assessment",
					subject: input.sourceId,
					key: "race/" + input.sourceId,
					revision: input.revision,
					eligibleAt: new Date().toISOString(),
				});
			},
		},
		{
			async candidates() {
				return [];
			},
		},
	);
	let ready, proceed;
	const held = new Promise((resolve) => {
			ready = resolve;
		}),
		continueConversion = new Promise((resolve) => {
			proceed = resolve;
		});
	let conversionPid, endPid;
	const converting = db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
		conversionPid = (await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0].pid;
		await tx.execute(sql`SELECT * FROM invitation_identity(${d.a.session})`);
		await tx.select().from(t.discovery).where(eq(t.discovery.id, d.result.profile.discoveryId)).for("update");
		ready();
		await continueConversion;
		return api.convertDiscovery(
			tx,
			ctx(d.a),
			command({
				discoveryId: d.result.profile.discoveryId,
				name: "Race winner",
				confirmed: true,
				relationships: [link],
			}),
		);
	});
	await held;
	const ending = db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
		endPid = (await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0].pid;
		return associations["associations.end"](
			tx,
			orgActor.session,
			link.organization,
			command({
				relationshipId: link.relationshipId,
				pair: { kind: "discovery", accountId: d.a.id, organization: link.organization },
				confirmed: true,
				reason: "End relationship",
			}),
		);
	});
	const settled = Promise.allSettled([converting, ending]);
	try {
		const deadline = Date.now() + 5000;
		let blocked = false;
		while (Date.now() < deadline) {
			if (endPid) {
				const r = await admin.execute(sql`SELECT pg_blocking_pids(${endPid}) pids`);
				if (r.rows[0].pids.includes(conversionPid)) {
					blocked = true;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(blocked, true, "The ending operation must reach the held conversion lock");
	} finally {
		proceed();
	}
	const [converted, ended] = await settled;
	assert.equal(converted.status, "fulfilled", converted.status === "rejected" ? String(converted.reason) : "");
	const value = ok(converted.value);
	assert.equal(value.currentPhase, 1);
	assert.equal(ended.status, "rejected");
	assert.equal(
		ended.reason.cause?.code,
		undefined,
		"End must return a bounded refusal rather than a PostgreSQL failure",
	);
	assert.equal(ended.reason.message, "unavailable");
	assert.equal((await admin.select().from(t.seat).where(eq(t.seat.account_id, d.a.id))).length, 1);
	assert.equal((await admin.select().from(t.affiliation).where(eq(t.affiliation.plant_id, value.plant.id))).length, 1);
});

test("AC:DC-001 AC:DC-027 account drafts stay private through conversion; resume uses only actual current plant values", async () => {
	const d = await discovery();
	const [draft] = await admin
		.insert(t.document)
		.values({ tenant_id: d.a.id, kind: "native", title: "Private draft" })
		.returning();
	const [draftRevision] = await admin
		.insert(t.document_revision)
		.values({
			tenant_id: d.a.id,
			document_id: draft.id,
			version_number: 1,
			body: "Private account values",
			content_hash: "a".repeat(64),
			recorded_at: new Date(),
		})
		.returning();
	await admin.update(t.document).set({ current_revision_id: draftRevision.id }).where(eq(t.document.id, draft.id));
	const value = ok(
		await call(
			"convertDiscovery",
			d.a,
			command({ discoveryId: d.result.profile.discoveryId, name: "Values scope", confirmed: true, relationships: [] }),
		),
	);
	const f = { a: d.a, p: value.plant };
	assert.equal((await resume(f)).values, "missing");
	const original = (await admin.select().from(t.document).where(eq(t.document.id, draft.id)))[0];
	assert.equal(original.tenant_id, d.a.id);
	assert.equal(original.current_revision_id, draftRevision.id);
	const [values] = await admin
		.insert(t.document)
		.values({ tenant_id: f.p.id, kind: "core_values", title: "Plant values" })
		.returning();
	const [valuesRevision] = await admin
		.insert(t.document_revision)
		.values({
			tenant_id: f.p.id,
			document_id: values.id,
			version_number: 1,
			body: "Actual saved plant values",
			content_hash: "b".repeat(64),
			recorded_at: new Date(),
		})
		.returning();
	await admin.update(t.document).set({ current_revision_id: valuesRevision.id }).where(eq(t.document.id, values.id));
	assert.equal((await resume(f)).values, "recorded");
	await admin.update(t.document).set({ archived_at: new Date() }).where(eq(t.document.id, values.id));
	assert.equal((await resume(f)).values, "missing");
	assert.equal(JSON.stringify(await resume(f)).includes("Private account values"), false);
});

test("AC:TARGET-IDN-013 AC:TARGET-IDN-016 active seatless accounts explicitly choose later onboarding; pending choice remains bound", async () => {
	const a = await actor("network"),
		org = randomUUID();
	await admin
		.insert(t.organization)
		.values({ id: org, kind: "sending_network", name: "Former organization", timezone: "UTC", material_revision: "1" });
	await admin.insert(t.seat).values({
		account_id: a.id,
		organization_id: org,
		role: "member",
		accepted_at: new Date(Date.now() - 86400000),
		ended_at: new Date(),
	});
	const former = ok(await call("getDiscoveryProfile", a, {}));
	assert.deepEqual(former, { status: "unavailable" });
	const created = ok(await call("createPlant", a, command({ name: "Explicit later plant", confirmed: true })));
	assert.equal(created.currentPhase, 1);
	assert.equal(created.status, "created");
	denied(await call("createDiscovery", a, command({}, "2")), "active_seat_conflict");
	const later = await actor("planter");
	const profile = ok(await call("createDiscovery", later, command()));
	assert.equal(profile.status, "active");
	denied(
		await call("createPlant", later, command({ name: "Use conversion", confirmed: true }, "2")),
		"association_resolution_required",
	);
	const converted = ok(
		await call(
			"convertDiscovery",
			later,
			command({
				discoveryId: profile.profile.discoveryId,
				name: "Explicit conversion",
				confirmed: true,
				relationships: [],
			}),
		),
	);
	assert.equal(converted.status, "converted");
	assert.equal(converted.currentPhase, 1);
	const pendingPlant = await actor("planter", "pending_domain"),
		pendingDiscovery = await actor("discovery", "pending_domain");
	denied(await call("createDiscovery", pendingPlant, command()));
	denied(await call("createPlant", pendingDiscovery, command({ name: "Wrong pending choice", confirmed: true })));
});
