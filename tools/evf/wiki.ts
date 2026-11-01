import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
 * whose claim check passed. The verifier's pass carries over those commits only (wikiCarryProof).
 */

export const WIKI_PREFIX = "docs/reference/wiki/";
const DRAFTS = `${WIKI_PREFIX}drafts/`,
	SEED = `${WIKI_PREFIX}seed.json`,
	MANIFEST = `${WIKI_PREFIX}manifest.json`;

type ClaimCheck = { status: string; reviewer: string; notes: string };
type Json = Record<string, unknown>;
type DraftRow = Json & { id: string; draft: Json & { approver: unknown; claim_check: ClaimCheck } };

/** A UTC time to the second, the form claim-check notes use. */
const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** The D-b notes form: `Approved <UTC time>: "<verbatim words>"`. */
export const approvedNotes = (words: string): string => `Approved ${utcNow()}: "${words}"`;

/** The drafts a branch adds or changes against its merge base with `base`, as they exist at `head`. */
export function taskDrafts(repo: string, base: string, head: string): string[] {
	const from = git(repo, "merge-base", base, head);
	return git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", from, head, "--", DRAFTS)
		.split("\n")
		.filter((path) => path.endsWith(".json"));
}

function parseDraft(path: string, text: string): DraftRow {
	let row: unknown;
	try {
		row = JSON.parse(text);
	} catch (e) {
		fail(`${path} is not valid JSON: ${(e as Error).message}`);
	}
	const draft = (row as { draft?: { claim_check?: Json } } | null)?.draft;
	const cc = draft?.claim_check;
	if (!cc || !["status", "reviewer", "notes"].every((k) => typeof cc[k] === "string"))
		fail(`${path} has no draft.claim_check with string status, reviewer and notes. Run bin/wiki lint ${path}.`);
	return row as DraftRow;
}

/** The draft at `path` as committed at `rev`. */
const draftAt = (repo: string, rev: string, path: string): DraftRow =>
	parseDraft(path, git(repo, "show", `${rev}:${path}`));

/**
 * `text` with its draft.claim_check values replaced in place, so every other byte of the draft stays. The result
 * must parse to the same draft with only the claim check changed; anything else refuses.
 */
function withClaimCheck(path: string, text: string, cc: ClaimCheck): string {
	const start = [...text.matchAll(/(?<!\\)"claim_check"\s*:\s*\{/g)].at(-1);
	if (!start) fail(`${path} has no claim_check object to edit.`);
	const open = start.index + start[0].length - 1;
	let end = open;
	for (let depth = 0, inString = false; end < text.length; end++) {
		const c = text[end];
		if (inString) {
			if (c === "\\") end++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) break;
	}
	let object = text.slice(open, end + 1);
	for (const key of ["status", "reviewer", "notes"] as const)
		object = object.replace(
			new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`),
			(_, lead: string) => `${lead}${JSON.stringify(cc[key])}`,
		);
	const out = text.slice(0, open) + object + text.slice(end + 1);
	const expected = parseDraft(path, text);
	expected.draft.claim_check = cc;
	if (!isDeepStrictEqual(parseDraft(path, out), expected))
		fail(`evf cannot edit the claim check of ${path} in place; edit it by hand and commit it.`);
	return out;
}

/**
 * Set every pending draft of the branch to passed with `reviewer` and `notes`, in the worktree. Drafts with status
 * passed or failed stay unchanged. Returns the drafts it changed.
 */
export function recordClaimCheck(wt: string, base: string, reviewer: string, notes: string): string[] {
	const changed: string[] = [];
	for (const path of taskDrafts(wt, base, "HEAD")) {
		const file = join(wt, path),
			text = readFileSync(file, "utf8");
		if (parseDraft(path, text).draft.claim_check.status !== "pending") continue;
		writeFileSync(file, withClaimCheck(path, text, { status: "passed", reviewer, notes }));
		changed.push(path);
	}
	return changed;
}

/** Commit the claim check of `paths` as one commit on the task branch and return the new head. */
export function commitClaimCheck(wt: string, task: TaskRef, reviewer: string, paths: string[]): string {
	git(wt, "add", "--", ...paths);
	git(wt, "commit", "--quiet", "-m", `${task.id}: Wiki claim check by ${reviewer} (${paths.length} drafts)`);
	return git(wt, "rev-parse", "HEAD");
}

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
	const changed = recordClaimCheck(wt, baseRef(root, cfg), reviewer, approvedNotes(words));
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

/**
 * Run `bin/wiki promote` for each draft whose claim check passed, with the claim-check commit as the reviewed sha and
 * the draft's own approver (D-d), then `bin/wiki check-seed`. Returns the promoted drafts, or the wiki tool's error.
 */
export function promoteDrafts(
	root: string,
	wt: string,
	number: number,
	reviewed: string,
	drafts: string[],
): { promoted: string[] } | { error: string } {
	const wiki = wikiTool(root),
		seedDir = ["--seed-dir", join(wt, WIKI_PREFIX)];
	const promoted: string[] = [];
	for (const path of drafts) {
		const row = parseDraft(path, readFileSync(join(wt, path), "utf8"));
		if (row.draft.claim_check.status !== "passed") continue;
		const approver = String(row.draft.approver);
		const r = run(
			wiki,
			[
				"promote",
				join(wt, path),
				"--approved-by",
				approver,
				"--pr",
				String(number),
				"--reviewed-sha",
				reviewed,
				...seedDir,
			],
			{ cwd: wt },
		);
		if (r.code !== 0) return { error: `bin/wiki promote ${path} failed: ${(r.stderr || r.stdout).trim()}` };
		promoted.push(path);
	}
	if (promoted.length) {
		const r = run(wiki, ["check-seed", ...seedDir], { cwd: wt });
		if (r.code !== 0) return { error: `bin/wiki check-seed failed after promotion: ${(r.stderr || r.stdout).trim()}` };
	}
	return { promoted };
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
