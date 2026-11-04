import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
	assistantLine,
	endTurnLine,
	fixture,
	MARKER,
	promptLine,
	source,
	toolCallLine,
	toolDoneLine,
	writeTranscript,
} from "./fixtures.ts";
import { ensureTask, openWorkDb, syncGoals, workDbPath } from "../db.ts";
import { driveOnce } from "../drive.ts";
import { parseTask } from "../lib.ts";
import { parseEntries, runSplit, turnOf } from "../turn-time.ts";

const SESSION = "44444444-4444-4444-8444-444444444444";
const MIN = 60_000;
const OPUS = "claude-opus-5-5",
	SONNET = "claude-sonnet-5-5";
const T0 = Date.parse("2026-11-04T10:00:00.000Z");

const evf = (cwd: string, env: Record<string, string>, input: string, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_STAGE: "", EVF_ROLE: "", ...env },
		input,
	});

type Fixture = ReturnType<typeof store>;
/** A disposable repo with a store, a task row and its own Claude dir. */
function store() {
	const f = fixture(),
		claude = mkdtempSync(join(tmpdir(), "evf-claude-")),
		savedClaude = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claude;
	const task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Long run", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const wt = f.task("ops-1");
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const t = ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET worktree = ?, spec = ? WHERE id = ?").run(wt, "Goal: x.\nDone criteria:\n1. y.", t.id);
	const insertRun = (stage: string, role: string, status: string, startedAt: number, session?: string) =>
		Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
				)
				.run(t.id, stage, role, session ?? null, status, new Date(startedAt).toISOString()).lastInsertRowid,
		);
	const events = (type: string) =>
		(
			db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = ? ORDER BY id").all(t.id, type) as Array<{
				payload: string;
			}>
		).map((e) => JSON.parse(e.payload) as Record<string, any>);
	return {
		...f,
		claude,
		task,
		wt,
		db,
		taskId: t.id,
		insertRun,
		events,
		transcript: (lines: string[], session = SESSION) => writeTranscript(claude, session, lines),
		transcriptFile: (session = SESSION) => join(claude, "projects", "-fixture-cwd", `${session}.jsonl`),
		close: () => {
			db.close();
			if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = savedClaude;
			rmSync(claude, { recursive: true, force: true });
			f.close();
		},
	};
}

const stopHook = (f: Fixture, run: number, input: object, env: Record<string, string> = {}) =>
	evf(f.root, { EVF_RUN: String(run), ...env }, JSON.stringify({ session_id: SESSION, ...input }), "hook", "stop");

/** One tool call in one turn: 1 s model, 2 s tool, 3 s model. */
const oneCall = (name: string, input: Record<string, unknown>) =>
	turnOf(
		parseEntries([
			promptLine(T0),
			toolCallLine(T0 + 1000, "a", name, input),
			toolDoneLine(T0 + 3000, "a"),
			endTurnLine(T0 + 6000),
		]),
		null,
	)!;

test("AC:OPS-134-1 evf hook stop records one turn_end with the exact values of the fixture and no text", () => {
	const f = store();
	try {
		const run = f.insertRun("implement", "implementer", "started", T0, SESSION);
		f.transcript([
			promptLine(T0 + 1000),
			toolCallLine(T0 + 2000, "t1", "Read", { file_path: `/x/${MARKER}` }),
			toolDoneLine(T0 + 4000, "t1"),
			toolCallLine(T0 + 5000, "t2", "Bash", { command: `bin/evf verify OPS-1 # ${MARKER}` }),
			toolDoneLine(T0 + 9000, "t2"),
			toolCallLine(T0 + 10_000, "t3", "Bash", { command: `sleep 8 # ${MARKER}` }),
			toolDoneLine(T0 + 18_000, "t3"),
			endTurnLine(T0 + 21_000),
		]);
		const r = stopHook(f, run, {});
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(f.events("turn_end"), [
			{
				run,
				session: SESSION,
				startedAt: new Date(T0 + 1000).toISOString(),
				endedAt: new Date(T0 + 21_000).toISOString(),
				toolMs: 2000,
				checkMs: 4000,
				waitMs: 8000,
				modelMs: 6000,
			},
		]);
		const stored = f.db.prepare("SELECT payload FROM events WHERE type = 'turn_end'").get() as { payload: string };
		assert.ok(!stored.payload.includes(MARKER), "no message text, command, prompt or tool output in the payload");
		assert.ok(!/sleep|verify|Read/.test(stored.payload));
	} finally {
		f.close();
	}
});

