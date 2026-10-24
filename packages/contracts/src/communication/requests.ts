import { z } from "zod";
import { recordId, requestKey, revision } from "../common/values.ts";
import { instant } from "../common/time.ts";
import { audienceInput, draftInput, mergeFields, templateDraft, templatePatch } from "./values.ts";

export const saveDraftRequest = z.strictObject({
	requestKey,
	expectedRevision: revision.optional(),
	input: draftInput,
});
export const deleteDraftRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ communicationId: recordId }),
});
export const scheduleRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ communicationId: recordId, scheduledAt: instant }),
});
export const createTemplateRequest = z.strictObject({ requestKey, input: templateDraft });
export const forkTemplateRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ sourceKey: z.string().trim().min(1).max(80) }),
});
export const updateTemplateRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ templateId: recordId, patch: templatePatch }),
});
export const templateIdRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ templateId: recordId }),
});
export const previewRequest = z.strictObject({
	bodyHtml: z.string().max(100_000),
	merge: mergeFields.default({}),
	audience: audienceInput.optional(),
	audienceChangedAfterReview: z.boolean().default(false),
	communicationId: recordId.optional(),
	meetingId: recordId.optional(),
	templateId: recordId.optional(),
});
export const searchRecipientsRequest = z.strictObject({ query: z.string().trim().min(1).max(200) });
export const resolveAudienceRequest = audienceInput;
export const resolveMergeRequest = z.strictObject({
	bodyHtml: z.string().max(100_000),
	merge: mergeFields.default({}),
});
export const recordRequest = z.strictObject({ id: recordId });
export const meetingTemplateRequest = z.strictObject({
	meetingType: z.enum(["vision_meeting", "orientation", "team_meeting"]),
});

export const dispatchRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ communicationId: recordId }),
});
export const cancelScheduledRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ communicationId: recordId, signedUrlExpires: instant.optional() }),
});
export const replaceScheduledRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ communicationId: recordId }),
});
export const restoreSuppressionRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ address: z.email(), reason: z.string().trim().min(1).max(500) }),
});
export const sendTransactionalRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		purpose: z.literal("password_reset"),
		token: z.string().min(20).max(200),
		address: z.email(),
	}),
});
export const listSuppressionRequest = z.strictObject({ address: z.email() });
