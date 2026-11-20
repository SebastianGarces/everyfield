import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
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
const configure = (env: {
	FLAGS_SECRET?: string;
	VERCEL_ENV?: string;
	VERCEL?: string;
	VERCEL_PROJECT_ID?: string;
}) => {
	for (const name of ["FLAGS_SECRET", "VERCEL_ENV", "VERCEL", "VERCEL_PROJECT_ID"]) delete process.env[name];
	Object.assign(process.env, env);
};

const project = "prj_qa_preview";
const onVercel = (VERCEL_ENV: string) => ({ VERCEL: "1", VERCEL_PROJECT_ID: project, VERCEL_ENV });
const kms = generateKeyPairSync("ec", { namedCurve: "P-256" });
const kid = "test-key";
const vercelFetch = globalThis.fetch;
globalThis.fetch = async (input, init) =>
	String(input).startsWith("https://kms.vercel.com/")
		? Response.json({ keys: [{ ...kms.publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }] })
		: vercelFetch(input, init);
const issuers = {
	"flags-discovery": "https://kms.vercel.com/d0efbb30-566d-48b6-b173-0062e54ec49c",
	"flag-overrides": "https://kms.vercel.com/64af96a2-ba60-42ef-91af-459fcef6f864",
};
const vercelSigned = (
	purpose: keyof typeof issuers,
	claims: Record<string, unknown> = {},
	scope: { projectIds: string[]; environments: string[] } = { projectIds: [project], environments: ["preview"] },
) => {
	const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const iat = Math.floor(Date.now() / 1000);
	const body = `${part({ alg: "ES256", kid, typ: "JWT" })}.${part({
		iss: issuers[purpose],
		aud: `vercel:${purpose}`,
		iat,
		exp: iat + 60,
		pur: purpose,
		ver: 1,
		scope,
		...claims,
	})}`;
	return `${body}.${sign("sha256", Buffer.from(body), { key: kms.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
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

test("the discovery route answers 404 in production with or without FLAGS_SECRET, and off Vercel with no FLAGS_SECRET", async () => {
	configure({ FLAGS_SECRET: secret, VERCEL_ENV: "production" });
	assert.equal((await discover(`Bearer ${await createAccessProof(secret)}`)).status, 404);
	configure(onVercel("production"));
	assert.equal(
		(
			await discover(
				`Bearer ${vercelSigned("flags-discovery", {}, { projectIds: [project], environments: ["production"] })}`,
			)
		).status,
		404,
	);
	configure({});
	assert.equal((await discover(`Bearer ${await createAccessProof(secret)}`)).status, 404);
});

test("on a Vercel preview with no FLAGS_SECRET the discovery route lists every registry flag for a Vercel-signed token, and refuses others", async () => {
	configure(onVercel("preview"));
	assert.equal((await discover()).status, 401);
	assert.equal((await discover(`Bearer ${await createAccessProof(secret)}`)).status, 401);
	const forged = vercelSigned("flags-discovery").replace(/\.[^.]+$/, `.${randomBytes(64).toString("base64url")}`);
	assert.equal((await discover(`Bearer ${forged}`)).status, 401, "a token with a signature Vercel did not make");
	const ok = await discover(`Bearer ${vercelSigned("flags-discovery")}`);
	assert.equal(ok.status, 200);
	const body = (await ok.json()) as { definitions: Record<string, unknown> };
	assert.deepEqual(Object.keys(body.definitions).sort(), Object.keys(registry).sort());
});

test("on a Vercel preview with no FLAGS_SECRET a Vercel-signed override cookie forces the flag and changes no feature_flag row", async () => {
	configure(onVercel("preview"));
	state.flagCookie = vercelSigned("flag-overrides", { overrides: { "overview-role-subtitle": true } });
	assert.equal(await readFlag("overview-role-subtitle"), true);
	assert.ok(
		state.flagStatements.every((q) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(q)),
		state.flagStatements.join("\n"),
	);
	state.flagCookie = await forcedOn();
	assert.equal(await readFlag("overview-role-subtitle"), false, "a FLAGS_SECRET cookie is ignored without the secret");
});

test("production ignores a Vercel-signed override cookie", async () => {
	configure(onVercel("production"));
	state.flagCookie = vercelSigned(
		"flag-overrides",
		{ overrides: { "overview-role-subtitle": true } },
		{ projectIds: [project], environments: ["production"] },
	);
	assert.equal(await readFlag("overview-role-subtitle"), false);
});
