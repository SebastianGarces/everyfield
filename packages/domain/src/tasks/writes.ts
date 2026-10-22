import { instant, resolveCalendar, revision, type TimeZone } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { and, eq, isNull, sql, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	administers,
	auditRow,
	changes,
	command,
	deny,
	parse,
	reply,
	type AuditCommand,
	type Command,
	type TaskContext,
	type Tx,
} from "./core.ts";
import { lastWrite } from "../operations/writes.ts";
import { detailOf, loadTask, type TaskRow } from "./queries.ts";
import { successorOf } from "./recurrence.ts";
import { structureWriter } from "./structure.ts";

/** What a reminder needs about one task after a write. WP-031's sync replaces its owed due and overdue notices. */
export type ReminderSource = {
	plantId: string;
	taskId: string;
	revision: string;
	title: string;
	assigneeId: string | null;
	due: { kind: "undated" } | { kind: "date_only"; date: string; zone: string } | { kind: "timed"; at: string };
	open: boolean;
	/** Created by this write: it has no notices yet, so the sync has nothing to replace or cancel. */
	created: boolean;
};
/** All tasks of one write go in one call, so the sync costs a fixed number of statements (patterns.md). */
export type TaskReminders = (tx: Tx, sources: readonly ReminderSource[]) => Promise<unknown>;

type DueColumns = Pick<TaskRow, "due_kind" | "due_date" | "due_time" | "timezone" | "due_at">;
/** The server resolves a deadline from the entered church-local time (REQ-TSK-018); the client never sends an instant. */
export function dueColumns(due: z.infer<typeof c.dueInput>, zone: TimeZone): DueColumns {
	if (due.kind === "undated")
		return { due_kind: "undated", due_date: null, due_time: null, timezone: null, due_at: null };
	if (due.kind === "local_date")
		return { due_kind: "date_only", due_date: due.date, due_time: null, timezone: null, due_at: null };
	const r = resolveCalendar(due.local, zone, "entered", due.offsetSeconds);
	if (r.kind === "gap") deny("nonexistent_local_time", { local: due.local });
	if (r.kind === "fold") deny("ambiguous_local_time", { local: due.local, choices: r.choices });
	if (r.kind === "invalid_offset") deny("invalid_input");
	return {
		due_kind: "timed",
		due_date: due.local.slice(0, 10),
		due_time: due.local.slice(11),
		timezone: zone,
		due_at: new Date(r.occurrence.instant),
	};
}
export const relationColumns = (r: z.infer<typeof c.relation> | null) => ({
	person_id: r?.kind === "person" ? r.id : null,
	meeting_id: r?.kind === "meeting" ? r.id : null,
	team_id: r?.kind === "team" ? r.id : null,
});

/** Names for references a write is about to store, each checked against the church and its current state. */
export async function references(
	tx: Tx,
	plantId: string,
	input: { assigneeId?: string | null; relation?: z.infer<typeof c.relation> | null },
) {
	const r = await tx.execute(sql`SELECT
		(SELECT i.display_name FROM seat s CROSS JOIN LATERAL seat_identity(s.account_id) i
			WHERE s.account_id=${input.assigneeId ?? null}::uuid AND s.plant_id=${plantId}::uuid AND s.ended_at IS NULL
			AND s.accepted_at<=clock_timestamp() FOR SHARE OF s) AS assignee,
		(SELECT display_name FROM person WHERE id=${input.relation?.kind === "person" ? input.relation.id : null}::uuid
			AND tenant_id=${plantId}::uuid AND plant_id IS NOT NULL AND state='live' FOR SHARE) AS person,
		(SELECT title FROM meeting WHERE id=${input.relation?.kind === "meeting" ? input.relation.id : null}::uuid
			AND plant_id=${plantId}::uuid FOR SHARE) AS meeting,
		(SELECT name FROM team WHERE id=${input.relation?.kind === "team" ? input.relation.id : null}::uuid
			AND plant_id=${plantId}::uuid AND archived_at IS NULL FOR SHARE) AS team`);
	const row = z
		.object({
			assignee: z.string().nullable(),
			person: z.string().nullable(),
			meeting: z.string().nullable(),
			team: z.string().nullable(),
		})
		.parse(r.rows[0]);
	if (input.assigneeId && row.assignee === null) deny("invalid_subject");
	const label = input.relation ? row[input.relation.kind] : null;
	if (input.relation && label === null) deny("invalid_subject");
	return { assigneeName: row.assignee, relationLabel: label };
}

