import * as c from "@everyfield/contracts/teams";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import type { AuditWrite } from "../operations/writes.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people/people.ts";
import { command, deny, next, parse, reply, type TeamsContext, type Tx, type Writer } from "./core.ts";
import { insertVersionLines } from "./responsibilities/store.ts";
import {
	catalogRole,
	catalogTeam,
	offerRemains,
	reviewDigest,
	TEMPLATE_VERSION,
	unknownSelection,
} from "./templates.ts";

const text = z.string().nullable();
const id = z.string().uuid();
const teamRow = z.object({
	id,
	revision: z.string(),
	name: z.string(),
	description: text,
	icon: text,
	templateKey: text,
	state: c.teamState,
	archived: z.boolean(),
	sortOrder: z.coerce.number().int(),
	leaderPersonId: id.nullable(),
	leaderSource: c.leaderSource.nullable(),
	leaderRoleId: id.nullable(),
	activeCount: z.coerce.number().int(),
});
type TeamRow = z.infer<typeof teamRow>;
type TeamPatch = {
	teamId: string;
	reason?: string;
	name?: string;
	description?: string | null;
	icon?: string | null;
	state?: TeamRow["state"];
};
const roleRow = z.object({
	id,
	revision: z.string(),
	teamId: id,
	name: z.string(),
	description: text,
	leadership: z.boolean(),
	timeCommitment: text,
	desiredSkills: text,
	templateKey: text,
	retired: z.boolean(),
	occupantPersonId: id.nullable(),
	occupantName: z.string().nullable(),
	previousTenureId: id.nullable(),
	teamArchived: z.boolean(),
	leaderPersonId: id.nullable(),
	leaderSource: c.leaderSource.nullable(),
	teamRevision: z.string(),
	stage: z.string().nullable(),
	personState: z.string().nullable(),
	personRevision: z.string().nullable(),
	pipelinePosition: z.string().nullable(),
	teamCount: z.coerce.number().int(),
});
type RoleRow = z.infer<typeof roleRow>;

const churchDate = (plantId: string) =>
	sql`(clock_timestamp() AT TIME ZONE (SELECT timezone FROM plant WHERE id = ${plantId}::uuid))::date`;
const keep = <T>(nextValue: T | undefined, previous: T) => (nextValue === undefined ? previous : nextValue);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const tuples = (rows: SQL[]) => sql.join(rows, sql`, `);

async function oneRow(tx: Tx, query: SQL) {
	const found = await tx.execute(query);
	return found.rows[0] as Record<string, unknown> | undefined;
}
async function lockTeam(tx: Tx, w: Writer, teamId: string): Promise<TeamRow> {
	const row = await oneRow(
		tx,
		sql`SELECT t.id, t.revision::text AS revision, t.name, t.description, t.icon,
			t.template_key AS "templateKey", t.state, (t.archived_at IS NOT NULL) AS archived,
			t.sort_order AS "sortOrder", t.leader_person_id AS "leaderPersonId",
			t.leader_source AS "leaderSource", t.leader_role_id AS "leaderRoleId",
			(SELECT count(*)::int FROM team_tenure tn
				JOIN team_role r ON r.id = tn.role_id
				JOIN person p ON p.id = tn.person_id AND p.state = 'live'
				WHERE r.team_id = t.id AND tn.ended_on IS NULL AND r.retired_at IS NULL) AS "activeCount"
			FROM team t WHERE t.id = ${teamId}::uuid AND t.plant_id = ${w.plant.id}::uuid FOR UPDATE`,
	);
	if (!row) {
		const other = await oneRow(tx, sql`SELECT 1 AS n FROM team WHERE id = ${teamId}::uuid`);
		if (other) deny("access_denied");
		deny();
	}
	return teamRow.parse(row);
}
async function lockRole(tx: Tx, w: Writer, roleId: string, personId: string | null): Promise<RoleRow> {
	const person = personId ?? "00000000-0000-0000-0000-000000000000";
	const row = await oneRow(
		tx,
		sql`SELECT r.id, r.revision::text AS revision, r.team_id AS "teamId", r.name, r.description, r.leadership,
			r.time_commitment AS "timeCommitment", r.desired_skills AS "desiredSkills",
			r.template_key AS "templateKey", (r.retired_at IS NOT NULL) AS retired,
			holder.person_id AS "occupantPersonId", holder.name AS "occupantName",
			prev.id AS "previousTenureId", (t.archived_at IS NOT NULL) AS "teamArchived",
			t.leader_person_id AS "leaderPersonId", t.leader_source AS "leaderSource",
			t.revision::text AS "teamRevision", person.stage, person.state AS "personState",
			person.revision AS "personRevision", person.position AS "pipelinePosition",
			(SELECT count(DISTINCT team_id)::int FROM (
				SELECT r2.team_id FROM team_tenure tn
				JOIN team_role r2 ON r2.id = tn.role_id
				WHERE tn.person_id = ${person}::uuid AND tn.ended_on IS NULL AND tn.plant_id = r.plant_id
				UNION SELECT r.team_id
			) counted) AS "teamCount"
			FROM team_role r
			JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
			LEFT JOIN LATERAL (
				SELECT tn.person_id, p.display_name AS name FROM team_tenure tn
				JOIN person p ON p.id = tn.person_id
				WHERE tn.role_id = r.id AND tn.ended_on IS NULL
			) holder ON true
			LEFT JOIN LATERAL (
				SELECT tn.id FROM team_tenure tn
				WHERE tn.role_id = r.id AND tn.person_id = ${person}::uuid AND tn.ended_on IS NOT NULL
				ORDER BY tn.ended_on DESC, tn.id DESC LIMIT 1
			) prev ON true
			LEFT JOIN LATERAL (
				SELECT stage, state, revision::text AS revision, pipeline_position::text AS position
				FROM person
				WHERE person.id = ${person}::uuid AND person.tenant_id = r.plant_id
				FOR UPDATE
			) person ON true
			WHERE r.id = ${roleId}::uuid AND r.plant_id = ${w.plant.id}::uuid
			FOR UPDATE OF r, t`,
	);
	if (!row) {
		const other = await oneRow(tx, sql`SELECT 1 AS n FROM team_role WHERE id = ${roleId}::uuid`);
		if (other) deny("access_denied");
		deny();
	}
	return roleRow.parse(row);
}
function teamValue(row: TeamRow, revision = row.revision) {
	return c.team.parse({ ...row, revision, activeCount: row.activeCount });
}
function roleValue(row: RoleRow, revision = row.revision) {
	return c.teamRole.parse({
		id: row.id,
		teamId: row.teamId,
		revision,
		name: row.name,
		description: row.description,
		leadership: row.leadership,
		timeCommitment: row.timeCommitment,
		desiredSkills: row.desiredSkills,
		templateKey: row.templateKey,
		retired: row.retired,
		occupantPersonId: row.occupantPersonId,
		occupantName: row.occupantName,
	});
}
function teamFacts(row: TeamRow) {
	return {
		name: row.name,
		description: row.description,
		icon: row.icon,
		state: row.state,
		archived: row.archived,
		templateKey: row.templateKey,
	};
}
const teamResult = (receiptId: string, outcome: "changed" | "noop", row: TeamRow) =>
	c.teamMutationResult.parse({
		receiptId,
		outcome,
		team: teamValue(row),
		stableKey: row.templateKey,
	});
