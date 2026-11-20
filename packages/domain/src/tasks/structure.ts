import { instant } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import { sql } from "@everyfield/db/query";
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
	type Command,
	type TaskContext,
	type Tx,
} from "./core.ts";
import { detailOf, loadTask, loadTasks, type LockedTask, type TaskRow } from "./queries.ts";
import {
	audited,
	auditCreated,
	bump,
	changeTo,
	current,
	dueColumns,
	insertTasks,
	mutation,
	newTask,
	noop,
	recount,
	reminderChange,
	references,
	setStatus,
	syncAll,
	syncReminders,
	update,
	type TaskReminders,
} from "./writes.ts";

const now = () => instant.parse(new Date().toISOString());
const OPEN = (s: string) => !(c.settledStatus as readonly string[]).includes(s);
const liveRule = (row: TaskRow) => (row.rule && !row.rule.stopped ? row.rule : null);
const ruleOf = (row: TaskRow) => {
	const rule = liveRule(row);
	return rule ? { frequency: rule.frequency, until: rule.until, localTime: rule.local_time } : null;
};

export function structureWriter(reminders: TaskReminders) {
	return {
		async createSubtask(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.createSubtaskRequest, raw);
				return command(tx, context, "tasks.createSubtask", input, async (cmd) => {
					const v = input.input;
					const parent = await loadTask(tx, cmd.actor.plantId, v.parentId, true);
					if (!parent || parent.deleted_at) deny("unavailable");
					const admin = administers(cmd.actor);
					if (!admin && !parent.assignees.some((a) => a.accountId === cmd.actor.accountId)) deny("unavailable");
					if (!admin && v.assigneeIds !== undefined) deny("access_denied");
					if (parent.parent_id) deny("invalid_subject");
					if (parent.child_total >= 500) deny("invalid_input");
					if (parent.revision !== input.expectedRevision) deny("conflict");
					const assignees =
						v.assigneeIds === undefined
							? parent.assignees.filter((a) => a.seated)
							: v.assigneeIds.length
								? (await references(tx, cmd.actor.plantId, { assigneeIds: v.assigneeIds })).assignees
								: [];
					const row = newTask(parent.plant_zone, {
						title: v.title,
						category: parent.category,
						priority: parent.priority,
						status: "not_started",
						assignees,
						parent_id: parent.id,
					});
					cmd.writes.push(...insertTasks(cmd.actor.plantId, cmd.actor.accountId, [row]));
					auditCreated(cmd, [row]);
					return { value: mutation(cmd, row, "changed") };
				});
			});
		},
		async setSubtaskCompletion(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.setSubtaskCompletionRequest, raw);
				return command(tx, context, "tasks.setSubtaskCompletion", input, async (cmd) => {
					const row = await current(tx, cmd, input.input.taskId, input.expectedRevision, true);
					if (row.parent_id !== input.input.parentId) deny("unavailable");
					return changeTo(tx, cmd, reminders, row, { status: input.input.complete ? "complete" : "not_started" });
				});
			});
		},
		async removeSubtask(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.removeSubtaskRequest, raw);
				return command(tx, context, "tasks.removeSubtask", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const row = await current(tx, cmd, input.input.taskId, input.expectedRevision, false);
					if (row.parent_id !== input.input.parentId) deny("unavailable");
					const next: TaskRow = { ...row, deleted_at: new Date(), revision: bump(row.revision) };
					cmd.writes.push(...update(cmd.actor.plantId, row, next));
					auditRow(cmd, {
						taskId: row.id,
						action: "tasks.changed",
						kind: "remove",
						...changes(audited(row), audited(next)),
						beforeRevision: row.revision,
						afterRevision: next.revision,
					});
					return { value: mutation(cmd, next, "changed") };
				});
			});
		},
		async replacePrerequisites(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.replacePrerequisitesRequest, raw);
				return command(tx, context, "tasks.replacePrerequisites", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const v = input.input;
					const row = await current(tx, cmd, v.taskId, input.expectedRevision, false);
					if (row.parent_id) deny("invalid_subject");
					const ids = v.prerequisiteIds as string[];
					const added = ids.filter((id) => !row.prerequisite_ids.includes(id));
					if (added.includes(row.id)) deny("invalid_subject");
					if (added.length === 0 && ids.length === row.prerequisite_ids.length)
						return { value: mutation(cmd, noop(cmd, row).row, "noop") };
					const plant = cmd.actor.plantId;
					const r = await tx.execute(sql`SELECT
						(SELECT count(*)::int FROM task WHERE id=ANY(${sql.param(added)}::uuid[]) AND plant_id=${plant}::uuid
							AND parent_id IS NULL AND deleted_at IS NULL) AS valid,
						EXISTS(WITH RECURSIVE reach(id) AS (
							SELECT unnest(${sql.param(added)}::uuid[])
							UNION SELECT u.id FROM reach r JOIN task t ON t.id=r.id AND t.plant_id=${plant}::uuid
								AND t.deleted_at IS NULL CROSS JOIN LATERAL unnest(t.prerequisite_ids) u(id))
							SELECT FROM reach WHERE id=${row.id}::uuid) AS cycle,
						(SELECT count(*)::int FROM task WHERE id=ANY(${sql.param(ids)}::uuid[]) AND plant_id=${plant}::uuid
							AND deleted_at IS NULL AND status NOT IN ('complete','no_longer_needed')) AS open`);
					const found = z.object({ valid: z.int(), cycle: z.boolean(), open: z.int() }).parse(r.rows[0]);
					if (found.valid !== added.length) deny("invalid_subject");
					if (found.cycle) deny("dependency_cycle");
					const next: TaskRow = {
						...row,
						prerequisite_ids: ids,
						open_prerequisites: found.open,
						revision: bump(row.revision),
					};
					cmd.writes.push(
						sql`UPDATE task SET prerequisite_ids=${sql.param(ids)}::uuid[], revision=revision+1
							WHERE id=${row.id}::uuid AND plant_id=${plant}::uuid AND revision=${row.revision}::bigint`,
					);
					auditRow(cmd, {
						taskId: row.id,
						action: "tasks.changed",
						kind: "edit",
						before: { prerequisite_ids: row.prerequisite_ids },
						after: { prerequisite_ids: ids },
						beforeRevision: row.revision,
						afterRevision: next.revision,
					});
					return { value: mutation(cmd, next, "changed"), after: syncReminders(reminders, tx, plant, row, next) };
				});
			});
		},
		async configureRecurrence(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.configureRecurrenceRequest, raw);
				return command(tx, context, "tasks.configureRecurrence", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const v = input.input;
					const row = await current(tx, cmd, v.taskId, input.expectedRevision, false);
					if (row.parent_id) deny("invalid_subject");
					if (row.obligation_id) deny("protected_source");
					const live = liveRule(row),
						before = ruleOf(row),
						after = v.rule;
					const plant = cmd.actor.plantId;
					if (JSON.stringify(before) === JSON.stringify(after))
						return { value: mutation(cmd, noop(cmd, row).row, "noop") };
					let next: TaskRow = { ...row, revision: bump(row.revision) };
					if (!after) {
						if (!live) throw Error(`Task ${row.id} stops a recurrence it does not hold`);
						cmd.writes.push(
							sql`UPDATE recurrence SET stopped_at=clock_timestamp(), revision=revision+1
								WHERE id=${row.series_id}::uuid AND plant_id=${plant}::uuid`,
							sql`UPDATE task SET revision=revision+1 WHERE id=${row.id}::uuid AND plant_id=${plant}::uuid
								AND revision=${row.revision}::bigint`,
						);
						next = { ...next, rule: { ...live, stopped: true } };
					} else if (live) {
						cmd.writes.push(
							sql`UPDATE recurrence SET interval=${after.frequency}, end_date=${after.until}::date,
								local_time=${after.localTime}::time, revision=revision+1
								WHERE id=${row.series_id}::uuid AND plant_id=${plant}::uuid`,
							sql`UPDATE task SET revision=revision+1 WHERE id=${row.id}::uuid AND plant_id=${plant}::uuid
								AND revision=${row.revision}::bigint`,
						);
						next = { ...next, rule: { ...live, ...stored(after) } };
					} else {
						const seriesId = randomUUID();
						cmd.writes.push(
							sql`INSERT INTO recurrence (id, plant_id, interval, end_date, timezone, local_time, source_task_id,
								source_revision) VALUES (${seriesId}::uuid, ${plant}::uuid, ${after.frequency}, ${after.until}::date,
								${row.plant_zone}, ${after.localTime}::time, ${row.id}::uuid, ${row.revision}::bigint)`,
							sql`UPDATE task SET series_id=${seriesId}::uuid, occurrence_key='1', revision=revision+1
								WHERE id=${row.id}::uuid AND plant_id=${plant}::uuid AND revision=${row.revision}::bigint`,
						);
						next = { ...next, series_id: seriesId, occurrence_key: "1", rule: { id: seriesId, ...stored(after) } };
					}
					auditRow(cmd, {
						taskId: row.id,
						action: "tasks.changed",
						kind: "edit",
						before: { recurrence: before },
						after: { recurrence: after },
						beforeRevision: row.revision,
						afterRevision: next.revision,
					});
					return { value: mutation(cmd, next, "changed"), after: syncReminders(reminders, tx, plant, row, next) };
				});
			});
		},
		async completeOccurrence(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.taskCommandRequest, raw);
				return command(tx, context, "tasks.completeOccurrence", input, async (cmd) => {
					const row = await current(tx, cmd, input.input.taskId, input.expectedRevision, true);
					const r = setStatus(tx, cmd, row, { status: "complete" });
					return {
						value: c.occurrenceMutation.parse({
							...mutation(cmd, r.row, r.outcome, r.recounted),
							successor: r.successor && detailOf(r.successor, now()),
						}),
						after: syncAll(reminders, tx, r.changes),
					};
				});
			});
		},
		async bulkComplete(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.bulkCompleteRequest, raw);
				return command(tx, context, "tasks.bulkComplete", input, async (cmd) =>
					bulk(tx, cmd, input.items, (row) => {
						if (!administers(cmd.actor) && !row.assignees.some((a) => a.accountId === cmd.actor.accountId))
							return "unauthorized";
						if (row.status === "no_longer_needed") return "closed";
						if (row.status === "complete") return "noop";
						const r = setStatus(tx, cmd, row, { status: "complete", source: "bulk" });
						return { row: r.row, changes: r.changes, successor: r.successor };
					}),
				);
			});
		},
		async bulkReschedule(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.bulkRescheduleRequest, raw);
				return command(tx, context, "tasks.bulkReschedule", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const due = dueColumns(input.due, cmd.actor.zone);
					return bulk(tx, cmd, input.items, (row) => {
						if (!OPEN(row.status)) return "closed";
						if (row.parent_id) return "ineligible";
						const next: TaskRow = { ...row, ...due };
						const delta = changes(audited(row), audited(next));
						if (!Object.keys(delta.after).length) return "noop";
						next.revision = bump(row.revision);
						cmd.writes.push(...update(cmd.actor.plantId, row, next));
						auditRow(cmd, {
							taskId: row.id,
							action: "tasks.changed",
							kind: "edit",
							...delta,
							beforeRevision: row.revision,
							afterRevision: next.revision,
							source: "bulk",
						});
						return { row: next, changes: [reminderChange(cmd.actor.plantId, row, next)] };
					});
				});
			});
		},
	};

	async function bulk(
		tx: Tx,
		cmd: Command,
		items: readonly { taskId: string; expectedRevision: string }[],
		apply: (
			row: LockedTask,
		) =>
			| z.infer<typeof c.bulkOutcome>
			| { row: TaskRow; changes: readonly ReturnType<typeof reminderChange>[]; successor?: TaskRow | null },
	) {
		const selected = [...new Map(items.map((i) => [i.taskId, i])).values()];
		const rows = await loadTasks(
			tx,
			cmd.actor.plantId,
			selected.map((i) => i.taskId),
		);
		const pending: ReturnType<typeof reminderChange>[] = [];
		const moves: Parameters<typeof recount>[0][number][] = [];
		const remaining: string[] = [];
		const asOf = now();
		const results = selected.map((item) => {
			const row = rows.get(item.taskId);
			const done = (
				outcome: z.infer<typeof c.bulkOutcome>,
				revision: string | null = row?.revision ?? null,
				successor: TaskRow | null = null,
			) => {
				if (outcome !== "changed" && row && !row.deleted_at && OPEN(row.status)) remaining.push(item.taskId);
				return { taskId: item.taskId, outcome, revision, successor: successor && detailOf(successor, asOf) };
			};
			if (!row) return done("not_found", null);
			if (row.deleted_at) return done("deleted");
			if (row.revision !== item.expectedRevision) return done("stale");
			const r = apply(row);
			if (typeof r === "string") return done(r);
			pending.push(...r.changes);
			moves.push({ from: row, to: r.row });
			return done("changed", r.row.revision, r.successor ?? null);
		});
		return {
			value: c.bulkResult.parse({
				receiptId: cmd.id,
				items: results,
				changed: results.filter((r) => r.outcome === "changed").length,
				remaining,
				recounted: recount(moves),
			}),
			after: syncAll(reminders, tx, pending),
		};
	}
}
const stored = (rule: c.RecurrenceRule) => ({
	frequency: rule.frequency,
	until: rule.until,
	local_time: rule.localTime,
	stopped: false,
});
