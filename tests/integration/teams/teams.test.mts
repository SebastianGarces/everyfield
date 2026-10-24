import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { InvitationRefusal } from "../../../packages/domain/src/identity/invitation-core.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { sectionOperations } from "../../../packages/domain/src/settings/index.ts";
import { reviewDigest, rosterWriter, teamsReader, teamsWriter } from "../../../packages/domain/src/teams/index.ts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
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
const schema = "wp017_" + randomUUID().replaceAll("-", "");
const roleName = "wp017_" + randomBytes(8).toString("hex");
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
const P = randomUUID();
const Q = randomUUID();
const actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: who === 3 ? Q : P } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code, JSON.stringify(result.error));
	return result.error;
};
const tx = (body) => db.transaction(body);
const run = (op, input, who = 0) => tx((t) => op(t, ctx(who), input));
const key = () => randomUUID();
const viewer = async (who = 0) => RequestActor.resolve(db, actors[who].session);
const count = async (query) => Number((await admin.execute(query)).rows[0].n);
const rev = async (table, id) =>
	(await admin.execute(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0].r;

async function person(name, fields = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,
		pipeline_position,state,created_at,linked_account_id) VALUES(${id},${fields.plant ?? P},${fields.plant ?? P},${name},'other',
		${fields.stage ?? "prospect"},'unknown','unknown',0,'live',clock_timestamp(),${fields.account ?? null})`);
	return id;
}
async function makeTeam(name, who = 0) {
	const team = ok(await run(teamsWriter.create, { requestKey: key(), input: { name } }, who)).team;
	const stored = Number((await admin.execute(sql`SELECT sort_order FROM team WHERE id=${team.id}`)).rows[0].sort_order);
	assert.equal(team.sortOrder, stored);
	return team;
}
async function makeRole(teamId, name, fields = {}) {
	return ok(
		await run(teamsWriter.createRole, {
			requestKey: key(),
			input: { teamId, name, ...fields },
		}),
	).role;
}
function initInput(input) {
	const lines = input.lines ?? [];
	return {
		requestKey: input.requestKey ?? key(),
		input: {
			expectedVersion: input.expectedVersion,
			mode: input.mode,
			selections: input.selections,
			...(input.lines ? { lines: input.lines } : {}),
			reviewDigest: reviewDigest({
				expectedVersion: input.expectedVersion,
				mode: input.mode,
				selections: input.selections,
				lines,
			}),
		},
	};
}
const init = (input, who = 0) => run(teamsWriter.initialize, initInput(input), who);

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(
			`CREATE ROLE ${roleName} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
		),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${roleName}`));
	const url = new URL(source);
	url.username = roleName;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 6, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${a.id + "@example.test"},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${a.id},${a.user},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${a.session},${a.user},${randomUUID()},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const [id, zone] of [
		[P, "America/Chicago"],
		[Q, "America/New_York"],
	])
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${id},'Synthetic',${zone},7,14,1,8,1,1)`,
		);
	for (const [i, plant, seatRole] of [
		[0, P, "owner"],
		[1, P, "member"],
		[2, P, "admin"],
		[3, Q, "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${actors[i].id},${plant},${seatRole},clock_timestamp())`,
		);
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${roleName}`));
	} finally {
		await closeDatabase(admin);
	}
});

test("AC:B01-004 AC:B01-011 AC:B01-032 AC:B01-035 skip, read and cancel add no teams and keep history", async () => {
	const team = await makeTeam("History desk");
	const slot = await makeRole(team.id, "Greeter");
	const alex = await person("Alex History");
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: alex },
		}),
	);
	const ended = await count(
		sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${alex} AND ended_on IS NOT NULL`,
	);
	for (const mode of ["read", "skip", "cancel"]) {
		const value = ok(await init({ expectedVersion: "2", mode, selections: [] }));
		assert.equal(value.newTenantRows, 0);
		assert.equal(value.newTeams, 0);
		assert.equal(value.phase, 1);
	}
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${alex} AND ended_on IS NOT NULL`),
		ended,
	);
});

test("AC:B01-010 AC:B01-012 AC:B01-013 AC:B01-014 AC:B01-015 AC:B01-028 AC:B01-029 AC:B01-030 AC:B01-031 AC:B01-034 AC:TARGET-TEAM-001 AC:TARGET-TEAM-003 import keeps the chosen rows and the custom teams", async () => {
	const custom = await makeTeam("Hospitality desk");
	const accounts = await count(sql`SELECT count(*)::int AS n FROM account`);
	refused(
		await init({
			expectedVersion: "1",
			mode: "import",
			selections: [{ teamKey: "worship", roleKeys: ["worship_lead"] }],
		}),
		"stale_template_version",
	);
	const bad = initInput({ expectedVersion: "2", mode: "import", selections: [] });
	bad.input.reviewDigest = "0".repeat(64);
	refused(await run(teamsWriter.initialize, bad), "stale_review");
	refused(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "worship", roleKeys: ["foreign-plant-key"] }],
		}),
		"access_denied",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team WHERE id=${custom.id}`), 1);
	const beforePreview = await count(sql`SELECT count(*)::int AS n FROM team WHERE plant_id=${P}`);
	const catalog = ok(await teamsReader.listImportTemplates(db, await viewer(), {}));
	assert.equal(catalog.newTenantRows, 0);
	assert.equal(catalog.version, "2");
	assert.equal(catalog.teams.length, 10);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team WHERE plant_id=${P}`), beforePreview);
	const worship = {
		expectedVersion: "2",
		mode: "import",
		selections: [{ teamKey: "worship", roleKeys: ["worship_lead"] }],
	};
	const same = initInput({ ...worship, requestKey: key() });
	const [first, second] = await Promise.all([run(teamsWriter.initialize, same), run(teamsWriter.initialize, same)]);
	assert.equal(first.status, "ok", JSON.stringify(first));
	assert.equal(second.status, "ok", JSON.stringify(second));
	assert.deepEqual(first.value.teamKeys, ["worship"]);
	assert.deepEqual(first.value.roleKeys, ["worship_lead"]);
	assert.equal(second.value.receiptId, first.value.receiptId);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team WHERE plant_id=${P} AND template_key='worship'`), 1);
	const replay = ok(await run(teamsWriter.initialize, same));
	assert.equal(replay.receiptId, first.value.receiptId);
	const named = await makeTeam("Worship");
	const worshipId = (await admin.execute(sql`SELECT id FROM team WHERE plant_id=${P} AND template_key='worship'`))
		.rows[0].id;
	const renamed = ok(
		await run(teamsWriter.edit, {
			requestKey: key(),
			expectedRevision: await rev("team", worshipId),
			input: { teamId: worshipId, name: "Gathering music" },
		}),
	);
	assert.equal(renamed.stableKey, "worship");
	assert.equal(renamed.team.name, "Gathering music");
	assert.equal(renamed.team.templateKey, "worship");
	assert.equal((await admin.execute(sql`SELECT name FROM team WHERE id=${named.id}`)).rows[0].name, "Worship");
	assert.equal(
		(await admin.execute(sql`SELECT template_key FROM team WHERE id=${named.id}`)).rows[0].template_key,
		null,
	);
	refused(
		await run(
			teamsWriter.edit,
			{
				requestKey: key(),
				expectedRevision: await rev("team", worshipId),
				input: { teamId: worshipId, name: "Other" },
			},
			3,
		),
		"access_denied",
	);
	refused(
		await run(teamsWriter.edit, {
			requestKey: key(),
			expectedRevision: "1",
			input: { teamId: randomUUID(), name: "Missing" },
		}),
	);
	const destination = await makeTeam("Facilities");
	const other = await makeTeam("Facilities");
	const placed = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "facilities", roleKeys: ["facilities_lead"], destinationTeamId: destination.id }],
		}),
	);
	assert.equal(placed.newSelectedRoles, 1);
	const roleTeam = (
		await admin.execute(sql`SELECT team_id FROM team_role WHERE plant_id=${P} AND template_key='facilities_lead'`)
	).rows[0].team_id;
	assert.equal(roleTeam, destination.id);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team_role WHERE team_id=${other.id}`), 0);
	assert.equal((await admin.execute(sql`SELECT name FROM team WHERE id=${other.id}`)).rows[0].name, "Facilities");
	const pastor = await person("Pastor Pat", { stage: "launch_team" });
	const lead = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "leadership", roleKeys: ["senior_pastor"], personId: pastor }],
		}),
	);
	assert.deepEqual(lead.teamKeys, ["leadership"]);
	assert.deepEqual(lead.roleKeys, ["senior_pastor"]);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${pastor}`)).rows[0].stage, "leader");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${pastor} AND action='people.stage_changed'`,
		),
		1,
	);
	assert.equal(
		Number(
			(await admin.execute(sql`SELECT pipeline_position FROM person WHERE id=${pastor}`)).rows[0].pipeline_position,
		),
		0,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM team_role WHERE plant_id=${P} AND template_key='launch_coordinator'`,
		),
		0,
	);
	const holder = (
		await admin.execute(
			sql`SELECT tn.person_id FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id
				WHERE r.template_key='senior_pastor' AND tn.ended_on IS NULL AND r.plant_id=${P}`,
		)
	).rows[0].person_id;
	assert.equal(holder, pastor);
	const otherPastor = await person("Other Pastor");
	ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "leadership", roleKeys: ["senior_pastor"], personId: otherPastor }],
		}),
	);
	assert.equal(
		(
			await admin.execute(
				sql`SELECT tn.person_id FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id
					WHERE r.template_key='senior_pastor' AND tn.ended_on IS NULL AND r.plant_id=${P}`,
			)
		).rows[0].person_id,
		pastor,
	);
	const again = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "worship", roleKeys: ["worship_lead"] }],
		}),
	);
	assert.equal(again.newTeams, 0);
	assert.equal(again.newSelectedRoles, 0);
	const later = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [{ teamKey: "prayer", roleKeys: ["prayer_lead"] }],
		}),
	);
	assert.equal(later.newSelectedRoles, 1);
	assert.equal(later.importOfferAvailable, true);
	const version = await sourceVersion();
	const duties = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [],
			lines: [
				{ teamId: custom.id, sourceVersionId: version, sourceLine: "1", text: "Lead worship", selected: true },
				{ teamId: custom.id, sourceVersionId: version, sourceLine: "2", text: "Print songs", selected: false },
				{ teamId: custom.id, sourceVersionId: version, sourceLine: "3", text: "Tune the room", selected: false },
			],
		}),
	);
	assert.equal(duties.createdResponsibilities, 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${custom.id}`), 1);
	const repeatDuties = ok(
		await init({
			expectedVersion: "2",
			mode: "import",
			selections: [],
			lines: [{ teamId: custom.id, sourceVersionId: version, sourceLine: "1", text: "Lead worship", selected: true }],
		}),
	);
	assert.equal(repeatDuties.createdResponsibilities, 0);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM responsibility WHERE team_id=${custom.id}`), 1);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM account`), accounts);
});

test("AC:GAP-TEAM-002 AC:TARGET-TEAM-002 archive keeps history and the linked task", async () => {
	const team = await makeTeam("Archive desk");
	const slot = await makeRole(team.id, "Host");
	const alex = await person("Alex Archive");
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	const taskId = randomUUID();
	await admin.execute(
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,team_id)
			VALUES(${taskId},${P},'Staff the room','ministry_team','medium','not_started',clock_timestamp(),'undated',${team.id})`,
	);
	refused(
		await run(
			teamsWriter.archive,
			{ requestKey: key(), expectedRevision: await rev("team", team.id), input: { teamId: team.id } },
			1,
		),
		"access_denied",
	);
	const revision = await rev("team", team.id);
	const audits = await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${team.id}`);
	refused(
		await run(teamsWriter.archive, { requestKey: key(), expectedRevision: "9", input: { teamId: team.id } }),
		"conflict",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${team.id}`), audits);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team WHERE id=${team.id} AND archived_at IS NULL`), 1);
	const archived = ok(
		await run(teamsWriter.archive, { requestKey: key(), expectedRevision: revision, input: { teamId: team.id } }),
	);
	assert.equal(archived.team.archived, true);
	const page = ok(await teamsReader.list(db, await viewer(), { includeArchived: true }));
	assert.equal(page.ordinaryIds.includes(team.id), false);
	assert.equal(page.archivedIds.includes(team.id), true);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE role_id=${slot.id}`), 1);
	assert.equal((await admin.execute(sql`SELECT team_id FROM task WHERE id=${taskId}`)).rows[0].team_id, team.id);
	const replay = ok(
		await run(teamsWriter.archive, {
			requestKey: archived.receiptId ? key() : key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id },
		}),
	);
	assert.equal(replay.outcome, "noop");
	const restored = ok(
		await run(teamsWriter.restore, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id },
		}),
	);
	assert.equal(restored.team.archived, false);
	const corrected = ok(
		await run(teamsWriter.correct, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, name: "Archive desk corrected", reason: "Spelling" },
		}),
	);
	assert.equal(corrected.team.name, "Archive desk corrected");
	const history = ok(await teamsReader.listHistory(db, await viewer(), { teamId: team.id }));
	assert.equal(history.entries.length > 0, true);
	assert.equal(JSON.stringify(history).includes(actors[0].id), false);
});

