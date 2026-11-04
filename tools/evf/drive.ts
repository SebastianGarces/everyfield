import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
	ensureTask,
	findTask,
	followUpsOfTask,
	markRowMerged,
	newTaskRow,
	openWorkDb,
	record,
	seatText,
	taskById,
	type TaskRow,
} from "./db.ts";
import {
	fileFollowUps,
	followUpsOf,
	linkFollowUp,
	partialLine,
	reserveFollowUpIds,
	rowsOfRef,
	unlinkFollowUp,
	unfiledMessage,
	unfiledSlices,
	waitsFor,
} from "./followups.ts";
import { ideaWorktree, launch, LaunchAborted, LaunchLineTooLong, type LaunchTiming } from "./launch.ts";
import { OWNER_VOID, requireCurrentCode, shipOnCurrentCode } from "./merge.ts";
import { noteOwnerAnswer, noteOwnerAsk } from "./owner-queue.ts";
import { isOpus, validateOverride, type Role } from "./seats.ts";
import {
	EvfError,
	evfDataDir,
	fail,
	git,
	gitOk,
	loadConfig,
	parseTask,
	run,
	runtimeDir,
	sleep,
	worktreePath,
	type TaskRef,
} from "./lib.ts";
import { closeRunPane } from "./panes.ts";
import { bodyOnlyItems, nameWithOwner, prFor, prOpen, requiredCheckNames, requiredCi, ship } from "./ship.ts";
import { checkGithubBody, checkPrBody, describeBodyItem, unmetBodyItem, type BodyItem } from "./pr-body.ts";
import { isPrototype } from "./feedback.ts";
import { fillRunUsage } from "./usage.ts";
import { acCriteria, checkProblems, coordinatorNotes, doneCriteria } from "./spec.ts";
import { acRun, acVideoMarkers, isUiTask } from "./ac.ts";
import { hasVerifiedHead, verify } from "./verify.ts";

/**
 * The stage machine of implement mode (the GPS of the talk, in code): plan → implement → simplify → pr → verify →
 * ci → ship → merged. Seats close their stage with `evf run done`; evf runs pr, ci and ship itself. The pr stage runs
 * the author checks at the current head, so a simplifier commit never costs a round.
 * A verifier that approves the code and the experience but finds only PR body faults closes verify `body-only` (OPS-113):
 * the body stage (the implementer seat) edits only the PR body at the reviewed head, evf checks it, and ci follows with
 * no round and no new verify. A head that moved after that review goes to pr and a full verify.
 * Three rules stop a loop that runs unattended. The loop cap: a verify, ci or ship failure costs a round, and the fourth round
 * escalates to Sebastian (guard rail 2). The retry cap: any other failure costs no round, but three failures in a row
 * escalate too. The circuit breaker (OPS-115): a seat stage that a seat closes twice in a row with the same status at
 * the same progress fingerprint (worktree HEAD and spec hash) escalates at the second close, so no third seat launches.
 * `evf next` reads the store and names the next stage; `evf drive` performs it, waits on the seat through Herdr and
 * repeats. Jonah only launches `evf drive --detach` and polls `evf status --json`.
 */

/**
 * Rounds a task may lose to failed verify, ci and ship runs. It stands beside the retry cap (RETRY_CAP) and the circuit
 * breaker (`noProgress`: one seat stage closed twice with one status at one fingerprint); any of the three escalates.
 */
export const LOOP_CAP = 3;
/** Failures in a row that cost no round (plan, implement, simplify, pr, ship, aborted seats) before escalation. */
export const RETRY_CAP = 3;
export const STAGES = ["plan", "implement", "simplify", "pr", "verify", "body", "ci", "ship", "merged"] as const;
/** Prototype mode: plan (angles) → three idea seats → compare → pick (Sebastian) → merge (handoff) → done. */
export const PROTOTYPE_STAGES = ["plan", "idea", "compare", "pick", "merge"] as const;
export const IDEAS = 3;
export type Stage = (typeof STAGES)[number] | (typeof PROTOTYPE_STAGES)[number];
const SEAT_STAGES: Partial<Record<Stage, Role>> = {
	plan: "planner",
	implement: "implementer",
	simplify: "simplifier",
	verify: "verifier",
	body: "implementer",
	idea: "ideator",
	compare: "comparer",
	merge: "prototype-merger",
};
/** UI work runs in the implementer seat. The separate ui seat is opt-in: the stored spec has the line `Seat: ui`. */
const wantsUiSeat = (spec: string | null) => !!spec && /^\s*Seat:\s*ui\s*$/im.test(spec);
export const seatOf = (stage: Stage, task: TaskRef, spec: string | null): Role | undefined =>
	stage === "implement" && task.part === "ui" && wantsUiSeat(spec) ? "ui" : SEAT_STAGES[stage];

export type Next = {
	stage: Stage | "waiting" | "escalated" | "done" | "blocked" | "abandoned";
	role?: Role;
	idea?: number;
	round: number;
	reason: string;
	run?: number;
	/** Set on `waiting`: the escalation this task earned and holds back until its last open seat closes. */
	deferred?: string;
	/** Set on a `pr` that skips simplify: the passed simplify run whose head HEAD still matches. */
	skipped?: SimplifySkip;
};
/** A passed simplify run after the reopen marker and its head, when the worktree has no change since that head. */
export type SimplifySkip = { run: number; head: string };
type RunRow = {
	id: number;
	stage: string;
	role: string;
	status: string;
	round: number;
	summary: string | null;
	/** The progress fingerprint a seat recorded when it closed a seat stage itself (OPS-115); absent otherwise. */
	progress_head?: string | null;
	progress_spec?: string | null;
};

const now = () => new Date().toISOString();
const headline = (text: string, max = 160) => text.split("\n")[0]?.slice(0, max) ?? "";
const runsOf = (db: DatabaseSync, taskId: number): RunRow[] =>
	db
		.prepare(
			"SELECT id, stage, status, role, round, summary, progress_head, progress_spec FROM runs WHERE task_id = ? ORDER BY started_at, id",
		)
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
	seat_model: null,
	seat_effort: null,
});

type OwnerEvent = { id: number; type: string; payload: Record<string, unknown> };
/** The newest event of the task among `types`, with its payload parsed. */
const latestEvent = (db: DatabaseSync, taskId: number, types: string[]): OwnerEvent | null => {
	const row = db
		.prepare(
			`SELECT id, type, payload FROM events WHERE task_id = ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY id DESC LIMIT 1`,
		)
		.get(taskId, ...types) as { id: number; type: string; payload: string } | undefined;
	return row ? { id: row.id, type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> } : null;
};

/**
 * The run id the latest `evf task reopen` or `evf task compare-passed` marked: only runs after it count as trailing
 * failures. 0 when the task never had either.
 */
const reopenMarker = (db: DatabaseSync, taskId: number): number =>
	Number(latestEvent(db, taskId, ["reopen", "compare_passed"])?.payload.after_run) || 0;

/** The coordinator's latest `evf task reopen --reason`, which the next seats must read. Null when never reopened. */
const reopenReasonOf = (db: DatabaseSync, taskId: number): string | null => {
	const reason = latestEvent(db, taskId, ["reopen"])?.payload.reason;
	return typeof reason === "string" && reason.trim() ? reason.trim() : null;
};

/** The owner's choice to compare only the passed ideas: the idea that is missing and why, until a later reopen. */
export type CompareChoice = { missing: number[]; reason: string };
const compareChoiceOf = (db: DatabaseSync, taskId: number): CompareChoice | null => {
	const e = latestEvent(db, taskId, ["reopen", "compare_passed"]);
	if (e?.type !== "compare_passed") return null;
	return { missing: (e.payload.missing as number[]) ?? [], reason: String(e.payload.reason ?? "") };
};

/** The escalation a task earned while a seat still worked, if no escalation or reopen came after it. */
const deferredEscalation = (db: DatabaseSync, taskId: number): string | null => {
	const e = latestEvent(db, taskId, ["escalation_deferred", "escalation", "reopen", "compare_passed"]);
	return e?.type === "escalation_deferred" ? String(e.payload.cause ?? "") || null : null;
};

/** What `nextStage` needs besides the rows. Each field is read from the events of the store by the caller. */
export type NextExtras = {
	reopenReason?: string | null;
	deferred?: string | null;
	choice?: CompareChoice | null;
	/** Later slices of the stored spec that have no follow-up row (OPS-86). */
	unfiled?: string[];
	/** Set on a queued follow-up: the label of the row it waits for. */
	waitsFor?: string | null;
	/** Set after a passed implement when the branch has no change since the last passed simplify (OPS-115). */
	simplifySkip?: SimplifySkip | null;
	/** Set when the task's latest verify approval is `body_only` (OPS-113): its head and whether HEAD moved since. */
	bodyOnly?: BodyOnly | null;
};
/** The head a `body_only` verify approved, and whether the worktree HEAD is another commit now. */
type BodyOnly = { head: string; moved: boolean };

/**
 * Failed or aborted runs since the last passed one, counting only runs after the latest reopen marker.
 * An evf run aborted by a restart is not a failure.
 */
const trailingFailures = (runs: RunRow[], reopenAfter: number): number => {
	let n = 0;
	for (let i = runs.length - 1; i >= 0; i--) {
		const r = runs[i]!;
		if (r.id <= reopenAfter) break;
		if (r.status === "passed") break;
		if (r.status === "started" || (r.role === "evf" && r.status === "aborted")) continue;
		n++;
	}
	return n;
};

/** Failed pr runs since the last passed implement run: simplify passes between them, so they reset no count. */
const prFailuresSinceImplement = (runs: RunRow[], reopenAfter: number): number => {
	let n = 0;
	for (let i = runs.length - 1; i >= 0; i--) {
		const r = runs[i]!;
		if (r.id <= reopenAfter || (r.stage === "implement" && r.status === "passed")) break;
		if (r.stage === "pr" && r.status === "failed") n++;
	}
	return n;
};
/** The escalation rule: the larger of the trailing failures and the failed pr runs since the last passed implement. */
const failuresInARow = (runs: RunRow[], marker: number): number =>
	Math.max(trailingFailures(runs, marker), prFailuresSinceImplement(runs, marker));
const AUTHOR_CHECKS_FAILED = "author checks failed";

/** The implement-mode stages a seat runs, whose seat-closed runs carry a progress fingerprint (OPS-115). */
const FINGERPRINTED = new Set(["plan", "implement", "simplify", "verify"]);

/**
 * The circuit breaker (OPS-115): why the task must stop because a seat stage made no progress, or null. Run B is the
 * newest run after the marker that a seat closed itself with a fingerprint; run A is the run of B's stage before it
 * with a fingerprint. A and B closed with the same status at the same HEAD and spec hash means the next seat would
 * start from exactly where B started, so the task escalates with both summaries.
 */
