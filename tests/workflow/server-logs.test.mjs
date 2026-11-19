import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const app = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const next = fileURLToPath(new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url));
const PAGE = "/settings/account";
const COOKIE = "better-auth.session_token=signed-out";

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});

function googleFontsMock(fontOrigin) {
	const require = createRequire(join(app, "package.json"));
	const google = (file) => require(`next/dist/compiled/@next/font/dist/google/${file}`);
	const { validateGoogleFontFunctionCall } = google("validate-google-font-function-call.js");
	const { getFontAxes } = google("get-font-axes.js");
	const { getGoogleFontsUrl } = google("get-google-fonts-url.js");
	const mock = {};
	for (const file of globSync("src/**/*.{ts,tsx}", { cwd: app })) {
		const text = readFileSync(join(app, file), "utf8");
		const imported = text.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/)?.[1] ?? "";
		for (const name of imported.match(/\w+/g) ?? [])
			for (const [, options] of text.matchAll(new RegExp(`\\b${name}\\((\\{[^)]*\\})\\)`, "g"))) {
				const font = validateGoogleFontFunctionCall(name, vm.runInNewContext(`(${options})`));
				const axes = getFontAxes(font.fontFamily, font.weights, font.styles, font.selectedVariableAxes);
				mock[getGoogleFontsUrl(font.fontFamily, axes, font.display)] =
					`/* latin */\n@font-face {\n  font-family: '${font.fontFamily}';\n  font-style: normal;\n  font-weight: 400;\n` +
					`  font-display: swap;\n  src: url(${fontOrigin}/font.woff2) format('woff2');\n}\n`;
			}
	}
	assert.ok(Object.keys(mock).length > 0, "found no next/font/google call in apps/web/src");
	return mock;
}

function actionId(name) {
	const manifest = JSON.parse(readFileSync(`${app}.next/dev/server/server-reference-manifest.json`, "utf8"));
	const found = Object.entries(manifest.node).find(
		([, action]) => action.exportedName === name && action.filename?.endsWith("features/settings/actions.ts"),
	);
	assert.ok(found, `No ${name} action in the dev manifest`);
	return found[0];
}

test("BUG-PR199: the dev server log never shows a password sent to a server action", { timeout: 240_000 }, async () => {
	let fontRequests = 0;
	const fonts = createHttpServer((_, response) => {
		fontRequests++;
		response.writeHead(200, { "content-type": "font/woff2" }).end();
	});
	await new Promise((r) => fonts.listen(0, "127.0.0.1", r));
	const dir = mkdtempSync(join(tmpdir(), "server-logs-"));
	const mockFile = join(dir, "google-fonts.cjs");
	writeFileSync(
		mockFile,
		`module.exports = ${JSON.stringify(googleFontsMock(`http://127.0.0.1:${fonts.address().port}`))};\n`,
	);
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	let log = "";
	const logged = (done) =>
		new Promise((resolve) => {
			const check = () => {
				if (!done(log)) return;
				server.stdout.off("data", check);
				server.stderr.off("data", check);
				resolve();
			};
			server.stdout.on("data", check);
			server.stderr.on("data", check);
			check();
		});
	const server = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: app,
		env: {
			...process.env,
			IDENTITY_DATABASE_URL: "postgres://logs:logs@127.0.0.1:1/logs",
			IDENTITY_AUTH_DATABASE_URL: "postgres://logs:logs@127.0.0.1:1/logs",
			IDENTITY_ORIGIN: origin,
			IDENTITY_SECRET: "server-logs-synthetic-session-secret",
			IDENTITY_MAIL_KEY: "a".repeat(64),
			IDENTITY_ADDRESS_KEY: "b".repeat(64),
			IDENTITY_MAIL_FROM: "server-logs@example.test",
			NODE_ENV: "development",
			NEXT_TELEMETRY_DISABLED: "1",
			NEXT_FONT_GOOGLE_MOCKED_RESPONSES: mockFile,
			PORT: String(port),
			IDENTITY_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/unreachable",
			IDENTITY_AUTH_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/unreachable",
			IDENTITY_ORIGIN: `http://127.0.0.1:${port}`,
			IDENTITY_SECRET: "s".repeat(32),
			IDENTITY_MAIL_KEY: "a".repeat(64),
			IDENTITY_ADDRESS_KEY: "b".repeat(64),
			IDENTITY_MAIL_FROM: "mail@example.test",
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (chunk) => (log += chunk));
	server.stderr.on("data", (chunk) => (log += chunk));
	const stop = () => {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {}
	};
	const watcher = spawn("/bin/sh", ["-c", 'cat >/dev/null; kill -TERM -"$0" 2>/dev/null', String(server.pid)], {
		stdio: ["pipe", "ignore", "ignore"],
		detached: true,
	});
	watcher.unref();
	watcher.stdin.unref();
	const send = (url, init) =>
		fetch(url, init).catch((error) => {
			assert.fail(`${init?.method ?? "GET"} ${url} failed (${error.cause?.message ?? error.message}):\n${log}`);
		});
	try {
		const deadline = Date.now() + 120_000;
		while (!/Ready in/.test(log)) {
			assert.ok(server.exitCode === null, `next dev exited:\n${log}`);
			assert.ok(Date.now() < deadline, `next dev did not start:\n${log}`);
			await new Promise((r) => setTimeout(r, 250));
		}
		await send(origin + PAGE, { headers: { cookie: COOKIE }, redirect: "manual" });

		const secrets = { current: "Synthetic-current-7Qx!", next: "Synthetic-new-3Vb!", proof: "Synthetic-proof-9Lm!" };
		const calls = [
			["changePassword", { currentPassword: secrets.current, newPassword: secrets.next, revokeOtherSessions: true }],
			["openAccountDeletion", { email: "synthetic@example.test", password: secrets.proof }],
		];
		for (const [name, request] of calls) {
			const response = await send(origin + PAGE, {
				method: "POST",
				headers: {
					cookie: COOKIE,
					accept: "text/x-component",
					"content-type": "text/plain;charset=UTF-8",
					"next-action": actionId(name),
					"next-router-state-tree": encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }])),
				},
				body: JSON.stringify([request]),
			});
			await response.text();
			assert.match(response.headers.get("content-type") ?? "", /text\/x-component/, `${name} did not run:\n${log}`);
		}
		await send(origin + PAGE, { headers: { cookie: COOKIE }, redirect: "manual" });
		await logged((text) => text.split(`GET ${PAGE}`).length > 2);
		assert.equal(log.split(`POST ${PAGE}`).length - 1, calls.length, "the dev server logged each action request");
		assert.ok(fontRequests > 0, "the page's fonts came from this run's font server, not from Google");
		const shown = Object.keys(secrets).filter((key) => log.includes(secrets[key]));
		const masked = Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, "<password>"), log);
		assert.deepEqual(shown, [], `the dev server log shows synthetic passwords:\n${masked}`);
	} finally {
		stop();
		watcher.kill();
		fonts.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
