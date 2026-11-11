// T-159 (com-23): a draft update that leaves out its subject keeps the stored one. Only null or blank clears it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftInput } from "../../../packages/contracts/src/communication/values.ts";

test("T-159: a draft input with no subject parses to no subject, so the stored one stays", () => {
	const parsed = draftInput.parse({ bodyHtml: "<p>Hi</p>" });
	assert.equal(parsed.subject, undefined);
	assert.equal("subject" in parsed, false);
});

test("T-159: null and blank subjects clear it, and text is trimmed", () => {
	assert.equal(draftInput.parse({ subject: null }).subject, null);
	assert.equal(draftInput.parse({ subject: "   " }).subject, null);
	assert.equal(draftInput.parse({ subject: "  Welcome  " }).subject, "Welcome");
	assert.equal(draftInput.safeParse({ subject: "x".repeat(501) }).success, false);
});
