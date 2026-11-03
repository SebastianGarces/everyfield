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
import { DEFAULT_DOCUMENT_TEMPLATES, DEFAULT_OWNER_PATHS } from "./policy.ts";
import { WIKI_PREFIX } from "./wiki.ts";
import { carryProof, type CarryProof } from "./ship.ts";

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
 * 4. A PR in the owner-path class (mergePolicy.ownerPaths: the landing and marketing site, OPS-111) merges only with his
 *    recorded approval for that head. It is classified with rule 2's diff and rules, and doubt counts as the class.
 * 5. A PR with an `EVF-Owner` record (OPS-121) merges only a head that the latest record covers: the approved head, or
 *    a head that carryProof reaches from it. Any other commit voids his approval until he approves the new head.
 *
 * `evf ship` and `evf drive` also refuse at their start on stale code (`requireCurrentCode`), before any GitHub write.
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

/**
 * Refuses when the running evf code differs from the base branch: `evf ship` and `evf drive` call it at their start,
 * before any GitHub write. `refusal` opens the message, for example "evf ship does not merge PR #7".
 */
export function requireCurrentCode(
	root: string,
	cfg: Config,
	refusal: string,
	fetchError = fetchBase(root, cfg),
): void {
	const stale = staleCode(root, cfg, fetchError);
	if (stale) fail(`${refusal}: ${stale}`);
}

/** The matched paths of one class for one exact head, or why evf cannot tell. Doubt counts as the class. */
export type PathClass = { paths: string[]; doubt?: string };

/** The paths the PR at exactly `sha` changes against its merge base with the base branch, or why that is unknown. */
function changedPaths(root: string, cfg: Config, sha: string, fetchError: string | undefined): PathClass {
	const doubt = (why: string): PathClass => ({ paths: [], doubt: why });
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
 * The two classes that hold a PR that would otherwise merge through evf ship, for one exact head: the matched
 * document-template paths and the matched owner paths (mergePolicy.ownerPaths, OPS-111: the landing and marketing
 * site), or why evf cannot tell. Doubt counts as both classes.
 */
export type HeldClasses = { templates: string[]; owner: string[]; doubt?: string };

/**
 * `evf ship`, `evf approve` and the merge decide whether a PR is held here. The policies are read from the base
 * branch's committed config (an absent key uses the built-in default in policy.ts) and matched over the whole diff
 * from the merge base, so splitting a change across commits never leaves a class. An entry that ends in `/` matches
 * every path under it; any other entry matches one file. A failed step returns `doubt` with a reason.
 */
export function heldClasses(root: string, cfg: Config, sha: string, fetchError = fetchBase(root, cfg)): HeldClasses {
	const doubt = (why: string): HeldClasses => ({ templates: [], owner: [], doubt: why });
	const changed = changedPaths(root, cfg, sha, fetchError);
	if (changed.doubt) return doubt(changed.doubt);
	const base = baseRef(root, cfg);
	let policy: Config["mergePolicy"];
	try {
		policy = committedConfig(root, base).mergePolicy;
	} catch (e) {
		if (!(e instanceof EvfError) && !(e instanceof SyntaxError)) throw e;
		return doubt(`the ${base} evf.config.json is unreadable: ${e.message}`);
	}
	const matching = ({ paths: entries }: { paths: string[] }) =>
		changed.paths.filter((path) =>
			entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)),
		);
	return {
		templates: matching(policy.documentTemplates ?? DEFAULT_DOCUMENT_TEMPLATES),
		owner: matching(policy.ownerPaths ?? DEFAULT_OWNER_PATHS),
	};
}

/** Whether the PR at exactly `sha` is in the document-template class, as `heldClasses` decides it. */
export function templateClass(root: string, cfg: Config, sha: string, fetchError = fetchBase(root, cfg)): PathClass {
	const { templates, doubt } = heldClasses(root, cfg, sha, fetchError);
	return doubt ? { paths: [], doubt } : { paths: templates };
}

