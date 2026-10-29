import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { ensureTask, findTask, markMerged, newTaskRow, openWorkDb, record, type TaskRow } from "./db.ts";
import { ideaWorktree, launch, type Role } from "./launch.ts";
import {
	EvfError,
	evfDataDir,
	fail,
	git,
	loadConfig,
	run,
	runtimeDir,
	sleep,
	worktreePath,
	type TaskRef,
} from "./lib.ts";
import { prFor, prOpen, ship } from "./ship.ts";
import { doneCriteria } from "./spec.ts";
import { verify } from "./verify.ts";

/**
 * The stage machine of implement mode (the GPS of the talk, in code): plan → implement → simplify → pr → evidence →
 * verify → ci → ship → merged. Seats close their stage with `evf run done`; evf runs pr, ci and ship itself.
 * A verify or ci failure costs a round; the fourth round escalates to Sebastian (guard rail 2). Any other failure
 * costs no round, but three failures in a row escalate too, so no loop runs unattended forever. `evf next` reads the
 * store and names the next stage; `evf drive` performs it, waits on the seat through Herdr and repeats. Jonah only
 * launches `evf drive --detach` and polls `evf status --json`.
 */

export const LOOP_CAP = 3;
/** Failures in a row that cost no round (plan, implement, simplify, pr, evidence, ship, aborted seats) before escalation. */
export const RETRY_CAP = 3;
export const STAGES = ["plan", "implement", "simplify", "pr", "evidence", "verify", "ci", "ship", "merged"] as const;
/** Prototype mode: plan (angles) → three idea seats → compare → pick (Sebastian) → merge (handoff) → done. */
export const PROTOTYPE_STAGES = ["plan", "idea", "compare", "pick", "merge"] as const;
export const IDEAS = 3;
export type Stage = (typeof STAGES)[number] | (typeof PROTOTYPE_STAGES)[number];
const SEAT_STAGES: Partial<Record<Stage, Role>> = {
	plan: "planner",
	implement: "implementer",
	simplify: "simplifier",
	evidence: "evidence",
	verify: "verifier",
	idea: "ideator",
	compare: "comparer",
	merge: "prototype-merger",
};
export const seatOf = (stage: Stage, task: TaskRef): Role | undefined =>
	stage === "implement" && task.part === "ui" ? "ui" : SEAT_STAGES[stage];

export type Next = {
	stage: Stage | "waiting" | "escalated" | "done";
	role?: Role;
	idea?: number;
	round: number;
	reason: string;
	run?: number;
};
type RunRow = { id: number; stage: string; role: string; status: string; round: number; summary: string | null };

const now = () => new Date().toISOString();
const headline = (text: string, max = 160) => text.split("\n")[0]?.slice(0, max) ?? "";
const runsOf = (db: DatabaseSync, taskId: number): RunRow[] =>
	db
		.prepare("SELECT id, stage, status, role, round, summary FROM runs WHERE task_id = ? ORDER BY started_at, id")
		.all(taskId) as RunRow[];

/** A task row for a ref the store does not know yet, so read commands can answer without writing. */
const unknownTask = (task: TaskRef): TaskRow => ({
	id: 0,
	ref: task.id,
	slug: task.slug,
	mode: "implement",
	status: "new",
	round: 0,
	goal_id: null,
	spec: null,
	pr_number: null,
	worktree: null,
});

/** Failed or aborted runs since the last passed one. An evf run aborted by a restart is not a failure. */
const trailingFailures = (runs: RunRow[]): number => {
	let n = 0;
	for (let i = runs.length - 1; i >= 0; i--) {
		const r = runs[i]!;
		if (r.status === "passed") break;
		if (r.status === "started" || (r.role === "evf" && r.status === "aborted")) continue;
		n++;
	}
	return n;
};

/** Prototype mode. Idea seats launch one per transition and run side by side; the pick is Sebastian's, not evf's. */
function nextPrototype(task: TaskRef, t: TaskRow, runs: RunRow[], picked: boolean): Next {
	const round = t.round;
	if (t.status === "done") return { stage: "done", round, reason: "handed off" };
	if (t.status === "escalated") return { stage: "escalated", round, reason: "escalated" };
	const failures = trailingFailures(runs);
	if (failures >= RETRY_CAP)
		return { stage: "escalated", round, reason: `${failures} failures in a row without a passed stage` };
	const go = (stage: Stage, reason: string, idea?: number): Next => ({
		stage,
		role: seatOf(stage, task),
		...(idea ? { idea } : {}),
		round,
		reason,
	});
	const lastOf = (stage: string) => runs.filter((r) => r.stage === stage).at(-1);
	if (!t.spec) {
		const plan = lastOf("plan");
		if (plan?.status === "started")
			return { stage: "waiting", round, run: plan.id, reason: "the plan seat is still open" };
		return go("plan", plan ? `plan ${plan.status}, no spec stored` : "no spec yet");
	}
	for (let i = 1; i <= IDEAS; i++) {
		const last = lastOf(`idea${i}`);
		if (!last || last.status === "failed" || last.status === "aborted")
			return go("idea", `idea ${i} ${last ? last.status : "not started"}`, i);
	}
	const openIdea = runs.find((r) => /^idea\d$/.test(r.stage) && r.status === "started");
	if (openIdea) return { stage: "waiting", round, run: openIdea.id, reason: `${openIdea.stage} is still open` };
	const compare = lastOf("compare");
	if (compare?.status !== "passed") {
		if (compare?.status === "started")
			return { stage: "waiting", round, run: compare.id, reason: "the compare seat is still open" };
		return go("compare", compare ? `compare ${compare.status}` : "all ideas built");
	}
	if (!picked) return { stage: "pick", round, reason: "waiting for Sebastian's pick: evf task pick" };
	const merge = lastOf("merge");
	if (merge?.status === "started")
		return { stage: "waiting", round, run: merge.id, reason: "the merge seat is still open" };
	if (merge?.status === "passed") return { stage: "done", round, reason: "handed off" };
	return go("merge", merge ? `merge ${merge.status}` : "idea picked");
}

