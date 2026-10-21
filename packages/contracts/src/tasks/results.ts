import { z } from "zod";
import { instant, localDateTime } from "../common/time.ts";
import { accountId, defineSafeError, operationId, recordId, revision, role, safeError } from "../common/values.ts";
import { category, due, obligationKind, priority, taskStatus } from "./values.ts";

const count = z.int().min(0);
const assignee = z.strictObject({ accountId, displayName: z.string() });
export const taskItem = z.strictObject({
	id: recordId,
	revision,
	title: z.string(),
	status: taskStatus,
	priority,
	category,
	due,
	overdue: z.boolean().nullable(),
	// Null is Needs owner.
	assignee: assignee.nullable(),
	relation: z.strictObject({ kind: z.enum(["person", "meeting", "team"]), id: recordId, label: z.string() }).nullable(),
	parentId: recordId.nullable(),
	checklist: z.strictObject({ total: count, complete: count }),
	managed: z.strictObject({ obligationId: recordId, kind: obligationKind }).nullable(),
	createdAt: instant,
	completedAt: instant.nullable(),
	deleted: z.boolean(),
});
export const taskPage = z.strictObject({
	items: z.array(taskItem).max(100),
	total: count,
	page: z.int().min(1),
	next: z.int().min(2).nullable(),
	completeness: z.literal("complete"),
});
export const taskDetail = taskItem.extend({
	description: z.string().nullable(),
	checklistItems: z
		.array(
			z.strictObject({ id: recordId, revision, title: z.string(), status: taskStatus, assignee: assignee.nullable() }),
		)
		.max(500),
	// Prerequisites arrive with WP-025; the list is empty until then.
	prerequisiteIds: z.array(recordId).max(0),
	obligationId: recordId.nullable(),
	occurrenceId: z.string().nullable(),
});
export const taskResult = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("unavailable") }),
	z.strictObject({ status: z.literal("available"), task: taskDetail }),
]);
const tally = <T extends z.ZodEnum>(values: T) => z.array(z.strictObject({ value: values, count })).max(20);
// Counts use the same authorized scope as the list. Top-level tasks and checklist rows are separate units.
export const taskCounts = z.strictObject({
	topLevelTotal: count,
	byStatus: tally(taskStatus),
	byPriority: tally(priority),
	byCategory: tally(category),
	childTaskTotal: count,
	childTaskComplete: count,
	completeness: z.literal("complete"),
});
export const historyActor = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), accountId, displayName: z.string().nullable() }),
	z.strictObject({ kind: z.literal("former_account") }),
	z.strictObject({ kind: z.literal("system"), cause: z.string() }),
]);
export const historySource = z.enum(["person", "evry", "bulk", "generated", "recurrence", "correction"]);
export const statusHistory = z.strictObject({
	taskId: recordId,
	items: z
		.array(
			z.strictObject({
				id: recordId,
				occurredAt: instant,
				from: taskStatus.nullable(),
				to: taskStatus,
				actor: historyActor,
				source: historySource,
			}),
		)
		.max(100),
	next: z.int().min(2).nullable(),
	completeness: z.literal("complete"),
});
export const assigneeOptions = z.strictObject({
	items: z.array(z.strictObject({ accountId, displayName: z.string(), role })).max(500),
});
export const relationOptions = z.strictObject({
	items: z.array(z.strictObject({ id: recordId, label: z.string() })).max(20),
});
export const taskMutation = z.strictObject({
	task: taskDetail,
	receiptId: operationId,
	outcome: z.enum(["changed", "noop"]),
});
export const taskError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError("protected_source", {}, "never"),
	defineSafeError("nonexistent_local_time", { local: localDateTime }, "never"),
	defineSafeError(
		"ambiguous_local_time",
		{ local: localDateTime, choices: z.array(z.strictObject({ instant, offsetSeconds: z.int() })).length(2) },
		"never",
	),
	// Reopening an older occurrence while another one of its series is open names that open task.
	defineSafeError("open_successor", { successorId: recordId }, "refresh"),
]);
export type TaskError = z.infer<typeof taskError>;
