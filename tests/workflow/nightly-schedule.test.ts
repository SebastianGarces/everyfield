// T-104: `bin/dev nightly schedule install|status|uninstall` against a fake launchctl and a temp LaunchAgents dir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { nightlyLog } from "../../scripts/nightly.ts";
import {
	install,
	jobPath,
	LABEL,
	plist,
	plistPath,
	type ScheduleDeps,
	status,
	uninstall,
} from "../../scripts/nightly-schedule.ts";

const root = resolve(import.meta.dirname, "../..");

function temp(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "evf-nightly-schedule-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A launchctl that keeps one gui/501 domain and records every call. bootout takes effect after one more print. */
function fakeDeps(dir: string, over: Partial<ScheduleDeps> = {}) {
	const calls: string[] = [];
	const out: string[] = [];
	let loaded = false;
	let unloading = false;
	const d: ScheduleDeps = {
		agentsDir: join(dir, "LaunchAgents"),
		uid: 501,
		home: join(dir, "ci"),
		checkout: "/repo/main",
		path: "/opt/node/bin:/usr/bin:/bin",
		launchctl: (args) => {
			calls.push(args.join(" "));
			if (args[0] === "print") {
				const was = loaded;
				if (unloading) [loaded, unloading] = [false, false];
				return { status: was ? 0 : 113, output: "" };
			}
			if (args[0] === "bootout")
				return loaded ? ((unloading = true), { status: 0, output: "" }) : { status: 3, output: "" };
			if (args[0] === "bootstrap") {
				// The real launchctl refuses a label that is still loaded (error 5).
				if (loaded) return { status: 5, output: "Bootstrap failed: 5: Input/output error" };
				assert.ok(existsSync(args[2]), "bootstrap reads a plist that exists");
				loaded = true;
				return { status: 0, output: "" };
			}
			throw new Error(`unexpected launchctl ${args.join(" ")}`);
		},
		log: (line) => out.push(line),
		sleep: () => {},
		...over,
	};
	return { d, calls, out, isLoaded: () => loaded };
}

const EXPECTED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.everyfield.nightly</string>
	<key>ProgramArguments</key>
	<array>
		<string>/repo/main/bin/dev</string>
		<string>nightly</string>
	</array>
	<key>WorkingDirectory</key>
	<string>/repo/main</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/node/bin:/usr/bin:/bin</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>3</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/ci/nightly.log</string>
	<key>StandardErrorPath</key>
	<string>/ci/nightly.log</string>
</dict>
</plist>
`;

test("the plist is one pure function of label, time, checkout, PATH and log, with XML escaped", async (t) => {
	const base = { label: LABEL, hour: 3, minute: 30, checkout: "/repo/main", path: "/opt/node/bin:/usr/bin:/bin" };
	const cases = [
		{ name: "the nightly agent", input: { ...base, log: "/ci/nightly.log" }, want: EXPECTED },
		{
			name: "special characters in paths",
			input: { ...base, checkout: "/a&b/<c>", log: "/ci/nightly.log" },
			want: EXPECTED.replaceAll("/repo/main", "/a&amp;b/&lt;c&gt;"),
		},
		{
			name: "another time",
			input: { ...base, hour: 23, minute: 5, log: "/ci/nightly.log" },
			want: EXPECTED.replace("<integer>3</integer>", "<integer>23</integer>").replace(
				"<integer>30</integer>",
				"<integer>5</integer>",
			),
		},
	];
	for (const c of cases) await t.test(c.name, () => assert.equal(plist(c.input), c.want));
	assert.doesNotMatch(EXPECTED, /RunAtLoad|KeepAlive/);
});

test("the generated plist passes plutil -lint", { skip: process.platform !== "darwin" }, (t) => {
	const dir = temp(t);
	const { d } = fakeDeps(dir);
	install(d);
	const r = spawnSync("plutil", ["-lint", plistPath(d.agentsDir)], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("install writes the plist and bootstraps it into the GUI domain", (t) => {
	const dir = temp(t);
	const { d, calls, out, isLoaded } = fakeDeps(dir);
	assert.equal(install(d), 0);
	const file = join(dir, "LaunchAgents", "com.everyfield.nightly.plist");
	assert.equal(readFileSync(file, "utf8"), EXPECTED.replaceAll("/ci/nightly.log", join(dir, "ci", "nightly.log")));
	assert.deepEqual(calls, ["print gui/501/com.everyfield.nightly", `bootstrap gui/501 ${file}`]);
	assert.ok(isLoaded());
	assert.equal(out[0], "installed com.everyfield.nightly: bin/dev nightly from /repo/main at 03:30 every day");
});

test("a second install boots the old agent out first and leaves exactly one plist", (t) => {
	const dir = temp(t);
	const { d, calls, out } = fakeDeps(dir);
	install(d);
	calls.length = 0;
	assert.equal(install(d), 0);
	const file = plistPath(d.agentsDir);
	assert.deepEqual(calls, [
		"print gui/501/com.everyfield.nightly",
		"bootout gui/501/com.everyfield.nightly",
		// launchd lets go asynchronously: install waits until print no longer finds the job.
		"print gui/501/com.everyfield.nightly",
		"print gui/501/com.everyfield.nightly",
		`bootstrap gui/501 ${file}`,
	]);
	assert.deepEqual(readdirSync(d.agentsDir), ["com.everyfield.nightly.plist"]);
	assert.match(out.at(-3) ?? "", /^replaced com\.everyfield\.nightly/);
});

test("install fails loudly when bootstrap fails", (t) => {
	const dir = temp(t);
	const { d } = fakeDeps(dir, { launchctl: (a) => ({ status: a[0] === "print" ? 113 : 5, output: "boom" }) });
	assert.throws(() => install(d), /launchctl bootstrap failed:\nboom/);
});

test("status reports an installed, loaded agent with its time, log and last record", (t) => {
	const dir = temp(t);
	const { d, out } = fakeDeps(dir);
	install(d);
	const result = JSON.stringify({
		type: "nightly_result",
		at: "2026-11-14T08:30:00.000Z",
		head: "f",
		suite: "tests/ui webkit",
		passed: 9,
		failed: 0,
		durationMs: 1,
	});
	appendFileSync(nightlyLog(d.home), `${result}\n{"type":"other"}\n{torn`);
	out.length = 0;
	assert.equal(status(d), 0);
	assert.deepEqual(out, [
		"com.everyfield.nightly: installed, loaded",
		"runs: bin/dev nightly at 03:30 local time every day",
		`plist: ${plistPath(d.agentsDir)}`,
		`log: ${join(d.home, "nightly.log")}`,
		`last record (${nightlyLog(d.home)}): ${result}`,
	]);
});

test("status with nothing installed says so and exits 0", (t) => {
	const dir = temp(t);
	const { d, out } = fakeDeps(dir);
	mkdirSync(d.home, { recursive: true });
	appendFileSync(nightlyLog(d.home), `${JSON.stringify({ type: "nightly_skipped", reason: "load" })}\n`);
	assert.equal(status(d), 0);
	assert.deepEqual(out, [
		"com.everyfield.nightly is not installed. Install it with bin/dev nightly schedule install.",
		`last record (${nightlyLog(d.home)}): {"type":"nightly_skipped","reason":"load"}`,
	]);
});

test("uninstall boots the agent out and deletes the plist; with nothing installed it succeeds", (t) => {
	const dir = temp(t);
	const { d, calls, out, isLoaded } = fakeDeps(dir);
	install(d);
	calls.length = 0;
	assert.equal(uninstall(d), 0);
	assert.ok(!existsSync(plistPath(d.agentsDir)));
	assert.ok(!isLoaded());
	assert.deepEqual(calls.slice(0, 2), [
		"print gui/501/com.everyfield.nightly",
		"bootout gui/501/com.everyfield.nightly",
	]);
	assert.equal(out.at(-1), "uninstalled com.everyfield.nightly");
	assert.equal(uninstall(d), 0);
	assert.equal(out.at(-1), "nothing was installed: com.everyfield.nightly had no plist and was not loaded");
});

test("the job PATH puts the running node first and reaches every tool nightly calls", () => {
	const found = (tool: string) =>
		({
			pnpm: "/brew/bin/pnpm",
			gh: "/brew/bin/gh",
			corepack: "/local/bin/corepack",
			portless: "/local/bin/portless",
			git: "/usr/bin/git",
		})[tool] ?? null;
	assert.equal(jobPath(found, "/nvm/v24/bin/node"), "/nvm/v24/bin:/brew/bin:/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	assert.throws(() => jobPath(() => null, "/n/node"), /pnpm is not on PATH/);
});

test("bin/dev nightly with another argument prints usage and exits 2; help lists the schedule commands", () => {
	const dev = (...args: string[]) => spawnSync(join(root, "bin/dev"), args, { encoding: "utf8" });
	for (const args of [
		["nightly", "bogus"],
		["nightly", "schedule"],
		["nightly", "schedule", "bogus"],
		["nightly", "schedule", "status", "x"],
	]) {
		const r = dev(...args);
		assert.equal(r.status, 2, args.join(" "));
		assert.match(r.stderr, /usage: dev nightly \[schedule install\|status\|uninstall\]/);
	}
	const help = dev("help").stdout;
	for (const action of ["install", "status", "uninstall"])
		assert.match(help, new RegExp(`dev nightly schedule ${action} `));
});
