import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS_UNREAD, outcomeText, unread } from "../../../apps/web/src/features/communication/model.ts";

test("a failed or lost address read shows Maya's line with no error code or other try-again text", () => {
	assert.equal(ADDRESS_UNREAD, "We couldn't load your church's address.");
	assert.ok(!/try again/i.test(ADDRESS_UNREAD));
	for (const status of ["failed", "lost"] as const) assert.equal(unread({ status }), true, status);
});

test("a loaded or refused address read is not offered a retry and keeps its own line", () => {
	assert.equal(unread(undefined), false);
	assert.equal(unread({ status: "ok", value: null }), false);
	const denied = { status: "refused", code: "access_denied" } as const;
	assert.equal(unread(denied), false);
	assert.equal(outcomeText(denied), "An Owner or Admin seat is required to change messages.");
});
