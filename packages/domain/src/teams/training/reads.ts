import * as c from "@everyfield/contracts/teams";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../../access/session.ts";
import { deny, parse, read, type Reader } from "../core.ts";
import { owner, row, unique } from "../reads.ts";
import { rosterDigest } from "./digest.ts";
const compatible = sql`(SELECT c.kind = 'earned' AND c.version = g.version
	FROM training_credit c
	WHERE c.plant_id = g.plant_id AND c.program_id = g.id AND c.person_id = a.person_id
	ORDER BY c.recorded_at DESC, c.id DESC
	LIMIT 1)`;

function facts(plantId: string, teamId: string) {
	return sql`SELECT (SELECT plant_id FROM team WHERE id = ${teamId}::uuid) AS owner,
		coalesce(fill.filled, 0) AS "filledSlots",
		coalesce(roles.n, 0) - coalesce(fill.filled, 0) AS "openSlots",
		coalesce(fill.people, 0) AS "distinctPeople",
		coalesce(att.members, 0) AS "memberAttendance",
		coalesce(att.guests, 0) AS "guestCount",
		coalesce(att.roster, 0) AS "rosterDenominator",
		CASE WHEN coalesce(train.denominator, 0) = 0 THEN NULL
			ELSE train.numerator::float8 / train.denominator END AS "trainingRate",
		CASE WHEN coalesce(roles.n, 0) = 0 THEN NULL
			ELSE coalesce(fill.filled, 0)::float8 / roles.n END AS "staffingRate",
		CASE WHEN coalesce(meetings.n, 0) = 0 THEN NULL
			WHEN coalesce(att.roster, 0) = 0 THEN 0::float8
			ELSE att.members::float8 / att.roster END AS "attendanceRate",
		json_build_array(40, 35, 25) AS weights,
		CASE WHEN coalesce(train.denominator, 0) = 0 OR coalesce(roles.n, 0) = 0 OR coalesce(meetings.n, 0) = 0 THEN NULL
			ELSE ((train.numerator::float8 / train.denominator) * 40)
				+ ((coalesce(fill.filled, 0)::float8 / roles.n) * 35)
				+ ((CASE WHEN coalesce(att.roster, 0) = 0 THEN 0::float8 ELSE att.members::float8 / att.roster END) * 25)
			END AS composite
		FROM (SELECT count(*)::int AS n FROM team_role r
			WHERE r.team_id = ${teamId}::uuid AND r.plant_id = ${plantId}::uuid AND r.retired_at IS NULL) roles
		CROSS JOIN (SELECT count(*)::int AS filled, count(DISTINCT tn.person_id)::int AS people
			FROM team_role r
			JOIN team_tenure tn ON tn.role_id = r.id AND tn.ended_on IS NULL AND tn.plant_id = r.plant_id
			JOIN person p ON p.id = tn.person_id AND p.tenant_id = r.plant_id AND p.state = 'live'
			WHERE r.team_id = ${teamId}::uuid AND r.plant_id = ${plantId}::uuid AND r.retired_at IS NULL) fill
		CROSS JOIN (SELECT count(*)::int AS n FROM (
			SELECT m.id FROM meeting m
			WHERE m.team_id = ${teamId}::uuid AND m.plant_id = ${plantId}::uuid AND m.type = 'team_meeting'
				AND m.status = 'completed' AND m.retired_at IS NULL
			ORDER BY m.starts_at DESC, m.id
			LIMIT 4) recent) meetings
		CROSS JOIN (SELECT
			(count(DISTINCT pa.person_id) FILTER (WHERE pa.roster_member AND pa.presence = 'attended'))::int AS members,
			(count(DISTINCT pa.person_id) FILTER (WHERE NOT pa.roster_member AND pa.presence = 'attended'))::int AS guests,
			(count(DISTINCT pa.person_id) FILTER (WHERE pa.roster_member))::int AS roster
			FROM participation pa
			JOIN (SELECT m.id FROM meeting m
				WHERE m.team_id = ${teamId}::uuid AND m.plant_id = ${plantId}::uuid AND m.type = 'team_meeting'
					AND m.status = 'completed' AND m.retired_at IS NULL
				ORDER BY m.starts_at DESC, m.id
				LIMIT 4) recent ON recent.id = pa.meeting_id
			WHERE pa.removed_at IS NULL) att
		CROSS JOIN (SELECT count(DISTINCT a.person_id)::int AS denominator,
			(count(DISTINCT a.person_id) FILTER (WHERE ${compatible}))::int AS numerator
			FROM training_assignment a
			JOIN training_program g ON g.id = a.program_id AND g.plant_id = a.plant_id AND g.required
				AND g.archived_at IS NULL AND g.team_id = ${teamId}::uuid
			JOIN person p ON p.id = a.person_id AND p.tenant_id = a.plant_id AND p.state = 'live'
			WHERE a.plant_id = ${plantId}::uuid AND a.state = 'active') train`;
}

