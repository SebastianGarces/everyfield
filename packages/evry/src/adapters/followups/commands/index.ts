import { sql } from "@everyfield/db/query";
import { createFollowUpWriter } from "@everyfield/domain/followups";
import { createTaskWriter, type TaskReminders } from "@everyfield/domain/tasks";
import { channel, outcome } from "@everyfield/contracts/followups";
import { dueInput, priority, title } from "@everyfield/contracts/tasks";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewContext } from "../../../proposals/types.ts";
import {
	assignee,
	change,
	done,
	json,
	liveTask,
	namedAccounts,
	ownDuty,
	ownersOf,
	reviewed,
	taskTarget,
} from "../../tasks/commands/index.ts";
import { inPlant, ownerOrAdmin } from "../../tasks/reads/index.ts";

// The Follow-up reviewed writes (WP-068): record or correct what happened on a follow-up, create one, assign owners and
// reopen a generated follow-up, each through the native follow-up or task command. A recorded outcome is what the user
// said happened, never a guess: "contacted" needs the user's own word that a conversation happened, and it is recorded
// on the follow-up's contact log, never in the person's profile notes. An owner must be able to own follow-ups
// (REQ-TSK-012); a review naming one who can't refuses before any card, with the reason.

const followUps = (reminders: TaskReminders) => createFollowUpWriter({ reminders });
/** An open person follow-up in the actor's church, as `t`. */
const openFollowUp = sql`t.category='follow_up' AND t.person_id IS NOT NULL AND t.parent_id IS NULL
	AND t.status IN ('not_started','in_progress','blocked')`;
// --- followups.recordOutcome ------------------------------------------------------------------------------------

const occurred = z.union([
	z.literal("now"),
	z.iso.date().describe("The church's local date it happened, like 2026-10-13"),
	z.iso.datetime({ local: true }).describe("The church's local date and time it happened, like 2026-10-13T14:30"),
]);
const recordInput = z
	.strictObject({
		taskId: z.uuid().optional().describe("The open follow-up task this is about, from tasks.listFollowUpOwners"),
		personId: z
			.uuid()
			.optional()
			.describe("Only when the person has no open follow-up: a standalone contact (Owner or Admin)"),
		outcome: outcome.describe(
			"contacted only when the user says a conversation happened; attempted_no_contact for a try with no conversation",
		),
		occurred: occurred.describe('When it happened, as the user said it: "now", a local date, or a local date and time'),
		channel: channel.optional(),
		notes: z.string().trim().max(2_000).optional().describe("What the user said about it, in their words"),
		completeTask: z.boolean().default(true).describe("Complete the follow-up with this outcome"),
	})
	.refine((v) => (v.taskId === undefined) !== (v.personId === undefined), "name a follow-up task or a person")
	.refine((v) => v.taskId !== undefined || (v.outcome !== "no_longer_needed" && !v.completeTask), "no task to close")
	.refine((v) => v.outcome !== "no_longer_needed" || !v.completeTask, "no_longer_needed closes without completing");
type Record = z.infer<typeof recordInput>;

/**
 * The instant the user's words name, in the church's time zone: a time they gave; for a date, noon that day; for today
 * or "now", the review's own time, so a call made "today" is never placed after the moment it is recorded.
 */
