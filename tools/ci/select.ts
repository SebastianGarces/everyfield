// Which local checks a change needs (T-41). `selectChecks` is the one place that decides: the changed paths and the
// coverage map go in, every check and selectable test file comes out with whether it runs and why. It fails safe: any
// doubt runs everything. `bin/dev check` (scripts/check.ts) gathers the inputs and runs the result; `bin/dev nightly`
// (scripts/nightly.ts) writes the coverage map. A change to this file or its rules runs everything.
import { matchesGlob, posix } from "node:path";

/** Every check `bin/dev check` knows. Package checks run through pnpm; suites run their selected test files. */
export const CHECKS = {
	lint: { kind: "package", script: "lint" },
	typecheck: { kind: "package", script: "typecheck" },
	"test:unit": { kind: "package", script: "test:unit" },
	docs: { kind: "command", command: ["python3", "docs/check-all.py"] },
	"ci-coverage": { kind: "command", command: ["node", "tools/ci/ci-tests.ts"] },
	workflow: { kind: "suite", root: "tests/workflow", files: "tests/workflow/*.test.{mjs,ts}" },
	"tools-ci": { kind: "suite", root: "tools/ci/tests", files: "tools/ci/tests/*.test.ts" },
	"tools-qa": { kind: "suite", root: "tools/qa/tests", files: "tools/qa/tests/*.test.ts" },
	"github-scripts": { kind: "suite", root: ".github/scripts", files: ".github/scripts/*.test.cjs" },
	"ops-watch": { kind: "suite", root: "ops/actionable-watch/test", files: "ops/actionable-watch/test/*.test.mts" },
} as const satisfies Record<string, Check>;

export type CheckId = keyof typeof CHECKS;
type Check =
	| { kind: "package"; script: string }
	| { kind: "command"; command: readonly string[] }
	| { kind: "suite"; root: string; files: string };
export type SuiteId = { [K in CheckId]: (typeof CHECKS)[K] extends { kind: "suite" } ? K : never }[CheckId];

/** The roots whose test files selection may skip. Any test-like file in them must belong to a suite. */
export const SELECTABLE_ROOTS = (Object.keys(CHECKS) as CheckId[]).flatMap((id) => {
	const check: Check = CHECKS[id];
	return check.kind === "suite" ? [check.root] : [];
});

/** A rule names the paths it covers and what they select. `packages` adds the owning packages' checks. */
export type Rule = {
	name: string;
	paths: readonly string[];
	checks?: readonly CheckId[];
	suites?: readonly SuiteId[];
	tests?: readonly string[];
	/** Adds the package checks, filtered to the packages that own the path (and their dependents). */
	packages?: true;
	/** The package a path no package script names falls back to; without one such a path runs everything. */
	fallbackPackage?: string;
	/** Paths whose effect no narrower rule can bound: they run everything. */
	full?: true;
};

const PACKAGE_CHECKS = ["lint", "typecheck", "test:unit"] as const;

