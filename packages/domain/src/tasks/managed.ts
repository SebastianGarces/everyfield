import { accountId, instant, localDate, personId, recordId, revision, timeZone } from "@everyfield/contracts/common";
import { meetingType } from "@everyfield/contracts/meetings";
import * as c from "@everyfield/contracts/tasks";
import { sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { displayTitle } from "../meetings/rows.ts";
import { auditRow, deny, parse, type AuditCommand, type Tx } from "./core.ts";
import { loadManagedTasks, storageKind, storedKind, type TaskRow } from "./queries.ts";
import { audited, reminderChange, setStatus, syncAll, type TaskReminders } from "./writes.ts";

// Generated work for a finalized meeting (REQ-TSK-017). The caller is the meeting domain's own reviewed command: it
// holds the meeting row lock and passes its audit command, so obligations, tasks and audit rows commit in its one
// write statement, or not at all. After that statement the caller runs `after` for reminders.
export const ensureMeetingObligationsInput = z.strictObject({
	meetingId: recordId,
	// The captured origin: the actual occurrence instant and the meeting's church-local date and zone.
	origin: z.strictObject({ at: instant, date: localDate, zone: timeZone }),
	followUps: z.array(z.strictObject({ personId, assigneeId: accountId.nullable() })).max(500),
	evaluation: z.strictObject({ assigneeId: accountId.nullable() }).nullable(),
});
const existingRow = z.object({
	id: z.uuid(),
	kind: storedKind,
	person_id: z.uuid().nullable(),
	task_id: z.uuid().nullable(),
});

/**
 * One obligation per meeting, Person and kind, and one per meeting for its evaluation. An obligation that exists already
 * is never given a new task, so a retry, a deleted task or a waiver never regenerates work. Unowned work is null:
 * Needs owner. Implements tasks.ensureObligation and tasks.ensureMeetingObligations. Two statements.
 */
export async function ensureMeetingObligations(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
	raw: z.input<typeof ensureMeetingObligationsInput>,
) {
	const v = parse(ensureMeetingObligationsInput, raw),
		plant = cmd.actor.plantId;
	const assignees = [...new Set([...v.followUps.map((f) => f.assigneeId), v.evaluation?.assigneeId ?? null])].filter(
		(a) => a !== null,
	);
	const r = await tx.execute(sql`SELECT
		(SELECT jsonb_build_object('title',title,'type',type,'vision_number',vision_number) FROM meeting WHERE id=${v.meetingId}::uuid AND plant_id=${plant}::uuid) AS meeting,
		(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,'person_id',o.person_id,
			'task_id',(SELECT t.id FROM task t WHERE t.obligation_id=o.id ORDER BY t.deleted_at NULLS FIRST LIMIT 1))),'[]')
			FROM obligation o WHERE o.meeting_id=${v.meetingId}::uuid AND o.plant_id=${plant}::uuid) AS existing,
		(SELECT coalesce(jsonb_object_agg(id,display_name),'{}') FROM person WHERE tenant_id=${plant}::uuid AND plant_id IS NOT NULL
			AND state='live' AND id=ANY(${sql.param(v.followUps.map((f) => f.personId))}::uuid[])) AS people,
		(SELECT coalesce(jsonb_object_agg(s.account_id,i.display_name),'{}') FROM seat s
			CROSS JOIN LATERAL seat_identity(s.account_id) i WHERE s.plant_id=${plant}::uuid AND s.ended_at IS NULL
			AND s.accepted_at<=clock_timestamp() AND s.account_id=ANY(${sql.param(assignees)}::uuid[])) AS seats,
		(SELECT timezone FROM plant WHERE id=${plant}::uuid) AS zone`);
	const row = z
		.object({
			meeting: z
				.object({ title: z.string().nullable(), type: meetingType, vision_number: z.number().int().nullable() })
				.nullable(),
			existing: z.array(existingRow),
			people: z.record(z.string(), z.string()),
			seats: z.record(z.string(), z.string()),
			zone: timeZone,
		})
		.parse(r.rows[0]);
	if (!row.meeting) deny();
	if (new Set(v.followUps.map((f) => f.personId)).size !== v.followUps.length) deny("invalid_input");
	// An assignee must hold a current seat; an invalid choice refuses instead of silently becoming Needs owner.
	if (assignees.some((a) => !(a in row.seats))) deny("invalid_subject");
	if (v.followUps.some((f) => !(f.personId in row.people))) deny("invalid_subject");

	const due = c.followUpDueDate(v.origin.date),
		at = new Date();
	const wanted = [
		...v.followUps.map((f) => ({
			kind: "first_vision_follow_up" as const,
			personId: f.personId,
			assigneeId: f.assigneeId,
			title: `Follow up with ${row.people[f.personId]}`,
		})),
		...(v.evaluation
			? [
					{
						kind: "meeting_evaluation" as const,
						personId: null,
						assigneeId: v.evaluation.assigneeId,
						title: `Evaluate ${displayTitle(row.meeting)}`,
					},
				]
			: []),
	];
	const results = [];
	const created: TaskRow[] = [];
	for (const w of wanted) {
		const found = row.existing.find((o) => o.kind === w.kind && o.person_id === w.personId);
		if (found) {
			results.push({
				kind: w.kind,
				personId: w.personId,
				obligationId: found.id,
				taskId: found.task_id,
				outcome: "existing",
			});
			continue;
		}
		const obligationId = randomUUID(),
			taskId = randomUUID();
		const task: TaskRow = {
			id: taskId,
			revision: revision.parse("1"),
			title: w.title,
			description: null,
			category: w.kind === "first_vision_follow_up" ? "follow_up" : "vision_meeting",
			priority: "medium",
			status: "not_started",
			created_at: at,
			completed_at: null,
			deleted_at: null,
			assignee_id: w.assigneeId,
			due_kind: "date_only",
			due_date: due,
			due_time: null,
			timezone: null,
			due_at: null,
			person_id: w.personId,
			meeting_id: w.personId ? null : v.meetingId,
			team_id: null,
			parent_id: null,
			series_id: null,
			occurrence_key: null,
			predecessor_id: null,
			prerequisite_ids: [],
			open_prerequisites: 0,
			obligation_id: obligationId,
			obligation_kind: w.kind,
			assignee_name: w.assigneeId ? row.seats[w.assigneeId]! : null,
			relation_label: w.personId ? row.people[w.personId]! : displayTitle(row.meeting),
			child_total: 0,
			child_complete: 0,
			plant_zone: row.zone,
			open_successor: null,
			checklist: [],
		};
		created.push(task);
		results.push({ kind: w.kind, personId: w.personId, obligationId, taskId, outcome: "created" });
	}
	if (created.length) {
		cmd.writes.push(
			tx.insert(tables.obligation).values(
				created.map((t) => ({
					id: t.obligation_id!,
					plant_id: plant,
					meeting_id: v.meetingId,
					person_id: t.person_id,
					kind: storageKind(t.obligation_kind!),
					origin_at: new Date(v.origin.at),
					origin_date: v.origin.date,
					timezone: v.origin.zone,
					formula_version: "1",
					due_date: due,
				})),
			),
			tx.insert(tables.task).values(
				created.map((t) => ({
					id: t.id,
					plant_id: plant,
					title: t.title,
					category: t.category,
					priority: t.priority,
					status: t.status,
					creator_id: cmd.actor.accountId,
					created_at: at,
					assignee_id: t.assignee_id,
					due_kind: t.due_kind,
					due_date: t.due_date,
					person_id: t.person_id,
					meeting_id: t.meeting_id,
					obligation_id: t.obligation_id,
				})),
			),
		);
		for (const t of created)
			auditRow(cmd, {
				taskId: t.id,
				action: "tasks.changed",
				kind: "create",
				before: null,
				after: audited(t),
				beforeRevision: null,
				afterRevision: "1",
				source: "generated",
			});
	}
	// Every generated task's reminders go to WP-031 in one call: a fixed statement count for any batch size.
	const changes = created.map((t) => reminderChange(plant, null, t)).filter((s) => s !== undefined);
	return {
		value: results,
		after: async () => {
			if (changes.length) await reminders(tx, changes);
		},
	};
}

export const applyManagedStatusInput = z.strictObject({
	obligationIds: z.array(recordId).min(1).max(500),
	status: c.taskStatus,
	reason: z.string().trim().min(1).max(500).nullable().default(null),
});
/**
 * Settle or reopen the live tasks of generated duties inside the caller's reviewed command, for example completing the
 * evaluation task when the evaluation is recorded, or closing the follow-ups of attendees a reconcile removed
 * (tasks.applyManagedStatus, tasks.settleManagedEvaluation). A waived duty stays waived: only an explicit reopen of
 * that task clears it. A deleted task stays deleted. Closing never undoes performed work: a completed task stays
 * complete. One read statement for any number of duties; the changes join the caller's write statement.
 */
export async function applyManagedStatus(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
	raw: z.input<typeof applyManagedStatusInput>,
) {
	const v = parse(applyManagedStatusInput, raw);
	const rows = await loadManagedTasks(tx, cmd.actor.plantId, v.obligationIds);
	const tasks = [],
		changes = [];
	for (const row of rows) {
		if (row.status === "no_longer_needed" || (v.status === "no_longer_needed" && row.status === "complete")) {
			tasks.push({ obligationId: row.obligation_id!, taskId: row.id, outcome: "unchanged" as const });
			continue;
		}
		const r = setStatus(tx, cmd, row, { status: v.status, reason: v.reason, source: "generated" });
		tasks.push({ obligationId: row.obligation_id!, taskId: row.id, outcome: r.outcome });
		changes.push(...r.changes);
	}
	const outcome = tasks.some((t) => t.outcome === "changed")
		? ("changed" as const)
		: tasks.some((t) => t.outcome === "noop")
			? ("noop" as const)
			: ("unchanged" as const);
	return { value: { outcome, tasks }, after: syncAll(reminders, tx, changes) };
}