test("AC:TARGET-TEAM-005 AC:TARGET-TEAM-006 AC:GAP-TEAM-014 AC:TARGET-TEAM-014 a role has one live person, and lists hide safety fields", async () => {
	const team = await makeTeam("Music");
	refused(
		await run(teamsWriter.createRole, {
			requestKey: key(),
			input: { teamId: team.id, name: "Fake lead", templateKey: "worship_lead" },
		}),
		"invalid_input",
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM team_role WHERE team_id=${team.id} AND template_key='worship_lead'`),
		0,
	);
	refused(await teamsReader.list(db, await viewer(), { background_check: "passed" }), "unsupported_filter");
	const other = await makeTeam("Welcome");
	const slot = await makeRole(team.id, "Player", { desiredSkills: "guitar" });
	const lead = await makeRole(team.id, "Director", { leadership: true });
	const away = await makeRole(other.id, "Door", { desiredSkills: "guitar" });
	const alex = await person("Alex Player", { stage: "core_group" });
	const casey = await person("Casey Player", { stage: "leader" });
	const first = ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	assert.equal(first.stage, "launch_team");
	assert.equal(first.warning, null);
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${alex}`)).rows[0].stage, "launch_team");
	assert.equal(
		Number((await admin.execute(sql`SELECT pipeline_position FROM person WHERE id=${alex}`)).rows[0].pipeline_position),
		0,
	);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${alex} AND action='people.stage_changed'`,
		),
		1,
	);
	const again = ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	assert.equal(again.outcome, "noop");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${alex} AND action='people.stage_changed'`,
		),
		1,
	);
	refused(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: casey },
		}),
		"occupied",
	);
	const raceRole = await makeRole(team.id, "Race");
	const raceRevision = await rev("team_role", raceRole.id);
	const raced = await Promise.all([
		run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: raceRevision,
			input: { roleId: raceRole.id, teamId: team.id, personId: alex },
		}),
		run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: raceRevision,
			input: { roleId: raceRole.id, teamId: team.id, personId: casey },
		}),
	]);
	assert.equal(raced.filter((result) => result.status === "ok").length, 1);
	assert.equal(raced.filter((result) => result.status === "refused" && result.error.code === "occupied").length, 1);
	const second = ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", away.id),
			input: { roleId: away.id, teamId: other.id, personId: alex },
		}),
	);
	assert.equal(second.warning, "overload");
	assert.equal(second.stage, "launch_team");
	refused(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", away.id),
			input: { roleId: away.id, teamId: team.id, personId: alex },
		}),
		"invalid_subject",
	);
	const led = ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", lead.id),
			input: { roleId: lead.id, teamId: team.id, personId: casey },
		}),
	);
	assert.equal(led.stage, "leader");
	const derived = (await admin.execute(sql`SELECT leader_person_id, leader_source FROM team WHERE id=${team.id}`))
		.rows[0];
	assert.equal(derived.leader_person_id, casey);
	assert.equal(derived.leader_source, "role_derived");
	ok(
		await run(teamsWriter.retireRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", lead.id),
			input: { roleId: lead.id },
		}),
	);
	assert.equal(
		(await admin.execute(sql`SELECT leader_person_id, leader_source FROM team WHERE id=${team.id}`)).rows[0]
			.leader_source,
		null,
	);
	ok(
		await run(teamsWriter.endMembership, {
			requestKey: key(),
			expectedRevision: await rev("team", other.id),
			input: { teamId: other.id, personId: alex },
		}),
	);
	const ended = await count(
		sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${alex} AND role_id=${away.id} AND ended_on IS NOT NULL`,
	);
	assert.equal(ended, 1);
	const returned = ok(
		await run(teamsWriter.reactivateMembership, {
			requestKey: key(),
			expectedRevision: await rev("team_role", away.id),
			input: { roleId: away.id, personId: alex },
		}),
	);
	assert.notEqual(returned.tenureId, null);
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM team_tenure WHERE id=${returned.tenureId} AND previous_tenure_id IS NOT NULL AND ended_on IS NULL`,
		),
		1,
	);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE role_id=${away.id} AND ended_on IS NOT NULL`),
		1,
	);
	const roles = ok(await teamsReader.listRoles(db, await viewer(), { teamId: team.id }));
	assert.equal(roles.roles.find((item) => item.id === slot.id).desiredSkills, "guitar");
	assert.equal(JSON.stringify(roles).includes("background"), false);
	assert.equal(JSON.stringify(roles).includes("penalty"), false);
	const assignments = ok(await teamsReader.listPersonAssignments(db, await viewer(), { personId: alex }));
	assert.equal(JSON.stringify(assignments).includes("background"), false);
	assert.equal(
		assignments.assignments.some((item) => item.desiredSkills === "guitar"),
		true,
	);
	const retired = ok(
		await run(teamsWriter.retireRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id },
		}),
	);
	assert.equal(retired.activeStaffingSlots, 0);
	assert.equal(retired.historicalOccupant, "Alex Player");
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM team_tenure WHERE role_id=${slot.id} AND ended_on IS NULL`),
		0,
	);
	const explicit = await person("Explicit Lead", { stage: "launch_team" });
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: explicit },
		}),
	);
	const leader = (await admin.execute(sql`SELECT leader_person_id, leader_source FROM team WHERE id=${team.id}`))
		.rows[0];
	assert.equal(leader.leader_person_id, explicit);
	assert.equal(leader.leader_source, "explicit");
	assert.equal((await admin.execute(sql`SELECT stage FROM person WHERE id=${explicit}`)).rows[0].stage, "leader");
	assert.equal(
		await count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${explicit} AND action='people.stage_changed'`,
		),
		1,
	);
	assert.equal(
		Number(
			(await admin.execute(sql`SELECT pipeline_position FROM person WHERE id=${explicit}`)).rows[0].pipeline_position,
		),
		0,
	);
});

test("AC:TARGET-TEAM-012 the org chart and its PDF use the same wrapped lines", async () => {
	const longName = "A".repeat(200);
	const root = (await admin.execute(sql`SELECT id FROM team WHERE plant_id=${P} AND template_key='leadership'`)).rows[0]
		.id;
	const named = await makeTeam(longName);
	const hidden = await makeTeam("Hidden chart");
	await run(teamsWriter.archive, {
		requestKey: key(),
		expectedRevision: await rev("team", hidden.id),
		input: { teamId: hidden.id },
	});
	const foreign = randomUUID();
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${foreign},${Q},'Foreign team','forming',1)`,
	);
	const chart = ok(await teamsReader.readOrgChart(db, await viewer(), {}));
	assert.equal(
		chart.nodes.some((node) => node.id === foreign),
		false,
	);
	assert.equal(
		chart.nodes.some((node) => node.id === hidden.id),
		false,
	);
	assert.equal(
		chart.nodes.some((node) => node.id === named.id),
		true,
	);
	assert.equal(chart.nodes.find((node) => node.id === named.id).parentId, root);
	assert.equal(chart.nodes.find((node) => node.id === root).parentId, null);
	const withArchived = ok(await teamsReader.readOrgChart(db, await viewer(), { includeArchived: true }));
	assert.equal(
		withArchived.nodes.some((node) => node.id === hidden.id),
		true,
	);
	const exported = ok(await teamsReader.readOrgChartExport(db, await viewer(), {}));
	assert.equal(exported.format, "pdf");
	assert.equal(exported.pdf.startsWith("%PDF-1.4"), true);
	const chunks = [];
	for (let i = 0; i < longName.length; i += 42) chunks.push(longName.slice(i, i + 42));
	for (const chunk of chunks) assert.equal(exported.lines.includes(chunk), true, chunk);
	for (const line of exported.lines) {
		assert.equal(line.length <= 42, true, line);
		assert.equal(exported.pdf.includes(line), true);
		assert.equal(exported.svg.includes(line), true);
	}
	assert.equal(JSON.stringify(exported.nodes).includes("account"), false);
	assert.equal(Object.hasOwn(exported.nodes[0], "leaderName"), true);
});

