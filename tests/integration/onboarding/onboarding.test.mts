import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId as writeSessionId } from "../../../packages/contracts/src/common/index.ts";
import { sendOnboardingRelationships } from "../../../apps/web/src/server/jobs/notifications.ts";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { testDatabase } from "../../support/test-database.mts";
import { sql, eq, and } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as t from "../../../packages/db/src/schema/tables.ts";
import {
	createOnboardingProducer,
	readOnboardingEntry,
	withOnboardingWrite,
} from "../../../packages/domain/src/onboarding/index.ts";
import { readViewer } from "../../../packages/domain/src/access/index.ts";
import { createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { enqueueJob, enqueueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { ok } from "../../support/fixture.mts";

const database = await testDatabase({ prefix: "wp009", max: 6 });
const { admin, schema } = database;
const db = database.pools.runtime;
let api, mail;
let faults = false;
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
		sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs`,
	);
	return r.rows[0];
}
async function resume(f) {
	const value = ok(await call("getResume", f.a, {}, f.p));
	// RT-6a: the one-statement entry read gives exactly the resume of the separate reads.
	const viewer = await readViewer(db, writeSessionId.parse(f.a.session));
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active",
			accountId: f.a.id,
			sessionId: f.a.session,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		},
		viewer.authority,
		true,
	);
	assert.equal(entry.kind, "plant");
	assert.deepEqual(entry.resume, value);
	return value;
}
before(async () => {
	mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "test@example.test",
		authorize: async (_tx, mail) => new Set(mail.map((m) => m.id)),
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
		relationships: async (tx, inputs) => {
			await sendOnboardingRelationships(tx, inputs, mail);
			if (faults) throw Error("required_intent_fault");
		},
		async enqueue(tx, input, command) {
			mail.append(
				tx,
				{
					owner: { kind: "account", id: input.accountId },
					purpose: input.kind === "discovery_created" ? "discovery_receipt" : "notification",
					logicalKey: `onboarding/${input.operationId}/${input.kind}`,
					recipient: input.accountId,
					address: input.address,
					content: { subject: "Onboarding saved", text: "Your selected onboarding changes were saved." },
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
			if (faults) throw Error("required_intent_fault");
		},
	});
});
after(async () => {
	await database.close();
});

test("AC:TARGET-IDN-013 AC:ROLE43-003 AC:ROLE43-014 AC:DC-021 AC:DC-027 AC:DC-029 AC:DC-031 creation is atomic, ungated, leader bootstrap and replay never demote", async () => {
	const a = await actor("planter", "pending_domain");
	const q = command({ name: "  Harvest Point  ", locality: { city: "  Boston  ", country: null }, confirmed: true });
	const results = await Promise.all([call("createPlant", a, q), call("createPlant", a, q)]);
	const first = ok(results[0]),
		second = ok(results[1]);
	assert.equal(first.plant.id, second.plant.id);
	assert.deepEqual(new Set([first.status, second.status]), new Set(["created", "existing"]));
	assert.deepEqual(first.creation, second.creation);
	const [plant] = await admin.select().from(t.plant).where(eq(t.plant.id, first.plant.id));
	assert.equal(plant.name, "Harvest Point");
	assert.equal(plant.city, "Boston");
	assert.equal(plant.country, null);
	assert.equal(plant.state_province, null);
	assert.equal(plant.phase, 1);
	assert.equal(plant.timezone, "America/Chicago");
	assert.equal(plant.digest_weekday, 0);
	assert.equal(plant.digest_hour, 16);
	const [person] = await admin.select().from(t.person).where(eq(t.person.id, first.ownerSeat.personId));
	assert.equal(person.stage, "leader");
	assert.equal(person.adult_classification, "unknown");
	assert.equal(person.commitment_state, "unknown");
	assert.equal(person.linked_account_id, a.id);
	const history = await admin.select().from(t.audit_event).where(eq(t.audit_event.subject_id, person.id));
	assert.equal(history[0].after_value.stage, "leader");
	const entries = await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, plant.id));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].kind, "creation");
	assert.equal(entries[0].from_phase, null);
	assert.equal(entries[0].to_phase, 1);
	// RT-6a: the plant, its owner seat and its creation entry are one statement; the reply names the stored rows.
	assert.equal(first.creation.recordedAt, entries[0].recorded_at.toISOString());
	const [owner] = await admin.select().from(t.seat).where(eq(t.seat.plant_id, plant.id));
	assert.equal(first.ownerSeat.seatId, owner.id);
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
		assert.deepEqual(ok(await call("declareJourney", f.a, q, f.p)), saved);
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

test("T-130 an Owner saves a planned launch date again and again, each time sending the revision it last read", async () => {
	const f = await makePlant();
	let r = await resume(f);
	assert.equal(r.scheduleRevision, "1");
	let { revision, scheduleRevision } = r;
	for (const date of ["2027-03-07", "2027-04-11", "2027-05-16", "2027-06-20"]) {
		const saved = ok(
			await call(
				"declareJourney",
				f.a,
				command(
					{
						journey: { answer: "unsure" },
						launch: { answer: "planned", date, expectedScheduleRevision: scheduleRevision },
					},
					revision,
				),
				f.p,
			),
		);
		assert.equal(saved.scheduledLaunchDate, date);
		const [row] = await admin.select().from(t.launch).where(eq(t.launch.plant_id, f.p.id));
		assert.equal(saved.scheduleRevision, row.revision, "the reply names the launch row it wrote");
		r = await resume(f);
		assert.equal(r.scheduledLaunchDate, date);
		assert.equal(r.scheduleRevision, saved.scheduleRevision);
		({ revision, scheduleRevision } = saved);
	}
	assert.equal(scheduleRevision, "4");
	// No date keeps the schedule and still names its revision.
	const kept = ok(
		await call(
			"declareJourney",
			f.a,
			command({ journey: { answer: "unsure" }, launch: { answer: "no_date" } }, revision),
			f.p,
		),
	);
	assert.equal(kept.scheduledLaunchDate, "2027-06-20");
	assert.equal(kept.scheduleRevision, "4");
	// Another tab moved the date: the revision this screen read is stale, so the save is refused.
	await admin
		.update(t.launch)
		.set({ target_date: "2027-07-04", revision: sql`${t.launch.revision}+1` })
		.where(eq(t.launch.plant_id, f.p.id));
	const stale = command(
		{ journey: { answer: "unsure" }, launch: { answer: "planned", date: "2027-08-01", expectedScheduleRevision: "4" } },
		kept.revision,
	);
	denied(await call("declareJourney", f.a, stale, f.p), "conflict");
	r = await resume(f);
	assert.equal(r.scheduledLaunchDate, "2027-07-04");
	assert.equal(r.scheduleRevision, "5");
});

test("T-130 a lock timeout or statement timeout refuses as temporary with retry same_request and writes nothing", async () => {
	for (const [setting, code] of [
		["lock_timeout", "55P03"],
		["statement_timeout", "57014"],
	]) {
		const f = await makePlant(),
			r = await resume(f);
		const q = command(
			{
				journey: { answer: "unsure" },
				launch: { answer: "planned", date: "2027-03-07", expectedScheduleRevision: "1" },
			},
			r.revision,
		);
		const before = await counts();
		let release, held;
		const locked = new Promise((resolve) => (held = resolve));
		// A second connection holds the plant row until the save gives up waiting for it.
		const holder = admin.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM plant WHERE id=${f.p.id}::uuid FOR UPDATE`);
			held();
			await new Promise((resolve) => (release = resolve));
		});
		await locked;
		let result;
		try {
			result = await db.transaction(async (tx) => {
				await tx.execute(sql.raw(`SET LOCAL ${setting}='200ms'`));
				return api.declareJourney(tx, ctx(f.a, f.p), q);
			});
		} finally {
			release();
			await holder;
		}
		assert.equal(result.status, "refused", `${code}: ${JSON.stringify(result)}`);
		assert.equal(result.error.code, "temporary", code);
		assert.equal(result.error.retry, "same_request", code);
		assert.deepEqual(result.error.details, {});
		assert.deepEqual(await counts(), before, `${code}: nothing is written`);
		assert.equal((await admin.select().from(t.launch).where(eq(t.launch.plant_id, f.p.id))).length, 0);
		const after = await resume(f);
		assert.equal(after.revision, r.revision);
		assert.equal(after.journey.status, "pending");
		// The same request goes through once the row is free.
		assert.equal(ok(await call("declareJourney", f.a, q, f.p)).scheduledLaunchDate, "2027-03-07");
	}
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

