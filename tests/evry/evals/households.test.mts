// The household evals: labelled requests (households.cases.json) scored against the real model's recorded streams
// (households.recorded.json). The model gets Evry's real system prompt and read tools; each read is answered from the
// fixture below (one household, "Okafor household" in North Ridgeville OH, James Okafor as Head and Ruth Allen as
// Spouse). A recording is keyed by the exact call the provider receives, so a changed prompt, tool list or limit has no
// recording and fails here until it is scored again on the real model:
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/households.test.mts
//
// Recording makes a few small paid calls (G-SPEND, approved by Sebastian on Oct 31 4:02 PM ET). CI replays the file.
//   AC:EVRY-CONTEXT-BOUNDS tool selection: each request picks the household operation of its case, with sensible input.
//   Answer correctness: the answer to "what households do we have?" names the household, says there is 1 and does not
//   say a row was withheld or is unavailable. The rubric scores each point.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stepCountIs, streamText } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { compileContext } from "../../../packages/evry/src/context/compile.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { selectQualifiedModel } from "../../../packages/evry/src/runtime/model.ts";
import { readTools } from "../../../packages/evry/src/runtime/tools.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";

type Case = {
	text: string;
	operation: string;
	alsoAccepted?: string[];
	noSearch?: boolean;
	rubric?: Record<string, string>;
};
type Recorded = { model: string; recordedAt: string; streams: Record<string, LanguageModelV4StreamPart[]> };
const CASES = new URL("households.cases.json", import.meta.url);
const RECORDED = new URL("households.recorded.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const record = process.env.EVRY_EVAL_RECORD === "1";
const recorded: Recorded = record
	? { model: process.env.EVRY_MODEL ?? "", recordedAt: new Date().toISOString(), streams: {} }
	: JSON.parse(readFileSync(RECORDED, "utf8"));

const PLANT = "5b6d1f0e-0000-4000-8000-000000000001";
const HOUSEHOLD = "5b6d1f0e-0000-4000-8000-0000000000a1";
const JAMES = "5b6d1f0e-0000-4000-8000-0000000000b1";
const RUTH = "5b6d1f0e-0000-4000-8000-0000000000b2";
// A plant Owner, the only fields the catalog and the prompt read.
const actor = {
	authority: {} as never,
	accountId: randomUUID(),
	session: randomUUID(),
	owner: { kind: "plant", id: PLANT },
	contextKind: "plant",
	role: "owner",
	seatId: null,
} as unknown as EvryActor;
const NOW = new Date("2026-10-31T20:00:00Z");

const household = {
	kind: "household",
	id: HOUSEHOLD,
	label: "Okafor household",
	fields: { name: "Okafor household", city: "North Ridgeville", memberCount: "2", revision: "1" },
};
const james = {
	kind: "person",
	id: JAMES,
	label: "James Okafor",
	fields: { role: "head", city: "North Ridgeville", householdId: HOUSEHOLD },
};
const ruth = {
	kind: "person",
	id: RUTH,
	label: "Ruth Allen",
	fields: { role: "spouse", city: "North Ridgeville", householdId: HOUSEHOLD },
};
const result = (operation: string, rows: object[]) => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
});
/** What the reads return for the fixture, in the shape the model gets (a resultId first). */
function answerRead(operation: string, input: any, resultId: number) {
	const home = [household, james, ruth];
	const rows =
		operation === "people.listHouseholds"
			? [household]
			: operation === "people.getHousehold" || operation === "people.getHouseholdMembers"
				? input?.householdId === HOUSEHOLD || input?.personId === JAMES || input?.personId === RUTH
					? home
					: []
				: operation === "people.listPeople"
					? [james, ruth].filter(
							(p) => !input?.search || p.label.toLowerCase().includes(String(input.search).toLowerCase()),
						)
					: [];
	return { resultId, ...result(operation, rows) };
}

/** What the provider observes of one call: a different value is a different call. */
const callKey = ({
	prompt,
	tools,
	toolChoice,
	reasoning,
	maxOutputTokens,
	providerOptions,
}: LanguageModelV4CallOptions) =>
	createHash("sha256")
		.update(JSON.stringify({ prompt, tools, toolChoice, reasoning, maxOutputTokens, providerOptions }))
		.digest("hex")
		.slice(0, 16);