/** Whether the owner-path class holds the PR: a matched path or doubt. */
export const ownerHeld = (h: HeldClasses): boolean => !!h.doubt || h.owner.length > 0;
/** Whether either class holds the PR. */
export const isHeld = (h: HeldClasses): boolean => ownerHeld(h) || h.templates.length > 0;

/** The Wiki-content paths (D-a: under docs/reference/wiki/) the PR at exactly `sha` changes, decided as templateClass does. */
export function wikiClass(root: string, cfg: Config, sha: string, fetchError = fetchBase(root, cfg)): PathClass {
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

/** Up to five matched paths in parentheses, and a count when there are more. */
const shown = (paths: string[]) =>
	`(${paths.slice(0, 5).join(", ")})${paths.length > 5 ? ` (${paths.length} paths in all)` : ""}`;

/** Why a PR is held: the matched paths of each class (shown), or the doubt. */
export function heldWhy({ templates, owner, doubt }: HeldClasses): string {
	if (doubt)
		return `evf cannot tell whether it changes document templates or landing and marketing owner paths (${doubt}), so it holds it as if it did`;
	const changes = [
		templates.length ? `document-template paths ${shown(templates)}` : "",
		owner.length ? `landing and marketing owner paths ${shown(owner)}` : "",
	].filter(Boolean);
	return `it changes ${changes.join(" and ")}`;
}

/** Why a task PR is held as Wiki content. */
export const wikiWhy = ({ paths }: PathClass): string => `it changes Wiki content ${shown(paths)}`;

/**
 * The command that records Sebastian's approval for a held PR. The owner-path class binds it to the exact head;
 * the document-template class alone keeps its OPS-80 command.
 */
export const heldApproveCommand = (h: HeldClasses, number: number, head: string): string =>
	ownerHeld(h)
		? `Sebastian approves each landing and marketing PR for its exact head; after his approval in chat, run: bin/evf approve ${number} --owner-approval "<his words>" --head ${head}`
		: `Sebastian approves each document-template PR; after his approval in chat, run: bin/evf approve ${number} --owner-approval "<his words>"`;

/** The command that records Sebastian's approval for a held Wiki-content task PR, bound to its head. */
export const wikiApproveCommand = (number: number, head: string): string =>
	`Sebastian approves each Wiki change; after his approval in chat, run: bin/evf approve ${number} --owner-approval "<his words>" --head ${head}`;

/**
 * Sebastian's recorded approval of one PR head (OPS-121): one `EVF-Owner:` line in a PR comment, which `evf approve
 * --head` posts. The latest valid line on the PR wins. Like EVF-Review, it is unsigned coordination evidence.
 */
export type OwnerRecord = { head: string; quote: string; at: string };
export const ownerLine = (r: OwnerRecord): string => `EVF-Owner: ${JSON.stringify(r)}`;

function readOwnerRecord(value: unknown): OwnerRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { head, quote, at } = value as Record<string, unknown>;
	if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head) || typeof quote !== "string" || typeof at !== "string")
		return undefined;
	return { head, quote, at };
}

/** The latest valid EVF-Owner record in the PR's comments, oldest comment first. Unreadable comments refuse. */
function ownerRecordOf(cwd: string | undefined, number: number): OwnerRecord | undefined {
	const gh = (args: string[]) => {
		const r = run("gh", args, { cwd });
		if (r.code !== 0)
			fail(
				`evf does not merge PR #${number}: it cannot read the PR's owner approval records (gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}).`,
			);
		return r.stdout.trim();
	};
	const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	const pages: unknown = JSON.parse(gh(["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"]));
	if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
		fail(`evf does not merge PR #${number}: its comments are unreadable, so evf cannot read an owner approval.`);
	let latest: OwnerRecord | undefined;
	for (const comment of pages.flat())
		for (const match of String(comment?.body ?? "").matchAll(/^EVF-Owner: (.+)$/gm)) {
			let value: unknown;
			try {
				value = JSON.parse(match[1]);
			} catch {
				continue;
			}
			latest = readOwnerRecord(value) ?? latest;
		}
	return latest;
}

