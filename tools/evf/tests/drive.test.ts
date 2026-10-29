import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, openWorkDb, sessionsRecorded, syncGoals } from "../db.ts";
import { driveOnce, LOOP_CAP, nextStage, RETRY_CAP, runDone } from "../drive.ts";
import { doneCriteria } from "../spec.ts";
import { evfDataDir, parseTask, sleep } from "../lib.ts";

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "", ...env },
	});
const TIMING = { waitMs: 2000, nudgeMs: 10, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 150 };

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
			`let r={};if(a[0]==="workspace"&&a[1]==="create")r={workspace:"w9",tab:"w9:t1",root_pane:{pane_id:"w9:p1"}};\n` +
			`else if(a[0]==="pane"&&a[1]==="process-info")r={process_info:{shell_pid:7,foreground_process_group_id:7}};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait")r={agent:{agent_status:st.status||"idle"}};\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_session:{value:st.session||"55555555-5555-4555-8555-555555555555"},agent_status:"idle"}};\n` +
			`process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(root, "fake-bin/herdr"), 0o755);
	return {
		calls: () => JSON.parse(readFileSync(calls, "utf8")) as string[][],
		setState: (s: object) => writeFileSync(state, JSON.stringify(s)),
	};
}

function driveFixture() {
	const f = fixture(),
		task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Drive", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
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
	return { ...f, task, wt, db, taskId: t.id, herdr, runs, events, taskRow, file, insertRun };
}

const SPEC =
	"Goal: a usable doghouse.\nDone criteria:\n1. The dog fits.\n2. The roof keeps rain out.\nNon-goals: lighting.";

test("OPS-59-next: the stage machine follows plan, implement, simplify, pr, evidence, verify, ci, ship and loops back on failures", () => {
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
	assert.equal(nextStage(task, specced, [run("plan", "passed")]).role, "ui", "a ui part gets the ui seat");
	assert.equal(nextStage(task, t, [run("plan", "passed")]).stage, "plan", "a plan without a stored spec repeats");
	assert.deepEqual(nextStage(task, specced, [run("plan", "started")]).stage, "waiting");
	assert.equal(nextStage(task, specced, [run("implement", "passed")]).stage, "simplify");
	assert.equal(nextStage(task, specced, [run("implement", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("simplify", "passed")]).stage, "pr");
	assert.equal(nextStage(task, specced, [run("pr", "passed")]).stage, "evidence");
	assert.equal(nextStage(task, specced, [run("pr", "failed")]).stage, "implement");
	assert.equal(nextStage(task, specced, [run("evidence", "passed")]).stage, "verify");
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
		assert.ok(start.includes("--agent") && start.includes("planner"), start.join(" "));
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

		// The pr stage is evf's own run and fails cleanly without a PR body.
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
			runDone(f.root, f.insertRun("implement", "implementer", "started"), { status: "failed", summary: `broke ${i}` });
			assert.equal(f.taskRow().status, "active");
		}
		assert.equal(f.taskRow().round, 0, "implement failures cost no round");
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
		state.requiredChecks = [{ name: "ci", bucket: "pass" }];
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
		assert.match(close(later, "passed").stderr, /Done criteria 1, 2 have no met/, "proofs bind to their head");
		assert.equal(close(later, "failed").status, 0, "a failed verify needs no proofs");

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
const BIG_NUDGE = { ...TIMING, nudgeMs: 10 * 60_000 };

test("OPS-67-blocked: a blocked seat is polled in short intervals, reported once, and the drive goes on when it leaves blocked", () => {
	const f = driveFixture();
	try {
		const id = openSeatRun(f, false);
		scriptedHerdr(f, id, { waits: ["blocked", "close"], gets: ["blocked", "blocked", "blocked", "working"] });
		const started = Date.now();
		driveOnce(f.root, f.task, BIG_NUDGE);
		assert.ok(Date.now() - started < 5000, "no nudgeMs sleep: the drive goes on within a few poll intervals");
		assert.equal(f.events("blocked").length, 1, "one blocked event for the episode, not one per poll");
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
		driveOnce(f.root, f.task, BIG_NUDGE);
		closer.kill();
		assert.ok(Date.now() - started < 5000);
		assert.equal(f.events("blocked").length, 1);
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
		driveOnce(f.root, f.task, BIG_NUDGE);
		const prompts = f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "prompt");
		assert.equal(prompts.length, 0, "no nudge prompt in the Herdr log");
		assert.equal(f.events("nudge").length, 0);
		assert.equal(f.runs()[0]!.status, "passed");
	} finally {
		f.db.close();
		f.close();
	}
});