const leadYes = (fill, roleName = "Lead planter", teamName = "Plant leadership") => ({
	answer: "yes",
	assignment: { kind: "minimal_role", roleName, container: { kind: "minimal", name: teamName } },
	...(fill === undefined ? {} : { seniorPastor: fill }),
});
/** Every ministry, role and open tenure of a plant, by name, in a stable order. */
async function ministryFacts(plantId) {
	const r = await admin.execute(sql`SELECT
		(SELECT coalesce(json_agg(json_build_array(name, template_key) ORDER BY name), '[]') FROM team WHERE plant_id=${plantId}) AS teams,
		(SELECT coalesce(json_agg(json_build_array(name, template_key) ORDER BY name), '[]') FROM team_role WHERE plant_id=${plantId}) AS roles,
		(SELECT coalesce(json_agg(json_build_array(p.display_name, r.name) ORDER BY r.name), '[]') FROM team_tenure tn
			JOIN team_role r ON r.id=tn.role_id JOIN person p ON p.id=tn.person_id
			WHERE tn.plant_id=${plantId} AND tn.ended_on IS NULL) AS held`);
	return r.rows[0];
}
async function otherPerson(plantId, name) {
	const id = randomUUID();
	await admin.insert(t.person).values({
		id,
		tenant_id: plantId,
		plant_id: plantId,
		display_name: name,
		source: "other",
		stage: "leader",
		adult_classification: "unknown",
		commitment_state: "unknown",
		pipeline_position: "1",
		state: "live",
		created_at: new Date(),
	});
	return id;
}
/** The Leadership template ministry with its two template roles, as a template import leaves it. */
async function leadership(plantId) {
	const team = randomUUID(),
		pastor = randomUUID();
	await admin.insert(t.team).values({
		id: team,
		plant_id: plantId,
		name: "Leadership",
		template_key: "leadership",
		state: "forming",
		sort_order: 1,
	});
	await admin.insert(t.team_role).values([
		{
			id: pastor,
			plant_id: plantId,
			team_id: team,
			name: "Senior pastor",
			template_key: "senior_pastor",
			leadership: true,
			sort_order: 1,
		},
		{
			plant_id: plantId,
			team_id: team,
			name: "Launch coordinator",
			template_key: "launch_coordinator",
			leadership: true,
			sort_order: 2,
		},
	]);
	return { team, pastor };
}

