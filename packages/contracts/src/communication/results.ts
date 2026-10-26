import { z } from "zod";
import { defineSafeError, recordId, revision, safeError } from "../common/values.ts";
import { instant } from "../common/time.ts";
import { audienceInput, communicationStates, meetingTemplateType, templateCategory } from "./values.ts";

export const communicationError = z.discriminatedUnion("code", [
	...safeError.options,
	defineSafeError(
		"stale_review",
		{ previewBody: z.string(), scriptExecution: z.literal(false), providerCalls: z.literal(0) },
		"never",
	),
	defineSafeError("schedule_window_exceeded", { providerHandoffs: z.literal(0) }, "never"),
	defineSafeError("protected_source", {}, "never"),
	defineSafeError("referenced", {}, "never"),
	defineSafeError("not_found", {}, "never"),
	defineSafeError("cancel_unconfirmed", { replacementIntents: z.literal(0) }, "never"),
]);
export type CommunicationError = z.infer<typeof communicationError>;

export const draftResult = z.strictObject({
	communicationId: recordId,
	revision,
	state: z.enum(communicationStates),
	subject: z.string().nullable(),
	bodyHtml: z.string().nullable(),
	bodyText: z.string().nullable(),
	audience: audienceInput,
	meetingId: recordId.nullable(),
	templateId: recordId.nullable(),
	templateSource: z.string().nullable(),
});
export const scheduleResult = draftResult.extend({
	scheduleStatus: z.literal("accepted"),
	scheduleSent: z.literal(false),
	draftIntents: z.literal(0),
	replacementIntents: z.literal(0),
	scheduledAt: instant,
});
export const templateResult = z.strictObject({
	templateId: recordId,
	revision,
	sourceKey: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	category: templateCategory,
	meetingType: meetingTemplateType.nullable(),
	subject: z.string(),
	bodyHtml: z.string(),
	archived: z.boolean(),
	origin: z.enum(["system", "plant"]),
});
export const previewResult = z.strictObject({
	previewBody: z.string(),
	scriptExecution: z.literal(false),
	providerCalls: z.literal(0),
	eligibleEmails: z.array(z.string()),
	excludedMissingEmail: z.array(z.string()),
	duplicateAddressesRemoved: z.number().int().nonnegative(),
});
export const audienceResult = z.strictObject({
	resolvedDistinctPeople: z.number().int().nonnegative(),
	eligibleRecipients: z.number().int().nonnegative(),
	missingEmailExclusions: z.array(z.string()),
	duplicateAddressesRemoved: z.number().int().nonnegative(),
	eligibleEmails: z.array(z.string()),
	searchResultLimit: z.literal(20),
	searchLimitTruncatesAudience: z.literal(false),
});
export const recipientResult = z.strictObject({
	people: z.array(z.strictObject({ id: recordId, displayName: z.string(), email: z.string() })).max(20),
	limit: z.literal(20),
});
export const teamListResult = z.strictObject({
	teams: z.array(z.strictObject({ id: recordId, name: z.string() })),
});
export const draftListResult = z.strictObject({
	drafts: z.array(draftResult),
});
export const templateListResult = z.strictObject({ templates: z.array(templateResult) });
export const mergeResult = z.strictObject({ bodyHtml: z.string(), bodyText: z.string() });

export const dispatchResult = z.strictObject({
	communicationId: recordId,
	sentAt: instant.nullable(),
	acceptedCount: z.number().int().nonnegative(),
	rejectedCount: z.number().int().nonnegative(),
	unknownCount: z.number().int().nonnegative(),
	uncertain: z.boolean(),
	failed: z.boolean(),
	providerCalls: z.number().int().nonnegative(),
	replayedWithNewKeys: z.literal(0),
	automaticReplayAllowed: z.literal(false),
	negativeEvidenceRequired: z.boolean(),
	firstDispatchClockReset: z.literal(false),
	crossScopeBatchAllowed: z.literal(false),
	status: z.enum(["accepted", "partial", "uncertain", "failed", "accepted_unknown"]),
	confirmedRecipientIds: z.array(z.string()),
});
export const cancelScheduledResult = z.strictObject({
	newHandoffs: z.literal(0),
	scheduledCancel: z.enum(["reconcile", "confirmed", "none"]),
	sentRecalled: z.literal(false),
	cancelRequested: z.boolean(),
	recallGuaranteed: z.literal(false),
	newSend: z.literal(false),
	existingUrlMayWorkUntil: instant.nullable(),
});
export const replaceScheduledResult = z.strictObject({
	replacementAllowed: z.boolean(),
	replacementIntents: z.literal(0),
	blindResends: z.literal(0),
});
export const rescheduleDispatchedResult = z.strictObject({
	body: z.string(),
	rescheduleStatus: z.enum(["accepted", "unknown"]),
	newCommunications: z.literal(0),
	scheduledAt: instant,
});
export const transactionalResult = z.strictObject({
	purposeMailAttempted: z.literal(true),
	deliveryStatus: z.enum(["unknown", "accepted", "refused"]),
	sentAt: instant.nullable(),
});
export const suppressionListResult = z.strictObject({
	address: z.email(),
	active: z.boolean(),
	suppressionClears: z.literal(0),
	newSends: z.literal(0),
});
export const restoreSuppressionResult = z.strictObject({
	suppressionClears: z.number().int().nonnegative(),
	newSends: z.literal(0),
});
export const retryResult = z.strictObject({
	blindResends: z.literal(0),
	retried: z.number().int().nonnegative(),
});

