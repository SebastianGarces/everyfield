import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleUnmerge, peopleWriter } from "../../../../packages/domain/src/people/index.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "../../../../packages/domain/src/teams/index.ts";
import { meetingsReader, meetingsWriter } from "../../../../packages/domain/src/meetings/index.ts";
import { fixture, ok, refused } from "../../../support/fixture.mts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const database = await fixture({ prefix: "wp019", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
let memberPerson;
const P = database.tenant.id;
const Q = (await database.plant({ timezone: "America/New_York" })).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	database.actors.admin,
	await database.actor({ kind: "plant", id: Q }, "admin"),
];
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
const tx = (body) => db.transaction(body);
const run = (op, input, who = 0) => tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => RequestActor.resolve(db, actors[who].session);
const count = async (query) => Number((await admin.execute(query)).rows[0].n);
const rev = async (table, id) =>
	(await admin.execute(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0].r;
const plantRevision = () =>
	admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${P}`).then((r) => r.rows[0].r);

async function person(name, fields = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${fields.plant ?? P},${fields.plant ?? P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,'live',clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function makeTeam(name, who = 0) {
	return ok(await run(teamsWriter.create, { requestKey: key(), input: { name } }, who)).team;
}
async function makeRole(teamId, name, fields = {}) {
	return ok(await run(teamsWriter.createRole, { requestKey: key(), input: { teamId, name, ...fields } })).role;
}
async function assign(role, teamId, personId) {
	return ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, teamId, personId },
		}),
	);
}
async function program(name, fields = {}) {
	return ok(
		await run(
			trainingWriter.createProgram,
			{
				requestKey: key(),
				input: { name, required: fields.required ?? true, teamId: fields.teamId ?? null },
			},
			fields.who ?? 0,
		),
	).program;
}
async function preview(programId, personIds, who = 0) {
	return ok(await trainingReader.readRequiredTrainingPreview(db, await viewer(who), { programId, personIds }));
}
async function saveRoster(programId, personIds, who = 0, requestKey = key()) {
	const seen = await preview(programId, personIds, who);
	return ok(
		await run(
			trainingWriter.setRequiredTrainingParticipants,
			{
				requestKey,
				expectedRevision: seen.revision,
				input: { programId, personIds, rosterDigest: seen.rosterDigest },
			},
			who,
		),
	);
}
const idsOf = (names, book) => names.map((name) => book[name]);
/** A team meeting through the one meetings writer (T-201); its guest list is the ministry's people serving now. */
const teamMeeting = (teamId, fields = {}, who = 0) =>
	run(
		meetingsWriter.schedule,
		{ requestKey: key(), input: { type: "team_meeting", teamId, date: "2026-10-24", time: "09:00", ...fields } },
		who,
	);
/** A held meeting: these people attended and it is completed. The attendance writer has its own tests. */
async function held(meetingId, personIds) {
	await admin.execute(sql`UPDATE participation SET presence='attended'
		WHERE meeting_id=${meetingId} AND person_id = ANY(${sql.param(personIds)}::uuid[])`);
	await admin.execute(sql`UPDATE meeting SET status='completed' WHERE id=${meetingId}`);
}

before(async () => {
	memberPerson = await person("Member leader", { account: actors[1].id });
});
after(async () => {
	await database.close();
});

test("AC:SCHEMA-004 AC:SME53-001 AC:SME53-003 AC:TARGET-TEAM-008 AC:TARGET-TEAM-016 a saved roster stays exact", async () => {
	const worship = await makeTeam("Worship");
	const hospitality = await makeTeam("Hospitality");
	const alex = await person("Alex Roster");
	const casey = await person("Casey Roster");
	const jordan = await person("Jordan Roster");
	const mara = await person("Mara Roster");
	const book = { Alex: alex, Casey: casey, Jordan: jordan, Mara: mara };
	await assign(await makeRole(worship.id, "Vocals"), worship.id, alex);
	await assign(await makeRole(worship.id, "Guitar"), worship.id, alex);
	await assign(await makeRole(hospitality.id, "Door"), hospitality.id, alex);
	const required = await program("Required welcome", { teamId: worship.id, required: true });
	const saved = await saveRoster(required.id, idsOf(["Alex", "Casey", "Jordan"], book));
	assert.deepEqual(saved.personIds, idsOf(["Alex", "Casey", "Jordan"], book));
	await assign(await makeRole(worship.id, "Later"), worship.id, mara);
	const matrix = ok(await trainingReader.readTrainingMatrix(db, await viewer(), {}));
	const row = matrix.programs.find((item) => item.id === required.id);
	assert.deepEqual(row.personIds, [alex, casey, jordan].sort());
	assert.equal(row.personIds.includes(mara), false);
	const again = await preview(required.id, [alex, alex, casey]);
	assert.deepEqual(again.personIds, [alex, casey]);
	const replaced = await saveRoster(required.id, [alex, casey]);
	assert.deepEqual(replaced.personIds, [alex, casey]);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM training_assignment WHERE program_id=${required.id} AND person_id=${alex} AND state='active'`,
		),
		1,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM training_assignment WHERE program_id=${required.id} AND state='active'`,
		),
		2,
	);
	const stale = await preview(required.id, [alex, casey]);
	await admin.execute(sql`UPDATE person SET revision = revision + 1 WHERE id=${alex}`);
	const before = await count(sql`SELECT count(*)::int AS n FROM training_assignment WHERE program_id=${required.id}`);
	refused(
		await run(trainingWriter.setRequiredTrainingParticipants, {
			requestKey: key(),
			expectedRevision: stale.revision,
			input: { programId: required.id, personIds: [alex, casey], rosterDigest: stale.rosterDigest },
		}),
		"conflict",
	);
	const foreign = await person("Quinn Foreign", { plant: Q });
	refused(
		await trainingReader.readRequiredTrainingPreview(db, await viewer(), {
			programId: required.id,
			personIds: [alex, foreign],
		}),
		"access_denied",
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM training_assignment WHERE program_id=${required.id}`),
		before,
	);
	const credits = await count(sql`SELECT count(*)::int AS n FROM training_credit`);
	await saveRoster(required.id, [alex]);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", required.id),
			input: { kind: "program", personId: alex, programId: required.id, earnedOn: "2026-10-02" },
		}),
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM training_assignment WHERE person_id=${alex} AND program_id=${required.id} AND state='active'`,
		),
		1,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_credit`), credits + 1);
	const optional = await program("Optional tour", { teamId: worship.id, required: false });
	const creditBefore = await count(sql`SELECT count(*)::int AS n FROM training_credit WHERE program_id=${optional.id}`);
	await saveRoster(optional.id, [casey]);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM training_credit WHERE program_id=${optional.id}`),
		creditBefore,
	);
	const listed = ok(await trainingReader.listTraining(db, await viewer(), {}));
	const shown = listed.programs.find((item) => item.id === required.id);
	assert.equal(shown.requiredPeople, 1);
	assert.equal(shown.compatibleCredits, 1);
	refused(
		await run(
			trainingWriter.createProgram,
			{ requestKey: key(), input: { name: "Churchwide", required: true, teamId: null } },
			1,
		),
		"access_denied",
	);
	const leader = memberPerson;
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", hospitality.id),
			input: { teamId: hospitality.id, personId: leader },
		}),
	);
	refused(
		await run(
			trainingWriter.createProgram,
			{ requestKey: key(), input: { name: "Broad", required: false, teamId: null } },
			1,
		),
		"access_denied",
	);
	refused(
		await run(
			trainingWriter.createProgram,
			{ requestKey: key(), input: { name: "Other team", required: false, teamId: worship.id } },
			1,
		),
		"access_denied",
	);
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", worship.id),
			input: { teamId: worship.id },
		}),
	);
	assert.equal(
		(await admin.execute(sql`SELECT team_id FROM training_program WHERE id=${required.id}`)).rows[0].team_id,
		worship.id,
	);
	const empty = await makeTeam("Empty applicability");
	const health = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: empty.id }));
	assert.equal(health.trainingRate, null);
});

test("AC:TARGET-TEAM-009 completion revoke and redo keep the original credit", async () => {
	const team = await makeTeam("Redo team");
	const alex = await person("Alex Redo");
	const item = await program("Redo course", { teamId: team.id });
	await saveRoster(item.id, [alex]);
	const firstName = item.name;
	ok(
		await run(trainingWriter.correctProgram, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { programId: item.id, name: "Redo course revised", required: true, reason: "Name was incomplete" },
		}),
	);
	refused(
		await run(trainingWriter.correctProgram, {
			requestKey: key(),
			expectedRevision: "1",
			input: { programId: item.id, name: "Stale name", required: false, reason: "Too old" },
		}),
		"conflict",
	);
	assert.equal(
		(await admin.execute(sql`SELECT name, team_id FROM training_program WHERE id=${item.id}`)).rows[0].name,
		"Redo course revised",
	);
	assert.equal(
		(await admin.execute(sql`SELECT team_id FROM training_program WHERE id=${item.id}`)).rows[0].team_id,
		team.id,
	);
	refused(
		await run(trainingWriter.correctProgram, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { programId: item.id, name: firstName, required: true, reason: "Move team", teamId: team.id },
		}),
		"invalid_input",
	);
	const earned = ok(
		await run(
			trainingWriter.attestCompletion,
			{
				requestKey: key(),
				expectedRevision: await rev("training_program", item.id),
				input: { kind: "program", personId: alex, programId: item.id, earnedOn: "2026-10-01" },
			},
			2,
		),
	);
	assert.equal(earned.verifierAccountId, actors[2].id);
	ok(
		await run(trainingWriter.revokeCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { personId: alex, programId: item.id },
		}),
	);
	const historyBefore = await count(
		sql`SELECT count(*)::int AS n FROM training_credit WHERE person_id=${alex} AND program_id=${item.id}`,
	);
	const repeat = ok(
		await run(trainingWriter.revokeCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { personId: alex, programId: item.id },
		}),
	);
	assert.equal(repeat.outcome, "noop");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM training_credit WHERE person_id=${alex} AND program_id=${item.id}`),
		historyBefore,
	);
	ok(
		await run(trainingWriter.recompleteTraining, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { personId: alex, programId: item.id, earnedOn: "2026-10-13" },
		}),
	);
	const history = ok(await trainingReader.readTrainingHistory(db, await viewer(), { personId: alex }));
	const kinds = history.credits.filter((row) => row.programId === item.id).map((row) => row.kind);
	assert.deepEqual(kinds, ["earned", "revoked", "earned"]);
	assert.equal(history.credits.find((row) => row.programId === item.id).verifierAccountId, actors[2].id);
	assert.equal(history.credits.find((row) => row.programId === item.id).earnedOn, "2026-10-01");
	const latest = history.credits.filter((row) => row.programId === item.id).at(-1);
	assert.equal(latest.kind, "earned");
	refused(
		await run(
			trainingWriter.revokeCompletion,
			{
				requestKey: key(),
				expectedRevision: await rev("training_program", item.id),
				input: { personId: alex, programId: item.id },
			},
			3,
		),
		"unavailable",
	);
	refused(await trainingReader.readTrainingHistory(db, await viewer(3), { personId: alex }), "access_denied");
});

