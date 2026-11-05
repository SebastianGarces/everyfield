import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { renderAc } from "./brief.ts";
import { missionFor } from "./db.ts";
import { cachedTriage } from "./feedback.ts";
import { followUpsOf } from "./followups.ts";
import { EvfError, findPackage, git, loadConfig, loadDag, packageContext, type TaskRef } from "./lib.ts";
import { cleanMerges, mergedMainOverlap, nameWithOwner, reviewsOf } from "./ship.ts";

/**
 * OPS-145: what changed since the head a verifier approved. `merge_only` means every commit since is a clean merge of
 * main, and only it narrows the review. `simplify` means the only non-merge commits came from the simplify seat. Any
 * other delta, a first review included, is `code`. The two full-review kinds differ only in the record.
 */
export type DeltaKind = "merge_only" | "simplify" | "code";
export type VerifyDelta = {
	head: string;
	priorApprovedHead: string | null;
	deltaKind: DeltaKind;
	/** Lines added plus removed from the prior approved head, or from the branch's base with none. Null when unreadable. */
	deltaLines: number | null;
	/** Set for `merge_only`: the branch's base before the merges, and the paths both the branch and main changed. */
	base?: string;
	overlapPaths?: string[];
	/** What moved since the approval and forced the full review: a key of ReviewInputs, `review`, or `rules: <path>`. */
	changedInputs?: string[];
};
type RunAfterApproval = { stage: string; status: string; progress_head: string | null };

/**
 * What an approval judged, besides the diff, as one hash each. A verify close stores them; a change to any one before the
 * next verifier voids the merge-only review. Null means unreadable, which counts as changed. The rules on main are the
 * other input (REVIEW_RULES), and the review on GitHub is the last (changedInputs). A reopen clears the approval itself.
 */
export type ReviewInputs = Record<
	"ask" | "spec" | "goal" | "followUps" | "proofs" | "prBody" | "contract",
	string | null
>;

/** The files that say how a verifier judges. A merge of main that changes one judges the branch by a new rule. */
const REVIEW_RULES = [
	"AGENTS.md",
	"docs/architecture/decisions.md",
	"docs/architecture/patterns.md",
	".agents/roles/verifier.md",
	".claude/agents/verifier.md",
	".agents/skills/verify-preview/",
	".agents/skills/test-standard/",
	".agents/skills/principle-",
];
const rulesIn = (wt: string, prior: string, head: string) =>
	git(wt, "diff", "--name-only", "--no-renames", prior, head)
		.split("\n")
		.filter((path) => REVIEW_RULES.some((rule) => path.startsWith(rule)))
		.map((path) => `rules: ${path}`);

const hashOf = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** The task's contract in the repo at the worktree head: its OPS entry, or its package with its requirements and cases. */
export function contractOf(root: string, wt: string, task: TaskRef): string | null {
	try {
		if (task.kind === "ops") return hashOf(loadConfig(wt).maintenanceTasks?.[task.id] ?? null);
		const wp = task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : task.wp;
		if (!wp) return hashOf(task.kind === "fb" ? cachedTriage(root, task.issue!) : null);
		return hashOf(
			findPackage(loadDag(wt), wp),
			(packageContext(wt, wp).acceptance_ids as string[]).map((id) => renderAc(wt, id)),
		);
	} catch (e) {
		if (e instanceof EvfError) return null;
		throw e;
	}
}

export function reviewInputs(
	db: DatabaseSync,
	root: string,
	taskId: number,
	task: TaskRef,
	wt: string,
	prBody: string,
): ReviewInputs {
	const t = db
		.prepare("SELECT ask, title, spec, goal_id, parent_task_id, slice FROM tasks WHERE id = ?")
		.get(taskId) as {
		ask: string;
		title: string;
		spec: string | null;
		goal_id: number | null;
		parent_task_id: number | null;
		slice: number | null;
	};
	const project = db.prepare("SELECT title, body FROM goals WHERE key = 'project'").get();
	const mission = t.goal_id
		? db.prepare("SELECT title, body FROM goals WHERE id = ?").get(t.goal_id)
		: missionFor(db, task.wp);
	// evf writes the AC: rows again at each close, from the tests at that head, so only the rows a person judged count.
	const proofs = db
		.prepare(
			"SELECT DISTINCT criterion, status, evidence_url, notes FROM proofs WHERE task_id = ? AND written_by IS NOT 'evf' ORDER BY criterion, status, evidence_url, notes",
		)
		.all(taskId);
	return {
		ask: hashOf(t.title, t.ask),
		spec: hashOf(t.spec),
		goal: hashOf(project, mission),
		followUps: hashOf(
			t.parent_task_id,
			t.slice,
			followUpsOf(db, taskId).map((f) => [f.label, f.status, f.title]),
		),
		proofs: hashOf(proofs),
		prBody: hashOf(existsSync(prBody) ? readFileSync(prBody, "utf8") : null),
		contract: contractOf(root, wt, task),
	};
}

