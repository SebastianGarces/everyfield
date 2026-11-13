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

test("BUG-3b7185b67: follow recursive scripts, filters and file globs; fail an unlisted integration test", () => {
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
		] as const) {
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

test("INV-ci-tests: an unlisted tests/unit or pure tests/ui test fails the guard; a browser suite importing setup.mjs is not required", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		mkdirSync(join(f.root, "apps/web"), { recursive: true });
		mkdirSync(join(f.root, "packages/domain/test"), { recursive: true });
		mkdirSync(join(f.root, "tests/ui/people"), { recursive: true });
		mkdirSync(join(f.root, "tests/unit/people"), { recursive: true });
		mkdirSync(join(f.root, "tests/reference/releases"), { recursive: true });
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
		writeFileSync(
			join(f.root, "packages/domain/package.json"),
			JSON.stringify({ name: "@everyfield/domain", scripts: { test: "tsx --test test/*.test.ts" } }),
		);
		writeFileSync(join(f.root, "packages/domain/test/rules.test.ts"), "");
		writeFileSync(
			join(f.root, "apps/web/package.json"),
			JSON.stringify({
				name: "@everyfield/web",
				scripts: {
					"test:unit": "node --test ../../tests/unit/people/model.test.mjs ../../tests/reference/releases/*.db.mts",
				},
			}),
		);
		writeFileSync(join(f.root, "tests/ui/setup.mjs"), "");
		writeFileSync(join(f.root, "tests/unit/people/model.test.mjs"), 'import "node:test";\n');
		writeFileSync(join(f.root, "tests/ui/people/browser.test.mjs"), 'import { launch } from "../setup.mjs";\n');
		writeFileSync(join(f.root, "tests/reference/releases/pin.db.mts"), "");
		writeFileSync(
			join(f.root, ".github/workflows/ci.yml"),
			"jobs:\n  tests:\n    steps:\n      - run: pnpm -r --if-present test:unit\n      - run: pnpm -r --if-present test\n",
		);
		let result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 3 test files/);
		writeFileSync(join(f.root, "tests/unit/people/new-model.test.mts"), 'import "node:test";\n');
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/^ci-tests: Tests missing from CI commands:\ntests\/unit\/people\/new-model\.test\.mts\n/,
		);
		rmSync(join(f.root, "tests/unit/people/new-model.test.mts"));
		writeFileSync(join(f.root, "tests/ui/people/new-model.test.mjs"), 'import "node:test";\n');
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/^ci-tests: Tests missing from CI commands:\ntests\/ui\/people\/new-model\.test\.mjs\n/,
		);
	} finally {
		f.close();
	}
});

test("INV-ci-db-steps: each package with test:db needs a CI step, and the domain census matrix runs by part", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
		for (const name of ["db", "evry", "domain"]) {
			mkdirSync(join(f.root, `packages/${name}`), { recursive: true });
			mkdirSync(join(f.root, `tests/integration/${name}`), { recursive: true });
			writeFileSync(
				join(f.root, `packages/${name}/package.json`),
				JSON.stringify({
					name: `@everyfield/${name}`,
					scripts: { "test:db": `node --test ../../tests/integration/${name}/*.test.mts` },
				}),
			);
			writeFileSync(join(f.root, `tests/integration/${name}/one.test.mts`), "");
		}
		const workflow = (packages: string[]) =>
			writeFileSync(
				join(f.root, ".github/workflows/ci.yml"),
				"jobs:\n  db:\n    steps:\n      - run: pnpm db:migrate\n" +
					packages.map((p) => `      - name: "${p} tests"\n        run: pnpm --filter "${p}" test:db\n`).join("") +
					"  domain:\n    strategy:\n      matrix:\n        include:\n          - part: 1\n            build: true\n" +
					"          - part: 2\n    steps:\n" +
					'      - run: pnpm --filter "@everyfield/domain" test:db\n',
			);
		workflow(["@everyfield/db", "@everyfield/evry"]);
		let result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 3 test files/);
		// The dropped package's suite is still listed elsewhere, so only the test:db rule can catch the missing step.
		writeFileSync(
			join(f.root, "package.json"),
			JSON.stringify({ scripts: { other: "node --test tests/integration/evry/one.test.mts" } }),
		);
		workflow(["@everyfield/db"]);
		writeFileSync(
			join(f.root, ".github/workflows/ci.yml"),
			readFileSync(join(f.root, ".github/workflows/ci.yml"), "utf8") + "      - run: pnpm other\n",
		);
		result = cli(f.root);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "ci-tests: ci.yml runs no test:db for @everyfield/evry. Add a step to the db job.\n");
	} finally {
		f.close();
	}
});

test("INV-ci-tests: a test file run by two CI commands fails and names both; the census union step is no second run", () => {
	const f = fixture();
	try {
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		mkdirSync(join(f.root, "packages/domain"), { recursive: true });
		mkdirSync(join(f.root, "tests/integration/writes"), { recursive: true });
		mkdirSync(join(f.root, "tests/integration/documents"), { recursive: true });
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
		const scripts = (unit: string) =>
			writeFileSync(
				join(f.root, "packages/domain/package.json"),
				JSON.stringify({
					name: "@everyfield/domain",
					scripts: {
						"test:unit": `node --test ${unit}`,
						"test:db": "pnpm test:writes",
						"test:writes": "node --test ../../tests/integration/writes/statements.test.mts",
					},
				}),
			);
		writeFileSync(join(f.root, "tests/integration/writes/statements.test.mts"), "");
		writeFileSync(join(f.root, "tests/integration/writes/suites.json"), '["tests/integration/documents/*.test.mts"]');
		writeFileSync(join(f.root, "tests/integration/documents/engine.test.mts"), "");
		writeFileSync(join(f.root, "tests/integration/documents/owned.test.mts"), "");
		writeFileSync(
			join(f.root, ".github/workflows/ci.yml"),
			"jobs:\n  app:\n    steps:\n      - run: pnpm -r --if-present test:unit\n" +
				'  domain:\n    steps:\n      - run: pnpm --filter "@everyfield/domain" test:db\n' +
				"  ci:\n    steps:\n      - name: Statement budgets over the union of the parts\n" +
				"        run: node --test tests/integration/writes/statements.test.mts\n" +
				"        env:\n          EVF_CENSUS_UNION: ${{ runner.temp }}/census\n",
		);
		scripts("../../tests/integration/documents/engine.test.mts");
		let result = cli(f.root);
		assert.equal(result.status, 1);
		assert.equal(
			result.stderr,
			"ci-tests: Tests run by more than one CI command:\n" +
				"tests/integration/documents/engine.test.mts: @everyfield/domain test:unit and @everyfield/domain test:writes\n" +
				"Run each file in exactly one command.\n",
		);
		writeFileSync(
			join(f.root, "tests/integration/writes/suites.json"),
			'["tests/integration/documents/owned.test.mts"]',
		);
		result = cli(f.root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CI includes all 3 test files/);
	} finally {
		f.close();
	}
});

test("INV-ci-tests: CI runs this check on its own, in the tooling job the required ci check needs", () => {
	const workflow = readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");
	const job = workflow.split(/(?=^  [\w-]+:\s*$)/m).find((part) => part.startsWith("  tooling:"));
	assert.ok(job, "ci.yml has a tooling job");
	assert.match(job, /^ +run: node tools\/ci\/ci-tests\.ts$/m);
	assert.match(workflow, /needs: \[[^\]]*\btooling\b[^\]]*\]/);
});