test("AC:TARGET-IDN-014 the Senior pastor fill is off by default and only a Yes answer can carry it", async () => {
	const f = await makePlant();
	const r = await resume(f);
	for (const answer of ["no", "skip"])
		denied(await call("answerLead", f.a, command({ answer, seniorPastor: true }, r.revision), f.p), "invalid_input");
	const result = ok(await call("answerLead", f.a, command(leadYes(undefined), r.revision), f.p));
	assert.equal("seniorPastor" in result.lead, false);
	assert.deepEqual(await ministryFacts(f.p.id), {
		teams: [["Plant leadership", null]],
		roles: [["Lead planter", null]],
		held: [["Synthetic", "Lead planter"]],
	});
});

test("AC:TARGET-IDN-014 with the fill on, the planter holds Leadership's Senior pastor role and nothing else", async () => {
	// No Leadership ministry yet: it is created with the Senior pastor role only.
	const f = await makePlant();
	const result = ok(await call("answerLead", f.a, command(leadYes(true), (await resume(f)).revision), f.p));
	assert.equal(result.lead.seniorPastor, "filled");
	assert.deepEqual(await ministryFacts(f.p.id), {
		teams: [["Leadership", "leadership"]],
		roles: [["Senior pastor", "senior_pastor"]],
		held: [["Synthetic", "Senior pastor"]],
	});
	const [team] = await admin.select().from(t.team).where(eq(t.team.id, result.lead.assignment.teamId));
	assert.equal(team.leader_person_id, f.result.ownerSeat.personId);
	assert.equal((await resume(f)).lead.seniorPastor, "filled");
	const [seat] = await admin.select().from(t.seat).where(eq(t.seat.id, f.result.ownerSeat.seatId));
	assert.equal(seat.role, "owner");

	// A Leadership ministry from the templates with the role vacant: only that role is filled.
	const g = await makePlant();
	const l = await leadership(g.p.id);
	const filled = ok(await call("answerLead", g.a, command(leadYes(true), (await resume(g)).revision), g.p));
	assert.deepEqual(filled.lead.assignment, { teamId: l.team, roleId: l.pastor, personId: g.result.ownerSeat.personId });
	assert.deepEqual(await ministryFacts(g.p.id), {
		teams: [["Leadership", "leadership"]],
		roles: [
			["Launch coordinator", "launch_coordinator"],
			["Senior pastor", "senior_pastor"],
		],
		held: [["Synthetic", "Senior pastor"]],
	});
});

