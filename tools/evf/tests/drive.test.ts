import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
	assistantLine,
	fixture,
	sessionStartJs,
	source,
	STORE_LATEST,
	STORE_MIGRATIONS,
	writeTranscript,
} from "./fixtures.ts";
import {
	ensureTask,
	findTask,
	markMerged,
	migrate,
	openWorkDb,
	sessionsRecorded,
	syncGoals,
	workDbPath,
} from "../db.ts";
import { drive, driveOnce, LOOP_CAP, nextStage, RETRY_CAP, runDone } from "../drive.ts";
import { doneCriteria } from "../spec.ts";
import { evfDataDir, evidenceDir, parseTask, runtimeDir, sleep } from "../lib.ts";
import { hasVerifiedHead, verify } from "../verify.ts";

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "", ...env },
	});
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 150, holdPollMs: 10 };

/** A Herdr that answers at once: every agent is idle unless the test writes another state to herdr-state.json. */
function fakeHerdr(root: string) {
	const calls = join(root, "herdr-calls.json"),
		state = join(root, "herdr-state.json");
	writeFileSync(calls, "[]");
	writeFileSync(
		join(root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			`const st=fs.existsSync(${JSON.stringify(state)})?JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8")):{};\n` +
			`if(a[0]==="pane"&&a[1]==="read"){process.stdout.write(st.screen||"");process.exit(0)}\n` +
			`if(a[0]==="agent"&&a[1]==="start"&&st.startFails){process.stderr.write("fixture: timed out waiting for agent startup");process.exit(1)}\n` +
			sessionStartJs(workDbPath(root)) +
			`let r={};if(a[0]==="workspace"&&a[1]==="create")r={workspace:"w9",tab:"w9:t1",root_pane:{pane_id:"w9:p1"}};\n` +
			`else if(a[0]==="pane"&&a[1]==="process-info")r={process_info:{shell_pid:7,foreground_process_group_id:7}};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:st.status||"idle"}};\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_session:{value:st.session||"55555555-5555-4555-8555-555555555555"},agent_status:st.getStatus||(calls.some(c=>c[0]==="agent"&&c[1]==="prompt"&&c[2]===a[2])&&!st.noTurn?"working":"idle")}};\n` +
			`process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(root, "fake-bin/herdr"), 0o755);
	return {
		calls: () => JSON.parse(readFileSync(calls, "utf8")) as string[][],
		setState: (s: object) => writeFileSync(state, JSON.stringify(s)),
	};
}

function driveFixture(opts: { failWhenFile?: string; failFullOnly?: boolean; nested?: string[] } = {}) {
	const f = fixture(),
		task = parseTask("OPS-1");
	// `failWhenFile` makes the first check fail while that file exists in the worktree, to fail the author checks at one head.
	// `failFullOnly` limits that check to full runs, so a quick run at the same head passes.
	// `nested` makes the first check run a guarded evf command through main.ts, once: the nested verify sees EVF_NESTED.
	const first = opts.nested
		? {
				name: "nested-evf",
				run: [
					process.execPath,
					"-e",
					`if(process.env.EVF_NESTED)process.exit(0);const r=require("node:child_process").spawnSync(process.execPath,[${JSON.stringify(join(source, "tools/evf/main.ts"))},...${JSON.stringify(opts.nested)}],{encoding:"utf8",env:{...process.env,EVF_NESTED:"1"}});console.log("nested exit "+r.status);console.log("monitor "+process.env.EVF_MONITOR);console.log(r.stdout);console.error(r.stderr);process.exit(r.status)`,
				],
			}
		: opts.failWhenFile
			? {
					name: "fixture-check",
					run: [
						process.execPath,
						"-e",
						`process.exit(require("node:fs").existsSync(${JSON.stringify(opts.failWhenFile)}) ? 1 : 0)`,
					],
					...(opts.failFullOnly ? { modes: ["full"] } : {}),
				}
			: undefined;
	const checks = first ? [first, ...f.cfg.checks.slice(1)] : f.cfg.checks;
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Drive", owningPaths: ["tools/evf/"], checks } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const wt = f.task("ops-1");
	const herdr = fakeHerdr(f.root);
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const t = ensureTask(db, task, "implement");
	const runs = () =>
		db.prepare("SELECT id, stage, role, status, round FROM runs WHERE task_id = ? ORDER BY id").all(t.id) as Array<
			Record<string, unknown>
		>;
	const events = (type: string) =>
		db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = ? ORDER BY id").all(t.id, type) as Array<{
			payload: string;
		}>;
	const taskRow = () =>
		db.prepare("SELECT status, round, spec, pr_number FROM tasks WHERE id = ?").get(t.id) as {
			status: string;
			round: number;
			spec: string | null;
			pr_number: number | null;
		};
	const file = (name: string, text: string) => {
		const path = join(f.root, "fake-bin", name);
		writeFileSync(path, text);
		return path;
	};
	const insertRun = (stage: string, role: string, status: string, session?: string) =>
		Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(t.id, stage, role, taskRow().round, session ?? null, status, new Date().toISOString()).lastInsertRowid,
		);
	db.prepare("UPDATE tasks SET worktree = ? WHERE id = ?").run(wt, t.id);
	// The implementer's PR body: an implement run closes passed only with a body that passes evf pr body (OPS-113).
	mkdirSync(runtimeDir(f.root, task), { recursive: true });
	writeFileSync(join(runtimeDir(f.root, task), "pr-body.md"), prBody());
	/** Progress for the circuit breaker (OPS-115): an empty commit moves the worktree HEAD. */
	const advance = (message = "progress") =>
		spawnSync("git", ["-C", wt, "commit", "-q", "--allow-empty", "-m", message], { encoding: "utf8" });
	return { ...f, task, wt, db, taskId: t.id, herdr, runs, events, taskRow, file, insertRun, advance };
}

const SPEC =
	"Goal: a usable doghouse.\nDone criteria:\n1. The dog fits.\n2. The roof keeps rain out.\nNon-goals: lighting.";

test("OPS-59-next: the stage machine follows plan, implement, simplify, pr, verify, ci, ship and loops back on failures", () => {
	const task = parseTask("WP-005/ui");
	const t = {
		id: 1,
		ref: task.id,
		slug: task.slug,
		mode: "implement",
		status: "active",
		round: 0,
		goal_id: null,
		spec: null,
		pr_number: null,
	};
	const run = (stage: string, status: string, id = 1) => ({ id, stage, role: "x", status, round: 0, summary: "s" });
	assert.deepEqual(nextStage(task, t, []), { stage: "plan", role: "planner", round: 0, reason: "no spec yet" });
	const specced = { ...t, spec: SPEC };
	assert.equal(nextStage(task, specced, []).stage, "implement");
	assert.equal(nextStage(task, specced, [run("plan", "passed")]).stage, "implement");
	assert.equal(
		nextStage(task, specced, [run("plan", "passed")]).role,
		"implementer",
		"UI work runs in the implementer seat by default",
	);
	assert.equal(
		nextStage(task, { ...specced, spec: `${SPEC}\nSeat: ui` }, [run("plan", "passed")]).role,
		"ui",
		"a ui part whose spec has the line Seat: ui gets the ui seat",
	);
	assert.equal(
		nextStage({ ...task, part: "api" }, { ...specced, spec: `${SPEC}\nSeat: ui` }, [run("plan", "passed")]).role,
		"implementer",
		"only a ui part can take the ui seat",
	);
	assert.equal(nextStage(task, t, [run("plan", "passed")]).stage, "plan", "a plan without a stored spec repeats");
	assert.deepEqual(nextStage(task, specced, [run("plan", "started")]).stage, "waiting");
	assert.equal(nextStage(task, specced, [run("implement", "passed")]).stage, "simplify");
	assert.equal(nextStage(task, specced, [run("implement", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("simplify", "passed")]).stage, "pr");
	assert.equal(nextStage(task, specced, [run("pr", "passed")]).stage, "verify");
	assert.equal(nextStage(task, specced, [run("pr", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("verify", "passed")]).stage, "ci");
	assert.equal(nextStage(task, { ...specced, round: 1 }, [run("verify", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("ci", "passed")]).stage, "ship");
	assert.equal(nextStage(task, specced, [run("ci", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("ship", "passed")]).stage, "done");
	assert.equal(nextStage(task, { ...specced, status: "merged" }, []).stage, "done");
	assert.equal(nextStage(task, { ...specced, status: "escalated", round: 4 }, []).stage, "escalated");
	assert.equal(nextStage(task, specced, [run("verify", "passed")]).role, undefined, "evf runs ci itself");
});

test("OPS-59-drive: one transition launches the next seat through Herdr with the stage prompt, waits on it, nudges once and aborts an unclosed stage", () => {
	const f = driveFixture();
	try {
		const ask = f.file("ask.md", "Make the doghouse usable.");
		const made = cli(f.root, {}, "task", "new", "OPS-1", "--ask-file", ask, "--title", "Usable doghouse");
		assert.equal(made.status, 0, made.stderr);
		assert.deepEqual(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout), {
			stage: "plan",
			role: "planner",
			round: 0,
			reason: "no spec yet",
		});

		let n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "plan");
		const launched = f.runs();
		assert.equal(launched.length, 1);
		assert.equal(launched[0]!.role, "planner");
		assert.equal(launched[0]!.status, "started");
		const calls = f.herdr.calls();
		assert.ok(
			calls.some(
				(c) => c[0] === "workspace" && c[1] === "create" && c.includes("--env") && c.includes("EVF_STAGE=plan"),
			),
			"workspace with the stage env",
		);
		const start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
		assert.ok(start.includes("--agent") && start.includes("evf:planner"), start.join(" "));
		const prompt = calls.find((c) => c[0] === "agent" && c[1] === "prompt")!;
		assert.match(prompt[3]!, /^Plan task OPS-1: write the spec .* bin\/evf run done \$EVF_RUN/);

		// The seat went idle without closing its stage: one nudge, then the run is aborted as failed.
		n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "waiting");
		const nudges = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt" && /Close your stage now/.test(c[3] ?? ""));
		assert.equal(nudges.length, 1);
		assert.equal(f.runs()[0]!.status, "failed");
		assert.equal(f.events("nudge").length, 1);
		assert.match(f.events("stage_end")[0]!.payload, /idle twice without closing plan/);
		assert.equal(
			nextStage(f.task, { ...ensureTask(f.db, f.task, "implement"), spec: null, pr_number: null }, []).stage,
			"plan",
		);

		// A seat that stores the spec and closes its stage moves the task to implement.
		n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "plan");
		const planRun = f.runs()[1]!;
		const starts = f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start");
		assert.deepEqual(
			starts.map((c) => c[2]),
			[`planner-ops-1-${f.runs()[0]!.id}`, `planner-ops-1-${planRun.id}`],
			"each launch gets its own Herdr agent, so the second never waits on the first seat",
		);
		const spec = f.file("spec.md", SPEC);
		assert.equal(cli(f.root, {}, "task", "spec", "OPS-1", "--file", spec).status, 0);
		assert.equal(
			cli(f.root, {}, "task", "spec", "OPS-1", "--file", f.file("bad.md", "just words")).status,
			1,
			"a spec needs Done criteria",
		);
		const summary = f.file("summary.md", "Spec written: two criteria.");
		const closed = cli(f.root, {}, "run", "done", String(planRun.id), "--status", "passed", "--summary-file", summary);
		assert.equal(closed.status, 0, closed.stderr);
		assert.deepEqual(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout), {
			stage: "implement",
			role: "implementer",
			round: 0,
			reason: "plan passed",
		});
		assert.equal(
			cli(f.root, {}, "run", "done", String(planRun.id), "--status", "passed", "--summary-file", summary).status,
			1,
			"a run closes once",
		);

		// Blocked seats are reported and waited on, then the wait resumes.
		n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "implement");
		assert.match(
			f.herdr
				.calls()
				.find((c) => c[0] === "agent" && c[1] === "prompt" && /Implement task OPS-1/.test(c[3] ?? ""))![3]!,
			/pr-body\.md/,
		);
		f.herdr.setState({ status: "blocked" });
		const implementRun = f.runs().at(-1)!;
		// driveOnce blocks this thread, so another process flips the seat to idle and closes its stage.
		const closer = spawn(
			process.execPath,
			[
				"-e",
				`setTimeout(() => { require("node:child_process").spawnSync(process.execPath, [process.argv[2], "run", "done", process.argv[3], "--status", "passed", "--summary-file", process.argv[4]], { cwd: process.argv[5], stdio: "inherit" }); require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ status: "idle" })); }, 150)`,
				join(f.root, "herdr-state.json"),
				join(source, "tools/evf/main.ts"),
				String(implementRun.id),
				f.file("built.md", "Built it."),
				f.root,
			],
			{ stdio: "inherit", env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_STAGE: "" } },
		);
		n = driveOnce(f.root, f.task, TIMING);
		for (let i = 0; i < 100 && !/idle/.test(readFileSync(join(f.root, "herdr-state.json"), "utf8")); i++) sleep(20);
		closer.kill();
		assert.equal(n.stage, "waiting");
		assert.ok(f.events("blocked").length >= 1, "the blocked state is recorded");
		assert.ok(
			f.herdr.calls().some((c) => c[0] === "notification" && c[1] === "show"),
			"and Sebastian is notified",
		);
		assert.equal(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout).stage, "simplify");

		// The pr stage is evf's own run and fails cleanly without a PR body (removed after implement passed with it).
		rmSync(join(runtimeDir(f.root, f.task), "pr-body.md"));
		runDone(f.root, Number((driveOnce(f.root, f.task, TIMING), f.runs().at(-1)!.id)), {
			status: "passed",
			summary: "Simplified.",
		});
		n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "pr");
		const prRun = f.runs().at(-1)!;
		assert.equal(prRun.role, "evf");
		assert.equal(prRun.status, "failed");
		assert.match(f.events("stage_end").at(-1)!.payload, /no PR body/);
		assert.equal(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout).stage, "implement");
		assert.match(cli(f.root, {}, "status", "OPS-1").stdout, /OPS-1 .*implement .*active/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-59-cap: a failed verify or ci costs a round and the fourth round escalates with a notification; nothing launches again", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
		const verifyRun = () =>
			Number(
				f.db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, 'verify', 'verifier', ?, ?, 'started', ?)",
					)
					.run(
						f.taskId,
						f.taskRow().round,
						`66666666-6666-4666-8666-66666666666${f.runs().length}`,
						new Date().toISOString(),
					).lastInsertRowid,
			);
		for (let i = 1; i <= LOOP_CAP; i++) {
			f.advance();
			runDone(f.root, verifyRun(), { status: "failed", summary: `finding ${i}` });
			assert.equal(f.taskRow().round, i);
			assert.notEqual(f.taskRow().status, "escalated");
			assert.equal(
				nextStage(f.task, { ...ensureTask(f.db, f.task, "implement"), ...f.taskRow() }, []).stage,
				"implement",
			);
		}
		assert.equal(f.events("round").length, LOOP_CAP);
		const approvals = f.db.prepare("SELECT decision FROM approvals WHERE task_id = ?").all(f.taskId) as Array<{
			decision: string;
		}>;
		assert.deepEqual(
			approvals.map((a) => a.decision),
			["changes_requested", "changes_requested", "changes_requested"],
		);
		f.advance();
		runDone(f.root, verifyRun(), { status: "failed", summary: "finding 4" });
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(f.taskRow().round, LOOP_CAP + 1);
		assert.equal(f.events("loop_cap_hit").length, 1);
		assert.match(f.events("escalation")[0]!.payload, /needs Sebastian: loop cap 3 hit after verify failed\. finding 4/);
		assert.ok(f.herdr.calls().some((c) => c[0] === "notification" && c[2] === "OPS-1 escalated"));
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "escalated");
		assert.equal(f.runs().length, LOOP_CAP + 1, "no seat launches after the cap");
		assert.equal(cli(f.root, {}, "drive", "OPS-1", "--once").status, 2);
		assert.match(cli(f.root, {}, "launch", "OPS-1", "--role", "implementer").stderr, /escalated after 4 rounds/);
		assert.equal(cli(f.root, {}, "status", "--json").stdout.includes('"escalated_tasks": 1'), true);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-59-proof: proofs bind to the worktree head, check records an event, and ask planner forks the planner session", () => {
	const f = driveFixture();
	try {
		const added = cli(
			f.root,
			{},
			"proof",
			"add",
			"OPS-1",
			"--criterion",
			"1",
			"--status",
			"met",
			"--evidence",
			"https://evidence.example/1.png",
		);
		assert.equal(added.status, 0, added.stderr);
		assert.equal(
			cli(f.root, {}, "proof", "add", "OPS-1", "--criterion", "2", "--status", "unmet", "--notes", "no WebKit").status,
			0,
		);
		assert.match(
			cli(f.root, {}, "proof", "add", "OPS-1", "--criterion", "3", "--status", "maybe").stderr,
			/met, unmet or n\/a/,
		);
		const shown = JSON.parse(cli(f.root, {}, "proof", "show", "OPS-1", "--json").stdout);
		assert.equal(shown.at_head.length, 2);
		assert.equal(shown.proofs[0].evidence_url, "https://evidence.example/1.png");
		spawnSync("git", ["-C", f.wt, "commit", "-q", "--allow-empty", "-m", "move the head"]);
		assert.equal(
			JSON.parse(cli(f.root, {}, "proof", "show", "OPS-1", "--json").stdout).at_head.length,
			0,
			"a new head has no proofs yet",
		);
		assert.match(cli(f.root, {}, "proof", "show", "OPS-1").stdout, /0 at head, 2 total/);

		const checked = cli(f.root, {}, "check", "OPS-1");
		assert.equal(checked.status, 0, checked.stderr);
		assert.match(f.events("check_result")[0]!.payload, /"passed":true/);

		writeFileSync(
			join(f.root, "fake-bin/claude"),
			`#!${process.execPath}\nconst a=process.argv.slice(2);process.stdout.write(JSON.stringify({result:"Use the porch roof; "+a.includes("--fork-session")+" "+a[a.indexOf("--resume")+1]}));\n`,
		);
		chmodSync(join(f.root, "fake-bin/claude"), 0o755);
		assert.match(cli(f.root, {}, "ask", "planner", "OPS-1", "Which roof?").stderr, /no planner run to ask/);
		f.db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, 'plan', 'planner', 0, '77777777-7777-4777-8777-777777777777', 'passed', ?)",
			)
			.run(f.taskId, new Date().toISOString());
		const asked = cli(f.root, { EVF_ROLE: "implementer" }, "ask", "planner", "OPS-1", "Which roof?");
		assert.equal(asked.status, 0, asked.stderr);
		assert.equal(asked.stdout.trim(), "Use the porch roof; true 77777777-7777-4777-8777-777777777777");
		assert.match(f.events("question")[0]!.payload, /"from":"implementer"/);
		assert.match(f.events("answer")[0]!.payload, /porch roof/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-59-ship: for a driven task, ship refuses author or verifier sessions evf never launched", () => {
	const f = driveFixture();
	try {
		const author = "11111111-1111-4111-8111-111111111111",
			verifier = "22222222-2222-4222-8222-222222222222";
		assert.equal(
			sessionsRecorded(f.root, "task/other", author, verifier),
			null,
			"an unknown branch is not the store's business",
		);
		assert.equal(
			sessionsRecorded(f.root, "task/ops-1", author, verifier),
			null,
			"a task row alone (evf check, evf launch by hand) does not make the branch a driven one",
		);
		f.insertRun("pr", "evf", "passed");
		assert.match(sessionsRecorded(f.root, "task/ops-1", author, verifier)!, /no implementer session/);
		f.insertRun("implement", "implementer", "passed", author);
		assert.match(sessionsRecorded(f.root, "task/ops-1", author, verifier)!, /no verifier session/);
		f.insertRun("verify", "verifier", "passed", verifier);
		assert.equal(sessionsRecorded(f.root, "task/ops-1", author, verifier), null);
		assert.match(
			sessionsRecorded(f.root, "task/ops-1", verifier, author)!,
			/no implementer session/,
			"swapped sessions are refused",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-59-retry: three failures in a row that cost no round escalate; a restart aborts evf's own open stage without a round and runs it again", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		for (let i = 1; i < RETRY_CAP; i++) {
			f.advance();
			runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "failed", summary: `broke ${i}` });
			assert.equal(f.taskRow().status, "active");
		}
		assert.equal(f.taskRow().round, 0, "implement failures cost no round");
		f.advance();
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "failed", summary: "broke again" });
		assert.equal(f.taskRow().status, "escalated");
		assert.match(f.events("escalation")[0]!.payload, /3 failures in a row, last in implement\. broke again/);
		assert.ok(f.herdr.calls().some((c) => c[0] === "notification" && c[2] === "OPS-1 escalated"));
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "escalated");
		assert.equal(f.runs().length, RETRY_CAP, "no seat launches after the escalation");

		// A seat aborted by its session-end hook counts too, and the drive loop is what escalates it. A passed stage resets the count.
		f.db.prepare("UPDATE tasks SET status = 'active' WHERE id = ?").run(f.taskId);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "simplify");
		runDone(f.root, f.runs().at(-1)!.id as number, { status: "failed", summary: "could not" });
		for (let i = 0; i < RETRY_CAP; i++) f.insertRun("simplify", "simplifier", "aborted");
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "escalated");
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(f.events("escalation").length, 2);

		// Restart: an open evf ci run from a drive that died is aborted, costs nothing, and ci runs again.
		f.db.prepare("UPDATE tasks SET status = 'active', pr_number = 77 WHERE id = ?").run(f.taskId);
		const head = spawnSync("git", ["-C", f.wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		for (const c of ["1", "2"])
			f.db
				.prepare("INSERT INTO proofs (task_id, head_sha, criterion, status, created_at) VALUES (?, ?, ?, 'met', ?)")
				.run(f.taskId, head, c, new Date().toISOString());
		runDone(f.root, f.insertRun("verify", "verifier", "started"), { status: "passed", summary: "approved" });
		const stale = f.insertRun("ci", "evf", "started");
		let n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "waiting");
		assert.match(n.reason, /ci stage restarts after a drive restart/);
		assert.equal(f.runs().find((r) => r.id === stale)!.status, "aborted");
		assert.equal(f.taskRow().round, 0, "a restart costs no round");
		assert.equal(f.events("restart").length, 1);
		const state = f.getState();
		state.requiredChecks = [{ name: "ci", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" }];
		state.protection = { required_status_checks: { contexts: ["ci"] } };
		f.setState(state);
		n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "ci", "the stage before the aborted run decides: ci runs again");
		assert.deepEqual([f.runs().at(-1)!.role, f.runs().at(-1)!.status], ["evf", "passed"]);
		assert.equal(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout).stage, "ship");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-64-gate: the proof gate reads the Done list from its header, not from the first line that says Done criteria", () => {
	const spec = [
		"Goal: the gate sees every criterion.",
		"",
		"Done when:",
		"1. The context lists every criterion.",
		"",
		"2. A test stores a spec with 25+ Done criteria",
		"   and blank lines between them.",
		"",
		"3. The gate needs a proof for each.",
		"",
		"Non-goals: no change to ship.",
	].join("\n");
	assert.deepEqual(doneCriteria(spec), ["1", "2", "3"], "a criterion that mentions Done criteria starts nothing");
	assert.deepEqual(doneCriteria(spec.replace("Done when:", "**Done criteria**")), ["1", "2", "3"]);
	assert.deepEqual(doneCriteria(spec.replace("Done when:", "## Done criteria (every proof of concept)")), [
		"1",
		"2",
		"3",
	]);
	assert.deepEqual(doneCriteria("Goal: x\nDone criteria: as follows\n1. a\n\n\n2. b\n## Approach\n1. not this"), [
		"1",
		"2",
	]);
	assert.deepEqual(doneCriteria("Goal: x\n1. a\n2. b"), [], "no Done header, no criteria");
});

