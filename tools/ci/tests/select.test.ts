// T-41: what `selectChecks` runs for a change, and the reachability lint over this checkout. CI_SELECT_MODULE swaps in
// another select.ts, which select-sabotage.test.ts uses to prove these cases catch a broken selection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const select = (await import(process.env.CI_SELECT_MODULE ?? "../select.ts")) as typeof import("../select.ts");
const { CHECKS, RULES, parseCoverageMap, selectChecks, unreachable } = select;
type Selection = import("../select.ts").Selection;
type Context = import("../select.ts").Context;

const NOW = new Date("2026-11-09T12:00:00Z");
const TESTS = [
	".github/scripts/fail-forward.test.cjs",
	"ops/actionable-watch/test/io.test.mts",
	"ops/actionable-watch/test/observe.test.mts",
	"tests/workflow/dev.test.mjs",
	"tests/workflow/evry-evals-coverage.test.mjs",
	"tests/workflow/nightly.test.ts",
	"tests/workflow/role-prompts.test.mjs",
	"tests/workflow/server-logs.test.mjs",
	"tests/workflow/setup-step.test.mjs",
	"tests/workflow/stack.test.mjs",
	"tools/ci/tests/select.test.ts",
	"tools/qa/tests/qa.test.ts",
];
const context: Context = {
	testFiles: TESTS,
	now: NOW,
	packages: [
		{
			dir: "apps/web",
			name: "@everyfield/web",
			scripts: { "test:unit": "node --test ../../tests/ui/tasks/model.test.mjs" },
		},
		{
			dir: "packages/db",
			name: "@everyfield/db",
			scripts: { "test:unit": "node --test ../../tests/integration/db/*.test.mts" },
		},
		{
			dir: "packages/evry",
			name: "@everyfield/evry",
			scripts: { "test:unit": "node --test ../../tests/evry/evals/*.test.mts" },
		},
		{ dir: "packages/ui", name: "@everyfield/ui", scripts: { lint: "eslint .", typecheck: "tsc --noEmit" } },
	],
};
const map = {
	head: "0123456789abcdef0123456789abcdef01234567",
	createdAt: "2026-11-08T03:00:00Z",
	tests: {
		".github/scripts/fail-forward.test.cjs": [".github/scripts/fail-forward.cjs"],
		"ops/actionable-watch/test/io.test.mts": ["ops/actionable-watch/io.mts", "ops/actionable-watch/observe.mts"],
		"ops/actionable-watch/test/observe.test.mts": ["ops/actionable-watch/observe.mts"],
		"tests/workflow/dev.test.mjs": ["scripts/browser.ts", "scripts/dev.ts"],
		// What a map built before the read tracer holds: V8 coverage alone sees nothing these tests read as text.
		"tests/workflow/evry-evals-coverage.test.mjs": [],
		"tests/workflow/nightly.test.ts": ["scripts/nightly.ts"],
		"tests/workflow/role-prompts.test.mjs": [],
		"tests/workflow/server-logs.test.mjs": [],
		"tests/workflow/setup-step.test.mjs": ["scripts/setup-step.mjs", "scripts/stack.mjs"],
		"tests/workflow/stack.test.mjs": ["scripts/stack.mjs"],
		"tools/ci/tests/select.test.ts": ["tools/ci/select.ts"],
		"tools/qa/tests/qa.test.ts": ["tools/qa/qa.ts", "tools/qa/store.ts"],
	},
};

/** The checks and tests that run, each with its reason; everything else must be skipped with the stated reason. */
function assertSelected(
	s: Selection,
	want: { checks: Record<string, string>; tests: Record<string, string>; filters?: string[] },
) {
	assert.equal(s.mode, "selected");
	assert.deepEqual(s.fullReasons, []);
	assert.deepEqual(
		s.checks,
		Object.fromEntries(
			Object.keys(CHECKS).map((id) => [
				id,
				id in want.checks
					? { run: true, reason: want.checks[id] }
					: { run: false, reason: "no changed path selects it" },
			]),
		),
	);
	assert.deepEqual(
		s.tests,
		Object.fromEntries(
			TESTS.map((f) => [
				f,
				f in want.tests ? { run: true, reason: want.tests[f] } : { run: false, reason: "no changed file reached it" },
			]),
		),
	);
	assert.deepEqual(s.packageFilters, want.filters ?? []);
}

