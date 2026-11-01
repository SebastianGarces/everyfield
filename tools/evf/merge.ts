import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	baseRef,
	commonDir,
	committedConfig,
	EvfError,
	fail,
	hasRemote,
	run,
	type Config,
	type RunResult,
	type TaskRef,
} from "./lib.ts";
import { DEFAULT_DOCUMENT_TEMPLATES } from "./policy.ts";
import { WIKI_PREFIX } from "./wiki.ts";

/**
 * The one place evf merges a pull request (OPS-83). `evf ship` and `evf approve` both call `mergePullRequest`;
 * a test fails when any other file in tools/evf merges. Two rules live here so no caller can skip them:
 *
 * 1. The running evf code is the base branch's evf code. A long process (the drive) loads tools/evf once, so a
 *    merge rule that lands later never reaches it. Such a process refuses to merge; it never merges on old rules.
 * 2. A PR in the document-template class (mergePolicy.documentTemplates, classified on the exact sha being
 *    merged, from the base branch's config) merges only with Sebastian's recorded approval for that head.
 *    Any doubt about the class counts as the class.
 * 3. A PR whose exact-head diff changes Wiki content (any path under docs/reference/wiki/, OPS-109) merges only with
 *    his recorded approval for that head too. Doubt holds it under rule 2.
 */

/** The evf code a process runs: the git trees of tools/evf and bin/evf, as they were when the process loaded it. */
export type CodeIdentity = { checkout: string; commit: string; evfTree: string; binTree: string; dirty: boolean };

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readCodeIdentity(checkout: string): CodeIdentity | undefined {
	const ids = run("git", ["-C", checkout, "rev-parse", "HEAD", "HEAD:tools/evf", "HEAD:bin/evf"]);
	const status = run("git", ["-C", checkout, "status", "--porcelain", "--", "tools/evf", "bin/evf"]);
	const [commit, evfTree, binTree] = ids.stdout.trim().split("\n");
	if (ids.code !== 0 || status.code !== 0 || !commit || !evfTree || !binTree) return undefined;
	return { checkout, commit, evfTree, binTree, dirty: status.stdout.trim() !== "" };
}

/** Read once, at load: later edits or pulls in the checkout do not change the code this process already runs. */
const readAtLoad = readCodeIdentity(CODE_ROOT);
type BaseCode = { commit: string; evfTree: string; binTree: string };
let claimed: ((base: BaseCode) => CodeIdentity | undefined) | undefined;

/** Tests claim an identity for the process (a function of the base code); null restores the one read at load. */
export function setLoadedCode(code: ((base: BaseCode) => CodeIdentity | undefined) | null): void {
	claimed = code ?? undefined;
}

/** Fetches the base branch; returns why it failed, or undefined. A local-only repository has nothing to fetch. */
function fetchBase(root: string, cfg: Config): string | undefined {
	if (!hasRemote(root, cfg)) return undefined;
	const fetched = run("git", ["-C", root, "fetch", "--quiet", cfg.remote, cfg.baseBranch]);
	return fetched.code === 0 ? undefined : `git fetch ${cfg.remote} ${cfg.baseBranch} failed: ${fetched.stderr.trim()}`;
}

function baseCode(root: string, cfg: Config, fetchError: string | undefined): BaseCode | string {
	if (fetchError) return fetchError;
	const ref = baseRef(root, cfg),
		base = run("git", ["-C", root, "rev-parse", ref]);
	if (base.code !== 0) return `git rev-parse ${ref} failed: ${base.stderr.trim()}`;
	// A base without tools/evf has no evf code to compare; the empty trees never equal a running process's.
	const trees = run("git", ["-C", root, "rev-parse", `${ref}:tools/evf`, `${ref}:bin/evf`]);
	const [evfTree = "", binTree = ""] = trees.code === 0 ? trees.stdout.trim().split("\n") : [];
	return { commit: base.stdout.trim(), evfTree, binTree };
}

