import { z } from "zod";
import { instant } from "../common/time.ts";
import { accountId, recordId, requestKey } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { category, description, dueInput, priority, relation, taskStatus, title } from "./values.ts";

// No owner, creator, completion time, obligation or source identity in bodies: the server derives them.
export const createTaskRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		title,
		description: description.nullable().default(null),
		status: taskStatus.default("not_started"),
		priority: priority.default("medium"),
		category: category.default("general"),
		due: dueInput.default({ kind: "undated" }),
		assigneeId: accountId.nullable().default(null),
		relation: relation.nullable().default(null),
		parentId: recordId.nullable().default(null),
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
			assigneeId: accountId.nullable().optional(),
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
export const relationOptionsRequest = z.strictObject({
	kind: z.enum(["person", "meeting", "team"]),
	search: z.string().trim().max(200).default(""),
});
