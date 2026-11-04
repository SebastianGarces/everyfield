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
	defineSafeError("rsvp_needs_meeting", {}, "never"),
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
	previewHtml: z.string(),
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
	/** The reachable people by name, capped at 200. `complete` is false when the cap cut the list. */
	recipients: z.array(z.strictObject({ id: recordId, displayName: z.string(), email: z.string() })).max(200),
	complete: z.boolean(),
});
export const recipientResult = z.strictObject({
	people: z.array(z.strictObject({ id: recordId, displayName: z.string(), email: z.string().nullable() })).max(20),
	limit: z.literal(20),
});
export const teamListResult = z.strictObject({
	teams: z.array(z.strictObject({ id: recordId, name: z.string() })),
});
export const churchNameResult = z.strictObject({ churchName: z.string() });
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
const count = z.number().int().nonnegative();
/**
 * What the email service confirmed for one cancel or time change, per accepted recipient. `confirmed` counts the
 * recipients it confirmed, `sent` the ones it says already went out, `open` the ones still without an answer.
 */
const providerTally = { confirmedCount: count, sentCount: count, openCount: count };
export const cancelScheduledResult = z.strictObject({
	newHandoffs: z.literal(0),
	/** `confirmed`: no recipient is open. `reconcile`: some are. `none`: nothing was with the email service. */
	scheduledCancel: z.enum(["reconcile", "confirmed", "none"]),
	sentRecalled: z.literal(false),
	cancelRequested: z.boolean(),
	recallGuaranteed: z.literal(false),
	newSend: z.literal(false),
	existingUrlMayWorkUntil: instant.nullable(),
	...providerTally,
});
export const replaceScheduledResult = z.strictObject({
	replacementAllowed: z.boolean(),
	replacementIntents: z.literal(0),
	blindResends: z.literal(0),
});
export const rescheduleDispatchedResult = z.strictObject({
	body: z.string(),
	/** `accepted`: every open recipient now holds `scheduledAt`. `unknown`: some still hold `heldAt`. */
	rescheduleStatus: z.enum(["accepted", "unknown"]),
	newCommunications: z.literal(0),
	/** The requested send time. */
	scheduledAt: instant,
	/** The time the email service still holds for an open recipient, or null when none is open. */
	heldAt: instant.nullable(),
	...providerTally,
});
export const transactionalResult = z.strictObject({
	purposeMailAttempted: z.literal(true),
	deliveryStatus: z.enum(["unknown", "accepted", "refused"]),
	sentAt: instant.nullable(),
});
export const suppressionListResult = z.strictObject({
	address: z.email(),
	active: z.boolean(),
	/** Each earlier restore of this address, newest first. `actorName` is null when no name is on record. */
	restores: z.array(z.strictObject({ at: instant, actorName: z.string().nullable(), reason: z.string() })),
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

/**
 * The state history shows for a message. `scheduled`: the email service holds at least one recipient for the send
 * time. `not_scheduled`: a scheduled message the email service refused for every recipient. `failed`: a send the email
 * service refused for every recipient ("Not sent"). `unknown`: no recipient confirmed ("Not confirmed").
 * `cancel_unconfirmed` and `time_unconfirmed`: a cancel or time change still open for some recipient.
 */
export const hubStates = [
	"draft",
	"scheduled",
	"not_scheduled",
	"sending",
	"sent",
	"logged",
	"cancelled",
	"cancel_unconfirmed",
	"time_unconfirmed",
	"failed",
	"unknown",
] as const;
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
	scheduledAt: instant.nullable(),
	sentAt: instant.nullable(),
	senderName: z.string().nullable(),
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
	/** Recipients the email service confirmed cancelled. */
	cancelled: z.number().int().nonnegative(),
	/** Recipients with a requested cancel that the email service has not confirmed. */
	cancelOpen: z.number().int().nonnegative(),
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
	/** The send time the email service holds, once it holds the message; before that, the saved time. */
	scheduledAt: instant.nullable(),
	/** A requested send time the email service has not confirmed for every recipient, else null. */
	requestedAt: instant.nullable(),
	sentAt: instant.nullable(),
	senderName: z.string().nullable(),
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

/** What became of one recipient of an earlier send that a replacement tried to cancel. */
export const recipientOutcome = z.enum(["cancelled", "sent", "open"]);
export type RecipientOutcome = z.infer<typeof recipientOutcome>;
const code = z.string().min(1);
/**
 * What the email service confirmed for an Evry email effect, as the proposal saves it and the review card reads it.
 * `code` is why Messages stopped a step after the first one committed; with no code the email service itself answered.
 */
export const mailReport = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("schedule"),
		confirmation: z.enum(["confirmed", "not_confirmed", "refused"]),
		scheduledAt: z.string(),
		accepted: count,
		refused: count,
		unknown: count,
		code: code.optional(),
	}),
	z.object({
		kind: z.literal("reschedule"),
		confirmation: z.enum(["confirmed", "not_confirmed", "none"]),
		scheduledAt: z.string(),
		open: count,
		sent: count,
	}),
	z.object({
		kind: z.literal("cancel"),
		confirmation: z.enum(["confirmed", "not_confirmed", "none"]),
		cancelled: count,
		sent: count,
		open: count,
	}),
	/** Every old send is confirmed cancelled and the new one reached the email service. */
	z.object({
		kind: z.literal("replace"),
		confirmation: z.enum(["confirmed", "not_confirmed"]),
		scheduledAt: z.string(),
		accepted: count,
		refused: count,
		unknown: count,
		cancelled: count,
	}),
	/** No new send: a cancel is open or too late, or the new one was refused after the old one was cancelled. */
	z.object({
		kind: z.literal("replace_stopped"),
		confirmation: z.enum(["not_confirmed", "blocked", "refused"]),
		cancelled: count,
		sent: count,
		open: count,
		people: z.array(z.object({ name: z.string(), outcome: recipientOutcome })),
		code: code.optional(),
	}),
]);
export type MailReport = z.infer<typeof mailReport>;
