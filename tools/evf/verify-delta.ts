import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { renderAc } from "./brief.ts";
import { missionFor } from "./db.ts";
import { cachedTriage } from "./feedback.ts";
import { followUpsOf } from "./followups.ts";
import {
	currentCatalog,
	fail,
	findPackage,
	git,
	independentReview,
	loadDag,
	packageContext,
	readJson,
	readParty,
	type Context,
	type TaskRef,
} from "./lib.ts";
import { cleanMerges, mergedMainOverlap, nameWithOwner, reviewsOf } from "./ship.ts";

/**
 * OPS-145: what changed since the head a verifier approved. `merge_only` narrows the review, so it fails closed: it needs
 * every proof in verifyDelta, and anything unknown gives `code`. `simplify` means the only non-merge commits came from the
 * simplify seat. Any other delta, a first review included, is `code`. The two full-review kinds differ only in the record.
 */
export type DeltaKind = "merge_only" | "simplify" | "code";
export type VerifyDelta = {
	head: string;
	priorApprovedHead: string | null;
	deltaKind: DeltaKind;
	/** Lines added plus removed from the prior approved head, or from the branch's base with none. Null when unreadable. */
	deltaLines: number | null;
	/** Set for `merge_only`: the branch's base before the merges. */
	base?: string;
	/** Why a prior approval gives no `merge_only`: a key of ReviewInputs, `checks`, `review`, `rules: <path>`, `overlap: <path>` or `unreadable`. */
	changedInputs?: string[];
	/** Recorded at the launch: what this verifier reads. Its close stores them, so a later change is seen. */
	reviewInputs?: ReviewInputs;
};
type RunAfterApproval = { stage: string; status: string; progress_head: string | null };

/**
 * What an approval judged, besides the diff and the rule files, as one hash each. Null means evf could not read it, which
 * always counts as changed. A reopen clears the approval itself.
 */
export type ReviewInputs = Record<
	"ask" | "spec" | "goal" | "followUps" | "proofs" | "prBody" | "contract",
	string | null
>;

/**
 * The files that say how a verifier judges. A merge of main that changes one judges the branch by a new rule. The
 * manifest's shared_read_paths are added at the head. `evf.config.json` is in the contract, which leaves out other
 * tasks' entries because nearly every commit to it changes one.
 */
const REVIEW_RULES = [
	"AGENTS.md",
	"docs/START-HERE.md",
	"docs/build-agent-workflow.md",
	"docs/architecture/",
	".github/workflows/",
	".agents/",
	".claude/agents/",
];
const MANIFEST = "docs/plan/context-manifest.json";
export function ruleChanges(wt: string, prior: string, head: string): string[] {
	const shared = readJson<{ shared_read_paths: string[] }>(join(wt, MANIFEST)).shared_read_paths;
	if (!shared?.length) fail(`${MANIFEST} names no shared_read_paths.`);
	return git(wt, "diff", "--name-only", "--no-renames", prior, head)
		.split("\n")
		.filter((path) => [...REVIEW_RULES, ...shared].some((rule) => path.startsWith(rule)))
		.map((path) => `rules: ${path}`);
}

const hashOf = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** One hash of what `read` returns. Anything that stops it is an input evf cannot prove unchanged. */
function hashed(read: () => unknown): string | null {
	try {
		return hashOf(read());
	} catch {
		return null;
	}
}

/** The full text of each id the context names. An id with no text stops this: the contract is then unknown. */
function textsOf(wt: string, context: Context): unknown {
	const { requirements, cases } = currentCatalog(wt);
	const operations = new Map(
		readJson<{ operations: Array<{ id: string }> }>(join(wt, "docs/catalog/operations.json")).operations.map((o) => [
			o.id,
			o,
		]),
	);
	const contracts = new Map(
		Object.entries(
			readJson<{ contracts: Record<string, unknown> }>(join(wt, "docs/catalog/shared-contracts.json")).contracts,
		),
	);
	const source = (key: string): Map<string, unknown> | null =>
		key.endsWith("requirement_ids") || key === "case_requirements_at_start"
			? requirements
			: key.endsWith("case_ids")
				? cases
				: key.endsWith("operation_ids")
					? operations
					: key === "shared_contract_ids"
						? contracts
						: null;
	return Object.entries(context).flatMap(([key, ids]) => {
		const from = source(key);
		if (!from) return [];
		return (ids as string[]).map((id) => {
			if (!from.has(id)) fail(`${context.id} ${key} names ${id}, which has no text.`);
			return [id, from.get(id)];
		});
	});
}

