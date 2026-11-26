import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { tenantId } from "../../../../packages/contracts/src/common/values.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { teamsWriter, trainingReader, trainingWriter } from "../../../../packages/domain/src/teams/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { fixture, ok } from "../../../support/fixture.mts";
import { accepts, foreignKeyOf, schemaCase, subcaseOf } from "./schema-probe.mts";

const c = schemaCase("SCHEMA-004");
const database = await fixture({ prefix: "schema004", max: 6, clock: new Date(String(c.clock?.now)) });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant({ timezone: "America/New_York" })).id;
const A = database.actors.admin;
after(() => database.close());

const ctx = () => ({ session: A.session, selected: { kind: "plant" as const, id: tenantId.parse(P) } });
const run = <V,>(op: (t: WriteTx, context: ReturnType<typeof ctx>, raw: unknown) => Promise<V>, input: unknown) =>
	gatedTransaction(db, (t) => op(t, ctx(), input));
const key = () => randomUUID();
const viewer = async () => {
	const actor = await RequestActor.resolve(db, A.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};
const n = async (query: SQL) => Number((await admin.execute<{ n: number }>(query)).rows[0]!.n);
const rev = async (table: string, id: string) =>
	String(
		(await admin.execute<{ r: string }>(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`))
			.rows[0]!.r,
	);

async function person(name: string, plant = P) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${id},${plant},${plant},${name},'other','prospect',
		'unknown','unknown',0,'live',clock_timestamp())`);
	return id;
}
async function team(name: string, members: string[]) {
	const made = ok(await run(teamsWriter.create, { requestKey: key(), input: { name } })).team;
	for (const personId of members) await join(made.id, personId);
	return made;
}
async function join(teamId: string, personId: string) {
	const roleId = ok(await run(teamsWriter.createRole, { requestKey: key(), input: { teamId, name: "Crew " + key() } }))
		.role.id;
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", roleId),
			input: { roleId, teamId, personId },
		}),
	);
}
async function program(name: string, teamId: string | null, required = true) {
	return ok(await run(trainingWriter.createProgram, { requestKey: key(), input: { name, required, teamId } })).program;
}
async function save(programId: string, personIds: string[]) {
	const seen = ok(await trainingReader.readRequiredTrainingPreview(db, await viewer(), { programId, personIds }));
	return {
		seen,
		command: {
			requestKey: key(),
			expectedRevision: seen.revision,
			input: { programId, personIds: seen.personIds, rosterDigest: seen.rosterDigest },
		},
	};
}
const saved = async (programId: string) =>
	ok(await trainingReader.readRequiredTrainingParticipants(db, await viewer(), { programId })).people.map(
		(p) => p.personId,
	);
const attest = async (programId: string, personId: string) =>
	ok(
		await run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await rev("training_program", programId),
			input: { kind: "program", personId, programId, earnedOn: "2026-10-02" },
		}),
	);