const roleResult = (
	receiptId: string,
	outcome: "changed" | "noop",
	row: RoleRow,
	slots: number,
	historical: string | null,
) =>
	c.roleMutationResult.parse({
		receiptId,
		outcome,
		role: roleValue(row),
		activeStaffingSlots: slots,
		historicalOccupant: historical,
	});

function saveTeam(w: Writer, before: TeamRow, after: TeamRow) {
	return sql`UPDATE team SET name = ${after.name}, description = ${after.description}, icon = ${after.icon},
		state = ${after.state}, archived_at = CASE WHEN ${after.archived} THEN coalesce(archived_at, clock_timestamp()) ELSE NULL END,
		revision = revision + 1
		WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid AND revision = ${before.revision}::bigint`;
}
function expectRevision(actual: string, expected: string) {
	if (actual !== expected) deny("conflict");
}
function stageAfter(stage: string | null, leadership: boolean) {
	if (leadership && stage === "launch_team") return "leader";
	if (!leadership && stage === "core_group") return "launch_team";
	return stage ?? "prospect";
}
type StageMove = {
	id: string;
	from: string;
	to: string;
	revision: string;
	position: string;
	cross: boolean;
};
function stageMove(
	personId: string,
	stage: string | null,
	revision: string | null,
	pipelinePosition: string | null,
	leadership: boolean,
): StageMove | null {
	if (!stage || !revision) return null;
	const to =
		leadership && stage === "launch_team" ? "leader" : !leadership && stage === "core_group" ? "launch_team" : null;
	if (!to) return null;
	const cross = !sameColumn(stage, to);
	return {
		id: personId,
		from: stage,
		to,
		revision,
		position: cross || pipelinePosition === null ? freshPosition(personId) : pipelinePosition,
		cross,
	};
}
function importMoves(
	people: { id: string; stage: string | null; revision: string; pipelinePosition: string | null }[],
	tenures: { personId: string; leadership: boolean }[],
): StageMove[] {
	const flags = new Map<string, { lead: boolean; member: boolean }>();
	for (const row of tenures) {
		const flag = flags.get(row.personId) ?? { lead: false, member: false };
		if (row.leadership) flag.lead = true;
		else flag.member = true;
		flags.set(row.personId, flag);
	}
	const moves: StageMove[] = [];
	for (const [personId, flag] of flags) {
		const person = people.find((item) => item.id === personId);
		if (!person) continue;
		const leadership =
			flag.lead && person.stage === "launch_team" ? true : flag.member && person.stage === "core_group" ? false : null;
		if (leadership === null) continue;
		const move = stageMove(personId, person.stage, person.revision, person.pipelinePosition, leadership);
		if (move) moves.push(move);
	}
	return moves;
}
function queueStageMoves(audit: AuditWrite, plantId: string, actorId: string, moves: StageMove[], cause: string) {
	if (!moves.length) return;
	audit.writes
		.push(sql`UPDATE person AS p SET stage = v.stage, pipeline_position = v.position, revision = p.revision + 1
		FROM (VALUES ${tuples(
			moves.map((move) => sql`(${move.id}::uuid, ${move.to}, ${move.position}::numeric, ${move.revision}::bigint)`),
		)}) AS v(id, stage, position, revision)
		WHERE p.id = v.id AND p.tenant_id = ${plantId}::uuid AND p.revision = v.revision
			AND p.stage IS DISTINCT FROM v.stage`);
	const crossed = moves.filter((move) => move.cross);
	if (crossed.length)
		audit.writes.push(
			columnsChanged(
				plantId,
				crossed.flatMap((move) => [move.from, move.to]),
			),
		);
	for (const move of moves)
		audit.events.push({
			id: randomUUID(),
			tenant_id: plantId,
			actor_id: actorId,
			subject_type: "person",
			subject_id: move.id,
			action: "people.stage_changed",
			kind: "stage_change",
			before_value: { stage: move.from },
			after_value: { stage: move.to },
			before_revision: move.revision,
			after_revision: next(move.revision),
			metadata: { cause },
		});
}