/** A fake claude: writes a transcript for its --session-id, prints what it got, runs the real session-end hook, exits. */
function fakeClaude(f: Fixture) {
	writeFileSync(
		join(f.root, "fake-bin/claude"),
		`#!${process.execPath}\nconst fs=require("node:fs"),cp=require("node:child_process"),path=require("node:path");\n` +
			`const a=process.argv.slice(2),opt=k=>a[a.indexOf(k)+1],session=opt("--session-id");\n` +
			`const dir=path.join(process.env.CLAUDE_CONFIG_DIR,"projects","-fixture-cwd");fs.mkdirSync(dir,{recursive:true});\n` +
			`fs.writeFileSync(path.join(dir,session+".jsonl"),${JSON.stringify(assistantLine("m1", OPUS, { input: 1000, output: 100 }))}+"\\n");\n` +
			`const prompt=fs.readFileSync(0,"utf8");\n` +
			`console.log(JSON.stringify({args:a,prompt,run:process.env.EVF_RUN,role:process.env.EVF_ROLE,stage:process.env.EVF_STAGE??null}));\n` +
			`const h=cp.spawnSync(process.execPath,[${JSON.stringify(join(source, "tools/evf/main.ts"))},"hook","session-end"],{input:JSON.stringify({session_id:session,reason:"other"}),env:process.env});\n` +
			`process.exit(Number(process.env.FAKE_CLAUDE_EXIT??0));\n`,
	);
	chmodSync(join(f.root, "fake-bin/claude"), 0o755);
	const prompt = join(f.root, "fake-bin/prompt.md");
	writeFileSync(prompt, "Do the coordinator work.\n");
	return prompt;
}

test("AC:OPS-134-2 coordinator and registration runs appear in evf usage and --json with role, model, tokens and cost", () => {
	const f = store();
	try {
		const prompt = fakeClaude(f);
		for (const [task, role] of [
			["OPS-1", "coordinator"],
			["OPS-9", "registration"],
		] as const) {
			const r = evf(f.root, {}, "", "headless", task, "--role", role, "--prompt-file", prompt);
			assert.equal(r.status, 0, r.stderr);
			const json = JSON.parse(evf(f.root, {}, "", "usage", "--json", task).stdout);
			const [row] = json.tasks[0].by_role_model;
			assert.equal(json.tasks[0].task, task);
			assert.equal(row.role, role);
			assert.equal(row.model, OPUS);
			assert.equal(row.input, 1000);
			assert.equal(row.output, 100);
			assert.equal(row.cost_estimate_usd, 0.006);
			assert.match(
				evf(f.root, {}, "", "usage", task).stdout,
				new RegExp(`${role} on ${OPUS}: input 1,000, output 100, cache read 0, cache write 0, \\$0\\.01 estimate`),
			);
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-134-3 coordinator.md, evf help and the README give the headless route", () => {
	const form = "evf headless <task> --role coordinator|registration --prompt-file <file>";
	const role = readFileSync(join(source, ".agents/roles/coordinator.md"), "utf8");
	assert.ok(role.includes(`bin/${form}`), "the role file gives the command form");
	assert.match(role, /`claude -p` session starts with `bin\/evf headless`/);
	const help = spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "help"], { encoding: "utf8" }).stdout;
	assert.ok(help.includes(form));
	assert.ok(readFileSync(join(source, "tools/evf/README.md"), "utf8").includes(form));
});

