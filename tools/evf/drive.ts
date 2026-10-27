import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { ensureTask, openWorkDb, type TaskRow } from "./db.ts";
import { launch, type Role } from "./launch.ts";
import { EvfError, evfDataDir, fail, git, loadConfig, run, runtimeDir, sleep, worktreePath, type TaskRef } from "./lib.ts";
import { prOpen, ship } from "./ship.ts";
import { verify } from "./verify.ts";

/**
 * The stage machine of implement mode (the GPS of the talk, in code): plan → implement → simplify → pr → evidence →
 * verify → ci → ship → merged. Seats close their stage with `evf run done`; evf runs pr, ci and ship itself.
 * A verify or ci failure costs a round; the fourth round escalates to Sebastian (guard rail 2). `evf next` reads the
 * store and names the next stage; `evf drive` performs it, waits on the seat through Herdr and repeats. Jonah only
 * launches `evf drive --detach` and polls `evf status --json`.
 */

export const LOOP_CAP = 3;
export const STAGES = ["plan", "implement", "simplify", "pr", "evidence", "verify", "ci", "ship", "merged"] as const;
export type Stage = (typeof STAGES)[number];
const SEAT_STAGES: Partial<Record<Stage, Role>> = {
	plan: "planner",
	implement: "implementer",
	simplify: "simplifier",
	evidence: "evidence",
	verify: "verifier",
};
export const seatOf = (stage: Stage, task: TaskRef): Role | undefined =>
	stage === "implement" && task.part === "ui" ? "ui" : SEAT_STAGES[stage];

export type Next = {
	stage: Stage | "waiting" | "escalated" | "done";
	role?: Role;
	round: number;
	reason: string;
	run?: number;
};
type RunRow = { id: number; stage: string; role: string; status: string; round: number; summary: string | null };
type FullTask = TaskRow & { spec: string | null; pr_number: number | null };

const now = () => new Date().toISOString();
const record = (db: DatabaseSync, taskId: number, runId: number | null, type: string, payload: Record<string, unknown>) =>
	db
		.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)")
		.run(taskId, runId, now(), type, JSON.stringify(payload));

function fullTask(db: DatabaseSync, task: TaskRef, mode = "implement"): FullTask {
	const row = ensureTask(db, task, mode);
	const extra = db.prepare("SELECT spec, pr_number FROM tasks WHERE id = ?").get(row.id) as {
		spec: string | null;
		pr_number: number | null;
	};
	return { ...row, ...extra };
}
const runsOf = (db: DatabaseSync, taskId: number): RunRow[] =>
	db
		.prepare("SELECT id, stage, status, role, round, summary FROM runs WHERE task_id = ? ORDER BY started_at, id")
		.all(taskId) as RunRow[];

/** Pure: the next stage from the task's closed runs. Rounds are counted when a verify or ci run closes failed. */
export function nextStage(task: TaskRef, t: FullTask, runs: RunRow[]): Next {
	const round = t.round;
	if (t.status === "merged") return { stage: "done", round, reason: "merged" };
	if (t.status === "escalated") return { stage: "escalated", round, reason: `loop cap of ${LOOP_CAP} rounds hit` };
	const open = runs.find((r) => r.status === "started");
	if (open) return { stage: "waiting", round, run: open.id, reason: `the ${open.stage} seat is still open` };
	const go = (stage: Stage, reason: string): Next => ({ stage, role: seatOf(stage, task), round, reason });
	const last = runs.at(-1);
	if (!last) return t.spec ? go("implement", "spec stored, no runs yet") : go("plan", "no spec yet");
	const passed = last.status === "passed";
	switch (last.stage as Stage) {
		case "plan":
			return passed && t.spec ? go("implement", "plan passed") : go("plan", `plan ${last.status}${t.spec ? "" : ", no spec stored"}`);
		case "implement":
			return passed ? go("simplify", "implement passed") : go("implement", `implement ${last.status}: ${last.summary ?? ""}`.trim());
		case "simplify":
			return passed ? go("pr", "simplify passed") : go("implement", `simplify ${last.status}: ${last.summary ?? ""}`.trim());
		case "pr":
			return passed ? go("evidence", "PR open") : go("implement", `pr ${last.status}: ${last.summary ?? ""}`.trim());
		case "evidence":
			return passed ? go("verify", "evidence captured") : go("implement", `evidence ${last.status}: ${last.summary ?? ""}`.trim());
		case "verify":
			return passed ? go("ci", "verifier approved") : go("implement", `verifier requested changes (round ${round})`);
		case "ci":
			return passed ? go("ship", "CI green") : go("implement", `CI failed (round ${round})`);
		case "ship":
			return passed ? { stage: "done", round, reason: "shipped" } : go("implement", `ship refused: ${last.summary ?? ""}`.trim());
		default:
			return go("implement", `unknown stage ${last.stage}`);
	}
}

