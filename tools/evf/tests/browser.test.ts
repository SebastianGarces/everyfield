import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../../..");
const evf = join(source, "bin/evf");

// A stand-in browser binary: Node under a Playwright-style path. Real browsers start their own
// process group, so a group kill alone misses them.
function fakeBrowserBinary(dir: string): string {
	const bin = join(dir, "ms-playwright/chromium_headless_shell-0/chrome-headless-shell");
	mkdirSync(join(bin, ".."), { recursive: true });
	symlinkSync(process.execPath, bin);
	return bin;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("BUG-ops8-browser-run: no browser process or temporary profile is left after a pass, a throw or a timeout", () => {
	const dir = mkdtempSync(join(tmpdir(), "evf-browser-test-")),
		bin = fakeBrowserBinary(dir),
		check = join(dir, "check.mjs");
	// The check launches a detached browser like Playwright does, records it, then ends as told.
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
process.kill(browser.pid, 0); // the browser runs before the check ends
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
		] as const) {
			const out = join(dir, `${mode}.json`);
			const r = spawnSync(evf, ["browser", "run", "--timeout", "3", "--", process.execPath, check, mode, out], {
				encoding: "utf8",
			});
			const { pid, profile } = JSON.parse(readFileSync(out, "utf8"));
			const leaked = alive(pid);
			if (leaked) process.kill(pid, "SIGKILL");
			assert.equal(r.status, expected, `${mode}: ${r.stderr}`);
			assert.equal(leaked, false, `${mode}: browser ${pid} is still running`);
			assert.equal(existsSync(profile), false, `${mode}: temporary profile ${profile} remains`);
			assert.match(r.stderr, /no browser process from this run is left/);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("BUG-ops8-doctor-browsers: doctor lists a leaked headless browser until it exits and never stops it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "evf-doctor-test-")),
		browser = spawn(fakeBrowserBinary(dir), ["-e", "setInterval(() => {}, 1000)", "--", "--headless"], {
			detached: true,
			stdio: "ignore",
		});
	const doctor = () =>
		spawnSync(evf, ["doctor", "--here", "--browser-age", "0"], { cwd: source, encoding: "utf8" }).stdout;
	try {
		await new Promise((r) => setTimeout(r, 300));
		const listed = doctor()
			.split("\n")
			.find((line) => line.includes(`PID ${browser.pid} `));
		assert.match(listed ?? "", /^WARN {2}Playwright chromium_headless_shell PID \d+ running 0 min, \d+ MB/);
		assert.equal(alive(browser.pid!), true, "doctor must not stop the browser");
		const exited = new Promise((r) => browser.on("exit", r));
		browser.kill("SIGKILL");
		await exited;
		assert.doesNotMatch(doctor(), new RegExp(`PID ${browser.pid} `));
	} finally {
		if (alive(browser.pid!)) browser.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
