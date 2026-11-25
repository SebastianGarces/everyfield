import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

process.env.EVRY_EVAL_RECORD = "1";
const { callKey, recorder } = await import("./golden-harness.mts");

const FIELD = "reasoningEncryptedContent";
const turn = (openai: Record<string, string | null>): LanguageModelV4CallOptions => ({
	prompt: [
		{ role: "user", content: [{ type: "text", text: "Who is new?" }] },
		{ role: "assistant", content: [{ type: "reasoning", text: "", providerOptions: { openai } }] },
	],
	providerOptions: { openai },
});

test("callKey ignores reasoningEncryptedContent and nothing else, and leaves the call unchanged", () => {
	const absent = callKey(turn({ itemId: "rs_1" }));
	for (const value of ["one", "another", "", null]) {
		const options = turn({ itemId: "rs_1", [FIELD]: value });
		const before = structuredClone(options);
		assert.equal(callKey(options), absent);
		assert.deepEqual(options, before);
	}
	const call = turn({ itemId: "rs_1" });
	const others: LanguageModelV4CallOptions[] = [
		turn({ itemId: "rs_2" }),
		{ ...call, prompt: call.prompt.slice(0, 1) },
		{ ...call, tools: [{ type: "function", name: "read", inputSchema: {} }] },
		{ ...call, toolChoice: { type: "none" } },
		{ ...call, reasoning: "low" },
		{ ...call, maxOutputTokens: 1 },
		{ ...call, responseFormat: { type: "json" } },
		{ ...call, providerOptions: { openai: { itemId: "rs_2" } } },
	];
	assert.equal(new Set([absent, ...others.map(callKey)]).size, others.length + 1);
});

test("a recording run saves everything but reasoningEncryptedContent, and passes the call and the stream through unchanged", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "evry-recorder-"));
	t.after(() => rmSync(dir, { recursive: true }));
	const usage = {
		inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 3, text: 3, reasoning: 0 },
	};
	const parts = (blob: boolean): LanguageModelV4StreamPart[] => {
		const meta = (value: string | null) => ({ openai: { itemId: "rs_1", ...(blob && { [FIELD]: value }) } });
		return [
			{ type: "reasoning-start", id: "r", providerMetadata: meta(null) },
			{ type: "reasoning-delta", id: "r", delta: "Think", providerMetadata: meta("") },
			{ type: "reasoning-end", id: "r", providerMetadata: meta("blob-stream") },
			{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage, providerMetadata: meta("blob-finish") },
		];
	};
	const content = (blob: boolean) => ({
		type: "text" as const,
		text: "Two people.",
		providerMetadata: { openai: { itemId: "msg_1", deep: [{ kept: true, ...(blob && { [FIELD]: "blob-text" }) }] } },
	});
	const given: LanguageModelV4CallOptions[] = [];
	const stub: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "stub",
		modelId: "stub",
		supportedUrls: {},
		async doGenerate(options) {
			given.push(options);
			return { content: [content(true)], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
		},
		async doStream(options) {
			given.push(options);
			return {
				stream: new ReadableStream({ start: (c) => (parts(true).forEach((part) => c.enqueue(part)), c.close()) }),
			};
		},
	};
	const price = { input: 1, output: 1, longContextAbove: 1_000_000 };
	const file = join(dir, "stub");
	const recorded = recorder(pathToFileURL(file).href, () => ({
		status: "qualified",
		id: "stub",
		model: stub,
		spend: { price, capMicroUsd: 1_000_000 },
	}));
	const keys: string[] = [];
	const model = recorded.model(keys);
	const streamed = turn({ itemId: "rs_0", [FIELD]: "blob-earlier" });
	const generated = { ...streamed, maxOutputTokens: 5 };
	const before = structuredClone([streamed, generated]);

	assert.deepEqual(await Array.fromAsync((await model.doStream(streamed)).stream), parts(true));
	assert.deepEqual((await model.doGenerate(generated)).content, [content(true)]);
	assert.ok(given[0] === streamed && given[1] === generated, "the provider gets the call itself");
	assert.deepEqual(given, before);

	recorded.save();
	const text = readFileSync(`${file}.recorded.json`, "utf8");
	assert.ok(!text.includes(FIELD));
	assert.deepEqual(JSON.parse(text).calls, {
		[keys[0]!]: { kind: "stream", parts: parts(false), usage: { input: 7, output: 3 } },
		[keys[1]!]: { kind: "generate", content: [content(false)], usage: { input: 7, output: 3 } },
	});
});

test("no recording holds reasoningEncryptedContent", () => {
	const files = readdirSync(import.meta.dirname).filter((name) => name.endsWith(".recorded.json"));
	assert.ok(files.length >= 5);
	assert.deepEqual(
		files.filter((name) => readFileSync(join(import.meta.dirname, name), "utf8").includes(FIELD)),
		[],
	);
});