export function next(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		const t = fullTask(db, task);
		console.log(JSON.stringify(nextStage(task, t, runsOf(db, t.id))));
		return 0;
	} finally {
		db.close();
	}
}

function notify(title: string, body: string): void {
	run("herdr", ["notification", "show", title, "--body", body, "--sound", "request"]);
}

/** Close a stage. A failed verify or ci costs a round; the fourth round escalates and nothing launches again. */
export function runDone(
	root: string,
	runId: number,
	opts: { status: "passed" | "failed"; summaryFile?: string; summary?: string },
): number {
	const db = openWorkDb(root);
	try {
		const r = db
			.prepare("SELECT r.id, r.task_id, r.stage, r.role, r.status, t.ref, t.round, t.worktree FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?")
			.get(runId) as { id: number; task_id: number; stage: string; role: string; status: string; ref: string; round: number; worktree: string | null } | undefined;
		if (!r) fail(`No run ${runId} in the work store.`);
		if (r.status !== "started") fail(`Run ${runId} already closed as ${r.status}.`);
		const summary = opts.summary ?? (opts.summaryFile ? readFileSync(opts.summaryFile, "utf8").trim() : "");
		if (!summary) fail("Give --summary-file <file> (or --summary) with what happened in this stage.");
		db.prepare("UPDATE runs SET status = ?, ended_at = ?, summary = ? WHERE id = ?").run(opts.status, now(), summary, runId);
		record(db, r.task_id, runId, "stage_end", { stage: r.stage, status: opts.status, summary: summary.split("\n")[0]?.slice(0, 200) });
		if (r.stage === "verify") {
			const head = r.worktree && existsSync(r.worktree) ? git(r.worktree, "rev-parse", "HEAD") : null;
			db.prepare(
				"INSERT INTO approvals (task_id, gate, approver, head_sha, decision, quote, created_at) VALUES (?, 'verify', ?, ?, ?, ?, ?)",
			).run(r.task_id, `${r.role}@${r.ref}`, head, opts.status === "passed" ? "approved" : "changes_requested", summary.slice(0, 2000), now());
		}
		let escalated = false;
		if ((r.stage === "verify" || r.stage === "ci") && opts.status === "failed") {
			const round = r.round + 1;
			record(db, r.task_id, runId, "round", { round, cause: r.stage, summary: `round ${round} after ${r.stage} failed` });
			if (round > LOOP_CAP) {
				db.prepare("UPDATE tasks SET round = ?, status = 'escalated', updated_at = ? WHERE id = ?").run(round, now(), r.task_id);
				record(db, r.task_id, runId, "loop_cap_hit", { round, cap: LOOP_CAP, summary: `${r.ref} hit the loop cap after ${r.stage} failed` });
				record(db, r.task_id, runId, "escalation", { summary: `${r.ref} needs Sebastian: ${summary.split("\n")[0]?.slice(0, 160)}` });
				notify(`${r.ref} escalated`, `Loop cap ${LOOP_CAP} hit after ${r.stage} failed. ${summary.split("\n")[0]?.slice(0, 160)}`);
				escalated = true;
			} else db.prepare("UPDATE tasks SET round = ?, updated_at = ? WHERE id = ?").run(round, now(), r.task_id);
		} else db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), r.task_id);
		console.log(`run ${runId} (${r.stage}) closed ${opts.status}${escalated ? `; ${r.ref} escalated after ${LOOP_CAP} rounds` : ""}.`);
		return 0;
	} finally {
		db.close();
	}
}

