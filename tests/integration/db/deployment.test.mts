import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT, EMBEDDING, RECORD, recorded, UNVERIFIED } from "../../evry/runtime/provider.mts";
import {
	EMBEDDING_PATH,
	evryAvailable,
	isProduction,
	isTestDeployment,
	providerAllowed,
	providerVerified,
	runsOffVercel,
	trustsVercelForwardedFor,
} from "../../../packages/db/src/deployment.ts";

test("INV-deployment: each guard opens only where it should, and an unrecognized VERCEL_ENV fails closed", () => {
	const rows: [string | undefined, boolean, boolean, boolean][] = [
		[undefined, false, true, true],
		["development", false, true, false],
		["preview", false, true, false],
		["production", true, false, false],
		["Production", false, false, false],
		["staging", false, false, false],
		["", false, false, false],
	];
	for (const [named, production, test, local] of rows)
		for (const vercel of [undefined, "1", "0"]) {
			const env = { VERCEL_ENV: named, VERCEL: vercel };
			const label = `VERCEL_ENV=${String(named)} VERCEL=${String(vercel)}`;
			assert.equal(isProduction(env), production, `isProduction ${label}`);
			assert.equal(isTestDeployment(env), test, `isTestDeployment ${label}`);
			assert.equal(runsOffVercel(env), local, `runsOffVercel ${label}`);
			assert.equal(trustsVercelForwardedFor(env), vercel === "1", `trustsVercelForwardedFor ${label}`);
		}
});

test("INV-provider: only a complete, dated, redacted record that names the exact path verifies it", () => {
	const now = new Date("2026-10-12T00:00:00Z");
	for (const path of [CHAT, EMBEDDING]) assert.equal(providerVerified(recorded(RECORD), path, now), true);
	for (const [name, record] of UNVERIFIED) assert.equal(providerVerified(recorded(record), CHAT, now), false, name);
	for (const raw of [undefined, "", "{", "enrolled", JSON.stringify(RECORD) + " ".repeat(4_000)])
		assert.equal(providerVerified({ AI_PROVIDER_RECORD: raw }, CHAT, now), false, String(raw).slice(0, 20));
	assert.equal(providerVerified(recorded(RECORD), CHAT, new Date("2026-10-11T23:59:59Z")), false, "dated after today");
	assert.equal(providerVerified(recorded({ ...RECORD, paths: [CHAT] }), EMBEDDING, now), false);
	assert.deepEqual({ ...EMBEDDING_PATH }, EMBEDDING);
});

test("INV-provider: a test deployment needs no record, and every other kind needs one", () => {
	const verified = { EVRY_MODEL: CHAT.model, AI_PROVIDER_RECORD: JSON.stringify(RECORD) };
	for (const named of [undefined, "development", "preview"])
		assert.deepEqual(
			[providerAllowed({ VERCEL_ENV: named }, CHAT), evryAvailable({ VERCEL_ENV: named })],
			[true, true],
		);
	for (const named of ["production", "Production", "staging", ""]) {
		const env = { EVRY_MODEL: CHAT.model, OPENAI_API_KEY: "sk-test-not-a-key", VERCEL_ENV: named };
		assert.deepEqual(
			[providerAllowed(env, CHAT), providerAllowed(env, EMBEDDING), evryAvailable(env)],
			[false, false, false],
		);
		assert.equal(evryAvailable({ ...env, ...verified }), true, named);
	}
});
