import type { DatabaseSync } from "node:sqlite";
import { record } from "./db.ts";
import {
	baseRef,
	EvfError,
	git,
	gitOk,
	loadConfig,
	REAL_CLOCK,
	run,
	worktreePath,
	type Clock,
	type TaskRef,
} from "./lib.ts";
import { carryProof, conflicting, reviewsOf, nameWithOwner } from "./ship.ts";

/**
 * The longest a verifier waits for a ready PR that overlaps its PR. A second verifier pass costs about 21 min
 * (33 passes, 11.5 h), so a wait much past that saves nothing.
 */
export const OVERLAP_WAIT_MS = 30 * 60_000;
const OVERLAP_POLL_MS = 60_000;
/** A failed sync of the worktree gets this many tries, this far apart, before the drive stops. */
const SYNC_TRIES = 3;
const SYNC_RETRY_MS = 5_000;

export type OverlapTiming = { overlapWaitMs?: number; overlapPollMs?: number; clock?: Clock };
type ReadyPr = { pr: number; paths: string[] };

const changedPaths = (wt: string, from: string, to: string) =>
	git(wt, "diff", "--name-only", "--no-renames", from, to).split("\n").filter(Boolean);

/** Paths that both the branch and main changed since they split: what the Fresh gate of evf ship refuses on. */
function mainOverlap(wt: string, head: string, main: string): string[] {
	const base = git(wt, "merge-base", head, main),
		onMain = new Set(changedPaths(wt, base, main));
	return changedPaths(wt, base, head).filter((path) => onMain.has(path));
}

/** A PR is ready when ship could take it: its latest review approves its head, directly or through a carry. */
function isReady(wt: string, remote: string, main: string, number: number, head: string): boolean {
	const { selected, latest } = reviewsOf(wt, nameWithOwner(wt), number, head);
	const review = selected ?? latest;
	if (!review || review.approval.verdict === "changes_requested") return false;
	if (review.approval.head === head) return true;
	gitOk(wt, "fetch", "--quiet", remote, head, review.approval.head);
	return typeof carryProof(wt, review.approval.head, head, main) !== "string";
}

/** The other ready PRs that change a path this PR changes. Comments are read only for a PR that overlaps. */
function readyOverlaps(wt: string, remote: string, base: string, own: number, head: string, main: string): ReadyPr[] {
	const mine = new Set(changedPaths(wt, git(wt, "merge-base", head, main), head));
	const r = run(
		"gh",
		["pr", "list", "--base", base, "--state", "open", "--limit", "100", "--json", "number,isDraft,headRefOid,files"],
		{ cwd: wt },
	);
	if (r.code !== 0) throw new EvfError(`gh pr list failed: ${(r.stderr || r.stdout).trim()}`);
	const prs = JSON.parse(r.stdout) as Array<{
		number: number;
		isDraft: boolean;
		headRefOid: string;
		files?: Array<{ path: string }>;
	}>;
	return prs.flatMap((pr) => {
		const paths = (pr.files ?? []).map((file) => file.path).filter((path) => mine.has(path));
		return pr.number !== own && !pr.isDraft && paths.length && isReady(wt, remote, main, pr.number, pr.headRefOid)
			? [{ pr: pr.number, paths }]
			: [];
	});
}

/** When the wait at this head began, if a drive that stopped mid-wait left it open: a restart keeps the same limit. */
function openWaitStart(db: DatabaseSync, taskId: number, head: string): number | null {
	const last = db
		.prepare("SELECT ts, payload FROM events WHERE task_id = ? AND type = 'verify_overlap' ORDER BY id DESC LIMIT 1")
		.get(taskId) as { ts: string; payload: string } | undefined;
	if (!last) return null;
	const payload = JSON.parse(last.payload) as { choice?: string; head?: string };
	return payload.choice === "wait" && payload.head === head ? Date.parse(last.ts) : null;
}

/**
 * Runs before the verifier launches, so it does not approve a head that ship then refuses on the Fresh gate (OPS-140).
 * Main overlaps: merge main into the branch. A ready PR overlaps: wait until it lands or the limit passes. No overlap:
 * start at once. Each `verify_overlap` event logs one choice. An unreadable GitHub never blocks: the verifier starts.
 * Returns the reason when the verifier must not start: main conflicts with the branch, or GitHub merged main and the
 * worktree cannot reach that new head, so a verifier would review a head that is not the PR head. Otherwise null.
 */
