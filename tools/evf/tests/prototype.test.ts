import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, sessionStartJs, source } from "./fixtures.ts";
import { openWorkDb, syncGoals, workDbPath } from "../db.ts";
import { driveOnce, runDone } from "../drive.ts";
import { parseTask } from "../lib.ts";

const cli = (cwd: string, env: Record<string, string>, input: unknown, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			EVF_RUN: "",
			EVF_WORKTREE: "",
			EVF_SESSION: "",
			EVF_ROLE: "",
			EVF_STAGE: "",
			EVF_BLIND: "",
			EVF_RUNTIME: "",
			...env,
		},
		input: input === undefined ? "" : JSON.stringify(input),
	});
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 150 };
const SPEC =
	"Goal: a doghouse people like.\nAngle 1: a plain kennel.\nAngle 2: a kennel with a porch.\nAngle 3: a two-room kennel.\nDone criteria:\n1. The dog fits.\n2. One screenshot per idea.\nNon-goals: lighting.";
const HANDOFF =
	"Goal: build the porch kennel.\nDone criteria:\n1. The dog fits.\n2. The porch keeps rain off the door.\nNon-goals: lighting.\nApproach: idea 2 proved the porch; drop the second room.";

function protoFixture() {
	const f = fixture(),
		task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Proto", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const calls = join(f.root, "herdr-calls.json");
	writeFileSync(calls, "[]");
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			sessionStartJs(workDbPath(f.root), "null") +
			`let r={};if(a[0]==="workspace"&&a[1]==="create")r={workspace:"w"+calls.length,tab:"t",root_pane:{pane_id:"p"+calls.length}};\n` +
			`else if(a[0]==="pane"&&a[1]==="process-info")r={process_info:{shell_pid:7,foreground_process_group_id:7}};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:"idle"}};\nelse if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_status:"working"}};\nprocess.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const file = (name: string, text: string) => {
		const path = join(f.root, "fake-bin", name);
		writeFileSync(path, text);
		return path;
	};
	const herdrCalls = () => JSON.parse(readFileSync(calls, "utf8")) as string[][];
	const runs = () =>
		db.prepare("SELECT id, stage, role, status FROM runs ORDER BY id").all() as Array<{
			id: number;
			stage: string;
			role: string;
			status: string;
		}>;
	const tasks = () =>
		db.prepare("SELECT id, mode, status, spec FROM tasks ORDER BY id").all() as Array<{
			id: number;
			mode: string;
			status: string;
			spec: string | null;
		}>;
	const nextOf = () =>
		JSON.parse(cli(f.root, {}, undefined, "next", "OPS-1").stdout) as {
			stage: string;
			role?: string;
			idea?: number;
			reason: string;
		};
	const closeRun = (id: number, status: "passed" | "failed" = "passed") =>
		runDone(f.root, id, { status, summary: `${status} ${id}` });
	return { ...f, task, db, file, herdrCalls, runs, tasks, nextOf, closeRun };
}

test("OPS-60-prototype: plan with angles, three blind idea seats in their own worktrees, compare, Sebastian's pick, merge and handoff", () => {
	const f = protoFixture();
	try {
		const made = cli(
			f.root,
			{},
			undefined,
			"task",
			"new",
			"OPS-1",
			"--mode",
			"prototype",
			"--ask-file",
			f.file("brief.md", "Explore doghouse layouts."),
		);
		assert.equal(made.status, 0, made.stderr);
		assert.match(
			cli(f.root, {}, undefined, "task", "new", "OPS-1", "--mode", "implement", "--ask-file", f.file("b2.md", "x"))
				.stderr,
			/already has an open prototype task/,
		);
		assert.deepEqual(f.nextOf(), { stage: "plan", role: "planner", round: 0, reason: "no spec yet" });

		// Plan: an Opus planner stores the spec with the three angles.
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "plan");
		const plan = f.runs()[0]!;
		assert.equal(plan.role, "planner");
		assert.match(f.herdrCalls().find((c) => c[1] === "prompt")![3]!, /"Angle 1:", "Angle 2:" and "Angle 3:"/);
		assert.equal(cli(f.root, {}, undefined, "task", "spec", "OPS-1", "--file", f.file("spec.md", SPEC)).status, 0);
		f.closeRun(plan.id);
		assert.deepEqual(f.nextOf(), { stage: "idea", role: "ideator", idea: 1, round: 0, reason: "idea 1 not started" });

		// Ideas: three launches, three worktrees, three branches, blind seats.
		for (let i = 1; i <= 3; i++) {
			const n = driveOnce(f.root, f.task, TIMING);
			assert.equal(n.stage, "idea");
			assert.equal(n.idea, i);
			const wt = join(f.root, `.worktrees/ops-1-idea${i}`);
			assert.ok(existsSync(join(wt, ".git")), `idea ${i} worktree`);
			assert.equal(
				spawnSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).stdout.trim(),
				`task/ops-1-idea${i}`,
			);
		}
		const ideaRuns = f.runs().filter((r) => r.role === "ideator");
		assert.deepEqual(
			ideaRuns.map((r) => r.stage),
			["idea1", "idea2", "idea3"],
		);
		const workspaces = f.herdrCalls().filter((c) => c[0] === "workspace" && c[1] === "create");
		assert.ok(
			workspaces.some((c) => c.includes("ops-1-idea2") && c.includes("EVF_BLIND=1") && c.includes("EVF_IDEA=2")),
			"idea seats are blind and numbered",
		);
		const prompts = f
			.herdrCalls()
			.filter((c) => c[1] === "prompt")
			.map((c) => c[3]!);
		assert.match(
			prompts.find((p) => /Build idea 2 /.test(p))!,
			/Your angle: a kennel with a porch\./,
		);
		assert.equal(f.nextOf().stage, "waiting");
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "waiting");
		assert.equal(
			f.runs().filter((r) => r.role === "ideator" && r.status === "failed").length,
			1,
			"an idle idea seat that never closes is aborted",
		);
		assert.deepEqual(f.nextOf(), { stage: "idea", role: "ideator", idea: 1, round: 0, reason: "idea 1 failed" });
		assert.equal(driveOnce(f.root, f.task, TIMING).idea, 1, "a failed idea relaunches");
		for (const r of f.runs().filter((r) => r.role === "ideator" && r.status === "started")) f.closeRun(r.id);
		assert.deepEqual(f.nextOf(), { stage: "compare", role: "comparer", round: 0, reason: "all ideas built" });

		// Compare: one seat reads all three and writes to the runtime dir, which the path guard allows.
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "compare");
		const compareWs = f
			.herdrCalls()
			.filter((c) => c[0] === "workspace" && c[1] === "create")
			.at(-1)!;
		const runtime = compareWs.find((a) => a.startsWith("EVF_RUNTIME="))!.slice("EVF_RUNTIME=".length);
		assert.match(
			prompts
				.concat(
					f
						.herdrCalls()
						.filter((c) => c[1] === "prompt")
						.map((c) => c[3]!),
				)
				.at(-1)!,
			/Idea worktrees: .*ops-1-idea1.*ops-1-idea3.*comparison/,
		);
		const guard = cli(
			f.root,
			{ EVF_WORKTREE: join(f.root, ".worktrees/ops-1"), EVF_RUNTIME: runtime },
			{ tool_name: "Write", tool_input: { file_path: join(runtime, "comparison/compare.html") }, cwd: f.root },
			"hook",
			"path-guard",
		);
		assert.equal(guard.stdout, "", "the comparer may write into the runtime dir");
		f.closeRun(f.runs().at(-1)!.id);

		// Pick: the task waits for Sebastian; the drive loop stops; the pick records his words.
		assert.equal(f.nextOf().stage, "pick");
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "pick");
		assert.equal(f.tasks()[0]!.status, "awaiting_pick");
		assert.ok(f.herdrCalls().some((c) => c[0] === "notification" && /ready to pick/.test(c[2] ?? "")));
		assert.equal(cli(f.root, {}, undefined, "drive", "OPS-1").status, 0, "drive exits while the pick is pending");
		assert.match(cli(f.root, {}, undefined, "task", "pick", "OPS-1", "2").stderr, /Quote Sebastian/);
		const compareRun = f.runs().find((r) => r.stage === "compare")!;
		const seatPick = cli(
			f.root,
			{ EVF_RUN: String(compareRun.id), EVF_ROLE: "comparer" },
			undefined,
			...["task", "pick", "OPS-1", "2", "--owner-approval", "Sebastian likes two"],
		);
		assert.equal(seatPick.status, 1);
		assert.match(seatPick.stderr, /a seat cannot run evf task pick/);
		assert.equal(f.tasks()[0]!.status, "awaiting_pick", "a seat's pick records nothing");
		assert.match(
			cli(f.root, {}, undefined, "task", "handoff", "OPS-1", "--file", f.file("h.md", HANDOFF)).stderr,
			/no pick yet/,
		);
		const picked = cli(
			f.root,
			{},
			undefined,
			"task",
			"pick",
			"OPS-1",
			"2",
			"--owner-approval",
			"Go with the porch one",
		);
		assert.equal(picked.status, 0, picked.stderr);
		assert.deepEqual(f.nextOf(), { stage: "merge", role: "prototype-merger", round: 0, reason: "idea picked" });

		// Merge: the Opus seat gets the pick and the worktree, and the handoff creates the implement task.
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "merge");
		const mergePrompt = f
			.herdrCalls()
			.filter((c) => c[1] === "prompt")
			.at(-1)![3]!;
		assert.match(mergePrompt, /picked idea 2 .*"Go with the porch one"\. Its worktree: .*ops-1-idea2/);
		const mergeRun = f.runs().at(-1)!;
		assert.equal(mergeRun.role, "prototype-merger");
		const handed = cli(
			f.root,
			{ EVF_RUN: String(mergeRun.id) },
			undefined,
			"task",
			"handoff",
			"OPS-1",
			"--file",
			f.file("handoff.md", HANDOFF),
		);
		assert.equal(handed.status, 0, handed.stderr);
		f.closeRun(mergeRun.id);
		const [proto, impl] = f.tasks();
		assert.equal(proto!.status, "done");
		assert.equal(impl!.mode, "implement");
		assert.equal(impl!.status, "specced");
		assert.match(impl!.spec!, /Approach: idea 2 proved the porch/);
		assert.equal(f.nextOf().stage, "implement", "the implement task takes over the ref with the handoff as its spec");
		assert.equal(JSON.parse(cli(f.root, {}, undefined, "status", "--json").stdout).health.open_tasks, 1);

		// After the implement task merges, the finished prototype stays closed: the ref is free for a new task.
		f.db.prepare("UPDATE tasks SET status = 'merged' WHERE id = ?").run(impl!.id);
		assert.deepEqual(f.nextOf(), { stage: "done", round: 0, reason: "merged" }, "a merge stays done");
		const again = cli(
			f.root,
			{},
			undefined,
			"task",
			"new",
			"OPS-1",
			"--mode",
			"implement",
			"--ask-file",
			f.file("b3.md", "y"),
		);
		assert.equal(again.status, 0, again.stderr);
		assert.equal(f.tasks().length, 3, "a new task row, not the done prototype row");
		assert.equal(f.tasks().at(-1)!.mode, "implement");
		assert.equal(f.nextOf().stage, "plan", "only the explicit reopen makes the ref plan again");
		assert.match(cli(f.root, {}, undefined, "refocus", "OPS-1").stdout, /Task: OPS-1 \(new, round 0 of 3\)/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-60-blind: the read guard confines an idea seat to its worktree and leaves other seats alone", () => {
	const f = protoFixture();
	try {
		const wt = join(f.root, ".worktrees/ops-1-idea1");
		const read = (env: Record<string, string>, tool_input: Record<string, string>, tool_name = "Read") =>
			cli(
				f.root,
				{ EVF_WORKTREE: wt, ...env },
				{ tool_name, tool_input, cwd: wt, hook_event_name: "PreToolUse" },
				"hook",
				"read-guard",
			);
		assert.equal(read({ EVF_BLIND: "1" }, { file_path: join(wt, "IDEA.md") }).stdout, "");
		assert.equal(read({ EVF_BLIND: "1" }, { path: "src" }, "Glob").stdout, "");
		assert.match(
			read({ EVF_BLIND: "1" }, { file_path: join(f.root, ".worktrees/ops-1-idea2/IDEA.md") }).stdout,
			/deny.*reads only its own worktree/,
		);
		assert.match(read({ EVF_BLIND: "1" }, { path: "../ops-1-idea2" }, "Grep").stdout, /deny/);
		assert.equal(read({ EVF_BLIND: "1" }, { pattern: "x" }, "Grep").stdout, "", "a search of the cwd stays inside");
		assert.match(read({ EVF_BLIND: "1" }, { path: "~/anything" }, "Glob").stdout, /deny/, "~ is the home directory");
		assert.match(
			read({ EVF_BLIND: "1" }, { pattern: `${join(f.root, ".worktrees/ops-1-idea2")}/**` }, "Glob").stdout,
			/deny.*ops-1-idea2 is outside/,
			"an absolute pattern is judged by its fixed prefix",
		);
		assert.match(read({ EVF_BLIND: "1" }, { pattern: "../ops-1-idea2/*" }, "Glob").stdout, /deny/);
		assert.match(read({ EVF_BLIND: "1" }, { pattern: "~/x/**/*.ts" }, "Glob").stdout, /deny/);
		assert.equal(
			read({ EVF_BLIND: "1" }, { pattern: "src/**/*.ts" }, "Glob").stdout,
			"",
			"a relative pattern stays inside",
		);
		assert.equal(
			read({ EVF_BLIND: "1" }, { pattern: "a..b/*" }, "Glob").stdout,
			"",
			"dots inside a name are not a parent step",
		);
		for (const pattern of ["/api/users", "/settings", "../lib", "^import .* from '\\.\\./lib'"])
			assert.equal(
				read({ EVF_BLIND: "1" }, { pattern }, "Grep").stdout,
				"",
				`Grep's pattern is a regex, not a path: ${pattern} searches the cwd`,
			);
		assert.match(
			read({ EVF_BLIND: "1" }, { pattern: "/api/users", path: "../ops-1-idea2" }, "Grep").stdout,
			/deny/,
			"Grep is confined by its path",
		);
		assert.equal(
			read({}, { file_path: join(f.root, ".worktrees/ops-1-idea2/IDEA.md") }).stdout,
			"",
			"sighted seats read anywhere",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-72: prototype ideas resume instead of restarting, repeated failures stop at once, the owner can compare the
// passed ideas, coordinator notes reach the seats and an idea cannot pass while it says a criterion is unmet.
const ASK =
	"Coordinator note (Oct 30 2026 3:36 AM ET): the preview pool holds four slots; wait for one.\n\nExplore doghouse layouts.\n\nCoordinator note: rebase after OPS-69.";
function protoTask(ask = "Explore doghouse layouts.") {
	const f = protoFixture();
	const made = cli(f.root, {}, undefined, "task", "new", "OPS-1", "--mode", "prototype", "--ask-file", f.file("ask.md", ask));
	assert.equal(made.status, 0, made.stderr);
	assert.equal(cli(f.root, {}, undefined, "task", "spec", "OPS-1", "--file", f.file("spec.md", SPEC)).status, 0);
	const taskId = f.tasks()[0]!.id;
	const seed = (stage: string, role: string, status: string, summary = "") =>
		Number(
			f.db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at, summary) VALUES (?, ?, ?, 0, ?, ?, ?)",
				)
				.run(taskId, stage, role, status, new Date().toISOString(), summary || null).lastInsertRowid,
		);
	const events = (type: string) =>
		f.db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = ? ORDER BY id").all(taskId, type) as Array<{
			payload: string;
		}>;
	const status = () => (f.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status;
	const failIdea = (idea: number, summary: string) => runDone(f.root, seed(`idea${idea}`, "ideator", "started"), { status: "failed", summary });
	const lastPrompt = () => f.herdrCalls().filter((c) => c[1] === "prompt").at(-1)![3]!;
	return { ...f, seed, events, status, failIdea, lastPrompt, taskId };
}

