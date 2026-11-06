import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditDoctorLines, fileResult, pickCandidate, pickTarget, targetOf, type Candidate } from "../audit.ts";
import { openWorkDb } from "../db.ts";
import { doctor } from "../doctor.ts";
import { fixture, source } from "./fixtures.ts";

const MAIN = join(source, "tools/evf/main.ts");
/** A spec whose two Done criteria are checked by `AC:<ref>-1` and `AC:<ref>-2`, as OPS-112 writes them. */
const SPEC = (ref: string) =>
	`## Goal\n\nFixture.\n\n## Done criteria\n\n1. Criterion 1.\n   Check: AC:${ref}-1\n2. Criterion 2.\n   Check: AC:${ref}-2\n\n## Non-goals\n\n- None.\n`;

/** The files of each fixture merge. Each merge adds its source lines and its marked tests in one squash commit. */
const BASE: Record<string, string> = {
	"packages/calc/src/range.ts": "export function big(x: number) {\n\tif (x > 1) return x;\n\treturn 0;\n}\n",
	"packages/web/src/boot.mjs": "let ready = false;\nexport function boot() {\n\tready = true;\n}\n",
};
const MERGES: Record<string, Record<string, string>> = {
	// Four candidates: three off-by-one mutants of `age >= 18` that the test catches, one dropped call it misses.
	"OPS-901": {
		"packages/calc/src/adult.mjs":
			"export function isAdult(age) {\n\treturn age >= 18;\n}\nexport function close(state) {\n\tstate.open = false;\n\tstate.onClose();\n\treturn state;\n}\n",
		"tests/calc/adult.test.mjs":
			'// AC:OPS-901-1 adulthood starts at 18.\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isAdult, close } from "../../packages/calc/src/adult.mjs";\n\ntest("AC:OPS-901-1 adult from 18", () => {\n\tassert.equal(isAdult(18), true);\n\tassert.equal(isAdult(17), false);\n\tassert.equal(close({ open: true, onClose() {} }).open, false);\n});\n',
	},
	// Every operator, and every line the candidates must skip.
	"OPS-902": {
		"packages/calc/src/range.ts":
			'export function big(x: number) {\n\tif (x > 1) return x;\n\treturn 0;\n}\nexport function inRange(n: number, max: number) {\n\treturn n < max;\n}\nexport function head(list: string[]) {\n\treturn list.slice(0, 2);\n}\nexport function shut(state: { close: () => void }) {\n\t// state.close(); a comment\n\tstate.close();\n\tconst label = "a < b";\n\treturn label;\n}\n',
		"apps/web/src/app/(x)/thing/page.tsx": "export default function Page() {\n\treturn null;\n}\n",
		"tests/calc/range.test.mjs":
			'// AC:OPS-902-1\nimport { test } from "node:test";\ntest("AC:OPS-902-1 range", () => {\n\tif (1 < 3) return;\n});\n',
		"tools/script.mjs": "export const less = (a, b) => a < b;\n",
	},
	// A red baseline: the marked test fails on main.
	"OPS-905": {
		"packages/calc/src/red.mjs": "export const ten = (n) => n > 10;\n",
		"tests/calc/red.test.mjs":
			'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { ten } from "../../packages/calc/src/red.mjs";\ntest("AC:OPS-905-1 red on main", () => assert.equal(ten(5), true));\n',
	},
	// A browser test: each tree gets its own preview, and a mutant that does not start is invalid.
	"OPS-906": {
		"packages/web/src/boot.mjs":
			'let ready = false;\nexport function boot() {\n\tready = true;\n}\nboot();\nif (!ready) throw new Error("did not start");\n',
		"tests/ui/web/boot.test.mjs":
			'// AC:OPS-906-1 the preview serves this tree (reads UI_BASE_URL like tests/ui/setup.mjs).\nimport assert from "node:assert/strict";\nimport { execFileSync } from "node:child_process";\nimport { test } from "node:test";\ntest("AC:OPS-906-1 preview of this exact tree", () => {\n\tconst head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();\n\tassert.equal(process.env.UI_BASE_URL, `https://fixture-${head}.localhost`);\n\tassert.equal(process.env.UI_ENGINE, undefined);\n});\n',
	},
	// A slow test, for a stopped run. It records its PID so the test can prove the stop reached it.
	"OPS-904": {
		"packages/calc/src/slow.mjs": "export const positive = (n) => n > 0;\n",
		"tests/calc/slow.test.mjs":
			'import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("AC:OPS-904-1 slow", async () => {\n\twriteFileSync(process.env.SLOW_PID_FILE, String(process.pid));\n\tawait new Promise((r) => setTimeout(r, 120000));\n});\n',
	},
	// Merged 40 days ago: outside the 30-day window of a run with no --task.
	"OPS-907": {
		"packages/calc/src/old.mjs": "export const old = (n) => n > 2;\n",
		"tests/calc/old.test.mjs": 'import { test } from "node:test";\ntest("AC:OPS-907-1 old", () => {});\n',
	},
	// Merged with candidates but no marked test.
	"OPS-903": { "packages/calc/src/bare.mjs": "export const neg = (n) => n < 0;\n" },
	// The marker only in a comment: the file carries it, but no test name does.
	"OPS-908": {
		"packages/calc/src/eight.mjs": "export const eight = (n) => n > 8;\n",
		"tests/calc/eight.test.mjs":
			'// AC:OPS-908-1 in a comment only\nimport { test } from "node:test";\ntest("eight", () => {});\n',
	},
	// A WP task: its markers are the package case IDs of WP-038; the runner sees NODE_ENV and the database env.
	"WP-038": {
		"packages/calc/src/phase.mjs": "export const last = (p) => p >= 6;\n",
		"tests/calc/phase.test.mjs":
			'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { last } from "../../packages/calc/src/phase.mjs";\ntest("AC:PHASE-CASE-001 phase six is last", () => {\n\tassert.equal(last(6), true);\n\tassert.equal(last(5), false);\n\tassert.equal(process.env.NODE_ENV, "test");\n\tassert.equal(process.env.DATABASE_URL, undefined);\n\tassert.ok(process.execArgv.includes("--conditions=react-server"));\n});\n',
		// The file carries a marker in a comment; its test name does not, so the test never runs (it would fail).
		"tests/calc/comment.test.mjs":
			'// AC:PHASE-CASE-001 in a comment\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unmarked", () => assert.fail("an unmarked test ran"));\n',
		// A browser file with the marker in a comment only: none of its tests runs, so the audit starts no preview.
		"tests/ui/calc/comment-browser.test.mjs":
			'// AC:PHASE-CASE-001 in a comment; reads UI_BASE_URL like tests/ui/setup.mjs\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("unmarked browser test", () => assert.ok(process.env.UI_BASE_URL));\n',
		"tests/calc/near.test.mjs":
			'import { test } from "node:test";\ntest("AC:PHASE-CASE-0010 not a WP-038 case", () => {});\n',
		"tests/calc/db.production.test.mjs":
			'import { test } from "node:test";\ntest("AC:PHASE-CASE-001 production only", () => {});\n',
		"tests/ui/escaped/old-bug.test.mjs":
			'import assert from "node:assert/strict";\nimport { test } from "node:test";\n// tests/ui runs without the react-server condition, as pnpm test:ui runs it.\ntest("an escaped bug stays fixed", () => assert.equal(process.execArgv.includes("--conditions=react-server"), false));\n',
		// TypeScript tests run on the tsx a workspace package installed, as the package scripts run them. This fake
		// records its arguments and runs them on Node.
		"tests/calc/phase.test.mts": 'import { test } from "node:test";\ntest("AC:PHASE-CASE-002 typescript", () => {});\n',
		"packages/tool/node_modules/tsx/dist/cli.mjs":
			'import { appendFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nappendFileSync(process.env.TSX_LOG, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);\n',
	},
};

