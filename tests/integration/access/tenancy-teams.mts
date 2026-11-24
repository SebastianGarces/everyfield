import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	TEMPLATES,
	responsibilityReader,
	responsibilityWriter,
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
	withTeamsWrite,
} from "../../../packages/domain/src/teams/index.ts";
import { casesFor, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";

export async function seedTeams(t: Tenancy) {
	const { a, MARK, key, ok } = t;
	const db = t.f.db;
	const write = <V,>(body: Parameters<typeof withTeamsWrite<V>>[2]) => withTeamsWrite(db, t.ownerA.actor, body);
	const revision = async (teamId: string) =>
		ok(await teamsReader.readRevision(db, t.ownerA.actor, { teamId })).revision;

	const setup = { expectedVersion: "2", mode: "import", selections: [{ teamKey: "worship", roleKeys: [] }] };
	ok(
		await write((tx, c) =>
			teamsWriter.initialize(tx, c, {
				requestKey: key(),
				input: setup,
			}),
		),
	);
	a.ministry = ok(await teamsReader.list(db, t.ownerA.actor, {})).items.find(
		(team) => team.templateKey === "worship",
	)!.id;
	const unedited = await revision(a.ministry);
	ok(
		await write((tx, c) =>
			teamsWriter.edit(tx, c, {
				requestKey: key(),
				expectedRevision: unedited,
				input: { teamId: a.ministry, name: `${MARK} worship`, description: `${MARK} ministry`, reason: `${MARK} why` },
			}),
		),
	);
	const role = ok(
		await write((tx, c) =>
			teamsWriter.createRole(tx, c, {
				requestKey: key(),
				input: { teamId: a.ministry, name: `${MARK} singer`, desiredSkills: `${MARK} skills` },
			}),
		),
	).role;
	ok(
		await write((tx, c) =>
			teamsWriter.assignRole(tx, c, {
				requestKey: key(),
				expectedRevision: role.revision,
				input: { roleId: role.id, teamId: a.ministry, personId: a.blair },
			}),
		),
	);
	const unled = await revision(a.ministry);
	ok(
		await write((tx, c) =>
			teamsWriter.appointLeader(tx, c, {
				requestKey: key(),
				expectedRevision: unled,
				input: { teamId: a.ministry, personId: a.avery },
			}),
		),
	);

	const release = randomUUID();
	const item = randomUUID();
	const token = randomUUID().replaceAll("-", "");
	await t.f.admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,
		chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${token},'memory',${token},'validated','0','none',1,${GLOBAL},0)`);
	await t.f.admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
		VALUES(${item},'ministry_template','worship',${GLOBAL})`);
	await t.f.admin.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,
		content_hash,source_credit) VALUES(${randomUUID()},${item},${release},1,'lines',${token},'test')`);
	const unassigned = await revision(a.ministry);
	ok(
		await write((tx, c) =>
			responsibilityWriter.addResponsibility(tx, c, {
				requestKey: key(),
				expectedRevision: unassigned,
				input: { teamId: a.ministry, text: `${MARK} bring the keys` },
			}),
		),
	);

	a.program = ok(
		await write((tx, c) =>
			trainingWriter.createProgram(tx, c, {
				requestKey: key(),
				input: { name: `${MARK} program`, required: true, teamId: a.ministry },
			}),
		),
	).program.id;
	const roster = ok(
		await trainingReader.readRequiredTrainingPreview(db, t.ownerA.actor, {
			programId: a.program,
			personIds: [a.avery, a.blair],
		}),
	);
	ok(
		await write((tx, c) =>
			trainingWriter.setRequiredTrainingParticipants(tx, c, {
				requestKey: key(),
				expectedRevision: roster.revision,
				input: { programId: a.program, personIds: roster.personIds, rosterDigest: roster.rosterDigest },
			}),
		),
	);
	const program = ok(await trainingReader.listTraining(db, t.ownerA.actor, {})).programs.find(
		(g) => g.id === a.program,
	);
	ok(
		await write((tx, c) =>
			trainingWriter.attestCompletion(tx, c, {
				requestKey: key(),
				expectedRevision: program!.revision,
				input: { kind: "program", personId: a.avery, programId: a.program, earnedOn: t.occurredOn },
			}),
		),
	);
}

export function teamsCases(t: Tenancy, who: TenancyOwner) {
	const { a, MARK } = t;
	const db = t.f.db;
	const tm = casesFor("teams:teamsReader.");
	const tr = casesFor("teams:trainingReader.");
	const rs = casesFor("teams:responsibilityReader.");
	const unavailable = { refused: "unavailable" };
	const denied = { refused: "access_denied" };
	const ministry = { teamId: a.ministry };
	const catalog = {
		version: "2",
		teams: TEMPLATES.map((team) => ({
			key: team.key,
			name: team.name,
			roles: team.roles.map((role) => ({ key: role.key, name: role.name, leadership: role.leadership })),
		})),
		newTenantRows: 0,
	};
	return [
		tm("listImportTemplates", () => teamsReader.listImportTemplates(db, who.actor, {}), {
			value: catalog,
			control: (value) => assert.deepEqual(value, catalog),
		}),
		tm("list", () => teamsReader.list(db, who.actor, {}), { value: { items: [], ordinaryIds: [], archivedIds: [] } }),
		tm("listHistory", () => teamsReader.listHistory(db, who.actor, ministry), denied),
		tm("listRoles", () => teamsReader.listRoles(db, who.actor, ministry), denied),
		tm("readRevision", () => teamsReader.readRevision(db, who.actor, ministry), denied),
		tm("listMembers", () => teamsReader.listMembers(db, who.actor, ministry), denied),
		tm("listPersonAssignments", () => teamsReader.listPersonAssignments(db, who.actor, { personId: a.blair }), denied),
		tm("listLeaderCandidates", () => teamsReader.listLeaderCandidates(db, who.actor, { q: MARK }), {
			value: { people: [] },
		}),
		tm("readOrgChart", () => teamsReader.readOrgChart(db, who.actor, {}), { value: { nodes: [] } }),
		tm("get", () => teamsReader.get(db, who.actor, ministry), denied),
		tm("searchMembers", () => teamsReader.searchMembers(db, who.actor, { q: MARK }), {
			value: { items: [], completeness: "complete" },
		}),
		tm("staffingSummary", () => teamsReader.staffingSummary(db, who.actor, {}), {
			value: { teams: [], roles: 0, filledRoles: 0, openRoles: 0, people: 0 },
		}),
		tm("personTeamCounts", () => teamsReader.personTeamCounts(db, who.actor, { minTeams: 1 }), {
			value: { minTeams: 1, people: [] },
		}),
		tm(
			"previewTemplateImport",
			() => teamsReader.previewTemplateImport(db, who.actor, { selections: [{ teamKey: "worship", roleKeys: [] }] }),
			{
				value: {
					teams: [{ key: "worship", name: "Worship", exists: false, newRoles: [], existingRoles: [] }],
					newTeams: 1,
					newRoles: 0,
				},
				control: (value) => assert.equal(value.teams[0]!.exists, true),
			},
		),
		tm("readOrgChartExport", () => teamsReader.readOrgChartExport(db, who.actor, {}), {
			partial: { format: "pdf", lines: [], nodes: [] },
		}),

		rs("listResponsibilities", () => responsibilityReader.listResponsibilities(db, who.actor, ministry), unavailable),
		rs(
			"previewResponsibilities",
			() => responsibilityReader.previewResponsibilities(db, who.actor, ministry),
			unavailable,
		),

		tr("listTraining", () => trainingReader.listTraining(db, who.actor, ministry), { value: { programs: [] } }),
		tr(
			"readRequiredTrainingPreview",
			() => trainingReader.readRequiredTrainingPreview(db, who.actor, { programId: a.program, personIds: [a.avery] }),
			denied,
		),
		tr("readTrainingMatrix", () => trainingReader.readTrainingMatrix(db, who.actor, ministry), {
			value: { programs: [] },
		}),
		tr("readPersonTraining", () => trainingReader.readPersonTraining(db, who.actor, { personId: a.avery }), denied),
		tr("readTrainingHistory", () => trainingReader.readTrainingHistory(db, who.actor, { personId: a.avery }), denied),
		tr("readStaffingFacts", () => trainingReader.readStaffingFacts(db, who.actor, ministry), denied),
		tr("readHealth", () => trainingReader.readHealth(db, who.actor, ministry), denied),
		tr("readAggregateHealth", () => trainingReader.readAggregateHealth(db, who.actor, {}), {
			value: { teams: [], measuredTeams: 0, totalTeams: 0, composite: null },
		}),
		tr(
			"readRequiredTrainingParticipants",
			() => trainingReader.readRequiredTrainingParticipants(db, who.actor, { programId: a.program }),
			denied,
		),
	];
}