const OPEN = (s: string) => !(c.settledStatus as readonly string[]).includes(s);
function reminderSource(plantId: string, row: TaskRow): ReminderSource {
	return {
		plantId,
		taskId: row.id,
		revision: row.revision,
		title: row.title,
		assigneeId: row.assignee_id,
		due:
			row.due_kind === "undated"
				? { kind: "undated" }
				: row.due_kind === "date_only"
					? { kind: "date_only", date: row.due_date!, zone: row.plant_zone }
					: { kind: "timed", at: row.due_at!.toISOString() },
		open: OPEN(row.status) && row.deleted_at === null,
		created: false,
	};
}
const remindable = (s: ReminderSource) => s.open && s.assigneeId !== null && s.due.kind !== "undated";
/** Reminders change only when the task had or now has owed reminders; other writes keep their small budget. */
export function reminderChange(plantId: string, before: TaskRow | null, after: TaskRow) {
	const prior = before && reminderSource(plantId, before),
		next = reminderSource(plantId, after);
	if (!(prior && remindable(prior)) && !remindable(next)) return undefined;
	return { ...next, open: remindable(next), created: before === null };
}
export function syncReminders(
	reminders: TaskReminders,
	tx: Tx,
	plantId: string,
	before: TaskRow | null,
	after: TaskRow,
) {
	const change = reminderChange(plantId, before, after);
	return change && (() => reminders(tx, [change]));
}
/** One reminder call for all tasks a command changed, or none: a fixed statement count for any batch size. */
export function syncAll(reminders: TaskReminders, tx: Tx, changes: readonly (ReminderSource | undefined)[]) {
	const all = changes.filter((s) => s !== undefined);
	return all.length ? () => reminders(tx, all) : undefined;
}

/**
 * Insert new task rows, a parent before its checklist rows. `after` names an earlier write of the same statement that
 * must run first, such as the completion that frees its series' one open slot for the successor.
 */
export function insertTasks(plantId: string, creatorId: string, rows: readonly TaskRow[], after?: SQLWrapper) {
	const values = rows.map((r) => ({
		id: r.id,
		title: r.title,
		description: r.description,
		category: r.category,
		priority: r.priority,
		status: r.status,
		created_at: r.created_at.toISOString(),
		assignee_id: r.assignee_id,
		due_kind: r.due_kind,
		due_date: r.due_date,
		due_time: r.due_time,
		timezone: r.timezone,
		due_at: r.due_at?.toISOString() ?? null,
		resolver_version: r.due_kind === "timed" ? "1" : null,
		person_id: r.person_id,
		meeting_id: r.meeting_id,
		team_id: r.team_id,
		parent_id: r.parent_id,
		series_id: r.series_id,
		occurrence_key: r.occurrence_key,
		predecessor_id: r.predecessor_id,
		completed_at: r.completed_at?.toISOString() ?? null,
	}));
	return sql`INSERT INTO task (id, plant_id, title, description, category, priority, status, creator_id, created_at,
		assignee_id, due_kind, due_date, due_time, timezone, due_at, resolver_version, person_id, meeting_id, team_id,
		parent_id, series_id, occurrence_key, predecessor_id, completed_at)
	SELECT r.id, ${plantId}::uuid, r.title, r.description, r.category, r.priority, r.status, ${creatorId}::uuid,
		r.created_at, r.assignee_id, r.due_kind, r.due_date, r.due_time, r.timezone, r.due_at, r.resolver_version,
		r.person_id, r.meeting_id, r.team_id, r.parent_id, r.series_id, r.occurrence_key, r.predecessor_id, r.completed_at
	FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS r(id uuid, title text, description text, category text,
		priority text, status text, created_at timestamptz, assignee_id uuid, due_kind text, due_date date, due_time time,
		timezone text, due_at timestamptz, resolver_version text, person_id uuid, meeting_id uuid, team_id uuid,
		parent_id uuid, series_id uuid, occurrence_key text, predecessor_id uuid, completed_at timestamptz)
	${after ? sql`WHERE EXISTS(SELECT FROM ${after})` : sql``}`;
}
/** The audit rows of newly created tasks. */
export function auditCreated(cmd: AuditCommand, rows: readonly TaskRow[], source?: z.infer<typeof c.historySource>) {
	for (const r of rows)
		auditRow(cmd, {
			taskId: r.id,
			action: "tasks.changed",
			kind: "create",
			before: null,
			after: audited(r),
			beforeRevision: null,
			afterRevision: r.revision,
			source,
		});
}

