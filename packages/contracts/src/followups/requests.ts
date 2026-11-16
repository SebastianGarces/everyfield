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
const confirmed = (v: { outcome: string; occurredAt?: unknown }) =>
	v.outcome !== "contacted" || v.occurredAt !== undefined;

export const recordOutcomeRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			target: z.discriminatedUnion("kind", [
				z.strictObject({ kind: z.literal("task"), taskId: recordId, expectedRevision: revision }),
				z.strictObject({ kind: z.literal("person"), personId }),
			]),
			outcome,
			occurredAt: instant.optional(),
			channel: channel.nullable().default(null),
			notes: notes.nullable().default(null),
			completeTask: z.boolean(),
		})
		.refine(confirmed, "occurred_at_required")
		.refine((v) => v.target.kind === "task" || (v.outcome !== "no_longer_needed" && !v.completeTask))
		.refine((v) => v.outcome !== "no_longer_needed" || !v.completeTask),
});
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
export const listContactHistoryRequest = z.strictObject({ personId, taskId: recordId.optional(), ...page });
export const readObligationsRequest = z.strictObject({
	personId: personId.optional(),
	meetingId: recordId.optional(),
	state: z.enum(["open", "complete", "no_longer_needed", "superseded", "any"]).default("any"),
	asOf: instant.optional(),
	...page,
});

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
export const HANDOFF_LIMIT = 100;
export const executeHandoffRequest = z.strictObject({
	requestKey,
	input: z
		.strictObject({
			fromAccountId: accountId,
			toAccountId: accountId,
			items: z
				.array(z.strictObject({ taskId: recordId, expectedRevision: revision }))
				.min(1)
				.max(HANDOFF_LIMIT)
				.refine((items) => new Set(items.map((i) => i.taskId)).size === items.length),
		})
		.refine((v) => v.fromAccountId !== v.toAccountId, { message: "same_account", path: ["toAccountId"] }),
});
