import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSeatProcess, seatEnv, verdictOf, type Finding, type Planted, type SeatRun } from "../audit-verifier.ts";
import { openWorkDb } from "../db.ts";
import { fixture, source } from "./fixtures.ts";

const MAIN = join(source, "tools/evf/main.ts");
const DAY = 86_400_000;
const SPEC = (ref: string) =>
	`## Goal\n\nFixture goal for ${ref}.\n\n## Done criteria\n\n1. Criterion 1.\n   Check: AC:${ref}-1\n\n## Non-goals\n\n- None.\n`;
const ASK = "Make isAdult true from 18 and make close call onClose.";

const MERGES: Record<string, Record<string, string>> = {
	// Three off-by-one mutants of `age >= 18` that the test catches, and one dropped call it misses.
	"OPS-921": {
		"packages/calc/src/adult.mjs":
			"export function isAdult(age) {\n\treturn age >= 18;\n}\nexport function close(state) {\n\tstate.open = false;\n\tstate.onClose();\n\treturn state;\n}\n",
		"packages/calc/src/greet.mjs": 'export const greet = (name) => "hi " + name;\n',
		"tests/calc/adult.test.mjs":
			'// AC:OPS-921-1 adulthood starts at 18.\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { isAdult, close } from "../../packages/calc/src/adult.mjs";\n\ntest("AC:OPS-921-1 adult from 18", () => {\n\tassert.equal(isAdult(18), true);\n\tassert.equal(isAdult(17), false);\n\tassert.equal(close({ open: true, onClose() {} }).open, false);\n});\n',
	},
	"OPS-925": {
		"packages/calc/src/red.mjs": "export const ten = (n) => n > 10;\n",
		"tests/calc/red.test.mjs":
			'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { ten } from "../../packages/calc/src/red.mjs";\ntest("AC:OPS-925-1 red on main", () => assert.equal(ten(5), true));\n',
	},
	"OPS-926": {
		"packages/web/src/boot.mjs":
			'let ready = false;\nexport function boot() {\n\tready = true;\n}\nboot();\nif (!ready) throw new Error("did not start");\n',
		"tests/ui/web/boot.test.mjs":
			'// AC:OPS-926-1 the preview serves this tree (reads UI_BASE_URL like tests/ui/setup.mjs).\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("AC:OPS-926-1 preview", () => assert.ok(process.env.UI_BASE_URL));\n',
	},
	"OPS-924": {
		"packages/calc/src/slow.mjs": "export const positive = (n) => n > 0;\n",
		"tests/calc/slow.test.mjs":
			'import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\ntest("AC:OPS-924-1 slow", async () => {\n\twriteFileSync(process.env.SLOW_PID_FILE, String(process.pid));\n\tawait new Promise((r) => setTimeout(r, 120000));\n});\n',
	},
	"OPS-928": {
		"packages/calc/src/eight.mjs": "export const eight = (n) => n > 8;\n",
		"tests/calc/eight.test.mjs":
			'// AC:OPS-928-1 in a comment only\nimport { test } from "node:test";\ntest("eight", () => {});\n',
	},
};

/** The stub `claude`: it records what it got, then acts as `mode.json` (next to it) says. */
const STUB = (node: string) => `#!${node}
const fs = require("fs"), path = require("path");
const dir = __dirname, args = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
	const files = {};
	for (const f of fs.readdirSync(".")) files[f] = fs.statSync(f).isFile() ? fs.readFileSync(f, "utf8") : "(directory)";
	fs.appendFileSync(path.join(dir, "seat.log"), JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env, files, pid: process.pid }) + "\\n");
	const mode = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8"));
	const sid = args[args.indexOf("--session-id") + 1];
	if (process.env.CLAUDE_CONFIG_DIR) {
		fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects/p"), { recursive: true });
		fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects/p", sid + ".jsonl"), JSON.stringify({ message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 20 } } }) + "\\n");
	}
	if (mode.kind === "wait") {
		fs.writeFileSync(path.join(dir, "wait.pid"), String(process.pid));
		setInterval(() => {}, 1000);
		return;
	}
	if (mode.kind === "exit") process.exit(mode.code);
	const result = mode.kind === "raw" ? mode.text : JSON.stringify({ findings: mode.findings });
	process.stdout.write(JSON.stringify({ type: "result", is_error: false, result, session_id: sid }) + "\\n");
});
`;

