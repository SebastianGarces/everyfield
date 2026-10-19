import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";

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
		f.cfg.maintenanceTasks = {
			"OPS-1": {
				title: "Foreground",
				owningPaths: ["evf.config.json"],
				checks: [
					{ name: "wait", run: [process.execPath, "-e", 'setTimeout(() => console.log("finished check"), 100)'] },
				],
			},
		};
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
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
			assert.match(readFileSync(report.checks[0].log, "utf8"), /finished check/);
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

test("BUG-OPS10-ci: follow recursive scripts, filters and file globs; fail an unlisted integration test", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		mkdirSync(join(f.root, "packages/domain/test"), { recursive: true });
		mkdirSync(join(f.root, "tests/integration/access"), { recursive: true });
		writeFileSync(
			join(f.root, "package.json"),
			JSON.stringify({ scripts: { "test:access": "pnpm --filter @everyfield/domain test:access" } }),
		);
		writeFileSync(
			join(f.root, "packages/domain/package.json"),
			JSON.stringify({
				name: "@everyfield/domain",
				scripts: {
					"test:unit": 'node --test "test/*.test.mts"',
					"test:access": "node --test ../../tests/integration/access/one.test.mts",
				},
			}),
		);
		writeFileSync(join(f.root, "packages/domain/test/unit.test.mts"), "");
		writeFileSync(join(f.root, "tests/integration/access/one.test.mts"), "");
		writeFileSync(
			join(f.root, ".github/workflows/ci.yml"),
			"jobs:\n  tests:\n    steps:\n      - run: pnpm -r --if-present test:unit\n      - run: pnpm test:access\n",
		);
		let result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 2 test files/);
		writeFileSync(join(f.root, "tests/integration/access/missing.test.mts"), "");
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /tests\/integration\/access\/missing\.test\.mts/);
		const manifest = join(f.root, "packages/domain/package.json");
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		pkg.scripts["test:access"] = "node --test ../../tests/integration/access/*.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 3 test files/);
		mkdirSync(join(f.root, "tools/evf"), { recursive: true });
		const exceptions = join(f.root, "tools/evf/ci-test-exceptions.json");
		const omitted = "tests/integration/access/local-only.test.mts";
		writeFileSync(join(f.root, omitted), "");
		pkg.scripts["test:access"] =
			"node --test ../../tests/integration/access/one.test.mts ../../tests/integration/access/missing.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		writeFileSync(
			exceptions,
			JSON.stringify({ [omitted]: { reason: "Requires a local preview, D63a", command: "pnpm test:access" } }),
		);
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /1 explicit local-only exception/);
		pkg.scripts["test:access"] = "node --test ../../tests/integration/access/*.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /stale CI exception/);
		writeFileSync(exceptions, "{}");
		const hidden = "tests/integration/access/hidden.test.mts";
		writeFileSync(join(f.root, hidden), "");
		writeFileSync(
			join(f.root, "package.json"),
			JSON.stringify({
				scripts: { "test:access": "pnpm --filter @everyfield/domain test:access", test: `node --test ${hidden}` },
			}),
		);
		pkg.scripts["test:access"] =
			"node --test ../../tests/integration/access/one.test.mts ../../tests/integration/access/missing.test.mts ../../tests/integration/access/local-only.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		const workflow = join(f.root, ".github/workflows/ci.yml");
		const original = readFileSync(workflow, "utf8");
		writeFileSync(
			workflow,
			original +
				"  wiki:\n    defaults:\n      run:\n        working-directory: tools/wiki\n    steps:\n      - run: pnpm test\n",
		);
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /hidden\.test\.mts/);
		writeFileSync(workflow, original + "      - run: |\n          pnpm test\n");
		result = cli(f.root, ["ci-tests"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 5 test files/);
	} finally {
		f.close();
	}
});
