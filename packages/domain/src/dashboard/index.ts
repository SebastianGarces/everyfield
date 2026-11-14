import * as c from "@everyfield/contracts/dashboard";
import type { PlantSetup } from "@everyfield/contracts/identity";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer } from "../documents/access.ts";
import { readPlantSetupComplete } from "../identity/reads.ts";

// Overview (WP-048): ADM-004 home routing and ADM-005 metrics, activity, quick actions and prompts. Every read is one
// statement whose live seat check gates every row it returns (C13). Overview certifies nothing: its numbers are counts,
// and a dismissed prompt only hides the prompt (REQ-ADM-005).

type Db = Pick<Database, "execute">;
type Scope = { plantId: string; accountId: string; seatId: string; live: SQL; admin: SQL; member: boolean };

class Refusal extends Error {
	constructor(readonly code: c.DashboardError["code"]) {
		super(code);
	}
}
const deny = (code: c.DashboardError["code"] = "access_denied"): never => {
	throw new Refusal(code);
};
async function settle<T>(body: () => Promise<T>): Promise<c.DashboardReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof Refusal) return { status: "refused", error: { code: error.code } };
		throw error;
	}
}
/** The request's plant seat. `live` holds while the session and this exact seat do; `admin` adds Owner or Admin. */
function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) return deny();
	const member = viewer.access.role === "member";
	return {
		plantId: viewer.plantId,
		accountId: viewer.accountId,
		seatId: viewer.access.seatId ?? deny(),
		live: liveRead(viewer.access),
		admin: member ? sql`false` : liveRead(viewer.access, true),
		member,
	};
}
const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A Person who is one of the church's own logins: linked to an account with a current seat here. */
const seatPerson = (x: string) => {
	const p = sql.raw(x);
	return sql`(${p}.linked_account_id IS NOT NULL AND EXISTS(SELECT FROM seat s WHERE s.plant_id=${p}.plant_id
		AND s.account_id=${p}.linked_account_id AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()))`;
};

/**
 * The first-week steps still open, from what the church recorded (dashboard.readSetupGaps). People counts anyone but the
 * church's own logins; a team is a second seat or an open seat invitation; a launch date is a planned or recorded date.
 */
const gapColumns = (p: SQL) => sql`
	NOT EXISTS(SELECT FROM person x WHERE x.plant_id=${p} AND x.state='live' AND NOT ${seatPerson("x")}) AS gap_add_people,
	NOT EXISTS(SELECT FROM meeting m WHERE m.plant_id=${p} AND m.type='vision_meeting' AND m.retired_at IS NULL
		AND m.status<>'cancelled') AS gap_plan_vision_meeting,
	(SELECT count(*) FROM seat s WHERE s.plant_id=${p} AND s.ended_at IS NULL)
		+ (SELECT count(*) FROM invitation i WHERE i.tenant_id=${p} AND i.purpose='seat' AND i.state='pending') <= 1
		AS gap_invite_team,
	NOT EXISTS(SELECT FROM launch l WHERE l.plant_id=${p} AND (l.target_date IS NOT NULL OR l.actual_date IS NOT NULL))
		AS gap_set_launch_date,
	(SELECT onboarding_completed_at IS NOT NULL FROM plant WHERE id=${p}) AS setup_complete`;
const gapRow = z.object({
	gap_add_people: z.boolean(),
	gap_plan_vision_meeting: z.boolean(),
	gap_invite_team: z.boolean(),
	gap_set_launch_date: z.boolean(),
	setup_complete: z.boolean(),
});
function gapsOf(raw: unknown): c.SetupGaps {
	const r = gapRow.parse(raw);
	const open: Record<c.SetupStep, boolean> = {
		add_people: r.gap_add_people,
		plan_vision_meeting: r.gap_plan_vision_meeting,
		invite_team: r.gap_invite_team,
		set_launch_date: r.gap_set_launch_date,
	};
	return { setupComplete: r.setup_complete, gaps: c.SETUP_STEPS.filter((s) => open[s]) };
}

/** The section a prompt dismissal is audited under: settings.changed names the field, never a value (audit.md). */
const PROMPT_SECTION = "overview_prompts";
/** The prompts this person dismissed in this church, from their own dismissal audit rows (dashboard.promptState). */
const dismissedColumn = (scope: Scope) => sql`(SELECT coalesce(jsonb_agg(DISTINCT a.metadata->>'prompt'),'[]')
	FROM audit_event a WHERE a.actor_id=${scope.accountId}::uuid AND a.action='settings.changed'
	AND a.tenant_id=${scope.plantId}::uuid AND a.metadata->>'section'=${PROMPT_SECTION}) AS dismissed`;
const dismissedOf = (raw: unknown) => z.array(c.promptKey).parse(raw);

