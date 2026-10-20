import test from "node:test";
import assert from "node:assert/strict";
import {
	exactOrigin,
	safeBoundary,
	safeResponse,
	proofEnabled,
	secretMatches,
	boundedBytes,
} from "../../../apps/web/src/server/platform/boundary.ts";
import { previewText } from "../../../apps/web/src/server/platform/preview.ts";
import { office, pdf } from "./fixtures.mjs";

test("INV-request-boundary: configured origin, constant-time secret, bounded bodies and safe errors", async () => {
	const key = "a".repeat(64);
	assert.equal(secretMatches(key, key), true);
	for (const candidate of [null, "", "b".repeat(64), key + "a"]) assert.equal(secretMatches(candidate, key), false);
	const request = new Request("https://preview.localhost/path", {
		method: "POST",
		headers: { origin: "https://preview.localhost" },
	});
	exactOrigin(request, "https://preview.localhost");
	for (const origin of [null, "https://preview.localhost:4430", "http://preview.localhost", "https://evil.test"]) {
		const h = new Headers();
		if (origin) h.set("Origin", origin);
		assert.throws(() => exactOrigin(new Request(request.url, { headers: h }), "https://preview.localhost"), {
			message: "origin_denied",
		});
	}
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
	const old = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	process.env.PLATFORM_PROOF_SECRET = key;
	try {
		assert.equal(proofEnabled(new Request(request.url, { headers: { "x-platform-proof": key } })), false);
	} finally {
		process.env.NODE_ENV = old;
		delete process.env.PLATFORM_PROOF_SECRET;
	}
});
