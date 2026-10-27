import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, openWorkDb, syncGoals } from "../db.ts";
import { parseTask } from "../lib.ts";

const SESSION = "33333333-3333-4333-8333-333333333333";
const cli = (cwd: string, env: Record<string, string>, input: unknown, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", HERDR_PANE_ID: "", ...env },
		input: input === undefined ? "" : JSON.stringify(input),
	});

function seatFixture() {
	const f = fixture(),
		task = parseTask("OPS-1"),
		worktree = join(f.root, ".worktrees/ops-1");
	mkdirSync(worktree, { recursive: true });
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const row = ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET ask = ?, spec = ? WHERE id = ?").run(
		"Make the doghouse usable.",
		"Goal: a usable doghouse.\nDone criteria:\n1. The dog fits.\n2. The roof keeps rain out.\nNon-goals: lighting.",
		row.id,
	);
	const run = db
		.prepare(
			"INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at) VALUES (?, 'implement', 'implementer', 'claude-sonnet-5-5', 'medium', 0, ?, 'started', ?)",
		)
		.run(row.id, SESSION, new Date().toISOString()).lastInsertRowid;
	const events = (type?: string) =>
		(db.prepare(`SELECT type, payload FROM events WHERE run_id = ?${type ? " AND type = ?" : ""} ORDER BY id`).all(...(type ? [run, type] : [run])) as Array<{
			type: string;
			payload: string;
		}>);
	const env = { EVF_RUN: String(run), EVF_TASK: "OPS-1", EVF_ROLE: "implementer", EVF_WORKTREE: worktree, EVF_SESSION: SESSION };
	return { ...f, task, worktree, db, taskId: row.id, run: Number(run), events, env };
}