test("AC:TARGET-TEAM-017 AC:SME53-009 service evidence does not change a role", async () => {
	const alex = await person("Alex Service");
	const casey = await person("Casey Service");
	const seats = await count(sql`SELECT count(*)::int AS n FROM seat`);
	const roles = await count(sql`SELECT count(*)::int AS n FROM team_role`);
	const stage = (await admin.execute(sql`SELECT stage FROM person WHERE id=${alex}`)).rows[0].stage;
	const jobs = await count(sql`SELECT count(*)::int AS n FROM job`);
	const yes = ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			input: { kind: "service", personId: alex, attendanceDays: 60, volunteerDays: 60 },
		}),
	);
	const no = ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			input: { kind: "service", personId: casey, attendanceDays: 60, volunteerDays: 59 },
		}),
	);
	assert.deepEqual([yes.candidate, no.candidate], [true, false]);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat`), seats);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team_role`), roles);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${alex}`)).rows[0].stage, stage);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM job`), jobs);
	refused(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			input: { kind: "service", personId: alex, attendanceDays: 60, volunteerDays: 60, testimony: "model" },
		}),
		"invalid_input",
	);
	// A service span has no revision to compare, so the program envelope is not accepted for it.
	refused(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: "1",
			input: { kind: "service", personId: alex, attendanceDays: 60, volunteerDays: 60 },
		}),
		"invalid_input",
	);
	const facts = ok(await trainingReader.readPersonTraining(db, await viewer(), { personId: alex }));
	assert.equal(facts.distinctPeople, 1);
});