export function noProgress(ref: string, runs: RunRow[], marker: number): string | null {
	const counted = runs.filter((r) => r.id > marker && r.progress_head && r.progress_spec);
	const b = counted.at(-1);
	const a = b && counted.filter((r) => r !== b && r.stage === b.stage).at(-1);
	if (!a || !b || a.status !== b.status || a.progress_head !== b.progress_head || a.progress_spec !== b.progress_spec)
		return null;
	return `no progress: ${b.stage} closed ${b.status} twice at ${b.progress_head!.slice(0, 10)} with an unchanged spec (runs ${a.id} and ${b.id}). Run ${a.id}: "${headline(a.summary ?? "")}"; run ${b.id}: "${headline(b.summary ?? "")}". Restart after a fix with evf task reopen ${ref} --reason "<words>".`;
}

const ideaStage = /^idea\d$/;
/** The first line of a summary with hex ids, digits and runs of space normalized, so two runs of one blocker compare equal. */
export const normalizedHeadline = (summary: string | null): string =>
	headline(summary ?? "", 300)
		.toLowerCase()
		.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, "<hex>")
		.replace(/\d+/g, "<n>")
		.replace(/\s+/g, " ")
		.trim();

/** The trailing failed or aborted runs of one idea after the marker, newest first. A passed run ends the list. */
const ideaFailures = (runs: RunRow[], idea: number, marker: number): RunRow[] => {
	const out: RunRow[] = [];
	const mine = runs.filter((r) => r.stage === `idea${idea}` && r.id > marker);
	for (let i = mine.length - 1; i >= 0; i--) {
		const r = mine[i]!;
		if (r.status === "passed") break;
		if (r.status !== "started") out.push(r);
	}
	return out;
};

/**
 * Prototype mode: why the task must stop retrying, or null. An idea that failed twice in a row with the same headline,
 * an idea out of retries, and the task-wide failure count each stop it. When every other idea passed, the reason names
 * the owner's choice to compare those.
 */
function prototypeStuck(ref: string, runs: RunRow[], marker: number): string | null {
	const lastOf = (idea: number) => runs.filter((r) => r.stage === `idea${idea}`).at(-1);
	let because: { idea: number; reason: string } | null = null;
	for (let i = 1; i <= IDEAS && !because; i++) {
		const failed = ideaFailures(runs, i, marker);
		if (
			failed.length >= 2 &&
			failed[0]!.status === "failed" &&
			failed[1]!.status === "failed" &&
			normalizedHeadline(failed[0]!.summary) &&
			normalizedHeadline(failed[0]!.summary) === normalizedHeadline(failed[1]!.summary)
		)
			because = {
				idea: i,
				reason: `idea ${i} failed twice in a row with the same error: ${headline(failed[0]!.summary ?? "")}`,
			};
		else if (failed.length >= RETRY_CAP)
			because = {
				idea: i,
				reason: `idea ${i} failed ${failed.length} times in a row (retry cap ${RETRY_CAP}); last: ${headline(failed[0]!.summary ?? failed[0]!.status)}`,
			};
	}
	if (because) {
		const others = Array.from({ length: IDEAS }, (_, i) => i + 1).filter((i) => i !== because!.idea);
		if (others.every((i) => lastOf(i)?.status === "passed"))
			return `${because.reason}. Ideas ${others.join(" and ")} passed: Sebastian can have them compared without idea ${because.idea} with evf task compare-passed ${ref} --owner-approval "<his words>".`;
		return because.reason;
	}
	const failures = trailingFailures(runs, marker);
	return failures >= RETRY_CAP ? `${failures} failures in a row without a passed stage` : null;
}

/** The run a held-back escalation waits for: any seat run still open (evf's own stages are not seats). */
const openSeat = (runs: RunRow[]) => runs.find((r) => r.status === "started" && r.role !== "evf");

/** Prototype mode. Idea seats launch one per transition and run side by side; the pick is Sebastian's, not evf's. */
function nextPrototype(
	task: TaskRef,
	t: TaskRow,
	runs: RunRow[],
	picked: boolean,
	reopenAfter: number,
	extras: NextExtras,
): Next {
	const round = t.round;
	if (t.status === "done") return { stage: "done", round, reason: "handed off" };
	if (t.status === "escalated") return { stage: "escalated", round, reason: "escalated" };
	// An owner's compare-passed choice leaves the missing idea out; no failure before it counts any more.
	const missing = extras.choice?.missing ?? [];
	const stuck = prototypeStuck(task.id, runs, reopenAfter) ?? extras.deferred ?? null;
	if (stuck) {
		// No new seat starts once the task earned an escalation, and none escalates while a seat still works.
		const open = openSeat(runs);
		if (open)
			return {
				stage: "waiting",
				round,
				run: open.id,
				reason: `escalation held back until the ${open.stage} seat closes: ${stuck}`,
				deferred: stuck,
			};
		return { stage: "escalated", round, reason: stuck };
	}
	const go = (stage: Stage, reason: string, idea?: number): Next => ({
		stage,
		role: seatOf(stage, task, t.spec),
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
		if (missing.includes(i)) continue;
		const last = lastOf(`idea${i}`);
		if (!last || last.status === "failed" || last.status === "aborted")
			return go("idea", `idea ${i} ${last ? last.status : "not started"}`, i);
	}
	const openIdea = runs.find((r) => ideaStage.test(r.stage) && r.status === "started");
	if (openIdea) return { stage: "waiting", round, run: openIdea.id, reason: `${openIdea.stage} is still open` };
	const compare = lastOf("compare");
	if (compare?.status !== "passed") {
		if (compare?.status === "started")
			return { stage: "waiting", round, run: compare.id, reason: "the compare seat is still open" };
		return go(
			"compare",
			compare
				? `compare ${compare.status}`
				: missing.length
					? `ideas built; idea ${missing.join(", ")} left out`
					: "all ideas built",
		);
	}
	if (!picked) return { stage: "pick", round, reason: "waiting for Sebastian's pick: evf task pick" };
	const merge = lastOf("merge");
	if (merge?.status === "started")
		return { stage: "waiting", round, run: merge.id, reason: "the merge seat is still open" };
	if (merge?.status === "passed") return { stage: "done", round, reason: "handed off" };
	return go("merge", merge ? `merge ${merge.status}` : "idea picked");
}

/**
 * Pure: the next stage from the task's closed runs. Rounds are counted when a verify, ci or ship run closes failed. After
 * a reopen, the stage's reason names the reopen until a seat has run since, so the old failure never reads as current.
 */
export function nextStage(
	task: TaskRef,
	t: TaskRow,
	runs: RunRow[],
	picked = false,
	reopenAfter = 0,
	extras: NextExtras = {},
): Next {
	// A queued follow-up never starts a seat. A task whose spec lists slices without follow-ups never starts implement.
	if (t.status === "queued")
		return {
			stage: "blocked",
			round: t.round,
			reason: `${task.id} is queued: it waits for ${extras.waitsFor ?? "its parent"} to merge`,
		};
	const n = nextStageOf(task, t, runs, picked, reopenAfter, extras);
	return n.stage === "implement" && extras.unfiled?.length
		? { stage: "blocked", round: n.round, reason: unfiledMessage(task.id, extras.unfiled) }
		: n;
}

function nextStageOf(
	task: TaskRef,
	t: TaskRow,
	runs: RunRow[],
	picked: boolean,
	reopenAfter: number,
	extras: NextExtras,
): Next {
	const round = t.round;
	if (t.mode === "prototype") return nextPrototype(task, t, runs, picked, reopenAfter, extras);
	if (t.status === "merged" || t.status === "done") return { stage: "done", round, reason: t.status };
	if (t.status === "escalated")
		return {
			stage: "escalated",
			round,
			reason: noProgress(task.id, runs, reopenAfter) ?? `loop cap of ${LOOP_CAP} rounds hit`,
		};
	const open = runs.find((r) => r.status === "started");
	if (open)
		return {
			stage: "waiting",
			round,
			run: open.id,
			reason: `the ${open.stage} seat is still open`,
			...(extras.deferred ? { deferred: extras.deferred } : {}),
		};
	// A cap that was reached while another seat still worked: that seat has closed, so the task stops now.
	if (extras.deferred) return { stage: "escalated", round, reason: extras.deferred };
	const failures = failuresInARow(runs, reopenAfter);
	if (failures >= RETRY_CAP)
		return { stage: "escalated", round, reason: `${failures} failures in a row without a passed stage` };
	const stuck = noProgress(task.id, runs, reopenAfter);
	if (stuck) return { stage: "escalated", round, reason: stuck };
	const reopened = !!extras.reopenReason && runs.every((r) => r.id <= reopenAfter);
	const named = (reason: string) => (reopened ? `reopened by the coordinator: ${extras.reopenReason}` : reason);
	const go = (stage: Stage, reason: string): Next => ({
		stage,
		role: seatOf(stage, task, t.spec),
		round,
		reason: named(reason),
	});
	// An evf run aborted by a restart never happened: the stage before it decides.
	const last = runs.filter((r) => !(r.role === "evf" && r.status === "aborted")).at(-1);
	if (!last) return t.spec ? go("implement", "spec stored, no runs yet") : go("plan", "no spec yet");
	const passed = last.status === "passed";
	const again = (stage: Stage) => go(stage, `${last.stage} ${last.status}: ${last.summary ?? ""}`.trim());
	// After a body_only verify the body stage runs at the reviewed head until its check passes; ci follows with no
	// new verify. A commit after the review voids that path: pr and a full verify run (OPS-113).
	const bodyOnly = extras.bodyOnly;
	if (bodyOnly && (last.stage === "verify" || last.stage === "body")) {
		const at = bodyOnly.head.slice(0, 10);
		if (bodyOnly.moved) return go("pr", `the head moved after the body_only review at ${at}: a full verify runs`);
		if (last.stage === "verify")
			return go("body", `the verifier approved the code at ${at} and asked only for body fixes`);
		if (passed) return go("ci", `body check passed at ${at}`);
		return again("body");
	}
	// A seat whose pane went away (run aborted) launches the same stage again, with the same round.
	if (last.status === "aborted" && (Object.keys(SEAT_STAGES) as string[]).includes(last.stage))
		return again(last.stage as Stage);
	switch (last.stage as Stage) {
		case "plan":
			return passed && t.spec
				? go("implement", "plan passed")
				: go("plan", `plan ${last.status}${t.spec ? "" : ", no spec stored"}`);
		case "implement": {
			if (!passed) return again("implement");
			// No commit since the last passed simplify: the simplifier would read the same diff, so pr runs next.
			const skip = extras.simplifySkip;
			return skip
				? {
						...go("pr", `simplify skipped: no change since simplify run ${skip.run} at ${skip.head.slice(0, 10)}`),
						skipped: skip,
					}
				: go("simplify", "implement passed");
		}
		case "simplify":
			return passed ? go("pr", "simplify passed") : again("implement");
		case "pr": {
			if (passed) return go("verify", "PR open");
			// The author checks failed at a head the simplifier committed: simplify fixes it, no round, no implement run.
			const before = runs.filter((r) => r !== last && !(r.role === "evf" && r.status === "aborted")).at(-1);
			return before?.stage === "simplify" &&
				before.status === "passed" &&
				last.summary?.startsWith(AUTHOR_CHECKS_FAILED)
				? again("simplify")
				: again("implement");
		}
		case "verify":
			return passed ? go("ci", "verifier approved") : go("implement", `verifier requested changes (round ${round})`);
		case "body":
			// A body run without a body_only review in force: only a full verify can approve the head.
			return go("pr", "body stage without a body_only review");
		case "ci":
			return passed ? go("ship", "CI green") : go("implement", `CI failed (round ${round})`);
		case "ship":
			return passed ? { stage: "done", round, reason: "shipped" } : again("implement");
		default:
			return go("implement", `unknown stage ${last.stage}`);
	}
}

/**
 * The simplify skip (OPS-115), read only after a passed implement: the last passed simplify after the marker, when
 * `git diff --quiet <its head> HEAD` finds no change in the worktree. The PR body and the proofs live outside the
 * repository, so a round that changed only those has no diff. Null when simplify must run.
 */
function simplifySkipOf(runs: RunRow[], marker: number, wt: string | null): SimplifySkip | null {
	const simplify = runs
		.filter((r) => r.id > marker && r.stage === "simplify" && r.status === "passed" && r.progress_head)
		.at(-1);
	if (!simplify || !wt || !existsSync(wt)) return null;
	return gitOk(wt, "diff", "--quiet", simplify.progress_head!, "HEAD")
		? { run: simplify.id, head: simplify.progress_head! }
		: null;
}

/** The owner events a task's next stage depends on, read from the store, and the simplify skip read from its worktree. */
const extrasOf = (db: DatabaseSync, taskId: number): NextExtras => {
	const t = db.prepare("SELECT spec, worktree FROM tasks WHERE id = ?").get(taskId) as
		{ spec: string | null; worktree: string | null } | undefined;
	return {
		reopenReason: reopenReasonOf(db, taskId),
		deferred: deferredEscalation(db, taskId),
		choice: compareChoiceOf(db, taskId),
		unfiled: unfiledSlices(db, taskId, t?.spec ?? null),
		waitsFor: waitsFor(db, taskId),
		simplifySkip: simplifySkipOf(runsOf(db, taskId), reopenMarker(db, taskId), t?.worktree ?? null),
		bodyOnly: bodyOnlyOf(db, taskId, t?.worktree ?? null),
	};
};

/** The head of the task's latest verify approval when its decision is `body_only`, else null. */
const bodyOnlyHead = (db: DatabaseSync, taskId: number): string | null => {
	const a = db
		.prepare("SELECT head_sha, decision FROM approvals WHERE task_id = ? AND gate = 'verify' ORDER BY id DESC LIMIT 1")
		.get(taskId) as { head_sha: string | null; decision: string } | undefined;
	return a?.decision === "body_only" && a.head_sha ? a.head_sha : null;
};
function bodyOnlyOf(db: DatabaseSync, taskId: number, wt: string | null): BodyOnly | null {
	const head = bodyOnlyHead(db, taskId);
	if (!head) return null;
	const current = wt && existsSync(wt) ? git(wt, "rev-parse", "HEAD") : null;
	return { head, moved: current !== head };
}

export function next(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task) ?? unknownTask(task);
		console.log(
			JSON.stringify(
				nextStage(
					task,
					t,
					t.id ? runsOf(db, t.id) : [],
					!!(t.id && pickOf(db, t.id)),
					t.id ? reopenMarker(db, t.id) : 0,
					t.id ? extrasOf(db, t.id) : {},
				),
			),
		);
		return 0;
	} finally {
		db.close();
	}
}

