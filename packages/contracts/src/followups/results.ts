import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { accountId, defineSafeError, operationId, personId, recordId, revision } from "../common/values.ts";
import { stage } from "../people/values.ts";
import { taskDetail, taskError } from "../tasks/results.ts";
import { due, followUpOrigin, followUpOwner, obligationKind, taskStatus } from "../tasks/values.ts";
import { channel, measurement, obligationState, outcome } from "./values.ts";

const count = z.int().min(0);
const paging = { total: count, page: z.int().min(1), next: z.int().min(2).nullable() };
const account = z.strictObject({ accountId, displayName: z.string() });
const actor = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("account"), accountId, displayName: z.string().nullable() }),
	z.strictObject({ kind: z.literal("former_account") }),
]);

// One recorded outcome as the contact log shows it: a human outcome, never a delivered email.
export const outcomeItem = z.strictObject({
	id: recordId,
	revision,
	personId,
	outcome,
	occurredAt: instant,
	recordedAt: instant,
	channel: channel.nullable(),
	notes: z.string().nullable(),
	// The person completed the task with this outcome; contacted can also be recorded without completing it.
	completedTask: z.boolean(),
	taskId: recordId.nullable(),
	// The person's other open follow-ups this one contact finished (a contact finishes all it may, REQ-MTG-022).
	alsoFinished: z.array(z.strictObject({ taskId: recordId, origin: followUpOrigin })).max(100),
	obligationId: recordId.nullable(),
	meetingId: recordId.nullable(),
	actor,
	// Effective, replaced by a correction, or withdrawn. Earlier entries stay in the log.
	state: z.enum(["effective", "corrected", "voided"]),
	// The entry this one corrected, with the reason given.
	corrects: z.strictObject({ id: recordId, reason: z.string().nullable() }).nullable(),
	voided: z.strictObject({ at: instant, actor, reason: z.string().nullable() }).nullable(),
	// Only an effective contacted outcome counts as contact.
	contact: z.boolean(),
});
export const contactHistory = z.strictObject({
	personId,
	// The latest effective contacted occurrence, or null when there is none (Unknown).
	lastConfirmedContactAt: instant.nullable(),
	items: z.array(outcomeItem).max(100),
	...paging,
	completeness: z.literal("complete"),
});
export const outcomeMutation = z.strictObject({
	receiptId: operationId,
	record: outcomeItem,
	// The entry a correction replaced or a void withdrew, as it reads now.
	previous: outcomeItem.nullable(),
	task: taskDetail.nullable(),
	lastConfirmedContactAt: instant.nullable(),
});

export const obligationItem = z.strictObject({
	id: recordId,
	kind: obligationKind,
	meeting: z.strictObject({ id: recordId, label: z.string() }),
	// Null for a meeting evaluation, which names no Person.
	person: z.strictObject({ id: personId, label: z.string() }).nullable(),
	origin: z.strictObject({ at: instant, date: localDate, zone: z.string() }),
	dueDate: localDate,
	state: obligationState,
	waiver: z.strictObject({ at: instant, reason: z.string().nullable() }).nullable(),
	task: z.strictObject({ id: recordId, revision, status: taskStatus, deleted: z.boolean() }).nullable(),
	// The task's assignee with whether they may own it; null is Needs owner. An ineligible assignee still counts as Needs owner.
	owner: followUpOwner.nullable(),
	// The earliest effective typed outcome that completed the task, when the task is complete.
	completion: z.strictObject({ outcomeId: recordId, outcome, occurredAt: instant }).nullable(),
	// An effective contacted outcome exists for this obligation. Task completion and contact are separate facts.
	contacted: z.boolean(),
	// The 48-hour measure for a first-Vision follow-up; null for an evaluation.
	measurement: measurement.nullable(),
});
export const obligationPage = z.strictObject({
	asOf: instant,
	items: z.array(obligationItem).max(100),
	...paging,
	completeness: z.literal("complete"),
});

// An open follow-up task as the assignment views show it. No due date or urgency is invented for an undated task.
export const dutyItem = z.strictObject({
	taskId: recordId,
	revision,
	title: z.string(),
	status: taskStatus,
	due,
	overdue: z.boolean().nullable(),
	obligationId: recordId.nullable(),
	person: z.strictObject({ id: personId, label: z.string() }),
	// The task's assignee with whether they may own it (REQ-TSK-012); null is Needs owner. Ineligible reads as Needs owner.
	owner: followUpOwner.nullable(),
	// Where the follow-up came from, so two for one person can be told apart.
	origin: followUpOrigin,
	// The latest effective outcome recorded on the task, if any.
	lastOutcome: outcome.nullable(),
	// The latest effective contact with this person since the follow-up began, by whoever recorded it. A follow-up the
	// recorder could not finish shows it, so nobody calls twice.
	contacted: z.strictObject({ at: instant, by: z.string().nullable() }).nullable(),
});
const ownerTally = z.array(account.extend({ open: count })).max(500);
export const followUpCoverage = z.strictObject({
	items: z
		.array(
			z.strictObject({
				person: z.strictObject({ id: personId, label: z.string(), stage: stage.nullable() }),
				// uncovered: no explicit open follow-up. It is not urgent work.
				coverage: z.enum(["owned", "needs_owner", "uncovered"]),
				duties: z.array(dutyItem).max(20),
			}),
		)
		.max(100),
	owners: ownerTally,
	// Accounts holding open follow-ups they can no longer own, with how many (REQ-TSK-013).
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
		// Still an eligible follow-up owner in this church.
		eligible: z.boolean(),
		// Holds the church's Owner seat: a handoff cannot take work from it.
		protectedOwner: z.boolean(),
	}),
	// Owner reads null while the source is not an eligible owner.
	duties: z.array(dutyItem).max(1000),
	total: count,
	recipients: z.array(account).max(500),
});
export const handoffResult = z.strictObject({
	receiptId: operationId,
	to: account,
	moved: z.array(z.strictObject({ taskId: recordId, revision })).max(100),
	// The source's open follow-ups still left after this request.
	remaining: z.array(recordId).max(1000),
	remainingTotal: count,
});

export const followUpError = z.discriminatedUnion("code", [
	...taskError.options,
	// The occurrence is after the server's current time.
	defineSafeError("future_occurrence", {}, "never"),
	defineSafeError("handoff_target_ineligible", {}, "refresh"),
	defineSafeError("protected_owner", {}, "never"),
]);
export type FollowUpError = z.infer<typeof followUpError>;
export { followUpOrigin, type FollowUpOrigin } from "../tasks/values.ts";
