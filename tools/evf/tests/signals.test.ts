import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fixture, source } from "./fixtures.ts";
import { check } from "../drive.ts";
import { ensureTask, openWorkDb, record, workDbPath } from "../db.ts";
import { evidenceDir, parseTask } from "../lib.ts";
import { hasVerifiedHead, requireVerifiedHead, verify, type CheckReport } from "../verify.ts";

type Fixture = ReturnType<typeof fixture>;
type Check = { name: string; run: string[] };
const MAIN = join(source, "tools/evf/main.ts");
const RUN_KEYS = ["durationMs", "head", "mode", "queuedMs", "result", "role", "run", "task", "treeHash", "trigger"];
const SUITE_KEYS = [
	"durationMs",
	"head",
	"loadEnd",
	"loadStart",
	"mode",
	"passed",
	"role",
	"startedAt",
	"suite",
	"task",
];
const FAILED_KEYS = ["attempt", "file", "head", "suite", "task", "test", "touchesOwnPaths", "touchesTestPaths"];
const SIGNALS = "'check_start','check_end','check_suite_end','test_failed'";

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [MAIN, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_FOREGROUND: "1", ...env },
	});
const node = (js: string, ...args: string[]): Check["run"] => [process.execPath, "-e", js, ...args];
const pass: Check = { name: "good", run: node("") };
/** Writes one check's EVF_TEST_REPORT file and exits with `code`. */
const reporting = (tests: unknown[], code = 0, name = "reported"): Check => ({
	name,
	run: node(
		`require("node:fs").writeFileSync(process.env.EVF_TEST_REPORT,${JSON.stringify(JSON.stringify({ tests }))});process.exit(${code})`,
	),
});

function quiet<T>(fn: () => T): { value: T; err: string } {
	const { log, error } = console;
	let err = "";
	console.log = () => {};
	console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
	try {
		return { value: fn(), err };
	} finally {
		console.log = log;
		console.error = error;
	}
}

/** `fn` with EVF_RUN set to `run`, or unset. The suite itself may run inside a seat, so no test inherits the value. */
function withRun<T>(run: string | undefined, fn: () => T): T {
	const saved = process.env.EVF_RUN;
	if (run === undefined) delete process.env.EVF_RUN;
	else process.env.EVF_RUN = run;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env.EVF_RUN;
		else process.env.EVF_RUN = saved;
	}
}

/** A registered OPS-900 worktree with `checks`; a store row for it unless `known` is false. */
function opsTask(f: Fixture, checks: Check[], opts: { known?: boolean; owning?: string[] } = {}) {
	const wt = f.task("ops-900"),
		task = parseTask("OPS-900");
	const cfg = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
	cfg.maintenanceTasks = {
		...cfg.maintenanceTasks,
		"OPS-900": { title: "Signals fixture", owningPaths: opts.owning ?? ["tools/evf/"], checks },
	};
	writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
	f.git("-C", wt, "add", "evf.config.json");
	f.git("-C", wt, "commit", "-qm", "Register OPS-900");
	const db = openWorkDb(f.root);
	const taskId = opts.known === false ? -1 : ensureTask(db, task, "implement").id;
	db.close();
	const commit = (path: string, text: string) => {
		mkdirSync(dirname(join(wt, path)), { recursive: true });
		writeFileSync(join(wt, path), text);
		f.git("-C", wt, "add", path);
		f.git("-C", wt, "commit", "-qm", `Change ${path}`);
	};
	return { wt, task, taskId, commit };
}

type Stored = { id: number; type: string; run_id: number | null; payload: Record<string, unknown> };
function stored(f: Fixture): Stored[] {
	const db = new DatabaseSync(workDbPath(f.root), { readOnly: true });
	const rows = db
		.prepare(`SELECT id, type, run_id, payload FROM events WHERE type IN (${SIGNALS}) ORDER BY id`)
		.all() as Array<{ id: number; type: string; run_id: number | null; payload: string }>;
	db.close();
	return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}
const ofType = (rows: Stored[], type: string) => rows.filter((r) => r.type === type);
const authorDir = (f: Fixture, task: ReturnType<typeof parseTask>, sha: string) =>
	evidenceDir(f.root, task, sha, "author-full");
const keys = (o: object) => Object.keys(o).sort();

/** What `evf test` reads besides its tests, committed on main so a task's owning paths need not cover it. */
function ciFiles(f: Fixture) {
	writeFileSync(join(f.root, "package.json"), '{"private":true,"type":"module","scripts":{}}\n');
	mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
	writeFileSync(
		join(f.root, ".github/workflows/ci.yml"),
		"jobs:\n  evf:\n    steps:\n      - run: node --test tools/evf/tests/*.test.ts\n",
	);
	f.git("add", "package.json", ".github");
	f.git("commit", "-qm", "CI files");
}
const sampleTests = (body: string) => `import test from "node:test";\n${body}\n`;
/** `bin/evf test` as a check. NODE_TEST_CONTEXT would turn the nested run's reporters off: it names this suite's protocol. */
const evfTest: Check = { name: "workflow", run: ["env", "-u", "NODE_TEST_CONTEXT", process.execPath, MAIN, "test"] };