export function overlapGate(
	db: DatabaseSync,
	root: string,
	task: TaskRef,
	taskId: number,
	pr: number | null,
	timing: OverlapTiming,
): string | null {
	const cfg = loadConfig(root),
		wt = worktreePath(root, cfg, task),
		main = baseRef(root, cfg),
		clock = timing.clock ?? REAL_CLOCK,
		limit = timing.overlapWaitMs ?? OVERLAP_WAIT_MS;
	const log = (choice: string, summary: string, fields: Record<string, unknown>) => {
		record(db, taskId, null, "verify_overlap", { choice, ...fields, summary: `${task.id}: ${summary}` });
		console.log(`drive ${task.id}: ${summary}`);
	};
	/** Moves the worktree to the branch head on GitHub. Returns the last Git error, or null when it arrived. */
	const syncBranch = (): string | null => {
		for (let attempt = 1; ; attempt++) {
			const fetched = run("git", ["fetch", "--quiet", cfg.remote, task.branch], { cwd: wt }),
				step = fetched.code === 0 ? run("git", ["merge", "--quiet", "--ff-only", "FETCH_HEAD"], { cwd: wt }) : fetched;
			if (step.code === 0) return null;
			if (attempt === SYNC_TRIES) return (step.stderr || step.stdout).trim();
			clock.sleep(SYNC_RETRY_MS);
		}
	};
	if (!pr) return null;
	try {
		let waitStart = openWaitStart(db, taskId, git(wt, "rev-parse", "HEAD"));
		for (;;) {
			gitOk(wt, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
			let head = git(wt, "rev-parse", "HEAD");
			const mainSha = git(wt, "rev-parse", main),
				overlapPaths = mainOverlap(wt, head, mainSha);
			if (overlapPaths.length) {
				const update = run("gh", ["pr", "update-branch", String(pr)], { cwd: wt });
				const fields = { head, main: mainSha, overlapPaths };
				if (update.code !== 0) {
					if (/conflict/i.test(update.stderr) || conflicting(wt, pr)) {
						const reason = `main ${mainSha.slice(0, 10)} conflicts with this branch in ${overlapPaths.join(", ")}. Merge main, resolve the conflict and commit.`;
						log("merge_conflict", `no verifier yet: ${reason}`, fields);
						return reason;
					}
					log(
						"merge_failed",
						`merge of main failed, the verifier starts: ${(update.stderr || update.stdout).trim()}`,
						fields,
					);
					return null;
				}
				const syncError = syncBranch();
				if (syncError) {
					const reason = `GitHub merged main ${mainSha.slice(0, 10)} into ${task.branch}, but this worktree cannot reach that head: ${syncError}. Clear the cause, then run git pull --ff-only ${cfg.remote} ${task.branch}.`;
					log("sync_failed", `no verifier yet: ${reason}`, fields);
					return reason;
				}
				head = git(wt, "rev-parse", "HEAD");
				log("merge_main", `merged main ${mainSha.slice(0, 10)} before the verifier: ${overlapPaths.join(", ")}`, {
					...fields,
					head,
				});
			}
			const ready = readyOverlaps(wt, cfg.remote, cfg.baseBranch, pr, head, mainSha);
			if (!ready.length) {
				log("start", "no overlap with main or a ready PR, the verifier starts", {
					head,
					main: mainSha,
					overlapPaths: [],
				});
				return null;
			}
			const names = ready.map((r) => `#${r.pr} (${r.paths.join(", ")})`).join(", ");
			if (waitStart === null) {
				waitStart = clock.now();
				log("wait", `the verifier waits up to ${Math.round(limit / 60_000)} min for ready PR ${names}`, {
					head,
					main: mainSha,
					ready,
					limitMs: limit,
				});
			}
			const left = limit - (clock.now() - waitStart);
			if (left <= 0) {
				log(
					"start_after_limit",
					`waited ${Math.round(limit / 60_000)} min for ready PR ${names}, the verifier starts`,
					{
						head,
						main: mainSha,
						ready,
					},
				);
				return null;
			}
			clock.sleep(Math.min(timing.overlapPollMs ?? OVERLAP_POLL_MS, left));
		}
	} catch (e) {
		if (!(e instanceof EvfError || e instanceof SyntaxError)) throw e;
		log("check_failed", `overlap check failed, the verifier starts: ${e.message}`, {});
		return null;
	}
}
