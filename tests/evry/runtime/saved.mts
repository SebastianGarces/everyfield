import { z } from "../../../packages/evry/node_modules/zod/index.js";

const savedRow = z.looseObject({
	kind: z.string(),
	id: z.string(),
	label: z.string(),
	fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const toolResult = z.looseObject({
	operation: z.string(),
	input: z.unknown(),
	result: z.looseObject({
		operation: z.string(),
		status: z.enum(["available", "not_found"]),
		rows: z.array(savedRow),
		total: z.number().nullable(),
		next: z.number().nullable(),
		completeness: z.enum(["complete", "partial"]),
		withheldRows: z.number().optional(),
		proposalId: z.string().optional(),
	}),
	originalTotal: z.number().nullable().optional(),
});
export type ToolResult = z.infer<typeof toolResult>;
export const assistantText = z.looseObject({ text: z.string(), withheld: z.boolean().optional() });
export const runStatus = z.looseObject({
	state: z.string(),
	reason: z.string(),
	usage: z
		.looseObject({ inputTokens: z.number(), toolCalls: z.number(), costMicroUsd: z.number().optional() })
		.optional(),
	error: z.looseObject({ code: z.string(), retry: z.string() }).optional(),
});
