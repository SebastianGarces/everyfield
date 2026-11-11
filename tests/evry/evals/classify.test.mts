// The evry.classifyRequest eval: labelled requests (classify.cases.json) scored against the real model's recorded
// answers (classify.recorded.json). A recording is keyed by the exact call the provider receives, so a changed prompt,
// reasoning level or output limit has no recording and fails here until it is scored again on the real model:
//
//   EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/classify.test.mts
//
// Recording makes one small paid call per case (about 20 millionths of a dollar each, G-SPEND).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyRequest, type RequestKind } from "../../../packages/evry/src/context/compile.ts";
import { recorder } from "./golden-harness.mts";

const CASES = new URL("classify.cases.json", import.meta.url);
const cases: { kind: RequestKind; text: string }[] = JSON.parse(readFileSync(CASES, "utf8"));
const recorded = recorder("classify");

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
	const model = recorded.model();
	const got: RequestKind[] = [];
	for (const c of cases) got.push((await classifyRequest(model, c.text, AbortSignal.timeout(30_000))).kind);
	recorded.save();
	const wrong = cases.flatMap((c, i) => (got[i] === c.kind ? [] : [`${c.text} -> ${got[i]}`]));
	// The rubric is every label: a pastoral request scored as application would reach the tools, and a record that
	// mentions prayer scored as pastoral would refuse ordinary work.
	assert.deepEqual(wrong, [], `${cases.length - wrong.length}/${cases.length} correct`);
});
