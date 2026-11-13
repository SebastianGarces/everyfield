import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { createTaskWriter, taskReader, type TaskReminders } from "@everyfield/domain/tasks";
import type { PeopleContext } from "@everyfield/contracts/people";
import { category, priority, recurrenceFrequency, taskStatus, title } from "@everyfield/contracts/tasks";
import { z } from "zod";
import { id, localDue, dueOf as nativeDue } from "../values.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import { inPlant, ownerOrAdmin, value } from "../reads/index.ts";

// The Tasks reviewed writes (WP-068). Each review is one SELECT under the proposal's statement: it reads the task live
// in the actor's church and saves the native command's exact arguments, including the revision the review showed. On
// approval the executor runs the native Tasks command once, with the effect key as its request key, so the change and
// its audit row commit together and a task changed since the review refuses instead of being overwritten. Every native
// command checks its own role floor again when it runs. A review refuses before any card when the actor could never
// approve it: a Member asking to change a task assigned to someone else, or an owner who can't hold the task.

/** The task in the actor's church, as `t`: live and top level unless the write names a checklist row. */
export const liveTask = (actor: EvryActor, taskId: string) =>
	sql`FROM task t WHERE t.id=${taskId}::uuid AND t.plant_id=${actor.owner.id}::uuid AND t.deleted_at IS NULL`;
