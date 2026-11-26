import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgDialect } from "../../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { SQL, sql, type SQLWrapper } from "../../../packages/db/src/query.ts";
import { fixture, type Fixture } from "../identity/invitations-support.mts";
import {
	captureFacts,
	createFacts,
	createPrivateCare,
	createSignals,
	criteriaOf,
	factInputs,
	type PrivateCare,
	type Signals,
} from "../../../packages/domain/src/intelligence/index.ts";
import { commitments, peopleWriter, recordCorrections } from "../../../packages/domain/src/people/index.ts";
import { ok, refusedWith } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { instant } from "../../../packages/contracts/src/common/index.ts";
import { readCatalog } from "../../../packages/domain/src/phases/index.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { caseOf, type Case } from "../target/sql/core/support.mts";

let f: Fixture;
let facts: ReturnType<typeof createFacts>;
let signals: Signals;
let care: PrivateCare;
type Plant = Awaited<ReturnType<typeof plant>>;
type Committed = Awaited<ReturnType<typeof committed>>;
type PlantFacts = Awaited<ReturnType<typeof read>>;
const ZONE = "America/Chicago";
const refusedBare = refusedWith({ details: {} });
const rows = async <T extends Record<string, unknown>>(q: SQL) => (await f.admin.execute<T>(q)).rows;
const one = async <T extends Record<string, unknown>>(q: SQL) => (await rows<T>(q))[0]!;
let today: string;
const day = (n: number) => new Date(Date.parse(today + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

before(async () => {
	f = await fixture();
	facts = createFacts();
	signals = createSignals();
	care = createPrivateCare();
	today = (await one<{ d: string }>(sql`SELECT (clock_timestamp() AT TIME ZONE ${ZONE})::date::text AS d`)).d;
});
after(() => f?.close());

async function plant() {
	const w = await f.workspace();
	assert.ok(w.kind === "plant");
	await f.admin.execute(sql`UPDATE plant SET timezone=${ZONE} WHERE id=${w.id}`);
	const a = await f.account();
	await f.seat(a, w, "owner");
	await f.admin.execute(sql`UPDATE account SET personal_timezone=${ZONE} WHERE id=${a.id}`);
	return {
		...a,
		w,
		actor: await f.actor(a.session),
		ctx: { session: a.session, selected: w },
	};
}
const tx = <T,>(body: Parameters<typeof gatedTransaction<T>>[1]) => gatedTransaction(f.db, body);
async function person(
	o: Plant,
	displayName: string,
	input: Record<string, unknown> = { adultClassification: "adult" },
): Promise<{ id: string; displayName: string }> {
	return ok(
		await tx((t) =>
			peopleWriter.createPerson(t, o.ctx, { requestKey: randomUUID(), input: { displayName, ...input } }),
		),
	).person;
}
const card = async (
	o: Plant,
	personId: string,
	occurredOn: string,
	kind: "core_group" | "launch_team" = "core_group",
) =>
	ok(
		await tx((t) =>
			commitments.createCommitment(t, o.ctx, { requestKey: randomUUID(), input: { personId, kind, occurredOn } }),
		),
	);
async function committed(o: Plant, name: string, on = day(-60), input?: Record<string, unknown>) {
	const p = await person(o, name, input);
	const saved = await card(o, p.id, on);
	return { ...p, cardId: saved.commitment.id, cardRevision: saved.commitment.revision };
}
const read = async (o: Pick<Plant, "actor">, db: Pick<Database, "execute"> = f.db) =>
	ok(await facts.readFacts(db, o.actor, {}));
const record = (id: string, kind: string, plantId: string) =>
	f.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${plantId}) ON CONFLICT DO NOTHING`);

let visionNumber = 0;
async function meeting(
	o: Plant,
	{
		held,
		inDays = 0,
		type = "vision_meeting",
		attended = [],
	}: { type?: string; attended?: string[] } & (
		{ held: number; inDays?: undefined } | { held?: undefined; inDays: number }
	),
) {
	const id = randomUUID();
	await record(id, "meeting", o.w.id);
	const on = held !== undefined ? day(-held) : day(inDays);
	const at = `${on}T18:00:00-06:00`;
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,actual_occurrence_at,vision_number)
		VALUES(${id},${o.w.id},${type},${on},'18:00',${ZONE},${at}::timestamptz,'r1',${held !== undefined ? "completed" : "ready"},1,
		${held !== undefined ? at : null}::timestamptz,${type === "vision_meeting" ? ++visionNumber : null})`);
	for (const personId of attended) await attend(o, id, personId);
	return id;
}
async function attend(o: Plant, meetingId: string, personId: string, presence = "attended") {
	const id = randomUUID();
	await record(id, "participation", o.w.id);
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,presence)
		VALUES(${id},${o.w.id},${meetingId},${personId},true,${presence})`);
	return id;
}
async function followUp(
	o: Plant,
	meetingId: string,
	personId: string,
	ageHours: number,
	task: { status?: string; after?: number } = {},
) {
	const id = randomUUID(),
		taskId = randomUUID();
	await record(id, "obligation", o.w.id);
	await record(taskId, "task", o.w.id);
	const origin = hoursAgo(ageHours);
	await f.admin.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
		formula_version,due_date) VALUES(${id},${o.w.id},${meetingId},${personId},'follow_up',${origin}::timestamptz,
		${origin.slice(0, 10)},${ZONE},'f1',${day(2)})`);
	await f.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,completed_at)
		VALUES(${taskId},${o.w.id},'Follow up','follow_up','medium',${task.status ?? "not_started"},${origin}::timestamptz,'undated',
		${id},${task.status === "complete" ? hoursAgo(ageHours - (task.after ?? 1)) : null}::timestamptz)`);
	return { id, taskId, origin };
}
async function outcome(
	o: Plant,
	obligation: Awaited<ReturnType<typeof followUp>>,
	personId: string,
	kind: string,
	afterHours: number,
	completes = true,
) {
	const id = randomUUID();
	await record(id, "contact_outcome", o.w.id);
	const at = new Date(Date.parse(obligation.origin) + afterHours * 3_600_000).toISOString();
	await f.admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,task_id,obligation_id,outcome,occurred_at,
		recorded_at,completes_task) VALUES(${id},${o.w.id},${personId},${obligation.taskId},${obligation.id},${kind},
		${at}::timestamptz,${at}::timestamptz,${completes})`);
	return id;
}
async function roles(o: Plant, holders: [string, string | null][]) {
	const team = randomUUID();
	await record(team, "team", o.w.id);
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${o.w.id},'Launch team','active',1)`,
	);
	const held: Record<string, { role: string; tenure: string }> = {};
	let order = 0;
	for (const [key, personId] of holders) {
		const role = randomUUID();
		await record(role, "team_role", o.w.id);
		await f.admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,responsibility_key)
			VALUES(${role},${o.w.id},${team},${key + " lead"},true,${++order},${key})`);
		if (personId) {
			const tenure = randomUUID();
			await record(tenure, "team_tenure", o.w.id);
			await f.admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
				VALUES(${tenure},${o.w.id},${role},${personId},${day(-10)})`);
			held[key] = { role, tenure };
		}
	}
	return { team, held };
}
async function program(o: Plant, people: { id: string }[], complete: number) {
	const id = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO training_program(id,plant_id,name,required) VALUES(${id},${o.w.id},'Launch team basics',true)`,
	);
	for (const [i, p] of people.entries()) {
		await f.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${o.w.id},${id},${p.id},1,'active',${day(-20)})`);
		if (i < complete)
			await f.admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
				VALUES(${o.w.id},${p.id},${id},'earned',1,${day(-5)})`);
	}
	return id;
}
const CANARY = "canary-note-7f3a";
async function interview(o: Plant, personId: string, on: string) {
	const id = randomUUID();
	await record(id, "interview", o.w.id);
	await f.admin
		.execute(sql`INSERT INTO interview(id,plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,
		right_reasons,season,maturity_notes,result) VALUES(${id},${o.w.id},${personId},${on},clock_timestamp(),'concern','pass',
		'pass','pass','fail',${CANARY + "-interview"},'not_qualified')`);
}
async function fourCs(o: Plant, personId: string, on: string) {
	const id = randomUUID();
	await record(id, "four_cs", o.w.id);
	await f.admin
		.execute(sql`INSERT INTO four_cs(id,plant_id,person_id,assessed_on,recorded_at,committed,compelled,contagious,
		courageous,committed_notes) VALUES(${id},${o.w.id},${personId},${on},clock_timestamp(),2,3,1,4,${CANARY + "-4cs"})`);
}
async function checkIn(o: Plant) {
	const current = ok(await care.readCurrent(f.db, o.actor, {}));
	const struggling = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
	ok(
		await care.save(f.db, o.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: { answers: struggling, note: CANARY + "-care" },
		}),
	);
}
const stable = ({ asOf: _asOf, ...rest }: PlantFacts) => rest;