test("AC:TARGET-IDN-014 a Senior pastor role someone already holds is kept, and the planter gets their own lead role", async () => {
	const f = await makePlant();
	const l = await leadership(f.p.id);
	const pastor = await otherPerson(f.p.id, "Pastor Kim");
	await admin
		.insert(t.team_tenure)
		.values({ plant_id: f.p.id, role_id: l.pastor, person_id: pastor, started_on: "2026-01-01" });
	const result = ok(await call("answerLead", f.a, command(leadYes(true), (await resume(f)).revision), f.p));
	assert.equal(result.lead.seniorPastor, "occupied");
	assert.notEqual(result.lead.assignment.teamId, l.team);
	assert.deepEqual(await ministryFacts(f.p.id), {
		teams: [
			["Leadership", "leadership"],
			["Plant leadership", null],
		],
		roles: [
			["Launch coordinator", "launch_coordinator"],
			["Lead planter", null],
			["Senior pastor", "senior_pastor"],
		],
		held: [
			["Synthetic", "Lead planter"],
			["Pastor Kim", "Senior pastor"],
		],
	});
	assert.equal((await resume(f)).lead.seniorPastor, "occupied");
	ok(await call("complete", f.a, command({}, (await resume(f)).revision), f.p));
	assert.equal((await resume(f)).completion.status, "completed");
});