export const taskTarget = sql`jsonb_build_object('kind','task','id',t.id,'label',t.title)`;
export const change = (field: string, before: SQL | null, after: SQL | null) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before ?? sql`NULL::jsonb`},'after',${after ?? sql`NULL::jsonb`})`;
export const json = (v: unknown) => sql`${JSON.stringify(v ?? null)}::jsonb`;
/** `t`'s owners by their account name, in the Tasks page's order, or null when it needs an owner. */
export const ownersOf = (t: string) =>
	sql.raw(`(SELECT to_jsonb(string_agg(i.display_name,', ' ORDER BY lower(i.display_name),a.account_id))
		FROM task_assignee a CROSS JOIN LATERAL seat_identity(a.account_id) i WHERE a.task_id=${t}.id)`);
/** A stored due date as the church reads it. */
export const dueOf = (t: string) =>
	sql.raw(`to_jsonb(CASE ${t}.due_kind WHEN 'date_only' THEN ${t}.due_date::text
		WHEN 'timed' THEN to_char(${t}.due_date,'YYYY-MM-DD')||' '||to_char(${t}.due_time,'HH24:MI')||' '||${t}.timezone END)`);

/** "me" names the signed-in user's own account; any other value is an account id from tasks.eligibleAssignees. */
export const assignee = z.union([id, z.literal("me")]);
const me = (actor: EvryActor, ids: readonly string[]) => [
	...new Set(ids.map((id) => (id === "me" ? actor.accountId : id))),
];

/**
 * The accounts named, each with its name, if every one may hold this kind of task now; otherwise the review refuses
 * before any card: an account without a current seat, or (for a follow-up) one that can't own follow-ups (REQ-TSK-012).
 */
export async function namedAccounts(
	context: ReviewContext,
	actor: EvryActor,
	raw: readonly string[],
	purpose: "any" | "committed_follow_up",
) {
	const ids = me(actor, raw);
	if (!ids.length) return { ids, names: [] as string[] };
	const seats = await context.db.transaction(async (tx) =>
		value(await taskReader.eligibleAssignees(tx, actor.authority, { purpose })),
	);
	const names = ids.map((id) => seats.items.find((s) => s.accountId === id)?.displayName ?? null);
	if (names.includes(null)) throw new EvryRefusal(purpose === "any" ? "assignee_ineligible" : "owner_ineligible");
	return { ids, names: names as string[] };
}

/**
 * A Member may change only a task assigned to them (or a checklist row of one): anything else refuses before any card,
 * with the reason. An Owner or Admin may change any task; the native command decides the rest when it runs.
 */
export async function ownDuty(context: ReviewContext, actor: EvryActor, taskId: string) {
	if (actor.role !== "member") return;
	const r = await context.db
		.execute(sql`SELECT EXISTS(SELECT FROM task t WHERE t.id=${taskId}::uuid AND t.plant_id=${actor.owner.id}::uuid
		AND EXISTS(SELECT FROM task_assignee a WHERE a.account_id=${actor.accountId}::uuid AND (a.task_id=t.id OR a.task_id=t.parent_id))) AS mine`);
	if (r.rows[0]?.mine !== true) throw new EvryRefusal("not_assigned");
}

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
export const done = (reply: Reply<{ receiptId: string; task: { revision: string } }>): EffectResult =>
	reply.status === "ok"
		? { receiptId: reply.value.receiptId, revision: reply.value.task.revision }
		: { refused: reply.error.code };

/**
 * One reviewed write whose native commands run in order, each with its own request key derived from the effect key, in
 * the executor's one transaction. The first refusal stops the rest and rolls everything back.
 */
export function reviewed<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	review(actor: EvryActor, input: I, context: ReviewContext): Promise<SQL | null>;
	run(
		tx: Transaction,
		context: PeopleContext,
		args: unknown,
		key: (step: string) => string,
		reminders: TaskReminders,
	): Promise<EffectResult>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed,
		review: spec.review,
		execute: (tx, context, args, effectKey, reminders) =>
			spec.run(tx, context, args, (step) => `${effectKey}:${step}`, reminders),
	};
}
const writer = (reminders: TaskReminders) => createTaskWriter({ reminders });
/** The saved native input and the revision the review showed. */
const saved = z.object({ expectedRevision: z.string(), input: z.record(z.string(), z.unknown()) });

const taskId = id.describe("A task id from an earlier result");

// --- Status changes on one task: complete, completeOccurrence, reopen, changeStatus, waive, delete ----------------

type StatusCommand = "complete" | "completeOccurrence" | "reopen" | "changeStatus" | "waive" | "delete";
function statusWrite<I extends { taskId: string }>(spec: {
	operation: `tasks.${StatusCommand}`;
	command: StatusCommand;
	description: string;
	input: z.ZodType<I>;
	/** The Member floor: their own task only. Otherwise Owner or Admin. */
	member: boolean;
	changes(input: I): SQL;
	/** The native input beyond the task id. */
	extra?(input: I): Record<string, unknown>;
	/** A condition on `t` the native command needs, so a review is never prepared for a change it would refuse. */
	when?: SQL;
}) {
	return reviewed<I>({
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.member ? inPlant : ownerOrAdmin,
		async review(actor, input, context) {
			if (spec.member) await ownDuty(context, actor, input.taskId);
			return sql`SELECT jsonb_build_object('target',${taskTarget},'changes',${spec.changes(input)}) AS review,
				jsonb_build_object('expectedRevision',t.revision::text,'input',jsonb_build_object('taskId',t.id)||${json(spec.extra?.(input) ?? {})}) AS args
				${liveTask(actor, input.taskId)} ${spec.when ? sql`AND ${spec.when}` : sql``}`;
		},
		async run(tx, context, args, key, reminders) {
			const a = saved.parse(args);
			const request = { requestKey: key("task"), expectedRevision: a.expectedRevision, input: a.input };
			return done(await writer(reminders)[spec.command](tx, context, request));
		},
	});
}
const status = (after: string) => change("status", sql`to_jsonb(t.status)`, json(after));
const open = sql`t.status IN ('not_started','in_progress','blocked')`;

const completeTask = statusWrite({
	operation: "tasks.complete",
	command: "complete",
	description: "Propose marking one task complete. A Member may complete only a task assigned to them.",
	input: z.strictObject({ taskId }),
	member: true,
	changes: () => sql`jsonb_build_array(${status("complete")})`,
	when: open,
});
const completeOccurrence = statusWrite({
	operation: "tasks.completeOccurrence",
	command: "completeOccurrence",
	description:
		"Propose completing the open occurrence of a recurring task (from tasks.findOpenOccurrence); the series' next occurrence is created.",
	input: z.strictObject({ taskId }),
	member: true,
	changes: () =>
		sql`jsonb_build_array(${status("complete")},${change("nextOccurrence", null, json("created by the series"))})`,
	when: sql`${open} AND t.series_id IS NOT NULL`,
});
const reopenTask = statusWrite({
	operation: "tasks.reopen",
	command: "reopen",
	description: "Propose reopening one completed or closed task. Its history keeps the earlier completion.",
	input: z.strictObject({ taskId }),
	member: true,
	changes: () => sql`jsonb_build_array(${status("not_started")})`,
	when: sql`t.status IN ('complete','no_longer_needed')`,
});
const changeStatus = statusWrite({
	operation: "tasks.changeStatus",
	command: "changeStatus",
	description: "Propose setting one task's status: not_started, in_progress, blocked, complete or no_longer_needed.",
	input: z.strictObject({ taskId, status: taskStatus }),
	member: true,
	changes: (v) => sql`jsonb_build_array(${status(v.status)})`,
	extra: (v) => ({ status: v.status }),
});
const waiveTask = statusWrite({
	operation: "tasks.waive",
	command: "waive",
	description: "Propose closing one task as no longer needed, with an optional reason. It gets no completion credit.",
	input: z.strictObject({ taskId, reason: z.string().trim().min(1).max(500).optional() }),
	member: true,
	changes: (v) =>
		sql`jsonb_build_array(${status("no_longer_needed")},${change("reason", null, json(v.reason ?? null))})`,
	extra: (v) => ({ reason: v.reason ?? null }),
	when: open,
});
const deleteTask = statusWrite({
	operation: "tasks.delete",
	command: "delete",
	description:
		"Propose deleting one task and its checklist rows. A meeting's generated follow-up and every history entry stay.",
	input: z.strictObject({ taskId }),
	member: false,
	changes: () => sql`jsonb_build_array(${status("deleted")})`,
});

// --- tasks.create (with an optional recurrence) and tasks.configureRecurrence --------------------------------------

const WEEKDAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const recurrence = z.strictObject({
	frequency: recurrenceFrequency,
	until: z.iso.date().nullable().default(null).describe("The last local date it repeats on; null for no end"),
});
type Recurrence = z.infer<typeof recurrence>;
const dueDay = (due: string | undefined) => due?.slice(0, 10) ?? null;
/** "weekly on Mondays, America/Chicago": the rule as the church reads it, counted from the first due date. */
function ruleText(rule: Recurrence, first: string | null, zone: SQL) {
	const day = first ? WEEKDAY[new Date(`${first}T00:00:00Z`).getUTCDay()]! : null;
	const on = day && /weekly/.test(rule.frequency) ? ` on ${day}` : "";
	const until = rule.until ? `, until ${rule.until}` : "";
	return sql`to_jsonb(${`${rule.frequency}${on}${until}`}::text||', '||${zone})`;
}
const churchZone = (actor: EvryActor) => sql`(SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid)`;
/** A due value as the review shows it: the church-local date (and time) with the church's zone. */
const dueText = (due: string | undefined, zone: SQL) =>
	due ? sql`to_jsonb(${due.replace("T", " ")}::text||' '||${zone})` : sql`NULL::jsonb`;

const createInput = z
	.strictObject({
		title,
		description: z.string().trim().max(5_000).optional(),
		priority: priority.optional(),
		category: category.exclude(["follow_up"]).optional(),
		due: localDue.optional().describe("Church-local due date or date and time; undated when omitted"),
		assigneeIds: z.array(assignee).max(10).optional().describe('Account ids from tasks.eligibleAssignees, or "me"'),
		recurrence: recurrence.optional().describe("Repeat it: weekly repeats on the due date's weekday"),
	})
	.refine((v) => !v.recurrence || v.due, "a recurring task needs a due date");
const createTask = reviewed<z.infer<typeof createInput>>({
	operation: "tasks.create",
	description:
		"Propose one new task with its title, due date, owners and an optional recurrence (one review for the task and its schedule). Use tasks.createFollowUp for a person follow-up.",
	input: createInput,
	allowed: ownerOrAdmin,
	async review(actor, v, context) {
		const owners = await namedAccounts(context, actor, v.assigneeIds ?? [], "any");
		const due = nativeDue(v.due);
		const zone = churchZone(actor);
		const input = {
			title: v.title,
			description: v.description ?? null,
			priority: v.priority ?? "medium",
			category: v.recurrence ? (v.category ?? "recurring") : (v.category ?? "general"),
			due,
			assigneeIds: owners.ids,
			relation: null,
		};
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("title", null, json(v.title))},
				${change("due", null, dueText(v.due, zone))},
				${change("owners", null, json(owners.names.join(", ") || null))}
				${v.recurrence ? sql`,${change("recurrence", null, ruleText(v.recurrence, dueDay(v.due), zone))}` : sql``}
				${v.description ? sql`,${change("description", null, json(v.description))}` : sql``})) AS review,
			jsonb_build_object('input',${json(input)},'recurrence',${json(v.recurrence ?? null)}) AS args`;
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ input: z.unknown(), recurrence: recurrence.nullable() }).parse(args);
		const tasks = writer(reminders);
		const created = await tasks.create(tx, context, { requestKey: key("create"), input: a.input });
		if (created.status !== "ok" || !a.recurrence) return done(created);
		const rule = { ...a.recurrence, localTime: null };
		return done(
			await tasks.configureRecurrence(tx, context, {
				requestKey: key("recurrence"),
				expectedRevision: created.value.task.revision,
				input: { taskId: created.value.task.id, rule },
			}),
		);
	},
});

