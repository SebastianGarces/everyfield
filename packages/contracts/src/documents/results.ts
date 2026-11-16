import { z } from "zod";
import { defineSafeError, recordId, sha256Text as sha256, tenantId, type Reply } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";
import { docDocument, type DocDifference } from "./format/index.ts";
import { nativeBody } from "./native.ts";
import { documentCategory, documentFormat, templateId } from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });

export const documentsError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	defineSafeError("unavailable", {}, "never"),
	defineSafeError("deleted", {}, "never"),
	defineSafeError("invalid_subject", {}, "never"),
	defineSafeError("render_failed", {}, "never"),
	defineSafeError("conflict", {}, "refresh"),
	defineSafeError("access_denied", {}, "never"),
]);
export type DocumentsError = z.infer<typeof documentsError>;
export type DocumentsReply<T> = Reply<T, DocumentsError>;

const mergeField = z.strictObject({
	key: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	required: z.boolean(),
	autoFill: z.string().min(1).max(80).nullable(),
});
export const templateView = z.strictObject({
	id: templateId,
	name: z.string().min(1).max(200),
	description: z.string().min(1).max(2000),
	category: documentCategory,
	phase: phaseNumber.nullable(),
	formats: z.array(documentFormat).min(1).max(3),
	pageCount: z.int().min(1).max(20),
	wikiSlug: z.string().min(1).max(200).nullable(),
	mergeFields: z.array(mergeField).max(20),
	documentClass: z.enum(["formal/legal", "outward-facing", "operational"]),
	pageSize: z.strictObject({ width: z.int().min(1), height: z.int().min(1) }).nullable(),
	fillable: z.boolean(),
	outline: z.array(z.string().min(1).max(200)).min(1).max(20),
});
export const templatePage = z.strictObject({
	version: sha256,
	templateCount: z.int().min(0),
	formatCount: z.int().min(0),
	templates: z.array(templateView).max(20),
});

const fieldSource = z.enum(["override", "church_name", "pastor_name", "launch_date", "meeting", "absent"]);
const resolvedField = z.strictObject({
	key: z.string().min(1).max(80),
	label: z.string().min(1).max(200),
	required: z.boolean(),
	value: z.string().max(2000).nullable(),
	source: fieldSource,
});
const contextValue = {
	templateId,
	templateVersion: sha256,
	plantId: tenantId,
	format: documentFormat,
	fields: z.array(resolvedField).max(20),
	missing: z.array(z.string().min(1).max(80)).max(20),
	sources: z.array(z.string().min(1).max(200)).max(5),
	complete: z.boolean(),
};
export const contextResult = z.strictObject(contextValue);
export const previewResult = z.strictObject({
	...contextValue,
	brandKit: z.boolean(),
	artifact: z.string().min(1).nullable(),
	digest: sha256.nullable(),
	engineVersion: sha256.nullable(),
});

export const agendaPrintResult = z.strictObject({
	templateId,
	localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	artifact: z.string().min(1),
});

