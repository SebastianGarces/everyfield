import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

export type Row = { id: string; label: string; fields: Record<string, unknown> };
export type Output = Record<string, unknown> & { rows?: Row[]; facts?: Record<string, unknown> };
export type Content = LanguageModelV4Content[];

export const call = (toolName: string, input: unknown): Content => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
export const say = (text: string): Content => [{ type: "text", text }];
export const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });

export function turnOf(options: LanguageModelV4CallOptions) {
	const tools = JSON.stringify(options.tools ?? []);
	const start = options.prompt.findLastIndex((m) => m.role === "user");
	const outputs = options.prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
	return {
		offers: (operation: string) => tools.includes(`"${operation}"`),
		last: outputs.at(-1),
		of: (operation: string) => outputs.findLast((o) => o.operation === operation),
	};
}

export function refusedText(last: Output) {
	return typeof last.problem === "string" ? last.problem : `I couldn't prepare that (${String(last.error)}).`;
}