const recurrenceInput = z.strictObject({
	taskId,
	rule: recurrence.nullable().describe("null stops the series; its tasks and history stay"),
});
const ruleOf = sql`(SELECT to_jsonb(r.interval||coalesce(', until '||r.end_date,'')||', '||r.timezone) FROM recurrence r
	WHERE r.id=t.series_id AND r.stopped_at IS NULL)`;
const configureRecurrence = reviewed<z.infer<typeof recurrenceInput>>({
	operation: "tasks.configureRecurrence",
	description:
		"Propose making one existing task repeat, changing its rule, or stopping it (rule null). Weekly repeats on its due date's weekday.",
	input: recurrenceInput,
	allowed: ownerOrAdmin,
	async review(actor, v) {
		// Weekly and biweekly repeat on the task's due weekday, as the native series counts from its due date.
		const after = v.rule
			? sql`to_jsonb(${v.rule.frequency}::text${/weekly/.test(v.rule.frequency) ? sql`||' on '||trim(to_char(t.due_date,'FMDay'))||'s'` : sql``}
				||${v.rule.until ? `, until ${v.rule.until}` : ""}::text||', '||${churchZone(actor)})`
			: json("stopped");
		return sql`SELECT jsonb_build_object('target',${taskTarget},'changes',jsonb_build_array(${change("recurrence", ruleOf, after)})) AS review,
			jsonb_build_object('expectedRevision',t.revision::text,'input',jsonb_build_object('taskId',t.id,'rule',${json(v.rule ? { ...v.rule, localTime: null } : null)})) AS args
			${liveTask(actor, v.taskId)} AND t.parent_id IS NULL AND t.obligation_id IS NULL
				${v.rule ? sql`AND t.due_kind<>'undated'` : sql`AND t.series_id IS NOT NULL`}`;
	},
	async run(tx, context, args, key, reminders) {
		const a = saved.parse(args);
		return done(
			await writer(reminders).configureRecurrence(tx, context, {
				requestKey: key("recurrence"),
				expectedRevision: a.expectedRevision,
				input: a.input,
			}),
		);
	},
});