/** The persisted fields a status or edit writes, also the values its audit row compares. */
export const audited = (r: TaskRow) => ({
	title: r.title,
	description: r.description,
	status: r.status,
	priority: r.priority,
	category: r.category,
	due_kind: r.due_kind,
	due_date: r.due_date,
	due_time: r.due_time,
	due_at: r.due_at?.toISOString() ?? null,
	assignee_id: r.assignee_id,
	person_id: r.person_id,
	meeting_id: r.meeting_id,
	team_id: r.team_id,
	completed_at: r.completed_at?.toISOString() ?? null,
	deleted_at: r.deleted_at?.toISOString() ?? null,
});
export const bump = (r: string) => revision.parse(String(BigInt(r) + 1n));

/** The locked live task under the expected revision, or a refusal. Members act only on a task they hold (own duty). */
export async function current(tx: Tx, cmd: Command, taskId: string, expectedRevision: string, ownDuty: boolean) {
	const row = await loadTask(tx, cmd.actor.plantId, taskId, true);
	if (!row || row.deleted_at) deny();
	if (!administers(cmd.actor) && !(ownDuty && row.assignee_id === cmd.actor.accountId)) deny();
	if (row.revision !== expectedRevision) deny("conflict");
	return row;
}
export function update(plantId: string, row: TaskRow, next: TaskRow) {
	const v = audited(next);
	return sql`UPDATE task SET title=${v.title}, description=${v.description}, status=${v.status}, priority=${v.priority},
		category=${v.category}, due_kind=${v.due_kind}, due_date=${v.due_date}::date, due_time=${v.due_time}::time,
		timezone=${next.timezone}, due_at=${v.due_at}::timestamptz,
		resolver_version=${next.due_kind === "timed" ? "1" : null}, assignee_id=${v.assignee_id}::uuid,
		person_id=${v.person_id}::uuid, meeting_id=${v.meeting_id}::uuid, team_id=${v.team_id}::uuid,
		completed_at=${v.completed_at}::timestamptz, deleted_at=${v.deleted_at}::timestamptz, revision=revision+1
		WHERE id=${row.id}::uuid AND plant_id=${plantId}::uuid AND revision=${row.revision}::bigint`;
}

/**
 * One status change for every entry point: complete, reopen, waive, changeStatus, checklist ticks and bulk completion
 * share it, so each records the same completion instant, waiver and history (REQ-TSK-003). The same status again is a
 * no-op with no history entry. Completing a recurring task also creates its one successor with fresh checklist rows in
 * the same statement (REQ-TSK-007). The caller passes `changes` to the reminder port once for the whole command and
 * builds the reply it needs from `row`; a bulk change needs only the new revision.
 */
