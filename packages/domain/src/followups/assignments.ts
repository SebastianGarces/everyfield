import * as c from "@everyfield/contracts/followups";
import * as tc from "@everyfield/contracts/tasks";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { administers, auditRow, changes, command, deny, parse, type TaskContext, type Tx } from "../tasks/core.ts";
import { idsOf, sortPeople } from "../tasks/assignees.ts";
import { lockingTasks, lockTaskWith, managedTaskRows, type TaskRow } from "../tasks/queries.ts";
import {
	assigneeFacts,
	audited,
	auditCreated,
	bump,
	checkAssignees,
	dueColumns,
	insertTasks,
	joiningOf,
	mutation,
	newTask,
	reminderChange,
	syncAll,
	syncReminders,
	update,
	type TaskReminders,
} from "../tasks/writes.ts";
import { lockOwner, ownerReason } from "../tasks/owner.ts";
import { answer, followUpTask, OPEN, refuse } from "./core.ts";

const ownerName = (
	plantId: string,
	account: string | null,
) => sql`(SELECT CASE WHEN ${ownerReason(sql`${account}::uuid`, sql`${plantId}::uuid`)} IS NULL
	THEN (SELECT display_name FROM seat_identity(${account}::uuid)) END WHERE ${lockOwner(sql`${account}::uuid`, sql`${plantId}::uuid`)} >= 0)`;
const isFollowUp = (t: TaskRow) =>
	t.category === "follow_up" && t.person_id !== null && t.parent_id === null && t.deleted_at === null;
const isOpen = (t: TaskRow) => !(tc.settledStatus as readonly string[]).includes(t.status);