/** Pure: the next stage from the task's closed runs. Rounds are counted when a verify or ci run closes failed. */
export function nextStage(task: TaskRef, t: TaskRow, runs: RunRow[], picked = false): Next {
	const round = t.round;
	if (t.mode === "prototype") return nextPrototype(task, t, runs, picked);
	if (t.status === "merged" || t.status === "done") return { stage: "done", round, reason: t.status };
	if (t.status === "escalated") return { stage: "escalated", round, reason: `loop cap of ${LOOP_CAP} rounds hit` };
	const open = runs.find((r) => r.status === "started");
	if (open) return { stage: "waiting", round, run: open.id, reason: `the ${open.stage} seat is still open` };
	const failures = trailingFailures(runs);
	if (failures >= RETRY_CAP)
		return { stage: "escalated", round, reason: `${failures} failures in a row without a passed stage` };
	const go = (stage: Stage, reason: string): Next => ({ stage, role: seatOf(stage, task), round, reason });
	// An evf run aborted by a restart never happened: the stage before it decides.
	const last = runs.filter((r) => !(r.role === "evf" && r.status === "aborted")).at(-1);
	if (!last) return t.spec ? go("implement", "spec stored, no runs yet") : go("plan", "no spec yet");
	const passed = last.status === "passed";
	const again = (stage: Stage) => go(stage, `${last.stage} ${last.status}: ${last.summary ?? ""}`.trim());
	switch (last.stage as Stage) {
		case "plan":
			return passed && t.spec
				? go("implement", "plan passed")
				: go("plan", `plan ${last.status}${t.spec ? "" : ", no spec stored"}`);
		case "implement":
			return passed ? go("simplify", "implement passed") : again("implement");
		case "simplify":
			return passed ? go("pr", "simplify passed") : again("implement");
		case "pr":
			return passed ? go("evidence", "PR open") : again("implement");
		case "evidence":
			return passed ? go("verify", "evidence captured") : again("implement");
		case "verify":
			return passed ? go("ci", "verifier approved") : go("implement", `verifier requested changes (round ${round})`);
		case "ci":
			return passed ? go("ship", "CI green") : go("implement", `CI failed (round ${round})`);
		case "ship":
			return passed ? { stage: "done", round, reason: "shipped" } : again("implement");
		default:
			return go("implement", `unknown stage ${last.stage}`);
	}
}

export function next(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task) ?? unknownTask(task);
		console.log(JSON.stringify(nextStage(task, t, t.id ? runsOf(db, t.id) : [], !!(t.id && pickOf(db, t.id)))));
		return 0;
	} finally {
		db.close();
	}
}

function notify(title: string, body: string): void {
	run("herdr", ["notification", "show", title, "--body", body, "--sound", "request"]);
}

/** The task stops here until Sebastian decides: status escalated, events, a Herdr notification. */
function escalate(db: DatabaseSync, t: { id: number; ref: string }, runId: number | null, cause: string): void {
	db.prepare("UPDATE tasks SET status = 'escalated', updated_at = ? WHERE id = ?").run(now(), t.id);
	record(db, t.id, runId, "escalation", { summary: `${t.ref} needs Sebastian: ${cause}` });
	notify(`${t.ref} escalated`, cause);
}

/**
 * Close a stage. A failed verify or ci costs a round; the fourth round escalates and nothing launches again. A verify
 * run closes passed only when every Done criterion has a met or n/a proof at the worktree head (guard rail 3).
 */
