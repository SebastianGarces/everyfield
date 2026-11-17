import { z } from "zod";
import { instant } from "../common/time.ts";
import { recordId, requestKey, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import {
	assigneeIds,
	category,
	description,
	dueInput,
	priority,
	recurrenceRule,
	relation,
	taskStatus,
	title,
} from "./values.ts";

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
export const editTaskRequest = commandEnvelope(
	z.strictObject({
		taskId: recordId,
		patch: z.strictObject({
			title: title.optional(),
			description: description.nullable().optional(),
			priority: priority.optional(),
			category: category.optional(),
			due: dueInput.optional(),
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
export const taskRowsRequest = z.strictObject({
	taskIds: z
		.array(recordId)
		.min(1)
		.max(100)
		.refine((ids) => new Set(ids).size === ids.length),
});
export const statusHistoryRequest = z.strictObject({
	taskId: recordId,
	limit: z.int().min(1).max(100).default(50),
	page: z.int().min(1).max(100_000).default(1),
});
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

export const listSubtasksRequest = z.strictObject({ parentId: recordId, ...page });
export const createSubtaskRequest = commandEnvelope(
	z.strictObject({
		parentId: recordId,
		title,
		assigneeIds: assigneeIds.optional(),
	}),
);
export const setSubtaskCompletionRequest = commandEnvelope(
	z.strictObject({ parentId: recordId, taskId: recordId, complete: z.boolean() }),
);
export const removeSubtaskRequest = commandEnvelope(z.strictObject({ parentId: recordId, taskId: recordId }));

export const replacePrerequisitesRequest = commandEnvelope(
	z.strictObject({ taskId: recordId, prerequisiteIds: z.array(recordId).max(50).refine(unique) }),
);
export const listPrerequisitesRequest = z.strictObject({ taskId: recordId });
export const prerequisiteCandidatesRequest = z.strictObject({
	taskId: recordId,
	search: z.string().trim().max(200).default(""),
});

export const configureRecurrenceRequest = commandEnvelope(
	z.strictObject({ taskId: recordId, rule: recurrenceRule.nullable() }),
);
export const findOpenOccurrenceRequest = z.strictObject({ taskId: recordId });

const bulkItems = z
	.array(z.strictObject({ taskId: recordId, expectedRevision: revision }))
	.min(1)
	.max(100);
export const bulkCompleteRequest = z.strictObject({ requestKey, items: bulkItems });
export const bulkRescheduleRequest = z.strictObject({ requestKey, items: bulkItems, due: dueInput });