test("OPS-58-launch: a dry run prints the worktree, workspace, agent and store steps and writes nothing", () => {
	const f = seatFixture();
	try {
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "verifier", "--dry-run");
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /# worktree exists: .*\.worktrees\/ops-1/);
		assert.match(out.stdout, /herdr workspace create --cwd \S+ --label ops-1 --env EVF_TASK=OPS-1 --env EVF_RUN=<run> --env EVF_ROLE=verifier --env EVF_STAGE=verify --env EVF_WORKTREE=\S+ --env EVF_SESSION=[0-9a-f-]{36} --env DISABLE_AUTO_UPDATE=true --env CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 --no-focus/);
		assert.match(
			out.stdout,
			/herdr agent start verifier-ops-1 --kind claude --pane <root pane> --timeout 90000 -- --agent verifier --name verifier@OPS-1 --session-id [0-9a-f-]{36} --model claude-opus-5-5 --effort high --permission-mode acceptEdits/,
		);
		assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1, "the dry run inserts no run");
		assert.match(cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "cook", "--dry-run").stderr, /--role must be one of planner, implementer/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-refocus: the goal chain names project, mission, task, stage, ask and spec, ends with the question and stays under 40 lines", () => {
	const f = seatFixture();
	try {
		const out = cli(f.root, {}, undefined, "refocus", "OPS-1");
		assert.equal(out.status, 0, out.stderr);
		const lines = out.stdout.trimEnd().split("\n");
		assert.equal(lines[0], "Goal chain for OPS-1");
		assert.match(lines[1]!, /^Project: Everyfield is an operational workspace/);
		assert.match(out.stdout, /Task: OPS-1 \(new, round 0 of 3\)/);
		assert.match(out.stdout, /Stage: implement \(implementer seat\)/);
		assert.match(out.stdout, /Ask:\nMake the doghouse usable\./);
		assert.match(out.stdout, /2\. The roof keeps rain out\./);
		assert.equal(lines.at(-1), "Is what you are doing now aligned with this? If not, stop and say so.");
		assert.ok(lines.length <= 40, `${lines.length} lines`);
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"), f.taskId);
		const long = cli(f.root, {}, undefined, "refocus", "OPS-1").stdout.trimEnd().split("\n");
		assert.equal(long.length, 40);
		assert.equal(long.at(-1), "Is what you are doing now aligned with this? If not, stop and say so.");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-hooks: session start records the session and injects the chain, also after a compaction; outside a seat the hooks are silent", () => {
	const f = seatFixture();
	try {
		const real = "44444444-4444-4444-8444-444444444444";
		const start = cli(f.root, f.env, { session_id: real, source: "startup", hook_event_name: "SessionStart", cwd: f.worktree }, "hook", "session-start");
		assert.equal(start.status, 0, start.stderr);
		const out = JSON.parse(start.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
		assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
		assert.match(out.hookSpecificOutput.additionalContext, /^You are the implementer seat for OPS-1 \(run \d+, worktree .*ops-1\)\.\nGoal chain for OPS-1/);
		assert.match(out.hookSpecificOutput.additionalContext, /aligned with this\? If not, stop and say so\.$/);
		assert.equal((f.db.prepare("SELECT session_id FROM runs WHERE id = ?").get(f.run) as { session_id: string }).session_id, real);
		assert.deepEqual(f.events().map((e) => e.type), ["session_start", "refocus"]);

		const compact = cli(f.root, f.env, { session_id: real, source: "compact", hook_event_name: "SessionStart" }, "hook", "session-start");
		assert.equal(compact.status, 0, compact.stderr);
		assert.match(compact.stdout, /Goal chain for OPS-1/);
		assert.deepEqual(f.events().map((e) => e.type), ["session_start", "refocus", "compaction", "refocus"]);

		const silent = cli(f.root, {}, { session_id: real, source: "startup" }, "hook", "session-start");
		assert.equal(silent.status, 0, silent.stderr);
		assert.equal(silent.stdout, "");
		assert.equal(f.events().length, 4);
		assert.match(cli(f.root, f.env, {}, "hook", "dance").stderr, /session-start, path-guard, stop or session-end/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-hooks: the path guard denies an edit outside the seat's worktree and allows one inside; stop and session end are recorded", () => {
	const f = seatFixture();
	try {
		const edit = (file_path: string) =>
			cli(f.root, f.env, { tool_name: "Edit", tool_input: { file_path }, cwd: f.worktree, hook_event_name: "PreToolUse" }, "hook", "path-guard");
		const insideAbs = edit(join(f.worktree, "src/new-file.ts"));
		assert.equal(insideAbs.status, 0, insideAbs.stderr);
		assert.equal(insideAbs.stdout, "");
		assert.equal(edit("relative/inside.ts").stdout, "");
		const outside = edit(join(f.root, "evf.config.json"));
		assert.equal(outside.status, 0, outside.stderr);
		const denied = JSON.parse(outside.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
		assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		assert.match(denied.hookSpecificOutput.permissionDecisionReason, /only inside its worktree/);
		assert.equal(edit("../../evf.config.json").status, 0);
		assert.match(edit("../../evf.config.json").stdout, /deny/);
		const unguarded = cli(f.root, { EVF_RUN: f.env.EVF_RUN }, { tool_name: "Edit", tool_input: { file_path: join(f.root, "evf.config.json") } }, "hook", "path-guard");
		assert.equal(unguarded.stdout, "", "no worktree, no guard");

		const stop = cli(f.root, f.env, { session_id: SESSION, stop_hook_active: false }, "hook", "stop");
		assert.equal(stop.status, 0, stop.stderr);
		assert.equal(stop.stdout, "");
		assert.equal(f.events("stop").length, 1);
		const end = cli(f.root, f.env, { session_id: SESSION, reason: "exit" }, "hook", "session-end");
		assert.equal(end.status, 0, end.stderr);
		const run = f.db.prepare("SELECT status, ended_at FROM runs WHERE id = ?").get(f.run) as { status: string; ended_at: string | null };
		assert.equal(run.status, "aborted", "a seat that exits without closing its stage is aborted");
		assert.ok(run.ended_at);
		assert.match(f.events("session_end")[0]!.payload, /"aborted":true/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-session: evf session prints the seat's session id from the environment", () => {
	const f = seatFixture();
	try {
		const out = cli(f.root, { EVF_SESSION: SESSION }, undefined, "session");
		assert.equal(out.status, 0, out.stderr);
		assert.equal(out.stdout.trim(), SESSION);
		assert.match(cli(f.root, {}, undefined, "session").stderr, /No Claude Code session id here/);
	} finally {
		f.db.close();
		f.close();
	}
});
