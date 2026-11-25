import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import { tenantId } from "../../../packages/contracts/src/common/index.ts";
import { executeBulkImport, peopleCsv } from "../../../packages/domain/src/people/index.ts";
import { PeopleReadContext } from "../../../packages/domain/src/people/core.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { meetingsReader, meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { taskReader } from "../../../packages/domain/src/tasks/index.ts";
import { teamsReader, teamsWriter, trainingReader, trainingWriter } from "../../../packages/domain/src/teams/index.ts";
import { evryActor, EvryRefusal, invokeRead, prepareProposal, READ_DOMAINS } from "../../../packages/evry/src/index.ts";
import type { LanguageModelV4 } from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import type { ReadAdapter } from "../../../packages/evry/src/catalog/types.ts";
import { scriptedModel, scriptedQualifiedModel } from "../../../packages/evry-scripted/src/index.ts";
import { runDueImports } from "../../../apps/web/src/features/people/import-export/run-imports.ts";
import { harness } from "../../evry/evals/intelligence-harness.mts";
import { fixture, ok, refused, waitingOnLock, type Actor } from "../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, untouched } from "../../support/recorded.mts";

const NOW = new Date("2026-10-13T16:00:00Z");
const TODAY = "2026-10-13";
const database = await fixture({ prefix: "wholeteam", max: 8, clock: NOW });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

const key = () => randomUUID();
const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
	(await admin.execute<T>(query)).rows[0]!;
const n = async (query: ReturnType<typeof sql>) => Number((await one<{ n: number }>(query)).n);
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const nothingChanges = <T,>(body: () => Promise<T>) => untouched(admin, body);
async function hidden<T>(table: string, body: () => Promise<T>) {
	await admin.execute(sql.raw(`ALTER TABLE ${table} RENAME TO ${table}_away`));
	try {
		return await body();
	} finally {
		await admin.execute(sql.raw(`ALTER TABLE ${table}_away RENAME TO ${table}`));
	}
}
const QUIET = { audits: ["teams.changed"], jobs: [], notices: 0, mail: 0 };

