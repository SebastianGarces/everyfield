import { z } from "zod";
import { correlationId, recordId, tenantId } from "../common/values.ts";
import { documentCategory, documentFormat, templateId } from "./values.ts";

const issue = z.strictObject({ path: z.string().max(200), problem: z.string().max(200) });
const error = <C extends string, D extends z.ZodRawShape>(code: C, details: D, retry: "never" | "refresh") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });

/** Refusals a document-template read can return. An unknown template is "unavailable". */
export const documentsError = z.discriminatedUnion("code", [
	error("invalid_input", { issues: z.array(issue).max(50) }, "never"),
	error("unavailable", {}, "never"),
	error("invalid_subject", {}, "never"),
	error("render_failed", {}, "never"),
	error("conflict", {}, "refresh"),
]);
export type DocumentsError = z.infer<typeof documentsError>;
export type DocumentsReply<T> = { status: "ok"; value: T } | { status: "refused"; error: DocumentsError };

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
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
	phase: z.int().min(0).max(6).nullable(),
	formats: z.array(documentFormat).min(1).max(3),
	pageCount: z.int().min(1).max(20),
	wikiSlug: z.string().min(1).max(200).nullable(),
	mergeFields: z.array(mergeField).max(20),
	documentClass: z.enum(["formal/legal", "outward-facing", "operational"]),
	/** Page size in points: card 306 x 396, Letter 612 x 792. Null for a spreadsheet. */
	pageSize: z.strictObject({ width: z.int().min(1), height: z.int().min(1) }).nullable(),
	/** True when the output has fields a person fills in. */
	fillable: z.boolean(),
	/** The real section titles of the rebuilt document. */
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
	artifact: z.string().min(1).nullable(),
	digest: sha256.nullable(),
	engineVersion: sha256.nullable(),
});

/** A meeting's agenda as bytes. localDate is the meeting's own day, for the file name. */
export const agendaPrintResult = z.strictObject({
	templateId,
	localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	artifact: z.string().min(1),
});

const revisionToken = z.string().regex(/^[0-9]{1,20}$/);
export const generatedDocument = z.strictObject({
	id: recordId,
	plantId: tenantId,
	templateId,
	templateVersion: sha256,
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
	body: z.string().max(2_000_000),
	revision: revisionToken,
	contentHash: sha256,
	archived: z.boolean(),
	copiedFromRevisionId: recordId.nullable(),
	copiedFromHash: sha256.nullable(),
});
export const ownedDocumentPage = z.strictObject({
	documents: z.array(ownedDocument).max(100),
});
export const coreValuesEvidence = z.strictObject({
	documentId: recordId.nullable(),
	text: z.string().max(2_000_000).nullable(),
});
