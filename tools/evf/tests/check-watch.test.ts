import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, source } from "./fixtures.ts";
import { approvedExperience, approvedQuality, mergeFixture, VERIFIER } from "./reconciliation-helpers.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { evidenceDir, parseTask } from "../lib.ts";
import { ship } from "../ship.ts";
import { verify, type CheckReport } from "../verify.ts";

/** OPS-143. Each test carries the marker of the Done criterion it proves. */

const task = parseTask("OPS-1");
const MAIN = join(source, "tools/evf/main.ts");
const FAST_POLL = { EVF_CHECK_POLL_MS: "100" };
const fastShip = { queue: { waitMs: 10_000, pollMs: 10 }, ciWaitMs: 10_000, ciPollMs: 1 };
type Check = { name: string; run: string[] };
const node = (script: string) => [process.execPath, "-e", script];
/** A check that runs `first`, then lives until the watch stops it or `limitMs` passes. */
const longCheck = (name: string, first: string, limitMs = 40_000): Check => ({
	name,
	run: node(`${first};setTimeout(()=>{},${limitMs})`),
});

/** An OPS-1 worktree on a fixture with a remote, a store row and an ignored node_modules. `use` commits its check list. */
function setup() {
	const f = fixture();
	f.cfg.checks = f.cfg.checks.map((c: Check) => (c.name === "format" ? { ...c, run: node("") } : c));
	f.cfg.maintenanceTasks = {
		"OPS-1": { title: "Checks", owningPaths: ["tools/evf/", "evf.config.json"], checks: [] },
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	writeFileSync(join(f.root, ".gitignore"), "node_modules/\n.env*\n");
	f.git("add", ".gitignore");
	f.commit();
	f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
	f.git("push", "-q", "origin", "main");
	const wt = f.task("ops-1"),
		db = openWorkDb(f.root);
	ensureTask(db, task, "implement");
	db.close();
	const use = (checks: Check[]) => {
		const config = join(wt, "evf.config.json"),
			cfg = JSON.parse(readFileSync(config, "utf8"));
		cfg.maintenanceTasks["OPS-1"].checks = checks;
		writeFileSync(config, JSON.stringify(cfg));
		f.git("-C", wt, "add", "evf.config.json");
		f.git("-C", wt, "commit", "-qm", "Set the checks");
		return f.git("-C", wt, "rev-parse", "HEAD");
	};
	return { ...f, wt, use };
}
const moveMain = (root: string) =>
	`const {execSync:x}=require("node:child_process");const c={cwd:${JSON.stringify(root)}};` +
	`require("node:fs").writeFileSync(${JSON.stringify(join(root, "moved.txt"))},"moved");` +
	`x("git add moved.txt && git commit -qm Moved && git push -q origin main",c)`;
function record(f: { root: string; wt: string }) {
	const sha = execFileSync("git", ["-C", f.wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	return JSON.parse(
		readFileSync(join(evidenceDir(f.root, task, sha, "author-full"), "checks.json"), "utf8"),
	) as CheckReport;
}
function events(root: string, type: string) {
	const db = openWorkDb(root);
	try {
		const rows = db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY id").all(type) as Array<{
			payload: string;
		}>;
		return rows.map((r) => JSON.parse(r.payload) as Record<string, any>);
	} finally {
		db.close();
	}
}
const cli = (cwd: string, env: Record<string, string> = {}, ...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_FOREGROUND: "1", ...env },
	});