function setup() {
	const f = fixture();
	const write = (files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(f.root, path)), { recursive: true });
			writeFileSync(join(f.root, path), text);
		}
	};
	const bin = join(f.root, "fake-bin");
	mkdirSync(bin, { recursive: true });
	const stack = join(bin, "stack.mjs");
	writeFileSync(
		stack,
		`import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [action] = process.argv.slice(2), tree = process.env.EVF_WORKTREE, runtime = process.env.EVF_RUNTIME_DIR;
if (action === "up") {
	await import(pathToFileURL(join(tree, "packages/web/src/boot.mjs")).href);
	mkdirSync(runtime, { recursive: true });
	writeFileSync(join(runtime, "stack.json"), JSON.stringify({ url: "https://fixture.localhost" }));
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
	write({
		"packages/web/src/boot.mjs": "let ready = false;\nexport function boot() {\n\tready = true;\n}\n",
		"packages/calc/src/unrelated.mjs": "export const one = 1;\n",
	});
	f.git("add", "-A");
	f.git("commit", "-qm", "Fixture app");
	const merges: Record<string, string> = {};
	const now = Date.now();
	Object.entries(MERGES).forEach(([ref, files], i) => {
		write(files);
		f.git("add", "-A");
		process.env.GIT_COMMITTER_DATE = process.env.GIT_AUTHOR_DATE = new Date(now - 10 * DAY + i * 60_000).toISOString();
		f.git("commit", "-qm", `${ref}: fixture merge`);
		delete process.env.GIT_COMMITTER_DATE;
		delete process.env.GIT_AUTHOR_DATE;
		merges[ref] = f.git("rev-parse", "HEAD");
	});
	// Later work on main that no audited merge made: it stays out of change.diff.
	write({ "packages/calc/src/unrelated.mjs": "export const one = 2;\n" });
	f.git("commit", "-qam", "Unrelated later work");
	const remote = f.bare(join(bin, "origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	const store = () => openWorkDb(f.root);
	const db = store();
	const at = new Date().toISOString();
	for (const [ref, sha] of Object.entries(merges))
		db.prepare(
			"INSERT INTO tasks (slug, mode, ref, title, ask, spec, status, merge_commit, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, 'merged', ?, ?, ?)",
		).run(ref.toLowerCase(), ref, ref, ASK, SPEC(ref), sha, at, at);
	db.close();

	const tmp = mkdtempSync(join(tmpdir(), "evf-verifier-tmp-"));
	const cfgDir = join(bin, "claude-config");
	writeFileSync(join(bin, "claude"), STUB(process.execPath));
	chmodSync(join(bin, "claude"), 0o755);
	const mode = (m: Record<string, unknown>) => writeFileSync(join(bin, "mode.json"), JSON.stringify(m));
	mode({ kind: "findings", findings: [] });
	const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		TMPDIR: tmp,
		CLAUDE_CONFIG_DIR: cfgDir,
		// All of these must stop at evf: the seat gets none of them.
		EVF_LEAK_CHECK: "1",
		ANTHROPIC_API_KEY: "key",
		ANTHROPIC_AUTH_TOKEN: "token",
		CLAUDE_CODE_USE_BEDROCK: "1",
		CLAUDE_CODE_USE_VERTEX: "1",
		...extra,
	});
	// Most tests start several seats in one store, which the monthly limit refuses. Moving the recorded results back
	// 31 days lifts it without changing what they say; the limit test turns this off.
	const relax = () => {
		const d = store();
		d.prepare("UPDATE audit_runs SET verifier_ended_at = ? WHERE verifier_result IN ('found', 'missed')").run(
			new Date(Date.now() - 31 * DAY).toISOString(),
		);
		d.close();
	};
	const cli = (args: string[], extra?: NodeJS.ProcessEnv, limit = false) => {
		if (!limit) relax();
		const r = spawnSync(process.execPath, [MAIN, "audit", ...args], { cwd: f.root, env: env(extra), encoding: "utf8" });
		return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
	};
	const calls = (): Array<{
		args: string[];
		stdin: string;
		cwd: string;
		env: Record<string, string>;
		files: Record<string, string>;
		pid: number;
	}> =>
		existsSync(join(bin, "seat.log"))
			? readFileSync(join(bin, "seat.log"), "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l))
			: [];
	const rows = () => {
		const d = store();
		const r = d.prepare("SELECT * FROM audit_runs WHERE dry_run = 0 ORDER BY id").all() as Array<Record<string, any>>;
		d.close();
		return r;
	};
	// A survivor reserves its OPS id as refs/evf/ids/<id> on the remote (OPS-116's filing); no branch or worktree changes.
	const state = () =>
		[
			f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
			spawnSync("git", ["ls-remote", remote], { encoding: "utf8" })
				.stdout.split("\n")
				.filter((l) => !l.includes("refs/evf/ids/"))
				.join("\n"),
			f.git("worktree", "list", "--porcelain"),
		].join("\n---\n");
	const tables = () => {
		const d = store();
		const out = JSON.stringify([
			d.prepare("SELECT * FROM runs ORDER BY id").all(),
			d.prepare("SELECT * FROM tasks ORDER BY id").all(),
		]);
		d.close();
		return out;
	};
	return {
		...f,
		bin,
		tmp,
		cfgDir,
		env,
		cli,
		relax,
		calls,
		rows,
		mode,
		state,
		tables,
		store,
		close: () => {
			rmSync(tmp, { recursive: true, force: true });
			f.close();
		},
	};
}

const candidates = (out: string, op: string) =>
	out
		.split("\n")
		.filter((l) => l.includes(`  ${op}  `))
		.map((l) => {
			const [id, , where, change] = l.split("  ");
			const m = /^(.*):(\d+)$/.exec(where!)!;
			return { id: id!, file: m[1]!, line: Number(m[2]), after: change!.split(" → ")[1]! };
		});
const pick = (f: ReturnType<typeof setup>, task: string, op: string) => {
	const c = candidates(f.cli(["--list", "--task", task]).out, op)[0];
	assert.ok(c, `a ${op} candidate of ${task}`);
	return c;
};
const lastLine = (out: string) => out.trim().split("\n").at(-1);
const withFlag = (task: string, c: { id: string }, ...more: string[]) => [
	"--task",
	task,
	"--mutation",
	c.id,
	"--seed",
	"1",
	"--with-verifier",
	...more,
];
const finding = (c: { file: string; line: number }, line = c.line): Finding => ({
	file: c.file,
	line,
	summary: "wrong",
});
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("AC:OPS-124-1 one seat after killed or survived, none after the other outcomes, none for --dry-run, usage error for --list", async () => {
	const f = setup();
	try {
		const obo = pick(f, "OPS-921", "off-by-one"),
			drop = pick(f, "OPS-921", "dropped-call");

		const killed = f.cli(withFlag("OPS-921", obo));
		assert.equal(killed.code, 0, killed.err + killed.out);
		assert.match(killed.out, /outcome killed/);
		assert.equal(f.calls().length, 1);
		const survived = f.cli(withFlag("OPS-921", drop));
		assert.equal(survived.code, 0, survived.err + survived.out);
		assert.match(survived.out, /outcome survived/);
		assert.equal(f.calls().length, 2);
		for (const call of f.calls()) {
			const session = call.args[call.args.indexOf("--session-id") + 1]!;
			assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			assert.deepEqual(call.args, [
				"-p",
				"--session-id",
				session,
				"--model",
				"claude-opus-5-5",
				"--effort",
				"medium",
				"--tools",
				"Read,Grep,Glob",
				"--allowedTools",
				"Read,Grep,Glob",
				"--output-format",
				"json",
			]);
		}
		assert.notEqual(f.calls()[0]!.args[2], f.calls()[1]!.args[2], "each seat has a new session id");

		// invalid, baseline-red and error start no seat.
		const route = pick(f, "OPS-926", "dropped-call");
		const invalid = f.cli(withFlag("OPS-926", route));
		assert.match(invalid.out, /outcome invalid/);
		assert.equal(lastLine(invalid.out), "tests: invalid, verifier: not run");
		const red = f.cli(["--task", "OPS-925", "--seed", "1", "--with-verifier"]);
		assert.equal(red.code, 1);
		assert.equal(lastLine(red.out), "tests: baseline-red, verifier: not run");
		const error = f.cli(["--task", "OPS-928", "--seed", "1", "--with-verifier"]);
		assert.equal(error.code, 1);
		assert.match(error.err, /has no marked test/);
		assert.equal(lastLine(error.out), "tests: error, verifier: not run");
		assert.deepEqual(
			f.rows().map((r) => r.outcome),
			["killed", "survived", "invalid", "baseline-red", "error"],
		);
		assert.equal(f.calls().length, 2);

		// stopped: SIGTERM while a test runs.
		const pidFile = join(f.bin, "slow.pid");
		f.relax();
		const child = spawn(process.execPath, [MAIN, "audit", "--task", "OPS-924", "--seed", "1", "--with-verifier"], {
			cwd: f.root,
			env: f.env({ SLOW_PID_FILE: pidFile }),
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		for (let i = 0; i < 300 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(existsSync(pidFile), out);
		child.kill("SIGTERM");
		assert.equal(await new Promise((r) => child.on("close", r)), 143, out);
		assert.equal(f.rows().at(-1)!.outcome, "stopped");
		assert.equal(f.calls().length, 2);

		// --dry-run runs the tests, starts no seat and prints what the seat would receive.
		const dry = f.cli(withFlag("OPS-921", obo, "--dry-run"));
		assert.equal(dry.code, 0, dry.err);
		assert.match(dry.out, /outcome killed/);
		assert.match(dry.out, /No verifier seat started/);
		assert.match(dry.out, /--model claude-opus-5-5 --effort medium --tools Read,Grep,Glob/);
		assert.match(dry.out, /change\.diff:/);
		assert.match(dry.out, /task\.md:/);
		assert.equal(lastLine(dry.out), "tests: killed, verifier: dry-run");
		assert.equal(f.calls().length, 2);
		assert.equal(f.rows().at(-1)!.verifier_result, null);

		// --list --with-verifier is a usage error.
		const list = f.cli(["--list", "--with-verifier", "--task", "OPS-921"]);
		assert.equal(list.code, 2);
		assert.match(list.err, /Unknown command: evf audit/);
		assert.equal(f.calls().length, 2);
	} finally {
		f.close();
	}
});

test("AC:OPS-124-2 the seat gets a plain folder of change.diff and task.md that gives nothing away", () => {
	const f = setup();
	try {
		const obo = pick(f, "OPS-921", "off-by-one"),
			drop = pick(f, "OPS-921", "dropped-call");
		for (const c of [obo, drop]) assert.equal(f.cli(withFlag("OPS-921", c)).code, 0);
		const [first, second] = f.calls();
		assert.ok(first && second);
		for (const call of [first, second]) {
			// A neutral folder, not a checkout, holding exactly the two files.
			assert.match(call.cwd, /\/review-[A-Za-z0-9]+$/);
			assert.deepEqual(Object.keys(call.files).sort(), ["change.diff", "task.md"]);
			assert.equal(spawnSync("git", ["-C", call.cwd, "rev-parse"], { encoding: "utf8" }).status === 0, false);
			assert.match(call.files["task.md"]!, /Fixture goal for OPS-921/);
			assert.match(call.files["task.md"]!, new RegExp(ASK));
			// The change, not the hunk: both files the task added, and none of the later unrelated work.
			assert.match(call.files["change.diff"]!, /^diff --git a\/packages\/calc\/src\/adult\.mjs/m);
			assert.match(call.files["change.diff"]!, /^diff --git a\/packages\/calc\/src\/greet\.mjs/m);
			assert.match(call.files["change.diff"]!, /^diff --git a\/tests\/calc\/adult\.test\.mjs/m);
			assert.doesNotMatch(call.files["change.diff"]!, /unrelated\.mjs/);
			const everything = [call.cwd, call.stdin, ...Object.values(call.files), ...Object.entries(call.env).flat()].join(
				"\n",
			);
			for (const banned of [
				obo.id,
				drop.id,
				/off-by-one|dropped-call|removed-route/,
				/audit|mutant|mutation/i,
				/killed|survived/,
			])
				assert.doesNotMatch(everything, typeof banned === "string" ? new RegExp(banned) : banned);
			assert.deepEqual(
				Object.keys(call.env).filter((k) => k.startsWith("EVF_")),
				[],
			);
		}
		assert.ok(first.files["change.diff"]!.includes(`+\t${obo.after}`), "the diff holds the off-by-one line");
		assert.ok(!first.files["change.diff"]!.includes("return age >= 18;"));
		// A dropped call: the diff holds the function with the call gone.
		assert.ok(second.files["change.diff"]!.includes("+\tstate.open = false;\n+\treturn state;"));
		assert.ok(!second.files["change.diff"]!.includes("state.onClose();"));
	} finally {
		f.close();
	}
});

const PLANTED: Planted = { operator: "off-by-one", file: "packages/a/src/x.ts", line: 40 };
const seat = (over: Partial<SeatRun> & { findings?: unknown; result?: string }): SeatRun => ({
	code: 0,
	out: JSON.stringify({
		type: "result",
		is_error: false,
		result: over.result ?? JSON.stringify({ findings: over.findings ?? [] }),
	}),
	...over,
});

test("AC:OPS-124-3 grading: found within 3 lines, missed outside, and no-verdict never becomes missed", async () => {
	const at = (file: string, line: number): Finding => ({ file, line, summary: "s" });
	const grade = (planted: Planted, findings: Finding[]) => verdictOf(planted, seat({ findings })).result;
	// Both edges of the window.
	for (const [line, expected] of [
		[37, "found"],
		[43, "found"],
		[36, "missed"],
		[44, "missed"],
		[40, "found"],
	] as const)
		assert.equal(verdictOf(PLANTED, seat({ findings: [at(PLANTED.file, line)] })).result, expected, String(line));
	assert.equal(verdictOf(PLANTED, seat({ findings: [at("packages/a/src/y.ts", 40)] })).result, "missed");
	assert.equal(verdictOf(PLANTED, seat({ findings: [] })).result, "missed");
	// Paths as a diff or an absolute path writes them.
	for (const file of [`b/${PLANTED.file}`, `./${PLANTED.file}`, `/work/review/${PLANTED.file}`])
		assert.equal(grade(PLANTED, [at(file, 41)]), "found", file);
	assert.equal(grade(PLANTED, [at(`other/${PLANTED.file}x`, 41)]), "missed");
	// A removed route: the file alone.
	const route: Planted = { operator: "removed-route", file: "apps/web/src/app/x/page.tsx", line: 1 };
	assert.equal(grade(route, [at(route.file, 900)]), "found");
	assert.equal(grade(route, [at("apps/web/src/app/y/page.tsx", 1)]), "missed");
	// Fenced JSON and findings inside prose parse.
	const json = JSON.stringify({ findings: [at(PLANTED.file, 40)] });
	for (const result of ["```json\n" + json + "\n```", `Here you go: ${json} done.`])
		assert.equal(verdictOf(PLANTED, seat({ result })).result, "found", result);

	// No verdict: output that does not parse, a bad finding, an error result, a non-zero exit, a signal.
	for (const bad of [
		seat({ out: "" }),
		seat({ out: "not json" }),
		seat({ result: JSON.stringify([at(PLANTED.file, 40)]) }),
		seat({ result: "I found nothing wrong." }),
		seat({ result: JSON.stringify({ findings: [{ file: PLANTED.file, line: "40", summary: "s" }] }) }),
		seat({ result: JSON.stringify({ findings: [{ file: PLANTED.file, line: 40 }] }) }),
		seat({ result: JSON.stringify({ other: [] }) }),
		seat({ out: JSON.stringify({ type: "result", is_error: true, result: JSON.stringify({ findings: [] }) }) }),
		seat({ code: 1 }),
		seat({ code: null }),
	])
		assert.equal(verdictOf(PLANTED, bad).result, "no-verdict", JSON.stringify(bad).slice(0, 80));

	// The process runner: a missing claude and a timeout, with a stub that waits.
	const dir = mkdtempSync(join(tmpdir(), "evf-seat-"));
	try {
		const none = await runSeatProcess(dir, "s", { PATH: join(dir, "nothing") }, new Set(), 5000);
		assert.equal(none.code, null);
		assert.equal(verdictOf(PLANTED, none).result, "no-verdict");
		writeFileSync(join(dir, "mode.json"), JSON.stringify({ kind: "wait" }));
		writeFileSync(join(dir, "claude"), STUB(process.execPath));
		chmodSync(join(dir, "claude"), 0o755);
		const slow = await runSeatProcess(dir, "s", { PATH: `${dir}:${process.env.PATH}` }, new Set(), 800);
		assert.equal(slow.code, null);
		assert.equal(verdictOf(PLANTED, slow).result, "no-verdict");
		assert.equal(alive(Number(readFileSync(join(dir, "wait.pid"), "utf8"))), false, "the timeout stopped the seat");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("AC:OPS-124-4 the row holds the verifier result next to the test outcome; the last line says both", () => {
	const f = setup();
	try {
		const obo = pick(f, "OPS-921", "off-by-one"),
			drop = pick(f, "OPS-921", "dropped-call");
		// The ask a survived run files without the flag.
		const dry = f.cli(["--task", "OPS-921", "--mutation", drop.id, "--seed", "1", "--dry-run"]);
		const wanted = dry.out.split("The ask it would file:\n\n")[1]!;

		// found: killed, a finding within 3 lines of the mutated line.
		f.mode({ kind: "findings", findings: [finding(obo, obo.line + 3)] });
		const found = f.cli(withFlag("OPS-921", obo));
		assert.equal(found.code, 0, found.err);
		assert.equal(lastLine(found.out), "tests: killed, verifier: found");
		// missed: killed, a finding 4 lines away.
		f.mode({ kind: "findings", findings: [finding(obo, obo.line + 4)] });
		const missed = f.cli(withFlag("OPS-921", obo));
		assert.equal(missed.code, 0, missed.err);
		assert.equal(lastLine(missed.out), "tests: killed, verifier: missed");
		// no-verdict on survived: the seat exits 1. The outcome, the filed task and the exit code stay.
		f.mode({ kind: "exit", code: 1 });
		const none = f.cli(withFlag("OPS-921", drop));
		assert.equal(none.code, 0, none.err);
		assert.equal(lastLine(none.out), "tests: survived, verifier: no-verdict");

		const [a, b, c] = f.rows();
		assert.deepEqual([a!.outcome, a!.verifier_result], ["killed", "found"]);
		assert.deepEqual([b!.outcome, b!.verifier_result], ["killed", "missed"]);
		assert.deepEqual([c!.outcome, c!.verifier_result], ["survived", "no-verdict"]);
		assert.deepEqual(JSON.parse(a!.verifier_findings), [finding(obo, obo.line + 3)]);
		assert.equal(c!.verifier_findings, null);
		for (const r of [a!, b!, c!]) {
			assert.match(r.verifier_session, /^[0-9a-f-]{36}$/);
			assert.ok(r.verifier_ended_at);
		}
		assert.deepEqual(JSON.parse(a!.verifier_usage), {
			"claude-opus-5-5": { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
		});
		assert.equal(a!.verifier_session, f.calls()[0]!.args[2]);
		// The filed ask is byte for byte what the run files without the flag.
		assert.match(c!.filed_task, /^OPS-\d+$/);
		const db = f.store();
		const ask = (db.prepare("SELECT ask FROM tasks WHERE ref = ?").get(c!.filed_task) as { ask: string }).ask;
		db.close();
		assert.equal(ask.trimEnd(), wanted.trimEnd());
		// A run without the flag leaves the verifier columns null.
		const plain = f.cli(["--task", "OPS-921", "--mutation", obo.id, "--seed", "1"]);
		assert.equal(plain.code, 0, plain.err);
		assert.doesNotMatch(plain.out, /^tests: /m);
		const last = f.rows().at(-1)!;
		for (const k of ["verifier_result", "verifier_session", "verifier_findings", "verifier_usage", "verifier_ended_at"])
			assert.equal(last[k], null, k);
		assert.equal(f.calls().length, 3);
	} finally {
		f.close();
	}
});

test("AC:OPS-124-5 nothing stays behind or leaks: a finished run and a stopped seat leave refs, worktrees and gates as they were", async () => {
	const f = setup();
	try {
		const obo = pick(f, "OPS-921", "off-by-one"),
			drop = pick(f, "OPS-921", "dropped-call");
		const before = f.state(),
			gates = f.tables();

		f.mode({ kind: "findings", findings: [finding(obo)] });
		const done = f.cli(withFlag("OPS-921", obo));
		assert.equal(done.code, 0, done.err);
		assert.equal(f.state(), before);
		assert.deepEqual(readdirSync(f.tmp), [], "the review folder and the audit worktree are gone");
		assert.equal(f.tables(), gates, "no runs row, and the audited task's row is unchanged");

		// A stopped run: the seat waits, evf gets SIGTERM.
		f.mode({ kind: "wait" });
		f.relax();
		const child = spawn(process.execPath, [MAIN, "audit", ...withFlag("OPS-921", drop)], { cwd: f.root, env: f.env() });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const pidFile = join(f.bin, "wait.pid");
		for (let i = 0; i < 300 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
		assert.ok(existsSync(pidFile), out);
		// While the seat runs, the test outcome and the filed task are written, and only the review folder exists.
		const mid = f.rows().at(-1)!;
		assert.equal(mid.outcome, "survived");
		assert.match(mid.filed_task, /^OPS-\d+$/);
		assert.equal(mid.verifier_result, null);
		assert.equal(readdirSync(f.tmp).filter((n) => n.startsWith("evf-audit-")).length, 0, "the audit worktree is gone");
		assert.equal(readdirSync(f.tmp).filter((n) => n.startsWith("review-")).length, 1);
		child.kill("SIGTERM");
		const code = await new Promise((r) => child.on("close", r));
		assert.equal(code, 143, out);
		const seatPid = Number(readFileSync(pidFile, "utf8"));
		for (let i = 0; i < 50 && alive(seatPid); i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(alive(seatPid), false, "the stop reached the seat");
		assert.deepEqual(readdirSync(f.tmp), []);
		const row = f.rows().at(-1)!;
		assert.deepEqual([row.outcome, row.verifier_result], ["survived", "no-verdict"]);
		assert.ok(row.verifier_ended_at);
		assert.equal(f.state(), before);
		assert.equal(existsSync(join(f.root, ".git/evf/audit/active.json")), false);
		// The one change to the work store is the task the survivor filed.
		const db = f.store();
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 0);
		db.close();
	} finally {
		f.close();
	}
});

test("AC:OPS-124-6 one found or missed result in 30 days; no-verdict does not count; the seat's env has no paid-API switch", () => {
	const f = setup();
	try {
		const obo = pick(f, "OPS-921", "off-by-one");
		const insert = (result: string | null, endedMsAgo: number) => {
			const db = f.store();
			const ended = new Date(Date.now() - endedMsAgo).toISOString();
			db.prepare(
				`INSERT INTO audit_runs (task_ref, merge_commit, main_sha, candidate_id, operator, file, line, seed, started_at, ended_at, outcome, verifier_result, verifier_ended_at)
				 VALUES ('OPS-921', 'a', 'b', 'c', 'off-by-one', 'f', 1, 1, ?, ?, 'killed', ?, ?)`,
			).run(ended, ended, result, result ? ended : null);
			db.close();
			return ended;
		};
		// A no-verdict run does not count.
		insert("no-verdict", 1000);
		// found 29 days 23 hours ago: refused before any test runs; the message names both dates.
		const ended = insert("found", 29 * DAY + 23 * 3_600_000);
		const refused = f.cli(withFlag("OPS-921", obo), undefined, true);
		assert.equal(refused.code, 1);
		assert.ok(refused.err.includes(ended), refused.err);
		assert.ok(refused.err.includes(new Date(Date.parse(ended) + 30 * DAY).toISOString()), refused.err);
		assert.match(refused.err, /needs a new approval from Sebastian/);
		assert.doesNotMatch(refused.out, /baseline|planted/);
		assert.equal(f.calls().length, 0);
		assert.equal(f.rows().length, 2, "a refusal records no row");
		// A dry run starts no seat, so it is not refused.
		assert.equal(f.cli(withFlag("OPS-921", obo, "--dry-run"), undefined, true).code, 0);
		// missed counts too, and the plain run is never refused.
		const db = f.store();
		db.prepare("UPDATE audit_runs SET verifier_result = 'missed' WHERE verifier_result = 'found'").run();
		db.close();
		assert.equal(f.cli(withFlag("OPS-921", obo), undefined, true).code, 1);
		assert.equal(f.cli(["--task", "OPS-921", "--mutation", obo.id, "--seed", "1"], undefined, true).code, 0);
		// The edge: 30 days and a minute ago no longer counts.
		const old = f.store();
		old.prepare("DELETE FROM audit_runs WHERE verifier_result = 'missed'").run();
		old.close();
		insert("found", 30 * DAY + 60_000);
		const open = f.cli(withFlag("OPS-921", obo), undefined, true);
		assert.equal(open.code, 0, open.err);
		assert.equal(lastLine(open.out), "tests: killed, verifier: missed");
		// Now the month is used: the run just recorded counts.
		assert.equal(f.cli(withFlag("OPS-921", obo), undefined, true).code, 1);

		// The seat's env: no API key, no cloud switch, no EVF variable.
		const env = f.calls()[0]!.env;
		for (const k of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"EVF_LEAK_CHECK",
		])
			assert.equal(env[k], undefined, k);
		assert.equal(env.CLAUDE_CONFIG_DIR, f.cfgDir);
		assert.deepEqual(
			Object.keys(
				seatEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", EVF_RUN: "1", NODE_OPTIONS: "x", LC_ALL: "C" }),
			).sort(),
			["HOME", "LC_ALL", "PATH"],
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-124-7 help lists the flag, the README documents it, and no workflow mentions it", () => {
	const help = spawnSync(process.execPath, [MAIN, "help"], { encoding: "utf8" }).stdout;
	assert.match(help, /evf audit \[--task <task>\].*\[--dry-run\] \[--with-verifier\]/);
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8");
	const section = readme.split("## Mutation audit")[1]!.split(/\n## /)[0]!;
	for (const word of [
		"--with-verifier",
		"change.diff",
		"task.md",
		"found",
		"missed",
		"no-verdict",
		"30 days",
		"claude-opus-5-5",
		"ANTHROPIC_API_KEY",
	])
		assert.ok(section.includes(word), word);
	assert.doesNotMatch(readme, /waits for Sebastian's answer to report decision D\.2/);
	const workflows = join(source, ".github/workflows");
	for (const file of readdirSync(workflows))
		assert.doesNotMatch(readFileSync(join(workflows, file), "utf8"), /with-verifier|audit-verifier/, file);
	const base = spawnSync("git", ["merge-base", "origin/main", "HEAD"], { cwd: source, encoding: "utf8" });
	if (base.status === 0) {
		const changed = spawnSync("git", ["diff", "--name-only", base.stdout.trim(), "HEAD", "--", ".github"], {
			cwd: source,
			encoding: "utf8",
		});
		assert.equal(changed.stdout.trim(), "", "no file under .github/ changes");
	}
});