test("a roster copy keeps the people it already added", async () => {
	const team = await makeTeam("Roster desk");
	const slot = await makeRole(team.id, "Roster role");
	const extra = await makeRole(team.id, "Roster extra");
	const alex = await person("Alex Roster");
	const casey = await person("Casey Roster");
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	const meeting = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,team_id,status,attendance_revision)
		VALUES(${meeting},${P},'team_meeting','2026-11-02','18:00','America/Chicago','2026-11-02T23:00:00Z','1',${team.id},'planning',1)`);
	const preview = ok(await teamsReader.readRosterPreview(db, await viewer(), { meetingId: meeting, teamId: team.id }));
	assert.deepEqual(preview.personIds, [alex]);
	const copied = ok(
		await run(rosterWriter.copyTeamRoster, { requestKey: key(), input: { meetingId: meeting, teamId: team.id } }),
	);
	assert.deepEqual(copied.addedPersonIds, [alex]);
	await admin.execute(sql`UPDATE participation SET rsvp='confirmed' WHERE meeting_id=${meeting} AND person_id=${alex}`);
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", extra.id),
			input: { roleId: extra.id, teamId: team.id, personId: casey },
		}),
	);
	const next = ok(
		await run(rosterWriter.copyTeamRoster, { requestKey: key(), input: { meetingId: meeting, teamId: team.id } }),
	);
	assert.deepEqual(next.addedPersonIds, [casey]);
	assert.deepEqual(next.skippedPersonIds, [alex]);
	assert.equal(
		(await admin.execute(sql`SELECT rsvp FROM participation WHERE meeting_id=${meeting} AND person_id=${alex}`)).rows[0]
			.rsvp,
		"confirmed",
	);
});

test("a team leader can edit a role and still cannot change the church profile", async () => {
	const team = await makeTeam("Leader desk");
	const slot = await makeRole(team.id, "Lead title");
	const linked = await person("Linked Lead", { account: actors[1].id, stage: "launch_team" });
	ok(
		await run(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await rev("team", team.id),
			input: { teamId: team.id, personId: linked },
		}),
	);
	const edited = ok(
		await run(
			teamsWriter.editRole,
			{
				requestKey: key(),
				expectedRevision: await rev("team_role", slot.id),
				input: { roleId: slot.id, desiredSkills: "guitar" },
			},
			1,
		),
	);
	assert.equal(edited.role.desiredSkills, "guitar");
	const extra = await makeRole(team.id, "Extra title");
	const retired = ok(
		await run(
			teamsWriter.retireRole,
			{
				requestKey: key(),
				expectedRevision: await rev("team_role", extra.id),
				input: { roleId: extra.id },
			},
			1,
		),
	);
	assert.equal(retired.role.retired, true);
	assert.equal(
		await count(sql`SELECT count(*)::int AS n FROM team_role WHERE id=${extra.id} AND retired_at IS NOT NULL`),
		1,
	);
	const stranger = await makeTeam("Other desk");
	const strangerRole = await makeRole(stranger.id, "Stranger role");
	refused(
		await run(
			teamsWriter.retireRole,
			{
				requestKey: key(),
				expectedRevision: await rev("team_role", strangerRole.id),
				input: { roleId: strangerRole.id },
			},
			1,
		),
		"access_denied",
	);
	refused(
		await run(
			teamsWriter.archive,
			{ requestKey: key(), expectedRevision: await rev("team", team.id), input: { teamId: team.id } },
			1,
		),
		"access_denied",
	);
	const settings = sectionOperations({
		organizations: {},
		organizationEffects: {},
		effects: { replan: async () => "1", invalidate: async () => {} },
		suppression: async () => "clear",
	});
	const plantRevision = (await admin.execute(sql`SELECT revision::text AS r FROM plant WHERE id=${P}`)).rows[0].r;
	const profile = await tx((t) =>
		settings.updatePlantProfile(t, ctx(1), {
			requestKey: key(),
			expectedRevision: plantRevision,
			input: { plant: { kind: "plant", id: P }, patch: { name: "Not allowed" } },
		}),
	);
	refused(profile);
	assert.equal((await admin.execute(sql`SELECT name FROM plant WHERE id=${P}`)).rows[0].name, "Synthetic");
});

test("AC:ROLE43-006 a member plant profile change is refused", async () => {
	const settings = sectionOperations({
		organizations: {},
		organizationEffects: {},
		effects: { replan: async () => "1", invalidate: async () => {} },
		suppression: async () => "clear",
	});
	const plantRevision = (await admin.execute(sql`SELECT revision::text AS r FROM plant WHERE id=${P}`)).rows[0].r;
	const profile = await tx((t) =>
		settings.updatePlantProfile(t, ctx(1), {
			requestKey: key(),
			expectedRevision: plantRevision,
			input: { plant: { kind: "plant", id: P }, patch: { name: "Member rename" } },
		}),
	);
	refused(profile);
	assert.equal(profile.status, "refused");
	assert.equal((await admin.execute(sql`SELECT name FROM plant WHERE id=${P}`)).rows[0].name, "Synthetic");
});

test("AC:TARGET-IDN-019 the owner seat cannot be removed", async () => {
	const seats = createSeatService(db);
	const owner = (
		await admin.execute(
			sql`SELECT id, revision::text AS r FROM seat WHERE account_id=${actors[0].id} AND plant_id=${P}`,
		)
	).rows[0];
	await assert.rejects(
		async () =>
			seats.remove(
				await viewer(2),
				{ kind: "plant", id: P },
				{
					requestKey: key(),
					expectedRevision: owner.r,
					input: { seatId: owner.id, expectedRole: "admin", handoffs: [] },
				},
				noReminders,
			),
		(error) => error instanceof InvitationRefusal && error.value.code === "protected_owner",
	);
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat WHERE id=${owner.id} AND ended_at IS NULL`), 1);
});