test("OPS-59-gate: a verify closes passed only with a met or n/a proof per Done criterion at the head; read commands write nothing; one drive per task", () => {
	const f = driveFixture();
	try {
		assert.deepEqual(doneCriteria(SPEC), ["1", "2"]);
		assert.deepEqual(doneCriteria("Goal: x\nDone criteria:\n1. a\n  2. b\n3. c\nNon-goals:\n1. not this"), [
			"1",
			"2",
			"3",
		]);
		assert.deepEqual(
			doneCriteria("## Goal\nx\n## Done criteria\n1. a\n2. b\n## Non-goals\n1. not this\n2. nor this\n3. nor this"),
			["1", "2"],
			"a heading ends the criteria",
		);
		assert.deepEqual(doneCriteria("Goal: x\nDone criteria:\n1. a\n2. b\n**Non-goals**\n1. not this"), ["1", "2"]);
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const verifyRun = f.insertRun("verify", "verifier", "started");
		const summary = f.file("approved.md", "Approved.");
		const close = (run: number, status: string) =>
			cli(f.root, {}, "run", "done", String(run), "--status", status, "--summary-file", summary);
		const refused = close(verifyRun, "passed");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Done criteria 1, 2 have no met or n\/a proof at [0-9a-f]{10}/);
		assert.equal(f.runs()[0]!.status, "started", "the run stays open");
		assert.equal(cli(f.root, {}, "proof", "add", "OPS-1", "--criterion", "1", "--status", "met").status, 0);
		assert.match(close(verifyRun, "passed").stderr, /Done criteria 2 have no met/);
		assert.equal(cli(f.root, {}, "proof", "add", "OPS-1", "--criterion", "2", "--status", "unmet").status, 0);
		assert.match(close(verifyRun, "passed").stderr, /Done criteria 2 have no met/, "an unmet proof does not count");
		assert.equal(cli(f.root, {}, "proof", "add", "OPS-1", "--criterion", "2", "--status", "n/a").status, 0);
		const closed = close(verifyRun, "passed");
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(
			(f.db.prepare("SELECT decision FROM approvals WHERE task_id = ?").get(f.taskId) as { decision: string }).decision,
			"approved",
		);
		spawnSync("git", ["-C", f.wt, "commit", "-q", "--allow-empty", "-m", "move the head"]);
		const later = f.insertRun("verify", "verifier", "started");
		assert.equal(close(later, "passed").status, 0, "proof carries forward to a later head of the same branch");
		assert.equal(
			close(f.insertRun("verify", "verifier", "started"), "failed").status,
			0,
			"a failed verify needs no proofs",
		);

		const other = parseTask("OPS-2");
		assert.equal(JSON.parse(cli(f.root, {}, "next", "OPS-2").stdout).stage, "plan");
		assert.match(cli(f.root, {}, "proof", "show", "OPS-2").stdout, /0 at head, 0 total/);
		assert.match(cli(f.root, {}, "ask", "planner", "OPS-2", "Why?").stderr, /no planner run to ask/);
		assert.equal(
			(f.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE ref = ?").get(other.id) as { n: number }).n,
			0,
			"next, proof show and ask planner create no task row",
		);

		const pidFile = join(evfDataDir(f.root), "drive", "ops-1.pid");
		mkdirSync(join(evfDataDir(f.root), "drive"), { recursive: true });
		writeFileSync(pidFile, `${process.pid}\n`);
		const busy = cli(f.root, {}, "drive", "OPS-1", "--once");
		assert.equal(busy.status, 1);
		assert.match(busy.stderr, new RegExp(`evf drive already runs for OPS-1 \\(pid ${process.pid}\\)`));
		writeFileSync(pidFile, "999999999\n");
		f.db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(f.taskId);
		assert.equal(cli(f.root, {}, "drive", "OPS-1", "--once").status, 2, "a dead holder's pid file is taken over");
		assert.equal(existsSync(pidFile), false, "the pid file goes when the loop ends");
	} finally {
		f.db.close();
		f.close();
	}
});