// --- tasks.edit -------------------------------------------------------------------------------------------------

const editInput = z.strictObject({
	taskId,
	patch: z
		.strictObject({
			title: title.optional(),
			description: z.string().trim().max(5_000).nullable().optional(),
			priority: priority.optional(),
			category: category.optional(),
			due: localDue.optional(),
			assigneeIds: z.array(assignee).max(10).optional().describe("The whole new set of owners; [] for nobody"),
		})
		.refine((p) => Object.keys(p).length > 0, "empty patch"),
});
const editTask = reviewed<z.infer<typeof editInput>>({
	operation: "tasks.edit",
	description: "Propose changing one task's title, description, priority, category, due date, owners or link.",
	input: editInput,
	allowed: ownerOrAdmin,
	async review(actor, v, context) {
		const owners = v.patch.assigneeIds ? await namedAccounts(context, actor, v.patch.assigneeIds, "any") : null;
		const patch = {
			...v.patch,
			...(v.patch.due ? { due: nativeDue(v.patch.due) } : {}),
			...(owners ? { assigneeIds: owners.ids } : {}),
		};
		const zone = churchZone(actor);
		const rows = [
			v.patch.title !== undefined ? change("title", sql`to_jsonb(t.title)`, json(v.patch.title)) : null,
			v.patch.description !== undefined
				? change("description", sql`to_jsonb(t.description)`, json(v.patch.description))
				: null,
			v.patch.priority ? change("priority", sql`to_jsonb(t.priority)`, json(v.patch.priority)) : null,
			v.patch.category ? change("category", sql`to_jsonb(t.category)`, json(v.patch.category)) : null,
			v.patch.due ? change("due", dueOf("t"), dueText(v.patch.due, zone)) : null,
			owners ? change("owners", ownersOf("t"), json(owners.names.join(", ") || null)) : null,
		].filter((r) => r !== null);
		return sql`SELECT jsonb_build_object('target',${taskTarget},'changes',jsonb_build_array(${sql.join(rows, sql`,`)})) AS review,
			jsonb_build_object('expectedRevision',t.revision::text,'input',jsonb_build_object('taskId',t.id,'patch',${json(patch)})) AS args
			${liveTask(actor, v.taskId)}`;
	},
	async run(tx, context, args, key, reminders) {
		const a = saved.parse(args);
		return done(
			await writer(reminders).edit(tx, context, {
				requestKey: key("edit"),
				expectedRevision: a.expectedRevision,
				input: a.input,
			}),
		);
	},
});