test("AC:PERSONREF-TEAM-ROLE-LEADER-RETIRE retirement ends the open role and keeps the history", async () => {
	const team = await makeTeam("Retire desk");
	const slot = await makeRole(team.id, "Retire role", { leadership: true });
	const alex = await person("Alex Retire", { stage: "launch_team" });
	ok(
		await run(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await rev("team_role", slot.id),
			input: { roleId: slot.id, teamId: team.id, personId: alex },
		}),
	);
	const personRevision = await rev("person", alex);
	const review = (await admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${P}`)).rows[0].r;
	ok(
		await tx((t) =>
			peopleWriter.retirePerson(
				t,
				ctx(0),
				{
					requestKey: key(),
					expectedRevision: personRevision,
					input: { personId: alex, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
	const members = ok(await teamsReader.listMembers(db, await viewer(), { teamId: team.id }));
	assert.equal(
		members.members.some((item) => item.personId === alex),
		false,
	);
	assert.equal(
		members.history.some((item) => item.personId === alex),
		true,
	);
	const leader = (await admin.execute(sql`SELECT leader_person_id FROM team WHERE id=${team.id}`)).rows[0];
	assert.equal(leader.leader_person_id, null);
});

async function sourceVersion() {
	const release = randomUUID();
	const item = randomUUID();
	const version = randomUUID();
	const token = randomUUID();
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${token},'memory',${token.replaceAll("-", "")},'validated','0','none',1,${GLOBAL},0)`);
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${item},'ministry_template',${token},${GLOBAL})`,
	);
	await admin.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
		VALUES(${version},${item},${release},1,'lines',${token},'test')`);
	return version;
}
