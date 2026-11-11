import test from "node:test";
import assert from "node:assert/strict";
import { safeBoundary, safeResponse, boundedBytes } from "../../../apps/web/src/server/platform/boundary.ts";

test("INV-request-boundary: bounded bodies and safe errors", async () => {
	const request = new Request("https://preview.localhost/path", { method: "POST" });
	assert.equal(
		Buffer.from(await boundedBytes(new Request(request.url, { method: "POST", body: "1234" }), 4)).toString(),
		"1234",
	);
	await assert.rejects(() => boundedBytes(new Request(request.url, { method: "POST", body: "12345" }), 4), {
		message: "invalid_input",
	});
	const response = await safeBoundary(async () => {
		throw new Error("DB-SECRET-CANARY private-care details");
	});
	assert.equal(response.status, 503);
	assert.equal((await response.json()).code, "unavailable");
	const success = await safeBoundary(async () => safeResponse({ revision: "2" }));
	assert.deepEqual(await success.json(), { revision: "2" });
	assert.equal(success.headers.get("cache-control"), "private, no-store");
});