test("AC:CA001 AC:CA003 30 committed adults on two teams count once each, children do not count, and the list names each", async () => {
	const o = await plant();
	const adults: Committed[] = [];
	for (let i = 0; i < 30; i++) {
		const p = await committed(o, `Adult ${String(i + 1).padStart(2, "0")}`);
		if (i < 10) await card(o, p.id, day(-30), "launch_team");
		adults.push(p);
	}
	for (const name of ["Child One", "Child Two"]) await committed(o, name, day(-40), { birthDate: "2016-04-02" });
	const r = await read(o);
	const a = r.committedAdults;
	assert.deepEqual([a.status, a.known, a.exact, a.children, a.needsClassifying.length], ["met", 30, 30, 2, 0]);
	assert.deepEqual(a.evidence.map((e) => e.person.id).sort(), adults.map((p) => p.id).sort());
	const both = a.evidence.find((e) => e.person.id === adults[0]!.id)!;
	assert.deepEqual([both.kinds, both.committedSince], [["core_group", "launch_team"], day(-60)]);
	assert.equal(r.criteria.committed_adults, "met");
	assert.equal(r.formulaVersion, "plant-facts/2");
});

test("AC:CA004 29 known adults and one unclassified person read Unknown with at least 29 and name that person", async () => {
	const o = await plant();
	for (let i = 0; i < 29; i++) await committed(o, `Adult ${i + 1}`);
	const sam = await committed(o, "Sam Unclassified", day(-60), {});
	const a = (await read(o)).committedAdults;
	assert.deepEqual([a.status, a.known, a.exact], ["unknown", 29, null]);
	assert.deepEqual(a.needsClassifying, [{ id: sam.id, name: "Sam Unclassified" }]);
	await f.admin.execute(sql`UPDATE person SET adult_classification='adult' WHERE id=${sam.id}`);
	assert.deepEqual([(await read(o)).committedAdults.exact, (await read(o)).committedAdults.status], [30, "met"]);
});

