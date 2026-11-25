import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import "../../platform/setup.mts";
import { sql } from "../../../../packages/db/src/query.ts";
import { meetingsWriter, rosterReader } from "../../../../packages/domain/src/meetings/index.ts";
import { documentsReader } from "../../../../packages/domain/src/documents/index.ts";
import { getPlant, listPlants } from "../../../../packages/domain/src/oversight/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	withTeamsWrite,
} from "../../../../packages/domain/src/teams/index.ts";
import type { TeamsContext } from "../../../../packages/domain/src/teams/core.ts";
import type { WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { ok } from "../../../support/fixture.mts";
import { key, world, type Feature, type World } from "./corrections-world.mts";

let w: World;
before(async () => {
	w = await world("corrteam");
});
after(() => w?.database.close());

test("INV-corrections: moving a person off the wrong team moves every roster, chart, count, audience, training, document, Plant Intelligence, oversight and Evry read, keeps the old place in history and rewrites nothing sent", async () => {
	const { actor } = w.boss;
	const teams = <T,>(op: (tx: WriteTx, c: TeamsContext, raw: unknown) => Promise<T>, raw: unknown) =>
		withTeamsWrite(w.db, actor, (tx, c) => op(tx, c, raw) as never) as Promise<T>;
	const casey = await w.committed(w.p, "Casey Cole", 60, {
		adultClassification: "adult",
		email: "casey@example.test",
	});
	const { version } = ok(await teamsReader.listImportTemplates(w.db, actor, {}));
	ok(
		await teams(teamsWriter.initialize, {
			requestKey: key(),
			input: {
				expectedVersion: version,
				mode: "import",
				selections: [
					{ teamKey: "leadership", roleKeys: ["senior_pastor"] },
					{ teamKey: "worship", roleKeys: ["worship_lead"] },
				],
			},
		}),
	);
	const roleOf = (template: string) =>
		w.one<{ id: string; team: string }>(
			sql`SELECT id,team_id AS team FROM team_role WHERE plant_id=${w.p.id} AND template_key=${template}`,
		);
	const pastor = await roleOf("senior_pastor");
	const worship = await roleOf("worship_lead");
	const assign = async (role: typeof pastor) =>
		ok(
			await teams(teamsWriter.assignRole, {
				requestKey: key(),
				expectedRevision: await w.revision("team_role", role.id),
				input: { roleId: role.id, teamId: role.team, personId: casey.id },
			}),
		);
	await assign(pastor);
	await w.admin
		.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,people_step)
		VALUES(${w.p.id},${w.boss.id},(SELECT id FROM audit_event WHERE tenant_id=${w.p.id} ORDER BY occurred_at LIMIT 1),
		${JSON.stringify({ answer: "yes", assignment: { roleId: pastor.id } })}::jsonb,'{}'::jsonb,'{}'::jsonb,'skipped')`);
	const rehearsal = async (teamId: string) =>
		ok(
			await w.meeting(meetingsWriter.schedule, {
				requestKey: key(),
				input: { type: "team_meeting", teamId, date: w.day(5), time: "18:00" },
			}),
		).meeting.id;
	const meetings = { leadership: await rehearsal(pastor.team), worship: await rehearsal(worship.team) };
	const agenda = { templateId: "vision-meeting-agenda" };
	ok(await w.document(agenda));
	const published = await w.publish({ teamIds: [pastor.team] });
	const unchanged = await w.freeze([
		"mail",
		"communication",
		"assessment_run",
		"network_intelligence_run",
		"network_intelligence_plant",
		"generated_document",
		"file_object",
		"audit_event",
	]);
	const rosterChange = async (meetingId: string) => {
		const r = ok(await rosterReader.previewRosterImport(w.db, actor, { meetingId }));
		return { add: r.add.map((x) => x.displayName), remove: r.remove.map((x) => x.displayName) };
	};
	const both = <T,>(f: (teamId: string) => Promise<T>) => Promise.all([f(pastor.team), f(worship.team)]);
	const features: Feature[] = [
		{
			name: "the team pages",
			read: () =>
				both(async (teamId) => {
					const t = ok(await teamsReader.get(w.db, actor, { teamId }));
					return [
						t.team.name,
						t.team.leaderName,
						t.team.activeCount,
						t.roles.map((r) => [r.name, r.occupantName]),
						t.members.map((m) => m.name),
					];
				}),
			before: [
				["Leadership", "Casey Cole", 1, [["Senior pastor", "Casey Cole"]], ["Casey Cole"]],
				["Worship", null, 0, [["Worship lead", null]], []],
			],
			after: [
				["Leadership", null, 0, [["Senior pastor", null]], []],
				["Worship", "Casey Cole", 1, [["Worship lead", "Casey Cole"]], ["Casey Cole"]],
			],
		},
		{
			name: "the team list",
			read: async () =>
				ok(await teamsReader.list(w.db, actor, {})).items.map((t) => [t.name, t.leaderName, t.activeCount]),
			before: [
				["Leadership", "Casey Cole", 1],
				["Worship", null, 0],
			],
			after: [
				["Leadership", null, 0],
				["Worship", "Casey Cole", 1],
			],
		},
		{
			name: "the role lists",
			read: () =>
				both(async (teamId) =>
					ok(await teamsReader.listRoles(w.db, actor, { teamId })).roles.map((r) => [r.name, r.occupantName]),
				),
			before: [[["Senior pastor", "Casey Cole"]], [["Worship lead", null]]],
			after: [[["Senior pastor", null]], [["Worship lead", "Casey Cole"]]],
		},
		{
			name: "the member search",
			read: async () =>
				ok(await teamsReader.searchMembers(w.db, actor, {})).items.map((i) => [i.name, i.teamName, i.roleName]),
			before: [["Casey Cole", "Leadership", "Senior pastor"]],
			after: [["Casey Cole", "Worship", "Worship lead"]],
		},
		{
			name: "the staffing summary",
			read: async () =>
				ok(await teamsReader.staffingSummary(w.db, actor, {})).teams.map((t) => [
					t.name,
					t.leaderName,
					t.filledRoles,
					t.openRoles,
					t.people,
				]),
			before: [
				["Leadership", "Casey Cole", 1, 0, 1],
				["Worship", null, 0, 1, 0],
			],
			after: [
				["Leadership", null, 0, 1, 0],
				["Worship", "Casey Cole", 1, 0, 1],
			],
		},
		{
			name: "the staffing health",
			read: () =>
				both(async (teamId) => {
					const h = ok(await trainingReader.readStaffingFacts(w.db, actor, { teamId }));
					return [h.filledSlots, h.openSlots, h.distinctPeople, h.staffingRate];
				}),
			before: [
				[1, 0, 1, 1],
				[0, 1, 0, 0],
			],
			after: [
				[0, 1, 0, 0],
				[1, 0, 1, 1],
			],
		},
		{
			name: "the organization chart",
			read: async () => ok(await teamsReader.readOrgChart(w.db, actor, {})).nodes.map((n) => [n.name, n.leaderName]),
			before: [
				["Leadership", "Casey Cole"],
				["Worship", null],
			],
			after: [
				["Leadership", null],
				["Worship", "Casey Cole"],
			],
		},
		{
			name: "the person's ministry roles",
			read: async () =>
				ok(await teamsReader.listPersonAssignments(w.db, actor, { personId: casey.id })).assignments.map((a) => [
					a.teamName,
					a.roleName,
					a.active,
				]),
			before: [["Leadership", "Senior pastor", true]],
			after: [
				["Worship", "Worship lead", true],
				["Leadership", "Senior pastor", false],
			],
		},
		{
			name: "the people on several teams",
			read: async () =>
				ok(await teamsReader.personTeamCounts(w.db, actor, { minTeams: 1 })).people.map((p) => [p.name, p.teamNames]),
			before: [["Casey Cole", ["Leadership"]]],
			after: [["Casey Cole", ["Worship"]]],
		},
		{
			name: "the person's training by team",
			read: async () => {
				const t = ok(await trainingReader.readPersonTraining(w.db, actor, { personId: casey.id }));
				return [t.currentTeams, t.formerTeams, t.concurrentAssignments];
			},
			before: [["Leadership"], [], 1],
			after: [["Worship"], ["Leadership"], 1],
		},
		{
			name: "the team meeting rosters",
			read: () =>
				Promise.all([meetings.leadership, meetings.worship].map(async (meetingId) => await rosterChange(meetingId))),
			before: [
				{ add: [], remove: [] },
				{ add: [], remove: [] },
			],
			after: [
				{ add: [], remove: ["Casey Cole"] },
				{ add: ["Casey Cole"], remove: [] },
			],
		},
		{
			name: "the message audience of each team",
			read: () =>
				both(async (teamId) => (await w.audience({ teamIds: [teamId] })).recipients.map((r) => r.displayName)),
			before: [["Casey Cole"], []],
			after: [[], ["Casey Cole"]],
		},
		{
			name: "a new document's pastor",
			read: async () =>
				ok(
					await documentsReader.resolveContext(w.db, actor, { ...agenda, format: "pdf", overrides: {} }),
				).fields.flatMap((f) => (f.key === "pastor_name" ? [[f.value, f.source]] : [])),
			before: [["Casey Cole", "pastor_name"]],
			after: [[null, "absent"]],
		},
		{
			name: "the oversight team counts and lead",
			read: async () => {
				const v = (await getPlant(w.db, w.director, w.p.id))!;
				return [
					v.sections.ministryTeams,
					v.plant.leadPlanter,
					v.launch.status === "shared" && v.launch.preparation.unfilledRoles,
				];
			},
			before: [
				{ status: "shared", counts: { teams: 2, roles: 2, rolesFilled: 1, trainingAssigned: 0, trainingComplete: 0 } },
				"Casey Cole",
				1,
			],
			after: [
				{ status: "shared", counts: { teams: 2, roles: 2, rolesFilled: 1, trainingAssigned: 0, trainingComplete: 0 } },
				null,
				0,
			],
		},
		{
			name: "the oversight directory",
			read: async () => (await listPlants(w.db, w.director))!.plants.map((x) => [x.name, x.leadPlanter]),
			before: [["Grace Harbor", "Casey Cole"]],
			after: [["Grace Harbor", null]],
		},
		{
			name: "Plant Intelligence facts",
			read: async () => {
				const f = await w.factsNow();
				return [
					f.coverage.filled,
					f.coverage.people,
					f.coverage.responsibilities.find((r) => r.key === "worship")?.people.map((x) => x.name),
					f.criteria.worship_leader,
				];
			},
			before: [0, 0, [], "unknown"],
			after: [1, 1, ["Casey Cole"], "met"],
		},
		{
			name: "Plant Intelligence freshness",
			read: async () => (await w.stale()) === published.run.runId,
			before: false,
			after: true,
		},
		{
			name: "Evry: the teams",
			read: async () => [
				...(await w.shown("teams.list", {}, ["leader", "people"])),
				...(await w.shown("teams.get", { teamId: pastor.team }, ["leader", "filledBy", "role"])),
				...(await w.shown("teams.get", { teamId: worship.team }, ["leader", "filledBy", "role"])),
				...(await w.shown("teams.searchMembers", {}, ["team", "role"])),
				...(await w.shown("teams.listRoles", { teamId: worship.team }, ["filledBy", "open"])),
				...(await w.shown("teams.orgChart", {}, ["leader"])),
				...(await w.shown("teams.personAssignments", { personId: casey.id }, ["team", "current", "ended"])),
				...(await w.shown("teams.staffingSummary", {}, ["filledRoles", "openRoles", "people"])),
				...(await w.shown("teams.personTraining", { personId: casey.id }, ["currentMinistries", "formerMinistries"])),
				...(await w.shown("teams.personTeamCounts", { minTeams: 1 }, ["names"])),
			],
			before: [
				["Leadership", "Casey Cole", 1],
				["Worship", null, 0],
				["Leadership", "Casey Cole", null, null],
				["Senior pastor", null, "Casey Cole", null],
				["Casey Cole", null, null, "Senior pastor"],
				["Worship", null, null, null],
				["Worship lead", null, null, null],
				["Casey Cole", "Leadership", "Senior pastor"],
				["Worship lead", null, true],
				["Leadership", "Casey Cole"],
				["Worship", null],
				["Senior pastor", "Leadership", true, null],
				["Leadership", 1, 0, 1],
				["Worship", 0, 1, 0],
				["Casey Cole", "Leadership", null],
				["Casey Cole", "Leadership"],
			],
			after: [
				["Leadership", null, 0],
				["Worship", "Casey Cole", 1],
				["Leadership", null, null, null],
				["Senior pastor", null, null, null],
				["Worship", "Casey Cole", null, null],
				["Worship lead", null, "Casey Cole", null],
				["Casey Cole", null, null, "Worship lead"],
				["Casey Cole", "Worship", "Worship lead"],
				["Worship lead", "Casey Cole", false],
				["Leadership", null],
				["Worship", "Casey Cole"],
				["Worship lead", "Worship", true, null],
				["Senior pastor", "Leadership", false, w.today],
				["Leadership", 0, 1, 0],
				["Worship", 1, 0, 1],
				["Casey Cole", "Worship", "Leadership"],
				["Casey Cole", "Worship"],
			],
		},
		{
			name: "Evry: the message audience",
			read: () =>
				both(async (teamId) =>
					(
						await w.evry("communication.preview", {
							subject: "Hello",
							body: "Hello",
							audience: { groups: [], teamIds: [teamId], personIds: [] },
						})
					).rows.map((r) => r.label),
				),
			before: [["Casey Cole"], []],
			after: [[], ["Casey Cole"]],
		},
		{
			name: "Evry: the oversight view",
			read: () => w.shown("oversight.getPlant", { plantId: w.p.id }, ["ministryTeams", "unfilledRoles"], w.director),
			before: [["Grace Harbor", "2 teams, 1 of 2 roles filled", 1]],
			after: [["Grace Harbor", "2 teams, 1 of 2 roles filled", 0]],
		},
	];
	await w.check(features, "before");

	ok(
		await teams(teamsWriter.removeRole, {
			requestKey: key(),
			expectedRevision: await w.revision("team_role", pastor.id),
			input: { roleId: pastor.id, personId: casey.id },
		}),
	);
	await assign(worship);

	await w.check(features, "after");
	const history = ok(await teamsReader.listHistory(w.db, actor, { teamId: pastor.team })).entries;
	assert.deepEqual(
		history
			.filter((e) => e.kind !== "create")
			.map((e) => [e.kind, e.about, e.before?.occupantPersonId, e.after?.occupantPersonId, e.actorName]),
		[
			["remove", { personName: "Casey Cole", roleName: "Senior pastor" }, casey.id, null, "Adam Admin"],
			["assign", { personName: "Casey Cole", roleName: "Senior pastor" }, null, casey.id, "Adam Admin"],
		],
	);
	assert.deepEqual(
		ok(await teamsReader.listMembers(w.db, actor, { teamId: pastor.team })).history.map((m) => [
			m.name,
			m.roleName,
			m.startedOn,
			m.endedOn,
		]),
		[["Casey Cole", "Senior pastor", w.today, w.today]],
	);
	assert.deepEqual(await w.shown("teams.history", { teamId: pastor.team }, ["person", "role", "by"]), [
		["remove", "Casey Cole", "Senior pastor", "Adam Admin"],
		["assign", "Casey Cole", "Senior pastor", "Adam Admin"],
		["create", null, null, "Adam Admin"],
	]);
	assert.deepEqual(await w.shown("teams.membershipHistory", { teamId: pastor.team }, ["role", "ended"]), [
		["Casey Cole", "Senior pastor", w.today],
	]);
	assert.deepEqual(
		(await w.auditOf(sql`subject_id=${pastor.id} AND kind='remove'`)).map((a) => [
			a.actor_id,
			a.before,
			a.after,
			a.recent,
		]),
		[[w.boss.id, { occupantPersonId: casey.id }, { occupantPersonId: null }, true]],
	);
	await unchanged();
});
