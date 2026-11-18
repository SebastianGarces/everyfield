import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	check as runCheck,
	type CheckOptions,
	type CheckRecord,
	type Gh,
	MAP_ARTIFACT,
	NIGHTLY_WORKFLOW,
	REPO,
	type Runner,
	spawnRunner,
} from "../../scripts/check.ts";
import { IMAGE, LABEL } from "../../scripts/throwaway-postgres.ts";

const noNightly: Gh = () => ({ status: 0, stdout: "[]" });
const check = (options: CheckOptions) => runCheck({ gh: noNightly, ...options });

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd, encoding: "utf8" }).trim();

function repo(t: { after(fn: () => void): void }, change: Record<string, string>, extra: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), "evf-check-repo-"));
	const home = mkdtempSync(join(tmpdir(), "evf-check-home-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});
	const write = (files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	};
	sh(root, "init", "-q", "-b", "main");
	write({
		"docs/a.md": "a\n",
		"packages/ui/package.json": JSON.stringify({
			name: "@everyfield/ui",
			scripts: { lint: "eslint .", "test:unit": "node --test" },
		}),
		"packages/ui/src/button.ts": "export {};\n",
		"scripts/dev.ts": "export {};\n",
		"tests/workflow/dev.test.mjs": "\n",
		"tools/ci/tests/a.test.ts": "\n",
		".github/scripts/a.test.cjs": "\n",
		...extra,
	});
	sh(root, "add", ".");
	sh(root, "commit", "-qm", "main");
	sh(root, "update-ref", "refs/remotes/origin/main", "HEAD");
	const base = sh(root, "rev-parse", "HEAD");
	sh(root, "switch", "-qc", "task");
	write(change);
	sh(root, "add", ".");
	sh(root, "commit", "-qm", "change");
	const map = {
		head: base,
		createdAt: new Date().toISOString(),
		tests: {
			"tests/workflow/dev.test.mjs": ["scripts/dev.ts"],
			"tools/ci/tests/a.test.ts": [],
			".github/scripts/a.test.cjs": [],
			"tools/qa/tests/a.test.ts": [],
			"tools/app/tests/a.test.ts": [],
			"ops/actionable-watch/test/a.test.mts": [],
		},
	};
	writeFileSync(join(home, "coverage-map.json"), JSON.stringify(map));
	return { root, home, base, head: sh(root, "rev-parse", "HEAD") };
}

function fake({ tests = 3, unitOutput = "ℹ tests 5\nℹ pass 5" } = {}) {
	const commands: string[] = [];
	const run: Runner = (command, args, { cwd, env }) => {
		commands.push([command, ...args].join(" "));
		if (args.includes("ls")) return { status: 0, stdout: JSON.stringify([{ name: "@everyfield/ui" }]), output: "" };
		if (args[0] === "scripts/test-workflow.mjs") {
			const files = args.slice(1);
			const report = files.flatMap((f) =>
				Array.from({ length: tests }, (_, i) => ({ name: `t${i}`, file: join(cwd, f), status: "passed" })),
			);
			writeFileSync(env.EVF_TEST_REPORT!, JSON.stringify({ tests: report }));
			return { status: report.length ? 0 : 1, stdout: "", output: "" };
		}
		if (args.includes("test:unit")) return { status: 0, stdout: unitOutput, output: unitOutput };
		return { status: 0, stdout: "", output: "" };
	};
	return { run, commands };
}

const ran = (record: CheckRecord) => record.checks.filter((c) => c.run).map((c) => c.id);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as CheckRecord;

test("T-41 a one-package change runs its package checks through the merge-base and dependents filter", (t) => {
	const { root, home, base, head } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
	const { run, commands } = fake();
	const { record, recordPath } = check({ root, full: false, home, run });
	assert.ok(recordPath.startsWith(home) && !recordPath.startsWith(root), recordPath);
	assert.deepEqual(read(recordPath), record);
	assert.equal(record.head, head);
	assert.equal(record.mergeBase, base);
	assert.equal(record.mode, "selected");
	assert.equal(record.result, "passed");
	assert.deepEqual(ran(record), ["lint", "typecheck", "test:unit", "test:db"]);
	const filter = `--filter ...[${base}] --filter ...@everyfield/ui`;
	assert.deepEqual(
		record.checks.filter((c) => c.run).map(({ id, command, result, tests }) => ({ id, command, result, tests })),
		[
			{ id: "lint", command: `corepack pnpm ${filter} --if-present run lint`, result: "passed", tests: null },
			{ id: "typecheck", command: null, result: "skipped", tests: null },
			{ id: "test:unit", command: `corepack pnpm ${filter} --if-present run test:unit`, result: "passed", tests: 5 },
			{ id: "test:db", command: null, result: "skipped", tests: null },
		],
	);
	assert.equal(
		record.checks.find((c) => c.id === "typecheck")!.reason,
		"package source: packages/ui/src/button.ts; no selected package defines typecheck",
	);
	assert.deepEqual(
		record.tests.find((x) => x.file === "tests/workflow/dev.test.mjs"),
		{
			file: "tests/workflow/dev.test.mjs",
			check: "workflow",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
	);
	assert.ok(!commands.some((c) => c.includes("test-workflow") || c.includes("check-all")), commands.join("\n"));
});

test("T-41 a changed source file runs the test files that reached it, with their counts", (t) => {
	const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
	const { record } = check({ root, full: false, home, run: fake().run });
	assert.equal(record.result, "passed");
	assert.deepEqual(ran(record), ["workflow"]);
	assert.deepEqual(record.tests, [
		{
			file: ".github/scripts/a.test.cjs",
			check: "github-scripts",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
		{
			file: "tests/workflow/dev.test.mjs",
			check: "workflow",
			run: true,
			reason: "reached scripts/dev.ts",
			result: "passed",
			tests: 3,
		},
		{
			file: "tools/ci/tests/a.test.ts",
			check: "tools-ci",
			run: false,
			reason: "no changed file reached it",
			result: "skipped",
			tests: null,
		},
	]);
	assert.equal(record.checks.find((c) => c.id === "workflow")!.tests, 3);
});

test("T-41 a non-empty diff that selects no checks fails, and so does a check that reports 0 tests", async (t) => {
	await t.test("no check selected", (t) => {
		const { root, home } = repo(t, { "bin/qa": "#!/bin/sh\n" });
		const { run, commands } = fake();
		const { record } = check({ root, full: false, home, run });
		assert.equal(record.mode, "selected");
		assert.deepEqual(ran(record), []);
		assert.deepEqual(commands, []);
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["the diff selected no checks, so nothing proves it; run bin/dev check --full"]);
	});
	await t.test("a test file that reports 0 tests", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		const { record } = check({ root, full: false, home, run: fake({ tests: 0 }).run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["workflow reported 0 tests", "tests/workflow/dev.test.mjs reported 0 tests"]);
	});
	await t.test("test:unit that reports 0 tests", (t) => {
		const { root, home } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
		const { record } = check({ root, full: false, home, run: fake({ unitOutput: "nothing ran" }).run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["test:unit reported 0 tests"]);
	});
	await t.test("a pnpm filter that selects no package", (t) => {
		const { root, home } = repo(t, { "packages/ui/src/button.ts": "export const x = 1;\n" });
		const run: Runner = (command, args, options) =>
			args.includes("ls") ? { status: 0, stdout: "[]", output: "" } : fake().run(command, args, options);
		const { record } = check({ root, full: false, home, run });
		assert.equal(record.result, "failed");
		assert.deepEqual(record.failures, ["lint failed", "typecheck failed", "test:unit failed", "test:db failed"]);
	});
});

test("T-41 --full, the verifier mode, ignores selection: a docs-only diff runs every check", (t) => {
	const { root, home } = repo(
		t,
		{ "docs/a.md": "b\n" },
		{
			"tools/qa/tests/a.test.ts": "\n",
			"tools/app/tests/a.test.ts": "\n",
			"ops/actionable-watch/test/a.test.mts": "\n",
		},
	);
	const selected = check({ root, full: false, home, run: fake().run }).record;
	assert.deepEqual(ran(selected), ["docs"]);
	const { run, commands } = fake();
	const { record } = check({ root, full: true, home, run });
	assert.equal(record.mode, "full");
	assert.deepEqual(record.fullReasons, ["verifier run (--full) ignores selection"]);
	assert.deepEqual(ran(record), [
		"lint",
		"typecheck",
		"test:unit",
		"test:db",
		"census",
		"docs",
		"ci-coverage",
		"workflow",
		"tools-ci",
		"tools-qa",
		"tools-app",
		"github-scripts",
		"ops-watch",
	]);
	assert.ok(commands.includes("corepack pnpm -r --if-present run lint"), commands.join("\n"));
	assert.ok(
		commands.some((c) => c.endsWith("scripts/test-workflow.mjs tests/workflow/dev.test.mjs")),
		commands.join("\n"),
	);
	assert.equal(record.result, "passed", record.failures.join("\n"));
	assert.deepEqual(
		record.tests.map((x) => [x.file, x.run, x.result]),
		[
			[".github/scripts/a.test.cjs", true, "passed"],
			["ops/actionable-watch/test/a.test.mts", true, "passed"],
			["tests/workflow/dev.test.mjs", true, "passed"],
			["tools/app/tests/a.test.ts", true, "passed"],
			["tools/ci/tests/a.test.ts", true, "passed"],
			["tools/qa/tests/a.test.ts", true, "passed"],
		],
	);
});

test("T-41 an unreadable diff runs everything", (t) => {
	const { root, home } = repo(t, { "docs/a.md": "b\n" });
	sh(root, "update-ref", "-d", "refs/remotes/origin/main");
	const { record } = check({ root, full: false, home, run: fake().run });
	assert.equal(record.mergeBase, null);
	assert.equal(record.mode, "full");
	assert.deepEqual(record.fullReasons, ["the diff could not be read"]);
});

function nightlyGh(createdAt: string, artifact: string | null, listed = { status: 0 }) {
	const calls: string[][] = [];
	const gh: Gh = (args) => {
		calls.push([...args]);
		if (args[0] === "run" && args[1] === "list")
			return { status: listed.status, stdout: JSON.stringify([{ databaseId: 7, createdAt }]) };
		if (args[0] === "run" && args[1] === "download") {
			if (artifact === null) return { status: 1, stdout: "" };
			writeFileSync(join(args[args.indexOf("--dir") + 1]!, "coverage-map.json"), artifact);
			return { status: 0, stdout: "" };
		}
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	return { gh, calls };
}

test("T-216 selection downloads the map of the latest green GitHub nightly when the home's map is missing or older", async (t) => {
	const map = (head: string, createdAt: string) =>
		JSON.stringify({
			head,
			createdAt,
			tests: {
				"tests/workflow/dev.test.mjs": ["scripts/dev.ts"],
				"tools/ci/tests/a.test.ts": [],
				".github/scripts/a.test.cjs": [],
			},
		});
	await t.test("missing: the download is saved and selects", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		rmSync(join(home, "coverage-map.json"));
		const now = new Date().toISOString();
		const { gh, calls } = nightlyGh(now, map("n".repeat(40), now));
		const { record } = runCheck({ root, full: false, home, run: fake().run, gh });
		assert.equal(record.mode, "selected", record.fullReasons.join("; "));
		assert.deepEqual(ran(record), ["workflow"]);
		assert.deepEqual(calls, [
			[
				"run",
				"list",
				"--repo",
				REPO,
				"--workflow",
				NIGHTLY_WORKFLOW,
				"--branch",
				"main",
				"--status",
				"success",
				"--limit",
				"1",
				"--json",
				"databaseId,createdAt",
			],
			["run", "download", "7", "--repo", REPO, "--name", MAP_ARTIFACT, "--dir", calls[1]![calls[1]!.length - 1]!],
		]);
		assert.equal(existsSync(calls[1]!.at(-1)!), false, "the download folder is removed");
		assert.equal(JSON.parse(readFileSync(join(home, "coverage-map.json"), "utf8")).head, "n".repeat(40));
	});
	await t.test("older: a newer nightly run replaces it", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		writeFileSync(join(home, "coverage-map.json"), map("o".repeat(40), "2026-11-01T07:40:00.000Z"));
		const now = new Date().toISOString();
		const { gh, calls } = nightlyGh(now, map("n".repeat(40), now));
		runCheck({ root, full: false, home, run: fake().run, gh });
		assert.equal(calls.length, 2);
		assert.equal(JSON.parse(readFileSync(join(home, "coverage-map.json"), "utf8")).head, "n".repeat(40));
	});
	await t.test("no newer run: the home's map is kept and nothing is downloaded", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		const before = readFileSync(join(home, "coverage-map.json"), "utf8");
		const { gh, calls } = nightlyGh("2026-11-01T07:17:00.000Z", map("n".repeat(40), "2026-11-01T07:40:00.000Z"));
		const { record } = runCheck({ root, full: false, home, run: fake().run, gh });
		assert.deepEqual(ran(record), ["workflow"]);
		assert.deepEqual(
			calls.map((c) => c.slice(0, 2).join(" ")),
			["run list"],
		);
		assert.equal(readFileSync(join(home, "coverage-map.json"), "utf8"), before);
	});
	await t.test("--full reads no map and asks gh nothing", (t) => {
		const { root, home } = repo(t, { "docs/a.md": "b\n" });
		const { gh, calls } = nightlyGh(new Date().toISOString(), null);
		runCheck({ root, full: true, home, run: fake().run, gh });
		assert.deepEqual(calls, []);
	});
});

test("T-216 a failed or unusable nightly download runs everything and says why", async (t) => {
	const cases: Array<[string, ReturnType<typeof nightlyGh>, string]> = [
		[
			"the download fails",
			nightlyGh(new Date().toISOString(), null),
			"the coverage map is missing and gh could not download the coverage map of GitHub nightly run 7",
		],
		[
			"the download is not a map",
			nightlyGh(new Date().toISOString(), "{not json"),
			"the coverage map is missing and the download of GitHub nightly run 7 is unusable: the coverage map is not JSON",
		],
		[
			"gh cannot list runs (offline, not signed in)",
			nightlyGh(new Date().toISOString(), null, { status: 4 }),
			"the coverage map is missing and gh could not list the GitHub nightly runs",
		],
		[
			"no nightly run has passed",
			{ gh: noNightly, calls: [] },
			"the coverage map is missing and no GitHub nightly run on main has passed yet",
		],
	];
	for (const [name, { gh }, reason] of cases)
		await t.test(name, (t) => {
			const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
			rmSync(join(home, "coverage-map.json"));
			const { record } = runCheck({ root, full: false, home, run: fake().run, gh });
			assert.equal(record.mode, "full");
			assert.deepEqual(record.fullReasons, [reason]);
			assert.equal(existsSync(join(home, "coverage-map.json")), false, "nothing unusable is saved");
		});
	await t.test("a usable older map in the home stays in use when the download fails", (t) => {
		const { root, home } = repo(t, { "scripts/dev.ts": "export const y = 2;\n" });
		const before = readFileSync(join(home, "coverage-map.json"), "utf8");
		const { gh } = nightlyGh(new Date(Date.now() + 60_000).toISOString(), null);
		const { record } = runCheck({ root, full: false, home, run: fake().run, gh });
		assert.equal(record.mode, "selected");
		assert.equal(readFileSync(join(home, "coverage-map.json"), "utf8"), before);
	});
});

const DB_PACKAGES = {
	"packages/db/package.json": JSON.stringify({ name: "@everyfield/db", scripts: { "test:db": "tsx --test x" } }),
	"packages/db/src/client.ts": "export {};\n",
	"packages/domain/package.json": JSON.stringify({
		name: "@everyfield/domain",
		scripts: { "test:db": "pnpm test:writes" },
	}),
	"packages/domain/src/a.ts": "export {};\n",
	"packages/evry/package.json": JSON.stringify({ name: "@everyfield/evry", scripts: { "test:db": "node --test x" } }),
};

type Call = { command: string; env: Record<string, string> };
function fakeDb({
	listed,
	fail,
	tests = 4,
	census = { status: 0, output: "" },
}: {
	listed: string[];
	fail?: "docker" | "ready" | "migrate" | "@everyfield/db" | "zero";
	tests?: number;
	census?: { status: number; output: string; changes?: string[] };
}) {
	const calls: Call[] = [];
	const run: Runner = (command, args, options) => {
		calls.push({ command: [command, ...args].join(" "), env: options.env });
		if (args.includes("ls")) return { status: 0, stdout: JSON.stringify(listed.map((name) => ({ name }))), output: "" };
		if (command === "docker") {
			if (fail === "docker") return { status: 1, stdout: "", output: "Cannot connect to the Docker daemon" };
			if (args[0] === "exec") return { status: fail === "ready" ? 1 : 0, stdout: "", output: "" };
			if (args[0] === "port") return { status: 0, stdout: "127.0.0.1:55432\n", output: "" };
			return { status: 0, stdout: "", output: "" };
		}
		if (args.includes("db:migrate")) return { status: fail === "migrate" ? 1 : 0, stdout: "", output: "migrate" };
		if (args.includes("test:db") && args.includes("@everyfield/domain")) {
			const out = `${census.output}\nℹ tests ${fail === "zero" ? 0 : 9}`;
			if (census.changes) {
				writeFileSync(join(options.env.EVF_CENSUS_TIGHTENED!, "limits.json"), '{\n\t"a": { "limit": 1 }\n}\n');
				writeFileSync(
					join(options.env.EVF_CENSUS_TIGHTENED!, "changes.md"),
					"### Statement budgets tightened\n\n" + census.changes.map((c) => `- ${c}\n`).join(""),
				);
			}
			return { status: census.status, stdout: out, output: out };
		}
		if (args.includes("test:db")) {
			const name = args[args.indexOf("--filter") + 1];
			const out = fail === "zero" ? "ℹ tests 0" : `ℹ tests ${tests}\nℹ pass ${tests}`;
			return { status: fail === name ? 1 : 0, stdout: out, output: out };
		}
		return fake().run(command, args, options);
	};
	return { run, calls, commands: () => calls.map((c) => c.command) };
}
const noWait = { readyTimeoutMs: 0, sleep: () => {}, watch: () => () => {} };
const dbEntry = (record: CheckRecord) => record.checks.find((c) => c.id === "test:db")!;

const censusEntry = (record: CheckRecord) => record.checks.find((c) => c.id === "census")!;

test("INV-check-census: a packages/domain change runs the whole census on a production build and a throwaway Postgres", (t) => {
	const { root, home } = repo(t, { "packages/domain/src/a.ts": "export const a = 1;\n" }, DB_PACKAGES);
	const { run, calls, commands } = fakeDb({ listed: ["@everyfield/domain"] });
	const { record } = check({ root, full: false, home, run, database: noWait });
	const db = dbEntry(record);
	assert.equal(db.result, "skipped");
	assert.equal(
		db.reason,
		"package source: packages/domain/src/a.ts; only @everyfield/domain defines test:db, the statement census, which runs as the census check",
	);
	const entry = censusEntry(record);
	assert.equal(entry.reason, "backend or database code: packages/domain/src/a.ts");
	assert.equal(entry.result, "passed", entry.detail);
	assert.equal(entry.tests, 9);
	assert.equal(
		entry.command,
		"corepack pnpm --filter @everyfield/web run build; corepack pnpm --filter @everyfield/domain run test:db",
	);
	assert.equal(entry.database?.throwaway, true);
	assert.equal(record.result, "passed");
	const order = commands().filter((c) => /^docker (run|rm)|db:migrate|run build|test:db/.test(c));
	assert.deepEqual(
		order.map((c) => c.split(" ").slice(0, 2).join(" ") + " " + c.split(" ").at(-1)),
		[
			`docker run ${IMAGE}`,
			"corepack pnpm db:migrate",
			"corepack pnpm build",
			"corepack pnpm test:db",
			`docker rm ${entry.database!.container}`,
		],
	);
	const censusRun = calls.find((c) => c.command.includes("@everyfield/domain run test:db"))!;
	assert.match(censusRun.env.DATABASE_URL!, /^postgres:\/\/ci:[0-9a-f]{36}@127\.0\.0\.1:55432\/everyfield_ci$/);
	assert.ok(censusRun.env.EVF_CENSUS_TIGHTENED, "the census gets a folder for the tightened limits.json");
});

test("INV-check-census: a build Next.js stops once with its retry notice runs once more; a real build failure fails", async (t) => {
	for (const [outputs, result, builds] of [
		[["Error [SecurityFatalError]: ...\nRetry the same command to continue the original task.", "ok"], "passed", 2],
		[["Type error: x", "ok"], "failed", 1],
	] as const)
		await t.test(String(result), (t) => {
			const { root, home } = repo(t, { "packages/domain/src/a.ts": "export const a = 1;\n" }, DB_PACKAGES);
			const { run: base, commands } = fakeDb({ listed: ["@everyfield/domain"] });
			let n = 0;
			const run: Runner = (command, args, options) => {
				if (!args.includes("build")) return base(command, args, options);
				const output = outputs[n++]!;
				return { status: output === "ok" ? 0 : 1, stdout: output, output };
			};
			const { record } = check({ root, full: false, home, run, database: noWait });
			assert.equal(censusEntry(record).result, result);
			assert.equal(n, builds);
			if (result === "failed")
				assert.equal(censusEntry(record).detail, "the production build for the request budgets failed");
		});
});

test("INV-check-census: a docs-only diff skips the census and says why", (t) => {
	const { root, home } = repo(t, { "docs/a.md": "b\n" }, DB_PACKAGES);
	const { run, commands } = fakeDb({ listed: [] });
	const { record } = check({ root, full: false, home, run, database: noWait });
	const entry = censusEntry(record);
	assert.deepEqual(
		{ run: entry.run, result: entry.result, reason: entry.reason },
		{ run: false, result: "skipped", reason: "the diff touches no backend or database code" },
	);
	assert.ok(!commands().some((c) => c.startsWith("docker") || c.includes("build")), commands().join("\n"));
});

test("INV-check-census: an over-budget write or an N+1 fails the census check and names the operation", (t) => {
	const { root, home } = repo(
		t,
		{ "apps/web/src/server/jobs/mail.ts": "export const m = 1;\n" },
		{ ...DB_PACKAGES, "apps/web/package.json": JSON.stringify({ name: "@everyfield/web", scripts: {} }) },
	);
	const problems = [
		"people.createPerson: 7 statements, limit 6 (2 read, 1 write, 2 transaction, 2 locked read)",
		"census.perRow: N+1, sends the same statement 3 times in one run: INSERT INTO note (id) VALUES (?); batch it into one set-based statement, or give limits.json a repeats reason",
	];
	const output = [
		"✖ INV-census: every request and write stays within its statement budget",
		"  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
		"  + actual - expected",
		"",
		"  + [",
		...problems.map((p, i) => `  +   '${p}'${i < problems.length - 1 ? "," : ""}`),
		"  + ]",
		"  - []",
	].join("\n");
	const { run } = fakeDb({ listed: ["@everyfield/web"], census: { status: 1, output } });
	const { record } = check({ root, full: false, home, run, database: noWait });
	assert.equal(censusEntry(record).result, "failed");
	assert.equal(record.result, "failed");
	assert.ok(
		record.failures.includes(`census failed: statement census: ${problems.join("; ")}`),
		record.failures.join("\n"),
	);
});

test("INV-check-census: slack is no failure; the tightened limits.json lands in the worktree and the record", (t) => {
	const { root, home } = repo(
		t,
		{ "packages/domain/src/a.ts": "export const a = 1;\n" },
		{ ...DB_PACKAGES, "tests/integration/writes/limits.json": '{\n\t"a": { "limit": 2 }\n}\n' },
	);
	const changes = ['a: 1 statements at most, limit 2; tightened to {"limit":1}'];
	const { run } = fakeDb({ listed: ["@everyfield/domain"], census: { status: 0, output: "", changes } });
	const { record } = check({ root, full: false, home, run, database: noWait });
	const entry = censusEntry(record);
	assert.equal(entry.result, "passed", entry.detail);
	assert.deepEqual(entry.tightened, changes);
	assert.equal(
		readFileSync(join(root, "tests/integration/writes/limits.json"), "utf8"),
		'{\n\t"a": { "limit": 1 }\n}\n',
	);
});

test("T-105 a full run runs every test:db, then the census, one after another on one throwaway Postgres", (t) => {
	const { root, home } = repo(t, { "docs/a.md": "b\n" }, DB_PACKAGES);
	const { run, calls, commands } = fakeDb({
		listed: ["@everyfield/db", "@everyfield/domain", "@everyfield/evry", "@everyfield/ui"],
	});
	const { record, recordPath } = check({ root, full: true, home, run, database: noWait });
	const entry = dbEntry(record);
	assert.equal(entry.result, "passed", entry.detail);
	assert.equal(entry.tests, 8);
	assert.deepEqual(entry.packages, [
		{
			name: "@everyfield/db",
			command: "corepack pnpm --filter @everyfield/db run test:db",
			result: "passed",
			tests: 4,
		},
		{
			name: "@everyfield/evry",
			command: "corepack pnpm --filter @everyfield/evry run test:db",
			result: "passed",
			tests: 4,
		},
	]);
	const started = calls.find((c) => c.command.startsWith("docker run "))!.command.split(" ");
	const container = started[started.indexOf("--name") + 1]!;
	assert.match(container, /^evf-check-db-evf-check-repo-/);
	assert.deepEqual(entry.database, { throwaway: true, image: IMAGE, container });
	assert.equal(started.at(-1), IMAGE);
	assert.ok(started.includes("127.0.0.1::5432") && started.includes("POSTGRES_DB=everyfield_ci"), started.join(" "));
	assert.ok(started[started.indexOf("--label") + 1]!.startsWith(`${LABEL}=`));
	const password = started.find((a) => a.startsWith("POSTGRES_PASSWORD="))!.slice("POSTGRES_PASSWORD=".length);
	assert.match(password, /^[0-9a-f]{36}$/);
	assert.ok(!readFileSync(recordPath, "utf8").includes(password), "the record holds the password");
	const order = commands().filter((c) => c.startsWith("docker") || /db:migrate|test:db|run build/.test(c));
	assert.deepEqual(
		order.map((c) => c.split(" ").slice(0, 2).join(" ")),
		[
			"docker ps",
			"docker run",
			"docker exec",
			"docker port",
			"corepack pnpm",
			"corepack pnpm",
			"corepack pnpm",
			"corepack pnpm",
			"corepack pnpm",
			"docker rm",
		],
	);
	assert.deepEqual(
		order.filter((c) => c.startsWith("corepack")).map((c) => c.replace("corepack pnpm ", "")),
		[
			"db:migrate",
			"--filter @everyfield/db run test:db",
			"--filter @everyfield/evry run test:db",
			"--filter @everyfield/web run build",
			"--filter @everyfield/domain run test:db",
		],
	);
	assert.equal(censusEntry(record).database?.container, container);
	assert.ok(order.at(-1)!.endsWith(container));
	const url = `postgres://ci:${password}@127.0.0.1:55432/everyfield_ci`;
	const database = { DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, EARLY_ACCESS_TEST_DATABASE: "1", CI: "true" };
	const usesDatabase = (c: Call) => /db:migrate|test:db|run build/.test(c.command);
	for (const c of calls.filter(usesDatabase)) {
		const { PATH: _, EVF_CENSUS_TIGHTENED: tightened, NEXT_TELEMETRY_DISABLED: telemetry, ...rest } = c.env;
		assert.deepEqual(rest, database, c.command);
		assert.equal(Boolean(tightened), c.command.includes("@everyfield/domain"), c.command);
		assert.equal(telemetry, c.command.includes("run build") ? "1" : undefined, c.command);
	}
	for (const c of calls.filter((c) => !usesDatabase(c))) assert.equal(c.env.DATABASE_URL, undefined, c.command);
});

test("T-105 each database failure fails test:db, the census and the run with its reason, never skipped or passed", async (t) => {
	const both = (detail: string) => [`test:db failed: ${detail}`, `census failed: ${detail}`];
	const cases: [Parameters<typeof fakeDb>[0]["fail"], string[], boolean][] = [
		["docker", both("Docker cannot be reached: Cannot connect to the Docker daemon"), false],
		["ready", both("the database was not ready within 0 s"), true],
		["migrate", both("pnpm db:migrate failed on the throwaway database"), true],
		["@everyfield/db", ["test:db failed: @everyfield/db test:db failed"], true],
		[
			"zero",
			["test:db failed: @everyfield/db reported 0 tests", "census failed: the statement census reported 0 tests"],
			true,
		],
	];
	for (const [fail, failure, started] of cases)
		await t.test(String(fail), (t) => {
			const { root, home } = repo(t, { "packages/db/src/client.ts": "export const c = 1;\n" }, DB_PACKAGES);
			const { run, commands } = fakeDb({ listed: ["@everyfield/db"], fail });
			const { record } = check({ root, full: false, home, run, database: noWait });
			assert.equal(dbEntry(record).result, "failed");
			assert.equal(record.result, "failed");
			assert.deepEqual(record.failures, failure);
			const run_ = commands().find((c) => c.startsWith("docker run "));
			assert.equal(Boolean(run_), started);
			if (run_) {
				const container = run_.split(" ")[run_.split(" ").indexOf("--name") + 1];
				assert.equal(commands().at(-1), `docker rm -f -v ${container}`, "the container outlives the run");
			}
		});
});

test("T-105 a container a crashed run left for this checkout is removed at the next start", (t) => {
	const { root, home } = repo(t, { "packages/db/src/client.ts": "export const c = 1;\n" }, DB_PACKAGES);
	const { run: base, commands } = fakeDb({ listed: ["@everyfield/db"] });
	const run: Runner = (command, args, options) =>
		command === "docker" && args[0] === "ps"
			? (base(command, args, options), { status: 0, stdout: "abc123\n", output: "" })
			: base(command, args, options);
	check({ root, full: false, home, run, database: noWait });
	const sweep = commands().find((c) => c.startsWith("docker ps"))!;
	assert.match(sweep, new RegExp(`^docker ps -aq --filter label=${LABEL.replaceAll(".", "\\.")}=[0-9a-f]{16}$`));
	assert.equal(commands()[commands().indexOf(sweep) + 1], "docker rm -f -v abc123");
});

test("T-105 the throwaway DATABASE_URL wins over the one an env file names", (t) => {
	const { root, home } = repo(t, { "packages/db/src/client.ts": "export const c = 1;\n" }, DB_PACKAGES);
	const envFile = join(root, "fixture.env");
	writeFileSync(
		envFile,
		"DATABASE_URL=postgres://shared.example.test/dev\nDATABASE_URL_UNPOOLED=postgres://shared.example.test/dev\n",
	);
	const { run: base } = fakeDb({ listed: ["@everyfield/db"] });
	let seen = "";
	const run: Runner = (command, args, options) => {
		if (!args.includes("test:db")) return base(command, args, options);
		const r = spawnRunner(
			process.execPath,
			[
				`--env-file-if-exists=${envFile}`,
				"-e",
				"console.log(process.env.DATABASE_URL + ' ' + process.env.DATABASE_URL_UNPOOLED); console.log('ℹ tests 1')",
			],
			options,
		);
		seen = r.stdout.split("\n")[0]!;
		return r;
	};
	const { record } = check({ root, full: false, home, run, database: noWait });
	assert.equal(dbEntry(record).result, "passed", dbEntry(record).detail);
	assert.match(
		seen,
		/^postgres:\/\/ci:[0-9a-f]{36}@127\.0\.0\.1:55432\/everyfield_ci postgres:\/\/ci:[0-9a-f]{36}@127\.0\.0\.1:55432\/everyfield_ci$/,
	);
});

test("T-105 the throwaway database uses the image of GitHub CI's db job", () => {
	const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
	const job = ci.split(/^  db:\n/m)[1]!.split(/^  \S/m)[0]!;
	assert.equal(job.match(/^\s+image: (\S+)$/m)?.[1], IMAGE);
});
