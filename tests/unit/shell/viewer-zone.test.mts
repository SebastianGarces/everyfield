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

test("AC: the send window bounds read the viewer's wall clock in the viewer's zone, whatever zone renders them", async () => {
	const { windowBounds } = await import("../../../apps/web/src/features/communication/scheduleWindow.ts");
	const now = Date.UTC(2026, 10, 20, 3, 5);
	assert.deepEqual(windowBounds(now, "America/Chicago"), { min: "2026-11-19T21:05", max: "2026-12-19T21:05" });
	assert.deepEqual(windowBounds(now, "Asia/Tokyo"), { min: "2026-11-20T12:05", max: "2026-12-20T12:05" });
	assert.deepEqual(windowBounds(Date.UTC(2026, 10, 20, 0, 0), "UTC"), {
		min: "2026-11-20T00:00",
		max: "2026-12-20T00:00",
	});
});