export const RULES: readonly Rule[] = [
	{
		name: "shared input",
		full: true,
		paths: [
			"pnpm-lock.yaml",
			"package.json",
			"pnpm-workspace.yaml",
			"tsconfig*.json",
			".prettierrc",
			".prettierignore",
			".gitignore",
			".npmrc",
			".nvmrc",
			".node-version",
			"eslint.config.*",
			".oxlintrc.json",
			".github/workflows/**",
			"tools/ci/select.ts",
			"scripts/check.ts",
			"scripts/test-workflow.mjs",
		],
	},
	{ name: "package source", paths: ["apps/*/**", "packages/*/**"], packages: true },
	{ name: "package manifest", paths: ["apps/*/package.json", "packages/*/package.json"], checks: ["ci-coverage"] },
	{
		name: "package test outside its package",
		paths: ["tests/integration/**", "tests/contracts/**", "tests/evry/**", "tests/reference/**", "tests/unit/**"],
		packages: true,
		checks: ["ci-coverage"],
	},
	// tests/ui holds only the browser suites, which import tests/ui/setup.mjs, and their seeds. They run nightly and in
	// the verifier's preview; the node tests that used to sit here live in tests/unit (T-281).
	{ name: "browser suite", paths: ["tests/ui/**"], packages: true, fallbackPackage: "@everyfield/web" },
	{
		name: "documentation",
		paths: [
			"docs/**",
			"design/**",
			"*.md",
			".agents/**/*.md",
			".agents/licenses/**",
			"skills-lock.json",
			"everyfield-feature-review.html",
		],
		checks: ["docs"],
	},
	// The docs check runs the wiki seed check. The wiki tool's own tests run in GitHub CI's tooling job only.
	{ name: "wiki tool", paths: ["tools/wiki/**"], checks: ["docs"] },
	{
		name: "role prompts and evf roles",
		paths: [".agents/role-prompts/**", ".agents/roles/**", "evf.toml"],
		tests: ["tests/workflow/role-prompts.test.mjs"],
	},
	{ name: "dev command", paths: ["bin/dev"], tests: ["tests/workflow/dev.test.mjs"] },
	{ name: "QA command", paths: ["bin/qa"], suites: ["tools-qa"] },
	{
		name: "preview config",
		paths: ["scripts/preview.json"],
		tests: ["tests/workflow/stack.test.mjs", "tests/workflow/setup-step.test.mjs"],
	},
	// Tests that read files as text or drive a process coverage cannot follow. The nightly map records node:fs reads
	// too; these rules hold until a map has seen them, and cover reads made outside node:fs (Next's bundler).
	{
		name: "adapter operations and their eval cases",
		paths: ["packages/evry/src/adapters/**", "tests/evry/evals/**"],
		tests: ["tests/workflow/evry-evals-coverage.test.mjs"],
	},
	{ name: "web app under a dev server", paths: ["apps/web/**"], tests: ["tests/workflow/server-logs.test.mjs"] },
	{
		name: "lint rule coverage",
		paths: ["scripts/lint-rule-coverage.mjs"],
		tests: ["tests/workflow/lint-rule-coverage.test.mjs"],
	},
	// The guard reads every file under tests/integration as text (T-261). A change to the guard itself is a changed test
	// file under tests/workflow, which runs everything.
	{
		name: "integration timing guard",
		paths: ["tests/integration/**"],
		tests: ["tests/workflow/integration-timing.test.mjs"],
	},
	{ name: "coverage read tracer", paths: ["scripts/trace-reads.mjs"], tests: ["tests/workflow/nightly.test.ts"] },
	// Fixtures and helpers next to the tests: the tests read them, so coverage cannot see every use.
	{ name: "workflow test support", paths: ["tests/workflow/**"], suites: ["workflow"] },
	{ name: "CI tool test support", paths: ["tools/ci/tests/**"], suites: ["tools-ci"] },
	{ name: "QA tool test support", paths: ["tools/qa/tests/**"], suites: ["tools-qa"] },
	// The watcher's tests read its README and plist as text, so every file under it runs the whole suite.
	{ name: "actionable watcher", paths: ["ops/actionable-watch/**"], suites: ["ops-watch"] },
	{
		name: "failure reporting and feedback queue input",
		paths: [".github/internal-feedback.json", ".github/ISSUE_TEMPLATE/**", ".github/scripts/*.sh"],
		suites: ["github-scripts"],
	},
	{
		name: "CI test exceptions",
		paths: ["tools/ci/ci-test-exceptions.json"],
		checks: ["ci-coverage"],
		suites: ["tools-ci"],
	},
];

/** The coverage map `bin/dev nightly` writes: which source files each selectable test file reached. */
export type CoverageMap = { head: string; createdAt: string; tests: Readonly<Record<string, readonly string[]>> };
/** Why no map can be used. */
export type MapProblem = { problem: string };

/** The longest a map stays usable. An older one runs everything. */
export const MAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Parses map JSON at the boundary. Anything off-shape is a problem, never a partial map. */
export function parseCoverageMap(text: string | null): CoverageMap | MapProblem {
	if (text === null) return { problem: "the coverage map is missing" };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { problem: "the coverage map is not JSON" };
	}
	if (!value || typeof value !== "object") return { problem: "the coverage map is not an object" };
	const { head, createdAt, tests } = value as Record<string, unknown>;
	if (typeof head !== "string" || typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)))
		return { problem: "the coverage map has no head or creation time" };
	if (!tests || typeof tests !== "object" || Array.isArray(tests)) return { problem: "the coverage map has no tests" };
	for (const reached of Object.values(tests))
		if (!Array.isArray(reached) || !reached.every((p) => typeof p === "string"))
			return { problem: "the coverage map lists a test with no file list" };
	return { head, createdAt, tests: tests as Record<string, string[]> };
}