test("AC:B01-001 AC:GAP-TEAM-013 AC:TARGET-TEAM-013 a team meeting keeps its guest list", async () => {
	const hospitality = await makeTeam("Hospitality");
	const other = await makeTeam("Other team");
	const alex = await person("Alex Guest");
	const casey = await person("Casey Guest");
	const jamie = await person("Jamie Guest");
	const leader = memberPerson;
	const otherMember = await database.actor({ kind: "plant", id: P }, "member");
	actors.push(otherMember);
	const stranger = await person("Other leader", { account: otherMember.id });
	await assign(await makeRole(hospitality.id, "Host"), hospitality.id, alex);
	await assign(await makeRole(hospitality.id, "Host two"), hospitality.id, alex);
	await assign(await makeRole(hospitality.id, "Greeter"), hospitality.id, casey);
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", hospitality.id),
			input: { teamId: hospitality.id, personId: leader },
		}),
	);
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", other.id),
			input: { teamId: other.id, personId: stranger },
		}),
	);
	const credits = await count(sql`SELECT count(*)::int AS n FROM training_credit`);
	// The ministry's own leader schedules its training session; the roster is copied once per person.
	const meeting = ok(await teamMeeting(hospitality.id, { subtype: "training" }, 1)).meeting;
	assert.equal(meeting.subtype, "training");
	assert.equal(meeting.guestCount, 2);
	const guests = await count(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${meeting.id}`);
	assert.equal(guests, 2);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_credit`), credits);
	// A later join does not change the saved guest list.
	await assign(await makeRole(hospitality.id, "Later guest"), hospitality.id, jamie);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${meeting.id}`), 2);
	// Another ministry's leader schedules nothing here.
	refused(await teamMeeting(hospitality.id, { subtype: "training", date: "2026-10-25" }, actors.length - 1));
	const second = ok(await teamMeeting(hospitality.id, { subtype: "training", date: "2026-10-26" }, 1)).meeting;
	assert.equal(second.guestCount, 3);
	const stored = (await admin.execute(sql`SELECT type, subtype, team_id FROM meeting WHERE id=${meeting.id}`)).rows[0];
	assert.deepEqual({ ...stored }, { type: "team_meeting", subtype: "training", team_id: hospitality.id });
	// The global list and the ministry's list project the same meeting ids.
	const listed = ok(await meetingsReader.list(db, await viewer(), { teamId: hospitality.id, window: "all" }));
	assert.deepEqual(listed.items.map((m) => m.id).sort(), [meeting.id, second.id].sort());
	const all = ok(await meetingsReader.list(db, await viewer(), { types: ["team_meeting"], window: "all" }));
	assert.ok(all.items.some((m) => m.id === meeting.id && m.team?.id === hospitality.id));
});

test("AC:B01-003 AC:SME53-002 AC:SME53-004 AC:TARGET-TEAM-011 health keeps its weights", async () => {
	const bare = await makeTeam("Bare health");
	const bareFacts = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: bare.id }));
	assert.equal(bareFacts.composite, null);
	assert.deepEqual(bareFacts.weights, [40, 35, 25]);
	const team = await makeTeam("Staffed health");
	const alex = await person("Alex Health");
	const casey = await person("Casey Health");
	const jamie = await person("Jamie Health");
	await assign(await makeRole(team.id, "One"), team.id, alex);
	await assign(await makeRole(team.id, "Two"), team.id, alex);
	const caseyRole = await makeRole(team.id, "Three");
	await assign(caseyRole, team.id, casey);
	const leader = memberPerson;
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: leader },
		}),
	);
	const meeting = ok(await teamMeeting(team.id, { subtype: "regular", date: "2026-10-20", guests: [jamie] })).meeting;
	await held(meeting.id, [alex, casey, jamie]);
	ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: casey },
		}),
	);
	const phases = await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'phase.%'`);
	const jobs = await count(sql`SELECT count(*)::int AS n FROM job`);
	const facts = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: team.id }));
	assert.equal(facts.filledSlots, 2);
	assert.equal(facts.distinctPeople, 1);
	assert.equal(facts.memberAttendance, 2);
	assert.equal(facts.guestCount, 1);
	assert.equal(facts.rosterDenominator, 2);
	assert.equal(facts.trainingRate, null);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'phase.%'`), phases);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM job`), jobs);
	const course = await program("Coverage", { teamId: team.id });
	await saveRoster(course.id, [alex, casey]);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", course.id),
			input: { kind: "program", personId: alex, programId: course.id, earnedOn: "2026-10-03" },
		}),
	);
	const covered = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: team.id }));
	assert.equal(covered.trainingRate, 0.5);
	assert.deepEqual(covered.weights, [40, 35, 25]);
	const history = ok(await trainingReader.readTrainingHistory(db, await viewer(), { personId: alex }));
	assert.equal(
		history.credits.some((row) => row.kind === "earned" && row.programId === course.id),
		true,
	);
	const quiet = await makeTeam("Measured zero");
	await makeRole(quiet.id, "Open");
	const quietMeeting = ok(await teamMeeting(quiet.id, { subtype: "regular", date: "2026-10-21" })).meeting;
	await held(quietMeeting.id, []);
	const zero = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: quiet.id }));
	assert.equal(zero.staffingRate, 0);
	assert.equal(zero.attendanceRate, 0);
	assert.equal(zero.trainingRate, null);
	assert.equal(zero.composite, null);
});

