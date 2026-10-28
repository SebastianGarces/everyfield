import * as c from "@everyfield/contracts/teams";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { drawingLines, drawingPdf, drawingSvg } from "./chart.ts";
import { deny, one, parse, read, type Reader, type Viewer } from "./core.ts";
import { TEMPLATES } from "./templates.ts";

const id = z.string().uuid();
const day = z
	.union([z.string(), z.date()])
	.transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)));
const stamp = z
	.union([z.string(), z.date()])
	.transform((value) => (value instanceof Date ? value.toISOString() : String(value)));

export async function row(db: Reader, viewer: Viewer, query: ReturnType<typeof sql>) {
	const found = await one(db, viewer, query);
	if (!found) deny();
	return found;
}
export function owner(plantId: string, value: unknown) {
	if (typeof value !== "string") deny();
	if (value !== plantId) deny("access_denied");
}
export function unique(ids: string[]) {
	return [...new Set(ids)];
}

const teamJson = sql`json_build_object(
	'id', t.id, 'revision', t.revision::text, 'name', t.name, 'description', t.description, 'icon', t.icon,
	'templateKey', t.template_key, 'state', t.state, 'archived', (t.archived_at IS NOT NULL), 'sortOrder', t.sort_order,
	'leaderPersonId', t.leader_person_id, 'leaderSource', t.leader_source, 'leaderRoleId', t.leader_role_id,
	'activeCount', (SELECT count(*)::int FROM team_tenure tn
		JOIN team_role r ON r.id = tn.role_id
		JOIN person p ON p.id = tn.person_id AND p.state = 'live'
		WHERE r.team_id = t.id AND tn.ended_on IS NULL AND r.retired_at IS NULL))`;

export const teamsReader = {
	/** Catalog only. This read inserts nothing. */
	async listImportTemplates(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			parse(z.object({}).strict(), raw ?? {});
			await one(db, viewer, sql`SELECT 1 AS ok`);
			return c.catalogPage.parse({
				version: c.TEMPLATE_VERSION,
				teams: TEMPLATES.map((team) => ({
					key: team.key,
					name: team.name,
					roles: team.roles.map((role) => ({ key: role.key, name: role.name, leadership: role.leadership })),
				})),
				newTenantRows: 0,
			});
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
			const all = z.array(c.team).parse(found.items).slice(0, 200);
			const include = input.includeArchived === true;
			return c.teamPage.parse({
				items: all.filter((team) => include || !team.archived),
				ordinaryIds: all.filter((team) => !team.archived).map((team) => team.id),
				archivedIds: all.filter((team) => team.archived).map((team) => team.id),
			});
		});
	},
	async listHistory(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.teamHistoryRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM team WHERE id = ${input.teamId}::uuid) AS owner,
					coalesce((SELECT json_agg(json_build_object(
						'id', a.id, 'kind', a.kind, 'occurredAt', a.occurred_at, 'reason', a.reason,
						'before', a.before_value, 'after', a.after_value
					) ORDER BY a.occurred_at DESC, a.id DESC)
					FROM (SELECT * FROM audit_event WHERE tenant_id = ${viewer.plantId}::uuid AND subject_id = ${input.teamId}::uuid
						ORDER BY occurred_at DESC, id DESC LIMIT 200) a), '[]'::json) AS entries`,
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
			return c.rolePage.parse({
				teamId: input.teamId,
				roles: z.array(c.teamRole).parse(found.roles).slice(0, 100),
			});
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
				sql`SELECT p.tenant_id AS owner,
					coalesce((SELECT json_agg(json_build_object(
						'teamId', t.id, 'teamName', t.name, 'roleId', r.id, 'roleName', r.name,
						'desiredSkills', r.desired_skills, 'startedOn', tn.started_on, 'endedOn', tn.ended_on,
						'active', (tn.ended_on IS NULL)
					) ORDER BY tn.started_on, tn.id)
					FROM team_tenure tn
					JOIN team_role r ON r.id = tn.role_id
					JOIN team t ON t.id = r.team_id
					WHERE tn.person_id = p.id AND tn.plant_id = p.tenant_id), '[]'::json) AS assignments
					FROM person p WHERE p.id = ${input.personId}::uuid`,
			);
			owner(viewer.plantId, found.owner);
			const assignments = z
				.array(
					z.object({
						teamId: id,
						teamName: z.string(),
						roleId: id,
						roleName: z.string(),
						desiredSkills: z.string().nullable(),
						startedOn: day,
						endedOn: day.nullable(),
						active: z.boolean(),
					}),
				)
				.parse(found.assignments);
			return c.personAssignments.parse({
				personId: input.personId,
				assignments: assignments.slice(0, 200),
			});
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
			return c.leaderCandidates.parse({
				people: z.array(c.leaderCandidate).parse(found.people),
			});
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
	async readRosterPreview(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.rosterPreviewRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM meeting WHERE id = ${input.meetingId}::uuid) AS "meetingPlant",
					(SELECT team_id FROM meeting WHERE id = ${input.meetingId}::uuid) AS "meetingTeam",
					(SELECT plant_id FROM team WHERE id = ${input.teamId}::uuid) AS "teamPlant",
					coalesce((SELECT json_agg(DISTINCT p.id) FROM team_tenure tn
						JOIN team_role r ON r.id = tn.role_id
						JOIN team t ON t.id = r.team_id
						JOIN person p ON p.id = tn.person_id AND p.state = 'live'
						WHERE t.id = ${input.teamId}::uuid AND t.plant_id = ${viewer.plantId}::uuid
							AND t.archived_at IS NULL AND r.retired_at IS NULL AND tn.ended_on IS NULL), '[]'::json) AS ids`,
			);
			if (found.meetingPlant == null || found.teamPlant == null) deny();
			owner(viewer.plantId, found.meetingPlant);
			owner(viewer.plantId, found.teamPlant);
			if (found.meetingTeam !== input.teamId) deny("invalid_subject");
			return c.rosterPreview.parse({
				meetingId: input.meetingId,
				teamId: input.teamId,
				personIds: z.array(id).parse(found.ids).slice(0, 500),
			});
		});
	},
};

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
	const body = (open: boolean) => sql`SELECT coalesce((SELECT json_agg(json_build_object(
		'personId', p.id, 'name', p.display_name, 'roleId', r.id, 'roleName', r.name,
		'startedOn', tn.started_on, 'endedOn', tn.ended_on, 'active', (tn.ended_on IS NULL), 'live', (p.state = 'live')
	) ORDER BY p.display_name, tn.id)
	FROM team_tenure tn
	JOIN team_role r ON r.id = tn.role_id
	JOIN person p ON p.id = tn.person_id
	JOIN team t ON t.id = r.team_id
	WHERE t.id = ${teamId}::uuid AND t.plant_id = ${plantId}::uuid
		AND ${open ? sql`tn.ended_on IS NULL AND r.retired_at IS NULL AND t.archived_at IS NULL AND p.state = 'live'` : sql`tn.ended_on IS NOT NULL`}), '[]'::json)`;
	return sql`SELECT (SELECT plant_id FROM team WHERE id = ${teamId}::uuid) AS owner,
		(${body(true)}) AS members, (${body(false)}) AS history`;
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
	const visible = (includeArchived ? all : all.filter((node) => !node.archived)).slice(0, 200);
	// An archived ministry is never a root: only a live Leadership-template ministry is (REQ-TEAM-012).
	const root = visible.find((node) => node.templateKey === "leadership" && !node.archived);
	return visible.map((node) => ({ ...node, parentId: root && node.id !== root.id ? root.id : null }));
}
