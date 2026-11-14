import { z } from "zod";
import { defineSafeError, personId, requestKey } from "../../common/values.ts";
import { instant } from "../../common/time.ts";
import { listPeopleRequest } from "../requests.ts";

// People CSV import (REQ-PPL-018) and export (REQ-PPL-019). The server reads the uploaded bytes itself; a client never
// returns parsed rows.

/** The 12 contact input columns. Background, account, photo and recruitment-stage fields are never imported. */
export const importColumns = [
	"first_name",
	"last_name",
	"email",
	"phone",
	"street",
	"city",
	"state",
	"postal_code",
	"country",
	"source",
	"source_details",
	"notes",
] as const;
export const importColumn = z.enum(importColumns);
/**
 * The 15 export columns. status is the recruitment stage, tags are semicolon-joined names and created_at is the recorded
 * UTC instant. Import reads only the 12 contact columns, so an export is not a lossless backup.
 */
export const exportColumns = [
	"first_name",
	"last_name",
	"email",
	"phone",
	"street",
	"city",
	"state",
	"postal_code",
	"country",
	"status",
	"source",
	"source_details",
	"notes",
	"tags",
	"created_at",
] as const;
export const importLimits = { bytes: 10 * 1024 * 1024, rows: 10_000 } as const;

export const csvError = [
	defineSafeError("file_too_large", {}, "never"),
	defineSafeError("row_limit_exceeded", {}, "never"),
	defineSafeError("unsupported_file_content", {}, "never"),
	defineSafeError("malformed_csv_quoting", { line: z.int().min(1) }, "never"),
	// The header names neither first_name nor last_name, or names a column twice.
	defineSafeError("csv_header_invalid", {}, "never"),
	// The uploaded bytes differ from the reviewed file.
	defineSafeError("file_changed", {}, "refresh"),
	// The church's people changed the duplicate findings since the preview.
	defineSafeError("review_stale", {}, "refresh"),
	// The request key already saved a different review.
	defineSafeError("review_digest_conflict", {}, "never"),
	// A retry named no kept copy: the server deleted it 7 days after the import stopped, so the file must be uploaded again.
	defineSafeError("import_file_expired", {}, "never"),
	// The file uploaded again to finish an import is not the file that import used.
	defineSafeError("import_file_mismatch", {}, "never"),
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const file = z.instanceof(Uint8Array);
export const rowNumber = z.int().min(1).max(importLimits.rows);

export const previewImportRequest = z.strictObject({ file });
export const importChoice = z.enum(["skip", "create", "create_and_review"]);
/** The rows and choices the person reviewed. Every valid row has exactly one choice; invalid rows have none. */
export const executeBulkImportRequest = z.strictObject({
	requestKey,
	file,
	fileDigest: sha256,
	reviewDigest: sha256,
	choices: z.array(z.strictObject({ row: rowNumber, choice: importChoice })).max(importLimits.rows),
});
export const importReceiptRequest = z.strictObject({ requestKey });
/**
 * How long the server keeps a failed or partial import's uploaded file after the import last stopped with rows left
 * (D-801). A complete import keeps none.
 */
export const importFileKeptDays = 7;

// The screen's way in (REQ-PPL-018 over the REQ-PPL-014 private-file flow): the browser puts the file once into the
// private bucket with a signed PUT, and the preview and the import each read that stored object on the server.
export const importUploadId = z.uuid();
export const signImportUploadRequest = z.strictObject({ byteLength: z.int().min(1).max(importLimits.bytes) });
export const importUpload = z.strictObject({
	uploadId: importUploadId,
	// The browser PUTs the file's exact bytes to this URL with exactly these headers; it works until expiresAt.
	url: z.url(),
	headers: z.strictObject({
		"content-type": z.literal("text/csv"),
		"if-none-match": z.literal("*"),
		"cache-control": z.literal("private, no-store"),
	}),
	expiresAt: instant,
});
export const previewStoredImportRequest = z.strictObject({ uploadId: importUploadId });
/** The reviewed import of a stored upload: the server reads the object and checks it is the previewed file. */
export const executeStoredImportRequest = executeBulkImportRequest
	.omit({ file: true })
	.extend({ uploadId: importUploadId });
/**
 * "Try N rows again" for the partial import under this request key. Without an upload it uses the server's kept copy
 * (D-802); once that is deleted, the same file uploaded again (D-803), which must be the bytes the import used.
 */
export const retryImportRequest = z.strictObject({ requestKey, uploadId: importUploadId.optional() });

/** A validation problem in one cell, or in the row's shape when column is null. */
export const rowProblem = z.strictObject({
	column: importColumn.nullable(),
	code: z.enum(["name_required", "invalid_email", "too_long", "invalid_source", "column_count"]),
});
const cell = z.string().nullable();
// A parsed row's normalized contact values. Parsing keeps only these keys.
export const importValues = z.object({
	displayName: z.string(),
	firstName: cell,
	lastName: cell,
	email: cell,
	phone: cell,
	street: cell,
	city: cell,
	stateProvince: cell,
	postalCode: cell,
	country: cell,
	source: z.string(),
	sourceDetails: cell,
	summaryNotes: cell,
});
/** Redacted to identity and display name (REQ-PPL-016). */
export const duplicateHint = z.strictObject({ personId, displayName: z.string() });
export const previewRow = z.discriminatedUnion("status", [
	z.strictObject({
		row: rowNumber,
		status: z.literal("valid"),
		values: importValues,
		existingDuplicates: z.array(duplicateHint),
		withinFileDuplicateOf: rowNumber.nullable(),
		suggested: importChoice,
	}),
	z.strictObject({ row: rowNumber, status: z.literal("invalid"), problems: z.array(rowProblem).min(1) }),
]);
export const importPreview = z.strictObject({
	fileDigest: sha256,
	reviewDigest: sha256,
	columns: z.strictObject({ used: z.array(importColumn), ignored: z.array(z.string()) }),
	rows: z.array(previewRow),
	counts: z.strictObject({
		rows: z.int(),
		valid: z.int(),
		invalid: z.int(),
		existingDuplicates: z.int(),
		withinFileDuplicates: z.int(),
	}),
});

export const receiptRow = z.discriminatedUnion("status", [
	z.strictObject({
		row: rowNumber,
		status: z.literal("created"),
		personId,
		// create_and_review: the existing or earlier-row Person this one should be reviewed against.
		reviewWith: personId.nullable(),
	}),
	z.strictObject({ row: rowNumber, status: z.literal("skipped") }),
	z.strictObject({
		row: rowNumber,
		status: z.literal("failed"),
		// row_write_failed: the import job could not write this row. It stays in remaining; a retry tries it again.
		reason: z.enum(["invalid", "row_write_failed"]),
		problems: z.array(rowProblem),
	}),
	// Reviewed for creation and not written yet.
	z.strictObject({ row: rowNumber, status: z.literal("remaining") }),
]);
/**
 * An import's outcome for every row. executeBulkImport saves the reviewed rows and queues a job that writes them;
 * in_progress lasts until the job ends. A retry of a partial import writes only the remaining rows and never creates a
 * row's Person twice. fileKept: the server still holds the uploaded file, so a retry needs no new upload; it is false
 * once the import completes, and importFileKeptDays after a partial import last stopped.
 */
export const importReceipt = z.strictObject({
	importId: z.uuid(),
	status: z.enum(["in_progress", "complete", "partial"]),
	fileKept: z.boolean(),
	rows: z.array(receiptRow),
	remaining: z.array(rowNumber),
	counts: z.strictObject({ created: z.int(), skipped: z.int(), failed: z.int(), remaining: z.int() }),
});

/**
 * The church's most recent people import, found without its request key: the key, when it was saved and its receipt
 * (CLN-05). none: the church has never imported.
 */
export const latestImportReceipt = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({ status: z.literal("available"), requestKey, importedAt: instant, receipt: importReceipt }),
]);

/** The directory's current filters (REQ-PPL-001), without paging or view. */
export const exportPeopleRequest = listPeopleRequest.pick({
	search: true,
	stages: true,
	sources: true,
	tags: true,
	tagOperator: true,
	adultClassification: true,
	commitment: true,
	archived: true,
});
export const csvFile = z.strictObject({
	filename: z.string(),
	mediaType: z.literal("text/csv; charset=utf-8"),
	text: z.string(),
});
export const peopleExport = csvFile.extend({
	// The exact filters, how many people matched and how many rows the bytes contain. Every match is exported.
	receipt: z.strictObject({
		filters: exportPeopleRequest,
		matched: z.int().min(0),
		returned: z.int().min(0),
		completeness: z.enum(["complete", "partial"]),
	}),
});