/** A workspace package as its package.json declares it. */
export type Package = { dir: string; name: string; scripts: Readonly<Record<string, string>> };

export type Context = {
	/** Every selectable test file in the checkout now. */
	testFiles: readonly string[];
	packages: readonly Package[];
	now: Date;
};

export type Decision = { run: boolean; reason: string };
export type Selection = {
	mode: "selected" | "full";
	/** Why everything runs; empty in selected mode. */
	fullReasons: string[];
	checks: Record<CheckId, Decision>;
	tests: Record<string, Decision>;
	/** pnpm filters beyond `...[<merge-base>]`: `...<name>` for each package a changed path belongs to. */
	packageFilters: string[];
};

const TEST_FILE = /\.test\.[cm]?[jt]s$/;
const inRoots = (path: string) => SELECTABLE_ROOTS.some((root) => path.startsWith(root + "/"));
const matches = (rule: Rule, path: string) => rule.paths.some((glob) => matchesGlob(path, glob));

/** The suite a selectable test file belongs to. */
export function suiteOf(file: string): SuiteId | undefined {
	return (Object.keys(CHECKS) as CheckId[]).find((id) => {
		const check: Check = CHECKS[id];
		return check.kind === "suite" && matchesGlob(file, check.files);
	}) as SuiteId | undefined;
}