const occurredAt = (actor: EvryActor, when: Record["occurred"]) => {
	const zone = sql`(SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid)`;
	if (when === "now") return sql`clock_timestamp()`;
	const local = when.length === 10 ? `${when}T12:00:00` : when;
	return sql`least(clock_timestamp(),(${local}::timestamp AT TIME ZONE ${zone}))`;
};
const iso = (at: ReturnType<typeof sql>) => sql`to_char(${at} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const recordOutcome = reviewed<Record>({
	operation: "followups.recordOutcome",
	description:
		"Propose recording what happened on a person's follow-up: contacted (a conversation happened, as the user said), attempted_no_contact, administrative_completion or no_longer_needed, with when, how and the user's note. It goes in the contact log, never the person's profile notes.",
	input: recordInput,
	allowed: inPlant,
	async review(actor, v, context) {
		const at = occurredAt(actor, v.occurred);
		const local = sql`to_jsonb(to_char(x.at AT TIME ZONE (SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid),'YYYY-MM-DD HH24:MI')||' '||(SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid))`;
		const changes = (closes: boolean) => sql`jsonb_build_array(
			${change("outcome", null, json(v.outcome))},
			${change("occurredAt", null, local)},
			${change("channel", null, json(v.channel ?? null))},
			${change("notes", null, json(v.notes ?? null))}
			${closes ? sql`,${change("followUp", sql`to_jsonb(t.status)`, json(v.outcome === "no_longer_needed" ? "no_longer_needed" : "complete"))}` : sql``})`;
		const native = (target: ReturnType<typeof sql>) =>
			sql`jsonb_build_object('input',jsonb_build_object('target',${target},'outcome',${v.outcome}::text,'occurredAt',${iso(sql`x.at`)},
				'channel',${v.channel ?? null}::text,'notes',${v.notes ?? null}::text,'completeTask',${v.completeTask}::boolean))`;
		if (v.taskId) {
			await ownDuty(context, actor, v.taskId);
			const closes = v.completeTask || v.outcome === "no_longer_needed";
			return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','person','id',p.id,'label',p.display_name),
					'changes',${changes(closes)}) AS review,
				${native(sql`jsonb_build_object('kind','task','taskId',t.id,'expectedRevision',t.revision::text)`)} AS args
				FROM (SELECT t.* ${liveTask(actor, v.taskId)}) t
				JOIN person p ON p.id=t.person_id AND p.state='live' CROSS JOIN LATERAL (SELECT ${at} AS at) x
				WHERE ${openFollowUp}`;
		}
		if (actor.role === "member") throw new EvryRefusal("not_assigned");
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','person','id',p.id,'label',p.display_name),
				'changes',${changes(false)}) AS review,
			${native(sql`jsonb_build_object('kind','person','personId',p.id)`)} AS args
			FROM person p CROSS JOIN LATERAL (SELECT ${at} AS at) x
			WHERE p.id=${v.personId!}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ input: z.unknown() }).parse(args);
		const reply = await followUps(reminders).recordOutcome(tx, context, { requestKey: key("outcome"), input: a.input });
		return reply.status === "ok"
			? { receiptId: reply.value.receiptId, revision: reply.value.record.revision }
			: { refused: reply.error.code };
	},
});

// --- followups.correctOutcome -----------------------------------------------------------------------------------