function notify(title: string, body: string): void {
	run("herdr", ["notification", "show", title, "--body", body, "--sound", "request"]);
}

/** The task stops here until Sebastian decides: status escalated, events, a Herdr notification. */
function escalate(
	db: DatabaseSync,
	root: string,
	t: { id: number; ref: string },
	runId: number | null,
	cause: string,
): void {
	db.prepare("UPDATE tasks SET status = 'escalated', updated_at = ? WHERE id = ?").run(now(), t.id);
	record(db, t.id, runId, "escalation", { summary: `${t.ref} needs Sebastian: ${cause}` });
	noteOwnerAsk(db, root, t.id, "escalation");
	notify(`${t.ref} escalated`, cause);
}

/** Whether `sha` is `head` or one of its ancestors. A sha the worktree does not know is not. */
const reachable = (wt: string, sha: string, head: string) =>
	sha === head || gitOk(wt, "merge-base", "--is-ancestor", sha, head);

/**
 * The criteria whose latest proof counts as proven at `head`. A proof counts when its head is `head` or an ancestor of
 * it; the latest such row for a criterion must be met or n/a. Proof carries forward across a later commit.
 */
function provenCriteria(db: DatabaseSync, taskId: number, wt: string, head: string): Set<string> {
	const rows = db
		.prepare("SELECT criterion, status, head_sha FROM proofs WHERE task_id = ? ORDER BY id")
		.all(taskId) as Array<{
		criterion: string;
		status: string;
		head_sha: string;
	}>;
	const counts = new Map<string, boolean>();
	const latest = new Map<string, string>();
	for (const p of rows) {
		if (!counts.has(p.head_sha)) counts.set(p.head_sha, reachable(wt, p.head_sha, head));
		if (counts.get(p.head_sha)) latest.set(p.criterion, p.status);
	}
	return new Set([...latest].filter(([, status]) => status === "met" || status === "n/a").map(([c]) => c));
}

/** Unmet or not met, said on a line that names a Done criterion: "Criterion 9 is unmet", "Done 3 not met". */
const NAMES_CRITERION = /\b(?:criteri(?:on|a)|done(?: criteri(?:on|a))?)\s*#?\d+/i;
const SAYS_UNMET = /\b(?:unmet|not\s+met)\b/i;
export const unmetCriterionLine = (text: string): string | null =>
	text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => NAMES_CRITERION.test(line) && SAYS_UNMET.test(line)) ?? null;

/** Other seat runs of the task that are open and whose Herdr agent exists: a seat that still works. */
function seatsStillWorking(db: DatabaseSync, taskId: number, exceptRun: number): string[] {
	const open = db
		.prepare(
			"SELECT herdr_agent FROM runs WHERE task_id = ? AND status = 'started' AND id <> ? AND role <> 'evf' AND herdr_agent IS NOT NULL",
		)
		.all(taskId, exceptRun) as Array<{ herdr_agent: string }>;
	return open.map((o) => o.herdr_agent).filter((agent) => agentExists(agent));
}

/**
 * The body check (OPS-113), run by evf when the body seat closes passed: push the PR body at the same head with
 * `evf pr open --body-file`, read the GitHub body with the `evf pr body` code and check every item of the body_only
 * review at the reviewed head. Returns why it fails, or null.
 */
function bodyCheck(root: string, task: TaskRef, wt: string | null, reviewed: string | null): string | null {
	if (!reviewed) return "the task has no body_only verify approval";
	if (!wt || !existsSync(wt)) return "the task has no worktree";
	const head = git(wt, "rev-parse", "HEAD");
	if (head !== reviewed)
		return `the head moved from the body_only review at ${reviewed.slice(0, 10)} to ${head.slice(0, 10)}; a full verify runs`;
	try {
		prOpen(root, task, prBodyPath(root, task));
		const pr = prFor(wt, task);
		if (!pr) return `no PR for ${task.branch}`;
		const github = checkGithubBody(wt, root, pr.number);
		if (github.headRefOid !== reviewed)
			return `the PR head is ${github.headRefOid.slice(0, 10)}, not the reviewed head ${reviewed.slice(0, 10)}`;
		const items = bodyOnlyItems(root, pr.number, reviewed);
		if (typeof items === "string") return items;
		const unmet = unmetBodyItem(github.body, items);
		return unmet ? `the PR body does not meet a body item: ${describeBodyItem(unmet)}` : null;
	} catch (e) {
		if (e instanceof EvfError) return e.message;
		throw e;
	}
}

/** Why the implementer's PR body cannot go to verify (OPS-113): it is missing or fails the `evf pr body` check. */
function implementBodyFault(root: string, task: TaskRef, wt: string | null): string | null {
	const file = prBodyPath(root, task);
	if (!existsSync(file)) return `no PR body at ${file}`;
	try {
		checkPrBody(
			wt && existsSync(wt) ? wt : root,
			readFileSync(file, "utf8"),
			isPrototype(root, task) ? "prototype" : "ordinary",
			followUpsOfTask(root, task),
			acVideoMarkers(root, task),
		);
		return null;
	} catch (e) {
		if (e instanceof EvfError) return `the PR body at ${file} fails the evf pr body check: ${e.message}`;
		throw e;
	}
}

/**
 * Close a stage. A failed verify or ci costs a round; the fourth round escalates and nothing launches again. A failed
 * verify at a head an earlier verify of the task already closed at costs no round (OPS-113). A verify run closes
 * passed or body-only only when every Done criterion has a met or n/a proof at the worktree head or an ancestor of it.
 * An implement run closes passed only with a PR body that passes the `evf pr body` check. A body run that closes
 * passed is checked by evf (bodyCheck) and closes failed, with the reason, when the check fails.
 * A seat that closes its own seat stage records the progress fingerprint, and the circuit breaker reads it. The drive
 * passes `closedBy: "evf"` when it closes a run for the seat (no agent, idle twice, wait timeout).
 */