/** The commits on the PR's own line after `from` up to `to`, oldest first, as "<short sha> <subject>". */
export function commitsAfter(root: string, from: string, to: string): string[] {
	const r = run("git", ["-C", root, "log", "--first-parent", "--reverse", "--format=%h %s", `${from}..${to}`]);
	return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** The commit list a voided or stale owner approval names. */
export const commitList = (commits: string[]): string =>
	commits.length
		? `Commits after the approved head, oldest first:\n${commits.map((c) => `- ${c}`).join("\n")}`
		: "evf cannot list the commits after the approved head.";

/** The command that records Sebastian's approval of `head` for an ordinary-route PR. */
export const ownerApproveCommand = (number: number, head: string): string =>
	`After Sebastian approves the new head in chat, run: bin/evf approve ${number} --owner-approval "<his words>" --head ${head}`;

/** Every refusal of a voided owner approval carries this phrase; the drive's ship stage waits on it, with no new round. */
export const OWNER_VOID = "Sebastian's owner approval is void";

/** What a merge records about the owner approval that covers its head; `carry` is set when the head moved after it. */
export type OwnerCover = { quote: string; approved_head: string; approved_at: string; carry?: CarryProof };

/**
 * Rule 5: undefined for a PR without an EVF-Owner record; otherwise the cover of `sha`, or a refusal that names the
 * commits after the approved head, carryProof's reason and the approve command for `sha`.
 */
export function ownerCover(
	root: string,
	cfg: Config,
	cwd: string | undefined,
	number: number,
	sha: string,
): OwnerCover | undefined {
	const record = ownerRecordOf(cwd, number);
	if (!record) return undefined;
	const cover = { quote: record.quote, approved_head: record.head, approved_at: record.at };
	if (record.head === sha) return cover;
	if (run("git", ["-C", root, "cat-file", "-e", `${record.head}^{commit}`]).code !== 0)
		run("git", ["-C", root, "fetch", "--quiet", cfg.remote, record.head]);
	let proof: CarryProof | string;
	try {
		proof = carryProof(root, record.head, sha, baseRef(root, cfg));
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		proof = e.message;
	}
	if (typeof proof !== "string") return { ...cover, carry: proof };
	fail(
		[
			`evf does not merge PR #${number}: ${OWNER_VOID}. He approved ${record.head.slice(0, 10)} ("${record.quote}"); the head is ${sha.slice(0, 10)}, and his approval does not carry: ${proof}.`,
			commitList(commitsAfter(root, record.head, sha)),
			ownerApproveCommand(number, sha),
		].join("\n"),
	);
}

/**
 * Every PR merge in tools/evf. Refusals throw EvfError before gh runs; a gh failure returns its result. `owner` is
 * the EVF-Owner approval that covers the merged head, when the PR has one.
 */
export function mergePullRequest(req: MergeRequest): RunResult & { owner?: OwnerCover } {
	const { root, cfg, number, sha, ownerApproval } = req;
	const fetchError = fetchBase(root, cfg);
	requireCurrentCode(root, cfg, `evf does not merge PR #${number}`, fetchError);
	const classes = heldClasses(root, cfg, sha, fetchError),
		wiki = classes.doubt ? undefined : wikiClass(root, cfg, sha, fetchError);
	const held = isHeld(classes)
		? `${heldWhy(classes)}. ${heldApproveCommand(classes, number, sha)}`
		: wiki?.paths.length
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
	const owner = ownerCover(root, cfg, req.cwd, number, sha);
	const merged = run("gh", ["pr", "merge", String(number), "--squash", "--match-head-commit", sha], { cwd: req.cwd });
	return owner ? { ...merged, owner } : merged;
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
