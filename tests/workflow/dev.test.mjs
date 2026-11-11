import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/dev.ts", import.meta.url));
const dev = (args, env = {}) =>
	spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("BUG-ops8-browser-run: bin/dev browser run leaves no browser process or temporary profile after a pass, a throw or a timeout", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dev-browser-test-")));
	// A stand-in browser binary: Node under a Playwright-style path. Real browsers start their own process group, so a
	// group kill alone misses them.
	const bin = join(dir, "ms-playwright/chromium_headless_shell-0/chrome-headless-shell");
	mkdirSync(join(bin, ".."), { recursive: true });
	symlinkSync(process.execPath, bin);
	const check = join(dir, "check.mjs");
	writeFileSync(
		check,
		`import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [mode, out] = process.argv.slice(2);
const profile = mkdtempSync(join(tmpdir(), "playwright_chromiumdev_profile-"));
const browser = spawn(${JSON.stringify(bin)}, ["-e", "setInterval(() => {}, 1000)", "--", "--headless"], { detached: true, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 300));
process.kill(browser.pid, 0);
browser.unref();
writeFileSync(out, JSON.stringify({ pid: browser.pid, profile }));
if (mode === "throw") throw new Error("check failed");
if (mode === "hang") setInterval(() => {}, 1000);
`,
	);
	try {
		for (const [mode, expected] of [
			["pass", 0],
			["throw", 1],
			["hang", 124],
		]) {
			const out = join(dir, `${mode}.json`);
			const r = dev(["browser", "run", "--timeout", "3", "--", process.execPath, check, mode, out]);
			const { pid, profile } = JSON.parse(readFileSync(out, "utf8"));
			const leaked = alive(pid);
			if (leaked) process.kill(pid, "SIGKILL");
			assert.equal(r.status, expected, `${mode}: ${r.stderr}`);
			assert.equal(leaked, false, `${mode}: browser ${pid} is still running`);
			assert.equal(existsSync(profile), false, `${mode}: temporary profile ${profile} remains`);
			assert.match(r.stderr, /no browser process from this run is left/);
		}
		assert.equal(dev(["browser", "run", "--", join(dir, "no-such-command")]).status, 127);
		assert.equal(dev(["browser", "run", "--timeout", "0", "--", "true"]).status, 1);
		assert.equal(dev(["browser", "run", "true"]).status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Fake only the external Portless executable, as stack.test.mjs does.
const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_REGISTRY;
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
let result;
if (args[1] === 'status') result = rows;
else if (args[1] === 'logs') { console.log('logs of ' + args.slice(2).join(' ')); process.exit(0); }
else if (args[1] === 'up') {
  const project = args[args.indexOf('--project') + 1];
  result = { id: 'p' + (rows.length + 1), project, head: 'abc', branch: 'b', mode: args[args.indexOf('--mode') + 1], state: 'ready', url: 'http://p.localhost:1355' };
  rows.push(result);
} else if (args[1] === 'down') {
  result = rows.find(p => p.id === args[2]);
  result.state = 'removed';
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(rows));
console.log(JSON.stringify(result));
`;

test("bin/dev stack and logs work on the selected worktree, and up waits for a slot", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dev-stack-test-")));
	try {
		const bin = join(dir, "bin"),
			project = join(dir, "worktree"),
			registry = join(dir, "registry.json");
		mkdirSync(bin);
		mkdirSync(project);
		execFileSync("git", ["init", "--quiet", project]);
		writeFileSync(join(bin, "portless"), fake);
		chmodSync(join(bin, "portless"), 0o755);
		const env = {
			PATH: `${bin}${delimiter}${process.env.PATH}`,
			FAKE_REGISTRY: registry,
			PORTLESS_PREVIEW_LIMIT: "1",
			EVF_PREVIEW_WAIT_MS: "1",
			EVF_PREVIEW_POLL_MS: "1",
		};
		const where = ["--project", project];

		const none = dev(["logs", ...where], env);
		assert.equal(none.status, 1);
		assert.match(none.stderr, /no running preview/);

		const full = JSON.stringify([{ id: "other", project: join(dir, "other"), state: "ready" }]);
		mkdirSync(join(dir, "other"));
		writeFileSync(registry, full);
		const waited = dev(["stack", "up", ...where], env);
		assert.equal(waited.status, 1);
		assert.match(waited.stderr, /No free preview slot/);
		assert.equal(readFileSync(registry, "utf8"), full, "no preview starts while the pool is full");

		writeFileSync(registry, "[]");
		const up = dev(["stack", "up", "--mode", "development", ...where], env);
		assert.equal(up.status, 0, up.stderr);
		assert.equal(JSON.parse(up.stdout).state, "ready");
		assert.equal(JSON.parse(dev(["stack", "status", ...where], env).stdout).id, "p1");

		const logs = dev(["logs", ...where, "--since", "5m"], env);
		assert.equal(logs.status, 0, logs.stderr);
		assert.equal(logs.stdout.trim(), "logs of p1 --since 5m");

		const down = dev(["stack", "down", ...where], env);
		assert.equal(down.status, 0, down.stderr);
		assert.equal(JSON.parse(down.stdout).state, "stopped");

		assert.equal(dev(["traces"], env).status, 2, "traces has no handler");
		assert.equal(dev(["stack", "sideways"], env).status, 2);
		assert.equal(dev(["nothing"], env).status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
