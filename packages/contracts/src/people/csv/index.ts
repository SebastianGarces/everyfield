import { z } from "zod";
import { defineSafeError, personId, requestKey } from "../../common/values.ts";
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
export const exportRowLimit = 50_000;

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
	defineSafeError("export_too_large", {}, "never"),
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
		// row_write_failed: this request's batch failed. Its rows stay in remaining and the next request retries them.
		reason: z.enum(["invalid", "row_write_failed"]),
		problems: z.array(rowProblem),
	}),
	// Reviewed for creation and not written yet.
	z.strictObject({ row: rowNumber, status: z.literal("remaining") }),
]);
/**
 * An import's outcome for every row. Each executeBulkImport request writes at most one batch; the caller repeats the same
 * request while remaining is not empty. A repeated request never creates a row's Person twice.
 */
export const importReceipt = z.strictObject({
	importId: z.uuid(),
	status: z.enum(["complete", "partial"]),
	rows: z.array(receiptRow),
	remaining: z.array(rowNumber),
	counts: z.strictObject({ created: z.int(), skipped: z.int(), failed: z.int(), remaining: z.int() }),
});

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
	// The exact filters and row count the bytes contain.
	receipt: z.strictObject({ filters: exportPeopleRequest, count: z.int().min(0) }),
});
