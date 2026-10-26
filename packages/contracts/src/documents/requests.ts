import { z } from "zod";
import { personId, recordId } from "../common/values.ts";
import { MERGE_KEY_MAX, MERGE_VALUE_MAX, documentCategory, documentFormat, templateId } from "./values.ts";

const overrides = z.record(z.string().trim().min(1).max(80), z.string().max(MERGE_VALUE_MAX)).optional();

export const listTemplatesRequest = z.strictObject({
	category: documentCategory.optional(),
	phase: z.int().min(0).max(6).optional(),
	format: documentFormat.optional(),
});
export const getTemplateRequest = z.strictObject({ templateId });
export const contextualTemplatesRequest = z.strictObject({
	wikiSlug: z.string().trim().min(1).max(200).optional(),
	category: documentCategory.optional(),
	phase: z.int().min(0).max(6).optional(),
	meetingId: recordId.optional(),
	teamId: recordId.optional(),
});
const contextInput = {
	templateId,
	format: documentFormat,
	overrides,
	personId: personId.optional(),
	meetingId: recordId.optional(),
	teamId: recordId.optional(),
};
function oneSubject(
	value: { personId?: string; meetingId?: string; teamId?: string; overrides?: Record<string, string> },
	ctx: z.RefinementCtx,
) {
	const subjects = [value.personId, value.meetingId, value.teamId].filter((item) => item !== undefined);
	const keys = Object.keys(value.overrides ?? {});
	if (subjects.length > 1) ctx.addIssue({ code: "custom", path: ["personId"], message: "Name one subject." });
	if (keys.length > MERGE_KEY_MAX)
		ctx.addIssue({ code: "custom", path: ["overrides"], message: "Too many merge fields." });
}
export const resolveContextRequest = z.strictObject(contextInput).superRefine(oneSubject);
export const previewRequest = resolveContextRequest;
export const generateRequest = z
	.strictObject({ ...contextInput, requestKey: z.string().trim().min(1).max(80) })
	.superRefine(oneSubject);
const revisionToken = z.string().regex(/^[0-9]{1,20}$/);
const documentTitle = z.string().trim().min(1).max(200);
export const saveNativeRequest = z.strictObject({
	title: documentTitle,
	body: z.string().max(2_000_000),
	documentId: recordId.optional(),
	expectedRevision: revisionToken,
});
export const archiveDocumentRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
});
export const designateCoreValuesRequest = archiveDocumentRequest;
export const importDocumentRequest = z.strictObject({
	title: documentTitle,
	format: z.enum(["text", "docx"]),
	bytes: z.string().min(1).max(14_000_000),
	documentId: recordId.optional(),
	expectedRevision: revisionToken,
	requestKey: z.string().trim().min(1).max(80),
});
export const useForChurchRequest = z.strictObject({
	documentId: recordId,
	revisionId: recordId,
});
export const ownedDocumentRequest = z.strictObject({ documentId: recordId });
export const generatedDocumentRequest = z.strictObject({ documentId: recordId });
export const listOwnedRequest = z.strictObject({});
export const listHistoryRequest = z.strictObject({});
export const readEvidenceRequest = z.strictObject({});
export const purgeOwnedRequest = z.strictObject({ witnessId: recordId });
