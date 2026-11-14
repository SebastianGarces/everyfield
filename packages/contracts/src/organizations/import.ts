import { z } from "zod";
import { personId, recordId } from "../common/values.ts";

// Importing pipeline people from a file (T-363): a plain CSV or the Excel export of a network's own application form.
// Columns match pipeline fields by their title, never their position; an answer that matches no field is kept on the
// person's record as one note. The server reads the file itself for the preview and again for the import; a body names
// only choices, never parsed rows.

/** A pipeline is a short list: these bound one file. */
export const pipelineImportLimits = { bytes: 5 * 1024 * 1024, rows: 2000, columns: 200 } as const;

/**
 * What one column becomes: a pipeline field, an answer kept in the imported note, or nothing. A field takes at most one
 * column. `stage` names each row's stage by its label.
 */
export const pipelineColumnChoice = z.enum(["name", "email", "stage", "answer", "skip"]);
export type PipelineColumnChoice = z.infer<typeof pipelineColumnChoice>;

/** Why a file was refused before any row was read. */
export type PipelineImportFileProblem = z.infer<typeof pipelineImportFileProblem>;
export const pipelineImportFileProblem = z.enum([
	"file_type",
	"file_empty",
	"file_too_large",
	"file_unreadable",
	"no_header",
	"no_rows",
	"row_limit",
	"column_limit",
]);
/** Why one row cannot be imported. */
export const pipelineImportRowProblem = z.enum([
	"name_required",
	"name_too_long",
	"invalid_email",
	"unknown_stage",
	"answers_too_long",
	"column_count",
]);

const fileName = z.string().trim().min(1).max(255);
const file = z.instanceof(Uint8Array);
/** The columns in file order, one choice each; null asks for the remembered or default match of each title. */
const columns = z.array(pipelineColumnChoice).max(pipelineImportLimits.columns);

export const pipelineImportPreviewRequest = z.strictObject({ fileName, file, columns: columns.nullable() });

export const pipelineImportPreview = z.strictObject({
	fileName: z.string(),
	/** The file's bytes, which the import must match. */
	fileDigest: z.string(),
	/** The duplicate findings the person reviewed; the import is refused when the pipeline changed them since. */
	reviewDigest: z.string(),
	columns: z.array(
		z.strictObject({
			title: z.string(),
			choice: pipelineColumnChoice,
			/** A background-check question (REQ-PPL-002): always skipped, never kept or matched. */
			locked: z.boolean(),
		}),
	),
	rows: z.array(
		z.strictObject({
			/** 1 is the first row after the header. */
			row: z.int().min(1),
			status: z.enum(["ready", "invalid", "duplicate"]),
			name: z.string().nullable(),
			email: z.string().nullable(),
			/** The stage a Stage column names; null goes to the stage chosen for everyone. */
			stageId: recordId.nullable(),
			problems: z.array(pipelineImportRowProblem),
			/** Pipeline people with the same email. */
			existing: z.array(z.strictObject({ personId, name: z.string() })),
			/** Other rows of this file with the same email. */
			sameAs: z.array(z.int().min(1)),
		}),
	),
	counts: z.strictObject({
		rows: z.int().min(0),
		ready: z.int().min(0),
		invalid: z.int().min(0),
		duplicates: z.int().min(0),
	}),
});
export type PipelineImportPreview = z.infer<typeof pipelineImportPreview>;

/**
 * The reviewed import. The browser names `importId` once per reviewed import, so a repeat (a double click or a retry)
 * adds no one again. Every possible duplicate row is decided by the person: skip it or add it anyway (REQ-MUL-017).
 */
export const pipelineImportRequest = z.strictObject({
	importId: z.uuid(),
	fileName,
	file,
	fileDigest: z.string().min(1).max(128),
	reviewDigest: z.string().min(1).max(128),
	columns,
	stageId: recordId,
	responsibleSeatId: recordId.nullable(),
	duplicates: z
		.array(z.strictObject({ row: z.int().min(1), choice: z.enum(["skip", "add"]) }))
		.max(pipelineImportLimits.rows),
});

export const pipelineImportResult = z.strictObject({
	added: z.array(z.strictObject({ row: z.int().min(1), personId })),
	/** Possible duplicates the person chose to skip. */
	skipped: z.array(z.int().min(1)),
	refused: z.array(z.strictObject({ row: z.int().min(1), problems: z.array(pipelineImportRowProblem) })),
});
export type PipelineImportResult = z.infer<typeof pipelineImportResult>;

export const pipelineImportRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("file_refused"), problem: pipelineImportFileProblem }),
	/** The uploaded bytes are not the file the person reviewed. */
	z.strictObject({ code: z.literal("file_changed") }),
	/** The pipeline's possible duplicates changed since the preview. */
	z.strictObject({ code: z.literal("review_stale") }),
	/** The same import id was used for a different reviewed import. */
	z.strictObject({ code: z.literal("conflict") }),
]);
export type PipelineImportRefusal = z.infer<typeof pipelineImportRefusal>;
