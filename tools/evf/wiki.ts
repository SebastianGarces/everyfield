import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as drafts from "../wiki/drafts.ts";
import {
	baseRef,
	fail,
	git,
	gitOk,
	hasRemote,
	isClean,
	loadConfig,
	requireWorktree,
	run,
	type TaskRef,
} from "./lib.ts";

/**
 * Wiki content on task branches (OPS-109). A task PR that changes a path under docs/reference/wiki/ merges only on
 * Sebastian's approval (merge.ts). Before that, evf records the claim check on the task's pending drafts (the verifier
 * through `evf ship`, or a named reviewer through `evf wiki claim-check`) and runs `bin/wiki promote` on each draft
 * whose claim check passed. The verifier's pass carries over those commits only (wikiCarryProof). The claim check and
 * promotion themselves moved to tools/wiki/drafts.ts behind `bin/wiki`; what stays here is v1's task and gate wrapping.
 */

export const WIKI_PREFIX = drafts.WIKI_PREFIX;
const SEED = `${WIKI_PREFIX}seed.json`,
	MANIFEST = `${WIKI_PREFIX}manifest.json`;

type Json = Record<string, unknown>;
type DraftRow = drafts.DraftRow;

/** Runs moved code, so a refusal from it stays an EvfError for every v1 caller. */
function asEvf<T>(work: () => T): T {
	try {
		return work();
	} catch (e) {
		if (e instanceof drafts.DraftError) fail(e.message);
		throw e;
	}
}

export const taskDrafts = (repo: string, base: string, head: string): string[] =>
	asEvf(() => drafts.taskDrafts(repo, base, head));

const parseDraft = (path: string, text: string): DraftRow => asEvf(() => drafts.parseDraft(path, text));

/** The draft at `path` as committed at `rev`. */
const draftAt = (repo: string, rev: string, path: string): DraftRow =>
	parseDraft(path, git(repo, "show", `${rev}:${path}`));

export const recordClaimCheck = (wt: string, base: string, reviewer: string, words: string): string[] =>
	asEvf(() => drafts.recordClaimCheck(wt, base, reviewer, words));

/** Commit the claim check of `paths` as one commit on the task branch and return the new head. */
export const commitClaimCheck = (wt: string, task: TaskRef, reviewer: string, paths: string[]): string =>
	asEvf(() => drafts.commitClaimCheck(wt, `${task.id}: `, reviewer, paths));

/**
 * `evf wiki claim-check <task> --reviewer "<name>" --approval "<words>"`: a named human or bot reviewer's claim check
 * on every pending draft of the task, in one commit on the task branch, pushed so the PR shows it.
 */
export function wikiClaimCheck(root: string, task: TaskRef, opts: { reviewer?: string; approval?: string }): number {
	const reviewer = opts.reviewer?.trim() ?? "",
		words = opts.approval?.trim() ?? "";
	if (!reviewer) fail('Name the reviewer: --reviewer "<name>".');
	if (words.split(/\s+/).filter(Boolean).length < 2)
		fail(`Quote ${reviewer}'s approval in two words or more: --approval "<words>".`);
	const cfg = loadConfig(root),
		wt = requireWorktree(root, cfg, task);
	if (!isClean(wt)) fail("The task worktree has uncommitted changes. Commit or remove them first.");
	const changed = recordClaimCheck(wt, baseRef(root, cfg), reviewer, words);
	if (!changed.length) fail(`${task.id} has no pending Wiki drafts, so there is no claim check to record.`);
	const head = commitClaimCheck(wt, task, reviewer, changed);
	if (hasRemote(root, cfg)) git(wt, "push", "--quiet", cfg.remote, `HEAD:refs/heads/${task.branch}`);
	console.log(
		`claim-check: ${changed.length} draft${changed.length === 1 ? "" : "s"} passed by ${reviewer} at ${head.slice(0, 10)}: ${changed.join(", ")}`,
	);
	return 0;
}

/** bin/wiki from the home checkout (the base branch's tool), with its own dependencies installed once. */
function wikiTool(root: string): string {
	const dir = join(root, "tools/wiki");
	if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"))) {
		const r = run("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-workspace"], { cwd: dir });
		if (r.code !== 0) fail(`The Wiki tool dependencies did not install: ${(r.stderr || r.stdout).trim()}`);
	}
	return join(root, "bin/wiki");
}

/** The home checkout's bin/wiki promotes the worktree's drafts. A stop names `evf ship`, which has pushed nothing yet. */
export function promoteDrafts(root: string, wt: string, base: string, number: number, reviewed: string): string[] {
	const wiki = wikiTool(root);
	try {
		return drafts.promoteDrafts(wiki, wt, base, number, reviewed);
	} catch (e) {
		if (e instanceof drafts.PromotionStopped) fail(`evf ship stopped before pushing anything: ${e.message}`);
		if (e instanceof drafts.DraftError) fail(e.message);
		throw e;
	}
}