export function runDone(
	root: string,
	runId: number,
	opts: { status: "passed" | "failed" | "body-only"; summaryFile?: string; summary?: string; closedBy?: "evf" },
): number {
	const db = openWorkDb(root);
	try {
		const r = db
			.prepare(
				"SELECT r.id, r.task_id, r.stage, r.role, r.status, t.ref, t.mode, t.round, t.worktree, t.spec FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
			)
			.get(runId) as
			| {
					id: number;
					task_id: number;
					stage: string;
					role: string;
					status: string;
					ref: string;
					mode: string;
					round: number;
					worktree: string | null;
					spec: string | null;
			  }
			| undefined;
		if (!r) fail(`No run ${runId} in the work store.`);
		if (r.status !== "started") fail(`Run ${runId} already closed as ${r.status}.`);
		let summary = opts.summary ?? (opts.summaryFile ? readFileSync(opts.summaryFile, "utf8").trim() : "");
		if (!summary) fail("Give --summary-file <file> (or --summary) with what happened in this stage.");
		if (opts.status === "body-only" && r.stage !== "verify")
			fail(`--status body-only closes a verify run only; run ${runId} is a ${r.stage} run.`);
		const head = r.worktree && existsSync(r.worktree) ? git(r.worktree, "rev-parse", "HEAD") : null;
		// The answer key (OPS-112): evf runs the marked tests at this head itself; an earlier run does not count.
		if ((r.stage === "implement" || r.stage === "verify") && opts.status !== "failed" && acCriteria(r.spec).length) {
			const unmet = acRun(root, parseTask(r.ref), { runId }).filter((row) => row.status !== "met");
			if (unmet.length)
				fail(
					`${r.stage} cannot close ${opts.status}: evf ac run found AC: criteria not met at ${head?.slice(0, 10)}:\n${unmet.map((row) => `  criterion ${row.criterion} (${row.marker}): ${row.notes}`).join("\n")}\nWrite or fix the test that carries each marker, commit, and close again; or close this run as failed.`,
				);
		}
		if (r.stage === "verify" && opts.status !== "failed") {
			if (!head) fail(`${r.ref} has no worktree to read the head from; a verify cannot pass without proofs at a head.`);
			const proven = provenCriteria(db, r.task_id, r.worktree!, head);
			const missing = doneCriteria(r.spec).filter((c) => !proven.has(c));
			if (missing.length)
				fail(
					`Done criteria ${missing.join(", ")} have no met or n/a proof at ${head.slice(0, 10)} or an earlier head it contains. Add them with bin/evf proof add ${r.ref} --criterion <n> --status met|n/a --evidence <url>, or close this verify as failed.`,
				);
		}
		if (r.stage === "implement" && opts.status === "passed") {
			const fault = implementBodyFault(root, parseTask(r.ref), r.worktree);
			if (fault)
				fail(
					`Implement cannot close passed: ${fault}. Write the PR body there following .agents/skills/everyfield-pr/template.md and check it with bin/evf pr body --body-file <file> --task ${r.ref}.`,
				);
		}
		// The seat's passed close of the body stage is evf's cue to check the body; a failed check fails the run.
		let status: "passed" | "failed" = opts.status === "failed" ? "failed" : "passed";
		if (r.stage === "body" && status === "passed") {
			const fault = bodyCheck(root, parseTask(r.ref), r.worktree, bodyOnlyHead(db, r.task_id));
			if (fault) {
				status = "failed";
				summary = `body check failed: ${fault}\nSeat summary: ${summary}`;
				console.log(`body check failed: ${fault}`);
			} else console.log("body check passed: evf pushed the body, the body standard passes and every item is met.");
		}
		const first = headline(summary);
		if (r.stage === "plan" && opts.status === "passed") {
			const unfiled = unfiledSlices(db, r.task_id, r.spec);
			if (unfiled.length) fail(`${unfiledMessage(r.ref, unfiled)} A plan run cannot close passed until they exist.`);
		}
		if (ideaStage.test(r.stage) && opts.status === "passed") {
			const idea = Number(r.stage.slice(4)),
				ideaFile = join(ideaWorktree(root, loadConfig(root), parseTask(r.ref), idea), "IDEA.md");
			const unmet =
				unmetCriterionLine(summary) ??
				(existsSync(ideaFile) ? unmetCriterionLine(readFileSync(ideaFile, "utf8")) : null);
			if (unmet)
				fail(
					`Idea ${idea} cannot close passed: "${unmet}" names a Done criterion that is not met. Finish that criterion, or close this run as failed.`,
				);
		}
		const fingerprinted = opts.closedBy !== "evf" && r.mode === "implement" && FINGERPRINTED.has(r.stage) && !!head;
		db.prepare(
			"UPDATE runs SET status = ?, ended_at = ?, summary = ?, progress_head = ?, progress_spec = ? WHERE id = ?",
		).run(
			status,
			now(),
			summary,
			fingerprinted ? head : null,
			fingerprinted
				? createHash("sha256")
						.update(r.spec ?? "")
						.digest("hex")
				: null,
			runId,
		);
		fillRunUsage(db, runId);
		record(db, r.task_id, runId, "stage_end", {
			stage: r.stage,
			status: opts.status === "body-only" ? "body_only" : status,
			summary: headline(summary, 200),
		});
		// A second review of a head an earlier verify of this task already closed at costs no round (OPS-113).
		const reviewedBefore =
			r.stage === "verify" &&
			!!head &&
			!!db
				.prepare("SELECT 1 FROM approvals WHERE task_id = ? AND gate = 'verify' AND head_sha = ? LIMIT 1")
				.get(r.task_id, head);
		if (r.stage === "verify")
			db.prepare(
				"INSERT INTO approvals (task_id, gate, approver, head_sha, decision, quote, created_at) VALUES (?, 'verify', ?, ?, ?, ?, ?)",
			).run(
				r.task_id,
				`${r.role}@${r.ref}`,
				head,
				opts.status === "body-only" ? "body_only" : status === "passed" ? "approved" : "changes_requested",
				summary.slice(0, 2000),
				now(),
			);
		let escalated = "";
		// A failed ship costs a round like a failed ci (OPS-123): the loop cap stops a ship that keeps failing.
		if ((r.stage === "ci" || r.stage === "ship" || (r.stage === "verify" && !reviewedBefore)) && status === "failed") {
			const round = r.round + 1;
			record(db, r.task_id, runId, "round", {
				round,
				cause: r.stage,
				summary: `round ${round} after ${r.stage} failed: ${first}`,
			});
			db.prepare("UPDATE tasks SET round = ?, updated_at = ? WHERE id = ?").run(round, now(), r.task_id);
			if (round > LOOP_CAP) {
				record(db, r.task_id, runId, "loop_cap_hit", {
					round,
					cap: LOOP_CAP,
					summary: `${r.ref} hit the loop cap after ${r.stage} failed: ${first}`,
				});
				escalated = `loop cap ${LOOP_CAP} hit after ${r.stage} failed. ${first}`;
			}
		} else {
			db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), r.task_id);
			if (reviewedBefore && status === "failed")
				record(db, r.task_id, runId, "review_repeat", {
					head,
					summary: `${r.ref}: verify failed again at ${head!.slice(0, 10)}, a head already reviewed; no round`,
				});
			if (status === "failed") {
				const runs = runsOf(db, r.task_id),
					marker = reopenMarker(db, r.task_id);
				if (r.mode === "prototype") escalated = prototypeStuck(r.ref, runs, marker) ?? "";
				else {
					const failures = failuresInARow(runs, marker);
					if (failures >= RETRY_CAP) escalated = `${failures} failures in a row, last in ${r.stage}. ${first}`;
				}
			}
		}
		if (!escalated && fingerprinted)
			escalated = noProgress(r.ref, runsOf(db, r.task_id), reopenMarker(db, r.task_id)) ?? "";
		// A task does not stop while another seat of it works. The escalation waits, recorded, for the last open seat.
		const pending = escalated ? "" : (deferredEscalation(db, r.task_id) ?? "");
		if (escalated || pending) {
			const working = seatsStillWorking(db, r.task_id, runId);
			if (working.length && escalated) {
				record(db, r.task_id, runId, "escalation_deferred", {
					cause: escalated,
					summary: `${r.ref} escalation held back while ${working.join(", ")} still works: ${escalated.slice(0, 160)}`,
				});
				escalated = "";
			} else if (!working.length) escalated ||= pending;
		}
		if (escalated) escalate(db, root, { id: r.task_id, ref: r.ref }, runId, escalated);
		console.log(
			`run ${runId} (${r.stage}) closed ${opts.status === "body-only" ? "body-only" : status}${escalated ? `; ${r.ref} escalated` : ""}.`,
		);
		// Last, after the store update committed: a seat that runs this from its own pane has recorded its result.
		const closed = closeRunPane(db, runId);
		if (closed) console.log(closed);
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
		const known = findTask(db, task);
		if (known?.status === "merged")
			fail(`${known.ref} is merged. Start a new task with evf task new ${known.ref} --ask-file <file>.`);
		// A UI spec needs one Check: line per Done criterion; any other spec that has one follows the same rule. A
		// prototype plan spec is exempt: its criteria describe what every proof of concept shows, not a test.
		const problems = known?.mode === "prototype" ? [] : checkProblems(spec, task.id, isUiTask(root, task));
		if (problems.length)
			fail(
				`The spec for ${task.id} fails the Check: rule:\n${problems.map((p) => `  ${p}`).join("\n")}\nUnder each Done criterion write one line "Check: AC:${task.id}-<n>" (a test whose name carries that marker proves it) or "Check: owner — <reason>" (a person judges it).`,
			);
		// OPS ids are reserved first: one failed reservation stores neither the spec nor a slice row.
		const ids = reserveFollowUpIds(root, db, { id: known?.id ?? 0, ref: task.id }, spec);
		const t = known ?? ensureTask(db, task, "implement");
		const parent = db.prepare("SELECT id, ref, ask, goal_id FROM tasks WHERE id = ?").get(t.id) as {
			id: number;
			ref: string;
			ask: string;
			goal_id: number | null;
		};
		db.exec("BEGIN IMMEDIATE");
		let filed: string[];
		try {
			db.prepare(
				"UPDATE tasks SET spec = ?, spec_hash = ?, status = CASE WHEN status = 'new' THEN 'specced' ELSE status END, updated_at = ? WHERE id = ?",
			).run(spec, hash, now(), t.id);
			record(db, t.id, null, "spec_set", {
				hash,
				summary: `${t.ref} spec stored (${spec.split("\n").length} lines)`,
			});
			filed = fileFollowUps(db, parent, spec, ids);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		console.log(`spec: ${t.ref} ${hash.slice(0, 12)}`);
		for (const line of filed) console.log(`follow-up: ${line}`);
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
		const choice = compareChoiceOf(db, t.id);
		if (choice?.missing.includes(idea))
			fail(
				`Idea ${idea} is the missing idea (${choice.reason.slice(0, 160)}); it was left out of the comparison. Pick one of the compared ideas.`,
			);
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
		noteOwnerAnswer(db, t.id);
		console.log(`pick: ${t.ref} idea ${idea}${head ? ` at ${head.slice(0, 10)}` : ""}.`);
		return 0;
	} finally {
		db.close();
	}
}

/** The coordinator's answer to an escalation: leave `escalated` and mark the run id after which failures count again. */
export function taskReopen(root: string, task: TaskRef, reason: string): number {
	if (process.env.EVF_RUN)
		fail("A seat cannot reopen its own escalation: the coordinator runs evf task reopen from a human shell.");
	if (reason.trim().split(/\s+/).filter(Boolean).length < 2)
		fail('Give the cause in two words or more: --reason "<words>".');
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task);
		if (!t) fail(`${task.id} has no task row, so there is nothing to reopen.`);
		if (t.status !== "escalated") fail(`${t.ref} is ${t.status}, not escalated: only an escalated task reopens.`);
		const status = t.pr_number ? "pr_open" : "active";
		const { m: afterRun } = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM runs WHERE task_id = ?").get(t.id) as {
			m: number;
		};
		db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), t.id);
		record(db, t.id, null, "reopen", {
			reason: reason.trim(),
			from: "escalated",
			to: status,
			round: t.round,
			after_run: afterRun,
			summary: `${t.ref} reopened to ${status}: ${reason.trim()}`,
		});
		noteOwnerAnswer(db, t.id);
		console.log(`reopen: ${t.ref} is ${status}.`);
		return 0;
	} finally {
		db.close();
	}
}

