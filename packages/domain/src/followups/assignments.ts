import * as c from "@everyfield/contracts/followups";
import * as tc from "@everyfield/contracts/tasks";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { administers, auditRow, changes, command, deny, parse, type TaskContext, type Tx } from "../tasks/core.ts";
import { loadTask, loadTasks, type TaskRow } from "../tasks/queries.ts";
import {
	audited,
	auditCreated,
	bump,
	dueColumns,
	insertTasks,
	mutation,
	newTask,
	reminderChange,
	syncAll,
	syncReminders,
	update,
	type TaskReminders,
} from "../tasks/writes.ts";
import { answer, COMMITTED, followUpTask, OPEN, refuse } from "./core.ts";

/**
 * The display name of `account` when it may own a follow-up now, else null (REQ-TSK-012). The seat and the committed
 * Person are share-locked, so a concurrent demotion or seat removal waits for this write or this write sees it.
 */
const ownerName = (plantId: string, account: string | null) => sql`(SELECT i.display_name FROM seat s
	JOIN person e ON e.tenant_id=s.plant_id AND e.linked_account_id=s.account_id AND e.plant_id IS NOT NULL
		AND e.state='live' AND e.stage IN ${COMMITTED}
	CROSS JOIN LATERAL seat_identity(s.account_id) i
	WHERE s.account_id=${account}::uuid AND s.plant_id=${plantId}::uuid AND s.ended_at IS NULL
		AND s.accepted_at<=clock_timestamp() LIMIT 1 FOR SHARE OF s, e)`;
const isFollowUp = (t: TaskRow) =>
	t.category === "follow_up" && t.person_id !== null && t.parent_id === null && t.deleted_at === null;
const isOpen = (t: TaskRow) => !(tc.settledStatus as readonly string[]).includes(t.status);

/** Explicit follow-up creation, assignment and handoff. Nothing here runs without a person's request (REQ-PPL-022). */
export function assignmentWriter(reminders: TaskReminders) {
	return {
		/**
		 * A manual follow-up with a Person: undated unless a date is chosen, with no meeting origin or 48-hour measure
		 * (REQ-TSK-012). The default title comes from the stored Person, never from the client. Owner/Admin.
		 */
		async createFollowUp(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.createFollowUpRequest, raw);
				return command(tx, context, "tasks.createFollowUp", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input,
						plant = cmd.actor.plantId;
					const due = dueColumns(v.due, cmd.actor.zone);
					const r = await tx.execute(sql`SELECT (SELECT display_name FROM person WHERE id=${v.personId}::uuid
						AND tenant_id=${plant}::uuid AND plant_id IS NOT NULL AND state='live' FOR SHARE) AS person,
						${ownerName(plant, v.assigneeId)} AS owner`);
					const facts = z.object({ person: z.string().nullable(), owner: z.string().nullable() }).parse(r.rows[0]);
					if (facts.person === null) deny("invalid_subject");
					if (v.assigneeId && facts.owner === null) refuse("owner_ineligible");
					const row = newTask(cmd.actor.zone, {
						title: v.title ?? `Follow up with ${facts.person}`,
						description: v.description,
						category: "follow_up",
						priority: v.priority,
						status: "not_started",
						assignee_id: v.assigneeId,
						assignee_name: facts.owner,
						...due,
						person_id: v.personId,
						relation_label: facts.person,
					});
					cmd.writes.push(insertTasks(plant, cmd.actor.accountId, [row]));
					auditCreated(cmd, [row]);
					return {
						value: mutation(cmd, row, "changed"),
						after: syncReminders(reminders, tx, plant, null, row),
					};
				});
			});
		},
		/**
		 * Assign an open follow-up to a current eligible owner, or leave it as Needs owner with null (REQ-TSK-012).
		 * Eligibility is checked when the change is made. Owner/Admin.
		 */
		async assignFollowUp(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.assignFollowUpRequest, raw);
				return command(tx, context, "tasks.assignFollowUp", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input,
						plant = cmd.actor.plantId;
					const row = await loadTask(tx, plant, v.taskId, true);
					if (!row || !isFollowUp(row)) deny();
					if (row.revision !== input.expectedRevision) deny("conflict");
					// Closed work stays closed: assignment never reopens it.
					if (!isOpen(row)) deny("invalid_subject");
					let name: string | null = null;
					if (v.assigneeId) {
						const r = await tx.execute(sql`SELECT ${ownerName(plant, v.assigneeId)} AS owner`);
						name = z.string().nullable().parse(r.rows[0]?.owner);
						if (name === null) refuse("owner_ineligible");
					}
					const next: TaskRow = { ...row, assignee_id: v.assigneeId, assignee_name: name };
					const changed = row.assignee_id !== v.assigneeId;
					if (changed) {
						next.revision = bump(row.revision);
						cmd.writes.push(update(plant, row, next));
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
		/**
		 * Move reviewed open follow-ups of an account that lost eligibility to a current eligible owner (REQ-TSK-013).
		 * All or nothing: a foreign or ineligible recipient, a changed task or the church Owner as source refuses before
		 * anything moves. Closed, waived or deleted tasks never reopen. At most 100 per request; the reply names what
		 * moved and the source's open follow-ups that remain. Owner/Admin.
		 */
		async executeHandoff(tx: Tx, context: TaskContext, raw: unknown) {
			return answer(tx, async () => {
				const input = parse(c.executeHandoffRequest, raw);
				return command(tx, context, "tasks.executeHandoff", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input,
						plant = cmd.actor.plantId;
					if (v.fromAccountId === v.toAccountId) deny("invalid_input");
					const r = await tx.execute(sql`SELECT ${ownerName(plant, v.toAccountId)} AS recipient,
						EXISTS(SELECT FROM seat s WHERE s.account_id=${v.fromAccountId}::uuid AND s.plant_id=${plant}::uuid
							AND s.role='owner' AND s.ended_at IS NULL) AS protected,
						(SELECT coalesce(jsonb_agg(t.id ORDER BY t.id),'[]') FROM task t
							JOIN person p ON p.id=t.person_id AND p.tenant_id=t.plant_id AND p.state='live'
							WHERE t.plant_id=${plant}::uuid AND ${followUpTask(sql`t`)} AND t.status IN ${OPEN}
							AND t.assignee_id=${v.fromAccountId}::uuid) AS open`);
					const facts = z
						.object({ recipient: z.string().nullable(), protected: z.boolean(), open: z.array(z.uuid()) })
						.parse(r.rows[0]);
					if (facts.protected) refuse("protected_owner");
					if (facts.recipient === null) refuse("handoff_target_ineligible");
					const rows = await loadTasks(
						tx,
						plant,
						v.items.map((i) => i.taskId),
					);
					const moved = [],
						reminderChanges = [];
					for (const item of v.items) {
						const row = rows.get(item.taskId);
						if (!row || !isFollowUp(row)) deny();
						// The reviewed selection must still be this account's open follow-up at the revision seen.
						if (row.revision !== item.expectedRevision || !isOpen(row) || row.assignee_id !== v.fromAccountId)
							deny("conflict");
						const next: TaskRow = {
							...row,
							assignee_id: v.toAccountId,
							assignee_name: facts.recipient,
							revision: bump(row.revision),
						};
						cmd.writes.push(update(plant, row, next));
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
