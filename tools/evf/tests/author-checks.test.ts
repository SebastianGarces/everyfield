import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, source } from "./fixtures.ts";
import { evfDataDir, git, parseTask } from "../lib.ts";
import { verify } from "../verify.ts";

const task = parseTask("OPS-1");
const node = (script: string) => [process.execPath, "-e", script];
const touch = (path: string) => `require("node:fs").writeFileSync(${JSON.stringify(path)}, "ran")`;

/** A fixture whose OPS-1 runs `checks`, with `format` running the given script. */
function setup(checks: Array<{ name: string; run: string[] }>, format = "") {
	const f = fixture();
	f.cfg.checks = f.cfg.checks.map((c: { name: string }) => (c.name === "format" ? { ...c, run: node(format) } : c));
	f.cfg.maintenanceTasks = {
		"OPS-1": { title: "Checks", owningPaths: ["tools/evf/", "evf.config.json", "docs/notes.md"], checks },
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const wt = f.task("ops-1");
	return { ...f, wt };
}
function cli(cwd: string, ...args: string[]) {
	return spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd, encoding: "utf8" });
}
/** The checks.json of one role at the worktree head. */
function record(f: ReturnType<typeof setup>, kind: "author-full" | "verifier-full") {
	const sha = git(f.wt, "rev-parse", "HEAD");
	return JSON.parse(readFileSync(join(evfDataDir(f.root), "evidence/ops-1", sha, kind, "checks.json"), "utf8"));
}

test("OPS-144-1: a format error fails author verify first, starts no other check, and names the prettier command", () => {
	const f = setup(
		[{ name: "long", run: node(touch("long-ran")) }],
		'console.error("[warn] apps/bad.ts");process.exit(1)',
	);
	try {
		const result = cli(f.wt, "verify", "OPS-1");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /corepack pnpm format \(prettier --write\)/);
		assert.match(result.stderr, /\[warn\] apps\/bad\.ts/);
		assert.equal(existsSync(join(f.wt, "long-ran")), false, "no long check started");
		const report = record(f, "author-full");
		assert.deepEqual(
			report.checks.map((c: { name: string; passed: boolean }) => [c.name, c.passed]),
			[["format", false]],
		);
		assert.match(readFileSync(report.checks[0].log, "utf8"), /corepack pnpm format \(prettier --write\)/);
	} finally {
		f.close();
	}
});

test("OPS-144-2,8: an author run stops at its first failure, records what did not run, and pre-push refuses it", () => {
	const f = setup([
		{ name: "green", run: node("") },
		{ name: "red", run: node("process.exit(3)") },
		{ name: "after", run: node(touch("after-ran")) },
	]);
	try {
		assert.equal(cli(f.wt, "verify", "OPS-1").status, 1);
		assert.equal(existsSync(join(f.wt, "after-ran")), false);
		const stopped = record(f, "author-full");
		assert.deepEqual(
			stopped.checks.map((c: { name: string }) => c.name),
			["format", "green", "red"],
		);
		assert.equal(stopped.stoppedAfter, "red");
		assert.deepEqual(stopped.notRun, ["after", "package-unit-tests", "ui-escaped"]);
		assert.equal(stopped.passed, false);
		const refused = cli(f.wt, "pre-push", "OPS-1");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /passing full evf verify/);
	} finally {
		f.close();
	}
});

test("OPS-144-3: a verifier run records every check after a failure and no stop", () => {
	const f = setup([
		{ name: "red", run: node("process.exit(3)") },
		{ name: "after", run: node("") },
	]);
	try {
		const reviewer = join(f.root, ".worktrees/reviewer");
		f.git("worktree", "add", "--detach", reviewer, "HEAD");
		assert.equal(cli(reviewer, "verify", "OPS-1", "--role", "verifier").status, 1);
		const report = record(f, "verifier-full");
		assert.deepEqual(
			report.checks.map((c: { name: string; passed: boolean }) => [c.name, c.passed]),
			[
				["format", true],
				["red", false],
				["after", true],
				["package-unit-tests", true],
			],
		);
		assert.equal("notRun" in report, false);
		assert.equal("stoppedAfter" in report, false);
	} finally {
		f.close();
	}
});

/** A branch with a real `evf test` check. Its one tooling test leaves a marker outside the checkout when it runs. */
function regressions() {
	const f = fixture();
	const started = join(f.root, "..", `started-${process.pid}-${Date.now()}`);
	mkdirSync(join(f.root, "tools/evf/tests"), { recursive: true });
	mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
	writeFileSync(join(f.root, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: bin/evf test\n");
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
	writeFileSync(
		join(f.root, "tools/evf/tests/one.test.ts"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started)}, "started");\n`,
	);
	f.cfg.maintenanceTasks = {
		"OPS-1": {
			title: "Checks",
			owningPaths: ["tools/evf/", "evf.config.json", "docs/notes.md"],
			checks: [
				{
					name: "workflow-regressions",
					run: ["env", "-u", "NODE_TEST_CONTEXT", process.execPath, join(source, "tools/evf/main.ts"), "test"],
				},
			],
		},
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.git("add", "-A");
	f.git("commit", "-qm", "Fixture");
	return { f, wt: f.task("ops-1"), started };
}

test("OPS-144-4,5,8: the record shows a skip with its reason, pre-push accepts it, and a tool path runs the suite", () => {
	const { f, wt, started } = regressions();
	try {
		const commit = (path: string) => {
			mkdirSync(join(wt, path, ".."), { recursive: true });
			writeFileSync(join(wt, path), "changed\n");
			git(wt, "add", "-A");
			git(wt, "commit", "-qm", "change");
		};
		const check = () => verify(f.root, task, "author", "full").checks.find((c) => c.name === "workflow-regressions")!;

		commit("docs/notes.md");
		const skipped = check();
		assert.equal(skipped.passed, true, readFileSync(skipped.log, "utf8"));
		assert.match(skipped.skipped ?? "", /^1 changed file\(s\) since \w+ and none is evf work$/);
		assert.equal(existsSync(started), false);
		assert.equal(cli(wt, "pre-push", "OPS-1").status, 0, "a passing run with a skip passes pre-push");

		commit("tools/evf/x.ts");
		const ran = check();
		assert.equal(ran.passed, true);
		assert.equal("skipped" in ran, false);
		assert.equal(existsSync(started), true);
	} finally {
		rmSync(started, { force: true });
		f.close();
	}
});

test("OPS-144-6,7: every push to main runs the suite, and the skip leaves the required ci job's input a success", () => {
	const ci = readFileSync(join(source, ".github/workflows/ci.yml"), "utf8");
	assert.match(ci, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]/m);
	assert.match(ci, /^ +- run: bin\/evf test \$\{\{ github\.event_name == 'push' && '--all' \|\| '' \}\}$/m);
	// A skip happens inside a step that exits 0, so the evf job reports success, the value the ci job requires.
	const evfJob = ci.slice(ci.indexOf("\n  evf:\n"), ci.indexOf("\n  db:\n"));
	assert.doesNotMatch(evfJob, /^ {4}if:/m, "the job itself never skips");
	assert.match(ci, /needs: \[[^\]]*\bevf\b[^\]]*\]/);
	assert.match(ci, /\[ "\$r" = success \] \|\| exit 1/);
});
