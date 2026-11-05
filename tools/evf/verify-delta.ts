import { EvfError, git, type TaskRef } from "./lib.ts";
import { cleanMerges, mergedMainOverlap } from "./ship.ts";

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
};
type RunAfterApproval = { stage: string; status: string; progress_head: string | null };

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
 * that close. A Git error gives `code`: an unreadable delta gets the full review.
 */
export function verifyDelta(wt: string, main: string, prior: string | null, after: RunAfterApproval[]): VerifyDelta {
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
		const merges = cleanMerges(wt, prior, head, main);
		if (typeof merges !== "string" && merges.length) {
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
	return `Verify task ${task.id}: this is a merge-only review. The verifier approved the prior head ${prior}. Every commit from it to the merge result ${head} is a clean merge of main: evf recomputed each merge tree and it matches. Limit your review to the merge result and the overlap. Read git diff ${prior} ${head}, which is what main brought in, against the branch's own change in git diff ${base} ${prior}. ${overlap} Also check whether what main changed breaks anything the branch calls or depends on. The approved review at the prior head stands for the rest: do not judge the rest of the diff again and do not rerun flows or bin/evf verify. Required CI on the exact head stays required, and evf ship checks it. Post one exact-head review with post-review.mjs --head ${head} --session <bin/evf session> --model claude-opus-5-5. Take the Ask coverage rows from the approved review at the prior head, and judge Code quality and Experience on the merge result. Close with bin/evf run done $EVF_RUN --status passed (approved) or failed (changes requested) --summary-file <path> listing every finding.`;
}
