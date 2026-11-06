import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Wiki content on a branch (OPS-109): the claim check on its drafts and the promotion of the drafts that passed.
 * `bin/wiki claim-check` and `bin/wiki promote-all` run these on the current branch.
 */

export const WIKI_PREFIX = "docs/reference/wiki/";
const DRAFTS = `${WIKI_PREFIX}drafts/`,
	SEED = `${WIKI_PREFIX}seed.json`,
	MANIFEST = `${WIKI_PREFIX}manifest.json`;

type ClaimCheck = { status: string; reviewer: string; notes: string };
type Json = Record<string, unknown>;
export type DraftRow = Json & { id: string; draft: Json & { approver: unknown; claim_check: ClaimCheck } };

/** A refusal to show as one message. bin/evf reports this name the same way as its own errors. */
export class DraftError extends Error {
	name = "ToolError";
}
/** A promotion that stopped before anything was pushed. */
export class PromotionStopped extends DraftError {}

const fail = (message: string): never => {
	throw new DraftError(message);
};

function run(cmd: string, args: string[], cwd: string) {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
	});
	return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

export function git(cwd: string, ...args: string[]): string {
	const r = run("git", args, cwd);
	if (r.code !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout.trim();
}

/** The drafts a branch adds or changes against its merge base with `base`, as they exist at `head`. */
export function taskDrafts(repo: string, base: string, head: string): string[] {
	const from = git(repo, "merge-base", base, head);
	return git(repo, "diff", "--name-only", "--no-renames", "--diff-filter=AM", from, head, "--", DRAFTS)
		.split("\n")
		.filter((path) => path.endsWith(".json"));
}

export function parseDraft(path: string, text: string): DraftRow {
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

/**
 * `text` with its draft.claim_check values replaced in place, so every other byte of the draft stays. The result
 * must parse to the same draft with only the claim check changed; anything else refuses.
 */
function withClaimCheck(path: string, text: string, cc: ClaimCheck): string {
	const start = [...text.matchAll(/(?<!\\)"claim_check"\s*:\s*\{/g)].at(-1);
	if (!start) return fail(`${path} has no claim_check object to edit.`);
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
		fail(`The tool cannot edit the claim check of ${path} in place; edit it by hand and commit it.`);
	return out;
}

/**
 * Set every pending draft of the branch to passed with `reviewer` and the D-b notes form
 * `Approved <UTC time>: "<verbatim words>"`, in the worktree. Drafts with status passed or failed stay unchanged.
 * Returns the drafts it changed.
 */
export function recordClaimCheck(wt: string, base: string, reviewer: string, words: string): string[] {
	const notes = `Approved ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}: "${words}"`;
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

/** Commit the claim check of `paths` as one commit, and return the new head. `prefix` starts the subject. */
export function commitClaimCheck(wt: string, prefix: string, reviewer: string, paths: string[]): string {
	git(wt, "add", "--", ...paths);
	git(wt, "commit", "--quiet", "-m", `${prefix}Wiki claim check by ${reviewer} (${paths.length} drafts)`);
	return git(wt, "rev-parse", "HEAD");
}

/** The bytes of `paths` under `wt` as one string (latin1 keeps every byte); a missing path reads as null. */
const snapshot = (wt: string, paths: string[]) =>
	JSON.stringify(paths.map((path) => (existsSync(join(wt, path)) ? readFileSync(join(wt, path), "latin1") : null)));
const output = (r: { stdout: string; stderr: string }) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");

/**
 * Run `bin/wiki promote` (the `wiki` path) for each draft of the branch whose claim check passed, with `reviewed` as
 * the reviewed sha and the draft's own approver (D-d), then `bin/wiki check-seed`. Lint checks a draft's links against
 * the published seed only, so a draft that links to another draft of this PR passes once that draft is promoted. So it
 * promotes in passes: each pass tries the remaining drafts in path order, and a failed draft gets another try only when
 * the pass promoted some other draft and the failed attempt wrote nothing. A pass that promotes nothing stops with each
 * remaining draft's own `bin/wiki promote` output. Returns the promoted drafts in promotion order; a wiki tool failure
 * throws its error.
 */
export function promoteDrafts(wiki: string, wt: string, base: string, number: number, reviewed: string): string[] {
	const seedDir = ["--seed-dir", join(wt, WIKI_PREFIX)];
	const stopped = (what: string, detail: string): never => {
		throw new PromotionStopped(`${what} failed: ${detail}`);
	};
	let remaining = taskDrafts(wt, base, "HEAD")
		.map((path) => ({ path, draft: parseDraft(path, readFileSync(join(wt, path), "utf8")).draft }))
		.filter(({ draft }) => draft.claim_check.status === "passed");
	const promoted: string[] = [];
	while (remaining.length) {
		const failed: ((typeof remaining)[number] & { detail: string })[] = [];
		for (const { path, draft } of remaining) {
			const args = ["promote", join(wt, path), "--approved-by", String(draft.approver), "--pr", String(number)];
			const watched = [SEED, MANIFEST, path],
				before = snapshot(wt, watched);
			const r = run(wiki, [...args, "--reviewed-sha", reviewed, ...seedDir], wt);
			if (r.code === 0) promoted.push(path);
			else if (before !== snapshot(wt, watched))
				stopped(`bin/wiki promote ${path}`, `${output(r)}\nIt changed the seed, manifest or draft before it failed.`);
			else failed.push({ path, draft, detail: output(r) });
		}
		if (failed.length === remaining.length)
			stopped(
				failed.map((d) => `bin/wiki promote ${d.path}`).join(", "),
				failed.map((d) => `\n${d.path}:\n${d.detail}`).join(""),
			);
		remaining = failed;
	}
	if (promoted.length) {
		const r = run(wiki, ["check-seed", ...seedDir], wt);
		if (r.code !== 0) stopped("bin/wiki check-seed after promotion", (r.stderr || r.stdout).trim());
	}
	return promoted;
}

const baseOf = (wt: string, base?: string) =>
	base ?? (run("git", ["rev-parse", "--verify", "--quiet", "origin/main"], wt).code === 0 ? "origin/main" : "main");

/** The checkout and branch a branch command works on. Refuses main, a detached head and uncommitted changes. */
function cleanBranch(cwd: string): { wt: string; branch: string } {
	const wt = git(cwd, "rev-parse", "--show-toplevel");
	const branch = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
	if (branch === "HEAD" || branch === "main") fail("Run this on the branch that holds the drafts, not on main.");
	if (git(wt, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"))
		fail("The checkout has uncommitted changes. Commit or remove them first.");
	return { wt, branch };
}

/**
 * `wiki claim-check --reviewer "<name>" --approval "<words>"`: a named human or bot reviewer's claim check on every
 * pending draft of the current branch, in one commit, pushed when the checkout has an origin so the PR shows it.
 */
export function claimCheckBranch(cwd: string, opts: { reviewer: string; approval: string; base?: string }): string {
	const reviewer = opts.reviewer.trim(),
		words = opts.approval.trim();
	if (!reviewer) fail('Name the reviewer: --reviewer "<name>".');
	if (words.split(/\s+/).filter(Boolean).length < 2)
		fail(`Quote ${reviewer}'s approval in two words or more: --approval "<words>".`);
	const { wt, branch } = cleanBranch(cwd);
	const changed = recordClaimCheck(wt, baseOf(wt, opts.base), reviewer, words);
	if (!changed.length) return fail(`${branch} has no pending Wiki drafts, so there is no claim check to record.`);
	const head = commitClaimCheck(wt, "", reviewer, changed);
	if (run("git", ["remote", "get-url", "origin"], wt).code === 0)
		git(wt, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
	return `claim-check: ${changed.length} draft${changed.length === 1 ? "" : "s"} passed by ${reviewer} at ${head.slice(0, 10)}: ${changed.join(", ")}`;
}

/**
 * `wiki promote-all --pr <n>`: promotes every draft of the current branch whose claim check passed, in one local
 * commit. `reviewed` is the commit that was reviewed, by default HEAD. On any failure the checkout returns to where it
 * started. It does not push and it does not grant approval: bin/wiki promote still checks each draft's named approver.
 */
export function promoteBranch(
	cwd: string,
	wiki: string,
	opts: { pr: number; reviewed?: string; base?: string },
): string {
	const { wt } = cleanBranch(cwd);
	const start = git(wt, "rev-parse", "HEAD");
	try {
		const promoted = promoteDrafts(wiki, wt, baseOf(wt, opts.base), opts.pr, opts.reviewed ?? start);
		if (!promoted.length) return "promote-all: no draft on this branch has a passed claim check.";
		git(wt, "add", "--all", "--", WIKI_PREFIX);
		git(wt, "commit", "--quiet", "-m", `Promote ${promoted.length} Wiki drafts`);
		return `promote-all: ${promoted.length} promoted at ${git(wt, "rev-parse", "--short=10", "HEAD")}, not pushed: ${promoted.join(", ")}`;
	} catch (error) {
		git(wt, "reset", "--quiet", "--hard", start);
		throw error;
	}
}
