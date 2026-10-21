import { instant, resolveCalendar, revision, type TimeZone } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { and, eq, isNull, sql } from "@everyfield/db/query";
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
import { detailOf, loadTask, type TaskRow } from "./queries.ts";

/** What a reminder needs about one task after a write. WP-031's sync replaces its owed due and overdue notices. */
export type ReminderSource = {
	plantId: string;
	taskId: string;
	revision: string;
	title: string;
	assigneeId: string | null;
	due: { kind: "undated" } | { kind: "date_only"; date: string; zone: string } | { kind: "timed"; at: string };
	open: boolean;
};
export type TaskReminders = (tx: Tx, source: ReminderSource) => Promise<unknown>;

type DueColumns = Pick<TaskRow, "due_kind" | "due_date" | "due_time" | "timezone" | "due_at">;
/** The server resolves a deadline from the entered church-local time (REQ-TSK-018); the client never sends an instant. */
function dueColumns(due: z.infer<typeof c.dueInput>, zone: TimeZone): DueColumns {
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
const relationColumns = (r: z.infer<typeof c.relation> | null) => ({
	person_id: r?.kind === "person" ? r.id : null,
	meeting_id: r?.kind === "meeting" ? r.id : null,
	team_id: r?.kind === "team" ? r.id : null,
});

/** Names for references a write is about to store, each checked against the church and its current state. */
async function references(
	tx: Tx,
	plantId: string,
	input: { assigneeId?: string | null; relation?: z.infer<typeof c.relation> | null; parentId?: string | null },
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
			AND plant_id=${plantId}::uuid AND archived_at IS NULL FOR SHARE) AS team,
		(SELECT jsonb_build_object('assignee',assignee_id) FROM task WHERE id=${input.parentId ?? null}::uuid
			AND plant_id=${plantId}::uuid AND parent_id IS NULL AND deleted_at IS NULL FOR SHARE) AS parent`);
	const row = z
		.object({
			assignee: z.string().nullable(),
			person: z.string().nullable(),
			meeting: z.string().nullable(),
			team: z.string().nullable(),
			parent: z.unknown(),
		})
		.parse(r.rows[0]);
	if (input.assigneeId && row.assignee === null) deny("invalid_subject");
	const label = input.relation ? row[input.relation.kind] : null;
	if (input.relation && label === null) deny("invalid_subject");
	if (input.parentId && !row.parent) deny("invalid_subject");
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
	};
}
const remindable = (s: ReminderSource) => s.open && s.assigneeId !== null && s.due.kind !== "undated";
/** Reminders change only when the task had or now has owed reminders; other writes keep their small budget. */
export function syncReminders(
	reminders: TaskReminders,
	tx: Tx,
	plantId: string,
	before: TaskRow | null,
	after: TaskRow,
) {
	const prior = before && reminderSource(plantId, before),
		next = reminderSource(plantId, after);
	if (!(prior && remindable(prior)) && !remindable(next)) return undefined;
	return () => reminders(tx, { ...next, open: remindable(next) });
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
const bump = (r: string) => revision.parse(String(BigInt(r) + 1n));

/** The locked live task under the expected revision, or a refusal. Members act only on a task they hold (own duty). */
async function current(tx: Tx, cmd: Command, taskId: string, expectedRevision: string, ownDuty: boolean) {
	const row = await loadTask(tx, cmd.actor.plantId, taskId, true);
	if (!row || row.deleted_at) deny();
	if (!administers(cmd.actor) && !(ownDuty && row.assignee_id === cmd.actor.accountId)) deny();
	if (row.revision !== expectedRevision) deny("conflict");
	return row;
}
function update(plantId: string, row: TaskRow, next: TaskRow) {
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
 * One status change for every entry point: complete, reopen, waive and changeStatus share it, so each records the
 * same completion instant, waiver and history (REQ-TSK-003). The same status again is a no-op with no history entry.
 */
export async function setStatus(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
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
		return { value: mutation(cmd, row, "noop") };
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
	return { value: mutation(cmd, next, "changed"), after: syncReminders(reminders, tx, cmd.actor.plantId, row, next) };
}
function mutation(cmd: AuditCommand, row: TaskRow, outcome: "changed" | "noop") {
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
		/** Create a top-level task or one checklist row under a live top-level parent. Owner/Admin. */
		async create(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.createTaskRequest, raw);
				return command(tx, context, "tasks.create", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input;
					// A checklist row has no deadline, relation or source (one level only; WP-025 owns the rest).
					if (v.parentId && (v.due.kind !== "undated" || v.relation)) deny("invalid_input");
					const due = dueColumns(v.due, cmd.actor.zone);
					const refs =
						v.assigneeId || v.relation || v.parentId
							? await references(tx, cmd.actor.plantId, v)
							: { assigneeName: null, relationLabel: null };
					const id = randomUUID(),
						at = new Date();
					const row: TaskRow = {
						id,
						revision: revision.parse("1"),
						title: v.title,
						description: v.description,
						category: v.category,
						priority: v.priority,
						status: v.status,
						created_at: at,
						completed_at: v.status === "complete" ? at : null,
						deleted_at: null,
						assignee_id: v.assigneeId,
						...due,
						...relationColumns(v.relation),
						parent_id: v.parentId,
						series_id: null,
						occurrence_key: null,
						obligation_id: null,
						obligation_kind: null,
						assignee_name: refs.assigneeName,
						relation_label: refs.relationLabel,
						child_total: 0,
						child_complete: 0,
						plant_zone: cmd.actor.zone,
						open_successor: null,
						checklist: [],
					};
					cmd.writes.push(
						tx.insert(tables.task).values({
							id,
							plant_id: cmd.actor.plantId,
							title: row.title,
							description: row.description,
							category: row.category,
							priority: row.priority,
							status: row.status,
							creator_id: cmd.actor.accountId,
							created_at: at,
							assignee_id: row.assignee_id,
							due_kind: row.due_kind,
							due_date: row.due_date,
							due_time: row.due_time,
							timezone: row.timezone,
							due_at: row.due_at,
							resolver_version: row.due_kind === "timed" ? "1" : null,
							person_id: row.person_id,
							meeting_id: row.meeting_id,
							team_id: row.team_id,
							parent_id: row.parent_id,
							completed_at: row.completed_at,
						}),
					);
					auditRow(cmd, {
						taskId: id,
						action: "tasks.changed",
						kind: "create",
						before: null,
						after: audited(row),
						beforeRevision: null,
						afterRevision: "1",
					});
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
						...(p.due !== undefined ? dueColumns(p.due, cmd.actor.zone) : {}),
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
					setStatus(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
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
					setStatus(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
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
					setStatus(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
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
					setStatus(tx, cmd, reminders, await current(tx, cmd, input.input.taskId, input.expectedRevision, true), {
						status: input.input.status,
					}),
				);
			});
		},
	};
}
export type TaskWriter = ReturnType<typeof createTaskWriter>;