test("AC:CA008 AC:CA019 a withdrawal lowers the count but keeps the growth clock; a corrected date moves it, with history and audit", async () => {
	const o = await plant();
	await committed(o, "Avery Early", day(-50));
	const blake = await committed(o, "Blake Recent", day(-22));
	let r = await read(o);
	assert.deepEqual([r.growth.status, r.growth.daysSince, r.committedAdults.known], ["slowed", 22, 2]);
	const personRevision = (await one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${blake.id}`)).r;
	ok(
		await tx((t) =>
			commitments.withdrawCommitment(t, o.ctx, {
				requestKey: randomUUID(),
				expectedRevision: personRevision,
				input: { personId: blake.id, effectiveOn: day(-2) },
			}),
		),
	);
	r = await read(o);
	assert.deepEqual(
		[r.committedAdults.known, r.growth.status, r.growth.lastAcquiredOn, r.growth.current, r.growth.currentWithdrawn],
		[1, "slowed", day(-22), 1, 1],
	);
	const before = r.sourceRevision;
	ok(
		await tx((t) =>
			commitments.correctCommitmentLifecycle(t, o.ctx, {
				requestKey: randomUUID(),
				expectedRevision: blake.cardRevision,
				input: {
					commitmentId: blake.cardId,
					correction: { action: "correct", occurredOn: day(-30) },
					reason: "Wrong date",
				},
			}),
		),
	);
	r = await read(o);
	assert.notEqual(r.sourceRevision, before);
	assert.deepEqual(
		[r.growth.status, r.growth.lastAcquiredOn, r.growth.daysSince, r.growth.current],
		["stalled", day(-30), 30, 0],
	);
	const history = ok(await tx((t) => recordCorrections.listRecordCorrections(t, o.ctx, { personId: blake.id })));
	const line = JSON.stringify(history);
	assert.match(line, new RegExp(day(-22)));
	assert.match(line, new RegExp(day(-30)));
	const audit =
		await one(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${o.w.id} AND action='people.corrected'
		AND metadata->>'event'='commitment_corrected' AND subject_id=${blake.id}`);
	assert.equal(audit.n, 1);
});

test("AC:PI-CASE-003 AC:PI-TASK-CONTACT-001 AC:B01-002 AC:B01-020 AC:B01-026 vision, follow-ups, coverage, training and answers", async () => {
	const o = await plant();
	const people = [];
	for (let i = 0; i < 10; i++) people.push(await committed(o, `Member ${i + 1}`));
	const held = await meeting(o, { held: 22, attended: people.slice(0, 6).map((p) => p.id) });
	await meeting(o, { held: 36, attended: people.slice(0, 4).map((p) => p.id) });
	await meeting(o, { inDays: 3 });
	await meeting(o, { held: 2 });

	const [g1, g2, g3, g4] = [
		await followUp(o, held, people[0]!.id, 72, { status: "complete", after: 72 - 10 }),
		await followUp(o, held, people[1]!.id, 72, { status: "complete", after: 72 - 40 }),
		await followUp(o, held, people[2]!.id, 72, { status: "no_longer_needed" }),
		await followUp(o, held, people[3]!.id, 72),
	];
	await outcome(o, g1, people[0]!.id, "contacted", 10);
	await outcome(o, g2, people[1]!.id, "administrative_completion", 40);
	void g3;
	void g4;

	const [a, b, c, d, e] = people;
	await roles(o, [
		["worship", a!.id],
		["children", b!.id],
		["assimilation", c!.id],
		["small_groups", d!.id],
		["administration_finance", null],
		["facilities", a!.id],
		["promotion", b!.id],
		["technology", null],
		["prayer", e!.id],
	]);
	await program(o, people, 9);
	ok(
		await signals.attest(f.db, o.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { key: "prayer_rhythm_established", value: "yes", asOf: day(-35) },
		}),
	);

	const r = await read(o);
	assert.deepEqual(
		[r.vision.status, r.vision.daysSince, r.vision.lastHeldOn, r.vision.nextScheduledOn],
		["watch", 22, day(-22), day(3)],
	);
	assert.deepEqual(r.vision.lastAttendance, [6, 4]);
	assert.deepEqual(
		[r.followUps.onTime, r.followUps.measured, r.followUps.noLongerNeeded, r.followUps.contacted],
		[2, 3, 1, 1],
	);
	assert.deepEqual(
		[r.coverage.filled, r.coverage.people, r.coverage.prayerLeader],
		[6, 4, [{ id: e!.id, name: e!.displayName }]],
	);
	assert.deepEqual([r.training.complete, r.training.total, r.training.status], [9, 10, "not_met"]);
	const prayer = r.attestations.find((x) => x.key === "prayer_rhythm_established")!;
	assert.deepEqual([prayer.value, prayer.asOf, prayer.renewal.status], ["yes", day(-35), "needs_renewing"]);
	assert.deepEqual(
		[r.criteria.all_team_leaders, r.criteria.training_complete, r.criteria.worship_leader, r.criteria.financial_base],
		["not_met", "not_met", "met", "unknown"],
	);
});

test("AC:CA015 a plant with no attendance reads Vision rhythm and cohesion as Unknown, not zero", async () => {
	const o = await plant();
	await committed(o, "Only Person");
	await meeting(o, { inDays: 5 });
	const r = await read(o);
	assert.deepEqual([r.vision.status, r.vision.reason, r.vision.daysSince], ["unknown", "no_attendance", null]);
	assert.deepEqual([r.cohesion.status, r.cohesion.reason], ["unknown", "no_attendance"]);
	assert.equal(r.followUps.status, "unknown");
	assert.equal(r.training.status, "unknown");
});

