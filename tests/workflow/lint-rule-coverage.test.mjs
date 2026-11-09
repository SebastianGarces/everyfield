// T-43: Oxlint runs ahead of ESLint and takes the rules it has. No rule that was on in the old ESLint configs
// (tests/workflow/lint-rules-baseline.json) may end up in neither tool.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baselineFile, coverage } from "../../scripts/lint-rule-coverage.mjs";

const missing = (result) =>
	Object.entries(result).flatMap(([pkg, rows]) =>
		rows.filter((r) => r.tool === "missing").map((r) => `${pkg}: ${r.rule}`),
	);

test("T-43: every rule on in the old ESLint configs is enforced by Oxlint or ESLint", async () => {
	const result = await coverage();
	assert.deepEqual(missing(result), [], "rules on before Oxlint that neither tool enforces now");
	for (const [pkg, rows] of Object.entries(result)) assert.ok(rows.length > 0, `${pkg} has no baseline rules`);
});

test("T-43: a baseline rule that neither tool has is reported missing", async () => {
	const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
	baseline["packages/db"] = { ...baseline["packages/db"], "no-debugger": { severity: "error", options: [] } };
	baseline["apps/web"] = { ...baseline["apps/web"], "react-hooks/gating": { severity: "error", options: [{}] } };
	const reported = missing(await coverage(baseline));
	for (const rule of ["apps/web: react-hooks/gating", "packages/db: no-debugger"])
		assert.ok(reported.includes(rule), rule);
});