export function setStatus(
	tx: Tx,
	cmd: AuditCommand,
	row: TaskRow,
	input: { status: z.infer<typeof c.taskStatus>; reason?: string | null; source?: z.infer<typeof c.historySource> },
) {
	if (row.status === input.status) {
		// A task command still needs its row to keep the request key; generated work adds nothing.
		if (input.source !== "generated")
			auditRow(cmd, {
				taskId: row.id,
				action: "tasks.changed",
				kind: "noop",
				before: null,
				after: null,
				beforeRevision: row.revision,
				afterRevision: row.revision,
			});
		return { row, outcome: "noop" as const, changes: [], successor: null };
	}
	const reopening = !OPEN(row.status) && OPEN(input.status);
	if (reopening && row.open_successor) deny("open_successor", { successorId: row.open_successor });
	const at = new Date();
	const next: TaskRow = {
		...row,
		status: input.status,
		completed_at: input.status === "complete" ? at : null,
		revision: bump(row.revision),
	};
	cmd.writes.push(update(cmd.actor.plantId, row, next));
	// A waived generated duty stays closed through edits and deletion; only an explicit reopen clears the waiver.
	if (row.obligation_id && (input.status === "no_longer_needed" || row.status === "no_longer_needed"))
		cmd.writes.push(
			tx
				.update(tables.obligation)
				.set(
					input.status === "no_longer_needed"
						? { waived_at: at, waiver_reason: input.reason ?? null, revision: sql`${tables.obligation.revision}+1` }
						: { waived_at: null, waiver_reason: null, revision: sql`${tables.obligation.revision}+1` },
				)
				.where(and(eq(tables.obligation.id, row.obligation_id), eq(tables.obligation.plant_id, cmd.actor.plantId))),
		);
	const delta = changes(audited(row), audited(next));
	auditRow(cmd, {
		taskId: row.id,
		action:
			input.status === "complete"
				? "tasks.completed"
				: input.status === "no_longer_needed"
					? "tasks.waived"
					: "tasks.changed",
		kind:
			input.status === "complete"
				? "complete"
				: input.status === "no_longer_needed"
					? "waive"
					: reopening
						? "reopen"
						: "edit",
		...delta,
		beforeRevision: row.revision,
		afterRevision: next.revision,
		reason: input.reason ?? null,
		source: input.source,
	});
	const created = input.status === "complete" ? successorOf(row, at) : null;
	if (created) {
		// The successor follows the completion inside the statement: the series has one open task at a time.
		cmd.writes.push(insertTasks(cmd.actor.plantId, cmd.actor.accountId, created, lastWrite(cmd)));
		auditCreated(cmd, created, "recurrence");
	}
	const successor = created?.[0] ?? null;
	return {
		row: next,
		outcome: "changed" as const,
		changes: [
			reminderChange(cmd.actor.plantId, row, next),
			successor ? reminderChange(cmd.actor.plantId, null, successor) : undefined,
		],
		successor,
	};
}
/** setStatus for one task command, with its reminder changes synced after the write. */
export function changeTo(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
	row: TaskRow,
	input: Parameters<typeof setStatus>[3],
) {
	const r = setStatus(tx, cmd, row, input);
	return { value: mutation(cmd, r.row, r.outcome), after: syncAll(reminders, tx, r.changes) };
}
/** A new task row with no completion, deletion, source, series or checklist. */
export function newTask(
	zone: TimeZone,
	fields: Pick<TaskRow, "title" | "category" | "priority" | "status" | "assignee_id" | "assignee_name"> &
		Partial<TaskRow>,
): TaskRow {
	const at = new Date();
	return {
		id: randomUUID(),
		revision: revision.parse("1"),
		description: null,
		created_at: at,
		completed_at: fields.status === "complete" ? at : null,
		deleted_at: null,
		due_kind: "undated",
		due_date: null,
		due_time: null,
		timezone: null,
		due_at: null,
		person_id: null,
		meeting_id: null,
		team_id: null,
		relation_label: null,
		parent_id: null,
		series_id: null,
		occurrence_key: null,
		predecessor_id: null,
		prerequisite_ids: [],
		open_prerequisites: 0,
		obligation_id: null,
		obligation_kind: null,
		child_total: 0,
		child_complete: 0,
		plant_zone: zone,
		open_successor: null,
		checklist: [],
		...fields,
	};
}
export function mutation(cmd: AuditCommand, row: TaskRow, outcome: "changed" | "noop") {
	return c.taskMutation.parse({
		task: detailOf(row, instant.parse(new Date().toISOString())),
		receiptId: cmd.id,
		outcome,
	});
}