/** A Herdr for the watch loop. `waits` are the `agent wait` answers; after the last one the seat closes its run. */
function watchHerdr(f: Fixture, run: number, script: { waits: string[]; promptFails?: boolean; keepOpen?: boolean }) {
	const calls = join(f.root, "herdr-calls.json"),
		state = join(f.root, "herdr-script.json");
	writeFileSync(calls, "[]");
	writeFileSync(state, JSON.stringify(script));
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			`const st=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));let r={};\n` +
			`if(a[0]==="agent"&&a[1]==="prompt"&&st.promptFails&&!a.includes("--wait")){process.stderr.write("fixture: send failed");process.exit(1)}\n` +
			`if(a[0]==="agent"&&a[1]==="wait"){let s=st.waits.shift();fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(st));\n` +
			`if(s===undefined&&st.keepOpen)s="working";\n` +
			`if(s===undefined){const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(workDbPath(f.root))});d.exec("PRAGMA busy_timeout = 5000");d.prepare("UPDATE runs SET status='passed' WHERE id = ?").run(${run});d.close();s="idle"}\n` +
			`r={agent:{agent_status:s}}}\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_status:"working"}};\n` +
			`process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
	const read = () => JSON.parse(readFileSync(calls, "utf8")) as string[][];
	return {
		calls: read,
		longNudges: () => read().filter((c) => c[0] === "agent" && c[1] === "prompt" && /Long run check/.test(c[3] ?? "")),
		notifications: () => read().filter((c) => c[0] === "notification"),
		setScript: (s: object) => writeFileSync(state, JSON.stringify(s)),
	};
}

const TIMING = { waitMs: 60_000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 5, startGraceMs: 10 };
const WORKING = ["working", "working", "working"];
/** The fake present: a day after the fixture's real commit, so that commit is old unless a test makes a newer one. */
const NOW = Date.now() + 24 * 60 * MIN;
/** One open check call since the start of the run. */
const longCheck = (start: number) => [
	promptLine(start),
	toolCallLine(start + 1000, "c1", "Bash", { command: "bin/evf verify OPS-1" }),
];
function seat(f: Fixture, elapsedMin: number, lines: string[] | null, now = NOW) {
	const start = now - elapsedMin * MIN;
	const run = f.insertRun("implement", "implementer", "started", start, SESSION);
	f.db
		.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = 'w9:p1' WHERE id = ?")
		.run(`implementer-ops-1-${run}`, run);
	if (lines) f.transcript(lines);
	return { run, start };
}
const commitAt = (f: Fixture, ms: number) =>
	spawnSync("git", ["-C", f.wt, "commit", "-q", "--allow-empty", "-m", "work"], {
		encoding: "utf8",
		env: { ...process.env, GIT_COMMITTER_DATE: new Date(ms).toISOString() },
	});

test("AC:OPS-134-4 a working seat at 60 min that meets the rule gets one nudge, also across drives; the near misses get none", () => {
	const f = store();
	try {
		const { run } = seat(f, 60, longCheck(NOW - 60 * MIN));
		const h = watchHerdr(f, run, { waits: [...WORKING] });
		// The clock moves two minutes per reading, so later polls read the transcript again and still do not nudge.
		let later = NOW;
		driveOnce(f.root, f.task, { ...TIMING, clock: () => (later += 2 * MIN) - 2 * MIN });
		assert.equal(h.longNudges().length, 1, "one nudge over several polls");
		assert.equal(f.events("long_run_nudge").length, 1);
		// A new drive process: the seat is open again and only the store remembers the nudge.
		f.db.prepare("UPDATE runs SET status = 'started' WHERE id = ?").run(run);
		h.setScript({ waits: [...WORKING] });
		driveOnce(f.root, f.task, { ...TIMING, clock: () => (later += 2 * MIN) });
		assert.equal(h.longNudges().length, 1, "no second nudge after a new drive process");
		// The near misses, on a clean store. Each case replaces the run before it.
		const nudges = (elapsedMin: number, lines: string[]) => {
			f.db.exec("DELETE FROM events; DELETE FROM runs");
			const { run: id } = seat(f, elapsedMin, lines);
			const quiet = watchHerdr(f, id, { waits: [...WORKING] });
			driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW });
			assert.equal(f.events("long_run_nudge").length, quiet.longNudges().length);
			return quiet.longNudges().length;
		};
		assert.equal(nudges(59, longCheck(NOW - 59 * MIN)), 0, "a run at 59 min");
		// 70 of 100 minutes in a check, then 30 of model time: exactly 70%.
		const split = (checkMin: number) => {
			const s = NOW - 100 * MIN;
			return [
				promptLine(s),
				toolCallLine(s, "c1", "Bash", { command: "bin/evf check OPS-1" }),
				toolDoneLine(s + checkMin * MIN, "c1"),
			];
		};
		assert.equal(nudges(100, split(70)), 0, "a run at exactly 70%");
		assert.equal(nudges(100, split(71)), 1, "the control: 71% is over the line");
		commitAt(f, NOW - 10 * MIN);
		assert.equal(nudges(60, longCheck(NOW - 60 * MIN)), 0, "a run with a commit in the last 60 min");
	} finally {
		f.close();
	}
});

test("AC:OPS-134-5 a run open at 120 min gives one notice with the split in event, notification and status, also with recent commits", () => {
	const f = store();
	try {
		commitAt(f, NOW - 5 * MIN);
		const s = NOW - 120 * MIN;
		// Model 30, tool 30, check 30, wait 30: an open sleep ends the window.
		const { run } = seat(f, 120, [
			promptLine(s),
			toolCallLine(s + 30 * MIN, "a", "Read"),
			toolDoneLine(s + 60 * MIN, "a"),
			toolCallLine(s + 60 * MIN, "b", "Bash", { command: "bin/evf test" }),
			toolDoneLine(s + 90 * MIN, "b"),
			toolCallLine(s + 90 * MIN, "c", "Bash", { command: "sleep 1800" }),
		]);
		const h = watchHerdr(f, run, { waits: [...WORKING] });
		driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW });
		f.db.prepare("UPDATE runs SET status = 'started' WHERE id = ?").run(run);
		h.setScript({ waits: [...WORKING] });
		driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW + 5 * MIN });
		const split = "model 30 min (25%), tool 30 min (25%), check 30 min (25%), wait 30 min (25%)";
		const [notice, ...more] = f.events("long_run_notice");
		assert.equal(more.length, 0, "one notice across two drives");
		assert.equal(h.notifications().length, 1);
		assert.equal(notice!.elapsedMin, 120);
		assert.ok(notice!.summary.includes("120 min") && notice!.summary.includes(split));
		const body = h.notifications()[0]!;
		assert.ok(body[body.indexOf("--body") + 1]!.includes("120 min"));
		assert.ok(body[body.indexOf("--body") + 1]!.includes(split));
		const status = evf(f.root, {}, "", "status", "OPS-1").stdout;
		const line = status.split("\n").find((l) => l.includes("long_run_notice"))!;
		assert.ok(line.includes("120 min") && line.includes(split), line);
	} finally {
		f.close();
	}
});

test("AC:OPS-134-6 the check ends nothing: run, pane and task stay as they are, and the idle and wait rules still act", () => {
	const f = store();
	try {
		const { run } = seat(f, 130, longCheck(NOW - 130 * MIN));
		const h = watchHerdr(f, run, { waits: [...WORKING, ...WORKING] });
		const before = f.db.prepare("SELECT status, round FROM tasks WHERE id = ?").get(f.taskId);
		const seen: unknown[] = [];
		let ticks = 0;
		driveOnce(f.root, f.task, {
			...TIMING,
			clock: () => {
				// Read while the seat is watched, after the first check has sent both messages.
				if (++ticks > 2)
					seen.push(
						(f.db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status,
						f.db.prepare("SELECT status, round FROM tasks WHERE id = ?").get(f.taskId),
					);
				return NOW + ticks * 2 * MIN;
			},
		});
		assert.equal(f.events("long_run_nudge").length, 1);
		assert.equal(f.events("long_run_notice").length, 1);
		assert.ok(seen.length >= 2, "the clock was read after both messages");
		for (let i = 0; i < seen.length; i += 2) {
			assert.equal(seen[i], "started");
			assert.deepEqual(seen[i + 1], before);
		}
		assert.deepEqual(
			h.calls().filter((c) => c[1] === "close" || c[0] === "pane"),
			[],
			"no pane or workspace is closed",
		);
		assert.equal(f.events("escalation").length, 0);
		assert.equal(f.events("nudge").length, 0, "the close nudge is another rule");
		const code = readFileSync(join(source, "tools/evf/long-run.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
		assert.doesNotMatch(code, /runDone|closeRunPane|abortGoneSeat|escalate|UPDATE |taskAbandon|fail\(/);
	} finally {
		f.close();
	}
	// The wait limit still closes a seat that never stops working, whatever the check did before it.
	const g = store();
	try {
		const { run } = seat(g, 130, longCheck(NOW - 130 * MIN));
		watchHerdr(g, run, { waits: [], keepOpen: true });
		driveOnce(g.root, g.task, { ...TIMING, waitMs: 1500, clock: () => NOW });
		const closed = g.db.prepare("SELECT status, summary FROM runs WHERE id = ?").get(run) as Record<string, string>;
		assert.equal(closed.status, "failed");
		assert.match(closed.summary!, /timed out/);
		assert.equal(g.events("long_run_notice").length, 1);
	} finally {
		g.close();
	}
});

test("AC:OPS-134-7 the logic stays in evf: the same four hook events, each routed to bin/evf hook, and no second hook file", () => {
	const settings = JSON.parse(readFileSync(join(source, ".claude/settings.json"), "utf8"));
	assert.deepEqual(Object.keys(settings.hooks).sort(), ["PreToolUse", "SessionEnd", "SessionStart", "Stop"]);
	const commands = Object.values(
		settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
	).flatMap((entries) => entries.flatMap((e) => e.hooks.map((h) => h.command)));
	assert.deepEqual(commands.sort(), [
		'"$CLAUDE_PROJECT_DIR"/bin/evf hook path-guard',
		'"$CLAUDE_PROJECT_DIR"/bin/evf hook read-guard',
		'"$CLAUDE_PROJECT_DIR"/bin/evf hook session-end',
		'"$CLAUDE_PROJECT_DIR"/bin/evf hook session-start',
		'"$CLAUDE_PROJECT_DIR"/bin/evf hook stop',
	]);
	const files = spawnSync("git", ["-C", source, "ls-files"], { encoding: "utf8" }).stdout.split("\n");
	assert.deepEqual(
		files.filter((p) => /^(\.claude|\.codex|\.cursor|\.gemini|\.husky)\/hooks?\//.test(p) || /hooks\.json$/.test(p)),
		[],
	);
});

test("AC:OPS-134-8 the durations are a partition: each class, each wrapper, and overlaps counted once with check over wait over tool", () => {
	const bash = (command: string) => oneCall("Bash", { command });
	for (const command of [
		"evf verify OPS-1",
		"bin/evf check OPS-1",
		"bin/evf test",
		"bin/evf ac run OPS-1",
		"bin/evf timing run x",
		"bin/evf browser run -- node x.mjs",
		"EVF_FOREGROUND=1 bin/evf verify OPS-1",
		"cd x && bin/evf verify OPS-1",
		'cd x && EVF_MONITOR="a b" /abs/bin/evf test',
		"if true; then bin/evf verify OPS-1; fi",
	]) {
		const t = bash(command);
		assert.deepEqual([t.toolMs, t.checkMs, t.waitMs, t.modelMs], [0, 2000, 0, 4000], command);
	}
	for (const command of [
		"sleep 30",
		"herdr agent wait w1 --until idle",
		"gh pr checks 12 --watch",
		"gh run watch 99",
		"cd x && sleep 3",
		"/bin/sleep 3",
		"until grep -q done log; do sleep 5; done",
		"for i in 1 2; do /bin/sleep 10; done",
	]) {
		const t = bash(command);
		assert.deepEqual([t.toolMs, t.checkMs, t.waitMs, t.modelMs], [0, 0, 2000, 4000], command);
	}
	const monitor = oneCall("Monitor", { until: "x" });
	assert.deepEqual([monitor.toolMs, monitor.checkMs, monitor.waitMs, monitor.modelMs], [0, 0, 2000, 4000]);
	for (const [name, input] of [
		["Read", { file_path: "/x" }],
		["Agent", { prompt: "sleep 5" }],
		["Bash", { command: "git status" }],
		["Bash", { command: "gh pr checks 12" }],
		["Bash", { command: 'git commit -m "sleep && bin/evf verify"' }],
		["Bash", { command: "cat <<EOF\nsleep 9\nEOF" }],
		["Bash", { command: "grep evf README.md" }],
		["Bash", { command: "for f in a b; do cat $f; done" }],
		["Bash", { command: "bin/evf proof show OPS-1" }],
	] as const) {
		const t = oneCall(name, input);
		assert.deepEqual([t.toolMs, t.checkMs, t.waitMs, t.modelMs], [2000, 0, 0, 4000], JSON.stringify(input));
	}
	// Tool 0-10, wait 2-8, check 4-6, then a second tool 12-14: check 2, wait 4, tool 4 + 2, model the rest.
	const s = T0;
	const t = turnOf(
		parseEntries([
			promptLine(s),
			toolCallLine(s, "tool", "Read"),
			toolCallLine(s + 2000, "wait", "Bash", { command: "sleep 6" }),
			toolCallLine(s + 4000, "check", "Bash", { command: "bin/evf verify OPS-1" }),
			toolDoneLine(s + 6000, "check"),
			toolDoneLine(s + 8000, "wait"),
			toolDoneLine(s + 10_000, "tool"),
			toolCallLine(s + 12_000, "next", "Read"),
			toolDoneLine(s + 14_000, "next"),
			endTurnLine(s + 15_000),
		]),
		null,
	)!;
	assert.deepEqual([t.checkMs, t.waitMs, t.toolMs, t.modelMs], [2000, 4000, 6000, 3000]);
	assert.equal(t.toolMs + t.checkMs + t.waitMs + t.modelMs, t.endedAt - t.startedAt);
});

test("AC:OPS-134-9 a missing or garbled transcript leaves the stop hook as it was; no EVF_RUN writes nothing; a continuation gets its own turn", () => {
	const f = store();
	try {
		const run = f.insertRun("implement", "implementer", "started", T0, SESSION);
		const missing = stopHook(f, run, {}, { EVF_STAGE: "implement" });
		assert.equal(missing.status, 0, missing.stderr);
		assert.equal(JSON.parse(missing.stdout).decision, "block");
		assert.equal(f.events("stop").length, 1);
		assert.equal(f.events("turn_end").length, 0);
		f.transcript(["{not json", "\u0000\u0001 garbage"]);
		const bad = stopHook(f, run, { stop_hook_active: true }, { EVF_STAGE: "implement" });
		assert.equal(bad.status, 0, bad.stderr);
		assert.equal(bad.stdout, "");
		assert.equal(f.events("stop").length, 2);
		assert.equal(f.events("turn_end").length, 0);
		// A directory cannot be read as a file: an error, caught.
		rmSync(f.transcriptFile());
		mkdirSync(f.transcriptFile());
		const unreadable = stopHook(f, run, {}, { EVF_STAGE: "implement" });
		assert.equal(unreadable.status, 0, unreadable.stderr);
		assert.equal(JSON.parse(unreadable.stdout).decision, "block");
		assert.equal(f.events("turn_end").length, 0);
		rmSync(f.transcriptFile(), { recursive: true });

		f.transcript([
			promptLine(T0),
			toolCallLine(T0 + 1000, "x", "Read"),
			toolDoneLine(T0 + 2000, "x"),
			endTurnLine(T0 + 3000),
		]);
		assert.equal(stopHook(f, run, {}).status, 0);
		// The Stop hook's feedback goes in as a meta user entry; the model answers it and stops again.
		f.transcript([
			promptLine(T0),
			toolCallLine(T0 + 1000, "x", "Read"),
			toolDoneLine(T0 + 2000, "x"),
			endTurnLine(T0 + 3000),
			promptLine(T0 + 4000, true),
			toolCallLine(T0 + 5000, "y", "Bash", { command: "bin/evf test" }),
			toolDoneLine(T0 + 7000, "y"),
			endTurnLine(T0 + 8000),
		]);
		assert.equal(stopHook(f, run, { stop_hook_active: true }).status, 0);
		const turns = f.events("turn_end");
		assert.equal(turns.length, 2);
		assert.equal(turns[1]!.startedAt, turns[0]!.endedAt, "the continuation starts at the previous endedAt");
		assert.equal(turns[1]!.endedAt, new Date(T0 + 8000).toISOString());
		assert.deepEqual([turns[1]!.checkMs, turns[1]!.toolMs, turns[1]!.modelMs], [2000, 0, 3000]);

		// Outside a seat: no store is even opened.
		const empty = mkdtempSync(join(tmpdir(), "evf-plain-"));
		const plain = spawnSync("git", ["init", "-q", empty]);
		assert.equal(plain.status, 0);
		const outside = evf(empty, {}, JSON.stringify({ session_id: SESSION }), "hook", "stop");
		assert.equal(outside.status, 0, outside.stderr);
		assert.equal(outside.stdout, "");
		assert.ok(!existsSync(workDbPath(empty)), "a session with no EVF_RUN writes nothing");
		rmSync(empty, { recursive: true, force: true });
		const count = () => (f.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
		const n = count();
		assert.equal(evf(f.root, {}, JSON.stringify({ session_id: SESSION }), "hook", "stop").status, 0);
		assert.equal(count(), n, "no EVF_RUN in a repo with a store: no event either");
	} finally {
		f.close();
	}
});

test("AC:OPS-134-10 evf headless inserts one run, passes stdout and the exit code through, and sets the final status over the hook", () => {
	const f = store();
	try {
		const prompt = fakeClaude(f);
		const row = () =>
			f.db
				.prepare(
					"SELECT id, stage, role, model, effort, session_id, status, ended_at, tokens_in FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1",
				)
				.get(f.taskId) as Record<string, any>;
		const count = () =>
			(f.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(f.taskId) as { n: number }).n;
		const ok = evf(
			f.root,
			{ EVF_STAGE: "implement" },
			"",
			"headless",
			"OPS-1",
			"--role",
			"coordinator",
			"--prompt-file",
			prompt,
		);
		assert.equal(ok.status, 0, ok.stderr);
		assert.equal(count(), 1, "one row");
		const out = JSON.parse(ok.stdout);
		const r = row();
		assert.deepEqual(
			[r.stage, r.role, r.model, r.effort, r.status, r.tokens_in],
			["coordinator", "coordinator", OPUS, "medium", "passed", 1000],
			"defaults, the final status over the aborting hook, usage filled",
		);
		assert.ok(r.ended_at);
		assert.equal(out.args[out.args.indexOf("--session-id") + 1], r.session_id);
		assert.ok(out.args.includes("-p"));
		assert.equal(out.args[out.args.indexOf("--model") + 1], OPUS);
		assert.equal(out.args[out.args.indexOf("--effort") + 1], "medium");
		assert.equal(out.prompt, "Do the coordinator work.\n");
		assert.equal(out.run, String(r.id));
		assert.equal(out.role, "coordinator");
		assert.equal(out.stage, null, "no EVF_STAGE, even when the caller has one");
		assert.equal(f.events("session_end").length, 1, "the session-end hook ran");

		const failed = evf(
			f.root,
			{ FAKE_CLAUDE_EXIT: "7" },
			"",
			"headless",
			"OPS-1",
			"--role",
			"registration",
			"--prompt-file",
			prompt,
			"--model",
			SONNET,
			"--effort",
			"low",
		);
		assert.equal(failed.status, 7, "the exit code comes through");
		const last = row();
		assert.deepEqual([last.role, last.model, last.effort, last.status], ["registration", SONNET, "low", "failed"]);

		const n = count();
		for (const role of ["implementer", "verifier", "nobody"]) {
			const refused = evf(f.root, {}, "", "headless", "OPS-1", "--role", role, "--prompt-file", prompt);
			assert.notEqual(refused.status, 0, role);
			assert.match(refused.stderr, /coordinator, registration/);
		}
		assert.equal(count(), n, "a refused role inserts nothing");
		const launch = evf(f.root, {}, "", "launch", "OPS-1", "--role", "coordinator", "--dry-run");
		assert.notEqual(launch.status, 0);
		assert.match(launch.stderr, /--role must be one of/);
	} finally {
		f.close();
	}
});

test("AC:OPS-134-11 coordinator and registration runs change nothing in the stage machine and have their own usage group", () => {
	const next = (f: Fixture) => JSON.parse(evf(f.root, {}, "", "next", "OPS-1").stdout);
	const f = store();
	try {
		const failures = (n: number) => {
			for (let i = 0; i < n; i++) f.insertRun("implement", "implementer", "failed", T0 + i * 1000);
		};
		for (const status of ["started", "passed", "failed"]) {
			const role = status === "passed" ? "registration" : "coordinator";
			f.db.exec("DELETE FROM runs");
			// Two failures: one more would escalate, so a counted failure, a reset or a held seat all show.
			failures(2);
			const base = next(f);
			const extra = f.insertRun(role, role, status, T0 + 5000);
			assert.deepEqual(next(f), base, `${role} ${status} with two failures`);
			failures(1);
			const three = next(f);
			assert.equal(three.stage, "escalated", `${role} ${status}: no reset, no count, no held-back wait`);
			f.db.prepare("DELETE FROM runs WHERE id = ?").run(extra);
			assert.deepEqual(next(f), three, "the same answer with no such run");
		}
		f.db.exec("DELETE FROM runs");
		// The circuit breaker: two closes at one fingerprint trip it, a headless run with a fingerprint between does not count.
		const closed = (stage: string, role: string, head: string) => {
			const id = f.insertRun(stage, role, "failed", T0 + 1000);
			f.db.prepare("UPDATE runs SET progress_head = ?, progress_spec = 's' WHERE id = ?").run(head, id);
		};
		closed("coordinator", "coordinator", "h1");
		closed("coordinator", "coordinator", "h1");
		assert.notEqual(next(f).stage, "escalated", "no breaker on headless rows");
		// A started headless run does not hold an evf-side view of a working seat either.
		f.db.exec("UPDATE runs SET status = 'started'");
		const open = next(f);
		assert.notEqual(open.stage, "waiting", "a held-back escalation does not wait for it");
		f.db.exec("DELETE FROM runs");
		const prompt = fakeClaude(f);
		assert.equal(evf(f.root, {}, "", "headless", "OPS-1", "--role", "coordinator", "--prompt-file", prompt).status, 0);
		assert.equal(evf(f.root, {}, "", "headless", "OPS-1", "--role", "registration", "--prompt-file", prompt).status, 0);
		const { by_model } = JSON.parse(evf(f.root, {}, "", "usage", "--json").stdout);
		const groups = by_model.find((m: { model: string }) => m.model === OPUS).groups;
		assert.equal(groups.coordination.runs, 2);
		assert.equal(groups.coordination.input, 2000);
		for (const name of ["build", "review", "prototype"]) assert.equal(groups[name].runs, 0, name);
		assert.match(evf(f.root, {}, "", "usage").stdout, /coordinator and registration: input 2,000/);
	} finally {
		f.close();
	}
});

test("AC:OPS-134-12 the run split reads the live transcript: an open call runs to now, time outside turns is wait, elapsed is from the run start", () => {
	const s = T0;
	// Pure: 10 min before the first prompt and 20 min after the end of the turn count as wait.
	const entries = parseEntries([
		promptLine(s + 10 * MIN),
		toolCallLine(s + 15 * MIN, "a", "Read"),
		toolDoneLine(s + 20 * MIN, "a"),
		endTurnLine(s + 30 * MIN),
	]);
	assert.deepEqual(runSplit(entries, s, s + 50 * MIN), {
		toolMs: 5 * MIN,
		checkMs: 0,
		waitMs: 30 * MIN,
		modelMs: 15 * MIN,
	});
	// The next prompt ends the gap: its 5 minutes count too, and a call with no result runs to the present.
	const live = parseEntries([
		promptLine(s),
		endTurnLine(s + 10 * MIN),
		promptLine(s + 15 * MIN),
		toolCallLine(s + 15 * MIN, "c", "Bash", { command: "bin/evf verify OPS-1" }),
	]);
	assert.deepEqual(runSplit(live, s, s + 75 * MIN), {
		toolMs: 0,
		checkMs: 60 * MIN,
		waitMs: 5 * MIN,
		modelMs: 10 * MIN,
	});
	const f = store();
	try {
		// One long turn, no turn_end in the store, a transcript that began before the run: the window starts at started_at.
		const start = NOW - 80 * MIN;
		const { run } = seat(f, 80, [
			promptLine(start - 30 * MIN),
			endTurnLine(start - 20 * MIN),
			promptLine(start),
			toolCallLine(start + MIN, "z", "Bash", { command: "bin/evf verify OPS-1" }),
		]);
		const h = watchHerdr(f, run, { waits: [...WORKING] });
		driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW });
		assert.equal(f.events("turn_end").length, 0);
		assert.equal(h.longNudges().length, 1, "one long turn gets the nudge");
		const [nudge] = f.events("long_run_nudge");
		assert.equal(nudge!.split.checkMs, 79 * MIN);
		assert.equal(nudge!.split.modelMs, MIN);
		assert.equal(nudge!.elapsedMin, 80);
	} finally {
		f.close();
	}
});

test("AC:OPS-134-13 the nudge does not block or replace the close nudge, holds the split, and a failed send is recorded once", () => {
	const f = store();
	try {
		const { run } = seat(f, 61, longCheck(NOW - 61 * MIN));
		// The seat works, then goes idle twice without closing.
		const h = watchHerdr(f, run, { waits: ["working", "idle", "idle"] });
		driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW });
		const prompts = h.calls().filter((c) => c[0] === "agent" && c[1] === "prompt");
		assert.equal(prompts.length, 2, "the long run nudge and the one close nudge");
		const [long, close] = prompts as [string[], string[]];
		assert.deepEqual(long.slice(4), [], "no --wait, and no --timeout: the real Herdr refuses --timeout without --wait");
		assert.match(long[3]!, /61 min/);
		assert.match(long[3]!, /check 61 min \(100%\)/);
		assert.match(long[3]!, /Act on this split/);
		assert.doesNotMatch(long[3]!, /close|run done/i, "it does not tell the seat to close");
		assert.match(close[3]!, /Close your stage now/);
		assert.ok(close.includes("--wait"));
		assert.equal(f.events("long_run_nudge")[0]!.delivered, true);
		assert.equal(f.events("nudge").length, 1);
		assert.equal(
			(f.db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status,
			"failed",
			"the idle rule still closes it",
		);
	} finally {
		f.close();
	}
	const g = store();
	try {
		const { run } = seat(g, 61, longCheck(NOW - 61 * MIN));
		const h = watchHerdr(g, run, { waits: [...WORKING], promptFails: true });
		let later = NOW;
		driveOnce(g.root, g.task, { ...TIMING, clock: () => (later += 2 * MIN) - 2 * MIN });
		assert.equal(h.longNudges().length, 1, "a failed send does not retry on the later polls");
		const events = g.events("long_run_nudge");
		assert.equal(events.length, 1);
		assert.equal(events[0]!.delivered, false);
		assert.equal(
			(g.db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status,
			"passed",
			"the drive went on to the end of the watch",
		);
	} finally {
		g.close();
	}
});

test("AC:OPS-134-14 a missing or unreadable transcript gets no nudge and no failure, and its notice says the split is not available", () => {
	for (const lines of [null, ["{not json", "more garbage"]]) {
		const f = store();
		try {
			const { run } = seat(f, 125, lines);
			const h = watchHerdr(f, run, { waits: [...WORKING] });
			driveOnce(f.root, f.task, { ...TIMING, clock: () => NOW });
			assert.equal(h.longNudges().length, 0);
			assert.equal(f.events("long_run_nudge").length, 0);
			const [notice, ...more] = f.events("long_run_notice");
			assert.equal(more.length, 0);
			assert.match(notice!.summary, /125 min/);
			assert.match(notice!.summary, /split is not available/);
			assert.equal(notice!.split, null);
			const shown = h.notifications()[0]!;
			assert.match(shown[shown.indexOf("--body") + 1]!, /split is not available/);
			assert.equal(
				(f.db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status,
				"passed",
			);
		} finally {
			f.close();
		}
	}
});
