import assert from "node:assert/strict";
import { test } from "node:test";
import { viewerZone } from "../../../apps/web/src/components/viewer-zone.ts";

test("BUG-780e84a6b: a forged or unknown ef-zone value gives no zone instead of failing the page", () => {
	assert.equal(viewerZone("America/New_York"), "America/New_York");
	assert.equal(viewerZone("%E0%A4%A"), null);
	assert.equal(viewerZone("America%2FNew_York"), null);
	assert.equal(viewerZone("Mars/Olympus"), null);
	assert.equal(viewerZone(undefined), null);
});
