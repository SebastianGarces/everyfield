import * as c from "@everyfield/contracts/teams";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { drawingLines, drawingPdf, drawingSvg, withParents } from "./chart.ts";
import { deny, one, parse, read, type Reader, type Viewer } from "./core.ts";
import { catalogTeam, TEMPLATES, unknownSelection } from "./templates.ts";

const id = z.string().uuid();
const day = z
	.union([z.string(), z.date()])
	.transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)));
const stamp = z
	.union([z.string(), z.date()])
	.transform((value) => (value instanceof Date ? value.toISOString() : String(value)));

export async function row(db: Reader, viewer: Viewer, query: ReturnType<typeof sql>) {
	const found = await one(db, viewer, query);
	if (!found) deny("unavailable");
	return found;
}
export function owner(plantId: string, value: unknown) {
	if (typeof value !== "string") deny("unavailable");
	if (value !== plantId) deny("access_denied");
}
export function unique(ids: string[]) {
	return [...new Set(ids)];
}

const teamJson = sql`json_build_object(
	'id', t.id, 'revision', t.revision::text, 'name', t.name, 'description', t.description, 'icon', t.icon,
	'templateKey', t.template_key, 'state', t.state, 'archived', (t.archived_at IS NOT NULL), 'sortOrder', t.sort_order,
	'leaderPersonId', t.leader_person_id, 'leaderSource', t.leader_source, 'leaderRoleId', t.leader_role_id,
	'leaderName', (SELECT p.display_name FROM person p WHERE p.id = t.leader_person_id),
	'activeCount', (SELECT count(*)::int FROM team_tenure tn
		JOIN team_role r ON r.id = tn.role_id
		JOIN person p ON p.id = tn.person_id AND p.state = 'live'
		WHERE r.team_id = t.id AND tn.ended_on IS NULL AND r.retired_at IS NULL))`;

const current = sql`tn.ended_on IS NULL AND r.retired_at IS NULL AND t.archived_at IS NULL AND p.state = 'live'`;
const roleJson = sql`json_build_object(
	'id', r.id, 'teamId', r.team_id, 'revision', r.revision::text, 'name', r.name,
	'description', r.description, 'leadership', r.leadership, 'timeCommitment', r.time_commitment,
	'desiredSkills', r.desired_skills, 'templateKey', r.template_key, 'retired', (r.retired_at IS NOT NULL),
	'occupantPersonId', holder.person_id, 'occupantName', holder.name)`;
const holder = sql`LEFT JOIN LATERAL (
	SELECT tn.person_id, p.display_name AS name FROM team_tenure tn
	JOIN person p ON p.id = tn.person_id
	WHERE tn.role_id = r.id AND tn.ended_on IS NULL
) holder ON true`;
const staffing = z.object({
	teams: z.array(z.unknown()),
	roles: z.number().int(),
	filledRoles: z.number().int(),
	openRoles: z.number().int(),
	people: z.number().int(),
});

