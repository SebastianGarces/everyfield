import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { openWorkDb, syncGoals } from "../db.ts";
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
const TIMING = { waitMs: 2000, nudgeMs: 10, ciWaitMs: 200, ciPollMs: 10 };
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
			`let r={};if(a[0]==="workspace"&&a[1]==="create")r={workspace:"w"+calls.length,tab:"t",root_pane:{pane_id:"p"+calls.length}};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:"idle"}};\nprocess.stdout.write(JSON.stringify({result:r}));\n`,
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
