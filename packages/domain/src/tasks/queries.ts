import { instant, localDateTime, revision, timeZone, type Instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { administers, deny, parse, readReply, viewerOf, type Tx, type Viewer } from "./core.ts";

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
	assignee_id: z.uuid().nullable(),
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
	occurrence_key: z.string().nullable(),
	obligation_id: z.uuid().nullable(),
	obligation_kind: storedKind.nullable(),
	assignee_name: z.string().nullable(),
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
				assignee_id: z.uuid().nullable(),
				assignee_name: z.string().nullable(),
			}),
		)
		.nullable()
		.optional(),
	total: z.coerce.number().int().optional(),
});
export type TaskRow = z.infer<typeof taskRow>;

const columns = sql`t.id, t.revision::text AS revision, t.title, t.description, t.category, t.priority, t.status,
	t.created_at, t.completed_at, t.deleted_at, t.assignee_id, t.due_kind, t.due_date::text AS due_date,
	t.due_time::text AS due_time, t.timezone, t.due_at, t.person_id, t.meeting_id, t.team_id, t.parent_id, t.series_id,
	t.occurrence_key, t.obligation_id, o.kind AS obligation_kind, ai.display_name AS assignee_name,
	coalesce(p.display_name, m.title, tm.name) AS relation_label, pl.timezone AS plant_zone,
	(SELECT count(*)::int FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL) AS child_total,
	(SELECT count(*)::int FROM task k WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL
		AND k.status='complete') AS child_complete,
	(SELECT k.id FROM task k WHERE k.series_id=t.series_id AND k.plant_id=t.plant_id AND k.id<>t.id
		AND k.deleted_at IS NULL AND k.status NOT IN ('complete','no_longer_needed') LIMIT 1) AS open_successor`;
const checklist = sql`(SELECT jsonb_agg(jsonb_build_object('id',k.id,'revision',k.revision::text,'title',k.title,
	'status',k.status,'assignee_id',k.assignee_id,'assignee_name',ki.display_name) ORDER BY k.created_at,k.id)
	FROM task k LEFT JOIN LATERAL seat_identity(k.assignee_id) ki ON true
	WHERE k.parent_id=t.id AND k.plant_id=t.plant_id AND k.deleted_at IS NULL) AS checklist`;
const joins = sql`FROM task t JOIN plant pl ON pl.id=t.plant_id
	LEFT JOIN obligation o ON o.id=t.obligation_id AND o.plant_id=t.plant_id
	LEFT JOIN LATERAL seat_identity(t.assignee_id) ai ON true
	LEFT JOIN person p ON p.id=t.person_id AND p.tenant_id=t.plant_id
	LEFT JOIN meeting m ON m.id=t.meeting_id AND m.plant_id=t.plant_id
	LEFT JOIN team tm ON tm.id=t.team_id AND tm.plant_id=t.plant_id`;

/** One task of the plant with its labels and checklist. A write locks the task row. */
export async function loadTask(tx: Tx, plantId: string, task: string | { obligationId: string }, lock: boolean) {
	const which =
		typeof task === "string"
			? sql`t.id=${task}::uuid`
			: sql`t.obligation_id=${task.obligationId}::uuid AND t.deleted_at IS NULL`;
	const r = await tx.execute(sql`SELECT ${columns}, ${checklist} ${joins}
		WHERE ${which} AND t.plant_id=${plantId}::uuid ${lock ? sql`FOR UPDATE OF t` : sql``}`);
	return r.rows[0] ? taskRow.parse(r.rows[0]) : null;
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
		assignee: row.assignee_id ? { accountId: row.assignee_id, displayName: row.assignee_name ?? "" } : null,
		relation: row.person_id
			? { kind: "person", id: row.person_id, label: row.relation_label ?? "" }
			: row.meeting_id
				? { kind: "meeting", id: row.meeting_id, label: row.relation_label ?? "" }
				: row.team_id
					? { kind: "team", id: row.team_id, label: row.relation_label ?? "" }
					: null,
		parentId: row.parent_id,
		checklist: { total: row.child_total, complete: row.child_complete },
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
			assignee: k.assignee_id ? { accountId: k.assignee_id, displayName: k.assignee_name ?? "" } : null,
		})),
		prerequisiteIds: [],
		obligationId: row.obligation_id,
		occurrenceId: row.occurrence_key,
	});
}

