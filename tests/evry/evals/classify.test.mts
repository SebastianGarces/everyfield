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
	assert.deepEqual(wrong, [], `${cases.length - wrong.length}/${cases.length} correct`);
});