test("AC:OPS-132-1 evf events returns every matching event in id order and filters combine", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const ui = ensureTask(db, parseTask("WP-002/ui"), "implement").id,
			ops = ensureTask(db, parseTask("OPS-7"), "implement").id;
		const insert = db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, ?, ?)");
		for (let i = 0; i < 70; i++)
			insert.run(
				i % 2 ? ui : ops,
				new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
				i % 7 ? "nudge" : "reopen",
				JSON.stringify({ n: i }),
			);
		db.close();
		const read = (...args: string[]) => {
			const r = cli(f.root, {}, "events", ...args, "--json");
			assert.equal(r.status, 0, r.stderr);
			return JSON.parse(r.stdout) as Array<{
				id: number;
				ts: string;
				type: string;
				task: string;
				run: number | null;
				payload: { n: number };
			}>;
		};
		const all = read();
		assert.equal(all.length, 70);
		assert.deepEqual(
			all.map((e) => e.id),
			[...all.map((e) => e.id)].sort((a, b) => a - b),
		);
		assert.deepEqual(keys(all[1]), ["id", "payload", "run", "task", "ts", "type"]);
		assert.deepEqual(all[1].payload, { n: 1 });
		assert.equal(all[1].task, "WP-002/ui");
		assert.equal(all[1].run, null);

		// Inclusive, for each way to write one instant.
		for (const since of [
			"2026-01-01T01:00:00.000Z",
			"2026-01-01T03:00:00+02:00",
			"2026-01-01T03:00+0200",
			"2026-01-01T03:00:00+02",
		])
			assert.equal(read("--since", since).length, 10, since);
		assert.equal(read("--since", "2026-01-01").length, 70);
		assert.equal(read("--type", "reopen").length, 10);
		assert.equal(read("--task", "OPS-7").length, 35);
		assert.equal(read("--task", "WP-002").length, 35, "a ref matches its parts");
		assert.equal(read("--task", "wp-002-ui").length, 35, "the slug matches");
		assert.equal(read("--task", "WP-002/ui").length, 35);
		const combined = read("--task", "OPS-7", "--type", "reopen", "--since", "2026-01-01T00:30:00Z");
		assert.deepEqual(
			combined.map((e) => e.payload.n),
			[42, 56],
		);

		const lines = cli(f.root, {}, "events", "--type", "reopen");
		assert.equal(lines.status, 0, lines.stderr);
		assert.equal(lines.stdout.trim().split("\n").length, 10);

		for (const bad of ["yesterday", "May 1 2026", "2026-02-31T00:00:00Z", "2026-13-01"]) {
			const refused = cli(f.root, {}, "events", "--since", bad);
			assert.notEqual(refused.status, 0, bad);
			assert.match(refused.stderr, /--since takes an ISO 8601 time/);
		}
		assert.notEqual(cli(f.root, {}, "events", "--since").status, 0);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-2 one verify records start, end and one suite event per checks.json entry", () => {
	const f = fixture();
	try {
		const { wt, task, taskId } = opsTask(f, [pass, { name: "bad", run: node("process.exit(3)") }]);
		const sha = f.git("-C", wt, "rev-parse", "HEAD");

		const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		const rows = stored(f);
		assert.equal(ofType(rows, "check_start").length, 1);
		assert.equal(ofType(rows, "check_end").length, 1);
		assert.deepEqual(
			ofType(rows, "check_suite_end").map((r) => r.payload.suite),
			report.checks.map((c) => c.name),
		);
		assert.ok(report.checks.length >= 2);
		assert.equal(rows[0].type, "check_start");
		assert.equal(rows.at(-1)!.type, "check_end");
		const start = rows[0].payload,
			end = rows.at(-1)!.payload;
		assert.deepEqual(keys(start), RUN_KEYS);
		assert.deepEqual(keys(end), RUN_KEYS);
		assert.equal(start.durationMs, null);
		assert.equal(start.result, null);
		assert.equal(typeof end.durationMs, "number");
		assert.equal(end.result, "failed");
		for (const p of [start, end]) {
			assert.equal(p.run, null);
			assert.equal(p.task, "OPS-900");
			assert.equal(p.head, sha);
			assert.equal(p.treeHash, f.git("-C", wt, "rev-parse", "HEAD^{tree}"));
			assert.equal(p.role, "author");
			assert.equal(p.mode, "full");
			assert.equal(p.trigger, "manual");
			assert.equal(typeof p.queuedMs, "number");
		}
		for (const r of ofType(rows, "check_suite_end")) {
			assert.deepEqual(keys(r.payload), SUITE_KEYS);
			assert.equal(typeof r.payload.loadStart, "number");
			assert.equal(typeof r.payload.loadEnd, "number");
			assert.equal(r.payload.passed, r.payload.suite !== "bad");
		}

		// run and trigger.
		const db = openWorkDb(f.root);
		const runId = Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', 't')",
				)
				.run(taskId).lastInsertRowid,
		);
		db.close();
		const last = () => stored(f).at(-1)!;
		withRun(String(runId), () => quiet(() => verify(f.root, task, "author", "full")));
		assert.equal(last().run_id, runId);
		assert.equal(last().payload.run, runId);
		assert.equal(last().payload.trigger, "seat");
		withRun("99999", () => quiet(() => verify(f.root, task, "author", "full")));
		assert.equal(last().run_id, null);
		assert.equal(last().payload.run, null);
		assert.equal(last().payload.trigger, "seat");
		withRun(String(runId), () => quiet(() => verify(f.root, task, "author", "full", undefined, undefined, "pr-stage")));
		assert.equal(last().payload.trigger, "pr-stage");
		withRun(undefined, () => quiet(() => check(f.root, task)));
		assert.equal(ofType(stored(f), "check_end").at(-1)!.payload.trigger, "evf-check");

		// A refused run records nothing.
		const before = stored(f).length;
		assert.throws(() => quiet(() => verify(f.root, task, "author", "full", "0".repeat(40))));
		writeFileSync(join(wt, "dirty"), "x");
		assert.throws(() => quiet(() => verify(f.root, task, "author", "full")));
		rmSync(join(wt, "dirty"));
		assert.equal(stored(f).length, before);

		// A run that gives up on the load wait records nothing.
		const limited = { ...f.cfg, machineLoad: { maxPerCore: 0.000001, maxWaitMinutes: 0 } };
		const realLoad = os.loadavg;
		os.loadavg = () => [50, 50, 50];
		syncBuiltinESMExports();
		try {
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(limited));
			assert.throws(() => quiet(() => verify(f.root, task, "author", "full")), /load limit/);
			assert.equal(stored(f).length, before);

			// queuedMs is the load wait: the load falls after the first wait of about 300 ms.
			let reads = 0;
			os.loadavg = () => {
				const load = reads++ ? 0 : 50;
				return [load, load, load];
			};
			syncBuiltinESMExports();
			limited.machineLoad = { maxPerCore: 1, maxWaitMinutes: 0.005 };
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(limited));
			quiet(() => verify(f.root, task, "author", "full"));
			assert.ok(Number(ofType(stored(f), "check_start").at(-1)!.payload.queuedMs) >= 250);
		} finally {
			os.loadavg = realLoad;
			syncBuiltinESMExports();
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-132-2 result covers invalidated and a throw, and a suite's time includes its build lock retries", () => {
	const f = fixture();
	try {
		const flag = join(f.root, "retried");
		const { wt, task } = opsTask(f, [
			{
				name: "locked",
				run: node(
					`const fs=require("node:fs");const p=${JSON.stringify(flag)};if(!fs.existsSync(p)){fs.writeFileSync(p,"");console.log("Another next build process is already running.");process.exit(1)}`,
				),
			},
		]);
		const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		const suite = ofType(stored(f), "check_suite_end")[1].payload;
		assert.equal(suite.passed, true);
		assert.ok(Number(suite.durationMs) >= 10_000, `retry wait is in ${suite.durationMs}`);
		assert.equal(report.checks[1].durationMs, suite.durationMs);
		assert.equal(stored(f).at(-1)!.payload.result, "passed");

		const setChecks = (checks: Check[]) => {
			const cfg = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
			cfg.maintenanceTasks["OPS-900"].checks = checks;
			writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
			f.git("-C", wt, "commit", "-qam", "Change checks");
		};
		setChecks([{ name: "dirties", run: node('require("node:fs").writeFileSync("stray","x")') }]);
		withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full")));
		assert.equal(stored(f).at(-1)!.payload.result, "invalidated");
		rmSync(join(wt, "stray"));

		setChecks([{ name: "bad-report", run: node('require("node:fs").writeFileSync(process.env.EVF_TEST_REPORT,"{")') }]);
		assert.throws(() => withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))));
		const end = stored(f).at(-1)!;
		assert.equal(end.type, "check_end");
		assert.equal(end.payload.result, "error");
		assert.equal(typeof end.payload.durationMs, "number");
	} finally {
		f.close();
	}
});