/**
 * Sebastian's choice to compare only the ideas that passed, after one idea is stuck. The task leaves `escalated`; the
 * drive then runs compare with the passed ideas. The missing idea cannot be picked. Failures before it count no more.
 */
export function taskComparePassed(root: string, task: TaskRef, ownerApproval: string): number {
	if (process.env.EVF_RUN)
		fail("The choice is Sebastian's, recorded by Jonah or a human shell: a seat cannot run evf task compare-passed.");
	if (ownerApproval.trim().split(/\s+/).filter(Boolean).length < 2)
		fail('Quote Sebastian\'s choice: --owner-approval "<his words>".');
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task);
		if (!t) fail(`${task.id} has no task row.`);
		if (t.mode !== "prototype") fail(`${t.ref} is in ${t.mode} mode; only prototype tasks compare ideas.`);
		if (t.status !== "escalated") fail(`${t.ref} is ${t.status}, not escalated: the choice answers an escalation.`);
		const runs = runsOf(db, t.id);
		const last = (i: number) => runs.filter((r) => r.stage === `idea${i}`).at(-1);
		const all = Array.from({ length: IDEAS }, (_, i) => i + 1);
		const missing = all.filter((i) => last(i)?.status !== "passed");
		if (missing.length !== 1)
			fail(
				`${t.ref} has ${all.length - missing.length} passed ideas of ${IDEAS}: the choice needs exactly one missing idea and every other idea passed.`,
			);
		const idea = missing[0]!,
			failed = ideaFailures(runs, idea, 0)[0],
			why = `idea ${idea} ${failed?.status ?? "did not finish"}: ${headline(failed?.summary ?? "no summary", 200)}`;
		const { m: afterRun } = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM runs WHERE task_id = ?").get(t.id) as {
			m: number;
		};
		db.prepare("UPDATE tasks SET status = 'active', updated_at = ? WHERE id = ?").run(now(), t.id);
		record(db, t.id, null, "compare_passed", {
			missing: [idea],
			passed: all.filter((i) => i !== idea),
			reason: why,
			quote: ownerApproval.trim(),
			after_run: afterRun,
			summary: `${t.ref}: Sebastian chose to compare ideas ${all.filter((i) => i !== idea).join(" and ")} without ${why}`,
		});
		noteOwnerAnswer(db, t.id);
		console.log(
			`compare-passed: ${t.ref} compares ideas ${all.filter((i) => i !== idea).join(" and ")}; idea ${idea} is missing.`,
		);
		return 0;
	} finally {
		db.close();
	}
}

/** A stale task row, closed for good: abandoned, with the reason as an `abandon` event. The TUI hides abandoned rows. */
export function taskAbandon(root: string, task: TaskRef, opts: { id?: number; reason: string }): number {
	if (process.env.EVF_RUN) fail("A seat cannot abandon a task row: Jonah or a human shell runs evf task abandon.");
	if (opts.reason.trim().split(/\s+/).filter(Boolean).length < 2)
		fail('Give the reason in two words or more: --reason "<words>".');
	const db = openWorkDb(root);
	try {
		const rows = db.prepare("SELECT id, ref, slug, status FROM tasks WHERE ref = ? ORDER BY id").all(task.id) as Array<{
			id: number;
			ref: string;
			slug: string;
			status: string;
		}>;
		if (!rows.length) fail(`${task.id} has no task row in the store.`);
		const row = opts.id ? rows.find((r) => r.id === opts.id) : rows.filter((r) => r.status !== "abandoned").at(-1);
		if (!row)
			fail(
				opts.id
					? `Store row ${opts.id} is not a row of ${task.id}; its rows are ${rows.map((r) => `${r.id} (${r.status})`).join(", ")}.`
					: `Every row of ${task.id} is already abandoned.`,
			);
		if (row.status === "merged")
			fail(
				`Store row ${row.id} of ${task.id} is merged; merged work is not abandoned.${rows.length > 1 ? ` The ref has rows ${rows.map((r) => `${r.id} (${r.status})`).join(", ")}: pick one with --id.` : ""}`,
			);
		if (row.status === "abandoned") fail(`Store row ${row.id} of ${task.id} is already abandoned.`);
		const open = db.prepare("SELECT id FROM runs WHERE task_id = ? AND status = 'started'").all(row.id) as Array<{
			id: number;
		}>;
		if (open.length)
			fail(
				`Store row ${row.id} of ${task.id} has a started run (${open.map((o) => o.id).join(", ")}); close or abort it first.`,
			);
		const pidFile = join(evfDataDir(root), "drive", `${row.slug}.pid`);
		const holder = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
		if (holder && holder !== process.pid && alive(holder))
			fail(`evf drive runs for ${task.id} (pid ${holder}). Stop it first.`);
		db.prepare("UPDATE tasks SET status = 'abandoned', updated_at = ? WHERE id = ?").run(now(), row.id);
		record(db, row.id, null, "abandon", {
			reason: opts.reason.trim(),
			from: row.status,
			summary: `${task.id} row ${row.id} abandoned (was ${row.status}): ${opts.reason.trim()}`,
		});
		noteOwnerAnswer(db, row.id);
		const event = (
			db.prepare("SELECT MAX(id) AS id FROM events WHERE task_id = ? AND type = 'abandon'").get(row.id) as {
				id: number;
			}
		).id;
		console.log(`abandon: ${task.id} store row ${row.id} (was ${row.status}) abandoned, event ${event}.`);
		return 0;
	} finally {
		db.close();
	}
}

/**
 * `evf task link <task> --follow-up <task2>` (OPS-109): record an existing row of task2 as a follow-up of the task's
 * current row, so followUpsOf, the Partial: line and the Ask coverage check name it. `--slice <n>` makes it the row
 * for later slice n of the stored spec; `--remove` undoes a link. It reserves no id and keeps the row's status.
 */
