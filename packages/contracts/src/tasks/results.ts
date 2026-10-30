import { z } from "zod";
import { instant, localDateTime } from "../common/time.ts";
import { accountId, defineSafeError, operationId, recordId, revision, role, safeError } from "../common/values.ts";
import {
	category,
	due,
	followUpOrigin,
	followUpOwner,
	MAX_ASSIGNEES,
	obligationKind,
	priority,
	recurrenceRule,
	taskStatus,
} from "./values.ts";

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
	// Ordered by display name, then account ID. An empty list is Needs owner.
	assignees: z.array(assignee).max(MAX_ASSIGNEES),
	// A person follow-up's assignees with whether each may own it (REQ-TSK-012); empty on any other task.
	followUpOwners: z.array(followUpOwner).max(MAX_ASSIGNEES),
	// Where an open person follow-up came from, so two for one person read differently; null on any other task.
	followUpOrigin: followUpOrigin.nullable(),
	relation: z.strictObject({ kind: z.enum(["person", "meeting", "team"]), id: recordId, label: z.string() }).nullable(),
	parentId: recordId.nullable(),
	checklist: z.strictObject({ total: count, complete: count }),
	// The derived blocked badge: live prerequisites not yet complete or no longer needed. It is advisory, separate from
	// the manual blocked status, and never prevents completion (REQ-TSK-006).
	openPrerequisites: count,
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
			z.strictObject({ id: recordId, revision, title: z.string(), status: taskStatus, assignees: z.array(assignee).max(MAX_ASSIGNEES) }),
		)
		.max(500),
	prerequisiteIds: z.array(recordId).max(50),
	obligationId: recordId.nullable(),
	occurrenceId: z.string().nullable(),
	recurrence: recurrenceRule.extend({ seriesId: recordId, stopped: z.boolean() }).nullable(),
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
export const subtaskPage = z.strictObject({
	parentId: recordId,
	items: z
		.array(
			z.strictObject({
				id: recordId,
				revision,
				title: z.string(),
				status: taskStatus,
				assignees: z.array(assignee).max(MAX_ASSIGNEES),
				completedAt: instant.nullable(),
			}),
		)
		.max(100),
	total: count,
	page: z.int().min(1),
	next: z.int().min(2).nullable(),
	completeness: z.literal("complete"),
});
export const prerequisiteList = z.strictObject({
	taskId: recordId,
	// Each prerequisite with whether it still blocks: a deleted, complete or no-longer-needed one does not.
	items: z
		.array(
			z.strictObject({
				id: recordId,
				title: z.string(),
				status: taskStatus,
				deleted: z.boolean(),
				blocking: z.boolean(),
			}),
		)
		.max(50),
	blocked: z.boolean(),
	completeness: z.literal("complete"),
});
export const prerequisiteCandidates = z.strictObject({
	items: z.array(z.strictObject({ id: recordId, title: z.string(), status: taskStatus })).max(20),
});
export const openOccurrence = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not_recurring") }),
	z.strictObject({
		status: z.literal("series"),
		seriesId: recordId,
		// Null when every occurrence is settled, for example after the end date or a stop.
		open: z
			.strictObject({ taskId: recordId, occurrence: z.int().min(1), predecessorId: recordId.nullable(), revision })
			.nullable(),
	}),
]);
export const occurrenceMutation = taskMutation.extend({ successor: taskDetail.nullable() });
export const bulkOutcome = z.enum([
	"changed",
	"noop",
	"not_found",
	"deleted",
	"closed",
	"unauthorized",
	"stale",
	"ineligible",
]);
export const bulkResult = z.strictObject({
	receiptId: operationId,
	items: z.array(z.strictObject({ taskId: recordId, outcome: bulkOutcome, revision: revision.nullable() })).max(100),
	changed: count,
	// Selected tasks this request did not change and that are still open, for the person to review.
	remaining: z.array(recordId).max(100),
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
	// A prerequisite that already depends on the task, directly or through others.
	defineSafeError("dependency_cycle", {}, "refresh"),
	// The chosen follow-up owner is not a current eligible follow-up owner in this church (REQ-TSK-012).
	defineSafeError("owner_ineligible", { accountId: accountId.optional() }, "refresh"),
]);
export type TaskError = z.infer<typeof taskError>;