export function runDone(
	root: string,
	runId: number,
	opts: { status: "passed" | "failed"; summaryFile?: string; summary?: string },
): number {
	const db = openWorkDb(root);
	try {
		const r = db
			.prepare(
				"SELECT r.id, r.task_id, r.stage, r.role, r.status, t.ref, t.round, t.worktree, t.spec FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
			)
			.get(runId) as
			| {
					id: number;
					task_id: number;
					stage: string;
					role: string;
					status: string;
					ref: string;
					round: number;
					worktree: string | null;
					spec: string | null;
			  }
			| undefined;
		if (!r) fail(`No run ${runId} in the work store.`);
		if (r.status !== "started") fail(`Run ${runId} already closed as ${r.status}.`);
		const summary = opts.summary ?? (opts.summaryFile ? readFileSync(opts.summaryFile, "utf8").trim() : "");
		if (!summary) fail("Give --summary-file <file> (or --summary) with what happened in this stage.");
		const first = headline(summary);
		const head = r.worktree && existsSync(r.worktree) ? git(r.worktree, "rev-parse", "HEAD") : null;
		if (r.stage === "verify" && opts.status === "passed") {
			if (!head) fail(`${r.ref} has no worktree to read the head from; a verify cannot pass without proofs at a head.`);
			const proven = new Set(
				(
					db
						.prepare("SELECT criterion FROM proofs WHERE task_id = ? AND head_sha = ? AND status IN ('met', 'n/a')")
						.all(r.task_id, head) as Array<{ criterion: string }>
				).map((p) => p.criterion),
			);
			const missing = doneCriteria(r.spec).filter((c) => !proven.has(c));
			if (missing.length)
				fail(
					`Done criteria ${missing.join(", ")} have no met or n/a proof at ${head.slice(0, 10)}. Add them with bin/evf proof add ${r.ref} --criterion <n> --status met|n/a --evidence <url>, or close this verify as failed.`,
				);
		}
		db.prepare("UPDATE runs SET status = ?, ended_at = ?, summary = ? WHERE id = ?").run(
			opts.status,
			now(),
			summary,
			runId,
		);
		record(db, r.task_id, runId, "stage_end", { stage: r.stage, status: opts.status, summary: headline(summary, 200) });
		if (r.stage === "verify")
			db.prepare(
				"INSERT INTO approvals (task_id, gate, approver, head_sha, decision, quote, created_at) VALUES (?, 'verify', ?, ?, ?, ?, ?)",
			).run(
				r.task_id,
				`${r.role}@${r.ref}`,
				head,
				opts.status === "passed" ? "approved" : "changes_requested",
				summary.slice(0, 2000),
				now(),
			);
		let escalated = "";
		if ((r.stage === "verify" || r.stage === "ci") && opts.status === "failed") {
			const round = r.round + 1;
			record(db, r.task_id, runId, "round", {
				round,
				cause: r.stage,
				summary: `round ${round} after ${r.stage} failed`,
			});
			db.prepare("UPDATE tasks SET round = ?, updated_at = ? WHERE id = ?").run(round, now(), r.task_id);
			if (round > LOOP_CAP) {
				record(db, r.task_id, runId, "loop_cap_hit", {
					round,
					cap: LOOP_CAP,
					summary: `${r.ref} hit the loop cap after ${r.stage} failed`,
				});
				escalated = `loop cap ${LOOP_CAP} hit after ${r.stage} failed. ${first}`;
			}
		} else {
			db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), r.task_id);
			if (opts.status === "failed") {
				const failures = trailingFailures(runsOf(db, r.task_id));
				if (failures >= RETRY_CAP) escalated = `${failures} failures in a row, last in ${r.stage}. ${first}`;
			}
		}
		if (escalated) escalate(db, { id: r.task_id, ref: r.ref }, runId, escalated);
		console.log(`run ${runId} (${r.stage}) closed ${opts.status}${escalated ? `; ${r.ref} escalated` : ""}.`);
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
		const mode = opts.mode ?? "implement";
		if (!["implement", "prototype"].includes(mode)) fail("--mode must be implement or prototype.");
		// The one command that reopens a merged ref: the merged row keeps its status and commit.
		const prior = findTask(db, task);
		const reopens = prior?.status === "merged" ? prior : undefined;
		const t = reopens ? newTaskRow(db, task, mode) : ensureTask(db, task, mode);
		if (t.mode !== mode)
			fail(`${t.ref} already has an open ${t.mode} task; finish or abandon it before a ${mode} task.`);
		db.prepare("UPDATE tasks SET ask = ?, title = ?, updated_at = ? WHERE id = ?").run(
			ask,
			opts.title ?? t.ref,
			now(),
			t.id,
		);
		record(db, t.id, null, "task_new", {
			summary: `${t.ref}: ${headline(opts.title ?? ask)}`,
			...(reopens ? { reopens: reopens.id } : {}),
		});
		console.log(JSON.stringify({ task: t.ref, id: t.id, status: t.status, mode: t.mode }));
		return 0;
	} finally {
		db.close();
	}
}

export function taskSpec(root: string, task: TaskRef, file: string): number {
	const spec = readFileSync(file, "utf8").trim();
	if (!doneCriteria(spec).length) fail("The spec needs a Goal, numbered Done criteria and Non-goals.");
	const hash = createHash("sha256").update(spec).digest("hex");
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		if (t.status === "merged")
			fail(`${t.ref} is merged. Start a new task with evf task new ${t.ref} --ask-file <file>.`);
		db.prepare(
			"UPDATE tasks SET spec = ?, spec_hash = ?, status = CASE WHEN status = 'new' THEN 'specced' ELSE status END, updated_at = ? WHERE id = ?",
		).run(spec, hash, now(), t.id);
		record(db, t.id, null, "spec_set", { hash, summary: `${t.ref} spec stored (${spec.split("\n").length} lines)` });
		console.log(`spec: ${t.ref} ${hash.slice(0, 12)}`);
		return 0;
	} finally {
		db.close();
	}
}