const revisionToken = z.string().regex(/^[0-9]{1,20}$/);
const templateVersionToken = z.string().regex(/^([a-f0-9]{64}|[1-9][0-9]{0,5})$/);
export const generatedDocument = z.strictObject({
	id: recordId,
	plantId: tenantId,
	templateId,
	templateVersion: templateVersionToken,
	savedTemplateName: z.string().min(1).max(200),
	format: documentFormat,
	digest: sha256,
	byteCount: z
		.int()
		.min(1)
		.max(8 * 1024 * 1024),
	downloadName: z.string().min(1).max(220),
	generatedAt: z.iso.datetime(),
	creatorAccountId: z.uuid().nullable(),
	revision: revisionToken,
	source: z.strictObject({ documentId: recordId, revisionId: recordId, revision: z.int().min(1) }).nullable(),
	theme: z
		.strictObject({
			kind: z.enum(["church", "everyfield-neutral"]),
			primary: z
				.string()
				.regex(/^#[0-9A-F]{6}$/)
				.nullable(),
		})
		.nullable(),
});
export const generatedHistory = z.strictObject({
	entries: z.array(generatedDocument).max(100),
});
export const downloadResult = z.strictObject({
	url: z.url(),
	expiresAt: z.iso.datetime(),
	expiresInSeconds: z.literal(300),
});
export const ownedDocument = z.strictObject({
	id: recordId,
	tenantId: tenantId,
	kind: z.enum(["native", "core_values", "launch_summary"]),
	title: z.string().min(1).max(200),
	body: nativeBody,
	textRevision: z.boolean(),
	revision: revisionToken,
	revisionId: recordId,
	contentHash: sha256,
	archived: z.boolean(),
	copiedFromRevisionId: recordId.nullable(),
	copiedFromHash: sha256.nullable(),
});
export const ownedListItem = ownedDocument.omit({ body: true, textRevision: true });
export const ownedDocumentPage = z.strictObject({
	documents: z.array(ownedListItem).max(100),
});
export const copySource = z.strictObject({
	id: recordId,
	title: z.string().min(1).max(200),
	revisionId: recordId,
});
export const copySourcePage = z.strictObject({ documents: z.array(copySource).max(100) });
export const coreValuesEvidence = z.strictObject({
	documentId: recordId.nullable(),
	text: z.string().max(2_000_000).nullable(),
});

const churchClass = z.enum(["formal/legal", "outward-facing", "operational"]);
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const brandAsset = z.strictObject({ fileId: recordId, alt: z.string().max(200) }).nullable();
export const docBrand = z.strictObject({
	palette: z.strictObject({
		ink: hexColor,
		mutedText: hexColor,
		muted: hexColor,
		border: hexColor,
		primary: hexColor,
		accent: hexColor,
		accentLine: hexColor,
		primaryText: hexColor,
		on: z.strictObject({
			ink: hexColor,
			"muted-text": hexColor,
			primary: hexColor,
			accent: hexColor,
			muted: hexColor,
			border: hexColor,
		}),
		themed: z.boolean(),
	}),
	assets: z.strictObject({ logo: brandAsset, mark: brandAsset, photo: brandAsset }),
});
export type DocBrand = z.infer<typeof docBrand>;
export const churchDocument = z.strictObject({
	id: recordId,
	tenantId: tenantId,
	templateId,
	templateVersion: z.int().min(1),
	formats: z.array(documentFormat).min(1).max(3),
	documentClass: churchClass,
	templateName: z.string().min(1).max(200).nullable(),
	useChurchBranding: z.boolean(),
	title: z.string().min(1).max(200),
	revision: revisionToken,
	revisionId: recordId,
	body: docDocument,
	contentHash: sha256,
	archived: z.strictObject({ at: z.iso.datetime(), by: z.string().min(1).max(255).nullable() }).nullable(),
	provenance: z
		.array(
			z.strictObject({ key: z.string().max(80), value: z.string().max(2000).nullable(), source: z.string().max(40) }),
		)
		.max(20),
});
export const churchDocumentView = churchDocument.extend({
	brands: z.strictObject({ church: docBrand.nullable(), plain: docBrand }),
	mergeValues: z.record(z.string().max(60), z.string().max(2000)),
	template: z.enum(["behind", "current"]).nullable(),
});
export type DocBrands = z.infer<typeof churchDocumentView>["brands"];
export const churchRevisionSummary = z.strictObject({
	id: recordId,
	number: z.int().min(1),
	authorAccountId: z.uuid().nullable(),
	authorName: z.string().min(1).max(255).nullable(),
	recordedAt: z.iso.datetime(),
	contentHash: sha256,
	formats: z.array(documentFormat).max(3),
});
export const CHURCH_REVISION_LIST_MAX = 1000;
export const churchRevisionList = z.strictObject({
	documentId: recordId,
	revisions: z.array(churchRevisionSummary).max(CHURCH_REVISION_LIST_MAX),
	truncated: z.boolean(),
});
export const churchRevision = churchRevisionSummary.extend({ documentId: recordId, body: docDocument });
export const churchSummary = z.strictObject({
	id: recordId,
	title: z.string().min(1).max(200),
	templateId,
	templateVersion: z.int().min(1),
	templateName: z.string().min(1).max(200).nullable(),
	documentClass: churchClass,
	revision: revisionToken,
	updatedAt: z.iso.datetime(),
});
export const churchTemplateSummary = z.strictObject({
	id: recordId,
	templateId,
	title: z.string().min(1).max(200),
	description: z.string().max(500).nullable(),
	version: z.int().min(1),
	documentClass: churchClass,
	formats: z.array(documentFormat).min(1).max(3),
	page: z.strictObject({ width: z.number().positive(), height: z.number().positive(), perSheet: z.int().min(1) }),
	source: z.strictObject({ documentId: recordId, revisionId: recordId, revision: z.int().min(1) }),
});
export const churchLibrary = z.strictObject({
	documents: z.array(churchSummary).max(200),
	templates: z.array(churchTemplateSummary).max(200),
});
export const deletedChurchTemplate = z.strictObject({ templateId: recordId, deleted: z.literal(true) });
export type ChurchTemplateSummary = z.infer<typeof churchTemplateSummary>;
export const churchFile = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1),
	format: documentFormat,
	mediaType: z.string().min(1).max(120),
	downloadName: z.string().min(1).max(220),
	digest: sha256,
	bytes: z.string().min(1),
});
export const savedExport = z.strictObject({
	id: recordId,
	documentId: recordId,
	revision: z.int().min(1),
	format: documentFormat,
	generatedAt: z.iso.datetime(),
	creatorName: z.string().min(1).max(255).nullable(),
	digest: sha256,
	byteCount: z.int().min(1),
	downloadName: z.string().min(1).max(220),
});
export const savedExportList = z.strictObject({ documentId: recordId, exports: z.array(savedExport).max(100) });
export const deletedExport = z.strictObject({ exportId: recordId, deleted: z.literal(true) });
export type SavedExport = z.infer<typeof savedExport>;
const differenceList = z
	.array(
		z.custom<DocDifference>(
			(v) => !!v && typeof v === "object" && "id" in v && "part" in v && "kind" in v,
			"a difference",
		),
	)
	.max(10_000);