type Op<V> = (t: WriteTx, c: never, raw: never) => Promise<V>;
async function church() {
	const P = await database.plant();
	const Q = await database.plant({ timezone: "America/New_York" });
	const A = await database.actor(P, "admin", { user: { name: "Alex Admin" } });
	const M = await database.actor(P, "member");
	const B = await database.actor(Q, "admin");
	const F = await database.actor(Q, "member");
	const run = <V,>(op: Op<V>, input: unknown, who: Actor = A, plant = who === B || who === F ? Q : P, pool = db) =>
		gatedTransaction(pool, (t) =>
			op(
				t,
				{ session: who.session, selected: { kind: "plant", id: tenantId.parse(plant.id) } } as never,
				input as never,
			),
		);
	const viewer = async (who: Actor = A) => {
		const found = await RequestActor.resolve(db, who.session);
		assert.ok(found instanceof RequestActor);
		return found;
	};
	const forged = async () => RequestActor.of(B.session, (await viewer()).actor);
	const revision = async (table: string, id: string) =>
		(await one<{ r: string }>(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).r;
	const create = (input: object, who?: Actor) => run(teamsWriter.create, { requestKey: key(), input }, who);
	const team = async (name: string, fields: object = {}) => ok(await create({ name, ...fields })).team;
	const createRole = (input: object, who?: Actor, plant?: typeof P) =>
		run(teamsWriter.createRole, { requestKey: key(), input }, who, plant);
	const role = async (teamId: string, name: string, fields: object = {}) =>
		ok(await createRole({ teamId, name, ...fields })).role;
	const onTeam =
		<V,>(op: Op<V>) =>
		async (teamId: string, fields: object = {}, who?: Actor, plant?: typeof P) =>
			run(
				op,
				{ requestKey: key(), expectedRevision: await revision("team", teamId), input: { teamId, ...fields } },
				who,
				plant,
			);
	const onRole =
		<V,>(op: Op<V>) =>
		async (roleId: string, fields: object = {}, who?: Actor, plant?: typeof P) =>
			run(
				op,
				{ requestKey: key(), expectedRevision: await revision("team_role", roleId), input: { roleId, ...fields } },
				who,
				plant,
			);
	const assign = (r: { id: string; teamId: string }, personId: string) =>
		onRole(teamsWriter.assignRole)(r.id, { teamId: r.teamId, personId });
	const importing = (selections: object[], requestKey = key()) => ({
		requestKey,
		input: { expectedVersion: "2", mode: "import", selections },
	});
	const person = async (name: string, fields: { stage?: string; account?: string } = {}) => {
		const id = key();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${id},${P.id},${P.id},${name},'other',
			${fields.stage ?? "prospect"},'adult','unknown',0,'live',clock_timestamp(),${fields.account ?? null})`);
		return id;
	};
	const removeSeat = async (who: Actor) => {
		const seat = await one<{ id: string; r: string }>(
			sql`SELECT id, revision::text AS r FROM seat WHERE account_id=${who.id} AND plant_id=${P.id}`,
		);
		const remover = await viewer();
		return (pool = db) =>
			createSeatService(pool).remove(
				remover,
				{ kind: "plant", id: tenantId.parse(P.id) },
				{
					requestKey: key(),
					expectedRevision: seat.r,
					input: { seatId: seat.id, expectedRole: "member", handoffs: [] },
				},
				noReminders,
			);
	};
	const material = () => n(sql`SELECT material_revision AS n FROM plant WHERE id=${P.id}`);
	const list = async (input: object = {}, who?: Actor) => ok(await teamsReader.list(db, await viewer(who), input));
	return {
		P,
		Q,
		A,
		M,
		B,
		F,
		run,
		viewer,
		forged,
		revision,
		create,
		team,
		createRole,
		role,
		edit: onTeam(teamsWriter.edit),
		archive: onTeam(teamsWriter.archive),
		restore: onTeam(teamsWriter.restore),
		appoint: onTeam(teamsWriter.appointLeader),
		leave: onTeam(teamsWriter.endMembership),
		editRole: onRole(teamsWriter.editRole),
		retire: onRole(teamsWriter.retireRole),
		removeRole: onRole(teamsWriter.removeRole),
		reactivate: onRole(teamsWriter.reactivateMembership),
		assign,
		importing,
		person,
		removeSeat,
		material,
		list,
	};
}
async function race<T>(plant: { id: string }, bodies: ((pool: typeof db) => Promise<T>)[]) {
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holder = admin.transaction(async (t) => {
		await t.execute(sql`SELECT 1 FROM plant WHERE id=${plant.id} FOR UPDATE`);
		held.resolve();
		await release.promise;
	});
	await Promise.race([held.promise, holder]);
	const racing: Promise<T>[] = [];
	try {
		for (const body of bodies) {
			const pool = database.connect("runtime", { max: 1 });
			const { rows } = await pool.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
			racing.push(body(pool));
			racing.at(-1)!.catch(() => {});
			await waitingOnLock(admin, { pids: [rows[0]!.pid] });
		}
	} finally {
		release.resolve();
	}
	await holder;
	return Promise.all(racing);
}
const structure = async (plantId: string) =>
	(
		await admin.execute(
			sql`SELECT to_jsonb(t) AS row FROM team t WHERE plant_id=${plantId} UNION ALL SELECT to_jsonb(r) FROM team_role r
				WHERE plant_id=${plantId} UNION ALL SELECT to_jsonb(tn) FROM team_tenure tn WHERE plant_id=${plantId} ORDER BY 1`,
		)
	).rows;
const leaderOf = (teamId: string) =>
	one(sql`SELECT leader_person_id AS person, leader_source AS source FROM team WHERE id=${teamId}`);

test("AC:TARGET-TEAM-001 a renamed template ministry keeps its key and stays apart from a custom one of the same name, and lists count live people by state", async () => {
	const c = await church();
	assert.deepEqual(await c.list(), { items: [], ordinaryIds: [], archivedIds: [] });
	const { value: made, added } = await recorded(admin, () =>
		c.create({ name: "Worship", description: "Our own songs", icon: "music", state: "forming" }),
	);
	const custom = ok(made).team;
	assert.deepEqual(added, QUIET);
	assert.deepEqual(
		[custom.name, custom.description, custom.icon, custom.state, custom.templateKey],
		["Worship", "Our own songs", "music", "forming", null],
	);
	ok(await c.run(teamsWriter.initialize, c.importing([{ teamKey: "worship", roleKeys: ["worship_lead"] }])));
	const predefined = (await c.list()).items.find((t) => t.templateKey === "worship")!;
	assert.deepEqual(
		(await c.list()).items.map((t) => [t.name, t.templateKey]),
		[
			["Worship", null],
			["Worship", "worship"],
		],
	);

	const rename = {
		requestKey: key(),
		expectedRevision: predefined.revision,
		input: { teamId: predefined.id, name: "Gathering music" },
	};
	const changed = await recorded(admin, () => c.run(teamsWriter.edit, rename));
	const renamed = ok(changed.value);
	assert.deepEqual([renamed.stableKey, renamed.team.name], ["worship", "Gathering music"]);
	assert.deepEqual(changed.added, QUIET);
	assert.deepEqual(await nothingChanges(() => c.run(teamsWriter.edit, rename)), changed.value);
	const again = ok(
		await c.run(teamsWriter.initialize, c.importing([{ teamKey: "worship", roleKeys: ["worship_lead"] }])),
	);
	assert.deepEqual([again.newTeams, again.newSelectedRoles], [0, 0]);
	assert.deepEqual(
		(await c.list()).items.map((t) => [t.id, t.name, t.description, t.icon, t.templateKey]),
		[
			[custom.id, "Worship", "Our own songs", "music", null],
			[predefined.id, "Gathering music", null, null, "worship"],
		],
	);

	const alex = await c.person("Alex", { stage: "launch_team" });
	const lead = await c.role(custom.id, "Lead singer", { leadership: true });
	const keys = await c.role(custom.id, "Keys");
	await c.role(custom.id, "Drums");
	ok(await c.assign(lead, alex));
	ok(await c.assign(keys, alex));
	for (const status of ["active", "paused", "forming", "paused"])
		assert.equal(ok(await c.edit(custom.id, { state: status })).team.state, status);
	ok(await c.edit(predefined.id, { state: "active" }));
	const resting = await c.team("Resting");
	const page = await c.list();
	assert.deepEqual(
		page.items.map((t) => [t.name, t.state, t.archived, t.leaderName]),
		[
			["Worship", "paused", false, "Alex"],
			["Gathering music", "active", false, null],
			["Resting", "forming", false, null],
		],
	);
	assert.deepEqual([page.ordinaryIds, page.archivedIds], [[custom.id, predefined.id, resting.id], []]);
	const listed = page.items.find((t) => t.id === custom.id)!;
	assert.deepEqual([listed.activeCount, listed.people], [2, 1]);
	const staffing = ok(await teamsReader.staffingSummary(db, await c.viewer(), {}));
	const counted = staffing.teams.find((t) => t.teamId === custom.id)!;
	assert.deepEqual(
		[counted.roles, counted.filledRoles, counted.openRoles, counted.people, counted.leaderName],
		[3, 2, 1, 1, "Alex"],
	);
	ok(await c.removeRole(keys.id, { personId: alex }));
	const after = ok(await teamsReader.staffingSummary(db, await c.viewer(), {})).teams[0]!;
	assert.deepEqual([after.filledRoles, after.openRoles, after.people], [1, 2, 1]);

	const theirs = ok(await c.create({ name: "Other church" }, c.B)).team;
	const foreign = await nothingChanges(async () => ({
		edit: await c.edit(predefined.id, { name: "Taken" }, c.B),
		forged: await c.edit(predefined.id, { name: "Taken" }, c.B, c.P),
		get: await teamsReader.get(db, await c.viewer(c.B), { teamId: predefined.id }),
		read: await teamsReader.list(db, await c.forged(), {}),
		guessed: await c.run(teamsWriter.edit, {
			requestKey: key(),
			expectedRevision: "1",
			input: { teamId: theirs.id, name: "Taken" },
		}),
		member: await c.edit(predefined.id, { name: "Taken" }, c.M),
		memberCreate: await c.create({ name: "Taken" }, c.M),
	}));
	for (const at of ["edit", "forged", "read", "guessed"] as const) refused(foreign[at], "unavailable");
	for (const at of ["get", "member", "memberCreate"] as const) refused(foreign[at], "access_denied");
	assert.deepEqual((await c.list({}, c.B)).ordinaryIds, [theirs.id]);
	assert.deepEqual((await c.list({}, c.M)).ordinaryIds, page.ordinaryIds);
});

test("AC:TARGET-TEAM-002 archiving a staffed ministry hides it from current lists and the chart, keeps its program, meeting, duty and tenure, and restores once", async () => {
	const c = await church();
	const T = await c.team("Welcome");
	const R = await c.role(T.id, "Lead", { leadership: true });
	const alex = await c.person("Alex", { stage: "launch_team", account: c.M.id });
	ok(await c.assign(R, alex));
	const program = ok(
		await c.run(trainingWriter.createProgram, {
			requestKey: key(),
			input: { name: "Welcome training", required: true, teamId: T.id },
		}),
	).program.id;
	const meeting = ok(
		await c.run(meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "team_meeting", teamId: T.id, date: "2026-10-20", time: "19:00" },
		}),
	).meeting.id;
	const task = key();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,team_id)
		VALUES(${task},${c.P.id},'task-1','ministry_team','medium','not_started',clock_timestamp(),'undated',${T.id})`);
	const ordinary = async () => ({
		list: (await c.list()).items.map((t) => t.id),
		ids: (await c.list()).ordinaryIds,
		chart: ok(await teamsReader.readOrgChart(db, await c.viewer(), {})).nodes.map((node) => node.id),
		exported: ok(await teamsReader.readOrgChartExport(db, await c.viewer(), {})).nodes.map((node) => node.id),
		staffing: ok(await teamsReader.staffingSummary(db, await c.viewer(), {})).teams.map((t) => t.teamId),
		health: ok(await trainingReader.readAggregateHealth(db, await c.viewer(), {})).teams.map((t) => t.teamId),
		serving: ok(await teamsReader.personTeamCounts(db, await c.viewer(), { minTeams: 1 })).people.map((p) => p.name),
		members: ok(await teamsReader.searchMembers(db, await c.viewer(), {})).items.map((m) => m.teamId),
	});
	const kept = async () => ({
		tenure: (await admin.execute(sql`SELECT * FROM team_tenure WHERE role_id=${R.id}`)).rows,
		role: (await admin.execute(sql`SELECT * FROM team_role WHERE id=${R.id}`)).rows,
		meeting: (await admin.execute(sql`SELECT * FROM meeting WHERE id=${meeting}`)).rows,
		program: (await admin.execute(sql`SELECT * FROM training_program WHERE id=${program}`)).rows,
		task: (await admin.execute(sql`SELECT * FROM task WHERE id=${task}`)).rows,
		duties: ok(await gatedTransaction(db, async (t) => taskReader.list(t, await c.viewer(), { limit: 100 }))).items.map(
			(t) => t.title,
		),
		assignments: ok(await teamsReader.listPersonAssignments(db, await c.viewer(), { personId: alex })).assignments.map(
			(a) => [a.teamName, a.roleName, a.startedOn, a.endedOn],
		),
		programs: ok(await trainingReader.listTraining(db, await c.viewer(), { teamId: T.id })).programs.map((p) => [
			p.name,
			p.teamId,
		]),
		meetings: ok(await meetingsReader.list(db, await c.viewer(), { teamId: T.id })).items.map((m) => m.id),
		seats: (await admin.execute(sql`SELECT * FROM seat WHERE plant_id=${c.P.id} ORDER BY id`)).rows,
	});
	const shown = {
		list: [T.id],
		ids: [T.id],
		chart: [T.id],
		exported: [T.id],
		staffing: [T.id],
		health: [T.id],
		serving: ["Alex"],
		members: [T.id],
	};
	assert.deepEqual(await ordinary(), shown);
	const records = await kept();
	assert.deepEqual(
		[records.duties, records.assignments, records.programs, records.meetings],
		[["task-1"], [["Welcome", "Lead", TODAY, null]], [["Welcome training", T.id]], [meeting]],
	);
	ok(await c.createRole({ teamId: T.id, name: "Door" }, c.M));
	const base = await kept();
	const revision = await c.revision("team", T.id);
	const archive = { requestKey: key(), expectedRevision: revision, input: { teamId: T.id } };
	refused(await nothingChanges(() => c.run(teamsWriter.archive, archive, c.M)), "access_denied");
	refused(await nothingChanges(() => c.run(teamsWriter.archive, { ...archive, requestKey: key() }, c.B, c.P)));
	const at = await c.material();
	const first = await recorded(admin, () => c.run(teamsWriter.archive, archive));
	assert.equal(ok(first.value).team.archived, true);
	assert.deepEqual(first.added, QUIET);
	assert.equal(await c.material(), at + 1);
	assert.deepEqual(await nothingChanges(() => c.run(teamsWriter.archive, archive)), first.value);
	const noop = await recorded(admin, async () => c.archive(T.id));
	assert.equal(ok(noop.value).outcome, "noop");
	assert.deepEqual(noop.added, QUIET);
	assert.equal(await c.material(), at + 1);

	assert.deepEqual(await ordinary(), {
		list: [],
		ids: [],
		chart: [],
		exported: [],
		staffing: [],
		health: [],
		serving: [],
		members: [],
	});
	assert.deepEqual(await kept(), base);
	const archived = await c.list({ includeArchived: true });
	assert.deepEqual(
		[archived.items.map((t) => [t.id, t.name, t.archived]), archived.ordinaryIds, archived.archivedIds],
		[[[T.id, "Welcome", true]], [], [T.id]],
	);
	const chart = ok(await teamsReader.readOrgChart(db, await c.viewer(), { includeArchived: true }));
	assert.deepEqual(
		chart.nodes.map((node) => [node.id, node.archived]),
		[[T.id, true]],
	);
	const exported = ok(await teamsReader.readOrgChartExport(db, await c.viewer(), { includeArchived: true }));
	assert.equal(exported.lines.includes("Welcome (archived)"), true);

	refused(
		await nothingChanges(() =>
			c.run(teamsWriter.edit, {
				requestKey: key(),
				expectedRevision: revision,
				input: { teamId: T.id, name: "Stale name" },
			}),
		),
		"conflict",
	);
	refused(await nothingChanges(() => c.createRole({ teamId: T.id, name: "Late role" })), "unavailable");
	refused(await nothingChanges(() => c.createRole({ teamId: T.id, name: "Late role" }, c.M)), "access_denied");

	await (
		await c.removeSeat(c.M)
	)();
	const withoutSeat = await kept();
	assert.equal(withoutSeat.seats.filter((s) => s.ended_at === null).length, 1);
	const restore = { requestKey: key(), expectedRevision: await c.revision("team", T.id), input: { teamId: T.id } };
	const before = await c.material();
	const restored = await recorded(admin, () => c.run(teamsWriter.restore, restore));
	assert.equal(ok(restored.value).team.archived, false);
	assert.deepEqual(restored.added, QUIET);
	assert.equal(await c.material(), before + 1);
	assert.deepEqual(await nothingChanges(() => c.run(teamsWriter.restore, restore)), restored.value);
	const second = await recorded(admin, async () => c.restore(T.id));
	assert.equal(ok(second.value).outcome, "noop");
	assert.deepEqual(second.added, QUIET);
	assert.equal(await c.material(), before + 1);
	assert.deepEqual(await ordinary(), shown);
	assert.deepEqual(await kept(), withoutSeat);
	assert.deepEqual(await leaderOf(T.id), { person: null, source: null });
	refused(await nothingChanges(() => c.createRole({ teamId: T.id, name: "Seatless" }, c.M)), "unavailable");

	ok(await c.edit(T.id, { name: "Welcome team", reason: "Clearer name" }));
	const history = ok(await teamsReader.listHistory(db, await c.viewer(), { teamId: T.id })).entries;
	assert.deepEqual(
		history
			.filter((e) => ["archive", "restore", "edit"].includes(e.kind))
			.map((e) => [e.kind, e.actorName, e.reason, e.before, e.after]),
		[
			["edit", "Alex Admin", "Clearer name", { name: "Welcome" }, { name: "Welcome team" }],
			["restore", "Alex Admin", null, { archived: true }, { archived: false }],
			["archive", "Alex Admin", null, { archived: false }, { archived: true }],
		],
	);
});