test("AC:PI-PURPOSE-001 AC:ASMT-012 check-ins never reach the facts; interviews and 4 C's show only a count and the latest date", async () => {
	const o = await plant();
	const p = await committed(o, "Quinn Interviewed");
	await interview(o, p.id, day(-9));
	await interview(o, p.id, day(-3));
	await fourCs(o, p.id, day(-12));
	const before = await read(o);
	await checkIn(o);
	const r = await read(o);
	assert.deepEqual(r.humanRecords, {
		interviews: { count: 2, latestOn: day(-3) },
		fourCs: { count: 1, latestOn: day(-12) },
	});
	const text = JSON.stringify(r);
	for (const hidden of [CANARY, "struggling", "not_qualified", "concern"]) assert.ok(!text.includes(hidden), hidden);
	assert.deepEqual(stable(r), stable(before));
	const seen: (SQLWrapper | string)[] = [];
	const spy: Pick<Database, "execute"> = {
		execute: <T extends Record<string, unknown>>(q: SQLWrapper | string) => {
			seen.push(q);
			return f.db.execute<T>(q);
		},
	};
	await read(o, spy);
	assert.equal(seen.length, 1);
	const [query] = seen;
	assert.ok(query instanceof SQL);
	const statement = new PgDialect().sqlToQuery(query).sql;
	for (const name of ["private_", "_notes", "result", "maturity", "committed,", "score", "next_steps", "card_notes"])
		assert.ok(!statement.includes(name), name);
});

test("AC:PI-CASE-001 a Member, a foreign plant and an ended seat read no facts", async () => {
	const o = await plant();
	await committed(o, "Private Person");
	const member = await f.account();
	await f.seat(member, o.w, "member");
	refusedBare(await facts.readFacts(f.db, await f.actor(member.session), {}), "access_denied");
	const other = await plant();
	assert.equal((await read(other)).committedAdults.known, 0);
	const admin = await f.account();
	const seat = await f.seat(admin, o.w, "admin");
	const actor = await f.actor(admin.session);
	assert.equal((await read({ actor })).committedAdults.known, 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${seat}`);
	refusedBare(await facts.readFacts(f.db, actor, {}), "access_denied");
	refusedBare(await facts.readFacts(f.db, o.actor, { extra: 1 }), "invalid_input");
});

test("AC:ASMT-006 every input the facts read changes the revision on the next read; private care does not", async () => {
	const o = await plant();
	const p = await committed(o, "Rowan Input");
	const q = await committed(o, "Sky Input", day(-30), {});
	const born = await committed(o, "Tate Born", day(-40), { birthDate: "1990-02-03" });
	const m = await meeting(o, { held: 10, attended: [p.id, q.id] });
	const m2 = await meeting(o, { held: 12, attended: [p.id] });
	const ob = await followUp(o, m, p.id, 72, { status: "complete", after: 62 });
	const co = await outcome(o, ob, p.id, "contacted", 10);
	const ob2 = await followUp(o, m, q.id, 30);
	const team = await roles(o, [
		["worship", p.id],
		["children", q.id],
	]);
	const other = await roles(o, [["technology", p.id]]);
	const prog = await program(o, [p], 0);
	await interview(o, p.id, day(-4));
	await fourCs(o, p.id, day(-4));
	const next = await meeting(o, { inDays: 4 });

	const changes = {
		"plant.timezone": sql`UPDATE plant SET timezone='America/Denver' WHERE id=${o.w.id}`,
		"plant.phase": sql`UPDATE plant SET phase=phase+1 WHERE id=${o.w.id}`,
		"person.display_name": sql`UPDATE person SET display_name='Rowan Renamed' WHERE id=${p.id}`,
		"person.adult_classification (no birth date)": sql`UPDATE person SET adult_classification='child' WHERE id=${q.id}`,
		"person.birth_date": sql`UPDATE person SET birth_date='2015-02-03' WHERE id=${born.id}`,
		"person.state": sql`UPDATE person SET state='retired',retired_at=clock_timestamp() WHERE id=${born.id}`,
		"commitment.signed_on": sql`UPDATE commitment SET signed_on=${day(-61)} WHERE id=${p.cardId}`,
		"commitment.kind": sql`UPDATE commitment SET kind='launch_team' WHERE id=${p.cardId}`,
		commitment_change: sql`INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on)
			VALUES(${randomUUID()},${o.w.id},${p.id},'withdrawn',${day(-1)})`,
		"commitment.voided_at": sql`UPDATE commitment SET voided_at=clock_timestamp() WHERE id=${q.cardId}`,
		"meeting.actual_occurrence_at": sql`UPDATE meeting SET actual_occurrence_at=actual_occurrence_at-interval '1 day' WHERE id=${m}`,
		"meeting.local_date (next scheduled)": sql`UPDATE meeting SET local_date=${day(6)} WHERE id=${next}`,
		"participation.presence": sql`UPDATE participation SET presence='absent' WHERE meeting_id=${m} AND person_id=${p.id}`,
		"participation.removed_at": sql`UPDATE participation SET removed_at=clock_timestamp() WHERE meeting_id=${m} AND person_id=${q.id}`,
		"meeting.status": sql`UPDATE meeting SET status='cancelled' WHERE id=${m2}`,
		"task.status": sql`UPDATE task SET status='no_longer_needed',completed_at=NULL WHERE id=${ob.taskId}`,
		"obligation.waived_at": sql`UPDATE obligation SET waived_at=clock_timestamp() WHERE id=${ob2.id}`,
		"obligation.origin_at": sql`UPDATE obligation SET origin_at=origin_at-interval '1 hour' WHERE id=${ob.id}`,
		"contact_outcome.voided_at": sql`UPDATE contact_outcome SET voided_at=clock_timestamp() WHERE id=${co}`,
		"team.archived_at": sql`UPDATE team SET archived_at=clock_timestamp() WHERE id=${other.team}`,
		"team_tenure.ended_on": sql`UPDATE team_tenure SET ended_on=${today} WHERE id=${team.held.worship!.tenure}`,
		"team_role.retired_at": sql`UPDATE team_role SET retired_at=clock_timestamp() WHERE id=${team.held.children!.role}`,
		training_credit: sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
			VALUES(${o.w.id},${p.id},${prog},'earned',1,${day(-1)})`,
		"training_program.version": sql`UPDATE training_program SET version=2 WHERE id=${prog}`,
		"training_assignment.state": sql`UPDATE training_assignment SET state='removed',ended_on=${today} WHERE program_id=${prog}`,
		"training_program.required": sql`UPDATE training_program SET required=false WHERE id=${prog}`,
		interview: sql`DELETE FROM interview WHERE person_id=${p.id}`,
		four_cs: sql`DELETE FROM four_cs WHERE person_id=${p.id}`,
		launch: sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${o.w.id},${day(40)},'scheduled')`,
		"launch.target_date": sql`UPDATE launch SET target_date=${day(41)} WHERE plant_id=${o.w.id}`,
		"launch.status": sql`UPDATE launch SET status='postponed',target_date=NULL WHERE plant_id=${o.w.id}`,
		"launch.gathering_path": sql`UPDATE launch SET gathering_path='milestone' WHERE plant_id=${o.w.id}`,
		"launch.gathering_reached_on": sql`UPDATE launch SET gathering_reached_on=${day(-1)},
			gathering_reached_name='Constituted as a church' WHERE plant_id=${o.w.id}`,
		"launch.gathering_reached_name": sql`UPDATE launch SET gathering_reached_name='Church constituted' WHERE plant_id=${o.w.id}`,
	};
	let last = (await read(o)).sourceRevision;
	for (const [input, change] of Object.entries(changes)) {
		await f.admin.execute(change);
		const now = (await read(o)).sourceRevision;
		assert.notEqual(now, last, `${input} did not change the facts' revision`);
		last = now;
	}
	ok(
		await signals.attest(f.db, o.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { key: "systems_tested", value: "yes" },
		}),
	);
	const answered = await read(o);
	assert.notEqual(answered.sourceRevision, last);
	assert.equal(answered.criteria.systems_tested, "met");
	await checkIn(o);
	await f.admin.execute(sql`UPDATE person SET email='rowan@example.test',notes='unrelated' WHERE id=${p.id}`);
	const quiet = await read(o);
	assert.equal(quiet.sourceRevision, answered.sourceRevision);
	assert.deepEqual(stable(quiet), stable(answered));
	assert.deepEqual(Object.keys(factInputs.shape).sort(), [
		"anyAttendance",
		"attendance",
		"attestations",
		"followUps",
		"fourCs",
		"interviews",
		"launch",
		"nextVision",
		"people",
		"phase",
		"roles",
		"training",
		"vision",
		"zone",
	]);
});

