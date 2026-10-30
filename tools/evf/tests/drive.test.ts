import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, findTask, markMerged, openWorkDb, sessionsRecorded, syncGoals } from "../db.ts";
import { drive, driveOnce, LOOP_CAP, nextStage, RETRY_CAP, runDone } from "../drive.ts";
import { doneCriteria } from "../spec.ts";
import { evfDataDir, parseTask, runtimeDir, sleep } from "../lib.ts";
import { verify } from "../verify.ts";

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "", ...env },
	});
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 150 };

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

function driveFixture(opts: { failWhenFile?: string } = {}) {
	const f = fixture(),
		task = parseTask("OPS-1");
	// A check that fails while `failWhenFile` exists in the worktree lets a test fail the author checks at one head.
	const checks = opts.failWhenFile
		? [
				{
					name: "fixture-check",
					run: [
						process.execPath,
						"-e",
						`process.exit(require("node:fs").existsSync(${JSON.stringify(opts.failWhenFile)}) ? 1 : 0)`,
					],
				},
				...f.cfg.checks.slice(1),
			]
		: f.cfg.checks;
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
	return { ...f, task, wt, db, taskId: t.id, herdr, runs, events, taskRow, file, insertRun };
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
			["1", "2"],
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
			"1",
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
		// GitHub reports the PR merged (a restart after the merge): the ship stage records it.
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
		assert.equal(types.lastIndexOf("next"), types.indexOf("next"), "one next event, before the ship");
		assert.ok(types.indexOf("next") < types.indexOf("merged"));
		assert.deepEqual(
			types.slice(types.indexOf("merged") + 1),
			["stage_end"],
			"only the ship run closes after the merge",
		);
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
			assert.match(r.stdout, /drive OPS-1: done \(merged\)/);
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
	for (let i = 0; i < n; i++)
		runDone(f.root, f.insertRun(stage, role, "started"), { status: "failed", summary: `${stage} broke` });
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
		assert.equal(after.events!.length, before.events!.length + 1);

		const n = nextOf(f);
		assert.equal(n.stage, "implement");
		assert.doesNotMatch(n.reason, /in a row/);
		failStage(f, "implement", "implementer", 2);
		assert.equal(f.taskRow().status, "active");
		assert.equal(nextOf(f).stage, "implement");
		assert.equal(driveOnce(f.root, f.task, { ...TIMING, waitMs: 1 }).stage === "escalated", false);
		failStage(f, "implement", "implementer");
		assert.equal(f.taskRow().status, "escalated");
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
	state.pr = { number: 77, url: "https://github.com/test/private/pull/77", state: "MERGED", mergeCommit: { oid: SHA } };
	state.requiredChecks = [{ name: "ci", bucket: "pass" }];
	f.setState(state);
	f.db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(SPEC, f.taskId);
	return remote;
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

		runDone(f.root, f.runs().at(-1)!.id as number, { status: "passed", summary: "still failing" });
		driveOnce(f.root, f.task, TIMING);
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
			f.herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start" && /evidence/.test(c.join(" "))).length,
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