type F = ReturnType<typeof fixture> & {
	merges: Record<string, string>;
	cli: (args: string[], env?: NodeJS.ProcessEnv) => { code: number; out: string; err: string };
	store: () => ReturnType<typeof openWorkDb>;
	state: () => string;
	stackLog: string;
};

function setup(): F {
	const f = fixture();
	const write = (files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(f.root, path)), { recursive: true });
			writeFileSync(join(f.root, path), text);
		}
	};
	// The fake stack: `up` imports the tree's boot module (a mutant that throws there does not start), then writes the
	// preview URL of that tree's HEAD into stack.json, as scripts/stack.mjs does.
	const stack = join(f.root, "fake-bin/stack.mjs"),
		stackLog = join(f.root, "fake-bin/stack.log");
	writeFileSync(
		stack,
		`import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [action, ...rest] = process.argv.slice(2), tree = process.env.EVF_WORKTREE, runtime = process.env.EVF_RUNTIME_DIR;
const head = execFileSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
appendFileSync(${JSON.stringify(stackLog)}, JSON.stringify({ action, rest, tree, head }) + "\\n");
if (action === "up") {
	await import(pathToFileURL(join(tree, "packages/web/src/boot.mjs")).href);
	mkdirSync(runtime, { recursive: true });
	writeFileSync(join(runtime, "stack.json"), JSON.stringify({ url: "https://fixture-" + head + ".localhost" }));
} else if (action === "down") rmSync(join(runtime, "stack.json"), { force: true });
`,
	);
	f.cfg.stack = {
		usesPaidProviders: false,
		up: ["node", stack, "up"],
		status: ["node", stack, "status"],
		down: ["node", stack, "down"],
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
	write(BASE);
	f.git("add", "-A");
	f.git("commit", "-qm", "Fixture app");
	const merges: Record<string, string> = {};
	// Merge times in file order, ten days ago plus one minute each; OPS-907 merged 40 days ago.
	const now = Date.now();
	Object.entries(MERGES).forEach(([ref, files], i) => {
		write(files);
		f.git("add", "-A");
		const at = new Date(ref === "OPS-907" ? now - 40 * 86_400_000 : now - 10 * 86_400_000 + i * 60_000).toISOString();
		process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = at;
		f.git("commit", "-qm", `${ref}: fixture merge`);
		delete process.env.GIT_COMMITTER_DATE;
		delete process.env.GIT_AUTHOR_DATE;
		merges[ref] = f.git("rev-parse", "HEAD");
	});
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	const store = () => openWorkDb(f.root);
	const db = store();
	const at = new Date().toISOString();
	for (const [ref, sha] of Object.entries(merges))
		db.prepare(
			"INSERT INTO tasks (slug, mode, ref, title, spec, status, merge_commit, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, 'merged', ?, ?, ?)",
		).run(ref.toLowerCase(), ref, ref, ref.startsWith("OPS") ? SPEC(ref) : null, sha, at, at);
	db.close();
	const cli = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
		const r = spawnSync(process.execPath, [MAIN, "audit", ...args], { cwd: f.root, env, encoding: "utf8" });
		return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
	};
	const state = () =>
		[
			f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
			spawnSync("git", ["ls-remote", remote], { encoding: "utf8" }).stdout,
			f.git("worktree", "list", "--porcelain"),
		].join("\n---\n");
	return { ...f, merges, cli, store, state, stackLog };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const candidateOf = (out: string) => /candidate (\S+), seed (\d+)/.exec(out)!;