test("AC:TARGET-TEAM-003 a chosen template import creates each chosen ministry and role once and leaves custom and occupied ones as they are", async () => {
	const c = await church();
	const custom = await c.team("Custom");
	const customRole = await c.role(custom.id, "Own role");
	ok(await c.run(teamsWriter.initialize, c.importing([{ teamKey: "leadership", roleKeys: ["senior_pastor"] }])));
	const pastorRole = await one<{ id: string; teamId: string }>(
		sql`SELECT id, team_id AS "teamId" FROM team_role WHERE plant_id=${c.P.id} AND template_key='senior_pastor'`,
	);
	const pastor = await c.person("Pastor Pat", { stage: "leader" });
	ok(await c.assign(pastorRole, pastor));
	const occupied = async () =>
		(
			await admin.execute(sql`SELECT r.id, r.name, r.revision, tn.person_id, tn.started_on, tn.ended_on, t.leader_person_id
				FROM team_role r JOIN team t ON t.id=r.team_id JOIN team_tenure tn ON tn.role_id=r.id WHERE r.id=${pastorRole.id}`)
		).rows;
	const customRows = async () =>
		(
			await admin.execute(
				sql`SELECT to_jsonb(t) AS team, to_jsonb(r) AS role FROM team t JOIN team_role r ON r.team_id=t.id WHERE t.id=${custom.id}`,
			)
		).rows;
	const [pastorBefore, customBefore] = [await occupied(), await customRows()];
	const count = (table: "team" | "team_role", template: string) =>
		n(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE plant_id=${c.P.id} AND template_key=${template}`,
		);

	const selections = [{ teamKey: "worship", roleKeys: ["worship_lead"] }];
	const preview = await nothingChanges(async () => {
		refused(
			await c.run(teamsWriter.initialize, {
				requestKey: key(),
				input: { expectedVersion: "1", mode: "import", selections },
			}),
			"stale_template_version",
		);
		refused(await c.run(teamsWriter.initialize, c.importing(selections), c.M), "access_denied");
		refused(await c.run(teamsWriter.initialize, c.importing(selections), c.B, c.P), "unavailable");
		refused(
			await c.run(teamsWriter.initialize, c.importing([{ ...selections[0]!, destinationTeamId: randomUUID() }])),
			"access_denied",
		);
		ok(await teamsReader.listImportTemplates(db, await c.viewer(), {}));
		return ok(await teamsReader.previewTemplateImport(db, await c.viewer(), { selections }));
	});
	assert.deepEqual(preview, {
		teams: [
			{
				key: "worship",
				name: "Worship",
				exists: false,
				newRoles: [{ key: "worship_lead", name: "Worship lead", leadership: true }],
				existingRoles: [],
			},
		],
		newTeams: 1,
		newRoles: 1,
	});
	const idle = await structure(c.P.id);
	for (const mode of ["cancel", "skip", "read", "import"]) {
		const none = await recorded(admin, () =>
			c.run(teamsWriter.initialize, {
				requestKey: key(),
				input: { expectedVersion: "2", mode, selections: mode === "import" ? [] : selections },
			}),
		);
		assert.deepEqual([ok(none.value).outcome, ok(none.value).newTenantRows], ["noop", 0], mode);
		assert.deepEqual(none.added, QUIET);
	}
	assert.deepEqual(await structure(c.P.id), idle);
	refused(
		await nothingChanges(() =>
			failingWrite(admin, { on: "team_role", event: "INSERT" }, () =>
				c.run(teamsWriter.initialize, c.importing(selections)),
			),
		),
		"required_write_failed",
	);

	const requests = [c.importing(selections), c.importing(selections)];
	const raced = await recorded(admin, () =>
		race(
			c.P,
			requests.map((request) => (pool) => c.run(teamsWriter.initialize, request, c.A, c.P, pool)),
		),
	);
	const results = raced.value;
	assert.deepEqual(results.map((r) => [ok(r).newTeams, ok(r).newSelectedRoles, ok(r).createdResponsibilities]).sort(), [
		[0, 0, 0],
		[1, 1, 0],
	]);
	assert.deepEqual(raced.added, { ...QUIET, audits: ["teams.changed", "teams.changed"] });
	assert.deepEqual([await count("team", "worship"), await count("team_role", "worship_lead")], [1, 1]);
	assert.deepEqual(
		await nothingChanges(async () => [
			await c.run(teamsWriter.initialize, requests[0]!),
			await c.run(teamsWriter.initialize, requests[1]!),
		]),
		results,
	);

	const worship = await one<{ id: string }>(
		sql`SELECT id FROM team WHERE plant_id=${c.P.id} AND template_key='worship'`,
	);
	ok(await c.edit(worship.id, { name: "Gathering music" }));
	const more = ok(
		await c.run(
			teamsWriter.initialize,
			c.importing([
				...selections,
				{ teamKey: "leadership", roleKeys: ["senior_pastor", "launch_coordinator"] },
				{ teamKey: "administration", roleKeys: [], destinationTeamId: custom.id },
			]),
		),
	);
	assert.deepEqual([more.newTeams, more.newSelectedRoles], [0, 1]);
	assert.deepEqual(await occupied(), pastorBefore);
	assert.deepEqual(await customRows(), customBefore);
	assert.equal(customBefore.length, 1);
	assert.equal(customRole.templateKey, null);
	assert.deepEqual(
		ok(await teamsReader.list(db, await c.viewer(), {})).items.map((t) => [t.name, t.templateKey]),
		[
			["Custom", null],
			["Leadership", "leadership"],
			["Gathering music", "worship"],
		],
	);
	assert.deepEqual(
		[
			await count("team", "leadership"),
			await count("team_role", "senior_pastor"),
			await count("team_role", "launch_coordinator"),
			await count("team_role", "worship_lead"),
		],
		[1, 1, 1, 1],
	);
	const seen = ok(
		await teamsReader.previewTemplateImport(db, await c.viewer(), {
			selections: [{ teamKey: "leadership", roleKeys: ["senior_pastor"] }],
		}),
	);
	assert.deepEqual([seen.teams[0]!.exists, seen.newTeams, seen.newRoles], [true, 0, 0]);
});

for (const first of ["appointment", "removal"])
	test(`AC:TARGET-TEAM-004 an explicit leader outlives their role, a seat removed as they are appointed (${first} first) ends their leading, and an unlinked contact gains no access`, async () => {
		const c = await church();
		const T = await c.team("Welcome");
		const lead = await c.role(T.id, "Lead", { leadership: true });
		const other = await c.role(T.id, "Second lead", { leadership: true });
		const alex = await c.person("Alex", { stage: "leader", account: c.M.id });
		const casey = await c.person("Casey", { stage: "leader" });
		const grants = async () =>
			(
				await admin.execute(
					sql`SELECT id, 'account' AS kind, NULL::timestamptz AS ended FROM account UNION ALL SELECT id, 'seat', ended_at FROM seat
					UNION ALL SELECT id, 'invitation', NULL FROM invitation ORDER BY 1`,
				)
			).rows;
		const held = await grants();
		ok(await c.assign(other, casey));
		assert.deepEqual(await leaderOf(T.id), { person: casey, source: "role_derived" });
		refused(await nothingChanges(() => c.createRole({ teamId: T.id, name: "Early" }, c.M)), "access_denied");
		const appointed = await recorded(admin, async () => c.appoint(T.id, { personId: alex }));
		assert.equal(ok(appointed.value).outcome, "changed");
		assert.deepEqual(appointed.added, QUIET);
		ok(await c.assign(lead, alex));
		assert.deepEqual(await leaderOf(T.id), { person: alex, source: "explicit" });
		ok(await c.removeRole(lead.id, { personId: alex }));
		ok(await c.retire(lead.id));
		assert.deepEqual(await leaderOf(T.id), { person: alex, source: "explicit" });
		ok(await c.createRole({ teamId: T.id, name: "Door" }, c.M));
		assert.deepEqual(await grants(), held);

		const kitchen = await c.team("Kitchen");
		const remove = await c.removeSeat(c.M);
		const revision = await c.revision("team", kitchen.id);
		const appointKitchen = (pool: typeof db) =>
			c.run(
				teamsWriter.appointLeader,
				{ requestKey: key(), expectedRevision: revision, input: { teamId: kitchen.id, personId: alex } },
				c.A,
				c.P,
				pool,
			);
		const raced = await recorded(admin, () =>
			race<unknown>(c.P, first === "appointment" ? [appointKitchen, remove] : [remove, appointKitchen]),
		);
		assert.deepEqual(
			await leaderOf(kitchen.id),
			first === "appointment" ? { person: null, source: null } : { person: alex, source: "explicit" },
		);
		assert.deepEqual(raced.added, {
			...NOTHING,
			audits: ["membership.ended", ...Array(first === "appointment" ? 3 : 2).fill("teams.changed")],
		});
		assert.deepEqual(await leaderOf(T.id), { person: null, source: null });
		assert.deepEqual(
			(await grants()).map((g) => [g.id, g.kind]),
			held.map((g) => [g.id, g.kind]),
		);
		assert.equal(await n(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${c.M.id} AND ended_at IS NULL`), 0);
		for (const teamId of [T.id, kitchen.id])
			refused(await nothingChanges(() => c.createRole({ teamId, name: "Seatless" }, c.M)), "unavailable");
		const history = ok(await teamsReader.listHistory(db, await c.viewer(), { teamId: T.id })).entries;
		assert.deepEqual(
			history
				.filter((e) => e.kind === "leader_change")
				.map((e) => [e.before?.leaderPersonId ?? null, e.after?.leaderSource ?? null]),
			[
				[null, null],
				[casey, "explicit"],
			],
		);

		const dana = await c.person("Dana Contact", { stage: "launch_team" });
		const before = await grants();
		const contact = await recorded(admin, async () => c.appoint(T.id, { personId: dana }));
		assert.deepEqual(contact.added, { ...QUIET, audits: ["people.stage_changed", "teams.changed"] });
		assert.deepEqual((await c.list()).items.map((t) => [t.name, t.leaderName, t.leaderSource]).slice(0, 1), [
			["Welcome", "Dana Contact", "explicit"],
		]);
		assert.deepEqual(await grants(), before);

		for (let i = 1; i <= 101; i++) await c.person(`Candidate ${String(i).padStart(3, "0")}`);
		const named = async (input: object) =>
			ok(await teamsReader.listLeaderCandidates(db, await c.viewer(), input)).people.map((p) => p.name);
		const open = await named({});
		assert.equal(open.length, 50);
		assert.equal(open.includes("Candidate 101"), false);
		assert.deepEqual(await named({ q: "candidate 101" }), ["Candidate 101"]);
		assert.deepEqual(await named({ q: "Candidate 1%" }), []);
		const foreign = ok(await teamsReader.listLeaderCandidates(db, await c.viewer(c.B), { q: "Candidate" }));
		assert.deepEqual(foreign.people, []);
		const last = await one<{ id: string }>(
			sql`SELECT id FROM person WHERE display_name='Candidate 101' AND plant_id=${c.P.id}`,
		);
		assert.equal(ok(await c.appoint(T.id, { personId: last.id })).team.leaderPersonId, last.id);
	});

