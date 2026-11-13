// The church-wide teams reads Evry answers from (T-320): staffing counted by role slots and by people apart, leaders
// that can't be read, distinct current ministries per person, a saved required training list and one role ended alone.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { teamsReader, teamsWriter, trainingReader, trainingWriter } from "../../../packages/domain/src/teams/index.ts";
import { fixture, ok } from "../../support/fixture.mts";

const database = await fixture({ prefix: "teamstaff", max: 4 });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const owner = database.actors.owner;
const ctx = { session: owner.session, selected: { kind: "plant" as const, id: P } };
const run = (op: (t: never, c: typeof ctx, i: unknown) => Promise<unknown>, input: unknown) =>
	db.transaction((t) => op(t as never, ctx, input));
const key = () => randomUUID();
const viewer = () => RequestActor.resolve(db, owner.session);
const rev = async (table: string, id: string) =>
	String((await admin.execute(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0]!.r);

after(() => database.close());

async function person(name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at) VALUES(${id},${P},${P},${name},'other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
const team = async (name: string) =>
	(ok(await run(teamsWriter.create as never, { requestKey: key(), input: { name } })) as { team: { id: string } }).team
		.id;
const role = async (teamId: string, name: string, leadership = false) =>
	(
		ok(await run(teamsWriter.createRole as never, { requestKey: key(), input: { teamId, name, leadership } })) as {
			role: { id: string };
		}
	).role.id;
const assign = async (teamId: string, roleId: string, personId: string) =>
	ok(
		await run(teamsWriter.assignRole as never, {
			requestKey: key(),
			expectedRevision: await rev("team_role", roleId),
			input: { roleId, teamId, personId },
		}),
	);
const read = async <T,>(op: (db: never, a: never, i: unknown) => Promise<unknown>, input: unknown) =>
	ok(await op(db as never, (await viewer()) as never, input)) as T;

type Summary = {
	teams: {
		name: string;
		leaderStatus: string;
		leaderName: string | null;
		roles: number;
		filledRoles: number;
		openRoles: number;
		people: number;
	}[];
	roles: number;
	filledRoles: number;
	openRoles: number;
	people: number;
};

const alex = await person("Alex Rivera");
const casey = await person("Casey Reed");
const sam = await person("Sam Patel");
const hospitality = await team("Hospitality");
const worship = await team("Worship");
const kids = await team("Kids ministry");
const h1 = await role(hospitality, "Greeter");
const h2 = await role(hospitality, "Coffee host");
const w1 = await role(worship, "Vocals");

test("AC:GAP-EVR-410 INV-counts: staffing counts role slots and people apart, and an ended membership counts for neither", async () => {
	await assign(hospitality, h1, alex);
	await assign(hospitality, h2, casey);
	ok(
		await run(teamsWriter.removeRole as never, {
			requestKey: key(),
			expectedRevision: await rev("team_role", h2),
			input: { roleId: h2, personId: casey },
		}),
	);
	const summary = await read<Summary>(teamsReader.staffingSummary as never, {});
	assert.deepEqual(
		[summary.roles, summary.filledRoles, summary.openRoles, summary.people],
		[3, 1, 2, 1],
		"3 roles, 1 filled, 2 open, 1 person serving",
	);
	const hosp = summary.teams.find((t) => t.name === "Hospitality")!;
	assert.deepEqual([hosp.roles, hosp.filledRoles, hosp.openRoles, hosp.people], [2, 1, 1, 1]);
	assert.equal(hosp.leaderStatus, "none");
});

test("INV-counts: one person in several roles and ministries counts once per ministry and once in the church's people", async () => {
	const k1 = await role(kids, "Classroom helper");
	const k2 = await role(kids, "Nursery helper");
	const w2 = await role(worship, "Sound");
	for (const [t, r] of [
		[kids, k1],
		[kids, k2],
		[worship, w2],
		[hospitality, h2],
	] as const)
		await assign(t, r, sam);
	const counts = await read<{ people: { name: string; teams: number; teamNames: string[] }[] }>(
		teamsReader.personTeamCounts as never,
		{ minTeams: 3 },
	);
	assert.deepEqual(
		counts.people.map((p) => [p.name, p.teams, p.teamNames]),
		[["Sam Patel", 3, ["Hospitality", "Kids ministry", "Worship"]]],
	);
	const summary = await read<Summary>(teamsReader.staffingSummary as never, {});
	// Alex and Sam serve; Sam's four roles count once among the people.
	assert.deepEqual([summary.filledRoles, summary.people], [5, 2]);
	assert.equal(summary.teams.find((t) => t.name === "Kids ministry")!.people, 1);
});

test("INV-leader: a leader recorded on a person who can't be read now is unavailable, never leaderless", async () => {
	const prayer = await team("Prayer");
	const lead = await person("Tom Baker");
	ok(
		await run(teamsWriter.appointLeader as never, {
			requestKey: key(),
			expectedRevision: await rev("team", prayer),
			input: { teamId: prayer, personId: lead },
		}),
	);
	const before = (await read<Summary>(teamsReader.staffingSummary as never, {})).teams.find(
		(t) => t.name === "Prayer",
	)!;
	assert.deepEqual([before.leaderStatus, before.leaderName], ["appointed", "Tom Baker"]);
	// The stored leader stays on the ministry while the person's record is no longer live in this church.
	await admin.execute(sql`UPDATE person SET state='retired', retired_at=clock_timestamp() WHERE id=${lead}`);
	const after = (await read<Summary>(teamsReader.staffingSummary as never, {})).teams.find((t) => t.name === "Prayer")!;
	assert.deepEqual([after.leaderStatus, after.leaderName], ["unavailable", null]);
});

test("AC:GAP-EVR-412 AC:TARGET-TEAM-016 the saved required list stays as saved when someone joins the ministry later", async () => {
	const helper = await role(kids, "Check-in");
	const program = (
		ok(
			await run(trainingWriter.createProgram as never, {
				requestKey: key(),
				input: { name: "Kids ministry training", required: true, teamId: kids },
			}),
		) as { program: { id: string } }
	).program.id;
	const preview = await read<{ revision: string; rosterDigest: string }>(
		trainingReader.readRequiredTrainingPreview as never,
		{ programId: program, personIds: [alex, casey] },
	);
	ok(
		await run(trainingWriter.setRequiredTrainingParticipants as never, {
			requestKey: key(),
			expectedRevision: preview.revision,
			input: { programId: program, personIds: [alex, casey], rosterDigest: preview.rosterDigest },
		}),
	);
	ok(
		await run(trainingWriter.attestCompletion as never, {
			requestKey: key(),
			expectedRevision: await rev("training_program", program),
			input: { kind: "program", personId: alex, programId: program, earnedOn: "2026-10-01" },
		}),
	);
	const jamie = await person("Jamie Fox");
	await assign(kids, helper, jamie);
	const saved = await read<{ people: { name: string; complete: boolean }[]; complete: number; total: number }>(
		trainingReader.readRequiredTrainingParticipants as never,
		{ programId: program },
	);
	assert.deepEqual(
		[saved.people.map((p) => [p.name, p.complete]), saved.complete, saved.total],
		[
			[
				["Alex Rivera", true],
				["Casey Reed", false],
			],
			1,
			2,
		],
	);
	const matrix = await read<{ programs: { id: string; people: { name: string; complete: boolean }[] }[] }>(
		trainingReader.readTrainingMatrix as never,
		{ teamId: kids },
	);
	assert.deepEqual(matrix.programs.find((g) => g.id === program)!.people, saved.people);
});

test("AC:TARGET-TEAM-006 removing one role keeps the person's other roles and ministries", async () => {
	const before = await read<{ people: { name: string; teams: number }[] }>(teamsReader.personTeamCounts as never, {
		minTeams: 1,
	});
	assert.equal(before.people.find((p) => p.name === "Sam Patel")!.teams, 3);
	const detail = await read<{ roles: { id: string; name: string; occupantName: string | null }[] }>(
		teamsReader.get as never,
		{ teamId: kids },
	);
	const classroom = detail.roles.find((r) => r.name === "Classroom helper")!;
	ok(
		await run(teamsWriter.removeRole as never, {
			requestKey: key(),
			expectedRevision: await rev("team_role", classroom.id),
			input: { roleId: classroom.id, personId: sam },
		}),
	);
	const members = await read<{ items: { roleName: string; teamName: string }[] }>(teamsReader.searchMembers as never, {
		q: "Sam",
	});
	assert.deepEqual(
		members.items.map((m) => `${m.teamName}: ${m.roleName}`),
		["Hospitality: Coffee host", "Kids ministry: Nursery helper", "Worship: Sound"],
	);
});

test("INV-counts: the church's health averages only measured ministries and names how many it measured", async () => {
	const health = await read<{
		measuredTeams: number;
		totalTeams: number;
		composite: number | null;
		teams: { window: { meetings: number } }[];
	}>(trainingReader.readAggregateHealth as never, {});
	// No ministry has a completed team meeting, so none is measured: Unknown, never zero.
	assert.deepEqual([health.measuredTeams, health.totalTeams, health.composite], [0, 4, null]);
	assert.ok(health.teams.every((t) => t.window.meetings === 0));
	// One ministry's own health read gives the same facts as its row in the church's.
	const kidsHealth = await read<{ teamId: string }>(trainingReader.readHealth as never, { teamId: kids });
	assert.deepEqual(
		kidsHealth,
		health.teams.find((t) => (t as unknown as { teamId: string }).teamId === kids),
	);
});
