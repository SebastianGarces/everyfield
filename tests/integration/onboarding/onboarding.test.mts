import "../platform/setup.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	accountId,
	instant,
	sessionId as writeSessionId,
	tenantId,
} from "../../../packages/contracts/src/common/index.ts";
import { sendOnboardingRelationships } from "../../../packages/domain/src/jobs/notifications.ts";
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
import { seatInvitationAcceptedResult } from "../../../packages/contracts/src/identity/invitations.ts";
import { createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { sectionOperations, withSettingsWrite } from "../../../packages/domain/src/settings/index.ts";
import { teamsReader, teamsWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import operationCatalog from "../../../docs/catalog/operations.json" with { type: "json" };
import { evryActor } from "../../../packages/evry/src/index.ts";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { ok, refusedWith, waitingOnLock } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";
import type { OnboardingContext, OnboardingProducer } from "../../../packages/contracts/src/onboarding/server.ts";
import type { Tx } from "../../../packages/domain/src/onboarding/core.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const database = await testDatabase({ prefix: "wp009", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
type Api = OnboardingProducer<Tx>;
type Answer<K extends keyof Api> = Awaited<ReturnType<Api[K]>>;
type Value<K extends keyof Api> = Extract<Answer<K>, { status: "ok" }>["value"];
type Calls = { [K in keyof Api]: (tx: Tx, context: OnboardingContext, raw: unknown) => Promise<Answer<K>> };
type Selected = OnboardingContext["selected"];
type Account = Awaited<ReturnType<typeof actor>>;
const present = <T,>(value: T | null | undefined, what: string): T => {
	if (value === null || value === undefined) assert.fail("missing " + what);
	return value;
};
type Lead =
	Answer<"answerLead"> extends infer R ? (R extends { status: "ok"; value: { lead: infer L } } ? L : never) : never;
type ResumeLead = Extract<Awaited<ReturnType<typeof resume>>, { lead: unknown }>["lead"];
const yes = (lead: Lead | ResumeLead) => {
	if (lead.answer !== "yes") assert.fail(JSON.stringify(lead));
	return lead;
};
type Profile =
	Answer<"getDiscoveryProfile"> extends infer R ? (R extends { status: "ok"; value: infer V } ? V : never) : never;
const activeProfile = (value: Profile) => {
	if (value.status !== "active") assert.fail(JSON.stringify(value));
	return value.profile;
};
const statementText = (first: unknown) => {
	if (typeof first === "string") return first;
	if (first && typeof first === "object" && "text" in first && typeof first.text === "string") return first.text;
	return assert.fail("query without text");
};
let api: Calls;
let mail: ReturnType<typeof createMailService>;
let faults = false;
const denied = refusedWith({ details: {} });
const command = (input: object = {}, expectedRevision = "1", requestKey = randomUUID()) => ({
	requestKey,
	expectedRevision,
	input,
});
const ctx = (a: Account, selected: Selected = { kind: "account", id: a.id }): OnboardingContext => ({
	session: a.session,
	selected,
});
const call = <K extends keyof Api>(name: K, a: Account, q: unknown, selected?: Selected) =>
	gatedTransaction(db, (tx) => api[name](tx, ctx(a, selected), q));
type NewAccount = typeof t.account.$inferInsert;
async function actor(
	kind: NewAccount["registration_kind"] = "planter",
	state: NewAccount["registration_state"] = "active",
) {
	const a = { id: accountId.parse(randomUUID()), user: randomUUID(), session: writeSessionId.parse(randomUUID()) };
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
async function makePlant(given?: Account) {
	const a = given ?? (await actor());
	const q = command({ name: "  Harvest Point  ", locality: { city: "  Boston  " }, confirmed: true });
	const result = ok(await call("createPlant", a, q));
	return { a, q, result, p: result.plant };
}
async function counts() {
	const r = await admin.execute(
		sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM audit_event) operations,(SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs`,
	);
	return present(r.rows[0], "row");
}
type Made = Awaited<ReturnType<typeof makePlant>>;
async function resume(f: Pick<Made, "a" | "p">) {
	const value = ok(await call("getResume", f.a, {}, f.p));
	if (value.status !== "available") assert.fail(JSON.stringify(value));
	const viewer = present(await readViewer(db, f.a.session), "viewer");
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active" as const,
			accountId: f.a.id,
			sessionId: f.a.session,
			expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
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
	const plant = present((await admin.select().from(t.plant).where(eq(t.plant.id, first.plant.id)))[0], "plant");
	assert.equal(plant.name, "Harvest Point");
	assert.equal(plant.city, "Boston");
	assert.equal(plant.country, null);
	assert.equal(plant.state_province, null);
	assert.equal(plant.phase, 1);
	assert.equal(plant.timezone, "America/Chicago");
	assert.equal(plant.digest_weekday, 0);
	assert.equal(plant.digest_hour, 16);
	const person = present(
		(await admin.select().from(t.person).where(eq(t.person.id, first.ownerSeat.personId)))[0],
		"person",
	);
	assert.equal(person.stage, "leader");
	assert.equal(person.adult_classification, "unknown");
	assert.equal(person.commitment_state, "unknown");
	assert.equal(person.linked_account_id, a.id);
	const history = await admin.select().from(t.audit_event).where(eq(t.audit_event.subject_id, person.id));
	const recorded = present(history[0], "history").after_value;
	assert.ok(recorded && typeof recorded === "object" && "stage" in recorded, JSON.stringify(recorded));
	assert.equal(recorded.stage, "leader");
	const entries = await admin.select().from(t.phase_transition).where(eq(t.phase_transition.plant_id, plant.id));
	assert.equal(entries.length, 1);
	assert.equal(present(entries[0], "entries").kind, "creation");
	assert.equal(present(entries[0], "entries").from_phase, null);
	assert.equal(present(entries[0], "entries").to_phase, 1);
	assert.equal(first.creation.recordedAt, present(entries[0], "entries").recorded_at.toISOString());
	const owner = present((await admin.select().from(t.seat).where(eq(t.seat.plant_id, plant.id)))[0], "owner");
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
		present((await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0], "account").registration_state,
		"pending_domain",
	);
	const created = ok(await call("createPlant", a, command({ name: "Retry", confirmed: true })));
	assert.equal(created.status, "created");
});

test("AC:ADR1-006 self confirmation, exact identity, live account, no seat transfer or organization creation", async () => {
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
	denied(await call("complete", other, command({}, "1"), f.p));
});

test("AC:ADR1-006 a resident creates their own ordinary Phase 1 plant with one seat, and no organization role, operation or Evry tool can create or commission one", async () => {
	const organization = randomUUID();
	await admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${organization},'sending_church','Grace Austin','America/Chicago',1)`);
	const selected = {
		kind: "organization",
		id: tenantId.parse(organization),
		organizationKind: "sending_church",
	} as const;
	const resident = await actor();
	const q = command({ name: "Harvest Point", confirmed: true });
	for (const role of ["owner", "admin", "member"] as const) {
		const staff = await actor("sending_church");
		await admin
			.insert(t.seat)
			.values({ account_id: staff.id, organization_id: organization, role, accepted_at: new Date() });
		await untouched(admin, async () => {
			denied(await call("createPlant", staff, q), "active_seat_conflict");
			denied(await call("createPlant", staff, q, selected as never));
			denied(await call("createPlant", staff, q, { kind: "account", id: resident.id }));
		});
		const viewer = present(await readViewer(db, staff.session), "viewer");
		const tools = readCatalog(evryActor(viewer.authority!)!);
		const offered = [...tools.domains.flatMap((d) => d.operations), ...tools.reviewedWrites].map((o) => o.operation);
		assert.ok(offered.length > 0);
		assert.equal(
			offered.some((name) => /commission|onboarding\.|createPlant/i.test(name)),
			false,
			`${role}: ${offered.join(" ")}`,
		);
	}
	const { operations } = operationCatalog;
	assert.deepEqual(
		operations.filter((o) => o.id === "onboarding.createPlant").map((o) => o.authority.flatMap((a) => a.actors)),
		[["authenticated_own_preplant_or_discovery_account"]],
		"only the account itself creates a plant",
	);
	assert.equal(
		operations.some((o) => /commission/i.test(o.id)),
		false,
		"commissioning is deferred: no operation delivers it",
	);
	for (const extra of [
		{ organization: selected },
		{ organizationId: organization },
		{ seatId: randomUUID() },
		{ seatTransfer: true },
		{ commissioning: true },
		{ lineage: organization },
		{ geographicAttestation: true },
		{ phase: 4 },
	])
		await untouched(admin, async () =>
			denied(await call("createPlant", resident, { ...q, input: { ...q.input, ...extra } }), "invalid_input"),
		);
	const created = ok(await call("createPlant", resident, q));
	const plant = present((await admin.select().from(t.plant).where(eq(t.plant.id, created.plant.id)))[0], "plant");
	assert.equal(plant.phase, 1);
	const seats = () => admin.select().from(t.seat).where(eq(t.seat.account_id, resident.id));
	assert.deepEqual(
		(await seats()).map((s) => [s.plant_id, s.organization_id, s.role, s.ended_at]),
		[[plant.id, null, "owner", null]],
	);
	const [entry, ...more] = await admin
		.select()
		.from(t.phase_transition)
		.where(eq(t.phase_transition.plant_id, plant.id));
	assert.deepEqual(more, []);
	assert.deepEqual([entry!.kind, entry!.from_phase, entry!.to_phase], ["creation", null, 1]);
	const [event] = await admin.select().from(t.audit_event).where(eq(t.audit_event.id, entry!.operation_id));
	assert.equal(event!.actor_id, resident.id, "the creation is attributed to the resident's own account");
	await untouched(admin, async () =>
		denied(await call("createPlant", resident, command(q.input, "2")), "active_seat_conflict"),
	);
	assert.equal((await seats()).length, 1);
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
		assert.equal(
			present(entries[0], "entries").reason,
			"Declared at setup — where this plant already was when it joined EveryField.",
		);
		assert.equal(present(entries[0], "entries").from_phase, 1);
		assert.equal(present(entries[0], "entries").to_phase, phase);
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

test("AC:TARGET-IDN-015 an Owner saves a planned launch date again and again, each time sending the revision it last read", async () => {
	const f = await makePlant();
	let r = await resume(f);
	let revision: string = r.revision;
	let scheduleRevision: string = r.scheduleRevision;
	assert.equal(scheduleRevision, "1");
	for (const date of ["2027-03-07", "2027-04-11", "2027-05-16", "2027-06-20"]) {
		const saved: Value<"declareJourney"> = ok(
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
		const row = present((await admin.select().from(t.launch).where(eq(t.launch.plant_id, f.p.id)))[0], "row");
		assert.equal(saved.scheduleRevision, row.revision, "the reply names the launch row it wrote");
		r = await resume(f);
		assert.equal(r.scheduledLaunchDate, date);
		assert.equal(r.scheduleRevision, saved.scheduleRevision);
		revision = saved.revision;
		scheduleRevision = saved.scheduleRevision;
	}
	assert.equal(scheduleRevision, "4");
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

test("AC:TARGET-IDN-015 a lock timeout or statement timeout refuses as temporary with retry same_request and writes nothing", async () => {
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
		let release = () => {};
		let held = () => {};
		const locked = new Promise<void>((resolve) => (held = resolve));
		const holder = admin.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM plant WHERE id=${f.p.id}::uuid FOR UPDATE`);
			held();
			await new Promise<void>((resolve) => (release = resolve));
		});
		await locked;
		let result;
		try {
			result = await gatedTransaction(db, async (tx) => {
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
		if (r.completion.status !== "completed") assert.fail(JSON.stringify(r.completion));
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
	assert.equal(yes(result.lead).assignment.personId, f.result.ownerSeat.personId);
	assert.deepEqual(ok(await call("answerLead", f.a, q, f.p)), result);
	const team = present(
		(
			await admin
				.select()
				.from(t.team)
				.where(eq(t.team.id, yes(result.lead).assignment.teamId))
		)[0],
		"team",
	);
	assert.equal(team.leader_person_id, f.result.ownerSeat.personId);
	assert.equal(team.template_version_id, null);
	const seat = present((await admin.select().from(t.seat).where(eq(t.seat.id, f.result.ownerSeat.seatId)))[0], "seat");
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
						roleId: yes(result.lead).assignment.roleId,
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

const leadYes = (fill: boolean | undefined, roleName = "Lead planter", teamName = "Plant leadership") => ({
	answer: "yes",
	assignment: { kind: "minimal_role", roleName, container: { kind: "minimal", name: teamName } },
	...(fill === undefined ? {} : { seniorPastor: fill }),
});
async function ministryFacts(plantId: string) {
	const r = await admin.execute(sql`SELECT
		(SELECT coalesce(json_agg(json_build_array(name, template_key) ORDER BY name), '[]') FROM team WHERE plant_id=${plantId}) AS teams,
		(SELECT coalesce(json_agg(json_build_array(name, template_key) ORDER BY name), '[]') FROM team_role WHERE plant_id=${plantId}) AS roles,
		(SELECT coalesce(json_agg(json_build_array(p.display_name, r.name) ORDER BY r.name), '[]') FROM team_tenure tn
			JOIN team_role r ON r.id=tn.role_id JOIN person p ON p.id=tn.person_id
			WHERE tn.plant_id=${plantId} AND tn.ended_on IS NULL) AS held`);
	return present(r.rows[0], "row");
}
async function otherPerson(plantId: string, name: string) {
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
async function leadership(plantId: string) {
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
	const f = await makePlant();
	const result = ok(await call("answerLead", f.a, command(leadYes(true), (await resume(f)).revision), f.p));
	assert.equal(yes(result.lead).seniorPastor, "filled");
	assert.deepEqual(await ministryFacts(f.p.id), {
		teams: [["Leadership", "leadership"]],
		roles: [["Senior pastor", "senior_pastor"]],
		held: [["Synthetic", "Senior pastor"]],
	});
	const team = present(
		(
			await admin
				.select()
				.from(t.team)
				.where(eq(t.team.id, yes(result.lead).assignment.teamId))
		)[0],
		"team",
	);
	assert.equal(team.leader_person_id, f.result.ownerSeat.personId);
	assert.equal(yes((await resume(f)).lead).seniorPastor, "filled");
	const seat = present((await admin.select().from(t.seat).where(eq(t.seat.id, f.result.ownerSeat.seatId)))[0], "seat");
	assert.equal(seat.role, "owner");

	const g = await makePlant();
	const l = await leadership(g.p.id);
	const filled = ok(await call("answerLead", g.a, command(leadYes(true), (await resume(g)).revision), g.p));
	assert.deepEqual(yes(filled.lead).assignment, {
		teamId: l.team,
		roleId: l.pastor,
		personId: g.result.ownerSeat.personId,
	});
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
	assert.equal(yes(result.lead).seniorPastor, "occupied");
	assert.notEqual(yes(result.lead).assignment.teamId, l.team);
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
	assert.equal(yes((await resume(f)).lead).seniorPastor, "occupied");
	ok(await call("complete", f.a, command({}, (await resume(f)).revision), f.p));
	assert.equal((await resume(f)).completion.status, "completed");
});

async function discovery() {
	const a = await actor("discovery", "pending_domain");
	const result = ok(await call("createDiscovery", a, command()));
	return { a, result };
}
async function relationship(
	account: { id: string },
	kind: (typeof t.organization.$inferInsert)["kind"] = "sending_church",
	createOwner = true,
) {
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
	const link = present(
		(
			await admin
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
				.returning()
		)[0],
		"link",
	);
	return {
		relationshipId: link.id,
		organization: { kind: "organization" as const, id: tenantId.parse(org), organizationKind: kind },
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
	assert.equal(activeProfile(p).relationships.length, 2);
	assert.equal((await counts()).plants, beforePlants);
	const q = command(
		{ discoveryId: d.result.profile.discoveryId, name: "New plant", confirmed: true, relationships: [first] },
		activeProfile(p).revision,
	);
	const converted = ok(await call("convertDiscovery", d.a, q));
	assert.equal(converted.status, "converted");
	assert.equal(converted.currentPhase, 1);
	assert.equal(converted.relationships.length, 1);
	assert.equal(present(converted.relationships[0], "relationships").organization.id, first.organization.id);
	assert.deepEqual(present(converted.relationships[0], "relationships").choices, first.choices);
	const ended = await admin.select().from(t.affiliation).where(eq(t.affiliation.account_id, d.a.id));
	assert.equal(ended.filter((x) => x.ended_at).length, 2);
	const chosen = await admin.select().from(t.affiliation).where(eq(t.affiliation.plant_id, converted.plant.id));
	assert.equal(chosen.length, 1);
	assert.equal(present(chosen[0], "chosen").organization_id, first.organization.id);
	assert.notEqual(present(chosen[0], "chosen").organization_id, second.organization.id);
	const unselectedOrganization = present(
		(await admin.select().from(t.organization).where(eq(t.organization.id, second.organization.id)))[0],
		"unselectedOrganization",
	);
	assert.equal(unselectedOrganization.material_revision, "2");
	const unselectedOwner = present(
		(
			await admin
				.select({ id: t.seat.account_id })
				.from(t.seat)
				.where(eq(t.seat.organization_id, second.organization.id))
		)[0],
		"unselectedOwner",
	);
	const notices = await admin
		.select()
		.from(t.mail)
		.where(and(eq(t.mail.recipient_account_id, unselectedOwner.id), eq(t.mail.purpose, "discovery_receipt")));
	assert.equal(notices.length, 1);
	assert.equal(present(notices[0], "notices").state, "pending");
	assert.deepEqual(await admin.select().from(t.job).where(eq(t.job.subject_record_id, second.relationshipId)), []);
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
	let proof = "";
	const invitations = createInvitationService({
		db,
		origin: "http://onboarding.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: () => sql`false`,
		async enqueueMail(tx, input, command) {
			const token = input.text.match(/http:\/\/onboarding\.example\.test\/invitation#proof=([^\s]+)/);
			if (token?.[1]) proof = decodeURIComponent(token[1]);
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
	assert.notEqual(proof, "");
	const accepted = seatInvitationAcceptedResult.parse(
		await invitations.accept(d.a.session, command({ invitationId: invited.invitation.invitationId, proof })),
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
	const profile = present(
		(await admin.select().from(t.discovery).where(eq(t.discovery.account_id, d.a.id)))[0],
		"profile",
	);
	assert.equal(profile.converted_at, null);
	const seats = await admin
		.select()
		.from(t.seat)
		.where(and(eq(t.seat.account_id, d.a.id), sql`${t.seat.ended_at} IS NULL`));
	assert.equal(seats.length, 1);
	assert.equal(present(seats[0], "seats").plant_id, sender.p.id);
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
		present(
			(await admin.select().from(t.discovery).where(eq(t.discovery.id, d.result.profile.discoveryId)))[0],
			"discovery",
		).converted_at,
		null,
	);
});

let readingSource: { org: string; revisions: (typeof t.article_revision.$inferSelect)[] } | undefined;
async function seedArticles() {
	if (readingSource) return readingSource;
	const org = randomUUID(),
		section = present(foundations.articles[0], "articles").section_id;
	await admin
		.insert(t.organization)
		.values({ id: org, kind: "sending_network", name: "Published source", timezone: "UTC", material_revision: "1" });
	await admin
		.insert(t.reference_item)
		.values({ id: section, kind: "section", canonical_key: "discovery-fixture-section", tenant_id: org });
	const revisions: (typeof t.article_revision.$inferSelect)[] = [];
	for (const article of foundations.articles) {
		await admin
			.insert(t.reference_item)
			.values({ id: article.id, kind: "article", canonical_key: article.slug, tenant_id: org });
		const row = present(
			(
				await admin
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
						search_vector: sql`DEFAULT`,
					})
					.returning()
			)[0],
			"row",
		);
		revisions.push(row);
	}
	readingSource = { org, revisions };
	return readingSource;
}
async function reading(a: { id: string }, positions = [0, 1, 2, 3, 4, 5], fraction = "0.81") {
	const source = await seedArticles();
	for (const position of positions) {
		const row = present(source.revisions[position], "revision " + position);
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
async function reader(f: Pick<Made, "p">, role: (typeof t.seat.$inferInsert)["role"] = "admin") {
	const a = await actor();
	await admin.insert(t.seat).values({ account_id: a.id, plant_id: f.p.id, role, accepted_at: new Date() });
	const p = present(
		(
			await admin
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
				.returning()
		)[0],
		"p",
	);
	return { ...a, person: p };
}

test("AC:DC-028 AC:DC-001 preplant reading belongs to actual account with no plant and survives creation", async () => {
	const d = await discovery(),
		before = await counts();
	await reading(d.a);
	const own = ok(await call("getDiscoveryProfile", d.a, {}));
	assert.equal(activeProfile(own).reading.articles.length, 6);
	assert.equal(activeProfile(own).reading.readerAccountId, d.a.id);
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
	const ministry = present(
		(
			await admin
				.insert(t.team)
				.values({
					plant_id: f.p.id,
					name: "Worship",
					state: "active",
					sort_order: 3,
					leader_person_id: adminReader.person.id,
					leader_source: "explicit",
				})
				.returning()
		)[0],
		"ministry",
	);
	const ministryRole = present(
		(
			await admin
				.insert(t.team_role)
				.values({ plant_id: f.p.id, team_id: ministry.id, name: "Worship leader", leadership: true, sort_order: 0 })
				.returning()
		)[0],
		"ministryRole",
	);
	await admin.insert(t.team_tenure).values({
		plant_id: f.p.id,
		role_id: ministryRole.id,
		person_id: adminReader.person.id,
		started_on: sql`(SELECT (clock_timestamp() AT TIME ZONE timezone)::date FROM plant WHERE id=${f.p.id})`,
	});
	assert.equal((await resume(f)).reading.status, "incomplete");
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
		.where(eq(t.team_tenure.role_id, yes(lead.lead).assignment.roleId));
	await admin
		.update(t.team)
		.set({ leader_person_id: adminReader.person.id })
		.where(eq(t.team.id, yes(lead.lead).assignment.teamId));
	const complete = await resume(f);
	assert.equal(complete.reading.status, "complete");
	assert.equal(complete.reading.readerAccountId, adminReader.id);
	assert.deepEqual(complete.reading.eligibility, { kind: "current_admin_lead", personId: adminReader.person.id });
	const adminSeat = present(
		(await admin.select().from(t.seat).where(eq(t.seat.account_id, adminReader.id)))[0],
		"adminSeat",
	);
	const tenure = present(
		(
			await admin
				.select()
				.from(t.team_tenure)
				.where(eq(t.team_tenure.role_id, yes(lead.lead).assignment.roleId))
		)[0],
		"tenure",
	);
	const { teamId, roleId } = yes(lead.lead).assignment;
	const toggles: [() => Promise<unknown>, () => Promise<unknown>][] = [
		[
			() =>
				admin.update(t.account).set({ registration_state: "pending_domain" }).where(eq(t.account.id, adminReader.id)),
			() => admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, adminReader.id)),
		],
		[
			() =>
				admin
					.update(t.seat)
					.set({ accepted_at: sql`clock_timestamp()+interval '1 day'` })
					.where(eq(t.seat.id, adminSeat.id)),
			() => admin.update(t.seat).set({ accepted_at: adminSeat.accepted_at }).where(eq(t.seat.id, adminSeat.id)),
		],
		[
			() => admin.update(t.team).set({ archived_at: new Date() }).where(eq(t.team.id, teamId)),
			() => admin.update(t.team).set({ archived_at: null }).where(eq(t.team.id, teamId)),
		],
		[
			() => admin.update(t.team_role).set({ retired_at: new Date() }).where(eq(t.team_role.id, roleId)),
			() => admin.update(t.team_role).set({ retired_at: null }).where(eq(t.team_role.id, roleId)),
		],
		[
			() => admin.update(t.team_role).set({ leadership: false }).where(eq(t.team_role.id, roleId)),
			() => admin.update(t.team_role).set({ leadership: true }).where(eq(t.team_role.id, roleId)),
		],
		[
			() => admin.update(t.team_tenure).set({ ended_on: tenure.started_on }).where(eq(t.team_tenure.id, tenure.id)),
			() => admin.update(t.team_tenure).set({ ended_on: null }).where(eq(t.team_tenure.id, tenure.id)),
		],
	];
	for (const [patch, restore] of toggles) {
		await patch();
		assert.equal((await resume(f)).reading.status, "incomplete");
		await restore();
	}

	await admin.update(t.seat).set({ role: "member" }).where(eq(t.seat.account_id, adminReader.id));
	assert.equal((await resume(f)).reading.status, "incomplete");
	await admin.update(t.seat).set({ role: "admin" }).where(eq(t.seat.account_id, adminReader.id));
	await admin
		.update(t.team_tenure)
		.set({ person_id: member.person.id })
		.where(eq(t.team_tenure.role_id, yes(lead.lead).assignment.roleId));
	assert.equal((await resume(f)).reading.status, "incomplete");
	await admin
		.update(t.team_tenure)
		.set({ person_id: adminReader.person.id })
		.where(eq(t.team_tenure.role_id, yes(lead.lead).assignment.roleId));
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
			invalidate(_tx, input) {
				return sql`UPDATE job SET state='superseded' WHERE subject_record_id=${input.sourceId} AND kind='digest' AND state='ready'`;
			},
		},
		{
			candidates() {
				return sql`SELECT NULL::uuid WHERE false`;
			},
		},
	);
	let ready = () => {};
	let proceed = () => {};
	const held = new Promise<void>((resolve) => {
			ready = resolve;
		}),
		continueConversion = new Promise<void>((resolve) => {
			proceed = resolve;
		});
	let conversionPid: number | undefined;
	const endPid: (number | undefined)[] = [];
	const converting = gatedTransaction(db, async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
		conversionPid = Number(present((await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0], "row").pid);
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
	const ending = gatedTransaction(db, async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
		endPid.push(Number(present((await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0], "row").pid));
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
		assert.equal(
			await waitingOnLock(admin, { pids: endPid, blockedBy: conversionPid }),
			true,
			"The ending operation must reach the held conversion lock",
		);
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
	const draft = present(
		(
			await admin.insert(t.document).values({ tenant_id: d.a.id, kind: "native", title: "Private draft" }).returning()
		)[0],
		"draft",
	);
	const draftRevision = present(
		(
			await admin
				.insert(t.document_revision)
				.values({
					tenant_id: d.a.id,
					document_id: draft.id,
					version_number: 1,
					body: "Private account values",
					content_hash: "a".repeat(64),
					recorded_at: new Date(),
				})
				.returning()
		)[0],
		"draftRevision",
	);
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
	const original = present((await admin.select().from(t.document).where(eq(t.document.id, draft.id)))[0], "original");
	assert.equal(original.tenant_id, d.a.id);
	assert.equal(original.current_revision_id, draftRevision.id);
	const values = present(
		(
			await admin
				.insert(t.document)
				.values({ tenant_id: f.p.id, kind: "core_values", title: "Plant values" })
				.returning()
		)[0],
		"values",
	);
	const valuesRevision = present(
		(
			await admin
				.insert(t.document_revision)
				.values({
					tenant_id: f.p.id,
					document_id: values.id,
					version_number: 1,
					body: "Actual saved plant values",
					content_hash: "b".repeat(64),
					recorded_at: new Date(),
				})
				.returning()
		)[0],
		"valuesRevision",
	);
	await admin.update(t.document).set({ current_revision_id: valuesRevision.id }).where(eq(t.document.id, values.id));
	assert.equal((await resume(f)).values, "recorded");
	const { peopleWriter } = await import("../../../packages/domain/src/people/index.ts");
	const added = ok(
		await gatedTransaction(db, (tx) =>
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
	return gatedTransaction(db, async (tx) => {
		const actor = await RequestActor.resolve(tx, writeSessionId.parse(session));
		if (!(actor instanceof RequestActor)) throw Error("verified_actor_required");
		return actor;
	});
}

test("INV-reads: the onboarding entry of a plant owner is one statement with no locks", async (t) => {
	const f = await makePlant();
	const viewer = present(await readViewer(db, writeSessionId.parse(f.a.session)), "viewer");
	const seat = present(viewer.authority, "authority").actor.context;
	if (seat.kind !== "seat") assert.fail(JSON.stringify(seat));
	assert.equal(seat.role, "owner");
	const statements: string[] = [];
	let recording = false;
	const instrumented = new WeakSet<object>();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args: unknown[]) {
			if (recording) statements.push(statementText(args[0]));
			return Reflect.apply(query, this, args);
		};
	});
	recording = true;
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active" as const,
			accountId: f.a.id,
			sessionId: f.a.session,
			expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
		},
		viewer.authority,
		true,
	);
	recording = false;
	assert.equal(entry.kind, "plant");
	assert.equal(entry.plantName, "Harvest Point");
	assert.partialDeepStrictEqual(entry.resume, { basics: "created" });
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
	const viewer = present(await readViewer(db, writeSessionId.parse(a.session)), "viewer");
	assert.equal(present(viewer.authority, "authority").actor.context.kind, "account");
	const statements: string[] = [];
	let recording = false;
	const instrumented = new WeakSet<object>();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args: unknown[]) {
			if (recording) statements.push(statementText(args[0]));
			return Reflect.apply(query, this, args);
		};
	});
	recording = true;
	const entry = await readOnboardingEntry(
		db,
		api,
		{
			status: "active" as const,
			accountId: a.id,
			sessionId: a.session,
			expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
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
			status: "active" as const,
			accountId: a.id,
			sessionId: a.session,
			expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
		},
		viewer.authority,
		false,
	);
	assert.deepEqual(unverified, { kind: "confirm_email" });
});

test("INV-reads: a pending account's onboarding entry reads only its account row, no identity lock", async (t) => {
	const a = await actor("discovery", "pending_domain");
	const viewer = present(await readViewer(db, writeSessionId.parse(a.session)), "viewer");
	assert.equal(viewer.registration, "pending_domain");
	assert.equal(viewer.authority, null);
	const statements: string[] = [];
	let recording = false;
	const instrumented = new WeakSet<object>();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args: unknown[]) {
			if (recording) statements.push(statementText(args[0]));
			return Reflect.apply(query, this, args);
		};
	});
	const session = {
		status: "pending_domain" as const,
		accountId: a.id,
		sessionId: a.session,
		expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
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

for (const [registration, kind, seatRole] of [
	["network", "sending_network", "admin"],
	["sending_church", "sending_church", "owner"],
] as const) {
	test(`INV-onboarding-entry: an active ${registration} account with an organization ${seatRole} seat gets the organization entry`, async () => {
		const a = await actor(registration, "active"),
			org = randomUUID();
		await admin
			.insert(t.organization)
			.values({ id: org, kind, name: "Overseeing organization", timezone: "UTC", material_revision: "1" });
		await admin.insert(t.seat).values({
			account_id: a.id,
			organization_id: org,
			role: seatRole,
			accepted_at: sql`clock_timestamp()-interval '1 second'`,
		});
		const viewer = present(await readViewer(db, writeSessionId.parse(a.session)), "viewer");
		const entry = await readOnboardingEntry(
			db,
			api,
			{
				status: "active" as const,
				accountId: a.id,
				sessionId: a.session,
				expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
			},
			viewer.authority,
			true,
		);
		assert.deepEqual(entry, { kind: "elsewhere", reason: "organization" });
	});
}

test("AC:TARGET-IDN-029 onboarding reads: a request actor whose seat or session ended reads no onboarding facts", async () => {
	const session = (a: Account) => ({
		status: "active" as const,
		accountId: a.id,
		sessionId: a.session,
		expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
	});
	const { OnboardingReadContext } = await import("../../../packages/domain/src/onboarding/core.ts");
	const f = await makePlant();
	const owner = present(
		present(await readViewer(db, writeSessionId.parse(f.a.session)), "viewer").authority,
		"authority",
	);
	assert.equal((await readOnboardingEntry(db, api, session(f.a), owner, true)).kind, "plant");
	await admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.account_id, f.a.id));
	assert.deepEqual(await readOnboardingEntry(db, api, session(f.a), owner, true), {
		kind: "elsewhere",
		reason: "member",
	});
	denied(await gatedTransaction(db, (tx) => api.getResume(tx, new OnboardingReadContext(owner), {})));

	const d = await discovery();
	const explorer = present(
		present(await readViewer(db, writeSessionId.parse(d.a.session)), "viewer").authority,
		"authority",
	);
	assert.equal((await readOnboardingEntry(db, api, session(d.a), explorer, true)).kind, "discovery");
	await admin
		.update(t.auth_session)
		.set({ expires_at: new Date(0) })
		.where(eq(t.auth_session.id, d.a.session));
	denied(await gatedTransaction(db, (tx) => api.getDiscoveryProfile(tx, new OnboardingReadContext(explorer), {})));
	assert.deepEqual(await readOnboardingEntry(db, api, session(d.a), explorer, true), {
		kind: "elsewhere",
		reason: "unavailable",
	});

	const a = await actor("planter", "active");
	const fresh = present(
		present(await readViewer(db, writeSessionId.parse(a.session)), "viewer").authority,
		"authority",
	);
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

test("INV-write-clock: answerLead, declareJourney and complete each write the plant once, and their saved times are that write's clock", async () => {
	const f = await makePlant();
	const statements: string[] = [];
	let recording = false;
	const instrumented = new WeakSet<object>();
	db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args: unknown[]) {
			if (recording) statements.push(statementText(args[0]));
			return Reflect.apply(query, this, args);
		};
	});
	async function plantWrites<V>(run: () => Promise<{ status: "ok"; value: V } | { status: "refused" }>) {
		statements.length = 0;
		recording = true;
		const value = ok(await run());
		recording = false;
		return { value, writes: statements.filter((s) => /^\s*update\s+("[^"]+"\.)?"plant"\s/i.test(s)) };
	}
	const stored = async () => {
		const row = present(
			(
				await admin
					.select({ plant: t.plant, setup: t.onboarding_setup })
					.from(t.plant)
					.innerJoin(t.onboarding_setup, eq(t.onboarding_setup.plant_id, t.plant.id))
					.where(eq(t.plant.id, f.p.id))
			)[0],
			"row",
		);
		return row;
	};
	let r = await resume(f);

	const lead = await plantWrites(() => call("answerLead", f.a, command({ answer: "no" }, r.revision), f.p));
	assert.equal(lead.writes.length, 1, lead.writes.join("\n"));
	assert.match(present(lead.writes[0], "plant write"), /clock_timestamp\(\)/);
	let row = await stored();
	assert.equal(row.plant.lead_answer, "no");
	assert.equal(row.plant.revision, lead.value.revision);
	assert.equal(BigInt(lead.value.revision), BigInt(r.revision) + 1n);
	assert.equal(BigInt(row.plant.material_revision), BigInt(r.materialRevision) + 1n);
	assert.deepEqual(row.setup.lead, lead.value.lead);
	r = await resume(f);
	assert.deepEqual(r.lead, lead.value.lead);

	const journey = await plantWrites(() =>
		call(
			"declareJourney",
			f.a,
			command(
				{
					journey: { answer: "existing", phase: 3 },
					launch: { answer: "planned", date: "2026-11-10", expectedScheduleRevision: "1" },
				},
				r.revision,
			),
			f.p,
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

	const done = await plantWrites(() => call("complete", f.a, command({}, journey.value.revision), f.p));
	assert.equal(done.writes.length, 1, done.writes.join("\n"));
	row = await stored();
	assert.equal(
		done.value.completion.completedAt,
		present(row.plant.onboarding_completed_at, "completed at").toISOString(),
	);
	assert.equal(row.plant.revision, done.value.revision);
	assert.equal(done.value.completion.materialRevision, row.plant.material_revision);
	assert.equal(row.setup.completed_material_revision, row.plant.material_revision);

	const again = await plantWrites(() => call("complete", f.a, command({}, done.value.revision), f.p));
	assert.equal(again.writes.length, 0, again.writes.join("\n"));
	assert.deepEqual(again.value.completion, done.value.completion);
	assert.deepEqual(await stored(), row);
	const noops = await admin
		.select()
		.from(t.audit_event)
		.where(and(eq(t.audit_event.tenant_id, f.p.id), eq(t.audit_event.kind, "noop")));
	assert.equal(noops.length, 1);

	const viewer = present(await readViewer(db, writeSessionId.parse(f.a.session)), "viewer");
	const inside = await withOnboardingWrite(db, present(viewer.authority, "authority"), ctx(f.a, f.p), (tx) =>
		api.getResume(tx, ctx(f.a, f.p), {}),
	);
	assert.deepEqual(ok(inside), await resume(f));
});

const leadOf = (plantId: string) =>
	admin.execute<{
		n: number;
	}>(sql`SELECT ((SELECT count(*) FROM team_tenure WHERE plant_id=${plantId} AND ended_on IS NULL)
		+(SELECT count(*) FROM team WHERE plant_id=${plantId} AND leader_person_id IS NOT NULL))::int AS n`);
const seatsOf = async (plantId: string) =>
	(
		await admin.execute(
			sql`SELECT account_id,role,revision::text FROM seat WHERE plant_id=${plantId} AND ended_at IS NULL ORDER BY account_id`,
		)
	).rows;

test("AC:ROLE43-003 AC:ROLE43-014 the Owner is linked to one person and one seat however often creation or the link is asked, and no reading or lead title gates it", async () => {
	const reader = await actor();
	await reading(reader);
	const a = await actor("planter", "pending_domain");
	const q = command({ name: "Harvest Point", confirmed: true });
	const made = (await Promise.all([call("createPlant", a, q), call("createPlant", a, q)])).map((r) => ok(r));
	const [first] = made;
	assert.ok(first);
	assert.deepEqual(made.map((m) => m.status).sort(), ["created", "existing"]);
	const p = first.plant;
	const held = async () => ({
		people: (
			await admin.execute(
				sql`SELECT id,linked_account_id FROM person WHERE plant_id=${p.id} AND state='live' AND linked_account_id=${a.id}`,
			)
		).rows,
		persons: await admin.$count(t.person, eq(t.person.plant_id, p.id)),
		seats: await seatsOf(p.id),
		transitions: await admin.$count(
			t.phase_transition,
			and(eq(t.phase_transition.plant_id, p.id), eq(t.phase_transition.kind, "creation")),
		),
		leads: (await leadOf(p.id)).rows[0]!.n,
	});
	const start = await held();
	assert.deepEqual(start, {
		people: [{ id: first.ownerSeat.personId, linked_account_id: a.id }],
		persons: 1,
		seats: [{ account_id: a.id, role: "owner", revision: "1" }],
		transitions: 1,
		leads: 0,
	});
	assert.equal(await admin.$count(t.reading, eq(t.reading.account_id, a.id)), 0);
	const r = await resume({ a, p });
	assert.deepEqual([r.currentPhase, r.reading, r.lead], [1, { status: "incomplete" }, { answer: "pending" }]);

	const input = { accountId: a.id, owner: p, selection: { kind: "resolve" as const } };
	await assert.rejects(
		gatedTransaction(db, (tx) =>
			accountPersonProducer.ensureAccountPerson(tx, { ...input, selection: { kind: "first", displayName: "Alex" } }),
		),
		/Failed query/,
	);
	const before = await counts();
	for (let n = 0; n < 2; n++) {
		const linked = await Promise.all(
			[0, 1].map(() => gatedTransaction(db, (tx) => accountPersonProducer.ensureAccountPerson(tx, input))),
		);
		for (const l of linked) {
			const value = ok(l);
			assert.equal(value.status, "linked");
			assert.equal("personId" in value && value.personId, first.ownerSeat.personId);
		}
	}
	assert.deepEqual(await held(), start);
	assert.deepEqual(await counts(), before, "linking again records nothing");

	ok(
		await call(
			"declareJourney",
			a,
			command({ journey: { answer: "existing", phase: 4 }, launch: { answer: "skip" } }, r.revision),
			p,
		),
	);
	const later = await counts();
	const replay = ok(await call("createPlant", a, q));
	assert.deepEqual([replay.plant, replay.ownerSeat, replay.creation], [p, first.ownerSeat, first.creation]);
	assert.equal(replay.currentPhase, 4);
	assert.deepEqual(await counts(), later);
	assert.deepEqual(await held(), start);
});

test("AC:ROLE43-004 a yes to the lead question adds or reuses the one shown ordinary role, imports no template, leaves an occupied Senior pastor and changes no account authority", async () => {
	for (const container of ["absent", "present"] as const) {
		const f = await makePlant();
		const l = await leadership(f.p.id);
		const pastor = await otherPerson(f.p.id, "Pastor Kim");
		await admin
			.insert(t.team_tenure)
			.values({ plant_id: f.p.id, role_id: l.pastor, person_id: pastor, started_on: "2026-01-01" });
		const [team, role] = [randomUUID(), randomUUID()];
		if (container === "present") {
			await admin
				.insert(t.team)
				.values({ id: team, plant_id: f.p.id, name: "Plant leadership", state: "active", sort_order: 5 });
			await admin.insert(t.team_role).values({
				id: role,
				plant_id: f.p.id,
				team_id: team,
				name: "Lead planter",
				leadership: true,
				sort_order: 1,
			});
		}
		const seats = await seatsOf(f.p.id);
		const other = await reader(f);
		await admin.delete(t.seat).where(eq(t.seat.account_id, other.id));
		denied(await call("answerLead", other, command(leadYes(true), (await resume(f)).revision), f.p));
		const q = command(
			container === "absent"
				? leadYes(true)
				: {
						answer: "yes",
						assignment: {
							kind: "existing_role",
							teamId: team,
							roleId: role,
							expectedTeamRevision: "1",
							expectedRoleRevision: "1",
						},
					},
			(await resume(f)).revision,
		);
		const { value, added } = await recorded(admin, () => call("answerLead", f.a, q, f.p));
		const result = ok(value);
		assert.deepEqual(added, { audits: ["attestation.recorded", "roles.changed"], jobs: [], notices: 0, mail: 0 });
		const { assignment, seniorPastor } = yes(result.lead);
		assert.equal(assignment.personId, f.result.ownerSeat.personId);
		assert.equal(seniorPastor, container === "absent" ? "occupied" : undefined);
		if (container === "present") assert.deepEqual([assignment.teamId, assignment.roleId], [team, role]);
		const facts = {
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
		};
		assert.deepEqual(await ministryFacts(f.p.id), facts, container);
		const assignments = await admin.execute(
			sql`SELECT role_id FROM team_tenure WHERE plant_id=${f.p.id} AND person_id=${assignment.personId} AND ended_on IS NULL`,
		);
		assert.deepEqual(assignments.rows, [{ role_id: assignment.roleId }]);
		assert.deepEqual(await seatsOf(f.p.id), seats, "the answer changes no seat");
		const before = await counts();
		assert.deepEqual(ok(await call("answerLead", f.a, q, f.p)), result);
		assert.deepEqual(await counts(), before);
		assert.deepEqual(await ministryFacts(f.p.id), facts);
	}
});

test("AC:ROLE43-005 a no or a skip leaves the Owner's person, seat and full authority, and ordinary ministry editing sets a lead later", async () => {
	for (const answer of ["no", "skip"]) {
		const f = await makePlant();
		const seats = await seatsOf(f.p.id);
		const person = async () =>
			(
				await admin.execute(
					sql`SELECT id,display_name,linked_account_id,stage,state FROM person WHERE plant_id=${f.p.id}`,
				)
			).rows;
		const people = await person();
		const q = command({ answer }, (await resume(f)).revision);
		const { value, added } = await recorded(admin, () => call("answerLead", f.a, q, f.p));
		const result = ok(value);
		assert.deepEqual(added, { audits: ["attestation.recorded"], jobs: [], notices: 0, mail: 0 });
		assert.deepEqual(ok(await call("answerLead", f.a, q, f.p)), result);
		assert.equal(result.lead.answer, answer);
		assert.equal((await leadOf(f.p.id)).rows[0]!.n, 0);
		assert.deepEqual(await ministryFacts(f.p.id), { teams: [], roles: [], held: [] });
		assert.deepEqual(await seatsOf(f.p.id), seats);
		assert.deepEqual(
			seats.map((x) => x.role),
			["owner"],
		);
		assert.deepEqual(await person(), people);

		const owner = await RequestActor.resolve(db, f.a.session);
		assert.ok(owner instanceof RequestActor);
		const { r } = (await admin.execute<{ r: string }>(sql`SELECT revision::text AS r FROM plant WHERE id=${f.p.id}`))
			.rows[0]!;
		const ownerCtx = { session: f.a.session, selected: f.p };
		const profile = sectionOperations({
			effects: { replan: async () => assert.fail("a city replans nothing") },
		} as never);
		const saved = await withSettingsWrite(db, owner, ownerCtx, (tx) =>
			profile.updatePlantProfile(tx, ownerCtx, {
				requestKey: randomUUID(),
				expectedRevision: r,
				input: { plant: f.p, patch: { city: "Waco" } },
			}),
		);
		ok(saved);
		assert.deepEqual((await admin.execute(sql`SELECT city FROM plant WHERE id=${f.p.id}`)).rows, [{ city: "Waco" }]);
		const team = ok(
			await withTeamsWrite(db, owner, (tx, c) =>
				teamsWriter.create(tx, c, {
					requestKey: randomUUID(),
					input: { name: "Plant leadership", description: null },
				}),
			),
		).team;
		const { revision } = ok(await teamsReader.readRevision(db, owner, { teamId: team.id }));
		ok(
			await withTeamsWrite(db, owner, (tx, c) =>
				teamsWriter.appointLeader(tx, c, {
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { teamId: team.id, personId: f.result.ownerSeat.personId },
				}),
			),
		);
		const [led] = await admin.select().from(t.team).where(eq(t.team.id, team.id));
		assert.equal(led!.leader_person_id, f.result.ownerSeat.personId);
		assert.deepEqual(await seatsOf(f.p.id), seats, "a later lead title leaves the seat alone");
	}
});

test("AC:ROLE43-013 only one account's own six articles strictly past 80 percent complete the reading: an Admin lead's do, two halves and a borrowed title never do", async () => {
	const f = await makePlant();
	assert.equal((await resume(f)).currentPhase, 1, "creation asks for no reading");
	for (const [fraction, status] of [
		["0.80", "incomplete"],
		["0.8001", "complete"],
	] as const) {
		const alone = await makePlant();
		await reading(alone.a, [0, 1, 2, 3, 4, 5], fraction);
		const value = (await resume(alone)).reading;
		assert.equal(value.status, status, fraction);
		if (value.status === "complete") {
			assert.equal(value.readerAccountId, alone.a.id);
			assert.deepEqual(
				value.articles.map((x) => x.scrollRatio),
				[0.8001, 0.8001, 0.8001, 0.8001, 0.8001, 0.8001],
			);
		}
	}
	const five = await makePlant();
	await reading(five.a, [0, 1, 2, 3, 4], "0.9");
	await reading(five.a, [5], "0.80");
	assert.equal((await resume(five)).reading.status, "incomplete", "one article at 0.80 is not read");

	const [b, c, d] = [await reader(f), await reader(f), await reader(f)];
	const lead = ok(await call("answerLead", f.a, command(leadYes(undefined), (await resume(f)).revision), f.p));
	const { teamId, roleId } = yes(lead.lead).assignment;
	const credit = async () =>
		(
			await admin.execute(
				sql`SELECT account_id,article_id,completed_fraction::text FROM reading WHERE account_id IN (${f.a.id},${b.id},${c.id},${d.id}) ORDER BY 1,2`,
			)
		).rows;
	const title = async (who: { person: { id: string } }) => {
		await admin.update(t.team_tenure).set({ person_id: who.person.id }).where(eq(t.team_tenure.role_id, roleId));
		await admin.update(t.team).set({ leader_person_id: who.person.id }).where(eq(t.team.id, teamId));
	};
	await reading(c, [0, 1, 2], "0.9");
	await reading(d, [3, 4, 5], "0.9");
	await title(c);
	assert.equal((await resume(f)).reading.status, "incomplete");
	const role = randomUUID();
	await admin.insert(t.team_role).values({
		id: role,
		plant_id: f.p.id,
		team_id: teamId,
		name: "Lead planter",
		leadership: true,
		sort_order: 9,
	});
	await admin.insert(t.team_tenure).values({
		plant_id: f.p.id,
		role_id: role,
		person_id: d.person.id,
		started_on: "2026-01-01",
	});
	assert.equal((await resume(f)).reading.status, "incomplete", "two disjoint halves never add up");
	await reading(b, [0, 1, 2, 3, 4, 5], "0.8001");
	const stored = await credit();
	assert.equal((await resume(f)).reading.status, "incomplete", "B is an Admin without the lead title");
	await title(b);
	const complete = (await resume(f)).reading;
	assert.ok(complete.status === "complete");
	assert.deepEqual(
		[complete.readerAccountId, complete.eligibility],
		[b.id, { kind: "current_admin_lead", personId: b.person.id }],
	);
	assert.ok(complete.articles.every((x) => x.scrollRatio === 0.8001));
	await admin.update(t.person).set({ linked_account_id: null }).where(eq(t.person.id, b.person.id));
	assert.equal((await resume(f)).reading.status, "incomplete", "the title alone carries no reading");
	await title(c);
	assert.equal((await resume(f)).reading.status, "incomplete");
	assert.deepEqual(await credit(), stored, "no title or link edit moves a reading record");
	assert.equal(await admin.$count(t.reading, eq(t.reading.account_id, f.a.id)), 0, "the Owner still has 0 of 6");
});

async function stored() {
	const r = await admin.execute(
		sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM person) people,(SELECT count(*)::int FROM seat) seats,
			(SELECT count(*)::int FROM phase_transition) transitions,(SELECT count(*)::int FROM discovery WHERE converted_at IS NOT NULL) converted,
			(SELECT count(*)::int FROM affiliation WHERE ended_at IS NULL) affiliations,(SELECT count(*)::int FROM team) teams,(SELECT count(*)::int FROM team_role) roles,
			(SELECT count(*)::int FROM team_tenure) tenures,(SELECT count(*)::int FROM invitation) invitations,
			(SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM job) jobs`,
	);
	return present(r.rows[0], "row") as Record<string, number>;
}
const gained = (before: Record<string, number>, after: Record<string, number>) =>
	Object.fromEntries(Object.entries(after).map(([k, n]) => [k, n - before[k]!]));
async function failingRow(table: string, when: "INSERT" | "UPDATE", body: () => Promise<unknown>) {
	await admin.execute(
		sql.raw(
			`CREATE FUNCTION fail_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_required_failure'; END $$;
			 CREATE TRIGGER fail_row BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_row()`,
		),
	);
	try {
		await assert.rejects(body());
	} finally {
		await admin.execute(sql.raw(`DROP TRIGGER fail_row ON ${table};DROP FUNCTION fail_row()`));
	}
}
function invitationsWith(seen: (proof: string) => void) {
	return createInvitationService({
		db,
		origin: "http://onboarding.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: () => sql`false`,
		async enqueueMail(tx, input, command) {
			const token = input.text.match(/#proof=([^\s]+)/);
			if (token?.[1]) seen(decodeURIComponent(token[1]));
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
}
async function seatOffer(a: Account) {
	const sender = await makePlant();
	let proof = "";
	const invitations = invitationsWith((value) => (proof = value));
	const { invitation } = await invitations.invite(
		await verifiedWriteActor(sender.a.session),
		command({ workspace: sender.p, role: "member", recipientEmail: a.user + "@example.test" }, sender.result.revision),
	);
	assert.notEqual(proof, "");
	return () => invitations.accept(a.session, command({ invitationId: invitation.invitationId, proof }));
}

test("AC:TARGET-IDN-013 a church creation that fails at any required write leaves nothing behind, and its retry makes one church at Phase 1 with no reading or journey claimed", async () => {
	const a = await actor("planter", "pending_domain");
	const q = command({ name: "  Harvest Point ", locality: { city: "Waco" }, confirmed: true });
	const before = await stored();
	for (const [table, when] of [
		["plant", "INSERT"],
		["seat", "INSERT"],
		["person", "INSERT"],
		["phase_transition", "INSERT"],
		["audit_event", "INSERT"],
		["mail", "INSERT"],
		["account", "UPDATE"],
	] as const) {
		await failingRow(table, when, () => call("createPlant", a, q));
		assert.deepEqual(await stored(), before, table);
		assert.equal(
			present((await admin.select().from(t.account).where(eq(t.account.id, a.id)))[0], "account").registration_state,
			"pending_domain",
			table,
		);
	}
	const made = await Promise.all([call("createPlant", a, q), call("createPlant", a, q)]);
	const [first, second] = made.map((r) => ok(r));
	assert.deepEqual([first!.plant.id, first!.currentPhase, second!.currentPhase], [second!.plant.id, 1, 1]);
	const after = await stored();
	const { plants, people, seats, transitions, affiliations } = gained(before, after);
	assert.deepEqual(
		{ plants, people, seats, transitions, affiliations },
		{ plants: 1, people: 1, seats: 1, transitions: 1, affiliations: 0 },
	);
	const replay = ok(await call("createPlant", a, q));
	assert.deepEqual([replay.status, replay.plant.id, replay.currentPhase], ["existing", first!.plant.id, 1]);
	assert.deepEqual(gained(after, await stored()), Object.fromEntries(Object.keys(after).map((k) => [k, 0])));
	const [plant] = await admin.select().from(t.plant).where(eq(t.plant.id, first!.plant.id));
	assert.deepEqual(
		[plant!.name, plant!.city, plant!.state_province, plant!.country],
		["Harvest Point", "Waco", null, null],
	);
	const r = await resume({ a, p: first!.plant });
	assert.deepEqual([r.reading, r.currentPhase, r.completion], [{ status: "incomplete" }, 1, { status: "unfinished" }]);
});

test("AC:TARGET-IDN-013 AC:TARGET-IDN-016 accepting a seat and creating or converting to a church at the same time leave one active seat and no stray church or person", async () => {
	for (const kind of ["plant", "discovery"] as const)
		for (let n = 0; n < 2; n++) {
			const d = kind === "discovery" ? await discovery() : null;
			const a = d?.a ?? (await actor());
			const accept = await seatOffer(a);
			const before = await stored();
			const create = () =>
				d
					? call(
							"convertDiscovery",
							a,
							command(
								{ discoveryId: d.result.profile.discoveryId, name: "Raced plant", confirmed: true, relationships: [] },
								d.result.profile.revision,
							),
						)
					: call("createPlant", a, command({ name: "Raced plant", confirmed: true }));
			const [accepted, created] = n
				? await Promise.allSettled([accept(), create()])
				: ((await Promise.allSettled([create(), accept()])).reverse() as PromiseSettledResult<never>[]);
			const won = [accepted!.status === "fulfilled", created!.status === "fulfilled" && created!.value.status === "ok"];
			assert.equal(won.filter(Boolean).length, 1, `${kind} ${JSON.stringify(won)}`);
			const { plants, people, seats, transitions, converted } = gained(before, await stored());
			assert.deepEqual(
				{ plants, people, seats, transitions, converted },
				{
					plants: won[1] ? 1 : 0,
					people: 1,
					seats: 1,
					transitions: won[1] ? 1 : 0,
					converted: won[1] && d ? 1 : 0,
				},
			);
			assert.equal(await admin.$count(t.seat, and(eq(t.seat.account_id, a.id), sql`${t.seat.ended_at} IS NULL`)), 1);
		}
});

test("AC:TARGET-IDN-014 skipping the lead question adds no role, template or grant, and finalizing a Vision meeting without a lead still makes its required work", async () => {
	const { createAttendanceWriter, withMeetingsWrite } = await import("../../../packages/domain/src/meetings/index.ts");
	const f = await makePlant();
	const before = await stored();
	const skipped = ok(await call("answerLead", f.a, command({ answer: "skip" }, (await resume(f)).revision), f.p));
	assert.equal(skipped.lead.answer, "skip");
	const { teams, roles, tenures, seats, invitations, affiliations, people } = gained(before, await stored());
	assert.deepEqual(
		{ teams, roles, tenures, seats, invitations, affiliations, people },
		{ teams: 0, roles: 0, tenures: 0, seats: 0, invitations: 0, affiliations: 0, people: 0 },
	);
	assert.deepEqual(await ministryFacts(f.p.id), { teams: [], roles: [], held: [] });
	const outside = await otherPerson(f.p.id, "Other leader");
	assert.equal(await admin.$count(t.seat, eq(t.seat.plant_id, f.p.id)), 1);
	const guest = await otherPerson(f.p.id, "Vision guest");
	await admin.update(t.person).set({ stage: "prospect" }).where(eq(t.person.id, guest));
	const meeting = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
		resolver_version,status,attendance_revision) VALUES(${meeting},${f.p.id},'vision_meeting',NULL,'2026-10-01','18:00',
		'America/Chicago','2026-10-01T23:00:00Z','1','in_progress',1)`);
	const writer = createAttendanceWriter({ reminders: async () => {} } as never);
	const finalized = await withMeetingsWrite(db, await verifiedWriteActor(f.a.session), (tx, c) =>
		writer.finalizeAttendance(tx, c, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { meetingId: meeting, attendeeIds: [guest] },
		}),
	);
	assert.equal(finalized.status, "ok", JSON.stringify(finalized));
	const required = (
		await admin.execute(
			sql`SELECT b.kind,t.status,t.deleted_at IS NULL AS visible FROM obligation b JOIN task t ON t.obligation_id=b.id WHERE b.meeting_id=${meeting} ORDER BY 1`,
		)
	).rows;
	assert.deepEqual(required, [
		{ kind: "evaluation", status: "not_started", visible: true },
		{ kind: "follow_up", status: "not_started", visible: true },
	]);
	assert.deepEqual(await ministryFacts(f.p.id), { teams: [], roles: [], held: [] });
	assert.equal((await resume(f)).lead.answer, "skip");
	assert.notEqual(outside, guest);
});

test("AC:TARGET-IDN-015 finishing twice with no new date keeps Phase 1 and the launch date, records one completion, claims no reading, and a failed save changes nothing", async () => {
	const f = await makePlant();
	await admin.insert(t.launch).values({ plant_id: f.p.id, target_date: "2026-11-10", status: "scheduled" });
	const r = await resume(f);
	const journey = { journey: { answer: "existing", phase: 4 }, launch: { answer: "skip" } };
	const state = async () => ({
		stored: await stored(),
		plant: (await admin.select().from(t.plant).where(eq(t.plant.id, f.p.id)))[0],
		launch: (await admin.select().from(t.launch).where(eq(t.launch.plant_id, f.p.id)))[0],
	});
	const before = await state();
	for (const [table, when] of [
		["phase_transition", "INSERT"],
		["audit_event", "INSERT"],
	] as const) {
		await failingRow(table, when, () => call("declareJourney", f.a, command(journey, r.revision), f.p));
		assert.deepEqual(await state(), before, table);
	}
	const planned = {
		...journey,
		launch: { answer: "planned", date: "2026-12-01", expectedScheduleRevision: String(before.launch!.revision) },
	};
	for (const [table, when] of [
		["launch", "INSERT"],
		["phase_transition", "INSERT"],
		["onboarding_setup", "UPDATE"],
	] as const) {
		await failingRow(table, when, () => call("declareJourney", f.a, command(planned, r.revision), f.p));
		assert.deepEqual(await state(), before, `a launch date saved with a failing ${table}`);
	}
	const other = await makePlant();
	const reached = ok(
		await call(
			"declareJourney",
			other.a,
			command(
				{ ...planned, launch: { ...planned.launch, expectedScheduleRevision: "1" } },
				(await resume(other)).revision,
			),
			other.p,
		),
	);
	assert.deepEqual(
		[reached.currentPhase, reached.scheduledLaunchDate],
		[4, "2026-12-01"],
		"the same answer with no fault",
	);
	const untouched = await state();
	await failingRow("audit_event", "INSERT", () => call("complete", f.a, command({}, r.revision), f.p));
	assert.deepEqual(await state(), untouched);
	const saved = ok(
		await call(
			"declareJourney",
			f.a,
			command({ journey: { answer: "skip" }, launch: { answer: "no_date" } }, r.revision),
			f.p,
		),
	);
	assert.deepEqual([saved.currentPhase, saved.scheduledLaunchDate], [1, "2026-11-10"]);
	const q = command({}, saved.revision);
	const done = ok(await call("complete", f.a, q, f.p));
	const once = await state();
	assert.deepEqual(ok(await call("complete", f.a, q, f.p)), done);
	assert.deepEqual(await state(), once);
	const repeated = ok(await call("complete", f.a, command({}, done.revision), f.p));
	assert.deepEqual(repeated.completion, done.completion);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${f.p.id} AND action='attestation.recorded' AND kind='complete'`,
			)
		).rows[0]!.n,
		1,
	);
	const end = await resume(f);
	assert.deepEqual(
		[end.currentPhase, end.scheduledLaunchDate, end.reading, end.completion.status, end.lead, end.peopleStep],
		[1, "2026-11-10", { status: "incomplete" }, "completed", { answer: "pending" }, "pending"],
	);
	denied(await call("createPlant", f.a, command({ name: "Again", confirmed: true }, "2")), "active_seat_conflict");
	assert.equal(await admin.$count(t.phase_transition, eq(t.phase_transition.plant_id, f.p.id)), 1);
	const keep = await call(
		"declareJourney",
		f.a,
		command({ journey: { answer: "existing", phase: 0 }, launch: { answer: "no_date" } }, end.revision),
		f.p,
	);
	assert.equal((await resume(f)).scheduledLaunchDate, "2026-11-10", keep.status);
});

test("AC:AF-012 AC:TARGET-IDN-016 converting twice makes one church, one Owner seat, one creation and one approved link for the chosen organization only", async () => {
	const former = await makePlant();
	const seatless = await actor("planter");
	await admin.insert(t.seat).values({
		account_id: seatless.id,
		plant_id: former.p.id,
		role: "member",
		accepted_at: new Date(Date.now() - 86400000),
		ended_at: new Date(),
	});
	const d = await discovery();
	assert.equal(await admin.$count(t.seat, eq(t.seat.account_id, d.a.id)), 0);
	const links = {
		S1: await relationship(d.a),
		S2: await relationship(d.a),
		N1: await relationship(d.a, "sending_network"),
		N2: await relationship(d.a, "sending_network"),
	};
	assert.equal(await admin.$count(t.seat, eq(t.seat.account_id, d.a.id)), 0, "a link grants no seat");
	const { revision } = activeProfile(ok(await call("getDiscoveryProfile", d.a, {})));
	const q = command(
		{
			discoveryId: d.result.profile.discoveryId,
			name: "Harvest Point",
			confirmed: true,
			relationships: [links.S1],
		},
		revision,
	);
	const before = await stored();
	const member = await reader(former, "member"),
		administrator = await reader(former),
		stranger = await discovery();
	const readers = await stored();
	for (const who of [seatless, stranger.a]) denied(await call("convertDiscovery", who, q));
	for (const who of [member, administrator, former.a])
		denied(await call("convertDiscovery", who, q), "active_seat_conflict");
	denied(await call("convertDiscovery", d.a, q, former.p));
	denied(await call("convertDiscovery", d.a, command(q.input, String(BigInt(revision) + 1n))), "conflict");
	for (const [table, when] of [
		["plant", "INSERT"],
		["seat", "INSERT"],
		["person", "INSERT"],
		["affiliation", "INSERT"],
		["phase_transition", "INSERT"],
		["audit_event", "INSERT"],
		["discovery", "UPDATE"],
	] as const)
		await failingRow(table, when, () => call("convertDiscovery", d.a, q));
	assert.deepEqual(await stored(), readers);

	const [first, second] = (await Promise.all([call("convertDiscovery", d.a, q), call("convertDiscovery", d.a, q)])).map(
		(r) => ok(r),
	);
	assert.deepEqual([first!.status, second!.status].sort(), ["converted", "existing"]);
	const P = first!.plant;
	assert.equal(second!.plant.id, P.id);
	assert.deepEqual([first!.currentPhase, second!.currentPhase], [1, 1]);
	const { plants, seats, transitions, people, converted } = gained(readers, await stored());
	assert.deepEqual(
		{ plants, seats, transitions, people, converted },
		{ plants: 1, seats: 1, transitions: 1, people: 1, converted: 1 },
	);
	const owners = await admin.select().from(t.seat).where(eq(t.seat.plant_id, P.id));
	assert.deepEqual(
		owners.map((x) => [x.account_id, x.role, x.ended_at]),
		[[d.a.id, "owner", null]],
	);
	const active = await admin
		.select()
		.from(t.affiliation)
		.where(and(eq(t.affiliation.plant_id, P.id), sql`${t.affiliation.ended_at} IS NULL`));
	assert.deepEqual(
		active.map((x) => [x.organization_id, x.share_wiki, x.share_people, x.shared_findings]),
		[[links.S1.organization.id, true, false, false]],
	);
	const approvals = (
		await admin.execute(sql`SELECT * FROM audit_event WHERE action='affiliation.approved' AND actor_id=${d.a.id}`)
	).rows;
	assert.equal(approvals.length, 1);
	const approval = JSON.stringify(approvals[0]);
	for (const id of [active[0]!.id, P.id, links.S1.organization.id]) assert.ok(approval.includes(id), approval);
	for (const link of [links.S2, links.N1, links.N2]) assert.equal(approval.includes(link.organization.id), false);
	for (const link of Object.values(links)) {
		const [old] = await admin.select().from(t.affiliation).where(eq(t.affiliation.id, link.relationshipId));
		assert.ok(old!.ended_at, "the Discovery link ends");
		assert.equal(
			await admin.$count(t.seat, eq(t.seat.organization_id, link.organization.id)),
			1,
			"no organization gains a seat",
		);
	}
	const settled = await stored();
	const replay = ok(await call("convertDiscovery", d.a, q));
	assert.deepEqual([replay.status, replay.plant.id, replay.creation], ["existing", P.id, first!.creation]);
	denied(await call("convertDiscovery", d.a, { ...q, requestKey: randomUUID() }), "active_seat_conflict");
	assert.deepEqual(await stored(), settled);
	assert.ok(before.plants! < settled.plants!);
});