test("AC:TARGET-TEAM-005 retiring an occupied role closes its slot, keeps who held it, clears only the leader it made and grants nothing", async () => {
	const c = await church();
	const T = await c.team("Kitchen");
	const R = await c.role(T.id, "  Cook  ", {
		description: "Cooks dinner",
		timeCommitment: "2 hours",
		desiredSkills: "knives",
		leadership: true,
	});
	assert.equal(R.name, "Cook");
	const cleared = ok(await c.editRole(R.id, { description: null, timeCommitment: null, desiredSkills: null })).role;
	assert.deepEqual(
		[cleared.name, cleared.description, cleared.timeCommitment, cleared.desiredSkills, cleared.leadership],
		["Cook", null, null, null, true],
	);
	const alex = await c.person("Alex", { stage: "leader" });
	const casey = await c.person("Casey", { stage: "leader" });
	ok(await c.assign(R, alex));
	assert.deepEqual(await leaderOf(T.id), { person: alex, source: "role_derived" });
	const grants = async () => {
		const rows = async (table: string) =>
			(await admin.execute(sql`SELECT to_jsonb(x) AS row FROM ${sql.identifier(table)} x ORDER BY x::text`)).rows;
		return Promise.all(["account", "seat", "invitation"].map(rows));
	};
	const granted = await grants();
	refused(await nothingChanges(() => c.assign(R, casey)), "occupied");
	await assert.rejects(
		admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
			VALUES(${key()},${c.P.id},${R.id},${casey},${TODAY})`),
		(e: { cause?: { code?: string } }) => e.cause?.code === "23505",
	);
	const foreign = await nothingChanges(async () => [
		await c.createRole({ teamId: T.id, name: "Foreign" }, c.B),
		await c.createRole({ teamId: T.id, name: "Foreign" }, c.B, c.P),
		await c.editRole(R.id, { name: "Foreign" }, c.B),
		await c.retire(R.id, {}, c.B),
		await c.removeRole(R.id, { personId: alex }, c.B),
	]);
	for (const reply of foreign) refused(reply, "unavailable");
	refused(await nothingChanges(() => c.retire(R.id, {}, c.M)), "access_denied");
	refused(await teamsReader.listRoles(db, await c.viewer(c.B), { teamId: T.id }), "access_denied");

	const retire = { requestKey: key(), expectedRevision: await c.revision("team_role", R.id), input: { roleId: R.id } };
	const done = await recorded(admin, () => c.run(teamsWriter.retireRole, retire));
	assert.deepEqual(
		[ok(done.value).role.retired, ok(done.value).activeStaffingSlots, ok(done.value).historicalOccupant],
		[true, 0, "Alex"],
	);
	assert.deepEqual(done.added, QUIET);
	assert.deepEqual(await nothingChanges(() => c.run(teamsWriter.retireRole, retire)), done.value);
	assert.deepEqual(await leaderOf(T.id), { person: null, source: null });
	assert.deepEqual(await grants(), granted);
	const members = ok(await teamsReader.listMembers(db, await c.viewer(), { teamId: T.id }));
	assert.deepEqual(
		[members.members, members.history.map((m) => [m.name, m.roleName, m.startedOn, m.endedOn])],
		[[], [["Alex", "Cook", TODAY, TODAY]]],
	);
	const staffing = ok(await teamsReader.staffingSummary(db, await c.viewer(), {}));
	assert.deepEqual([staffing.roles, staffing.filledRoles, staffing.people], [0, 0, 0]);
	assert.equal((await one(sql`SELECT stage FROM person WHERE id=${alex}`)).stage, "leader");
	refused(await nothingChanges(() => c.assign(R, casey)), "unavailable");

	const again = await c.role(T.id, "Second cook", { leadership: true });
	ok(await c.assign(again, casey));
	ok(await c.appoint(T.id, { personId: casey }));
	const kept = ok(await c.retire(again.id));
	assert.equal(kept.historicalOccupant, "Casey");
	assert.deepEqual(await leaderOf(T.id), { person: casey, source: "explicit" });
});

test("AC:TARGET-TEAM-006 two people racing for one role leave one holder, a person may serve on three ministries, and a return opens a new tenure", async () => {
	const c = await church();
	const [T, T2, T3] = [await c.team("T"), await c.team("T2"), await c.team("T3")];
	const [R, second, r2, r3] = [
		await c.role(T.id, "R"),
		await c.role(T.id, "Second"),
		await c.role(T2.id, "R2"),
		await c.role(T3.id, "R3"),
	];
	const alex = await c.person("Alex", { stage: "leader", account: c.M.id });
	const casey = await c.person("Casey", { stage: "leader" });
	const stageOf = async (id: string) => (await one(sql`SELECT stage FROM person WHERE id=${id}`)).stage;
	const warnings = [];
	for (const r of [second, r2, r3]) {
		const { value, added } = await recorded(admin, async () => c.assign(r, alex));
		assert.deepEqual(added, QUIET);
		warnings.push([ok(value).outcome, ok(value).teamCount, ok(value).warning, ok(value).stage]);
	}
	assert.deepEqual(warnings, [
		["changed", 1, null, "leader"],
		["changed", 2, "overload", "leader"],
		["changed", 3, "overload", "leader"],
	]);

	const at = await c.revision("team_role", R.id);
	const request = (personId: string) => ({
		requestKey: key(),
		expectedRevision: at,
		input: { roleId: R.id, teamId: T.id, personId },
	});
	const requests = [request(alex), request(casey)];
	const { value: results, added } = await recorded(admin, () =>
		race(
			c.P,
			requests.map((r) => (pool) => c.run(teamsWriter.assignRole, r, c.A, c.P, pool)),
		),
	);
	assert.deepEqual(results.map((r) => (r.status === "ok" ? "ok" : r.error.code)).sort(), ["occupied", "ok"]);
	assert.deepEqual(added, QUIET);
	const won = results.findIndex((r) => r.status === "ok");
	const holders = async () =>
		(
			await admin.execute<{ person_id: string }>(
				sql`SELECT person_id FROM team_tenure WHERE role_id=${R.id} AND ended_on IS NULL`,
			)
		).rows.map((r) => r.person_id);
	assert.deepEqual(await holders(), [[alex, casey][won]]);
	const filled = ok(await teamsReader.listRoles(db, await c.viewer(), { teamId: T.id })).roles.find(
		(r) => r.id === R.id,
	)!;
	assert.deepEqual([filled.occupantPersonId, filled.occupantName], [[alex, casey][won], ["Alex", "Casey"][won]]);

	if (won === 1) ok(await c.removeRole(R.id, { personId: casey }));
	const mine = { ...request(alex), expectedRevision: await c.revision("team_role", R.id) };
	const held = ok(await c.run(teamsWriter.assignRole, mine));
	assert.deepEqual([held.teamCount, held.warning, held.stage], [3, "overload", "leader"]);
	assert.deepEqual(ok(await nothingChanges(() => c.run(teamsWriter.assignRole, mine))), held);
	const repeat = ok(await c.assign(R, alex));
	assert.deepEqual([repeat.outcome, repeat.tenureId], ["noop", null]);
	assert.deepEqual(await holders(), [alex]);
	refused(
		await nothingChanges(async () =>
			c.run(teamsWriter.assignRole, {
				...request(alex),
				expectedRevision: await c.revision("team_role", r2.id),
				input: { roleId: r2.id, teamId: T.id, personId: alex },
			}),
		),
		"invalid_subject",
	);
	refused(await nothingChanges(async () => c.removeRole(R.id, { personId: alex }, c.B)), "unavailable");
	refused(await nothingChanges(async () => c.reactivate(R.id, { personId: alex }, c.M)), "access_denied");

	const tenures = async () =>
		(
			await admin.execute(sql`SELECT tn.id, r.name AS role, tn.person_id, tn.started_on::text AS started, tn.ended_on::text AS ended,
				tn.previous_tenure_id AS previous FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id
				WHERE tn.person_id=${alex} ORDER BY tn.id`)
		).rows;
	const seats = async () => (await admin.execute(sql`SELECT * FROM seat WHERE account_id=${c.M.id}`)).rows;
	const seated = await seats();
	const serving = await tenures();
	const removed = await recorded(admin, async () => c.leave(T.id, { personId: alex }));
	assert.equal(ok(removed.value).outcome, "changed");
	assert.deepEqual(removed.added, QUIET);
	const ended = await tenures();
	assert.deepEqual(
		ended,
		serving.map((t) => (["R", "Second"].includes(String(t.role)) && t.ended === null ? { ...t, ended: TODAY } : t)),
	);
	assert.equal(await stageOf(alex), "leader");
	assert.deepEqual(await seats(), seated);
	const back = await recorded(admin, async () => c.reactivate(R.id, { personId: alex }));
	const returned = ok(back.value);
	assert.deepEqual([returned.outcome, returned.stage, returned.warning], ["changed", "leader", "overload"]);
	assert.deepEqual(back.added, QUIET);
	const now = await tenures();
	const prior = ended.filter((t) => t.role === "R");
	assert.deepEqual(
		now.filter((t) => t.id !== returned.tenureId),
		ended,
	);
	assert.deepEqual(
		now.filter((t) => t.id === returned.tenureId),
		[
			{
				id: returned.tenureId,
				role: "R",
				person_id: alex,
				started: TODAY,
				ended: null,
				previous: prior[0]!.id,
			},
		],
	);
	assert.equal(await stageOf(alex), "leader");
	assert.equal(ok(await c.reactivate(R.id, { personId: alex })).outcome, "noop");
	assert.deepEqual(await holders(), [alex]);
	const history = ok(await teamsReader.listMembers(db, await c.viewer(), { teamId: T.id })).history;
	assert.equal(history.filter((m) => m.personId === alex).length, 2);
	assert.equal(
		ok(await teamsReader.listHistory(db, await c.viewer(), { teamId: T.id })).entries.every(
			(e) => e.actorName === "Alex Admin",
		),
		true,
	);
});

test("AC:TARGET-TEAM-006 returning to a leadership role leads a ministry that has no leader, and replaces none", async () => {
	const c = await church();
	const T = await c.team("Returning");
	const lead = await c.role(T.id, "Lead", { leadership: true });
	const alex = await c.person("Alex", { stage: "leader" });
	const casey = await c.person("Casey", { stage: "leader" });
	ok(await c.assign(lead, alex));
	ok(await c.removeRole(lead.id, { personId: alex }));
	assert.deepEqual(await leaderOf(T.id), { person: null, source: null });
	ok(await c.reactivate(lead.id, { personId: alex }));
	assert.deepEqual(await leaderOf(T.id), { person: alex, source: "role_derived" });
	ok(await c.removeRole(lead.id, { personId: alex }));
	ok(await c.appoint(T.id, { personId: casey }));
	ok(await c.reactivate(lead.id, { personId: alex }));
	assert.deepEqual(await leaderOf(T.id), { person: casey, source: "explicit" });
});

test("AC:TARGET-TEAM-012 the chart and both exports show this church's current ministries under Leadership, with whole names and no private ids", async () => {
	const c = await church();
	const alone = await c.team("Leadership");
	const chart = async (input: object = {}, who?: Actor) =>
		ok(await teamsReader.readOrgChart(db, await c.viewer(who), input)).nodes;
	assert.deepEqual(
		(await chart()).map((node) => [node.name, node.parentId]),
		[["Leadership", null]],
	);
	ok(await c.run(teamsWriter.initialize, c.importing([{ teamKey: "leadership", roleKeys: ["senior_pastor"] }])));
	const root = (await chart()).find((node) => node.templateKey === "leadership")!;
	ok(await c.edit(root.id, { name: "Elders" }));
	const long = "W".repeat(200);
	const wide = await c.team(long);
	const unsafe = await c.team(`<script>alert("x")</script>`);
	const gone = await c.team("Closed");
	ok(await c.archive(gone.id));
	const lead = await c.role(wide.id, "Lead", { leadership: true });
	const open = await c.role(wide.id, "Open seat");
	ok(await c.assign(lead, await c.person("Alex", { stage: "leader", account: c.M.id })));
	const foreign = ok(await c.create({ name: "Q-Team" }, c.B)).team;

	const placed = (nodes: Awaited<ReturnType<typeof chart>>) =>
		nodes.map((node) => [node.id, node.name, node.parentId, node.archived, node.leaderName]);
	const current = [
		[alone.id, "Leadership", root.id, false, null],
		[root.id, "Elders", null, false, null],
		[wide.id, long, root.id, false, "Alex"],
		[unsafe.id, `<script>alert("x")</script>`, root.id, false, null],
	];
	assert.deepEqual(placed(await chart()), current);
	assert.deepEqual(placed(await chart({}, c.M)), current);
	const all = [...current, [gone.id, "Closed", root.id, true, null]];
	assert.deepEqual(placed(await chart({ includeArchived: true })), all);
	assert.deepEqual(
		(await chart({}, c.B)).map((node) => node.id),
		[foreign.id],
	);
	refused(await teamsReader.readOrgChart(db, await c.viewer(), { teamId: foreign.id }), "invalid_input");
	refused(await teamsReader.get(db, await c.viewer(), { teamId: foreign.id }), "access_denied");
	const single = ok(await teamsReader.get(db, await c.viewer(), { teamId: wide.id }));
	assert.deepEqual(
		[single.team.name, single.team.leaderName, single.roles.map((r) => [r.id, r.name, r.occupantName])],
		[
			long,
			"Alex",
			[
				[lead.id, "Lead", "Alex"],
				[open.id, "Open seat", null],
			],
		],
	);

	const [exported, labelled] = await nothingChanges(async () => [
		ok(await teamsReader.readOrgChartExport(db, await c.viewer(), {})),
		ok(await teamsReader.readOrgChartExport(db, await c.viewer(c.M), { includeArchived: true })),
	]);
	assert.ok(exported && labelled);
	assert.equal(exported.format, "pdf");
	assert.equal(exported.pdf.startsWith("%PDF-1.4"), true);
	assert.deepEqual(placed(exported.nodes), current);
	assert.deepEqual(Object.keys(exported).sort(), ["format", "lines", "nodes", "pdf", "svg"]);
	for (const node of [...exported.nodes, ...labelled.nodes])
		assert.deepEqual(Object.keys(node).sort(), ["archived", "id", "leaderName", "name", "parentId", "templateKey"]);
	assert.deepEqual(exported.lines, [
		"Organization",
		"Leadership",
		"Elders",
		...["W".repeat(42), "W".repeat(42), "W".repeat(42), "W".repeat(42), "W".repeat(32)],
		"Leader: Alex",
		`<script>alert("x")</script>`,
	]);
	assert.deepEqual(labelled.lines, [...exported.lines, "Closed (archived)"]);
	const drawn = (svg: string) =>
		[...svg.matchAll(/<text [^>]*>(.*?)<\/text>/g)].map((m) =>
			m[1]!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
		);
	const printed = (pdf: string) =>
		[...pdf.matchAll(/^\((.*)\) Tj$/gm)].map((m) => m[1]!.replaceAll(/\\([()\\])/g, "$1"));
	for (const artifact of [exported, labelled]) {
		assert.deepEqual(drawn(artifact.svg), artifact.lines);
		assert.deepEqual(printed(artifact.pdf), artifact.lines);
		assert.equal(artifact.svg.includes("<script"), false);
	}
	const bytes = JSON.stringify([exported, labelled]);
	for (const secret of [c.A.id, c.M.id, c.M.email, foreign.id, "Q-Team", "private/", "opaque"])
		assert.equal(bytes.includes(secret), false, secret);
	assert.equal(
		JSON.stringify(ok(await teamsReader.readOrgChartExport(db, await c.viewer(c.B), {}))).includes("Q-Team"),
		true,
	);
	const held = await c.viewer(c.M);
	ok(await teamsReader.readOrgChartExport(db, held, {}));
	await (
		await c.removeSeat(c.M)
	)();
	refused(await teamsReader.readOrgChartExport(db, held, {}), "unavailable");
	refused(await teamsReader.readOrgChartExport(db, await c.forged(), {}), "unavailable");
});

const SECRET = "PRIVATE-BACKGROUND";
const SAFETY = /background|clearance|safety|penalty|rotation/i;
async function anywhere(text: string) {
	const { rows } = await admin.execute<{ table_name: string }>(
		sql`SELECT table_name FROM information_schema.tables WHERE table_schema=${database.schema} AND table_type='BASE TABLE'`,
	);
	const found = [];
	for (const { table_name } of rows)
		if (
			(await n(
				sql`SELECT count(*)::int AS n FROM ${sql.identifier(table_name)} x WHERE x::text LIKE ${"%" + text + "%"}`,
			)) > 0
		)
			found.push(table_name);
	return found;
}
const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const adapter = (operation: string) =>
	Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === operation) as unknown as ReadAdapter<unknown>;
function listsMinistries() {
	const base = scriptedModel();
	const seen: unknown[] = [];
	const model: LanguageModelV4 = {
		...base,
		async doStream(options) {
			for (const message of options.prompt)
				for (const part of message.role === "tool" ? message.content : [])
					if (part.type === "tool-result" && part.output.type === "json") seen.push(part.output.value);
			if (options.responseFormat?.type === "json" || options.prompt.some((m) => m.role === "tool"))
				return base.doStream(options);
			return {
				stream: new ReadableStream({
					start(stream) {
						const input = JSON.stringify({ operation: "teams.list", input: {} });
						stream.enqueue({ type: "tool-call", toolCallId: key(), toolName: "teams_read", input });
						stream.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
						stream.close();
					},
				}),
			};
		},
	};
	return { model: { ...scriptedQualifiedModel(), model }, seen };
}
async function childrens(c: Awaited<ReturnType<typeof church>>) {
	ok(
		await c.run(teamsWriter.initialize, c.importing([{ teamKey: "childrens_ministry", roleKeys: ["childrens_lead"] }])),
	);
	const [team] = (await c.list()).items;
	assert.ok(team);
	assert.equal(ok(await c.edit(team.id, { name: "Hospitality" })).stableKey, "childrens_ministry");
	const role = await one<{ id: string; teamId: string }>(
		sql`SELECT id, team_id AS "teamId" FROM team_role WHERE team_id=${team.id}`,
	);
	return { team, role };
}

test("AC:TARGET-TEAM-014 AC:GAP-TEAM-014 a renamed children's ministry, the people CSV and Evry hold no background check, and no safety or rotation operation exists", async () => {
	const c = await church();
	const { team, role } = await childrens(c);
	const csv = `first_name,last_name,email,background_check,notes\r\nAlex,Rivera,alex@example.test,${SECRET},Likes music\r\n`;
	const file = new TextEncoder().encode(csv);
	const authority = await c.viewer();
	const preview = ok(
		await gatedTransaction(db, (t) => peopleCsv.previewImport(t, new PeopleReadContext(authority), { file })),
	);
	assert.deepEqual(preview.columns.ignored, ["background_check"]);
	ok(
		await executeBulkImport(db, authority, {
			requestKey: key(),
			file,
			fileDigest: preview.fileDigest,
			reviewDigest: preview.reviewDigest,
			choices: [{ row: 1, choice: "create" }],
		}),
	);
	await runDueImports(db, 10);
	const alex = await one<{ id: string }>(sql`SELECT id FROM person WHERE plant_id=${c.P.id}`);
	assert.deepEqual(await anywhere("Likes music"), ["person"]);
	assert.deepEqual(await anywhere(SECRET), []);
	ok(await c.editRole(role.id, { desiredSkills: "guitar" }));
	ok(await c.assign(role, alex.id));

	const page = await c.list();
	assert.deepEqual(
		page.items.map((t) => ({ id: t.id, name: t.name })),
		[{ id: team.id, name: "Hospitality" }],
	);
	const assignments = ok(await teamsReader.listPersonAssignments(db, authority, { personId: alex.id })).assignments;
	assert.deepEqual(
		assignments.map((a) => [a.teamName, a.desiredSkills]),
		[["Hospitality", "guitar"]],
	);
	const health = ok(await trainingReader.readHealth(db, authority, { teamId: team.id }));
	assert.deepEqual([health.staffingRate, health.trainingRate, health.composite], [1, null, null]);
	const exported = ok(
		await gatedTransaction(db, (t) => peopleCsv.exportPeople(t, new PeopleReadContext(authority), {})),
	).text;
	assert.equal(exported.includes("Rivera"), true);
	const reads = {
		page,
		assignments,
		health,
		exported,
		detail: ok(await teamsReader.get(db, authority, { teamId: team.id })),
		roles: ok(await teamsReader.listRoles(db, authority, { teamId: team.id })),
		members: ok(await teamsReader.listMembers(db, authority, { teamId: team.id })),
		history: ok(await teamsReader.listHistory(db, authority, { teamId: team.id })),
		chart: ok(await teamsReader.readOrgChartExport(db, authority, {})),
		catalog: ok(await teamsReader.listImportTemplates(db, authority, {})),
		matrix: ok(await trainingReader.readTrainingMatrix(db, authority, { teamId: team.id })),
	};
	for (const [name, value] of Object.entries(reads)) assert.equal(SAFETY.test(JSON.stringify(value)), false, name);
	refused(
		await nothingChanges(() => teamsReader.list(db, authority, { background_check: "passed" })),
		"unsupported_filter",
	);
	const forged = await nothingChanges(async () => [
		await c.createRole({ teamId: team.id, name: "Nursery", backgroundCheck: "required" }),
		await c.editRole(role.id, { backgroundCheck: "required" }),
		await c.edit(team.id, { backgroundCheck: "required" }),
		await teamsReader.listPersonAssignments(db, authority, { personId: alex.id, background_check: "passed" }),
	]);
	for (const reply of forged) refused(reply, "invalid_input");
	ok(await c.createRole({ teamId: team.id, name: "Nursery" }));

	const evry = evryActor(authority);
	const ask = (operation: string, input: object) =>
		invokeRead(db, evry, adapter(operation), adapter(operation).input.parse(input));
	assert.deepEqual(
		(await ask("teams.list", {})).rows.map((r) => [r.id, r.label]),
		[[team.id, "Hospitality"]],
	);
	const shown = (await ask("teams.personAssignments", { personId: alex.id })).rows;
	assert.equal(shown.length, 1);
	assert.equal(SAFETY.test(JSON.stringify(shown)), false);
	assert.equal(adapter("teams.list").input.safeParse({ background_check: "passed" }).success, false);
	assert.equal(
		Object.values(READ_DOMAINS)
			.flat()
			.some((a) => SAFETY.test(a.operation)),
		false,
	);
	const lease = { turnId: key(), tenantId: c.P.id, leaseOwner: key(), generation: 1 };
	for (const operation of ["teams.recordBackgroundCheck", "teams.scheduleRotation", "teams.setChildRatio"])
		await nothingChanges(() =>
			assert.rejects(
				prepareProposal(db, evry, lease as never, key(), { operation, input: { teamId: team.id } }),
				(e: unknown) => e instanceof EvryRefusal && e.code === "invalid_input",
				operation,
			),
		);
	const told = harness(db, NOW);
	const answer = await told.ask(evry, "What is Alex Rivera's background check status in the children's ministry?");
	assert.deepEqual(
		[answer.reads, answer.proposals, answer.answer],
		[[], [], "Everyfield doesn't track background checks, so I have nothing to look up for that."],
	);
	const found = await told.ask(evry, "Find Alex");
	assert.equal(found.reads.includes("people.listPeople"), true);
	assert.equal(found.results.includes("Alex Rivera"), true);
	assert.deepEqual(await anywhere(SECRET), []);
});

test("AC:GAP-TEAM-014 another church's member and an unavailable source learn nothing of the ministry list and write nothing", async () => {
	const c = await church();
	const { team } = await childrens(c);
	const stranger = await c.viewer(c.F);
	const denied = await nothingChanges(async () => ({
		list: ok(await teamsReader.list(db, stranger, { includeArchived: true })),
		plant: await teamsReader.list(db, stranger, { plant: c.P.id }),
		forged: await teamsReader.list(db, RequestActor.of(c.F.session, (await c.viewer()).actor), {}),
		get: await teamsReader.get(db, stranger, { teamId: team.id }),
		guessed: await teamsReader.get(db, stranger, { teamId: key() }),
	}));
	assert.deepEqual(denied.list, { items: [], ordinaryIds: [], archivedIds: [] });
	refused(denied.plant, "invalid_input");
	refused(denied.forged, "unavailable");
	refused(denied.get, "access_denied");
	refused(denied.guessed, "unavailable");
	assert.equal(JSON.stringify(denied).includes("Hospitality"), false);

	const held = await c.viewer();
	const { model, seen } = listsMinistries();
	const told = harness(db, NOW, null, { model });
	const asked = async () => {
		seen.length = 0;
		await told.ask(evryActor(held), "List our ministries");
		return [...seen];
	};
	assert.equal(JSON.stringify(await asked()).includes("Hospitality"), true);
	await nothingChanges(() => hidden("team", () => assert.rejects(teamsReader.list(db, held, {}), /Failed query/)));
	const domain = await structure(c.P.id);
	const failed = await recorded(admin, () => hidden("team_tenure", () => asked()));
	assert.deepEqual(failed.value, [{ error: "source_unavailable", operation: "teams.list" }]);
	assert.deepEqual([failed.added.notices, failed.added.mail], [0, 0]);
	assert.deepEqual(await structure(c.P.id), domain);
	assert.deepEqual((await c.list()).ordinaryIds, [team.id]);
});

test("AC:GAP-TEAM-002 a live ministry's archive keeps its members' history, a restore brings it back, and a refused or failed archive changes nothing", async () => {
	const c = await church();
	const T = await c.team("Hospitality");
	const [host, greeter] = [await c.role(T.id, "Host"), await c.role(T.id, "Greeter")];
	const alex = await c.person("Alex");
	const casey = await c.person("Casey", { stage: "leader" });
	ok(await c.assign(host, alex));
	ok(await c.assign(greeter, casey));
	const tenure = await one<{ id: string; r: string }>(
		sql`SELECT id, revision::text AS r FROM team_tenure WHERE role_id=${host.id}`,
	);
	ok(
		await c.run(teamsWriter.correctTenure, {
			requestKey: key(),
			expectedRevision: tenure.r,
			input: { tenureId: tenure.id, startedOn: "2026-10-01", endedOn: null, reason: "Joined earlier" },
		}),
	);
	ok(await c.removeRole(greeter.id, { personId: casey }));
	const program = ok(
		await c.run(trainingWriter.createProgram, {
			requestKey: key(),
			input: { name: "Host training", required: true, teamId: T.id },
		}),
	).program.id;
	const required = ok(
		await trainingReader.readRequiredTrainingPreview(db, await c.viewer(), { programId: program, personIds: [alex] }),
	);
	ok(
		await c.run(trainingWriter.setRequiredTrainingParticipants, {
			requestKey: key(),
			expectedRevision: required.revision,
			input: { programId: program, personIds: [alex], rosterDigest: required.rosterDigest },
		}),
	);
	ok(
		await c.run(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await c.revision("training_program", program),
			input: { kind: "program", personId: alex, programId: program, earnedOn: "2026-10-05" },
		}),
	);
	const joined = async () =>
		ok(await teamsReader.listPersonAssignments(db, await c.viewer(), { personId: alex })).assignments.map((a) => [
			a.teamName,
			a.startedOn,
			a.endedOn,
		]);
	const past = async () =>
		ok(await teamsReader.listMembers(db, await c.viewer(), { teamId: T.id })).history.map((m) => [
			m.name,
			m.startedOn,
			m.endedOn,
		]);
	const kept = async () => ({
		tenure: (await admin.execute(sql`SELECT * FROM team_tenure WHERE plant_id=${c.P.id} ORDER BY id`)).rows,
		roles: (await admin.execute(sql`SELECT * FROM team_role WHERE plant_id=${c.P.id} ORDER BY id`)).rows,
		credit: (await admin.execute(sql`SELECT * FROM training_credit WHERE plant_id=${c.P.id}`)).rows,
		joined: await joined(),
		past: await past(),
	});
	const base = await kept();
	assert.deepEqual(
		[base.joined, base.past, base.credit.length],
		[[["Hospitality", "2026-10-01", null]], [["Casey", TODAY, TODAY]], 1],
	);
	const ids = async () => {
		const page = await c.list({ includeArchived: true });
		return [page.ordinaryIds, page.archivedIds];
	};
	const archive = async (requestKey = key()) => ({
		requestKey,
		expectedRevision: await c.revision("team", T.id),
		input: { teamId: T.id },
	});
	const request = await archive();
	for (const [who, plant, code] of [
		[c.F, c.Q, "access_denied"],
		[c.F, c.P, "unavailable"],
		[c.B, c.Q, "unavailable"],
		[c.M, c.P, "access_denied"],
	] as const) {
		const error = refused(
			await nothingChanges(() => c.run(teamsWriter.archive, { ...request, requestKey: key() }, who, plant)),
			code,
		);
		assert.equal(JSON.stringify(error).includes("Hospitality"), false);
	}
	for (const broken of [
		() => failingWrite(admin, { on: "audit_event", event: "INSERT" }, () => c.run(teamsWriter.archive, request)),
		() => hidden("team_tenure", () => c.run(teamsWriter.archive, request)),
	]) {
		refused(await nothingChanges(broken), "required_write_failed");
	}
	assert.deepEqual(await ids(), [[T.id], []]);

	const done = await recorded(admin, () => c.run(teamsWriter.archive, request));
	assert.equal(ok(done.value).outcome, "changed");
	assert.deepEqual(done.added, QUIET);
	assert.deepEqual(await ids(), [[], [T.id]]);
	assert.deepEqual(await kept(), base);
	assert.equal(await n(sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${alex}`), 1);
	for (const [who, plant, code] of [
		[c.F, c.Q, "access_denied"],
		[c.M, c.P, "access_denied"],
	] as const)
		refused(await nothingChanges(async () => c.restore(T.id, {}, who, plant)), code);
	refused(
		await nothingChanges(() =>
			failingWrite(admin, { on: "audit_event", event: "INSERT" }, async () => c.restore(T.id)),
		),
		"required_write_failed",
	);
	const back = await recorded(admin, async () => c.restore(T.id));
	assert.equal(ok(back.value).outcome, "changed");
	assert.deepEqual(back.added, QUIET);
	assert.deepEqual(await ids(), [[T.id], []]);
	assert.deepEqual(await kept(), base);
	assert.equal(await n(sql`SELECT count(*)::int AS n FROM team_tenure WHERE person_id=${alex}`), 1);
	assert.deepEqual((await recorded(admin, () => c.run(teamsWriter.archive, request))).added, NOTHING);
});