export const trainingReader = {
	async listTraining(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			parse(c.listTrainingRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(json_build_object(
						'id', g.id, 'teamId', g.team_id, 'name', g.name, 'required', g.required, 'version', g.version,
						'revision', g.revision::text, 'archived', (g.archived_at IS NOT NULL),
						'requiredPeople', (SELECT count(*)::int FROM training_assignment a
							JOIN person p ON p.id = a.person_id AND p.tenant_id = a.plant_id AND p.state = 'live'
							WHERE a.program_id = g.id AND a.state = 'active'),
						'compatibleCredits', (SELECT count(*)::int FROM training_assignment a
							JOIN person p ON p.id = a.person_id AND p.tenant_id = a.plant_id AND p.state = 'live'
							WHERE a.program_id = g.id AND a.state = 'active' AND ${compatible}))
						ORDER BY g.name, g.id)
					FROM (SELECT * FROM training_program g WHERE g.plant_id = ${viewer.plantId}::uuid ORDER BY g.name, g.id LIMIT 100) g),
					'[]'::json) AS programs`,
			);
			return c.trainingList.parse({ programs: found.programs });
		});
	},
	async readRequiredTrainingPreview(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.previewRequiredTrainingRequest, raw);
			const wanted = unique(input.personIds);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM training_program WHERE id = ${input.programId}::uuid) AS owner,
					(SELECT g.revision::text FROM training_program g
						WHERE g.id = ${input.programId}::uuid AND g.plant_id = ${viewer.plantId}::uuid) AS revision,
					coalesce((SELECT json_agg(json_build_object('id', p.id, 'revision', p.revision::text) ORDER BY p.id)
						FROM person p
						WHERE p.id = ANY(${sql.param(wanted.length ? wanted : ["00000000-0000-0000-0000-000000000000"])}::uuid[])
							AND p.tenant_id = ${viewer.plantId}::uuid AND p.state = 'live' AND ${wanted.length > 0}), '[]'::json) AS people,
					(SELECT count(*)::int FROM person p
						WHERE p.id = ANY(${sql.param(wanted.length ? wanted : ["00000000-0000-0000-0000-000000000000"])}::uuid[])
							AND p.tenant_id <> ${viewer.plantId}::uuid AND ${wanted.length > 0}) AS foreign`,
			);
			owner(viewer.plantId, found.owner);
			if (z.number().int().parse(found.foreign) > 0) deny("access_denied");
			const people = z.array(z.object({ id: z.string().uuid(), revision: z.string() })).parse(found.people);
			if (people.length !== wanted.length) deny("invalid_subject");
			return c.requiredTrainingPreview.parse({
				programId: input.programId,
				revision: found.revision,
				personIds: wanted,
				rosterDigest: rosterDigest({ programId: input.programId, revision: String(found.revision), people }),
			});
		});
	},
	async readTrainingMatrix(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			parse(c.trainingMatrixRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT coalesce((SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'personIds', coalesce((
						SELECT json_agg(a.person_id ORDER BY a.person_id) FROM training_assignment a
						JOIN person p ON p.id = a.person_id AND p.tenant_id = a.plant_id AND p.state = 'live'
						WHERE a.program_id = g.id AND a.state = 'active'), '[]'::json)) ORDER BY g.name, g.id)
					FROM (SELECT id, name FROM training_program WHERE plant_id = ${viewer.plantId}::uuid ORDER BY name, id LIMIT 100) g),
					'[]'::json) AS programs`,
			);
			return c.trainingMatrix.parse({ programs: found.programs });
		});
	},
	async readPersonTraining(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.personTrainingRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT tenant_id FROM person WHERE id = ${input.personId}::uuid) AS owner,
					coalesce((SELECT json_agg(DISTINCT t.name ORDER BY t.name) FROM team t
						JOIN team_role r ON r.team_id = t.id AND r.retired_at IS NULL
						JOIN team_tenure tn ON tn.role_id = r.id AND tn.ended_on IS NULL AND tn.person_id = ${input.personId}::uuid
						WHERE t.plant_id = ${viewer.plantId}::uuid AND t.archived_at IS NULL), '[]'::json) AS "currentTeams",
					coalesce((SELECT json_agg(DISTINCT t.name ORDER BY t.name) FROM team t
						JOIN team_role r ON r.team_id = t.id
						JOIN team_tenure tn ON tn.role_id = r.id AND tn.person_id = ${input.personId}::uuid
						WHERE t.plant_id = ${viewer.plantId}::uuid
							AND NOT EXISTS (SELECT 1 FROM team_role r2
								JOIN team_tenure tn2 ON tn2.role_id = r2.id AND tn2.ended_on IS NULL AND tn2.person_id = tn.person_id
								WHERE r2.team_id = t.id AND r2.retired_at IS NULL AND t.archived_at IS NULL)), '[]'::json) AS "formerTeams",
					(SELECT count(*)::int FROM team_tenure tn
						JOIN team_role r ON r.id = tn.role_id AND r.retired_at IS NULL
						JOIN team t ON t.id = r.team_id AND t.archived_at IS NULL AND t.plant_id = ${viewer.plantId}::uuid
						WHERE tn.person_id = ${input.personId}::uuid AND tn.ended_on IS NULL) AS "concurrentAssignments",
					(EXISTS (SELECT 1 FROM training_assignment a
						JOIN training_program g ON g.id = a.program_id AND g.required AND g.archived_at IS NULL AND g.plant_id = a.plant_id
						WHERE a.person_id = ${input.personId}::uuid AND a.plant_id = ${viewer.plantId}::uuid AND a.state = 'active')
					 AND NOT EXISTS (SELECT 1 FROM training_assignment a
						JOIN training_program g ON g.id = a.program_id AND g.required AND g.archived_at IS NULL AND g.plant_id = a.plant_id
						WHERE a.person_id = ${input.personId}::uuid AND a.plant_id = ${viewer.plantId}::uuid AND a.state = 'active'
							AND NOT coalesce(${compatible}, false))) AS "currentTrainingComplete",
					EXISTS (SELECT 1 FROM training_credit c
						WHERE c.person_id = ${input.personId}::uuid AND c.plant_id = ${viewer.plantId}::uuid AND c.kind = 'earned') AS "earnedHistoryRetained",
					(SELECT count(*)::int FROM person p WHERE p.id = ${input.personId}::uuid AND p.tenant_id = ${viewer.plantId}::uuid) AS "distinctPeople"`,
			);
			owner(viewer.plantId, found.owner);
			return c.personTraining.parse({
				personId: input.personId,
				currentTeams: found.currentTeams,
				formerTeams: found.formerTeams,
				concurrentAssignments: found.concurrentAssignments,
				currentTrainingComplete: found.currentTrainingComplete,
				earnedHistoryRetained: found.earnedHistoryRetained,
				distinctPeople: found.distinctPeople,
			});
		});
	},
	async readTrainingHistory(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.trainingHistoryRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT tenant_id FROM person WHERE id = ${input.personId}::uuid) AS owner,
					coalesce((SELECT json_agg(json_build_object(
						'id', c.id, 'programId', c.program_id, 'kind', c.kind, 'version', c.version,
						'earnedOn', c.earned_on, 'verifierAccountId', c.verifier_account_id,
						'attendanceDays', c.attendance_days, 'volunteerDays', c.volunteer_days)
						ORDER BY c.recorded_at, c.id)
					FROM (SELECT * FROM training_credit c
						WHERE c.person_id = ${input.personId}::uuid AND c.plant_id = ${viewer.plantId}::uuid
						ORDER BY c.recorded_at, c.id LIMIT 200) c), '[]'::json) AS credits`,
			);
			owner(viewer.plantId, found.owner);
			return c.trainingHistory.parse({ personId: input.personId, credits: found.credits });
		});
	},
	readStaffingFacts: teamFactsRead(c.staffingFactsRequest),
	readTrainingHealth: teamFactsRead(c.trainingHealthRequest),
	async listTeamMeetings(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listTeamMeetingsRequest, raw);
			const found = await row(
				db,
				viewer,
				sql`SELECT (SELECT plant_id FROM team WHERE id = ${input.teamId}::uuid) AS owner,
					coalesce((SELECT json_agg(json_build_object('id', m.id, 'subtype', m.subtype, 'status', m.status,
						'guestIds', coalesce((SELECT json_agg(pa.person_id ORDER BY pa.person_id)
							FROM participation pa WHERE pa.meeting_id = m.id AND pa.removed_at IS NULL), '[]'::json))
						ORDER BY m.starts_at, m.id)
					FROM (SELECT id, subtype, status, starts_at FROM meeting
						WHERE team_id = ${input.teamId}::uuid AND plant_id = ${viewer.plantId}::uuid AND type = 'team_meeting'
						ORDER BY starts_at, id LIMIT 100) m), '[]'::json) AS meetings`,
			);
			owner(viewer.plantId, found.owner);
			return c.teamMeetingList.parse({ teamId: input.teamId, meetings: found.meetings });
		});
	},
};

function teamFactsRead(request: typeof c.staffingFactsRequest | typeof c.trainingHealthRequest) {
	return (db: Reader, authority: RequestActor, raw: unknown) =>
		read(authority, async (viewer) => {
			const input = parse(request, raw);
			const found = await row(db, viewer, facts(viewer.plantId, input.teamId));
			owner(viewer.plantId, found.owner);
			return c.teamFacts.parse({ teamId: input.teamId, ...picked(found) });
		});
}
function picked(found: Record<string, unknown>) {
	return {
		filledSlots: found.filledSlots,
		openSlots: found.openSlots,
		distinctPeople: found.distinctPeople,
		memberAttendance: found.memberAttendance,
		guestCount: found.guestCount,
		rosterDenominator: found.rosterDenominator,
		trainingRate: found.trainingRate,
		staffingRate: found.staffingRate,
		attendanceRate: found.attendanceRate,
		weights: found.weights,
		composite: found.composite,
	};
}