async function discovery() {
	const a = await actor("discovery", "pending_domain");
	const result = ok(await call("createDiscovery", a, command()));
	return { a, result };
}
async function relationship(account, kind = "sending_church", createOwner = true) {
	const org = randomUUID();
	await admin
		.insert(t.organization)
		.values({ id: org, kind, name: "Sending partner", timezone: "UTC", material_revision: "1" });
	if (createOwner) {
		const orgOwner = await actor(kind === "sending_church" ? "sending_church" : "network");
		await admin
			.insert(t.seat)
			.values({ account_id: orgOwner.id, organization_id: org, role: "owner", accepted_at: new Date() });
	}
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
	const [unselectedOrganization] = await admin
		.select()
		.from(t.organization)
		.where(eq(t.organization.id, second.organization.id));
	assert.equal(unselectedOrganization.material_revision, "2");
	const [unselectedOwner] = await admin
		.select({ id: t.seat.account_id })
		.from(t.seat)
		.where(eq(t.seat.organization_id, second.organization.id));
	const notices = await admin
		.select()
		.from(t.mail)
		.where(and(eq(t.mail.recipient_account_id, unselectedOwner.id), eq(t.mail.purpose, "discovery_receipt")));
	assert.equal(notices.length, 1);
	assert.equal(notices[0].state, "pending");
	const invalidations = await admin
		.select()
		.from(t.job)
		.where(and(eq(t.job.kind, "assessment"), eq(t.job.subject_record_id, second.relationshipId)));
	assert.equal(invalidations.length, 1);
	assert.equal(invalidations[0].source_revision, "2");
	const before = await counts(),
		replay = ok(await call("convertDiscovery", d.a, q));
	assert.equal(replay.status, "existing");
	assert.deepEqual(replay.creation, converted.creation);
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

test("AC:TARGET-IDN-016 an unlinked Discovery may accept a seat, then conversion refuses without side effects", async () => {
	const d = await discovery(),
		sender = await makePlant();
	let proof;
	const invitations = createInvitationService({
		db,
		origin: "http://onboarding.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: () => sql`false`,
		async enqueueMail(tx, input, command) {
			const token = input.text.match(/http:\/\/onboarding\.example\.test\/invitation#proof=([^\s]+)/);
			if (token) proof = decodeURIComponent(token[1]);
			return mail.append(
				tx,
				{
					owner: input.owner,
					purpose: input.purpose,
					logicalKey: input.logicalKey,
					recipient: input.recipientAccountId,
					address: input.recipientEmail,
					content: { subject: input.subject, text: input.text },
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
	const invited = await invitations.invite(
		await verifiedWriteActor(sender.a.session),
		command(
			{ workspace: sender.p, role: "member", recipientEmail: d.a.user + "@example.test" },
			sender.result.revision,
		),
	);
	assert.equal(typeof proof, "string");
	const accepted = await invitations.accept(
		d.a.session,
		command({ invitationId: invited.invitation.invitationId, proof }),
	);
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.seat.role, "member");
	const before = await counts();
	denied(
		await call(
			"convertDiscovery",
			d.a,
			command(
				{ discoveryId: d.result.profile.discoveryId, name: "Refused second plant", confirmed: true, relationships: [] },
				d.result.profile.revision,
			),
		),
		"active_seat_conflict",
	);
	assert.deepEqual(await counts(), before);
	const [profile] = await admin.select().from(t.discovery).where(eq(t.discovery.account_id, d.a.id));
	assert.equal(profile.converted_at, null);
	const seats = await admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.account_id, d.a.id), sql`${t.seat.ended_at} IS NULL`));
	assert.equal(seats.length, 1);
	assert.equal(seats[0].plant_id, sender.p.id);
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
	await admin.insert(t.team_tenure).values({
		plant_id: f.p.id,
		role_id: ministryRole.id,
		person_id: adminReader.person.id,
		started_on: sql`(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM plant WHERE id=${f.p.id})`,
	});
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
		[t.seat, adminSeat.id, { accepted_at: sql`clock_timestamp()+interval '1 day'` }, { accepted_at: adminSeat.accepted_at }],
		[t.team, lead.lead.assignment.teamId, { archived_at: new Date() }, { archived_at: null }],
		[t.team_role, lead.lead.assignment.roleId, { retired_at: new Date() }, { retired_at: null }],
		[t.team_role, lead.lead.assignment.roleId, { leadership: false }, { leadership: true }],
		[t.team_tenure, tenure.id, { ended_on: tenure.started_on }, { ended_on: null }],
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
	assert.equal((await resume(f)).status, "available");
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

test("INV-discovery-race: a conversion and an organization ending its link serialize without deadlock", async () => {
	const { createOrganizationAdapter } = await import("../../../packages/domain/src/organizations/index.ts");
	const { queueJobs } = await import("../../../apps/web/src/server/jobs/queue.ts");
	const d = await discovery(),
		link = await relationship(d.a, "sending_church", false),
		orgActor = await actor("sending_church");
	await admin
		.insert(t.seat)
		.values({ account_id: orgActor.id, organization_id: link.organization.id, role: "owner", accepted_at: new Date() });
	const associations = createOrganizationAdapter(
		{
			async invitation() {
				throw Error("Invitation is outside this race");
			},
			notice(tx, input) {
				return queueJobs(tx, [
					{
						tenant: input.pair.organization.id,
						kind: "notification",
						subject: input.relationshipId,
						key: "race/" + input.eventId,
						revision: input.revision,
						eligibleAt: new Date().toISOString(),
					},
				]);
			},
			invalidate(tx, input) {
				return queueJobs(
					tx,
					input.owners.map((owner) => ({
						tenant: owner.id,
						kind: "assessment",
						subject: input.sourceId,
						key: "race/" + input.sourceId,
						revision: input.revision,
						eligibleAt: new Date().toISOString(),
					})),
				);
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
		// The conversion keeps every lock it took until the organization's end waits for one of them.
		const result = await api.convertDiscovery(
			tx,
			ctx(d.a),
			command({
				discoveryId: d.result.profile.discoveryId,
				name: "Race winner",
				confirmed: true,
				relationships: [link],
			}),
		);
		ready();
		await continueConversion;
		return result;
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
		// Waits on Postgres lock state, bounded by a poll count rather than a deadline.
		let blocked = false;
		for (let poll = 0; poll < 50_000 && !blocked; poll++) {
			const r = await admin.execute(sql`SELECT pg_blocking_pids(${endPid ?? 0}::int) pids`);
			blocked = r.rows[0].pids.includes(conversionPid);
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
	const { peopleWriter } = await import("../../../packages/domain/src/people/index.ts");
	const added = ok(
		await db.transaction((tx) =>
			peopleWriter.createPerson(tx, ctx(f.a, f.p), {
				requestKey: randomUUID(),
				input: { displayName: "Actual additional Person" },
			}),
		),
	);
	assert.equal(added.person.displayName, "Actual additional Person");
	assert.equal((await resume(f)).peopleStep, "saved");
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

async function verifiedWriteActor(session: string) {
	return db.transaction(async (tx) => {
		const actor = await RequestActor.resolve(tx, writeSessionId.parse(session));
		if (!(actor instanceof RequestActor)) throw Error("verified_actor_required");
		return actor;
	});
}

test("INV-reads: the onboarding entry of a plant owner is one statement with no locks (RT-6a)", async (t) => {
	const f = await makePlant();
	const viewer = await readViewer(db, writeSessionId.parse(f.a.session));
	assert.equal(viewer.authority.actor.context.role, "owner");
	const statements = [];
	let recording = false;
	const instrumented = new WeakSet();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	recording = true;
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active",
			accountId: f.a.id,
			sessionId: f.a.session,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		},
		viewer.authority,
		true,
	);
	recording = false;
	assert.equal(entry.kind, "plant");
	assert.equal(entry.plantName, "Harvest Point");
	assert.equal(entry.resume.basics, "created");
	t.diagnostic(JSON.stringify({ onboardingEntryStatements: statements.length }));
	assert.equal(statements.length, 1, `onboarding entry: ${statements.length} statements`);
	assert.equal(
		statements.some((q) => /for\s+(update|share)|pg_advisory/i.test(q)),
		false,
		"the entry read must not lock",
	);
});

test("INV-reads: a seatless account's onboarding entry reads no identity row for update and takes no lock", async (t) => {
	const a = await actor("planter", "active");
	const viewer = await readViewer(db, writeSessionId.parse(a.session));
	assert.equal(viewer.authority.actor.context.kind, "account");
	const statements = [];
	let recording = false;
	const instrumented = new WeakSet();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	recording = true;
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active",
			accountId: a.id,
			sessionId: a.session,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		},
		viewer.authority,
		true,
	);
	recording = false;
	assert.deepEqual(entry, { kind: "start", offer: "either", accountRevision: "1" });
	t.diagnostic(JSON.stringify({ seatlessEntryStatements: statements.length }));
	assert.equal(statements.length, 5, `seatless entry: ${statements.length} statements`);
	assert.equal(
		statements.some((q) => /for\s+(update|share)|pg_advisory|invitation_identity/i.test(q)),
		false,
		"the seatless entry read must not lock or read the identity row for update",
	);
	const unverified = await readOnboardingEntry(
		db,
		api,
		{
			status: "active",
			accountId: a.id,
			sessionId: a.session,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		},
		viewer.authority,
		false,
	);
	assert.deepEqual(unverified, { kind: "confirm_email" });
});

test("INV-reads: a pending account's onboarding entry reads only its account row, no identity lock", async (t) => {
	const a = await actor("discovery", "pending_domain");
	const viewer = await readViewer(db, writeSessionId.parse(a.session));
	assert.equal(viewer.registration, "pending_domain");
	assert.equal(viewer.authority, null);
	const statements = [];
	let recording = false;
	const instrumented = new WeakSet();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	const session = {
		status: "pending_domain",
		accountId: a.id,
		sessionId: a.session,
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
	};
	recording = true;
	const entry = await readOnboardingEntry(db, api, session, null, true);
	recording = false;
	assert.deepEqual(entry, { kind: "start", offer: "discovery", accountRevision: "1" });
	t.diagnostic(JSON.stringify({ pendingEntryStatements: statements.length }));
	assert.equal(statements.length, 1, `pending entry: ${statements.length} statements`);
	assert.equal(
		statements.some((q) => /for\s+(update|share)|pg_advisory|invitation_identity/i.test(q)),
		false,
		"the pending entry read must not lock or read the identity row for update",
	);
	assert.deepEqual(await readOnboardingEntry(db, api, session, null, false), { kind: "confirm_email" });
});

// Nora QA 2026-11-05 Ask C (T-65): a network Admin and a sending-church Owner who already hold an organization seat
// sign in and reach the organization outcome, never the church-plant start.
for (const [registration, kind, seatRole] of [
	["network", "sending_network", "admin"],
	["sending_church", "sending_church", "owner"],
] as const) {
	test(`T-65 an active ${registration} account with an organization ${seatRole} seat gets the organization entry`, async () => {
		const a = await actor(registration, "active"),
			org = randomUUID();
		await admin
			.insert(t.organization)
			.values({ id: org, kind, name: "Overseeing organization", timezone: "UTC", material_revision: "1" });
		await admin
			.insert(t.seat)
			.values({ account_id: a.id, organization_id: org, role: seatRole, accepted_at: sql`clock_timestamp()-interval '1 second'` });
		const viewer = await readViewer(db, writeSessionId.parse(a.session));
		const entry = await readOnboardingEntry(
			db,
			api,
			{
				status: "active",
				accountId: a.id,
				sessionId: a.session,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			},
			viewer.authority,
			true,
		);
		assert.deepEqual(entry, { kind: "elsewhere", reason: "organization" });
	});
}

test("C13 onboarding reads: a request actor whose seat or session ended reads no onboarding facts", async () => {
	const session = (a) => ({
		status: "active",
		accountId: a.id,
		sessionId: a.session,
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
	});
	const { OnboardingReadContext } = await import("../../../packages/domain/src/onboarding/core.ts");
	// A plant Owner: the entry and the resume read, with the RequestActor resolved before the seat ended.
	const f = await makePlant();
	const owner = (await readViewer(db, writeSessionId.parse(f.a.session))).authority;
	assert.equal((await readOnboardingEntry(db, api, session(f.a), owner, true)).kind, "plant");
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, f.a.id));
	assert.deepEqual(await readOnboardingEntry(db, api, session(f.a), owner, true), {
		kind: "elsewhere",
		reason: "member",
	});
	denied(await db.transaction((tx) => api.getResume(tx, new OnboardingReadContext(owner), {})));

	// A Discovery account: the profile read, with the RequestActor resolved before the session ended.
	const d = await discovery();
	const explorer = (await readViewer(db, writeSessionId.parse(d.a.session))).authority;
	assert.equal((await readOnboardingEntry(db, api, session(d.a), explorer, true)).kind, "discovery");
	await admin
		.update(t.auth_session)
		.set({ expires_at: new Date(0) })
		.where(eq(t.auth_session.id, d.a.session));
	denied(await db.transaction((tx) => api.getDiscoveryProfile(tx, new OnboardingReadContext(explorer), {})));
	assert.deepEqual(await readOnboardingEntry(db, api, session(d.a), explorer, true), {
		kind: "elsewhere",
		reason: "unavailable",
	});

	// A seatless account before creation: the precreation facts need a live session too.
	const a = await actor("planter", "active");
	const fresh = (await readViewer(db, writeSessionId.parse(a.session))).authority;
	assert.equal((await readOnboardingEntry(db, api, session(a), fresh, true)).kind, "start");
	await admin
		.update(t.auth_session)
		.set({ expires_at: new Date(0) })
		.where(eq(t.auth_session.id, a.session));
	assert.deepEqual(await readOnboardingEntry(db, api, session(a), fresh, true), {
		kind: "elsewhere",
		reason: "unavailable",
	});
});

test("RT-6 answerLead, declareJourney and complete each write the plant once, and their saved times are that write's clock", async () => {
	const f = await makePlant();
	const statements = [];
	let recording = false;
	const instrumented = new WeakSet();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return Reflect.apply(query, this, args);
		};
	});
	// The plant UPDATEs one command sends. The declaration's phase move is part of its WITH statement, not one of them.
	async function plantWrites(name, q) {
		statements.length = 0;
		recording = true;
		const value = ok(await call(name, f.a, q, f.p));
		recording = false;
		return { value, writes: statements.filter((s) => /^\s*update\s+("[^"]+"\.)?"plant"\s/i.test(s)) };
	}
	const stored = async () => {
		const [row] = await admin
			.select({ plant: t.plant, setup: t.onboarding_setup })
			.from(t.plant)
			.innerJoin(t.onboarding_setup, eq(t.onboarding_setup.plant_id, t.plant.id))
			.where(eq(t.plant.id, f.p.id));
		return row;
	};
	let r = await resume(f);

	const lead = await plantWrites("answerLead", command({ answer: "no" }, r.revision));
	assert.equal(lead.writes.length, 1, lead.writes.join("\n"));
	assert.match(lead.writes[0], /clock_timestamp\(\)/);
	let row = await stored();
	assert.equal(row.plant.lead_answer, "no");
	assert.equal(row.plant.revision, lead.value.revision);
	assert.equal(BigInt(lead.value.revision), BigInt(r.revision) + 1n);
	assert.equal(BigInt(row.plant.material_revision), BigInt(r.materialRevision) + 1n);
	assert.deepEqual(row.setup.lead, lead.value.lead);
	r = await resume(f);
	assert.deepEqual(r.lead, lead.value.lead);

	const journey = await plantWrites(
		"declareJourney",
		command(
			{
				journey: { answer: "existing", phase: 3 },
				launch: { answer: "planned", date: "2026-11-10", expectedScheduleRevision: "1" },
			},
			r.revision,
		),
	);
	assert.equal(journey.writes.length, 1, journey.writes.join("\n"));
	assert.equal(journey.value.currentPhase, 3);
	assert.equal(journey.value.journey.savedAt, journey.value.launch.savedAt);
	assert.ok(journey.value.journey.savedAt > lead.value.lead.savedAt);
	row = await stored();
	assert.equal(row.plant.journey_answer, "existing");
	assert.equal(row.plant.launch_answer, "planned");
	assert.equal(row.plant.phase, 3);
	assert.equal(row.plant.revision, journey.value.revision);
	assert.deepEqual(row.setup.journey, journey.value.journey);
	assert.deepEqual(row.setup.launch, journey.value.launch);

	const done = await plantWrites("complete", command({}, journey.value.revision));
	assert.equal(done.writes.length, 1, done.writes.join("\n"));
	row = await stored();
	assert.equal(done.value.completion.completedAt, row.plant.onboarding_completed_at.toISOString());
	assert.equal(row.plant.revision, done.value.revision);
	assert.equal(done.value.completion.materialRevision, row.plant.material_revision);
	assert.equal(row.setup.completed_material_revision, row.plant.material_revision);

	// A second completion changes no plant row and records a noop.
	const again = await plantWrites("complete", command({}, done.value.revision));
	assert.equal(again.writes.length, 0, again.writes.join("\n"));
	assert.deepEqual(again.value.completion, done.value.completion);
	assert.deepEqual(await stored(), row);
	const noops = await admin
		.select()
		.from(t.audit_event)
		.where(and(eq(t.audit_event.tenant_id, f.p.id), eq(t.audit_event.kind, "noop")));
	assert.equal(noops.length, 1);

	// A resume inside a bound write reads through the same entry statement and gives the same answer.
	const viewer = await readViewer(db, writeSessionId.parse(f.a.session));
	const inside = await withOnboardingWrite(db, viewer.authority, ctx(f.a, f.p), (tx) =>
		api.getResume(tx, ctx(f.a, f.p), {}),
	);
	assert.deepEqual(ok(inside), await resume(f));
});