test("AC:GAP-TEAM-010 AC:TARGET-PPL-021 AC:TARGET-TEAM-010 a person keeps current and former teams", async () => {
	const worship = await makeTeam("Worship");
	const hospitality = await makeTeam("Hospitality");
	const alex = await person("Alex Teams");
	await assign(await makeRole(worship.id, "Lead"), worship.id, alex);
	await assign(await makeRole(hospitality.id, "Welcome"), hospitality.id, alex);
	const both = ok(await trainingReader.readPersonTraining(db, await viewer(), { personId: alex }));
	assert.deepEqual(both.currentTeams, ["Hospitality", "Worship"]);
	assert.equal(both.concurrentAssignments, 2);
	ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", hospitality.id),
			input: { teamId: hospitality.id, personId: alex },
		}),
	);
	const course = await program("Former credit", { teamId: worship.id });
	await saveRoster(course.id, [alex]);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", course.id),
			input: { kind: "program", personId: alex, programId: course.id, earnedOn: "2026-10-04" },
		}),
	);
	ok(
		await run(trainingWriter.revokeCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", course.id),
			input: { personId: alex, programId: course.id },
		}),
	);
	const facts = ok(await trainingReader.readPersonTraining(db, await viewer(), { personId: alex }));
	assert.deepEqual(facts.currentTeams, ["Worship"]);
	assert.deepEqual(facts.formerTeams, ["Hospitality"]);
	assert.equal(facts.currentTrainingComplete, false);
	assert.equal(facts.earnedHistoryRetained, true);
	assert.equal(facts.distinctPeople, 1);
	const assignments = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: alex }));
	assert.equal(JSON.stringify(assignments).includes("background"), false);
	assert.equal(assignments.assignments.length >= 1, true);
});

