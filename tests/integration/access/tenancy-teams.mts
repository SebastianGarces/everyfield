// The teams reads of INV-tenancy (tenancy.test.mts), with the teams/responsibilities and teams/training subfolders:
// church A's ministry, written through the teams writes as its owner, and one case per read.
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

const GLOBAL = "00000000-0000-0000-0000-000000000000";

/**
 * The Worship ministry from the setup catalog, renamed with a reason, with a role, a leader, a member, a responsibility
 * and a required training program that Avery completed.
 */
export async function seedTeams(t) {
	const { a, MARK, key, ok } = t;
	const db = t.f.db;
	const write = (op, input) => withTeamsWrite(db, t.ownerA.actor, (tx, c) => op(tx, c, input));
	const read = async (op, input) => ok(await op(db, t.ownerA.actor, input));
	const revision = async (teamId) => (await read(teamsReader.readRevision, { teamId })).revision;

	const setup = { expectedVersion: "2", mode: "import", selections: [{ teamKey: "worship", roleKeys: [] }] };
	ok(
		await write(teamsWriter.initialize, {
			requestKey: key(),
			input: setup,
		}),
	);
	a.ministry = (await read(teamsReader.list, {})).items.find((team) => team.templateKey === "worship").id;
	ok(
		await write(teamsWriter.edit, {
			requestKey: key(),
			expectedRevision: await revision(a.ministry),
			input: { teamId: a.ministry, name: `${MARK} worship`, description: `${MARK} ministry`, reason: `${MARK} why` },
		}),
	);
	const role = ok(
		await write(teamsWriter.createRole, {
			requestKey: key(),
			input: { teamId: a.ministry, name: `${MARK} singer`, desiredSkills: `${MARK} skills` },
		}),
	).role;
	ok(
		await write(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: role.revision,
			input: { roleId: role.id, teamId: a.ministry, personId: a.blair },
		}),
	);
	ok(
		await write(teamsWriter.appointLeader, {
			requestKey: key(),
			expectedRevision: await revision(a.ministry),
			input: { teamId: a.ministry, personId: a.avery },
		}),
	);

	// Raw rows because the shared reference library is installed by the reference release, not by any church write:
	// the Worship playbook version a ministry's responsibilities are filed under (as responsibilities.test.mts seeds it).
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
	ok(
		await write(responsibilityWriter.addResponsibility, {
			requestKey: key(),
			expectedRevision: await revision(a.ministry),
			input: { teamId: a.ministry, text: `${MARK} bring the keys` },
		}),
	);

	a.program = ok(
		await write(trainingWriter.createProgram, {
			requestKey: key(),
			input: { name: `${MARK} program`, required: true, teamId: a.ministry },
		}),
	).program.id;
	const roster = await read(trainingReader.readRequiredTrainingPreview, {
		programId: a.program,
		personIds: [a.avery, a.blair],
	});
	ok(
		await write(trainingWriter.setRequiredTrainingParticipants, {
			requestKey: key(),
			expectedRevision: roster.revision,
			input: { programId: a.program, personIds: roster.personIds, rosterDigest: roster.rosterDigest },
		}),
	);
	const program = (await read(trainingReader.listTraining, {})).programs.find((g) => g.id === a.program);
	ok(
		await write(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: program.revision,
			input: { kind: "program", personId: a.avery, programId: a.program, earnedOn: t.occurredOn },
		}),
	);
}

/** The teams cases for `who`: church B's owner for the tenancy check, church A's owner for the control. */
export function teamsCases(t, who) {
	const { a, MARK } = t;
	const db = t.f.db;
	const op = (area, reader) => (name, input, expected) => [
		`teams:${area}.${name}`,
		{ run: () => reader[name](db, who.actor, input), expected },
	];
	const tm = op("teamsReader", teamsReader);
	const tr = op("trainingReader", trainingReader);
	const rs = op("responsibilityReader", responsibilityReader);
	const unavailable = { refused: "unavailable" };
	// A ministry, program or Person another church owns: the teams reads refuse it as theirs to deny (as the teams
	// suites assert for a foreign church), where a missing one reads as unavailable.
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
		tm(
			"listImportTemplates",
			{},
			{
				// The same fixed catalog for every church; church A's own owner reads it unchanged.
				value: catalog,
				control: (value) => assert.deepEqual(value, catalog),
			},
		),
		tm("list", {}, { value: { items: [], ordinaryIds: [], archivedIds: [] } }),
		tm("listHistory", ministry, denied),
		tm("listRoles", ministry, denied),
		tm("readRevision", ministry, denied),
		tm("listMembers", ministry, denied),
		tm("listPersonAssignments", { personId: a.blair }, denied),
		tm("listLeaderCandidates", { q: MARK }, { value: { people: [] } }),
		tm("readOrgChart", {}, { value: { nodes: [] } }),
		tm("get", ministry, denied),
		tm("searchMembers", { q: MARK }, { value: { items: [], completeness: "complete" } }),
		tm("staffingSummary", {}, { value: { teams: [], roles: 0, filledRoles: 0, openRoles: 0, people: 0 } }),
		tm("personTeamCounts", { minTeams: 1 }, { value: { minTeams: 1, people: [] } }),
		tm(
			"previewTemplateImport",
			{ selections: [{ teamKey: "worship", roleKeys: [] }] },
			{
				// Church B has no Worship ministry yet; church A's own owner sees the one it imported.
				value: {
					teams: [{ key: "worship", name: "Worship", exists: false, newRoles: [], existingRoles: [] }],
					newTeams: 1,
					newRoles: 0,
				},
				control: (value) => assert.equal(value.teams[0].exists, true),
			},
		),
		// The export also carries the generated PDF and SVG of the empty chart.
		tm("readOrgChartExport", {}, { partial: { format: "pdf", lines: [], nodes: [] } }),

		rs("listResponsibilities", ministry, unavailable),
		rs("previewResponsibilities", ministry, unavailable),

		tr("listTraining", ministry, { value: { programs: [] } }),
		tr("readRequiredTrainingPreview", { programId: a.program, personIds: [a.avery] }, denied),
		tr("readTrainingMatrix", ministry, { value: { programs: [] } }),
		tr("readPersonTraining", { personId: a.avery }, denied),
		tr("readTrainingHistory", { personId: a.avery }, denied),
		tr("readStaffingFacts", ministry, denied),
		tr("readHealth", ministry, denied),
		tr("readAggregateHealth", {}, { value: { teams: [], measuredTeams: 0, totalTeams: 0, composite: null } }),
		tr("readRequiredTrainingParticipants", { programId: a.program }, denied),
	];
}
