import { calendarContext, instant, timeZone, type Clock } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/launch";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveAccess, liveRead, liveRows, type RequestActor } from "../access/session.ts";
import { linkActive } from "../organizations/core.ts";
import { personSearchMatch } from "../people/search.ts";
import { assigneesOf } from "../tasks/assignees.ts";
import { SEED } from "./catalog.ts";
import { deny, scopeOf, settle, type Scope } from "./core.ts";
import { historyOf, LAUNCH_ACTIONS } from "./history.ts";

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
		tasks: m.tasks,
		practices: m.templateKey === c.PRACTICE_MILESTONE ? { held: practices, required: c.PRACTICES_REQUIRED } : null,
	});
}

const personJson = (id: SQL) => sql`CASE WHEN ${id} IS NOT NULL THEN jsonb_build_object('accountId',${id},
	'displayName',(SELECT i.display_name FROM seat_identity(${id}) i LIMIT 1)) END`;
/** One debrief version as JSON: `d` is a launch_debrief row. */
const debriefJson = (d: string) => {
	const r = sql.raw(d);
	return sql`jsonb_build_object('id',${r}.id,'version',${r}.version,'revision',${r}.revision::text,
	'answers',jsonb_build_object('wentWell',${r}.went_well,'toChange',${r}.to_change,'operations',${r}.operations,
		'followUpPlan',${r}.follow_up_plan,'supportNeeded',${r}.support_needed,'missingNames',${r}.missing_names,
		'missingCount',${r}.missing_count),
	'savedAt',${iso(sql`${r}.saved_at`)},'savedBy',${personJson(sql`${r}.saved_by`)},
	'submittedAt',${iso(sql`${r}.submitted_at`)},'submittedBy',${personJson(sql`${r}.submitted_by`)})`;
};
/** The live People named as guests: a retired or merged-away Person leaves the roster, and its link stays as history. */
const rosterOf = (plant: SQL) => sql`launch_guest g JOIN person pe ON pe.id=g.person_id AND pe.tenant_id=g.plant_id
	AND pe.state='live' WHERE g.plant_id=${plant}`;
/**
 * What happened on Launch Sunday, as JSON columns (WP-046). `admin` is the reader's Owner or Admin condition: a Member
 * gets the outcome, the guest count and the evidence, never guest names, debrief answers or the summary.
 */
const outcomeColumns = (plant: SQL, admin: SQL) => sql`${admin} AS admin,
	(SELECT jsonb_build_object('actualDate',l.actual_date::text,'attendance',l.attendance,'decisions',l.decisions,
		'note',l.outcome_note,'recordedAt',${iso(sql`l.outcome_recorded_at`)},'recordedBy',${personJson(sql`l.outcome_recorded_by`)})
		FROM launch l WHERE l.plant_id=${plant} AND l.actual_date IS NOT NULL) AS outcome,
	(SELECT count(*)::int FROM ${rosterOf(plant)}) AS guest_count,
	CASE WHEN ${admin} THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('guestId',g.id,'personId',g.person_id,
		'displayName',pe.display_name,'recordedAt',${iso(sql`g.recorded_at`)}) ORDER BY g.recorded_at,g.id),'[]')
		FROM ${rosterOf(plant)}) END AS guests,
	(SELECT ${debriefJson("d")} FROM launch_debrief d WHERE d.plant_id=${plant} AND d.submitted_at IS NOT NULL
		ORDER BY d.version DESC LIMIT 1) AS submitted,
	(SELECT count(*)::int FROM launch_debrief d WHERE d.plant_id=${plant} AND d.submitted_at IS NOT NULL) AS submissions,
	CASE WHEN ${admin} THEN (SELECT ${debriefJson("d")} FROM launch_debrief d WHERE d.plant_id=${plant}
		AND d.submitted_at IS NULL) END AS draft,
	CASE WHEN ${admin} THEN (SELECT jsonb_build_object('id',s.id,'revision',s.revision::text,'body',s.body,
		'savedAt',${iso(sql`s.saved_at`)}) FROM launch_summary s WHERE s.plant_id=${plant} AND s.published_at IS NULL) END AS summary_draft,
	CASE WHEN ${admin} THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'body',s.body,
		'publishedAt',${iso(sql`s.published_at`)},'publishedBy',${personJson(sql`s.published_by`)}) ORDER BY s.version DESC),'[]')
		FROM launch_summary s WHERE s.plant_id=${plant} AND s.published_at IS NOT NULL) END AS published`;