/** The reason this process's evf code may not merge, or undefined when it matches the base branch. */
function staleCode(root: string, cfg: Config, fetchError = fetchBase(root, cfg)): string | undefined {
	const base = baseCode(root, cfg, fetchError);
	if (typeof base === "string") return `evf cannot read the ${cfg.baseBranch} code to compare: ${base}`;
	const code = claimed ? claimed(base) : readAtLoad;
	const rerun = `Update the home checkout to ${cfg.baseBranch} (git -C ${root} merge --ff-only ${baseRef(root, cfg)}), then rerun the command from it.`;
	if (!code)
		return `evf cannot tell which code it runs (${CODE_ROOT} is not a readable git checkout). Base ${cfg.baseBranch} is ${base.commit.slice(0, 10)}. ${rerun}`;
	const names = `The running evf code is at ${code.commit.slice(0, 10)} (${code.checkout}); ${cfg.baseBranch} is at ${base.commit.slice(0, 10)}.`;
	if (code.dirty)
		return `${names} The checkout has uncommitted changes in tools/evf or bin/evf, so evf does not trust its merge rules. ${rerun}`;
	if (code.evfTree !== base.evfTree || code.binTree !== base.binTree)
		return `${names} tools/evf or bin/evf differ from ${cfg.baseBranch}, so a merge rule may be missing here. ${rerun}`;
	return undefined;
}

export type TemplateClass = { paths: string[]; doubt?: string };

/** The paths the PR at exactly `sha` changes against its merge base with the base branch, or why that is unknown. */
function changedPaths(root: string, cfg: Config, sha: string, fetchError: string | undefined): TemplateClass {
	const doubt = (why: string): TemplateClass => ({ paths: [], doubt: why });
	if (!/^[0-9a-f]{40}$/.test(sha)) return doubt(`the head to merge is not a full commit sha (${JSON.stringify(sha)})`);
	if (fetchError) return doubt(fetchError);
	const base = baseRef(root, cfg);
	if (run("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`]).code !== 0)
		return doubt(`commit ${sha.slice(0, 10)} is not in the repository`);
	const mergeBase = run("git", ["-C", root, "merge-base", base, sha]);
	if (mergeBase.code !== 0 || !mergeBase.stdout.trim())
		return doubt(
			`git merge-base ${base} ${sha.slice(0, 10)} failed: ${mergeBase.stderr.trim() || "no common ancestor"}`,
		);
	// --no-renames counts both sides of a rename.
	const diff = run("git", ["-C", root, "diff", "--name-only", "--no-renames", mergeBase.stdout.trim(), sha]);
	if (diff.code !== 0) return doubt(`git diff to ${sha.slice(0, 10)} failed: ${diff.stderr.trim()}`);
	return { paths: diff.stdout.split("\n").filter(Boolean) };
}

/**
 * Whether the PR at exactly `sha` is in the document-template class, decided from the base branch's config and
 * the whole diff from the merge base, so splitting a change across commits never leaves it. `evf ship`, `evf approve`
 * and the merge all decide the class here. A failed step returns `doubt` with a reason; the caller treats doubt as the class.
 */
export function templateClass(
	root: string,
	cfg: Config,
	sha: string,
	fetchError = fetchBase(root, cfg),
): TemplateClass {
	const changed = changedPaths(root, cfg, sha, fetchError);
	if (changed.doubt) return changed;
	const base = baseRef(root, cfg);
	let entries: string[];
	try {
		entries = (committedConfig(root, base).mergePolicy.documentTemplates ?? DEFAULT_DOCUMENT_TEMPLATES).paths;
	} catch (e) {
		if (!(e instanceof EvfError) && !(e instanceof SyntaxError)) throw e;
		return { paths: [], doubt: `the ${base} evf.config.json is unreadable: ${e.message}` };
	}
	// An entry that ends in `/` matches every path under it; any other entry matches one file.
	const matches = (path: string) =>
		entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
	return { paths: changed.paths.filter(matches) };
}

/** The Wiki-content paths (D-a: under docs/reference/wiki/) the PR at exactly `sha` changes, decided as templateClass does. */
export function wikiClass(root: string, cfg: Config, sha: string, fetchError = fetchBase(root, cfg)): TemplateClass {
	const changed = changedPaths(root, cfg, sha, fetchError);
	return changed.doubt ? changed : { paths: changed.paths.filter((path) => path.startsWith(WIKI_PREFIX)) };
}

/** Sebastian's words for one PR and one exact head. Only `evf approve --owner-approval` builds it. */
type OwnerApproval = { quote: string; approved_head: string };

type MergeRequest = {
	root: string;
	cfg: Config;
	/** The checkout gh runs in; absent means the caller's directory. */
	cwd?: string;
	number: number;
	/** The exact head, passed to --match-head-commit. */
	sha: string;
	ownerApproval?: OwnerApproval;
};

/** Up to five matched paths, and a count when there are more. */
const shown = (paths: string[]) =>
	`${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, ... (${paths.length} paths in all)` : ""}`;

/** Why a PR is held as a template PR: up to five matched paths, a count when there are more, or the doubt. */
export function templateWhy({ paths, doubt }: TemplateClass): string {
	const more = paths.length > 5 ? ` (${paths.length} paths in all)` : "";
	return doubt
		? `evf cannot tell whether it changes document templates (${doubt}), so it holds it as if it did`
		: `it changes document-template paths (${paths.slice(0, 5).join(", ")})${more}`;
}

/** Why a task PR is held as Wiki content. */
export const wikiWhy = ({ paths }: TemplateClass): string => `it changes Wiki content (${shown(paths)})`;

/** The command that records Sebastian's approval for a held PR. */
export const approveCommand = (number: number): string =>
	`Sebastian approves each document-template PR; after his approval in chat, run: bin/evf approve ${number} --owner-approval "<his words>"`;

/** The command that records Sebastian's approval for a held Wiki-content task PR, bound to its head. */
export const wikiApproveCommand = (number: number, head: string): string =>
	`Sebastian approves each Wiki change; after his approval in chat, run: bin/evf approve ${number} --owner-approval "<his words>" --head ${head}`;

/** Every PR merge in tools/evf. Refusals throw EvfError before gh runs; a gh failure returns its result. */
export function mergePullRequest(req: MergeRequest): RunResult {
	const { root, cfg, number, sha, ownerApproval } = req;
	const fetchError = fetchBase(root, cfg);
	const stale = staleCode(root, cfg, fetchError);
	if (stale) fail(`evf does not merge PR #${number}: ${stale}`);
	const cls = templateClass(root, cfg, sha, fetchError),
		wiki = cls.doubt ? cls : wikiClass(root, cfg, sha, fetchError);
	const held =
		cls.doubt || cls.paths.length
			? `${templateWhy(cls)}. ${approveCommand(number)}`
			: wiki.paths.length
				? `${wikiWhy(wiki)}. ${wikiApproveCommand(number, sha)}`
				: undefined;
	if (held) {
		if (!ownerApproval || ownerApproval.quote.trim().split(/\s+/).filter(Boolean).length < 2)
			fail(`evf does not merge PR #${number}: ${held}`);
		if (ownerApproval.approved_head !== sha)
			fail(
				`evf does not merge PR #${number}: Sebastian approved ${ownerApproval.approved_head.slice(0, 10)}, not ${sha.slice(0, 10)}. His approval does not carry over to a new head.`,
			);
	}
	return run("gh", ["pr", "merge", String(number), "--squash", "--match-head-commit", sha], { cwd: req.cwd });
}

