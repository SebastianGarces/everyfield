import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT, EMBEDDING, RECORD, UNVERIFIED } from "./provider.mts";
import { evryModel } from "../../../apps/web/src/server/models.ts";

const SCRIPTED = { EVRY_SCRIPTED_MODEL: "1" };
const PAID = { EVRY_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-test-not-a-key" };

test("INV-spend: the Evry turn picks the scripted model only off Vercel, on any Vercel environment never", async () => {
	const cases: [string, Record<string, string | undefined>, string | null][] = [
		["local, scripted", SCRIPTED, "evry-scripted"],
		["local, paid and scripted", { ...PAID, ...SCRIPTED }, "evry-scripted"],
		["local, paid", PAID, "gpt-6-luna"],
		["local, neither", {}, null],
		...["production", "preview", "development", "staging", ""].flatMap(
			(vercel): [string, Record<string, string | undefined>, string | null][] => [
				[`${vercel}, scripted`, { ...SCRIPTED, VERCEL_ENV: vercel }, null],
				[
					`${vercel}, paid and scripted`,
					{ ...PAID, ...SCRIPTED, VERCEL_ENV: vercel },
					["preview", "development"].includes(vercel) ? "gpt-6-luna" : null,
				],
			],
		),
	];
	for (const [name, env, model] of cases) {
		const selected = await evryModel(env);
		assert.equal(selected.status === "qualified" ? selected.id : null, model, name);
	}
});

test("INV-provider: production and an unrecognized kind select the paid model only with a verified record, read at each selection", async () => {
	const named = JSON.stringify(RECORD);
	const status = async (env: Record<string, string | undefined>) => {
		const selected = await evryModel(env);
		return selected.status === "unavailable" ? selected : selected.status;
	};
	const blocked = { status: "unavailable", releaseGate: "blocked" };
	for (const VERCEL_ENV of ["production", "Production", "staging", ""]) {
		const env = { ...PAID, VERCEL_ENV };
		assert.deepEqual(await status(env), blocked, `${VERCEL_ENV}, no record`);
		for (const [name, record] of UNVERIFIED)
			assert.deepEqual(
				await status({ ...env, AI_PROVIDER_RECORD: JSON.stringify(record) }),
				blocked,
				`${VERCEL_ENV}, ${name}`,
			);
		assert.equal(await status({ ...env, AI_PROVIDER_RECORD: named }), "qualified", `${VERCEL_ENV}, verified`);
		const other = JSON.stringify({ ...RECORD, paths: [{ ...CHAT, model: "gpt-6-sol" }, EMBEDDING] });
		assert.deepEqual(await status({ ...env, AI_PROVIDER_RECORD: other }), blocked);
		assert.deepEqual(await status({ VERCEL_ENV, EVRY_MODEL: "gpt-6-luna", AI_PROVIDER_RECORD: named }), {
			status: "unavailable",
		});
		assert.deepEqual(await status({ VERCEL_ENV, AI_PROVIDER_RECORD: named }), blocked, "a record alone names no model");
	}
	for (const VERCEL_ENV of [undefined, "development", "preview"]) {
		assert.equal(await status({ ...PAID, VERCEL_ENV }), "qualified", `${VERCEL_ENV}, no record`);
		assert.equal(await status({ ...PAID, VERCEL_ENV, AI_PROVIDER_RECORD: "claimed" }), "qualified");
		assert.deepEqual(await status({ VERCEL_ENV }), { status: "unavailable" });
	}
});
