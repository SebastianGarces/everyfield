import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { settleConfirm } = await import("../../../packages/ui/src/controls/index.ts");

const FIXED = "The action did not finish. Try again.";

test("INV-privacy: a confirm dialog closes on success, shows a returned refusal's copy, and the fixed copy for anything thrown", async () => {
	assert.equal(await settleConfirm(() => {}), null);
	assert.equal(await settleConfirm(async () => undefined), null);
	assert.equal(
		await settleConfirm(async () => ({ refused: "The connection dropped. Nothing was deleted." })),
		"The connection dropped. Nothing was deleted.",
	);
	assert.equal(
		await settleConfirm(() => ({ refused: "Save the message before you send it." })),
		"Save the message before you send it.",
	);
	assert.equal(await settleConfirm(async () => ({ refused: "" })), FIXED);
	for (const unexpected of [
		new Error("internal detail the viewer must not read"),
		new TypeError("Cannot read properties of undefined (reading 'revision')"),
		Object.assign(new Error("refused"), { refused: "Looks like a refusal" }),
		"a thrown string",
		undefined,
	]) {
		assert.equal(
			await settleConfirm(async () => {
				throw unexpected;
			}),
			FIXED,
		);
		assert.equal(
			await settleConfirm(() => {
				throw unexpected;
			}),
			FIXED,
		);
	}
});