function evalModel(): LanguageModelV4 {
	if (record) {
		const real = selectQualifiedModel({ ...process.env, EVRY_SCRIPTED_MODEL: "" });
		if (real.status !== "qualified") throw Error("Recording needs EVRY_MODEL and OPENAI_API_KEY");
		return {
			...real.model,
			async doStream(options) {
				const out = await real.model.doStream(options);
				const parts: LanguageModelV4StreamPart[] = [];
				recorded.streams[callKey(options)] = parts;
				return {
					...out,
					stream: out.stream.pipeThrough(
						new TransformStream({
							transform(part, controller) {
								parts.push(part);
								controller.enqueue(part);
							},
						}),
					),
				};
			},
		};
	}
	const missing = (): never => {
		throw Error("A household eval call changed: record and score it again (see the top of this file)");
	};
	return {
		specificationVersion: "v4",
		provider: "recorded",
		modelId: recorded.model,
		supportedUrls: {},
		doGenerate: missing,
		async doStream(options) {
			const parts = recorded.streams[callKey(options)] ?? missing();
			return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
		},
	};
}

/** One request, as the runtime asks it: the real system prompt and read tools, up to four model steps. */
async function converse(model: LanguageModelV4, text: string) {
	const calls: { operation: string; input: any }[] = [];
	let n = 0;
	const tools = readTools(actor, async (adapter, input) => {
		calls.push({ operation: adapter.operation, input });
		return answerRead(adapter.operation, input, ++n);
	});
	const context = compileContext({ actor, catalog: readCatalog(actor), history: [], text, references: [], now: NOW });
	const run = streamText({
		model,
		system: context.system,
		messages: context.messages,
		tools,
		stopWhen: stepCountIs(4),
		maxRetries: 0,
		maxOutputTokens: LIMITS.outputTokensPerCall,
		onError: () => undefined,
	});
	return { calls, answer: await run.text };
}

test("AC:EVRY-CONTEXT-BOUNDS household requests pick the household operation with sensible input, and the answer is correct", async () => {
	assert.ok(cases.length >= 4);
	const model = evalModel();
	const failures: string[] = [];
	let answered = 0;
	for (const c of cases) {
		const { calls, answer } = await converse(model, c.text);
		const ops = calls.map((x) => x.operation);
		const accepted = [c.operation, ...(c.alsoAccepted ?? [])];
		if (!ops.some((op) => accepted.includes(op))) failures.push(`${c.text}: called ${ops.join(", ") || "nothing"}`);
		for (const call of calls.filter((x) => accepted.includes(x.operation))) {
			if (c.noSearch && call.input?.search)
				failures.push(`${c.text}: searched for ${JSON.stringify(call.input.search)}`);
			if (/get(Household|HouseholdMembers)$/.test(call.operation)) {
				const id = call.input?.householdId ?? call.input?.personId;
				if (![HOUSEHOLD, JAMES, RUTH].includes(id))
					failures.push(`${c.text}: ${call.operation} with ${JSON.stringify(call.input)}`);
			}
		}
		if (c.rubric) {
			answered++;
			// The scored points of the answer to "what households do we have?".
			const points = {
				namesHousehold: /Okafor/.test(answer),
				saysCount:
					/\b(1|one|single)\b[^.\n]{0,20}\bhousehold\b|\bhousehold\b[^.\n]{0,20}\b(1|one)\b|\bonly one\b/i.test(answer),
				notWithheld: !/withheld|unavailable|no longer available|not available|couldn't|could not|missing/i.test(answer),
			};
			for (const [point, ok] of Object.entries(points))
				if (!ok) failures.push(`${c.text}: rubric ${point} failed in "${answer}"`);
		}
	}
	if (record) writeFileSync(RECORDED, JSON.stringify(recorded, null, "\t") + "\n");
	assert.ok(answered >= 1, "the answer rubric is scored");
	assert.deepEqual(failures, []);
});
