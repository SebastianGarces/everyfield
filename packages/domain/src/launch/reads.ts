import { calendarContext, instant, timeZone, type Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { assigneesOf } from "../tasks/assignees.ts";
import { SEED } from "./catalog.ts";
import { deny, scopeOf, settle } from "./core.ts";

export const systemClock: Clock = { now: () => instant.parse(new Date().toISOString()) };
const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const TASK_COUNT = SEED.reduce((n, m) => n + m.taskKeys.length, 0);

/**
 * A distinct practice actually held: a Pre-launch practice marked held, at or before now and not voided. The same
 * predicate as meetings.listCompletedPreLaunchPractices (REQ-KNOW-041 to 045). `plant` is an SQL plant id.
 */
export const heldPractices = (plant: SQL) => sql`(SELECT count(*)::int FROM meeting x WHERE x.plant_id=${plant}
	AND x.type='prelaunch_practice' AND x.status='completed' AND x.actual_occurrence_at<=clock_timestamp()
	AND x.occurrence_voided_at IS NULL)`;

/**
 * One milestone as JSON with its live linked tasks, in Playbook task order. Progress is read from the tasks each time,
 * never a stored counter (LCH-004). A completion needs review when a task that was complete at completion is open now.
 */
export const milestoneJson = (m: string) => {
	const r = sql.raw(m);
	return sql`jsonb_build_object('id',${r}.id,'templateKey',${r}.template_key,'area',${r}.area,'title',${r}.title,
	'description',${r}.description,'revision',${r}.revision::text,
	'completedAt',${iso(sql`${r}.completed_at`)},'completedBy',${r}.completed_by,
	'completedByName',(SELECT i.display_name FROM seat_identity(${r}.completed_by) i LIMIT 1),
	'needsReview',${r}.completed_at IS NOT NULL AND EXISTS(SELECT FROM task k WHERE k.id=ANY(${r}.completed_task_ids)
		AND k.plant_id=${r}.plant_id AND k.deleted_at IS NULL AND k.status NOT IN ('complete','no_longer_needed')),
	'tasks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'title',k.title,'status',k.status,
		'revision',k.revision::text,'dueDate',k.due_date::text,'assignees',${assigneesOf("k")})
		ORDER BY split_part(k.launch_task_key,'/',2)::int, k.id),'[]')
		FROM task k WHERE k.plant_id=${r}.plant_id AND k.deleted_at IS NULL
		AND split_part(k.launch_task_key,'/',1)=${r}.template_key))`;
};
const milestoneRow = z.object({
	id: z.uuid(),
	templateKey: z.string(),
	area: c.area,
	title: z.string(),
	description: z.string().nullable(),
	revision: z.string(),
	completedAt: z.string().nullable(),
	completedBy: z.uuid().nullable(),
	completedByName: z.string().nullable(),
	needsReview: z.boolean(),
	tasks: z.array(
		z.object({
			id: z.uuid(),
			title: z.string(),
			status: c.prepTask.shape.status,
			revision: z.string(),
			dueDate: z.string().nullable(),
			assignees: z.array(z.object({ accountId: z.uuid(), displayName: z.string() })),
		}),
	),
});
export function milestoneOf(raw: unknown, practices: number): c.Milestone {
	const m = milestoneRow.parse(raw);
	return c.milestone.parse({
		id: m.id,
		templateKey: m.templateKey,
		area: m.area,
		title: m.title,
		description: m.description,
		revision: m.revision,
		completion: m.completedAt
			? {
					at: m.completedAt,
					by: m.completedBy ? { accountId: m.completedBy, displayName: m.completedByName ?? "" } : null,
				}
			: null,
		needsReview: m.needsReview,
		tasks: m.tasks.map((t) => ({
			...t,
			assignees: t.assignees.map((a) => ({ accountId: a.accountId, displayName: a.displayName })),
		})),
		practices: m.templateKey === c.PRACTICE_MILESTONE ? { held: practices, required: c.PRACTICES_REQUIRED } : null,
	});
}

/** The plan as JSON columns of one statement: `p` is a plant row, `access` the read's live condition. */
export const planColumns = (plant: SQL) => sql`(SELECT timezone FROM plant WHERE id=${plant}) AS timezone,
	(SELECT jsonb_build_object('status',l.status,'targetDate',l.target_date::text,'revision',l.revision::text)
		FROM launch l WHERE l.plant_id=${plant}) AS launch,
	(SELECT coalesce(jsonb_agg(${milestoneJson("m")} ORDER BY m.position),'[]') FROM launch_milestone m
		WHERE m.plant_id=${plant} AND m.removed_at IS NULL) AS milestones,
	${heldPractices(plant)} AS practices,
	(SELECT count(*)::int FROM launch_milestone m WHERE m.plant_id=${plant}) AS seeded_milestones,
	(SELECT count(*)::int FROM task k WHERE k.plant_id=${plant} AND k.launch_task_key IS NOT NULL) AS seeded_tasks`;
const planRow = z.object({
	timezone: timeZone,
	launch: z.object({ status: c.launchStatus, targetDate: z.string().nullable(), revision: z.string() }).nullable(),
	milestones: z.array(z.unknown()),
	practices: z.int(),
	seeded_milestones: z.int(),
	seeded_tasks: z.int(),
});
/** The plan from planColumns, and whether readiness needs repair: a dated plan missing seeded milestones or tasks. */
export function planOf(raw: unknown, clock: Clock) {
	const r = planRow.parse(raw);
	const plan = c.plan.parse({
		today: calendarContext(r.timezone, clock).localDate,
		timeZone: r.timezone,
		launch: r.launch,
		revision: r.launch?.revision ?? "1",
		milestones: r.milestones.map((m) => milestoneOf(m, r.practices)),
	});
	const dated = r.launch !== null && r.launch.status !== "planning";
	const incomplete = r.seeded_milestones < SEED.length || r.seeded_tasks < TASK_COUNT;
	return { plan, repair: dated && incomplete };
}

export function createLaunchReader(clock: Clock = systemClock) {
	return {
		/**
		 * launch.readPlan (LCH-001, LCH-008): the planned date, the church-local date today and the nine milestones with
		 * their live prep tasks and the held-practice count. Any seat of the church reads it. One statement, gated by the
		 * live seat (C13). `repair` says an Owner or Admin opening the plan should run launch.ensureReadiness.
		 */
		async readPlan(db: Pick<Database, "execute">, authority: RequestActor) {
			return settle(async () => {
				const scope = scopeOf(authority);
				const { rows } = await db.execute(sql`SELECT g.ok, q.* FROM (SELECT ${scope.live} AS ok) g
	LEFT JOIN LATERAL (SELECT ${planColumns(sql`${scope.plantId}::uuid`)}) q ON g.ok`);
				const row = rows[0];
				if (!row?.ok || !row.timezone) deny("access_denied");
				return planOf(row, clock);
			});
		},
	};
}
export type LaunchReader = ReturnType<typeof createLaunchReader>;