/**
 * The task's contract in the repo at the worktree head: evf.config.json without other tasks' entries, then the package,
 * its context, and the text of each requirement, case, operation and shared contract the context names.
 */
export function contractOf(root: string, wt: string, task: TaskRef): string | null {
	return hashed(() => {
		const config = readJson<{ maintenanceTasks?: Record<string, unknown> }>(join(wt, "evf.config.json"));
		const own = { ...config, maintenanceTasks: config.maintenanceTasks?.[task.id] ?? null };
		const triage = task.kind === "fb" ? cachedTriage(root, task.issue!) : null;
		const wp = task.kind === "fb" ? triage?.wp : task.kind === "wp" ? task.wp : null;
		if (!wp) return [own, triage];
		const context = packageContext(wt, wp);
		return [
			own,
			triage,
			findPackage(loadDag(wt), wp),
			context,
			textsOf(wt, context),
			(context.acceptance_ids ?? []).map((id) => renderAc(wt, id)),
		];
	});
}

/** The proof rows a seat or person wrote. evf writes the AC: rows again at each close, from the tests at that head. */
export function proofsHash(db: DatabaseSync, taskId: number): string | null {
	return hashed(() =>
		db
			.prepare(
				"SELECT DISTINCT criterion, status, evidence_url, notes FROM proofs WHERE task_id = ? AND written_by IS NOT 'evf' ORDER BY criterion, status, evidence_url, notes",
			)
			.all(taskId),
	);
}

export function reviewInputs(
	db: DatabaseSync,
	root: string,
	taskId: number,
	task: TaskRef,
	wt: string,
	prBody: string,
): ReviewInputs {
	const row = () =>
		db.prepare("SELECT ask, title, spec, goal_id, parent_task_id, slice FROM tasks WHERE id = ?").get(taskId) as {
			ask: string;
			title: string;
			spec: string | null;
			goal_id: number | null;
			parent_task_id: number | null;
			slice: number | null;
		};
	return {
		// The events too: a store of the same text says someone changed their mind, and it costs one full review.
		ask: hashed(() => [
			row().title,
			row().ask,
			db
				.prepare(
					"SELECT type, payload FROM events WHERE task_id = ? AND type IN ('task_new', 'spec_set', 'reopen', 'handoff') ORDER BY id",
				)
				.all(taskId),
		]),
		spec: hashed(() => row().spec),
		goal: hashed(() => [
			db.prepare("SELECT title, body FROM goals WHERE key = 'project'").get(),
			row().goal_id
				? db.prepare("SELECT title, body FROM goals WHERE id = ?").get(row().goal_id!)
				: missionFor(db, task.wp),
		]),
		followUps: hashed(() => [
			row().parent_task_id,
			row().slice,
			followUpsOf(db, taskId).map((f) => [f.label, f.status, f.title]),
		]),
		proofs: proofsHash(db, taskId),
		prBody: hashed(() => readFileSync(prBody, "utf8")),
		contract: contractOf(root, wt, task),
	};
}

/**
 * The inputs that moved since the close that recorded `then`. A close with no record names every input. The approval also
 * needs its review on GitHub, because the prompt reads that review.
 */
