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
/** The agenda of one meeting, as a PDF. The template follows from the meeting. */
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
/** A document title or church template name holds at most this many characters. */
export const TEMPLATE_NAME_MAX = 200;
/** A church template description holds at most this many characters. */
export const TEMPLATE_DESCRIPTION_MAX = 500;
const documentTitle = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);
/** A plain native document saves its title and one native body node (D-209). Any other body is refused. */
export const saveNativeRequest = z.strictObject({
	title: documentTitle,
	body: nativeBody,
	documentId: recordId.optional(),
	expectedRevision: revisionToken,
});
/** A Church Document saves one everyfield.doc/1 document (`kind: "document"`). Any other shape is refused. */
export const saveChurchRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
	body: docDocument,
});
/**
 * Save as template: one saved revision of a Church Document becomes the church's own template. The request names the
 * revision it copies, so the template holds what the person saw saved. The same request key makes one template.
 */
export const saveChurchTemplateRequest = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000),
	name: documentTitle,
	description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX).optional(),
	requestKey: z.string().trim().min(1).max(80),
});
/**
 * Update a church template: one saved revision of a Church Document becomes the template's next version. The request
 * names the version it replaces, so a template that changed since the dialog opened is a conflict. The same request
 * key makes one version.
 */
export const updateChurchTemplateRequest = z.strictObject({
	templateId: recordId,
	expectedVersion: z.int().min(1).max(1_000_000),
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000),
	requestKey: z.string().trim().min(1).max(80),
});
/**
 * Rename a church template or change its description. It makes no new version. The limits are Save as template's; an
 * empty description clears it. The same request key makes one change; last write wins (D-173).
 */
export const editChurchTemplateRequest = z.strictObject({
	templateId: recordId,
	name: documentTitle,
	description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX),
	requestKey: z.string().trim().min(1).max(80),
});
/** Delete a church template from "New from template". Documents made from it keep their content. */
export const deleteChurchTemplateRequest = z.strictObject({ templateId: recordId });
/** A built-in or church template id, merge values by field key and a request key. The same key returns the same document. */
export const createFromTemplateRequest = z.strictObject({
	templateId,
	mergeFields: overrides,
	requestKey: z.string().trim().min(1).max(80),
});
export const exportNativeRequest = z.strictObject({
	documentId: recordId,
	/** The revision number to export, from 1. */
	revision: z.int().min(1).max(1_000_000),
	format: documentFormat,
	requestKey: z.string().trim().min(1).max(80),
});
export const setBrandingRequest = z.strictObject({ documentId: recordId, useChurchBranding: z.boolean() });
export const churchRevisionRequest = z.strictObject({ documentId: recordId, revision: z.int().min(1).max(1_000_000) });
/** The revision list of one Church Document. An empty request lists saved exports. */
export const churchHistoryRequest = z.strictObject({ documentId: recordId });
/** One Church Document with its current revision. */
export const readChurchRequest = z.strictObject({ documentId: recordId });
/** The Church Documents of the church plant. */
export const listChurchRequest = z.strictObject({});
/** The bytes of one revision in one format: the preview and every download read this. No revision: the current one. */
export const churchFileRequest = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1).max(1_000_000).optional(),
	format: documentFormat,
});
/** The saved exports of one Church Document: the latest 100, newest first. */
export const listExportsRequest = z.strictObject({ documentId: recordId });
/** One saved export of one Church Document: its stored bytes for a download, or its deletion. */
export const exportRequest = z.strictObject({ documentId: recordId, exportId: recordId });
/** Compare a Church Document's current revision with the current version of its template. */
export const churchCompareRequest = z.strictObject({ documentId: recordId });
/** The compare's two lists (D-423): "Template changes" since the document's base, and "All differences". */
export const compareView = z.enum(["changes", "all"]);
export type CompareView = z.infer<typeof compareView>;
/**
 * Accept items of one list from the current template as the next revision. The ids are the numbers of the list `view`
 * names, which hold for the expected revision and the template hash the compare named; a newer revision or template
 * is a conflict. `key` is the key the compare gave that list, so ids from the other list are a conflict too.
 */
export const acceptTemplateRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
	templateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	view: compareView,
	key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	accept: z.union([z.literal("all"), z.array(z.int().min(0).max(100_000)).min(1).max(10_000)]),
});
/** Delete a Church Document from the library. The expected revision guards against a stale page. */
export const deleteChurchRequest = z.strictObject({ documentId: recordId, expectedRevision: revisionToken });
export const documentRevisionRequest = z.strictObject({
	documentId: recordId,
	expectedRevision: revisionToken,
});
/** The import route's input: the file's raw bytes, at most IMPORT_BYTES_MAX, and where they go. */
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
/** Copy the current revision of one of your account documents into the church plant. The same key makes one copy. */
export const useForChurchRequest = z.strictObject({
	documentId: recordId,
	revisionId: recordId,
	requestKey: z.string().trim().min(1).max(80),
});
export const ownedDocumentRequest = z.strictObject({ documentId: recordId });
export const generatedDocumentRequest = z.strictObject({ documentId: recordId });
export const listOwnedRequest = z.strictObject({});
/** Your own account documents that Use for this church can copy. */
export const listCopySourcesRequest = z.strictObject({});
export const listHistoryRequest = z.strictObject({});
export const readEvidenceRequest = z.strictObject({});
export const purgeOwnedRequest = z.strictObject({ witnessId: recordId });

export type ChurchSave = z.infer<typeof saveChurchRequest>;
