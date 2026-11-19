import assert from "node:assert/strict";
import { existsSync, globSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const ORIGIN = "https://app.everyfield.test";
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];
process.env.IDENTITY_ORIGIN = ORIGIN;

const withExtension = (path: string) =>
	[path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile()) ??
	path;
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
		if (specifier.startsWith("@/"))
			return next(pathToFileURL(withExtension(join(SRC, specifier.slice(2)))).href, context);
		if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.\w+$/.test(specifier))
			return next(
				pathToFileURL(withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier))).href,
				context,
			);
		try {
			return next(specifier, context);
		} catch {
			return next(`${specifier}.js`, context);
		}
	},
});

const { ROUTE_KIND, mutatingRoute } = await import("../../../apps/web/src/server/platform/boundary.ts");
const routes = await Promise.all(
	globSync("app/**/route.ts", { cwd: SRC }).map(async (file) => ({
		file,
		module: (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>,
	})),
);
const writes = routes.flatMap(({ file, module }) =>
	WRITES.filter((method) => method in module).map((method) => ({
		at: `${method} ${file}`,
		handler: module[method] as ((request: Request, context: unknown) => Promise<Response>) & { [ROUTE_KIND]?: string },
		method,
	})),
);
const context = {
	params: Promise.resolve({ id: "x", token: "x", documentId: "x", accountId: "x", versionId: "x", path: ["x"] }),
};
const request = (method: string, headers: Record<string, string>) =>
	new Request(`${ORIGIN}/api/x`, { method, headers: { "content-type": "application/json", ...headers }, body: "{}" });

test("INV-security: every route that writes is built with a route wrapper that names how it is authenticated", () => {
	assert.ok(writes.length >= 25, `only ${writes.length} write handlers found`);
	const unwrapped = writes.filter((w) => !["session", "token", "signed"].includes(w.handler[ROUTE_KIND] ?? ""));
	assert.deepEqual(
		unwrapped.map((w) => w.at),
		[],
	);
	assert.deepEqual(
		writes
			.filter((w) => w.handler[ROUTE_KIND] !== "session")
			.map((w) => `${w.at} ${w.handler[ROUTE_KIND]}`)
			.sort(),
		[
			"POST app/(product)/email-preferences/[token]/one-click/route.ts token",
			"POST app/(product)/unsubscribe/[token]/one-click/route.ts token",
			"POST app/api/webhooks/resend/route.ts signed",
		],
	);
});

test("INV-security: a session route refuses a write from another site or of unknown origin before it runs", async () => {
	const refused: Record<string, string>[] = [
		{ "sec-fetch-site": "cross-site", origin: ORIGIN },
		{ "sec-fetch-site": "same-site", origin: ORIGIN },
		{ "sec-fetch-site": "none" },
		{ origin: "https://evil.test" },
		{ origin: `${ORIGIN}.evil.test` },
		{ origin: "null" },
		{},
	];
	for (const w of writes.filter((w) => w.handler[ROUTE_KIND] === "session"))
		for (const headers of refused) {
			const response = await w.handler(request(w.method, headers), context);
			assert.equal(response.status, 403, `${w.at} ${JSON.stringify(headers)}`);
			assert.deepEqual(await response.json(), { code: "origin_denied" }, w.at);
		}
});

test("INV-security: the session guard passes a same-origin fetch, or an exact Origin when the browser sends no fetch metadata", async () => {
	const seen: string[] = [];
	const guarded = mutatingRoute(async (incoming: Request) => {
		seen.push(incoming.headers.get("x-case") ?? "");
		return new Response(null, { status: 204 });
	});
	const cases: [string, Record<string, string>, number][] = [
		["same-origin", { "sec-fetch-site": "same-origin" }, 204],
		["same-origin, other Origin", { "sec-fetch-site": "same-origin", origin: "https://evil.test" }, 204],
		["no metadata, own Origin", { origin: ORIGIN }, 204],
		["cross-site, own Origin", { "sec-fetch-site": "cross-site", origin: ORIGIN }, 403],
		["no metadata, no Origin", {}, 403],
	];
	for (const [name, headers, status] of cases)
		assert.equal((await guarded(request("POST", { ...headers, "x-case": name }))).status, status, name);
	assert.deepEqual(seen, ["same-origin", "same-origin, other Origin", "no metadata, own Origin"]);
});
