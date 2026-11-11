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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stepCountIs, streamText } from "../../../packages/evry/node_modules/ai/dist/index.js";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { compileContext } from "../../../packages/evry/src/context/compile.ts";
import { LIMITS } from "../../../packages/evry/src/context/limits.ts";
import { readTools } from "../../../packages/evry/src/runtime/tools.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { recorder } from "./golden-harness.mts";

type Case = {
	text: string;
	operation: string;
	alsoAccepted?: string[];
	noSearch?: boolean;
	rubric?: Record<string, string>;
};
const CASES = new URL("households.cases.json", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(CASES, "utf8"));
const recorded = recorder("households");

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
	const model = recorded.model();
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
	recorded.save();
	assert.ok(answered >= 1, "the answer rubric is scored");
	assert.deepEqual(failures, []);
});
