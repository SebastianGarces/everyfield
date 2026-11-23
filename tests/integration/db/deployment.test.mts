import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isProduction,
	isTestDeployment,
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
