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