/**
 * The inputs that moved since the close that recorded `then`. A close with no record, from before this check, names
 * every input. The approval also needs its exact-head review on GitHub, because the prompt reads that review.
 */
export function changedInputs(
	then: ReviewInputs | undefined,
	now: ReviewInputs,
	wt: string,
	pr: number | null,
	prior: string,
): string[] {
	const moved = (Object.keys(now) as Array<keyof ReviewInputs>).filter((k) => now[k] === null || then?.[k] !== now[k]);
	return approvedOnGitHub(wt, pr, prior) ? moved : [...moved, "review"];
}
function approvedOnGitHub(wt: string, pr: number | null, head: string): boolean {
	if (!pr) return false;
	try {
		const review = reviewsOf(wt, nameWithOwner(wt), pr, head).selected?.approval;
		return review?.head === head && review.verdict === "approved";
	} catch (e) {
		if (e instanceof EvfError || e instanceof SyntaxError) return false;
		throw e;
	}
}

const changedLines = (wt: string, from: string, to: string) =>
	git(wt, "diff", "--numstat", "--no-renames", from, to)
		.split("\n")
		.filter(Boolean)
		.reduce((sum, row) => {
			const [added, removed] = row.split("\t");
			return sum + (Number(added) || 0) + (Number(removed) || 0);
		}, 0);

/** The implement runs since the approval added no code, and nothing but merges came after the simplifier. */
function onlySimplified(wt: string, main: string, prior: string, head: string, after: RunAfterApproval[]): boolean {
	const last = (stage: string) => after.filter((r) => r.stage === stage && r.status === "passed").at(-1),
		merges = (from: string, to: string) => typeof cleanMerges(wt, from, to, main) !== "string",
		implement = last("implement"),
		simplify = last("simplify");
	if (!simplify?.progress_head || !merges(simplify.progress_head, head)) return false;
	return !implement || (!!implement.progress_head && merges(prior, implement.progress_head));
}

/**
 * Classifies the worktree head against `prior`, the head the latest verify close approved. `after` lists the runs since
 * that close. `changed` names the review inputs that moved since it, which gives `code` whatever Git shows. A Git error
 * gives `code`: an unreadable delta gets the full review.
 */
export function verifyDelta(
	wt: string,
	main: string,
	prior: string | null,
	after: RunAfterApproval[],
	changed: string[],
): VerifyDelta {
	const head = git(wt, "rev-parse", "HEAD");
	try {
		if (!prior)
			return {
				head,
				priorApprovedHead: null,
				deltaKind: "code",
				deltaLines: changedLines(wt, git(wt, "merge-base", head, main), head),
			};
		const known = { head, priorApprovedHead: prior, deltaLines: changedLines(wt, prior, head) };
		const inputs = [...changed, ...rulesIn(wt, prior, head)];
		if (inputs.length) return { ...known, deltaKind: "code", changedInputs: inputs };
		if (head === prior) return { ...known, deltaKind: "code" };
		const merges = cleanMerges(wt, prior, head, main);
		if (typeof merges !== "string") {
			const { base, overlap } = mergedMainOverlap(wt, prior, head, main);
			return { ...known, deltaKind: "merge_only", base, overlapPaths: overlap };
		}
		return { ...known, deltaKind: onlySimplified(wt, main, prior, head, after) ? "simplify" : "code" };
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		return { head, priorApprovedHead: prior, deltaKind: "code", deltaLines: null };
	}
}

/** The verifier's task when only main changed. Required CI and the exact-head review stay as they are. */
export function mergeOnlyPrompt(task: TaskRef, delta: VerifyDelta): string {
	const { head, priorApprovedHead: prior, base, overlapPaths = [] } = delta;
	const overlap = overlapPaths.length
		? `The branch and main both changed these paths, so read each one at ${head} and confirm that both sides' changes survive: ${overlapPaths.join(", ")}.`
		: "The branch and main changed no path in common.";
	return `Verify task ${task.id}: this is a merge-only review. The verifier approved the prior head ${prior}. Every commit from it to the merge result ${head} is a clean merge of main: evf recomputed each merge tree and it matches. Limit your review to the merge result and the overlap. Read git diff ${prior} ${head}, which is what main brought in, against the branch's own change in git diff ${base} ${prior}. ${overlap} Also check whether what main changed breaks anything the branch calls or depends on. The approved review at the prior head stands for the rest: do not judge the rest of the diff again and do not rerun flows or bin/evf verify. Required CI on the exact head stays required, and evf ship checks it. Read the current PR body and confirm that it still describes the branch. Post one exact-head review with post-review.mjs --head ${head} --session <bin/evf session> --model claude-opus-5-5. Take the Ask coverage rows from the approved review at the prior head, and judge Code quality and Experience on the merge result. Close with bin/evf run done $EVF_RUN --status passed (approved), body-only (the merge result is approved, and every open finding is a PR body fix you posted as a present or absent text with --verdict body_only --body-items) or failed (changes requested) --summary-file <path> listing every finding.`;
}