/** Everything runs, for exactly `reasons`. */
function assertFull(s: Selection, reasons: string[]) {
	const why = `full run: ${reasons.join("; ")}`;
	assert.deepEqual(s, {
		mode: "full",
		fullReasons: reasons,
		checks: Object.fromEntries(Object.keys(CHECKS).map((id) => [id, { run: true, reason: why }])),
		tests: Object.fromEntries(TESTS.map((f) => [f, { run: true, reason: why }])),
		packageFilters: [],
	});
}

test("T-41 selection table: docs, one package, tools, lockfile, workflow file, unknown path, empty diff", async (t) => {
	await t.test("a docs-only change runs only the documentation check", () =>
		assertSelected(selectChecks(["docs/plan/context.md"], map, context), {
			checks: { docs: "documentation: docs/plan/context.md" },
			tests: {},
		}),
	);
	await t.test("a change in one package runs the package checks for it and its dependents", () =>
		assertSelected(selectChecks(["packages/ui/src/controls/Button.tsx"], map, context), {
			checks: {
				lint: "package source: packages/ui/src/controls/Button.tsx",
				typecheck: "package source: packages/ui/src/controls/Button.tsx",
				"test:unit": "package source: packages/ui/src/controls/Button.tsx",
			},
			tests: {},
			filters: ["...@everyfield/ui"],
		}),
	);
	await t.test("a tools/qa source change runs only the tests that reached it", () =>
		assertSelected(selectChecks(["tools/qa/store.ts"], map, context), {
			checks: { "tools-qa": "runs tools/qa/tests/qa.test.ts" },
			tests: { "tools/qa/tests/qa.test.ts": "reached tools/qa/store.ts" },
		}),
	);
	await t.test("a tools/ci support file runs its suite", () =>
		assertSelected(selectChecks(["tools/ci/tests/fixture.json"], map, context), {
			checks: { "tools-ci": "runs tools/ci/tests/select.test.ts" },
			tests: { "tools/ci/tests/select.test.ts": "CI tool test support: tools/ci/tests/fixture.json" },
		}),
	);
	await t.test("an actionable watcher source change runs the whole ops-watch suite and nothing else", () =>
		assertSelected(selectChecks(["ops/actionable-watch/io.mts"], map, context), {
			checks: {
				"ops-watch": "runs ops/actionable-watch/test/io.test.mts; runs ops/actionable-watch/test/observe.test.mts",
			},
			tests: {
				"ops/actionable-watch/test/io.test.mts":
					"reached ops/actionable-watch/io.mts; actionable watcher: ops/actionable-watch/io.mts",
				"ops/actionable-watch/test/observe.test.mts": "actionable watcher: ops/actionable-watch/io.mts",
			},
		}),
	);
	await t.test("the lockfile runs everything", () =>
		assertFull(selectChecks(["pnpm-lock.yaml"], map, context), ["pnpm-lock.yaml is a shared input"]),
	);
	await t.test("a workflow file runs everything", () =>
		assertFull(selectChecks([".github/workflows/ci.yml"], map, context), [
			".github/workflows/ci.yml is a shared input",
		]),
	);
	await t.test("a path no rule covers runs everything", () =>
		assertFull(selectChecks(["ops/maintenance/cli.mts"], map, context), ["no rule covers ops/maintenance/cli.mts"]),
	);
	await t.test("an empty diff runs everything", () =>
		assertFull(selectChecks([], map, context), ["the diff is empty, so nothing narrows the run"]),
	);
});

test("T-41 the map selects through child-process coverage and package tests reach their owners", async (t) => {
	await t.test("a changed source file selects every test file that reached it", () =>
		assertSelected(selectChecks(["scripts/dev.ts", ".github/scripts/fail-forward.cjs"], map, context), {
			checks: {
				workflow: "runs tests/workflow/dev.test.mjs",
				"github-scripts": "runs .github/scripts/fail-forward.test.cjs",
			},
			tests: {
				"tests/workflow/dev.test.mjs": "reached scripts/dev.ts",
				".github/scripts/fail-forward.test.cjs": "reached .github/scripts/fail-forward.cjs",
			},
		}),
	);
	await t.test("a test file the map has never seen always runs", () => {
		const { "tests/workflow/dev.test.mjs": _, ...older } = map.tests;
		assertSelected(selectChecks(["docs/a.md"], { ...map, tests: older }, context), {
			checks: { docs: "documentation: docs/a.md", workflow: "runs tests/workflow/dev.test.mjs" },
			tests: { "tests/workflow/dev.test.mjs": "not in the coverage map from 0123456789ab" },
		});
	});
	await t.test("a package test outside its package runs the owning package's checks", () =>
		assertSelected(selectChecks(["tests/integration/db/unit.test.mts"], map, context), {
			checks: {
				lint: "package test outside its package: tests/integration/db/unit.test.mts",
				typecheck: "package test outside its package: tests/integration/db/unit.test.mts",
				"test:unit": "package test outside its package: tests/integration/db/unit.test.mts",
				"ci-coverage": "package test outside its package: tests/integration/db/unit.test.mts",
			},
			tests: {},
			filters: ["...@everyfield/db"],
		}),
	);
});

