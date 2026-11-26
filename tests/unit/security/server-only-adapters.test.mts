import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type Case = {
	id: string;
	given: Record<string, { client_import?: string; secret?: string }>;
	action: { arguments: { client_import: string; secret: string } };
	expected: { result: { build_allowed: boolean; secret_in_browser: null } };
};
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB = ROOT + "apps/web";
const { cases } = JSON.parse(readFileSync(ROOT + "docs/acceptance/schema.json", "utf8")) as { cases: Case[] };
const sec01 = cases.find((c) => c.id === "SEC-01") ?? assert.fail("no case SEC-01");
const require = createRequire(WEB + "/package.json");
const swc = require("next/dist/build/swc/index.js") as {
	loadBindings: () => Promise<unknown>;
	transform: (source: string, options: object) => Promise<{ code: string }>;
};
const { getLoaderSWCOptions } = require("next/dist/build/swc/options.js") as {
	getLoaderSWCOptions: (options: object) => object;
};
const { getDefineEnv } = require("next/dist/build/define-env.js") as {
	getDefineEnv: (options: object) => Record<string, unknown>;
};
const loadConfig = (
	require("next/dist/server/config.js") as { default: (phase: string, dir: string) => Promise<object> }
).default;
const { PHASE_PRODUCTION_BUILD } = require("next/constants.js") as { PHASE_PRODUCTION_BUILD: string };

const ADAPTERS = {
	"database-adapter": "apps/web/src/server/database.ts",
	"auth-adapter": "apps/web/src/server/identity/index.ts",
	"auth-library": "packages/domain/src/identity/auth.ts",
	"storage-adapter": "packages/db/src/schema/storage.ts",
	"mail-adapter": "apps/web/src/server/mail/transport.ts",
	"model-adapter": "apps/web/src/server/models.ts",
	"server-config": "apps/web/src/server/config.ts",
	"database-client": "packages/db/src/client.ts",
	"cron-route": "apps/web/src/server/platform/cron.ts",
} as const;
const LAYERS = { browser: "app-pages-browser", ssr: "ssr", server: "rsc" } as const;

async function compile(file: string, layer: (typeof LAYERS)[keyof typeof LAYERS]) {
	const filename = ROOT + file;
	const options = getLoaderSWCOptions({
		filename,
		development: false,
		isServer: layer !== LAYERS.browser,
		appDir: WEB + "/src/app",
		isPageFile: false,
		hasReactRefresh: false,
		bundleLayer: layer,
		serverComponents: true,
		jsConfig: {},
		esm: true,
		pageExtensions: ["tsx", "ts"],
		isCacheComponents: false,
		useCacheEnabled: false,
		taintEnabled: false,
		trackDynamicImports: false,
		serverReferenceHashSalt: "",
		cacheHandlers: {},
		relativeFilePathFromRoot: relative(WEB, filename),
	});
	return swc.transform(readFileSync(filename, "utf8"), { ...options, filename }).then(
		(output) => ({ built: true as const, code: output.code }),
		(error: unknown) => ({ built: false as const, error: String(error) }),
	);
}

test("AC:SEC-01 a client component that imports a protected adapter is refused by the build, and no server secret reaches a browser bundle", async (t) => {
	const { client_import, secret } = sec01.action.arguments;
	const { result } = sec01.expected;
	assert.equal(sec01.given["behavior-inputs"]?.client_import, client_import);
	assert.ok(client_import in ADAPTERS, client_import);
	await swc.loadBindings();

	await t.test("each protected adapter fails to compile into the browser and SSR client graphs", async () => {
		for (const [name, file] of Object.entries(ADAPTERS)) {
			assert.match(readFileSync(ROOT + file, "utf8"), /^import "server-only";$/m, file);
			for (const layer of [LAYERS.browser, LAYERS.ssr]) {
				const out = await compile(file, layer);
				assert.equal(out.built, result.build_allowed, `${name} in ${layer}`);
				assert.match("error" in out ? out.error : "", /depends on "server-only"/, `${name} in ${layer}`);
			}
			const server = await compile(file, LAYERS.server);
			assert.equal(server.built, true, `${name} on the server`);
		}
	});

	await t.test(
		"the database adapter, resolved without the server condition as a browser graph resolves it, throws at load",
		async () => {
			const { client_import: name } = sec01.action.arguments;
			const adapter = ADAPTERS[name as keyof typeof ADAPTERS];
			await assert.rejects(import(ROOT + adapter), /cannot be imported from a Client Component/);
		},
	);

	await t.test("the client bundle defines inline only public names, never a server secret", async () => {
		const names = [
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"IDENTITY_DATABASE_URL",
			"IDENTITY_AUTH_DATABASE_URL",
			"IDENTITY_SECRET",
			"IDENTITY_MAIL_KEY",
			"IDENTITY_ADDRESS_KEY",
			"RESEND_API_KEY",
			"RESEND_WEBHOOK_SECRET",
			"OPENAI_API_KEY",
			"S3_SECRET_ACCESS_KEY",
			"CRON_SECRET",
		];
		const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
		for (const name of names) process.env[name] = secret;
		process.env.NEXT_PUBLIC_SEC01_CONTROL = secret;
		try {
			const config = await loadConfig(PHASE_PRODUCTION_BUILD, WEB);
			const inlined = (isClient: boolean) =>
				getDefineEnv({
					isTurbopack: true,
					config,
					dev: false,
					distDir: ".next",
					projectPath: WEB,
					isClient,
					isEdgeServer: false,
					isNodeServer: !isClient,
					hasRewrites: false,
					omitNonDeterministic: false,
					rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
				});
			const browser = inlined(true);
			assert.equal(browser["process.env.NEXT_PUBLIC_SEC01_CONTROL"], JSON.stringify(secret));
			delete browser["process.env.NEXT_PUBLIC_SEC01_CONTROL"];
			const leaked = Object.entries(browser).find(([, value]) => JSON.stringify(value ?? null).includes(secret));
			assert.equal(leaked ?? null, result.secret_in_browser);
			for (const name of names) assert.equal(Object.hasOwn(browser, `process.env.${name}`), false, name);
		} finally {
			delete process.env.NEXT_PUBLIC_SEC01_CONTROL;
			for (const name of names)
				if (saved[name] === undefined) delete process.env[name];
				else process.env[name] = saved[name];
		}
	});

	await t.test("no source names a public variable that the bundler would inline", () => {
		const sources = ["apps/web/src", "packages/domain/src", "packages/db/src", "packages/evry/src", "packages/ui/src"];
		const found = spawnSync("git", ["grep", "-l", "NEXT_PUBLIC_", "--", ...sources], { cwd: ROOT, encoding: "utf8" });
		assert.deepEqual([found.status, found.stdout], [1, ""]);
	});
});