/** Every checks.json entry has its timing, from the same reading as its suite event. */
function assertTimed(f: Fixture, report: CheckReport) {
	const events = ofType(stored(f), "check_suite_end").filter((e) => e.payload.head === report.sha);
	const latest = events.slice(-report.checks.length);
	assert.deepEqual(
		latest.map((e) => e.payload.suite),
		report.checks.map((c) => c.name),
	);
	for (const [i, c] of report.checks.entries()) {
		assert.equal(typeof c.startedAt, "string", c.name);
		assert.equal(new Date(c.startedAt!).toISOString(), c.startedAt);
		assert.equal(typeof c.durationMs, "number", c.name);
		assert.equal(latest[i].payload.startedAt, c.startedAt);
		assert.equal(latest[i].payload.durationMs, c.durationMs);
	}
	const written = JSON.parse(readFileSync(join(report.evidenceDir, "checks.json"), "utf8")) as CheckReport;
	assert.equal(written.schema, 3);
	assert.deepEqual(written.checks, report.checks);
}

test("AC:OPS-132-3 each checks.json entry holds its suite event's timing and an older record still passes", () => {
	const f = fixture();
	try {
		const { wt, task } = opsTask(f, [pass]);
		const current = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		assertTimed(f, current);

		// The record of a run before this change: no timing fields.
		const sha = f.git("-C", wt, "rev-parse", "HEAD"),
			dir = authorDir(f, task, sha);
		const older = {
			...current,
			passed: true,
			checks: [{ name: "good", command: ["x"], exitCode: 0, log: join(dir, "x.log"), passed: true }],
		};
		writeFileSync(join(dir, "checks.json"), JSON.stringify(older));
		assert.equal(requireVerifiedHead(f.root, task), sha);
		assert.equal(hasVerifiedHead(f.root, task), true);
	} finally {
		f.close();
	}
	const u = fixture();
	try {
		// The not-run ui-escaped entry: a WP /ui part with an escaped test and no running stack.
		u.cfg.checks = [pass];
		u.authorize("WP-005");
		u.commit();
		const task = parseTask("WP-005/ui"),
			wt = u.task(task.slug);
		mkdirSync(join(wt, "tests/ui/escaped"), { recursive: true });
		writeFileSync(join(wt, "tests/ui/escaped/one.test.mjs"), "// escaped\n");
		u.git("-C", wt, "add", "tests");
		u.git("-C", wt, "commit", "-qm", "Add an escaped test");
		const db = openWorkDb(u.root);
		ensureTask(db, task, "implement");
		db.close();
		const report = withRun(undefined, () => quiet(() => verify(u.root, task, "author", "full"))).value;
		assert.deepEqual(
			report.checks.filter((c) => c.name === "ui-escaped").map((c) => c.passed),
			[false],
		);
		assertTimed(u, report);
	} finally {
		u.close();
	}
	const g = fixture();
	try {
		// case-coverage and fresh-checkout-typecheck on a WP task. A private Node folder puts a fake corepack first on PATH.
		writeFileSync(join(g.root, "package.json"), '{"private":true}');
		g.git("add", "package.json");
		g.cfg.checks = [reporting([{ name: "AC:NOT-A-CASE marked", status: "passed" }], 0, "marked")];
		g.authorize("WP-002");
		g.commit();
		const wt = g.task("wp-002"),
			task = parseTask("WP-002");
		const db = openWorkDb(g.root);
		ensureTask(db, task, "implement");
		db.close();
		const nodeDir = join(g.root, "fake-bin/runtime");
		mkdirSync(nodeDir, { recursive: true });
		cpSync(process.execPath, join(nodeDir, "node"));
		writeFileSync(join(nodeDir, "corepack"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(nodeDir, "corepack"), 0o755);
		const r = spawnSync(join(nodeDir, "node"), [MAIN, "verify", "WP-002"], {
			cwd: wt,
			encoding: "utf8",
			env: { ...process.env, EVF_RUN: "", EVF_FOREGROUND: "1" },
		});
		const sha = g.git("-C", wt, "rev-parse", "HEAD");
		const report = JSON.parse(readFileSync(join(authorDir(g, task, sha), "checks.json"), "utf8")) as CheckReport;
		assert.ok(
			report.checks.some((c) => c.name === "fresh-checkout-typecheck"),
			r.stderr,
		);
		assert.ok(
			report.checks.some((c) => c.name === "case-coverage"),
			r.stderr,
		);
		assertTimed(g, report);
	} finally {
		g.close();
	}
});

test("AC:OPS-132-4 a failed test records one test_failed; passed, skipped and name-less failures record none", () => {
	const f = fixture();
	try {
		const { wt, task, commit } = opsTask(f, [
			reporting(
				[
					{ name: "green", status: "passed" },
					{ name: "skipped one", status: "skipped" },
					{ name: "red", status: "failed" },
				],
				1,
			),
		]);
		const sha = f.git("-C", wt, "rev-parse", "HEAD");
		const verifyOnce = () => withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full")));
		verifyOnce();
		let failed = ofType(stored(f), "test_failed");
		assert.equal(failed.length, 1);
		assert.deepEqual(keys(failed[0].payload), FAILED_KEYS);
		assert.deepEqual(failed[0].payload, {
			task: "OPS-900",
			head: sha,
			attempt: 1,
			suite: "reported",
			test: "red",
			touchesTestPaths: false,
			file: null,
			touchesOwnPaths: null,
		});

		// The attempt number counts reruns at this head.
		verifyOnce();
		failed = ofType(stored(f), "test_failed");
		assert.equal(failed.length, 2);
		assert.equal(failed[1].payload.attempt, 2);

		// Each kind of test path in the diff.
		commit("tools/evf/tests/helper.ts", "export {};\n");
		verifyOnce();
		assert.equal(ofType(stored(f), "test_failed").at(-1)!.payload.touchesTestPaths, true);
		assert.equal(ofType(stored(f), "test_failed").at(-1)!.payload.attempt, 1);
		f.git("-C", wt, "rm", "-q", "tools/evf/tests/helper.ts");
		f.git("-C", wt, "commit", "-qm", "Remove helper");
		commit("tools/evf/widget.test.ts", "export {};\n");
		f.git("-C", wt, "rm", "-q", "tools/evf/widget.test.ts");
		f.git("-C", wt, "commit", "-qm", "Remove widget test");
		verifyOnce();
		assert.equal(ofType(stored(f), "test_failed").at(-1)!.payload.touchesTestPaths, false, "no net change");
		commit("tools/evf/widget.test.ts", "export {};\n");
		verifyOnce();
		assert.equal(ofType(stored(f), "test_failed").at(-1)!.payload.touchesTestPaths, true);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-4 a failed check with no test names records no test_failed", () => {
	const f = fixture();
	try {
		const { task } = opsTask(f, [{ name: "silent", run: node("process.exit(1)") }]);
		withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full")));
		assert.equal(ofType(stored(f), "test_failed").length, 0);
		const suites = ofType(stored(f), "check_suite_end");
		assert.equal(suites.find((s) => s.payload.suite === "silent")!.payload.passed, false);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-4 bin/evf test gives verify one name per failed test, not one for its parent", () => {
	const f = fixture();
	try {
		ciFiles(f);
		const { task, commit } = opsTask(f, [evfTest]);
		commit(
			"tools/evf/tests/sample.test.ts",
			sampleTests(
				[
					'test("green", () => {});',
					'test("skipped one", { skip: true }, () => {});',
					'test("parent test", async (t) => { await t.test("child red", () => { throw new Error("boom"); }); });',
					'test.describe("parent suite", () => { test.it("nested red", () => { throw new Error("boom"); }); });',
				].join("\n"),
			),
		);
		withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full")));
		const failed = ofType(stored(f), "test_failed");
		assert.deepEqual(failed.map((e) => e.payload.test).sort(), ["child red", "nested red"]);
		for (const e of failed) {
			assert.equal(e.payload.suite, "workflow");
			assert.equal(e.payload.touchesTestPaths, true);
			assert.equal(e.payload.file, "tools/evf/tests/sample.test.ts");
			assert.equal(e.payload.touchesOwnPaths, true);
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-132-5 a rerun copies the earlier run to attempt-n and the current path holds the newest", () => {
	const f = fixture();
	try {
		const counter = join(f.root, "count");
		const { wt, task } = opsTask(f, [
			{
				name: "counted",
				// Prints its run number and what the evidence folder held when the first check began.
				run: node(
					`const fs=require("node:fs"),p=${JSON.stringify(counter)},n=(fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0)+1;fs.writeFileSync(p,String(n));` +
						`const d=process.env.EVF_EVIDENCE_DIR;console.log("run "+n+" folders "+fs.readdirSync(d).filter(e=>e.includes("attempt")).sort().join(",")+" current "+fs.existsSync(d+"/checks.json"));`,
				),
			},
		]);
		const sha = f.git("-C", wt, "rev-parse", "HEAD"),
			dir = authorDir(f, task, sha);
		const once = () => withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		const folders = () =>
			readdirSync(dir)
				.filter((e) => e.includes("attempt"))
				.sort();
		const logOf = (report: CheckReport) => readFileSync(report.checks[1].log, "utf8");
		const recordIn = (path: string) => JSON.parse(readFileSync(join(path, "checks.json"), "utf8")) as CheckReport;

		const first = once();
		assert.deepEqual(folders(), []);
		const firstFinished = first.finishedAt;

		// Refused: nothing copied.
		assert.throws(() => quiet(() => verify(f.root, task, "author", "full", "0".repeat(40))));
		assert.deepEqual(folders(), []);

		const second = once();
		assert.deepEqual(folders(), ["attempt-1"]);
		assert.match(logOf(second), /run 2 folders attempt-1 current true/);
		const one = recordIn(join(dir, "attempt-1"));
		assert.equal(one.finishedAt, firstFinished);
		assert.equal(one.evidenceDir, join(dir, "attempt-1"));
		assert.ok(one.checks[1].log.startsWith(join(dir, "attempt-1") + "/"));
		assert.match(readFileSync(one.checks[1].log, "utf8"), /run 1 folders/);
		assert.equal(recordIn(dir).finishedAt, second.finishedAt);

		const third = once();
		assert.deepEqual(folders(), ["attempt-1", "attempt-2"]);
		const two = recordIn(join(dir, "attempt-2"));
		assert.equal(two.finishedAt, second.finishedAt);
		assert.match(readFileSync(two.checks[1].log, "utf8"), /run 2 folders/);
		assert.equal(existsSync(join(dir, "attempt-2/attempt-1")), false, "attempt folders are not copied again");
		assert.deepEqual(
			readdirSync(join(dir, "attempt-1")).filter((e) => e.includes("attempt")),
			[],
		);
		assert.equal(recordIn(dir).finishedAt, third.finishedAt);
		assert.match(logOf(third), /run 3/);

		// Another mode has its own folder, and ac evidence never changes.
		const ac = evidenceDir(f.root, task, sha, "ac");
		mkdirSync(join(ac, "criterion-1"), { recursive: true });
		writeFileSync(join(ac, "criterion-1/video.webm"), "x");
		withRun(undefined, () => quiet(() => verify(f.root, task, "author", "quick")));
		assert.deepEqual(
			readdirSync(evidenceDir(f.root, task, sha, "author-quick")).filter((e) => e.includes("attempt")),
			[],
		);
		once();
		assert.deepEqual(readdirSync(ac), ["criterion-1"]);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-6 hasVerifiedHead and pre-push read only the current path", () => {
	const f = fixture();
	try {
		const { wt, task } = opsTask(f, [pass]);
		const sha = f.git("-C", wt, "rev-parse", "HEAD"),
			dir = authorDir(f, task, sha);
		const record = (passed: boolean, extra: object = {}) =>
			JSON.stringify({
				schema: 3,
				task: "OPS-900",
				role: "author",
				mode: "full",
				sha,
				clean: true,
				unchanged: true,
				passed,
				checks: [],
				...extra,
			});
		mkdirSync(join(dir, "attempt-1"), { recursive: true });
		const expect = (allowed: boolean) => {
			assert.equal(hasVerifiedHead(f.root, task), allowed);
			const r = cli(wt, {}, "pre-push", "OPS-900");
			assert.equal(r.status === 0, allowed, r.stderr);
			if (allowed) assert.match(r.stdout, new RegExp(`PASSED pre-push check for ${sha}`));
			else assert.match(r.stderr, /A passing full evf verify OPS-900 record is required/);
		};
		// Newest passed, earlier failed.
		writeFileSync(join(dir, "checks.json"), record(true));
		writeFileSync(join(dir, "attempt-1/checks.json"), record(false));
		expect(true);
		// Newest failed, earlier passed.
		writeFileSync(join(dir, "checks.json"), record(false));
		writeFileSync(join(dir, "attempt-1/checks.json"), record(true));
		expect(false);
		// No current record, earlier passed.
		rmSync(join(dir, "checks.json"));
		expect(false);
		// A record from before this change, with no attempts and no timing.
		rmSync(join(dir, "attempt-1"), { recursive: true });
		writeFileSync(
			join(dir, "checks.json"),
			record(true, { checks: [{ name: "good", command: ["x"], exitCode: 0, log: "x.log", passed: true }] }),
		);
		expect(true);
		writeFileSync(join(dir, "checks.json"), record(false));
		expect(false);

		// A real rerun: failing first, then passing, reads the newest.
		const flip = join(f.root, "flip");
		const cfg = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
		cfg.maintenanceTasks["OPS-900"].checks = [
			{
				name: "flips",
				run: node(
					`const fs=require("node:fs");const p=${JSON.stringify(flip)};if(!fs.existsSync(p)){fs.writeFileSync(p,"");process.exit(1)}`,
				),
			},
		];
		writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
		f.git("-C", wt, "commit", "-qam", "Flip check");
		const run = () => withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		assert.equal(run().passed, false);
		assert.equal(hasVerifiedHead(f.root, task), false);
		assert.equal(run().passed, true);
		assert.equal(hasVerifiedHead(f.root, task), true);
		const newSha = f.git("-C", wt, "rev-parse", "HEAD");
		const earlier = JSON.parse(readFileSync(join(authorDir(f, task, newSha), "attempt-1/checks.json"), "utf8"));
		assert.equal(earlier.passed, false);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-7 no event holds a command argument, secret, connection string, environment value or log text", () => {
	const f = fixture();
	const ARG = "ARG-SECRET-7e1",
		ENV = "ENV-SECRET-41b",
		OUT = "OUTPUT-SECRET-c9d",
		URL = "postgres://owner:URL-SECRET-55a@db.example/app",
		NPG = "npg_NPGSECRET123";
	try {
		const failing = {
			name: "leaky",
			run: node(
				`console.log(${JSON.stringify(OUT)},process.env.FIXTURE_SECRET,process.argv.slice(1).join(" "));
				require("node:fs").writeFileSync(process.env.EVF_TEST_REPORT,JSON.stringify({tests:[{name:"plain name",status:"failed",error:${JSON.stringify(OUT)},annotations:[${JSON.stringify(URL)}]},{name:${JSON.stringify(`connects to ${URL} with ${NPG}`)},status:"failed"}]}));
				process.exit(1)`,
				"--",
				`--password=${ARG}`,
				URL,
			),
		};
		const { task } = opsTask(f, [failing]);
		process.env.FIXTURE_SECRET = ENV;
		const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "full"))).value;
		const rows = stored(f);
		assert.ok(rows.length >= 4);
		const failed = ofType(rows, "test_failed");
		assert.deepEqual(
			failed.map((e) => e.payload.test),
			["plain name", "connects to postgres://<redacted> with <redacted>"],
		);
		for (const r of rows) {
			const text = JSON.stringify(r.payload);
			for (const secret of [ARG, ENV, OUT, "URL-SECRET", "NPGSECRET", "owner:"])
				assert.ok(!text.includes(secret), `${r.type}: ${text}`);
			assert.deepEqual(
				keys(r.payload),
				r.type === "check_suite_end" ? SUITE_KEYS : r.type === "test_failed" ? FAILED_KEYS : RUN_KEYS,
			);
		}
		for (const c of report.checks) {
			assert.ok(!String(c.startedAt).includes("SECRET"));
			assert.equal(typeof c.durationMs, "number");
		}
		// The existing command field and log keep their text.
		const entry = report.checks.find((c) => c.name === "leaky")!;
		assert.ok(entry.command.includes(`--password=${ARG}`));
		assert.ok(entry.command.includes(URL));
		const log = readFileSync(entry.log, "utf8");
		for (const secret of [ARG, ENV, OUT, URL]) assert.ok(log.includes(secret), secret);
	} finally {
		delete process.env.FIXTURE_SECRET;
		f.close();
	}
});

test("AC:OPS-132-8 a signal failure gives one warning line and the same checks, result and exit code", () => {
	const f = fixture();
	try {
		const { wt, task } = opsTask(f, [pass, { name: "bad", run: node("process.exit(4)") }]);
		const sha = f.git("-C", wt, "rev-parse", "HEAD"),
			dir = authorDir(f, task, sha),
			store = workDbPath(f.root);
		const attempt = () => {
			const r = cli(wt, {}, "verify", "OPS-900");
			const report = JSON.parse(readFileSync(join(dir, "checks.json"), "utf8")) as CheckReport;
			return {
				code: r.status,
				passed: report.passed,
				checks: report.checks.map((c) => [c.name, c.exitCode]),
				warnings: r.stderr.split("\n").filter((l) => /warning/i.test(l)),
			};
		};
		const baseline = attempt();
		assert.equal(baseline.code, 1);
		assert.equal(baseline.passed, false);
		assert.deepEqual(baseline.warnings, []);
		const same = (label: string, pattern: RegExp) => {
			const got = attempt();
			assert.deepEqual(
				{ code: got.code, passed: got.passed, checks: got.checks },
				{ code: baseline.code, passed: baseline.passed, checks: baseline.checks },
				label,
			);
			assert.equal(got.warnings.length, 1, `${label}: ${got.warnings.join(" | ")}`);
			assert.match(got.warnings[0], pattern, label);
		};

		// The evidence copy fails: the earlier record cannot be read as JSON. The events still arrive.
		const eventsBefore = stored(f).length;
		writeFileSync(join(dir, "checks.json"), "{ not json");
		same("copy", /evidence not copied/);
		assert.ok(stored(f).length > eventsBefore);
		assert.equal(
			readdirSync(dir).some((e) => e.startsWith(".attempt-")),
			false,
			"no half-built copy stays",
		);

		// Locked: another connection holds the write lock.
		const holder = new DatabaseSync(store);
		holder.exec("PRAGMA busy_timeout = 0");
		holder.exec("BEGIN IMMEDIATE");
		try {
			same("locked", /check events stopped/);
		} finally {
			holder.exec("ROLLBACK");
			holder.close();
		}

		// The store does not know the task.
		const db = openWorkDb(f.root);
		db.exec("PRAGMA foreign_keys = OFF");
		db.prepare("UPDATE tasks SET status = 'abandoned' WHERE ref = 'OPS-900'").run();
		db.close();
		same("unknown", /does not know OPS-900/);
		const db2 = openWorkDb(f.root);
		db2.prepare("UPDATE tasks SET status = 'new' WHERE ref = 'OPS-900'").run();
		db2.close();

		// Read-only. root ignores file modes, so this case proves nothing there.
		if (process.getuid?.() !== 0) {
			chmodSync(store, 0o444);
			try {
				same("read-only", /check events|no check events/);
			} finally {
				chmodSync(store, 0o644);
			}
		}

		// Missing.
		rmSync(store);
		for (const suffix of ["-wal", "-shm"]) rmSync(store + suffix, { force: true });
		same("missing", /no work store/);
		assert.equal(existsSync(store), false, "a signal never creates the store");
	} finally {
		f.close();
	}
});

test("AC:OPS-132-9 failed names from bin/evf test stay out of EVF_TEST_REPORT, so a WP task's case coverage is unchanged", () => {
	const f = fixture();
	try {
		ciFiles(f);
		f.cfg.checks = [evfTest];
		f.authorize("WP-002");
		f.commit();
		const wt = f.task("wp-002"),
			task = parseTask("WP-002");
		const db = openWorkDb(f.root);
		ensureTask(db, task, "implement");
		db.close();
		const commit = (path: string, text: string) => {
			mkdirSync(dirname(join(wt, path)), { recursive: true });
			writeFileSync(join(wt, path), text);
			f.git("-C", wt, "add", path);
			f.git("-C", wt, "commit", "-qm", `Change ${path}`);
		};
		commit(
			"tools/evf/tests/sample.test.ts",
			sampleTests(
				'test("AC:OPS-1-1 marked workflow test", () => {});\ntest("AC:OPS-1-2 marked red", () => { throw new Error("boom"); });',
			),
		);
		const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "quick"))).value;
		assert.deepEqual(
			report.checks.map((c) => [c.name, c.passed]),
			[["workflow", false]],
			"no case-coverage entry",
		);
		const dir = report.evidenceDir;
		assert.equal(existsSync(join(dir, "1-workflow.tests.json")), false);
		assert.deepEqual(
			ofType(stored(f), "test_failed").map((e) => e.payload.test),
			["AC:OPS-1-2 marked red"],
		);

		// A direct run prints what it printed before, with or without the capture, and keeps its exit code.
		const direct = (extra: Record<string, string>) => {
			const r = spawnSync(evfTest.run[0], evfTest.run.slice(1), {
				cwd: wt,
				encoding: "utf8",
				env: { ...process.env, EVF_RUN: "", EVF_FOREGROUND: "1", ...extra },
			});
			return { code: r.status, out: r.stdout.replace(/\(?[\d.]+ ?ms\)?|duration_ms \S+/g, "").replace(/\n+$/, "") };
		};
		const plain = direct({}),
			capture = join(f.root, "names.jsonl"),
			captured = direct({ EVF_FAILED_TESTS: capture });
		assert.equal(plain.code, 1);
		assert.match(plain.out, /marked workflow test/);
		assert.deepEqual(captured, plain);
		assert.equal(
			readFileSync(capture, "utf8"),
			`${JSON.stringify({ name: "AC:OPS-1-2 marked red", file: join(realpathSync(wt), "tools/evf/tests/sample.test.ts") })}\n`,
		);

		// A green suite exits 0 with an empty capture.
		commit("tools/evf/tests/sample.test.ts", 'import test from "node:test";\ntest("AC:OPS-1-1 all good", () => {});\n');
		const green = direct({ EVF_FAILED_TESTS: capture });
		assert.equal(green.code, 0);
		assert.match(green.out, /all good/);
		assert.equal(readFileSync(capture, "utf8"), "");
	} finally {
		f.close();
	}
});

/** A check that runs its shell script the way a package script runs: the flags expand unquoted. */
const shellCheck = (name: string, script: string): Check => ({
	name,
	run: ["env", "-u", "NODE_TEST_CONTEXT", "sh", "-c", script],
});
const NODE_TEST = `"${process.execPath}" --test \${EVF_NODE_TEST_FLAGS:-}`;
const redAndGreen = sampleTests(`
test("AC:OPS-1-3 red one", () => { throw new Error("boom"); });
test("green one", () => {});
test("parent", async (t) => { await t.test("red child", () => { throw new Error("boom"); }); });
`);

test("T-2 a package script in package-unit-tests names each failed test, across two commands, and turns on no case coverage", () => {
	const f = fixture();
	try {
		f.cfg.checks = [
			shellCheck(
				"package-unit-tests",
				`${NODE_TEST} a.test.mjs; first=$?; ${NODE_TEST} b.test.mjs; exit $(($first + $?))`,
			),
		];
		f.authorize("WP-002");
		f.commit();
		const wt = f.task("wp-002"),
			task = parseTask("WP-002"),
			db = openWorkDb(f.root);
		ensureTask(db, task, "implement");
		db.close();
		for (const [path, text] of [
			["a.test.mjs", redAndGreen],
			[
				"b.test.mjs",
				sampleTests('test("green one", () => {});\ntest("red in b", () => { throw new Error("boom"); });'),
			],
		]) {
			writeFileSync(join(wt, path), text);
			f.git("-C", wt, "add", path);
		}
		f.git("-C", wt, "commit", "-qm", "Tests");
		const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "quick"))).value;
		assert.deepEqual(
			report.checks.map((c) => [c.name, c.passed]),
			[["package-unit-tests", false]],
			"no case-coverage entry",
		);
		assert.deepEqual(
			ofType(stored(f), "test_failed")
				.map((e) => [e.payload.suite, e.payload.test, e.payload.file])
				.sort(),
			[
				["package-unit-tests", "AC:OPS-1-3 red one", "a.test.mjs"],
				["package-unit-tests", "red child", "a.test.mjs"],
				["package-unit-tests", "red in b", "b.test.mjs"],
			],
		);
		const log = readFileSync(report.checks[0].log, "utf8");
		assert.match(log, /✖ AC:OPS-1-3 red one/);
		assert.match(log, /✔ green one/);
		assert.doesNotMatch(log, /"name":/, "names go to their file only");
	} finally {
		f.close();
	}
});