/** The step each optional prompt answers: it shows only while that step is open. */
const PROMPT_STEP: Record<c.PromptKey, c.SetupStep> = { import_people: "add_people", invite_team: "invite_team" };

const frameRow = z.object({
	ok: z.boolean(),
	admin: z.boolean().nullable(),
	name: z.string().nullable(),
	phase: z.int().nullable(),
	timezone: z.string().nullable(),
	today: z.string().nullable(),
	created_on: z.string().nullable(),
	dismissed: z.unknown(),
});

export const dashboardReader = {
	/**
	 * dashboard.resolveHome (ADM-004): which home the request's seat has. An organization seat has its organization home;
	 * a plant seat has Overview once the church's setup is saved complete, else its setup; any other account has its own
	 * onboarding or Discovery page ("none"). Only the validated seat and the persisted onboarding fact decide it: no
	 * caller input takes part, so a query parameter, returnTo or browser dismissal never certifies setup. One statement for
	 * a plant seat, with the live check as its predicate; a failed check reads as setup not finished.
	 */
	async resolveHome(db: Db, authority: RequestActor | null): Promise<PlantSetup> {
		const context = authority?.actor.context;
		if (!authority || context?.kind !== "seat") return "none";
		if (context.owner.kind === "organization") return "organization";
		return (await readPlantSetupComplete(db, authority.session, context.owner)) ? "complete" : "incomplete";
	},

	/** dashboard.readSetupGaps (ADM-004): whether setup is saved complete and which first-week steps are still open. */
	async readSetupGaps(db: Db, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const { rows } = await db.execute(sql`SELECT g.ok,q.* FROM (SELECT ${scope.live} AS ok) g
	LEFT JOIN LATERAL (SELECT ${gapColumns(sql`${scope.plantId}::uuid`)}) q ON g.ok`);
			const r = rows[0];
			if (!r || r.ok !== true) return deny();
			return c.setupGaps.parse(gapsOf(r));
		});
	},

	/** dashboard.promptState (ADM-005): the optional prompts this person dismissed in this church. */
	async readPromptState(db: Db, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const { rows } = await db.execute(sql`SELECT g.ok,q.* FROM (SELECT ${scope.live} AS ok) g
	LEFT JOIN LATERAL (SELECT ${dismissedColumn(scope)}) q ON g.ok`);
			const r = rows[0];
			if (!r || r.ok !== true) return deny();
			return c.promptState.parse({ dismissed: dismissedOf(r.dismissed) });
		});
	},

	/**
	 * dashboard.availableActions (ADM-005): the church as this seat sees it now: its name, saved phase, church-local
	 * today and creation day, the quick actions the live seat can use (Owner and Admin write; a Member has none), the
	 * setup gaps and the optional prompts still showing. One statement.
	 */
	async readAvailableActions(db: Db, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const p = sql`${scope.plantId}::uuid`;
			const { rows } = await db.execute(sql`SELECT g.ok,g.admin,pl.name,pl.phase,pl.timezone,
	to_char((clock_timestamp() AT TIME ZONE pl.timezone)::date,'YYYY-MM-DD') AS today,
	to_char(((SELECT min(t.occurred_at) FROM phase_transition t WHERE t.plant_id=pl.id AND t.kind='creation')
		AT TIME ZONE pl.timezone)::date,'YYYY-MM-DD') AS created_on,
	${dismissedColumn(scope)}, q.*
 FROM (SELECT ${scope.live} AS ok, ${scope.admin} AS admin) g
 LEFT JOIN plant pl ON g.ok AND pl.id=${p}
 LEFT JOIN LATERAL (SELECT ${gapColumns(p)}) q ON pl.id IS NOT NULL`);
			const r = frameRow.parse(rows[0]);
			if (!r.ok || r.name === null || r.phase === null || !r.timezone || !r.today) return deny();
			const setup = gapsOf(rows[0]);
			const admin = r.admin === true;
			const dismissed = new Set(dismissedOf(r.dismissed));
			const firstWeek = r.created_on !== null && Date.parse(r.today) - Date.parse(r.created_on) < 7 * 86_400_000;
			return c.overviewFrame.parse({
				plantName: r.name,
				phase: r.phase,
				timeZone: r.timezone,
				today: r.today,
				firstWeek,
				role: authority.actor.context.kind === "seat" ? authority.actor.context.role : "member",
				actions: admin ? c.QUICK_ACTIONS : [],
				setup,
				prompts: admin ? c.PROMPTS.filter((k) => setup.gaps.includes(PROMPT_STEP[k]) && !dismissed.has(k)) : [],
			});
		});
	},

	/**
	 * dashboard.metrics (ADM-005): four independent counts in one statement. None is compared with a target.
	 * - Recruited: live People in core group, launch team or leader, without the church's own logins.
	 * - People: every live Person; retired and merged People are not counted.
	 * - My overdue tasks: the viewer's own open top-level tasks past due: a date-only task from the church-local midnight
	 *   after its day, a timed one once its time has passed. Tasks assigned only to others are not counted.
	 * - Vision Meetings: held (completed, at or before now), neither voided nor deleted.
	 */
	async readMetrics(db: Db, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const p = sql`${scope.plantId}::uuid`;
			const { rows } = await db.execute(sql`SELECT g.ok,q.* FROM (SELECT ${scope.live} AS ok) g
	LEFT JOIN LATERAL (SELECT
	(SELECT count(*)::int FROM person x WHERE x.plant_id=${p} AND x.state='live'
		AND x.stage IN ('core_group','launch_team','leader') AND NOT ${seatPerson("x")}) AS recruited,
	(SELECT count(*)::int FROM person x WHERE x.plant_id=${p} AND x.state='live') AS people,
	(SELECT count(*)::int FROM task t JOIN plant pl ON pl.id=t.plant_id WHERE t.plant_id=${p} AND t.parent_id IS NULL
		AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed')
		AND EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=t.id AND ta.account_id=${scope.accountId}::uuid)
		AND ((t.due_kind='timed' AND t.due_at<clock_timestamp())
			OR (t.due_kind='date_only' AND ((t.due_date+1)::timestamp AT TIME ZONE pl.timezone)<=clock_timestamp())))
		AS my_overdue,
	(SELECT count(*)::int FROM meeting m WHERE m.plant_id=${p} AND m.type='vision_meeting' AND m.status='completed'
		AND m.retired_at IS NULL AND m.occurrence_voided_at IS NULL AND m.actual_occurrence_at<=clock_timestamp())
		AS vision) q ON g.ok`);
			const r = rows[0];
			if (!r || r.ok !== true) return deny();
			return c.metrics.parse({
				recruited: r.recruited,
				people: r.people,
				myOverdueTasks: r.my_overdue,
				visionMeetings: r.vision,
			});
		});
	},

	/**
	 * dashboard.activity (ADM-005): the 20 latest changes in the church the viewer can open, newest first, from the
	 * audit record of each change: a Person added, a meeting held, attendance corrected (the same meeting, never a new
	 * one), a task completed, Launch Sunday set, moved or postponed, Launch Sunday recorded and, for Owners and Admins,
	 * a phase change. An entry whose item is gone (a deleted task, a deleted meeting) is left out, as is one for an item
	 * the viewer cannot open. Who did it is the account on the row. One statement.
	 */
	async readActivity(db: Db, authority: RequestActor) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const p = sql`${scope.plantId}::uuid`;
			const actions = ACTIVITY_ACTIONS.map((a) => sql`${a}`);
			const { rows } = await db.execute(sql`SELECT g.ok,(SELECT timezone FROM plant WHERE g.ok AND id=${p}) AS timezone,
	CASE WHEN g.ok THEN (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.occurred_at DESC,e.id DESC),'[]') FROM (
	SELECT a.id,a.occurred_at,${iso(sql`a.occurred_at`)} AS at,a.action,a.kind,a.metadata->>'event' AS event,
		a.after_value,a.actor_id,(SELECT i.display_name FROM seat_identity(a.actor_id) i LIMIT 1) AS actor_name,
		a.subject_id,x.display_name AS person_name,m.title AS meeting_title,m.type AS meeting_type,t.title AS task_title
	FROM audit_event a
	LEFT JOIN person x ON a.subject_type='person' AND x.id=a.subject_id AND x.tenant_id=${p}
	LEFT JOIN meeting m ON a.subject_type='meeting' AND m.id=a.subject_id AND m.plant_id=${p}
	LEFT JOIN task t ON a.subject_type='task' AND t.id=a.subject_id AND t.plant_id=${p}
	WHERE a.tenant_id=${p} AND a.action IN (${sql.join(actions, sql`,`)}) AND a.kind<>'noop' AND (
		(a.action='people.created' AND x.id IS NOT NULL)
		OR (a.action='meetings.finalized' AND a.kind IN ('finalize','complete','reconcile') AND m.retired_at IS NULL
			AND m.id IS NOT NULL)
		OR (a.action='tasks.completed' AND t.deleted_at IS NULL AND t.id IS NOT NULL)
		OR (a.action IN ('launch.changed','launch.outcome_recorded') AND a.subject_type='launch')
		OR (a.action IN ('phase.declared','phase.transitioned') AND g.admin))
	ORDER BY a.occurred_at DESC,a.id DESC LIMIT ${c.ACTIVITY_LIMIT + 1}) e) END AS entries
 FROM (SELECT ${scope.live} AS ok, ${scope.admin} AS admin) g`);
			const r = z
				.object({ ok: z.boolean(), timezone: z.string().nullable(), entries: z.array(eventRow).nullable() })
				.parse(rows[0]);
			if (!r.ok || !r.timezone || !r.entries) return deny();
			const entries = r.entries.flatMap((e) => {
				const change = changeOf(e);
				return change
					? [
							{
								id: e.id,
								at: e.at,
								actor:
									e.actor_id && e.actor_name !== null ? { accountId: e.actor_id, displayName: e.actor_name } : null,
								change,
							},
						]
					: [];
			});
			return c.activity.parse({
				timeZone: r.timezone,
				entries: entries.slice(0, c.ACTIVITY_LIMIT),
				more: r.entries.length > c.ACTIVITY_LIMIT,
			});
		});
	},
};

