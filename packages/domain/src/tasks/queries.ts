import { instant, localDateTime, revision, timeZone, type Instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { originJson, originOf } from "./origin.ts";
import { assigneeList, assigneesOf, assignedTo, sortPeople } from "./assignees.ts";
import { ownerView, eligibleOwner } from "./owner.ts";
import { administers, deny, parse, readReply, readerOf, type Reader, type Tx, type Viewer } from "./core.ts";

// Storage keeps the shipped short kind names; the contract names say which duty it is.
export const storedKind = z
	.enum(["follow_up", "evaluation"])
	.transform((k) => (k === "follow_up" ? "first_vision_follow_up" : "meeting_evaluation"));
export const storageKind = (k: z.infer<typeof c.obligationKind>) =>
	k === "first_vision_follow_up" ? ("follow_up" as const) : ("evaluation" as const);
export const taskRow = z.object({
	id: z.uuid(),
	revision,
	title: z.string(),
	description: z.string().nullable(),
	category: c.category,
	priority: c.priority,
	status: c.taskStatus,
	created_at: z.coerce.date(),
	completed_at: z.coerce.date().nullable(),
	deleted_at: z.coerce.date().nullable(),
	// Ordered by display name, then account ID (D-b).
	assignees: assigneeList,
	due_kind: z.enum(["undated", "date_only", "timed"]),
	due_date: z.string().nullable(),
	due_time: z.string().nullable(),
	timezone: z.string().nullable(),
	due_at: z.coerce.date().nullable(),
	person_id: z.uuid().nullable(),
	meeting_id: z.uuid().nullable(),
	team_id: z.uuid().nullable(),
	parent_id: z.uuid().nullable(),
	series_id: z.uuid().nullable(),
	predecessor_id: z.uuid().nullable(),
	prerequisite_ids: z.array(z.uuid()),
	open_prerequisites: z.int(),
	occurrence_key: z.string().nullable(),
	obligation_id: z.uuid().nullable(),
	obligation_kind: storedKind.nullable(),
	follow_up_owners: z.array(c.followUpOwner).nullish(),
	follow_up_origin: z.unknown().nullish(),
	relation_label: z.string().nullable(),
	child_total: z.int(),
	child_complete: z.int(),
	plant_zone: timeZone,
	open_successor: z.uuid().nullable(),
	checklist: z
		.array(
			z.object({
				id: z.uuid(),
				revision,
				title: z.string(),
				status: c.taskStatus,
				// Each assignee's seat status says whether a recurrence copy may keep them.
				assignees: assigneeList,
			}),
		)
		.optional(),
	rule: z
		.object({
			id: z.uuid(),
			frequency: c.recurrenceFrequency,
			until: z.string().nullable(),
			local_time: z.string().nullable(),
			stopped: z.boolean(),
		})
		.nullable()
		.optional(),
	total: z.coerce.number().int().optional(),
});
/** A list row, or a task a write builds. */
export type TaskRow = z.infer<typeof taskRow>;
/**
 * One task as a single-task read returns it: its checklist, its series rule, whether a live successor exists, whether
 * the assignee is still seated and whether the relation is live. A status change needs all of them (REQ-TSK-007).
 */
export const lockedTask = taskRow.extend({
	checklist: taskRow.shape.checklist
		.unwrap()
		.nullable()
		.transform((k) => k ?? []),
	rule: taskRow.shape.rule.unwrap(),
	has_successor: z.boolean(),
	// The related Person is live, the team active: a recurrence copy may name them again.
	relation_live: z.boolean(),
});
export type LockedTask = z.infer<typeof lockedTask>;

const columns = sql`t.id, t.revision::text AS revision, t.title, t.description, t.category, t.priority, t.status,
	t.created_at, t.completed_at, t.deleted_at, ${assigneesOf("t")} AS assignees, t.due_kind, t.due_date::text AS due_date,
	t.due_time::text AS due_time, t.timezone, t.due_at, t.person_id, t.meeting_id, t.team_id, t.parent_id, t.series_id,
	t.predecessor_id, t.prerequisite_ids::text[] AS prerequisite_ids,
	(SELECT count(*)::int FROM task q WHERE q.id=ANY(t.prerequisite_ids) AND q.plant_id=t.plant_id AND q.deleted_at IS NULL
		AND q.status NOT IN ('complete','no_longer_needed')) AS open_prerequisites,
	t.occurrence_key, t.obligation_id, o.kind AS obligation_kind,
	coalesce(p.display_name, m.title, tm.name) AS relation_label, pl.timezone AS plant_zone,
	(SELECT count(*)::int FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL) AS child_total,
	(SELECT count(*)::int FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL
		AND k.status='complete') AS child_complete,
	(SELECT k.id FROM task k WHERE k.series_id=t.series_id AND k.plant_id=t.plant_id AND k.id<>t.id
		AND k.deleted_at IS NULL AND k.status NOT IN ('complete','no_longer_needed') LIMIT 1) AS open_successor`;
/**
 * A person follow-up's owner view and origin. Only reads carry them: each is another seat_identity call the planner
 * cannot inline, and a write's answer is merged with what the screen already shows.
 */
const views = sql`	CASE WHEN t.category='follow_up' AND t.person_id IS NOT NULL AND t.parent_id IS NULL
		THEN (SELECT coalesce(jsonb_agg(${ownerView(sql`a.account_id`, sql`t.plant_id`)}),'[]'::jsonb)
			FROM task_assignee a WHERE a.task_id=t.id) END AS follow_up_owners,
	CASE WHEN t.category='follow_up' AND t.person_id IS NOT NULL AND t.parent_id IS NULL
		THEN ${originJson(sql`t`)} END AS follow_up_origin`;
const checklist = sql`(SELECT jsonb_agg(jsonb_build_object('id',k.id,'revision',k.revision::text,'title',k.title,
	'status',k.status,'assignees',${assigneesOf("k")})
	ORDER BY k.created_at,k.id)
	FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL) AS checklist,
	(SELECT jsonb_build_object('id',r.id,'frequency',r.interval,'until',r.end_date,'local_time',to_char(r.local_time,'HH24:MI'),
		'stopped',r.stopped_at IS NOT NULL) FROM recurrence r WHERE r.id=t.series_id AND r.plant_id=t.plant_id) AS rule,
	EXISTS(SELECT FROM task n WHERE n.predecessor_id=t.id AND n.plant_id=t.plant_id AND n.deleted_at IS NULL)
		AS has_successor,
	(t.person_id IS NULL OR p.state='live') AND (t.team_id IS NULL OR tm.archived_at IS NULL) AS relation_live`;
const joins = sql`FROM task t JOIN plant pl ON pl.id=t.plant_id
	LEFT JOIN obligation o ON o.id=t.obligation_id AND o.plant_id=t.plant_id
	LEFT JOIN person p ON p.id=t.person_id AND p.tenant_id=t.plant_id
	LEFT JOIN meeting m ON m.id=t.meeting_id AND m.plant_id=t.plant_id
	LEFT JOIN team tm ON tm.id=t.team_id AND tm.plant_id=t.plant_id`;

/** One task of the plant with its labels and checklist. A write locks the task row. */
export async function loadTask(tx: Tx, plantId: string, task: string | { obligationId: string }, lock: boolean) {
	const which =
		typeof task === "string"
			? sql`t.id=${task}::uuid`
			: sql`t.obligation_id=${task.obligationId}::uuid AND t.deleted_at IS NULL`;
	const r = await tx.execute(sql`${taskQuery(plantId, which)} ${lock ? sql`FOR UPDATE OF t` : sql``}`);
	return r.rows[0] ? lockedTask.parse(r.rows[0]) : null;
}
/** The plant's tasks that match `which`, locked in ID order so two batches never wait on each other in a cycle. One statement. */
export async function lockTasks(tx: Tx, plantId: string, which: SQL) {
	const r = await tx.execute(sql`${taskQuery(plantId, which)} ORDER BY t.id FOR UPDATE OF t`);
	return z.array(lockedTask).parse(r.rows);
}
/** Several tasks of the plant by ID, locked as lockTasks locks them. */
export async function loadTasks(tx: Tx, plantId: string, ids: readonly string[]) {
	const rows = await lockTasks(tx, plantId, sql`t.id=ANY(${sql.param(ids)}::uuid[])`);
	return new Map(rows.map((row) => [row.id, row]));
}
/**
 * The live tasks of generated duties, locked in ID order like loadTasks, as one JSON array expression. A caller puts it
 * in its own locked fact read so settling the duties adds no statement; `obligations` is a uuid[] expression.
 */
export const managedTasks = (plantId: string, obligations: SQL) =>
	sql`(SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (${taskQuery(plantId, sql`t.obligation_id=ANY(${obligations}) AND t.deleted_at IS NULL`)} ORDER BY t.id FOR UPDATE OF t) x)`;
export const managedTaskRows = z.array(lockedTask);
const taskQuery = (plantId: string, which: SQL, withViews = false) =>
	sql`SELECT ${columns}, ${withViews ? sql`${views}, ` : sql``}${checklist}, 1 AS ord ${joins} WHERE ${which} AND t.plant_id=${plantId}::uuid`;

/**
 * One read statement: the reader's live authority (C13, lock-free per C27) and the rows of `query`, which numbers its
 * rows in `ord`.
 * A reader whose session, seat, role or lifecycle changed since the viewer lookup is refused and reads nothing.
 */
async function gated(tx: Tx, viewer: Reader, query: SQL, admin = false) {
	const live = liveRead({ session: viewer.session, owner: viewer.owner, seatId: viewer.seatId }, admin);
	const r = await tx.execute(sql`SELECT g.live, q.* FROM (SELECT ${live} AS live) g
		LEFT JOIN LATERAL (${query}) q ON g.live ORDER BY q.ord`);
	if (r.rows[0]?.live !== true) deny();
	return r.rows.filter((row) => row.ord !== null);
}

export function dueOf(row: Pick<TaskRow, "due_kind" | "due_date" | "due_time" | "timezone" | "due_at">): c.Due {
	if (row.due_kind === "undated") return { kind: "undated" };
	if (row.due_kind === "date_only") return c.due.parse({ kind: "local_date", date: row.due_date });
	const local = localDateTime.parse(`${row.due_date}T${row.due_time!.slice(0, 8)}`),
		at = row.due_at!;
	return c.due.parse({
		kind: "resolved_instant",
		local,
		zone: row.timezone,
		instant: at.toISOString(),
		offsetSeconds: (Date.parse(`${local}Z`) - at.getTime()) / 1000,
	});
}
/**
 * A person follow-up's owner views (REQ-TSK-012), one for each assignee. A read carries the stored views; an assignee a
 * write just added was checked by that write, so it reads as eligible.
 */
function followUpOwnersOf(row: TaskRow) {
	if (row.category !== "follow_up" || !row.person_id || row.parent_id) return [];
	const views = new Map((row.follow_up_owners ?? []).map((v) => [v.accountId, v]));
	return sortPeople(
		row.assignees.map(
			(a) =>
				views.get(a.accountId) ?? {
					accountId: a.accountId,
					displayName: a.displayName,
					eligible: true,
					reason: null,
				},
		),
	);
}
const peopleOf = (a: { accountId: string; displayName: string }) => ({
	accountId: a.accountId,
	displayName: a.displayName,
});
export function itemOf(row: TaskRow, asOf: Instant) {
	const due = dueOf(row);
	const settled = (c.settledStatus as readonly string[]).includes(row.status);
	return {
		id: row.id,
		revision: row.revision,
		title: row.title,
		status: row.status,
		priority: row.priority,
		category: row.category,
		due,
		overdue: due.kind === "undated" ? null : settled ? false : c.overdueAt(due, row.plant_zone, asOf),
		assignees: row.assignees.map(peopleOf),
		followUpOwners: followUpOwnersOf(row),
		followUpOrigin: row.follow_up_origin ? originOf(row.follow_up_origin) : null,
		relation: row.person_id
			? { kind: "person", id: row.person_id, label: row.relation_label ?? "" }
			: row.meeting_id
				? { kind: "meeting", id: row.meeting_id, label: row.relation_label ?? "" }
				: row.team_id
					? { kind: "team", id: row.team_id, label: row.relation_label ?? "" }
					: null,
		parentId: row.parent_id,
		checklist: { total: row.child_total, complete: row.child_complete },
		openPrerequisites: row.open_prerequisites,
		managed:
			row.obligation_id && row.obligation_kind ? { obligationId: row.obligation_id, kind: row.obligation_kind } : null,
		createdAt: row.created_at.toISOString(),
		completedAt: row.completed_at?.toISOString() ?? null,
		deleted: row.deleted_at !== null,
	};
}
export function detailOf(row: TaskRow, asOf: Instant) {
	return c.taskDetail.parse({
		...itemOf(row, asOf),
		description: row.description,
		checklistItems: (row.checklist ?? []).map((k) => ({
			id: k.id,
			revision: k.revision,
			title: k.title,
			status: k.status,
			assignees: k.assignees.map(peopleOf),
		})),
		prerequisiteIds: row.prerequisite_ids,
		obligationId: row.obligation_id,
		occurrenceId: row.occurrence_key,
		recurrence: row.rule
			? {
					seriesId: row.rule.id,
					frequency: row.rule.frequency,
					until: row.rule.until,
					localTime: row.rule.local_time,
					stopped: row.rule.stopped,
				}
			: null,
	});
}

const now = () => instant.parse(new Date().toISOString());
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => "\\" + m);
/** The authorized top-level scope shared by the list and its counts. */
function scope(viewer: Viewer, f: z.infer<typeof c.countTasksRequest>): SQL {
	const parts = [
		sql`t.plant_id=${viewer.plantId}::uuid AND t.parent_id IS NULL AND t.deleted_at IS NULL`,
		f.view === "my" ? assignedTo("t", sql`${viewer.accountId}::uuid`) : null,
		f.search ? sql`t.title ILIKE ${"%" + escapeLike(f.search) + "%"} ESCAPE '\\'` : null,
		f.statuses.length ? sql`t.status=ANY(${sql.param(f.statuses)}::text[])` : null,
		f.priorities.length ? sql`t.priority=ANY(${sql.param(f.priorities)}::text[])` : null,
		f.categories.length ? sql`t.category=ANY(${sql.param(f.categories)}::text[])` : null,
		f.teamId ? sql`t.team_id=${f.teamId}::uuid` : null,
		{
			any: null,
			person: sql`t.person_id IS NOT NULL`,
			meeting: sql`t.meeting_id IS NOT NULL`,
			team: sql`t.team_id IS NOT NULL`,
			none: sql`num_nonnulls(t.person_id,t.meeting_id,t.team_id,t.launch_id)=0`,
		}[f.relation],
		{
			any: null,
			undated: sql`t.due_kind='undated'`,
			local_date: sql`t.due_kind='date_only'`,
			resolved_instant: sql`t.due_kind='timed'`,
		}[f.due],
	].filter((p) => p !== null);
	return sql.join(parts, sql` AND `);
}
const sortKey = {
	// A date-only task sorts at the end of its church-local day, where it becomes overdue.
	due: sql`coalesce(t.due_at, ((t.due_date + 1)::timestamp AT TIME ZONE pl.timezone))`,
	priority: sql`array_position(ARRAY['low','medium','high','urgent'], t.priority)`,
	status: sql`array_position(ARRAY['not_started','in_progress','blocked','complete','no_longer_needed'], t.status)`,
	title: sql`lower(t.title)`,
	created: sql`t.created_at`,
};

