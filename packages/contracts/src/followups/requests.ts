import { z } from "zod";
import { instant } from "../common/time.ts";
import { accountId, personId, recordId, requestKey, revision } from "../common/values.ts";
import { commandEnvelope } from "../common/writes.ts";
import { assigneeIds, description, dueInput, priority, title } from "../tasks/values.ts";
import { channel, notes, outcome, reason } from "./values.ts";

const page = {
	limit: z.int().min(1).max(100).default(50),
	page: z.int().min(1).max(100_000).default(1),
};
// A contacted outcome needs the human-confirmed instant it happened; the server never assumes one.
const confirmed = (v: { outcome: string; occurredAt?: unknown }) =>
	v.outcome !== "contacted" || v.occurredAt !== undefined;

// No actor, church, recorded instant, obligation or meeting in the body: the server derives them from the task.
export const recordOutcomeRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			// A task the person holds, or, for an Owner or Admin, a Person with no task (a standalone contact).
			target: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("task"), taskId: recordId, expectedRevision: revision }),
				z.strictObject({ kind: z.literal("person"), personId }),
			]),
			outcome,
			// Omitted means now, except for contacted. The server refuses a future instant.
			occurredAt: instant.optional(),
			channel: channel.nullable().default(null),
			notes: notes.nullable().default(null),
			// Completing the task is the person's separate choice (REQ-MTG-022).
			completeTask: z.boolean(),
		})
		.refine(confirmed, "occurred_at_required")
		.refine((v) => v.target.kind === "task" || (v.outcome !== "no_longer_needed" && !v.completeTask))
		.refine((v) => v.outcome !== "no_longer_needed" || !v.completeTask),
});
// A correction replaces the outcome with a new one and keeps the old; a void withdraws it. Either needs a reason.
export const correctOutcomeRequest = commandEnvelope(
	z.strictObject({
		outcomeId: recordId,
		correction: z.discriminatedUnion("kind", [
			z
				.strictObject({
					kind: z.literal("replace"),
					outcome,
					occurredAt: instant.optional(),
					channel: channel.nullable().optional(),
					notes: notes.nullable().optional(),
				})
				.refine(confirmed, "occurred_at_required"),
			z.strictObject({ kind: z.literal("void") }),
		]),
		reason,
	}),
);
// With taskId, only the entries recorded on that follow-up task or finished along with it.
export const listContactHistoryRequest = z.strictObject({ personId, taskId: recordId.optional(), ...page });
export const readObligationsRequest = z.strictObject({
	personId: personId.optional(),
	meetingId: recordId.optional(),
	state: z.enum(["open", "complete", "no_longer_needed", "superseded", "any"]).default("any"),
	asOf: instant.optional(),
	...page,
});

// A manual follow-up: undated unless a date is chosen, with no meeting origin and no 48-hour measure. The title
// defaults to one derived from the stored Person.
export const createFollowUpRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		personId,
		title: title.optional(),
		description: description.nullable().default(null),
		priority: priority.default("medium"),
		due: dueInput.default({ kind: "undated" }),
		assigneeIds: assigneeIds.default([]),
	}),
});
// An empty list leaves the follow-up as Needs owner.
export const assignFollowUpRequest = commandEnvelope(z.strictObject({ taskId: recordId, assigneeIds }));
export const followUpCoverageRequest = z.strictObject({
	personId: personId.optional(),
	coverage: z.enum(["owned", "needs_owner", "uncovered", "any"]).default("any"),
	asOf: instant.optional(),
	...page,
});
export const listFollowUpOwnersRequest = z.strictObject({
	owner: z.union([accountId, z.literal("needs_owner")]).optional(),
	personId: personId.optional(),
	asOf: instant.optional(),
	...page,
});
export const planHandoffRequest = z.strictObject({ fromAccountId: accountId });
// At most 100 reviewed follow-ups per request. A larger selection is several requests, each with its own key.
export const executeHandoffRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			fromAccountId: accountId,
			toAccountId: accountId,
			items: z
				.array(z.strictObject({ taskId: recordId, expectedRevision: revision }))
				.min(1)
				.max(100)
				.refine((items) => new Set(items.map((i) => i.taskId)).size === items.length),
		})
		.refine((v) => v.fromAccountId !== v.toAccountId, { message: "same_account", path: ["toAccountId"] }),
});