const loadedShape = z.object({
	phase: z.coerce.number().int(),
	teams: z.array(z.object({ id, key: z.string(), name: z.string(), leader: id.nullable() })),
	teamIds: z.array(id),
	roles: z.array(z.object({ id, teamId: id, key: z.string(), holder: id.nullable() })),
	lines: z.array(z.object({ teamId: id, version: id, line: z.string() })),
	people: z.array(
		z.object({
			id,
			stage: z.string().nullable(),
			revision: z.string(),
			pipelinePosition: z.string().nullable(),
		}),
	),
});
async function loadPlant(tx: Tx, plantId: string, personIds: string[]) {
	const ids = personIds.length ? personIds : ["00000000-0000-0000-0000-000000000000"];
	const row = await oneRow(
		tx,
		sql`WITH locked_plant AS (
			SELECT phase::int AS phase FROM plant WHERE id = ${plantId}::uuid FOR UPDATE
		), locked_teams AS (
			SELECT id, template_key AS key, name, leader_person_id AS leader FROM team
			WHERE plant_id = ${plantId}::uuid FOR UPDATE
		), locked_roles AS (
			SELECT r.id, r.team_id, r.template_key AS key,
				(SELECT tn.person_id FROM team_tenure tn WHERE tn.role_id = r.id AND tn.ended_on IS NULL) AS holder
			FROM team_role r WHERE r.plant_id = ${plantId}::uuid FOR UPDATE
		), locked_people AS (
			SELECT id, stage, revision::text AS revision, pipeline_position::text AS position
			FROM person
			WHERE tenant_id = ${plantId}::uuid AND ${personIds.length}::int > 0
				AND id = ANY(${sql.param(ids)}::uuid[])
			FOR UPDATE
		)
		SELECT (SELECT phase FROM locked_plant) AS phase,
			coalesce((SELECT json_agg(json_build_object('id', id, 'key', key, 'name', name, 'leader', leader))
				FROM locked_teams WHERE key IS NOT NULL), '[]'::json) AS teams,
			coalesce((SELECT json_agg(id) FROM locked_teams), '[]'::json) AS "teamIds",
			coalesce((SELECT json_agg(json_build_object('id', id, 'teamId', team_id, 'key', key, 'holder', holder))
				FROM locked_roles WHERE key IS NOT NULL), '[]'::json) AS roles,
			coalesce((SELECT json_agg(json_build_object('teamId', team_id, 'version', source_version_id, 'line', source_line))
				FROM responsibility WHERE plant_id = ${plantId}::uuid), '[]'::json) AS lines,
			coalesce((SELECT json_agg(json_build_object(
				'id', id, 'stage', stage, 'revision', revision, 'pipelinePosition', position))
				FROM locked_people), '[]'::json) AS people`,
	);
	return loadedShape.parse(row);
}
type Selection = {
	teamKey: string;
	roleKeys: string[];
	label?: string;
	personId?: string;
	destinationTeamId?: string;
};
type Line = { teamId: string; sourceVersionId: string; sourceLine: string; text: string; selected: boolean };
function planImport(plantId: string, loaded: z.infer<typeof loadedShape>, selections: Selection[], lines: Line[]) {
	if (lines.some((line) => !loaded.teamIds.includes(line.teamId))) deny("access_denied");
	const teams: { id: string; key: string | null; name: string; leader: string | null }[] = loaded.teams.map((team) => ({
		...team,
	}));
	const roles = loaded.roles.map((role) => ({ ...role }));
	const teamInserts: { id: string; name: string; key: string; ord: number }[] = [];
	const roleInserts: {
		id: string;
		teamId: string;
		name: string;
		key: string;
		leadership: boolean;
		responsibility: string | null;
		ord: number;
	}[] = [];
	const tenureInserts: { id: string; roleId: string; personId: string; leadership: boolean; teamId: string }[] = [];
	const renames: { id: string; name: string }[] = [];
	let ord = 1;
	for (const selection of selections) {
		const catalog = catalogTeam(selection.teamKey);
		if (!catalog) deny("access_denied");
		const destination = selection.destinationTeamId
			? (teams.find((team) => team.id === selection.destinationTeamId) ??
				(loaded.teamIds.includes(selection.destinationTeamId)
					? { id: selection.destinationTeamId, key: null, name: "", leader: null }
					: null))
			: teams.find((team) => team.key === selection.teamKey);
		if (selection.destinationTeamId && !loaded.teamIds.includes(selection.destinationTeamId) && !destination)
			deny("access_denied");
		let teamId = destination?.id;
		if (!teamId) {
			teamId = randomUUID();
			const name = selection.label ?? catalog.name;
			teamInserts.push({ id: teamId, name, key: selection.teamKey, ord: ord++ });
			teams.push({ id: teamId, key: selection.teamKey, name, leader: null });
		} else if (
			selection.label &&
			destination &&
			destination.name !== selection.label &&
			destination.key === selection.teamKey
		) {
			destination.name = selection.label;
			renames.push({ id: teamId, name: selection.label });
		}
		let roleOrd = 1;
		for (const roleKey of selection.roleKeys) {
			const spec = catalogRole(selection.teamKey, roleKey);
			if (!spec) deny("access_denied");
			let role = roles.find((item) => item.teamId === teamId && item.key === roleKey);
			if (!role) {
				const roleId = randomUUID();
				roleInserts.push({
					id: roleId,
					teamId,
					name: spec.name,
					key: roleKey,
					leadership: spec.leadership,
					responsibility: spec.responsibilityKey,
					ord: roleOrd++,
				});
				role = { id: roleId, teamId, key: roleKey, holder: null };
				roles.push(role);
			}
			if (!selection.personId || role.holder) continue;
			tenureInserts.push({
				id: randomUUID(),
				roleId: role.id,
				personId: selection.personId,
				leadership: spec.leadership,
				teamId,
			});
			role.holder = selection.personId;
		}
	}
	const existingLines = new Set(loaded.lines.map((line) => `${line.teamId}:${line.version}:${line.line}`));
	const responsibilities = lines.filter(
		(line) => line.selected && !existingLines.has(`${line.teamId}:${line.sourceVersionId}:${line.sourceLine}`),
	);
	const present = roles
		.filter((role) => teams.some((team) => team.id === role.teamId))
		.map((role) => {
			const team = teams.find((item) => item.id === role.teamId);
			return { teamKey: team?.key ?? "", roleKey: role.key };
		});
	const leaderRows = new Map<string, { roleId: string; personId: string }>();
	for (const row of tenureInserts.filter((item) => item.leadership)) {
		const team = teams.find((item) => item.id === row.teamId);
		if (team && !team.leader && !leaderRows.has(row.teamId))
			leaderRows.set(row.teamId, { roleId: row.roleId, personId: row.personId });
	}
	const insertedTeams = new Set(teamInserts.map((row) => row.id));
	const writes: SQL[] = [];
	if (teamInserts.length)
		writes.push(sql`INSERT INTO team
			(id, plant_id, name, template_key, state, sort_order, leader_person_id, leader_source, leader_role_id)
			SELECT v.id, ${plantId}::uuid, v.name, v.key, 'forming',
				(SELECT coalesce(max(sort_order), 0) FROM team WHERE plant_id = ${plantId}::uuid) + v.ord,
				v.leader_person, v.leader_source, v.leader_role
			FROM (VALUES ${tuples(
				teamInserts.map((row) => {
					const leader = leaderRows.get(row.id);
					return sql`(${row.id}::uuid, ${row.name}, ${row.key}, ${row.ord}::int, ${leader?.personId ?? null}::uuid, ${leader ? "role_derived" : null}, ${leader?.roleId ?? null}::uuid)`;
				}),
			)}) AS v(id, name, key, ord, leader_person, leader_source, leader_role)
			ON CONFLICT (plant_id, template_key) WHERE template_key IS NOT NULL DO NOTHING`);
	if (roleInserts.length)
		writes.push(sql`INSERT INTO team_role
			(id, plant_id, team_id, name, leadership, sort_order, template_key, responsibility_key)
			SELECT v.id, ${plantId}::uuid, v.team_id, v.name, v.leadership, v.ord, v.key, v.responsibility
			FROM (VALUES ${tuples(
				roleInserts.map(
					(row) =>
						sql`(${row.id}::uuid, ${row.teamId}::uuid, ${row.name}, ${row.leadership}::boolean, ${row.ord}::int, ${row.key}, ${row.responsibility}::text)`,
				),
			)}) AS v(id, team_id, name, leadership, ord, key, responsibility)
			ON CONFLICT (team_id, template_key) WHERE template_key IS NOT NULL DO NOTHING`);
	if (tenureInserts.length)
		writes.push(sql`INSERT INTO team_tenure (id, plant_id, role_id, person_id, started_on)
			SELECT v.id, ${plantId}::uuid, v.role_id, v.person_id, ${churchDate(plantId)}
			FROM (VALUES ${tuples(
				tenureInserts.map((row) => sql`(${row.id}::uuid, ${row.roleId}::uuid, ${row.personId}::uuid)`),
			)}) AS v(id, role_id, person_id)`);
	const moves = importMoves(loaded.people, tenureInserts);
	const existingLeaders = [...leaderRows].filter(([teamId]) => !insertedTeams.has(teamId));
	if (existingLeaders.length)
		writes.push(sql`UPDATE team AS t SET leader_person_id = v.person_id, leader_source = 'role_derived',
			leader_role_id = v.role_id, revision = t.revision + 1
			FROM (VALUES ${tuples(
				existingLeaders.map(([teamId, row]) => sql`(${teamId}::uuid, ${row.roleId}::uuid, ${row.personId}::uuid)`),
			)}) AS v(team_id, role_id, person_id)
			WHERE t.id = v.team_id AND t.plant_id = ${plantId}::uuid AND t.leader_person_id IS NULL`);
	if (renames.length)
		writes.push(sql`UPDATE team AS t SET name = v.name, revision = t.revision + 1
			FROM (VALUES ${tuples(renames.map((row) => sql`(${row.id}::uuid, ${row.name})`))}) AS v(id, name)
			WHERE t.id = v.id AND t.plant_id = ${plantId}::uuid AND t.name IS DISTINCT FROM v.name`);
	const responsibilityInsert = insertVersionLines(plantId, responsibilities);
	if (responsibilityInsert) writes.push(responsibilityInsert);
	const first = selections[0];
	const catalog = first ? catalogTeam(first.teamKey) : undefined;
	const newTenantRows = teamInserts.length + roleInserts.length + tenureInserts.length + responsibilities.length;
	return {
		writes,
		moves,
		changed: newTenantRows > 0 || renames.length > 0,
		subject: teamInserts[0]?.id ?? roleInserts[0]?.id ?? renames[0]?.id ?? plantId,
		subjectType: (teamInserts.length ? "team" : roleInserts.length ? "team_role" : "record") as
			"team" | "team_role" | "record",
		roles,
		value: {
			teamKeys: [...new Set(selections.map((selection) => selection.teamKey))],
			roleKeys: selections.flatMap((selection) => selection.roleKeys),
			newTenantRows,
			newTeams: teamInserts.length,
			newSelectedRoles: roleInserts.length,
			createdResponsibilities: responsibilities.length,
			importedRows: teamInserts.length + roleInserts.length,
			newRows: newTenantRows,
			importOfferAvailable: offerRemains(present),
			stableKey: first?.teamKey ?? null,
			label: first ? (first.label ?? catalog?.name ?? null) : null,
			phase: loaded.phase,
		},
	};
}
const baseResult = (receiptId: string, outcome: "changed" | "noop", value: ReturnType<typeof planImport>["value"]) =>
	c.initializeResult.parse({
		receiptId,
		outcome,
		...value,
	});