function reader(authority: RequestActor, admin = false) {
	const viewer = readerOf(authority);
	if (admin && !administers(viewer)) deny();
	return viewer;
}
export const taskReader = {
	/** One page in a stable order: the sort key, null due dates last, then the ID (D67 page numbers). One statement. */
	async list(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.listTasksRequest, raw);
			const key = sortKey[v.sort],
				direction = v.direction === "asc" ? sql`ASC` : sql`DESC`;
			const order = sql`(${key}) IS NULL, ${key} ${direction}, t.id ${direction}`;
			const found = await gated(
				tx,
				viewer,
				sql`SELECT ${columns}, ${views}, count(*) OVER () AS total, row_number() OVER (ORDER BY ${order}) AS ord ${joins}
				WHERE ${scope(viewer, v)} ORDER BY ${order} LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit}`,
			);
			const rows = z.array(taskRow).parse(found),
				asOf = v.asOf ?? now();
			// A page past the end has no rows to carry the total; the caller then reads the last page (D67).
			const total = rows[0]?.total ?? (v.page > 1 ? await countTop(tx, viewer, v) : 0);
			return c.taskPage.parse({
				items: rows.map((row) => itemOf(row, asOf)),
				total,
				page: v.page,
				next: v.page * v.limit < total ? v.page + 1 : null,
				completeness: "complete",
			});
		});
	},
	/** Top-level tallies and checklist units over the list's scope. One statement. */
	async count(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.countTasksRequest, raw);
			const tally = (column: SQL) =>
				sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('value',x.v,'count',x.n) ORDER BY x.v),'[]') FROM
					(SELECT ${column} v, count(*)::int n FROM scope GROUP BY 1) x)`;
			const [found] = await gated(
				tx,
				viewer,
				sql`WITH scope AS MATERIALIZED (SELECT t.id, t.status, t.priority, t.category
				FROM task t WHERE ${scope(viewer, v)})
				SELECT 1 AS ord, (SELECT count(*)::int FROM scope) AS total, ${tally(sql`status`)} AS by_status,
					${tally(sql`priority`)} AS by_priority, ${tally(sql`category`)} AS by_category,
					(SELECT count(*)::int FROM task k JOIN scope s ON k.parent_id=s.id WHERE k.deleted_at IS NULL) AS child_total,
					(SELECT count(*)::int FROM task k JOIN scope s ON k.parent_id=s.id WHERE k.deleted_at IS NULL
						AND k.status='complete') AS child_complete`,
			);
			const row = z
				.object({
					total: z.int(),
					by_status: z.unknown(),
					by_priority: z.unknown(),
					by_category: z.unknown(),
					child_total: z.int(),
					child_complete: z.int(),
				})
				.parse(found);
			return c.taskCounts.parse({
				topLevelTotal: row.total,
				byStatus: row.by_status,
				byPriority: row.by_priority,
				byCategory: row.by_category,
				childTaskTotal: row.child_total,
				childTaskComplete: row.child_complete,
				completeness: "complete",
			});
		});
	},
	/** One live task with its checklist. A missing, deleted or foreign task reads as unavailable. One statement. */
	async get(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.getTaskRequest, raw);
			const [found] = await gated(tx, viewer, taskQuery(viewer.plantId, sql`t.id=${v.taskId}::uuid`, true));
			const row = found && lockedTask.parse(found);
			if (!row || row.deleted_at) return c.taskResult.parse({ status: "unavailable" });
			return c.taskResult.parse({ status: "available", task: detailOf(row, v.asOf ?? now()) });
		});
	},
	/**
	 * Every status change of a task the church has, deleted or not, from the shared audit record (D70): creation,
	 * completion, reopen and waiver, with who or what made it. One statement.
	 */
	async statusHistory(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.statusHistoryRequest, raw);
			const found = await gated(
				tx,
				viewer,
				sql`SELECT a.id, a.occurred_at, a.before_value->>'status' AS "from",
					a.after_value->>'status' AS "to", a.actor_id, a.actor_token, a.system_cause,
					coalesce(a.metadata->>'source','person') AS source, ai.display_name, count(a.id) OVER () AS total,
					row_number() OVER (ORDER BY a.occurred_at, a.id) AS ord
				FROM task t LEFT JOIN audit_event a ON a.tenant_id=t.plant_id AND a.subject_id=t.id AND a.after_value ? 'status'
				LEFT JOIN LATERAL seat_identity(a.actor_id) ai ON true
				WHERE t.id=${v.taskId}::uuid AND t.plant_id=${viewer.plantId}::uuid
				ORDER BY a.occurred_at, a.id LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit}`,
			);
			const rows = z
				.array(
					z.object({
						id: z.uuid(),
						occurred_at: z.coerce.date(),
						from: c.taskStatus.nullable(),
						to: c.taskStatus,
						actor_id: z.uuid().nullable(),
						actor_token: z.string().nullable(),
						system_cause: z.string().nullable(),
						source: c.historySource,
						display_name: z.string().nullable(),
						total: z.coerce.number().int(),
					}),
				)
				.parse(found.filter((a) => a.id !== null));
			// The task row always comes back: no rows on page 1 means no such task here. A task with no status audit row
			// comes back as one row with null audit columns, which reads as an empty history.
			if (!found.length && v.page === 1) deny();
			const total = rows[0]?.total ?? 0;
			return c.statusHistory.parse({
				taskId: v.taskId,
				items: rows.map((a) => ({
					id: a.id,
					occurredAt: a.occurred_at.toISOString(),
					from: a.from,
					to: a.to,
					// A system trigger is never shown as a person; a deleted account keeps only its scope-local token.
					actor: a.system_cause
						? { kind: "system", cause: a.system_cause }
						: a.actor_id
							? { kind: "account", accountId: a.actor_id, displayName: a.display_name }
							: { kind: "former_account" },
					source: a.source,
				})),
				next: v.page * v.limit < total ? v.page + 1 : null,
				completeness: "complete",
			});
		});
	},
	/**
	 * The church's current accepted seats, who may hold a task. With purpose `committed_follow_up` only the seats that may
	 * own a follow-up (REQ-TSK-012). Owner/Admin only. One statement.
	 */
	async eligibleAssignees(tx: Tx, authority: RequestActor, raw: unknown = {}) {
		return readReply(async () => {
			const viewer = reader(authority, true),
				v = parse(c.eligibleAssigneesRequest, raw);
			const plant = sql`${viewer.plantId}::uuid`;
			const found = await gated(
				tx,
				viewer,
				sql`SELECT s.account_id, s.role, i.display_name,
					row_number() OVER (ORDER BY lower(i.display_name), s.account_id) AS ord FROM seat s
				CROSS JOIN LATERAL seat_identity(s.account_id) i
				WHERE s.plant_id=${plant} AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
				${v.purpose === "committed_follow_up" ? sql`AND ${eligibleOwner(sql`s.account_id`, plant)}` : sql``}
				ORDER BY lower(i.display_name), s.account_id LIMIT 500`,
				true,
			);
			const rows = z
				.array(z.object({ account_id: z.uuid(), role: z.enum(["owner", "admin", "member"]), display_name: z.string() }))
				.parse(found);
			return c.assigneeOptions.parse({
				items: rows.map((s) => ({ accountId: s.account_id, displayName: s.display_name, role: s.role })),
			});
		});
	},
	/** Live People, meetings or active teams of the church a task may name, by name. Owner/Admin only. One statement. */
	async relationOptions(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority, true),
				v = parse(c.relationOptionsRequest, raw);
			const like = "%" + escapeLike(v.search) + "%";
			const query = {
				person: sql`SELECT id, display_name AS label FROM person WHERE tenant_id=${viewer.plantId}::uuid
					AND plant_id IS NOT NULL AND state='live' AND display_name ILIKE ${like} ESCAPE '\\'`,
				meeting: sql`SELECT id, title AS label FROM meeting WHERE plant_id=${viewer.plantId}::uuid
					AND status<>'cancelled' AND title ILIKE ${like} ESCAPE '\\'`,
				team: sql`SELECT id, name AS label FROM team WHERE plant_id=${viewer.plantId}::uuid
					AND archived_at IS NULL AND name ILIKE ${like} ESCAPE '\\'`,
			}[v.kind];
			const found = await gated(
				tx,
				viewer,
				sql`SELECT o.*, row_number() OVER (ORDER BY lower(o.label), o.id) AS ord FROM (${query}) o
				ORDER BY lower(o.label), o.id LIMIT 20`,
				true,
			);
			return c.relationOptions.parse({
				items: found.map((o) => z.object({ id: z.uuid(), label: z.string() }).parse(o)),
			});
		});
	},
	/** One page of a live task's checklist rows, oldest first (REQ-TSK-005). One statement. */
	async listSubtasks(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.listSubtasksRequest, raw);
			const found = await gated(
				tx,
				viewer,
				sql`SELECT 0 AS ord, NULL::uuid AS id, NULL AS title, NULL AS status, NULL::text AS revision,
					NULL::jsonb AS assignees, NULL::timestamptz AS completed_at,
					(SELECT count(*)::int FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL) AS total
				FROM task t WHERE t.id=${v.parentId}::uuid AND t.plant_id=${viewer.plantId}::uuid AND t.deleted_at IS NULL
				UNION ALL (SELECT row_number() OVER (ORDER BY k.created_at, k.id), k.id, k.title, k.status, k.revision::text,
					${assigneesOf("k")}, k.completed_at, NULL
				FROM task k JOIN task t ON t.id=k.parent_id AND t.plant_id=k.plant_id AND t.deleted_at IS NULL
				WHERE k.parent_id=${v.parentId}::uuid AND k.plant_id=${viewer.plantId}::uuid AND k.deleted_at IS NULL
				ORDER BY k.created_at, k.id LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit})`,
			);
			// The parent's own row comes first and carries the count; without it the parent is not a live task here.
			const [head, ...items] = found;
			if (!head || Number(head.ord) !== 0) deny();
			const total = z.int().parse(head.total);
			const rows = z
				.array(
					z.object({
						id: z.uuid(),
						title: z.string(),
						status: c.taskStatus,
						revision,
						assignees: assigneeList,
						completed_at: z.coerce.date().nullable(),
					}),
				)
				.parse(items);
			return c.subtaskPage.parse({
				parentId: v.parentId,
				items: rows.map((k) => ({
					id: k.id,
					revision: k.revision,
					title: k.title,
					status: k.status,
					assignees: k.assignees.map(peopleOf),
					completedAt: k.completed_at?.toISOString() ?? null,
				})),
				total,
				page: v.page,
				next: v.page * v.limit < total ? v.page + 1 : null,
				completeness: "complete",
			});
		});
	},
	/**
	 * A live task's prerequisites in the order saved, with whether each still blocks it: a deleted, complete or no
	 * longer needed prerequisite does not (REQ-TSK-006). One statement.
	 */
	async listPrerequisites(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.listPrerequisitesRequest, raw);
			const [found] = await gated(
				tx,
				viewer,
				sql`SELECT 1 AS ord, coalesce((SELECT jsonb_agg(jsonb_build_object('id',q.id,'title',q.title,'status',q.status,
					'deleted',q.deleted_at IS NOT NULL) ORDER BY u.n) FROM unnest(t.prerequisite_ids) WITH ORDINALITY u(id,n)
					JOIN task q ON q.id=u.id AND q.plant_id=t.plant_id),'[]') AS items
				FROM task t WHERE t.id=${v.taskId}::uuid AND t.plant_id=${viewer.plantId}::uuid AND t.deleted_at IS NULL`,
			);
			if (!found) deny();
			const items = z
				.array(z.object({ id: z.uuid(), title: z.string(), status: c.taskStatus, deleted: z.boolean() }))
				.parse(found.items)
				.map((q) => ({ ...q, blocking: !q.deleted && !(c.settledStatus as readonly string[]).includes(q.status) }));
			return c.prerequisiteList.parse({
				taskId: v.taskId,
				items,
				blocked: items.some((q) => q.blocking),
				completeness: "complete",
			});
		});
	},
	/**
	 * Live top-level tasks that may become prerequisites of a task, by title: not the task itself and none that already
	 * depends on it, so a pick never closes a cycle. Open tasks first. Owner/Admin. One statement.
	 */
	async prerequisiteCandidates(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority, true),
				v = parse(c.prerequisiteCandidatesRequest, raw);
			const plant = sql`${viewer.plantId}::uuid`;
			const found = await gated(
				tx,
				viewer,
				sql`WITH RECURSIVE dependents(id) AS (
					SELECT id FROM task WHERE id=${v.taskId}::uuid AND plant_id=${plant} AND parent_id IS NULL
						AND deleted_at IS NULL
					UNION SELECT t.id FROM task t JOIN dependents d ON d.id=ANY(t.prerequisite_ids)
						WHERE t.plant_id=${plant} AND t.deleted_at IS NULL)
				SELECT o.id, o.title, o.status, row_number() OVER (ORDER BY o.status IN ('complete','no_longer_needed'),
					lower(o.title), o.id) AS ord
				FROM task o WHERE o.plant_id=${plant} AND o.parent_id IS NULL AND o.deleted_at IS NULL
					AND EXISTS(SELECT FROM dependents) AND o.id NOT IN (SELECT id FROM dependents)
					AND o.title ILIKE ${"%" + escapeLike(v.search) + "%"} ESCAPE '\\'
				ORDER BY ord LIMIT 20`,
				true,
			);
			return c.prerequisiteCandidates.parse({
				items: z.array(z.object({ id: z.uuid(), title: z.string(), status: c.taskStatus })).parse(found),
			});
		});
	},
	/**
	 * The open occurrence of a task's series, if any: its task, occurrence number, predecessor and revision
	 * (REQ-TSK-007). A task outside any series reads not_recurring. One statement.
	 */
	async findOpenOccurrence(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(authority),
				v = parse(c.findOpenOccurrenceRequest, raw);
			const [found] = await gated(
				tx,
				viewer,
				sql`SELECT 1 AS ord, t.series_id, o.id AS open_id, o.occurrence_key, o.predecessor_id, o.revision::text AS revision
				FROM task t LEFT JOIN task o ON o.series_id=t.series_id AND o.plant_id=t.plant_id AND o.deleted_at IS NULL
					AND o.status NOT IN ('complete','no_longer_needed')
				WHERE t.id=${v.taskId}::uuid AND t.plant_id=${viewer.plantId}::uuid`,
			);
			if (!found) deny();
			const row = z
				.object({
					series_id: z.uuid().nullable(),
					open_id: z.uuid().nullable(),
					occurrence_key: z.string().nullable(),
					predecessor_id: z.uuid().nullable(),
					revision: revision.nullable(),
				})
				.parse(found);
			if (!row.series_id) return c.openOccurrence.parse({ status: "not_recurring" });
			return c.openOccurrence.parse({
				status: "series",
				seriesId: row.series_id,
				open: row.open_id
					? {
							taskId: row.open_id,
							occurrence: Number(row.occurrence_key),
							predecessorId: row.predecessor_id,
							revision: row.revision,
						}
					: null,
			});
		});
	},
};
async function countTop(tx: Tx, viewer: Reader, v: z.infer<typeof c.countTasksRequest>) {
	const [found] = await gated(
		tx,
		viewer,
		sql`SELECT 1 AS ord, count(*)::int AS n FROM task t WHERE ${scope(viewer, v)}`,
	);
	return z.object({ n: z.int() }).parse(found).n;
}