export function changedInputs(
	then: ReviewInputs | undefined,
	now: ReviewInputs,
	wt: string,
	pr: number | null,
	prior: string,
	prBody: string,
): string[] {
	const moved = (Object.keys(now) as Array<keyof ReviewInputs>).filter((k) => now[k] === null || then?.[k] !== now[k]);
	return approvedOnGitHub(wt, pr, prior, prBody) ? moved : [...moved, "review"];
}
/** The latest review on the PR approves `head`, and its verifier is independent of the author in the PR body. */
function approvedOnGitHub(wt: string, pr: number | null, head: string, prBody: string): boolean {
	if (!pr) return false;
	try {
		const review = reviewsOf(wt, nameWithOwner(wt), pr, head).latest?.approval;
		const line = /^EVF-Author: (.+)$/m.exec(readFileSync(prBody, "utf8"))?.[1];
		const author = line ? readParty(JSON.parse(line)) : "no EVF-Author line";
		return (
			review?.head === head &&
			review.verdict === "approved" &&
			typeof author !== "string" &&
			independentReview(author, review.verifier) === null
		);
	} catch {
		return false;
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
 * that close. `changed` names what moved since it. `merge_only` is the last return and needs all of this: a prior head,
 * nothing in `changed`, at least one commit since, every commit a clean merge of main, no rule file in those merges, and no
 * path the branch changed. Anything that stops the proof gives `code`.
 */
export function verifyDelta(
	wt: string,
	main: string,
	prior: string | null,
	after: RunAfterApproval[],
	changed: string[],
): VerifyDelta {
	const head = git(wt, "rev-parse", "HEAD");
	if (!prior) {
		let deltaLines: number | null = null;
		try {
			deltaLines = changedLines(wt, git(wt, "merge-base", head, main), head);
		} catch {
			// The first review is a full one with or without this count.
		}
		return { head, priorApprovedHead: null, deltaKind: "code", deltaLines };
	}
	try {
		const known = { head, priorApprovedHead: prior, deltaLines: changedLines(wt, prior, head) };
		const merges = cleanMerges(wt, prior, head, main);
		const merged = typeof merges !== "string" && merges.length > 0;
		const refused = [...changed, ...ruleChanges(wt, prior, head)];
		const overlap = merged ? mergedMainOverlap(wt, prior, head, main) : null;
		if (overlap) refused.push(...overlap.overlap.map((path) => `overlap: ${path}`));
		if (refused.length) return { ...known, deltaKind: "code", changedInputs: refused };
		if (overlap) return { ...known, deltaKind: "merge_only", base: overlap.base };
		const simplified = head !== prior && onlySimplified(wt, main, prior, head, after);
		return { ...known, deltaKind: simplified ? "simplify" : "code" };
	} catch {
		return { head, priorApprovedHead: prior, deltaKind: "code", deltaLines: null, changedInputs: ["unreadable"] };
	}
}

/** The verifier's task when only main changed. Required CI and the exact-head review stay as they are. */
export function mergeOnlyPrompt(task: TaskRef, delta: VerifyDelta): string {
	const { head, priorApprovedHead: prior, base } = delta;
	return `Verify task ${task.id}: this is a merge-only review. The verifier approved the prior head ${prior}. Every commit from it to the merge result ${head} is a clean merge of main: evf recomputed each merge tree and it matches. Main changed no file of this branch, no rule file and nothing in the ask, spec, goal chain, follow-ups, proofs, PR body or task contract since that verifier started, and the author checks passed at the merge result. Limit your review to the merge result. Read git diff ${prior} ${head}, which is what main brought in, against the branch's own change in git diff ${base} ${prior}, and check whether what main changed breaks anything the branch calls or depends on. The approved review at the prior head stands for the rest: do not judge the rest of the diff again and do not rerun flows or bin/evf verify. Required CI on the exact head stays required, and evf ship checks it. Read the current PR body and confirm that it still describes the branch. Post one exact-head review with post-review.mjs --head ${head} --session <bin/evf session> --model claude-opus-5-5. Take the Ask coverage rows from the approved review at the prior head, and judge Code quality and Experience on the merge result. Close with bin/evf run done $EVF_RUN --status passed (approved), body-only (the merge result is approved, and every open finding is a PR body fix you posted as a present or absent text with --verdict body_only --body-items) or failed (changes requested) --summary-file <path> listing every finding.`;
}