test("T-41 tests that read files as text are selected when those files change", async (t) => {
	await t.test("an adapter operation runs the eval coverage guard as well as its package checks", () =>
		assertSelected(selectChecks(["packages/evry/src/adapters/people/reads/list.ts"], map, context), {
			checks: {
				lint: "package source: packages/evry/src/adapters/people/reads/list.ts",
				typecheck: "package source: packages/evry/src/adapters/people/reads/list.ts",
				"test:unit": "package source: packages/evry/src/adapters/people/reads/list.ts",
				workflow: "runs tests/workflow/evry-evals-coverage.test.mjs",
			},
			tests: {
				"tests/workflow/evry-evals-coverage.test.mjs":
					"adapter operations and their eval cases: packages/evry/src/adapters/people/reads/list.ts",
			},
			filters: ["...@everyfield/evry"],
		}),
	);
	await t.test("an eval case file no package script names runs everything, the guard included", () =>
		assertFull(selectChecks(["tests/evry/evals/classify.cases.json"], map, context), [
			"no package owns tests/evry/evals/classify.cases.json",
		]),
	);
	await t.test("the preview config runs both tests that read it", () =>
		assertSelected(selectChecks(["scripts/preview.json"], map, context), {
			checks: { workflow: "runs tests/workflow/setup-step.test.mjs; runs tests/workflow/stack.test.mjs" },
			tests: {
				"tests/workflow/stack.test.mjs": "preview config: scripts/preview.json",
				"tests/workflow/setup-step.test.mjs": "preview config: scripts/preview.json",
			},
		}),
	);
	await t.test("a web app change runs the dev-server log test", () =>
		assertSelected(selectChecks(["apps/web/src/features/settings/actions.ts"], map, context), {
			checks: {
				lint: "package source: apps/web/src/features/settings/actions.ts",
				typecheck: "package source: apps/web/src/features/settings/actions.ts",
				"test:unit": "package source: apps/web/src/features/settings/actions.ts",
				workflow: "runs tests/workflow/server-logs.test.mjs",
			},
			tests: {
				"tests/workflow/server-logs.test.mjs": "web app under a dev server: apps/web/src/features/settings/actions.ts",
			},
			filters: ["...@everyfield/web"],
		}),
	);
	await t.test("a file read as text, or under a listed directory, reaches the test through the map", () =>
		assertSelected(
			selectChecks(
				["tools/qa/qa-preview.md", "tools/qa/fixtures/new.json"],
				{
					...map,
					tests: { ...map.tests, "tools/qa/tests/qa.test.ts": ["tools/qa/fixtures/", "tools/qa/qa-preview.md"] },
				},
				context,
			),
			{
				checks: { "tools-qa": "runs tools/qa/tests/qa.test.ts" },
				tests: {
					"tools/qa/tests/qa.test.ts": "reached tools/qa/qa-preview.md; reached tools/qa/fixtures/new.json",
				},
			},
		),
	);
});

