import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "../../../../packages/db/src/query.ts";
import { setServerEnv } from "../../../support/server-env.mts";

const SRC = fileURLToPath(new URL("../../../../apps/web/src/", import.meta.url));
const web = createRequire(new URL("../../../../apps/web/package.json", import.meta.url));
const { RequestCookies } = web("next/dist/compiled/@edge-runtime/cookies") as {
	RequestCookies: new (headers: Headers) => object;
};

const react = web("react") as { createElement: (type: unknown, props: object) => unknown };
(globalThis as { React?: unknown }).React = react;
export const element = (type: unknown, props: object) => react.createElement(type, props);

type Held = { headers: Headers; cookies: object };
const current = new AsyncLocalStorage<Held>();
const holder = Symbol.for("everyfield.tests.security.request");
(globalThis as { [holder]?: () => Held })[holder] = () => {
	const held = current.getStore();
	if (!held) throw Error("no simulated request");
	return held;
};
const STUB = `const held = () => globalThis[Symbol.for("everyfield.tests.security.request")]();
export const headers = async () => held().headers;
export const cookies = async () => held().cookies;
export const draftMode = async () => ({ isEnabled: false });`;

const FLIGHT = web.resolve("next/dist/compiled/react-server-dom-webpack/server.node.js");
const CLIENT = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*["']use client["']/;
const EXPORTED = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
function exportsOf(text: string) {
	const names = new Set([...text.matchAll(EXPORTED)].map((m) => m[1]!));
	for (const [, list] of text.matchAll(/export\s*\{([^}]*)\}/g))
		for (const part of list!.split(","))
			names.add(
				part
					.trim()
					.split(/\s+as\s+/)
					.at(-1)!
					.trim(),
			);
	for (const [, name] of text.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(name!);
	for (const [, name] of text.matchAll(/Object\.defineProperty\(exports,\s*"([A-Za-z_$][\w$]*)"/g)) names.add(name!);
	for (const [, block] of text.matchAll(/_export\(exports,\s*\{([\s\S]*?)\n\}\);/g))
		for (const [, name] of block!.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*function/gm)) names.add(name!);
	names.delete("");
	names.delete("__esModule");
	if (/export\s+default\b|exports\.default\s*=/.test(text)) names.add("default");
	return [...names];
}
function clientReferences(url: string, text: string) {
	const lines = exportsOf(text).map((name) => {
		const ref = `registerClientReference(function () { throw Error("client component on the server"); }, ${JSON.stringify(url)}, ${JSON.stringify(name)})`;
		return name === "default" ? `export default ${ref};` : `export const ${name} = ${ref};`;
	});
	return `import flight from ${JSON.stringify(pathToFileURL(FLIGHT).href)};\nconst { registerClientReference } = flight;\n${lines.join("\n")}`;
}

const withExtension = (path: string) =>
	[path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile()) ??
	path;
const SERVER_LAYER: Record<string, string> = {
	"next/navigation": "next/dist/api/navigation.react-server.js",
	"next/link": "next/dist/client/app-dir/link.js",
	"next/error": "next/dist/api/error.react-server.js",
};
registerHooks({
	resolve: (specifier, context, next) => {
		const layered = SERVER_LAYER[specifier];
		if (layered) return { url: pathToFileURL(web.resolve(layered)).href, shortCircuit: true };
		if (specifier === "next/headers")
			return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true };
		if (specifier.startsWith("@/"))
			return next(pathToFileURL(withExtension(join(SRC, specifier.slice(2)))).href, context);
		if (
			specifier.startsWith(".") &&
			context.parentURL?.startsWith(pathToFileURL(SRC).href) &&
			!/\.\w+$/.test(specifier)
		)
			return next(
				pathToFileURL(withExtension(join(dirname(fileURLToPath(context.parentURL)), specifier))).href,
				context,
			);
		return next(specifier, context);
	},
	load: (url, context, next) => {
		if (!url.startsWith("file:") || !/\.(?:[cm]?[jt]sx?)$/.test(url)) return next(url, context);
		const text = readFileSync(fileURLToPath(url), "utf8");
		if (!CLIENT.test(text)) return next(url, context);
		return { format: "module", source: clientReferences(url, text), shortCircuit: true };
	},
});

