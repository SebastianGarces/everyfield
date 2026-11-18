import assert from "node:assert/strict";
import { test } from "node:test";
import { assessmentsMount } from "../../../apps/web/src/server/jobs/assessment.ts";

const db = {} as never;
const PAID = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" };

test("INV-spend: the assessment job mounts the paid drafter only off production, never with EVRY_SCRIPTED_MODEL=1", () => {
	const cases: [string, Record<string, string | undefined>, string | null][] = [
		["local, paid", PAID, "gpt-6-luna"],
		["development, paid", { ...PAID, VERCEL_ENV: "development" }, "gpt-6-luna"],
		["preview, paid", { ...PAID, VERCEL_ENV: "preview" }, "gpt-6-luna"],
		["local, paid and scripted", { ...PAID, EVRY_SCRIPTED_MODEL: "1" }, "assessment-scripted"],
		["preview, paid and scripted", { ...PAID, VERCEL_ENV: "preview", EVRY_SCRIPTED_MODEL: "1" }, "assessment-scripted"],
		[
			"development, paid and scripted",
			{ ...PAID, VERCEL_ENV: "development", EVRY_SCRIPTED_MODEL: "1" },
			"assessment-scripted",
		],
		["local, scripted", { EVRY_SCRIPTED_MODEL: "1" }, "assessment-scripted"],
		["local, neither", {}, "assessment-scripted"],
		["preview, neither", { VERCEL_ENV: "preview" }, "assessment-scripted"],
		["local, key without a model", { OPENAI_API_KEY: PAID.OPENAI_API_KEY }, "assessment-scripted"],
		["local, an unapproved model", { ...PAID, EVRY_MODEL: "gpt-6" }, "assessment-scripted"],
		["local, an invalid cap", { ...PAID, EVRY_MONTHLY_CAP_USD: "-1" }, "assessment-scripted"],
		["production, paid", { ...PAID, VERCEL_ENV: "production" }, null],
		["production, scripted", { EVRY_SCRIPTED_MODEL: "1", VERCEL_ENV: "production" }, null],
		["production, neither", { VERCEL_ENV: "production" }, null],
		["an unknown environment", { ...PAID, VERCEL_ENV: "staging" }, null],
	];
	for (const [name, env, drafter] of cases) assert.equal(assessmentsMount(db, env)?.drafter.id ?? null, drafter, name);
	assert.equal(assessmentsMount(null, PAID)?.drafter.id, "assessment-scripted", "no job database, no paid drafter");
});
