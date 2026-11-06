import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source, setTasks } from "./fixtures.ts";

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, detached = false) {
	return spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
		detached,
	});
}

test("BUG-OPS10-foreground: detached checks refuse before work; explicit supervision waits for the result", () => {
	const f = fixture();
	try {
		f.tasks = {
			"OPS-1": {
				title: "Foreground",
				owningPaths: ["evf.config.json"],
				checks: [
					{ name: "wait", run: [process.execPath, "-e", 'setTimeout(() => console.log("finished check"), 100)'] },
				],
			},
		};
		setTasks(f.root, f.tasks);
		f.commit();
		f.task("ops-1");
		for (const args of [
			["verify", "OPS-1"],
			["pre-push", "OPS-1"],
			["stack", "up", "WP-001"],
		]) {
			// Refusal needs a detached session even when the test runner has a foreground terminal.
			const result = cli(f.root, args, { EVF_MONITOR: "", EVF_FOREGROUND: "" }, true);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /detached.*terminal/i);
			assert.match(result.stderr, /stay in your turn.*EVF_MONITOR/i);
		}
		for (const env of [
			{ EVF_FOREGROUND: "1", EVF_MONITOR: "" },
			{ EVF_FOREGROUND: "", EVF_MONITOR: "test-runner" },
		]) {
			const result = cli(f.root, ["verify", "OPS-1"], env);
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stderr, /expected duration/i);
			assert.match(result.stdout, /PASSED local tooling checks/);
			const match = result.stdout.match(/checks: (.*checks\.json)/);
			assert.ok(match);
			const report = JSON.parse(readFileSync(match[1], "utf8"));
			assert.match(readFileSync(report.checks[1].log, "utf8"), /finished check/);
			const push = cli(f.root, ["pre-push", "OPS-1"], env);
			assert.equal(push.status, 0, push.stderr);
			assert.match(push.stderr, /expected duration/);
			assert.match(push.stdout, /PASSED pre-push check/);
		}
		f.cfg.stack = {
			usesPaidProviders: false,
			up: [process.execPath, "-e", 'setTimeout(() => console.log("stack ready"), 100)'],
		};
		f.authorize("WP-001");
		f.commit();
		f.task("wp-001");
		const up = cli(f.root, ["stack", "up", "WP-001"], { EVF_MONITOR: "test-runner" });
		assert.equal(up.status, 0, up.stderr);
		assert.match(up.stderr, /expected duration/);
		assert.match(up.stdout, /stack ready/);
	} finally {
		f.close();
	}
});

// The moved tools keep their old bin/evf names until bin/evf goes away. Their own tests are under tools/qa and tools/ci.
test("bin/evf qa and bin/evf ci-tests reach the moved tools and report a refusal on one line", () => {
	const f = fixture();
	try {
		const list = cli(f.root, ["qa", "list"]);
		assert.equal(list.status, 0, list.stderr);
		assert.equal(list.stdout.trim(), "No open QA previews.");
		const down = cli(f.root, ["qa", "down", "not-a-preview"]);
		assert.equal(down.status, 1);
		assert.match(down.stderr, /^evf: not-a-preview is not a QA preview id/);
		writeFileSync(join(f.root, "package.json"), "{}");
		const coverage = cli(f.root, ["ci-tests"]);
		assert.equal(coverage.status, 1);
		assert.match(coverage.stderr, /^evf: package\.json needs a scripts object/);
	} finally {
		f.close();
	}
});
