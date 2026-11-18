import assert from "node:assert/strict";
import { test } from "node:test";
import { selectQualifiedModel } from "../../../packages/evry/src/runtime/model.ts";

const SCRIPTED = { EVRY_SCRIPTED_MODEL: "1" };
const PAID = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" };

test("INV-spend: the Evry turn picks the scripted model only off Vercel, on any Vercel environment never", () => {
	const cases: [string, Record<string, string | undefined>, string | null][] = [
		["local, scripted", SCRIPTED, "evry-scripted"],
		["local, paid and scripted", { ...PAID, ...SCRIPTED }, "evry-scripted"],
		["local, paid", PAID, "gpt-6-luna"],
		["local, neither", {}, null],
		...["production", "preview", "development", "staging"].flatMap(
			(vercel): [string, Record<string, string | undefined>, string | null][] => [
				[`${vercel}, scripted`, { ...SCRIPTED, VERCEL_ENV: vercel }, null],
				[`${vercel}, paid and scripted`, { ...PAID, ...SCRIPTED, VERCEL_ENV: vercel }, "gpt-6-luna"],
			],
		),
	];
	for (const [name, env, model] of cases) {
		const selected = selectQualifiedModel(env);
		assert.equal(selected.status === "qualified" ? selected.id : null, model, name);
	}
});