test("AC:GAP-TEAM-015 AC:TARGET-TEAM-004 AC:TARGET-TEAM-015 stage moves stay with the team write", async () => {
	const team = await makeTeam("Stage team");
	const member = await person("Stage member", { stage: "core_group" });
	const leaderPerson = await person("Stage leader", { stage: "launch_team" });
	const stayed = await person("Stage stayed", { stage: "leader" });
	const role = await makeRole(team.id, "Member");
	const leadRole = await makeRole(team.id, "Lead", { leadership: true });
	const extra = await makeRole(team.id, "Extra");
	const beforeRev = await plantRevision();
	const seatCount = await count(sql`SELECT count(*)::int AS n FROM seat`);
	const request = {
		requestKey: key(),
		expectedRevision: await rev("team_role", role.id),
		input: { roleId: role.id, teamId: team.id, personId: member },
	};
	ok(await run(teamsWriter.assignRole, request));
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0].stage, "launch_team");
	assert.notEqual(await plantRevision(), beforeRev);
	const events = await count(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${member} AND action='people.stage_changed'`,
	);
	assert.equal(events, 1);
	ok(await run(teamsWriter.assignRole, request));
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${member} AND action='people.stage_changed'`,
		),
		1,
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat`), seatCount);
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", leadRole.id),
			input: { roleId: leadRole.id, teamId: team.id, personId: leaderPerson },
		}),
	);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${leaderPerson}`)).rows[0].stage, "leader");
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", extra.id),
			input: { roleId: extra.id, teamId: team.id, personId: stayed },
		}),
	);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${stayed}`)).rows[0].stage, "leader");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${stayed} AND action='people.stage_changed'`,
		),
		0,
	);
	const frozenStage = (await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0].stage;
	const frozenRev = await plantRevision();
	const roleRevision = await rev("team_role", role.id);
	refused(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: String(BigInt(roleRevision) + 1n),
			input: { roleId: role.id, teamId: team.id, personId: member },
		}),
		"conflict",
	);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0].stage, frozenStage);
	assert.equal(await plantRevision(), frozenRev);
	const mail = await count(sql`SELECT count(*)::int AS n FROM job WHERE kind='mail'`);
	assert.equal(mail, 0);
	const unlinked = await person("Unlinked appoint");
	const seats = await count(sql`SELECT count(*)::int AS n FROM seat`);
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: unlinked },
		}),
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat`), seats);
	await admin.execute(
		sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id=${actors[1].id} AND plant_id=${P}`,
	);
	try {
		const linked = memberPerson;
		const led = await makeTeam("Led team");
		ok(
			await run(teamsWriter.appointLeader, {
				requestKey: key(),
				expectedRevision: await rev("team", led.id),
				input: { teamId: led.id, personId: linked },
			}),
		);
		refused(await teamMeeting(led.id, { subtype: "training", date: "2026-10-27", time: "09:30" }, 1));
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id=${actors[1].id} AND plant_id=${P}`);
	}
	for (let n = 1; n <= 101; n += 1) await person("M " + String(n).padStart(3, "0"));
	const page = ok(await teamsReader.listLeaderCandidates(db, await viewer(), {}));
	assert.equal(page.people.length, 50);
	assert.equal(
		page.people.some((item) => item.name === "M 101"),
		false,
	);
	const found = ok(await teamsReader.listLeaderCandidates(db, await viewer(), { q: "M 101" }));
	assert.deepEqual(
		found.people.map((item) => item.name),
		["M 101"],
	);
});

test("AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-MERGE AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-CONFLICT AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-RETIRE AC:PERSONREF-TRAINING-APPLICABILITY-COMPLETION-UNMERGE AC:SCHEMA-009 training references follow the person rules", async () => {
	const assignment = registry.find((item) => item.kind === "training_assignment");
	const credit = registry.find((item) => item.kind === "training_credit");
	assert.equal(assignment.treatment, "move");
	assert.equal(assignment.revision, true);
	assert.equal(credit.treatment, "keep");
	assert.equal(credit.revision, false);
	const make = async (name) =>
		ok(
			await tx((t) =>
				peopleWriter.createPerson(t, ctx(), {
					requestKey: key(),
					input: { displayName: name, adultClassification: "adult" },
				}),
			),
		).person;
	const source = await make("P2 training");
	const survivor = await make("P1 training");
	const item = await program("Merge course", { teamId: null });
	await saveRoster(item.id, [source.id]);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { kind: "program", personId: source.id, programId: item.id, earnedOn: "2026-10-05" },
		}),
	);
	const assignmentId = (
		await admin.execute(sql`SELECT id FROM training_assignment WHERE person_id=${source.id} AND program_id=${item.id}`)
	).rows[0].id;
	const review = ok(
		await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId: source.id, survivorId: survivor.id })),
	);
	await admin.execute(sql`UPDATE training_assignment SET revision = revision + 1 WHERE id=${assignmentId}`);
	refused(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: source.id, survivorId: survivor.id, reviewDigest: review.reviewDigest },
			}),
		),
		"conflict",
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0].person_id,
		source.id,
	);
	const fresh = ok(
		await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId: source.id, survivorId: survivor.id })),
	);
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: source.id, survivorId: survivor.id, reviewDigest: fresh.reviewDigest },
			}),
		),
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0].person_id,
		survivor.id,
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_credit WHERE person_id=${source.id}`)).rows.length,
		1,
	);
	assert.equal(
		merged.moved.some((row) => row.kind === "training_assignment" && row.count >= 1),
		true,
	);
	const jobs = await count(sql`SELECT count(*)::int AS n FROM job WHERE kind='mail'`);
	const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(), { mergeId: merged.mergeId })));
	ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(), {
				requestKey: key(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0].person_id,
		source.id,
	);
	assert.equal((await admin.execute(sql`SELECT state FROM person WHERE id=${source.id}`)).rows[0].state, "live");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM job WHERE kind='mail'`), jobs);
	const left = await make("Shared left");
	const right = await make("Shared right");
	const shared = await program("Shared roster", { teamId: null });
	await saveRoster(shared.id, [left.id, right.id]);
	const leftRow = (
		await admin.execute(
			sql`SELECT id, revision::int AS revision FROM training_assignment WHERE person_id=${left.id} AND program_id=${shared.id} AND state='active'`,
		)
	).rows[0];
	const rightId = (
		await admin.execute(
			sql`SELECT id FROM training_assignment WHERE person_id=${right.id} AND program_id=${shared.id} AND state='active'`,
		)
	).rows[0].id;
	const reviewBoth = ok(
		await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId: left.id, survivorId: right.id })),
	);
	const mergedBoth = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: left.id, survivorId: right.id, reviewDigest: reviewBoth.reviewDigest },
			}),
		),
	);
	const placed = (
		await admin.execute(
			sql`SELECT id, person_id, state, revision::int AS revision, (ended_on IS NOT NULL) AS ended FROM training_assignment WHERE program_id=${shared.id}`,
		)
	).rows;
	const active = placed.filter((row) => row.state === "active");
	assert.equal(active.length, 1);
	assert.equal(active[0].id, rightId);
	assert.equal(active[0].person_id, right.id);
	const ended = placed.find((row) => row.id === leftRow.id);
	assert.equal(ended.person_id, right.id);
	assert.equal(ended.state, "removed");
	assert.equal(ended.ended, true);
	assert.equal(ended.revision, leftRow.revision + 1);
	const previewBoth = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(), { mergeId: mergedBoth.mergeId })));
	ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(), {
				requestKey: key(),
				expectedRevision: previewBoth.reviewRevision,
				input: { mergeId: mergedBoth.mergeId },
			}),
		),
	);
	const restored = (
		await admin.execute(
			sql`SELECT id, person_id, state, revision::int AS revision FROM training_assignment WHERE program_id=${shared.id}`,
		)
	).rows;
	const back = restored.find((row) => row.id === leftRow.id);
	assert.equal(back.person_id, left.id);
	assert.equal(back.state, "removed");
	assert.equal(back.revision, leftRow.revision + 2);
	const keptActive = restored.find((row) => row.id === rightId);
	assert.equal(keptActive.person_id, right.id);
	assert.equal(keptActive.state, "active");
	const retired = await make("P2 retire");
	const kept = await program("Retire course", { teamId: null });
	await saveRoster(kept.id, [retired.id]);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", kept.id),
			input: { kind: "program", personId: retired.id, programId: kept.id, earnedOn: "2026-10-06" },
		}),
	);
	const personRevision = await rev("person", retired.id);
	const reviewRevision = await plantRevision();
	ok(
		await tx((t) =>
			peopleWriter.retirePerson(
				t,
				ctx(),
				{
					requestKey: key(),
					expectedRevision: personRevision,
					input: { personId: retired.id, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	const matrix = ok(await trainingReader.readTrainingMatrix(db, await viewer(), {}));
	assert.equal(
		matrix.programs.some((row) => row.personIds.includes(retired.id)),
		false,
	);
	const past = ok(await trainingReader.readTrainingHistory(db, await viewer(), { personId: retired.id }));
	assert.equal(
		past.credits.some((row) => row.personId === undefined || row.programId === kept.id),
		true,
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_credit WHERE program_id=${kept.id}`)).rows[0].person_id,
		retired.id,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM training_assignment a LEFT JOIN person p ON p.id=a.person_id WHERE p.id IS NULL`,
		),
		0,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM training_credit c LEFT JOIN person p ON p.id=c.person_id WHERE p.id IS NULL`,
		),
		0,
	);
});