/**
 * A detached checkout of the base branch's current commit under the Git common dir, created once per commit.
 * The drive runs its ship stage here when its own loaded code is behind.
 */
function baseCodeCheckout(root: string, cfg: Config): string {
	const ref = baseRef(root, cfg),
		sha = run("git", ["-C", root, "rev-parse", `${ref}^{commit}`]).stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) fail(`evf cannot read ${ref} to check out its code.`);
	const dir = join(commonDir(root), "evf-code");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, sha.slice(0, 12)),
		at = () => run("git", ["-C", path, "rev-parse", "HEAD"]).stdout.trim();
	if (existsSync(path) && at() === sha) return path;
	if (existsSync(path)) run("git", ["-C", root, "worktree", "remove", "--force", path]);
	const added = run("git", ["-C", root, "worktree", "add", "--detach", path, sha]);
	// A second drive may have created it between the check and the add.
	if (added.code !== 0 && at() !== sha) fail(`evf cannot check out ${sha.slice(0, 10)}: ${added.stderr.trim()}`);
	return path;
}

/**
 * Runs `evf ship` for the drive. Code that matches the base ships in this process; code that is behind runs the
 * ship in a child from the base checkout, so the merge always follows the current rules.
 */
export function shipOnCurrentCode(root: string, cfg: Config, task: TaskRef, inProcess: () => number): number {
	if (!staleCode(root, cfg)) return inProcess();
	const checkout = baseCodeCheckout(root, cfg);
	const r = run(
		process.execPath,
		["--disable-warning=ExperimentalWarning", join(checkout, "tools/evf/main.ts"), "ship", task.id],
		{ cwd: root },
	);
	if (r.stdout.trim()) console.log(r.stdout.trim());
	if (r.code !== 0) fail(r.stderr.trim() || `evf ship ${task.id} exited ${r.code}`);
	return 0;
}
