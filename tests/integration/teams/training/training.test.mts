import { sql, type SQL } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantId } from "../../../../packages/contracts/src/common/index.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { peopleMerge, peopleUnmerge, peopleWriter } from "../../../../packages/domain/src/people/index.ts";
import {
	createAttendanceWriter,
	attendanceReader,
	withMeetingsWrite,
} from "../../../../packages/domain/src/meetings/index.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "../../../../packages/domain/src/teams/index.ts";
import { meetingsReader, meetingsWriter } from "../../../../packages/domain/src/meetings/index.ts";
import { fixture, ok, refused } from "../../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, untouched } from "../../../support/recorded.mts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const database = await fixture({ prefix: "wp019", max: 6, clock: new Date("2026-10-13T16:00:00Z") });
const { admin } = database;
const db = database.pools.runtime;
let memberPerson: string;
const P = database.tenant.id;
const Q = (await database.plant({ timezone: "America/New_York" })).id;
const actors = [
	database.actors.owner,
	database.actors.member,
	database.actors.admin,
	await database.actor({ kind: "plant", id: Q }, "admin"),
	await database.actor({ kind: "plant", id: Q }, "member"),
];
const ctx = (who = 0) => ({
	session: actors[who]!.session,
	selected: { kind: "plant" as const, id: tenantId.parse(actors[who]!.selected.id) },
});
type Context = ReturnType<typeof ctx>;
const tx = <V,>(body: (t: WriteTx) => Promise<V>) => gatedTransaction(db, body);
const run = <V,>(op: (t: WriteTx, context: Context, raw: unknown) => Promise<V>, input: unknown, who = 0) =>
	tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => {
	const actor = await RequestActor.resolve(db, actors[who]!.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};
const count = async (query: SQL) => Number((await admin.execute(query)).rows[0]!.n);
const rev = async (table: string, id: string) =>
	(await admin.execute<{ r: string }>(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0]!.r;
const plantRevision = () =>
	admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${P}`).then((r) => String(r.rows[0]!.r));

async function person(name: string, fields: { plant?: string; stage?: string; account?: string; state?: string } = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${fields.plant ?? P},${fields.plant ?? P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,${fields.state ?? "live"},clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function makeTeam(name: string, who = 0) {
	return ok(await run(teamsWriter.create, { requestKey: key(), input: { name } }, who)).team;
}
async function makeRole(teamId: string, name: string, fields: { leadership?: boolean; desiredSkills?: string } = {}) {
	return ok(await run(teamsWriter.createRole, { requestKey: key(), input: { teamId, name, ...fields } })).role;
}
async function assign(role: { id: string }, teamId: string, personId: string) {
	return ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, teamId, personId },
		}),
	);
}
async function program(name: string, fields: { required?: boolean; teamId?: string | null; who?: number } = {}) {
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
async function preview(programId: string, personIds: string[], who = 0) {
	return ok(await trainingReader.readRequiredTrainingPreview(db, await viewer(who), { programId, personIds }));
}
async function saveRoster(programId: string, personIds: string[], who = 0, requestKey = key()) {
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
const idsOf = <Name extends string>(names: Name[], book: Record<Name, string>) => names.map((name) => book[name]);
const teamMeeting = (teamId: string, fields: object = {}, who = 0) =>
	run(
		meetingsWriter.schedule,
		{ requestKey: key(), input: { type: "team_meeting", teamId, date: "2026-10-24", time: "09:00", ...fields } },
		who,
	);
const attendance = createAttendanceWriter({ reminders: async () => {} });
async function held(meetingId: string, personIds: string[], who = 0) {
	for (const status of ["ready", "in_progress"])
		ok(
			await run(meetingsWriter.changeStatus, {
				requestKey: key(),
				expectedRevision: await rev("meeting", meetingId),
				input: { meetingId, to: status },
			}),
		);
	const { attendanceRevision } = ok(await attendanceReader.listAttendance(db, await viewer(who), { meetingId }));
	ok(
		await withMeetingsWrite(db, await viewer(who), (t, c) =>
			attendance.finalizeAttendance(t, c, {
				requestKey: key(),
				expectedRevision: attendanceRevision,
				input: { meetingId, attendeeIds: personIds },
			}),
		),
	);
	ok(
		await run(meetingsWriter.changeStatus, {
			requestKey: key(),
			expectedRevision: await rev("meeting", meetingId),
			input: { meetingId, to: "completed" },
		}),
	);
}
const audited = (...audits: string[]) => ({ ...NOTHING, audits });
async function leads(teamId: string, personId: string) {
	return run(teamsWriter.appointLeader, {
		requestKey: key(),
		expectedRevision: await rev("team", teamId),
		input: { teamId, personId },
	});
}
async function leave(teamId: string, personId: string) {
	return ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", teamId),
			input: { teamId, personId },
		}),
	);
}
const attestation = async (programId: string, personId: string, earnedOn = "2026-10-01") => ({
	requestKey: key(),
	expectedRevision: await rev("training_program", programId),
	input: { kind: "program", personId, programId, earnedOn },
});
const namedCredit = async (programId: string, personId: string, earnedOn?: string) => ({
	requestKey: key(),
	expectedRevision: await rev("training_program", programId),
	input: { personId, programId, ...(earnedOn ? { earnedOn } : {}) },
});
const guestIds = async (meetingId: string, who = 0) =>
	ok(await meetingsReader.listGuests(db, await viewer(who), { meetingId })).guests.map((g) => g.person.personId);
const historyOf = async (personId: string, programId: string) =>
	ok(await trainingReader.readTrainingHistory(db, await viewer(), { personId })).credits.filter(
		(row) => row.programId === programId,
	);

before(async () => {
	memberPerson = await person("Member leader", { account: actors[1]!.id });
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
	const row = matrix.programs.find((item) => item.id === required.id)!;
	assert.deepEqual(row.personIds, [alex, casey, jordan].sort());
	assert.equal(row.personIds.includes(mara), false);
	const again = await preview(required.id, [alex, alex, casey]);
	assert.deepEqual(again.personIds, [alex, casey]);
	const replaced = await saveRoster(required.id, [alex, casey]);
	assert.deepEqual(replaced.personIds, [alex, casey]);

	const church = "2026-10-13";
	await admin.execute(sql`UPDATE training_assignment SET effective_on='2026-10-01'
		WHERE program_id=${required.id} AND state='active'`);
	const obligations = async () =>
		ok(await trainingReader.readRequiredTrainingParticipants(db, await viewer(1), { programId: required.id }))
			.people.map((x) => x.personId)
			.sort();
	const past = async () =>
		ok(await trainingReader.readAssignmentHistory(db, await viewer(1), { teamId: worship.id })).assignments.map((a) => [
			a.personName,
			a.programName,
			a.assignedOn,
			a.endedOn,
		]);
	assert.deepEqual(await obligations(), [alex, casey].sort());
	assert.deepEqual(await past(), [["Jordan Roster", required.name, church, church]]);
	const seen = await preview(required.id, [alex]);
	const removeCasey = {
		requestKey: key(),
		expectedRevision: seen.revision,
		input: { programId: required.id, personIds: [alex], rosterDigest: seen.rosterDigest },
	};
	await admin.execute(sql`CREATE FUNCTION t625_fault() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'injected roster fault'; END$$`);
	await admin.execute(sql`CREATE TRIGGER t625_fault BEFORE UPDATE ON training_assignment FOR EACH ROW
		EXECUTE FUNCTION t625_fault()`);
	try {
		refused(await run(trainingWriter.setRequiredTrainingParticipants, removeCasey), "required_write_failed");
	} finally {
		await admin.execute(sql`DROP TRIGGER t625_fault ON training_assignment`);
	}
	assert.deepEqual(await obligations(), [alex, casey].sort(), "a fault keeps the whole roster");
	const once = ok(await run(trainingWriter.setRequiredTrainingParticipants, removeCasey));
	assert.deepEqual(
		ok(await run(trainingWriter.setRequiredTrainingParticipants, removeCasey)),
		once,
		"a repeat replays",
	);
	assert.deepEqual(await obligations(), [alex], "the current obligations change");
	assert.deepEqual(
		await past(),
		[
			["Casey Roster", required.name, "2026-10-01", church],
			["Jordan Roster", required.name, church, church],
		],
		"the earlier assignment stays in history with its dates",
	);
	refused(await trainingReader.readAssignmentHistory(db, await viewer(3), { teamId: worship.id }), "unavailable");
	await saveRoster(required.id, [alex, casey]);
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
	const shown = listed.programs.find((item) => item.id === required.id)!;
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
		(await admin.execute(sql`SELECT team_id FROM training_program WHERE id=${required.id}`)).rows[0]!.team_id,
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
		(await admin.execute(sql`SELECT name, team_id FROM training_program WHERE id=${item.id}`)).rows[0]!.name,
		"Redo course revised",
	);
	assert.equal(
		(await admin.execute(sql`SELECT team_id FROM training_program WHERE id=${item.id}`)).rows[0]!.team_id,
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
	assert.equal(earned.verifierAccountId, actors[2]!.id);
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
	assert.equal(history.credits.find((row) => row.programId === item.id)!.verifierAccountId, actors[2]!.id);
	assert.equal(history.credits.find((row) => row.programId === item.id)!.earnedOn, "2026-10-01");
	const latest = history.credits.filter((row) => row.programId === item.id).at(-1)!;
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
	refused(await trainingReader.readTrainingHistory(db, await viewer(3), { personId: alex }), "unavailable");
});

test("AC:TARGET-TEAM-017 AC:SME53-009 service evidence does not change a role", async () => {
	const alex = await person("Alex Service");
	const casey = await person("Casey Service");
	const seats = await count(sql`SELECT count(*)::int AS n FROM seat`);
	const roles = await count(sql`SELECT count(*)::int AS n FROM team_role`);
	const stage = (await admin.execute(sql`SELECT stage FROM person WHERE id=${alex}`)).rows[0]!.stage;
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
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${alex}`)).rows[0]!.stage, stage);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM job`), jobs);
	refused(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			input: { kind: "service", personId: alex, attendanceDays: 60, volunteerDays: 60, testimony: "model" },
		}),
		"invalid_input",
	);
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
	const meetings = await count(sql`SELECT count(*)::int AS n FROM meeting`);
	const made = await recorded(admin, () => teamMeeting(hospitality.id, { subtype: "training" }, 1));
	const meeting = ok(made.value).meeting;
	assert.deepEqual(
		made.added,
		{ ...audited("meetings.changed"), jobs: Array(4).fill("notification") },
		"only its own reminders are queued: no notice, mail, calendar or task",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM meeting`), meetings + 1);
	assert.deepEqual((await guestIds(meeting.id)).sort(), [alex, casey].sort());
	assert.equal(meeting.subtype, "training");
	assert.equal(meeting.guestCount, 2);
	const guests = await count(sql`SELECT count(*)::int AS n FROM participation WHERE meeting_id=${meeting.id}`);
	assert.equal(guests, 2);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_credit`), credits);
	await assign(await makeRole(hospitality.id, "Later guest"), hospitality.id, jamie);
	assert.deepEqual((await guestIds(meeting.id)).sort(), [alex, casey].sort(), "a later member is not added");
	assert.equal(
		refused(
			await untouched(admin, () =>
				teamMeeting(hospitality.id, { subtype: "training", date: "2026-10-25" }, actors.length - 1),
			),
		).code,
		"unavailable",
	);
	ok(await teamMeeting(other.id, { subtype: "training", date: "2026-10-25" }, actors.length - 1));
	const second = ok(await teamMeeting(hospitality.id, { subtype: "training", date: "2026-10-26" }, 1)).meeting;
	assert.equal(second.guestCount, 3);
	const stored = (await admin.execute(sql`SELECT type, subtype, team_id FROM meeting WHERE id=${meeting.id}`)).rows[0]!;
	assert.deepEqual({ ...stored }, { type: "team_meeting", subtype: "training", team_id: hospitality.id });
	const listed = ok(await meetingsReader.list(db, await viewer(), { teamId: hospitality.id, window: "all" }));
	assert.deepEqual(listed.items.map((m) => m.id).sort(), [meeting.id, second.id].sort());
	const all = ok(await meetingsReader.list(db, await viewer(), { types: ["team_meeting"], window: "all" }));
	assert.ok(all.items.some((m) => m.id === meeting.id && m.team?.id === hospitality.id));
});

test("AC:B01-003 AC:SME53-002 AC:SME53-004 AC:TARGET-TEAM-011 health weighs staffing 40, training 35 and attendance 25, and only measured rates have a band", async () => {
	const bare = await makeTeam("Bare health");
	const bareFacts = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: bare.id }));
	assert.equal(bareFacts.composite, null);
	assert.deepEqual(bareFacts.weights, [40, 35, 25]);
	const measuresOf = async (teamId: string) => {
		const h = ok(await trainingReader.readHealth(db, await viewer(), { teamId }));
		return [h.trainingRate, h.staffingRate, h.attendanceRate, h.composite, h.staffingBand, h.attendanceBand];
	};
	assert.deepEqual(await measuresOf(bare.id), [null, null, null, null, "unknown", "unknown"]);
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
	const meeting = ok(await teamMeeting(team.id, { subtype: "regular", date: "2026-10-06", guests: [jamie] })).meeting;
	await held(meeting.id, [alex, casey, jamie]);
	ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: casey },
		}),
	);
	const seen = await recorded(admin, async () =>
		untouched(admin, async () => trainingReader.readStaffingFacts(db, await viewer(), { teamId: team.id })),
	);
	assert.deepEqual(seen.added, NOTHING);
	const facts = ok(seen.value);
	assert.equal(facts.filledSlots, 2);
	assert.equal(facts.distinctPeople, 1);
	assert.equal(facts.memberAttendance, 2);
	assert.equal(facts.guestCount, 1);
	assert.equal(facts.rosterDenominator, 2);
	assert.equal(facts.trainingRate, null);
	const course = await program("Coverage", { teamId: team.id });
	await saveRoster(course.id, [alex, casey]);
	assert.equal(
		ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: team.id })).trainingRate,
		0,
		"nobody has finished yet is a measured 0",
	);
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
	const quietMeeting = ok(await teamMeeting(quiet.id, { subtype: "regular", date: "2026-10-07" })).meeting;
	await held(quietMeeting.id, []);
	const zero = ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: quiet.id }));
	assert.equal(zero.staffingRate, 0);
	assert.equal(zero.attendanceRate, 0);
	assert.equal(zero.trainingRate, null);
	assert.equal(zero.composite, null);
	assert.deepEqual(await measuresOf(quiet.id), [null, 0, 0, null, "red", "yellow"]);
	const operational = async () =>
		ok(await trainingReader.readAggregateHealth(db, await viewer(), {})).teams.map((t) => t.teamId);
	assert.ok((await operational()).includes(quiet.id));
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", quiet.id),
			input: { teamId: quiet.id },
		}),
	);
	assert.equal((await operational()).includes(quiet.id), false, "an archived ministry is not measured now");
	const church = ok(await trainingReader.readAggregateHealth(db, await viewer(), {}));
	assert.ok(church.totalTeams > 1);
	assert.deepEqual(
		[church.measuredTeams, church.composite],
		[1, covered.composite],
		"unmeasured ministries stay out of the average",
	);
});

test("AC:SME53-004 each rate moves the composite by its own weight, and the bands turn at 40, 60 and 50 percent", async () => {
	const team = await makeTeam("Weighted health");
	const people: string[] = [];
	for (let n = 0; n < 10; n++) people.push(await person(`Weighted ${n}`));
	const roles = [];
	for (let n = 0; n < 8; n++) roles.push(await makeRole(team.id, `Weighted ${n}`));
	for (const n of [0, 1, 2]) await assign(roles[n]!, team.id, people[n]!);
	const course = await program("Weighted course", { teamId: team.id });
	await saveRoster(course.id, people.slice(0, 5));
	for (const n of [0, 1, 2, 3])
		ok(await run(trainingWriter.attestCompletion, await attestation(course.id, people[n]!)));
	const meeting = ok(await teamMeeting(team.id, { subtype: "regular", date: "2026-10-06" })).meeting;
	await held(meeting.id, [people[0]!]);
	const measured = async () => {
		const h = ok(await trainingReader.readHealth(db, await viewer(), { teamId: team.id }));
		return [h.staffingRate, h.trainingRate, h.attendanceRate, Math.round(h.composite! * 1000) / 1000];
	};
	assert.deepEqual(await measured(), [3 / 8, 0.8, 1 / 3, 51.333], "15 of 40, 28 of 35 and 8.333 of 25");
	assert.deepEqual(
		ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: team.id })).composite,
		ok(await trainingReader.readHealth(db, await viewer(), { teamId: team.id })).composite,
	);

	const staffing = async (filled: number, slots: number) => {
		const one = await makeTeam(`Staffed ${filled} of ${slots}`);
		for (let n = 0; n < slots; n++) {
			const role = await makeRole(one.id, `Slot ${n}`);
			if (n < filled) await assign(role, one.id, people[n]!);
		}
		const h = ok(await trainingReader.readHealth(db, await viewer(), { teamId: one.id }));
		return [h.staffingRate, h.staffingBand];
	};
	assert.deepEqual(
		[await staffing(3, 8), await staffing(2, 5), await staffing(4, 7), await staffing(3, 5)],
		[
			[3 / 8, "red"],
			[0.4, "yellow"],
			[4 / 7, "yellow"],
			[0.6, "ok"],
		],
	);
	const attendance = async (members: number, date: string, came: number) => {
		const one = await makeTeam(`Attended ${date}`);
		for (let n = 0; n < members; n++) await assign(await makeRole(one.id, `Member ${n}`), one.id, people[n]!);
		const at = ok(await teamMeeting(one.id, { subtype: "regular", date })).meeting;
		await held(at.id, people.slice(0, came));
		const h = ok(await trainingReader.readHealth(db, await viewer(), { teamId: one.id }));
		return [h.attendanceRate, h.attendanceBand];
	};
	assert.deepEqual(
		[await attendance(7, "2026-10-07", 3), await attendance(4, "2026-10-08", 2), await attendance(7, "2026-10-09", 4)],
		[
			[3 / 7, "yellow"],
			[0.5, "ok"],
			[4 / 7, "ok"],
		],
	);
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
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0]!.stage, "launch_team");
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
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${leaderPerson}`)).rows[0]!.stage, "leader");
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", extra.id),
			input: { roleId: extra.id, teamId: team.id, personId: stayed },
		}),
	);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${stayed}`)).rows[0]!.stage, "leader");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${stayed} AND action='people.stage_changed'`,
		),
		0,
	);
	const frozenStage = (await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0]!.stage;
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
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${member}`)).rows[0]!.stage, frozenStage);
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
		sql`UPDATE seat SET ended_at = clock_timestamp() WHERE account_id=${actors[1]!.id} AND plant_id=${P}`,
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
		await admin.execute(sql`UPDATE seat SET ended_at = NULL WHERE account_id=${actors[1]!.id} AND plant_id=${P}`);
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
	const assignment = registry.find((item) => item.kind === "training_assignment")!;
	const credit = registry.find((item) => item.kind === "training_credit")!;
	assert.equal(assignment.treatment, "move");
	assert.equal(assignment.revision, true);
	assert.equal(credit.treatment, "keep");
	assert.equal(credit.revision, false);
	const make = async (name: string) =>
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
	).rows[0]!.id;
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
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0]!.person_id,
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
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0]!.person_id,
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
		(await admin.execute(sql`SELECT person_id FROM training_assignment WHERE id=${assignmentId}`)).rows[0]!.person_id,
		source.id,
	);
	assert.equal((await admin.execute(sql`SELECT state FROM person WHERE id=${source.id}`)).rows[0]!.state, "live");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM job WHERE kind='mail'`), jobs);
	const left = await make("Shared left");
	const right = await make("Shared right");
	const shared = await program("Shared roster", { teamId: null });
	await saveRoster(shared.id, [left.id, right.id]);
	const leftRow = (
		await admin.execute<{ id: string; revision: number }>(
			sql`SELECT id, revision::int AS revision FROM training_assignment WHERE person_id=${left.id} AND program_id=${shared.id} AND state='active'`,
		)
	).rows[0]!;
	const rightId = (
		await admin.execute(
			sql`SELECT id FROM training_assignment WHERE person_id=${right.id} AND program_id=${shared.id} AND state='active'`,
		)
	).rows[0]!.id;
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
	assert.equal(active[0]!.id, rightId);
	assert.equal(active[0]!.person_id, right.id);
	const ended = placed.find((row) => row.id === leftRow.id)!;
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
	const back = restored.find((row) => row.id === leftRow.id)!;
	assert.equal(back.person_id, left.id);
	assert.equal(back.state, "active");
	assert.equal(back.revision, leftRow.revision + 2);
	const keptActive = restored.find((row) => row.id === rightId)!;
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
		past.credits.some((row) => row.programId === kept.id),
		true,
	);
	assert.equal(
		(await admin.execute(sql`SELECT person_id FROM training_credit WHERE program_id=${kept.id}`)).rows[0]!.person_id,
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
			actorId: actors[1]!.id,
			input: { name: "Forged field", required: false, teamId: null },
		}),
		"invalid_input",
	);
	const before = await count(sql`SELECT count(*)::int AS n FROM training_program`);
	await admin.execute(sql`UPDATE auth_session SET user_id=${actors[2]!.user} WHERE id=${actors[0]!.session}`);
	try {
		const created = ok(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "Follows account", required: false, teamId: null },
			}),
		);
		const actor = (await admin.execute(sql`SELECT actor_id FROM audit_event WHERE id=${created.receiptId}`)).rows[0]!
			.actor_id;
		assert.equal(actor, actors[2]!.id);
	} finally {
		await admin.execute(sql`UPDATE auth_session SET user_id=${actors[0]!.user} WHERE id=${actors[0]!.session}`);
	}
	const orphan = randomUUID();
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${orphan},${orphan + "@example.test"},true,'Orphan')`,
	);
	await admin.execute(sql`UPDATE auth_session SET user_id=${orphan} WHERE id=${actors[0]!.session}`);
	try {
		refused(
			await run(trainingWriter.createProgram, {
				requestKey: key(),
				input: { name: "No account", required: false, teamId: null },
			}),
		);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_program`), before + 1);
	} finally {
		await admin.execute(sql`UPDATE auth_session SET user_id=${actors[0]!.user} WHERE id=${actors[0]!.session}`);
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
		"unavailable",
	);
	const ownerView = await viewer(0);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${actors[0]!.id} AND plant_id=${P}`);
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
		await admin.execute(sql`UPDATE seat SET role='owner' WHERE account_id=${actors[0]!.id} AND plant_id=${P}`);
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

test("AC:REQ-IDN-005 a credit write for a missing, another church's or retired person is refused and adds no credit", async () => {
	const course = await program("Person outcome course", { required: false });
	const revision = await rev("training_program", course.id);
	const credits = () => count(sql`SELECT count(*)::int AS n FROM training_credit WHERE program_id=${course.id}`);
	const marks = await plantRevision();
	const cases = [
		[randomUUID(), "invalid_subject"],
		[await person("Abroad Person", { plant: Q }), "access_denied"],
		[await person("Retired Person", { state: "retired" }), "invalid_subject"],
	];
	for (const [personId, code] of cases) {
		refused(
			await run(trainingWriter.attestCompletion, {
				requestKey: key(),
				expectedRevision: revision,
				input: { kind: "program", personId, programId: course.id, earnedOn: "2026-10-01" },
			}),
			code,
		);
		refused(
			await run(trainingWriter.revokeCompletion, {
				requestKey: key(),
				expectedRevision: revision,
				input: { personId, programId: course.id },
			}),
			code,
		);
		refused(
			await run(trainingWriter.recompleteTraining, {
				requestKey: key(),
				expectedRevision: revision,
				input: { personId, programId: course.id, earnedOn: "2026-10-01" },
			}),
			code,
		);
	}
	assert.equal(await credits(), 0);
	assert.equal(await plantRevision(), marks);
});

test("INV-concurrency two leaders recording the same credit at once add one credit row, and two revokes add one revoke", async () => {
	const course = await program("Race course", { required: false });
	const sam = await person("Sam Race");
	const credits = (kind: "earned" | "revoked") =>
		count(sql`SELECT count(*)::int AS n FROM training_credit
			WHERE program_id=${course.id} AND person_id=${sam} AND kind=${kind}`);
	const revision = await rev("training_program", course.id);
	const both = <V,>(op: Parameters<typeof run<V>>[0], input: object) =>
		Promise.all([0, 2].map((who) => run(op, { requestKey: key(), expectedRevision: revision, input }, who)));
	const attests = await both(trainingWriter.attestCompletion, {
		kind: "program",
		personId: sam,
		programId: course.id,
		earnedOn: "2026-10-05",
	});
	assert.deepEqual(attests.map((reply) => ok(reply).outcome).sort(), ["changed", "noop"]);
	assert.equal(await credits("earned"), 1);
	const revokes = await both(trainingWriter.revokeCompletion, {
		personId: sam,
		programId: course.id,
	});
	assert.deepEqual(revokes.map((reply) => ok(reply).outcome).sort(), ["changed", "noop"]);
	assert.equal(await credits("revoked"), 1);
});

test("AC:TARGET-TEAM-008 one person in two roles is one required person with one earned credit, and only the leader's own program is theirs", async () => {
	const team = await makeTeam("Credit team");
	const otherTeam = await makeTeam("Credit other team");
	const alex = await person("Alex Credit");
	const casey = await person("Casey Credit");
	await assign(await makeRole(team.id, "R1"), team.id, alex);
	await assign(await makeRole(team.id, "R2"), team.id, alex);
	await assign(await makeRole(otherTeam.id, "R3"), otherTeam.id, casey);
	ok(await leads(team.id, memberPerson));
	const course = await program("Program A", { teamId: team.id });
	const churchwide = await program("Everyone", { required: false });
	const elsewhere = await program("Elsewhere", { teamId: otherTeam.id, required: false });
	const listed = async (who = 0) => ok(await trainingReader.listTraining(db, await viewer(who), {})).programs;
	const counts = async () => {
		const row = (await listed()).find((p) => p.id === course.id)!;
		return [row.requiredPeople, row.compatibleCredits];
	};
	assert.deepEqual(await counts(), [0, 0], "two roles require nobody by themselves");
	const unassigned = await attestation(course.id, alex);
	refused(await untouched(admin, () => run(trainingWriter.attestCompletion, unassigned)), "invalid_subject");
	const saved = await recorded(admin, () => saveRoster(course.id, [alex, alex]));
	assert.deepEqual(saved.added, audited("training.assigned"));
	assert.deepEqual(await counts(), [1, 0]);
	const planned = ok(await teamMeeting(team.id, { subtype: "training", date: "2026-10-20" }, 1)).meeting;
	assert.deepEqual(await guestIds(planned.id), [alex]);
	assert.deepEqual(await counts(), [1, 0], "a planned session earns nothing");
	const earned = await recorded(admin, async () =>
		run(trainingWriter.attestCompletion, await attestation(course.id, alex), 1),
	);
	assert.deepEqual(earned.added, audited("training.completed"));
	assert.equal(ok(earned.value).verifierAccountId, actors[1]!.id);
	assert.equal(ok(await run(trainingWriter.attestCompletion, await attestation(course.id, alex), 1)).outcome, "noop");
	assert.deepEqual(await counts(), [1, 1], "the second role adds no second credit");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM training_credit WHERE program_id=${course.id}`), 1);
	const seen = await recorded(admin, () => untouched(admin, () => listed()));
	assert.deepEqual(seen.added, NOTHING);

	for (const [programId, personId] of [
		[churchwide.id, alex],
		[elsewhere.id, casey],
	] as const) {
		const request = await attestation(programId, personId);
		refused(await untouched(admin, () => run(trainingWriter.attestCompletion, request, 1)), "access_denied");
		ok(await run(trainingWriter.attestCompletion, request, 2));
	}
	const foreign = await person("Foreign Credit", { plant: Q });
	for (const who of [3, 4]) {
		const request = await attestation(course.id, alex);
		refused(
			await untouched(admin, () => run(trainingWriter.attestCompletion, request, who)),
			who === 3 ? "unavailable" : "access_denied",
		);
		assert.deepEqual(
			(await listed(who)).map((p) => p.name),
			["Foreign course"],
		);
	}
	const theirs = await program("Their course", { required: false, who: 3 });
	ok(await run(trainingWriter.attestCompletion, await attestation(theirs.id, foreign), 3));
	assert.deepEqual(await counts(), [1, 1], "another church's completion counts only there");
	const abroad = await attestation(course.id, foreign);
	refused(await untouched(admin, () => run(trainingWriter.attestCompletion, abroad)), "access_denied");

	await leave(team.id, alex);
	assert.deepEqual(
		(await historyOf(alex, course.id)).map((row) => [row.kind, row.earnedOn]),
		[["earned", "2026-10-01"]],
	);
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id },
		}),
	);
	const kept = (await listed()).find((p) => p.id === course.id)!;
	assert.deepEqual([kept.teamId, kept.requiredPeople, kept.compatibleCredits], [team.id, 1, 1]);
	assert.equal((await historyOf(alex, course.id)).length, 1);
	const late = await attestation(course.id, alex);
	refused(await untouched(admin, () => run(trainingWriter.attestCompletion, late, 1)), "access_denied");
});