export function inRequest<T>(init: { cookie?: string; headers?: Record<string, string> }, run: () => Promise<T>) {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("cookie", init.cookie);
	return current.run({ headers, cookies: new RequestCookies(headers) }, run);
}

export const appModule = <T,>(path: string): Promise<T> => import(pathToFileURL(withExtension(join(SRC, path))).href);

export async function closeAppPools() {
	const pools = (globalThis as { [k: symbol]: Map<string, { $client: { end(): Promise<void> } }> | undefined })[
		Symbol.for("everyfield.web.pools")
	];
	if (!pools) return;
	await Promise.all([...pools.values()].map((db) => db.$client.end()));
	pools.clear();
}

const manifest = new Proxy(
	{},
	{ get: (_, key: string) => ({ id: key.split("#")[0], chunks: [], name: key.split("#")[1] ?? "*" }) },
);
export async function flight(model: unknown): Promise<string> {
	const { renderToPipeableStream } = web(FLIGHT) as {
		renderToPipeableStream: (
			model: unknown,
			map: object,
			options?: object,
		) => { pipe: (w: NodeJS.WritableStream) => void };
	};
	const { PassThrough } = await import("node:stream");
	const out = new PassThrough();
	const chunks: Buffer[] = [];
	out.on("data", (c: Buffer) => chunks.push(c));
	const done = new Promise((resolve) => out.on("end", resolve));
	const errors: string[] = [];
	renderToPipeableStream(model, manifest, { onError: (e: unknown) => void errors.push(String(e)) }).pipe(out);
	await done;
	return Buffer.concat(chunks).toString("utf8") + errors.join("\n");
}

export const APP_SECRET = "security-cases-secret-".padEnd(48, "x");
export function useApp(databaseUrl: string) {
	setServerEnv({
		IDENTITY_ORIGIN: APP_ORIGIN,
		IDENTITY_DATABASE_URL: databaseUrl,
		IDENTITY_AUTH_DATABASE_URL: databaseUrl,
		IDENTITY_SECRET: APP_SECRET,
	});
}
export const APP_ORIGIN = "https://app.everyfield.test";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }> };
export async function appCookie(admin: Executor, session: string) {
	await admin.execute(sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '30 days' WHERE id=${session}`);
	const [row] = (await admin.execute(sql`SELECT token FROM auth_session WHERE id=${session}`)).rows;
	const token = String(row?.token);
	const { requestAuth } = await appModule<{
		requestAuth: () => { $context: Promise<{ secret: string; authCookies: { sessionToken: { name: string } } }> };
	}>("server/identity/index.ts");
	const auth = await requestAuth().$context;
	const signature = createHmac("sha256", auth.secret).update(token).digest("base64");
	return `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

const SSR = fileURLToPath(new URL("./security-ssr.mts", import.meta.url));
const TSX = createRequire(new URL("../../../../packages/domain/package.json", import.meta.url)).resolve("tsx/esm");
const WEB_TSCONFIG = fileURLToPath(new URL("../../../../apps/web/tsconfig.json", import.meta.url));
export async function html(element: { type: { $$id?: string }; props: object }, pathname: string): Promise<string> {
	const id = element.type.$$id ?? "";
	const hash = id.lastIndexOf("#");
	if (hash < 0) throw Error("the page did not hand its data to a client component");
	const { spawnSync } = await import("node:child_process");
	const out = spawnSync(process.execPath, ["--import", pathToFileURL(TSX).href, SSR], {
		input: JSON.stringify({
			module: fileURLToPath(id.slice(0, hash)),
			name: id.slice(hash + 1),
			props: element.props,
			pathname,
		}),
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "", TSX_TSCONFIG_PATH: WEB_TSCONFIG },
		maxBuffer: 64 * 1024 * 1024,
	});
	if (out.status !== 0) throw Error(`server render failed: ${out.stderr.slice(0, 2000)}`);
	return out.stdout;
}