export function taskLink(
	root: string,
	task: TaskRef,
	opts: { followUp: TaskRef; id?: number; slice?: number; remove: boolean },
): number {
	const db = openWorkDb(root);
	try {
		const parent = findTask(db, task);
		if (!parent) fail(`${task.id} has no task row in the store.`);
		const rows = rowsOfRef(db, opts.followUp.id),
			list = rows.map((r) => `${r.id} (${r.status})`).join(", ");
		const candidates = opts.id ? rows.filter((r) => r.id === opts.id) : rows.filter((r) => r.status !== "abandoned");
		if (!candidates.length)
			fail(
				opts.id
					? `Store row ${opts.id} is not a row of ${opts.followUp.id}${rows.length ? `; its rows are ${list}` : ""}.`
					: `${opts.followUp.id} has no open task row in the store.`,
			);
		if (candidates.length > 1) fail(`${opts.followUp.id} has rows ${list}: pick one with --id.`);
		db.exec("BEGIN IMMEDIATE");
		let summary: string | null;
		try {
			summary = opts.remove
				? unlinkFollowUp(db, parent, candidates[0]!)
				: linkFollowUp(db, parent, candidates[0]!, opts.slice ?? null);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		console.log(
			summary
				? `link: ${summary}.`
				: `link: no change; store row ${candidates[0]!.id} ${opts.remove ? "is no follow-up" : "already is that follow-up"}.`,
		);
		return 0;
	} finally {
		db.close();
	}
}

/**
 * Set, change or clear the seat model and effort of one task row (OPS-81). The row's seats then run on it in every
 * role and round; a field left out keeps its value. Coordinator and human shells only: a seat cannot raise its own tier.
 */
export function taskSeats(
	root: string,
	task: TaskRef,
	opts: { model?: string; effort?: string; clear: boolean },
): number {
	if (process.env.EVF_RUN)
		fail(
			"The seat override is the coordinator's: run evf task seats from the coordinator or a human shell, not from a seat.",
		);
	const { model, effort, clear } = opts;
	if (clear && (model !== undefined || effort !== undefined)) fail("Give --clear alone, or --model and --effort.");
	if (!clear && model === undefined && effort === undefined) fail("Give --model, --effort or --clear.");
	validateOverride({ model, effort });
	const db = openWorkDb(root);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const t = findTask(db, task);
			if (!t) fail(`${task.id} has no open task row (never created, or abandoned). Create it with evf task new first.`);
			if (t.status === "merged" || t.status === "done")
				fail(`${t.ref} is ${t.status}; the override belongs to an open row.`);
			const next = clear
				? { model: null, effort: null }
				: { model: model ?? t.seat_model, effort: effort ?? t.seat_effort };
			const summary = `${t.ref} seats: ${seatText({ seat_model: next.model, seat_effort: next.effort })} (was ${seatText(t)})`;
			db.prepare("UPDATE tasks SET seat_model = ?, seat_effort = ?, updated_at = ? WHERE id = ?").run(
				next.model,
				next.effort,
				now(),
				t.id,
			);
			record(db, t.id, null, "seat_override", {
				model: next.model,
				effort: next.effort,
				previous_model: t.seat_model,
				previous_effort: t.seat_effort,
				summary,
			});
			db.exec("COMMIT");
			console.log(`seats: ${summary}`);
			if (next.model && !isOpus(next.model))
				console.log("seats: the verifier keeps its Opus setting; a non-Opus override does not apply to it (D82).");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
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
						"INSERT INTO tasks (slug, mode, ref, goal_id, title, ask, spec, spec_hash, branch, status, seat_model, seat_effort, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, ?, ?, ?, 'specced', ?, ?, ?, ?)",
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
						proto.seat_model,
						proto.seat_effort,
						now(),
						now(),
					).lastInsertRowid,
			);
			record(db, proto.id, Number(process.env.EVF_RUN) || null, "handoff", {
				implement_task: implementId,
				hash,
				seat_model: proto.seat_model,
				seat_effort: proto.seat_effort,
				summary: `${proto.ref} handed off to implement task ${implementId}`,
			});
			record(db, implementId, null, "spec_set", {
				hash,
				from_prototype: proto.id,
				seat_model: proto.seat_model,
				seat_effort: proto.seat_effort,
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
		const ac = acCriteria(t.spec).find((c) => c.criterion === opts.criterion);
		if (ac && opts.status !== "unmet")
			fail(
				`Criterion ${opts.criterion} checks ${ac.marker}: evf writes its met row after it runs the tests that carry the marker. Run bin/evf ac run ${t.ref}. A seat may still record --status unmet.`,
			);
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
						"SELECT criterion, status, head_sha, evidence_url, notes, written_by, created_at FROM proofs WHERE task_id = ? ORDER BY id",
					)
					.all(t.id) as Array<Record<string, unknown>>)
			: [];
		const atHead = rows.filter((p) => p.head_sha === head);
		// A row from an earlier head that the current head contains is carried forward; any other row is stale.
		const marked = rows.map((p) => ({
			...p,
			carried: !!head && p.head_sha !== head && reachable(wt, String(p.head_sha), head),
		}));
		if (json) console.log(JSON.stringify({ task: task.id, head, proofs: marked, at_head: atHead }, null, 2));
		else {
			console.log(
				`proofs for ${task.id} (head ${head?.slice(0, 10) ?? "no worktree"}): ${atHead.length} at head, ${rows.length} total`,
			);
			for (const p of marked)
				console.log(
					`  ${String(p.head_sha).slice(0, 10)} ${String(p.criterion).padEnd(4)} ${String(p.status).padEnd(5)} ${p.written_by === "evf" ? "by evf ac run" : "by a seat"} ${p.evidence_url ?? "-"} ${p.notes ?? ""}${p.carried ? " (carried from an earlier head)" : ""}`,
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
type PromptContext = {
	spec: string | null;
	ideas: string[];
	comparison: string;
	pick: Pick | null;
	prBody: string;
	/** The ask's `Coordinator note` paragraphs, which idea and compare seats must read. */
	notes: string[];
	/** The coordinator's reopen reason while no seat has passed since the reopen; the prompt carries it verbatim. */
	reopen: string | null;
	/** The failed or aborted run of this idea that the seat resumes from. */
	previous: { id: number; status: string; summary: string } | null;
	choice: CompareChoice | null;
	/** Set for the body stage only (OPS-113): the reviewed head and the items of its body_only review, or why evf has none. */
	body?: { head: string; items: BodyItem[] | string };
};
const notesOf = (ctx: PromptContext) =>
	ctx.notes.length
		? ` Coordinator notes from the ask, read them first: ${ctx.notes.map((n) => `"${n}"`).join(" ")}`
		: "";
/** Said first in every prompt after a reopen: the reason replaces the failure summaries that came before it. */
const reopenOf = (ctx: PromptContext) =>
	ctx.reopen
		? `The coordinator reopened this task. Reason, verbatim: "${ctx.reopen}". This is your current instruction; the failure summaries from before the reopen are history, not orders. `
		: "";
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
		`Build idea ${next.idea} of prototype task ${task.id} in this worktree. Your angle: ${angleOf(ctx.spec, next.idea!)}. The brief and the Done criteria are in your session-start context.${notesOf(ctx)}${ctx.previous ? ` This is a rerun: run ${ctx.previous.id} of this idea ended ${ctx.previous.status} with: "${ctx.previous.summary}". Resume in this worktree and its existing IDEA.md. Do not start over: clear that blocker first.` : ""} Write IDEA.md at the worktree root, commit, and close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>. A run cannot close passed while its summary or IDEA.md says a Done criterion is unmet: finish the criterion or close failed.`,
	compare: (task, _next, ctx) => {
		const left = ctx.choice?.missing ?? [],
			shown = ctx.ideas.filter((_, i) => !left.includes(i + 1));
		return `Compare the ${left.length ? "passed ideas" : "three ideas"} of prototype task ${task.id}. Idea worktrees: ${shown.join(", ")}.${left.length ? ` Idea ${left.join(", ")} is missing from this comparison (${ctx.choice!.reason}); Sebastian chose to compare without it. Name the missing idea and why at the top of comparison.md, and do not compare it.` : ""}${notesOf(ctx)} Build the comparison in ${ctx.comparison} (a toggle page for UI work; a compare script plus one diagram per idea for backend work) and write comparison.md there without naming a winner. Record it with bin/evf proof add ${task.id} --criterion comparison --status met --evidence ${ctx.comparison}/comparison.md, then close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`;
	},
	merge: (task, _next, ctx) =>
		`Sebastian picked idea ${ctx.pick?.idea} of prototype task ${task.id}: "${ctx.pick?.quote}". Its worktree: ${ctx.ideas[(ctx.pick?.idea ?? 1) - 1]}. Comparison: ${ctx.comparison}. Read the brief, the comparison and all three ideas, write the handoff spec (Goal, numbered Done criteria, Non-goals, Approach) and run bin/evf task handoff ${task.id} --file <path>. Close with bin/evf run done $EVF_RUN --status passed|failed --summary-file <path>.`,
};
export const STAGE_PROMPTS: Record<string, Prompt> = {
	plan: (task) =>
		`Plan task ${task.id}: write the spec (Goal, numbered testable Done criteria, Non-goals) from the ask in your session-start context. Write one Done criterion for each user action and expected result in the verbatim ask, and cover each Ask coverage deliverable (route, page, screen, command, file). Give each criterion one line under it: "Check: AC:${task.id}-<n>" when a test can prove it (a test whose name carries that marker), or "Check: owner — <reason>" for a taste call a person must judge. A UI spec cannot be stored without them. Store it with bin/evf task spec ${task.id} --file <path>, then close with bin/evf run done $EVF_RUN --status passed --summary-file <path>.`,
	implement: (task, next, ctx) =>
		`Implement task ${task.id} in this worktree against the spec in your session-start context.${next.round && !ctx.reopen ? ` Round ${next.round}: ${next.reason}. Read the last verify, ci or ship summary with bin/evf status --json ${task.id} and fix those findings first.` : ""} Before you close: add tests; for UI work read .agents/roles/ui-designer.md and capture 390 and 1440 px screenshots of each UI state you changed, outside the repository, as the capture half of .agents/skills/verify-preview/SKILL.md says; record bin/evf proof add ${task.id} --criterion <n> --status met|unmet|n/a --evidence <url-or-path> for each Done criterion you built or changed in this round whose Check: line is owner or that has no Check: line. For each criterion whose Check: is AC:${task.id}-<n>, write the test whose name carries that marker (tests/ui for browser behavior, tools/evf/tests for tooling) and do not proof add that row: bin/evf ac run ${task.id} runs the marked tests at HEAD and writes it, run done runs it again at your head, and the PR body proof table links each browser row's video. Keep bin/evf verify ${task.id} green, commit, and write the PR body to ${ctx.prBody} following .agents/skills/everyfield-pr/template.md with your EVF-Author line (bin/evf session prints your id). ${CLOSE}`,
	simplify: (task, next) =>
		`Simplify task ${task.id}: read the spec and git diff origin/main...HEAD, remove what the Done criteria do not need, commit. evf runs the author checks at your head in the pr stage.${next.reason.startsWith("pr failed") ? ` evf ran the author checks at the head and they failed (${next.reason}). Fix that first.` : ""} ${CLOSE}`,
	body: (task, next, ctx) => {
		const { head, items } = ctx.body!,
			at = head.slice(0, 10);
		const list =
			typeof items === "string"
				? ` evf could not read the items (${items}): read the latest EVF-Review line on the PR with gh pr view --comments.`
				: ` The items: ${items.map((item, i) => `${i + 1}. ${describeBodyItem(item)}`).join(" ")}`;
		return `Fix the PR body of task ${task.id} at ${at}. The verifier approved the code and the experience there and posted a body_only review: only the PR body needs these fixes.${list}${next.reason.startsWith("body failed") ? ` evf checked the body after the last body run and it failed (${next.reason}). Fix that first.` : ""} Edit only the PR body file ${ctx.prBody}: each "present" text must appear in it exactly, each "absent" text must not appear, and the body must still pass bin/evf pr body --body-file ${ctx.prBody} --task ${task.id}. Keep the EVF-Author line. Make no commit and change no other file: a commit sends the task to a full verify. When you close passed, evf pushes the body with evf pr open --body-file at the same head, checks it with the evf pr body standard and checks every item. ${CLOSE}`;
	},
	verify: (task) =>
		`Verify task ${task.id}: before you judge, read the full ask and spec with bin/evf task spec ${task.id} --show (your session-start context may shorten them), the goal chain and bin/evf proof show ${task.id}; read the full diff and judge the code and its simplicity. You judge the owner rows. evf wrote the AC: rows by running the marked tests at the head, and run done reruns them, so you may rely on those rows; still read each marked test and request changes when it checks too little (a test that only sees the page load proves nothing). Spot-check the proof: open the evidence in the proof table and re-run a flow only where a proof is unmet, missing or looks wrong. When only a screenshot is missing, capture it and record it with bin/evf proof add instead of requesting changes. Follow verify-preview; post one review with post-review.mjs --session <bin/evf session> --model claude-opus-5-5. Close with bin/evf run done $EVF_RUN --status passed (approved; every Done criterion needs a met or n/a proof at the head or an ancestor of it), body-only (code and experience approved, and every open finding is a PR body fix you posted as a present or absent text with --verdict body_only --body-items) or failed (changes requested) --summary-file <path> listing every finding.`,
};

/** The items of the body_only review at `head` for the body prompt, or why GitHub has none. */
function bodyItemsOf(root: string, t: TaskRow, head: string): BodyItem[] | string {
	if (!t.pr_number) return "no PR number recorded";
	try {
		return bodyOnlyItems(root, t.pr_number, head);
	} catch (e) {
		if (e instanceof EvfError) return e.message;
		throw e;
	}
}

const prBodyPath = (root: string, task: TaskRef) => join(runtimeDir(root, task), "pr-body.md");

/**
 * seatPollMs: how often a blocked seat, or a seat whose first turn has not begun, is looked at again.
 * startGraceMs: how long, counted from the moment the drive starts to watch a seat, an idle report counts as "the turn
 * has not begun yet". A seat watched late, after other launches, still gets the whole grace.
 */
export type DriveTiming = {
	waitMs: number;
	ciWaitMs: number;
	ciPollMs: number;
	seatPollMs: number;
	startGraceMs: number;
	/** Waits inside `evf launch`; tests shorten them, production uses LAUNCH_TIMING. */
	launch?: Partial<LaunchTiming>;
	/**
	 * The wait after a launch abort before the same stage launches again: this long after the first abort, twice as long
	 * after the second. The abort that reaches RETRY_CAP escalates at once and does not wait. Unset means no wait.
	 */
	abortBackoffMs?: number;
};
const DRIVE_TIMING: DriveTiming = {
	waitMs: 6 * 60 * 60_000,
	seatPollMs: 5_000,
	startGraceMs: 30_000,
	ciWaitMs: 40 * 60_000,
	ciPollMs: 30_000,
	abortBackoffMs: 30_000,
};

type Outcome = { status: "passed" | "failed"; summary: string };
/**
 * The pr stage: run the author checks at the current head, then push and open or update the PR from the body the
 * implementer wrote, and remember its number. A simplifier commit moved the head, so the checks run here, not in a seat.
 */
function prStage(db: DatabaseSync, root: string, task: TaskRef, t: TaskRow, wt: string): Outcome {
	const body = prBodyPath(root, task);
	if (!existsSync(body)) return { status: "failed", summary: `no PR body at ${body}; the implementer writes it` };
	// The implementer's own run is the record when the head has not moved; only a new head runs the checks again.
	const report = hasVerifiedHead(root, task) ? null : verify(root, task, "author", "full");
	if (report && !report.passed) {
		const failed = report.checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.log})`);
		return {
			status: "failed",
			summary: `${AUTHOR_CHECKS_FAILED} at ${report.sha.slice(0, 10)}: ${failed.join(", ") || "the tree changed during the run"}`,
		};
	}
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

/** Whether GitHub reports the PR as conflicting with its base: then required checks never start on its head. */
function conflicting(wt: string, number: number): boolean {
	const r = run("gh", ["pr", "view", String(number), "--json", "mergeable"], { cwd: wt });
	try {
		return (JSON.parse(r.stdout) as { mergeable?: string }).mergeable === "CONFLICTING";
	} catch {
		return false;
	}
}

/**
 * The ci stage (OPS-121): the required checks of the base branch, as evf ship reads and matches them, on the exact PR
 * head. Green only when each passed; a failure ends it at once; missing or pending checks wait, except on a PR that
 * conflicts with main. A check the rules do not require, such as Vercel, never decides it.
 */
function ciStage(root: string, t: TaskRow, wt: string, timing: DriveTiming): Outcome {
	if (!t.pr_number) return { status: "failed", summary: "no PR number recorded" };
	const required = requiredCheckNames(wt, nameWithOwner(wt), loadConfig(root).baseBranch);
	const start = Date.now();
	for (;;) {
		const ci = requiredCi(wt, t.pr_number, required);
		if (ci.failed.length)
			return { status: "failed", summary: `Required CI failed on the PR head: ${ci.failed.join(", ")}` };
		const waiting = [...ci.missing.map((n) => `${n} missing`), ...ci.pending.map((n) => `${n} pending`)].join(", ");
		if (!waiting)
			return {
				status: "passed",
				summary: `CI green: required ${[...new Set(ci.passed.map((c) => c.name))].join(", ")} passed`,
			};
		if (conflicting(wt, t.pr_number))
			return {
				status: "failed",
				summary: `PR #${t.pr_number} conflicts with main, so required CI never starts on its head: ${waiting}`,
			};
		if (Date.now() - start > timing.ciWaitMs)
			return {
				status: "failed",
				summary: `Required CI is not green after ${Math.round(timing.ciWaitMs / 60_000)} min: ${waiting}`,
			};
		sleep(timing.ciPollMs);
	}
}