test("T-2 a failed step that is no test and a check outside the two record no name", () => {
	const typecheck: Check = { name: "local-app", run: ["sh", "-c", "echo typecheck failed; exit 2"] };
	for (const check of [typecheck, shellCheck("other", `${NODE_TEST} tools/evf/a.test.mjs`)]) {
		const f = fixture();
		try {
			const { task, commit } = opsTask(f, [check]);
			commit("tools/evf/a.test.mjs", redAndGreen);
			const report = withRun(undefined, () => quiet(() => verify(f.root, task, "author", "quick"))).value;
			assert.deepEqual(
				report.checks.filter((c) => !c.passed).map((c) => c.name),
				[check.name],
			);
			assert.deepEqual(ofType(stored(f), "test_failed"), []);
			assert.deepEqual(
				ofType(stored(f), "check_suite_end")
					.filter((e) => !e.payload.passed)
					.map((e) => e.payload.suite),
				[check.name],
			);
		} finally {
			f.close();
		}
	}
});

test("T-2 two tests with one name in two files record two events", () => {
	const f = fixture();
	try {
		const { task, commit } = opsTask(f, [
			shellCheck("package-unit-tests", `${NODE_TEST} tools/evf/a.test.mjs tools/evf/b.test.mjs`),
		]);
		const red = sampleTests('test("same name", () => { throw new Error("boom"); });');
		commit("tools/evf/a.test.mjs", red);
		commit("tools/evf/b.test.mjs", red);
		withRun(undefined, () => quiet(() => verify(f.root, task, "author", "quick")));
		assert.deepEqual(
			ofType(stored(f), "test_failed")
				.map((e) => e.payload.file)
				.sort(),
			["tools/evf/a.test.mjs", "tools/evf/b.test.mjs"],
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-10 evf status recent leaves out the four new events and keeps its limit of 50", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root),
			id = ensureTask(db, parseTask("OPS-7"), "implement").id;
		const types = ["check_start", "check_end", "check_suite_end", "test_failed"];
		record(db, id, null, "reopen", { summary: "the row to keep" });
		for (let i = 0; i < 60; i++) record(db, id, null, types[i % 4], {});
		db.close();
		const recent = (...args: string[]) =>
			(
				JSON.parse(cli(f.root, {}, "status", "--json", ...args).stdout) as { recent: Array<{ type: string }> }
			).recent.map((e) => e.type);
		for (const args of [[], ["OPS-7"]]) assert.ok(recent(...args).includes("reopen"), args.join());
		for (const type of recent()) assert.ok(!types.includes(type), type);
		const db2 = openWorkDb(f.root);
		for (let i = 0; i < 60; i++) record(db2, id, null, "nudge", {});
		db2.close();
		assert.equal(recent().length, 50);
		assert.equal(recent("OPS-7").length, 50);
		const all = JSON.parse(cli(f.root, {}, "events", "--json").stdout) as Array<{ type: string }>;
		for (const type of types) assert.equal(all.filter((e) => e.type === type).length, 15, type);
	} finally {
		f.close();
	}
});

test("AC:OPS-132-11 evf help and the README document events, the signals, attempt-n and the test name limit", () => {
	const help = spawnSync(process.execPath, [MAIN, "help"], { encoding: "utf8" }).stdout;
	assert.match(help, /evf events \[--since <time>\] \[--type <name>\] \[--task <task>\] \[--json\]/);
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8");
	assert.match(readme, /`evf events \[--since <time>\] \[--type <name>\] \[--task <task>\] \[--json\]`/);
	for (const type of ["check_start", "check_end", "check_suite_end", "test_failed"])
		assert.ok(readme.includes(`\`${type}\``), type);
	for (const field of new Set([...RUN_KEYS, ...SUITE_KEYS, ...FAILED_KEYS]))
		assert.ok(readme.includes(`\`${field}\``), field);
	assert.match(readme, /`<evidence dir>\/attempt-<n>`/);
	assert.match(readme, /`test_failed` has a limit: only a check that reports test names/);
});
