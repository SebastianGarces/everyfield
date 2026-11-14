// BUG-PR199: `next dev` printed every server action call with its arguments, so a password change or a deletion proof
// put the password in the server log. The row starts the real dev server, calls both actions over HTTP as the browser
// does, with synthetic passwords, and asserts that no log line carries them. Next.js records the arguments before the
// action decides anything, so a signed-out call shows the leak as well as a signed-in one and needs no database.
//
// T-262: the run needs no network and no wall-clock luck, so parallel check slots cannot fail it. `next dev` fetched
// every next/font/google stylesheet and font file from Google with a 3 s timeout; on a loaded machine one font file
// missed it, the page failed to compile and the action never ran (D-678). Next's NEXT_FONT_GOOGLE_MOCKED_RESPONSES now
// answers the stylesheets, and their font files come from a server this run owns on an ephemeral port.
//
// T-357: "fetch failed / SocketError: other side closed" in full checks came from an earlier run of this test, not from
// load. A run killed before its `finally` left its detached `next dev` alive and idle, still holding the checkout's
// .next/dev/lock (evf check slot s4 held one from Nov 13). Every later run there printed "Ready in", took the first
// request, failed to get the lock, printed "Another next dev server is already running" and exited, closing the
// socket; elsewhere, and alone, the test passed. Now a watcher holding a pipe from this process stops the server's
// process group however this process ends, and a failed request reports the server log, which names any other lock
// holder.
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
// Proxy admits any session cookie; the page then reads the real session.
const COOKIE = "better-auth.session_token=signed-out";

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});

/**
 * The stylesheet next/font/google requests for each loader call in the app, keyed by URL as Next.js looks it up, each
 * with one font file on `fontOrigin`. Next's own helpers build the URLs, so a font added to the app needs no edit here.
 */
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

/** The action id Next.js gave `name` in apps/web/src/features/settings/actions.ts. */
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
	/** Resolves once `done(log)` holds, checked on each output chunk; the test's own timeout bounds the wait. */
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
			NODE_ENV: "development",
			NEXT_TELEMETRY_DISABLED: "1",
			NEXT_FONT_GOOGLE_MOCKED_RESPONSES: mockFile,
			PORT: String(port),
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
	// The watcher's stdin is this process's pipe: when this process ends, however it ends, `cat` reads end of file and
	// the server's process group is stopped. Unreferenced, it never keeps this process alive.
	const watcher = spawn("/bin/sh", ["-c", 'cat >/dev/null; kill -TERM -"$0" 2>/dev/null', String(server.pid)], {
		stdio: ["pipe", "ignore", "ignore"],
		detached: true,
	});
	watcher.unref();
	watcher.stdin.unref();
	/** `fetch`, failing with the server log: a server that quit mid-request says why (e.g. another holds the lock). */
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
		// The first render compiles the page and with it the settings actions.
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
			// The action ran: Next.js answers an action call, not the page or a missing-action refusal.
			assert.match(response.headers.get("content-type") ?? "", /text\/x-component/, `${name} did not run:\n${log}`);
		}
		// Next.js logs a request, then its action arguments, after the response finishes. One more page request is the
		// barrier: once its line is in the log, every line the action requests wrote is in too.
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
