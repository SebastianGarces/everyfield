import { z } from "zod";
import { correlationId, recordId, tenantId } from "../common/values.ts";
import { churchBody } from "./body.ts";
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
	error("access_denied", {}, "never"),
	error("template_not_editable", {}, "never"),
	/** `documents.generate` on an editable template: a Church Document is made with `createFromTemplate`. */
	error("template_is_editable", {}, "never"),
	/** An editable template that has no authored content yet. */
	error("template_not_authored", {}, "never"),
	error("slot_not_deletable", { slotIds: z.array(z.string().max(60)).max(20) }, "never"),
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
	/** `ready`: a Church Document is made from it. `pending`: editable, with no authored copy yet. Null: not editable. */
	editable: z.enum(["ready", "pending"]).nullable(),
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
/** A catalog template is versioned by the reference artifact hash; a Church Document template by its whole number. */
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
	/** The Church Document revision an export was made from. Null for a generated file. */
	source: z
		.strictObject({
			documentId: recordId,
			revisionId: recordId,
			revision: z.int().min(1),
			/** The document's title now, for the saved-exports list. */
			title: z.string().min(1).max(200),
		})
		.nullable(),
	/** The theme an export used. Null for a generated file. */
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

const churchClass = z.enum(["formal/legal", "outward-facing", "operational"]);
/** A Church Document with its current revision. */
export const churchDocument = z.strictObject({
	id: recordId,
	tenantId: tenantId,
	templateId,
	templateVersion: z.int().min(1),
	documentClass: churchClass,
	useChurchBranding: z.boolean(),
	title: z.string().min(1).max(200),
	/** The current revision number, as a decimal string, for the expected-revision check. */
	revision: revisionToken,
	revisionId: recordId,
	body: churchBody,
	contentHash: sha256,
	archived: z.boolean(),
	/** The merge values resolved into revision 1, with where each came from. */
	provenance: z
		.array(
			z.strictObject({ key: z.string().max(80), value: z.string().max(2000).nullable(), source: z.string().max(40) }),
		)
		.max(20),
});
export const churchRevisionSummary = z.strictObject({
	id: recordId,
	number: z.int().min(1),
	authorAccountId: z.uuid().nullable(),
	/** The author's name. Null when the account no longer exists. */
	authorName: z.string().max(200).nullable(),
	recordedAt: z.iso.datetime(),
	contentHash: sha256,
});
export const churchRevisionList = z.strictObject({
	documentId: recordId,
	revisions: z.array(churchRevisionSummary).max(1000),
});
export const churchRevision = churchRevisionSummary.extend({ documentId: recordId, body: churchBody });
/** One Church Document in the list: its current revision and when that revision was saved. */
export const churchListItem = z.strictObject({
	id: recordId,
	title: z.string().min(1).max(200),
	templateId,
	templateName: z.string().min(1).max(200),
	documentClass: churchClass,
	revision: z.int().min(1),
	editedAt: z.iso.datetime(),
});
export const churchList = z.strictObject({
	/** The church plant's IANA time zone, for the edit times. */
	timeZone: z.string().min(1).max(80),
	documents: z.array(churchListItem).max(200),
});
/** A saved export of a Church Document, as the document page lists it. */
export const churchExport = z.strictObject({
	id: recordId,
	format: z.enum(["pdf", "docx"]),
	revision: z.int().min(1),
	theme: z.enum(["church", "everyfield-neutral"]),
	creatorName: z.string().max(200).nullable(),
	generatedAt: z.iso.datetime(),
	downloadName: z.string().min(1).max(220),
});
/** One Church Document with its template facts, history and saved exports. One read, a fixed number of statements. */
export const churchPage = z.strictObject({
	document: churchDocument,
	templateName: z.string().min(1).max(200),
	slots: z.array(z.strictObject({ id: z.string().min(1).max(60), label: z.string().min(1).max(200) })).max(20),
	/** The church plant's IANA time zone, for the times on the page. */
	timeZone: z.string().min(1).max(80),
	/** True when the church plant has a brand kit. */
	hasBrandKit: z.boolean(),
	revisions: z.array(churchRevisionSummary).max(1000),
	exports: z.array(churchExport).max(100),
});
export type ChurchPage = z.infer<typeof churchPage>;
export type ChurchList = z.infer<typeof churchList>;
export type ChurchExport = z.infer<typeof churchExport>;
export type ChurchRevisionSummary = z.infer<typeof churchRevisionSummary>;
export const brandingResult = z.strictObject({ documentId: recordId, useChurchBranding: z.boolean() });
export type ChurchRevisionList = z.infer<typeof churchRevisionList>;
export type ChurchRevision = z.infer<typeof churchRevision>;
export type ChurchDocument = z.infer<typeof churchDocument>;