type PiCase = Case & { clock: { now: string; zone: string } };
const piCase = (id: string) => caseOf("intelligence", id) as PiCase;
const valueOf = <T,>(k: PiCase, name: string) => (k.given[name] as { value: T }).value;
const pinnedFacts = (iso: string) => createFacts({ clock: { now: () => instant.parse(new Date(iso).toISOString()) } });
const readAt = async (o: Pick<Plant, "actor">, iso: string) => ok(await pinnedFacts(iso).readFacts(f.db, o.actor, {}));
const shiftDays = (on: string, n: number) =>
	new Date(Date.parse(on + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
async function zoned(zone: string, phase?: number) {
	const o = await plant();
	await f.admin.execute(
		sql`UPDATE plant SET timezone=${zone},phase=coalesce(${phase ?? null}::int,phase) WHERE id=${o.w.id}`,
	);
	return o;
}
async function heldOn(
	o: Plant,
	on: string,
	attended: string[],
	{ type = "vision_meeting", status = "completed" }: { type?: string; status?: string } = {},
) {
	const id = randomUUID();
	await record(id, "meeting", o.w.id);
	const at = `${on}T09:00:00-05:00`;
	await f.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,actual_occurrence_at,vision_number)
		VALUES(${id},${o.w.id},${type},${on},'09:00',${ZONE},${at}::timestamptz,'r1',${status},1,
		${status === "completed" ? at : null}::timestamptz,${type === "vision_meeting" ? ++visionNumber : null})`);
	for (const personId of attended) await attend(o, id, personId);
	return id;
}
const revisionOfPerson = async (personId: string) =>
	(await one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${personId}`)).r;
const withdraw = async (o: Plant, personId: string, effectiveOn: string) =>
	ok(
		await tx(async (t) =>
			commitments.withdrawCommitment(t, o.ctx, {
				requestKey: randomUUID(),
				expectedRevision: await revisionOfPerson(personId),
				input: { personId, effectiveOn },
			}),
		),
	);

