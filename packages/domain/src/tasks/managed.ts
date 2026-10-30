import { accountId, instant, localDate, personId, recordId, timeZone } from "@everyfield/contracts/common";
import { meetingType } from "@everyfield/contracts/meetings";
import * as c from "@everyfield/contracts/tasks";
import { sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { displayTitle } from "../meetings/rows.ts";
import { ownerReason } from "./owner.ts";
import { auditRow, deny, parse, type AuditCommand, type Tx } from "./core.ts";
import { managedTaskRows, managedTasks, storageKind, storedKind, type TaskRow } from "./queries.ts";
import { audited, insertTasks, newTask, reminderChange, setStatus, syncAll, type TaskReminders } from "./writes.ts";

// Generated work for finalized meetings (REQ-TSK-017). The caller is the meeting domain's own reviewed command: it
// holds the meeting row locks and passes its audit command, so obligations, tasks and audit rows commit in its one
// write statement, or not at all. After that statement the caller runs `after` for reminders.
const meetingObligations = z.strictObject({
	meetingId: recordId,
	// The captured origin: the actual occurrence instant and the meeting's church-local date and zone.
	origin: z.strictObject({ at: instant, date: localDate, zone: timeZone }),
	followUps: z.array(z.strictObject({ personId, assigneeId: accountId.nullable() })).max(500),
	evaluation: z.strictObject({ assigneeId: accountId.nullable() }).nullable(),
});
/** One meeting's duties, or several: a correction of one meeting can owe a follow-up on a later one (REQ-MTG-020). */
export const ensureMeetingObligationsInput = z
	.strictObject({ meetings: z.array(meetingObligations).min(1).max(501) })
	.refine((v) => new Set(v.meetings.map((m) => m.meetingId)).size === v.meetings.length, "duplicate_meeting");
const existingRow = z.object({
	id: z.uuid(),
	meeting_id: z.uuid(),
	kind: storedKind,
	person_id: z.uuid().nullable(),
	task_id: z.uuid().nullable(),
});
export const obligationFactsRow = z.object({
	meetings: z.record(
		z.string(),
		z.object({ title: z.string().nullable(), type: meetingType, vision_number: z.number().int().nullable() }),
	),
	existing: z.array(existingRow),
	people: z.record(z.string(), z.string()),
	seats: z.array(z.string()),
	// The display name of each named assignee, whether or not the seat is current.
	names: z.record(z.string(), z.string()),
	// Why each named assignee cannot own a follow-up, or null when it can (REQ-TSK-012).
	reasons: z.record(z.string(), z.string().nullable()),
	zone: timeZone,
});
const asArray = (ids: readonly string[]) => sql`${sql.param([...ids])}::uuid[]`;
/**
 * What ensureMeetingObligations reads, as one SQL expression a caller can put in its own locked fact read so the
 * producer adds no statement: the meetings, their existing duties, the live People and the seated assignees named by
 * the uuid[] expressions, and the plant's zone.
 */
export function obligationFacts(plantId: string, meetings: SQL, people: SQL, assignees: SQL): SQL {
	return sql`jsonb_build_object(
		'meetings', (SELECT coalesce(jsonb_object_agg(id, jsonb_build_object('title',title,'type',type,'vision_number',vision_number)),'{}')
			FROM meeting WHERE plant_id=${plantId}::uuid AND id=ANY(${meetings})),
		'existing', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'meeting_id',o.meeting_id,'kind',o.kind,'person_id',o.person_id,
			'task_id',(SELECT t.id FROM task t WHERE t.obligation_id=o.id ORDER BY t.deleted_at NULLS FIRST LIMIT 1))),'[]')
			FROM obligation o WHERE o.plant_id=${plantId}::uuid AND o.meeting_id=ANY(${meetings})),
		'people', (SELECT coalesce(jsonb_object_agg(id,display_name),'{}') FROM person WHERE tenant_id=${plantId}::uuid
			AND plant_id IS NOT NULL AND state='live' AND id=ANY(${people})),
		'seats', (SELECT coalesce(jsonb_agg(s.account_id),'[]') FROM seat s
			WHERE s.plant_id=${plantId}::uuid AND s.ended_at IS NULL
			AND s.accepted_at<=clock_timestamp() AND s.account_id=ANY(${assignees})),
		'names', (SELECT coalesce(jsonb_object_agg(u.a, coalesce(i.display_name,'')),'{}')
			FROM unnest(${assignees}) AS u(a) LEFT JOIN LATERAL seat_identity(u.a) i ON true),
		'reasons', (SELECT coalesce(jsonb_object_agg(u.a, ${ownerReason(sql`u.a`, sql`${plantId}::uuid`)}),'{}')
			FROM unnest(${assignees}) AS u(a)),
		'zone', (SELECT timezone FROM plant WHERE id=${plantId}::uuid))`;
}

/**
 * One obligation per meeting, Person and kind, and one per meeting for its evaluation. An obligation that exists already
 * is never given a new task, so a retry, a deleted task or a waiver never regenerates work. Unowned work is null:
 * Needs owner. Implements tasks.ensureObligation and tasks.ensureMeetingObligations. With `facts` read by the caller
 * (obligationFacts, covering every named meeting, Person and assignee), it adds no statement; without, one read.
 */
export async function ensureMeetingObligations(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
	raw: z.input<typeof ensureMeetingObligationsInput>,
	facts?: unknown,
) {
	const v = parse(ensureMeetingObligationsInput, raw),
		plant = cmd.actor.plantId;
	const assignees = [
		...new Set(v.meetings.flatMap((m) => [...m.followUps.map((f) => f.assigneeId), m.evaluation?.assigneeId ?? null])),
	].filter((a) => a !== null);
	const row = obligationFactsRow.parse(
		facts ??
			(
				await tx.execute(
					sql`SELECT ${obligationFacts(
						plant,
						asArray(v.meetings.map((m) => m.meetingId)),
						asArray(v.meetings.flatMap((m) => m.followUps.map((f) => f.personId))),
						asArray(assignees),
					)} AS facts`,
				)
			).rows[0]?.facts,
	);
	// An assignee must hold a current seat; an invalid choice refuses instead of silently becoming Needs owner.
	if (assignees.some((a) => !row.seats.includes(a))) deny("invalid_subject");
	// A follow-up owner must also be a committed Person's account; an evaluation keeps the seated rule.
	if (v.meetings.some((m) => m.followUps.some((f) => f.assigneeId && row.reasons[f.assigneeId] !== null)))
		deny("owner_ineligible");
	const at = new Date();
	const results = [];
	const created: TaskRow[] = [];
	const origins = new Map<string, z.infer<typeof meetingObligations>["origin"]>(),
		meetingOf = new Map<string, string>();
	for (const m of v.meetings) {
		const meeting = row.meetings[m.meetingId];
		if (!meeting) deny();
		if (new Set(m.followUps.map((f) => f.personId)).size !== m.followUps.length) deny("invalid_input");
		if (m.followUps.some((f) => !(f.personId in row.people))) deny("invalid_subject");
		origins.set(m.meetingId, m.origin);
		const due = c.followUpDueDate(m.origin.date);
		const title = displayTitle(meeting);
		const wanted = [
			...m.followUps.map((f) => ({
				kind: "first_vision_follow_up" as const,
				personId: f.personId,
				assigneeId: f.assigneeId,
				title: `Follow up with ${row.people[f.personId]}`,
			})),
			...(m.evaluation
				? [
						{
							kind: "meeting_evaluation" as const,
							personId: null,
							assigneeId: m.evaluation.assigneeId,
							title: `Evaluate ${title}`,
						},
					]
				: []),
		];
		for (const w of wanted) {
			const found = row.existing.find(
				(o) => o.meeting_id === m.meetingId && o.kind === w.kind && o.person_id === w.personId,
			);
			if (found) {
				results.push({
					meetingId: m.meetingId,
					kind: w.kind,
					personId: w.personId,
					obligationId: found.id,
					taskId: found.task_id,
					outcome: "existing" as const,
				});
				continue;
			}
			const obligationId = randomUUID(),
				taskId = randomUUID();
			created.push(
				newTask(row.zone, {
					id: taskId,
					title: w.title,
					category: w.kind === "first_vision_follow_up" ? "follow_up" : "vision_meeting",
					priority: "medium",
					status: "not_started",
					created_at: at,
					assignee_id: w.assigneeId,
					assignee_name: w.assigneeId ? row.names[w.assigneeId]! : null,
					due_kind: "date_only",
					due_date: due,
					person_id: w.personId,
					meeting_id: w.personId ? null : m.meetingId,
					obligation_id: obligationId,
					obligation_kind: w.kind,
					relation_label: w.personId ? row.people[w.personId]! : title,
				}),
			);
			meetingOf.set(taskId, m.meetingId);
			results.push({
				meetingId: m.meetingId,
				kind: w.kind,
				personId: w.personId,
				obligationId,
				taskId,
				outcome: "created" as const,
			});
		}
	}
	if (created.length) {
		cmd.writes.push(
			tx.insert(tables.obligation).values(
				created.map((t) => {
					const meetingId = meetingOf.get(t.id)!,
						origin = origins.get(meetingId)!;
					return {
						id: t.obligation_id!,
						plant_id: plant,
						meeting_id: meetingId,
						person_id: t.person_id,
						kind: storageKind(t.obligation_kind!),
						origin_at: new Date(origin.at),
						origin_date: origin.date,
						timezone: origin.zone,
						formula_version: "1",
						due_date: t.due_date!,
					};
				}),
			),
			insertTasks(plant, cmd.actor.accountId, created),
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
 * complete. One read statement for any number of duties, or none when the caller read `locked` with managedTasks in its
 * own locked fact read; the changes join the caller's write statement.
 */
export async function applyManagedStatus(
	tx: Tx,
	cmd: AuditCommand,
	reminders: TaskReminders,
	raw: z.input<typeof applyManagedStatusInput>,
	locked?: unknown,
) {
	const v = parse(applyManagedStatusInput, raw);
	const wanted = new Set<string>(v.obligationIds);
	const rows = managedTaskRows
		.parse(
			locked ??
				(await tx.execute(sql`SELECT ${managedTasks(cmd.actor.plantId, asArray(v.obligationIds))} AS tasks`)).rows[0]
					?.tasks,
		)
		.filter((row) => wanted.has(row.obligation_id!));
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
