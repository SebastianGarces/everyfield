// The assessment evaluation's real-model opt-in (D92): without ASSESSMENT_EVAL_REAL_MODEL=1 it stays scripted; with it,
// it needs the approved paid model and the shared development database, and refuses production and the scripted switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentHosts } from "../../../packages/db/src/development.ts";
import { realModelOptIn } from "../../integration/intelligence/real-model.mts";

const dev = `postgres://u:p@${[...developmentHosts][0]}/neondb`;
const REAL = {
	ASSESSMENT_EVAL_REAL_MODEL: "1",
	EVRY_MODEL: "gpt-6-luna",
	OPENAI_API_KEY: "sk-test-not-a-key",
	DATABASE_URL: dev,
};

test("INV-spend: the real-model evaluation runs only by opt-in, on the shared development database, never on production", () => {
	assert.equal(
		realModelOptIn({ EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk", DATABASE_URL: dev }),
		null,
		"no opt-in, scripted",
	);
	assert.equal(realModelOptIn({ ...REAL, ASSESSMENT_EVAL_REAL_MODEL: "true" }), null, "only 1 opts in");
	const opted = realModelOptIn(REAL);
	assert.equal(opted?.meterUrl.hostname, [...developmentHosts][0]);
	assert.equal(opted?.meterUrl.searchParams.get("sslmode"), "verify-full");
	const refusals: [string, Record<string, string | undefined>, RegExp][] = [
		["production", { ...REAL, VERCEL_ENV: "production" }, /never on production/],
		["scripted switch", { ...REAL, EVRY_SCRIPTED_MODEL: "1" }, /EVRY_SCRIPTED_MODEL=1/],
		[
			"another host",
			{ ...REAL, DATABASE_URL: "postgres://u:p@ep-other-host.neon.tech/neondb" },
			/shared development database/,
		],
		[
			"CI's localhost",
			{ ...REAL, DATABASE_URL: "postgres://ci:ci@localhost:5432/everyfield_ci" },
			/shared development database/,
		],
		["no database", { ...REAL, DATABASE_URL: undefined }, /shared development database/],
		["no key", { ...REAL, OPENAI_API_KEY: undefined }, /OPENAI_API_KEY/],
		["another model", { ...REAL, EVRY_MODEL: "gpt-6" }, /gpt-6-luna/],
	];
	for (const [name, env, why] of refusals) assert.throws(() => realModelOptIn(env), why, name);
});