const ACTIVITY_ACTIONS = [
	"people.created",
	"meetings.finalized",
	"tasks.completed",
	"launch.changed",
	"launch.outcome_recorded",
	"phase.declared",
	"phase.transitioned",
] as const;
const eventRow = z.object({
	id: z.uuid(),
	at: z.string(),
	action: z.enum(ACTIVITY_ACTIONS),
	kind: z.string(),
	event: z.string().nullable(),
	after_value: z.record(z.string(), z.unknown()).nullable(),
	actor_id: z.uuid().nullable(),
	actor_name: z.string().nullable(),
	subject_id: z.uuid(),
	person_name: z.string().nullable(),
	meeting_title: z.string().nullable(),
	meeting_type: z.string().nullable(),
	task_title: z.string().nullable(),
});
/** What an audit row says happened, as an activity change. A row of a kind Overview does not show reads as null. */
function changeOf(e: z.infer<typeof eventRow>): c.Change | null {
	const after = e.after_value ?? {};
	const date = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : null);
	switch (e.action) {
		case "people.created":
			return c.change.parse({ kind: "person_added", personId: e.subject_id, name: e.person_name ?? "" });
		case "meetings.finalized":
			return c.change.parse({
				kind: e.kind === "reconcile" ? "attendance_corrected" : "meeting_held",
				meetingId: e.subject_id,
				title: e.meeting_title,
				meetingType: e.meeting_type,
			});
		case "tasks.completed":
			return c.change.parse({ kind: "task_completed", taskId: e.subject_id, title: e.task_title ?? "" });
		case "launch.changed": {
			const event = c.launchDateEvent.safeParse(e.event);
			return event.success
				? c.change.parse({ kind: "launch_date", event: event.data, date: date(after.targetDate) })
				: null;
		}
		case "launch.outcome_recorded":
			return c.change.parse({ kind: "launch_recorded", date: date(after.actualDate) });
		case "phase.declared":
		case "phase.transitioned":
			return c.change.parse({ kind: "phase_changed", phase: after.phase });
	}
}

