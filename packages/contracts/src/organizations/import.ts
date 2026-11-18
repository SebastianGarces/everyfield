import { z } from "zod";
import { personId, recordId } from "../common/values.ts";

export const pipelineImportLimits = { bytes: 5 * 1024 * 1024, rows: 2000, columns: 200 } as const;

export const pipelineColumnChoice = z.enum(["name", "email", "stage", "answer", "skip"]);
export type PipelineColumnChoice = z.infer<typeof pipelineColumnChoice>;

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
const columns = z.array(pipelineColumnChoice).max(pipelineImportLimits.columns);

export const pipelineImportPreviewRequest = z.strictObject({ fileName, file, columns: columns.nullable() });

export const pipelineImportPreview = z.strictObject({
	fileName: z.string(),
	fileDigest: z.string(),
	reviewDigest: z.string(),
	columns: z.array(
		z.strictObject({
			title: z.string(),
			choice: pipelineColumnChoice,
			locked: z.boolean(),
		}),
	),
	rows: z.array(
		z.strictObject({
			row: z.int().min(1),
			status: z.enum(["ready", "invalid", "duplicate"]),
			name: z.string().nullable(),
			email: z.string().nullable(),
			stageId: recordId.nullable(),
			problems: z.array(pipelineImportRowProblem),
			existing: z.array(z.strictObject({ personId, name: z.string() })),
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
	skipped: z.array(z.int().min(1)),
	refused: z.array(z.strictObject({ row: z.int().min(1), problems: z.array(pipelineImportRowProblem) })),
});
export type PipelineImportResult = z.infer<typeof pipelineImportResult>;

export const pipelineImportRefusal = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("unavailable") }),
	z.strictObject({ code: z.literal("invalid_input"), field: z.string().optional() }),
	z.strictObject({ code: z.literal("file_refused"), problem: pipelineImportFileProblem }),
	z.strictObject({ code: z.literal("file_changed") }),
	z.strictObject({ code: z.literal("review_stale") }),
	z.strictObject({ code: z.literal("conflict") }),
]);
export type PipelineImportRefusal = z.infer<typeof pipelineImportRefusal>;