export const teamsReader = {
	async listImportTemplates(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			parse(z.object({}).strict(), raw ?? {});
			await one(db, viewer, sql`SELECT 1 AS ok`);
			return {
				version: c.TEMPLATE_VERSION,
				teams: TEMPLATES.map((team) => ({
					key: team.key,
					name: team.name,
					roles: team.roles.map((role) => ({ key: role.key, name: role.name, leadership: role.leadership })),
				})),
				newTenantRows: 0,
			} satisfies z.output<typeof c.catalogPage>;
		});
	},
	async get(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.getTeamRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT t.plant_id AS owner, ${teamJson} AS team,
					coalesce((SELECT json_agg(${roleJson} ORDER BY r.sort_order, r.id) FROM team_role r ${holder}
						WHERE r.team_id = t.id AND r.plant_id = t.plant_id AND r.retired_at IS NULL), '[]'::json) AS roles,
					(${memberList(viewer.plantId, input.teamId, true)}) AS members
					FROM team t WHERE t.id = ${input.teamId}::uuid`,
			);
			owner(viewer.plantId, found.owner);
			return c.teamDetail.parse({
				team: found.team,
				roles: z.array(c.teamRole).parse(found.roles).slice(0, 100),
				members: members.parse(found.members).slice(0, 500),
			});
		});
	},
	async searchMembers(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.searchMembersRequest, raw);
			const needle = (input.q ?? "").replace(/[\\%_]/g, (ch) => "\\" + ch);
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(x ORDER BY x.name, x."teamName", x."roleName", x."roleId") FROM (
					SELECT p.id AS "personId", p.display_name AS name, t.id AS "teamId", t.name AS "teamName", r.id AS "roleId",
						r.name AS "roleName", tn.started_on AS "startedOn"
					FROM team_tenure tn JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id
					JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
					JOIN person p ON p.id = tn.person_id AND p.tenant_id = tn.plant_id
					WHERE tn.plant_id = ${viewer.plantId}::uuid AND ${current}
						AND (${input.teamId ?? null}::uuid IS NULL OR t.id = ${input.teamId ?? null}::uuid)
						AND (${needle} = '' OR p.display_name ILIKE ${"%" + needle + "%"} ESCAPE '\\')
					ORDER BY p.display_name, t.name, r.name, r.id LIMIT 201) x), '[]'::json) AS items`,
			);
			const items = z.array(z.unknown()).parse(found.items);
			return c.memberSearch.parse({
				items: items.slice(0, 200),
				completeness: items.length > 200 ? "partial" : "complete",
			});
		});
	},
	async staffingSummary(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			parse(c.staffingSummaryRequest, raw ?? {});
			const plant = sql`${viewer.plantId}::uuid`;
			const found = await row(
				db,
				viewer,
				sql`WITH teams AS (SELECT t.* FROM team t WHERE t.plant_id = ${plant} AND t.archived_at IS NULL
						ORDER BY t.sort_order, t.id LIMIT 200),
					slots AS (SELECT r.id, r.team_id, (SELECT tn.person_id FROM team_tenure tn
							JOIN person p ON p.id = tn.person_id AND p.tenant_id = tn.plant_id AND p.state = 'live'
							WHERE tn.role_id = r.id AND tn.plant_id = r.plant_id AND tn.ended_on IS NULL LIMIT 1) AS person_id
						FROM team_role r JOIN teams t ON t.id = r.team_id WHERE r.plant_id = ${plant} AND r.retired_at IS NULL)
				SELECT coalesce((SELECT json_agg(json_build_object(
						'teamId', t.id, 'name', t.name, 'state', t.state,
						'leaderStatus', CASE WHEN t.leader_person_id IS NULL THEN 'none'
							WHEN lp.id IS NULL THEN 'unavailable'
							WHEN t.leader_source = 'explicit' THEN 'appointed' ELSE 'fallback' END,
						'leaderName', lp.display_name,
						'roles', (SELECT count(*) FROM slots s WHERE s.team_id = t.id),
						'filledRoles', (SELECT count(s.person_id) FROM slots s WHERE s.team_id = t.id),
						'openRoles', (SELECT count(*) FILTER (WHERE s.person_id IS NULL) FROM slots s WHERE s.team_id = t.id),
						'people', (SELECT count(DISTINCT s.person_id) FROM slots s WHERE s.team_id = t.id))
						ORDER BY t.sort_order, t.id)
					FROM teams t LEFT JOIN person lp ON lp.id = t.leader_person_id AND lp.tenant_id = t.plant_id AND lp.state = 'live'),
					'[]'::json) AS teams,
					(SELECT count(*)::int FROM slots) AS roles,
					(SELECT count(person_id)::int FROM slots) AS "filledRoles",
					(SELECT (count(*) - count(person_id))::int FROM slots) AS "openRoles",
					(SELECT count(DISTINCT person_id)::int FROM slots) AS people`,
			);
			const totals = staffing.parse(found);
			return c.staffingSummary.parse({ ...totals, teams: totals.teams.map((t) => c.staffingRow.parse(t)) });
		});
	},
	async personTeamCounts(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.personTeamCountsRequest, raw ?? {});
			const minTeams = input.minTeams ?? 2;
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(x ORDER BY x.teams DESC, x.name, x."personId") FROM (
					SELECT p.id AS "personId", p.display_name AS name, count(DISTINCT t.id)::int AS teams,
						array_agg(DISTINCT t.name ORDER BY t.name) AS "teamNames"
					FROM team_tenure tn JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id
					JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
					JOIN person p ON p.id = tn.person_id AND p.tenant_id = tn.plant_id
					WHERE tn.plant_id = ${viewer.plantId}::uuid AND ${current}
					GROUP BY p.id, p.display_name HAVING count(DISTINCT t.id) >= ${minTeams}
					ORDER BY count(DISTINCT t.id) DESC, p.display_name, p.id LIMIT 200) x), '[]'::json) AS people`,
			);
			return c.personTeamCounts.parse({ minTeams, people: found.people });
		});
	},
	async previewTemplateImport(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.previewTemplateImportRequest, raw);
			if (unknownSelection(input.selections))
				deny("invalid_input", { issues: [{ path: "selections", problem: "unknown team or role" }] });
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(json_build_object('key', t.template_key, 'roles', coalesce((
						SELECT json_agg(r.template_key) FROM team_role r WHERE r.team_id = t.id AND r.template_key IS NOT NULL), '[]'::json)))
					FROM team t WHERE t.plant_id = ${viewer.plantId}::uuid AND t.template_key IS NOT NULL), '[]'::json) AS present`,
			);
			const present = z.array(z.object({ key: z.string(), roles: z.array(z.string()) })).parse(found.present);
			const teams = input.selections.map((selection) => {
				const team = catalogTeam(selection.teamKey);
				if (!team) throw Error(`The checked selection names no catalog team: ${selection.teamKey}`);
				const have = present.find((p) => p.key === team.key);
				const chosen = team.roles
					.filter((role) => selection.roleKeys.includes(role.key))
					.map(({ key, name, leadership }) => ({ key, name, leadership }));
				return {
					key: team.key,
					name: team.name,
					exists: !!have,
					newRoles: chosen.filter((role) => !have?.roles.includes(role.key)),
					existingRoles: chosen.filter((role) => have?.roles.includes(role.key)),
				};
			});
			return {
				teams,
				newTeams: teams.filter((t) => !t.exists).length,
				newRoles: teams.reduce((n, t) => n + t.newRoles.length, 0),
			} satisfies z.output<typeof c.templatePreview>;
		});
	},
	async list(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			if (raw !== null && typeof raw === "object" && "background_check" in raw) deny("unsupported_filter");
			const input = parse(c.listTeamsRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(${teamJson} ORDER BY t.sort_order, t.id)
					FROM team t WHERE t.plant_id = ${viewer.plantId}::uuid), '[]'::json) AS items`,
			);
			const all = z.array(c.listedTeam).parse(found.items).slice(0, 200);
			const include = input.includeArchived === true;
			return {
				items: all.filter((team) => include || !team.archived),
				ordinaryIds: all.filter((team) => !team.archived).map((team) => team.id),
				archivedIds: all.filter((team) => team.archived).map((team) => team.id),
			} satisfies z.output<typeof c.teamPage>;
		});
	},
	async listHistory(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.teamHistoryRequest, raw);
			const plant = sql`${viewer.plantId}::uuid`;
			const team = sql`${input.teamId}::uuid`;
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM team WHERE id = ${team}) AS owner,
					coalesce((WITH subjects(id, subject, stored) AS (
						SELECT ${team}, 'ministry', 'team'
						UNION ALL SELECT r.id, 'role', 'team_role' FROM team_role r
							WHERE r.team_id = ${team} AND r.plant_id = ${plant}
						UNION ALL SELECT tn.id, 'tenure', 'team_tenure' FROM team_tenure tn
							JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id
							WHERE r.team_id = ${team} AND tn.plant_id = ${plant})
					SELECT json_agg(json_build_object(
						'id', a.id, 'kind', a.kind, 'occurredAt', a.occurred_at, 'reason', a.reason,
						'before', a.before_value, 'after', a.after_value, 'subject', a.subject,
						'about', CASE WHEN a.subject = 'role' THEN
								(SELECT json_build_object('personName', NULL, 'roleName', coalesce(a.after_value->>'name', r.name)) FROM team_role r
									WHERE r.id = a.subject_id AND r.plant_id = a.tenant_id)
							ELSE (SELECT json_build_object('personName', p.display_name, 'roleName', r.name) FROM team_tenure tn
								JOIN team_role r ON r.id = tn.role_id JOIN person p ON p.id = tn.person_id
								WHERE tn.id = CASE WHEN a.subject = 'tenure' THEN a.subject_id
										ELSE (a.metadata->>'tenureId')::uuid END
									AND tn.plant_id = a.tenant_id) END,
						'actorName', (SELECT display_name FROM seat_identity(a.actor_id))
					) ORDER BY a.occurred_at DESC, a.id DESC)
					FROM (SELECT e.*, s.subject FROM audit_event e
						JOIN subjects s ON s.id = e.subject_id AND (e.subject_type = s.stored
							OR (s.subject = 'ministry' AND e.subject_type = 'record' AND e.kind = 'leader_change'))
						WHERE e.tenant_id = ${plant} AND e.kind <> 'noop'
							AND NOT (s.subject = 'role' AND e.request_identity->>'operation' IS NOT DISTINCT FROM 'teams.initialize')
						ORDER BY e.occurred_at DESC, e.id DESC LIMIT 200) a), '[]'::json) AS entries`,
			);
			owner(viewer.plantId, found.owner);
			const entries = z
				.array(
					z.object({
						id,
						kind: z.string(),
						occurredAt: stamp,
						reason: z.string().nullable(),
						before: z.record(z.string(), z.unknown()).nullable(),
						after: z.record(z.string(), z.unknown()).nullable(),
						actorName: z.string().nullable(),
						subject: z.enum(["ministry", "role", "tenure"]),
						about: z.object({ personName: z.string().nullable(), roleName: z.string() }).nullable(),
					}),
				)
				.parse(found.entries);
			return c.teamHistory.parse({ teamId: input.teamId, entries });
		});
	},
	async listRoles(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listRolesRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM team WHERE id = ${input.teamId}::uuid) AS owner,
					coalesce((SELECT json_agg(json_build_object(
						'id', r.id, 'teamId', r.team_id, 'revision', r.revision::text, 'name', r.name,
						'description', r.description, 'leadership', r.leadership, 'timeCommitment', r.time_commitment,
						'desiredSkills', r.desired_skills, 'templateKey', r.template_key, 'retired', (r.retired_at IS NOT NULL),
						'occupantPersonId', holder.person_id, 'occupantName', holder.name
					) ORDER BY r.sort_order, r.id)
					FROM team_role r
					LEFT JOIN LATERAL (
						SELECT tn.person_id, p.display_name AS name FROM team_tenure tn
						JOIN person p ON p.id = tn.person_id
						WHERE tn.role_id = r.id AND tn.ended_on IS NULL
					) holder ON true
					WHERE r.team_id = ${input.teamId}::uuid AND r.plant_id = ${viewer.plantId}::uuid), '[]'::json) AS roles`,
			);
			owner(viewer.plantId, found.owner);
			return {
				teamId: input.teamId,
				roles: z.array(c.teamRole).parse(found.roles).slice(0, 100),
			} satisfies z.output<typeof c.rolePage>;
		});
	},
	async readRevision(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.teamRevisionRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT plant_id AS owner, revision::text AS revision FROM team WHERE id = ${input.teamId}::uuid`,
			);
			owner(viewer.plantId, found.owner);
			return c.teamRevision.parse({ teamId: input.teamId, revision: found.revision });
		});
	},
	async listMembers(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listMembersRequest, raw);
			const found = await row(db, viewer, memberQuery(viewer.plantId, input.teamId));
			owner(viewer.plantId, found.owner);
			return c.memberPage.parse({
				teamId: input.teamId,
				members: members.parse(found.members).slice(0, 500),
				history: members.parse(found.history).slice(0, 500),
			});
		});
	},
	async listPersonAssignments(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.personAssignmentsRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT p.tenant_id AS owner, ${personTenuresJson(sql`p.id`, sql`p.tenant_id`)} AS assignments
					FROM person p WHERE p.id = ${input.personId}::uuid`,
			);
			owner(viewer.plantId, found.owner);
			return { personId: input.personId, assignments: personTenures(found.assignments) } satisfies z.output<
				typeof c.personAssignments
			>;
		});
	},
	async listLeaderCandidates(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listLeaderCandidatesRequest, raw);
			const q = input.q ?? "";
			const needle = q.replace(/[\\%_]/g, (ch) => "\\" + ch);
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(json_build_object('personId', p.id, 'name', p.display_name, 'stage', p.stage)
					ORDER BY p.display_name, p.id)
					FROM (SELECT id, display_name, stage FROM person
						WHERE tenant_id = ${viewer.plantId}::uuid AND state = 'live' AND stage IS NOT NULL
							AND (${q} = '' OR display_name ILIKE ${"%" + needle + "%"} ESCAPE '\\')
						ORDER BY display_name, id LIMIT 50) p), '[]'::json) AS people`,
			);
			return {
				people: z.array(c.leaderCandidate).parse(found.people),
			} satisfies z.output<typeof c.leaderCandidates>;
		});
	},
	async readOrgChart(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.orgChartRequest, raw);
			return c.orgChart.parse({
				nodes: await chartNodes(db, viewer, input.includeArchived === true),
			});
		});
	},
	async readOrgChartExport(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.orgChartExportRequest, raw);
			const nodes = await chartNodes(db, viewer, input.includeArchived === true);
			const lines = drawingLines(nodes);
			return c.orgChartExport.parse({
				format: "pdf",
				pdf: drawingPdf(lines),
				svg: drawingSvg(lines),
				lines,
				nodes,
			});
		});
	},
};

