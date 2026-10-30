import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assistantLine, fixture, sessionStartJs, source, writeTranscript } from "./fixtures.ts";
import { ensureTask, openWorkDb, syncGoals, workDbPath } from "../db.ts";
import { EvfError, parseTask } from "../lib.ts";
import { guardTypedLine, launch, launchPlan, LaunchLineTooLong, typedLineBytes } from "../launch.ts";
import { ROLES } from "../seats.ts";

const SESSION = "33333333-3333-4333-8333-333333333333";
const cli = (cwd: string, env: Record<string, string>, input: unknown, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", HERDR_PANE_ID: "", ...env },
		input: input === undefined ? "" : JSON.stringify(input),
	});

/**
 * A Herdr on the fixture's PATH that records its calls and fails where herdr-state.json says so. With `tui` set, an
 * "evf TUI" workspace w1 exists whose pane w1:p1 runs the evf-tui process, and `layout` answers `pane layout`.
 */
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
			`const save=()=>fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(st));const flag=(a,n)=>a[a.indexOf(n)+1];\n` +
			sessionStartJs(workDbPath(root)) +
			`const tuiPane=st.tuiPane||"w1:p1";const allPanes=()=>[...(st.tui?[tuiPane]:[]),...(st.panes||[])];\n` +
			`let r={};if(a[0]==="workspace"&&a[1]==="create"){if(st.createFails)die("fixture: no herdr server");r={workspace:{workspace_id:"w9"},tab:"w9:t1",root_pane:{pane_id:"w9:p1"}};}\n` +
			`else if(a[0]==="workspace"&&a[1]==="list")r={workspaces:st.tui?[{label:st.tuiLabel||"evf TUI",workspace_id:"w1"}]:[]};\n` +
			`else if(a[0]==="workspace"&&a[1]==="close")r={type:"ok"};\n` +
			`else if(a[0]==="agent"&&a[1]==="start"){const dd=a.indexOf("--");const typed=["claude",...a.slice(dd+1)].map(x=>/^[\\w./:=@-]+$/.test(x)?x:"'"+x.replace(/'/g,"'\\\\''")+"'").join(" ");const tb=Buffer.byteLength(typed);st.typedLines=[...(st.typedLines||[]),tb];save();if(tb>=1024)die(JSON.stringify({error:{code:"agent_start_input_failed",message:"input contains a "+tb+"-byte line but the terminal is in canonical mode with a 1024-byte limit; wait for the shell prompt and retry"}}));if(st.inputFailStarts>0){st.inputFailStarts--;save();die(JSON.stringify({error:{code:"agent_start_input_failed",message:"input contains a 900-byte line but the terminal is in canonical mode with a 1024-byte limit; wait for the shell prompt and retry"}}))}if(st.startFails)die("fixture: agent did not become idle");if(st.failStarts>0){st.failStarts--;save();die("fixture: agent did not become idle")}if(st.busyStarts>0){st.busyStarts--;save();die(JSON.stringify({error:{code:"agent_pane_busy",message:"agent target pane w9:p1 is not an available shell"}}))}st.agents=[...(st.agents||[]),{name:a[2],pane_id:a[5]}];save();r={agent:{name:a[2]}};}\n` +
			`else if(a[0]==="agent"&&a[1]==="list")r={agents:st.agents||[]};\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_status:st.agentStatus||"working"}};\n` +
			`else if(a[0]==="pane"&&a[1]==="read")process.stdout.write(st.screen||"");\n` +
			`else if(a[0]==="pane"&&a[1]==="process-info"){const busy=st.notReady===true||st.notReady>0;if(typeof st.notReady==="number"&&st.notReady>0){st.notReady--;save()}const rc=st.rcLoading>0;if(rc){st.rcLoading--;save()}r={process_info:{shell_pid:7,foreground_process_group_id:busy?99:7,foreground_processes:rc?[{pid:7},{pid:8,cmdline:"brew shellenv"}]:flag(a,"--pane")===tuiPane&&st.tui?[{cmdline:"/x/.git/evf/bin/evf-tui --db /x/work.sqlite"}]:[]}};}\n` +
			`else if(a[0]==="pane"&&a[1]==="list")r={panes:allPanes().map(p=>({pane_id:p,workspace_id:p.split(":")[0],tab_id:p.split(":")[0]+":t1"}))};\n` +
			`else if(a[0]==="pane"&&a[1]==="layout")r={layout:st.layout||{panes:[{pane_id:tuiPane,rect:{x:0,y:0,width:512,height:72}}],splits:[]}};\n` +
			`else if(a[0]==="pane"&&a[1]==="split"){if(st.splitFails)die("fixture: split failed");r={pane:{pane_id:st.splitPane||"w1:p2"}};}\n` +
			`else if(a[0]==="pane"&&a[1]==="get"){const p=a[2];if((st.gone||[]).includes(p))die("pane not found");r={pane:{pane_id:p,workspace_id:p.split(":")[0]}};}\n` +
			`else if(a[0]==="pane"&&a[1]==="close"){if(st.watchDb){const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(st.watchDb,{readOnly:true});st.closeSaw=[...(st.closeSaw||[]),d.prepare("SELECT status FROM runs WHERE herdr_pane = ?").all(a[2]).map(x=>x.status)];d.close();save()}r={type:"ok"};}\n` +
			`else if(a[0]==="pane"&&a[1]==="resize")r={type:"ok"};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:"idle"}};\n` +
			`if(!(a[0]==="pane"&&a[1]==="read"))process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(root, "fake-bin/herdr"), 0o755);
	return {
		calls: () => JSON.parse(readFileSync(calls, "utf8")) as string[][],
		setState: (s: object) => writeFileSync(state, JSON.stringify(s)),
		state: () => JSON.parse(readFileSync(state, "utf8")) as Record<string, any>,
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
			/herdr agent start 'verifier-ops-1-<run>' --kind claude --pane '<root pane>' --timeout 90000 -- --plugin-dir '\S+\/runtime\/ops-1\/seat-<run>' --agent evf:verifier --name verifier@OPS-1 --session-id [0-9a-f-]{36} --model claude-opus-5-5 --effort high --dangerously-skip-permissions/,
		);
		assert.match(
			out.stdout,
			/# agent definition: \S+\/\.claude\/agents\/verifier\.md \(the driving checkout \S+, not the task worktree\), written to \S+\/seat-<run>\/agents\/verifier\.md/,
		);
		assert.match(out.stdout, /# typed line: \d+ bytes \(the terminal accepts fewer than 1024\)/);
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
		const create = calls.find((c) => c[0] === "workspace" && c[1] === "create")!,
			start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
		assert.ok(create.includes(`EVF_RUN=${run.id}`), "the seat's environment names its run");
		assert.ok(create.some((arg) => /^EVF_WORKTREE=.*\.worktrees\/ops-1$/.test(arg)));
		assert.deepEqual(start.slice(2, 7), [`implementer-ops-1-${run.id}`, "--kind", "claude", "--pane", "w9:p1"]);
		assert.ok(start.includes(String(run.session_id)), "Claude Code starts with the session id evf chose");
		assert.deepEqual(
			pairs(calls, "agent", "prompt"),
			[["agent", "prompt", `implementer-ops-1-${run.id}`, "Begin."]],
			"one prompt: the turn began, so nothing is sent again",
		);
		const task = f.db.prepare("SELECT status, herdr_workspace_id FROM tasks WHERE id = ?").get(f.taskId) as Record<
			string,
			unknown
		>;
		assert.deepEqual([task.status, task.herdr_workspace_id], ["active", "w9"]);
		const events = f.db
			.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY id")
			.all(run.id)
			.map((e) => (e as { type: string }).type);
		assert.deepEqual(events, ["session_start", "stage_start", "prompt_sent"], "the prompt waits for the session");

		// A fresh worktree may sit at Claude Code's folder-trust dialog: evf accepts it and the seat reaches idle alone.
		f.herdr.setState({ startFails: true, screen: "Do you trust the files in this folder?\n> Yes, proceed" });
		const trusted = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "verifier");
		assert.equal(trusted.status, 0, trusted.stderr);
		const after = f.herdr.calls().slice(calls.length);
		assert.deepEqual(
			after
				.filter((c) => (c[0] === "pane" && c[1] !== "process-info") || c[1] === "wait" || c[1] === "rename")
				.map((c) => c.slice(0, 3)),
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

test("OPS-58-refocus: the goal chain names project, mission, task, stage, ask and spec and ends with the question", () => {
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
		assert.match(
			out.stdout,
			/\nProof rule: a verify closes passed only when each of the 2 Done criteria \(1, 2\) has a met or n\/a proof/,
		);
		assert.match(out.stdout, /\nFull ask and spec: bin\/evf task spec OPS-1 --show\.\n/);
		assert.equal(lines.at(-1), "Is what you are doing now aligned with this? If not, stop and say so.");
	} finally {
		f.db.close();
		f.close();
	}
});

const NON_GOALS = [
	"- No product code.",
	"- No change to ship or merge.",
	"- No GitHub settings.",
	"- No other task's spec.",
];
/**
 * A spec shaped like the ones that lost criteria: a "Done when:" header, a criterion that names "Done criteria" in its
 * text, blank lines between criteria, long criteria over several lines and a Non-goals list after them.
 */
function bigSpec(criterionWords: number): string {
	const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}w${i}`).join(" ");
	const criteria = Array.from({ length: 26 }, (_, i) => {
		const n = i + 1;
		const text = n === 4 ? "The tests store a spec with 25+ Done criteria." : `Criterion ${n} holds.`;
		return n % 3 === 0
			? `${n}. ${text} ${words(criterionWords, `c${n}a`)}\n   ${words(criterionWords, `c${n}b`)}\n   End of criterion ${n}.`
			: `${n}. ${text} ${words(criterionWords, `c${n}`)}`;
	});
	return [
		"# OPS-1: a big spec",
		"",
		"Goal: every seat sees every criterion.",
		"",
		"## Facts",
		"",
		...Array.from({ length: 30 }, (_, i) => `- Fact ${i + 1}.`),
		"",
		"Done when:",
		"",
		criteria.join("\n\n"),
		"",
		"## Non-goals",
		"",
		...NON_GOALS,
		"",
		"## Approach",
		"",
		...Array.from({ length: 30 }, (_, i) => `${i + 1}. Step ${i + 1}.`),
	].join("\n");
}
const ALL = Array.from({ length: 26 }, (_, i) => String(i + 1));

