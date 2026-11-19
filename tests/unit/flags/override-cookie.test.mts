import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const fake = (source: string) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
const stored = { name: "overview-role-subtitle", scope: "workspace", value: true };
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only") return fake("");
		if (specifier === "next/headers")
			return fake(`const cookies = new Map([["vercel-flag-overrides", { name: "vercel-flag-overrides", value: "x" }]]);
export const headers = async () => new Headers({ cookie: "vercel-flag-overrides=x" });
export const cookies = async () => ({ get: (n) => cookies.get(n), getAll: () => [...cookies.values()] });`);
		if (specifier === "./database")
			return fake(
				`export const requestDatabase = () => ({ execute: async () => ({ rows: [${JSON.stringify(stored)}] }) });`,
			);
		if (specifier === "./request-context") return fake(`export const getViewer = async () => null;`);
		return next(specifier, context);
	},
});

test("a request carrying a vercel-flag-overrides cookie still reads the stored flag value, with no FLAGS_SECRET", async () => {
	delete process.env.FLAGS_SECRET;
	const { readFlag } = await import("../../../apps/web/src/server/flags.ts");
	assert.equal(await readFlag("overview-role-subtitle"), true);
});
