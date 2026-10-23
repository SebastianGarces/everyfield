import { z } from "zod";
import { defineSafeError, recordId, revision, safeError } from "../common/values.ts";
import { instant } from "../common/time.ts";
import { communicationStates, meetingTemplateType, templateCategory } from "./values.ts";

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
