import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const webServer = new URL("../../../apps/web/src/server/flags.ts", import.meta.url).href;
const fake = (source: string) => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true });
const state = globalThis as typeof globalThis & {
	flagCookie: string;
	flagRows: { name: string; scope: string; value: boolean }[];
	flagStatements: string[];
};
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only") return fake("");
		if (specifier === "next/headers")
			return fake(`const jar = () => new Map([["vercel-flag-overrides", { name: "vercel-flag-overrides", value: globalThis.flagCookie }]]);
export const headers = async () => new Headers({ cookie: "vercel-flag-overrides=" + globalThis.flagCookie });
export const cookies = async () => ({ get: (n) => jar().get(n), getAll: () => [...jar().values()] });`);
		if (specifier === "./database")
			return fake(
				`export const requestDatabase = () => ({ execute: async (query) => { globalThis.flagStatements.push(JSON.stringify(query)); return { rows: globalThis.flagRows }; } });`,
			);
		if (specifier === "./request-context") return fake(`export const getViewer = async () => null;`);
		if (specifier === "./config") return next("./config.ts", context);
		if (specifier === "flags") return next(specifier, { ...context, parentURL: webServer });
		return next(specifier, context);
	},
});

const sdk: {
	createAccessProof(secret: string): Promise<string>;
	encryptOverrides(overrides: Record<string, boolean>, secret: string): Promise<string>;
} = await import("flags" as string);
const { createAccessProof, encryptOverrides } = sdk;
const { flagsDiscovery, readFlag } = await import("../../../apps/web/src/server/flags.ts");
const { registry } = await import("../../../packages/domain/src/flags/registry.ts");

const secret = randomBytes(32).toString("base64url");
const configure = (env: { FLAGS_SECRET?: string; VERCEL_ENV?: string }) => {
	delete process.env.FLAGS_SECRET;
	delete process.env.VERCEL_ENV;
	Object.assign(process.env, env);
};

beforeEach(() => {
	configure({});
	state.flagCookie = "x";
	state.flagRows = [];
	state.flagStatements = [];
});

const forcedOn = () => encryptOverrides({ "overview-role-subtitle": true }, secret);

test("a request carrying a vercel-flag-overrides cookie still reads the stored flag value, with no FLAGS_SECRET", async () => {
	state.flagRows = [{ name: "overview-role-subtitle", scope: "workspace", value: true }];
	assert.equal(await readFlag("overview-role-subtitle"), true);
	state.flagCookie = await forcedOn();
	state.flagRows = [];
	assert.equal(await readFlag("overview-role-subtitle"), false);
});

test("on a preview with FLAGS_SECRET an encrypted override cookie forces the flag on and changes no feature_flag row", async () => {
	state.flagCookie = await forcedOn();
	for (const env of [{ VERCEL_ENV: "preview" }, {}]) {
		configure({ FLAGS_SECRET: secret, ...env });
		state.flagStatements = [];
		assert.equal(await readFlag("overview-role-subtitle"), true);
		assert.ok(
			state.flagStatements.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(q)),
			state.flagStatements.join("\n"),
		);
	}
});

test("the override cookie is ignored in production even with FLAGS_SECRET set, and a cookie under another key is ignored", async () => {
	state.flagCookie = await forcedOn();
	configure({ FLAGS_SECRET: secret, VERCEL_ENV: "production" });
	assert.equal(await readFlag("overview-role-subtitle"), false);
	configure({ FLAGS_SECRET: randomBytes(32).toString("base64url"), VERCEL_ENV: "preview" });
	assert.equal(await readFlag("overview-role-subtitle"), false, "a cookie made with another secret is ignored");
});

const discover = (authorization?: string) =>
	flagsDiscovery(
		new Request("https://preview.invalid/.well-known/vercel/flags", {
			headers: authorization ? { Authorization: authorization } : {},
		}) as never,
	);

test("the Flags Explorer discovery route lists every registry flag for a valid access proof, and refuses without one", async () => {
	configure({ FLAGS_SECRET: secret, VERCEL_ENV: "preview" });
	assert.equal((await discover()).status, 401);
	assert.equal((await discover("Bearer not-a-proof")).status, 401);
	assert.equal(
		(await discover(`Bearer ${await createAccessProof(randomBytes(32).toString("base64url"))}`)).status,
		401,
	);
	const ok = await discover(`Bearer ${await createAccessProof(secret)}`);
	assert.equal(ok.status, 200);
	const body = (await ok.json()) as { definitions: Record<string, { defaultValue: boolean; options: unknown[] }> };
	assert.deepEqual(Object.keys(body.definitions).sort(), Object.keys(registry).sort());
	assert.equal(body.definitions["overview-role-subtitle"]!.defaultValue, false);
	assert.deepEqual(body.definitions["overview-role-subtitle"]!.options, [
		{ value: false, label: "Off" },
		{ value: true, label: "On" },
	]);
});

test("the discovery route answers 404 in production and on a deployment with no FLAGS_SECRET", async () => {
	configure({ FLAGS_SECRET: secret, VERCEL_ENV: "production" });
	assert.equal((await discover(`Bearer ${await createAccessProof(secret)}`)).status, 404);
	configure({ VERCEL_ENV: "preview" });
	assert.equal((await discover(`Bearer ${await createAccessProof(secret)}`)).status, 404);
});