type Pick = { idea: number; quote: string; created_at: string };
const pickOf = (db: DatabaseSync, taskId: number): Pick | null => {
	const row = db
		.prepare(
			"SELECT proof_ids, quote, created_at FROM approvals WHERE task_id = ? AND gate = 'pick' AND decision = 'approved' ORDER BY id DESC LIMIT 1",
		)
		.get(taskId) as { proof_ids: string; quote: string; created_at: string } | undefined;
	if (!row) return null;
	const idea = Number((JSON.parse(row.proof_ids) as number[])[0]);
	return Number.isInteger(idea) ? { idea, quote: row.quote, created_at: row.created_at } : null;
};

/** Sebastian's pick, in his words, recorded as an approval of gate `pick` so the merge seat can start. */
export function taskPick(root: string, task: TaskRef, idea: number, ownerApproval: string): number {
	if (process.env.EVF_RUN)
		fail("The pick is Sebastian's, recorded by Jonah or a human shell: a seat cannot run evf task pick.");
	if (!Number.isInteger(idea) || idea < 1 || idea > IDEAS) fail(`Pick an idea from 1 to ${IDEAS}.`);
	if (ownerApproval.trim().split(/\s+/).filter(Boolean).length < 2)
		fail('Quote Sebastian\'s pick: --owner-approval "<his words>".');
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "prototype");
		if (t.mode !== "prototype") fail(`${t.ref} is in ${t.mode} mode; only prototype tasks take a pick.`);
		const wt = ideaWorktree(root, loadConfig(root), task, idea);
		const head = existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;
		db.prepare(
			"INSERT INTO approvals (task_id, gate, approver, head_sha, proof_ids, decision, quote, created_at) VALUES (?, 'pick', 'Sebastian', ?, ?, 'approved', ?, ?)",
		).run(t.id, head, JSON.stringify([idea]), ownerApproval.trim(), now());
		db.prepare("UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?").run(now(), t.id);
		record(db, t.id, null, "pick", {
			idea,
			head,
			summary: `Sebastian picked idea ${idea}: ${ownerApproval.trim().slice(0, 120)}`,
		});
		console.log(`pick: ${t.ref} idea ${idea}${head ? ` at ${head.slice(0, 10)}` : ""}.`);
		return 0;
	} finally {
		db.close();
	}
}

/** The merge seat's handoff becomes the implement task's spec; the prototype task is done and its code discarded. */
export function taskHandoff(root: string, task: TaskRef, file: string): number {
	const spec = readFileSync(file, "utf8").trim();
	if (!doneCriteria(spec).length) fail("The handoff needs a Goal, numbered Done criteria, Non-goals and an Approach.");
	const hash = createHash("sha256").update(spec).digest("hex");
	const db = openWorkDb(root);
	try {
		const proto = ensureTask(db, task, "prototype");
		if (proto.mode !== "prototype") fail(`${proto.ref} is in ${proto.mode} mode; a handoff ends a prototype task.`);
		if (!pickOf(db, proto.id)) fail(`${proto.ref} has no pick yet; Sebastian picks before the handoff.`);
		const ask = (db.prepare("SELECT ask FROM tasks WHERE id = ?").get(proto.id) as { ask: string }).ask;
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(now(), proto.id);
			const implementId = Number(
				db
					.prepare(
						"INSERT INTO tasks (slug, mode, ref, goal_id, title, ask, spec, spec_hash, branch, status, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, ?, ?, ?, 'specced', ?, ?)",
					)
					.run(
						task.slug,
						task.id,
						proto.goal_id,
						`${task.id} from prototype`,
						ask,
						spec,
						hash,
						task.branch,
						now(),
						now(),
					).lastInsertRowid,
			);
			record(db, proto.id, Number(process.env.EVF_RUN) || null, "handoff", {
				implement_task: implementId,
				hash,
				summary: `${proto.ref} handed off to implement task ${implementId}`,
			});
			record(db, implementId, null, "spec_set", {
				hash,
				from_prototype: proto.id,
				summary: `${task.id} spec from the prototype handoff`,
			});
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		console.log(`handoff: ${proto.ref} done; implement task created with spec ${hash.slice(0, 12)}.`);
		return 0;
	} finally {
		db.close();
	}
}

/** Proofs bind to the worktree head, so the verify close and `evf proof show` can refuse stale evidence. */
export function proofAdd(
	root: string,
	task: TaskRef,
	opts: { criterion: string; status: "met" | "unmet" | "n/a"; evidence?: string; notes?: string },
): number {
	const wt = worktreePath(root, loadConfig(root), task);
	if (!existsSync(wt)) fail(`No worktree for ${task.id}.`);
	const head = git(wt, "rev-parse", "HEAD");
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		const runId = Number(process.env.EVF_RUN) || null;
		db.prepare(
			"INSERT INTO proofs (task_id, run_id, head_sha, criterion, status, evidence_url, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(t.id, runId, head, opts.criterion, opts.status, opts.evidence ?? null, opts.notes ?? null, now());
		record(db, t.id, runId, "proof", {
			criterion: opts.criterion,
			status: opts.status,
			head,
			summary: `criterion ${opts.criterion} ${opts.status} at ${head.slice(0, 10)}`,
		});
		console.log(`proof: ${t.ref} criterion ${opts.criterion} ${opts.status} at ${head.slice(0, 10)}`);
		return 0;
	} finally {
		db.close();
	}
}