const correctInput = z.strictObject({
	outcomeId: z.uuid().describe("A contact log entry id from followups.listContactHistory"),
	correction: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("replace"),
			outcome,
			occurred: occurred.optional(),
			channel: channel.optional(),
		}),
		z.strictObject({ kind: z.literal("void") }),
	]),
	reason: z.string().trim().min(1).max(500),
});
const correctOutcome = reviewed<z.infer<typeof correctInput>>({
	operation: "followups.correctOutcome",
	description:
		"Propose correcting one recorded contact log entry (replace its outcome, time or channel) or withdrawing it, with a reason. The old entry stays in the log.",
	input: correctInput,
	allowed: inPlant,
	async review(actor, v, context) {
		const c = v.correction;
		const owner = await context.db.execute(
			sql`SELECT o.task_id FROM contact_outcome o WHERE o.id=${v.outcomeId}::uuid AND o.plant_id=${actor.owner.id}::uuid`,
		);
		const task = owner.rows[0]?.task_id;
		if (actor.role === "member") {
			if (typeof task !== "string") throw new EvryRefusal("not_assigned");
			await ownDuty(context, actor, task);
		}
		const at = c.kind === "replace" && c.occurred ? occurredAt(actor, c.occurred) : null;
		const correction =
			c.kind === "void"
				? json({ kind: "void" })
				: sql`jsonb_strip_nulls(jsonb_build_object('kind','replace','outcome',${c.outcome}::text,
					'occurredAt',${at ? iso(at) : sql`NULL::text`},'channel',${c.channel ?? null}::text))`;
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','person','id',p.id,'label',p.display_name),
				'changes',jsonb_build_array(
					${change("outcome", sql`to_jsonb(o.outcome)`, c.kind === "void" ? json("withdrawn") : json(c.outcome))},
					${change("reason", null, json(v.reason))})) AS review,
			jsonb_build_object('expectedRevision',o.revision::text,'input',jsonb_build_object('outcomeId',o.id,'correction',${correction},'reason',${v.reason}::text)) AS args
			FROM contact_outcome o JOIN person p ON p.id=o.person_id
			WHERE o.id=${v.outcomeId}::uuid AND o.plant_id=${actor.owner.id}::uuid AND o.voided_at IS NULL`;
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ expectedRevision: z.string(), input: z.unknown() }).parse(args);
		const reply = await followUps(reminders).correctOutcome(tx, context, {
			requestKey: key("correct"),
			expectedRevision: a.expectedRevision,
			input: a.input,
		});
		return reply.status === "ok"
			? { receiptId: reply.value.receiptId, revision: reply.value.record.revision }
			: { refused: reply.error.code };
	},
});

// --- tasks.createFollowUp ---------------------------------------------------------------------------------------

const createInput = z.strictObject({
	personId: z.uuid().describe("A person id from an earlier result"),
	title: title.optional().describe('Defaults to "Follow up with <name>"'),
	priority: priority.optional(),
	due: dueInput.optional(),
	assigneeIds: z.array(assignee).max(10).optional().describe('Account ids that may own follow-ups, or "me"'),
});
const createFollowUp = reviewed<z.infer<typeof createInput>>({
	operation: "tasks.createFollowUp",
	description:
		"Propose a new follow-up with one person, with its owners (who must be able to own follow-ups) and an optional due date.",
	input: createInput,
	allowed: ownerOrAdmin,
	async review(actor, v, context) {
		const owners = await namedAccounts(context, actor, v.assigneeIds ?? [], "committed_follow_up");
		const due = v.due ?? { kind: "undated" as const };
		const input = {
			personId: v.personId,
			...(v.title ? { title: v.title } : {}),
			priority: v.priority ?? "medium",
			due,
			assigneeIds: owners.ids,
		};
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','person','id',p.id,'label',p.display_name),
				'changes',jsonb_build_array(
					${change("followUp", null, sql`to_jsonb(coalesce(${v.title ?? null}::text,'Follow up with '||p.display_name))`)},
					${change("owners", null, json(owners.names.join(", ") || null))},
					${change("due", null, json(due.kind === "undated" ? null : due.kind === "local_date" ? due.date : due.local))})) AS review,
			jsonb_build_object('input',${json(input)}) AS args
			FROM person p WHERE p.id=${v.personId}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ input: z.unknown() }).parse(args);
		return done(
			await followUps(reminders).createFollowUp(tx, context, { requestKey: key("followup"), input: a.input }),
		);
	},
});

// --- tasks.assignFollowUp ---------------------------------------------------------------------------------------
//
// One review may assign several follow-ups ("split the new guests between Carlos and Ana"): each is its own native
// assignment, in one transaction, so all of them change or none.

const assignInput = z.strictObject({
	items: z
		.array(
			z.strictObject({
				taskId: z.uuid().describe("An open follow-up task id from tasks.listFollowUpOwners"),
				assigneeIds: z.array(assignee).max(10).describe('The whole new set of owners, or "me"; [] for nobody'),
			}),
		)
		.min(1)
		.max(50)
		.refine((items) => new Set(items.map((i) => i.taskId)).size === items.length, "repeated follow-up"),
});
const assignArgs = z.object({
	items: z.array(z.object({ taskId: z.uuid(), expectedRevision: z.string(), assigneeIds: z.array(z.uuid()) })),
});
const assignFollowUp = reviewed<z.infer<typeof assignInput>>({
	operation: "tasks.assignFollowUp",
	description:
		"Propose who owns one or more open follow-ups, listed one by one on a single review. Every owner must be able to own follow-ups (tasks.eligibleAssignees canOwnFollowUps).",
	input: assignInput,
	allowed: ownerOrAdmin,
	async review(actor, v, context: ReviewContext) {
		const items = [];
		for (const item of v.items) {
			const owners = await namedAccounts(context, actor, item.assigneeIds, "committed_follow_up");
			items.push({ taskId: item.taskId, assigneeIds: owners.ids, names: owners.names.join(", ") || null });
		}
		return sql`WITH n AS (SELECT * FROM jsonb_to_recordset(${json(items.map((i, n) => ({ ...i, n })))}) n("taskId" uuid,"assigneeIds" jsonb,names text,n int))
			SELECT jsonb_build_object('target',CASE WHEN count(*)=1 THEN (array_agg(jsonb_build_object('kind','task','id',t.id,'label',t.title)))[1] ELSE 'null'::jsonb END,
				'changes',jsonb_agg(jsonb_build_object('field',p.display_name,'before',coalesce(${ownersOf("t")},'"Needs owner"'::jsonb),'after',to_jsonb(coalesce(n.names,'Needs owner'))) ORDER BY n.n)) AS review,
			jsonb_build_object('items',jsonb_agg(jsonb_build_object('taskId',t.id,'expectedRevision',t.revision::text,'assigneeIds',n."assigneeIds") ORDER BY n.n)) AS args
			FROM n JOIN task t ON t.id=n."taskId" AND t.plant_id=${actor.owner.id}::uuid AND t.deleted_at IS NULL AND ${openFollowUp}
			JOIN person p ON p.id=t.person_id
			HAVING count(*)=${items.length}`;
	},
	async run(tx, context, args, key, reminders) {
		const a = assignArgs.parse(args);
		let last: EffectResult = { receiptId: "", revision: "" };
		for (const [n, item] of a.items.entries()) {
			last = done(
				await followUps(reminders).assignFollowUp(tx, context, {
					requestKey: key(`assign${n}`),
					expectedRevision: item.expectedRevision,
					input: { taskId: item.taskId, assigneeIds: item.assigneeIds },
				}),
			);
			if ("refused" in last) return last;
		}
		return last;
	},
});

// --- tasks.reopenObligation -------------------------------------------------------------------------------------
//
// A meeting's generated follow-up closed as no longer needed (or completed) is reopened through its current task, the
// same native reopen the Tasks page uses: the obligation keeps its identity and its waiver is cleared.

const reopenInput = z.strictObject({
	obligationId: z.uuid().describe("An obligationId from followups.readObligations"),
});
const reopenObligation = reviewed<z.infer<typeof reopenInput>>({
	operation: "tasks.reopenObligation",
	description:
		"Propose reopening a meeting's generated follow-up or evaluation that was closed or completed. Its history stays.",
	input: reopenInput,
	allowed: inPlant,
	async review(actor, v, context) {
		const found = await context.db.execute(
			sql`SELECT t.id FROM task t WHERE t.obligation_id=${v.obligationId}::uuid AND t.plant_id=${actor.owner.id}::uuid AND t.deleted_at IS NULL
				ORDER BY t.created_at DESC LIMIT 1`,
		);
		const taskId = found.rows[0]?.id;
		if (typeof taskId !== "string") return null;
		await ownDuty(context, actor, taskId);
		return sql`SELECT jsonb_build_object('target',${taskTarget},'changes',jsonb_build_array(${change("status", sql`to_jsonb(t.status)`, json("not_started"))})) AS review,
			jsonb_build_object('expectedRevision',t.revision::text,'input',jsonb_build_object('taskId',t.id)) AS args
			${liveTask(actor, taskId)} AND t.status IN ('complete','no_longer_needed')`;
	},
	async run(tx, context, args, key, reminders) {
		const a = z.object({ expectedRevision: z.string(), input: z.unknown() }).parse(args);
		return done(
			await createTaskWriter({ reminders }).reopen(tx, context, {
				requestKey: key("reopen"),
				expectedRevision: a.expectedRevision,
				input: a.input,
			}),
		);
	},
});

/** The installed Follow-up reviewed writes, keyed by operation. */
export const FOLLOWUP_COMMANDS = {
	"tasks.createFollowUp": createFollowUp,
	"tasks.assignFollowUp": assignFollowUp,
	"tasks.reopenObligation": reopenObligation,
	"followups.recordOutcome": recordOutcome,
	"followups.correctOutcome": correctOutcome,
} as const;
