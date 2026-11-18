import { z } from "zod";
import { personId, recordId } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";
import { docDocument } from "./format/index.ts";
import { nativeBody } from "./native.ts";
import {
	IMPORT_BYTES_MAX,
	IMPORT_TOO_LARGE,
	MERGE_KEY_MAX,
	MERGE_VALUE_MAX,
	documentCategory,
	documentFormat,
	templateId,
} from "./values.ts";

const overrides = z.record(z.string().trim().min(1).max(80), z.string().max(MERGE_VALUE_MAX)).optional();

export const listTemplatesRequest = z.strictObject({
	category: documentCategory.optional(),
	phase: phaseNumber.optional(),
	format: documentFormat.optional(),
});
export const getTemplateRequest = z.strictObject({ templateId });
export const contextualTemplatesRequest = z.strictObject({
	wikiSlug: z.string().trim().min(1).max(200).optional(),
	category: documentCategory.optional(),
	phase: phaseNumber.optional(),
	meetingId: recordId.optional(),
	teamId: recordId.optional(),
});
export const printAgendaRequest = z.strictObject({ meetingId: recordId });
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
export const generateRequest = z
	.strictObject({ ...contextInput, requestKey: z.string().trim().min(1).max(80) })
	.superRefine(oneSubject);
const revisionToken = z.string().regex(/^[0-9]{1,20}$/);
export const TEMPLATE_NAME_MAX = 200;
export const TEMPLATE_DESCRIPTION_MAX = 500;
const documentTitle = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);
export const saveNativeRequest = z.strictObject({
	title: documentTitle,
	body: nativeBody,
	documentId: recordId.optional(),
	expectedRevision: revisionToken,
});
export const saveChurchRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
	body: docDocument,
});
export const saveChurchTemplateRequest = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000),
	name: documentTitle,
	description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX).optional(),
	requestKey: z.string().trim().min(1).max(80),
});
export const updateChurchTemplateRequest = z.strictObject({
	templateId: recordId,
	expectedVersion: z.int().min(1).max(1_000_000),
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000),
	requestKey: z.string().trim().min(1).max(80),
});
export const editChurchTemplateRequest = z.strictObject({
	templateId: recordId,
	name: documentTitle,
	description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX),
	requestKey: z.string().trim().min(1).max(80),
});
export const deleteChurchTemplateRequest = z.strictObject({ templateId: recordId });
export const createFromTemplateRequest = z.strictObject({
	templateId,
	mergeFields: overrides,
	requestKey: z.string().trim().min(1).max(80),
});
export const exportNativeRequest = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000),
	format: documentFormat,
	requestKey: z.string().trim().min(1).max(80),
});
export const setBrandingRequest = z.strictObject({ documentId: recordId, useChurchBranding: z.boolean() });
export const churchRevisionRequest = z.strictObject({ documentId: recordId, revision: z.int().min(1).max(1_000_000) });
export const churchHistoryRequest = z.strictObject({ documentId: recordId });
export const readChurchRequest = z.strictObject({ documentId: recordId });
export const listChurchRequest = z.strictObject({});
export const churchFileRequest = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000).optional(),
	format: documentFormat,
});
export const listExportsRequest = z.strictObject({ documentId: recordId });
export const exportRequest = z.strictObject({ documentId: recordId, exportId: recordId });
export const churchCompareRequest = z.strictObject({ documentId: recordId });
export const compareView = z.enum(["changes", "all"]);
export type CompareView = z.infer<typeof compareView>;
export const acceptTemplateRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
	templateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	view: compareView,
	key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	accept: z.union([z.literal("all"), z.array(z.int().min(0).max(100_000)).min(1).max(10_000)]),
});
export const deleteChurchRequest = z.strictObject({ documentId: recordId, expectedRevision: revisionToken });
export const archiveChurchRequest = deleteChurchRequest;
export const listArchivedChurchRequest = z.strictObject({});
export const restoreChurchRequest = z.strictObject({ documentId: recordId });
export const documentRevisionRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
});
export const importDocumentRequest = z.strictObject({
	title: documentTitle,
	format: z.enum(["text", "docx"]),
	bytes: z
		.instanceof(Uint8Array)
		.refine((bytes) => bytes.length > 0, "The file is empty.")
		.refine((bytes) => bytes.length <= IMPORT_BYTES_MAX, IMPORT_TOO_LARGE),
	documentId: recordId.optional(),
	expectedRevision: revisionToken,
	requestKey: z.string().trim().min(1).max(80),
});
export const useForChurchRequest = z.strictObject({
	documentId: recordId,
	revisionId: recordId,
	requestKey: z.string().trim().min(1).max(80),
});
export const ownedDocumentRequest = z.strictObject({ documentId: recordId });
export const generatedDocumentRequest = z.strictObject({ documentId: recordId });
export const listOwnedRequest = z.strictObject({});
export const listCopySourcesRequest = z.strictObject({});
export const listHistoryRequest = z.strictObject({});
export const readEvidenceRequest = z.strictObject({});
export const purgeOwnedRequest = z.strictObject({ witnessId: recordId });

export type ChurchSave = z.infer<typeof saveChurchRequest>;