/** The task commands. The web mount supplies WP-031's reminder sync, as settings supplies its effects. */
export function createTaskWriter(deps: { reminders: TaskReminders }) {
	const { reminders } = deps;
	return {
		...structureWriter(reminders),
		/** Create a top-level task. Owner/Admin. Checklist rows come from createSubtask. */
		async create(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.createTaskRequest, raw);
				return command(tx, context, "tasks.create", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input;
					const due = dueColumns(v.due, await cmd.actor.zone());
					const refs =
						v.assigneeId || v.relation
							? await references(tx, cmd.actor.plantId, v)
							: { assigneeName: null, relationLabel: null };
					const row = newTask(await cmd.actor.zone(), {
						title: v.title,
						description: v.description,
						category: v.category,
						priority: v.priority,
						status: v.status,
						assignee_id: v.assigneeId,
						assignee_name: refs.assigneeName,
						...due,
						...relationColumns(v.relation),
						relation_label: refs.relationLabel,
					});
					cmd.writes.push(insertTasks(cmd.actor.plantId, cmd.actor.accountId, [row]));
					auditCreated(cmd, [row]);
					return {
						value: mutation(cmd, row, "changed"),
						after: syncReminders(reminders, tx, cmd.actor.plantId, null, row),
					};
				});
			});
		},
		/** Edit fields of a live task. A generated duty keeps its relation and category (REQ-TSK-002). Owner/Admin. */
		async edit(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.editTaskRequest, raw);
				return command(tx, context, "tasks.edit", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const row = await current(tx, cmd, input.input.taskId, input.expectedRevision, false);
					const p = input.input.patch;
					const relation = p.relation === undefined ? undefined : relationColumns(p.relation);
					if (
						row.obligation_id &&
						((p.category !== undefined && p.category !== row.category) ||
							(relation &&
								(relation.person_id !== row.person_id ||
									relation.meeting_id !== row.meeting_id ||
									relation.team_id !== row.team_id)))
					)
						deny("protected_source");
					if (row.parent_id && ((p.due && p.due.kind !== "undated") || p.relation)) deny("invalid_input");
					const refs =
						(p.assigneeId && p.assigneeId !== row.assignee_id) || p.relation
							? await references(tx, cmd.actor.plantId, {
									assigneeId: p.assigneeId,
									relation: p.relation,
								})
							: null;
					const next: TaskRow = {
						...row,
						...(p.title !== undefined ? { title: p.title } : {}),
						...(p.description !== undefined ? { description: p.description } : {}),
						...(p.priority !== undefined ? { priority: p.priority } : {}),
						...(p.category !== undefined ? { category: p.category } : {}),
						...(p.due !== undefined ? dueColumns(p.due, await cmd.actor.zone()) : {}),
						...(p.assigneeId !== undefined
							? {
									assignee_id: p.assigneeId,
									assignee_name: p.assigneeId === row.assignee_id ? row.assignee_name : (refs?.assigneeName ?? null),
								}
							: {}),
						...(relation ? { ...relation, relation_label: refs?.relationLabel ?? null } : {}),
					};
					const delta = changes(audited(row), audited(next));
					const changed = Object.keys(delta.after).length > 0;
					if (changed) {
						next.revision = bump(row.revision);
						cmd.writes.push(update(cmd.actor.plantId, row, next));
					}
					auditRow(cmd, {
						taskId: row.id,
						action: "tasks.changed",
						kind: changed ? "edit" : "noop",
						...(changed ? delta : { before: null, after: null }),
						beforeRevision: row.revision,
						afterRevision: next.revision,
					});
					return {
						value: mutation(cmd, next, changed ? "changed" : "noop"),
						after: changed ? syncReminders(reminders, tx, cmd.actor.plantId, row, next) : undefined,
					};
				});
			});
		},
		/** Soft-delete a task with its checklist rows. A generated obligation and every history entry remain. */
		async delete(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.taskCommandRequest, raw);
				return command(tx, context, "tasks.delete", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const row = await current(tx, cmd, input.input.taskId, input.expectedRevision, false);
					const at = new Date();
					cmd.writes.push(
						tx
							.update(tables.task)
							.set({ deleted_at: at, revision: sql`${tables.task.revision}+1` })
							.where(
								and(
									eq(tables.task.plant_id, cmd.actor.plantId),
									sql`(${tables.task.id}=${row.id}::uuid OR ${tables.task.parent_id}=${row.id}::uuid)`,
									isNull(tables.task.deleted_at),
								),
							),
					);
					for (const k of [{ id: row.id, revision: row.revision }, ...(row.checklist ?? [])])
						auditRow(cmd, {
							taskId: k.id,
							action: "tasks.changed",
							kind: "remove",
							before: { deleted_at: null },
							after: { deleted_at: at.toISOString() },
							beforeRevision: k.revision,
							afterRevision: bump(k.revision),
						});
					const next: TaskRow = {
						...row,
						deleted_at: at,
						revision: bump(row.revision),
						checklist: [],
						child_total: 0,
						child_complete: 0,
					};
					return {
						value: mutation(cmd, next, "changed"),
						after: syncReminders(reminders, tx, cmd.actor.plantId, row, next),
					};
				});
			});
		},
		/** Complete a task: the server records when and by whom. A Member completes only a task they hold. */
		async complete(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.taskCommandRequest, raw);
				return command(tx, context, "tasks.complete", input, async (cmd) =>
					changeTo(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
						status: "complete",
					}),
				);
			});
		},
		/** Reopen a settled task. History keeps the earlier completion or waiver; an open later occurrence refuses. */
		async reopen(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.taskCommandRequest, raw);
				return command(tx, context, "tasks.reopen", input, async (cmd) =>
					changeTo(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
						status: "not_started",
					}),
				);
			});
		},
		/** Close as no longer needed: no completion time or success credit; a generated duty stays waived. */
		async waive(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.waiveTaskRequest, raw);
				return command(tx, context, "tasks.waive", input, async (cmd) =>
					changeTo(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
						status: "no_longer_needed",
						reason: input.input.reason,
					}),
				);
			});
		},
		/** Any status, through the same writer as complete, reopen and waive. */
		async changeStatus(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.changeStatusRequest, raw);
				return command(tx, context, "tasks.changeStatus", input, async (cmd) =>
					changeTo(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
						status: input.input.status,
					}),
				);
			});
		},
	};
}
export type TaskWriter = ReturnType<typeof createTaskWriter>;