test("AC:TARGET-TEAM-009 complete, revoke and redo each record once and keep the first verifier and date", async () => {
	const team = await makeTeam("Transition team");
	const alex = await person("Alex Transition");
	const course = await program("Transition course", { teamId: team.id });
	await saveRoster(course.id, [alex]);
	const current = async () =>
		ok(await trainingReader.readRequiredTrainingParticipants(db, await viewer(), { programId: course.id })).people.map(
			(p) => [p.personId, p.complete],
		);
	const material = async () => BigInt(await plantRevision());
	const step = async (op: Parameters<typeof run>[0], request: unknown, who: number) => {
		const before = await material();
		const made = await recorded(admin, () => run(op, request, who));
		return {
			outcome: ok(made.value as { status: string }) as { outcome: string },
			added: made.added,
			stale: (await material()) - before,
		};
	};
	const complete = await step(trainingWriter.attestCompletion, await attestation(course.id, alex), 2);
	assert.deepEqual(
		[complete.outcome.outcome, complete.added, complete.stale],
		["changed", audited("training.completed"), 1n],
	);
	assert.deepEqual(await current(), [[alex, true]]);
	const request = await namedCredit(course.id, alex);
	for (const who of [3, 4]) {
		const code = who === 3 ? "unavailable" : "access_denied";
		const redo = { ...request, input: { ...request.input, earnedOn: "2026-10-13" } };
		refused(await untouched(admin, () => run(trainingWriter.revokeCompletion, request, who)), code);
		refused(await untouched(admin, () => run(trainingWriter.recompleteTraining, redo, who)), code);
	}
	const revoke = await step(trainingWriter.revokeCompletion, request, 0);
	assert.deepEqual([revoke.outcome.outcome, revoke.added, revoke.stale], ["changed", audited("training.revoked"), 1n]);
	assert.deepEqual(await current(), [[alex, false]]);
	const history = async () =>
		(await historyOf(alex, course.id)).map((row) => [row.kind, row.earnedOn, row.verifierAccountId, row.version]);
	const two = [
		["earned", "2026-10-01", actors[2]!.id, 1],
		["revoked", null, actors[0]!.id, 1],
	];
	assert.deepEqual(await history(), two);
	const repeat = await step(trainingWriter.revokeCompletion, await namedCredit(course.id, alex), 2);
	assert.deepEqual([repeat.outcome.outcome, repeat.stale], ["noop", 0n]);
	assert.deepEqual(repeat.added, audited("training.revoked"));
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${alex} AND action='training.revoked'
			AND kind='noop'`),
		1,
	);
	assert.deepEqual(await history(), two);
	assert.deepEqual(
		(await recorded(admin, () => untouched(admin, () => run(trainingWriter.revokeCompletion, request)))).added,
		NOTHING,
	);
	const redo = await step(trainingWriter.recompleteTraining, await namedCredit(course.id, alex, "2026-10-13"), 0);
	assert.deepEqual([redo.outcome.outcome, redo.added, redo.stale], ["changed", audited("training.completed"), 1n]);
	assert.deepEqual(await history(), [...two, ["earned", "2026-10-13", actors[0]!.id, 1]]);
	assert.deepEqual(await current(), [[alex, true]]);
	const stale = {
		requestKey: key(),
		expectedRevision: "1",
		input: { programId: course.id, name: "Stale", required: false, reason: "Old screen" },
	};
	refused(await untouched(admin, () => run(trainingWriter.correctProgram, stale)), "conflict");
	const fresh = { ...stale, requestKey: key(), expectedRevision: await rev("training_program", course.id) };
	const corrected = await recorded(admin, () =>
		run(trainingWriter.correctProgram, {
			...fresh,
			input: { ...fresh.input, name: "Transition course 2", required: true },
		}),
	);
	assert.equal(ok(corrected.value).program.version, 2);
	assert.deepEqual(corrected.added, audited("training.corrected"));
	assert.deepEqual(await current(), [[alex, false]], "a credit for the earlier version is not current");
	assert.deepEqual(await history(), [...two, ["earned", "2026-10-13", actors[0]!.id, 1]]);
	const proof = (
		await admin.execute(sql`SELECT actor_id, before_value, after_value, reason FROM audit_event
			WHERE action='training.corrected' AND id=${ok(corrected.value).receiptId}`)
	).rows[0];
	assert.deepEqual(proof, {
		actor_id: actors[0]!.id,
		before_value: { name: "Transition course", version: 1 },
		after_value: { name: "Transition course 2", version: 2 },
		reason: "Old screen",
	});
});

test("AC:TARGET-TEAM-010 the person past the first hundred shows one current team, one current assignment and a revoked completion kept in history", async () => {
	for (let n = 1; n <= 100; n += 1) await person("Crew " + String(n).padStart(3, "0"));
	const past = await person("Crew 101");
	const t1 = await makeTeam("T1 current");
	const t2 = await makeTeam("T2 archived");
	await assign(await makeRole(t1.id, "R1"), t1.id, past);
	await assign(await makeRole(t1.id, "R2"), t1.id, past);
	await assign(await makeRole(t2.id, "Old"), t2.id, past);
	const course = await program("Assigned course", { teamId: t1.id });
	await saveRoster(course.id, [past]);
	ok(await run(trainingWriter.attestCompletion, await attestation(course.id, past)));
	const facts = async () => ok(await trainingReader.readPersonTraining(db, await viewer(), { personId: past }));
	assert.deepEqual(
		[(await facts()).currentTeams, (await facts()).currentTrainingComplete],
		[["T1 current", "T2 archived"], true],
	);
	ok(await run(trainingWriter.revokeCompletion, await namedCredit(course.id, past)));
	ok(
		await run(teamsWriter.archive, {
			requestKey: key(),
			expectedRevision: await rev("team", t2.id),
			input: { teamId: t2.id },
		}),
	);
	const seen = await recorded(admin, () => untouched(admin, facts));
	assert.deepEqual(seen.added, NOTHING);
	assert.deepEqual(seen.value, {
		personId: past,
		currentTeams: ["T1 current"],
		formerTeams: ["T2 archived"],
		concurrentAssignments: 2,
		currentTrainingComplete: false,
		earnedHistoryRetained: true,
		distinctPeople: 1,
	});
	const counted = ok(await teamsReader.personTeamCounts(db, await viewer(), { minTeams: 1 }));
	assert.deepEqual(
		counted.people.filter((p) => p.personId === past).map((p) => [p.teams, p.teamNames]),
		[[1, ["T1 current"]]],
	);
	const required = ok(await trainingReader.readTrainingMatrix(db, await viewer(), {})).programs.filter((p) =>
		p.people.some((x) => x.personId === past),
	);
	assert.deepEqual(
		required.map((p) => [p.id, p.people.map((x) => x.complete)]),
		[[course.id, [false]]],
	);
	assert.deepEqual(
		(await historyOf(past, course.id)).map((row) => row.kind),
		["earned", "revoked"],
	);
	const roles = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: past })).assignments;
	assert.deepEqual(roles.map((a) => [a.teamName, a.roleName, a.startedOn]).sort(), [
		["T1 current", "R1", "2026-10-13"],
		["T1 current", "R2", "2026-10-13"],
		["T2 archived", "Old", "2026-10-13"],
	]);
	assert.equal(
		(ok(await teamsReader.listLeaderCandidates(db, await viewer(), {})).people as { name: string }[]).some(
			(p) => p.name === "Crew 101",
		),
		false,
	);
	assert.deepEqual(
		ok(await teamsReader.listLeaderCandidates(db, await viewer(), { q: "crew 101" })).people.map((p) => p.personId),
		[past],
	);
	for (const who of [3, 4]) {
		refused(await teamsReader.listPersonAssignments(db, await viewer(who), { personId: past }), "unavailable");
		refused(await trainingReader.readPersonTraining(db, await viewer(who), { personId: past }), "unavailable");
	}
});

test("AC:GAP-TEAM-010 two ministries are two assignments, each program's evidence stands alone, and a refused or failed read changes nothing", async () => {
	const worship = await makeTeam("Worship links");
	const hospitality = await makeTeam("Hospitality links");
	const alex = await person("Alex Links");
	await assign(await makeRole(worship.id, "Vocals"), worship.id, alex);
	await assign(await makeRole(hospitality.id, "Door"), hospitality.id, alex);
	const a = await program("Links A", { teamId: worship.id });
	const b = await program("Links B", { teamId: hospitality.id });
	await saveRoster(a.id, [alex]);
	await saveRoster(b.id, [alex]);
	const evidence = async () =>
		ok(await trainingReader.readTrainingMatrix(db, await viewer(), {}))
			.programs.filter((p) => [a.id, b.id].includes(p.id))
			.map((p) => [p.name, p.people.map((x) => x.complete)]);
	assert.deepEqual(
		await evidence(),
		[
			["Links A", [false]],
			["Links B", [false]],
		],
		"serving completes nothing",
	);
	ok(await run(trainingWriter.attestCompletion, await attestation(a.id, alex)));
	const complete = [
		["Links A", [true]],
		["Links B", [false]],
	];
	assert.deepEqual(await evidence(), complete);
	const teams = async (who = 0) => teamsReader.listPersonAssignments(db, await viewer(who), { personId: alex });
	const training = async (who = 0) => trainingReader.readPersonTraining(db, await viewer(who), { personId: alex });
	const seen = await recorded(admin, () =>
		untouched(
			admin,
			async () =>
				[
					ok(await teams())
						.assignments.map((x) => x.teamName)
						.sort(),
					ok(await training()),
				] as const,
		),
	);
	assert.deepEqual(seen.added, NOTHING);
	const [names, person_] = seen.value;
	assert.deepEqual(names, ["Hospitality links", "Worship links"]);
	assert.deepEqual(
		[person_.currentTeams, person_.concurrentAssignments, person_.currentTrainingComplete],
		[["Hospitality links", "Worship links"], 2, false],
	);
	const readers: ((who?: number) => Promise<{ status: string }>)[] = [teams, training];
	for (const reader of readers) {
		const error = refused(await untouched(admin, () => reader(4)), "unavailable");
		assert.deepEqual(error.details, {});
	}
	await admin.execute(sql`ALTER TABLE team_tenure RENAME TO team_tenure_away`);
	try {
		for (const reader of readers)
			await assert.rejects(
				async () => reader(),
				(e) => /team_tenure/.test(String((e as Error & { cause?: Error }).cause?.message)),
			);
	} finally {
		await admin.execute(sql`ALTER TABLE team_tenure_away RENAME TO team_tenure`);
	}
	assert.deepEqual(ok(await training()).concurrentAssignments, 2);
	assert.deepEqual(await evidence(), complete);
});

test("AC:GAP-TEAM-013 the ministry's own leader schedules training for its people as they are, and a refusal or a failed write leaves no meeting", async () => {
	const team = await makeTeam("Training hosts");
	const foreignTeam = await makeTeam("Foreign hosts", 3);
	const alex = await person("Alex Host", { account: actors[2]!.id });
	const casey = await person("Casey Host", { stage: "leader" });
	const jamie = await person("Jamie Host");
	await assign(await makeRole(team.id, "Greeter"), team.id, casey);
	await assign(await makeRole(team.id, "Usher"), team.id, jamie);
	ok(await leads(team.id, alex));
	const input = {
		subtype: "training",
		date: "2026-10-20",
		time: "10:00",
		venue: { kind: "new", venue: { name: "Hall", address: "1 Main" } },
	};
	const made = await recorded(admin, () => teamMeeting(team.id, input, 2));
	const meeting = ok(made.value).meeting;
	assert.deepEqual(made.added, {
		...audited("meetings.changed"),
		jobs: ["notification", "notification", "notification"],
	});
	assert.deepEqual(
		[meeting.type, meeting.subtype, meeting.team, meeting.startsAt, meeting.venue?.name],
		["team_meeting", "training", { id: team.id, name: "Training hosts" }, "2026-10-20T15:00:00.000Z", "Hall"],
	);
	assert.deepEqual((await guestIds(meeting.id)).sort(), [casey, jamie].sort());
	const later = await person("Later Host");
	await assign(await makeRole(team.id, "Later"), team.id, later);
	assert.deepEqual((await guestIds(meeting.id)).sort(), [casey, jamie].sort());
	for (const who of [2, 0])
		refused(await untouched(admin, () => teamMeeting(foreignTeam.id, input, who)), "team_unavailable");
	for (const who of [4, 3]) {
		const error = refused(
			await untouched(admin, () => teamMeeting(team.id, input, who)),
			who === 3 ? "team_unavailable" : "unavailable",
		);
		assert.equal(JSON.stringify(error).includes("Training hosts"), false);
	}
	for (const table of ["participation", "meeting", "job", "audit_event"])
		refused(
			await untouched(admin, () =>
				failingWrite(admin, { on: table, event: "INSERT" }, () => teamMeeting(team.id, input, 2)),
			),
			"required_write_failed",
		);
	assert.deepEqual((await guestIds(meeting.id)).sort(), [casey, jamie].sort());
	ok(await teamMeeting(team.id, input, 2));
	await admin.execute(sql`UPDATE person SET linked_account_id=NULL WHERE id=${alex}`);
});

test("AC:TARGET-TEAM-015 AC:GAP-TEAM-015 a placement moves one stage in the same commit, once, and a failed write leaves nothing", async () => {
	const team = await makeTeam("Effects team");
	const other = await makeTeam("Effects other team");
	const stageOf = async (id: string) =>
		(await admin.execute(sql`SELECT stage FROM person WHERE id=${id}`)).rows[0]!.stage;
	const seats = () => count(sql`SELECT count(*)::int AS n FROM seat`);
	const seatsBefore = await seats();
	const stages: unknown[] = [];
	const placed: string[] = [];
	for (const [stage, leadership] of [
		["core_group", false],
		["launch_team", true],
		["leader", false],
	] as const) {
		const who = await person("Effects " + stage, { stage });
		const role = await makeRole(team.id, "Effects role " + stage, { leadership });
		const request = {
			requestKey: key(),
			expectedRevision: await rev("team_role", role.id),
			input: { roleId: role.id, teamId: team.id, personId: who },
		};
		const material = BigInt(await plantRevision());
		for (const [table, event] of [
			["plant", "UPDATE"],
			["team_tenure", "INSERT"],
			["audit_event", "INSERT"],
			...(stage === "leader" ? [] : [["person", "UPDATE"]]),
		] as [string, string][])
			refused(
				await untouched(admin, () =>
					failingWrite(admin, { on: table, event }, () => run(teamsWriter.assignRole, request)),
				),
				"required_write_failed",
			);
		const made = await recorded(admin, () => run(teamsWriter.assignRole, request));
		ok(made.value);
		const moved = stage !== "leader";
		assert.deepEqual(made.added, audited(...(moved ? ["people.stage_changed"] : []), "teams.changed"), stage);
		assert.equal(BigInt(await plantRevision()), material + 1n);
		const commit = (
			await admin.execute(sql`SELECT count(DISTINCT v)::int AS n FROM (
				SELECT xmin::text AS v FROM plant WHERE id=${P}
				UNION ALL SELECT xmin::text FROM team_tenure WHERE person_id=${who}
				UNION ALL SELECT xmin::text FROM audit_event WHERE subject_id=${who} AND action='people.stage_changed'
				${moved ? sql`UNION ALL SELECT xmin::text FROM person WHERE id=${who}` : sql``}) x`)
		).rows[0]!.n;
		assert.equal(commit, 1, "the placement, the stage, its history and the freshness mark commit together");
		const again = await recorded(admin, () => untouched(admin, () => run(teamsWriter.assignRole, request)));
		assert.deepEqual([again.added, ok(again.value)], [NOTHING, ok(made.value)]);
		const anew = { ...request, requestKey: key(), expectedRevision: await rev("team_role", role.id) };
		const noop = await recorded(admin, () => run(teamsWriter.assignRole, anew));
		assert.deepEqual([ok(noop.value).outcome, noop.added], ["noop", audited("teams.changed")]);
		assert.equal(await count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${who}`), 1);
		if (moved) {
			const event = (
				await admin.execute(sql`SELECT actor_id, before_value, after_value FROM audit_event
					WHERE subject_id=${who} AND action='people.stage_changed'`)
			).rows;
			assert.deepEqual(event, [
				{
					actor_id: actors[0]!.id,
					before_value: { stage },
					after_value: { stage: leadership ? "leader" : "launch_team" },
				},
			]);
		}
		stages.push(await stageOf(who));
		placed.push(who);
	}
	assert.deepEqual(stages, ["launch_team", "leader", "leader"]);
	assert.equal(await seats(), seatsBefore);

	const prospect = await person("Effects prospect");
	const role = await makeRole(team.id, "Effects prospect role");
	await assign(role, team.id, prospect);
	assert.equal(await stageOf(prospect), "prospect", "only the exact stage moves");
	const early = await person("Effects early leader", { stage: "core_group" });
	ok(await leads(other.id, early));
	assert.equal(await stageOf(early), "core_group", "leadership does not move a core group person");
	const lead = await person("Effects launch leader", { stage: "launch_team" });
	const appointed = await recorded(admin, () => leads(other.id, lead));
	ok(appointed.value);
	assert.deepEqual(appointed.added, audited("people.stage_changed", "teams.changed"));
	assert.equal(await stageOf(lead), "leader");
	const second = await recorded(admin, () => leads(other.id, lead));
	assert.equal(ok(second.value).outcome, "noop");
	assert.deepEqual(second.added, audited("teams.changed"));
	await leave(team.id, placed[0]!);
	assert.equal(await stageOf(placed[0]!), "launch_team", "leaving moves nobody back");

	const casey = await person("Effects Casey", { stage: "leader" });
	const advanced = await recorded(admin, () => leads(other.id, casey));
	assert.equal(ok(advanced.value).team.leaderPersonId, casey);
	assert.deepEqual(advanced.added, audited("teams.changed"));
	assert.equal(await stageOf(casey), "leader");
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team WHERE leader_person_id=${casey}`), 1);
	assert.equal(await seats(), seatsBefore);

	const alex = await person("Effects Alex", { stage: "core_group" });
	const open = await makeRole(other.id, "Effects open");
	const request = {
		requestKey: key(),
		expectedRevision: await rev("team_role", open.id),
		input: { roleId: open.id, teamId: other.id, personId: alex },
	};
	for (const [who, code] of [
		[4, "access_denied"],
		[3, "unavailable"],
	] as const) {
		const error = refused(await untouched(admin, () => run(teamsWriter.assignRole, request, who)), code);
		assert.deepEqual(error.details, {});
		const leader = {
			requestKey: key(),
			expectedRevision: await rev("team", other.id),
			input: { teamId: other.id, personId: casey },
		};
		refused(await untouched(admin, () => run(teamsWriter.appointLeader, leader, who)), code);
	}
	ok(await run(teamsWriter.assignRole, request));
	assert.equal(ok(await teamsReader.listMembers(db, await viewer(), { teamId: other.id })).members.length, 1);
	assert.equal(await stageOf(alex), "launch_team");

	const session = await recorded(admin, () => teamMeeting(team.id, { subtype: "training", date: "2026-10-20" }));
	ok(session.value);
	assert.deepEqual(session.added, {
		...audited("meetings.changed"),
		jobs: ["notification", "notification", "notification"],
	});
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM mail`), 0);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM task`), 0);
});

test("AC:TARGET-TEAM-016 AC:SME53-001 a reviewed list of two ministries and their leaders is exact, and changes only by a reviewed change", async () => {
	const t = await makeTeam("Source team");
	const u = await makeTeam("Source other team");
	const alex = await person("Alex Source", { stage: "leader" });
	const casey = await person("Casey Source");
	const jordan = await person("Jordan Source");
	const jamie = await person("Jamie Source");
	const mara = await person("Mara Source");
	await assign(await makeRole(t.id, "One"), t.id, alex);
	await assign(await makeRole(t.id, "Two"), t.id, alex);
	await assign(await makeRole(t.id, "Three"), t.id, casey);
	await assign(await makeRole(u.id, "Four"), u.id, alex);
	ok(await leads(u.id, jordan));
	const course = await program("Source course", { teamId: t.id });
	const selection = async (...teamIds: string[]) => {
		const ids: string[] = [];
		for (const teamId of teamIds) {
			const found = ok(await teamsReader.get(db, await viewer(), { teamId }));
			ids.push(
				...found.members.map((m) => m.personId),
				...(found.team.leaderPersonId ? [found.team.leaderPersonId] : []),
			);
		}
		return ids;
	};
	const chosen = await selection(t.id, u.id);
	assert.deepEqual(chosen.filter((id) => id === alex).length, 3, "one person, three places");
	const seen = await recorded(admin, () => untouched(admin, () => preview(course.id, chosen)));
	assert.deepEqual(seen.added, NOTHING);
	const expected = [alex, casey, jordan].sort();
	assert.deepEqual([...seen.value.personIds].sort(), expected);
	const saved = await recorded(admin, () => saveRoster(course.id, chosen));
	assert.deepEqual(saved.added, audited("training.assigned"));
	assert.equal(saved.value.added, 3);
	const required = async () =>
		ok(await trainingReader.readRequiredTrainingParticipants(db, await viewer(), { programId: course.id }))
			.people.map((p) => p.personId)
			.sort();
	const matrix = async () =>
		ok(await trainingReader.readTrainingMatrix(db, await viewer(), { teamId: t.id })).programs.find(
			(p) => p.id === course.id,
		)!.personIds;
	assert.deepEqual([await required(), await matrix()], [expected, expected]);
	const reviewed = await preview(course.id, chosen);
	await leave(t.id, casey);
	await assign(await makeRole(t.id, "Five"), t.id, mara);
	await assign(await makeRole(u.id, "Six"), u.id, jamie);
	ok(await leads(u.id, jamie));
	assert.deepEqual(
		[await required(), await matrix()],
		[expected, expected],
		"people joining, leaving and leading change nothing",
	);

	const remove = await recorded(admin, () => saveRoster(course.id, [alex, casey]));
	assert.deepEqual([remove.added, remove.value.removed], [audited("training.assignment_removed"), 1]);
	assert.deepEqual(await required(), [alex, casey].sort());
	const add = await recorded(admin, () => saveRoster(course.id, [alex, casey, jamie]));
	assert.deepEqual([add.added, add.value.added], [audited("training.assigned"), 1]);
	const now = [alex, casey, jamie].sort();
	const stale = {
		requestKey: key(),
		expectedRevision: reviewed.revision,
		input: { programId: course.id, personIds: chosen, rosterDigest: reviewed.rosterDigest },
	};
	refused(await untouched(admin, () => run(trainingWriter.setRequiredTrainingParticipants, stale)), "conflict");
	const fresh = await preview(course.id, now);
	const swapped = {
		requestKey: key(),
		expectedRevision: fresh.revision,
		input: { programId: course.id, personIds: [alex, mara], rosterDigest: fresh.rosterDigest },
	};
	refused(await untouched(admin, () => run(trainingWriter.setRequiredTrainingParticipants, swapped)), "conflict");
	const dated = {
		requestKey: key(),
		expectedRevision: reviewed.revision,
		input: { programId: course.id, personIds: now, rosterDigest: fresh.rosterDigest },
	};
	refused(await untouched(admin, () => run(trainingWriter.setRequiredTrainingParticipants, dated)), "conflict");
	const episodes = () => count(sql`SELECT count(*)::int AS n FROM training_assignment WHERE program_id=${course.id}`);
	const before = await episodes();
	ok(await run(trainingWriter.attestCompletion, await attestation(course.id, alex)));
	ok(await run(trainingWriter.revokeCompletion, await namedCredit(course.id, alex)));
	assert.equal(ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: t.id })).trainingRate, 0);
	ok(await run(trainingWriter.recompleteTraining, await namedCredit(course.id, alex, "2026-10-13")));
	assert.deepEqual([await required(), await episodes()], [now, before], "credits leave the saved list alone");
	assert.equal(ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: t.id })).trainingRate, 1 / 3);
	assert.equal(ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId: u.id })).trainingRate, null);
	for (const [who, code] of [
		[3, "unavailable"],
		[4, "unavailable"],
	] as const)
		refused(
			await trainingReader.readRequiredTrainingPreview(db, await viewer(who), {
				programId: course.id,
				personIds: [alex],
			}),
			code,
		);
});

test("AC:SME53-002 coverage counts each assigned person and program once, and only current credits", async () => {
	const team = await makeTeam("Coverage team");
	const alex = await person("Alex Coverage");
	const casey = await person("Casey Coverage");
	const jordan = await person("Jordan Coverage");
	await assign(await makeRole(team.id, "One"), team.id, alex);
	await assign(await makeRole(team.id, "Two"), team.id, alex);
	await assign(await makeRole(team.id, "Three"), team.id, casey);
	const course = await program("Coverage course", { teamId: team.id });
	const rates = async () => {
		const found = ok(
			await trainingReader.readRequiredTrainingParticipants(db, await viewer(), { programId: course.id }),
		);
		const health = ok(await trainingReader.readHealth(db, await viewer(), { teamId: team.id }));
		return [found.complete, found.total, health.trainingRate];
	};
	assert.deepEqual(await rates(), [0, 0, null], "no saved list is unknown");
	await saveRoster(course.id, [jordan]);
	ok(await run(trainingWriter.attestCompletion, await attestation(course.id, jordan)));
	assert.deepEqual(await rates(), [1, 1, 1], "everyone required finished");
	await saveRoster(course.id, [alex, casey]);
	assert.deepEqual(
		(await historyOf(jordan, course.id)).map((c) => c.kind),
		["earned"],
	);
	assert.deepEqual(await rates(), [0, 2, 0], "a credit of someone no longer required does not count");
	ok(await run(trainingWriter.attestCompletion, await attestation(course.id, alex)));
	assert.deepEqual(await rates(), [1, 2, 0.5]);
	ok(await run(trainingWriter.attestCompletion, await attestation(course.id, casey)));
	assert.deepEqual(await rates(), [2, 2, 1]);
	ok(await run(trainingWriter.revokeCompletion, await namedCredit(course.id, casey)));
	const seen = await recorded(admin, () => untouched(admin, rates));
	assert.deepEqual([seen.value, seen.added], [[1, 2, 0.5], NOTHING]);
	await saveRoster(course.id, []);
	assert.deepEqual(await rates(), [0, 0, null], "an emptied list is unknown, not complete");
});
