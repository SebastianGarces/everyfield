import { randomUUID } from "node:crypto";
import type { QualifiedModel } from "../../../packages/evry/src/index.ts";
import type {
	LanguageModelV4,
	LanguageModelV4StreamPart,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";

export type Call = { tool: string; input: { operation: string; input: unknown } };
export function probing(calls: Call[], offered: string[], prompts: string[]): QualifiedModel {
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	let asked = false;
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "test",
		modelId: "probing",
		supportedUrls: {},
		doGenerate: async () => ({
			content: [{ type: "text", text: JSON.stringify({ kind: "application" }) }],
			finishReason: { unified: "stop", raw: undefined },
			usage,
			warnings: [],
		}),
		async doStream(options) {
			const results = JSON.stringify(
				options.prompt.flatMap((m): unknown[] =>
					m.role === "tool"
						? m.content.flatMap((part) => ("output" in part ? [part.output] : []))
						: m.role === "system"
							? [m.content]
							: [],
				),
			);
			prompts.push(JSON.stringify([options.prompt, options.tools]));
			offered.push(...(options.tools ?? []).map((t) => t.name));
			const parts: LanguageModelV4StreamPart[] = asked
				? [
						{ type: "text-start", id: "t" },
						{ type: "text-delta", id: "t", delta: results },
						{ type: "text-end", id: "t" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
					]
				: [
						...calls.map((c) => ({
							type: "tool-call" as const,
							toolCallId: randomUUID(),
							toolName: c.tool,
							input: JSON.stringify(c.input),
						})),
						{ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
					];
			asked = true;
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
	return { status: "qualified", id: "probing", model };
}