/**
 * The plan as JSON columns of one statement: `plant` is an SQL plant id and `admin` the reader's Owner or Admin
 * condition (a writer passes true: only Owners and Admins write).
 */
export const planColumns = (plant: SQL, admin: SQL) => sql`${outcomeColumns(plant, admin)},
	(SELECT timezone FROM plant WHERE id=${plant}) AS timezone,
	(SELECT jsonb_build_object('status',l.status,'targetDate',l.target_date::text,'revision',l.revision::text)
		FROM launch l WHERE l.plant_id=${plant}) AS launch,
	(SELECT coalesce(jsonb_agg(${milestoneJson("m")} ORDER BY m.position),'[]') FROM launch_milestone m
		WHERE m.plant_id=${plant} AND m.removed_at IS NULL) AS milestones,
	${heldPractices(plant)} AS practices,
	(SELECT count(*)::int FROM launch_milestone m WHERE m.plant_id=${plant}) AS seeded_milestones,
	(SELECT count(*)::int FROM task k WHERE k.plant_id=${plant} AND k.launch_task_key IS NOT NULL) AS seeded_tasks`;
/** An account named on a row: null when the account has since been deleted. */
const named = z
	.object({ accountId: z.uuid(), displayName: z.string().nullable() })
	.nullable()
	.transform((p) => (p && p.displayName !== null ? { accountId: p.accountId, displayName: p.displayName } : null));
const debriefRow = z
	.object({
		id: z.uuid(),
		version: z.int(),
		revision: z.string(),
		answers: c.debriefAnswers,
		savedAt: z.string(),
		savedBy: named,
		submittedAt: z.string().nullable(),
		submittedBy: named,
	})
	.nullable();
const planRow = z.object({
	admin: z.boolean(),
	outcome: z
		.object({
			actualDate: z.string(),
			attendance: z.int().nullable(),
			decisions: z.int().nullable(),
			note: z.string().nullable(),
			recordedAt: z.string(),
			recordedBy: named,
		})
		.nullable(),
	guest_count: z.int(),
	guests: z.array(z.unknown()).nullable(),
	submitted: debriefRow,
	submissions: z.int(),
	draft: debriefRow,
	summary_draft: z.unknown().nullable(),
	published: z.array(z.unknown()).nullable(),
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
		outcome: r.outcome,
		guests: { count: r.guest_count, named: r.admin ? r.guests : null },
		evidence: c.evidenceOf(r.submitted),
		debrief: r.admin ? { draft: r.draft, submitted: r.submitted, submissions: r.submissions } : null,
		summary: r.admin ? { draft: r.summary_draft, published: r.published ?? [] } : null,
	});
	const dated = r.launch !== null && r.launch.status !== "planning";
	const incomplete = r.seeded_milestones < SEED.length || r.seeded_tasks < TASK_COUNT;
	return { plan, repair: dated && incomplete };
}

