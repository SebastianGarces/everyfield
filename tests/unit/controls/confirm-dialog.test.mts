import assert from "node:assert/strict";
import { test } from "node:test";

const { ConfirmRefused, confirmProblem } = await import("../../../packages/ui/src/controls/index.ts");

const FIXED = "The action did not finish. Try again.";

test("INV-privacy: a confirm dialog shows a refusal's own copy, and the fixed copy for any other error", () => {
	assert.equal(
		confirmProblem(new ConfirmRefused("The connection dropped. Nothing was deleted.")),
		"The connection dropped. Nothing was deleted.",
	);
	for (const unexpected of [
		new Error("internal detail the viewer must not read"),
		new TypeError("Cannot read properties of undefined (reading 'revision')"),
		Object.assign(new Error("refused"), { copy: "Looks like a refusal" }),
		new ConfirmRefused(""),
		"a thrown string",
		undefined,
	])
		assert.equal(confirmProblem(unexpected), FIXED);
});