const hubStates = ["draft", "scheduled", "sending", "sent", "logged", "cancelled", "failed", "unknown"] as const;
const contactOutcomes = ["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"] as const;

export const historyItem = z.strictObject({
	id: recordId,
	subject: z.string().nullable(),
	state: z.enum(hubStates),
	channel: z.literal("email"),
	meetingId: recordId.nullable(),
	createdAt: instant,
	countsAsSent: z.boolean(),
	rate: z.number().nullable(),
	reachable: z.number().int().nonnegative(),
	delivered: z.number().int().nonnegative(),
});
export const historyPage = z.strictObject({
	items: z.array(historyItem),
	nextCursor: z.string().nullable(),
	visibleCount: z.number().int().nonnegative(),
	asOf: instant,
	complete: z.boolean(),
	limit: z.number().int().min(1).max(100),
	rate: z.number().nullable(),
	draftCountsAsSent: z.literal(false),
	unknownCountsAsSent: z.literal(false),
	foreignRows: z.array(z.string()).max(0),
});
export const deliveryTotalsResult = z.strictObject({
	communicationId: recordId,
	state: z.enum(hubStates),
	selected: z.number().int().nonnegative(),
	reachable: z.number().int().nonnegative(),
	attempted: z.number().int().nonnegative(),
	accepted: z.number().int().nonnegative(),
	sent: z.number().int().nonnegative(),
	delivered: z.number().int().nonnegative(),
	opened: z.number().int().nonnegative(),
	clicked: z.number().int().nonnegative(),
	bounced: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	suppressed: z.number().int().nonnegative(),
	unknown: z.number().int().nonnegative(),
	asOf: instant,
	rate: z.number().nullable(),
	outcomes: z.array(z.enum(["accepted", "unknown", "rejected"])),
	sentForAll: z.boolean(),
});
export const detailResult = z.strictObject({
	communicationId: recordId,
	revision: revision,
	state: z.enum(communicationStates),
	subject: z.string().nullable(),
	bodyHtml: z.string().nullable(),
	bodyText: z.string().nullable(),
	meetingId: recordId.nullable(),
	deliveryAddress: z.string().nullable(),
	currentPersonAddress: z.string().nullable(),
	deliveryStatus: z.string().nullable(),
	recipients: z.array(
		z.strictObject({
			personId: recordId.nullable(),
			deliveryAddress: z.string().nullable(),
			currentPersonAddress: z.string().nullable(),
			deliveryStatus: z.string(),
			sentAt: instant.nullable(),
			deliveredAt: instant.nullable(),
			openedAt: instant.nullable(),
			clickedAt: instant.nullable(),
		}),
	),
});
export const personHistoryResult = historyPage.extend({
	personId: recordId,
	lastConfirmedContactAt: instant.nullable(),
	contacts: z.array(
		z.strictObject({
			outcomeId: recordId,
			outcome: z.enum(contactOutcomes),
			occurredAt: instant,
			voided: z.boolean(),
			taskId: recordId.nullable(),
		}),
	),
});
export const meetingHistoryResult = historyPage.extend({ meetingId: recordId });
export const recipientHistoryResult = z.strictObject({
	communicationId: recordId,
	items: z.array(
		z.strictObject({
			personId: recordId.nullable(),
			name: z.string().nullable(),
			deliveryStatus: z.string(),
			deliveryAddress: z.string().nullable(),
		}),
	),
	nextCursor: z.string().nullable(),
	complete: z.boolean(),
});
export const meetingTrackingResult = z.strictObject({
	meetingId: recordId,
	items: z.array(
		z.strictObject({
			personId: recordId,
			name: z.string(),
			deliveryStatus: z.string(),
		}),
	),
	complete: z.literal(true),
});
export const executionResult = z.strictObject({
	communicationId: recordId,
	status: z.enum(["failed", "unknown", "accepted", "partial"]),
	accepted: z.number().int().nonnegative(),
	refused: z.number().int().nonnegative(),
	unknown: z.number().int().nonnegative(),
});
export const resendCandidatesResult = z.strictObject({
	communicationId: recordId,
	selection: z.enum(["delivered_nonopeners", "proven_failed"]),
	eligibleIds: z.array(recordId),
	eligibleNames: z.array(z.string()),
	excludedNames: z.array(z.string()),
	openTrackingIsCertain: z.literal(false),
	confirmedDelivery: z.boolean(),
});
export const resendResult = z.strictObject({
	communicationId: recordId,
	newCommunications: z.literal(1),
	originalMutated: z.literal(false),
	replayNewIntents: z.literal(0),
	openTrackingIsCertain: z.literal(false),
	eligibleIds: z.array(recordId),
	eligibleNames: z.array(z.string()),
});
export const recordContactResult = z.strictObject({
	projectionRevision: revision,
	outcomeId: recordId,
	outcome: z.literal("contacted"),
	lastConfirmedContactAt: instant,
});
export const contactCorrectionResult = z.strictObject({
	executionId: recordId,
	status: z.literal("corrected"),
	affected: z.literal(1),
	excluded: z.literal(0),
	results: z.array(
		z.strictObject({
			outcomeId: recordId,
			outcome: z.enum(contactOutcomes),
			voided: z.boolean(),
		}),
	),
	correction: z.strictObject({
		supersedesId: recordId,
		outcomeId: recordId,
		outcome: z.enum(contactOutcomes),
		occurredAt: instant.nullable(),
	}),
	correlationId: recordId,
	lastConfirmedContactAt: instant.nullable(),
});
