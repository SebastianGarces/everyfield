import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { accountId, defineSafeError, operationId, personId, recordId, revision } from "../common/values.ts";
import { stage } from "../people/values.ts";
import { taskDetail, taskError } from "../tasks/results.ts";
import { due, followUpOrigin, followUpOwner, MAX_ASSIGNEES, obligationKind, taskStatus } from "../tasks/values.ts";
import { channel, measurement, obligationState, outcome } from "./values.ts";

const count = z.int().min(0);
const paging = { total: count, page: z.int().min(1), next: z.int().min(2).nullable() };
const account = z.strictObject({ accountId, displayName: z.string() });
const actor = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), accountId, displayName: z.string().nullable() }),
	z.strictObject({ kind: z.literal("former_account") }),
]);

export const outcomeItem = z.strictObject({
	id: recordId,
	revision,
	personId,
	outcome,
	occurredAt: instant,
	recordedAt: instant,
	channel: channel.nullable(),
	notes: z.string().nullable(),
	completedTask: z.boolean(),
	taskId: recordId.nullable(),
	alsoFinished: z.array(z.strictObject({ taskId: recordId, origin: followUpOrigin })).max(100),
	obligationId: recordId.nullable(),
	meetingId: recordId.nullable(),
	actor,
	state: z.enum(["effective", "corrected", "voided"]),
	corrects: z.strictObject({ id: recordId, reason: z.string().nullable() }).nullable(),
	voided: z.strictObject({ at: instant, actor, reason: z.string().nullable() }).nullable(),
	contact: z.boolean(),
});
export const contactHistory = z.strictObject({
	personId,
	lastConfirmedContactAt: instant.nullable(),
	items: z.array(outcomeItem).max(100),
	...paging,
	completeness: z.literal("complete"),
});
export const outcomeMutation = z.strictObject({
	receiptId: operationId,
	record: outcomeItem,
	previous: outcomeItem.nullable(),
	task: taskDetail.nullable(),
	lastConfirmedContactAt: instant.nullable(),
});

export const obligationItem = z.strictObject({
	id: recordId,
	kind: obligationKind,
	meeting: z.strictObject({ id: recordId, label: z.string() }),
	person: z.strictObject({ id: personId, label: z.string() }).nullable(),
	origin: z.strictObject({ at: instant, date: localDate, zone: z.string() }),
	dueDate: localDate,
	state: obligationState,
	waiver: z.strictObject({ at: instant, reason: z.string().nullable() }).nullable(),
	task: z.strictObject({ id: recordId, revision, status: taskStatus, deleted: z.boolean() }).nullable(),
	owners: z.array(followUpOwner).max(MAX_ASSIGNEES),
	completion: z.strictObject({ outcomeId: recordId, outcome, occurredAt: instant }).nullable(),
	contacted: z.boolean(),
	measurement: measurement.nullable(),
});
export const obligationPage = z.strictObject({
	asOf: instant,
	items: z.array(obligationItem).max(100),
	...paging,
	completeness: z.literal("complete"),
});

export const dutyItem = z.strictObject({
	taskId: recordId,
	revision,
	title: z.string(),
	status: taskStatus,
	due,
	overdue: z.boolean().nullable(),
	obligationId: recordId.nullable(),
	person: z.strictObject({ id: personId, label: z.string() }),
	owners: z.array(followUpOwner).max(MAX_ASSIGNEES),
	origin: followUpOrigin,
	lastOutcome: outcome.nullable(),
	contacted: z.strictObject({ at: instant, by: z.string().nullable() }).nullable(),
});
const ownerTally = z.array(account.extend({ open: count })).max(500);
export const followUpCoverage = z.strictObject({
	items: z
		.array(
			z.strictObject({
				person: z.strictObject({ id: personId, label: z.string(), stage: stage.nullable() }),
				coverage: z.enum(["owned", "needs_owner", "uncovered"]),
				duties: z.array(dutyItem).max(20),
			}),
		)
		.max(100),
	owners: ownerTally,
	formerOwners: ownerTally,
	needsOwner: count,
	uncovered: count,
	...paging,
	completeness: z.literal("complete"),
});
export const followUpOwners = z.strictObject({
	items: z.array(dutyItem).max(100),
	owners: ownerTally,
	unassigned: count,
	matched: count,
	page: z.int().min(1),
	next: z.int().min(2).nullable(),
	completeness: z.literal("complete"),
});
export const handoffPlan = z.strictObject({
	from: z.strictObject({
		accountId,
		displayName: z.string().nullable(),
		eligible: z.boolean(),
		protectedOwner: z.boolean(),
	}),
	duties: z.array(dutyItem).max(1000),
	total: count,
	recipients: z.array(account).max(500),
});
export const handoffResult = z.strictObject({
	receiptId: operationId,
	to: account,
	moved: z.array(z.strictObject({ taskId: recordId, revision })).max(100),
	remaining: z.array(recordId).max(1000),
	remainingTotal: count,
});

export const followUpError = z.discriminatedUnion("code", [
	...taskError.options,
	defineSafeError("future_occurrence", {}, "never"),
	defineSafeError("handoff_target_ineligible", {}, "refresh"),
	defineSafeError("protected_owner", {}, "never"),
]);
export type FollowUpError = z.infer<typeof followUpError>;
export { followUpOrigin, type FollowUpOrigin } from "../tasks/values.ts";