test("AC:TARGET-IDN-029 the session account is the actor", async () => {
	refused(
		await run(trainingWriter.createProgram, {
			requestKey: key(),
			actorId: actors[1].id,
			input: { name: "Forged field", required: false, teamId: null },
		}),
		"invalid_input",
	);
	const before = await count(sql`SELECT count(*)::int AS n FROM training_program`);
	await admin.execute(sql`UPDATE auth_session SET user_id=${actors[2].user} WHERE id=${actors[0].session}`);
	try {
		const created = ok(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "Follows account", required: false, teamId: null },
			}),
		);
		const actor = (await admin.execute(sql`SELECT actor_id FROM audit_event WHERE id=${created.receiptId}`)).rows[0]
			.actor_id;
		assert.equal(actor, actors[2].id);
	} finally {
		await admin.execute(sql`UPDATE auth_session SET user_id=${actors[0].user} WHERE id=${actors[0].session}`);
	}
	const orphan = randomUUID();
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${orphan},${orphan + "@example.test"},true,'Orphan')`,
	);
	await admin.execute(sql`UPDATE auth_session SET user_id=${orphan} WHERE id=${actors[0].session}`);
	try {
		refused(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "No account", required: false, teamId: null },
			}),
		);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_program`), before + 1);
	} finally {
		await admin.execute(sql`UPDATE auth_session SET user_id=${actors[0].user} WHERE id=${actors[0].session}`);
	}
	const item = await program("Cross tenant");
	refused(
		await run(
			trainingWriter.correctProgram,
			{
				requestKey: key(),
				expectedRevision: item.revision,
				input: { programId: item.id, name: "Other plant", required: true, reason: "No" },
			},
			3,
		),
		"unavailable",
	);
	refused(
		await trainingReader.readPersonTraining(db, await viewer(3), { personId: await person("Local only") }),
		"access_denied",
	);
	const ownerView = await viewer(0);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${actors[0].id} AND plant_id=${P}`);
	try {
		refused(await trainingReader.listTraining(db, ownerView, {}));
		refused(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "Member churchwide", required: false, teamId: null },
			}),
			"access_denied",
		);
	} finally {
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${actors[0].id} AND plant_id=${P}`);
	}
});