export function proofShow(root: string, task: TaskRef, json: boolean): number {
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task);
		const wt = worktreePath(root, loadConfig(root), task);
		const head = existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;
		const rows = t
			? (db
					.prepare(
						"SELECT criterion, status, head_sha, evidence_url, notes, created_at FROM proofs WHERE task_id = ? ORDER BY id",
					)
					.all(t.id) as Array<Record<string, unknown>>)
			: [];
		const atHead = rows.filter((p) => p.head_sha === head);
		if (json) console.log(JSON.stringify({ task: task.id, head, proofs: rows, at_head: atHead }, null, 2));
		else {
			console.log(
				`proofs for ${task.id} (head ${head?.slice(0, 10) ?? "no worktree"}): ${atHead.length} at head, ${rows.length} total`,
			);
			for (const p of rows)
				console.log(
					`  ${String(p.head_sha).slice(0, 10)} ${String(p.criterion).padEnd(4)} ${String(p.status).padEnd(5)} ${p.evidence_url ?? "-"} ${p.notes ?? ""}`,
				);
		}
		return 0;
	} finally {
		db.close();
	}
}

/** Run the author checks against the task. A task the store knows gets a `check_result` event; others only the checks. */
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
		const t = findTask(db, task);
		if (t)
			record(db, t.id, Number(process.env.EVF_RUN) || null, "check_result", {
				passed,
				summary: `checks ${passed ? "passed" : "failed"}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
			});
	} finally {
		db.close();
	}
	if (detail) fail(detail);
	return passed ? 0 : 1;
}

/** Ask the planner that planned this task. Its session resumes as a fork in plan mode, so it answers without editing. */
export function askPlanner(root: string, task: TaskRef, question: string): number {
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task);
		const planner = t
			? (db
					.prepare(
						"SELECT id, session_id FROM runs WHERE task_id = ? AND role = 'planner' AND session_id IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1",
					)
					.get(t.id) as { id: number; session_id: string } | undefined)
			: undefined;
		if (!t || !planner) fail(`${task.id} has no planner run to ask.`);
		record(db, t.id, planner.id, "question", {
			from: process.env.EVF_ROLE ?? "unknown",
			summary: question.slice(0, 200),
		});
		const r = run(
			"claude",
			[
				"-p",
				"--resume",
				planner.session_id,
				"--fork-session",
				"--output-format",
				"json",
				"--permission-mode",
				"plan",
				question,
			],
			{ cwd: process.env.EVF_WORKTREE || root },
		);
		if (r.code !== 0)
			fail(`claude --resume ${planner.session_id} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
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

const CLOSE = "Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.";
/** What a stage prompt may name: the spec, the idea worktrees, the comparison dir, the pick and the PR body path. */
type PromptContext = { spec: string | null; ideas: string[]; comparison: string; pick: Pick | null; prBody: string };
type Prompt = (task: TaskRef, next: Next, ctx: PromptContext) => string;
const angleOf = (spec: string | null, idea: number) =>
	spec
		?.split("\n")
		.find((line) => new RegExp(`^\\s*Angle ${idea}\\s*:`, "i").test(line))
		?.replace(/^\s*Angle \d\s*:\s*/i, "") ??
	`angle ${idea} (the spec names none; choose a distinct approach and say which)`;
const PROTOTYPE_PROMPTS: Record<string, Prompt> = {
	plan: (task) =>
		`Plan prototype task ${task.id}: from the brief in your session-start context write the spec with Goal, three lines "Angle 1:", "Angle 2:" and "Angle 3:" naming three distinct approaches worth a proof of concept, numbered Done criteria for what every proof of concept must show, and Non-goals. Store it with bin/evf task spec ${task.id} --file <path>, then close with bin/evf run done $EVF_RUN --status passed --summary-file <path>.`,
	idea: (task, next, ctx) =>
		`Build idea ${next.idea} of prototype task ${task.id} in this worktree. Your angle: ${angleOf(ctx.spec, next.idea!)}. The brief and the Done criteria are in your session-start context. Write IDEA.md at the worktree root, commit, and close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
	compare: (task, _next, ctx) =>
		`Compare the three ideas of prototype task ${task.id}. Idea worktrees: ${ctx.ideas.join(", ")}. Build the comparison in ${ctx.comparison} (a toggle page for UI work; a compare script plus one diagram per idea for backend work) and write comparison.md there without naming a winner. Record it with bin/evf proof add ${task.id} --criterion comparison --status met --evidence ${ctx.comparison}/comparison.md, then close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
	merge: (task, _next, ctx) =>
		`Sebastian picked idea ${ctx.pick?.idea} of prototype task ${task.id}: "${ctx.pick?.quote}". Its worktree: ${ctx.ideas[(ctx.pick?.idea ?? 1) - 1]}. Comparison: ${ctx.comparison}. Read the brief, the comparison and all three ideas, write the handoff spec (Goal, numbered Done criteria, Non-goals, Approach) and run bin/evf task handoff ${task.id} --file <path>. Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
};
const STAGE_PROMPTS: Record<string, Prompt> = {
	plan: (task) =>
		`Plan task ${task.id}: write the spec (Goal, numbered testable Done criteria, Non-goals) from the ask in your session-start context, store it with bin/evf task spec ${task.id} --file <path>, then close with bin/evf run done $EVF_RUN --status passed --summary-file <path>.`,
	implement: (task, next, ctx) =>
		`Implement task ${task.id} in this worktree against the spec in your session-start context.${next.round ? ` Round ${next.round}: ${next.reason}. Read the last verify or ci summary with bin/evf status --json ${task.id} and fix those findings first.` : ""} Keep bin/evf verify ${task.id} green, commit, and write the PR body to ${ctx.prBody} following .agents/skills/everyfield-pr/template.md with your EVF-Author line (bin/evf session prints your id). ${CLOSE}`,
	simplify: (task) =>
		`Simplify task ${task.id}: read the spec and git diff origin/main...HEAD, remove what the Done criteria do not need, keep bin/evf verify ${task.id} green, commit. ${CLOSE}`,
	evidence: (task) =>
		`Capture evidence for task ${task.id} at the current head. First read the full spec with bin/evf task spec ${task.id} --show: your session-start context may shorten it. Then record one bin/evf proof add ${task.id} --criterion <n> --status met|unmet|n/a --evidence <url-or-path> per Done criterion. ${CLOSE}`,
	verify: (task) =>
		`Verify task ${task.id}: before you judge, read the full ask and spec with bin/evf task spec ${task.id} --show (your session-start context may shorten them), the goal chain and bin/evf proof show ${task.id}; follow verify-preview; post one review with post-review.mjs --session <bin/evf session> --model claude-opus-5-5. Close with bin/evf run done $EVF_RUN --status passed (approved; every Done criterion needs a met or n/a proof at the head) or failed (changes requested) --summary-file <path> listing every finding.`,
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
		failed: checks
			.filter((c) => c.bucket === "fail" || c.bucket === "cancel" || c.bucket === "skipping")
			.map((c) => c.name),
		passed: checks.filter((c) => c.bucket === "pass").map((c) => c.name),
	};
};

/**
 * seatPollMs: how often a blocked seat, or a seat whose first turn has not begun, is looked at again.
 * startGraceMs: how long after the launch prompt an idle report counts as "the turn has not begun yet".
 */
export type DriveTiming = {
	waitMs: number;
	nudgeMs: number;
	ciWaitMs: number;
	ciPollMs: number;
	seatPollMs: number;
	startGraceMs: number;
};
const DRIVE_TIMING: DriveTiming = {
	waitMs: 6 * 60 * 60_000,
	nudgeMs: 10 * 60_000,
	seatPollMs: 5_000,
	startGraceMs: 30_000,
	ciWaitMs: 40 * 60_000,
	ciPollMs: 30_000,
};

type Outcome = { status: "passed" | "failed"; summary: string };
/** The pr stage: push and open the PR from the body the implementer wrote, then remember its number. */
function prStage(db: DatabaseSync, root: string, task: TaskRef, t: TaskRow, wt: string): Outcome {
	const body = prBodyPath(root, task);
	if (!existsSync(body)) return { status: "failed", summary: `no PR body at ${body}; the implementer writes it` };
	prOpen(root, task, body);
	const pr = prFor(wt, task);
	if (pr)
		db.prepare("UPDATE tasks SET pr_number = ?, status = 'pr_open', updated_at = ? WHERE id = ?").run(
			pr.number,
			now(),
			t.id,
		);
	return { status: "passed", summary: `PR #${pr?.number ?? "?"} open` };
}

/** The ci stage: poll the PR checks until they all pass, one fails, or the wait runs out. */
function ciStage(t: TaskRow, wt: string, timing: DriveTiming): Outcome {
	if (!t.pr_number) return { status: "failed", summary: "no PR number recorded" };
	const start = Date.now();
	for (;;) {
		const c = checksOf(wt, t.pr_number);
		if (c.failed.length) return { status: "failed", summary: `CI failed: ${c.failed.join(", ")}` };
		if (!c.pending.length && c.passed.length) return { status: "passed", summary: `CI green: ${c.passed.join(", ")}` };
		if (Date.now() - start > timing.ciWaitMs)
			return {
				status: "failed",
				summary: `CI still pending after ${Math.round(timing.ciWaitMs / 60_000)} min: ${c.pending.join(", ") || "no checks reported"}`,
			};
		sleep(timing.ciPollMs);
	}
}

/** The ship stage. A PR GitHub already merged (a restart after the merge) is recorded, not shipped again. */
function shipStage(db: DatabaseSync, root: string, task: TaskRef, t: TaskRow, runId: number): Outcome {
	const view = (): { state: string; commit: string | null } => {
		const r = run("gh", ["pr", "view", String(t.pr_number ?? task.branch), "--json", "state,mergeCommit"], {
			cwd: root,
		});
		const text = r.code === 0 ? r.stdout.trim() : "";
		try {
			const v = JSON.parse(text) as { state?: string; mergeCommit?: { oid?: string } | null };
			return { state: v.state ?? "", commit: v.mergeCommit?.oid ?? null };
		} catch {
			return { state: "", commit: /^[0-9a-f]{40}$/.test(text) ? text : null };
		}
	};
	const before = view();
	if (before.state !== "MERGED") ship(root, task);
	markMerged(db, task, before.state === "MERGED" ? before.commit : view().commit, runId);
	return { status: "passed", summary: before.state === "MERGED" ? "already merged on GitHub" : "shipped" };
}

/** evf runs pr, ci and ship itself and records them as runs of role `evf`. */
function evfStage(db: DatabaseSync, root: string, task: TaskRef, t: TaskRow, stage: Stage, timing: DriveTiming): void {
	const wt = worktreePath(root, loadConfig(root), task);
	const runId = Number(
		db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, 'evf', ?, 'started', ?)",
			)
			.run(t.id, stage, t.round, now()).lastInsertRowid,
	);
	record(db, t.id, runId, "stage_start", { stage, role: "evf", summary: `evf runs ${stage} for ${task.id}` });
	let outcome: Outcome;
	try {
		outcome =
			stage === "pr"
				? prStage(db, root, task, t, wt)
				: stage === "ci"
					? ciStage(t, wt, timing)
					: stage === "ship"
						? shipStage(db, root, task, t, runId)
						: { status: "failed", summary: `evf cannot run stage ${stage}` };
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		outcome = { status: "failed", summary: e.message };
	}
	runDone(root, runId, outcome);
}