/** GitHub's state of a PR and its merge commit. An unreadable GitHub gives state "". */
function prState(root: string, pr: number | string): { state: string; commit: string | null; head?: string } {
	const r = run("gh", ["pr", "view", String(pr), "--json", "state,mergeCommit,headRefOid"], { cwd: root });
	const text = r.code === 0 ? r.stdout.trim() : "";
	try {
		const v = JSON.parse(text) as { state?: string; mergeCommit?: { oid?: string } | null; headRefOid?: string };
		return { state: v.state ?? "", commit: v.mergeCommit?.oid ?? null, head: v.headRefOid };
	} catch {
		return { state: "", commit: /^[0-9a-f]{40}$/.test(text) ? text : null };
	}
}

/**
 * The ship stage. A PR GitHub already merged (a restart after the merge) is recorded, not shipped again. The merge is
 * recorded on the drive's own row `t`, so a follow-up the merge released never reads as this task (OPS-123).
 */
function shipStage(db: DatabaseSync, root: string, task: TaskRef, t: TaskRow, runId: number): Outcome {
	const pr = t.pr_number ?? task.branch;
	const before = prState(root, pr);
	if (before.state === "MERGED") {
		markRowMerged(db, t.id, before.commit, runId);
		return { status: "passed", summary: "already merged on GitHub" };
	}
	try {
		shipOnCurrentCode(root, loadConfig(root), task, () => ship(root, task));
	} catch (e) {
		// A voided owner approval (OPS-121) waits for Sebastian, like an owner route: no merge and no new round.
		if (!(e instanceof EvfError) || !e.message.includes(OWNER_VOID)) throw e;
		record(db, t.id, runId, "owner_approval_wait", { pr: t.pr_number, summary: `${task.id}: ${e.message}` });
		noteOwnerAsk(db, root, t.id, "void_approval");
		notify(`${task.id} waits for Sebastian`, e.message);
		return { status: "passed", summary: `waits for Sebastian's new approval: ${e.message}` };
	}
	const after = prState(root, pr);
	// A task is merged only when GitHub says so. An owner route (Wiki-style waits, P2/P3, design, document
	// templates) verifies and returns without a merge: the drive records the wait and stops, with no new round.
	if (after.state !== "MERGED" && taskById(db, t.id)?.status !== "merged") {
		const partial = partialLine(followUpsOf(db, t.id));
		const cause = `${partial ? `${partial} ` : ""}PR #${pr} is verified and waits for Sebastian's approval. After his approval in chat, run: bin/evf approve ${pr} --owner-approval "<his words>" --head ${after.head ?? "<the PR head>"}`;
		record(db, t.id, runId, "owner_approval_wait", { pr: t.pr_number, summary: `${task.id}: ${cause}` });
		// Evf ship recorded the route's ask at this head, unless older base code ran it (shipOnCurrentCode).
		noteOwnerAsk(db, root, t.id, task.kind === "fb" ? "feedback" : "parked");
		notify(`${task.id} waits for Sebastian`, cause);
		return { status: "passed", summary: "verified; waits for Sebastian's approval (evf approve)" };
	}
	markRowMerged(db, t.id, after.commit, runId);
	return { status: "passed", summary: "shipped" };
}

/**
 * How a drive's pinned row ended, or null while it is open (OPS-123). An abandoned row stops the drive. A merged row,
 * recorded by this drive, by `evf ship` or `evf approve`, or found on GitHub now, ends it. The GitHub check runs once
 * per pass and only for a row with a PR number; an unreadable GitHub leaves the row open.
 */
function driveEnd(db: DatabaseSync, root: string, t: TaskRow): Next | null {
	if (t.status === "abandoned") {
		const reason = latestEvent(db, t.id, ["abandon"])?.payload.reason;
		return {
			stage: "abandoned",
			round: t.round,
			reason: `store row ${t.id} of ${t.ref} was abandoned${typeof reason === "string" ? `: ${reason}` : ""}; the drive stops and starts no other row`,
		};
	}
	if (t.status !== "merged" && t.pr_number) {
		const gh = prState(root, t.pr_number);
		if (gh.state === "MERGED") markRowMerged(db, t.id, gh.commit, null);
	}
	return mergedEnd(db, t.id);
}

/** The `done (merged as <commit>)` end of a drive whose row `id` is merged, or null. */
function mergedEnd(db: DatabaseSync, id: number): Next | null {
	const row = taskById(db, id);
	if (row?.status !== "merged") return null;
	return { stage: "done", round: row.round, reason: `merged${row.merge_commit ? ` as ${row.merge_commit}` : ""}` };
}

/** evf runs pr, ci and ship itself and records them as runs of role `evf`. */
function evfStage(
	db: DatabaseSync,
	root: string,
	task: TaskRef,
	t: TaskRow,
	stage: Stage,
	timing: DriveTiming,
): Outcome["status"] {
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
					? ciStage(root, t, wt, timing)
					: stage === "ship"
						? shipStage(db, root, task, t, runId)
						: { status: "failed", summary: `evf cannot run stage ${stage}` };
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		outcome = { status: "failed", summary: e.message };
	}
	// A merge inside the stage (markMerged) already closed this run as passed; only the stage_end event is left.
	if (runStatus(db, runId) === "started") runDone(root, runId, outcome);
	else record(db, t.id, runId, "stage_end", { stage, status: outcome.status, summary: outcome.summary });
	return outcome.status;
}

const runStatus = (db: DatabaseSync, runId: number) =>
	(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;

/** The agent state in `herdr agent get|wait` output, or "unknown" when Herdr printed none. */
function parseAgentState(stdout: string): string {
	try {
		return String(
			(JSON.parse(stdout) as { result?: { agent?: { agent_status?: string } } }).result?.agent?.agent_status ??
				"unknown",
		);
	} catch {
		return "unknown";
	}
}

const agentState = (agent: string) => parseAgentState(run("herdr", ["agent", "get", agent]).stdout);
/** False when Herdr has no such agent: `agent get` fails or names no agent. */
const agentExists = (agent: string): boolean => {
	const r = run("herdr", ["agent", "get", agent], { timeoutMs: 10_000 });
	try {
		return r.code === 0 && !!(JSON.parse(r.stdout) as { result?: { agent?: unknown } }).result?.agent;
	} catch {
		return false;
	}
};

/** When the launch prompt went in, or null for a seat launched without one. */
function promptSentAt(db: DatabaseSync, runId: number): number | null {
	const row = db
		.prepare("SELECT ts FROM events WHERE run_id = ? AND type = 'prompt_sent' ORDER BY id LIMIT 1")
		.get(runId) as { ts: string } | undefined;
	return row ? Date.parse(row.ts) : null;
}

/** Close the run of a seat whose Herdr agent is gone. The stage launches again with the same round. */
function abortGoneSeat(db: DatabaseSync, t: TaskRow, runId: number, agent: string, stage: string): void {
	db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ? AND status = 'started'").run(
		now(),
		`Herdr has no agent ${agent}; the ${stage} stage launches again`,
		runId,
	);
	fillRunUsage(db, runId);
	record(db, t.id, runId, "seat_gone", { agent, summary: `${agent} is gone; ${stage} launches again` });
}

