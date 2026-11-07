import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tool = resolve(import.meta.dirname, "../ci-tests.ts");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ci-tests-"));
	execFileSync("git", ["init", "--quiet", root]);
	return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

const cli = (root: string) => spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });

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
		let result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 2 test files/);
		writeFileSync(join(f.root, "tests/integration/access/missing.test.mts"), "");
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^ci-tests: Tests missing from CI commands/);
		assert.match(result.stderr, /tests\/integration\/access\/missing\.test\.mts/);
		const manifest = join(f.root, "packages/domain/package.json");
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		pkg.scripts["test:access"] = "node --test ../../tests/integration/access/*.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 3 test files/);
		mkdirSync(join(f.root, "tools/ci"), { recursive: true });
		const exceptions = join(f.root, "tools/ci/ci-test-exceptions.json");
		const omitted = "tests/integration/access/local-only.test.mts";
		writeFileSync(join(f.root, omitted), "");
		pkg.scripts["test:access"] =
			"node --test ../../tests/integration/access/one.test.mts ../../tests/integration/access/missing.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		writeFileSync(
			exceptions,
			JSON.stringify({ [omitted]: { reason: "Requires a local preview, D63a", command: "pnpm test:access" } }),
		);
		result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /1 explicit local-only exception/);
		pkg.scripts["test:access"] = "node --test ../../tests/integration/access/*.test.mts";
		writeFileSync(manifest, JSON.stringify(pkg));
		result = cli(f.root);
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
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /hidden\.test\.mts/);
		writeFileSync(workflow, original + "      - run: |\n          pnpm test\n");
		result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 5 test files/);
	} finally {
		f.close();
	}
});

test("INV-ci-db-matrix: a package-name matrix covers its packages' tests and must list every package with the script", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		mkdirSync(join(f.root, "tests/integration/db"), { recursive: true });
		mkdirSync(join(f.root, "tests/integration/writes"), { recursive: true });
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
		writeFileSync(join(f.root, "tests/integration/writes/suites.json"), "[]");
		for (const [name, test] of [
			["db", "db/baseline.test.mts"],
			["domain", "writes/statements.test.mts"],
		]) {
			mkdirSync(join(f.root, `packages/${name}`), { recursive: true });
			writeFileSync(
				join(f.root, `packages/${name}/package.json`),
				JSON.stringify({
					name: `@everyfield/${name}`,
					scripts: { "test:db": `node --test ../../tests/integration/${test}` },
				}),
			);
			writeFileSync(join(f.root, "tests/integration", test), "");
		}
		const workflow = (packages: string[]) =>
			writeFileSync(
				join(f.root, ".github/workflows/ci.yml"),
				"jobs:\n  db:\n    name: db (${{ matrix.package }})\n    strategy:\n      matrix:\n        include:\n" +
					packages.map((p) => `          - package: "${p}"\n            build: true\n`).join("") +
					'    steps:\n      - run: pnpm --filter "${{ matrix.package }}" test:db\n',
			);
		workflow(["@everyfield/db", "@everyfield/domain"]);
		let result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 2 test files/);
		workflow(["@everyfield/db"]);
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must list exactly the packages that define it\. Missing: @everyfield\/domain\./);
		workflow(["@everyfield/db", "@everyfield/domain", "@everyfield/gone"]);
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unknown: @everyfield\/gone\./);
	} finally {
		f.close();
	}
});

test("CI runs this check on its own, in the tools job the required ci check needs", () => {
	const workflow = readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");
	const job = workflow.split(/(?=^  [\w-]+:\s*$)/m).find((part) => part.startsWith("  tools:"));
	assert.ok(job, "ci.yml has a tools job");
	assert.match(job, /^ +run: node tools\/ci\/ci-tests\.ts$/m);
	assert.match(workflow, /needs: \[[^\]]*\btools\b[^\]]*\]/);
});