export function taskNew(root: string, task: TaskRef, opts: { askFile: string; title?: string; mode?: string }): number {
	const ask = readFileSync(opts.askFile, "utf8").trim();
	if (!ask) fail("The ask file is empty.");
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, opts.mode ?? "implement");
		db.prepare("UPDATE tasks SET ask = ?, title = ?, updated_at = ? WHERE id = ?").run(ask, opts.title ?? t.ref, now(), t.id);
		record(db, t.id, null, "task_new", { summary: `${t.ref}: ${(opts.title ?? ask).split("\n")[0]?.slice(0, 160)}` });
		console.log(JSON.stringify({ task: t.ref, id: t.id, status: t.status, mode: t.mode }));
		return 0;
	} finally {
		db.close();
	}
}

export function taskSpec(root: string, task: TaskRef, file: string): number {
	const spec = readFileSync(file, "utf8").trim();
	if (!/done criteria/i.test(spec) || !/\n\s*1\./.test(spec)) fail("The spec needs a Goal, numbered Done criteria and Non-goals.");
	const hash = createHash("sha256").update(spec).digest("hex");
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		db.prepare("UPDATE tasks SET spec = ?, spec_hash = ?, status = CASE WHEN status = 'new' THEN 'specced' ELSE status END, updated_at = ? WHERE id = ?").run(spec, hash, now(), t.id);
		record(db, t.id, null, "spec_set", { hash, summary: `${t.ref} spec stored (${spec.split("\n").length} lines)` });
		console.log(`spec: ${t.ref} ${hash.slice(0, 12)}`);
		return 0;
	} finally {
		db.close();
	}
}

/** Proofs bind to the worktree head, so the verifier and `evf pr open` can refuse stale evidence. */
export function proofAdd(root: string, task: TaskRef, opts: { criterion: string; status: "met" | "unmet" | "n/a"; evidence?: string; notes?: string }): number {
	const wt = worktreePath(root, loadConfig(root), task);
	if (!existsSync(wt)) fail(`No worktree for ${task.id}.`);
	const head = git(wt, "rev-parse", "HEAD");
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		const runId = Number(process.env.EVF_RUN) || null;
		db.prepare("INSERT INTO proofs (task_id, run_id, head_sha, criterion, status, evidence_url, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
			t.id, runId, head, opts.criterion, opts.status, opts.evidence ?? null, opts.notes ?? null, now(),
		);
		record(db, t.id, runId, "proof", { criterion: opts.criterion, status: opts.status, head, summary: `criterion ${opts.criterion} ${opts.status} at ${head.slice(0, 10)}` });
		console.log(`proof: ${t.ref} criterion ${opts.criterion} ${opts.status} at ${head.slice(0, 10)}`);
		return 0;
	} finally {
		db.close();
	}
}

export function proofShow(root: string, task: TaskRef, json: boolean): number {
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		const wt = worktreePath(root, loadConfig(root), task);
		const head = existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;
		const rows = db.prepare("SELECT criterion, status, head_sha, evidence_url, notes, created_at FROM proofs WHERE task_id = ? ORDER BY id").all(t.id) as Array<Record<string, unknown>>;
		const atHead = rows.filter((p) => p.head_sha === head);
		if (json) console.log(JSON.stringify({ task: t.ref, head, proofs: rows, at_head: atHead }, null, 2));
		else {
			console.log(`proofs for ${t.ref} (head ${head?.slice(0, 10) ?? "no worktree"}): ${atHead.length} at head, ${rows.length} total`);
			for (const p of rows) console.log(`  ${String(p.head_sha).slice(0, 10)} ${String(p.criterion).padEnd(4)} ${String(p.status).padEnd(5)} ${p.evidence_url ?? "-"} ${p.notes ?? ""}`);
		}
		return 0;
	} finally {
		db.close();
	}
}

