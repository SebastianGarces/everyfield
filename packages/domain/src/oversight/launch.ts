import * as C from "@everyfield/contracts/oversight";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { compatible } from "../teams/training/reads.ts";

// Launch preparation and Launch Sunday as oversight reads them (WP-047b: oversight.getHealth,
// oversight.readLaunchReadiness) and as the planter's own Launch page reads them, from the same fragments, so a concern
// an organization sees is one the planter sees. Counts only: no role name, person or training title leaves here.

/** The plant-local date today for plant row `pl`. */
const today = (pl: string) => sql`(clock_timestamp() AT TIME ZONE ${sql.raw(pl)}.timezone)::date`;

/** Plant `plant`'s saved required obligations: active assignments of live people to live required programs. */
const requiredObligations = (plant: SQL) => sql`training_assignment a
		JOIN training_program g ON g.id=a.program_id AND g.plant_id=a.plant_id AND g.required AND g.archived_at IS NULL
		JOIN person pe ON pe.id=a.person_id AND pe.plant_id=a.plant_id AND pe.state='live'
		WHERE a.plant_id=${plant} AND a.state='active'`;
/** How many saved required obligations plant `plant` has, or null when none is assigned (NIR-06 applicability). */
export const requiredTrainingCount = (plant: SQL) =>
	sql`(SELECT nullif(count(*), 0)::int FROM ${requiredObligations(plant)})`;

/**
 * Plant `p`'s preparation counts as one JSON value (C.preparation). `teams` is the SQL condition under which the gap
 * counts may be read (Ministry teams shared, or true for the plant's own seat); without it both are null.
 * - unfilledRoles: live roles on live teams that carry a Playbook responsibility and have no current live occupant;
 *   null when no role carries one.
 * - outstandingTraining: active assignments of live people to live required programs with no current compatible
 *   completion; null when none is assigned.
 */
export const preparationJson = (p: SQL, teams: SQL) => sql`(SELECT json_build_object(
	'launched', coalesce(l.actual_date IS NOT NULL OR l.status='completed', false),
	'daysToLaunch', CASE WHEN l.actual_date IS NULL AND l.status='scheduled' AND l.target_date IS NOT NULL
		THEN l.target_date - ${today("pl")} END,
	'unfilledRoles', CASE WHEN ${teams} THEN (SELECT CASE WHEN count(*) > 0 THEN (count(*) FILTER (WHERE NOT x.filled))::int END
		FROM (SELECT EXISTS(SELECT FROM team_tenure tn JOIN person pe ON pe.id=tn.person_id AND pe.plant_id=tn.plant_id
			AND pe.state='live' WHERE tn.role_id=r.id AND tn.plant_id=r.plant_id AND tn.ended_on IS NULL) AS filled
			FROM team_role r JOIN team t ON t.id=r.team_id AND t.archived_at IS NULL
			WHERE r.plant_id=pl.id AND r.retired_at IS NULL AND r.responsibility_key IS NOT NULL) x) END,
	'outstandingTraining', CASE WHEN ${teams} THEN (SELECT CASE WHEN count(*) > 0
			THEN (count(*) FILTER (WHERE NOT coalesce(${compatible}, false)))::int END
		FROM ${requiredObligations(sql`pl.id`)}) END)
	FROM plant pl LEFT JOIN launch l ON l.plant_id=pl.id WHERE pl.id=${p})`;

/**
 * Plant `p`'s Launch Sunday for the plant view, as one JSON value: status and dates, the latest date change, the
 * readiness milestones completed (and not waiting for review) out of the plan's milestones, and the recorded outcome's
 * date and counts. Never the outcome note, the debrief, guests or who changed anything.
 */
export const launchJson = (p: SQL) => sql`(SELECT json_build_object('status', l.status,
	'targetDate', l.target_date::text, 'today', ${today("pl")}::text,
	'lastDateEvent', (SELECT a.metadata->>'event' FROM audit_event a WHERE a.tenant_id=pl.id AND a.action='launch.changed'
		AND a.subject_type='launch' AND a.metadata->>'event' IN ('scheduled','moved','postponed','rescheduled')
		ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1),
	'milestones', (SELECT count(*)::int FROM launch_milestone m WHERE m.plant_id=pl.id AND m.removed_at IS NULL),
	'completed', (SELECT count(*)::int FROM launch_milestone m WHERE m.plant_id=pl.id AND m.removed_at IS NULL
		AND m.completed_at IS NOT NULL AND NOT EXISTS(SELECT FROM task k WHERE k.id=ANY(m.completed_task_ids)
			AND k.plant_id=m.plant_id AND k.deleted_at IS NULL AND k.status NOT IN ('complete','no_longer_needed'))),
	'actualDate', l.actual_date::text, 'attendance', l.attendance, 'decisions', l.decisions)
	FROM plant pl LEFT JOIN launch l ON l.plant_id=pl.id WHERE pl.id=${p})`;

const launchRow = z.object({
	status: z.enum(["planning", "scheduled", "postponed", "completed"]).nullable(),
	targetDate: z.string().nullable(),
	today: z.string(),
	lastDateEvent: z.string().nullable(),
	milestones: z.int(),
	completed: z.int(),
	actualDate: z.string().nullable(),
	attendance: z.int().nullable(),
	decisions: z.int().nullable(),
});
/** The plant view's shared Launch from launchJson and preparationJson. */
export function plantLaunchOf(raw: unknown, preparation: unknown): C.PlantLaunch {
	const r = launchRow.parse(raw);
	const state: C.LaunchState = r.actualDate
		? "completed"
		: r.status === "postponed"
			? "postponed"
			: r.status !== "scheduled" || !r.targetDate
				? "not_set"
				: r.targetDate < r.today
					? "overdue"
					: r.lastDateEvent === "moved" || r.lastDateEvent === "rescheduled"
						? "moved"
						: "scheduled";
	return C.plantLaunch.parse({
		status: "shared",
		state,
		plannedDate: r.status === "postponed" ? null : r.targetDate,
		milestones: { completed: r.completed, total: r.milestones },
		outcome: r.actualDate ? { actualDate: r.actualDate, attendance: r.attendance, decisions: r.decisions } : null,
		preparation: C.preparation.parse(preparation),
	});
}
