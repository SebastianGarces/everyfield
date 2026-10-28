import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** A Herdr on the fixture's PATH that records its calls and fails where herdr-state.json says so. */
function fakeHerdr(root: string) {
	const calls = join(root, "herdr-calls.json"),
		state = join(root, "herdr-state.json");
	writeFileSync(calls, "[]");
	writeFileSync(state, "{}");
	writeFileSync(
		join(root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			`const st=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));const die=m=>{process.stderr.write(m);process.exit(1)};\n` +
			`let r={};if(a[0]==="workspace"&&a[1]==="create"){if(st.createFails)die("fixture: no herdr server");r={workspace:{workspace_id:"w9"},tab:"w9:t1",root_pane:{pane_id:"w9:p1"}};}\n` +
			`else if(a[0]==="agent"&&a[1]==="start"){if(st.startFails)die("fixture: agent did not become idle");r={agent:{name:a[2]}};}\n` +
			`else if(a[0]==="pane"&&a[1]==="read")process.stdout.write(st.screen||"");\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:"idle"}};\n` +
			`if(a[0]!=="pane")process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(root, "fake-bin/herdr"), 0o755);
	return {
		calls: () => JSON.parse(readFileSync(calls, "utf8")) as string[][],
		setState: (s: object) => writeFileSync(state, JSON.stringify(s)),
	};
}

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
		db
			.prepare(`SELECT type, payload FROM events WHERE run_id = ?${type ? " AND type = ?" : ""} ORDER BY id`)
			.all(...(type ? [run, type] : [run])) as Array<{
			type: string;
			payload: string;
		}>;
	const env = {
		EVF_RUN: String(run),
		EVF_TASK: "OPS-1",
		EVF_ROLE: "implementer",
		EVF_WORKTREE: worktree,
		EVF_SESSION: SESSION,
	};
	const runs = () =>
		db
			.prepare(
				"SELECT id, stage, role, status, session_id, herdr_agent, herdr_pane, summary FROM runs WHERE task_id = ? ORDER BY id",
			)
			.all(row.id) as Array<Record<string, unknown>>;
	return { ...f, task, worktree, db, taskId: row.id, run: Number(run), events, runs, env, herdr: fakeHerdr(f.root) };
}

test("OPS-58-launch: a dry run prints the worktree, workspace, agent and store steps and writes nothing", () => {
	const f = seatFixture();
	try {
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "verifier", "--dry-run");
		assert.equal(out.status, 0, out.stderr);
		assert.match(out.stdout, /# worktree exists: .*\.worktrees\/ops-1/);
		assert.match(
			out.stdout,
			/herdr workspace create --cwd \S+ --label ops-1 --env EVF_TASK=OPS-1 --env 'EVF_RUN=<run>' --env EVF_ROLE=verifier --env EVF_STAGE=verify --env EVF_WORKTREE=\S+ --env EVF_RUNTIME=\S+ --env EVF_SESSION=[0-9a-f-]{36} --env DISABLE_AUTO_UPDATE=true --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 --no-focus/,
		);
		assert.match(
			out.stdout,
			/herdr agent start 'verifier-ops-1-<run>' --kind claude --pane '<root pane>' --timeout 90000 -- --agent verifier --name verifier@OPS-1 --session-id [0-9a-f-]{36} --model claude-opus-5-5 --effort high --permission-mode acceptEdits/,
		);
		assert.equal(
			(f.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
			1,
			"the dry run inserts no run",
		);
		assert.match(
			cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "cook", "--dry-run").stderr,
			/--role must be one of planner, implementer/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-launch: a real launch records the run, passes EVF_RUN to the workspace and starts the agent; the trust dialog is answered once", () => {
	const f = seatFixture();
	try {
		writeFileSync(join(f.root, "prompt.txt"), "Begin.\n");
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer", "--prompt-file", "prompt.txt");
		assert.equal(out.status, 0, out.stderr);
		const printed = JSON.parse(out.stdout) as Record<string, unknown>;
		const run = f.runs().at(-1)!;
		assert.equal(printed.run, run.id);
		assert.equal(printed.workspace, "w9");
		assert.deepEqual(
			[run.stage, run.role, run.status, run.herdr_agent, run.herdr_pane],
			["implement", "implementer", "started", `implementer-ops-1-${run.id}`, "w9:p1"],
			"the Herdr agent name carries the run id, so a later round never collides with this seat",
		);
		assert.match(String(run.session_id), /^[0-9a-f-]{36}$/);
		const calls = f.herdr.calls();
		const create = calls.find((c) => c[0] === "workspace")!,
			start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
		assert.ok(create.includes(`EVF_RUN=${run.id}`), "the seat's environment names its run");
		assert.ok(create.some((arg) => /^EVF_WORKTREE=.*\.worktrees\/ops-1$/.test(arg)));
		assert.deepEqual(start.slice(2, 7), [`implementer-ops-1-${run.id}`, "--kind", "claude", "--pane", "w9:p1"]);
		assert.ok(start.includes(String(run.session_id)), "Claude Code starts with the session id evf chose");
		assert.deepEqual(calls.at(-1), ["agent", "prompt", `implementer-ops-1-${run.id}`, "Begin."]);
		const task = f.db.prepare("SELECT status, herdr_workspace_id FROM tasks WHERE id = ?").get(f.taskId) as Record<
			string,
			unknown
		>;
		assert.deepEqual([task.status, task.herdr_workspace_id], ["active", "w9"]);
		const events = f.db
			.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY id")
			.all(run.id)
			.map((e) => (e as { type: string }).type);
		assert.deepEqual(events, ["stage_start", "prompt_sent"]);

		// A fresh worktree may sit at Claude Code's folder-trust dialog: evf accepts it and the seat reaches idle alone.
		f.herdr.setState({ startFails: true, screen: "Do you trust the files in this folder?\n> Yes, proceed" });
		const trusted = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "verifier");
		assert.equal(trusted.status, 0, trusted.stderr);
		const after = f.herdr.calls().slice(calls.length);
		assert.deepEqual(
			after.filter((c) => c[0] === "pane" || c[1] === "wait" || c[1] === "rename").map((c) => c.slice(0, 3)),
			[
				["pane", "read", "w9:p1"],
				["pane", "send-keys", "w9:p1"],
				["agent", "wait", "w9:p1"],
				["agent", "rename", "w9:p1"],
			],
		);
		const trustedRun = f.runs().at(-1)!;
		assert.deepEqual([trustedRun.status, trustedRun.herdr_agent], ["started", `verifier-ops-1-${trustedRun.id}`]);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-launch: every Herdr failure before the agent is up aborts the run, so the store never lists a seat that does not exist", () => {
	const f = seatFixture();
	try {
		const launch = (env: Record<string, string> = {}) =>
			cli(f.root, env, undefined, "launch", "OPS-1", "--role", "implementer");
		const last = () => f.runs().at(-1)!;
		f.herdr.setState({ startFails: true, screen: "claude: command not found" });
		const noStart = launch();
		assert.equal(noStart.status, 1);
		assert.match(
			noStart.stderr,
			/herdr agent start failed in workspace w9 pane w9:p1: fixture: agent did not become idle/,
		);
		assert.equal(last().status, "aborted");
		assert.match(String(last().summary), /^launch failed: herdr agent start failed/);

		f.herdr.setState({ createFails: true });
		const noWorkspace = launch();
		assert.equal(noWorkspace.status, 1);
		assert.match(noWorkspace.stderr, /herdr workspace create failed: fixture: no herdr server/);
		assert.equal(last().status, "aborted");
		assert.match(String(last().summary), /^launch failed: herdr workspace create failed/);
		assert.ok(!f.herdr.calls().slice(-1)[0]!.includes("start"), "no agent start without a workspace");

		// git stays reachable; herdr is not on this PATH (evf never finds it under /usr/bin).
		const noHerdr = launch({ PATH: "/usr/bin:/bin" });
		assert.equal(noHerdr.status, 1);
		assert.match(noHerdr.stderr, /herdr workspace create failed: spawnSync herdr ENOENT/);
		assert.equal(last().status, "aborted");
		assert.equal(f.runs().filter((r) => r.status === "started").length, 1, "only the fixture's own run is live");
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
		f.db
			.prepare("UPDATE tasks SET spec = ? WHERE id = ?")
			.run(Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"), f.taskId);
		const long = cli(f.root, {}, undefined, "refocus", "OPS-1").stdout.trimEnd().split("\n");
		assert.ok(long.length <= 40, `${long.length} lines`);
		assert.ok(long.includes("line 20") && !long.includes("line 21"), "the spec is cut at 20 lines");
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
		const start = cli(
			f.root,
			f.env,
			{ session_id: real, source: "startup", hook_event_name: "SessionStart", cwd: f.worktree },
			"hook",
			"session-start",
		);
		assert.equal(start.status, 0, start.stderr);
		const out = JSON.parse(start.stdout) as {
			hookSpecificOutput: { hookEventName: string; additionalContext: string };
		};
		assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
		assert.match(
			out.hookSpecificOutput.additionalContext,
			/^You are the implementer seat for OPS-1 \(run \d+, worktree .*ops-1\)\.\nGoal chain for OPS-1/,
		);
		assert.match(out.hookSpecificOutput.additionalContext, /aligned with this\? If not, stop and say so\.$/);
		assert.equal(
			(f.db.prepare("SELECT session_id FROM runs WHERE id = ?").get(f.run) as { session_id: string }).session_id,
			real,
		);
		assert.deepEqual(
			f.events().map((e) => e.type),
			["session_start", "refocus"],
		);

		const compact = cli(
			f.root,
			f.env,
			{ session_id: real, source: "compact", hook_event_name: "SessionStart" },
			"hook",
			"session-start",
		);
		assert.equal(compact.status, 0, compact.stderr);
		assert.match(compact.stdout, /Goal chain for OPS-1/);
		assert.deepEqual(
			f.events().map((e) => e.type),
			["session_start", "refocus", "compaction", "refocus"],
		);

		const silent = cli(f.root, {}, { session_id: real, source: "startup" }, "hook", "session-start");
		assert.equal(silent.status, 0, silent.stderr);
		assert.equal(silent.stdout, "");
		assert.equal(f.events().length, 4);
		assert.match(
			cli(f.root, f.env, {}, "hook", "dance").stderr,
			/session-start, path-guard, read-guard, stop or session-end/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-58-hooks: the path guard denies an edit outside the seat's worktree and allows one inside; stop and session end are recorded", () => {
	const f = seatFixture();
	try {
		const edit = (file_path: string) =>
			cli(
				f.root,
				f.env,
				{ tool_name: "Edit", tool_input: { file_path }, cwd: f.worktree, hook_event_name: "PreToolUse" },
				"hook",
				"path-guard",
			);
		const insideAbs = edit(join(f.worktree, "src/new-file.ts"));
		assert.equal(insideAbs.status, 0, insideAbs.stderr);
		assert.equal(insideAbs.stdout, "");
		assert.equal(edit("relative/inside.ts").stdout, "");
		const outside = edit(join(f.root, "evf.config.json"));
		assert.equal(outside.status, 0, outside.stderr);
		const denied = JSON.parse(outside.stdout) as {
			hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
		};
		assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
		assert.match(denied.hookSpecificOutput.permissionDecisionReason, /only inside its worktree/);
		const relativeOut = edit("../../evf.config.json");
		assert.equal(relativeOut.status, 0, relativeOut.stderr);
		assert.match(relativeOut.stdout, /deny/);
		symlinkSync(join(f.root, "outside/not-yet.ts"), join(f.worktree, "dangling-link"));
		assert.match(edit(join(f.worktree, "dangling-link")).stdout, /deny/, "a dangling symlink resolves to its target");
		mkdirSync(join(f.worktree, "src"), { recursive: true });
		symlinkSync(join(f.root, "evf.config.json"), join(f.worktree, "src/config-link"));
		assert.match(edit("src/config-link").stdout, /deny/, "a symlink to an existing file outside is denied");
		const home = edit("~/evf-seat-guard-probe.ts");
		assert.match(home.stdout, /deny/, "~ is the home directory, not a folder in the worktree");
		assert.match(
			home.stdout,
			new RegExp(join(homedir(), "evf-seat-guard-probe.ts").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		const unguarded = cli(
			f.root,
			{ EVF_RUN: f.env.EVF_RUN },
			{ tool_name: "Edit", tool_input: { file_path: join(f.root, "evf.config.json") } },
			"hook",
			"path-guard",
		);
		assert.equal(unguarded.stdout, "", "no worktree, no guard");

		const stop = cli(
			f.root,
			{ ...f.env, EVF_STAGE: "implement" },
			{ session_id: SESSION, stop_hook_active: false },
			"hook",
			"stop",
		);
		assert.equal(stop.status, 0, stop.stderr);
		assert.match(JSON.parse(stop.stdout).reason, /still open\. Close it now: bin\/evf run done \d+/);
		assert.equal(JSON.parse(stop.stdout).decision, "block");
		const again = cli(
			f.root,
			{ ...f.env, EVF_STAGE: "implement" },
			{ session_id: SESSION, stop_hook_active: true },
			"hook",
			"stop",
		);
		assert.equal(again.stdout, "", "the block is not repeated while Claude Code is already continuing");
		assert.equal(f.events("stop").length, 2);
		const status = () =>
			f.db.prepare("SELECT status, ended_at, session_id FROM runs WHERE id = ?").get(f.run) as {
				status: string;
				ended_at: string | null;
				session_id: string;
			};
		for (const reason of ["clear", "resume"]) {
			const kept = cli(f.root, f.env, { session_id: SESSION, reason }, "hook", "session-end");
			assert.equal(kept.status, 0, kept.stderr);
			assert.equal(status().status, "started", `${reason} keeps the seat's run open`);
			assert.match(f.events("session_end").at(-1)!.payload, /"aborted":false/);
		}
		const next = "55555555-5555-4555-8555-555555555555";
		cli(f.root, f.env, { session_id: next, source: "clear" }, "hook", "session-start");
		assert.equal(status().session_id, next, "the session after /clear is recorded on the same run");
		const end = cli(f.root, f.env, { session_id: next, reason: "exit" }, "hook", "session-end");
		assert.equal(end.status, 0, end.stderr);
		assert.equal(status().status, "aborted", "a seat that exits without closing its stage is aborted");
		assert.ok(status().ended_at);
		assert.match(f.events("session_end").at(-1)!.payload, /"aborted":true/);
		const closed = cli(
			f.root,
			{ ...f.env, EVF_STAGE: "implement" },
			{ session_id: next, stop_hook_active: false },
			"hook",
			"stop",
		);
		assert.equal(closed.stdout, "", "a closed stage never blocks a stop");
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
