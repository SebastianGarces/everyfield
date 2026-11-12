import { z } from "zod";
import { correlationId, recordId, tenantId } from "../common/values.ts";
import { docDocument, type DocDifference } from "./format/index.ts";
import { nativeBody } from "./native.ts";
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
	/** The church plant has a saved brand kit, so the render uses the church theme where the kit has a primary color. */
	brandKit: z.boolean(),
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
	source: z.strictObject({ documentId: recordId, revisionId: recordId, revision: z.int().min(1) }).nullable(),
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
	/** The current revision's body; a pre-change text revision reads as one paragraph per line. */
	body: nativeBody,
	/** True when the current revision is stored as plain text, saved before native bodies. */
	textRevision: z.boolean(),
	revision: revisionToken,
	/** The current revision record: Use for this church names it. */
	revisionId: recordId,
	contentHash: sha256,
	archived: z.boolean(),
	copiedFromRevisionId: recordId.nullable(),
	copiedFromHash: sha256.nullable(),
});
/** One row of the written-documents list: the document without its body, which the list never reads. */
export const ownedListItem = ownedDocument.omit({ body: true, textRevision: true });
export const ownedDocumentPage = z.strictObject({
	documents: z.array(ownedListItem).max(100),
});
/** One account document Use for this church offers: its title and the current revision a copy takes. */
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
/**
 * What the PDF paints for one document, so the editor paper can paint the same: the palette the renderer derives from
 * the church theme (or the neutral theme when the document does not use church branding or the church has no kit), and
 * the brand-kit images the document may show. An image the kit lacks is null.
 */
export const docBrand = z.strictObject({
	palette: z.strictObject({
		ink: hexColor,
		mutedText: hexColor,
		muted: hexColor,
		border: hexColor,
		primary: hexColor,
		accent: hexColor,
		accentLine: hexColor,
		/** Primary as text on white, as the PDF prints the title, numbered heading numbers and links. */
		primaryText: hexColor,
		/** The text color the PDF prints on a box filled with each token. */
		on: z.strictObject({
			ink: hexColor,
			"muted-text": hexColor,
			primary: hexColor,
			accent: hexColor,
			muted: hexColor,
			border: hexColor,
		}),
		/** True for a church theme; false for the Everyfield-neutral theme. */
		themed: z.boolean(),
	}),
	assets: z.strictObject({ logo: brandAsset, mark: brandAsset, photo: brandAsset }),
});
export type DocBrand = z.infer<typeof docBrand>;
/** A Church Document with its current revision. The body is an everyfield.doc/1 document. */
export const churchDocument = z.strictObject({
	id: recordId,
	tenantId: tenantId,
	templateId,
	templateVersion: z.int().min(1),
	/** The formats the document offers: PDF and Word, and Excel when it holds a ledger table. */
	formats: z.array(documentFormat).min(1).max(3),
	documentClass: churchClass,
	/** The name of the church template the document was made from; null for a built-in template. */
	templateName: z.string().min(1).max(200).nullable(),
	useChurchBranding: z.boolean(),
	title: z.string().min(1).max(200),
	/** The current revision number, as a decimal string, for the expected-revision check. */
	revision: revisionToken,
	revisionId: recordId,
	body: docDocument,
	contentHash: sha256,
	archived: z.boolean(),
	/** The merge values resolved into revision 1, with where each came from. */
	provenance: z
		.array(
			z.strictObject({ key: z.string().max(80), value: z.string().max(2000).nullable(), source: z.string().max(40) }),
		)
		.max(20),
});
/**
 * What the editor gets: the document and both looks the PDF can paint for it. `church` is the church theme, null when
 * the church has no brand kit with a primary color to paint; `plain` is the Everyfield-neutral theme. The document's
 * `useChurchBranding` picks one, so the page can follow the branding switch without another read. `mergeValues` is the
 * church's current value of each merge field Insert offers.
 */