export const teamsWriter = {
	async create(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.createTeamRequest, raw);
			return command(tx, ctx, "teams.create", input, async (w, audit) => {
				const id = randomUUID();
				const sortOrder = z.coerce
					.number()
					.int()
					.parse(
						(
							await oneRow(
								tx,
								sql`SELECT coalesce(max(sort_order), 0) + 1 AS n FROM team WHERE plant_id = ${w.plant.id}::uuid`,
							)
						)?.n,
					);
				const row = teamRow.parse({
					id,
					revision: "1",
					name: input.input.name,
					description: input.input.description ?? null,
					icon: input.input.icon ?? null,
					templateKey: null,
					state: input.input.state ?? "forming",
					archived: false,
					sortOrder,
					leaderPersonId: null,
					leaderSource: null,
					leaderRoleId: null,
					activeCount: 0,
				});
				audit.writes.push(sql`INSERT INTO team (id, plant_id, name, description, icon, state, sort_order)
					SELECT ${id}::uuid, ${w.plant.id}::uuid, ${row.name}, ${row.description}, ${row.icon}, ${row.state},
						${sortOrder}::int`);
				return {
					value: teamResult(audit.id, "changed", row),
					subject: id,
					subjectType: "team",
					kind: "create",
					before: null,
					after: teamFacts(row),
				};
			});
		});
	},
	async edit(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return changeTeam(tx, ctx, c.editTeamRequest, "teams.edit", "edit", raw);
	},
	async correct(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return changeTeam(tx, ctx, c.correctTeamRequest, "teams.correct", "correct", raw);
	},
	async archive(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return changeTeam(tx, ctx, c.archiveTeamRequest, "teams.archive", "archive", raw, (row) => ({
			...row,
			archived: true,
		}));
	},
	async restore(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return changeTeam(tx, ctx, c.restoreTeamRequest, "teams.restore", "restore", raw, (row) => ({
			...row,
			archived: false,
		}));
	},
	async createRole(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.createRoleRequest, raw);
			return command(
				tx,
				ctx,
				"teams.createRole",
				input,
				async (w, audit) => {
					const team = await lockTeam(tx, w, input.input.teamId);
					if (team.archived) deny();
					const id = randomUUID();
					const row = roleRow.parse({
						id,
						revision: "1",
						teamId: team.id,
						name: input.input.name,
						description: input.input.description ?? null,
						leadership: input.input.leadership ?? false,
						timeCommitment: input.input.timeCommitment ?? null,
						desiredSkills: input.input.desiredSkills ?? null,
						templateKey: null,
						retired: false,
						occupantPersonId: null,
						occupantName: null,
						previousTenureId: null,
						teamArchived: false,
						leaderPersonId: team.leaderPersonId,
						leaderSource: team.leaderSource,
						teamRevision: team.revision,
						stage: null,
						personState: null,
						personRevision: null,
						pipelinePosition: null,
						teamCount: 0,
					});
					audit.writes.push(sql`INSERT INTO team_role
						(id, plant_id, team_id, name, description, leadership, time_commitment, desired_skills, sort_order, template_key)
						SELECT ${id}::uuid, ${w.plant.id}::uuid, ${team.id}::uuid, ${row.name}, ${row.description},
							${row.leadership}, ${row.timeCommitment}, ${row.desiredSkills},
							(SELECT coalesce(max(sort_order), 0) + 1 FROM team_role WHERE team_id = ${team.id}::uuid),
							${row.templateKey}`);
					return {
						value: roleResult(audit.id, "changed", row, 0, null),
						subject: id,
						subjectType: "team_role",
						kind: "create",
						before: null,
						after: { name: row.name, desiredSkills: row.desiredSkills, leadership: row.leadership },
					};
				},
				input.input.teamId,
			);
		});
	},
	async editRole(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.editRoleRequest, raw);
			return command(
				tx,
				ctx,
				"teams.editRole",
				input,
				async (w, audit) => {
					const before = await lockRole(tx, w, input.input.roleId, null);
					expectRevision(before.revision, input.expectedRevision);
					if (before.retired || before.teamArchived) deny();
					const after = roleRow.parse({
						...before,
						name: keep(input.input.name, before.name),
						description: keep(input.input.description, before.description),
						leadership: keep(input.input.leadership, before.leadership),
						timeCommitment: keep(input.input.timeCommitment, before.timeCommitment),
						desiredSkills: keep(input.input.desiredSkills, before.desiredSkills),
						revision: next(before.revision),
					});
					const noop = same(roleValue(before), roleValue({ ...after, revision: before.revision }));
					if (!noop)
						audit.writes.push(sql`UPDATE team_role SET name = ${after.name}, description = ${after.description},
						leadership = ${after.leadership}, time_commitment = ${after.timeCommitment},
						desired_skills = ${after.desiredSkills}, revision = revision + 1
						WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid`);
					return {
						value: roleResult(
							audit.id,
							noop ? "noop" : "changed",
							noop ? before : after,
							before.occupantPersonId ? 1 : 0,
							null,
						),
						subject: before.id,
						subjectType: "team_role",
						kind: "edit",
						outcome: noop ? "noop" : "changed",
						before: { name: before.name, desiredSkills: before.desiredSkills },
						after: { name: after.name, desiredSkills: after.desiredSkills },
						revision: { before: before.revision, after: noop ? before.revision : after.revision },
					};
				},
				roleTeam(input.input.roleId),
			);
		});
	},
	async retireRole(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.retireRoleRequest, raw);
			return command(
				tx,
				ctx,
				"teams.retireRole",
				input,
				async (w, audit) => {
					const before = await lockRole(tx, w, input.input.roleId, null);
					expectRevision(before.revision, input.expectedRevision);
					const noop = before.retired;
					if (!noop) {
						audit.writes.push(sql`UPDATE team_tenure SET ended_on = ${churchDate(w.plant.id)}, revision = revision + 1
						WHERE role_id = ${before.id}::uuid AND ended_on IS NULL AND plant_id = ${w.plant.id}::uuid`);
						audit.writes.push(sql`UPDATE team_role SET retired_at = clock_timestamp(), revision = revision + 1
						WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid AND retired_at IS NULL`);
						audit.writes.push(sql`UPDATE team SET leader_person_id = NULL, leader_source = NULL, leader_role_id = NULL,
						revision = revision + 1
						WHERE id = ${before.teamId}::uuid AND plant_id = ${w.plant.id}::uuid
							AND leader_source = 'role_derived' AND leader_role_id = ${before.id}::uuid`);
					}
					const after = roleRow.parse({
						...before,
						retired: true,
						revision: noop ? before.revision : next(before.revision),
						occupantPersonId: null,
					});
					return {
						value: roleResult(audit.id, noop ? "noop" : "changed", after, 0, before.occupantName),
						subject: before.id,
						subjectType: "team_role",
						kind: "retire",
						outcome: noop ? "noop" : "changed",
						before: { retired: before.retired, occupantPersonId: before.occupantPersonId },
						after: { retired: true, occupantPersonId: null },
						revision: { before: before.revision, after: after.revision },
					};
				},
				roleTeam(input.input.roleId),
			);
		});
	},
	async assignRole(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.assignRoleRequest, raw);
			return command(
				tx,
				ctx,
				"teams.assignRole",
				input,
				async (w, audit) => {
					const before = await lockRole(tx, w, input.input.roleId, input.input.personId);
					expectRevision(before.revision, input.expectedRevision);
					if (before.teamId !== input.input.teamId) deny("invalid_subject");
					if (before.retired || before.teamArchived) deny();
					if (!before.personState) deny("invalid_subject");
					if (before.personState !== "live") deny("invalid_subject");
					if (before.occupantPersonId && before.occupantPersonId !== input.input.personId)
						deny("occupied", { roleId: before.id });
					const already = before.occupantPersonId === input.input.personId;
					const tenureId = already ? null : randomUUID();
					const stage = stageAfter(before.stage, before.leadership);
					const teamCount = before.teamCount;
					if (!already) {
						audit.writes.push(sql`INSERT INTO team_tenure (id, plant_id, role_id, person_id, started_on)
							VALUES (${tenureId}::uuid, ${w.plant.id}::uuid, ${before.id}::uuid, ${input.input.personId}::uuid,
								${churchDate(w.plant.id)})`);
						const move = stageMove(
							input.input.personId,
							before.stage,
							before.personRevision,
							before.pipelinePosition,
							before.leadership,
						);
						if (move) queueStageMoves(audit, w.plant.id, w.accountId, [move], "team_membership");
						if (before.leadership)
							audit.writes.push(sql`UPDATE team SET leader_person_id = ${input.input.personId}::uuid,
								leader_source = 'role_derived', leader_role_id = ${before.id}::uuid, revision = revision + 1
								WHERE id = ${before.teamId}::uuid AND plant_id = ${w.plant.id}::uuid AND leader_person_id IS NULL`);
					}
					return {
						value: c.membershipResult.parse({
							receiptId: audit.id,
							outcome: already ? "noop" : "changed",
							tenureId,
							roleId: before.id,
							personId: input.input.personId,
							stage,
							warning: teamCount >= 2 ? "overload" : null,
							teamCount,
						}),
						subject: tenureId ?? before.id,
						subjectType: tenureId ? "team_tenure" : "team_role",
						kind: "assign",
						outcome: already ? "noop" : "changed",
						before: { occupantPersonId: before.occupantPersonId },
						after: { occupantPersonId: input.input.personId, stage },
					};
				},
				input.input.teamId,
			);
		});
	},
	async endMembership(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.endMembershipRequest, raw);
			return command(
				tx,
				ctx,
				"teams.endMembership",
				input,
				async (w, audit) => {
					const team = await lockTeam(tx, w, input.input.teamId);
					expectRevision(team.revision, input.expectedRevision);
					const open = await oneRow(
						tx,
						sql`SELECT count(*)::int AS n, min(p.stage) AS stage FROM team_tenure tn
							JOIN team_role r ON r.id = tn.role_id
							JOIN person p ON p.id = tn.person_id
							WHERE r.team_id = ${team.id}::uuid AND tn.person_id = ${input.input.personId}::uuid
								AND tn.ended_on IS NULL AND tn.plant_id = ${w.plant.id}::uuid`,
					);
					const count = z.object({ n: z.coerce.number().int(), stage: z.string().nullable() }).parse(open);
					if (!count.n) {
						return membershipNoop(audit, input.input.personId, count.stage ?? "prospect", team.id);
					}
					audit.writes
						.push(sql`UPDATE team_tenure tn SET ended_on = ${churchDate(w.plant.id)}, revision = tn.revision + 1
						FROM team_role r WHERE r.id = tn.role_id AND r.team_id = ${team.id}::uuid
							AND tn.person_id = ${input.input.personId}::uuid AND tn.ended_on IS NULL
							AND tn.plant_id = ${w.plant.id}::uuid`);
					audit.writes.push(sql`UPDATE team SET leader_person_id = NULL, leader_source = NULL, leader_role_id = NULL,
						revision = revision + 1
						WHERE id = ${team.id}::uuid AND leader_person_id = ${input.input.personId}::uuid
							AND leader_source = 'role_derived'`);
					return {
						value: c.membershipResult.parse({
							receiptId: audit.id,
							outcome: "changed",
							tenureId: null,
							roleId: null,
							personId: input.input.personId,
							stage: count.stage ?? "prospect",
							warning: null,
							teamCount: 0,
						}),
						subject: team.id,
						subjectType: "team",
						kind: "remove",
						before: { open: count.n },
						after: { open: 0 },
					};
				},
				input.input.teamId,
			);
		});
	},
	async reactivateMembership(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.reactivateMembershipRequest, raw);
			return command(
				tx,
				ctx,
				"teams.reactivateMembership",
				input,
				async (w, audit) => {
					const before = await lockRole(tx, w, input.input.roleId, input.input.personId);
					expectRevision(before.revision, input.expectedRevision);
					if (before.retired || before.teamArchived) deny();
					if (before.personState !== "live") deny("invalid_subject");
					if (!before.previousTenureId) deny("invalid_subject");
					if (before.occupantPersonId && before.occupantPersonId !== input.input.personId)
						deny("occupied", { roleId: before.id });
					const already = before.occupantPersonId === input.input.personId;
					const tenureId = already ? null : randomUUID();
					const stage = stageAfter(before.stage, before.leadership);
					if (!already) {
						audit.writes
							.push(sql`INSERT INTO team_tenure (id, plant_id, role_id, person_id, started_on, previous_tenure_id)
						VALUES (${tenureId}::uuid, ${w.plant.id}::uuid, ${before.id}::uuid, ${input.input.personId}::uuid,
							${churchDate(w.plant.id)}, ${before.previousTenureId}::uuid)`);
						const move = stageMove(
							input.input.personId,
							before.stage,
							before.personRevision,
							before.pipelinePosition,
							before.leadership,
						);
						if (move) queueStageMoves(audit, w.plant.id, w.accountId, [move], "team_membership");
					}
					return {
						value: c.membershipResult.parse({
							receiptId: audit.id,
							outcome: already ? "noop" : "changed",
							tenureId,
							roleId: before.id,
							personId: input.input.personId,
							stage,
							warning: before.teamCount >= 2 ? "overload" : null,
							teamCount: before.teamCount,
						}),
						subject: tenureId ?? before.previousTenureId,
						subjectType: "team_tenure",
						kind: "assign",
						outcome: already ? "noop" : "changed",
						before: { ended: true },
						after: { tenureId, previousTenureId: before.previousTenureId },
					};
				},
				roleTeam(input.input.roleId),
			);
		});
	},
	async appointLeader(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.appointLeaderRequest, raw);
			return command(tx, ctx, "teams.appointLeader", input, async (w, audit) => {
				const before = await lockTeam(tx, w, input.input.teamId);
				expectRevision(before.revision, input.expectedRevision);
				if (before.archived) deny();
				const person = await oneRow(
					tx,
					sql`SELECT stage, state, revision::text AS revision, pipeline_position::text AS "pipelinePosition"
						FROM person WHERE id = ${input.input.personId}::uuid AND tenant_id = ${w.plant.id}::uuid FOR UPDATE`,
				);
				const who = z
					.object({
						stage: z.string().nullable(),
						state: z.string(),
						revision: z.string(),
						pipelinePosition: z.string().nullable(),
					})
					.safeParse(person);
				if (!who.success || who.data.state !== "live") deny("invalid_subject");
				const noop = before.leaderPersonId === input.input.personId && before.leaderSource === "explicit";
				if (!noop) {
					audit.writes
						.push(sql`UPDATE team SET leader_person_id = ${input.input.personId}::uuid, leader_source = 'explicit',
						leader_role_id = NULL, revision = revision + 1
						WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid`);
					const move = stageMove(
						input.input.personId,
						who.data.stage,
						who.data.revision,
						who.data.pipelinePosition,
						true,
					);
					if (move) queueStageMoves(audit, w.plant.id, w.accountId, [move], "team_leader");
				}
				const after = teamRow.parse({
					...before,
					revision: noop ? before.revision : next(before.revision),
					leaderPersonId: input.input.personId,
					leaderSource: "explicit",
					leaderRoleId: null,
				});
				return {
					value: teamResult(audit.id, noop ? "noop" : "changed", after),
					subject: before.id,
					subjectType: "team",
					kind: "leader_change",
					outcome: noop ? "noop" : "changed",
					before: { leaderPersonId: before.leaderPersonId, leaderSource: before.leaderSource },
					after: { leaderPersonId: after.leaderPersonId, leaderSource: "explicit" },
					revision: { before: before.revision, after: after.revision },
				};
			});
		});
	},
	async initialize(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.initializeRequest, raw);
			return command(tx, ctx, "teams.initialize", input, async (w, audit) => {
				if (input.input.expectedVersion !== TEMPLATE_VERSION) deny("stale_template_version");
				const lines = input.input.lines ?? [];
				if (
					reviewDigest({
						expectedVersion: input.input.expectedVersion,
						mode: input.input.mode,
						selections: input.input.selections,
						lines,
					}) !== input.input.reviewDigest
				)
					deny("stale_review");
				if (input.input.mode === "import" && unknownSelection(input.input.selections)) deny("access_denied");
				const personIds =
					input.input.mode === "import"
						? [...new Set(input.input.selections.flatMap((item) => (item.personId ? [item.personId] : [])))]
						: [];
				const loaded = await loadPlant(tx, w.plant.id, personIds);
				const planned =
					input.input.mode === "import"
						? planImport(w.plant.id, loaded, input.input.selections, lines)
						: planImport(w.plant.id, loaded, [], []);
				for (const query of planned.writes) audit.writes.push(query);
				queueStageMoves(audit, w.plant.id, w.accountId, planned.moves, "team_membership");
				return {
					value: baseResult(audit.id, planned.changed ? "changed" : "noop", planned.value),
					subject: planned.subject,
					subjectType: planned.subjectType,
					kind: planned.changed ? "create" : "noop",
					outcome: planned.changed ? "changed" : "noop",
					before: null,
					after: { newTeams: planned.value.newTeams, newSelectedRoles: planned.value.newSelectedRoles },
				};
			});
		});
	},
};