test("OPS-72-resume: an ideator rerun gets the failed run's summary and the order to resume and clear the blocker", () => {
	const f = protoTask();
	try {
		const failed = f.seed("idea1", "ideator", "failed", "Needs: a free preview slot (4/4 in use)\nIDEA.md has the plan; the proof step stopped.");
		assert.equal(driveOnce(f.root, f.task, TIMING).idea, 1);
		const prompt = f.lastPrompt();
		assert.ok(prompt.includes(`run ${failed} of this idea ended failed with: "Needs: a free preview slot (4/4 in use)`), prompt);
		assert.match(prompt, /Resume in this worktree and its existing IDEA\.md\. Do not start over: clear that blocker first\./);
		// A first launch is not a rerun.
		const second = driveOnce(f.root, f.task, TIMING);
		assert.equal(second.idea, 2);
		assert.doesNotMatch(f.lastPrompt(), /This is a rerun/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-same: a second failure with the same headline escalates at once with that headline and launches no third seat", () => {
	const f = protoTask();
	try {
		f.failIdea(1, "Needs: a free preview slot (run 703, 4/4 in use)");
		assert.notEqual(f.status(), "escalated", "one failure retries");
		assert.equal(f.nextOf().stage, "idea");
		f.failIdea(1, "Needs: a free preview slot (run 716, 4/4 in use)\nA second line that differs.");
		assert.equal(f.status(), "escalated");
		assert.match(
			f.events("escalation")[0]!.payload,
			/idea 1 failed twice in a row with the same error: Needs: a free preview slot \(run 716, 4\/4 in use\)/,
		);
		const runs = f.runs().length;
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "escalated");
		assert.equal(f.runs().length, runs, "no third seat");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-same: two different headlines still launch a third seat", () => {
	const f = protoTask();
	try {
		f.failIdea(1, "Needs: a free preview slot");
		f.failIdea(1, "Build error in app.ts line 12");
		assert.notEqual(f.status(), "escalated");
		const n = f.nextOf();
		assert.deepEqual([n.stage, n.idea], ["idea", 1]);
		const runs = f.runs().length;
		assert.equal(driveOnce(f.root, f.task, TIMING).idea, 1);
		assert.equal(f.runs().length, runs + 1, "the third seat launched");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-compare: with one idea stuck and the others passed, the owner can compare the passed ideas; the missing idea cannot be picked", () => {
	const f = protoTask();
	try {
		f.seed("idea2", "ideator", "passed", "Built.");
		f.seed("idea3", "ideator", "passed", "Built.");
		f.failIdea(1, "Needs: a free preview slot (run 703)");
		f.failIdea(1, "Needs: a free preview slot (run 716)");
		assert.equal(f.status(), "escalated");
		assert.match(
			JSON.parse(f.events("escalation")[0]!.payload).summary,
			/Ideas 2 and 3 passed: Sebastian can have them compared without idea 1 with evf task compare-passed OPS-1 --owner-approval "<his words>"/,
		);
		const choose = (env: Record<string, string>, words: string) =>
			cli(f.root, env, undefined, "task", "compare-passed", "OPS-1", ...(words ? ["--owner-approval", words] : []));
		const asSeat = choose({ EVF_RUN: "5", EVF_ROLE: "ideator" }, "Sebastian says compare two and three");
		assert.equal(asSeat.status, 1);
		assert.match(asSeat.stderr, /a seat cannot run evf task compare-passed/);
		assert.match(choose({}, "").stderr, /Quote Sebastian/);
		assert.match(choose({}, "ok").stderr, /Quote Sebastian/);
		assert.equal(f.status(), "escalated", "refusals record nothing");
		assert.equal(f.events("compare_passed").length, 0);

		const chosen = choose({}, "Compare two and three without the first");
		assert.equal(chosen.status, 0, chosen.stderr);
		assert.equal(f.status(), "active");
		const choice = JSON.parse(f.events("compare_passed")[0]!.payload) as { missing: number[]; passed: number[]; reason: string; quote: string };
		assert.deepEqual([choice.missing, choice.passed, choice.quote], [[1], [2, 3], "Compare two and three without the first"]);
		assert.deepEqual([f.nextOf().stage, f.nextOf().role], ["compare", "comparer"]);

		// The compare prompt lists only the passed ideas and names the missing one and why.
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "compare");
		const prompt = f.lastPrompt();
		assert.match(prompt, /^Compare the passed ideas of prototype task OPS-1\. Idea worktrees: \S*ops-1-idea2, \S*ops-1-idea3\./);
		assert.doesNotMatch(prompt.split("Build the comparison")[0]!, /ops-1-idea1/);
		assert.match(prompt, /Idea 1 is missing from this comparison \(idea 1 failed: Needs: a free preview slot \(run 716\)\)/);

		const pickMissing = cli(f.root, {}, undefined, "task", "pick", "OPS-1", "1", "--owner-approval", "Pick the first one");
		assert.equal(pickMissing.status, 1);
		assert.match(pickMissing.stderr, /Idea 1 is the missing idea/);
		assert.equal(cli(f.root, {}, undefined, "task", "pick", "OPS-1", "2", "--owner-approval", "Pick the second").status, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-compare: the choice needs exactly one missing idea and an escalated prototype task", () => {
	const f = protoTask();
	try {
		const choose = () => cli(f.root, {}, undefined, "task", "compare-passed", "OPS-1", "--owner-approval", "Compare what passed");
		assert.match(choose().stderr, /not escalated/);
		f.seed("idea2", "ideator", "passed", "Built.");
		f.db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(f.taskId);
		assert.match(choose().stderr, /1 passed ideas of 3: the choice needs exactly one missing idea/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-hold: an idea at its retry cap waits for the idea that still works, then escalates with its reason", () => {
	const f = protoTask();
	try {
		const other = f.seed("idea2", "ideator", "started");
		f.db.prepare("UPDATE runs SET herdr_agent = ? WHERE id = ?").run(`ideator2-ops-1-${other}`, other);
		f.failIdea(1, "Blocked by the slot pool");
		f.failIdea(1, "Blocked by the port clash");
		f.failIdea(1, "Blocked by the disk");
		// The fake Herdr in this fixture answers every agent: idea 2 still works, so the task does not escalate.
		assert.notEqual(f.status(), "escalated");
		assert.equal(f.events("escalation_deferred").length, 1);
		const n = f.nextOf();
		assert.deepEqual([n.stage, n.run], ["waiting", other]);
		runDone(f.root, other, { status: "passed", summary: "Built." });
		assert.equal(f.status(), "escalated");
		assert.match(f.events("escalation")[0]!.payload, /idea 1 failed 3 times in a row \(retry cap 3\); last: Blocked by the disk/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-notes: idea and compare prompts and the shortened session context carry the ask's coordinator notes", () => {
	const f = protoTask(ASK);
	try {
		const notes = [
			"Coordinator note (Oct 30 2026 3:36 AM ET): the preview pool holds four slots; wait for one.",
			"Coordinator note: rebase after OPS-69.",
		];
		driveOnce(f.root, f.task, TIMING);
		for (const note of notes) assert.ok(f.lastPrompt().includes(note), `idea prompt: ${note}`);
		for (const i of [1, 2, 3]) f.seed(`idea${i}`, "ideator", i === 1 ? "passed" : "passed", "Built.");
		f.db.prepare("UPDATE runs SET status = 'passed' WHERE stage LIKE 'idea%' AND status = 'started'").run();
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "compare");
		for (const note of notes) assert.ok(f.lastPrompt().includes(note), `compare prompt: ${note}`);

		const whole = cli(f.root, {}, undefined, "refocus", "OPS-1").stdout;
		for (const note of notes) assert.equal(whole.split(note).length - 1, 1, `once in the whole context: ${note}`);
		const big = `${SPEC.replace("Non-goals", "")}\n${Array.from({ length: 40 }, (_, i) => `${i + 3}. ${"criterion text ".repeat(20)}`).join("\n")}\nNon-goals: lighting.`;
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(big, f.taskId);
		const cut = cli(f.root, {}, undefined, "refocus", "OPS-1").stdout;
		assert.match(cut, /SHORTENED/);
		for (const note of notes) assert.ok(cut.includes(note), `shortened context: ${note}`);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-unmet: an idea seat cannot close passed while its summary or IDEA.md says a Done criterion is unmet", () => {
	const f = protoTask();
	try {
		const id = f.seed("idea1", "ideator", "started");
		const done = (status: string, text: string) =>
			cli(f.root, {}, undefined, "run", "done", String(id), "--status", status, "--summary-file", f.file("s.md", text));
		const refused = done("passed", "Idea built.\nCriterion 9 is unmet: no live preview, no screenshots");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /"Criterion 9 is unmet: no live preview, no screenshots" names a Done criterion that is not met/);
		assert.match(refused.stderr, /Finish that criterion, or close this run as failed/);
		assert.equal(f.runs().find((r) => r.id === id)!.status, "started", "a refusal closes nothing");
		assert.match(done("passed", "Done 3 not met yet").stderr, /Done 3 not met yet/);

		// IDEA.md at the idea worktree root counts too.
		const wt = join(f.root, ".worktrees/ops-1-idea1");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "IDEA.md"), "# Idea 1\n- Criterion 2: not met, the screenshots are missing\n");
		assert.match(done("passed", "Built the idea.").stderr, /Criterion 2: not met, the screenshots are missing/);
		assert.equal(done("failed", "Criterion 9 is unmet: no live preview").status, 0, "failing is always allowed");
		assert.equal(f.runs().find((r) => r.id === id)!.status, "failed");

		// Every criterion met passes, in the summary and in IDEA.md.
		const again = f.seed("idea1", "ideator", "started");
		writeFileSync(join(wt, "IDEA.md"), "# Idea 1\nEvery criterion met.\n");
		const passed = cli(f.root, {}, undefined, "run", "done", String(again), "--status", "passed", "--summary-file", f.file("t.md", "Every criterion met: 1 and 2."));
		assert.equal(passed.status, 0, passed.stderr);
	} finally {
		f.db.close();
		f.close();
	}
});