const listIds = (out: string, op: string) =>
	out
		.split("\n")
		.filter((l) => l.includes(`  ${op}  `))
		.map((l) => l.split("  ")[0]!);

test("AC:OPS-116-1 --list prints the exact candidates of a known merge: three operators, changed source lines only", () => {
	const f = setup();
	try {
		const db = f.store();
		const target = targetOf(f.root, db, f.git("rev-parse", "origin/main"), "OPS-902");
		db.close();
		assert.equal(typeof target, "object");
		const rows = (target as { candidates: Candidate[] }).candidates
			.map((c) => [c.operator, c.file, c.line, c.after])
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		// Skipped: the unchanged `x > 1` line, the comment, the string "a < b", the test file and tools/.
		assert.deepEqual(rows, [
			["dropped-call", "packages/calc/src/range.ts", 13, null],
			["off-by-one", "packages/calc/src/range.ts", 6, "\treturn n <= max;"],
			["off-by-one", "packages/calc/src/range.ts", 9, "\treturn list.slice(-1, 2);"],
			["off-by-one", "packages/calc/src/range.ts", 9, "\treturn list.slice(0, 1);"],
			["off-by-one", "packages/calc/src/range.ts", 9, "\treturn list.slice(0, 3);"],
			["off-by-one", "packages/calc/src/range.ts", 9, "\treturn list.slice(1, 2);"],
			["removed-route", "apps/web/src/app/(x)/thing/page.tsx", 1, null],
		]);
		const listed = f.cli(["--list", "--task", "OPS-902"]);
		assert.equal(listed.code, 0, listed.err);
		const lines = listed.out.split("\n").filter((l) => /^(obo|drop|route)-[0-9a-f]{8}  /.test(l));
		assert.equal(lines.length, 7);
		assert.ok(
			lines.includes(
				`${listIds(listed.out, "dropped-call")[0]}  dropped-call  packages/calc/src/range.ts:13  state.close(); → (line removed)`,
			),
		);
		assert.ok(
			lines.some((l) => l.endsWith("off-by-one  packages/calc/src/range.ts:6  return n < max; → return n <= max;")),
		);
		assert.ok(lines.some((l) => l.endsWith("removed-route  apps/web/src/app/(x)/thing/page.tsx:1  (file removed)")));
		// Stable ids: a second listing prints the same lines.
		assert.deepEqual(f.cli(["--list", "--task", "OPS-902"]).out, listed.out);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-2 marked tests: WP case IDs, spec markers, the escaped folder, and both refusals", () => {
	const f = setup();
	try {
		const db = f.store(),
			main = f.git("rev-parse", "origin/main");
		const wp = targetOf(f.root, db, main, "WP-038") as Exclude<ReturnType<typeof targetOf>, string>;
		const ops = targetOf(f.root, db, main, "OPS-901") as Exclude<ReturnType<typeof targetOf>, string>;
		db.close();
		// AC:PHASE-CASE-0010 is not PHASE-CASE-001, and a *.production.* file never runs.
		assert.deepEqual(wp.marked, [
			"tests/calc/comment.test.mjs",
			"tests/calc/phase.test.mjs",
			"tests/calc/phase.test.mts",
			"tests/ui/calc/comment-browser.test.mjs",
		]);
		assert.ok(wp.markers.includes("PHASE-CASE-001"));
		assert.deepEqual(wp.escaped, ["tests/ui/escaped/old-bug.test.mjs"]);
		assert.deepEqual(ops.markers, ["OPS-901-1", "OPS-901-2"]);
		assert.deepEqual(ops.marked, ["tests/calc/adult.test.mjs"]);

		// Markers in comments only: the run refuses before it plants anything.
		const commentOnly = f.cli(["--task", "OPS-908", "--seed", "1"]);
		assert.equal(commentOnly.code, 1);
		assert.match(commentOnly.err, /OPS-908 has no marked test: no test name on main carries AC:<marker>/);
		assert.doesNotMatch(commentOnly.out, /planted/);

		const notMerged = f.cli(["--list", "--task", "OPS-950"]);
		assert.equal(notMerged.code, 1);
		assert.match(
			notMerged.err,
			/OPS-950 is not merged: the work store has no merged row whose merge commit is on main\./,
		);
		const unmarked = f.cli(["--list", "--task", "OPS-903"]);
		assert.equal(unmarked.code, 1);
		assert.match(
			unmarked.err,
			/OPS-903 has no marked test: no test on main carries AC:<marker> for any of its 2 markers\./,
		);

		// A run on the WP task runs its marked test and the escaped test, with NODE_ENV=test and no shell database URL.
		const tsxLog = join(f.root, "fake-bin/tsx.log");
		const run = f.cli(["--task", "WP-038", "--seed", "1"], {
			...process.env,
			DATABASE_URL: "postgres://not-dev.invalid/x",
			TSX_LOG: tsxLog,
		});
		assert.equal(run.code, 0, run.err + run.out);
		assert.match(
			run.out,
			/tests \(5\): tests\/calc\/comment\.test\.mjs, tests\/calc\/phase\.test\.mjs, tests\/calc\/phase\.test\.mts, tests\/ui\/calc\/comment-browser\.test\.mjs, tests\/ui\/escaped\/old-bug\.test\.mjs/,
		);
		// The browser file runs no test, so no preview starts.
		assert.match(run.out, /^evf audit: baseline on main\.$/m);
		assert.equal(existsSync(f.stackLog), false);
		// Only tests whose name carries a marker run: the unmarked test of comment.test.mjs never runs.
		assert.match(run.out, /tests\/calc\/comment\.test\.mjs: passed \(0 tests\)/);
		assert.match(run.out, /tests\/calc\/phase\.test\.mjs: passed \(1 tests\)/);
		assert.match(run.out, /outcome killed/);
		// Main and the mutant each ran the TypeScript file through tsx; the JavaScript files ran on plain Node.
		const tsxRuns = readFileSync(tsxLog, "utf8").trim().split("\n");
		assert.equal(tsxRuns.length, 2);
		assert.ok(tsxRuns.every((l) => l.endsWith(" tests/calc/phase.test.mts")));
	} finally {
		f.close();
	}
});

test("AC:OPS-116-3 with no --task: never-audited first, then the oldest audit; a seed repeats the run", () => {
	const f = setup();
	try {
		const db = f.store(),
			main = f.git("rev-parse", "origin/main"),
			now = new Date();
		// Merges older than 30 days drop out; WP-038 merged last, so the never-audited OPS-901 (oldest merge) goes first.
		const order: string[] = [];
		const eligible = ["OPS-901", "OPS-902", "OPS-905", "OPS-906", "OPS-904", "OPS-908", "WP-038"];
		for (let i = 0; i < eligible.length; i++) {
			const picked = pickTarget(f.root, db, main, now).ref;
			order.push(picked);
			db.prepare(
				"INSERT INTO audit_runs (task_ref, merge_commit, main_sha, candidate_id, operator, file, line, seed, outcome, started_at, ended_at) VALUES (?, ?, ?, 'x', 'off-by-one', 'f', 1, 1, 'killed', ?, ?)",
			).run(
				picked,
				f.merges[picked]!,
				main,
				new Date(now.getTime() + i).toISOString(),
				new Date(now.getTime() + i).toISOString(),
			);
		}
		assert.deepEqual(order, eligible);
		// Every task audited now: the oldest audit comes back first.
		assert.equal(pickTarget(f.root, db, main, now).ref, "OPS-901");
		// Thirty-one days later nothing is inside the window.
		assert.throws(
			() => pickTarget(f.root, db, main, new Date(now.getTime() + 31 * 86_400_000)),
			/No task merged in the last 30 days/,
		);
		db.close();

		const first = f.cli(["--dry-run", "--task", "OPS-901"]);
		assert.equal(first.code, 0, first.err);
		const [, id, seed] = candidateOf(first.out);
		assert.match(
			first.out,
			new RegExp(`repeat: bin/evf audit --task OPS-901 --mutation ${id} --seed ${seed} --dry-run`),
		);
		const again = f.cli(["--dry-run", "--task", "OPS-901", "--seed", seed!]);
		assert.equal(candidateOf(again.out)[1], id);
		const listed = f.cli(["--list", "--task", "OPS-901"]).out;
		const all = listed
			.split("\n")
			.filter((l) => /^(obo|drop)-/.test(l))
			.map((l) => ({ id: l.split("  ")[0]! }) as Candidate);
		assert.equal(pickCandidate(all, Number(seed)).id, id);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-4 a detached temporary worktree: refs, branches and worktrees match after a passing, failing, stopped and crashed run", async () => {
	const f = setup();
	try {
		const before = f.state();
		const killed = f.cli([
			"--task",
			"OPS-901",
			"--mutation",
			listIds(f.cli(["--list", "--task", "OPS-901"]).out, "off-by-one")[0]!,
		]);
		assert.equal(killed.code, 0, killed.err);
		assert.match(killed.out, /outcome killed/);
		assert.equal(f.state(), before);
		const red = f.cli(["--task", "OPS-905", "--seed", "3"]);
		assert.equal(red.code, 1);
		assert.equal(f.state(), before);

		// A stopped run: SIGTERM while the slow test runs. The test process dies with it and nothing stays behind.
		const pidFile = join(f.root, "fake-bin/slow.pid");
		const child = spawn(process.execPath, [MAIN, "audit", "--task", "OPS-904", "--seed", "1"], {
			cwd: f.root,
			env: { ...process.env, SLOW_PID_FILE: pidFile },
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		for (let i = 0; i < 300 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(existsSync(pidFile), out);
		const active = JSON.parse(readFileSync(join(f.root, ".git/evf/audit/active.json"), "utf8"));
		assert.ok(!active.tree.startsWith(f.root), "the audit worktree is outside the repository");
		assert.ok(f.git("worktree", "list").includes("evf-audit-"));
		assert.match(f.git("-C", active.tree, "status", "--branch", "--porcelain"), /^## HEAD \(no branch\)/);
		child.kill("SIGTERM");
		const code = await new Promise((r) => child.on("close", r));
		assert.equal(code, 143, out);
		const testPid = Number(readFileSync(pidFile, "utf8"));
		for (let i = 0; i < 50 && alive(testPid); i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(alive(testPid), false, "the stop reached the test process");
		assert.equal(f.state(), before);
		assert.ok(!existsSync(active.tree));
		const db = f.store();
		assert.equal(
			(db.prepare("SELECT outcome FROM audit_runs ORDER BY id DESC LIMIT 1").get() as { outcome: string }).outcome,
			"stopped",
		);
		db.close();

		// A crashed run (SIGKILL) leaves its worktree: doctor reports it, and the next evf audit removes it.
		const crash = spawn(process.execPath, [MAIN, "audit", "--task", "OPS-904", "--seed", "1"], {
			cwd: f.root,
			env: { ...process.env, SLOW_PID_FILE: pidFile + "2" },
		});
		for (let i = 0; i < 300 && !existsSync(pidFile + "2"); i++) await new Promise((r) => setTimeout(r, 100));
		crash.kill("SIGKILL");
		await new Promise((r) => crash.on("close", r));
		process.kill(Number(readFileSync(pidFile + "2", "utf8")), "SIGKILL"); // its test process outlived the crash
		assert.notEqual(f.state(), before);
		assert.ok(
			auditDoctorLines(f.root, null).some((l) =>
				/^audit worktree .*evf-audit-.* is left from a stopped evf audit; the next evf audit removes it$/.test(l),
			),
		);
		const next = f.cli(["--list", "--task", "OPS-901"]);
		assert.equal(next.code, 0, next.err);
		assert.match(next.err, /removed .*evf-audit-.*, left by a stopped audit/);
		assert.equal(f.state(), before);
		assert.ok(!auditDoctorLines(f.root, null).some((l) => l.startsWith("audit worktree")));
	} finally {
		f.close();
	}
});

test("AC:OPS-116-5 four outcomes on stub tests: killed, survived, baseline-red, and invalid when the mutant does not start", () => {
	const f = setup();
	try {
		const list = f.cli(["--list", "--task", "OPS-901"]).out;
		const killed = f.cli(["--dry-run", "--task", "OPS-901", "--mutation", listIds(list, "off-by-one")[0]!]);
		assert.match(killed.out, /evf audit: outcome killed\. Failed on the mutant: tests\/calc\/adult\.test\.mjs\./);
		const survived = f.cli(["--dry-run", "--task", "OPS-901", "--mutation", listIds(list, "dropped-call")[0]!]);
		assert.match(survived.out, /evf audit: outcome survived\./);

		const red = f.cli(["--task", "OPS-905", "--seed", "1"]);
		assert.equal(red.code, 1);
		assert.match(
			red.out,
			/evf audit: outcome baseline-red\. Failing on main: tests\/calc\/red\.test\.mjs\. Nothing planted, nothing filed\./,
		);
		assert.doesNotMatch(red.out, /mutant .* planted/);

		// The browser test runs against a preview of each tree. Dropping boot() stops the app from starting: invalid.
		const invalid = f.cli(["--task", "OPS-906", "--seed", "1"], { ...process.env, UI_ENGINE: "chromium" });
		assert.equal(invalid.code, 0, invalid.err + invalid.out);
		assert.match(invalid.out, /baseline on main with a preview/);
		assert.match(invalid.out, /evf audit: outcome invalid\. The mutant did not build or start; it proves nothing\./);
		const calls = readFileSync(f.stackLog, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.deepEqual(
			calls.map((c) => [c.action, c.rest]),
			[
				["up", ["--mode", "production"]],
				["down", []],
				["up", ["--mode", "production"]],
			],
		);
		assert.equal(calls[0].head, f.git("rev-parse", "origin/main"));
		assert.notEqual(calls[2].head, calls[0].head, "the mutant tree gets its own preview");

		// A test file that fails to load is invalid, never killed; a failed assertion is failed.
		assert.equal(fileResult(1, "# SyntaxError: Unexpected token ';'\nnot ok 1 - a.test.mjs\n# pass 0\n"), "invalid");
		assert.equal(fileResult(1, "not ok 1 - a\n  error: 'SyntaxError in the app'\n# pass 0\n"), "failed");
		assert.equal(fileResult(0, "# pass 1\n"), "passed");
	} finally {
		f.close();
	}
});

test("AC:OPS-116-6 AC:OPS-148-5 a survivor files one new OPS task whose stored ask is exact, and prints its entry file and path", () => {
	const f = setup();
	try {
		const config = createHash("sha256")
			.update(readFileSync(join(f.root, "evf.config.json")))
			.digest("hex");
		const drop = listIds(f.cli(["--list", "--task", "OPS-901"]).out, "dropped-call")[0]!;
		const r = f.cli(["--task", "OPS-901", "--mutation", drop, "--seed", "5"]);
		assert.equal(r.code, 0, r.err + r.out);
		const id = /filed (OPS-\d+) \(status new\)/.exec(r.out)![1]!;
		const db = f.store();
		const row = db.prepare("SELECT title, ask, status FROM tasks WHERE ref = ?").get(id) as Record<string, string>;
		db.close();
		const main = f.git("rev-parse", "origin/main");
		assert.equal(row.status, "new");
		assert.equal(row.title, "Answer key for OPS-901 missed dropped-call in packages/calc/src/adult.mjs:6");
		assert.equal(
			row.ask,
			`# Ask: Answer key for OPS-901 missed dropped-call in packages/calc/src/adult.mjs:6

Filed by \`evf audit\` (OPS-116). One planted bug survived every marked test of OPS-901.

- Audited task: OPS-901 (merge commit ${f.merges["OPS-901"]})
- Main SHA: ${main}
- Candidate: ${drop} (dropped-call, seed 5)
- Repeat: \`bin/evf audit --task OPS-901 --mutation ${drop} --seed 5 --dry-run\`

## Mutation diff

\`\`\`diff
--- a/packages/calc/src/adult.mjs
+++ b/packages/calc/src/adult.mjs
@@ -6 +5,0 @@
-	state.onClose();
\`\`\`

## Tests that ran

- tests/calc/adult.test.mjs: 1 test ran; main passed, mutant passed
- tests/ui/escaped/old-bug.test.mjs: 1 test ran; main passed, mutant passed

## Done template

1. A test that carries one of OPS-901's markers (\`AC:<marker>\`) fails on this mutant and passes on main.
   Check: \`bin/evf audit --task OPS-901 --mutation ${drop}\` reports \`killed\`.
`,
		);
		// AC:OPS-148-5 the entry and its path, and the command writes no entry file.
		assert.ok(r.out.includes(`on ${id}'s branch as tools/evf/tasks/${id}.json (evf audit writes no file):\n{`), r.out);
		const printed = r.out.slice(r.out.indexOf("{", r.out.indexOf(`tools/evf/tasks/${id}.json`)));
		assert.deepEqual(JSON.parse(printed), {
			title: "Answer key for OPS-901 missed dropped-call in packages/calc/src/adult.mjs:6",
			owningPaths: ["tests/"],
			checks: [
				{ name: "documentation", run: ["python3", "docs/check-all.py"] },
				{ name: "package-unit-tests", run: ["corepack", "pnpm", "-r", "--if-present", "test:unit"] },
			],
			risk: "ordinary",
		});
		assert.equal(existsSync(join(f.root, `tools/evf/tasks/${id}.json`)), false);
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(f.root, "evf.config.json")))
				.digest("hex"),
			config,
		);
		assert.match(
			spawnSync("git", ["ls-remote", join(f.root, "fake-bin/origin.git"), `refs/evf/ids/${id}`], { encoding: "utf8" })
				.stdout,
			new RegExp(id),
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-7 killed, invalid and baseline-red file nothing; a repeat survivor and --dry-run file no new task", () => {
	const f = setup();
	try {
		const remote = join(f.root, "fake-bin/origin.git");
		const reservations = () => spawnSync("git", ["ls-remote", remote, "refs/evf/ids/*"], { encoding: "utf8" }).stdout;
		const tasks = () => {
			const db = f.store();
			const n = (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
			db.close();
			return n;
		};
		const start = tasks();
		const list = f.cli(["--list", "--task", "OPS-901"]).out;
		assert.match(f.cli(["--task", "OPS-901", "--mutation", listIds(list, "off-by-one")[1]!]).out, /outcome killed/);
		assert.match(f.cli(["--task", "OPS-906", "--seed", "1"]).out, /outcome invalid/);
		assert.match(f.cli(["--task", "OPS-905", "--seed", "1"]).out, /outcome baseline-red/);
		assert.equal(tasks(), start);
		assert.equal(reservations(), "");

		const drop = listIds(list, "dropped-call")[0]!;
		const dry = f.cli(["--dry-run", "--task", "OPS-901", "--mutation", drop]);
		assert.match(
			dry.out,
			/dry run\. No id reserved, nothing filed\. The ask it would file:\n\n# Ask: Answer key for OPS-901 missed dropped-call/,
		);
		assert.equal(tasks(), start);
		assert.equal(reservations(), "");

		const first = f.cli(["--task", "OPS-901", "--mutation", drop]);
		const id = /filed (OPS-\d+)/.exec(first.out)![1];
		assert.equal(tasks(), start + 1);
		const again = f.cli(["--task", "OPS-901", "--mutation", drop]);
		assert.match(again.out, new RegExp(`this survivor is filed already as ${id}\\. Nothing new filed\\.`));
		assert.equal(tasks(), start + 1);
		assert.equal(reservations().trim().split("\n").length, 1);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-8 report proof: four candidates, three killed and one survived, one new task naming the fourth", () => {
	const f = setup();
	try {
		const list = f.cli(["--list", "--task", "OPS-901"]).out;
		const ids = list
			.split("\n")
			.filter((l) => /^(obo|drop)-/.test(l))
			.map((l) => l.split("  ")[0]!);
		assert.equal(ids.length, 4);
		const outcomes = ids.map((id) => /outcome (\S+?)\./.exec(f.cli(["--task", "OPS-901", "--mutation", id]).out)![1]);
		assert.deepEqual([...outcomes].sort(), ["killed", "killed", "killed", "survived"]);
		const db = f.store();
		const filed = db.prepare("SELECT ref, title FROM tasks WHERE status = 'new'").all() as Array<{
			ref: string;
			title: string;
		}>;
		db.close();
		assert.equal(filed.length, 1);
		assert.equal(filed[0]!.title, "Answer key for OPS-901 missed dropped-call in packages/calc/src/adult.mjs:6");
		assert.equal(ids[outcomes.indexOf("survived")], listIds(list, "dropped-call")[0]);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-9 the store records each run, and doctor warns only when no audit killed or survived in 31 days", () => {
	const f = setup();
	const doctorAudit = () => {
		const lines: string[] = [];
		const log = console.log;
		console.log = (s: string) => lines.push(String(s));
		try {
			doctor(f.root);
		} finally {
			console.log = log;
		}
		return lines.filter((l) => /evf audit|audit worktree/.test(l));
	};
	try {
		assert.deepEqual(doctorAudit(), [
			"WARN  no evf audit killed or survived a mutant in the last 31 days; run: bin/evf audit",
		]);
		const id = listIds(f.cli(["--list", "--task", "OPS-901"]).out, "off-by-one")[0]!;
		const r = f.cli(["--task", "OPS-901", "--mutation", id, "--seed", "9"]);
		assert.equal(r.code, 0, r.err);
		const db = f.store();
		const row = db.prepare("SELECT * FROM audit_runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
		assert.equal(row.task_ref, "OPS-901");
		assert.equal(row.merge_commit, f.merges["OPS-901"]);
		assert.equal(row.main_sha, f.git("rev-parse", "origin/main"));
		assert.equal(row.candidate_id, id);
		assert.equal(row.operator, "off-by-one");
		assert.equal(row.file, "packages/calc/src/adult.mjs");
		assert.equal(row.seed, 9);
		assert.equal(row.outcome, "killed");
		assert.deepEqual(JSON.parse(row.tests as string), [
			{ file: "tests/calc/adult.test.mjs", ran: 1, main: "passed", mutant: "failed" },
			{ file: "tests/ui/escaped/old-bug.test.mjs", ran: 1, main: "passed", mutant: "passed" },
		]);
		assert.equal(row.filed_task, null);
		assert.ok(Date.parse(row.started_at as string) <= Date.parse(row.ended_at as string));
		assert.deepEqual(doctorAudit(), []);
		// An invalid or baseline-red run does not count; a killed run 32 days old does not either.
		db.prepare("UPDATE audit_runs SET ended_at = ?").run(new Date(Date.now() - 32 * 86_400_000).toISOString());
		db.close();
		assert.match(f.cli(["--task", "OPS-905", "--seed", "1"]).out, /baseline-red/);
		const store = f.store();
		assert.deepEqual(auditDoctorLines(f.root, store), [
			"no evf audit killed or survived a mutant in the last 31 days; run: bin/evf audit",
		]);
		store.close();
	} finally {
		f.close();
	}
});

test("AC:OPS-116-10 the default run starts no model seat, and the audit waits on machine load like evf verify", () => {
	const f = setup();
	try {
		const bin = join(f.root, "fake-bin/seats"),
			calls = join(f.root, "fake-bin/seat-calls.log");
		mkdirSync(bin);
		for (const name of ["claude", "evf"]) {
			writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n`);
			chmodSync(join(bin, name), 0o755);
		}
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
		const runs = () => {
			const db = f.store();
			const n = (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
			db.close();
			return n;
		};
		const before = runs();
		for (const args of [
			["--task", "OPS-901", "--seed", "2"],
			["--task", "OPS-906", "--seed", "2"],
		]) {
			const r = f.cli(args, env);
			assert.equal(r.code, 0, r.err + r.out);
		}
		const drop = listIds(f.cli(["--list", "--task", "OPS-901"], env).out, "dropped-call")[0]!;
		assert.match(f.cli(["--task", "OPS-901", "--mutation", drop], env).out, /filed OPS-/);
		assert.equal(existsSync(calls), false, "no claude or evf launch call");
		assert.equal(runs(), before);

		f.cfg.machineLoad = { maxPerCore: 0.000001, maxWaitMinutes: 0 };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
		const busy = f.cli(["--task", "OPS-901", "--seed", "2"]);
		assert.equal(busy.code, 1);
		assert.match(busy.err, /The machine stayed above its load limit for 0 min .*--ignore-load/);
		const waits = new DatabaseSync(join(f.root, ".git/evf/work.sqlite"))
			.prepare("SELECT payload FROM events WHERE type = 'load_wait'")
			.all() as Array<{ payload: string }>;
		assert.deepEqual(
			waits.map((w) => JSON.parse(w.payload).task),
			["OPS-901"],
			"evf audit passes its task to the load gate (OPS-133)",
		);
		const forced = f.cli(["--task", "OPS-901", "--seed", "2", "--ignore-load", "fixture override"]);
		assert.equal(forced.code, 0, forced.err);
		const overrides = readFileSync(join(f.root, ".git/evf/load-overrides.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.deepEqual([overrides.at(-1).command, overrides.at(-1).reason], ["audit", "fixture override"]);
	} finally {
		f.close();
	}
});

test("AC:OPS-116-11 local only: no workflow runs evf audit, and the audit makes no model or paid call", () => {
	const workflows = join(source, ".github/workflows");
	for (const file of readdirSync(workflows))
		assert.doesNotMatch(readFileSync(join(workflows, file), "utf8"), /evf audit|evf\s+audit|\baudit\.ts\b/, file);
	const code = readFileSync(join(source, "tools/evf/audit.ts"), "utf8");
	for (const banned of [
		/agent\.act/,
		/agent\.assert/,
		/\bclaude\b/,
		/launch/,
		/\bfetch\(/,
		/https?:\/\//,
		/api\.anthropic/,
		/tester\.army/,
	])
		assert.doesNotMatch(code, banned);
	// The runner leaves the database to the development env file, never a shell value, and NODE_ENV is test.
	assert.match(code, /k\.startsWith\("DATABASE_URL"\)/);
	assert.match(code, /NODE_ENV: "test"/);
});

test("AC:OPS-116-13 evf help lists evf audit", () => {
	const r = spawnSync(process.execPath, [MAIN, "help"], { encoding: "utf8" });
	assert.match(r.stdout, /evf audit \[--task <task>\] \[--mutation <id>\] \[--seed <n>\] \[--dry-run\]/);
	assert.match(r.stdout, /evf audit --list \[--task <task>\]/);
	assert.match(readFileSync(join(source, "tools/evf/README.md"), "utf8"), /## Mutation audit/);
});