export function assignmentWriter(reminders: TaskReminders) {
	return {
		async createFollowUp(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.createFollowUpRequest, raw);
				return command(tx, context, "tasks.createFollowUp", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const v = input.input,
						plant = cmd.actor.plantId;
					const due = dueColumns(v.due, cmd.actor.zone);
					const r = await tx.execute(sql`SELECT (SELECT display_name FROM person WHERE id=${v.personId}::uuid
						AND tenant_id=${plant}::uuid AND plant_id IS NOT NULL AND state='live' FOR SHARE) AS person,
						${assigneeFacts(plant, v.assigneeIds)} AS owners`);
					const facts = z.object({ person: z.string().nullable(), owners: z.unknown() }).parse(r.rows[0]);
					if (facts.person === null) deny("invalid_subject");
					const assignees = checkAssignees(facts.owners, true, "owner_ineligible");
					const row = newTask(cmd.actor.zone, {
						title: v.title ?? `Follow up with ${facts.person}`,
						description: v.description,
						category: "follow_up",
						priority: v.priority,
						status: "not_started",
						assignees,
						...due,
						person_id: v.personId,
						relation_label: facts.person,
					});
					cmd.writes.push(...insertTasks(plant, cmd.actor.accountId, [row]));
					auditCreated(cmd, [row]);
					return {
						value: mutation(cmd, row, "changed"),
						after: syncReminders(reminders, tx, plant, null, row),
					};
				});
			});
		},
		async assignFollowUp(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.assignFollowUpRequest, raw);
				return command(tx, context, "tasks.assignFollowUp", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const v = input.input,
						plant = cmd.actor.plantId;
					const locked = await lockTaskWith(
						tx,
						plant,
						v.taskId,
						(k) => sql`${assigneeFacts(plant, joiningOf(k, v.assigneeIds))} AS owners`,
					);
					const row = locked.task;
					if (!row || !isFollowUp(row)) deny("unavailable");
					if (row.revision !== input.expectedRevision) deny("conflict");
					if (!isOpen(row)) deny("invalid_subject");
					const added = checkAssignees(locked.facts.owners, true, "owner_ineligible");
					const next: TaskRow = {
						...row,
						assignees: sortPeople(
							v.assigneeIds.map(
								(id) => row.assignees.find((a) => a.accountId === id) ?? added.find((a) => a.accountId === id)!,
							),
						),
					};
					const changed = JSON.stringify(idsOf(row.assignees)) !== JSON.stringify(idsOf(next.assignees));
					if (changed) {
						next.revision = bump(row.revision);
						cmd.writes.push(...update(plant, row, next));
					}
					auditRow(cmd, {
						taskId: row.id,
						action: "tasks.changed",
						kind: changed ? "edit" : "noop",
						...(changed ? changes(audited(row), audited(next)) : { before: null, after: null }),
						beforeRevision: row.revision,
						afterRevision: next.revision,
					});
					return {
						value: mutation(cmd, next, changed ? "changed" : "noop"),
						after: changed ? syncReminders(reminders, tx, plant, row, next) : undefined,
					};
				});
			});
		},
		async executeHandoff(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.executeHandoffRequest, raw);
				return command(tx, context, "tasks.executeHandoff", input, async (cmd) => {
					if (!administers(cmd.actor)) deny("unavailable");
					const v = input.input,
						plant = cmd.actor.plantId;
					const items = sql.param(v.items.map((i) => i.taskId));
					const r = await tx.execute(sql`WITH k AS (${lockingTasks(plant, sql`t.id=ANY(${items}::uuid[])`)})
						SELECT f.*, CASE WHEN f.recipient IS NOT NULL AND NOT f.protected
							THEN (SELECT coalesce(json_agg(k ORDER BY k.id),'[]') FROM k) END AS tasks
						FROM (SELECT ${ownerName(plant, v.toAccountId)} AS recipient,
						EXISTS(SELECT FROM seat s WHERE s.account_id=${v.fromAccountId}::uuid AND s.plant_id=${plant}::uuid
							AND s.role='owner' AND s.ended_at IS NULL) AS protected,
						(SELECT coalesce(jsonb_agg(t.id ORDER BY t.id),'[]') FROM task t
							JOIN person p ON p.id=t.person_id AND p.tenant_id=t.plant_id AND p.state='live'
							WHERE t.plant_id=${plant}::uuid AND ${followUpTask(sql`t`)} AND t.status IN ${OPEN}
							AND EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=t.id AND ta.account_id=${v.fromAccountId}::uuid)) AS open
						OFFSET 0) f`);
					const facts = z
						.object({
							recipient: z.string().nullable(),
							protected: z.boolean(),
							open: z.array(z.uuid()),
							tasks: managedTaskRows.nullable(),
						})
						.parse(r.rows[0]);
					if (facts.protected) refuse("protected_owner");
					if (facts.recipient === null) refuse("handoff_target_ineligible");
					const rows = new Map((facts.tasks ?? []).map((row) => [row.id, row]));
					const moved = [],
						reminderChanges = [];
					for (const item of v.items) {
						const row = rows.get(item.taskId);
						if (!row || !isFollowUp(row)) deny("unavailable");
						if (
							row.revision !== item.expectedRevision ||
							!isOpen(row) ||
							!row.assignees.some((a) => a.accountId === v.fromAccountId)
						)
							deny("conflict");
						const next: TaskRow = {
							...row,
							assignees: sortPeople([
								...row.assignees.filter((a) => a.accountId !== v.fromAccountId && a.accountId !== v.toAccountId),
								{ accountId: v.toAccountId, displayName: facts.recipient, seated: true },
							]),
							revision: bump(row.revision),
						};
						cmd.writes.push(...update(plant, row, next));
						auditRow(cmd, {
							taskId: row.id,
							action: "tasks.changed",
							kind: "edit",
							...changes(audited(row), audited(next)),
							beforeRevision: row.revision,
							afterRevision: next.revision,
						});
						moved.push({ taskId: row.id, revision: next.revision });
						reminderChanges.push(reminderChange(plant, row, next));
					}
					const done = new Set<string>(v.items.map((i) => i.taskId));
					const remaining = facts.open.filter((id) => !done.has(id));
					return {
						value: c.handoffResult.parse({
							receiptId: cmd.id,
							to: { accountId: v.toAccountId, displayName: facts.recipient },
							moved,
							remaining: remaining.slice(0, 1000),
							remainingTotal: remaining.length,
						}),
						after: syncAll(reminders, tx, reminderChanges),
					};
				});
			});
		},
	};
}