export const churchDocumentView = churchDocument.extend({
	brands: z.strictObject({ church: docBrand.nullable(), plain: docBrand }),
	mergeValues: z.record(z.string().max(60), z.string().max(2000)),
	/**
	 * Where the document stands against the current version of its template, built-in or the church's own: "behind"
	 * when the template hash it records is not the current one's; null when there is nothing to compare with.
	 */
	template: z.enum(["behind", "current"]).nullable(),
});
export type DocBrands = z.infer<typeof churchDocumentView>["brands"];
export const churchRevisionSummary = z.strictObject({
	id: recordId,
	number: z.int().min(1),
	authorAccountId: z.uuid().nullable(),
	/** The saver's name while they hold a seat in this church plant; null once that seat ends or the account is gone (D-105). */
	authorName: z.string().min(1).max(255).nullable(),
	recordedAt: z.iso.datetime(),
	contentHash: sha256,
	/**
	 * The formats this revision offers, from its own body: PDF and Word as its export list names them, and Excel while it
	 * holds a ledger table. Empty for a stored body that cannot render.
	 */
	formats: z.array(documentFormat).max(3),
});
/** The most revisions one church revision list holds: the newest ones. */
export const CHURCH_REVISION_LIST_MAX = 1000;
export const churchRevisionList = z.strictObject({
	documentId: recordId,
	/** The newest CHURCH_REVISION_LIST_MAX revisions, oldest first. */
	revisions: z.array(churchRevisionSummary).max(CHURCH_REVISION_LIST_MAX),
	/** True when the document has older revisions than the list holds. */
	truncated: z.boolean(),
});
export const churchRevision = churchRevisionSummary.extend({ documentId: recordId, body: docDocument });
/** One entry of the Church Document library. */
export const churchSummary = z.strictObject({
	id: recordId,
	title: z.string().min(1).max(200),
	templateId,
	templateVersion: z.int().min(1),
	/** The name of the church template the document was made from; null for a built-in template. */
	templateName: z.string().min(1).max(200).nullable(),
	documentClass: churchClass,
	revision: revisionToken,
	updatedAt: z.iso.datetime(),
});
/**
 * One of the church's own templates, as "New from template" shows it, with the document revision it was saved from.
 * `templateId` is what New from template takes ("church-" and the record id).
 */
export const churchTemplateSummary = z.strictObject({
	id: recordId,
	templateId,
	title: z.string().min(1).max(200),
	description: z.string().max(500).nullable(),
	/** The current version: 1 when saved, one more for each update. */
	version: z.int().min(1),
	documentClass: churchClass,
	formats: z.array(documentFormat).min(1).max(3),
	/** Sheets of paper: the page size in points and the cards per sheet (1 when not tiled). */
	page: z.strictObject({ width: z.number().positive(), height: z.number().positive(), perSheet: z.int().min(1) }),
	source: z.strictObject({ documentId: recordId, revisionId: recordId, revision: z.int().min(1) }),
});
export const churchLibrary = z.strictObject({
	documents: z.array(churchSummary).max(200),
	templates: z.array(churchTemplateSummary).max(200),
});
export const deletedChurchTemplate = z.strictObject({ templateId: recordId, deleted: z.literal(true) });
export type ChurchTemplateSummary = z.infer<typeof churchTemplateSummary>;
/** The bytes of one revision in one format, base64. */
export const churchFile = z.strictObject({
	documentId: recordId,
	revision: z.int().min(1),
	format: documentFormat,
	mediaType: z.string().min(1).max(120),
	downloadName: z.string().min(1).max(220),
	digest: sha256,
	bytes: z.string().min(1),
});
/** One saved export as the document page lists it. The revision and the bytes never change after the export. */
export const savedExport = z.strictObject({
	id: recordId,
	documentId: recordId,
	revision: z.int().min(1),
	format: documentFormat,
	generatedAt: z.iso.datetime(),
	/** The name of the person who exported it, while they hold a seat in the church plant; else null. */
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
/**
 * A Church Document beside the current version of its template, as two lists in reading order (D-423), and the text
 * each merge field prints on both sides (the document's frozen values, then what an accepted new field would print).
 * `changes` ("Template changes") holds only what the template changed since `baseVersion`, the version the document
 * records; both are null when that version is not stored. `differences` ("All differences") holds every difference
 * from the current version. `keys` names each list for an accept. `behind` is true when the template hash the
 * document records is not the current template's.
 */
export const churchCompare = z.strictObject({
	documentId: recordId,
	revision: revisionToken,
	templateTitle: z.string().min(1).max(200),
	/** True when the template is the church's own ("Save as template"), false for one of Everyfield's. */
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
export type ChurchSummary = z.infer<typeof churchSummary>;
export const brandingResult = z.strictObject({ documentId: recordId, useChurchBranding: z.boolean() });
export type ChurchRevisionList = z.infer<typeof churchRevisionList>;
export type ChurchRevision = z.infer<typeof churchRevision>;
export type ChurchDocument = z.infer<typeof churchDocument>;