/**
 * Wait on an open seat. The wait runs in slices of one seat-poll interval, and the store is read before each slice, so a
 * run that closed or a seat that is gone never holds the drive. A blocked seat is reported once per episode and polled
 * until it leaves `blocked`; an idle report before the launch prompt began its turn is not a finished turn; a seat that
 * goes idle after its turn with its stage open is nudged once, then aborted.
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
		runDone(root, runId, { status: "failed", summary: "no Herdr agent recorded for this run", closedBy: "evf" });
		return;
	}
	const watchStart = Date.now(),
		deadline = watchStart + timing.waitMs;
	let turnSeen = false,
		waitsLogged = 0;
	for (let nudged = false; ;) {
		if (runStatus(db, runId) !== "started") return;
		// A seat that waits for a free preview slot says so as an event; the drive log repeats it.
		for (const e of db
			.prepare("SELECT id, payload FROM events WHERE run_id = ? AND type = 'preview_wait' AND id > ? ORDER BY id")
			.all(runId, waitsLogged) as Array<{ id: number; payload: string }>) {
			waitsLogged = e.id;
			console.log(
				`${now()} drive ${task.id}: ${r.herdr_agent}: ${(JSON.parse(e.payload) as { summary?: string }).summary}`,
			);
		}
		const sliceStart = Date.now();
		const waited = run(
			"herdr",
			[
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
				String(Math.max(1, Math.min(timing.seatPollMs, deadline - sliceStart))),
			],
			// A floor keeps a slow runner from killing a wait that is about to answer.
			{ timeoutMs: Math.max(timing.seatPollMs + 200, 2_000) },
		);
		if (runStatus(db, runId) !== "started") return;
		const state = parseAgentState(waited.stdout);
		if (!["idle", "done", "blocked"].includes(state)) {
			if (state === "unknown" && !agentExists(r.herdr_agent)) {
				abortGoneSeat(db, t, runId, r.herdr_agent, r.stage);
				return;
			}
			if (Date.now() >= deadline) {
				runDone(root, runId, {
					status: "failed",
					summary: `herdr agent wait timed out after ${Math.round(timing.waitMs / 60_000)} min: ${(waited.stderr || waited.stdout).trim().slice(0, 200)}`,
					closedBy: "evf",
				});
				return;
			}
			// A slice that ended with the seat still working, or a quick failure: look at the store again after a pause.
			if (Date.now() - sliceStart < timing.seatPollMs) sleep(timing.seatPollMs - (Date.now() - sliceStart));
			continue;
		}
		if (state === "blocked") {
			record(db, t.id, runId, "blocked", { summary: `${r.herdr_agent} is blocked on a prompt` });
			notify(`${task.id} seat blocked`, `${r.herdr_agent} waits on a prompt in its pane.`);
			do {
				sleep(timing.seatPollMs);
				if (runStatus(db, runId) !== "started") return;
			} while (agentState(r.herdr_agent) === "blocked");
			// The prompt is gone: say so, or the last event keeps reading "blocked" for as long as the seat works.
			record(db, t.id, runId, "unblocked", { summary: `${r.herdr_agent} resumed after a prompt` });
			continue;
		}
		if (state === "idle" && !nudged && !turnSeen) {
			// The launch prompt may not have begun its turn yet: wait for the seat to leave idle before reading idle as finished.
			const sent = promptSentAt(db, runId);
			if (sent !== null) {
				for (let left = watchStart + timing.startGraceMs; Date.now() < left;) {
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
		runDone(root, runId, {
			status: "failed",
			summary: `${r.herdr_agent} went idle twice without closing ${r.stage}`,
			closedBy: "evf",
		});
		return;
	}
}

/** The failed or aborted run an idea seat resumes from, or null for a first launch. */
function previousIdeaRun(runs: RunRow[], idea: number | undefined): PromptContext["previous"] {
	const last = idea ? runs.filter((r) => r.stage === `idea${idea}`).at(-1) : undefined;
	return last && (last.status === "failed" || last.status === "aborted")
		? { id: last.id, status: last.status, summary: last.summary ?? "(no summary)" }
		: null;
}

/**
 * Launch a seat. A launch that fails after its run row exists closed that run as aborted with the pane's last lines
 * (launch retries once by itself), so the drive logs it, waits (abortBackoffMs, doubling) and goes on to the next
 * transition, where the retry cap applies. A launch line over the terminal limit cannot succeed on a retry: the task
 * escalates at once with that message. A failure before any run row exists is not a launch result: it stops the drive.
 */
function launchOrLog(
	root: string,
	task: TaskRef,
	taskId: number,
	launching: {
		role: Role;
		prompt: string;
		idea?: number;
		stage?: string;
		mode: string;
		launch?: Partial<LaunchTiming>;
	},
	timing: DriveTiming,
): void {
	try {
		launch(root, task, launching.role, {
			prompt: launching.prompt,
			idea: launching.idea,
			stage: launching.stage,
			mode: launching.mode,
			timing: launching.launch,
			driven: true,
			taskId,
		});
	} catch (e) {
		if (e instanceof LaunchLineTooLong) {
			console.log(`${now()} drive ${task.id}: launch of ${launching.role} refused: ${e.message}`);
			const db = openWorkDb(root);
			try {
				const t = taskById(db, taskId)!;
				if (t.status !== "escalated") escalate(db, root, t, null, e.message);
			} finally {
				db.close();
			}
			return;
		}
		if (!(e instanceof LaunchAborted)) throw e;
		console.log(`${now()} drive ${task.id}: launch of ${launching.role} failed: ${e.message}`);
		const db = openWorkDb(root);
		let failures = 0;
		try {
			failures = failuresInARow(runsOf(db, taskId), reopenMarker(db, taskId));
		} finally {
			db.close();
		}
		const wait = (timing.abortBackoffMs ?? 0) * 2 ** Math.max(0, failures - 1);
		if (failures < RETRY_CAP && wait > 0) {
			console.log(
				`${now()} drive ${task.id}: launch abort ${failures} of ${RETRY_CAP}; waiting ${wait / 1000} s before the ${launching.role} launches again`,
			);
			sleep(wait);
		}
	}
}

/**
 * The row a fresh drive pins (OPS-123): the ref's current row, which may be a released follow-up with its own ask and
 * seats. Only a ref with no row at all gets a new one here; a running drive never creates or switches rows after this.
 */
export function pinRow(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		return ensureTask(db, task, "implement").id;
	} finally {
		db.close();
	}
}

/**
 * One transition on the pinned row `pin` (a fresh drive's pin when absent). Returns the stage it performed or waited
 * on. A pass first ends the drive when the row is abandoned or merged, a merge on GitHub included.
 */
export function driveOnce(
	root: string,
	task: TaskRef,
	timing: DriveTiming = DRIVE_TIMING,
	pin: number = pinRow(root, task),
): Next {
	const db = openWorkDb(root);
	let launching:
		| {
				role: Role;
				prompt: string;
				idea?: number;
				stage?: string;
				mode: string;
				comparison: string;
				launch?: Partial<LaunchTiming>;
		  }
		| undefined;
	try {
		const t = taskById(db, pin);
		if (!t) fail(`Store row ${pin} of ${task.id} does not exist; the drive stops.`);
		const ended = driveEnd(db, root, t);
		if (ended) return ended;
		const runs = runsOf(db, t.id);
		const pick = pickOf(db, t.id);
		const marker = reopenMarker(db, t.id),
			extras = extrasOf(db, t.id);
		const n = nextStage(task, t, runs, !!pick, marker, extras);
		record(db, t.id, n.run ?? null, "next", {
			stage: n.stage,
			round: n.round,
			summary: `next: ${n.stage} (${n.reason})`,
		});
		// An escalation the task earned while a seat works is held back and recorded, so the TUI says why it stays active.
		if (n.stage === "waiting" && n.deferred && extras.deferred !== n.deferred)
			record(db, t.id, n.run ?? null, "escalation_deferred", {
				cause: n.deferred,
				summary: `${task.id} escalation held back until ${n.reason.replace(/^escalation held back until /, "")}`,
			});
		if (n.skipped)
			record(db, t.id, null, "simplify_skipped", {
				simplify_run: n.skipped.run,
				head: n.skipped.head,
				summary: `${task.id} skips simplify: no change since simplify run ${n.skipped.run} at ${n.skipped.head.slice(0, 10)}`,
			});
		if (n.stage === "escalated" && t.status !== "escalated") escalate(db, root, t, null, n.reason);
		if (n.stage === "done" || n.stage === "escalated" || n.stage === "blocked") return n;
		if (n.stage === "pick") {
			if (t.status !== "awaiting_pick") {
				db.prepare("UPDATE tasks SET status = 'awaiting_pick', updated_at = ? WHERE id = ?").run(now(), t.id);
				record(db, t.id, null, "awaiting_pick", {
					summary: `${task.id}: comparison ready, waiting for Sebastian's pick`,
				});
				noteOwnerAsk(db, root, t.id, "prototype_pick", null);
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
				fillRunUsage(db, open.id);
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
				notes: coordinatorNotes((db.prepare("SELECT ask FROM tasks WHERE id = ?").get(t.id) as { ask: string }).ask),
				// Until a seat passes after the reopen, every prompt carries the coordinator's reason.
				reopen: runs.some((r) => r.id > marker && r.status === "passed") ? null : (extras.reopenReason ?? null),
				previous: previousIdeaRun(runs, n.idea),
				choice: extras.choice ?? null,
				...(n.stage === "body" && extras.bodyOnly
					? { body: { head: extras.bodyOnly.head, items: bodyItemsOf(root, t, extras.bodyOnly.head) } }
					: {}),
			};
			const prompts = t.mode === "prototype" ? PROTOTYPE_PROMPTS : STAGE_PROMPTS;
			launching = {
				role: n.role,
				prompt: reopenOf(ctx) + prompts[n.stage]!(task, n, ctx),
				stage: n.stage === "body" ? "body" : undefined,
				idea: n.idea,
				mode: t.mode,
				comparison: ctx.comparison,
				launch: timing.launch,
			};
			return n;
		}
		const evfStatus = evfStage(db, root, task, t, n.stage, timing);
		// A merge ends the task: the loop stops here and makes no further transition.
		const merged = n.stage === "ship" ? mergedEnd(db, t.id) : null;
		if (merged) return merged;
		// A verified owner route stops here: Sebastian approves, then the next pass records the merge.
		// A failed ship keeps its transition (a new implement round).
		if (n.stage === "ship" && evfStatus === "passed") {
			const partial = partialLine(followUpsOf(db, t.id));
			return {
				stage: "done",
				round: n.round,
				reason: `${partial ? `${partial} ` : ""}PR #${t.pr_number ?? "?"} waits for Sebastian's approval`,
			};
		}
		return n;
	} finally {
		db.close();
		if (launching) {
			mkdirSync(launching.comparison, { recursive: true });
			launchOrLog(root, task, pin, launching, timing);
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
	// A drive on stale evf code would run its stages on old rules, so it refuses before any seat or run row (OPS-111).
	// Once it runs, a main that moves under it reaches the ship stage through shipOnCurrentCode instead.
	requireCurrentCode(root, loadConfig(root), `evf drive does not start ${task.id}`);
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
		// The drive stays on this row to its end; a follow-up its merge releases waits for a fresh drive (OPS-123).
		const pin = pinRow(root, task);
		for (;;) {
			const n = driveOnce(root, task, timing, pin);
			console.log(`${now()} drive ${task.id}: ${n.stage} (${n.reason})`);
			const stop = n.stage === "escalated" || n.stage === "blocked" || n.stage === "abandoned";
			if (stop || n.stage === "done" || n.stage === "pick" || opts.once) return stop ? 2 : 0;
		}
	} finally {
		if (existsSync(pidFile) && Number(readFileSync(pidFile, "utf8").trim()) === process.pid) unlinkSync(pidFile);
	}
}