export const personTenuresJson = (personId: SQL, plantId: SQL) =>
	sql`coalesce((SELECT json_agg(json_build_object(
		'tenureId', tn.id, 'revision', tn.revision::text,
		'teamId', t.id, 'teamName', t.name, 'roleId', r.id, 'roleName', r.name,
		'desiredSkills', r.desired_skills, 'startedOn', tn.started_on, 'endedOn', tn.ended_on,
		'active', (tn.ended_on IS NULL)
	) ORDER BY (tn.ended_on IS NULL) DESC, tn.started_on DESC, tn.id)
	FROM team_tenure tn
	JOIN team_role r ON r.id = tn.role_id AND r.plant_id = tn.plant_id
	JOIN team t ON t.id = r.team_id AND t.plant_id = r.plant_id
	WHERE tn.person_id = ${personId} AND tn.plant_id = ${plantId}), '[]'::json)`;
export const personTenures = (raw: unknown) =>
	z
		.array(z.unknown())
		.parse(raw)
		.slice(0, 200)
		.map((a) => c.assignmentRow.parse(a));

const memberRow = z.object({
	personId: id,
	name: z.string(),
	roleId: id,
	roleName: z.string(),
	startedOn: day,
	endedOn: day.nullable(),
	active: z.boolean(),
	live: z.boolean(),
});
const members = z.array(memberRow);
function memberQuery(plantId: string, teamId: string) {
	return sql`SELECT (SELECT plant_id FROM team WHERE id = ${teamId}::uuid) AS owner,
		(${memberList(plantId, teamId, true)}) AS members, (${memberList(plantId, teamId, false)}) AS history`;
}
function memberList(plantId: string, teamId: string, open: boolean) {
	return sql`SELECT coalesce((SELECT json_agg(json_build_object(
		'personId', p.id, 'name', p.display_name, 'roleId', r.id, 'roleName', r.name,
		'startedOn', tn.started_on, 'endedOn', tn.ended_on, 'active', (tn.ended_on IS NULL), 'live', (p.state = 'live')
	) ORDER BY p.display_name, tn.id)
	FROM team_tenure tn
	JOIN team_role r ON r.id = tn.role_id
	JOIN person p ON p.id = tn.person_id
	JOIN team t ON t.id = r.team_id
	WHERE t.id = ${teamId}::uuid AND t.plant_id = ${plantId}::uuid
		AND ${open ? sql`tn.ended_on IS NULL AND r.retired_at IS NULL AND t.archived_at IS NULL AND p.state = 'live'` : sql`tn.ended_on IS NOT NULL`}), '[]'::json)`;
}

const chartRow = z.object({
	id,
	name: z.string(),
	templateKey: z.string().nullable(),
	archived: z.boolean(),
	leaderName: z.string().nullable(),
});
async function chartNodes(db: Reader, viewer: Viewer, includeArchived: boolean) {
	const found = await row(
		db,
		viewer,
		sql`SELECT coalesce((SELECT json_agg(json_build_object(
			'id', t.id, 'name', t.name, 'templateKey', t.template_key, 'archived', (t.archived_at IS NOT NULL),
			'leaderName', (SELECT p.display_name FROM person p WHERE p.id = t.leader_person_id)
		) ORDER BY t.sort_order, t.id)
		FROM team t WHERE t.plant_id = ${viewer.plantId}::uuid), '[]'::json) AS nodes`,
	);
	const all = chartRow.array().parse(found.nodes);
	return withParents((includeArchived ? all : all.filter((node) => !node.archived)).slice(0, 200));
}