/** Why the drafts at `head` still need a step before Sebastian's approval can merge it, or null when none is left. */
export function unfinishedDrafts(repo: string, base: string, head: string, task: TaskRef): string | null {
	const drafts = taskDrafts(repo, base, head).map((path) => ({
		path,
		status: draftAt(repo, head, path).draft.claim_check.status,
	}));
	if (!drafts.length) return null;
	const pending = drafts.filter((d) => d.status === "pending").map((d) => d.path),
		other = drafts.filter((d) => d.status !== "pending").map((d) => `${d.path} (claim check ${d.status})`);
	return [
		pending.length
			? `${pending.length} draft${pending.length === 1 ? " has" : "s have"} no claim check yet (${pending.join(", ")}). The verifier records it in bin/evf ship ${task.id}, or a named reviewer through bin/evf wiki claim-check ${task.id} --reviewer "<name>" --approval "<words>".`
			: "",
		other.length
			? `${other.length} draft${other.length === 1 ? " is" : "s are"} not promoted (${other.join(", ")}). bin/evf ship ${task.id} promotes a passed draft; a failed one needs a fix and a new review.`
			: "",
	]
		.filter(Boolean)
		.join(" ");
}

/** The commits evf added after the reviewed head: claim checks and promotions of the PR's own drafts, nothing else. */
export type WikiCarry = { approvedHead: string; head: string; claimChecked: string[]; promoted: string[] };

const showJson = (repo: string, rev: string, path: string): Json => JSON.parse(git(repo, "show", `${rev}:${path}`));
const without = (row: Json, ...keys: string[]): Json =>
	Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

/**
 * The verifier's approval of `approved` carries to `head` only when every change between them is one of: the
 * claim_check object of a draft the PR changes, the deletion of such a draft, and the seed and manifest changes
 * `bin/wiki promote` makes for exactly the deleted drafts. Returns the proof, or the reason it does not carry.
 */
export function wikiCarryProof(repo: string, approved: string, head: string, main: string): WikiCarry | string {
	if (!gitOk(repo, "merge-base", "--is-ancestor", approved, head))
		return `${approved.slice(0, 10)} is not an ancestor of ${head.slice(0, 10)}`;
	const reviewed = new Set(taskDrafts(repo, main, approved));
	const claimChecked: string[] = [],
		promoted: string[] = [];
	let seedChanged = false;
	const changes = git(repo, "diff", "--name-status", "--no-renames", approved, head).split("\n").filter(Boolean);
	for (const line of changes) {
		const [status, path = ""] = line.split("\t");
		if (path === SEED || path === MANIFEST) seedChanged = true;
		else if (!reviewed.has(path)) return `${path} is not a claim check or promotion of this PR's drafts`;
		else if (status === "D") promoted.push(path);
		else {
			const before = draftAt(repo, approved, path),
				after = draftAt(repo, head, path);
			if (
				!isDeepStrictEqual(
					{ ...after, draft: without(after.draft, "claim_check") },
					{ ...before, draft: without(before.draft, "claim_check") },
				)
			)
				return `${path} changes more than its claim_check`;
			claimChecked.push(path);
		}
	}
	if (seedChanged || promoted.length) {
		const why = promotionChanges(repo, approved, head, promoted);
		if (why) return why;
	}
	return { approvedHead: approved, head, claimChecked, promoted };
}

/** Whether seed.json and manifest.json changed from `from` to `to` exactly as promoting `drafts` does; the reason if not. */
function promotionChanges(repo: string, from: string, to: string, drafts: string[]): string | null {
	const rows = new Map(drafts.map((path) => [String(draftAt(repo, from, path).id), draftAt(repo, from, path)]));
	const oldSeed = showJson(repo, from, SEED),
		newSeed = showJson(repo, to, SEED);
	const articles = (seed: Json) => (seed.articles as Json[]) ?? [];
	const others = (seed: Json) => articles(seed).filter((a) => !rows.has(String(a.id)));
	if (
		!isDeepStrictEqual(without(oldSeed, "articles"), without(newSeed, "articles")) ||
		!isDeepStrictEqual(others(oldSeed), others(newSeed))
	)
		return "seed.json changes more than the promoted drafts' articles";
	for (const [id, row] of rows) {
		const article = articles(newSeed).find((a) => a.id === id);
		const at = article?.published_at;
		if (
			!article ||
			article.status !== "published" ||
			typeof at !== "string" ||
			article.updated_at !== at ||
			!isDeepStrictEqual(
				without(article, "status", "published_at", "updated_at"),
				without(row, "draft", "status", "published_at", "updated_at"),
			)
		)
			return `seed.json does not hold the reviewed article of ${drafts.find((d) => rows.get(id) === row)} as published`;
	}
	const oldManifest = showJson(repo, from, MANIFEST),
		newManifest = showJson(repo, to, MANIFEST);
	const entries = (m: Json, key: string) => ((m[key] as Json[]) ?? []).filter((e) => !rows.has(String(e.id)));
	const releases = (m: Json) => (m.releases as Json[]) ?? [];
	const added = releases(newManifest).slice(releases(oldManifest).length);
	if (
		!isDeepStrictEqual(
			without(oldManifest, "articles", "releases", "seedPayloadSHA256"),
			without(newManifest, "articles", "releases", "seedPayloadSHA256"),
		) ||
		!isDeepStrictEqual(entries(oldManifest, "articles"), entries(newManifest, "articles")) ||
		!isDeepStrictEqual(releases(oldManifest), releases(newManifest).slice(0, releases(oldManifest).length)) ||
		added.length !== rows.size ||
		!added.every((r) => rows.has(String(r.id))) ||
		newManifest.seedPayloadSHA256 !==
			createHash("sha256")
				.update(run("git", ["show", `${to}:${SEED}`], { cwd: repo }).stdout)
				.digest("hex")
	)
		return "manifest.json changes more than the promoted drafts' release records";
	return null;
}
