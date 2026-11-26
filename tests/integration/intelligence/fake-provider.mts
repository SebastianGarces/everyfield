import { AsyncResource } from "node:async_hooks";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
} from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import { scriptedDraft } from "../../../packages/evry-scripted/src/scripted-assessment.ts";

export type Reply = { text: string; usage?: { input: number; output: number } } | Error;

export function fakeProvider(
	reply: (params: LanguageModelV4CallOptions, n: number) => Reply,
	during?: () => Promise<void> | void,
) {
	const requests: LanguageModelV4CallOptions[] = [];
	const hook = during && AsyncResource.bind(during);
	const model: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "fake",
		modelId: "gpt-6-luna",
		supportedUrls: {},
		async doGenerate(params) {
			requests.push(params);
			await hook?.();
			const r = reply(params, requests.length);
			if (r instanceof Error) throw r;
			return {
				content: [{ type: "text", text: r.text }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: r.usage?.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: r.usage?.output, text: undefined, reasoning: undefined },
				},
				warnings: [],
			};
		},
		async doStream() {
			throw Error("the assessment never streams");
		},
	};
	return { model, requests };
}
export const sent = (params: LanguageModelV4CallOptions) => {
	const user = params.prompt.find((m) => m.role === "user")!;
	return JSON.parse((user.content[0] as { text: string }).text);
};
export const grounded = (params: LanguageModelV4CallOptions) => scriptedDraft(sent(params).input);