test("AC:PI-CASE-001 one capture at a pinned as-of reads one database state, before or after a concurrent writer, never a mix", async () => {
	const k = piCase("PI-CASE-001");
	const asOf = valueOf<string>(k, "as_of");
	const peopleBefore = valueOf<number>(k, "people_before");
	const attendanceBefore = valueOf<number>(k, "attendance_before");
	const during = valueOf<{ people_after: number; attendance_after: number }>(k, "writer_during_capture");
	assert.equal(valueOf<boolean>(k, "clock_advances_during_queries"), true);
	const o = await plant();
	const people: Committed[] = [];
	for (let i = 0; i < peopleBefore; i++) people.push(await committed(o, `Snapshot ${i + 1}`, "2026-09-01"));
	const vision = await heldOn(
		o,
		"2026-10-06",
		people.slice(0, attendanceBefore).map((p) => p.id),
	);
	const catalog = await readCatalog();
	const capture = async () => {
		const snapshot = await captureFacts(f.db, o.w.id, asOf);
		assert.ok(snapshot);
		return {
			people: snapshot.committedAdults.known,
			attendance: snapshot.vision.lastAttendance[0],
			revision: snapshot.sourceRevision,
			asOf: snapshot.asOf,
			committed: criteriaOf(catalog, 3, snapshot).find((x) => x.key === "committed_adults")?.status,
		};
	};
	const first = await capture();
	assert.deepEqual([first.people, first.attendance], [peopleBefore, attendanceBefore]);
	assert.equal(Date.parse(first.asOf), Date.parse(String(k.expected.result.as_of)));
	const seen: (SQLWrapper | string)[] = [];
	const spy: Pick<Database, "execute"> = {
		execute: <T extends Record<string, unknown>>(q: SQLWrapper | string) => {
			seen.push(q);
			return f.db.execute<T>(q);
		},
	};
	await captureFacts(spy, o.w.id, asOf);
	assert.equal(seen.length, 1, "the whole snapshot is one statement");

	const late = await person(o, "Late Writer");
	let written!: () => void;
	let release!: () => void;
	const wrote = new Promise<void>((r) => (written = r));
	const gate = new Promise<void>((r) => (release = r));
	const writer = f.admin.transaction(async (t) => {
		const card = randomUUID(),
			seen = randomUUID();
		await t.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${card},'commitment',${o.w.id}),
			(${seen},'participation',${o.w.id})`);
		await t.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
			VALUES(${card},${o.w.id},${late.id},'core_group','2026-10-01',clock_timestamp())`);
		await t.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,presence)
			VALUES(${seen},${o.w.id},${vision},${late.id},true,'attended')`);
		written();
		await gate;
	});
	await wrote;
	const mid = await capture();
	assert.deepEqual(mid, first, "an uncommitted writer is invisible to the capture");
	const racing = [capture(), capture(), capture()];
	release();
	await writer;
	racing.push(capture());
	const after = await capture();
	assert.deepEqual([after.people, after.attendance], [during.people_after, during.attendance_after]);
	assert.notEqual(after.revision, first.revision, "the writer's commit is a new source revision");
	const legal = k.expected.result.legal_snapshots as { people: number; attendance: number }[];
	assert.deepEqual(
		legal.map((s) => [s.people, s.attendance]),
		[
			[first.people, first.attendance],
			[after.people, after.attendance],
		],
	);
	assert.equal(k.expected.result.mixed_snapshots_allowed, false);
	for (const r of await Promise.all(racing)) {
		assert.ok(
			[first, after].some((s) => JSON.stringify(s) === JSON.stringify(r)),
			`a mixed snapshot: ${JSON.stringify(r)}`,
		);
		assert.equal(Date.parse(r.asOf), Date.parse(asOf));
	}
	assert.deepEqual(await capture(), after, "the same state at the same as-of reads the same snapshot");
	const read = await readAt(o, asOf);
	assert.deepEqual(
		[read.asOf, read.committedAdults.known, read.vision.lastAttendance[0], read.sourceRevision],
		[after.asOf, after.people, after.attendance, after.revision],
	);
});

test("AC:PI-CASE-003 Vision cadence reads 21 days as watch and 28 as direct, weekly rhythm warns of nothing, a scheduled meeting is not held", async () => {
	const k = piCase("PI-CASE-003");
	const now = k.clock.now;
	const today = now.slice(0, 10);
	const gaps = valueOf<number[]>(k, "computed_gaps_days");
	const read = [];
	for (const gap of gaps) {
		const o = await plant();
		const p = await committed(o, `Cadence ${gap}`, "2026-08-01");
		await heldOn(o, shiftDays(today, -gap), [p.id]);
		read.push((await readAt(o, now)).vision);
	}
	assert.deepEqual(
		read.map((v) => v.daysSince),
		k.expected.result.gaps_days,
	);
	assert.deepEqual(
		read.map((v) => v.status === "watch" || v.status === "direct"),
		k.expected.result.watch_allowed,
	);
	assert.deepEqual(
		read.map((v) => v.status === "direct"),
		k.expected.result.direct_allowed,
	);
	const o = await plant();
	const p = await committed(o, "Weekly Regular", "2026-08-01");
	for (const on of valueOf<string[]>(k, "predictable_weekly_completed_dates")) await heldOn(o, on, [p.id]);
	const future = valueOf<string>(k, "scheduled_only_future");
	await heldOn(o, future, [], { status: "ready" });
	const weekly = (await readAt(o, now)).vision;
	assert.deepEqual(
		[weekly.status, weekly.lastHeldOn, weekly.daysSince, weekly.nextScheduledOn, weekly.lastAttendance],
		["on_target", today, 0, future, [1, 1]],
	);
	assert.equal(k.expected.result.weekly_overmeeting_warning, false);
	assert.doesNotMatch(JSON.stringify(weekly), /over_target|warn|too often/i);
	const scheduledOnly = await plant();
	const q = await committed(scheduledOnly, "Scheduled Only", "2026-08-01");
	await heldOn(scheduledOnly, "2026-09-01", [q.id], { type: "orientation" });
	await heldOn(scheduledOnly, future, [q.id], { status: "ready" });
	const none = (await readAt(scheduledOnly, now)).vision;
	assert.deepEqual(
		[none.status, none.reason, none.lastHeldOn, none.nextScheduledOn],
		["unknown", "no_vision_meeting", null, future],
	);
});

test("AC:PI-CASE-004 the last two completed Vision meetings count distinct attendees; other types and future plans do not count", async () => {
	const k = piCase("PI-CASE-004");
	const now = k.clock.now;
	const o = await plant();
	const named = new Map<string, string>();
	for (const label of ["P", "Q", "R"]) named.set(label, (await committed(o, `Attendee ${label}`, "2026-08-01")).id);
	const meetings = valueOf<{ actual: string; attended: string[] }[]>(k, "completed_vision_meetings");
	for (const m of meetings) {
		const id = await heldOn(o, m.actual, []);
		const repeated: string[] = [];
		for (const label of m.attended) {
			if (repeated.includes(label)) {
				await assert.rejects(attend(o, id, named.get(label)!), (e: Error) =>
					/participation_uq_1/.test(String((e.cause as Error | undefined)?.message)),
				);
				continue;
			}
			repeated.push(label);
			await attend(o, id, named.get(label)!);
		}
	}
	const others: string[] = [];
	const planned = valueOf<number>(k, "future_vision_attendance_plan");
	for (let i = 0; i < planned; i++) others.push((await person(o, `Guest ${i + 1}`)).id);
	await heldOn(o, "2026-10-12", others.slice(0, valueOf<number>(k, "other_type_attendance")), { type: "orientation" });
	const plan = await heldOn(o, "2026-10-20", [], { status: "ready" });
	for (const id of others) await attend(o, plan, id);
	const v = (await readAt(o, now)).vision;
	const [current, previous] = v.lastAttendance;
	const r = k.expected.result;
	assert.deepEqual(
		{ previous_attendance: previous, current_attendance: current, change: current! - previous! },
		{ previous_attendance: r.previous_attendance, current_attendance: r.current_attendance, change: r.change },
	);
	assert.equal(r.future_headcount_included, false);
	assert.deepEqual([v.lastHeldOn, v.nextScheduledOn], [meetings[1]!.actual, "2026-10-20"]);
});

test("AC:PI-CASE-007 Launch facts count down in the church's zone; first service, guest data and debrief stay Unknown before Launch Sunday", async () => {
	const k = piCase("PI-CASE-007");
	const now = k.clock.now;
	const o = await zoned(valueOf<string>(k, "plant_zone"), valueOf<number>(k, "phase"));
	const writer = createLaunchWriter({ notices: async () => {}, clock: { now: () => instant.parse(now) } });
	const planned = valueOf<string>(k, "planned_day");
	ok(
		await writer.schedule(f.db, o.actor, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { date: planned, reason: null },
		}),
	);
	const seeded = await one<{ milestones: number; tasks: number }>(sql`SELECT
		(SELECT count(*)::int FROM launch_milestone WHERE plant_id=${o.w.id}) milestones,
		(SELECT count(*)::int FROM task WHERE plant_id=${o.w.id} AND launch_task_key IS NOT NULL) tasks`);
	assert.deepEqual(seeded, {
		milestones: valueOf<number>(k, "current_milestones"),
		tasks: valueOf<number>(k, "seed_tasks"),
	});
	await f.admin.execute(
		sql`UPDATE launch SET attendance=${valueOf<number>(k, "attendance_headcount")},actual_date=${valueOf<string | null>(k, "actual_day")} WHERE plant_id=${o.w.id}`,
	);
	for (let i = 0; i < valueOf<number>(k, "named_guest_links"); i++) {
		const guest = await person(o, `Launch Guest ${i + 1}`);
		await f.admin.execute(
			sql`INSERT INTO launch_guest(plant_id,person_id,recorded_by) VALUES(${o.w.id},${guest.id},${o.id})`,
		);
	}
	assert.equal(valueOf<string>(k, "debrief"), "draft");
	await f.admin.execute(sql`INSERT INTO launch_debrief(plant_id,version,went_well,saved_at,saved_by)
		VALUES(${o.w.id},1,'Draft notes',${now}::timestamptz,${o.id})`);
	const r = await readAt(o, now);
	const catalog = await readCatalog();
	const after = criteriaOf(catalog, 5, r);
	const status = (key: string) => after.find((x) => x.key === key)?.status;
	const e = k.expected.result;
	assert.deepEqual(
		{
			countdown_days: r.launch.daysToLaunch,
			first_service_complete: status("first_service_complete"),
			guest_data_entered: status("guest_data_entered"),
			debrief_done: status("debrief_done"),
			phase: (await one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${o.w.id}`)).phase,
		},
		e,
	);
	assert.deepEqual(
		[r.launch.targetOn, r.today, r.firstService],
		[planned, "2026-10-13", { path: "launch_sunday", status: "unknown", heldOn: null }],
	);
});

