import { z } from "zod";
import { instant } from "../common/time.ts";
import { accountId, recordId, requestKey, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { assigneeIds, category, description, dueInput, priority, recurrenceRule, relation, taskStatus, title } from "./values.ts";

// No owner, creator, completion time, obligation or source identity in bodies: the server derives them. A checklist
// row is created with createSubtaskRequest.
export const createTaskRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		title,
		description: description.nullable().default(null),
		status: taskStatus.default("not_started"),
		priority: priority.default("medium"),
		category: category.default("general"),
		due: dueInput.default({ kind: "undated" }),
		assigneeIds: assigneeIds.default([]),
		relation: relation.nullable().default(null),
	}),
});
// Omitted means unchanged; an explicit null clears a nullable field.
export const editTaskRequest = commandEnvelope(
	z.strictObject({
		taskId: recordId,
		patch: z.strictObject({
			title: title.optional(),
			description: description.nullable().optional(),
			priority: priority.optional(),
			category: category.optional(),
			due: dueInput.optional(),
			// Omitted leaves the set unchanged; an empty list clears it.
			assigneeIds: assigneeIds.optional(),
			relation: relation.nullable().optional(),
		}),
	}),
);
export const taskCommandRequest = commandEnvelope(z.strictObject({ taskId: recordId }));
export const waiveTaskRequest = commandEnvelope(
	z.strictObject({ taskId: recordId, reason: z.string().trim().min(1).max(500).nullable().default(null) }),
);
export const changeStatusRequest = commandEnvelope(z.strictObject({ taskId: recordId, status: taskStatus }));

const filters = {
	view: z.enum(["my", "all"]).default("all"),
	search: z.string().trim().max(200).optional(),
	statuses: z.array(taskStatus).max(5).default([]),
	priorities: z.array(priority).max(4).default([]),
	categories: z.array(category).max(10).default([]),
	relation: z.enum(["person", "meeting", "team", "none", "any"]).default("any"),
	// A team the church does not have matches no task, so a foreign team reveals nothing.
	teamId: recordId.optional(),
	due: z.enum(["undated", "local_date", "resolved_instant", "any"]).default("any"),
};
export const listTasksRequest = z.strictObject({
	...filters,
	sort: z.enum(["due", "priority", "status", "title", "created"]).default("due"),
	direction: z.enum(["asc", "desc"]).default("asc"),
	limit: z.int().min(1).max(100).default(50),
	page: z.int().min(1).max(100_000).default(1),
	asOf: instant.optional(),
});
export const countTasksRequest = z.strictObject(filters);
export const getTaskRequest = z.strictObject({ taskId: recordId, asOf: instant.optional() });
export const statusHistoryRequest = z.strictObject({
	taskId: recordId,
	limit: z.int().min(1).max(100).default(50),
	page: z.int().min(1).max(100_000).default(1),
});
/** Who a picker offers: every seat, or only those who may own a follow-up (REQ-TSK-012). */
export const eligibleAssigneesRequest = z.strictObject({
	purpose: z.enum(["any", "committed_follow_up"]).default("any"),
});
export const relationOptionsRequest = z.strictObject({
	kind: z.enum(["person", "meeting", "team"]),
	search: z.string().trim().max(200).default(""),
});

const page = {
	limit: z.int().min(1).max(100).default(50),
	page: z.int().min(1).max(100_000).default(1),
};
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

// One-level checklist rows (REQ-TSK-005). expectedRevision is the parent's revision for a create and the child's for a
// tick or removal, so a concurrent parent change or child change refuses instead of acting on stale state.
export const listSubtasksRequest = z.strictObject({ parentId: recordId, ...page });
export const createSubtaskRequest = commandEnvelope(
	z.strictObject({
		parentId: recordId,
		title,
		// Omitted inherits the parent's assignees. Only an Owner or Admin may name other accounts or an empty list.
		assigneeIds: assigneeIds.optional(),
	}),
);
export const setSubtaskCompletionRequest = commandEnvelope(
	z.strictObject({ parentId: recordId, taskId: recordId, complete: z.boolean() }),
);
export const removeSubtaskRequest = commandEnvelope(z.strictObject({ parentId: recordId, taskId: recordId }));

// Advisory prerequisites (REQ-TSK-006): the whole set is replaced at once.
export const replacePrerequisitesRequest = commandEnvelope(
	z.strictObject({ taskId: recordId, prerequisiteIds: z.array(recordId).max(50).refine(unique) }),
);
export const listPrerequisitesRequest = z.strictObject({ taskId: recordId });
export const prerequisiteCandidatesRequest = z.strictObject({
	taskId: recordId,
	search: z.string().trim().max(200).default(""),
});

// Recurrence (REQ-TSK-007). A null rule stops the series; its tasks and history stay.
export const configureRecurrenceRequest = commandEnvelope(
	z.strictObject({ taskId: recordId, rule: recurrenceRule.nullable() }),
);
export const findOpenOccurrenceRequest = z.strictObject({ taskId: recordId });

// Bulk changes (REQ-TSK-008): at most 100 reviewed tasks, each with the revision the person saw. A repeated task ID
// counts once.
const bulkItems = z
	.array(z.strictObject({ taskId: recordId, expectedRevision: revision }))
	.min(1)
	.max(100);
export const bulkCompleteRequest = z.strictObject({ requestKey, items: bulkItems });
export const bulkRescheduleRequest = z.strictObject({ requestKey, items: bulkItems, due: dueInput });