/** Record a check run against the task as a `check_result` event. The checks are `evf verify` author full. */
export function check(root: string, task: TaskRef, ignoreLoad?: string): number {
	let passed = false,
		detail = "";
	try {
		passed = verify(root, task, "author", "full", undefined, ignoreLoad).passed;
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		detail = e.message;
	}
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		record(db, t.id, Number(process.env.EVF_RUN) || null, "check_result", { passed, summary: `checks ${passed ? "passed" : "failed"}${detail ? `: ${detail.slice(0, 160)}` : ""}` });
	} finally {
		db.close();
	}
	if (detail) fail(detail);
	return passed ? 0 : 1;
}

/** Ask the planner that planned this task. Its session resumes as a fork, so the original transcript stays whole. */
export function askPlanner(root: string, task: TaskRef, question: string): number {
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		const planner = db.prepare("SELECT id, session_id FROM runs WHERE task_id = ? AND role = 'planner' AND session_id IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1").get(t.id) as { id: number; session_id: string } | undefined;
		if (!planner) fail(`${t.ref} has no planner run to ask.`);
		record(db, t.id, planner.id, "question", { from: process.env.EVF_ROLE ?? "unknown", summary: question.slice(0, 200) });
		const r = run("claude", ["-p", "--resume", planner.session_id, "--fork-session", "--output-format", "json", "--permission-mode", "acceptEdits", question], { cwd: process.env.EVF_WORKTREE || root });
		if (r.code !== 0) fail(`claude --resume ${planner.session_id} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
		let answer = r.stdout.trim();
		try {
			const parsed = JSON.parse(r.stdout) as { result?: string };
			if (typeof parsed.result === "string") answer = parsed.result;
		} catch {
			// Plain text answer.
		}
		record(db, t.id, planner.id, "answer", { summary: answer.slice(0, 200) });
		console.log(answer);
		return 0;
	} finally {
		db.close();
	}
}

const STAGE_PROMPTS: Record<string, (task: TaskRef, next: Next) => string> = {
	plan: (task) => `Plan task ${task.id}: write the spec (Goal, numbered testable Done criteria, Non-goals) from the ask in your session-start context, store it with bin/evf task spec ${task.id} --file <path>, then close with bin/evf run done $EVF_RUN --status passed --summary-file <path>.`,
	implement: (task, next) =>
		`Implement task ${task.id} in this worktree against the spec in your session-start context.${next.round ? ` Round ${next.round}: ${next.reason}. Read the last verify or ci summary with bin/evf status --json ${task.id} and fix those findings first.` : ""} Keep bin/evf verify ${task.id} green, commit, and write the PR body to ${"${EVF_PR_BODY}"} following .agents/skills/everyfield-pr/template.md with your EVF-Author line (bin/evf session prints your id). Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
	simplify: (task) => `Simplify task ${task.id}: read the spec and git diff origin/main...HEAD, remove what the Done criteria do not need, keep bin/evf verify ${task.id} green, commit. Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
	evidence: (task) => `Capture evidence for task ${task.id} at the current head: one bin/evf proof add ${task.id} --criterion <n> --status met|unmet --evidence <url-or-path> per Done criterion. Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
	verify: (task) => `Verify task ${task.id}: read the ask, spec, goal chain and bin/evf proof show ${task.id}; follow verify-preview; post one review with post-review.mjs --session <bin/evf session> --model claude-opus-5-5. Close with bin/evf run done $EVF_RUN --status passed (approved) or failed (changes requested) --summary-file <path> listing every finding.`,
};

const prBodyPath = (root: string, task: TaskRef) => join(runtimeDir(root, task), "pr-body.md");
const checksOf = (wt: string, number: number): { pending: string[]; failed: string[]; passed: string[] } => {
	const r = run("gh", ["pr", "checks", String(number), "--json", "name,bucket"], { cwd: wt });
	let checks: Array<{ name: string; bucket: string }> = [];
	try {
		const parsed = JSON.parse(r.stdout);
		if (Array.isArray(parsed)) checks = parsed;
	} catch {
		// No checks reported yet.
	}
	return {
		pending: checks.filter((c) => c.bucket === "pending").map((c) => c.name),
		failed: checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel" || c.bucket === "skipping").map((c) => c.name),
		passed: checks.filter((c) => c.bucket === "pass").map((c) => c.name),
	};
};

export type DriveTiming = { waitMs: number; nudgeMs: number; ciWaitMs: number; ciPollMs: number };
const DRIVE_TIMING: DriveTiming = { waitMs: 6 * 60 * 60_000, nudgeMs: 10 * 60_000, ciWaitMs: 40 * 60_000, ciPollMs: 30_000 };

/** evf runs these stages itself and records them as runs of role `evf`. */
function evfStage(db: DatabaseSync, root: string, task: TaskRef, t: FullTask, stage: Stage, timing: DriveTiming): void {
	const wt = worktreePath(root, loadConfig(root), task);
	const runId = Number(
		db.prepare("INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, 'evf', ?, 'started', ?)").run(t.id, stage, t.round, now()).lastInsertRowid,
	);
	record(db, t.id, runId, "stage_start", { stage, role: "evf", summary: `evf runs ${stage} for ${task.id}` });
	const close = (status: "passed" | "failed", summary: string) => runDone(root, runId, { status, summary });
	try {
		if (stage === "pr") {
			const body = prBodyPath(root, task);
			if (!existsSync(body)) return close("failed", `no PR body at ${body}; the implementer writes it`);
			prOpen(root, task, body);
			const view = run("gh", ["pr", "view", task.branch, "--json", "number"], { cwd: wt });
			const number = view.code === 0 ? (JSON.parse(view.stdout) as { number: number }).number : null;
			if (number) db.prepare("UPDATE tasks SET pr_number = ?, status = 'pr_open', updated_at = ? WHERE id = ?").run(number, now(), t.id);
			return close("passed", `PR #${number ?? "?"} open`);
		}
		if (stage === "ci") {
			const number = t.pr_number ?? (db.prepare("SELECT pr_number FROM tasks WHERE id = ?").get(t.id) as { pr_number: number | null }).pr_number;
			if (!number) return close("failed", "no PR number recorded");
			const start = Date.now();
			for (;;) {
				const c = checksOf(wt, number);
				if (c.failed.length) return close("failed", `CI failed: ${c.failed.join(", ")}`);
				if (!c.pending.length && c.passed.length) return close("passed", `CI green: ${c.passed.join(", ")}`);
				if (Date.now() - start > timing.ciWaitMs) return close("failed", `CI still pending after ${Math.round(timing.ciWaitMs / 60_000)} min: ${c.pending.join(", ") || "no checks reported"}`);
				sleep(timing.ciPollMs);
			}
		}
		if (stage === "ship") {
			ship(root, task);
			const view = run("gh", ["pr", "view", String(t.pr_number ?? task.branch), "--json", "mergeCommit", "-q", ".mergeCommit.oid"], { cwd: root });
			db.prepare("UPDATE tasks SET status = 'merged', merge_commit = ?, updated_at = ? WHERE id = ?").run(view.code === 0 ? view.stdout.trim() || null : null, now(), t.id);
			record(db, t.id, runId, "merged", { summary: `${task.id} merged` });
			return close("passed", "shipped");
		}
		return close("failed", `evf cannot run stage ${stage}`);
	} catch (e) {
		if (e instanceof EvfError) return close("failed", e.message);
		throw e;
	}
}

/** Wait on an open seat. A blocked seat is reported and waited on; an idle seat that left its stage open is nudged once, then aborted. */
function waitOnSeat(db: DatabaseSync, root: string, task: TaskRef, t: FullTask, runId: number, timing: DriveTiming): void {
	const r = db.prepare("SELECT herdr_agent, stage, status FROM runs WHERE id = ?").get(runId) as { herdr_agent: string | null; stage: string; status: string };
	if (!r.herdr_agent) {
		runDone(root, runId, { status: "failed", summary: "no Herdr agent recorded for this run" });
		return;
	}
	for (let nudged = false; ; ) {
		const waited = run("herdr", ["agent", "wait", r.herdr_agent, "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", String(timing.waitMs)]);
		const status = (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
		if (status !== "started") return;
		let state = "unknown";
		try {
			state = String((JSON.parse(waited.stdout) as { result?: { agent?: { agent_status?: string } } }).result?.agent?.agent_status ?? "unknown");
		} catch {
			// Herdr printed no JSON: treat as a timeout.
		}
		if (waited.code !== 0 && state === "unknown") {
			runDone(root, runId, { status: "failed", summary: `herdr agent wait failed or timed out: ${(waited.stderr || waited.stdout).trim().slice(0, 200)}` });
			return;
		}
		if (state === "blocked") {
			record(db, t.id, runId, "blocked", { summary: `${r.herdr_agent} is blocked on a prompt` });
			notify(`${task.id} seat blocked`, `${r.herdr_agent} waits on a prompt in its pane.`);
			sleep(timing.nudgeMs);
			continue;
		}
		if (!nudged) {
			nudged = true;
			record(db, t.id, runId, "nudge", { summary: `${r.herdr_agent} went idle without closing ${r.stage}` });
			run("herdr", ["agent", "prompt", r.herdr_agent, `Close your stage now: bin/evf run done ${runId} --status passed|failed --summary-file <path>. If you are blocked, say why in the summary and use failed.`]);
			sleep(Math.min(timing.nudgeMs, 2000));
			continue;
		}
		runDone(root, runId, { status: "failed", summary: `${r.herdr_agent} went idle twice without closing ${r.stage}` });
		return;
	}
}

/** One transition. Returns the stage it performed or waited on. */
export function driveOnce(root: string, task: TaskRef, timing: DriveTiming = DRIVE_TIMING): Next {
	const db = openWorkDb(root);
	try {
		const t = fullTask(db, task);
		const n = nextStage(task, t, runsOf(db, t.id));
		record(db, t.id, n.run ?? null, "next", { stage: n.stage, round: n.round, summary: `next: ${n.stage} (${n.reason})` });
		if (n.stage === "done" || n.stage === "escalated") return n;
		if (n.stage === "waiting") {
			waitOnSeat(db, root, task, t, n.run!, timing);
			return n;
		}
		if (n.role) {
			const prompt = STAGE_PROMPTS[n.stage]!(task, n).replace("${EVF_PR_BODY}", prBodyPath(root, task));
			db.close();
			mkdirSync(runtimeDir(root, task), { recursive: true });
			launch(root, task, n.role, { prompt });
			return n;
		}
		evfStage(db, root, task, t, n.stage, timing);
		return n;
	} finally {
		try {
			db.close();
		} catch {
			// Closed before the launch.
		}
	}
}

export function drive(root: string, task: TaskRef, opts: { once?: boolean; detach?: boolean }, timing: DriveTiming = DRIVE_TIMING): number {
	if (opts.detach) {
		const dir = join(evfDataDir(root), "drive");
		mkdirSync(dir, { recursive: true });
		const log = join(dir, `${task.slug}.log`),
			out = openSync(log, "a");
		const child = spawn(process.execPath, [join(root, "tools/evf/main.ts"), "drive", task.id], { cwd: root, detached: true, stdio: ["ignore", out, out] });
		writeFileSync(join(dir, `${task.slug}.pid`), `${child.pid}\n`);
		child.unref();
		console.log(JSON.stringify({ task: task.id, pid: child.pid, log }));
		return 0;
	}
	for (;;) {
		const n = driveOnce(root, task, timing);
		console.log(`${now()} drive ${task.id}: ${n.stage} (${n.reason})`);
		if (n.stage === "done" || n.stage === "escalated" || opts.once) return n.stage === "escalated" ? 2 : 0;
	}
}