/** A scripted Herdr for waitOnSeat: `agent wait` and `agent get` answer from queues; "close" makes the seat close its stage. */
function scriptedHerdr(f: ReturnType<typeof driveFixture>, runId: number, script: { waits: string[]; gets: string[] }) {
	const calls = join(f.root, "herdr-calls.json"),
		state = join(f.root, "herdr-script.json"),
		summary = f.file("script-summary.md", "Done.");
	writeFileSync(state, JSON.stringify(script));
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			`const st=JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));\n` +
			`const next=k=>{const q=st[k];const v=q.length>1?q.shift():q[0];fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(st));return v};\n` +
			`let r={};if(a[0]==="agent"&&a[1]==="wait"){let s=next("waits");if(s==="close"){require("node:child_process").spawnSync(process.execPath,[${JSON.stringify(join(source, "tools/evf/main.ts"))},"run","done","${runId}","--status","passed","--summary-file",${JSON.stringify(summary)}],{cwd:${JSON.stringify(f.root)},env:{...process.env,EVF_RUN:"",EVF_WORKTREE:"",EVF_STAGE:""}});s="idle"}r={agent:{agent_status:s}}}\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_status:next("gets")}};\n` +
			`process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
}
function openSeatRun(f: ReturnType<typeof driveFixture>, promptSent: boolean) {
	f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
	const id = f.insertRun("implement", "implementer", "started");
	f.db.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = 'w9:p1' WHERE id = ?").run(`implementer-ops-1-${id}`, id);
	if (promptSent)
		f.db
			.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'prompt_sent', '{}')")
			.run(f.taskId, id, new Date().toISOString());
	return id;
}

test("OPS-67-blocked: a blocked seat is polled in short intervals, reported once, and the drive goes on when it leaves blocked", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, false);
		scriptedHerdr(f, id, { waits: ["blocked", "close"], gets: ["blocked", "blocked", "blocked", "working"] });
		const started = Date.now();
		driveOnce(f.root, f.task, TIMING);
		assert.ok(Date.now() - started < 5000, "the drive goes on within a few poll intervals");
		assert.equal(f.events("blocked").length, 1, "one blocked event for the episode, not one per poll");
		const episode = f.db
			.prepare("SELECT type, payload FROM events WHERE run_id = ? AND type IN ('blocked', 'unblocked') ORDER BY id")
			.all(id) as Array<{ type: string; payload: string }>;
		assert.deepEqual(
			episode.map((e) => e.type),
			["blocked", "unblocked"],
			"the resumed event follows the blocked one, so the last event no longer says blocked",
		);
		assert.match(episode[1]!.payload, /implementer-ops-1-\d+ resumed after a prompt/);
		assert.equal(f.herdr.calls().filter((c) => c[0] === "notification" && c[1] === "show").length, 1);
		const gets = f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "get");
		assert.equal(gets.length, 4, "the state was polled until it left blocked");
		assert.equal(f.runs()[0]!.status, "passed");
		assert.equal(f.events("nudge").length, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-67-blocked: a blocked seat whose run closes ends the wait at once", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, false);
		scriptedHerdr(f, id, { waits: ["blocked"], gets: ["blocked"] });
		const closer = spawn(
			process.execPath,
			[
				"-e",
				`setTimeout(() => require("node:child_process").spawnSync(process.execPath, [process.argv[1], "run", "done", process.argv[2], "--status", "failed", "--summary-file", process.argv[3]], { cwd: process.argv[4], env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_STAGE: "" } }), 200)`,
				join(source, "tools/evf/main.ts"),
				String(id),
				f.file("closed.md", "Closed by someone else."),
				f.root,
			],
			{ stdio: "inherit" },
		);
		const started = Date.now();
		driveOnce(f.root, f.task, TIMING);
		closer.kill();
		assert.ok(Date.now() - started < 5000);
		assert.equal(f.events("blocked").length, 1);
	} finally {
		f.db.close();
		f.close();
	}
});

const SHA = "a".repeat(40);
const rowsOf = (f: ReturnType<typeof driveFixture>) =>
	f.db
		.prepare("SELECT id, status, merge_commit FROM tasks WHERE ref = 'OPS-1' ORDER BY id")
		.all()
		.map((r) => ({ ...r })) as Array<{ id: number; status: string; merge_commit: string | null }>;

test("OPS-66-drive: the drive exits at the merge: one merged row, no next event after it, no seat launched", () => {
	const f = driveFixture(),
		log = console.log;
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'pr_open', pr_number = 77 WHERE id = ?").run(SPEC, f.taskId);
		const head = spawnSync("git", ["-C", f.wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		for (const c of ["1", "2"])
			f.db
				.prepare("INSERT INTO proofs (task_id, head_sha, criterion, status, created_at) VALUES (?, ?, ?, 'met', ?)")
				.run(f.taskId, head, c, new Date().toISOString());
		runDone(f.root, f.insertRun("verify", "verifier", "started"), { status: "passed", summary: "approved" });
		runDone(f.root, f.insertRun("ci", "evf", "started"), { status: "passed", summary: "green" });
		// GitHub reports the PR merged (a restart after the merge): the merge check before the ship stage records it.
		const state = f.getState();
		state.pr = { number: 77, state: "MERGED", mergeCommit: { oid: SHA } };
		f.setState(state);
		const launches = () =>
			f.herdr.calls().filter((c) => c[0] === "workspace" || (c[0] === "agent" && c[1] === "start")).length;
		const before = launches();
		const lines: string[] = [];
		console.log = (l: string) => lines.push(l);
		const code = drive(f.root, f.task, {}, { ...TIMING, waitMs: 60_000, seatPollMs: 10 });
		console.log = log;
		assert.equal(code, 0, lines.join("\n"));
		assert.deepEqual(rowsOf(f), [{ id: f.taskId, status: "merged", merge_commit: SHA }]);
		const types = (
			f.db.prepare("SELECT type FROM events WHERE task_id = ? ORDER BY id").all(f.taskId) as Array<{ type: string }>
		).map((e) => e.type);
		assert.equal(types.filter((t) => t === "merged").length, 1);
		assert.equal(types.at(-1), "merged", "no next event and no stage after the merge");
		assert.ok(!f.runs().some((r) => r.stage === "ship"), "no ship stage runs for a merged PR");
		assert.equal(launches(), before, "no launch after ship");
	} finally {
		console.log = log;
		f.db.close();
		f.close();
	}
});

test("OPS-66-current: ensureTask returns the merged row, skipping later abandoned ghosts; markMerged is idempotent and inserts when the store has no row", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET status = 'merged', merge_commit = ? WHERE id = ?").run(SHA, f.taskId);
		f.db
			.prepare(
				"INSERT INTO tasks (slug, mode, ref, title, status, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'ghost', 'abandoned', 'x', 'x')",
			)
			.run();
		const got = ensureTask(f.db, f.task, "implement");
		assert.equal(got.id, f.taskId);
		assert.equal(got.status, "merged");
		assert.equal(rowsOf(f).length, 2, "no row inserted");
		markMerged(f.db, f.task, SHA, null);
		assert.equal(f.events("merged").length, 0, "an already merged row records nothing");

		const other = parseTask("OPS-2");
		markMerged(f.db, other, SHA, null);
		markMerged(f.db, other, SHA, null);
		const row = findTask(f.db, other)!;
		assert.equal(row.status, "merged");
		const events = f.db.prepare("SELECT type FROM events WHERE task_id = ?").all(row.id);
		assert.equal(events.length, 1, "one row and one merged event for a ref the store did not know");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-67-idle: an idle report before the launch prompt began its turn gets no 'Close your stage now' nudge", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, true);
		scriptedHerdr(f, id, { waits: ["idle", "close"], gets: ["working"] });
		driveOnce(f.root, f.task, { startGraceMs: 60_000 });
		const prompts = f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "prompt");
		assert.equal(prompts.length, 0, "no nudge prompt in the Herdr log");
		assert.equal(f.events("nudge").length, 0);
		assert.equal(f.runs()[0]!.status, "passed");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-66-reopen: only evf task new reopens a merged ref; drive, spec and launch leave it alone; next reports done", () => {
	const f = driveFixture();
	try {
		f.db
			.prepare("UPDATE tasks SET status = 'merged', merge_commit = ?, spec = ? WHERE id = ?")
			.run(SHA, SPEC, f.taskId);
		assert.deepEqual(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout), {
			stage: "done",
			round: 0,
			reason: "merged",
		});
		const unchanged = () => assert.deepEqual(rowsOf(f), [{ id: f.taskId, status: "merged", merge_commit: SHA }]);
		for (const args of [
			["drive", "OPS-1"],
			["drive", "OPS-1", "--once"],
		]) {
			const r = cli(f.root, {}, ...args);
			assert.equal(r.status, 0, r.stderr);
			assert.match(r.stdout, /drive OPS-1: done \(merged as a{40}\)/);
			unchanged();
		}
		const spec = cli(f.root, {}, "task", "spec", "OPS-1", "--file", f.file("spec.md", SPEC));
		assert.notEqual(spec.status, 0);
		assert.match(spec.stderr, /evf task new/);
		unchanged();
		const launch = cli(f.root, {}, "launch", "OPS-1", "--role", "planner", "--dry-run");
		assert.notEqual(launch.status, 0);
		assert.match(launch.stderr, /OPS-1 is merged\./);
		unchanged();

		const made = cli(f.root, {}, "task", "new", "OPS-1", "--ask-file", f.file("ask.md", "Again."));
		assert.equal(made.status, 0, made.stderr);
		const rows = rowsOf(f);
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], { id: f.taskId, status: "merged", merge_commit: SHA });
		assert.equal(rows[1]!.status, "new");
		assert.equal(JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout).stage, "plan");
		const ev = f.db.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'task_new'").get(rows[1]!.id) as {
			payload: string;
		};
		assert.equal(JSON.parse(ev.payload).reopens, f.taskId);
	} finally {
		f.db.close();
		f.close();
	}
});

const nextOf = (f: ReturnType<typeof driveFixture>) => JSON.parse(cli(f.root, {}, "next", "OPS-1").stdout);
const reopen = (f: ReturnType<typeof driveFixture>, reason = "gate fixed upstream", env: Record<string, string> = {}) =>
	cli(f.root, env, "task", "reopen", "OPS-1", "--reason", reason);
const failStage = (f: ReturnType<typeof driveFixture>, stage: string, role: string, n = 1) => {
	for (let i = 0; i < n; i++) {
		f.advance(); // Each failure follows a commit, so the circuit breaker stays out of the retry-cap tests.
		runDone(f.root, f.insertRun(stage, role, "started"), { status: "failed", summary: `${stage} broke` });
	}
};
const storeCounts = (f: ReturnType<typeof driveFixture>) =>
	Object.fromEntries(
		["runs", "events", "approvals", "proofs"].map((t) => [
			t,
			f.db
				.prepare(`SELECT * FROM ${t} ORDER BY id`)
				.all()
				.map((r) => JSON.stringify(r)),
		]),
	);

test("OPS-68-reopen: three failures escalate, the reopen restarts the count, the sixth failure escalates again, history stays", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		failStage(f, "simplify", "simplifier");
		failStage(f, "implement", "implementer", 2);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(nextOf(f).stage, "escalated");
		const before = storeCounts(f);
		const help = cli(f.root, {}, "help");
		assert.match(help.stdout, /^ {2}evf task reopen <task> --reason .*$/m);

		const r = reopen(f);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout.trim(), "reopen: OPS-1 is active.");
		assert.equal(f.taskRow().status, "active");
		const ev = f.events("reopen");
		assert.equal(ev.length, 1);
		assert.deepEqual(JSON.parse(ev[0]!.payload), {
			reason: "gate fixed upstream",
			from: "escalated",
			to: "active",
			round: 0,
			after_run: f.runs().at(-1)!.id,
			summary: `OPS-1 reopened to active: gate fixed upstream`,
		});
		const after = storeCounts(f);
		for (const t of ["runs", "approvals", "proofs"]) assert.deepEqual(after[t], before[t!], `${t} unchanged`);
		assert.deepEqual(after.events!.slice(0, before.events!.length), before.events, "old events unchanged");
		// The reopen event, and the owner_answer to the escalation's owner_ask (OPS-131).
		assert.equal(after.events!.length, before.events!.length + 2);
		assert.equal(f.events("owner_answer").length, 1);

		const n = nextOf(f);
		assert.equal(n.stage, "implement");
		assert.doesNotMatch(n.reason, /in a row/);
		failStage(f, "implement", "implementer", 2);
		assert.equal(f.taskRow().status, "active");
		assert.equal(nextOf(f).stage, "implement");
		assert.equal(driveOnce(f.root, f.task, { ...TIMING, waitMs: 1 }).stage === "escalated", false);
		// The drive launched an implement seat above and its Herdr agent exists: the third failure waits for it.
		failStage(f, "implement", "implementer");
		assert.equal(f.taskRow().status, "active", "a seat of the task still works");
		assert.equal(f.events("escalation_deferred").length, 1);
		runDone(f.root, f.runs().find((r) => r.status === "started")!.id as number, {
			status: "passed",
			summary: "Built.",
		});
		assert.equal(f.taskRow().status, "escalated", "the last open seat closed");
		assert.equal(f.events("escalation").length, 2);
		assert.equal(nextOf(f).stage, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-68-refuse: a task that is not escalated, a short reason and a seat all leave the store unchanged", () => {
	const f = driveFixture();
	try {
		const same = (r: ReturnType<typeof reopen>, msg: RegExp, snap: unknown, row: unknown) => {
			assert.notEqual(r.status, 0);
			assert.match(r.stderr, msg);
			assert.deepEqual(storeCounts(f), snap);
			assert.deepEqual(f.taskRow(), row);
		};
		for (const status of ["new", "pr_open", "merged", "done"]) {
			f.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, f.taskId);
			same(reopen(f), new RegExp(`is ${status}, not escalated`), storeCounts(f), f.taskRow());
		}
		f.db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(f.taskId);
		same(reopen(f, "oneword"), /two words or more/, storeCounts(f), f.taskRow());
		same(reopen(f, "gate fixed", { EVF_RUN: "7" }), /seat cannot reopen/, storeCounts(f), f.taskRow());
		assert.equal(f.taskRow().status, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-68-pr: a task with a PR reopens to pr_open; a passed run after the reopen resets the count", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active', pr_number = 5 WHERE id = ?").run(SPEC, f.taskId);
		failStage(f, "implement", "implementer", 3);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(reopen(f).status, 0);
		assert.equal(f.taskRow().status, "pr_open");
		failStage(f, "implement", "implementer", 2);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		failStage(f, "simplify", "simplifier", 2);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(nextOf(f).stage, "implement");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-68-marker: only the latest reopen counts; started and evf-aborted runs stay uncounted", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		failStage(f, "implement", "implementer", 3);
		assert.equal(reopen(f).status, 0);
		failStage(f, "implement", "implementer", 3);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(reopen(f, "second look").status, 0);
		const markers = f.events("reopen").map((e) => JSON.parse(e.payload).after_run);
		assert.equal(markers.length, 2);
		assert.ok(markers[1] > markers[0]);
		failStage(f, "implement", "implementer");
		f.insertRun("simplify", "evf", "aborted");
		const open = f.insertRun("review", "reviewer", "started");
		failStage(f, "implement", "implementer");
		assert.equal(f.taskRow().status, "active", "the aborted and started runs do not count");
		runDone(f.root, open, { status: "passed", summary: "ok" });
		assert.equal(f.taskRow().status, "active");
		assert.notEqual(nextOf(f).stage, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-68-prototype: three failed idea runs escalate, the reopen sets active, nextPrototype returns an idea stage", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, mode = 'prototype', status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		for (let i = 1; i <= RETRY_CAP; i++) failStage(f, `idea${i}`, "ideator");
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(nextOf(f).stage, "escalated");
		assert.equal(reopen(f).status, 0);
		assert.equal(f.taskRow().status, "active");
		const n = nextOf(f);
		assert.equal(n.stage, "idea");
		assert.equal(n.idea, 1);
	} finally {
		f.db.close();
		f.close();
	}
});

const sh = (cwd: string, ...args: string[]) =>
	spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout.trim();
const head = (f: ReturnType<typeof driveFixture>) => sh(f.wt, "rev-parse", "HEAD");
const commitFile = (f: ReturnType<typeof driveFixture>, name: string) => {
	writeFileSync(join(f.wt, "tools/evf", name), name);
	sh(f.wt, "add", "tools/evf");
	sh(f.wt, "commit", "-qm", `add ${name}`);
	return head(f);
};
const proofAt = (f: ReturnType<typeof driveFixture>, sha: string, criterion: string, status = "met") =>
	f.db
		.prepare("INSERT INTO proofs (task_id, head_sha, criterion, status, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(f.taskId, sha, criterion, status, new Date().toISOString());

const AUTHOR = { session: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet-5-5", role: "implementer" };
/** The task's PR body from the PR template: every heading, the EVF-Author line and the generated-by line. */
function prBody() {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	return `${template
		.split("\n")
		.filter((line) => line.startsWith("## "))
		.map((heading) => `${heading}\nConcrete task evidence.`)
		.join(
			"\n\n",
		)}\n\nEVF-Author: ${JSON.stringify(AUTHOR)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/** A remote, the PR body the implementer wrote and a GitHub that already shows the PR merged, so pr, ci and ship run for real. */
function withPr(f: ReturnType<typeof driveFixture>) {
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	mkdirSync(runtimeDir(f.root, f.task), { recursive: true });
	writeFileSync(join(runtimeDir(f.root, f.task), "pr-body.md"), prBody());
	const state = f.getState();
	state.pr = { number: 77, url: "https://github.com/test/private/pull/77", state: "OPEN" };
	state.requiredChecks = [{ name: "ci", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" }];
	state.protection = { required_status_checks: { contexts: ["ci"] } };
	f.setState(state);
	f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
	return remote;
}

/**
 * GitHub merges the PR inside the ship stage: while the store has a started ship run, `gh pr view` reports the PR
 * merged as `commit`. Every other call goes to the fixture's fake gh. The drive's merge check between stages sees OPEN.
 */
function mergeInShip(f: ReturnType<typeof driveFixture>, commit = SHA) {
	const gh = join(f.root, "fake-bin/gh"),
		base = join(f.root, "fake-bin/gh-base");
	writeFileSync(base, readFileSync(gh));
	chmodSync(base, 0o755);
	writeFileSync(
		gh,
		`#!${process.execPath}
const a=process.argv.slice(2);const {DatabaseSync}=require("node:sqlite");` +
			`const d=new DatabaseSync(${JSON.stringify(workDbPath(f.root))});d.exec("PRAGMA busy_timeout = 5000");` +
			`const shipping=d.prepare("SELECT 1 FROM runs WHERE stage = 'ship' AND status = 'started'").get();d.close();` +
			`if(shipping&&a[0]==="pr"&&a[1]==="view"){process.stdout.write(JSON.stringify({number:77,state:"MERGED",mergeCommit:{oid:${JSON.stringify(commit)}}}));process.exit(0)}` +
			`const r=require("node:child_process").spawnSync(${JSON.stringify(base)},a,{stdio:"inherit"});process.exit(r.status??1);\n`,
	);
}

test("OPS-70-pr: the pr stage runs the author checks at the head a simplifier committed and opens the PR there, with no round", () => {
	const f = driveFixture();
	try {
		const remote = withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		assert.equal(verify(f.root, f.task, "author", "full").passed, true, "the implementer's last verify, at head A");
		const a = head(f);
		const b = commitFile(f, "simplified.txt");
		assert.notEqual(a, b);
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		assert.equal(nextOf(f).stage, "pr");

		const n = driveOnce(f.root, f.task, TIMING);
		assert.equal(n.stage, "pr");
		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.role, f.runs().at(-1)!.status], ["pr", "evf", "passed"]);
		assert.equal(
			sh(f.root, "--git-dir", remote, "rev-parse", "refs/heads/task/ops-1"),
			b,
			"the PR branch is at the new head",
		);
		assert.equal(f.taskRow().pr_number, 77);
		assert.equal(f.taskRow().round, 0, "the round count does not change");
		const after = nextOf(f);
		assert.equal(after.stage, "verify");
		assert.equal(after.round, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("the pr stage's verify that gives up in the queue or the load wait reruns the pr stage: no implement run, no round, no escalation (AC:OPS-138-5 AC:OPS-138-11)", () => {
	const f = driveFixture();
	const real = os.loadavg;
	try {
		withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		commitFile(f, "simplified.txt");
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		const queue = join(evfDataDir(f.root), "check-queue");
		mkdirSync(queue, { recursive: true });
		const held = [1, 2, 3].map((n) => join(queue, `${String(n).padStart(15, "0")}.json`));
		for (const path of held)
			writeFileSync(path, JSON.stringify({ pid: process.pid, task: "OPS-H", at: new Date().toISOString() }));
		const timing = { ...TIMING, checkQueue: { waitMs: 30, pollMs: 5, now: Date.now, sleep } };
		const summaryOf = (id: number) =>
			(f.db.prepare("SELECT summary FROM runs WHERE id = ?").get(id) as { summary: string }).summary;
		const agents = () => f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start").length;
		const seats = agents();
		// More times than the retry cap: a give-up is no failure of the PR.
		for (let i = 0; i < RETRY_CAP + 1; i++) {
			assert.equal(driveOnce(f.root, f.task, timing).stage, "pr");
			const run = f.runs().at(-1)!;
			assert.deepEqual([run.stage, run.role, run.status], ["pr", "evf", "aborted"]);
			assert.match(summaryOf(run.id), /full check queue .*no check ran/);
			assert.equal(nextOf(f).stage, "pr");
		}

		for (const path of held) rmSync(path);
		const limited = { ...f.cfg, machineLoad: { maxPerCore: 0.000001, maxWaitMinutes: 0 } };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(limited));
		os.loadavg = () => [50, 50, 50];
		syncBuiltinESMExports();
		assert.equal(driveOnce(f.root, f.task, timing).stage, "pr");
		assert.equal(f.runs().at(-1)!.status, "aborted");
		assert.match(summaryOf(f.runs().at(-1)!.id), /The machine stayed above its load limit/);
		assert.equal(nextOf(f).stage, "pr");
		assert.equal(f.taskRow().round, 0);
		assert.equal(agents(), seats, "no seat started");
		assert.deepEqual(readdirSync(queue), [], "no ticket left");

		os.loadavg = real;
		syncBuiltinESMExports();
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
		assert.equal(driveOnce(f.root, f.task, timing).stage, "pr");
		assert.equal(f.runs().at(-1)!.status, "passed");
		assert.equal(nextOf(f).stage, "verify");
		assert.equal(f.taskRow().round, 0);
	} finally {
		os.loadavg = real;
		syncBuiltinESMExports();
		f.db.close();
		f.close();
	}
});

test("OPS-70-pr: the pr stage at a head that already has a passing author record does not rerun the checks", () => {
	const f = driveFixture();
	try {
		withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		assert.equal(verify(f.root, f.task, "author", "full").passed, true);
		const record = join(evidenceDir(f.root, f.task, head(f), "author-full"), "checks.json");
		const before = statSync(record).mtimeMs;
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), {
			status: "passed",
			summary: "nothing to remove",
		});
		driveOnce(f.root, f.task, TIMING);
		assert.equal(f.runs().at(-1)!.status, "passed");
		assert.equal(statSync(record).mtimeMs, before, "the record was not rewritten");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-70-pr: author checks that fail at a simplifier head send the task back to simplify with the failure, no round, no implement run; three in a row escalate", () => {
	const f = driveFixture({ failWhenFile: "tools/evf/FAIL" });
	try {
		withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		commitFile(f, "FAIL");
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		driveOnce(f.root, f.task, TIMING);
		const failed = f.runs().at(-1)!;
		assert.deepEqual([failed.stage, failed.status], ["pr", "failed"]);
		const after = nextOf(f);
		assert.equal(after.stage, "simplify");
		assert.equal(after.role, "simplifier");
		assert.equal(after.round, 0);
		assert.match(after.reason, /author checks failed at [0-9a-f]{10}: fixture-check/);
		assert.equal(f.taskRow().round, 0);

		driveOnce(f.root, f.task, TIMING);
		assert.equal(f.runs().at(-1)!.role, "simplifier", "the simplifier launches again");
		const prompt = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt")
			.at(-1)![3]!;
		assert.match(prompt, /^Simplify task OPS-1.*author checks.*failed.*author checks failed at/);
		assert.equal(f.runs().filter((r) => r.stage === "implement").length, 1, "no implement run starts");

		f.advance(); // Each simplifier commits, so the circuit breaker stays out of the pr failure count.
		runDone(f.root, f.runs().at(-1)!.id as number, { status: "passed", summary: "still failing" });
		driveOnce(f.root, f.task, TIMING);
		f.advance();
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "again" });
		driveOnce(f.root, f.task, TIMING);
		assert.equal(
			f.taskRow().status,
			"escalated",
			"three failed pr runs escalate although simplify passed between them",
		);
		assert.equal(f.taskRow().round, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-70-route: a pr failure that is not failed author checks goes to implement; an aborted seat launches its own stage again, same round", () => {
	const task = parseTask("OPS-1");
	const t = {
		id: 1,
		ref: task.id,
		slug: task.slug,
		mode: "implement",
		status: "active",
		round: 1,
		goal_id: null,
		spec: SPEC,
		pr_number: null,
	};
	const run = (stage: string, status: string, summary = "s", role = "x", id = 1) => ({
		id,
		stage,
		role,
		status,
		round: 1,
		summary,
	});
	assert.equal(
		nextStage(task, t, [run("simplify", "passed"), run("pr", "failed", "no PR body at x", "evf", 2)]).stage,
		"implement",
	);
	assert.equal(
		nextStage(task, t, [run("implement", "passed"), run("pr", "failed", "author checks failed at abc", "evf", 2)])
			.stage,
		"implement",
		"the head came from the implementer, not a simplifier",
	);
	for (const stage of ["plan", "implement", "simplify", "verify"])
		assert.equal(
			nextStage(task, t, [run(stage, "aborted", "gone", "x")]).stage,
			stage,
			`an aborted ${stage} seat launches again`,
		);
	assert.equal(nextStage(task, t, [run("verify", "aborted")]).round, 1, "and the round stays");
});

test("OPS-70-carry: proof carries to a later head; an unmet row, a missing criterion or a head outside the branch refuses the close", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const summary = f.file("approved.md", "Approved.");
		const close = (run: number, status = "passed") =>
			cli(f.root, {}, "run", "done", String(run), "--status", status, "--summary-file", summary);
		const a = head(f);
		proofAt(f, a, "1");
		proofAt(f, a, "2");
		const b = commitFile(f, "simplified.txt");
		const shown = JSON.parse(cli(f.root, {}, "proof", "show", "OPS-1", "--json").stdout);
		assert.deepEqual(
			shown.proofs.map((p: { carried: boolean }) => p.carried),
			[true, true],
		);
		assert.match(
			cli(f.root, {}, "proof", "show", "OPS-1").stdout,
			/0 at head, 2 total[^]*\(carried from an earlier head\)/,
		);
		const ok = close(f.insertRun("verify", "verifier", "started"));
		assert.equal(ok.status, 0, `(a) proven at A, simplifier commits B, verify closes at B: ${ok.stderr}`);

		// (b) Criterion 2 recorded unmet at B: the latest row wins, and the refusal names it.
		proofAt(f, b, "2", "unmet");
		const refused = close(f.insertRun("verify", "verifier", "started"));
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Done criteria 2 have no met or n\/a proof/);
		assert.doesNotMatch(refused.stderr, /Done criteria 1/);
		proofAt(f, b, "2", "n/a");
		f.advance(); // A commit before the second passed verify keeps the circuit breaker out of the proof gate test.
		assert.equal(close(f.runs().at(-1)!.id as number).status, 0, "a later met or n/a row at the head repairs it");

		// (c) A proof at a head that is not an ancestor of the current head does not count.
		sh(f.wt, "checkout", "-q", "-b", "side", a);
		const side = commitFile(f, "side.txt");
		sh(f.wt, "checkout", "-q", "task/ops-1");
		f.db.prepare("DELETE FROM proofs WHERE task_id = ?").run(f.taskId);
		proofAt(f, a, "1");
		proofAt(f, side, "2");
		const stale = close(f.insertRun("verify", "verifier", "started"));
		assert.equal(stale.status, 1);
		assert.match(stale.stderr, /Done criteria 2 have no met or n\/a proof/);
		assert.equal(
			JSON.parse(cli(f.root, {}, "proof", "show", "OPS-1", "--json").stdout).proofs.find(
				(p: { head_sha: string }) => p.head_sha === side,
			).carried,
			false,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

/** Herdr whose `agent wait` hangs, or whose agent is gone; everything else answers like fakeHerdr. */
function brokenHerdr(f: ReturnType<typeof driveFixture>, mode: "hang" | "gone") {
	const path = join(f.root, "fake-bin/herdr");
	const script = readFileSync(path, "utf8");
	const marker = "const a=process.argv.slice(2);\n";
	const guard =
		mode === "hang"
			? `if(a[0]==="agent"&&a[1]==="wait"){setInterval(()=>{},1000);return}\n`
			: `if(a[0]==="agent"&&(a[1]==="wait"||a[1]==="get")){process.stderr.write("no such agent");process.exit(1)}\n`;
	writeFileSync(path, script.replace(marker, marker + guard));
}

test("OPS-70-wait: a wait on a seat whose run already closed ends within two seat-poll intervals, although herdr agent wait hangs", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, false);
		brokenHerdr(f, "hang");
		const closer = spawn(
			process.execPath,
			[
				"-e",
				`setTimeout(() => require("node:child_process").spawnSync(process.execPath, [process.argv[1], "run", "done", process.argv[2], "--status", "passed", "--summary-file", process.argv[3]], { cwd: process.argv[4], env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_STAGE: "" } }), 150)`,
				join(source, "tools/evf/main.ts"),
				String(id),
				f.file("closed.md", "Closed by the seat."),
				f.root,
			],
			{ stdio: "inherit" },
		);
		const seatPollMs = 1500;
		const started = Date.now();
		driveOnce(f.root, f.task, { ...TIMING, waitMs: 60_000, seatPollMs });
		const elapsed = Date.now() - started;
		closer.kill();
		assert.equal(f.runs()[0]!.status, "passed");
		assert.ok(elapsed < 2 * seatPollMs, `the drive moved on after ${elapsed} ms`);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-70-gone: a started run whose Herdr agent is gone is aborted, and the next transition launches the stage again with the same round", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, false);
		f.db.prepare("UPDATE tasks SET round = 1 WHERE id = ?").run(f.taskId);
		brokenHerdr(f, "gone");
		driveOnce(f.root, f.task, TIMING);
		assert.equal(f.runs()[0]!.status, "aborted");
		assert.equal(f.events("seat_gone").length, 1);
		assert.equal(f.taskRow().round, 1);
		const next = nextOf(f);
		assert.deepEqual([next.stage, next.role, next.round], ["implement", "implementer", 1]);
		driveOnce(f.root, f.task, TIMING);
		const runs = f.runs();
		assert.equal(runs.length, 2);
		assert.deepEqual(
			[runs[1]!.stage, runs[1]!.role, runs[1]!.status, runs[1]!.round],
			["implement", "implementer", "started", 1],
		);
		assert.notEqual(runs[1]!.id, id);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-70-flow: fake seats take a task from plan to merged through plan, implement, simplify, pr, verify, ci and ship with no evidence run", () => {
	const f = driveFixture(),
		log = console.log;
	try {
		const made = cli(f.root, {}, "task", "new", "OPS-1", "--ask-file", f.file("ask.md", "Make the doghouse usable."));
		assert.equal(made.status, 0, made.stderr);
		withPr(f);
		mergeInShip(f);
		f.db.prepare("UPDATE tasks SET spec = NULL, status = 'new' WHERE id = ?").run(f.taskId);
		// Every `agent wait` is the seat doing its stage work and closing the run named in the agent name.
		const main = join(source, "tools/evf/main.ts"),
			summary = f.file("seat-summary.md", "Done."),
			spec = f.file("spec.md", SPEC);
		const path = join(f.root, "fake-bin/herdr");
		const script = readFileSync(path, "utf8");
		const marker = "const a=process.argv.slice(2);\n";
		const seat =
			`if(a[0]==="agent"&&a[1]==="wait"){const m=/^(planner|implementer|simplifier|verifier)-ops-1-(\\d+)$/.exec(a[2]);if(m){const cp=require("node:child_process");` +
			`const evf=(...x)=>cp.spawnSync(process.execPath,[${JSON.stringify(main)},...x],{cwd:${JSON.stringify(f.root)},env:{...process.env,EVF_RUN:"",EVF_WORKTREE:"",EVF_STAGE:""}});` +
			`if(m[1]==="planner")evf("task","spec","OPS-1","--file",${JSON.stringify(spec)});` +
			`if(m[1]==="implementer")for(const c of["1","2"])evf("proof","add","OPS-1","--criterion",c,"--status","met","--evidence","shot.png");` +
			`if(m[1]==="simplifier"){const wt=${JSON.stringify(f.wt)};require("node:fs").writeFileSync(wt+"/tools/evf/simplified.txt","x");cp.spawnSync("git",["-C",wt,"add","tools/evf"]);cp.spawnSync("git",["-C",wt,"commit","-qm","simplify"])}` +
			`evf("run","done",m[2],"--status","passed","--summary-file",${JSON.stringify(summary)})}}\n`;
		writeFileSync(path, script.replace(marker, marker + seat));
		console.log = () => {};
		const code = drive(f.root, f.task, {}, { ...TIMING, waitMs: 60_000, seatPollMs: 10 });
		console.log = log;
		assert.equal(code, 0);
		assert.equal(f.taskRow().status, "merged");
		const runs = f.runs();
		assert.deepEqual(
			runs.map((r) => r.stage),
			["plan", "implement", "simplify", "pr", "verify", "ci", "ship"],
		);
		assert.deepEqual(
			runs.map((r) => r.role),
			["planner", "implementer", "simplifier", "evf", "verifier", "evf", "evf"],
		);
		assert.ok(runs.every((r) => r.status === "passed" && r.round === 0));
		assert.equal(
			f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start" && /^evidence/.test(c[2] ?? "")).length,
			0,
		);
		const prompts = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt")
			.map((c) => c[3]!);
		assert.match(
			prompts.find((p) => /^Implement task/.test(p))!,
			/add tests.*390 and 1440 px.*bin\/evf proof add OPS-1/,
		);
		assert.match(
			prompts.find((p) => /^Verify task/.test(p))!,
			/full diff.*re-run a flow only where a proof is unmet, missing or looks wrong.*capture it/,
		);
	} finally {
		console.log = log;
		f.db.close();
		f.close();
	}
});

test("OPS-70-seats: the implementer allowlist covers the proof commands, the evidence seat is gone and launch lists the valid roles", () => {
	const agent = readFileSync(join(source, ".claude/agents/implementer.md"), "utf8");
	const tools = /^tools: (.*)$/m.exec(agent)![1]!;
	const entries = [...tools.matchAll(/Bash\(([^)]*)\)/g)].map((m) => m[1]!);
	const glob = (pattern: string) =>
		new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	const proofCommands: string[] = [
		"portless preview up --pr 12",
		"node .agents/skills/verify-preview/scripts/preview.mjs --pr 12",
		"node /work/repo/.agents/skills/verify-preview/scripts/capture.mjs --after http://x --out /tmp/e",
		"node .agents/skills/verify-preview/scripts/publish.mjs /tmp/e --task OPS-70",
		"bin/evf browser run --timeout 900 -- node flow.mjs",
		"agent-browser --session s open http://x",
		"corepack pnpm --filter @everyfield/db reset:dev",
	];
	for (const command of proofCommands)
		assert.ok(
			entries.some((entry) => glob(entry).test(command)),
			`an allowlist entry matches: ${command}`,
		);
	assert.match(agent, /^skills: .*better-interface.*better-ui/m, "the implementer loads the better-* UI skills");
	assert.match(agent, /\.agents\/roles\/ui-designer\.md/);
	assert.equal(existsSync(join(source, ".claude/agents/evidence.md")), false);

	const f = driveFixture();
	try {
		const r = cli(f.root, {}, "launch", "OPS-1", "--role", "evidence", "--dry-run");
		assert.notEqual(r.status, 0);
		assert.match(
			r.stderr,
			/--role must be one of planner, implementer, ui, simplifier, verifier, ideator, comparer, prototype-merger/,
		);
		assert.doesNotMatch(cli(f.root, {}, "help").stdout, /evidence stage|evidence seat|→ evidence/);
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-72: the drive survives a launch that fails, never escalates while a seat works, hands a reopen reason to the next
// seat, counts the start grace from the start of the wait and closes stale task rows.
const quietly = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("OPS-72-launchfail: a launch that fails twice closes its run with the pane excerpt; the drive logs it, goes on and the retry cap ends it", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		f.herdr.setState({ startFails: true, screen: "$ claude --agent evidence\nError: agent not found\n" });
		// One transition: the launch fails, the error does not escape, the run is closed with what the pane showed.
		const lines: string[] = [];
		const log = console.log;
		console.log = (line: string) => lines.push(line);
		try {
			assert.equal(driveOnce(f.root, f.task, TIMING).stage, "implement");
		} finally {
			console.log = log;
		}
		const first = f.runs();
		assert.equal(first.length, 1);
		assert.equal(first[0]!.status, "aborted");
		assert.ok(
			lines.some((l) => /drive OPS-1: launch of implementer failed: .*Error: agent not found/.test(l)),
			lines.join("\n"),
		);
		const summary = (f.db.prepare("SELECT summary FROM runs WHERE id = ?").get(first[0]!.id) as { summary: string })
			.summary;
		assert.match(summary, /timed out waiting for agent startup/);
		assert.match(summary, /Error: agent not found/);
		assert.equal(
			f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start").length,
			2,
			"one retry inside the launch",
		);

		// The loop goes on to its next transitions; the retry cap, not an uncaught error, ends it.
		const code = quietly(() => drive(f.root, f.task, {}, TIMING));
		assert.equal(code, 2, "escalated, not crashed");
		assert.equal(f.runs().length, RETRY_CAP);
		assert.ok(f.runs().every((r) => r.status === "aborted"));
		assert.ok(f.events("next").length >= RETRY_CAP, "nextStage ran between the failed launches");
		assert.equal(f.taskRow().status, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

/** An open seat run with a Herdr agent the fake Herdr knows. */
const openAgentRun = (f: ReturnType<typeof driveFixture>, stage: string, role: string) => {
	const id = f.insertRun(stage, role, "started");
	f.db.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = 'w9:p1' WHERE id = ?").run(`${role}-ops-1-${id}`, id);
	return id;
};

test("OPS-72-defer: a verify that fails past the loop cap does not escalate while another seat works; the last seat to close does", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active', round = ? WHERE id = ?").run(SPEC, LOOP_CAP, f.taskId);
		const verifyRun = openAgentRun(f, "verify", "verifier");
		const other = openAgentRun(f, "implement", "implementer");
		runDone(f.root, verifyRun, { status: "failed", summary: "Findings: the roof leaks." });
		assert.equal(f.taskRow().round, LOOP_CAP + 1);
		assert.equal(f.taskRow().status, "active", "the other seat still works");
		assert.equal(f.events("escalation").length, 0);
		const held = f.events("escalation_deferred");
		assert.equal(held.length, 1);
		assert.match(held[0]!.payload, /loop cap 3 hit after verify failed\. Findings: the roof leaks\./);
		const n = nextOf(f);
		assert.deepEqual([n.stage, n.run], ["waiting", other]);
		assert.match(n.deferred, /loop cap 3 hit after verify failed/);

		runDone(f.root, other, { status: "passed", summary: "Built." });
		assert.equal(f.taskRow().status, "escalated", "escalated when the last open seat closed");
		const escalation = f.events("escalation");
		assert.equal(escalation.length, 1);
		assert.match(
			escalation[0]!.payload,
			/needs Sebastian: loop cap 3 hit after verify failed\. Findings: the roof leaks\./,
			"with the reason it would have had",
		);
		assert.equal(nextOf(f).stage, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-defer: a seat whose Herdr agent is gone does not hold the escalation back", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active', round = ? WHERE id = ?").run(SPEC, LOOP_CAP, f.taskId);
		const verifyRun = openAgentRun(f, "verify", "verifier");
		openAgentRun(f, "implement", "implementer");
		brokenHerdr(f, "gone");
		runDone(f.root, verifyRun, { status: "failed", summary: "Findings: the roof leaks." });
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(f.events("escalation_deferred").length, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-defer: three failures in a row wait for the open seat too, and the retry cap's reason survives the seat passing", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const other = openAgentRun(f, "simplify", "simplifier");
		failStage(f, "implement", "implementer", RETRY_CAP);
		assert.equal(f.taskRow().status, "active");
		assert.equal(f.events("escalation_deferred").length, 1);
		runDone(f.root, other, { status: "passed", summary: "Simplified." });
		assert.equal(f.taskRow().status, "escalated");
		assert.match(f.events("escalation")[0]!.payload, /3 failures in a row, last in implement/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-reopen: the first seat after a reopen gets the coordinator's reason verbatim, not the old failure summary", () => {
	const f = driveFixture();
	try {
		f.db
			.prepare("UPDATE tasks SET spec = ?, status = 'escalated', ask = ?, round = 2 WHERE id = ?")
			.run(SPEC, "Make the doghouse usable.", f.taskId);
		const old = f.insertRun("implement", "implementer", "failed");
		const S = "implement failed: the roof leaks in 17 places";
		f.db.prepare("UPDATE runs SET summary = ? WHERE id = ?").run(S, old);
		const R = 'start from the spec again; the "gate" moved to CI';
		const r = reopen(f, R);
		assert.equal(r.status, 0, r.stderr);
		const n = nextOf(f);
		assert.equal(n.stage, "implement");
		assert.match(n.reason, /reopened by the coordinator/);
		assert.ok(n.reason.includes(R), n.reason);
		assert.ok(!n.reason.includes("17 places"), "the reason after a reopen is not the old summary");

		driveOnce(f.root, f.task, TIMING);
		const prompt = f.herdr.calls().find((c) => c[0] === "agent" && c[1] === "prompt")![3]!;
		assert.ok(prompt.includes(R), "the prompt carries the reason verbatim");
		assert.ok(!prompt.includes("17 places"), "and not the pre-reopen summary");
		assert.doesNotMatch(prompt, /Read the last verify or ci summary/);
		assert.match(prompt, /^The coordinator reopened this task\./);

		// The session-start context shows it too, and keeps it when it shortens the rest.
		f.db
			.prepare("UPDATE tasks SET spec = ? WHERE id = ?")
			.run(
				`Goal: g.\nDone criteria:\n${Array.from({ length: 40 }, (_, i) => `${i + 1}. ${"criterion text ".repeat(20)}`).join("\n")}\nNon-goals: none.`,
				f.taskId,
			);
		const ctx = cli(f.root, {}, "refocus", "OPS-1").stdout;
		assert.match(ctx, /SHORTENED/);
		assert.ok(ctx.includes(R), "the shortened context keeps the reopen reason");

		// A seat that passed after the reopen ends the reopen reason's hold on the prompts.
		runDone(f.root, f.runs().at(-1)!.id as number, { status: "passed", summary: "Built." });
		driveOnce(f.root, f.task, TIMING);
		const later = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt")
			.at(-1)![3]!;
		assert.ok(!later.includes(R));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-grace: the start grace counts from the start of the wait, not from the prompt that went out a minute ago", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, true);
		f.db
			.prepare("UPDATE events SET ts = ? WHERE run_id = ? AND type = 'prompt_sent'")
			.run(new Date(Date.now() - 60_000).toISOString(), id);
		// The seat reports idle at first, three polls later its turn begins, then it closes its stage.
		scriptedHerdr(f, id, { waits: ["idle", "close"], gets: ["idle", "idle", "idle", "working"] });
		// The grace is far longer than four polls take under load, and still shorter than the minute since the prompt.
		driveOnce(f.root, f.task, { ...TIMING, startGraceMs: 30_000, seatPollMs: 10 });
		const nudges = f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "prompt");
		assert.equal(nudges.length, 0, "no nudge: the grace had not run out");
		assert.equal(f.events("nudge").length, 0);
		assert.equal(f.runs()[0]!.status, "passed");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-abandon: a stale row closes with an abandon event; merged rows, open runs, live drives and seats are refused", () => {
	const f = driveFixture();
	try {
		const abandon = (extra: string[], env: Record<string, string> = {}) =>
			cli(f.root, env, "task", "abandon", "OPS-1", ...extra);
		const status = (id: number) =>
			(f.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
		assert.match(cli(f.root, {}, "help").stdout, /^ {2}evf task abandon <task> \[--id <store id>\] --reason/m);

		assert.match(abandon(["--reason", "stale"]).stderr, /two words or more/);
		assert.match(abandon(["--reason", "shipped long ago"], { EVF_RUN: "7" }).stderr, /seat cannot abandon/);
		assert.equal(status(f.taskId), "new", "refusals change nothing");

		// A second and third row of the same ref, as the leftover rows were.
		const insert = (st: string, commit: string | null = null) =>
			Number(
				f.db
					.prepare(
						"INSERT INTO tasks (slug, mode, ref, title, status, merge_commit, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'OPS-1', ?, ?, ?, ?)",
					)
					.run(st, commit, new Date().toISOString(), new Date().toISOString()).lastInsertRowid,
			);
		const merged = insert("merged", "abc123"),
			active = insert("active");
		assert.match(abandon(["--id", String(merged), "--reason", "shipped long ago"]).stderr, /is merged/);
		assert.match(abandon(["--id", "999", "--reason", "shipped long ago"]).stderr, /not a row of OPS-1/);

		const open = f.db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', ?)",
			)
			.run(active, new Date().toISOString()).lastInsertRowid;
		assert.match(abandon(["--id", String(active), "--reason", "shipped long ago"]).stderr, /has a started run/);
		f.db.prepare("UPDATE runs SET status = 'aborted' WHERE id = ?").run(open);

		const holder = spawn("sleep", ["30"]);
		const pidFile = join(evfDataDir(f.root), "drive", "ops-1.pid");
		mkdirSync(join(evfDataDir(f.root), "drive"), { recursive: true });
		writeFileSync(pidFile, `${holder.pid}\n`);
		try {
			assert.match(
				abandon(["--id", String(active), "--reason", "shipped long ago"]).stderr,
				/evf drive runs for OPS-1/,
			);
		} finally {
			holder.kill();
		}
		assert.equal(status(active), "active");
		writeFileSync(pidFile, "99999999\n");

		const done = abandon(["--id", String(active), "--reason", "shipped as PR 351 long ago"]);
		assert.equal(done.status, 0, done.stderr);
		assert.equal(status(active), "abandoned");
		assert.equal(status(merged), "merged", "only the chosen row changed");
		const event = f.db
			.prepare("SELECT id, task_id, payload FROM events WHERE type = 'abandon' AND task_id = ?")
			.get(active) as { id: number; payload: string };
		assert.deepEqual(
			{ reason: JSON.parse(event.payload).reason, from: JSON.parse(event.payload).from },
			{ reason: "shipped as PR 351 long ago", from: "active" },
		);
		assert.ok(done.stdout.includes(`event ${event.id}`), done.stdout);
		assert.match(abandon(["--id", String(active), "--reason", "shipped long ago"]).stderr, /already abandoned/);

		// Without --id the current row is the newest open one: here the merged row, which is refused with the choices.
		const plain = abandon(["--reason", "shipped under another ref"]);
		assert.match(plain.stderr, /is merged.*pick one with --id/);
		assert.equal(abandon(["--id", String(f.taskId), "--reason", "shipped under another ref"]).status, 0);
		assert.equal(status(f.taskId), "abandoned");
		assert.equal(status(merged), "merged");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-69-gone: a seat whose Herdr agent is gone is aborted with the usage of its transcript so far", () => {
	const f = driveFixture(),
		saved = process.env.CLAUDE_CONFIG_DIR,
		claude = join(f.root, "claude-config"),
		session = "44444444-4444-4444-8444-444444444444";
	try {
		process.env.CLAUDE_CONFIG_DIR = claude;
		const id = openSeatRun(f, false);
		f.db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(session, id);
		writeTranscript(claude, session, [assistantLine("a", "claude-sonnet-5-5", { input: 100, output: 50, read: 1000 })]);
		brokenHerdr(f, "gone");
		driveOnce(f.root, f.task, TIMING);
		const row = f.db.prepare("SELECT status, tokens_in, tokens_out, cache_read_tokens FROM runs WHERE id = ?").get(id);
		assert.deepEqual({ ...row }, { status: "aborted", tokens_in: 100, tokens_out: 50, cache_read_tokens: 1000 });
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved;
		f.db.close();
		f.close();
	}
});

// OPS-74: waits between launch aborts, and an over-long launch line that escalates at once.
test("OPS-74-backoff: three launch aborts in a row wait 1x then 2x the backoff between launches; the third escalates without a wait", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		f.herdr.setState({ startFails: true, screen: "claude: command not found" });
		const timing = { ...TIMING, abortBackoffMs: 150, launch: { paneReadyPollMs: 5 } };
		const lines: string[] = [];
		const log = console.log;
		console.log = (line: string) => lines.push(String(line));
		const took: number[] = [];
		try {
			for (let i = 0; i < 3; i++) {
				const t0 = Date.now();
				driveOnce(f.root, f.task, timing);
				took.push(Date.now() - t0);
			}
			assert.equal(driveOnce(f.root, f.task, timing).stage, "escalated");
		} finally {
			console.log = log;
		}
		assert.deepEqual(
			f.runs().map((r) => r.status),
			["aborted", "aborted", "aborted"],
		);
		const waits = lines.filter((l) => /waiting [\d.]+ s before the implementer launches again/.test(l));
		assert.equal(waits.length, 2, lines.join("\n"));
		assert.match(waits[0]!, /launch abort 1 of 3; waiting 0\.15 s/);
		assert.match(waits[1]!, /launch abort 2 of 3; waiting 0\.3 s/);
		assert.ok(took[0]! >= 150 && took[1]! >= 300, `waits ran: ${took.join(", ")}`);
		assert.ok(!lines.some((l) => /launch abort 3/.test(l)), "the third abort waits for nothing");
		assert.match(f.events("escalation")[0]!.payload, /3 failures in a row without a passed stage/);
		assert.equal(f.taskRow().status, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-74-toolong: a launch line over the limit escalates the task at once with the byte count, without a retry or a run", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const lines: string[] = [];
		const log = console.log;
		console.log = (line: string) => lines.push(String(line));
		try {
			assert.equal(driveOnce(f.root, f.task, { ...TIMING, launch: { typedLineLimit: 100 } }).stage, "implement");
		} finally {
			console.log = log;
		}
		assert.equal(f.taskRow().status, "escalated", "escalated after one launch, not three");
		assert.equal(f.runs().length, 0, "no run row, so no failure counted");
		assert.match(
			f.events("escalation")[0]!.payload,
			/launch line for implementer is \d+ bytes; the terminal accepts fewer than 100\./,
		);
		assert.ok(
			lines.some((l) => /launch of implementer refused: .*fewer than 100\./.test(l)),
			lines.join("\n"),
		);
		assert.equal(f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start").length, 0);
		assert.equal(driveOnce(f.root, f.task, TIMING).stage, "escalated");
	} finally {
		f.db.close();
		f.close();
	}
});

const NO_PROMISE = { EVF_MONITOR: "", EVF_FOREGROUND: "" };

/** Run a command to its end with no controlling terminal and without either foreground variable. */
function detached(f: { root: string }, args: string[], env: Record<string, string> = {}): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
			cwd: f.root,
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				EVF_RUN: "",
				EVF_WORKTREE: "",
				EVF_SESSION: "",
				EVF_ROLE: "",
				EVF_STAGE: "",
				...NO_PROMISE,
				...env,
			},
		});
		child.on("exit", resolve);
	});
}

const nestedLog = (f: ReturnType<typeof driveFixture>) =>
	readFileSync(
		(
			JSON.parse(readFileSync(join(evidenceDir(f.root, f.task, head(f), "author-full"), "checks.json"), "utf8")) as {
				checks: Array<{ log: string }>;
			}
		).checks[0]!.log,
		"utf8",
	);

test("OPS-75-drive: a drive with no terminal and no foreground variable passes the pr-stage checks that run a guarded evf command", async () => {
	const f = driveFixture({ nested: ["check", "OPS-1"] });
	try {
		withPr(f);
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		assert.equal(nextOf(f).stage, "pr");
		assert.equal(await detached(f, ["drive", "OPS-1", "--once"]), 0);
		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.role, f.runs().at(-1)!.status], ["pr", "evf", "passed"]);
		assert.equal(f.taskRow().pr_number, 77);
		const log = nestedLog(f);
		assert.match(log, /nested exit 0/);
		assert.doesNotMatch(log, /detached from a terminal/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-75-detach: evf drive --detach passes the pr-stage checks with neither foreground variable", async () => {
	const f = driveFixture({ nested: ["check", "OPS-1"] });
	try {
		withPr(f);
		// --detach starts <root>/tools/evf/main.ts; the fixture root has the templates only.
		symlinkSync(join(source, "tools/evf/main.ts"), join(f.root, "tools/evf/main.ts"));
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		assert.equal(await detached(f, ["drive", "OPS-1", "--once", "--detach"]), 0);
		for (let i = 0; i < 600 && f.runs().at(-1)?.stage !== "pr"; i++) sleep(100);
		for (let i = 0; i < 600 && f.runs().at(-1)?.status === "started"; i++) sleep(100);
		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.status], ["pr", "passed"]);
		assert.doesNotMatch(nestedLog(f), /detached from a terminal/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-75-verify: a guarded evf command inside a top-level verify check runs and logs its own output", async () => {
	for (const command of [
		["check", "OPS-1"],
		["verify", "OPS-1"],
	]) {
		const f = driveFixture({ nested: command });
		try {
			// The nested command inherits the top level's EVF_FOREGROUND=1. Only the check runner sets EVF_MONITOR,
			// so its value shows the runner gave the promise.
			assert.equal(await detached(f, ["verify", "OPS-1"], { EVF_FOREGROUND: "1" }), 0, command.join(" "));
			const log = nestedLog(f);
			assert.match(log, /nested exit 0/);
			assert.match(log, /PASSED/);
			assert.match(log, /^monitor evf verify OPS-1$/m);
			assert.doesNotMatch(log, /detached from a terminal/);
		} finally {
			f.db.close();
			f.close();
		}
	}
});

test("OPS-75-seat: a seat the drive launches carries the promise naming the drive; a manual launch does not", () => {
	const f = driveFixture();
	try {
		const ask = f.file("ask.md", "Make the doghouse usable.");
		assert.equal(cli(f.root, {}, "task", "new", "OPS-1", "--ask-file", ask, "--title", "Usable doghouse").status, 0);
		const manual = cli(f.root, {}, "launch", "OPS-1", "--role", "planner", "--dry-run");
		assert.equal(manual.status, 0, manual.stderr);
		assert.doesNotMatch(manual.stdout, /EVF_MONITOR/);
		driveOnce(f.root, f.task, TIMING);
		const create = f.herdr.calls().find((c) => c[0] === "workspace" && c[1] === "create")!;
		assert.ok(create.includes("EVF_MONITOR=evf drive OPS-1"), create.join(" "));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-100-signal: SIGTERM to a real drive blocked in its ship stage aborts the run, records drive_stopped, removes the pid file and exits 143", async () => {
	const f = driveFixture();
	let blocker = 0;
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'pr_open', pr_number = 77 WHERE id = ?").run(SPEC, f.taskId);
		const head = spawnSync("git", ["-C", f.wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
		for (const c of ["1", "2"])
			f.db
				.prepare("INSERT INTO proofs (task_id, head_sha, criterion, status, created_at) VALUES (?, ?, ?, 'met', ?)")
				.run(f.taskId, head, c, new Date().toISOString());
		runDone(f.root, f.insertRun("verify", "verifier", "started"), { status: "passed", summary: "approved" });
		runDone(f.root, f.insertRun("ci", "evf", "started"), { status: "passed", summary: "green" });
		// The merge check before the stage sees an open PR. Every later gh call blocks, so the ship stage sits inside
		// spawnSync, which holds Node's event loop.
		const marker = join(f.root, "gh-blocked.pid"),
			checked = join(f.root, "gh-checked");
		writeFileSync(
			join(f.root, "fake-bin/gh"),
			`#!${process.execPath}\nconst fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(checked)})){fs.writeFileSync(${JSON.stringify(checked)},"");process.stdout.write('{"state":"OPEN"}');process.exit(0)}fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},60000)\n`,
		);
		chmodSync(join(f.root, "fake-bin/gh"), 0o755);
		// A shell reports how the drive ended: 128 + the signal number when a signal ended it.
		const status = join(f.root, "drive-status.txt");
		const child = spawn(
			"sh",
			[
				"-c",
				`"$0" --disable-warning=ExperimentalWarning "$1" drive OPS-1; echo $? > "$2"`,
				process.execPath,
				join(source, "tools/evf/main.ts"),
				status,
			],
			{
				cwd: f.root,
				env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" },
				stdio: "ignore",
			},
		);
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(existsSync(marker), "the ship stage reached gh");
		blocker = Number(readFileSync(marker, "utf8"));
		const pidFile = join(evfDataDir(f.root), "drive", "ops-1.pid");
		const drivePid = Number(readFileSync(pidFile, "utf8"));
		const started = Date.now();
		process.kill(drivePid, "SIGTERM");
		await exited;
		assert.ok(Date.now() - started < 10_000, "the drive ends at once, not when the blocked stage returns");
		assert.equal(readFileSync(status, "utf8").trim(), "143");
		const ship = f.db.prepare("SELECT status, summary FROM runs WHERE task_id = ? AND stage = 'ship'").get(f.taskId);
		assert.deepEqual({ ...ship }, { status: "aborted", summary: "drive stopped by SIGTERM during ship" });
		const stopped = f.events("drive_stopped");
		assert.equal(stopped.length, 1);
		assert.deepEqual(
			{ stage: JSON.parse(stopped[0].payload).stage, signal: JSON.parse(stopped[0].payload).signal },
			{ stage: "ship", signal: "SIGTERM" },
		);
		assert.ok(!existsSync(pidFile), "the pid file is gone");
	} finally {
		if (blocker) {
			try {
				process.kill(blocker);
			} catch {
				// Already gone.
			}
		}
		f.db.close();
		f.close();
	}
});

// OPS-115: the circuit breaker and the simplify skip.
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const progressOf = (f: ReturnType<typeof driveFixture>, id: number) =>
	({ ...(f.db.prepare("SELECT progress_head, progress_spec FROM runs WHERE id = ?").get(id) as object) }) as {
		progress_head: string | null;
		progress_spec: string | null;
	};
const close = (
	f: ReturnType<typeof driveFixture>,
	stage: string,
	role: string,
	status: "passed" | "failed",
	summary: string,
) => {
	const id = f.insertRun(stage, role, "started");
	runDone(f.root, id, { status, summary });
	return id;
};
/** Make the fake Herdr act as seats: on `agent wait` for a matching agent, run `js` (it has evf, cp, m and wt), then close passed. */
function fakeSeats(f: ReturnType<typeof driveFixture>, roles: string, js = "") {
	const main = join(source, "tools/evf/main.ts"),
		summary = f.file("seat-summary.md", "Closed with no change.\nSecond line.");
	const path = join(f.root, "fake-bin/herdr");
	const marker = "const a=process.argv.slice(2);\n";
	const seat =
		`if(a[0]==="agent"&&a[1]==="wait"){const m=/^(${roles})-ops-1-(\\d+)$/.exec(a[2]);if(m){const cp=require("node:child_process"),wt=${JSON.stringify(f.wt)};` +
		`const evf=(...x)=>cp.spawnSync(process.execPath,[${JSON.stringify(main)},...x],{cwd:${JSON.stringify(f.root)},env:{...process.env,EVF_RUN:"",EVF_WORKTREE:"",EVF_STAGE:""}});` +
		js +
		`evf("run","done",m[2],"--status","passed","--summary-file",${JSON.stringify(summary)})}}\n`;
	writeFileSync(path, readFileSync(path, "utf8").replace(marker, marker + seat));
}
const agentStarts = (f: ReturnType<typeof driveFixture>, role: string) =>
	f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start" && new RegExp(`^${role}-`).test(c[2] ?? ""))
		.length;
const quiet = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("OPS-115-fingerprint: a seat that closes plan, implement (ui seat too), simplify or verify records HEAD and the spec hash; evf's stages and older runs carry none", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const at = head(f);
		for (const [stage, role] of [
			["plan", "planner"],
			["implement", "ui"],
			["simplify", "simplifier"],
			["verify", "verifier"],
		] as const) {
			f.advance();
			const id = close(f, stage, role, "failed", `${stage} closed`);
			assert.deepEqual(progressOf(f, id), { progress_head: head(f), progress_spec: sha256(SPEC) }, stage);
		}
		assert.notEqual(head(f), at);
		const pr = close(f, "pr", "evf", "failed", "no PR body");
		assert.deepEqual(progressOf(f, pr), { progress_head: null, progress_spec: null }, "evf's own stage");
		const columns = (f.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(columns.includes("progress_head") && columns.includes("progress_spec"), "migration 009 adds the fields");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-breaker: two implement runs closed passed at the same head and spec escalate with the stage, both run ids, the head and both summary lines", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		// A run closed before the migration has no fingerprint and never counts as run A.
		const old = f.insertRun("implement", "implementer", "passed");
		f.db.prepare("UPDATE runs SET summary = 'old pass' WHERE id = ?").run(old);
		const a = close(f, "implement", "implementer", "passed", "Built the roof.\nDetails follow.");
		assert.equal(f.taskRow().status, "active", "one fingerprinted close never trips");
		const b = close(f, "implement", "implementer", "passed", "Built the roof again.");
		assert.equal(f.taskRow().status, "escalated");
		const short = head(f).slice(0, 10);
		const escalation = JSON.parse(f.events("escalation")[0]!.payload).summary as string;
		assert.equal(
			escalation,
			`OPS-1 needs Sebastian: no progress: implement closed passed twice at ${short} with an unchanged spec (runs ${a} and ${b}). Run ${a}: "Built the roof."; run ${b}: "Built the roof again.". Restart after a fix with evf task reopen OPS-1 --reason "<words>".`,
		);
		const note = f.herdr.calls().find((c) => c[0] === "notification" && c[2] === "OPS-1 escalated")!;
		assert.ok(note[4]!.includes('"Built the roof."') && note[4]!.includes('"Built the roof again."'), note[4]);
		const shown = cli(f.root, {}, "status", "OPS-1");
		assert.ok(shown.stdout.includes(`no progress: implement closed passed twice at ${short}`), shown.stdout);
		assert.equal(nextOf(f).stage, "escalated");
		assert.match(nextOf(f).reason, new RegExp(`^no progress: implement .*runs ${a} and ${b}`));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-progress: a commit between two implement closes, or a changed spec between two plan closes, does not trip the breaker", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET status = 'active' WHERE id = ?").run(f.taskId);
		close(f, "plan", "planner", "passed", "Planned.");
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
		close(f, "plan", "planner", "passed", "Planned again.");
		assert.equal(f.taskRow().status, "active", "a stored spec is progress");
		close(f, "implement", "implementer", "passed", "Built.");
		commitFile(f, "roof.txt");
		close(f, "implement", "implementer", "passed", "Built more.");
		assert.equal(f.taskRow().status, "active", "a commit is progress");
		assert.equal(f.events("escalation").length, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-status: passed then failed at one fingerprint does not trip the breaker; the retry cap still ends a failing run of stages", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		close(f, "implement", "implementer", "passed", "Built.");
		close(f, "implement", "implementer", "failed", "Broke it.");
		assert.equal(f.taskRow().status, "active");
		failStage(f, "implement", "implementer", RETRY_CAP - 1);
		assert.equal(f.taskRow().status, "escalated");
		assert.match(f.events("escalation")[0]!.payload, /3 failures in a row, last in implement/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-seat: aborted runs, evf's own stages and runs evf closed for the seat are neither run A nor run B", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const a = close(f, "implement", "implementer", "passed", "Built.");
		// The drive closes a run that has no Herdr agent for the seat: no fingerprint, no trip.
		const noAgent = f.insertRun("implement", "implementer", "started");
		quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.equal(f.runs().find((r) => r.id === noAgent)!.status, "failed");
		assert.deepEqual(progressOf(f, noAgent), { progress_head: null, progress_spec: null });
		runDone(f.root, f.insertRun("implement", "implementer", "started"), {
			status: "passed",
			summary: "closed by evf",
			closedBy: "evf",
		});
		f.insertRun("implement", "implementer", "aborted");
		close(f, "pr", "evf", "passed", "PR open");
		assert.equal(f.taskRow().status, "active", "none of these counts as run B");
		const b = close(f, "implement", "implementer", "passed", "Built again.");
		assert.equal(f.taskRow().status, "escalated", "nor as run A: the seat's own closes match");
		assert.match(f.events("escalation")[0]!.payload, new RegExp(`runs ${a} and ${b}`));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-next: nextStage escalates on the last two fingerprinted closes of a seat stage after the marker, and names the cause", () => {
	const task = parseTask("OPS-1");
	const t = {
		id: 1,
		ref: task.id,
		slug: task.slug,
		mode: "implement",
		status: "active",
		round: 0,
		goal_id: null,
		spec: SPEC,
		pr_number: null,
		worktree: null,
		seat_model: null,
		seat_effort: null,
	};
	const run = (id: number, stage: string, status: string, head: string | null, summary = `s${id}`) => ({
		id,
		stage,
		role: "x",
		status,
		round: 0,
		summary,
		progress_head: head,
		progress_spec: head ? "spec" : null,
	});
	const H = "a".repeat(40);
	const stuck = [
		run(1, "implement", "passed", H, "Built."),
		run(2, "simplify", "passed", H),
		run(3, "pr", "failed", null),
		run(4, "implement", "passed", H, "Built again."),
	];
	const n = nextStage(task, t, stuck);
	assert.equal(n.stage, "escalated");
	assert.equal(
		n.reason,
		`no progress: implement closed passed twice at aaaaaaaaaa with an unchanged spec (runs 1 and 4). Run 1: "Built."; run 4: "Built again.". Restart after a fix with evf task reopen OPS-1 --reason "<words>".`,
	);
	assert.equal(
		nextStage(task, { ...t, status: "escalated" }, stuck).reason,
		n.reason,
		"an escalated task names it too",
	);
	assert.equal(nextStage(task, t, stuck, false, 1).stage, "simplify", "run 1 is before the reopen marker");
	const moved = [...stuck.slice(0, 3), run(4, "implement", "passed", "b".repeat(40))];
	assert.equal(nextStage(task, t, moved).stage, "simplify");
	const unmarked = stuck.map((r) => ({ ...r, progress_head: null, progress_spec: null }));
	assert.equal(nextStage(task, t, unmarked).stage, "simplify", "runs without a fingerprint never trip it");
	assert.equal(nextStage(task, t, [...stuck.slice(0, 3), run(4, "implement", "failed", H)]).stage, "implement");
});

test("OPS-115-drive: a fake planner that closes passed with no spec and no commit starts twice; the drive escalates and exits 2", () => {
	const f = driveFixture();
	try {
		const made = cli(f.root, {}, "task", "new", "OPS-1", "--ask-file", f.file("ask.md", "Make the doghouse usable."));
		assert.equal(made.status, 0, made.stderr);
		fakeSeats(f, "planner");
		const code = quiet(() => drive(f.root, f.task, {}, { ...TIMING, waitMs: 60_000 }));
		assert.equal(code, 2);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(agentStarts(f, "planner"), 2, "two planners, not three");
		assert.match(JSON.parse(f.events("escalation")[0]!.payload).summary, /no progress: plan closed passed twice/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-drive: a fake implementer that closes passed with no commit starts at most twice; the drive escalates and exits 2", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'specced' WHERE id = ?").run(SPEC, f.taskId);
		fakeSeats(f, "implementer|simplifier");
		const code = quiet(() => drive(f.root, f.task, {}, { ...TIMING, waitMs: 60_000 }));
		assert.equal(code, 2);
		assert.equal(f.taskRow().status, "escalated");
		assert.ok(agentStarts(f, "implementer") <= 2, String(agentStarts(f, "implementer")));
		assert.match(JSON.parse(f.events("escalation")[0]!.payload).summary, /no progress: implement closed passed twice/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-defer: the breaker waits for another working seat and escalates when it closes", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		const other = openAgentRun(f, "simplify", "simplifier");
		close(f, "implement", "implementer", "failed", "Roof leaks.");
		close(f, "implement", "implementer", "failed", "Roof still leaks.");
		assert.equal(f.taskRow().status, "active", "a seat of the task still works");
		const held = f.events("escalation_deferred");
		assert.equal(held.length, 1);
		assert.match(held[0]!.payload, /no progress: implement closed failed twice/);
		f.advance();
		runDone(f.root, other, { status: "passed", summary: "Simplified." });
		assert.equal(f.taskRow().status, "escalated", "the last open seat closed");
		assert.match(
			JSON.parse(f.events("escalation")[0]!.payload).summary,
			/no progress: implement closed failed twice.*"Roof still leaks\."/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-reopen: after a breaker escalation, evf task reopen sets a marker and the next transition launches the stage again", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		close(f, "implement", "implementer", "failed", "Blocked on the gate.");
		close(f, "implement", "implementer", "failed", "Blocked on the gate.");
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(quiet(() => driveOnce(f.root, f.task, TIMING)).stage, "escalated");
		assert.equal(agentStarts(f, "implementer"), 0);
		assert.equal(reopen(f).status, 0);
		const n = quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.equal(n.stage, "implement");
		assert.equal(agentStarts(f, "implementer"), 1, "the implementer launches again");
		const relaunched = f.runs().at(-1)!;
		assert.deepEqual([relaunched.stage, relaunched.status], ["implement", "started"]);
		runDone(f.root, relaunched.id as number, { status: "failed", summary: "Blocked on the gate." });
		assert.equal(f.taskRow().status, "active", "runs before the marker are not run A");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-skip: a round that changes only the PR body and a proof skips simplify with an event; pr runs next", () => {
	const f = driveFixture();
	try {
		withPr(f);
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		commitFile(f, "built.txt");
		close(f, "implement", "implementer", "passed", "Built.");
		assert.equal(nextOf(f).stage, "simplify", "round 0 has no earlier simplify");
		const simplified = commitFile(f, "simplified.txt");
		const simplify = close(f, "simplify", "simplifier", "passed", "Simplified.");
		assert.equal(quiet(() => driveOnce(f.root, f.task, TIMING)).stage, "pr");
		assert.equal(f.runs().at(-1)!.status, "passed");
		close(f, "verify", "verifier", "failed", "Findings: criterion 2 has no proof.");
		assert.equal(f.taskRow().round, 1);

		// Round 1: the implementer only rewrites the PR body and adds a proof. Neither lives in the repository.
		writeFileSync(join(runtimeDir(f.root, f.task), "pr-body.md"), `${prBody()}\n`);
		const proof = cli(
			f.root,
			{},
			"proof",
			"add",
			"OPS-1",
			"--criterion",
			"2",
			"--status",
			"met",
			"--evidence",
			"shot.png",
		);
		assert.equal(proof.status, 0, proof.stderr);
		close(f, "implement", "implementer", "passed", "Added the proof.");
		assert.equal(f.taskRow().status, "pr_open", "implement moved from the round-0 head: no escalation");
		const before = f.runs().length;
		const n = quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.equal(n.stage, "pr");
		assert.equal(n.reason, `simplify skipped: no change since simplify run ${simplify} at ${simplified.slice(0, 10)}`);
		assert.deepEqual(
			f
				.runs()
				.slice(before)
				.map((r) => [r.stage, r.role, r.status]),
			[["pr", "evf", "passed"]],
			"no simplify run in round 1",
		);
		assert.equal(agentStarts(f, "simplifier"), 0, "no simplifier seat launched");
		const skipped = f.events("simplify_skipped").map((e) => JSON.parse(e.payload));
		assert.equal(skipped.length, 1);
		assert.deepEqual([skipped[0].simplify_run, skipped[0].head], [simplify, simplified]);
		assert.match(skipped[0].summary, new RegExp(`simplify run ${simplify} at ${simplified.slice(0, 10)}`));

		// A later implement run with a commit runs simplify again.
		commitFile(f, "door.txt");
		close(f, "implement", "implementer", "passed", "Fixed the door.");
		assert.equal(nextOf(f).stage, "simplify", "the branch changed since the last passed simplify");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-115-skip: author checks that fail in pr after a skipped simplify send the task to implement, not to simplify", () => {
	const flag = join(mkdtempSync(join(tmpdir(), "evf-ops115-")), "FAIL");
	const f = driveFixture({ failWhenFile: flag });
	try {
		withPr(f);
		f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
		commitFile(f, "built.txt");
		close(f, "implement", "implementer", "passed", "Built.");
		commitFile(f, "simplified.txt");
		close(f, "simplify", "simplifier", "passed", "Simplified.");
		close(f, "implement", "implementer", "passed", "Only the PR body changed.");
		writeFileSync(flag, "x"); // Outside the repository: the head and the diff stay as they are.
		const n = quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.equal(n.stage, "pr");
		assert.ok(n.skipped, "simplify was skipped");
		const failed = f.runs().at(-1)!;
		assert.deepEqual([failed.stage, failed.status], ["pr", "failed"]);
		const after = nextOf(f);
		assert.equal(after.stage, "implement");
		assert.match(after.reason, /^pr failed: author checks failed at/);
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-113: the body-only fix path in the stage machine.
const VERIFIER = { session: "22222222-2222-4222-8222-222222222222", model: "claude-opus-5-5", role: "verifier" };
const BODY_ITEMS = [
	{ present: "The verifier reviewed this head.", why: "How it was verified names an old head." },
	{ absent: "still to come", why: "The verifier already reviewed the code." },
];
const bodyWith = (line: string) => prBody().replace("Concrete task evidence.", `Concrete task evidence. ${line}`);
const STALE_BODY = bodyWith("The verifier is still to come."),
	FIXED_BODY = bodyWith("The verifier reviewed this head.");

/** An open PR at a new head with a body_only review on GitHub, proofs at the head and the verify closed body-only. */
function bodyOnlyAt(f: ReturnType<typeof driveFixture>) {
	withPr(f);
	const sha = commitFile(f, "reviewed.txt");
	const bodyFile = join(runtimeDir(f.root, f.task), "pr-body.md");
	writeFileSync(bodyFile, STALE_BODY);
	assert.equal(verify(f.root, f.task, "author", "full").passed, true, "the author checks ran at the head");
	const state = f.getState();
	state.pr = {
		number: 77,
		url: "https://github.com/test/private/pull/77",
		state: "OPEN",
		isDraft: false,
		headRefName: f.task.branch,
		headRefOid: sha,
		baseRefName: "main",
		body: STALE_BODY,
		labels: [],
		files: [],
	};
	state.requiredChecks = [
		{ name: "ci", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
	];
	state.protection = { required_status_checks: { contexts: ["ci"] } };
	state.comments["77"] = [
		{
			body: `EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "body_only", body: BODY_ITEMS, quality: { verdict: "approved", principles: ["laziness-protocol", "minimize-reader-load", "subtract-before-you-add", "test-behavior-not-implementation"] }, experience: { verdict: "approved", budget: "met" } })}`,
			html_url: "https://github.com/test/private/pull/77#c1",
		},
	];
	f.setState(state);
	f.db.prepare("UPDATE tasks SET pr_number = 77, status = 'pr_open' WHERE id = ?").run(f.taskId);
	for (const c of ["1", "2"]) proofAt(f, sha, c);
	const v = f.insertRun("verify", "verifier", "started", VERIFIER.session);
	runDone(f.root, v, { status: "body-only", summary: "Code approved; the body names an old head." });
	return { sha, bodyFile, verifyRun: v };
}
const lastPrompt = (f: ReturnType<typeof driveFixture>) =>
	f.herdr
		.calls()
		.filter((c) => c[0] === "agent" && c[1] === "prompt")
		.at(-1)![3]!;

test("OPS-113-close: --status body-only closes a verify run only, with the passed proof gate, a body_only approval at the head and no round", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
		const sha = head(f);
		for (const [stage, role] of [
			["implement", "implementer"],
			["simplify", "simplifier"],
			["body", "implementer"],
		] as const) {
			const id = f.insertRun(stage, role, "started");
			assert.throws(
				() => runDone(f.root, id, { status: "body-only", summary: "s" }),
				new RegExp(`--status body-only closes a verify run only; run ${id} is a ${stage} run`),
			);
			assert.equal(f.runs().find((r) => r.id === id)!.status, "started", "the refused close changes nothing");
		}
		const v = f.insertRun("verify", "verifier", "started");
		proofAt(f, sha, "1");
		assert.throws(
			() => runDone(f.root, v, { status: "body-only", summary: "body only" }),
			/Done criteria 2 have no met or n\/a proof at [0-9a-f]{10}/,
		);
		proofAt(f, sha, "2", "unmet");
		assert.throws(
			() => runDone(f.root, v, { status: "body-only", summary: "body only" }),
			/Done criteria 2 have no met/,
		);
		proofAt(f, sha, "2", "n/a");
		quietly(() => runDone(f.root, v, { status: "body-only", summary: "Code approved; body items listed." }));
		assert.equal(f.runs().find((r) => r.id === v)!.status, "passed");
		const approval = f.db
			.prepare("SELECT gate, head_sha, decision FROM approvals WHERE task_id = ? ORDER BY id DESC LIMIT 1")
			.get(f.taskId);
		assert.deepEqual({ ...approval }, { gate: "verify", head_sha: sha, decision: "body_only" });
		assert.equal(f.taskRow().round, 0);
		assert.equal(f.events("round").length, 0);
		assert.match(f.events("stage_end").at(-1)!.payload, /"status":"body_only"/);
		// The CLI takes the status and names it in its usage refusal.
		const summary = f.file("summary.md", "s");
		assert.match(
			cli(f.root, {}, "run", "done", String(v), "--status", "bodyonly", "--summary-file", summary).stderr,
			/passed, failed or body-only/,
		);
		const other = f.insertRun("implement", "implementer", "started");
		assert.match(
			cli(f.root, {}, "run", "done", String(other), "--status", "body-only", "--summary-file", summary).stderr,
			/closes a verify run only/,
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-113-body: after a body_only verify the body stage runs in the implementer seat, same round, with each item, the body file and its limits in the prompt", () => {
	const f = driveFixture();
	try {
		const { sha, bodyFile } = bodyOnlyAt(f);
		const n = nextOf(f);
		assert.deepEqual([n.stage, n.role, n.round], ["body", "implementer", 0]);
		assert.match(n.reason, new RegExp(`approved the code at ${sha.slice(0, 10)}`));
		assert.equal(quietly(() => driveOnce(f.root, f.task, TIMING)).stage, "body");
		const launched = f.runs().at(-1)!;
		assert.deepEqual(
			[launched.stage, launched.role, launched.status, launched.round],
			["body", "implementer", "started", 0],
		);
		const prompt = lastPrompt(f);
		assert.match(prompt, /^Fix the PR body of task OPS-1 at [0-9a-f]{10}\./);
		assert.ok(
			prompt.includes(`1. present "The verifier reviewed this head." (How it was verified names an old head.)`),
			prompt,
		);
		assert.ok(prompt.includes(`2. absent "still to come" (The verifier already reviewed the code.)`), prompt);
		assert.ok(prompt.includes(`Edit only the PR body file ${bodyFile}`), prompt);
		assert.match(prompt, /Make no commit and change no other file/);
		assert.match(prompt, /Close with bin\/evf run done \$EVF_RUN --status passed\|failed --summary-file <path>\.$/);
		assert.equal(f.runs().filter((r) => r.stage === "verify").length, 1);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-113-check: a passed body seat makes evf push the body at the same head and check it; a pass goes to ci with no verify", () => {
	const f = driveFixture();
	try {
		const { sha, bodyFile } = bodyOnlyAt(f);
		const run = f.insertRun("body", "implementer", "started");
		writeFileSync(bodyFile, FIXED_BODY);
		const lines: string[] = [];
		const log = console.log;
		console.log = (l: string) => void lines.push(String(l));
		try {
			runDone(f.root, run, { status: "passed", summary: "Body fixed." });
		} finally {
			console.log = log;
		}
		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.status], ["body", "passed"]);
		assert.ok(
			lines.some((l) => /body check passed/.test(l)),
			lines.join("\n"),
		);
		const state = f.getState();
		assert.equal(state.pr.body, FIXED_BODY, "evf pr open pushed the body");
		assert.ok(
			state.calls.some((c: any) => c.args[0] === "pr" && c.args[1] === "edit" && c.args.includes("--body-file")),
		);
		assert.ok(
			state.calls.some(
				(c: any) =>
					c.args[0] === "pr" && c.args[1] === "view" && c.args.includes("body,headRefName,headRefOid,labels,files"),
			),
			"the GitHub body was read with the evf pr body code",
		);
		assert.equal(head(f), sha);
		const n = nextOf(f);
		assert.deepEqual([n.stage, n.round], ["ci", 0]);
		assert.equal(quietly(() => driveOnce(f.root, f.task, TIMING)).stage, "ci");
		assert.equal(f.runs().at(-1)!.status, "passed");
		assert.equal(nextOf(f).stage, "ship");
		assert.equal(f.runs().filter((r) => r.stage === "verify").length, 1, "no verify run starts");
		assert.equal(f.taskRow().round, 0);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-113-retry: a failed body check (unmet item or body standard) runs the body stage again with the failure, no round; three in a row escalate", () => {
	const f = driveFixture();
	try {
		const { bodyFile } = bodyOnlyAt(f);
		const close = (body: string) => {
			writeFileSync(bodyFile, body);
			quietly(() =>
				runDone(f.root, f.insertRun("body", "implementer", "started"), { status: "passed", summary: "Body fixed." }),
			);
			return f.runs().at(-1)!;
		};
		let r = close(bodyWith("The verifier reviewed this head. It is still to come."));
		assert.equal(r.status, "failed");
		const unmet = f.db.prepare("SELECT summary FROM runs WHERE id = ?").get(r.id) as { summary: string };
		assert.match(unmet.summary, /^body check failed: the PR body does not meet a body item: absent "still to come"/);
		let n = nextOf(f);
		assert.deepEqual([n.stage, n.role, n.round], ["body", "implementer", 0]);
		assert.match(n.reason, /^body failed: body check failed: .*absent "still to come"/);
		quietly(() => driveOnce(f.root, f.task, TIMING));
		assert.match(
			lastPrompt(f),
			/evf checked the body after the last body run and it failed \(body failed: body check failed: .*still to come/,
		);
		quietly(() => runDone(f.root, f.runs().at(-1)!.id, { status: "failed", summary: "aborted for the test" }));
		assert.equal(f.taskRow().status, "pr_open", "two failures in a row do not escalate yet");

		// The fourth body run fails the body standard; that makes three failures in a row.
		r = close(FIXED_BODY.replace("## Follow-ups", "## Later"));
		assert.equal(r.status, "failed");
		assert.match(
			(f.db.prepare("SELECT summary FROM runs WHERE id = ?").get(r.id) as { summary: string }).summary,
			/^body check failed: PR body is missing required sections: ## Follow-ups/,
		);
		assert.equal(f.taskRow().status, "escalated");
		assert.match(f.events("escalation").at(-1)!.payload, /3 failures in a row, last in body/);
		assert.equal(f.taskRow().round, 0, "no body failure costs a round");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-113-round: a failed verify at a head an earlier verify already closed at costs no round; a new head still does, and the cap stays 3", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
		const a = head(f);
		for (const c of ["1", "2"]) proofAt(f, a, c);
		const verifyRun = (session: string) => f.insertRun("verify", "verifier", "started", session);
		quietly(() =>
			runDone(f.root, verifyRun("66666666-6666-4666-8666-666666666661"), { status: "body-only", summary: "body only" }),
		);
		// A second reviewer of the same head requests changes: a duplicate review of an unchanged head, no round.
		quietly(() =>
			runDone(f.root, verifyRun("66666666-6666-4666-8666-666666666662"), { status: "failed", summary: "again" }),
		);
		assert.equal(f.taskRow().round, 0);
		assert.equal(f.events("round").length, 0);
		assert.match(f.events("review_repeat")[0]!.payload, new RegExp(`a head already reviewed; no round`));
		for (let i = 1; i <= LOOP_CAP; i++) {
			f.advance();
			quietly(() =>
				runDone(f.root, verifyRun(`66666666-6666-4666-8666-66666666667${i}`), {
					status: "failed",
					summary: `finding ${i}`,
				}),
			);
			assert.equal(f.taskRow().round, i, "a failed verify at a new head costs a round");
			assert.notEqual(f.taskRow().status, "escalated");
		}
		f.advance();
		quietly(() =>
			runDone(f.root, verifyRun("66666666-6666-4666-8666-666666666680"), { status: "failed", summary: "finding 4" }),
		);
		assert.equal(f.taskRow().round, LOOP_CAP + 1);
		assert.equal(f.taskRow().status, "escalated");
		assert.match(f.events("escalation").at(-1)!.payload, /loop cap 3 hit after verify failed/);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-113-implement: an implement run closes passed only with a PR body that passes the evf pr body check; the refusal names the check", () => {
	const f = driveFixture();
	try {
		f.db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(SPEC, f.taskId);
		const bodyFile = join(runtimeDir(f.root, f.task), "pr-body.md");
		const id = f.insertRun("implement", "implementer", "started");
		rmSync(bodyFile);
		assert.throws(
			() => runDone(f.root, id, { status: "passed", summary: "built" }),
			new RegExp(`Implement cannot close passed: no PR body at .*pr-body\\.md`),
		);
		writeFileSync(bodyFile, prBody().replace("## Follow-ups", "## Later"));
		assert.throws(
			() => runDone(f.root, id, { status: "passed", summary: "built" }),
			/Implement cannot close passed: the PR body at .* fails the evf pr body check: PR body is missing required sections: ## Follow-ups\./,
		);
		writeFileSync(bodyFile, prBody().replace(/\n\n🤖.*$/, ""));
		assert.throws(
			() => runDone(f.root, id, { status: "passed", summary: "built" }),
			/fails the evf pr body check: End the PR body with its attribution line/,
		);
		assert.equal(f.runs().find((r) => r.id === id)!.status, "started", "a refused close changes nothing");
		// A failed implement needs no body.
		rmSync(bodyFile);
		quietly(() =>
			runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "failed", summary: "blocked" }),
		);
		writeFileSync(bodyFile, prBody());
		quietly(() => runDone(f.root, id, { status: "passed", summary: "built" }));
		assert.equal(f.runs().find((r) => r.id === id)!.status, "passed");
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-123: a drive pins its row, reads it by id on every pass, ends at the merge and counts a round for a failed ship.
/** A drive fixture whose row has a real title, ask and seats, so a row evf invents stands out. */
function pinnedFixture() {
	const f = driveFixture();
	f.db
		.prepare(
			"UPDATE tasks SET title = 'Usable doghouse', ask = 'Make the doghouse usable.', seat_model = 'claude-opus-5-5', seat_effort = 'medium', spec = ? WHERE id = ?",
		)
		.run(SPEC, f.taskId);
	return f;
}
/** A queued follow-up with the parent's ref, its own ask and seats, as a WP or FB slice is filed (OPS-86). */
const addSlice = (f: ReturnType<typeof driveFixture>, status = "queued") =>
	Number(
		f.db
			.prepare(
				"INSERT INTO tasks (slug, mode, ref, title, ask, branch, status, parent_task_id, slice, seat_model, seat_effort, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'The second slice', 'Build the second slice.', 'task/ops-1', ?, ?, 1, 'claude-opus-5-5', 'high', 'x', 'x')",
			)
			.run(status, f.taskId).lastInsertRowid,
	);
const tasksTable = (f: ReturnType<typeof driveFixture>) =>
	(f.db.prepare("SELECT * FROM tasks ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
/** No row that evf invented for a ref: the bare ref as title, no ask, or default seats. */
const noInventedRow = (f: ReturnType<typeof driveFixture>) => {
	for (const r of tasksTable(f)) {
		assert.notEqual(r.title, r.ref, `row ${r.id} has the bare ref as its title`);
		assert.ok(String(r.ask ?? "").trim(), `row ${r.id} has no ask`);
		assert.ok(r.seat_model && r.seat_effort, `row ${r.id} has default seats`);
	}
};
const launchCalls = (f: ReturnType<typeof driveFixture>) =>
	f.herdr.calls().filter((c) => (c[0] === "workspace" && c[1] === "create") || (c[0] === "agent" && c[1] === "start"));
/** The closed runs a drive reaches ship after: implement, simplify, pr, verify and ci passed, PR #77 open. */
const readyToShip = (f: ReturnType<typeof driveFixture>, round = 0) => {
	f.db.prepare("UPDATE tasks SET status = 'pr_open', pr_number = 77, round = ? WHERE id = ?").run(round, f.taskId);
	for (const [stage, role] of [
		["implement", "implementer"],
		["simplify", "simplifier"],
		["pr", "evf"],
		["verify", "verifier"],
		["ci", "evf"],
	])
		f.insertRun(stage!, role!, "passed");
};
/** A fake Herdr whose `agent wait` runs `js` once (with fs, cp and the store path `db`), then reports the seat working. */
function herdrOnWait(f: ReturnType<typeof driveFixture>, js: string) {
	const calls = join(f.root, "herdr-calls.json"),
		once = join(f.root, "herdr-once");
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2),db=${JSON.stringify(workDbPath(f.root))};\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			`if(a[0]==="agent"&&a[1]==="wait"&&!fs.existsSync(${JSON.stringify(once)})){fs.writeFileSync(${JSON.stringify(once)},"");${js}}\n` +
			`process.stdout.write(JSON.stringify({result:{agent:{agent_status:"working"}}}));\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
}
const captured = <T>(fn: () => T): { value: T; lines: string[] } => {
	const log = console.log,
		lines: string[] = [];
	console.log = (...a: unknown[]) => lines.push(a.join(" "));
	try {
		return { value: fn(), lines };
	} finally {
		console.log = log;
	}
};
const MERGE = "c".repeat(40);

test("OPS-123-elsewhere AC:OPS-123-2: a merge that evf approve records while the drive waits on a seat ends the drive on its next pass", () => {
	const f = pinnedFixture();
	try {
		const slice = addSlice(f);
		const seat = openSeatRun(f, true);
		// Another process records the merge the way evf approve does: markMergedByBranch on the PR head branch.
		const db = pathToFileURL(join(source, "tools/evf/db.ts")).href;
		herdrOnWait(
			f,
			`cp.spawnSync(process.execPath,["--disable-warning=ExperimentalWarning","--input-type=module","-e",${JSON.stringify(`import { markMergedByBranch } from ${JSON.stringify(db)}; markMergedByBranch(${JSON.stringify(f.root)}, "task/ops-1", ${JSON.stringify(MERGE)});`)}],{stdio:"inherit"});`,
		);
		const before = launchCalls(f).length;
		const { value: code, lines } = captured(() => drive(f.root, f.task, {}, TIMING));
		assert.equal(code, 0, lines.join("\n"));
		assert.ok(
			lines.some((l) => l.includes(`drive OPS-1: done (merged as ${MERGE})`)),
			lines.join("\n"),
		);
		assert.equal(f.taskRow().status, "merged");
		assert.equal(f.runs().find((r) => r.id === seat)!.status, "aborted", "the merge closed the open seat run");
		assert.equal(launchCalls(f).length, before, "no seat launched");
		assert.equal(
			(f.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(slice) as { n: number }).n,
			0,
			"the released slice never started",
		);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-123-github AC:OPS-123-3: a PR merged on GitHub between stages ends the drive at the next pass with no ci or ship; an unreadable GitHub does not", () => {
	const f = pinnedFixture();
	try {
		readyToShip(f);
		f.db.prepare("DELETE FROM runs WHERE task_id = ? AND stage = 'ci'").run(f.taskId); // ci runs next
		const s = f.getState();
		s.pr = { number: 77, state: "MERGED", mergeCommit: { oid: MERGE } };
		s.calls = [];
		f.setState(s);
		const { value: code, lines } = captured(() => drive(f.root, f.task, {}, TIMING));
		assert.equal(code, 0, lines.join("\n"));
		assert.ok(
			lines.some((l) => l.includes(`drive OPS-1: done (merged as ${MERGE})`)),
			lines.join("\n"),
		);
		assert.deepEqual(
			{ ...(f.db.prepare("SELECT status, merge_commit FROM tasks WHERE id = ?").get(f.taskId) as object) },
			{ status: "merged", merge_commit: MERGE },
		);
		assert.equal(f.events("merged").length, 1);
		assert.deepEqual(
			f.runs().filter((r) => r.stage === "ci" || r.stage === "ship"),
			[],
			"no ci or ship stage after the merge",
		);
		const gh = f.getState().calls.map((c: { args: string[] }) => c.args.slice(0, 2).join(" "));
		assert.deepEqual(gh, ["pr view"], "one GitHub read, no checks and no merge");
	} finally {
		f.db.close();
		f.close();
	}
	const g = pinnedFixture();
	try {
		readyToShip(g);
		g.db.prepare("DELETE FROM runs WHERE task_id = ? AND stage = 'ci'").run(g.taskId);
		const s = g.getState();
		s.requiredChecks = [{ name: "ci", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" }];
		s.protection = { required_status_checks: { contexts: ["ci"] } };
		g.setState(s);
		// GitHub cannot be read for the PR: the merge check finds nothing and the ci stage runs as before.
		const gh = join(g.root, "fake-bin/gh"),
			base = join(g.root, "fake-bin/gh-base");
		writeFileSync(base, readFileSync(gh));
		chmodSync(base, 0o755);
		writeFileSync(
			gh,
			`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==="pr"&&a[1]==="view"){process.stderr.write("fixture: GitHub is down");process.exit(1)}` +
				`process.exit(require("node:child_process").spawnSync(${JSON.stringify(base)},a,{stdio:"inherit"}).status??1);\n`,
		);
		const n = quiet(() => driveOnce(g.root, g.task, TIMING));
		assert.equal(n.stage, "ci");
		assert.deepEqual(
			g
				.runs()
				.filter((r) => r.stage === "ci")
				.map((r) => r.status),
			["passed"],
		);
		assert.equal(g.taskRow().status, "pr_open");
	} finally {
		g.db.close();
		g.close();
	}
});

test("OPS-123-replay AC:OPS-123-4: after a recorded merge, with and without a released slice, the drive's next pass on its pinned row leaves the tasks table as it was", () => {
	for (const withSlice of [false, true]) {
		const f = pinnedFixture();
		try {
			const slice = withSlice ? addSlice(f) : 0;
			const pin = f.taskId;
			markMerged(f.db, f.task, MERGE, null);
			if (withSlice) assert.equal(findTask(f.db, f.task)!.id, slice, "the released slice is the ref's current row now");
			const before = tasksTable(f);
			const n = quiet(() => driveOnce(f.root, f.task, TIMING, pin));
			assert.deepEqual([n.stage, n.reason], ["done", `merged as ${MERGE}`]);
			assert.deepEqual(tasksTable(f), before, `the same rows${withSlice ? " with the slice" : ""}`);
			noInventedRow(f);
			assert.deepEqual(launchCalls(f), [], "no seat launched");
			assert.equal(f.events("next").length, 0, "the pass made no transition");
		} finally {
			f.db.close();
			f.close();
		}
	}
});

test("OPS-123-fresh AC:OPS-123-5: a fresh drive on a merged row ends merged; on a released slice it drives the slice with its own seats; an abandoned pinned row stops with code 2", () => {
	const f = pinnedFixture();
	try {
		f.db.prepare("UPDATE tasks SET status = 'merged', merge_commit = ? WHERE id = ?").run(MERGE, f.taskId);
		const before = tasksTable(f);
		const { value: code, lines } = captured(() => drive(f.root, f.task, {}, TIMING));
		assert.equal(code, 0, lines.join("\n"));
		assert.ok(
			lines.some((l) => l.includes(`drive OPS-1: done (merged as ${MERGE})`)),
			lines.join("\n"),
		);
		assert.deepEqual(tasksTable(f), before, "no row inserted");

		// The merge released a slice: a fresh drive pins it and starts its planner with the slice's own seats.
		const slice = addSlice(f, "new");
		const once = captured(() => drive(f.root, f.task, { once: true }, TIMING));
		assert.equal(once.value, 0, once.lines.join("\n"));
		const runs = f.db.prepare("SELECT task_id, stage, model, effort FROM runs ORDER BY id").all() as Array<object>;
		assert.deepEqual(
			runs.map((r) => ({ ...r })),
			[{ task_id: slice, stage: "plan", model: "claude-opus-5-5", effort: "high" }],
		);
		assert.equal(tasksTable(f).length, before.length + 1, "only the slice row the test filed was added");
		noInventedRow(f);
	} finally {
		f.db.close();
		f.close();
	}
	const g = pinnedFixture();
	try {
		const seat = openSeatRun(g, true);
		// The row is abandoned while the drive waits on its seat (store edit; evf task abandon refuses a live drive).
		herdrOnWait(
			g,
			`const {DatabaseSync}=require("node:sqlite"),d=new DatabaseSync(db);d.exec("PRAGMA busy_timeout = 5000");` +
				`d.prepare("UPDATE runs SET status = 'aborted' WHERE id = ?").run(${seat});d.prepare("UPDATE tasks SET status = 'abandoned' WHERE id = ?").run(${g.taskId});` +
				`d.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, NULL, 'x', 'abandon', ?)").run(${g.taskId},JSON.stringify({reason:"replaced by a new plan"}));d.close();`,
		);
		const before = tasksTable(g).length;
		const { value: code, lines } = captured(() => drive(g.root, g.task, {}, TIMING));
		assert.equal(code, 2, lines.join("\n"));
		assert.ok(
			lines.some((l) =>
				l.includes(`drive OPS-1: abandoned (store row ${g.taskId} of OPS-1 was abandoned: replaced by a new plan;`),
			),
			lines.join("\n"),
		);
		assert.equal(tasksTable(g).length, before, "no replacement row");
		assert.equal(launchCalls(g).length, 0, "no seat launched");
	} finally {
		g.db.close();
		g.close();
	}
});

test("OPS-123-round AC:OPS-123-6: a failed ship records a ship round with its summary and the next pass launches implement for that round with the summary", () => {
	const f = pinnedFixture();
	try {
		readyToShip(f);
		const first = quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.equal(first.stage, "ship", "the failed ship does not end the drive");
		const ship = f.db
			.prepare("SELECT status, summary FROM runs WHERE task_id = ? AND stage = 'ship'")
			.get(f.taskId) as {
			status: string;
			summary: string;
		};
		assert.equal(ship.status, "failed");
		const headline = ship.summary.split("\n")[0]!;
		const rounds = f.events("round").map((e) => JSON.parse(e.payload));
		assert.deepEqual(rounds, [{ round: 1, cause: "ship", summary: `round 1 after ship failed: ${headline}` }]);
		assert.equal(f.taskRow().round, 1);
		const next = quiet(() => driveOnce(f.root, f.task, TIMING));
		assert.deepEqual([next.stage, next.round], ["implement", 1]);
		const implement = f.db
			.prepare("SELECT round FROM runs WHERE task_id = ? AND stage = 'implement' ORDER BY id DESC LIMIT 1")
			.get(f.taskId) as { round: number };
		assert.equal(implement.round, 1);
		const prompt = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt")
			.map((c) => c[3]!)
			.find((p) => p.startsWith("Implement task"))!;
		assert.ok(prompt.includes(`Round 1: ship failed: ${ship.summary}.`), prompt);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-123-cap AC:OPS-123-7: a failed ship past the loop cap escalates with the ship summary, exits 2 and launches no implement seat", () => {
	const f = pinnedFixture();
	try {
		readyToShip(f, LOOP_CAP);
		const { value: code, lines } = captured(() => drive(f.root, f.task, {}, TIMING));
		assert.equal(code, 2, lines.join("\n"));
		const ship = f.db.prepare("SELECT summary FROM runs WHERE task_id = ? AND stage = 'ship'").get(f.taskId) as {
			summary: string;
		};
		const headline = ship.summary.split("\n")[0]!;
		const cap = f.events("loop_cap_hit").map((e) => JSON.parse(e.payload));
		assert.deepEqual(cap, [
			{ round: LOOP_CAP + 1, cap: LOOP_CAP, summary: `OPS-1 hit the loop cap after ship failed: ${headline}` },
		]);
		assert.equal(
			JSON.parse(f.events("escalation")[0]!.payload).summary,
			`OPS-1 needs Sebastian: loop cap ${LOOP_CAP} hit after ship failed. ${headline}`,
		);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(agentStarts(f, "implementer"), 0, "no implement seat launched");
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-130: the simplifier seat runs the quick check; the pr stage stays the gate.
test("OPS-130-seat AC:OPS-130-1: the simplifier seat commits first and runs the quick check, and no line asks it for the full check", () => {
	const seat = readFileSync(join(source, ".claude/agents/simplifier.md"), "utf8");
	assert.match(seat, /^description: .*bin\/evf verify <task> --quick/m);
	assert.match(seat, /^3\. Commit.*bin\/evf verify <task> --quick/m);
	assert.deepEqual(seat.match(/bin\/evf verify[^`]*/g), Array(2).fill("bin/evf verify <task> --quick"));
});

test("OPS-130-full AC:OPS-130-2: a passing quick report at the simplifier head does not stand in for full; the pr stage runs full author checks at that head and pushes it", () => {
	const f = driveFixture();
	try {
		const remote = withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		assert.equal(verify(f.root, f.task, "author", "full").passed, true, "the implementer's last verify, at head A");
		const b = commitFile(f, "simplified.txt");
		assert.equal(verify(f.root, f.task, "author", "quick").passed, true, "the simplifier's quick check, at head B");
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });
		assert.equal(hasVerifiedHead(f.root, f.task), false, "a quick report never counts as a verified head");

		driveOnce(f.root, f.task, TIMING);

		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.status], ["pr", "passed"]);
		const report = JSON.parse(readFileSync(join(evidenceDir(f.root, f.task, b, "author-full"), "checks.json"), "utf8"));
		assert.deepEqual([report.sha, report.mode, report.passed], [b, "full", true]);
		assert.equal(sh(f.root, "--git-dir", remote, "rev-parse", "refs/heads/task/ops-1"), b);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-130-route AC:OPS-130-3: quick passes and full fails at the simplifier head; the pr run fails and the task returns to simplify in round 0 with the failure, no second implement run", () => {
	const f = driveFixture({ failWhenFile: "tools/evf/FAIL", failFullOnly: true });
	try {
		withPr(f);
		runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "passed", summary: "built" });
		commitFile(f, "FAIL");
		assert.equal(verify(f.root, f.task, "author", "quick").passed, true, "the simplifier's quick check passes");
		runDone(f.root, f.insertRun("simplify", "simplifier", "started"), { status: "passed", summary: "simplified" });

		driveOnce(f.root, f.task, TIMING);

		const failed = f.runs().at(-1)!;
		assert.deepEqual([failed.stage, failed.status], ["pr", "failed"]);
		const { summary } = f.db.prepare("SELECT summary FROM runs WHERE id = ?").get(failed.id as number) as {
			summary: string;
		};
		assert.match(summary, /author checks failed at [0-9a-f]{10}: fixture-check/);
		const after = nextOf(f);
		assert.deepEqual([after.stage, after.round], ["simplify", 0]);

		driveOnce(f.root, f.task, TIMING);
		assert.equal(f.runs().at(-1)!.role, "simplifier");
		const prompt = f.herdr
			.calls()
			.filter((c) => c[0] === "agent" && c[1] === "prompt")
			.at(-1)![3]!;
		assert.match(prompt, /author checks failed at [0-9a-f]{10}: fixture-check/);
		assert.equal(f.runs().filter((r) => r.stage === "implement").length, 1, "no second implement run starts");
	} finally {
		f.db.close();
		f.close();
	}
});

// OPS-135: round routing.

const PASS = (name: string) => ({ name, bucket: "pass", link: "https://github.com/test/private/actions/runs/1" });
const RED = (name: string) => ({ name, bucket: "fail", link: "https://github.com/test/private/actions/runs/2" });
const patchGh = (f: ReturnType<typeof driveFixture>, patch: Record<string, unknown>) =>
	f.setState({ ...f.getState(), ...patch });
const headChecks = (f: ReturnType<typeof driveFixture>, ...checks: unknown[]) => patchGh(f, { requiredChecks: checks });
/** Main's newest commit reports these results. Without this call the fake gh refuses the read, as an unreadable GitHub. */
const onMain = (f: ReturnType<typeof driveFixture>, results: Record<string, string>) =>
	patchGh(f, {
		api: {
			...f.getState().api,
			"repos/test/private/commits?sha=main&per_page=10": [{ sha: "m1" }],
			"repos/test/private/commits/m1/check-runs?per_page=100": {
				check_runs: Object.entries(results).map(([name, conclusion]) => ({ name, conclusion })),
			},
			"repos/test/private/commits/m1/status": { statuses: [] },
		},
	});
/** A PR whose runs passed through verify, so the next stage is ci. */
const passStages = (f: ReturnType<typeof driveFixture>) => {
	for (const [stage, role] of [
		["implement", "implementer"],
		["simplify", "simplifier"],
		["pr", "evf"],
		["verify", "verifier"],
	])
		f.insertRun(stage!, role!, "passed");
};
/** GitHub reports the worktree HEAD as the PR head. */
const prAtHead = (f: ReturnType<typeof driveFixture>) =>
	patchGh(f, { pr: { ...f.getState().pr, headRefOid: head(f) } });
const atCi = (f: ReturnType<typeof driveFixture>) => {
	withPr(f);
	f.db.prepare("UPDATE tasks SET status = 'pr_open', pr_number = 77 WHERE id = ?").run(f.taskId);
	commitFile(f, "built.txt");
	prAtHead(f);
	passStages(f);
};
const payloads = (f: ReturnType<typeof driveFixture>, type: string) =>
	f.events(type).map((e) => JSON.parse(e.payload) as Record<string, any>);
const notices = (f: ReturnType<typeof driveFixture>) => f.herdr.calls().filter((c) => c[0] === "notification");
const seatStarts = (f: ReturnType<typeof driveFixture>) =>
	f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start");
const pass = (f: ReturnType<typeof driveFixture>) => quiet(() => driveOnce(f.root, f.task, TIMING));
/** Every part of "holds": status, one new event with the exact fields, no seat, the same round, an aborted evf run. */
const assertHeld = (
	f: ReturnType<typeof driveFixture>,
	expected: { cause: string; checks: string[]; round?: number; events?: number },
) => {
	const row = f.taskRow();
	assert.equal(row.status, "held_external");
	assert.equal(row.round, expected.round ?? 0);
	const events = payloads(f, "held_external");
	assert.equal(events.length, expected.events ?? 1);
	const e = events.at(-1)!;
	assert.deepEqual(Object.keys(e).sort(), ["cause", "checks", "head", "summary"]);
	assert.deepEqual([e.cause, e.checks, e.head], [expected.cause, expected.checks, head(f)]);
	assert.equal(seatStarts(f).length, 0, "no seat launched");
	assert.deepEqual([f.runs().at(-1)!.role, f.runs().at(-1)!.status], ["evf", "aborted"]);
};
const routed = (name: string, body: (f: ReturnType<typeof driveFixture>) => void) =>
	test(name, () => {
		const f = driveFixture();
		try {
			atCi(f);
			body(f);
		} finally {
			f.db.close();
			f.close();
		}
	});
const mainCommit = (f: ReturnType<typeof driveFixture>, name: string, text = name) => {
	writeFileSync(join(f.root, name), text);
	f.git("add", name);
	f.git("commit", "-qm", `main adds ${name}`);
	f.git("push", "-q", "origin", "main");
	return f.git("rev-parse", "HEAD");
};
const mergeMain = (f: ReturnType<typeof driveFixture>) => {
	sh(f.wt, "fetch", "-q", "origin", "main");
	sh(f.wt, "merge", "-q", "--no-ff", "--no-edit", "origin/main");
	return head(f);
};
const pushBranch = (f: ReturnType<typeof driveFixture>) => sh(f.wt, "push", "-q", "origin", `HEAD:${f.task.branch}`);

routed(
	"round routing (AC:OPS-135-1): a non-required failure with the required check missing holds as external; required green with Vercel red still ships",
	(f) => {
		headChecks(f, RED("Vercel"));
		assert.equal(pass(f).stage, "ci");
		assertHeld(f, { cause: "external", checks: ["Vercel"] });
		assert.equal(payloads(f, "round_start").length, 0);

		const g = driveFixture();
		try {
			atCi(g);
			headChecks(g, PASS("ci"), RED("Vercel"));
			assert.equal(pass(g).stage, "ci");
			assert.deepEqual([g.runs().at(-1)!.stage, g.runs().at(-1)!.status], ["ci", "passed"]);
			assert.equal(g.taskRow().status, "pr_open");
			assert.equal(nextOf(g).stage, "ship");
			assert.equal(payloads(g, "held_external").length, 0);
		} finally {
			g.db.close();
			g.close();
		}
	},
);

routed(
	"round routing (AC:OPS-135-1): a required check that stays missing with no failing check anywhere stays this_pr",
	(f) => {
		headChecks(f);
		pass(f);
		assert.equal(f.taskRow().round, 1);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(payloads(f, "held_external").length, 0);
		assert.equal(nextOf(f).stage, "implement");
	},
);

routed("round routing (AC:OPS-135-2): a required check that also fails on main holds as main", (f) => {
	headChecks(f, RED("ci"));
	onMain(f, { ci: "failure" });
	pass(f);
	assertHeld(f, { cause: "main", checks: ["ci"] });
});

routed(
	"round routing (AC:OPS-135-2): main's latest finished result decides; a run in progress on main does not hide it",
	(f) => {
		headChecks(f, RED("ci"));
		patchGh(f, {
			api: {
				"repos/test/private/commits?sha=main&per_page=10": [{ sha: "m2" }, { sha: "m1" }],
				"repos/test/private/commits/m2/check-runs?per_page=100": { check_runs: [{ name: "ci", conclusion: null }] },
				"repos/test/private/commits/m2/status": { statuses: [] },
				"repos/test/private/commits/m1/check-runs?per_page=100": {
					check_runs: [{ name: "ci", conclusion: "failure" }],
				},
				"repos/test/private/commits/m1/status": { statuses: [] },
			},
		});
		pass(f);
		assertHeld(f, { cause: "main", checks: ["ci"] });
	},
);

routed("round routing (AC:OPS-135-2): a newer green on main wins over an older red", (f) => {
	headChecks(f, RED("ci"));
	patchGh(f, {
		api: {
			"repos/test/private/commits?sha=main&per_page=10": [{ sha: "m2" }, { sha: "m1" }],
			"repos/test/private/commits/m2/check-runs?per_page=100": { check_runs: [{ name: "ci", conclusion: "success" }] },
			"repos/test/private/commits/m2/status": { statuses: [] },
			"repos/test/private/commits/m1/check-runs?per_page=100": {
				check_runs: [{ name: "ci", conclusion: "failure" }],
			},
			"repos/test/private/commits/m1/status": { statuses: [] },
		},
	});
	pass(f);
	assert.equal(f.taskRow().round, 1);
	assert.equal(payloads(f, "held_external").length, 0);
	assert.equal(nextOf(f).stage, "implement");
});

routed("round routing (AC:OPS-135-2): a commit status on main counts like a check run", (f) => {
	headChecks(f, RED("ci"));
	patchGh(f, {
		api: {
			"repos/test/private/commits?sha=main&per_page=10": [{ sha: "m1" }],
			"repos/test/private/commits/m1/check-runs?per_page=100": { check_runs: [] },
			"repos/test/private/commits/m1/status": { statuses: [{ context: "ci", state: "failure" }] },
		},
	});
	pass(f);
	assertHeld(f, { cause: "main", checks: ["ci"] });
});

routed("round routing (AC:OPS-135-2): an unreadable main leaves the failure this_pr", (f) => {
	headChecks(f, RED("ci"));
	pass(f);
	assert.equal(f.taskRow().round, 1);
	assert.equal(f.taskRow().status, "pr_open");
	assert.equal(payloads(f, "held_external").length, 0);
	assert.equal(nextOf(f).stage, "implement");
});

routed(
	"round routing (AC:OPS-135-3): a required check red only on this PR at a new head starts a round, and a verifier's request is never classified",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "success" });
		pass(f);
		assert.equal(f.taskRow().round, 1);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(payloads(f, "held_external").length, 0);
		assert.equal(nextOf(f).stage, "implement");

		const g = driveFixture();
		try {
			atCi(g);
			onMain(g, { ci: "failure" });
			close(g, "verify", "verifier", "failed", "Findings: the door sticks.");
			assert.equal(g.taskRow().round, 1);
			assert.equal(g.taskRow().status, "pr_open");
			assert.equal(nextOf(g).stage, "implement");
			const reads = g.getState().calls.filter((c: { args: string[] }) => c.args.some((a) => a.includes("/commits")));
			assert.deepEqual(reads, [], "a changes request reads no check");
		} finally {
			g.db.close();
			g.close();
		}
	},
);

routed("round routing (AC:OPS-135-3): one failing check that is only this PR's makes a mixed failure this_pr", (f) => {
	patchGh(f, { protection: { required_status_checks: { contexts: ["ci", "db"] } } });
	headChecks(f, RED("ci"), RED("db"));
	onMain(f, { ci: "failure", db: "success" });
	pass(f);
	assert.equal(f.taskRow().round, 1);
	assert.equal(payloads(f, "held_external").length, 0);
});

routed("round routing (AC:OPS-135-3): a PR that conflicts with main is this_pr, even with a red check on main", (f) => {
	patchGh(f, { pr: { ...f.getState().pr, mergeable: "CONFLICTING" } });
	headChecks(f, RED("ci"));
	onMain(f, { ci: "failure" });
	pass(f);
	assert.equal(f.taskRow().round, 1);
	assert.equal(payloads(f, "held_external").length, 0);
});

routed(
	"round routing (AC:OPS-135-4): one notification per hold; polls and a restart add no notice, no next and no held_external; a later hold adds one",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "failure" });
		pass(f);
		assert.equal(notices(f).length, 1);
		const text = notices(f)[0]!.join(" ");
		for (const part of ["OPS-1", "main", "ci", "bin/evf task reopen OPS-1"])
			assert.ok(text.includes(part), `${part} in: ${text}`);

		const nexts = payloads(f, "next").length;
		assert.equal(pass(f).stage, "held");
		assert.equal(pass(f).stage, "held");
		const restart = cli(f.root, {}, "drive", "OPS-1", "--once");
		assert.equal(restart.status, 0, restart.stderr);
		assert.match(restart.stdout, /held/);
		assert.equal(notices(f).length, 1);
		assert.equal(payloads(f, "next").length, nexts);
		assert.equal(payloads(f, "held_external").length, 1);

		// The retry cap never counts a hold: more holds than RETRY_CAP in a row still do not escalate.
		for (let n = 2; n <= RETRY_CAP + 2; n++) {
			onMain(f, { ci: "success" });
			assert.equal(pass(f).stage, "ci", "the hold ends");
			onMain(f, { ci: "failure" });
			pass(f);
			assertHeld(f, { cause: "main", checks: ["ci"], events: n });
			assert.equal(notices(f).length, n);
		}
		assert.equal(f.taskRow().round, 0);
	},
);

test("round routing (AC:OPS-135-5): each new round records round_start with the previous round's counts; a hold, a repeat review and a loop cap stop record none", () => {
	const f = driveFixture();
	try {
		withPr(f);
		f.db.prepare("UPDATE tasks SET status = 'pr_open', pr_number = 77 WHERE id = ?").run(f.taskId);
		const write = (name: string, text: string) => {
			writeFileSync(join(f.wt, "tools/evf", name), text);
			sh(f.wt, "add", "tools/evf");
			sh(f.wt, "commit", "-qm", `add ${name}`);
		};
		write("one.txt", "a\nb\n");
		close(f, "verify", "verifier", "failed", "Findings: the door sticks.");
		const first = head(f);
		assert.deepEqual(payloads(f, "round_start"), [
			{
				cause: "this_pr",
				nonMergeCommits: 1,
				diffLines: 2,
				round: 1,
				stage: "verify",
				head: first,
				summary: "round 1 starts after verify failed: Findings: the door sticks.",
			},
		]);

		// A repeat review of a reviewed head costs no round and records no round_start.
		runDone(f.root, f.insertRun("verify", "verifier", "started"), {
			status: "failed",
			summary: "Again.",
			closedBy: "evf",
		});
		assert.equal(f.taskRow().round, 1);
		assert.equal(payloads(f, "round_start").length, 1);

		// One commit and a merge of main: main's commit and the merge do not count.
		write("two.txt", "a\nb\nc\n");
		mainCommit(f, "main-a.txt", "a\nb\nc\nd\ne\n");
		const second = mergeMain(f);
		passStages(f);
		headChecks(f, RED("ci"));
		onMain(f, { ci: "success" });
		pass(f);
		const ci = payloads(f, "round_start").at(-1)!;
		assert.deepEqual([ci.round, ci.stage, ci.head, ci.nonMergeCommits, ci.diffLines], [2, "ci", second, 1, 3]);

		// A hold records none.
		mainCommit(f, "main-b.txt");
		const third = mergeMain(f);
		passStages(f);
		onMain(f, { ci: "failure" });
		pass(f);
		assert.equal(f.taskRow().status, "held_external");
		assert.equal(f.taskRow().round, 2);
		assert.equal(payloads(f, "round_start").length, 2);

		// A round that added only a merge counts zero. The hold moved nothing, so the counts start at the ci head.
		reopen(f);
		onMain(f, { ci: "success" });
		pass(f);
		const merged = payloads(f, "round_start").at(-1)!;
		assert.deepEqual([merged.round, merged.head, merged.nonMergeCommits, merged.diffLines], [3, third, 0, 0]);

		// The worktree is gone: both counts are null.
		f.db.prepare("UPDATE tasks SET worktree = ? WHERE id = ?").run(join(f.root, "no-such-worktree"), f.taskId);
		f.db.prepare("UPDATE tasks SET round = 2 WHERE id = ?").run(f.taskId);
		runDone(f.root, f.insertRun("verify", "verifier", "started"), {
			status: "failed",
			summary: "Gone.",
			closedBy: "evf",
		});
		const gone = payloads(f, "round_start").at(-1)!;
		assert.deepEqual([gone.round, gone.head, gone.nonMergeCommits, gone.diffLines], [3, null, null, null]);

		// The loop cap stop records none.
		const before = payloads(f, "round_start").length;
		runDone(f.root, f.insertRun("verify", "verifier", "started"), {
			status: "failed",
			summary: "Cap.",
			closedBy: "evf",
		});
		assert.equal(f.taskRow().round, LOOP_CAP + 1);
		assert.equal(f.taskRow().status, "escalated");
		assert.equal(payloads(f, "round_start").length, before);
	} finally {
		f.db.close();
		f.close();
	}
});

/** Round 1 with a passed simplify at the current head, ready for what the round adds. */
const roundOneAfterSimplify = (f: ReturnType<typeof driveFixture>) => {
	withPr(f);
	commitFile(f, "built.txt");
	close(f, "implement", "implementer", "passed", "Built.");
	const simplified = commitFile(f, "simplified.txt");
	const run = close(f, "simplify", "simplifier", "passed", "Simplified.");
	close(f, "verify", "verifier", "failed", "Findings: criterion 2 has no proof.");
	assert.equal(f.taskRow().round, 1);
	return { run, simplified };
};
const skipFixture = (name: string, body: (f: ReturnType<typeof driveFixture>) => void) =>
	test(name, () => {
		const f = driveFixture();
		try {
			body(f);
		} finally {
			f.db.close();
			f.close();
		}
	});

skipFixture(
	"round routing (AC:OPS-135-6): a round 1 of only a clean merge of main skips simplify with reason merge_only and goes to pr",
	(f) => {
		const { run, simplified } = roundOneAfterSimplify(f);
		mainCommit(f, "main-a.txt");
		mergeMain(f);
		close(f, "implement", "implementer", "passed", "Merged main.");
		const before = f.runs().length;
		const n = pass(f);
		assert.equal(n.stage, "pr");
		assert.deepEqual(n.skipped, { run, head: simplified, reason: "merge_only" });
		assert.deepEqual(
			f
				.runs()
				.slice(before)
				.map((r) => [r.stage, r.role]),
			[["pr", "evf"]],
		);
		assert.equal(agentStarts(f, "simplifier"), 0);
		const [skipped] = payloads(f, "simplify_skipped");
		assert.deepEqual([skipped!.simplify_run, skipped!.head, skipped!.reason], [run, simplified, "merge_only"]);
	},
);

skipFixture(
	"round routing (AC:OPS-135-6): a PR body change adds no commit and skips under the existing rule, with no merge_only reason",
	(f) => {
		const { run, simplified } = roundOneAfterSimplify(f);
		writeFileSync(join(runtimeDir(f.root, f.task), "pr-body.md"), `${prBody()}\n`);
		close(f, "implement", "implementer", "passed", "Body.");
		assert.deepEqual(nextOf(f).skipped, { run, head: simplified });
	},
);

skipFixture("round routing (AC:OPS-135-6): one new non-merge commit beside a merge of main runs simplify", (f) => {
	roundOneAfterSimplify(f);
	mainCommit(f, "main-a.txt");
	mergeMain(f);
	commitFile(f, "fix.txt");
	close(f, "implement", "implementer", "passed", "Fixed.");
	const n = nextOf(f);
	assert.equal(n.stage, "simplify");
	assert.equal(n.skipped, undefined);
});

skipFixture("round routing (AC:OPS-135-6): a merge with a conflict resolution runs simplify", (f) => {
	roundOneAfterSimplify(f);
	writeFileSync(join(f.wt, "clash.txt"), "branch\n");
	sh(f.wt, "add", "clash.txt");
	sh(f.wt, "commit", "-qm", "branch clash");
	const simplified = head(f);
	close(f, "simplify", "simplifier", "passed", "Simplified again.");
	mainCommit(f, "clash.txt", "main\n");
	sh(f.wt, "fetch", "-q", "origin", "main");
	sh(f.wt, "merge", "-q", "--no-edit", "origin/main");
	writeFileSync(join(f.wt, "clash.txt"), "both\n");
	sh(f.wt, "add", "clash.txt");
	sh(f.wt, "commit", "-q", "--no-edit");
	assert.notEqual(head(f), simplified);
	assert.notEqual(sh(f.wt, "show", "--cc", "--format=", "HEAD"), "", "the fixture merge carries a resolution");
	close(f, "implement", "implementer", "passed", "Merged main.");
	assert.equal(nextOf(f).stage, "simplify");
});

skipFixture(
	"round routing (AC:OPS-135-7): in round 0 a merge-only branch runs simplify; the OPS-115 skip applies in every round and keeps its fields",
	(f) => {
		withPr(f);
		commitFile(f, "built.txt");
		close(f, "implement", "implementer", "passed", "Built.");
		const simplified = commitFile(f, "simplified.txt");
		const run = close(f, "simplify", "simplifier", "passed", "Simplified.");
		assert.equal(f.taskRow().round, 0);

		// Round 0, no change since the simplify: the OPS-115 skip, with its present fields only.
		close(f, "implement", "implementer", "passed", "Nothing new.");
		const n = pass(f);
		assert.equal(n.stage, "pr");
		assert.deepEqual(n.skipped, { run, head: simplified });
		const [skipped] = payloads(f, "simplify_skipped");
		assert.deepEqual(Object.keys(skipped!).sort(), ["head", "simplify_run", "summary"]);

		// Round 0, only a merge of main since the simplify: simplify runs.
		mainCommit(f, "main-a.txt");
		mergeMain(f);
		close(f, "implement", "implementer", "passed", "Merged main.");
		assert.equal(f.taskRow().round, 0);
		assert.equal(nextOf(f).stage, "simplify");
	},
);

routed(
	"round routing (AC:OPS-135-8): evf ship on a held task still refuses while a required check fails, and the owning paths exclude ship.ts",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "failure" });
		pushBranch(f);
		patchGh(f, {
			pr: {
				...f.getState().pr,
				body: prBody(),
				headRefName: f.task.branch,
				headRefOid: head(f),
				baseRefName: "main",
				isDraft: false,
			},
		});
		pass(f);
		assert.equal(f.taskRow().status, "held_external");
		const shipped = cli(f.root, {}, "ship", "OPS-1");
		assert.notEqual(shipped.status, 0);
		assert.match(shipped.stderr, /Required GitHub CI must be green on the exact PR head: ci failed/);
		assert.equal(f.taskRow().status, "held_external");
		const config = JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8"));
		const paths: string[] = config.maintenanceTasks["OPS-135"].owningPaths;
		assert.deepEqual(
			paths.filter((p) => "tools/evf/ship.ts".startsWith(p)),
			[],
		);
	},
);

routed(
	"round routing (AC:OPS-135-9): a required check that fails again at the same head holds as external with main green; a moved head starts a round",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "success" });
		pass(f);
		assert.equal(f.taskRow().round, 1);

		passStages(f);
		pass(f);
		assertHeld(f, { cause: "external", checks: ["ci"], round: 1 });

		// The head moves and the check is red again: the release runs ci, which starts a round at the new head.
		commitFile(f, "fix.txt");
		prAtHead(f);
		assert.equal(pass(f).stage, "ci");
		assert.equal(f.taskRow().status, "pr_open");
		pass(f);
		assert.equal(f.taskRow().round, 2);
		assert.equal(f.taskRow().status, "pr_open");
	},
);

routed("round routing (AC:OPS-135-9): a same-head comparison ignores failures before the latest reopen", (f) => {
	headChecks(f, RED("ci"));
	onMain(f, { ci: "success" });
	pass(f);
	passStages(f);
	f.db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(f.taskId);
	assert.equal(reopen(f).status, 0);
	pass(f);
	assert.equal(f.taskRow().round, 2, "no earlier failure counts after the reopen");
	assert.equal(payloads(f, "held_external").length, 0);
});

routed(
	"round routing (AC:OPS-135-10): a main hold clears: the drive updates the branch, fast-forwards the worktree and runs ci at the new head with no seat and no round",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "failure" });
		pushBranch(f);
		pass(f);
		assertHeld(f, { cause: "main", checks: ["ci"] });
		const held = head(f);

		const fix = mainCommit(f, "main-fix.txt");
		assert.equal(pass(f).stage, "held", "main is still red");
		onMain(f, { ci: "success" });
		const n = pass(f);
		assert.equal(n.stage, "ci");
		assert.equal(f.taskRow().status, "pr_open");
		const [released] = payloads(f, "hold_released");
		assert.equal(payloads(f, "hold_released").length, 1);
		assert.match(released!.reason, /ci no longer fail on main; the branch includes main/);
		assert.notEqual(head(f), held);
		assert.equal(spawnSync("git", ["-C", f.wt, "merge-base", "--is-ancestor", fix, "HEAD"]).status, 0);
		assert.ok(f.getState().calls.some((c: { args: string[] }) => c.args[1] === "update-branch"));

		headChecks(f, PASS("ci"));
		pass(f);
		assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.status], ["ci", "passed"]);
		assert.equal(f.taskRow().round, 0);
		assert.equal(seatStarts(f).length, 0);
		assert.equal(nextOf(f).stage, "ship");
	},
);

routed(
	"round routing (AC:OPS-135-10): a failed branch update still runs ci, which reports the conflict as this_pr",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "failure" });
		pass(f); // The branch was never pushed, so the fake's update-branch fails.
		onMain(f, { ci: "success" });
		assert.equal(pass(f).stage, "ci");
		assert.match(payloads(f, "hold_released")[0]!.reason, /the branch update failed/);
		patchGh(f, { pr: { ...f.getState().pr, mergeable: "CONFLICTING" } });
		pass(f);
		assert.equal(f.taskRow().round, 1);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(nextOf(f).stage, "implement");
	},
);

routed(
	"round routing (AC:OPS-135-10): an external hold clears when the named checks no longer fail or the head moves",
	(f) => {
		headChecks(f, RED("Vercel"));
		pass(f);
		assertHeld(f, { cause: "external", checks: ["Vercel"] });
		assert.equal(pass(f).stage, "held");
		headChecks(f, PASS("ci"), PASS("Vercel"));
		assert.equal(pass(f).stage, "ci");
		assert.equal(f.taskRow().status, "pr_open");
		assert.match(payloads(f, "hold_released")[0]!.reason, /Vercel no longer fail/);
		pass(f);
		assert.equal(nextOf(f).stage, "ship");

		const g = driveFixture();
		try {
			atCi(g);
			headChecks(g, RED("Vercel"));
			pass(g);
			const moved = commitFile(g, "fix.txt");
			prAtHead(g);
			assert.equal(pass(g).stage, "ci");
			assert.match(payloads(g, "hold_released")[0]!.reason, new RegExp(`head moved to ${moved.slice(0, 10)}`));
			assert.equal(g.taskRow().round, 0);
		} finally {
			g.db.close();
			g.close();
		}
	},
);

skipFixture("round routing (AC:OPS-135-10): a held ship failure resumes at ci, not at ship", (f) => {
	withPr(f);
	readyToShip(f);
	headChecks(f, RED("ci"));
	onMain(f, { ci: "failure" });
	assert.equal(pass(f).stage, "ship");
	assert.equal(f.taskRow().status, "held_external");
	assert.deepEqual([f.runs().at(-1)!.stage, f.runs().at(-1)!.status], ["ship", "aborted"]);
	onMain(f, { ci: "success" });
	assert.equal(pass(f).stage, "ci");
	assert.equal(nextOf(f).stage, "ci");
});

routed("round routing (AC:OPS-135-10): an abandoned or merged held task ends the drive", (f) => {
	headChecks(f, RED("ci"));
	onMain(f, { ci: "failure" });
	pass(f);
	const abandoned = cli(f.root, {}, "task", "abandon", "OPS-1", "--reason", "not needed now");
	assert.equal(abandoned.status, 0, abandoned.stderr);
	const row = f.taskId;
	assert.equal(quiet(() => driveOnce(f.root, f.task, TIMING, row)).stage, "abandoned");

	const g = driveFixture();
	try {
		atCi(g);
		headChecks(g, RED("ci"));
		onMain(g, { ci: "failure" });
		pass(g);
		patchGh(g, { pr: { number: 77, state: "MERGED", mergeCommit: { oid: SHA } } });
		assert.equal(pass(g).stage, "done");
		assert.equal(g.taskRow().status, "merged");
	} finally {
		g.db.close();
		g.close();
	}
});

routed(
	"round routing (AC:OPS-135-11): evf task reopen accepts a held task; a check red at that head with main green then starts a round",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "success" });
		pass(f);
		passStages(f);
		pass(f);
		assertHeld(f, { cause: "external", checks: ["ci"], round: 1 });
		const same = head(f);

		const opened = reopen(f);
		assert.equal(opened.status, 0, opened.stderr);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(payloads(f, "reopen").at(-1)!.from, "held_external");
		assert.equal(nextOf(f).stage, "ci");
		pass(f);
		assert.equal(head(f), same);
		assert.equal(f.taskRow().round, 2);
		assert.equal(f.taskRow().status, "pr_open");
		assert.equal(nextOf(f).stage, "implement");
	},
);

routed("round routing (AC:OPS-135-11): a check still red on main holds again after a reopen", (f) => {
	headChecks(f, RED("ci"));
	onMain(f, { ci: "failure" });
	pass(f);
	assert.equal(reopen(f).status, 0);
	assert.equal(nextOf(f).stage, "ci");
	pass(f);
	assertHeld(f, { cause: "main", checks: ["ci"], events: 2 });
	assert.equal(notices(f).length, 2);
});

routed(
	"round routing (AC:OPS-135-12): evf next prints stage held with the cause and evf status shows held_external",
	(f) => {
		headChecks(f, RED("ci"));
		onMain(f, { ci: "failure" });
		pass(f);
		const n = nextOf(f);
		assert.deepEqual([n.stage, n.cause, n.round], ["held", "main", 0]);
		assert.match(n.reason, /OPS-1 held \(main\): ci at /);
		const text = cli(f.root, {}, "status");
		assert.match(text.stdout, /OPS-1\s+implement\s+held_external/);
		const json = JSON.parse(cli(f.root, {}, "status", "--json").stdout);
		assert.equal(json.tasks.find((t: { ref: string }) => t.ref === "OPS-1").status, "held_external");
		assert.equal(json.tasks.find((t: { ref: string }) => t.ref === "OPS-1").hold_cause, "main");
	},
);

test("round routing (AC:OPS-135-12): the migration leaves existing rows and statuses unchanged and accepts held_external", () => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const file of STORE_MIGRATIONS.slice(
			0,
			STORE_MIGRATIONS.findIndex((m) => m.endsWith("-held-external.sql")),
		)) {
			db.exec(readFileSync(join(source, "tools/evf/db/migrations", file), "utf8"));
			db.prepare("INSERT INTO schema_version VALUES (?, ?, 'then')").run(Number(file.slice(0, 3)), file.slice(4, -4));
		}
		const statuses = [
			"new",
			"queued",
			"specced",
			"active",
			"awaiting_pick",
			"escalated",
			"pr_open",
			"merged",
			"done",
			"abandoned",
		];
		statuses.forEach((status, i) =>
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, round, pr_number, spec, seat_model, parent_task_id, slice, linked, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, 'spec', 'm', ?, ?, ?, 'a', 'b')",
				)
				.run(`ops-${i}`, `OPS-${i}`, status, i, 100 + i, i ? 1 : null, i ? i : null, i % 2),
		);
		const rows = () => db.prepare("SELECT * FROM tasks ORDER BY id").all();
		const before = rows();
		assert.equal(before.length, statuses.length);
		assert.equal(migrate(db).version, STORE_LATEST);
		assert.deepEqual(rows(), before);
		db.prepare("UPDATE tasks SET status = 'held_external' WHERE id = 4").run();
		assert.throws(() => db.prepare("UPDATE tasks SET status = 'nonsense' WHERE id = 4").run(), /CHECK/);
		const view = db.prepare("SELECT status, hold_cause, parent_task_id FROM v_tasks WHERE id = 4").get() as Record<
			string,
			unknown
		>;
		assert.deepEqual({ ...view }, { status: "held_external", hold_cause: null, parent_task_id: 1 });
	} finally {
		db.close();
	}
});