/** Packages whose scripts name `path` (directly or by glob), relative to the package directory. */
function owners(path: string, packages: readonly Package[]): Package[] {
	return packages.filter((pkg) =>
		Object.values(pkg.scripts).some((command) =>
			(command.match(/[^\s"']+/g) ?? []).some(
				(token) => token.includes("/") && matchesGlob(path, posix.normalize(posix.join(pkg.dir, token))),
			),
		),
	);
}

/** Everything runs, for `reasons`. A verifier run (`bin/dev check --full`) always takes this. */
export function everything(reasons: string[], context: Pick<Context, "testFiles">): Selection {
	const why = `full run: ${reasons.join("; ")}`;
	return {
		mode: "full",
		fullReasons: reasons,
		checks: Object.fromEntries(
			Object.keys(CHECKS).map((id) => [id, { run: true, reason: why }]),
		) as Selection["checks"],
		tests: Object.fromEntries(context.testFiles.map((file) => [file, { run: true, reason: why }])),
		packageFilters: [],
	};
}

/**
 * The checks and test files a change needs. `changedPaths` is null when the diff could not be read. Any path no rule
 * covers, a changed test file, a shared input, an empty diff or an unusable map runs everything.
 */
export function selectChecks(
	changedPaths: readonly string[] | null,
	map: CoverageMap | MapProblem,
	context: Context,
): Selection {
	if (changedPaths === null) return everything(["the diff could not be read"], context);
	if (changedPaths.length === 0) return everything(["the diff is empty, so nothing narrows the run"], context);
	if ("problem" in map) return everything([map.problem], context);
	const age = context.now.getTime() - Date.parse(map.createdAt);
	if (age > MAP_MAX_AGE_MS) return everything([`the coverage map from ${map.createdAt} is over 7 days old`], context);

	const full: string[] = [];
	const checkWhy = new Map<CheckId, string[]>();
	const testWhy = new Map<string, string[]>();
	const filters = new Set<string>();
	const add = <K>(into: Map<K, string[]>, key: K, why: string) => into.set(key, [...(into.get(key) ?? []), why]);
	// Which tests reached each source file: the map inverted. A source ending in "/" is a directory the test listed, so
	// every path under it reaches the test.
	const reachedBy = new Map<string, string[]>();
	const listedBy = new Map<string, string[]>();
	for (const [test, sources] of Object.entries(map.tests))
		for (const source of sources) add(source.endsWith("/") ? listedBy : reachedBy, source, test);
	const reachers = (path: string) => [
		...(reachedBy.get(path) ?? []),
		...[...listedBy].flatMap(([dir, tests]) => (path.startsWith(dir) ? tests : [])),
	];

	for (const path of changedPaths) {
		if (inRoots(path) && (TEST_FILE.test(path) || suiteOf(path))) {
			full.push(`test file ${path} is new or changed`);
			continue;
		}
		const rules = RULES.filter((rule) => matches(rule, path));
		const shared = rules.find((rule) => rule.full);
		if (shared) {
			full.push(`${path} is a ${shared.name}`);
			continue;
		}
		const reached = [...new Set(reachers(path))];
		if (!rules.length && !reached.length) {
			full.push(`no rule covers ${path}`);
			continue;
		}
		for (const test of reached) add(testWhy, test, `reached ${path}`);
		for (const rule of rules) {
			const why = `${rule.name}: ${path}`;
			for (const id of rule.checks ?? []) add(checkWhy, id, why);
			for (const test of rule.tests ?? []) add(testWhy, test, why);
			for (const suite of rule.suites ?? [])
				for (const test of context.testFiles) if (suiteOf(test) === suite) add(testWhy, test, why);
			if (rule.packages) {
				for (const id of PACKAGE_CHECKS) add(checkWhy, id, why);
				// pnpm's `...[<merge-base>]` filter finds the repository from the first `.git` folder above the workspace,
				// so in a nested worktree (.worktrees/<task>) it reads the main checkout and selects nothing. Each owning
				// package is named as well, which selects the same packages and their dependents in any checkout.
				const inside = context.packages.filter((pkg) => path.startsWith(pkg.dir + "/"));
				const found = (inside.length ? inside : owners(path, context.packages)).map((pkg) => pkg.name);
				if (!found.length && rule.fallbackPackage) found.push(rule.fallbackPackage);
				if (!found.length) full.push(`no package owns ${path}`);
				for (const name of found) filters.add(`...${name}`);
			}
		}
	}
	if (full.length) return everything(full, context);

	// A test the map has never seen may reach anything, so it always runs.
	for (const test of context.testFiles)
		if (!(test in map.tests)) add(testWhy, test, `not in the coverage map from ${map.head.slice(0, 12)}`);
	const tests = Object.fromEntries(
		context.testFiles.map((file): [string, Decision] => {
			const why = testWhy.get(file);
			return [file, why ? { run: true, reason: why.join("; ") } : { run: false, reason: "no changed file reached it" }];
		}),
	);
	for (const [file, decision] of Object.entries(tests)) if (decision.run) add(checkWhy, suiteOf(file)!, `runs ${file}`);
	const checks = Object.fromEntries(
		(Object.keys(CHECKS) as CheckId[]).map((id): [CheckId, Decision] => {
			const why = checkWhy.get(id);
			return [
				id,
				why
					? { run: true, reason: [...new Set(why)].join("; ") }
					: { run: false, reason: "no changed path selects it" },
			];
		}),
	) as Selection["checks"];
	return { mode: "selected", fullReasons: [], checks, tests, packageFilters: [...filters].sort() };
}

/**
 * The reachability lint: what selection could never run. A test-like file under a selectable root that no suite runs, a
 * check that no rule names, and a rule that names a test file that does not exist.
 */
export function unreachable(files: readonly string[], rules: readonly Rule[] = RULES): string[] {
	const problems: string[] = [];
	for (const file of files)
		if (inRoots(file) && TEST_FILE.test(file) && !suiteOf(file))
			problems.push(`${file} is a test file no suite runs; widen a suite's files in tools/ci/select.ts`);
	for (const id of Object.keys(CHECKS) as CheckId[]) {
		const named = rules.some(
			(rule) => !rule.full && (rule.checks?.includes(id) || rule.suites?.includes(id as SuiteId)),
		);
		const isPackage = CHECKS[id].kind === "package" && rules.some((rule) => rule.packages);
		if (!named && !isPackage) problems.push(`check ${id} is selected by no rule`);
	}
	for (const rule of rules)
		for (const test of rule.tests ?? [])
			if (!files.includes(test) || !suiteOf(test))
				problems.push(`rule "${rule.name}" names ${test}, which no suite runs`);
	return problems;
}