export const dashboardWriter = {
	/**
	 * dashboard.dismissPrompt (ADM-005): hides one optional prompt for this person in this church, in every browser. It
	 * changes nothing else: no count, task, milestone or setup step. One statement: the live seat check, a
	 * settings.changed audit row that names the field and the prompt, and nothing when it was already dismissed. Any seat
	 * may dismiss its own prompts; a Member is shown none.
	 */
	async dismissPrompt(db: Db, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const scope = scopeOf(authority);
			const input = c.dismissPromptRequest.safeParse(raw);
			if (!input.success) return deny("invalid_input");
			const prompt = input.data.prompt;
			const { rows } = await db.execute(sql`WITH g AS (SELECT ${scope.live} AS ok),
 done AS (SELECT EXISTS(SELECT FROM audit_event a WHERE a.actor_id=${scope.accountId}::uuid AND a.action='settings.changed'
	AND a.tenant_id=${scope.plantId}::uuid AND a.metadata->>'section'=${PROMPT_SECTION}
	AND a.metadata->>'prompt'=${prompt}) AS done),
 ins AS (INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
	SELECT ${scope.plantId}::uuid,${scope.accountId}::uuid,'settings.changed','edit','seat',${scope.seatId}::uuid,
	jsonb_build_object('section',${PROMPT_SECTION}::text,'fields',jsonb_build_array('dismissedPrompts'),'prompt',${prompt}::text)
	FROM g, done WHERE g.ok AND NOT done.done RETURNING id)
 SELECT g.ok,(SELECT count(*)::int FROM ins) AS written FROM g`);
			const r = rows[0];
			if (!r || r.ok !== true) return deny();
			return c.dismissPromptResult.parse({ outcome: r.written === 1 ? "changed" : "noop", prompt });
		});
	},
};
