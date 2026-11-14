import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	createFacts,
	createPrivateCare,
	createSignals,
	factInputs,
} from "../../../packages/domain/src/intelligence/index.ts";
import { commitments, peopleWriter, recordCorrections } from "../../../packages/domain/src/people/index.ts";
import { ok, refusedWith } from "../../support/fixture.mts";

// WP-040 measured facts through intelligence.readFacts, the read Plant Intelligence calls, on a scratch schema of the
// development or CI database. People and commitment cards go through the People operations; meetings, follow-ups,
// ministry roles, training, interviews and 4 C's are seeded as rows, since the read only reads them.

let f, facts, signals, care;
const ZONE = "America/Chicago";
const refusedBare = refusedWith({ details: {} });
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
let today;
const day = (n) => new Date(Date.parse(today + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

before(async () => {
	f = await fixture();
	facts = createFacts();
	signals = createSignals();
	care = createPrivateCare();
	today = (await one(sql`SELECT (clock_timestamp() AT TIME ZONE ${ZONE})::date::text AS d`)).d;
});
after(() => f?.close());

/** A plant in Chicago with its Owner, whose session the People writes use. */
async function plant() {
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone=${ZONE} WHERE id=${w.id}`);
	const a = await f.account();
	await f.seat(a, w, "owner");
	await f.admin.execute(sql`UPDATE account SET personal_timezone=${ZONE} WHERE id=${a.id}`);
	return {
		...a,
		w,
		actor: await f.actor(a.session),
		ctx: { session: a.session, selected: { kind: "plant", id: w.id } },
	};
}
const tx = (body) => f.db.transaction(body);
async function person(o, displayName, input = { adultClassification: "adult" }) {
	return ok(
		await tx((t) =>
			peopleWriter.createPerson(t, o.ctx, { requestKey: randomUUID(), input: { displayName, ...input } }),
		),
	).person;
}
const card = async (o, personId, occurredOn, kind = "core_group") =>
	ok(
		await tx((t) =>
			commitments.createCommitment(t, o.ctx, { requestKey: randomUUID(), input: { personId, kind, occurredOn } }),
		),
	);
async function committed(o, name, on = day(-60), input) {
	const p = await person(o, name, input);
	const saved = await card(o, p.id, on);
	return { ...p, cardId: saved.commitment.id, cardRevision: saved.commitment.revision };
}
const read = async (o, db = f.db) => ok(await facts.readFacts(db, o.actor, {}));
const record = (id, kind, plantId) =>
	f.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${plantId}) ON CONFLICT DO NOTHING`);

let visionNumber = 0;
/** A meeting, completed when `held` names how many days ago it happened, else scheduled `inDays` ahead. */
async function meeting(o, { held, inDays, type = "vision_meeting", attended = [] }) {
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
async function attend(o, meetingId, personId, presence = "attended") {
	const id = randomUUID();
	await record(id, "participation", o.w.id);
	await f.admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,presence)
		VALUES(${id},${o.w.id},${meetingId},${personId},true,${presence})`);
	return id;
}
/** A first-Vision follow-up of `meetingId` for `personId` and its task, originating `ageHours` ago. */
async function followUp(o, meetingId, personId, ageHours, task = {}) {
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
async function outcome(o, obligation, personId, kind, afterHours, completes = true) {
	const id = randomUUID();
	await record(id, "contact_outcome", o.w.id);
	const at = new Date(Date.parse(obligation.origin) + afterHours * 3_600_000).toISOString();
	await f.admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,task_id,obligation_id,outcome,occurred_at,
		recorded_at,completes_task) VALUES(${id},${o.w.id},${personId},${obligation.taskId},${obligation.id},${kind},
		${at}::timestamptz,${at}::timestamptz,${completes})`);
	return id;
}
/** A ministry team with one role per responsibility key, each held by the named person (or open with null). */
async function roles(o, holders) {
	const team = randomUUID();
	await record(team, "team", o.w.id);
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${o.w.id},'Launch team','active',1)`,
	);
	const out = {};
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
			out[key] = { role, tenure };
		}
	}
	return { team, ...out };
}
/** A required program with these people assigned; the first `complete` of them earned it at its version. */
async function program(o, people, complete) {
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
async function interview(o, personId, on) {
	const id = randomUUID();
	await record(id, "interview", o.w.id);
	await f.admin
		.execute(sql`INSERT INTO interview(id,plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,
		right_reasons,season,maturity_notes,result) VALUES(${id},${o.w.id},${personId},${on},clock_timestamp(),'concern','pass',
		'pass','pass','fail',${CANARY + "-interview"},'not_qualified')`);
}
async function fourCs(o, personId, on) {
	const id = randomUUID();
	await record(id, "four_cs", o.w.id);
	await f.admin
		.execute(sql`INSERT INTO four_cs(id,plant_id,person_id,assessed_on,recorded_at,committed,compelled,contagious,
		courageous,committed_notes) VALUES(${id},${o.w.id},${personId},${on},clock_timestamp(),2,3,1,4,${CANARY + "-4cs"})`);
}
/** A private weekly check-in of the Owner: Struggling everywhere, with a note. */
async function checkIn(o) {
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
const stable = ({ asOf: _asOf, ...rest }) => rest;

test("AC:CA001 AC:CA003 30 committed adults on two teams count once each, children do not count, and the list names each", async () => {
	const o = await plant();
	const adults = [];
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
	const both = a.evidence.find((e) => e.person.id === adults[0].id);
	assert.deepEqual([both.kinds, both.committedSince], [["core_group", "launch_team"], day(-60)]);
	assert.equal(r.criteria.committed_adults, "met");
	assert.equal(r.formulaVersion, "plant-facts/1");
});

test("AC:CA004 29 known adults and one unclassified person read Unknown with at least 29 and name that person", async () => {
	const o = await plant();
	for (let i = 0; i < 29; i++) await committed(o, `Adult ${i + 1}`);
	const sam = await committed(o, "Sam Unclassified", day(-60), {});
	const a = (await read(o)).committedAdults;
	assert.deepEqual([a.status, a.known, a.exact], ["unknown", 29, null]);
	assert.deepEqual(a.needsClassifying, [{ id: sam.id, name: "Sam Unclassified" }]);
	// Classifying them settles the count.
	await f.admin.execute(sql`UPDATE person SET adult_classification='adult' WHERE id=${sam.id}`);
	assert.deepEqual([(await read(o)).committedAdults.exact, (await read(o)).committedAdults.status], [30, "met"]);
});

test("AC:CA008 AC:CA019 a withdrawal lowers the count but keeps the growth clock; a corrected date moves it, with history and audit", async () => {
	const o = await plant();
	await committed(o, "Avery Early", day(-50));
	const blake = await committed(o, "Blake Recent", day(-22));
	let r = await read(o);
	assert.deepEqual([r.growth.status, r.growth.daysSince, r.committedAdults.known], ["slowed", 22, 2]);
	const personRevision = (await one(sql`SELECT revision::text AS r FROM person WHERE id=${blake.id}`)).r;
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
	// The correction is in the person's correction history and its audit row.
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
	// A newer completed Vision meeting with nobody attended is not a held meeting with attendance.
	await meeting(o, { held: 2 });

	const [g1, g2, g3, g4] = [
		await followUp(o, held, people[0].id, 72, { status: "complete", after: 72 - 10 }),
		await followUp(o, held, people[1].id, 72, { status: "complete", after: 72 - 40 }),
		await followUp(o, held, people[2].id, 72, { status: "no_longer_needed" }),
		await followUp(o, held, people[3].id, 72),
	];
	await outcome(o, g1, people[0].id, "contacted", 10);
	await outcome(o, g2, people[1].id, "administrative_completion", 40);
	void g3;
	void g4;

	const [a, b, c, d, e] = people;
	await roles(o, [
		["worship", a.id],
		["children", b.id],
		["assimilation", c.id],
		["small_groups", d.id],
		["administration_finance", null],
		["facilities", a.id],
		["promotion", b.id],
		["technology", null],
		["prayer", e.id],
	]);
	await program(o, people, 9);
	// Answered 35 days ago through the signals operation, with its stated as-of date.
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
		[6, 4, [{ id: e.id, name: e.displayName }]],
	);
	assert.deepEqual([r.training.complete, r.training.total, r.training.status], [9, 10, "not_met"]);
	const prayer = r.attestations.find((x) => x.key === "prayer_rhythm_established");
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
	// Private care is no input: the check-in changes neither the facts nor their revision.
	assert.deepEqual(stable(r), stable(before));
	// The one statement names no private-care table and no interview or 4 C's content column.
	const seen = [];
	const spy = { execute: (q) => (seen.push(q), f.db.execute(q)) };
	await read(o, spy);
	assert.equal(seen.length, 1);
	const statement = f.db.dialect.sqlToQuery(seen[0]).sql;
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

	// One committed change to each input the statement reads, conditional ones included: a manual classification only
	// matters without a birth date, and the plant's zone moves every local date.
	const changes = {
		"plant.timezone": sql`UPDATE plant SET timezone='America/Denver' WHERE id=${o.w.id}`,
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
		"team_tenure.ended_on": sql`UPDATE team_tenure SET ended_on=${today} WHERE id=${team.worship.tenure}`,
		"team_role.retired_at": sql`UPDATE team_role SET retired_at=clock_timestamp() WHERE id=${team.children.role}`,
		training_credit: sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
			VALUES(${o.w.id},${p.id},${prog},'earned',1,${day(-1)})`,
		"training_program.version": sql`UPDATE training_program SET version=2 WHERE id=${prog}`,
		"training_assignment.state": sql`UPDATE training_assignment SET state='removed',ended_on=${today} WHERE program_id=${prog}`,
		"training_program.required": sql`UPDATE training_program SET required=false WHERE id=${prog}`,
		interview: sql`DELETE FROM interview WHERE person_id=${p.id}`,
		four_cs: sql`DELETE FROM four_cs WHERE person_id=${p.id}`,
	};
	let last = (await read(o)).sourceRevision;
	for (const [input, change] of Object.entries(changes)) {
		await f.admin.execute(change);
		const now = (await read(o)).sourceRevision;
		assert.notEqual(now, last, `${input} did not change the facts' revision`);
		last = now;
	}
	// An attestation through its own operation is an input too.
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
	// Private care and unrelated columns are not inputs.
	await checkIn(o);
	await f.admin.execute(sql`UPDATE person SET email='rowan@example.test',notes='unrelated' WHERE id=${p.id}`);
	const quiet = await read(o);
	assert.equal(quiet.sourceRevision, answered.sourceRevision);
	assert.deepEqual(stable(quiet), stable(answered));
	// Every top-level input the builder parses has at least one change above, or is a computed presence of one.
	assert.deepEqual(Object.keys(factInputs.shape).sort(), [
		"anyAttendance",
		"attendance",
		"attestations",
		"followUps",
		"fourCs",
		"interviews",
		"nextVision",
		"people",
		"roles",
		"training",
		"vision",
		"zone",
	]);
});