test("AC:TARGET-TEAM-008 a ministry's own programs are listed with its roster even when the church has more than 100", async () => {
	const own = await makeTeam("Zion choir");
	const other = await makeTeam("Aardvark crew");
	const mine = await program("Zion choir basics", { teamId: own.id, required: true });
	const churchWide = await program("Zion church welcome", { required: false });
	const singer = await person("Zion Singer");
	await assign(await makeRole(own.id, "Alto"), own.id, singer);
	await saveRoster(mine.id, [singer]);
	// 101 programs of another ministry whose names sort before this ministry's own, so the church-wide cap cuts it.
	await admin.execute(sql`INSERT INTO training_program(plant_id, team_id, name, required)
		SELECT ${P}::uuid, ${other.id}::uuid, 'Aardvark ' || lpad(n::text, 3, '0'), false FROM generate_series(1, 101) n`);
	try {
		const all = ok(await trainingReader.listTraining(db, await viewer(), {}));
		assert.equal(all.programs.length, 100);
		assert.equal(
			all.programs.some((p) => p.id === mine.id),
			false,
		);
		const listed = ok(await trainingReader.listTraining(db, await viewer(), { teamId: own.id }));
		assert.equal(
			listed.programs.some((p) => p.id === mine.id),
			true,
		);
		assert.equal(
			listed.programs.some((p) => p.id === churchWide.id),
			true,
		);
		assert.equal(
			listed.programs.every((p) => p.teamId === own.id || p.teamId === null),
			true,
		);
		const matrix = ok(await trainingReader.readTrainingMatrix(db, await viewer(), { teamId: own.id }));
		assert.deepEqual(matrix.programs.find((p) => p.id === mine.id)?.personIds, [singer]);
		assert.equal(
			matrix.programs.some((p) => p.id === churchWide.id),
			true,
		);
		assert.equal(
			matrix.programs.some((p) => p.name.startsWith("Aardvark ")),
			false,
		);
	} finally {
		await admin.execute(sql`DELETE FROM training_program WHERE team_id = ${other.id}::uuid`);
	}
});

test("AC:TARGET-TEAM-016 two admins saving one required list: the second is refused and a lost reply replays", async () => {
	const team = await makeTeam("Roster race");
	const alex = await person("Alex Race");
	const casey = await person("Casey Race");
	const item = await program("Race course", { teamId: team.id });
	// Both dialogs open on the same revision and freeze what their preview read.
	const first = await preview(item.id, [alex], 0);
	const second = await preview(item.id, [casey], 2);
	assert.equal(first.revision, second.revision);
	const request = {
		requestKey: key(),
		expectedRevision: first.revision,
		input: { programId: item.id, personIds: [alex], rosterDigest: first.rosterDigest },
	};
	const saved = ok(await run(trainingWriter.setRequiredTrainingParticipants, request, 0));
	assert.deepEqual(saved.personIds, [alex]);
	assert.equal(saved.outcome, "changed");
	refused(
		await run(
			trainingWriter.setRequiredTrainingParticipants,
			{
				requestKey: key(),
				expectedRevision: second.revision,
				input: { programId: item.id, personIds: [casey], rosterDigest: second.rosterDigest },
			},
			2,
		),
		"conflict",
	);
	const stored = async () =>
		(
			await admin.execute(
				sql`SELECT person_id FROM training_assignment WHERE program_id=${item.id} AND state='active' ORDER BY person_id`,
			)
		).rows.map((row) => row.person_id);
	assert.deepEqual(await stored(), [alex]);
	// The first reply was lost. The same request, with the same frozen revision and digest, returns the saved result.
	const programRevision = await rev("training_program", item.id);
	const replay = ok(await run(trainingWriter.setRequiredTrainingParticipants, request, 0));
	assert.deepEqual(replay, saved);
	assert.deepEqual(await stored(), [alex]);
	assert.equal(await rev("training_program", item.id), programRevision);
});