/** Start a seat session with `spec` stored and return the context Claude Code receives. */
function seatContext(f: ReturnType<typeof seatFixture>, spec: string): string {
	f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(spec, f.taskId);
	const start = cli(f.root, f.env, { session_id: SESSION, source: "startup" }, "hook", "session-start");
	assert.equal(start.status, 0, start.stderr);
	const context = (JSON.parse(start.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
		.additionalContext;
	assert.ok(context.length <= 8000, `${context.length} characters: Claude Code would cut the rest`);
	assert.ok(context.split("\n").length <= 200, `${context.split("\n").length} lines: Claude Code would cut the rest`);
	return context;
}
const numbered = (context: string) => [...context.matchAll(/^\s*(\d+)\. /gm)].map((m) => m[1]);

test("OPS-64-context: a 26-criterion spec with blank lines and multi-line criteria reaches the seat whole, every criterion, non-goal and the proof rule", () => {
	const f = seatFixture();
	try {
		const spec = bigSpec(12);
		const context = seatContext(f, spec);
		const done = spec.slice(spec.indexOf("Done when:"), spec.indexOf("## Approach"));
		assert.ok(context.includes(done.trim()), "the Done list and the Non-goals appear verbatim, blank lines included");
		for (const n of ALL) assert.ok(context.includes(`\n${n}. `), `criterion ${n} is in the seat context`);
		for (const g of NON_GOALS) assert.ok(context.includes(g), `non-goal "${g}" is in the seat context`);
		assert.match(
			context,
			new RegExp(`Proof rule: .*each of the 26 Done criteria \\(${ALL.join(", ")}\\) has a met or n/a proof`),
		);
		assert.ok(!context.includes("SHORTENED"), "nothing is cut, so nothing says so");
		assert.match(context, /Full ask and spec: bin\/evf task spec OPS-1 --show\./);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-64-context: a spec too big for Claude Code's hook limit keeps every criterion number and non-goal and says what it cut first", () => {
	const f = seatFixture();
	try {
		const spec = bigSpec(80);
		assert.ok(spec.length > 8000, "the spec alone is over the limit");
		const context = seatContext(f, spec);
		assert.deepEqual(
			numbered(context)
				.filter((n) => ALL.includes(n!))
				.slice(0, 26),
			ALL,
			"every criterion, in order, before any other numbered line",
		);
		for (const n of ["3", "6", "26"].map(Number))
			assert.ok(context.includes(`${n}. Criterion ${n} holds.`), `criterion ${n} keeps its opening text`);
		for (const g of NON_GOALS) assert.ok(context.includes(g), `non-goal "${g}" is in the seat context`);
		assert.match(context, /each of the 26 Done criteria \(1, 2, .*, 26\) has a met or n\/a proof/);
		const lines = context.split("\n");
		const notice = lines.findIndex((l) => l.startsWith("SHORTENED to fit"));
		assert.ok(notice > 0 && notice < lines.indexOf("Spec:"), "the cut is announced before the spec text");
		assert.match(lines[notice]!, /spec section "Done when": \d+ of 27 items cut to \d+ characters/);
		assert.match(lines[notice]!, /spec section "Approach" \(\d+ lines\)/);
		assert.match(lines[notice]!, /Run bin\/evf task spec OPS-1 --show and read the full ask and spec/);
		assert.ok(!context.includes("Step 30."), "a section that is left out is named, not partly shown");

		// The command the notice names prints the stored text in full.
		const show = cli(f.root, {}, undefined, "task", "spec", "OPS-1", "--show");
		assert.equal(show.status, 0, show.stderr);
		assert.match(show.stdout, /^OPS-1 \(new\), spec .*, 26 Done criteria: 1, 2, .*, 26\n/);
		assert.ok(show.stdout.includes(`Ask:\nMake the doghouse usable.\n`));
		assert.ok(show.stdout.endsWith(`Spec:\n${spec.trim()}\n`), "the spec appears byte for byte");
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

const SHORT = { paneReadyMs: 30_000, paneReadyPollMs: 10, busyRetries: 3, busyBackoffMs: 5 };
const startCalls = (f: ReturnType<typeof seatFixture>) =>
	f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start");
const quiet = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("OPS-67-launch: launch waits while the new pane is not an available shell, then starts the seat exactly once", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ notReady: 4 });
		const before = f.herdr.calls().length;
		quiet(() => launch(f.root, f.task, "implementer", { timing: SHORT }));
		const calls = f.herdr.calls().slice(before);
		const polls = calls.filter((c) => c[1] === "process-info");
		assert.equal(polls.length, 6, "four busy polls, then two quiet ones in a row");
		assert.ok(
			calls.findIndex((c) => c[1] === "start") > calls.findLastIndex((c) => c[1] === "process-info"),
			"agent start comes after the last poll",
		);
		assert.equal(startCalls(f).length, 1);
		const run = f.runs().at(-1)!;
		assert.deepEqual([run.status, run.herdr_pane], ["started", "w9:p1"]);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-67-launch: agent_pane_busy retries with backoff and the seat is recorded once, without a second start", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ busyStarts: 1 });
		const before = f.herdr.calls().length;
		quiet(() => launch(f.root, f.task, "implementer", { timing: SHORT }));
		const calls = f.herdr.calls().slice(before);
		assert.equal(calls.filter((c) => c[1] === "start").length, 2, "one busy refusal, one successful start");
		assert.ok(
			calls.findIndex((c) => c[1] === "list") < calls.findLastIndex((c) => c[1] === "start"),
			"the agent list is checked before the retry",
		);
		const state = JSON.parse(readFileSync(join(f.root, "herdr-state.json"), "utf8")) as { agents: unknown[] };
		assert.equal(state.agents.length, 1, "exactly one start succeeded");
		const run = f.runs().at(-1)!;
		assert.deepEqual(
			[run.status, run.herdr_agent, run.herdr_pane],
			["started", `implementer-ops-1-${run.id}`, "w9:p1"],
		);
		const starts = f.db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'stage_start'")
			.get(run.id) as { n: number };
		assert.equal(starts.n, 1);

		// An earlier start that succeeded late is the seat: no second start.
		const name = `implementer-ops-1-${Number(run.id) + 1}`;
		f.herdr.setState({ busyStarts: 1, agents: [{ name, pane_id: "w9:p1" }] });
		const mark = startCalls(f).length;
		quiet(() => launch(f.root, f.task, "implementer", { timing: SHORT }));
		assert.equal(startCalls(f).length - mark, 1, "the busy refusal is not followed by a duplicate start");
		assert.equal(f.runs().at(-1)!.status, "started");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-67-launch: agent_pane_busy that never clears fails the run after the bounded retries", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ busyStarts: 99 });
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "implementer", { timing: SHORT })),
			(e) => e instanceof EvfError && /answered agent_pane_busy in workspace w9 pane w9:p1 on all 4 attempts over \d+(\.\d)? s of waiting/.test(e.message),
		);
		assert.equal(startCalls(f).length, 8, "the first start and three busy retries, then the same once in a new pane");
		assert.equal(f.runs().at(-1)!.status, "aborted");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-67-launch: a pane that never becomes a shell fails after the wait without calling agent start", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ notReady: true });
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "implementer", { timing: { ...SHORT, paneReadyMs: 100 } })),
			(e) =>
				e instanceof EvfError && /pane w9:p1 in workspace w9 was not an available shell after waiting/.test(e.message),
		);
		assert.equal(startCalls(f).length, 0);
		const run = f.runs().at(-1)!;
		assert.equal(run.status, "aborted");
		assert.match(
			String(run.summary),
			/^launch failed: pane w9:p1 in workspace w9 was not an available shell after waiting/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

const SEAT_CLOSE = (f: ReturnType<typeof seatFixture>, id: number | string) => {
	writeFileSync(join(f.root, "done.md"), "Done.\n");
	return cli(f.root, {}, undefined, "run", "done", String(id), "--status", "passed", "--summary-file", "done.md");
};
const pairs = (calls: string[][], kind: string, sub: string) => calls.filter((c) => c[0] === kind && c[1] === sub);

test("OPS-65-split: with an 'evf TUI' workspace the dry run splits a pane and prints the same environment as workspace create", () => {
	const f = seatFixture();
	try {
		const plain = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer", "--dry-run").stdout;
		f.herdr.setState({ tui: true });
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer", "--dry-run");
		assert.equal(out.status, 0, out.stderr);
		const split = out.stdout.split("\n").find((l) => l.startsWith("herdr pane split"))!;
		assert.match(split, /^herdr pane split w1:p1 --direction right --cwd \S+ --env EVF_TASK=OPS-1 /);
		assert.match(split, / --no-focus$/);
		assert.doesNotMatch(out.stdout, /workspace create/);
		assert.match(out.stdout, /herdr agent start 'implementer-ops-1-<run>' --kind claude --pane '<new pane>'/);
		const envs = (line: string) => [...line.matchAll(/--env (\S+)/g)].map((m) => m[1]!.replace(/=.*/, "")).sort();
		assert.deepEqual(envs(split), envs(plain.split("\n").find((l) => l.startsWith("herdr workspace create"))!));

		// The label is one named value a test can override.
		f.herdr.setState({ tui: true, tuiLabel: "scratch label" });
		assert.match(
			cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer", "--dry-run").stdout,
			/workspace create/,
		);
		assert.match(
			cli(
				f.root,
				{ EVF_TUI_LABEL: "scratch label" },
				undefined,
				"launch",
				"OPS-1",
				"--role",
				"implementer",
				"--dry-run",
			).stdout,
			/pane split/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-split: a real launch stores the seat pane and the TUI workspace on the split path, the new workspace on the fallback", () => {
	const f = seatFixture();
	try {
		const stored = (runId: unknown) => {
			const run = f.db.prepare("SELECT herdr_pane FROM runs WHERE id = ?").get(runId) as { herdr_pane: string };
			const task = f.db.prepare("SELECT herdr_workspace_id FROM tasks WHERE id = ?").get(f.taskId) as {
				herdr_workspace_id: string;
			};
			const event = JSON.parse(
				(
					f.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'stage_start'").get(runId) as {
						payload: string;
					}
				).payload,
			) as { workspace: string; pane: string };
			return [run.herdr_pane, task.herdr_workspace_id, event.workspace, event.pane];
		};
		// No TUI workspace: today's behavior, the new workspace's root pane.
		let out = JSON.parse(cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer").stdout) as {
			run: number;
		};
		assert.deepEqual(stored(out.run), ["w9:p1", "w9", "w9", "w9:p1"]);
		assert.equal(pairs(f.herdr.calls(), "workspace", "create").length, 1);
		assert.equal(pairs(f.herdr.calls(), "pane", "split").length, 0);

		// A TUI workspace: a split pane in it, with the seat's cwd and env.
		f.herdr.setState({ tui: true });
		out = JSON.parse(cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "verifier").stdout) as { run: number };
		assert.deepEqual(stored(out.run), ["w1:p2", "w1", "w1", "w1:p2"]);
		const split = pairs(f.herdr.calls(), "pane", "split")[0]!;
		assert.ok(split.includes(`EVF_RUN=${out.run}`) && split.includes("--no-focus") && split.includes("--cwd"));
		assert.equal(pairs(f.herdr.calls(), "workspace", "create").length, 1, "no second workspace");
		assert.deepEqual(pairs(f.herdr.calls(), "agent", "start").at(-1)!.slice(5, 7), ["--pane", "w1:p2"]);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-split: a split pane whose agent never starts is closed; the run aborts and the TUI pane stays", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ tui: true, startFails: true, screen: "claude: command not found" });
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer");
		assert.equal(out.status, 1);
		assert.equal(f.runs().at(-1)!.status, "aborted");
		const closes = pairs(f.herdr.calls(), "pane", "close");
		assert.deepEqual(
			closes,
			[
				["pane", "close", "w1:p2"],
				["pane", "close", "w1:p2"],
			],
			"only the new pane closes: after the first try, and after the retry",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-cleanup: a finished run closes its own pane after the store update; the TUI pane and other seats are never closed", () => {
	const f = seatFixture();
	try {
		const open = (pane: string) => {
			const id = f.db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, herdr_pane, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', ?, ?)",
				)
				.run(f.taskId, pane, new Date().toISOString()).lastInsertRowid;
			return Number(id);
		};
		const mine = open("w1:p2"),
			other = open("w1:p3");
		f.herdr.setState({ tui: true, panes: ["w1:p2", "w1:p3"], watchDb: workDbPath(f.root) });
		const done = SEAT_CLOSE(f, mine);
		assert.equal(done.status, 0, done.stderr);
		assert.deepEqual(
			pairs(f.herdr.calls(), "pane", "close"),
			[["pane", "close", "w1:p2"]],
			"ending one run never closes another's pane",
		);
		assert.deepEqual(f.herdr.state().closeSaw, [["passed"]], "the store already said passed when the pane closed");
		assert.match(done.stdout, /closed pane w1:p2/);

		// A run whose stored pane is the TUI pane: no close, a refusal in the output.
		const tui = open("w1:p1");
		const before = f.herdr.calls().length;
		const refused = SEAT_CLOSE(f, tui);
		assert.equal(refused.status, 0);
		assert.equal(pairs(f.herdr.calls().slice(before), "pane", "close").length, 0);
		assert.match(refused.stdout, /pane w1:p1 is the TUI pane: not closed/);

		// Another open run records the same pane: refused too.
		const twin = open("w1:p3");
		const shared = SEAT_CLOSE(f, twin);
		assert.match(shared.stdout, new RegExp(`pane w1:p3 still belongs to open run ${other}: not closed`));
		assert.equal(pairs(f.herdr.calls(), "pane", "close").length, 1);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-cleanup: a seat that closes its own pane hands the close and rebalance to a detached process", async () => {
	const f = seatFixture();
	try {
		const id = Number(
			f.db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, herdr_pane, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', 'w1:p2', ?)",
				)
				.run(f.taskId, new Date().toISOString()).lastInsertRowid,
		);
		f.herdr.setState({ tui: true, panes: ["w1:p2", "w1:p3"] });
		writeFileSync(join(f.root, "done.md"), "Done.\n");
		const done = cli(
			f.root,
			{ HERDR_PANE_ID: "w1:p2" },
			undefined,
			"run",
			"done",
			String(id),
			"--status",
			"passed",
			"--summary-file",
			"done.md",
		);
		assert.match(done.stdout, /closing pane w1:p2 from a detached process/);
		for (let i = 0; i < 50 && !pairs(f.herdr.calls(), "pane", "close").length; i++)
			await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(pairs(f.herdr.calls(), "pane", "close"), [["pane", "close", "w1:p2"]]);
		for (let i = 0; i < 50 && !pairs(f.herdr.calls(), "pane", "layout").length; i++)
			await new Promise((r) => setTimeout(r, 100));
		assert.ok(pairs(f.herdr.calls(), "pane", "layout").length, "the rebalance read the layout after the close");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-cleanup: a fallback seat closes its workspace only when no other pane lives there; the session-end hook cleans up too", () => {
	const f = seatFixture();
	try {
		const open = (pane: string) =>
			Number(
				f.db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, round, status, herdr_pane, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', ?, ?)",
					)
					.run(f.taskId, pane, new Date().toISOString()).lastInsertRowid,
			);
		const alone = open("w9:p1");
		f.herdr.setState({});
		SEAT_CLOSE(f, alone);
		assert.deepEqual(
			f.herdr.calls().filter((c) => c[1] === "close"),
			[["workspace", "close", "w9"]],
		);

		const crowded = open("w8:p1");
		f.herdr.setState({ panes: ["w8:p1", "w8:p2"] });
		SEAT_CLOSE(f, crowded);
		assert.deepEqual(
			pairs(f.herdr.calls(), "pane", "close"),
			[["pane", "close", "w8:p1"]],
			"a workspace with another pane keeps living",
		);

		// The session-end hook aborts a run that never closed its stage and closes its pane.
		const dying = open("w1:p4");
		f.herdr.setState({ tui: true, panes: ["w1:p4"] });
		const before = f.herdr.calls().length;
		cli(
			f.root,
			{ EVF_RUN: String(dying), EVF_TASK: "OPS-1", EVF_ROLE: "implementer", EVF_WORKTREE: f.worktree },
			{ session_id: SESSION, reason: "other" },
			"hook",
			"session-end",
		);
		assert.deepEqual(pairs(f.herdr.calls().slice(before), "pane", "close"), [["pane", "close", "w1:p4"]]);
		assert.equal(
			(f.db.prepare("SELECT status FROM runs WHERE id = ?").get(dying) as { status: string }).status,
			"aborted",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-65-auto: every role launches with --dangerously-skip-permissions through an agent file that says bypassPermissions; no file sets dontAsk", () => {
	const read = (path: string) => readFileSync(join(source, path), "utf8");
	for (const role of Object.keys(ROLES)) {
		const agent = read(`.claude/agents/${role}.md`);
		assert.match(agent.split("---")[1]!, /^permissionMode: bypassPermissions$/m, `${role}.md permissionMode`);
	}
	const f = seatFixture();
	try {
		for (const role of ["verifier", "implementer"]) {
			const line = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", role, "--dry-run")
				.stdout.split("\n")
				.find((l) => l.startsWith("herdr agent start"))!;
			assert.match(line, / --dangerously-skip-permissions$/);
			assert.ok(!line.includes("--permission-mode"));
		}
	} finally {
		f.db.close();
		f.close();
	}
	const agents = Object.keys(ROLES).map((r) => `.claude/agents/${r}.md`);
	for (const path of ["tools/evf/launch.ts", "tools/evf/README.md", "tools/evf/tests/seat.test.ts", ...agents]) {
		assert.ok(!read(path).includes("accept" + "Edits"), `${path} still names the old mode`);
	}
	for (const path of [
		"tools/evf/launch.ts",
		"tools/evf/panes.ts",
		"tools/evf/drive.ts",
		".claude/settings.json",
		...agents,
	]) {
		assert.ok(!new RegExp("dont" + "Ask").test(read(path)), `${path} sets a bypass`);
	}
	const planAnswer = read("tools/evf/drive.ts").match(/"--permission-mode",\s*"plan"/g);
	assert.equal(planAnswer?.length, 1, "the planner --resume answer path keeps --permission-mode plan");
});

test("OPS-65-settings: deny rules and the hooks are unchanged, no ask rule remains (OPS-71); the only allow addition targets post-review.mjs (a wildcard cannot anchor the path, so the absolute form also matches extra arguments)", () => {
	const settings = JSON.parse(readFileSync(join(source, ".claude/settings.json"), "utf8")) as {
		permissions: { allow: string[]; ask: string[]; deny: string[] };
		hooks: Record<string, unknown[]>;
	};
	// OPS-71 removed the git push ask rule; the deny rules below still stop main, force and mirror pushes.
	assert.equal(settings.permissions.ask, undefined);
	assert.deepEqual(settings.permissions.deny, [
		"Bash(git push *--force*)",
		"Bash(git push -f*)",
		"Bash(git push * -f*)",
		"Bash(git push * +*)",
		"Bash(git push --mirror*)",
		"Bash(git push * --mirror*)",
		"Bash(git push * main)",
		"Bash(git push * main *)",
		"Bash(git push *:main*)",
		"Bash(git push *:refs/heads/main*)",
		"Bash(gh pr merge*)",
		"Bash(gh pr review*)",
		"Bash(gh api -X *)",
		"Bash(gh api --method *)",
		"Bash(gh repo *)",
		"Bash(git checkout main*)",
		"Bash(git switch main*)",
		"Bash(git branch -D *)",
		"Bash(git branch -d *)",
		"Bash(git worktree remove*)",
		"Bash(git worktree prune*)",
		"Read(./.env*)",
		"Read(./apps/web/.env*)",
		"Read(./packages/**/.env*)",
	]);
	const hook = (command: string, timeout: number, matcher?: string) => ({
		...(matcher ? { matcher } : {}),
		hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/bin/evf hook ${command}`, timeout }],
	});
	assert.deepEqual(settings.hooks, {
		SessionStart: [hook("session-start", 15)],
		PreToolUse: [hook("path-guard", 10, "Edit|Write|MultiEdit|NotebookEdit"), hook("read-guard", 10, "Read|Grep|Glob")],
		Stop: [hook("stop", 15)],
		SessionEnd: [hook("session-end", 15)],
	});
	const script = ".agents/skills/verify-preview/scripts/post-review.mjs";
	const existing = new Set([
		"Bash(cd *)",
		"Bash(bin/evf pr open *)",
		"Bash(./bin/evf pr open *)",
		"Bash(*/bin/evf pr open *)",
		"Bash(git add *)",
		"Bash(git commit *)",
		"Bash(git -C * add *)",
		"Bash(git -C * commit *)",
	]);
	const added = settings.permissions.allow.filter((rule) => !existing.has(rule));
	assert.ok(added.length >= 1, "the allow list lacks the post-review rule");
	for (const rule of added)
		assert.ok(
			(rule.startsWith("Bash(node /") || rule === `Bash(node ${script} *)`) &&
				rule.endsWith(`${script} *)`) &&
				!rule.slice(0, -script.length - 3).includes("**"),
			`allow rule ${rule} covers more than post-review.mjs`,
		);
	assert.ok(
		added.some((rule) => rule === `Bash(node ${script} *)`),
		"the relative form is allowed",
	);
});

// OPS-72: launch takes the role from the driving checkout, reads the pane on a failed start, retries once and sends the
// first prompt only to a ready session.
const TURN = { ...SHORT, sessionReadyMs: 3_000, sessionPollMs: 20, turnConfirmMs: 150, turnPollMs: 20 };
const startArgsOf = (f: ReturnType<typeof seatFixture>) => startCalls(f).at(-1)!;
const flagOf = (start: string[], flag: string) => start[start.indexOf(flag) + 1]!;
/** The definition a launch handed to the seat: the file inside the run's plugin directory. */
const pluginAgent = (start: string[], role: string) => {
	const dir = flagOf(start, "--plugin-dir");
	return {
		dir,
		manifest: JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>,
		text: readFileSync(join(dir, "agents", `${role}.md`), "utf8"),
	};
};

test("OPS-72-agent: the seat gets the role definition of the driving checkout, whether the worktree has none or a different one", () => {
	const f = seatFixture();
	try {
		const rootText = readFileSync(join(f.root, ".claude/agents/implementer.md"), "utf8");
		const seen = new Set<string>();
		const check = (label: string) => {
			quiet(() => launch(f.root, f.task, "implementer", { timing: TURN }));
			const start = startArgsOf(f);
			assert.equal(flagOf(start, "--agent"), "evf:implementer");
			assert.ok(!start.includes("--agents"), `${label}: no definition on the typed line`);
			const got = pluginAgent(start, "implementer");
			assert.equal(got.manifest.name, "evf");
			assert.equal(got.text, rootText, `${label}: the plugin carries the driving checkout's file, whole`);
			assert.ok(!got.dir.startsWith(f.worktree), `${label}: the directory is outside the task worktree`);
			assert.ok(!seen.has(got.dir), `${label}: each run has its own directory`);
			seen.add(got.dir);
			// A role file without model or effort gets the seat's; one with them keeps its own.
			assert.match(got.text, /^model: claude-/m);
			assert.match(got.text, /^effort: /m);
		};
		// The seat fixture's worktree has no .claude/agents at all.
		check("no worktree file");
		// A task branch that edits the role file does not change the seat its own drive launches.
		mkdirSync(join(f.worktree, ".claude/agents"), { recursive: true });
		writeFileSync(
			join(f.worktree, ".claude/agents/implementer.md"),
			"---\nname: implementer\ndescription: branch copy\nmodel: claude-opus-5-5\neffort: high\ntools: Read\n---\nThe branch's own prompt.\n",
		);
		check("a different worktree file");
		const dry = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer", "--dry-run").stdout;
		assert.match(dry, /# agent definition: \S+\/\.claude\/agents\/implementer\.md \(the driving checkout/);
		assert.doesNotMatch(dry, /ops-1\/\.claude\/agents/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-pane: a failed start reports the pane's real error, not only the timeout, in the message and the run summary", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ startFails: true, screen: "\n  ╭───╮\n$ claude --agent evidence\nError: agent not found\n" });
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "implementer", { timing: TURN })),
			(e) => e instanceof EvfError && /agent start failed/.test(e.message) && /Error: agent not found/.test(e.message),
		);
		const run = f.runs().at(-1)!;
		assert.equal(run.status, "aborted");
		assert.match(String(run.summary), /^launch failed: .*Error: agent not found/);
		assert.match(String(run.summary), /claude --agent evidence/, "the last meaningful lines, not the box drawing");
		assert.doesNotMatch(String(run.summary), /╭/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-retry: a first failed start closes the dead pane and the second pane starts the seat: one run row, a new session id", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ failStarts: 1, screen: "claude: command not found" });
		const before = f.runs().length;
		quiet(() => launch(f.root, f.task, "implementer", { timing: TURN }));
		const rows = f.runs();
		assert.equal(rows.length, before + 1, "one run row");
		const run = rows.at(-1)!;
		assert.equal(run.status, "started");
		assert.equal(startCalls(f).length, 2, "two starts: one failed, one succeeded");
		assert.equal(pairs(f.herdr.calls(), "workspace", "close").length, 1, "the dead workspace closed");
		assert.equal(pairs(f.herdr.calls(), "workspace", "create").length, 2, "a new pane for the second try");
		const [first, second] = startCalls(f).map((c) => c[c.indexOf("--session-id") + 1]);
		assert.notEqual(first, second, "the second try uses a new Claude session id");
		assert.equal(run.session_id, second);
		const retry = f.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'launch_retry'").get(run.id) as {
			payload: string;
		};
		assert.match(retry.payload, /command not found/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-retry: two failed starts close the run as aborted with the pane excerpt and throw one error", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ startFails: true, screen: "Error: agent not found" });
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "implementer", { timing: TURN })),
			(e) => e instanceof EvfError && /Error: agent not found/.test(e.message),
		);
		assert.equal(startCalls(f).length, 2, "exactly one retry");
		const run = f.runs().at(-1)!;
		assert.equal(run.status, "aborted");
		assert.match(String(run.summary), /Error: agent not found/);
		assert.equal(pairs(f.herdr.calls(), "workspace", "close").length, 2, "both dead workspaces closed");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-ready: the first prompt waits for the run's session_start event and is never sent before it", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ sessionDelayMs: 400 });
		const started = Date.now();
		quiet(() => launch(f.root, f.task, "implementer", { prompt: "Begin.", timing: TURN }));
		const run = f.runs().at(-1)!;
		const types = f.db
			.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY id")
			.all(run.id)
			.map((e) => (e as { type: string }).type);
		assert.ok(
			types.indexOf("session_start") >= 0 && types.indexOf("session_start") < types.indexOf("prompt_sent"),
			types.join(","),
		);
		assert.ok(Date.now() - started >= 350, "launch waited for the delayed session");
		assert.equal(pairs(f.herdr.calls(), "agent", "prompt").length, 1);
		assert.ok(!types.includes("prompt_resent"), "the turn began, so no resend");
		// Claude never reaches its hook: the prompt is not sent at all, the launch fails after its retry.
		f.herdr.setState({ noSession: true, screen: "Welcome to Claude Code" });
		const mark = pairs(f.herdr.calls(), "agent", "prompt").length;
		assert.throws(
			() =>
				quiet(() =>
					launch(f.root, f.task, "implementer", { prompt: "Begin.", timing: { ...TURN, sessionReadyMs: 120 } }),
				),
			(e) =>
				e instanceof EvfError && /sent no session_start/.test(e.message) && /Welcome to Claude Code/.test(e.message),
		);
		assert.equal(
			pairs(f.herdr.calls(), "agent", "prompt").length,
			mark,
			"no prompt reached a session that was not ready",
		);
		assert.equal(f.runs().at(-1)!.status, "aborted");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-ready: a first prompt that starts no turn is sent exactly once more and records prompt_resent", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ agentStatus: "idle" });
		quiet(() => launch(f.root, f.task, "implementer", { prompt: "Begin.", timing: TURN }));
		const run = f.runs().at(-1)!;
		const prompts = pairs(f.herdr.calls(), "agent", "prompt");
		assert.equal(prompts.length, 2, "the prompt and exactly one resend");
		assert.deepEqual(prompts[0], prompts[1]);
		const resent = f.db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'prompt_resent'")
			.get(run.id) as {
			n: number;
		};
		assert.equal(resent.n, 1);
		assert.equal(run.status, "started");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-69-hook: the session-end hook fills usage, and refills a run that evf run done already closed, from the complete transcript", () => {
	const f = seatFixture(),
		claude = join(f.root, "claude-config");
	try {
		const env = { ...f.env, CLAUDE_CONFIG_DIR: claude };
		const usage = () => ({
			...(f.db.prepare("SELECT status, tokens_in, tokens_out, cost_est FROM runs WHERE id = ?").get(f.run) as object),
		});
		writeTranscript(claude, SESSION, [assistantLine("a", "claude-sonnet-5-5", { input: 10, output: 20 })]);
		// The stage closed while the transcript held one message.
		f.db.prepare("UPDATE runs SET status = 'passed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), f.run);
		assert.equal(usage().tokens_in, null);
		// The seat's final turns land in the transcript, then the session ends.
		writeTranscript(claude, SESSION, [
			assistantLine("a", "claude-sonnet-5-5", { input: 10, output: 20 }),
			assistantLine("b", "claude-sonnet-5-5", { input: 5, output: 7 }),
		]);
		const end = cli(f.root, env, { session_id: SESSION, reason: "exit" }, "hook", "session-end");
		assert.equal(end.status, 0, end.stderr);
		assert.deepEqual(usage(), { status: "passed", tokens_in: 15, tokens_out: 27, cost_est: (15 * 2 + 27 * 10) / 1e6 });
		// A clear keeps the run open and counts nothing yet.
		f.db
			.prepare("UPDATE runs SET status = 'started', tokens_in = NULL, tokens_out = NULL, cost_est = NULL WHERE id = ?")
			.run(f.run);
		cli(f.root, env, { session_id: SESSION, reason: "clear" }, "hook", "session-end");
		assert.equal(usage().tokens_in, null);
		// An aborting end fills too, and a missing transcript leaves null with the usual exit code.
		cli(f.root, env, { session_id: SESSION, reason: "exit" }, "hook", "session-end");
		assert.deepEqual([usage().status, usage().tokens_in], ["aborted", 15]);
		f.db.prepare("UPDATE runs SET status = 'started', tokens_in = NULL WHERE id = ?").run(f.run);
		const none = cli(
			f.root,
			{ ...env, CLAUDE_CONFIG_DIR: join(f.root, "empty") },
			{ session_id: SESSION, reason: "exit" },
			"hook",
			"session-end",
		);
		assert.equal(none.status, 0, none.stderr);
		assert.deepEqual([usage().status, usage().tokens_in], ["aborted", null]);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-69-launch-abort: a launch that fails after the run row exists aborts the run and leaves usage null without a transcript", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ startFails: true, screen: "claude: command not found" });
		const out = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer");
		assert.notEqual(out.status, 0);
		const last = f.runs().at(-1)!;
		assert.equal(last.status, "aborted");
		assert.match(String(last.summary), /^launch failed/);
		const usage = f.db.prepare("SELECT tokens_in, cost_est FROM runs WHERE id = ?").get(last.id) as object;
		assert.deepEqual({ ...usage }, { tokens_in: null, cost_est: null });
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-69-runs-model: the runs row records the resolved model and effort of a seat override", () => {
	const f = seatFixture();
	try {
		const path = join(f.root, "evf.config.json"),
			cfg = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({ ...cfg, seats: { implementer: { model: "claude-opus-5-5", effort: "high" } } }),
		);
		f.herdr.setState({ startFails: true, screen: "claude: command not found" });
		cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "implementer");
		const row = f.db.prepare("SELECT model, effort FROM runs WHERE id = (SELECT MAX(id) FROM runs)").get() as object;
		assert.deepEqual({ ...row }, { model: "claude-opus-5-5", effort: "high" });
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-74: the typed line stays under Herdr's 1024-byte terminal limit whatever the role file holds, and a shell that is
// not at its prompt yet is waited for, not abandoned.
const ROLE_NAMES = Object.keys(ROLES) as Array<keyof typeof ROLES>;
const optsFor = (role: string) => (role === "ideator" ? { idea: 1, timing: TURN } : { timing: TURN });

test("OPS-74-line: every role launches against a Herdr that enforces the 1024-byte limit, from the checkout's real role files", () => {
	const f = seatFixture();
	try {
		for (const role of ROLE_NAMES) {
			const before = startCalls(f).length;
			quiet(() => launch(f.root, f.task, role, optsFor(role)));
			assert.equal(startCalls(f).length - before, 1, `${role}: started at the first try`);
			const run = f.runs().at(-1)!;
			assert.equal(run.status, "started", role);
			assert.ok(String(run.herdr_agent).startsWith(role), role);
		}
		const typed = f.herdr.state().typedLines as number[];
		assert.equal(typed.length, ROLE_NAMES.length);
		for (const [i, bytes] of typed.entries()) assert.ok(bytes <= 768, `${ROLE_NAMES[i]}: typed line is ${bytes} bytes`);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-grow: the typed line does not grow with the role file; an over-long line is refused before any pane exists", () => {
	const f = seatFixture();
	try {
		const lengths = (role: (typeof ROLE_NAMES)[number]) => {
			const task = parseTask("OPS-1");
			const plan = launchPlan(f.root, task, role, { idea: role === "ideator" ? 1 : undefined, run: "123" });
			return typedLineBytes(plan);
		};
		const real = ROLE_NAMES.map(lengths);
		for (const [i, bytes] of real.entries()) assert.ok(bytes <= 768, `${ROLE_NAMES[i]}: ${bytes} bytes`);
		for (const role of ROLE_NAMES) {
			const file = join(f.root, `.claude/agents/${role}.md`);
			writeFileSync(file, `${readFileSync(file, "utf8")}\n${"A long extra paragraph for the role.\n".repeat(600)}`);
		}
		assert.ok(readFileSync(join(f.root, ".claude/agents/planner.md"), "utf8").length > 20_000);
		assert.deepEqual(ROLE_NAMES.map(lengths), real, "the same line lengths with 20 KB role files");
		quiet(() => launch(f.root, f.task, "planner", { timing: TURN }));
		assert.equal(startCalls(f).length, 1);
		const dry = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "planner", "--dry-run").stdout;
		const bytes = Number(/# typed line: (\d+) bytes/.exec(dry)![1]);
		assert.ok(bytes > 0 && bytes <= 768, `dry run shows ${bytes}`);

	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-prompt: agent_start_input_failed twice waits with backoff in the same pane, then starts the seat once", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ inputFailStarts: 2 });
		const t0 = Date.now();
		const timing = { ...SHORT, busyBackoffMs: 40 };
		quiet(() => launch(f.root, f.task, "implementer", { timing }));
		const waited = Date.now() - t0;
		assert.ok(waited >= 40 + 80, `waited ${waited} ms, at least the backoff sum 120`);
		const calls = f.herdr.calls();
		assert.equal(startCalls(f).length, 3, "two refusals, one start");
		assert.equal(pairs(calls, "pane", "split").length + pairs(calls, "workspace", "create").length, 1, "one pane");
		assert.equal(pairs(calls, "workspace", "close").length + pairs(calls, "pane", "close").length, 0, "no pane closed");
		assert.equal(f.herdr.state().agents.length, 1, "a started seat");
		const rows = f.runs();
		assert.equal(rows.filter((r) => r.status === "started").length, 2, "the fixture's run and one launch run");
		assert.equal(rows.at(-1)!.status, "started");
		// The agent list is read before each retry, and the shell is polled again.
		const idx = calls.map((c, i) => (c[0] === "agent" && c[1] === "start" ? i : -1)).filter((i) => i >= 0);
		for (const i of idx.slice(1)) assert.ok(calls.slice(idx[0], i).some((c) => c[1] === "list"), "list before a retry");
		assert.ok(
			calls.slice(idx[0], idx[1]).filter((c) => c[1] === "process-info").length >= 2,
			"the shell is checked again before the retry",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-prompt: agent_start_input_failed that never clears fails after the full backoff and names the code, attempts and wait", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ inputFailStarts: 999 });
		const timing = { ...SHORT, busyBackoffMs: 20 };
		const t0 = Date.now();
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "implementer", { timing })),
			(e) =>
				e instanceof EvfError &&
				/answered agent_start_input_failed in workspace w9 pane w9:p1 on all 4 attempts over 0\.\d s of waiting/.test(e.message),
		);
		assert.ok(Date.now() - t0 >= 20 + 40 + 80, "the whole backoff 20 + 40 + 80 ms ran");
		assert.equal(startCalls(f).length, 8, "four attempts, then the same once in a new pane");
		assert.equal(f.runs().at(-1)!.status, "aborted");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-quiet: a shell with a subshell in the foreground group is not ready, though the group id equals the shell pid", () => {
	const f = seatFixture();
	try {
		f.herdr.setState({ rcLoading: 3 });
		const before = f.herdr.calls().length;
		quiet(() => launch(f.root, f.task, "implementer", { timing: SHORT }));
		const calls = f.herdr.calls().slice(before);
		assert.equal(calls.filter((c) => c[1] === "process-info").length, 5, "three loading polls, then two quiet ones");
		assert.ok(
			calls.findIndex((c) => c[1] === "start") > calls.findLastIndex((c) => c[1] === "process-info"),
			"agent start comes after the quiet polls",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-guard: a line of 1024 bytes or more is refused before any pane or run row exists, with the role, the bytes and the limit", () => {
	const f = seatFixture();
	try {
		// At the real limit: a plan whose plugin path is long enough.
		const plan = launchPlan(f.root, f.task, "planner", { run: "1" });
		const longPlan = { ...plan, pluginDir: `/${"d".repeat(900)}` };
		assert.throws(
			() => guardTypedLine(longPlan),
			(e) =>
				e instanceof LaunchLineTooLong &&
				/^The launch line for planner is (\d+) bytes; the terminal accepts fewer than 1024\./.test(e.message) &&
				Number(/is (\d+) bytes/.exec(e.message)![1]) === typedLineBytes(longPlan),
		);
		guardTypedLine(plan); // the real line passes
		// Through launch, with the limit lowered below the real line: no pane, no run row.
		const panes = f.herdr.calls().length,
			runs = f.runs().length,
			bytes = typedLineBytes(plan);
		assert.throws(
			() => quiet(() => launch(f.root, f.task, "planner", { timing: { ...TURN, typedLineLimit: bytes } })),
			(e) => e instanceof LaunchLineTooLong && /launch line for planner is \d+ bytes; the terminal accepts fewer than \d+\./.test(e.message),
		);
		assert.equal(f.herdr.calls().length, panes, "no herdr call, so no pane");
		assert.equal(f.runs().length, runs, "no run row");
		const dry = cli(f.root, {}, undefined, "launch", "OPS-1", "--role", "planner", "--dry-run").stdout;
		assert.ok(Number(/# typed line: (\d+) bytes/.exec(dry)![1]) > 0);
	} finally {
		f.db.close();
		f.close();
	}
});