const assignment = (programId: string, personId: string, plant = P) =>
	sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${plant},${programId},${personId},1,'active','2026-10-13')`;
const trainingRate = async (teamId: string) =>
	ok(await trainingReader.readStaffingFacts(db, await viewer(), { teamId })).trainingRate;

test("AC:SCHEMA-004 a saved roster keeps one episode per person and program, ignores later membership and keeps completion and assignment apart", async () => {
	const book: Record<string, string> = {
		Alex: await person("Alex"),
		Casey: await person("Casey"),
		Jamie: await person("Jamie"),
	};
	const name = (id: string) => Object.keys(book).find((k) => book[k] === id);
	const roster = c.given.roster!.teams as Record<string, string[]>;
	const t1 = await team(
		"T1",
		roster.T1!.map((x) => book[x]!),
	);
	const t2 = await team(
		"T2",
		roster.T2!.map((x) => book[x]!),
	);
	const programA = await program("program-A", t1.id);
	const bulk = (c.action.arguments.save_roster as string[]).map((x) => book[x]!);
	const first = await save(programA.id, bulk);
	assert.deepEqual(first.seen.personIds.map(name), ["Alex", "Casey"]);
	const racing = await Promise.all([
		run(trainingWriter.setRequiredTrainingParticipants, first.command),
		run(trainingWriter.setRequiredTrainingParticipants, { ...first.command, requestKey: key() }),
		run(trainingWriter.correctProgram, {
			requestKey: key(),
			expectedRevision: await rev("training_program", programA.id),
			input: { programId: programA.id, name: "program-A", required: true, reason: "Renamed while saving" },
		}),
	]);
	assert.ok(racing.some((r) => r.status === "ok"));
	for (const r of racing) assert.ok(["ok", "refused"].includes(r.status), JSON.stringify(r));
	const savedRoster = (await saved(programA.id)).map(name).sort();
	const removal = await save(programA.id, [book.Alex!]);
	const added = await save(programA.id, [book.Alex!, book.Casey!]);
	await Promise.all([
		run(trainingWriter.setRequiredTrainingParticipants, removal.command),
		run(trainingWriter.setRequiredTrainingParticipants, added.command),
	]);
	ok(
		await run(
			trainingWriter.setRequiredTrainingParticipants,
			(await save(programA.id, [book.Alex!, book.Casey!])).command,
		),
	);
	const episodes = await admin.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM training_assignment
		WHERE program_id=${programA.id} AND state='active' GROUP BY person_id ORDER BY person_id`);
	assert.equal(await accepts(admin, assignment(programA.id, book.Alex!)), false, "a second current episode is refused");
	assert.equal(
		await accepts(admin, assignment(programA.id, book.Jamie!)),
		true,
		"a same-church person and program is accepted",
	);
	const foreignPerson = await person("Quinn", Q);
	assert.equal(
		await accepts(admin, assignment(programA.id, foreignPerson)),
		false,
		"a person of another church is refused",
	);
	assert.equal(
		await accepts(admin, assignment(programA.id, book.Jamie!, Q)),
		false,
		"a program of another church is refused",
	);
	assert.equal(await foreignKeyOf(admin, "training_assignment", ["person_id", "plant_id"]), "person");
	assert.equal(await foreignKeyOf(admin, "training_assignment", ["program_id", "plant_id"]), "training_program");

	const later = c.action.arguments.later_team_members as string[];
	for (const x of later) await join(t1.id, book[x]!);
	const afterJoin = (await saved(programA.id)).map(name).sort();

	const creditsBefore = await n(sql`SELECT count(*)::int AS n FROM training_credit`);
	const assignmentsBefore = await n(sql`SELECT count(*)::int AS n FROM training_assignment`);
	const orientation = await program("orientation", t1.id, false);
	await attest(orientation.id, book.Jamie!);
	const completionAssigned =
		(await n(sql`SELECT count(*)::int AS n FROM training_assignment`)) !== assignmentsBefore ||
		(await saved(orientation.id)).some((id) => id === book.Jamie);
	const creditsAfterAttest = await n(sql`SELECT count(*)::int AS n FROM training_credit`);
	assert.equal(creditsAfterAttest, creditsBefore + 1);
	const programB = await program("program-B", t1.id);
	ok(await run(trainingWriter.setRequiredTrainingParticipants, (await save(programB.id, [book.Casey!])).command));
	const assignmentCompleted =
		(await n(sql`SELECT count(*)::int AS n FROM training_credit`)) !== creditsAfterAttest ||
		ok(await trainingReader.readRequiredTrainingParticipants(db, await viewer(), { programId: programB.id }))
			.complete !== 0;
	await program("program-T2", t2.id);

	assert.deepEqual(
		{
			saved_roster: savedRoster,
			current_episodes_per_person_program: Math.max(...episodes.rows.map((r) => r.n)),
			later_membership_recomputes_roster: JSON.stringify(afterJoin) !== JSON.stringify(["Alex", "Casey"]),
			completion_creates_assignment: completionAssigned,
			assignment_creates_completion: assignmentCompleted,
			empty_applicability: await trainingRate(t2.id),
		},
		c.expected.result,
	);
	assert.equal(episodes.rows.length, 2);
});

test("AC:SCHEMA-004 completion-without-assignment: a recorded completion earns credit and creates no requirement or coverage", async () => {
	const s = subcaseOf(c, "completion-without-assignment");
	const alex = await person(String(s.given.Alex!.id));
	const crew = await team("Solo", [alex]);
	const programA = await program(String(s.action.arguments.program), crew.id, false);
	await attest(programA.id, alex);
	const history = ok(await trainingReader.readTrainingHistory(db, await viewer(), { personId: alex })).credits.filter(
		(x) => x.programId === programA.id,
	);
	const current = await admin.execute<{ id: string }>(
		sql`SELECT id FROM training_assignment WHERE person_id=${alex} AND program_id=${programA.id} AND state='active'`,
	);
	const credit = sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
		VALUES(${P},${alex},${programA.id},'earned',1,'2026-10-03')`;
	assert.equal(await accepts(admin, credit), true);
	assert.equal(
		await accepts(
			admin,
			sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
				VALUES(${P},${await person("Quinn", Q)},${programA.id},'earned',1,'2026-10-03')`,
		),
		false,
	);
	assert.deepEqual(
		{
			earned_credit: history.some((x) => x.kind === "earned"),
			required_assignment: current.rows[0]?.id ?? null,
			coverage: await trainingRate(crew.id),
		},
		s.expected.result,
	);
	assert.equal(
		ok(await trainingReader.readPersonTraining(db, await viewer(), { personId: alex })).earnedHistoryRetained,
		true,
	);
});