test("AC:PI-CASE-029 acquisitions fall in 28-day windows by the church's local date; the recording date never moves them", async () => {
	const k = piCase("PI-CASE-029");
	const now = k.clock.now;
	const o = await zoned(valueOf<string>(k, "plant_zone"));
	const dates = valueOf<string[]>(k, "acquisition_dates");
	const recorded = `${valueOf<string>(k, "as_of_local_date")}T15:00:00Z`;
	assert.equal(valueOf<string>(k, "recording_dates"), `all ${valueOf<string>(k, "as_of_local_date")}`);
	const people: Committed[] = [];
	for (const on of dates) {
		const p = await committed(o, `Acquired ${on}`, on);
		await f.admin.execute(sql`UPDATE commitment SET recorded_at=${recorded}::timestamptz WHERE id=${p.cardId}`);
		people.push(p);
	}
	assert.equal(valueOf<boolean>(k, "one_genuine_recent_adult_withdrawn"), true);
	await withdraw(o, people[0]!.id, "2026-10-12");
	const r = await readAt(o, now);
	const g = r.growth;
	assert.equal(r.today, valueOf<string>(k, "as_of_local_date"));
	const inWindow = (on: string) => on >= g.priorStart && on <= r.today;
	const e = k.expected.result;
	assert.deepEqual(
		{
			current_window_count: g.current,
			prior_window_count: g.prior,
			outside_dates: dates.filter((on) => !inWindow(on)),
			recording_date_replaces_occurrence: g.current === dates.length,
		},
		e,
	);
	assert.deepEqual([g.windowStart, g.priorStart, g.currentWithdrawn], ["2026-09-16", "2026-08-19", 1]);
	assert.equal(r.committedAdults.known, dates.length - 1);
});