const runStatus = (db: DatabaseSync, runId: number) =>
	(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;

/** The agent state in `herdr agent get|wait` output, or "unknown" when Herdr printed none. */
function parseAgentState(stdout: string): string {
	try {
		return String(
			(JSON.parse(stdout) as { result?: { agent?: { agent_status?: string } } }).result?.agent?.agent_status ?? "unknown",
		);
	} catch {
		return "unknown";
	}
}

const agentState = (agent: string) => parseAgentState(run("herdr", ["agent", "get", agent]).stdout);

/** When the launch prompt went in, or null for a seat launched without one. */
function promptSentAt(db: DatabaseSync, runId: number): number | null {
	const row = db
		.prepare("SELECT ts FROM events WHERE run_id = ? AND type = 'prompt_sent' ORDER BY id LIMIT 1")
		.get(runId) as { ts: string } | undefined;
	return row ? Date.parse(row.ts) : null;
}

/**
 * Wait on an open seat. A blocked seat is reported once per episode and polled until it leaves `blocked`; an idle report
 * before the launch prompt began its turn is not a finished turn; a seat that goes idle after its turn with its stage
 * open is nudged once, then aborted.
 */
function waitOnSeat(
	db: DatabaseSync,
	root: string,
	task: TaskRef,
	t: TaskRow,
	runId: number,
	timing: DriveTiming,
): void {
	const r = db.prepare("SELECT herdr_agent, stage, status FROM runs WHERE id = ?").get(runId) as {
		herdr_agent: string | null;
		stage: string;
		status: string;
	};
	if (!r.herdr_agent) {
		runDone(root, runId, { status: "failed", summary: "no Herdr agent recorded for this run" });
		return;
	}
	let turnSeen = false;
	for (let nudged = false; ;) {
		const waited = run("herdr", [
			"agent",
			"wait",
			r.herdr_agent,
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
			"--timeout",
			String(timing.waitMs),
		]);
		if (runStatus(db, runId) !== "started") return;
		const state = parseAgentState(waited.stdout);
		if (waited.code !== 0 && state === "unknown") {
			runDone(root, runId, {
				status: "failed",
				summary: `herdr agent wait failed or timed out: ${(waited.stderr || waited.stdout).trim().slice(0, 200)}`,
			});
			return;
		}
		if (state === "blocked") {
			record(db, t.id, runId, "blocked", { summary: `${r.herdr_agent} is blocked on a prompt` });
			notify(`${task.id} seat blocked`, `${r.herdr_agent} waits on a prompt in its pane.`);
			do {
				sleep(timing.seatPollMs);
				if (runStatus(db, runId) !== "started") return;
			} while (agentState(r.herdr_agent) === "blocked");
			continue;
		}
		if (state === "idle" && !nudged && !turnSeen) {
			// The launch prompt may not have begun its turn yet: wait for the seat to leave idle before reading idle as finished.
			const sent = promptSentAt(db, runId);
			if (sent !== null) {
				for (let left = sent + timing.startGraceMs; Date.now() < left;) {
					sleep(timing.seatPollMs);
					if (runStatus(db, runId) !== "started") return;
					if (agentState(r.herdr_agent) !== "idle") {
						turnSeen = true;
						break;
					}
				}
				if (turnSeen) continue;
			}
		}
		if (!nudged) {
			nudged = true;
			record(db, t.id, runId, "nudge", { summary: `${r.herdr_agent} went idle without closing ${r.stage}` });
			// --wait returns when the nudged turn ends, so the next wait above sees the seat's answer, not the old idle.
			run("herdr", [
				"agent",
				"prompt",
				r.herdr_agent,
				`Close your stage now: bin/evf run done ${runId} --status passed|failed --summary-file <path>. If you are blocked, say why in the summary and use failed.`,
				"--wait",
				"--timeout",
				String(timing.waitMs),
			]);
			continue;
		}
		runDone(root, runId, { status: "failed", summary: `${r.herdr_agent} went idle twice without closing ${r.stage}` });
		return;
	}
}

/** One transition. Returns the stage it performed or waited on. */
export function driveOnce(root: string, task: TaskRef, timing: DriveTiming = DRIVE_TIMING): Next {
	const db = openWorkDb(root);
	let launching: { role: Role; prompt: string; idea?: number; mode: string; comparison: string } | undefined;
	try {
		const t = ensureTask(db, task, "implement");
		const runs = runsOf(db, t.id);
		const pick = pickOf(db, t.id);
		const n = nextStage(task, t, runs, !!pick);
		if (t.status !== "merged")
			record(db, t.id, n.run ?? null, "next", {
				stage: n.stage,
				round: n.round,
				summary: `next: ${n.stage} (${n.reason})`,
			});
		if (n.stage === "escalated" && t.status !== "escalated") escalate(db, t, null, n.reason);
		if (n.stage === "done" || n.stage === "escalated") return n;
		if (n.stage === "pick") {
			if (t.status !== "awaiting_pick") {
				db.prepare("UPDATE tasks SET status = 'awaiting_pick', updated_at = ? WHERE id = ?").run(now(), t.id);
				record(db, t.id, null, "awaiting_pick", {
					summary: `${task.id}: comparison ready, waiting for Sebastian's pick`,
				});
				notify(
					`${task.id} ready to pick`,
					`Three ideas and the comparison are ready: evf task pick ${task.id} <n> --owner-approval "<words>"`,
				);
			}
			return n;
		}
		if (n.stage === "waiting") {
			const open = runs.find((r) => r.id === n.run)!;
			if (open.role === "evf") {
				// A drive process died inside its own stage. The stage runs again; no seat and no round are lost.
				db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
					now(),
					"evf drive ended before this stage closed; the stage runs again",
					open.id,
				);
				record(db, t.id, open.id, "restart", {
					stage: open.stage,
					summary: `${open.stage} restarts after a drive restart`,
				});
				return { ...n, reason: `the ${open.stage} stage restarts after a drive restart` };
			}
			waitOnSeat(db, root, task, t, n.run!, timing);
			return n;
		}
		if (n.role) {
			const cfg = loadConfig(root);
			const ctx: PromptContext = {
				spec: t.spec,
				ideas: Array.from({ length: IDEAS }, (_, i) => ideaWorktree(root, cfg, task, i + 1)),
				comparison: join(runtimeDir(root, task), "comparison"),
				pick,
				prBody: prBodyPath(root, task),
			};
			const prompts = t.mode === "prototype" ? PROTOTYPE_PROMPTS : STAGE_PROMPTS;
			launching = {
				role: n.role,
				prompt: prompts[n.stage]!(task, n, ctx),
				idea: n.idea,
				mode: t.mode,
				comparison: ctx.comparison,
			};
			return n;
		}
		evfStage(db, root, task, t, n.stage, timing);
		// A merge ends the task: the loop stops here and makes no further transition.
		if (n.stage === "ship" && findTask(db, task)?.status === "merged")
			return { stage: "done", round: n.round, reason: "merged" };
		return n;
	} finally {
		db.close();
		if (launching) {
			mkdirSync(launching.comparison, { recursive: true });
			launch(root, task, launching.role, { prompt: launching.prompt, idea: launching.idea, mode: launching.mode });
		}
	}
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

export function drive(
	root: string,
	task: TaskRef,
	opts: { once?: boolean; detach?: boolean },
	timing: DriveTiming = DRIVE_TIMING,
): number {
	const dir = join(evfDataDir(root), "drive");
	mkdirSync(dir, { recursive: true });
	const pidFile = join(dir, `${task.slug}.pid`);
	if (opts.detach) {
		const log = join(dir, `${task.slug}.log`),
			out = openSync(log, "a");
		const child = spawn(
			process.execPath,
			[
				"--disable-warning=ExperimentalWarning",
				join(root, "tools/evf/main.ts"),
				"drive",
				task.id,
				...(opts.once ? ["--once"] : []),
			],
			{ cwd: root, detached: true, stdio: ["ignore", out, out] },
		);
		child.unref();
		console.log(JSON.stringify({ task: task.id, pid: child.pid, log }));
		return 0;
	}
	// One drive per task: a second loop would launch the same seat twice and close the first loop's own stage.
	const holder = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
	if (holder && holder !== process.pid && alive(holder))
		fail(`evf drive already runs for ${task.id} (pid ${holder}). Stop it first, or wait for it.`);
	writeFileSync(pidFile, `${process.pid}\n`);
	try {
		for (;;) {
			const n = driveOnce(root, task, timing);
			console.log(`${now()} drive ${task.id}: ${n.stage} (${n.reason})`);
			if (n.stage === "done" || n.stage === "escalated" || n.stage === "pick" || opts.once)
				return n.stage === "escalated" ? 2 : 0;
		}
	} finally {
		if (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) === process.pid) unlinkSync(pidFile);
	}
}
