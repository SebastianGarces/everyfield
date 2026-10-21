// BUG-PR199: `next dev` printed every server action call with its arguments, so a password change or a deletion proof
// put the password in the server log. The row starts the real dev server, calls both actions over HTTP as the browser
// does, with synthetic passwords, and asserts that no log line carries them. Next.js records the arguments before the
// action decides anything, so a signed-out call shows the leak as well as a signed-in one and needs no database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
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
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	let log = "";
	const server = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd: app,
		env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stdout.on("data", (chunk) => (log += chunk));
	server.stderr.on("data", (chunk) => (log += chunk));
	try {
		const deadline = Date.now() + 120_000;
		while (!/Ready in/.test(log)) {
			assert.ok(server.exitCode === null, `next dev exited:\n${log}`);
			assert.ok(Date.now() < deadline, `next dev did not start:\n${log}`);
			await new Promise((r) => setTimeout(r, 250));
		}
		// The first render compiles the page and with it the settings actions.
		await fetch(origin + PAGE, { headers: { cookie: COOKIE }, redirect: "manual" });

		const secrets = { current: "Synthetic-current-7Qx!", next: "Synthetic-new-3Vb!", proof: "Synthetic-proof-9Lm!" };
		const calls = [
			["changePassword", { currentPassword: secrets.current, newPassword: secrets.next, revokeOtherSessions: true }],
			["openAccountDeletion", { email: "synthetic@example.test", password: secrets.proof }],
		];
		for (const [name, request] of calls) {
			const response = await fetch(origin + PAGE, {
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
		// The call log prints after the request finishes.
		await new Promise((r) => setTimeout(r, 1_500));
		assert.match(log, new RegExp(`POST ${PAGE}`), "the dev server logged no action request");
		const shown = Object.keys(secrets).filter((key) => log.includes(secrets[key]));
		const masked = Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, "<password>"), log);
		assert.deepEqual(shown, [], `the dev server log shows synthetic passwords:\n${masked}`);
	} finally {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {}
	}
});