const listKey = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const churchCompare = z.strictObject({
	documentId: recordId,
	revision: revisionToken,
	templateTitle: z.string().min(1).max(200),
	churchTemplate: z.boolean(),
	templateVersion: z.int().min(1),
	templateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	baseVersion: z.int().min(1).nullable(),
	behind: z.boolean(),
	values: z.record(z.string(), z.string()),
	changes: differenceList.nullable(),
	differences: differenceList,
	keys: z.strictObject({ changes: listKey.nullable(), all: listKey }),
});
export type ChurchCompare = z.infer<typeof churchCompare>;
export const deletedChurch = z.strictObject({ documentId: recordId, deleted: z.literal(true) });
export const archivedChurch = z.strictObject({ documentId: recordId, archived: z.literal(true) });
export const restoredChurch = z.strictObject({ documentId: recordId, restored: z.literal(true) });
export const archivedChurchSummary = z.strictObject({
	id: recordId,
	title: z.string().min(1).max(200),
	documentClass: churchClass,
	archivedAt: z.iso.datetime(),
	archivedBy: z.string().min(1).max(255).nullable(),
});
export type ArchivedChurchSummary = z.infer<typeof archivedChurchSummary>;
export const ARCHIVED_CHURCH_LIST_MAX = 200;
export const archivedChurchList = z.strictObject({
	documents: z.array(archivedChurchSummary).max(ARCHIVED_CHURCH_LIST_MAX),
});
export type ChurchSummary = z.infer<typeof churchSummary>;
export const brandingResult = z.strictObject({ documentId: recordId, useChurchBranding: z.boolean() });
export type ChurchRevisionList = z.infer<typeof churchRevisionList>;
export type ChurchRevision = z.infer<typeof churchRevision>;
export type ChurchDocument = z.infer<typeof churchDocument>;