// --- tasks.bulkComplete and tasks.bulkReschedule -----------------------------------------------------------------

const many = z
	.array(taskId)
	.min(1)
	.max(100)
	.refine((ids) => new Set(ids).size === ids.length, "repeated task");
/** The named live top-level tasks, as `t`, in title order: each one row of the review, at the revision it showed. */
const bulkReview = (actor: EvryActor, ids: readonly string[], row: SQL, extra: SQL) =>
	sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_agg(${row} ORDER BY lower(t.title),t.id)) AS review,
		jsonb_build_object('items',jsonb_agg(jsonb_build_object('taskId',t.id,'expectedRevision',t.revision::text) ORDER BY t.id))||${extra} AS args
		FROM task t WHERE t.id=ANY(${sql.param([...ids])}::uuid[]) AND t.plant_id=${actor.owner.id}::uuid AND t.deleted_at IS NULL
			AND t.parent_id IS NULL
		HAVING count(*)=${ids.length}`;
const bulkDone = (reply: Reply<{ receiptId: string; changed: number }>): EffectResult =>
	reply.status === "ok"
		? { receiptId: reply.value.receiptId, revision: String(reply.value.changed) }
		: { refused: reply.error.code };

const bulkCompleteInput = z.strictObject({ taskIds: many });
const bulkComplete = reviewed<z.infer<typeof bulkCompleteInput>>({
	operation: "tasks.bulkComplete",
	description:
		"Propose completing several tasks at once (up to 100), listed one by one on the review. A Member may complete only their own.",
	input: bulkCompleteInput,
	allowed: inPlant,
	async review(actor, v, context) {
		for (const id of v.taskIds) await ownDuty(context, actor, id);
		return bulkReview(
			actor,
			v.taskIds,
			sql`jsonb_build_object('field',t.title,'before',to_jsonb(t.status),'after',to_jsonb('complete'::text))`,
			sql`'{}'::jsonb`,
		);
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ items: z.array(z.unknown()) }).parse(args);
		return bulkDone(await writer(reminders).bulkComplete(tx, context, { requestKey: key("bulk"), items: a.items }));
	},
});
const rescheduleInput = z.strictObject({ taskIds: many, due: localDue });
const bulkReschedule = reviewed<z.infer<typeof rescheduleInput>>({
	operation: "tasks.bulkReschedule",
	description: "Propose moving several tasks (up to 100) to one new due date, listed one by one on the review.",
	input: rescheduleInput,
	allowed: ownerOrAdmin,
	async review(actor, v) {
		return bulkReview(
			actor,
			v.taskIds,
			sql`jsonb_build_object('field',t.title,'before',${dueOf("t")},'after',${dueText(v.due, churchZone(actor))})`,
			sql`jsonb_build_object('due',${json(nativeDue(v.due))})`,
		);
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ items: z.array(z.unknown()), due: z.unknown() }).parse(args);
		return bulkDone(
			await writer(reminders).bulkReschedule(tx, context, { requestKey: key("bulk"), items: a.items, due: a.due }),
		);
	},
});

// --- Checklist rows: tasks.createSubtask, tasks.setSubtaskCompletion and tasks.removeSubtask ------------------------
//
// One review may add, tick and remove rows of one parent's checklist: each step runs its own native command (a real
// child task with its own status and history, EVRY-REAL-CHILD-TASK-PARITY), ticks first, then removals, then additions.
// The operation names the step the request is mainly about; each of the three needs its own step.

const checklistInput = z.strictObject({
	parentId: id.describe("The parent task id"),
	add: z.array(title).max(20).default([]).describe("Titles of new checklist rows"),
	tick: z
		.array(z.strictObject({ taskId: id.describe("A checklist row id from tasks.get"), complete: z.boolean() }))
		.max(20)
		.default([]),
	remove: z.array(id).max(20).default([]).describe("Checklist row ids to remove"),
});
type Checklist = z.infer<typeof checklistInput>;
const checklistArgs = z.object({
	parentId: id,
	parentRevision: z.string(),
	add: z.array(z.string()),
	rows: z.array(z.object({ taskId: id, revision: z.string(), complete: z.boolean().nullable() })),
});
function checklistWrite({
	operation,
	main,
	description,
}: {
	operation: string;
	main: "add" | "tick" | "remove";
	description: string;
}) {
	return reviewed<Checklist>({
		operation,
		description,
		input: checklistInput.refine((v) => v[main].length > 0, `${main} needs a row`),
		allowed: main === "remove" ? ownerOrAdmin : inPlant,
		async review(actor, v, context) {
			await ownDuty(context, actor, v.parentId);
			const steps = [
				...v.tick.map((k) => ({ id: k.taskId, complete: k.complete })),
				...v.remove.map((id) => ({ id, complete: null })),
			];
			// Every named row must be a live checklist row of this parent, or there is no review.
			return sql`WITH k AS (SELECT c.id,c.title,c.status,c.revision,s.complete,s.n FROM jsonb_to_recordset(${json(steps.map((s, n) => ({ ...s, n })))})
					s(id uuid,complete boolean,n int) JOIN task c ON c.id=s.id AND c.parent_id=${v.parentId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.deleted_at IS NULL)
				SELECT jsonb_build_object('target',${taskTarget},'changes',
					coalesce((SELECT jsonb_agg(jsonb_build_object('field',k.title,'before',to_jsonb(k.status),
						'after',to_jsonb(CASE WHEN k.complete IS NULL THEN 'removed' WHEN k.complete THEN 'complete' ELSE 'not_started' END)) ORDER BY k.n) FROM k),'[]'::jsonb)
					||(SELECT coalesce(jsonb_agg(jsonb_build_object('field',a,'before',NULL,'after','added')),'[]'::jsonb) FROM jsonb_array_elements_text(${json(v.add)}) a)) AS review,
				jsonb_build_object('parentId',t.id,'parentRevision',t.revision::text,'add',${json(v.add)},
					'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('taskId',k.id,'revision',k.revision::text,'complete',k.complete) ORDER BY k.n) FROM k),'[]'::jsonb)) AS args
				${liveTask(actor, v.parentId)} AND t.parent_id IS NULL AND (SELECT count(*) FROM k)=${steps.length}`;
		},
		async run(tx, context, args, key, reminders) {
			const a = checklistArgs.parse(args);
			const tasks = writer(reminders);
			let last: EffectResult = { receiptId: a.parentId, revision: a.parentRevision };
			for (const [n, row] of a.rows.entries()) {
				const base = { requestKey: key(`row${n}`), expectedRevision: row.revision };
				const input = { parentId: a.parentId, taskId: row.taskId };
				const reply =
					row.complete === null
						? await tasks.removeSubtask(tx, context, { ...base, input })
						: await tasks.setSubtaskCompletion(tx, context, { ...base, input: { ...input, complete: row.complete } });
				last = done(reply);
				if ("refused" in last) return last;
			}
			// Each addition is checked against the parent's current revision, which an earlier step may have moved.
			for (const [n, title] of a.add.entries()) {
				const parent = await tx.execute(
					sql`SELECT revision::text AS revision FROM task WHERE id=${a.parentId}::uuid AND deleted_at IS NULL`,
				);
				const revision = parent.rows[0]?.revision;
				if (typeof revision !== "string") return { refused: "conflict" };
				last = done(
					await tasks.createSubtask(tx, context, {
						requestKey: key(`add${n}`),
						expectedRevision: revision,
						input: { parentId: a.parentId, title },
					}),
				);
				if ("refused" in last) return last;
			}
			return last;
		},
	});
}
export const createSubtask = checklistWrite({
	operation: "tasks.createSubtask",
	main: "add",
	description:
		"Propose adding checklist rows to one task (each a real subtask), optionally ticking or removing other rows of the same checklist in the same review.",
});
export const setSubtaskCompletion = checklistWrite({
	operation: "tasks.setSubtaskCompletion",
	main: "tick",
	description:
		"Propose ticking or unticking checklist rows of one task, optionally adding or removing rows of the same checklist in the same review.",
});
export const removeSubtask = checklistWrite({
	operation: "tasks.removeSubtask",
	main: "remove",
	description:
		"Propose removing checklist rows from one task, optionally adding or ticking rows of the same checklist in the same review.",
});

/** The installed Tasks reviewed writes, keyed by operation. */
export const TASK_COMMANDS = {
	"tasks.create": createTask,
	"tasks.configureRecurrence": configureRecurrence,
	"tasks.edit": editTask,
	"tasks.complete": completeTask,
	"tasks.completeOccurrence": completeOccurrence,
	"tasks.reopen": reopenTask,
	"tasks.changeStatus": changeStatus,
	"tasks.waive": waiveTask,
	"tasks.delete": deleteTask,
	"tasks.bulkComplete": bulkComplete,
	"tasks.bulkReschedule": bulkReschedule,
	"tasks.createSubtask": createSubtask,
	"tasks.setSubtaskCompletion": setSubtaskCompletion,
	"tasks.removeSubtask": removeSubtask,
} as const;
