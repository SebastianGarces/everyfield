import { z } from "zod";
import { defineSafeError, personId, requestKey } from "../../common/values.ts";
import { instant } from "../../common/time.ts";
import { listPeopleRequest } from "../requests.ts";

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
	defineSafeError("csv_header_invalid", {}, "never"),
	defineSafeError("file_changed", {}, "refresh"),
	defineSafeError("review_stale", {}, "refresh"),
	defineSafeError("review_digest_conflict", {}, "never"),
	defineSafeError("import_file_expired", {}, "never"),
	defineSafeError("import_file_mismatch", {}, "never"),
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const file = z.instanceof(Uint8Array);
export const rowNumber = z.int().min(1).max(importLimits.rows);

export const previewImportRequest = z.strictObject({ file });
export const importChoice = z.enum(["skip", "create", "create_and_review"]);
export const executeBulkImportRequest = z.strictObject({
	requestKey,
	file,
	fileDigest: sha256,
	reviewDigest: sha256,
	choices: z.array(z.strictObject({ row: rowNumber, choice: importChoice })).max(importLimits.rows),
});
export const importReceiptRequest = z.strictObject({ requestKey });
export const importFileKeptDays = 7;

export const importUploadId = z.uuid();
export const signImportUploadRequest = z.strictObject({ byteLength: z.int().min(1).max(importLimits.bytes) });
export const importUpload = z.strictObject({
	uploadId: importUploadId,
	url: z.url(),
	headers: z.strictObject({
		"content-type": z.literal("text/csv"),
		"if-none-match": z.literal("*"),
		"cache-control": z.literal("private, no-store"),
	}),
	expiresAt: instant,
});
export const previewStoredImportRequest = z.strictObject({ uploadId: importUploadId });
export const executeStoredImportRequest = executeBulkImportRequest
	.omit({ file: true })
	.extend({ uploadId: importUploadId });
export const retryImportRequest = z.strictObject({ requestKey, uploadId: importUploadId.optional() });

export const rowProblem = z.strictObject({
	column: importColumn.nullable(),
	code: z.enum(["name_required", "invalid_email", "too_long", "invalid_source", "column_count"]),
});
const cell = z.string().nullable();
export const importValues = z.strictObject({
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
		reviewWith: personId.nullable(),
	}),
	z.strictObject({ row: rowNumber, status: z.literal("skipped") }),
	z.strictObject({
		row: rowNumber,
		status: z.literal("failed"),
		reason: z.enum(["invalid", "row_write_failed"]),
		problems: z.array(rowProblem),
	}),
	z.strictObject({ row: rowNumber, status: z.literal("remaining") }),
]);
export const importReceipt = z.strictObject({
	importId: z.uuid(),
	status: z.enum(["in_progress", "complete", "partial"]),
	fileKept: z.boolean(),
	rows: z.array(receiptRow),
	remaining: z.array(rowNumber),
	counts: z.strictObject({ created: z.int(), skipped: z.int(), failed: z.int(), remaining: z.int() }),
});

export const latestImportReceipt = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({ status: z.literal("available"), requestKey, importedAt: instant, receipt: importReceipt }),
]);

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
	receipt: z.strictObject({
		filters: exportPeopleRequest,
		matched: z.int().min(0),
		returned: z.int().min(0),
		completeness: z.enum(["complete", "partial"]),
	}),
});