test("AC:TARGET-TEAM-009 a credit sent from a dialog opened before Correct program is refused", async () => {
	const team = await makeTeam("Revision team");
	const alex = await person("Alex Revision");
	const item = await program("Revision course", { teamId: team.id });
	await saveRoster(item.id, [alex]);
	const opened = await rev("training_program", item.id);
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: opened,
			input: { kind: "program", personId: alex, programId: item.id, earnedOn: "2026-10-01" },
		}),
	);
	ok(
		await run(trainingWriter.correctProgram, {
			requestKey: key(),
			expectedRevision: opened,
			input: { programId: item.id, name: "Revision course 2", required: true, reason: "New content" },
		}),
	);
	assert.notEqual(await rev("training_program", item.id), opened);
	const credits = () =>
		count(sql`SELECT count(*)::int AS n FROM training_credit WHERE program_id=${item.id} AND person_id=${alex}`);
	const before = await credits();
	const marks = await plantRevision();
	refused(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: opened,
			input: { kind: "program", personId: alex, programId: item.id, earnedOn: "2026-10-02" },
		}),
		"conflict",
	);
	refused(
		await run(trainingWriter.revokeCompletion, {
			requestKey: key(),
			expectedRevision: opened,
			input: { personId: alex, programId: item.id },
		}),
		"conflict",
	);
	refused(
		await run(trainingWriter.recompleteTraining, {
			requestKey: key(),
			expectedRevision: opened,
			input: { personId: alex, programId: item.id, earnedOn: "2026-10-03" },
		}),
		"conflict",
	);
	assert.equal(await credits(), before);
	assert.equal(await plantRevision(), marks);
	// The current revision is accepted.
	ok(
		await run(trainingWriter.recompleteTraining, {
			requestKey: key(),
			expectedRevision: await rev("training_program", item.id),
			input: { personId: alex, programId: item.id, earnedOn: "2026-10-03" },
		}),
	);
	assert.equal(await credits(), before + 1);
});

test("AC:REQ-IDN-005 an unknown or another church's program or team is unavailable to every training write", async () => {
	const alex = await person("Alex Unknown");
	const foreignTeam = await makeTeam("Foreign training team", 3);
	const foreign = await program("Foreign course", { teamId: foreignTeam.id, who: 3 });
	const archivedTeam = await makeTeam("Archived training team");
	const archivedItem = await program("Archived team course", { teamId: archivedTeam.id });
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", archivedTeam.id),
			input: { teamId: archivedTeam.id },
		}),
	);
	for (const programId of [randomUUID(), foreign.id]) {
		const expectedRevision = programId === foreign.id ? foreign.revision : "1";
		refused(
			await run(trainingWriter.correctProgram, {
				requestKey: key(),
				expectedRevision,
				input: { programId, name: "Probe", required: true, reason: "Probe" },
			}),
		);
		refused(
			await run(trainingWriter.setRequiredTrainingParticipants, {
				requestKey: key(),
				expectedRevision,
				input: { programId, personIds: [], rosterDigest: "0".repeat(64) },
			}),
		);
		refused(
			await run(trainingWriter.attestCompletion, {
				requestKey: key(),
				expectedRevision,
				input: { kind: "program", personId: alex, programId, earnedOn: "2026-10-01" },
			}),
		);
		refused(
			await run(trainingWriter.revokeCompletion, {
				requestKey: key(),
				expectedRevision,
				input: { personId: alex, programId },
			}),
		);
		refused(
			await run(trainingWriter.recompleteTraining, {
				requestKey: key(),
				expectedRevision,
				input: { personId: alex, programId, earnedOn: "2026-10-01" },
			}),
		);
	}
	for (const teamId of [randomUUID(), foreignTeam.id, archivedTeam.id]) {
		refused(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "Probe", required: false, teamId },
			}),
		);
		refused(await teamMeeting(teamId, { subtype: "training", date: "2026-12-01", time: "18:00" }), "team_unavailable");
	}
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM training_program WHERE plant_id=${P} AND name='Probe'`),
		0,
	);
	// A member who leads no ministry is still refused for permission, not for the row.
	refused(
		await run(
			trainingWriter.correctProgram,
			{
				requestKey: key(),
				expectedRevision: archivedItem.revision,
				input: { programId: randomUUID(), name: "Probe", required: true, reason: "Probe" },
			},
			1,
		),
		"access_denied",
	);
});