test("AC:PI-GROW-001 a withdrawal lowers committed adults but keeps the latest genuine acquisition's clock", async () => {
	const k = piCase("PI-GROW-001");
	const now = k.clock.now;
	const o = await plant();
	const newest = valueOf<string>(k, "genuine_first_acquisition");
	const before = valueOf<number>(k, "known_active_before");
	for (let i = 0; i < before - 1; i++) await committed(o, `Grow ${i + 1}`, "2026-09-01");
	const recent = await committed(o, "Grow Newest", newest);
	assert.equal((await readAt(o, now)).committedAdults.known, before);
	await withdraw(o, recent.id, valueOf<string>(k, "withdrawal"));
	const r = await readAt(o, now);
	assert.equal(r.today, valueOf<string>(k, "as_of"));
	assert.deepEqual(
		{
			committed_adults: r.committedAdults.known,
			latest_genuine_acquisition: r.growth.lastAcquiredOn,
			elapsed_days: r.growth.daysSince,
			trajectory: r.criteria.growth_trajectory,
			slowed: r.growth.status === "slowed",
			stalled: r.growth.status === "stalled",
		},
		k.expected.result,
	);
	assert.equal(r.growth.status, "on_track");
});

test("AC:PI-GROW-002 a corrected erroneous acquisition gives way to the prior valid one and its history stays", async () => {
	const k = piCase("PI-GROW-002");
	const now = k.clock.now;
	const o = await plant();
	await committed(o, "Grow Valid", valueOf<string>(k, "prior_valid_acquisition"));
	const wrong = await committed(o, "Grow Erroneous", valueOf<string>(k, "erroneous_first_acquisition"));
	const before = await readAt(o, now);
	assert.equal(before.growth.lastAcquiredOn, valueOf<string>(k, "erroneous_first_acquisition"));
	assert.equal(valueOf<boolean>(k, "correction_invalidates"), true);
	ok(
		await tx((t) =>
			commitments.correctCommitmentLifecycle(t, o.ctx, {
				requestKey: randomUUID(),
				expectedRevision: wrong.cardRevision,
				input: { commitmentId: wrong.cardId, correction: { action: "void" }, reason: "Recorded in error" },
			}),
		),
	);
	const r = await readAt(o, now);
	const history = ok(await tx((t) => recordCorrections.listRecordCorrections(t, o.ctx, { personId: wrong.id })));
	const audit = await one<{ n: number }>(sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${o.w.id}
		AND action='people.corrected' AND metadata->>'event'='commitment_corrected' AND subject_id=${wrong.id}`);
	const kept = await one<{ signed_on: string; voided: boolean }>(
		sql`SELECT signed_on::text,voided_at IS NOT NULL AS voided FROM commitment WHERE id=${wrong.cardId}`,
	);
	assert.deepEqual(
		{
			latest_valid_acquisition: r.growth.lastAcquiredOn,
			elapsed_days: r.growth.daysSince,
			correction_history_retained:
				audit.n === 1 &&
				kept.voided &&
				kept.signed_on === valueOf<string>(k, "erroneous_first_acquisition") &&
				history.items.some(
					(x) =>
						x.recordId === wrong.cardId &&
						JSON.stringify(x.changes) === JSON.stringify([{ field: "voided", old: false, new: true }]),
				),
		},
		k.expected.result,
	);
	assert.notEqual(r.sourceRevision, before.sourceRevision);
	assert.equal(r.committedAdults.known, 1);
});

test("AC:PI-GROW-003 a reactivation is not a new acquisition; a same-day join and withdrawal net zero and the clock reads one day", async () => {
	const k = piCase("PI-GROW-003");
	const now = k.clock.now;
	const o = await plant();
	const returning = await committed(o, "Grow Returning", valueOf<string>(k, "first_valid_commitment"));
	await withdraw(o, returning.id, valueOf<string>(k, "withdrawal"));
	const leaving = await committed(o, "Grow Leaving", valueOf<string>(k, "first_valid_commitment"));
	const behavior = k.given["behavior-inputs"] as {
		new_adult_on: string;
		withdrawn_adult_on: string;
		net_delta: number;
	};
	const before = (await readAt(o, now)).committedAdults.known;
	ok(
		await tx(async (t) =>
			commitments.reactivateCommitment(t, o.ctx, {
				requestKey: randomUUID(),
				expectedRevision: await revisionOfPerson(returning.id),
				input: { personId: returning.id, effectiveOn: valueOf<string>(k, "reactivation") },
			}),
		),
	);
	const reactivated = await readAt(o, now);
	assert.equal(reactivated.growth.lastAcquiredOn, valueOf<string>(k, "first_valid_commitment"));
	assert.equal(reactivated.committedAdults.known, before + 1);
	await committed(o, "Grow Joining", behavior.new_adult_on);
	await withdraw(o, leaving.id, behavior.withdrawn_adult_on);
	const r = await readAt(o, now);
	assert.equal(r.committedAdults.known - reactivated.committedAdults.known, behavior.net_delta);
	assert.deepEqual(
		{ days_since_acquisition: r.growth.daysSince, stalled: r.growth.status === "stalled" },
		k.expected.result,
	);
	assert.deepEqual(
		[r.growth.lastAcquiredOn, r.growth.current, r.growth.status],
		[behavior.new_adult_on, 1, "on_track"],
	);
});