/** The plan after a write, in the write's transaction. */
export async function planAfter(tx: Transaction, scope: Scope, clock: Clock) {
	const { rows } = await tx.execute(sql`SELECT ${planColumns(sql`${scope.plantId}::uuid`, sql`true`)}`);
	return planOf(rows[0], clock).plan;
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
	LEFT JOIN LATERAL (SELECT ${planColumns(sql`${scope.plantId}::uuid`, scope.admin)}) q ON g.ok`);
				const row = rows[0];
				if (!row?.ok || !row.timezone) deny("access_denied");
				return planOf(row, clock);
			});
		},
		/**
		 * launch.readJournal (LCH-002, LCH-010): every Launch change, newest first, with who made it and when. Owners and
		 * Admins read it; one statement gated by their live seat. A deleted account reads as a former account.
		 */
		async readJournal(db: Pick<Database, "execute">, authority: RequestActor) {
			return settle(async () => {
				const scope = scopeOf(authority);
				const p = sql`${scope.plantId}::uuid`;
				const { rows } = await db.execute(sql`SELECT g.ok,(SELECT timezone FROM plant WHERE id=${p}) AS timezone,
	CASE WHEN g.ok THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'at',${iso(sql`a.occurred_at`)},
		'actorId',a.actor_id,'actorName',(SELECT i.display_name FROM seat_identity(a.actor_id) i LIMIT 1),
		'action',a.action,'kind',a.kind,'subjectType',a.subject_type,'before',a.before_value,'after',a.after_value,
		'reason',a.reason,'metadata',a.metadata,
		'title',(SELECT m.title FROM launch_milestone m WHERE a.subject_type='launch_milestone' AND m.id=a.subject_id),
		'guestName',(SELECT pe.display_name FROM launch_guest lg JOIN person pe ON pe.id=lg.person_id
			AND pe.tenant_id=lg.plant_id WHERE a.subject_type='launch_guest' AND lg.id=a.subject_id))
		ORDER BY a.occurred_at DESC,a.id DESC),'[]') FROM audit_event a WHERE a.tenant_id=${p}
		AND a.action IN (${sql.join(
			LAUNCH_ACTIONS.map((x) => sql`${x}`),
			sql`,`,
		)}) AND a.kind<>'noop') END AS entries
 FROM (SELECT ${scope.admin} AS ok) g`);
				const r = z
					.object({ ok: z.boolean(), timezone: z.string().nullable(), entries: z.array(z.unknown()).nullable() })
					.parse(rows[0]);
				if (!r.ok || !r.timezone) deny("access_denied");
				return c.history.parse({ timeZone: r.timezone, entries: historyOf(r.entries ?? []) });
			});
		},
		/**
		 * The church's live People a typed guest name may be (LCH-007), for an Owner or Admin to pick from. A match is only
		 * offered: nothing links or merges until the planter picks it. One statement with the live seat check.
		 */
		async suggestGuests(db: Pick<Database, "execute">, authority: RequestActor, query: string) {
			return settle(async () => {
				const scope = scopeOf(authority);
				const p = sql`${scope.plantId}::uuid`;
				const { rows } = await db.execute(sql`SELECT g.ok,x.* FROM (SELECT ${scope.admin} AS ok) g
	LEFT JOIN LATERAL (SELECT person.id,person.display_name,coalesce(person.email,person.phone,'') AS detail,
		EXISTS(SELECT FROM launch_guest lg WHERE lg.plant_id=${p} AND lg.person_id=person.id) AS already_guest
		FROM person WHERE g.ok AND person.plant_id=${p} AND person.state='live' AND ${personSearchMatch(query.slice(0, 200))}
		ORDER BY person.created_at,person.id LIMIT 8) x ON true`);
				if (rows[0]?.ok !== true) deny("access_denied");
				return rows.flatMap((r) =>
					r.id
						? [
								c.guestMatch.parse({
									personId: r.id,
									displayName: r.display_name,
									detail: r.detail,
									alreadyGuest: r.already_guest,
								}),
							]
						: [],
				);
			});
		},
		/**
		 * The published Launch summary an organization may read (REQ-KNOW-112, REQ-KNOW-114, LAUNCH46-016): the latest
		 * published version, only while this exact organization has a current link with Plant Intelligence findings shared
		 * (`shared_findings`) and every source category the version draws on shared. It is readable from the moment it is
		 * published; it never waits for an assessment release. Drafts, debrief answers and guest names are never read here.
		 * Null for anything else, including an organization that may not read it. One statement with the live seat check.
		 */
		async readPublishedSummary(db: Pick<Database, "execute">, authority: RequestActor, plantId: string) {
			const ctx = authority.actor.context;
			if (ctx.kind !== "seat" || ctx.owner.kind !== "organization") return null;
			const id = z.uuid().safeParse(plantId);
			if (!id.success) return null;
			const shared = sql`CASE c WHEN 'meetings' THEN k.share_meetings WHEN 'people' THEN k.share_people
				WHEN 'tasks' THEN k.share_tasks WHEN 'ministry' THEN k.share_ministry_teams ELSE false END`;
			const found = await liveRows(
				db,
				liveRead(liveAccess(authority)),
				sql`SELECT s.version,s.body,${iso(sql`s.published_at`)} AS published_at FROM affiliation k
	JOIN LATERAL (SELECT * FROM launch_summary x WHERE x.plant_id=k.plant_id AND x.published_at IS NOT NULL
		ORDER BY x.version DESC LIMIT 1) s ON true
	WHERE k.organization_id=${ctx.owner.id}::uuid AND k.plant_id=${id.data}::uuid AND ${linkActive("k")}
		AND k.shared_findings AND NOT EXISTS(SELECT FROM unnest(s.source_categories) c WHERE NOT coalesce(${shared},false))`,
			);
			const row = found?.[0];
			return row
				? c.sharedSummary.parse({ version: row.version, body: row.body, publishedAt: row.published_at })
				: null;
		},
	};
}