async function until(ok: () => boolean, limitMs = 30_000) {
	for (const end = Date.now() + limitMs; !ok(); await new Promise((done) => setTimeout(done, 50)))
		assert.ok(Date.now() < end, "the wait passed its limit");
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("AC:OPS-143-1 AC:OPS-143-4 main moves during a run: the run passes, the event says base_moved, and the next run refuses until it includes main", () => {
	const f = setup();
	try {
		f.use([{ name: "move", run: node(moveMain(f.root)) }]);
		const before = f.git("rev-parse", "origin/main");

		const run = cli(f.wt, {}, "verify", "OPS-1");
		assert.equal(run.status, 0, run.stderr + run.stdout);
		const after = f.git("rev-parse", "origin/main");
		assert.notEqual(after, before, "main moved during the run");
		const report = record(f);
		assert.deepEqual([report.passed, report.unchanged], [true, true]);
		const expected = { reason: "base_moved", oldBase: before, newBase: after, wastedMs: 0 };
		assert.deepEqual(report.invalidated, expected);
		const [event] = events(f.root, "check_invalidated");
		assert.deepEqual([event.reason, event.oldBase, event.newBase, event.wastedMs], ["base_moved", before, after, 0]);
		assert.equal(events(f.root, "check_end").at(-1)!.result, "passed");
		const status = JSON.parse(cli(f.root, {}, "status", "--json").stdout) as { recent: Array<{ type: string }> };
		assert.ok(!status.recent.some((e) => e.type === "check_invalidated"), "evf status recent leaves it out");
		assert.equal(cli(f.wt, {}, "pre-push", "OPS-1").status, 0, "the record counts for the push gate");

		const next = cli(f.wt, {}, "verify", "OPS-1");
		assert.equal(next.status, 1);
		assert.match(next.stderr, /Include current main before verification\./);
	} finally {
		f.close();
	}
});

test("AC:OPS-143-2 AC:OPS-143-6 a commit during a run stops it within 60 s on the real poll and leaves no process: not a detached child, not one that ignores SIGTERM", () => {
	const spawnLong = (pidFile: string) =>
		`const {spawn}=require("node:child_process"),fs=require("node:fs");` +
		// One grandchild in the check's group that ignores SIGTERM, and one in its own session whose parent then exits.
		`const stay="process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)";` +
		`const a=spawn(process.execPath,["-e",stay],{stdio:"ignore"});` +
		`const b=spawn(process.execPath,["-e",stay],{stdio:"ignore",detached:true});` +
		`const m=spawn(process.execPath,["-e",${JSON.stringify(
			`const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore",detached:true});require("node:fs").writeFileSync(${JSON.stringify(pidFile)}+".orphan",String(c.pid));setTimeout(()=>{},15000)`,
		)}],{stdio:"ignore",detached:true});` +
		`fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,a.pid,b.pid,m.pid]))`;
	const f = setup();
	try {
		const pidFile = join(f.root, "fake-bin/pids.json"),
			after = join(f.root, "fake-bin/after");
		const sha = f.use([
			{
				name: "long",
				run: node(
					`${spawnLong(pidFile)};` +
						`require("node:child_process").spawn("sh",["-c",${JSON.stringify(`sleep 2; git -C ${f.wt} commit -q --allow-empty -m Moved`)}],{stdio:"ignore",detached:true}).unref();` +
						`setTimeout(()=>{},120000)`,
				),
			},
			{ name: "after", run: node(`require("node:fs").writeFileSync(${JSON.stringify(after)},"ran")`) },
		]);

		const started = Date.now();
		const run = cli(f.wt, { EVF_CHECK_POLL_MS: "" }, "verify", "OPS-1");
		const took = Date.now() - started;
		assert.equal(run.status, 1, run.stderr + run.stdout);
		assert.ok(took < 60_000, `the run ended after ${took} ms`);
		assert.match(run.stdout, /INVALIDATED \(tree_changed\)/);
		const report = JSON.parse(
			readFileSync(join(evidenceDir(f.root, task, sha, "author-full"), "checks.json"), "utf8"),
		) as CheckReport;
		assert.deepEqual([report.passed, report.unchanged], [false, false]);
		assert.equal(report.invalidated!.reason, "tree_changed");
		assert.ok(report.invalidated!.wastedMs > 0);
		assert.equal(events(f.root, "check_invalidated").at(-1)!.reason, "tree_changed");
		assert.equal(events(f.root, "check_end").at(-1)!.result, "invalidated");
		assert.equal(existsSync(after), false, "no later check starts");

		const pids = [
			...(JSON.parse(readFileSync(pidFile, "utf8")) as number[]),
			Number(readFileSync(`${pidFile}.orphan`, "utf8")),
		];
		assert.equal(pids.length, 5);
		assert.deepEqual(pids.filter(alive), [], "no process of the check is left");
	} finally {
		f.close();
	}
});

for (const [how, stop] of [
	["evf gets SIGKILL", (pid: number) => process.kill(pid, "SIGKILL")],
	["a person presses Ctrl-C", (pid: number) => process.kill(-pid, "SIGINT")],
] as const)
	test(`AC:OPS-143-6 ${how} during a check: no process of the check is left`, async () => {
		const f = setup();
		try {
			const pidFile = join(f.root, "fake-bin/pid");
			f.use([
				{
					name: "long",
					run: node(
						`const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});` +
							`require("node:fs").writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setTimeout(()=>{},60000)`,
					),
				},
			]);
			// Its own group stands for the terminal's foreground group. The watch moved the check out of that group.
			const evf = spawn(process.execPath, [MAIN, "verify", "OPS-1"], {
				cwd: f.wt,
				detached: true,
				stdio: "ignore",
				env: { ...process.env, EVF_RUN: "", EVF_FOREGROUND: "1", ...FAST_POLL },
			});
			await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
			const pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
			assert.deepEqual(pids.filter(alive), pids, "the check runs");
			stop(evf.pid!);
			await until(() => pids.filter(alive).length === 0);
		} finally {
			f.close();
		}
	});

for (const [name, change] of [
	["the install record", (wt: string) => join(wt, "node_modules/.pnpm/lock.yaml")],
	["an env file", (wt: string) => join(wt, ".env.local")],
] as const)
	test(`AC:OPS-143-3 ${name} changes during a run: inputs_changed invalidates it and stops it`, () => {
		const f = setup();
		try {
			const record_ = change(f.wt);
			mkdirSync(join(record_, ".."), { recursive: true });
			writeFileSync(record_, "first");
			f.use([longCheck("long", `require("node:fs").writeFileSync(${JSON.stringify(record_)},"second, longer")`)]);
			const started = Date.now();
			const run = cli(f.wt, FAST_POLL, "verify", "OPS-1");
			assert.equal(run.status, 1, run.stderr + run.stdout);
			assert.ok(Date.now() - started < 30_000, "the watch stopped the check before its limit");
			assert.match(run.stdout, /INVALIDATED \(inputs_changed\)/);
			assert.equal(record(f).invalidated!.reason, "inputs_changed");
			assert.equal(events(f.root, "check_invalidated").at(-1)!.reason, "inputs_changed");
		} finally {
			f.close();
		}
	});

test("OPS-143 a temporary file gone by the next poll stops nothing", () => {
	const f = setup();
	try {
		const temp = join(f.wt, "temp.txt");
		f.use([
			{
				name: "temp",
				// Present across at most one 2 s poll: never on two polls in a row.
				run: node(
					`const fs=require("node:fs");setTimeout(()=>fs.writeFileSync(${JSON.stringify(temp)},"x"),500);` +
						`setTimeout(()=>fs.rmSync(${JSON.stringify(temp)}),2500);setTimeout(()=>{},5000)`,
				),
			},
		]);
		const run = cli(f.wt, { EVF_CHECK_POLL_MS: "2000" }, "verify", "OPS-1");
		assert.equal(run.status, 0, run.stderr + run.stdout);
		const report = record(f);
		assert.equal(report.passed, true);
		assert.equal(report.invalidated, undefined);
		assert.deepEqual(events(f.root, "check_invalidated"), []);
	} finally {
		f.close();
	}
});

test("OPS-143 a run keeps the result, output and missing-command code of its check under the watch", () => {
	const f = setup();
	try {
		f.use([{ name: "loud", run: node(`console.log("out line");console.error("err line");process.exit(3)`) }]);
		const { log, error } = console;
		console.log = console.error = () => {};
		let report: CheckReport;
		try {
			report = verify(f.root, task, "author", "full");
		} finally {
			console.log = log;
			console.error = error;
		}
		const loud = report.checks.find((c) => c.name === "loud")!;
		assert.equal(loud.exitCode, 3);
		const text = readFileSync(loud.log, "utf8");
		assert.match(text, /out line/);
		assert.match(text, /err line/);
		assert.equal(report.unchanged, true);
		f.use([{ name: "gone", run: ["evf-no-such-command"] }]);
		console.log = console.error = () => {};
		try {
			report = verify(f.root, task, "author", "full");
		} finally {
			console.log = log;
			console.error = error;
		}
		assert.equal(report.checks.find((c) => c.name === "gone")!.exitCode, 127);
	} finally {
		f.close();
	}
});

/** A verify at an approved head during which main changes `path`, with required CI queued as pass, then fail. */
function shipAfterMainMove(path: string) {
	const f = mergeFixture({ owningPaths: ["tools/evf/", "evf.config.json", "README.md"] }),
		inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
	const db = openWorkDb(f.root);
	ensureTask(db, f.taskRef, "implement");
	db.close();
	const move =
		`const {execSync:x}=require("node:child_process"),r=${JSON.stringify(f.root)};` +
		`require("node:fs").appendFileSync(r+"/"+${JSON.stringify(path)},"Main line.\\n");` +
		`x("git add "+${JSON.stringify(path)}+" && git commit -qm Main && git push -q origin main",{cwd:r})`;
	const config = join(f.wt, "evf.config.json"),
		cfg = JSON.parse(readFileSync(config, "utf8"));
	cfg.maintenanceTasks["OPS-1"].checks = [{ name: "move", run: node(move) }];
	writeFileSync(config, JSON.stringify(cfg));
	writeFileSync(join(f.wt, "README.md"), `PR line.\n${readFileSync(join(f.wt, "README.md"), "utf8")}`);
	inWt("add", "evf.config.json", "README.md");
	inWt("commit", "-qm", "Work");
	const head = inWt("rev-parse", "HEAD");
	const verified = cli(f.wt, {}, "verify", "OPS-1");
	assert.equal(verified.status, 0, verified.stderr + verified.stdout);
	const report = record(f);
	assert.deepEqual([report.passed, report.invalidated!.reason], [true, "base_moved"]);
	inWt("push", "-q", "origin", `+${head}:refs/heads/${f.taskRef.branch}`);
	const state = f.getState(),
		pass = { name: "ci", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/2" };
	state.pr.headRefOid = head;
	state.comments["77"] = [
		{
			body: `EVF-Review: ${JSON.stringify({ head, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
			html_url: "https://github.com/test/private/pull/77#issuecomment-3",
		},
	];
	state.protection = { required_status_checks: { strict: true, contexts: ["ci"] } };
	state.requiredChecks = [pass];
	state.checksQueue = [[pass], [{ name: "ci", bucket: "fail" }]];
	state.calls = [];
	f.setState(state);
	const calls = (sub: string) =>
		f.getState().calls.filter((c: { args: string[] }) => c.args[0] === "pr" && c.args[1] === sub);
	return { f, head, inWt, calls };
}

test("AC:OPS-143-5 main moves during a passing run over a path of the PR: evf ship still refuses on the overlap", () => {
	const { f, head, inWt, calls } = shipAfterMainMove("README.md");
	const { log } = console;
	console.log = () => {};
	try {
		assert.throws(
			() => ship(f.root, f.taskRef, fastShip),
			/Fresh gate needed: main changed paths this PR also changes: README\.md\./,
		);
		assert.deepEqual([calls("update-branch"), calls("merge")], [[], []]);
		assert.equal(inWt("rev-parse", "HEAD"), head);
	} finally {
		console.log = log;
		f.close();
	}
});

test("AC:OPS-143-5 main moves during a passing run over another path: evf ship merges main, waits for required CI on the merge, and a red result blocks it", () => {
	const { f, calls } = shipAfterMainMove("moved.md");
	const { log } = console;
	console.log = () => {};
	try {
		assert.throws(
			() => ship(f.root, f.taskRef, fastShip),
			/Fresh gate needed at [a-f0-9]{40}: required CI failed after the merge of main \(ci\)/,
		);
		assert.equal(calls("update-branch").length, 1);
		assert.deepEqual(calls("merge"), []);
	} finally {
		console.log = log;
		f.close();
	}
});
