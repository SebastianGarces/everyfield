import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const loaded: string[] = [];
registerHooks({
	load: (url, context, next) => {
		if (url.includes("/packages/evry-scripted/")) loaded.push(url);
		return next(url, context);
	},
});

const { assessmentDrafter, evryModel } = await import("../../../apps/web/src/server/models.ts");

const db = {} as never;
const PAID = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" };
const SCRIPTED = { EVRY_SCRIPTED_MODEL: "1" };

test("INV-spend: production never loads the scripted package, and gets the paid model or none and no assessments", async () => {
	const cases: [string, Record<string, string | undefined>, string | null][] = [
		["production, neither", { VERCEL_ENV: "production" }, null],
		["production, scripted", { ...SCRIPTED, VERCEL_ENV: "production" }, null],
		["production, paid", { ...PAID, VERCEL_ENV: "production" }, "gpt-6-luna"],
		["production, paid and scripted", { ...PAID, ...SCRIPTED, VERCEL_ENV: "production" }, "gpt-6-luna"],
	];
	for (const [name, env, model] of cases) {
		const selected = await evryModel(env);
		assert.equal(selected.status === "qualified" ? selected.id : null, model, name);
		assert.equal(await assessmentDrafter(db, env), null, name);
	}
	assert.deepEqual([...loaded], []);

	const local = await evryModel(SCRIPTED);
	assert.equal(local.status === "qualified" ? local.id : null, "evry-scripted");
	assert.ok(loaded.some((url) => url.endsWith("/packages/evry-scripted/src/index.ts")));
});