function roleTeam(roleId: string) {
	return async (tx: Tx, w: Writer) => {
		const found = await oneRow(
			tx,
			sql`SELECT team_id AS "teamId" FROM team_role WHERE id = ${roleId}::uuid AND plant_id = ${w.plant.id}::uuid`,
		);
		return typeof found?.teamId === "string" ? found.teamId : undefined;
	};
}
function membershipNoop(audit: AuditWrite, personId: string, stage: string, teamId: string) {
	return {
		value: c.membershipResult.parse({
			receiptId: audit.id,
			outcome: "noop" as const,
			tenureId: null,
			roleId: null,
			personId,
			stage,
			warning: null,
			teamCount: 0,
		}),
		subject: teamId,
		subjectType: "team" as const,
		kind: "remove" as const,
		outcome: "noop" as const,
	};
}
async function changeTeam(
	tx: Tx,
	ctx: TeamsContext,
	schema: z.ZodType<{ requestKey: string; expectedRevision: string; input: TeamPatch }>,
	operation: "teams.edit" | "teams.correct" | "teams.archive" | "teams.restore",
	kind: "edit" | "correct" | "archive" | "restore",
	raw: unknown,
	apply?: (row: TeamRow) => TeamRow,
) {
	return reply(tx, async () => {
		const input = parse(schema, raw);
		return command(tx, ctx, operation, input, async (w, audit) => {
			const before = await lockTeam(tx, w, input.input.teamId);
			expectRevision(before.revision, input.expectedRevision);
			const patch = input.input;
			const target = apply
				? apply(before)
				: teamRow.parse({
						...before,
						name: keep(patch.name, before.name),
						description: keep(patch.description, before.description),
						icon: keep(patch.icon, before.icon),
						state: keep(patch.state, before.state),
					});
			const noop = same(teamFacts(before), teamFacts(target));
			const after = teamRow.parse({ ...target, revision: noop ? before.revision : next(before.revision) });
			if (!noop) audit.writes.push(saveTeam(w, before, after));
			return {
				value: teamResult(audit.id, noop ? "noop" : "changed", after),
				subject: before.id,
				subjectType: "team",
				kind,
				outcome: noop ? "noop" : "changed",
				reason: input.input.reason ?? null,
				before: teamFacts(before),
				after: teamFacts(after),
				revision: { before: before.revision, after: after.revision },
			};
		});
	});
}
