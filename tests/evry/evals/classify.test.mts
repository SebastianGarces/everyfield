// The evry.classifyRequest eval: labelled requests (classify.cases.json) scored against the real model's recorded
// answers (classify.recorded.json). A recording is keyed by the exact call the provider receives, so a changed prompt,
// reasoning level or output limit has no recording and fails here until it is scored again on the real model:
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/classify.test.mts
//
// Recording makes one small paid call per case (about 20 millionths of a dollar each, G-SPEND).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { classifyRequest, type RequestKind } from "../../../packages/evry/src/context/compile.ts";
import { selectQualifiedModel } from "../../../packages/evry/src/runtime/model.ts";

const CASES = new URL("classify.cases.json", import.meta.url);
const RECORDED = new URL("classify.recorded.json", import.meta.url);
type Recorded = { model: string; recordedAt: string; answers: Record<string, string> };

const cases: { kind: RequestKind; text: string }[] = JSON.parse(readFileSync(CASES, "utf8"));
const record = process.env.EVRY_EVAL_RECORD === "1";
const recorded: Recorded = record
	? { model: process.env.EVRY_MODEL ?? "", recordedAt: new Date().toISOString(), answers: {} }
	: JSON.parse(readFileSync(RECORDED, "utf8"));

/** What the provider observes of one call: a different value is a different call. */
const callKey = ({ prompt, reasoning, maxOutputTokens, responseFormat, providerOptions }: LanguageModelV4CallOptions) =>
	createHash("sha256")
		.update(JSON.stringify({ prompt, reasoning, maxOutputTokens, responseFormat, providerOptions }))
		.digest("hex")
		.slice(0, 16);

function evalModel(): LanguageModelV4 {
	if (record) {
		const real = selectQualifiedModel({ ...process.env, EVRY_SCRIPTED_MODEL: "" });
		if (real.status !== "qualified") throw Error("Recording needs EVRY_MODEL and OPENAI_API_KEY");
		return {
			...real.model,
			async doGenerate(options) {
				const result = await real.model.doGenerate(options);
				recorded.answers[callKey(options)] = result.content
					.flatMap((c) => (c.type === "text" ? [c.text] : []))
					.join("");
				return result;
			},
		};
	}
	const missing = (): never => {
		throw Error("The classify call changed: record and score it again (see the top of this file)");
	};
	return {
		specificationVersion: "v4",
		provider: "recorded",
		modelId: recorded.model,
		supportedUrls: {},
		async doGenerate(options) {
			const text = recorded.answers[callKey(options)] ?? missing();
			return {
				content: [{ type: "text", text }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 0, text: 0, reasoning: 0 },
				},
				warnings: [],
			};
		},
		doStream: missing,
	};
}

test("AC:INH-EDGES-10 AC:INH-REGRESSION-CAPABILITIES evry.classifyRequest labels every request of the eval set, including records that mention prayer", async () => {
	assert.ok(cases.length >= 20);
	assert.deepEqual(
		[...new Set(cases.map((c) => c.kind))].sort(),
		["application", "capabilities", "pastoral_boundary"],
		"every kind is scored",
	);
	assert.ok(
		cases.some((c) => c.kind === "application" && /pray/i.test(c.text)),
		"records that mention prayer",
	);
	const model = evalModel();
	const got: RequestKind[] = [];
	for (const c of cases) got.push((await classifyRequest(model, c.text, AbortSignal.timeout(30_000))).kind);
	if (record) writeFileSync(RECORDED, JSON.stringify(recorded, null, "\t") + "\n");
	const wrong = cases.flatMap((c, i) => (got[i] === c.kind ? [] : [`${c.text} -> ${got[i]}`]));
	// The rubric is every label: a pastoral request scored as application would reach the tools, and a record that
	// mentions prayer scored as pastoral would refuse ordinary work.
	assert.deepEqual(wrong, [], `${cases.length - wrong.length}/${cases.length} correct`);
});
