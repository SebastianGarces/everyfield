import type { DocumentsError } from "@everyfield/contracts/documents";
import { z } from "zod";
import { rowId } from "../native.ts";
import { EvryRefusal } from "../../context/errors.ts";

export const FILE_FORMAT = { pdf: "PDF", docx: "Word", xlsx: "Excel" } as const;
export const FIELD_SOURCE = {
	church_name: "from the church profile",
	pastor_name: "from the Senior Pastor role",
	launch_date: "from the launch date",
	meeting: "from the meeting",
	override: "your text",
	absent: "missing",
} as const;

const format = z.enum(["pdf", "docx", "xlsx"]);
export const fillInput = z.strictObject({
	templateId: z.string().trim().min(1).max(80).describe("From documents.templates.contextual"),
	format: format.optional(),
	values: z
		.array(z.strictObject({ key: z.string().min(1).max(80), value: z.string().max(2_000) }))
		.max(20)
		.optional()
		.describe("Only values the user gave, by field key"),
	meetingId: rowId.optional().describe("For an agenda template"),
});
export type FillInput = z.infer<typeof fillInput>;

export function fillRequest(input: FillInput, formats: readonly z.infer<typeof format>[]) {
	const chosen = input.format ?? formats[0];
	if (!chosen || !formats.includes(chosen))
		throw new EvryRefusal(
			"invalid_input",
			`This template is made as ${formats.map((f) => FILE_FORMAT[f]).join(" or ")}.`,
		);
	return {
		templateId: input.templateId,
		format: chosen,
		overrides: Object.fromEntries((input.values ?? []).map((v) => [v.key, v.value])),
		...(input.meetingId && { meetingId: input.meetingId }),
	};
}

export function fillRefusal(error: DocumentsError) {
	if (error.code === "invalid_input")
		return new EvryRefusal("invalid_input", error.details.issues.map((i) => `${i.path}: ${i.problem}`).join(" "));
	if (error.code === "invalid_subject") return new EvryRefusal("invalid_subject");
	return new EvryRefusal("source_unavailable");
}