test("T-41 fail safe: each doubt runs every check, with the reason", async (t) => {
	const cases: [string, string[] | null, Parameters<typeof selectChecks>[1], string][] = [
		["an unreadable diff", null, map, "the diff could not be read"],
		["a path with no rule", [".claude/settings.json"], map, "no rule covers .claude/settings.json"],
		["a new test file", ["tools/ci/tests/new.test.ts"], map, "test file tools/ci/tests/new.test.ts is new or changed"],
		[
			"a changed test file",
			["tests/workflow/dev.test.mjs"],
			map,
			"test file tests/workflow/dev.test.mjs is new or changed",
		],
		["a missing map", ["scripts/dev.ts"], parseCoverageMap(null), "the coverage map is missing"],
		["an unreadable map", ["scripts/dev.ts"], parseCoverageMap("{not json"), "the coverage map is not JSON"],
		[
			"a map with no tests",
			["scripts/dev.ts"],
			parseCoverageMap('{"head":"a","createdAt":"2026-11-08T00:00:00Z"}'),
			"the coverage map has no tests",
		],
		[
			"a map over 7 days old",
			["scripts/dev.ts"],
			{ ...map, createdAt: "2026-11-02T11:59:59Z" },
			"the coverage map from 2026-11-02T11:59:59Z is over 7 days old",
		],
		["pnpm-lock.yaml", ["pnpm-lock.yaml"], map, "pnpm-lock.yaml is a shared input"],
		["the root package.json", ["package.json"], map, "package.json is a shared input"],
		["pnpm-workspace.yaml", ["pnpm-workspace.yaml"], map, "pnpm-workspace.yaml is a shared input"],
		["tsconfig.base.json", ["tsconfig.base.json"], map, "tsconfig.base.json is a shared input"],
		["a root config file", [".prettierrc"], map, ".prettierrc is a shared input"],
		[
			"a workflow file",
			[".github/workflows/fail-forward.yml"],
			map,
			".github/workflows/fail-forward.yml is a shared input",
		],
		["the selector and its rules", ["tools/ci/select.ts"], map, "tools/ci/select.ts is a shared input"],
		[
			"a package test no package script names",
			["tests/integration/helpers/x.ts"],
			map,
			"no package owns tests/integration/helpers/x.ts",
		],
	];
	for (const [name, changed, m, reason] of cases)
		await t.test(name, () => assertFull(selectChecks(changed, m, context), [reason]));
	await t.test("a map exactly 7 days old still selects", () =>
		assert.equal(selectChecks(["docs/a.md"], { ...map, createdAt: "2026-11-02T12:00:00Z" }, context).mode, "selected"),
	);
	await t.test("one doubtful path among narrow ones still runs everything", () =>
		assertFull(selectChecks(["docs/a.md", "ops/x.mts", "scripts/dev.ts"], map, context), ["no rule covers ops/x.mts"]),
	);
});

test("T-41 reachability lint: every selectable test file and configured check can be reached", () => {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const listed = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		encoding: "utf8",
	});
	assert.equal(listed.status, 0);
	assert.deepEqual(unreachable(listed.stdout.split("\0").filter(Boolean)), []);
	// The lint can see each kind of gap.
	assert.deepEqual(
		unreachable([
			"tools/ci/tests/new.test.mjs",
			"tests/workflow/sub/deep.test.mjs",
			"tests/workflow/dev.test.mjs",
			"tests/workflow/evry-evals-coverage.test.mjs",
			"tests/workflow/lint-rule-coverage.test.mjs",
			"tests/workflow/nightly.test.ts",
			"tests/workflow/role-prompts.test.mjs",
			"tests/workflow/server-logs.test.mjs",
			"tests/workflow/setup-step.test.mjs",
			"tests/workflow/stack.test.mjs",
		]),
		[
			"tools/ci/tests/new.test.mjs is a test file no suite runs; widen a suite's files in tools/ci/select.ts",
			"tests/workflow/sub/deep.test.mjs is a test file no suite runs; widen a suite's files in tools/ci/select.ts",
		],
	);
	assert.deepEqual(
		unreachable(
			[...TESTS, "tests/workflow/lint-rule-coverage.test.mjs"],
			RULES.filter((rule) => !rule.checks?.includes("docs")),
		),
		["check docs is selected by no rule"],
	);
	assert.deepEqual(unreachable([]), [
		'rule "role prompts and evf roles" names tests/workflow/role-prompts.test.mjs, which no suite runs',
		'rule "dev command" names tests/workflow/dev.test.mjs, which no suite runs',
		'rule "preview config" names tests/workflow/stack.test.mjs, which no suite runs',
		'rule "preview config" names tests/workflow/setup-step.test.mjs, which no suite runs',
		'rule "adapter operations and their eval cases" names tests/workflow/evry-evals-coverage.test.mjs, which no suite runs',
		'rule "web app under a dev server" names tests/workflow/server-logs.test.mjs, which no suite runs',
		'rule "lint rule coverage" names tests/workflow/lint-rule-coverage.test.mjs, which no suite runs',
		'rule "coverage read tracer" names tests/workflow/nightly.test.ts, which no suite runs',
	]);
});