const now = () => instant.parse(new Date().toISOString());
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => "\\" + m);
/** The authorized top-level scope shared by the list and its counts. */
function scope(viewer: Viewer, f: z.infer<typeof c.countTasksRequest>): SQL {
	const parts = [
		sql`t.plant_id=${viewer.plantId}::uuid AND t.parent_id IS NULL AND t.deleted_at IS NULL`,
		f.view === "my" ? sql`t.assignee_id=${viewer.accountId}::uuid` : null,
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

function reader(viewer: Viewer, write = false) {
	if (write && !administers(viewer)) deny();
	return viewer;
}
export const taskReader = {
	/** One page in a stable order: the sort key, null due dates last, then the ID (D67 page numbers). One statement. */
	async list(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(viewerOf(authority)),
				v = parse(c.listTasksRequest, raw);
			const key = sortKey[v.sort],
				direction = v.direction === "asc" ? sql`ASC` : sql`DESC`;
			const r = await tx.execute(sql`SELECT ${columns}, count(*) OVER () AS total ${joins}
				WHERE ${scope(viewer, v)} ORDER BY (${key}) IS NULL, ${key} ${direction}, t.id ${direction}
				LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit}`);
			const rows = z.array(taskRow).parse(r.rows),
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
			const viewer = reader(viewerOf(authority)),
				v = parse(c.countTasksRequest, raw);
			const tally = (column: SQL) =>
				sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('value',x.v,'count',x.n) ORDER BY x.v),'[]') FROM
					(SELECT ${column} v, count(*)::int n FROM scope GROUP BY 1) x)`;
			const r = await tx.execute(sql`WITH scope AS MATERIALIZED (SELECT t.id, t.status, t.priority, t.category
				FROM task t WHERE ${scope(viewer, v)})
				SELECT (SELECT count(*)::int FROM scope) AS total, ${tally(sql`status`)} AS by_status,
					${tally(sql`priority`)} AS by_priority, ${tally(sql`category`)} AS by_category,
					(SELECT count(*)::int FROM task k JOIN scope s ON k.parent_id=s.id WHERE k.deleted_at IS NULL) AS child_total,
					(SELECT count(*)::int FROM task k JOIN scope s ON k.parent_id=s.id WHERE k.deleted_at IS NULL
						AND k.status='complete') AS child_complete`);
			const row = z
				.object({
					total: z.int(),
					by_status: z.unknown(),
					by_priority: z.unknown(),
					by_category: z.unknown(),
					child_total: z.int(),
					child_complete: z.int(),
				})
				.parse(r.rows[0]);
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
			const viewer = reader(viewerOf(authority)),
				v = parse(c.getTaskRequest, raw);
			const row = await loadTask(tx, viewer.plantId, v.taskId, false);
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
			const viewer = reader(viewerOf(authority)),
				v = parse(c.statusHistoryRequest, raw);
			const r = await tx.execute(sql`SELECT a.id, a.occurred_at, a.before_value->>'status' AS "from",
					a.after_value->>'status' AS "to", a.actor_id, a.actor_token, a.system_cause,
					coalesce(a.metadata->>'source','person') AS source, ai.display_name, count(*) OVER () AS total
				FROM task t JOIN audit_event a ON a.tenant_id=t.plant_id AND a.subject_id=t.id
				LEFT JOIN LATERAL seat_identity(a.actor_id) ai ON true
				WHERE t.id=${v.taskId}::uuid AND t.plant_id=${viewer.plantId}::uuid AND a.after_value ? 'status'
				ORDER BY a.occurred_at, a.id LIMIT ${v.limit} OFFSET ${(v.page - 1) * v.limit}`);
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
				.parse(r.rows);
			if (!rows.length && !(await loadTask(tx, viewer.plantId, v.taskId, false))) deny();
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
	/** The church's current accepted seats, who may hold a task. Owner/Admin only. One statement. */
	async eligibleAssignees(tx: Tx, authority: RequestActor) {
		return readReply(async () => {
			const viewer = reader(viewerOf(authority), true);
			const r = await tx.execute(sql`SELECT s.account_id, s.role, i.display_name FROM seat s
				CROSS JOIN LATERAL seat_identity(s.account_id) i
				WHERE s.plant_id=${viewer.plantId}::uuid AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp()
				ORDER BY lower(i.display_name), s.account_id LIMIT 500`);
			const rows = z
				.array(z.object({ account_id: z.uuid(), role: z.enum(["owner", "admin", "member"]), display_name: z.string() }))
				.parse(r.rows);
			return c.assigneeOptions.parse({
				items: rows.map((s) => ({ accountId: s.account_id, displayName: s.display_name, role: s.role })),
			});
		});
	},
	/** Live People, meetings or active teams of the church a task may name, by name. Owner/Admin only. One statement. */
	async relationOptions(tx: Tx, authority: RequestActor, raw: unknown) {
		return readReply(async () => {
			const viewer = reader(viewerOf(authority), true),
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
			const r = await tx.execute(sql`SELECT * FROM (${query}) o ORDER BY lower(o.label), o.id LIMIT 20`);
			return c.relationOptions.parse({
				items: z.array(z.object({ id: z.uuid(), label: z.string() })).parse(r.rows),
			});
		});
	},
};
async function countTop(tx: Tx, viewer: Viewer, v: z.infer<typeof c.countTasksRequest>) {
	const r = await tx.execute(sql`SELECT count(*)::int AS n FROM task t WHERE ${scope(viewer, v)}`);
	return z.object({ n: z.int() }).parse(r.rows[0]).n;
}
