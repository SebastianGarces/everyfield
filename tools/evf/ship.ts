import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	EvfError,
	evfDataDir,
	fail,
	baseRef,
	crossFamilyReview,
	crossFamilyReviewRefusal,
	findPackage,
	git,
	gitOk,
	hasRemote,
	isClean,
	isModelFamily,
	loadConfig,
	loadDag,
	pathsForPart,
	requireWorktree,
	run,
	sleep,
	type Config,
	type ModelFamily,
	type TaskRef,
} from "./lib.ts";
import { maintenanceScope, requireTaskScope } from "./policy.ts";
import { checkPrBody } from "./pr-body.ts";
import { withShipQueue, type QueueTiming } from "./ship-queue.ts";
import { formatScope, wpScope } from "./scope.ts";
import { recordProgress, type ShippedRecord } from "./progress.ts";
import { requireVerifiedHead } from "./verify.ts";
import { stack } from "./task.ts";
import { requireFreeMigrationNumbers } from "./migrations.ts";
import {
	cachedTriage,
	fbOwningPaths,
	feedbackTitle,
	internalIssueOf,
	isPrototype,
	onFeedbackShipped,
} from "./feedback.ts";

function gh(cwd: string, args: string[]): string {
	const r = run("gh", args, { cwd });
	if (r.code !== 0) fail(`gh ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout.trim();
}

function requireRemote(root: string, cfg: Config): void {
	if (!hasRemote(root, cfg))
		fail(`No "${cfg.remote}" git remote yet. Create the GitHub repository, add the remote, then retry.`);
}

function nameWithOwner(cwd: string): string {
	return gh(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
}

function postStatus(
	cwd: string,
	cfg: Config,
	sha: string,
	state: "pending" | "success" | "failure",
	description: string,
): void {
	gh(cwd, [
		"api",
		"-X",
		"POST",
		`repos/${nameWithOwner(cwd)}/statuses/${sha}`,
		"-f",
		`state=${state}`,
		"-f",
		`context=${cfg.statusContext}`,
		"-f",
		`description=${description.slice(0, 140)}`,
	]);
}

function pushBranch(wt: string, cfg: Config, task: TaskRef): void {
	git(wt, "push", "--quiet", "-u", cfg.remote, `HEAD:refs/heads/${task.branch}`);
}

function prFor(wt: string, task: TaskRef): { number: number; url: string; state: string } | null {
	const r = run("gh", ["pr", "view", task.branch, "--json", "number,url,state"], { cwd: wt });
	return r.code === 0 ? (JSON.parse(r.stdout) as { number: number; url: string; state: string }) : null;
}

function taskTitle(root: string, wt: string, task: TaskRef): string {
	if (task.kind === "ops") return maintenanceScope(wt, task).title;
	if (task.kind === "fb") return feedbackTitle(root, task.issue!);
	const pkg = findPackage(loadDag(root), task.wp);
	return `${pkg.title}${task.part ? ` (${task.part})` : ""}`;
}

function taskPaths(root: string, wt: string, task: TaskRef): string[] {
	if (task.kind === "ops") return maintenanceScope(wt, task).owningPaths;
	return task.kind === "fb" ? fbOwningPaths(root, task) : pathsForPart(findPackage(loadDag(root), task.wp), task.part);
}

export function prOpen(root: string, task: TaskRef, bodyFile?: string): number {
	if (bodyFile) bodyFile = resolve(bodyFile);
	const cfg = loadConfig(root);
	const wp = task.kind === "wp" ? task.wp : task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : undefined;
	const wt = requireWorktree(root, cfg, task);
	requireTaskScope(root, wt, task, wp);
	requireRemote(root, cfg);
	if (!isClean(wt)) fail("Commit your work first. The worktree is not clean.");
	const sha = requireVerifiedHead(root, task);
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	requireFreeMigrationNumbers(wt, baseRef(root, cfg), task);

	if (!bodyFile || !existsSync(bodyFile))
		fail("Write the PR body following the PR standard, then pass --body-file <file>.");
	const body = readFileSync(bodyFile, "utf8");
	const proto = isPrototype(root, task);
	checkPrBody(wt, body, proto ? "prototype" : "ordinary");
	const internal = internalIssueOf(root, task);
	if (internal && !body.includes(`Closes #${internal}`))
		fail(`Include Closes #${internal} in the PR body for this feedback task.`);
	pushBranch(wt, cfg, task);
	const existing = prFor(wt, task);
	if (existing && existing.state === "OPEN") {
		gh(wt, ["pr", "edit", String(existing.number), "--body-file", bodyFile]);
		console.log(`pr: updated ${existing.url}`);
	} else {
		const extra = proto ? ["--draft", "--label", "prototype"] : [];
		if (proto)
			gh(wt, [
				"label",
				"create",
				"prototype",
				"--force",
				"--description",
				"Prototype from feedback; waits for product review",
			]);
		const url = gh(wt, [
			"pr",
			"create",
			"--base",
			cfg.baseBranch,
			"--head",
			task.branch,
			"--title",
			`${task.id}: ${taskTitle(root, wt, task)}`,
			"--body-file",
			bodyFile,
			...extra,
		]);
		console.log(`pr: opened ${url}`);
	}
	if (proto) {
		postStatus(wt, cfg, sha, "pending", "Prototype: waits for Sebastian's product review");
		console.log(
			"next: this is a prototype. Report the PR to the coordinator; Sebastian reviews it. Do not run evf ship.",
		);
		return 0;
	}
	if (task.kind === "wp")
		console.log(formatScope(wpScope(wt, git(root, "rev-parse", baseRef(root, cfg)), task.wp, task.part)));
	console.log(
		`next: the coordinator delegates verification. The verifier runs: evf verify ${task.id} --role verifier, then evf ship ${task.id}`,
	);
	return 0;
}

const QUALITY_PRINCIPLES = [
	"laziness-protocol",
	"minimize-reader-load",
	"subtract-before-you-add",
	"test-behavior-not-implementation",
];
export type Approval = {
	head: string;
	verifierFamily: ModelFamily;
	verdict: "approved" | "changes_requested";
	quality: { verdict: "approved" | "changes_requested"; principles: string[] };
	experience: {
		verdict: "approved" | "changes_requested";
		budget: "met" | "exceeded" | "not_applicable";
		exception?: "reports" | "analytics";
	};
	packageClosures?: string[];
};
export type RequiredCheck = { name: string; bucket: string; state: string; link: string };
/** Required CI on one PR head, by name. Only a pass counts; skipped and cancelled checks are failures. */
type RequiredCi = { passed: RequiredCheck[]; failed: string[]; missing: string[]; pending: string[] };
/** Why an approval of `approvedHead` still holds at `head`: only clean merges of main, on paths the PR never changed. */
export type CarryProof = {
	approvedHead: string;
	head: string;
	merges: Array<{ commit: string; branchParent: string; mainParent: string }>;
	base: string;
	mainIncluded: string;
	overlap: string[];
};
export type MergeEvidence = {
	head: string;
	authorFamily: ModelFamily;
	approval: Approval;
	approvalUrl: string;
	checks: RequiredCheck[];
	checkedAt: string;
	carry?: CarryProof;
};
type PullRequest = {
	number: number;
	body: string;
	headRefOid: string;
	baseRefName: string;
	state: string;
	isDraft: boolean;
};

function readApproval(input: unknown): Approval | null {
	if (
		!input ||
		typeof input !== "object" ||
		!("head" in input) ||
		typeof input.head !== "string" ||
		!/^([a-f0-9]{40})$/.test(input.head)
	)
		return null;
	if (!("verifierFamily" in input) || !isModelFamily(input.verifierFamily)) return null;
	if (!("verdict" in input) || (input.verdict !== "approved" && input.verdict !== "changes_requested")) return null;
	if (!("quality" in input) || !input.quality || typeof input.quality !== "object") return null;
	const quality = input.quality;
	if (!("verdict" in quality) || (quality.verdict !== "approved" && quality.verdict !== "changes_requested"))
		return null;
	if (!("principles" in quality) || !Array.isArray(quality.principles)) return null;
	const principles = quality.principles;
	if (
		!principles.every((name): name is string => typeof name === "string" && name.trim().length > 0) ||
		!QUALITY_PRINCIPLES.every((name) => principles.includes(name))
	)
		return null;
	if (!("experience" in input) || !input.experience || typeof input.experience !== "object") return null;
	const experience = input.experience;
	if (!("verdict" in experience) || (experience.verdict !== "approved" && experience.verdict !== "changes_requested"))
		return null;
	if (
		!("budget" in experience) ||
		(experience.budget !== "met" && experience.budget !== "exceeded" && experience.budget !== "not_applicable")
	)
		return null;
	if ("exception" in experience && experience.exception !== "reports" && experience.exception !== "analytics")
		return null;
	let packageClosures: string[] | undefined;
	if ("packageClosures" in input) {
		const values = input.packageClosures;
		if (!Array.isArray(values) || !values.every((id): id is string => typeof id === "string" && /^WP-\d{3}$/.test(id)))
			return null;
		packageClosures = values;
	}
	return {
		head: input.head,
		verifierFamily: input.verifierFamily,
		verdict: input.verdict,
		quality: { verdict: quality.verdict, principles },
		experience: {
			verdict: experience.verdict,
			budget: experience.budget,
			...("exception" in experience ? { exception: experience.exception } : {}),
		},
		...(packageClosures ? { packageClosures } : {}),
	};
}

/**
 * The approval of `approved` carries to `head` only when every commit between them is a merge whose first parent
 * is the previous head and whose second parent is on main, each merge tree is the clean `git merge-tree` result,
 * and the PR's own changes share no path with what main changed since the PR's base. Returns the refusal reason.
 */
export function carryProof(repo: string, approved: string, head: string, main: string): CarryProof | string {
	if (!gitOk(repo, "merge-base", "--is-ancestor", approved, head))
		return `${approved.slice(0, 10)} is not an ancestor of ${head.slice(0, 10)}`;
	const merges: CarryProof["merges"] = [];
	for (let commit = head; commit !== approved;) {
		const parents = git(repo, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
		if (parents.length !== 2) return `${commit.slice(0, 10)} is not a merge of main`;
		const [branchParent, mainParent] = parents;
		if (!gitOk(repo, "merge-base", "--is-ancestor", approved, branchParent))
			return `${commit.slice(0, 10)} does not merge into the approved branch`;
		if (!gitOk(repo, "merge-base", "--is-ancestor", mainParent, main))
			return `${commit.slice(0, 10)} merges ${mainParent.slice(0, 10)}, which is not on main`;
		const clean = run("git", ["merge-tree", "--write-tree", branchParent, mainParent], { cwd: repo });
		if (clean.code !== 0 || clean.stdout.split("\n")[0] !== git(repo, "rev-parse", `${commit}^{tree}`))
			return `${commit.slice(0, 10)} differs from the clean merge of its parents`;
		merges.unshift({ commit, branchParent, mainParent });
		commit = branchParent;
	}
	const base = git(repo, "merge-base", approved, main),
		mainIncluded = git(repo, "merge-base", head, main);
	const paths = (from: string, to: string) =>
		git(repo, "diff", "--name-only", "--no-renames", from, to).split("\n").filter(Boolean);
	const mainPaths = new Set(paths(base, mainIncluded));
	const overlap = paths(base, approved).filter((path) => mainPaths.has(path));
	if (overlap.length) return `main changed paths this PR also changes: ${overlap.join(", ")}`;
	return { approvedHead: approved, head, merges, base, mainIncluded, overlap };
}

/**
 * The check names that branch protection and rulesets require on `base`. They come from the rules, never from
 * the checks a head reports so far: a required workflow that has not started yet reports nothing.
 */
function requiredCheckNames(cwd: string, repo: string, base: string): string[] {
	const names = new Set<string>();
	const protection = run("gh", ["api", `repos/${repo}/branches/${base}/protection`], { cwd });
	if (protection.code === 0) {
		const rsc = JSON.parse(protection.stdout)?.required_status_checks;
		for (const name of [...(rsc?.contexts ?? []), ...(rsc?.checks ?? []).map((c: { context: unknown }) => c.context)])
			if (typeof name === "string") names.add(name);
	} else if (!/HTTP 404/.test(protection.stderr))
		fail(`Branch protection of ${base} is unreadable: ${(protection.stderr || protection.stdout).trim()}`);
	const rules: unknown = JSON.parse(gh(cwd, ["api", `repos/${repo}/rules/branches/${base}`]));
	if (!Array.isArray(rules)) fail(`The rulesets of ${base} are unreadable.`);
	for (const rule of rules)
		if (rule?.type === "required_status_checks")
			for (const check of rule.parameters?.required_status_checks ?? [])
				if (typeof check?.context === "string") names.add(check.context);
	if (!names.size) fail(`${base} requires no status checks, so evf cannot prove required CI.`);
	return [...names].sort();
}

/** Matches the checks the PR head reports against the required names. A required name with no check is missing. */
function requiredCi(cwd: string, number: number, required: string[]): RequiredCi {
	const r = run("gh", ["pr", "checks", String(number), "--json", "name,state,bucket,link"], { cwd });
	let reported: RequiredCheck[] = [];
	try {
		const parsed: unknown = JSON.parse(r.stdout);
		if (Array.isArray(parsed)) reported = parsed;
	} catch {
		// gh prints nothing while the head reports no checks yet.
	}
	const ci: RequiredCi = { passed: [], failed: [], missing: [], pending: [] };
	for (const name of required) {
		const checks = reported.filter((c) => c?.name === name);
		if (!checks.length) ci.missing.push(name);
		else if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel" || c.bucket === "skipping"))
			ci.failed.push(name);
		else if (checks.every((c) => c.bucket === "pass" && typeof c.link === "string")) ci.passed.push(...checks);
		else ci.pending.push(name);
	}
	return ci;
}

/**
 * One unsigned review convention, shared by the verifier and GitHub merge workflow. `carry` lets an approval of
 * an earlier head hold over merge-only commits (carryProof); the owner approval routes never pass it.
 */
export function checkPr(
	root: string,
	number: number,
	expectedHead?: string,
	opts: { carry?: boolean } = {},
): MergeEvidence {
	const cfg = loadConfig(root);
	const pr: PullRequest = JSON.parse(
		gh(root, ["pr", "view", String(number), "--json", "number,body,headRefOid,baseRefName,state,isDraft"]),
	);
	if (pr.state !== "OPEN" || pr.isDraft || pr.baseRefName !== cfg.baseBranch)
		fail("Shipping requires an open, ready PR targeting main.");
	if (expectedHead && pr.headRefOid !== expectedHead)
		fail("PR head changed. Verify the new exact head before shipping.");
	const { authorFamily } = checkPrBody(root, pr.body);
	const repo = nameWithOwner(root);
	const ci = requiredCi(root, number, requiredCheckNames(root, repo, cfg.baseBranch));
	if (ci.failed.length) fail(`Required GitHub CI must be green on the exact PR head: ${ci.failed.join(", ")} failed.`);
	if (ci.missing.length) fail(`Required GitHub CI is missing on the exact PR head: ${ci.missing.join(", ")}.`);
	if (ci.pending.length)
		fail(`Required GitHub CI must be green on the exact PR head: ${ci.pending.join(", ")} pending.`);
	const checks = ci.passed;
	const pages = JSON.parse(gh(root, ["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"]));
	if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
		fail("GitHub verifier comments are unreadable.");
	const comments = pages.flat();
	let selected: { approval: Approval; url: string } | undefined, latest: typeof selected;
	let missingFields: string[] = [];
	for (const comment of comments)
		for (const match of String(comment?.body ?? "").matchAll(/^EVF-Review: (.+)$/gm)) {
			let value: unknown;
			try {
				value = JSON.parse(match[1]);
			} catch {
				continue;
			}
			if (value && typeof value === "object" && "head" in value && value.head === pr.headRefOid) {
				missingFields = ["quality", "experience"].filter((field) => !(field in value));
			}
			const approval = readApproval(value);
			if (!approval) continue;
			latest = { approval, url: typeof comment.html_url === "string" ? comment.html_url : "" };
			if (approval.head === pr.headRefOid) selected = latest;
		}
	let carry: CarryProof | undefined;
	if (!selected && opts.carry && latest?.approval.verdict === "approved") {
		const approved = latest.approval.head;
		if (!gitOk(root, "cat-file", "-e", `${approved}^{commit}`))
			run("git", ["fetch", "--quiet", cfg.remote, approved], { cwd: root });
		const proof = carryProof(root, approved, pr.headRefOid, baseRef(root, cfg));
		if (typeof proof === "string")
			fail(
				`Missing verifier approval for the exact PR head. The approval of ${approved.slice(0, 10)} does not carry: ${proof}.`,
			);
		[selected, carry] = [latest, proof];
	}
	if (!selected?.url || selected.approval.verdict !== "approved") {
		if (missingFields.length)
			fail(`Missing ${missingFields.join(" and ")} field in verifier review for the exact PR head.`);
		fail("Missing verifier approval for the exact PR head.");
	}
	if (selected.approval.quality.verdict !== "approved") fail("Code quality must be approved before shipping.");
	if (selected.approval.experience.verdict !== "approved") fail("Experience must be approved before shipping.");
	const experience = selected.approval.experience;
	if (
		experience.budget === "exceeded" &&
		(!experience.exception || !pr.body.split(/\r?\n/).includes(`EVF-Experience-Exception: ${experience.exception}`))
	)
		fail("Experience budget exceeded. Name the approved reports or analytics exception in the PR and review.");
	const checkedAtMs = Date.now();
	if (!crossFamilyReview(authorFamily, selected.approval.verifierFamily, checkedAtMs))
		fail(crossFamilyReviewRefusal(authorFamily, checkedAtMs));
	const current: PullRequest = JSON.parse(
		gh(root, ["pr", "view", String(number), "--json", "number,body,headRefOid,baseRefName,state,isDraft"]),
	);
	if (current.headRefOid !== pr.headRefOid || current.body !== pr.body || current.state !== "OPEN" || current.isDraft)
		fail("PR changed during merge checks. Run verification again.");
	return {
		head: pr.headRefOid,
		authorFamily,
		approval: selected.approval,
		approvalUrl: selected.url,
		checks,
		checkedAt: new Date(checkedAtMs).toISOString(),
		...(carry ? { carry } : {}),
	};
}

export type ShipTiming = { queue: QueueTiming; ciWaitMs: number; ciPollMs: number };
const SHIP_TIMING: ShipTiming = {
	queue: { waitMs: 60 * 60_000, pollMs: 2_000 },
	ciWaitMs: 30 * 60_000,
	ciPollMs: 20_000,
};

export function ship(root: string, task: TaskRef, timing: ShipTiming = SHIP_TIMING): number {
	const cfg = loadConfig(root),
		wp = task.kind === "wp" ? task.wp : task.kind === "fb" ? cachedTriage(root, task.issue!)?.wp : undefined;
	const wt = requireWorktree(root, cfg, task);
	requireTaskScope(root, wt, task, wp);
	requireRemote(root, cfg);
	if (isPrototype(root, task)) fail(`${task.id} is a prototype. Sebastian approves it in chat before evf approve.`);
	if (!isClean(wt)) fail("The task worktree must be clean before shipping.");
	const pr = prFor(wt, task);
	if (!pr || pr.state !== "OPEN") fail(`No open PR for ${task.branch}.`);
	if (cfg.mergePolicy.ordinary !== "automatic-after-independent-review")
		fail("Ordinary automatic merge is not approved.");
	const design = task.kind === "ops" && maintenanceScope(wt, task).route === "design",
		cls = task.kind === "fb" ? cachedTriage(root, task.issue!)?.class : undefined;
	// The PR #13 owner routes keep exact-head review and never merge here; only the merging routes queue and carry.
	if (design || (task.kind === "fb" && !(cfg.mergePolicy.feedbackVerifierMerge as string[]).includes(cls ?? "")))
		return ownerRoute(root, cfg, task, wt, pr.number, design, cls);
	return withShipQueue(root, task.id, () => queuedMerge(root, cfg, task, wt, pr.number, timing), timing.queue);
}

function ownerRoute(
	root: string,
	cfg: Config,
	task: TaskRef,
	wt: string,
	number: number,
	design: boolean,
	cls: string | undefined,
): number {
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const sha = git(wt, "rev-parse", "HEAD");
	requireFreeMigrationNumbers(wt, baseRef(root, cfg), task);
	const verification = checkPr(wt, number, sha);
	const verified = () =>
		postStatus(wt, cfg, sha, "success", `Verified by ${verification.approval.verifierFamily} at ${sha.slice(0, 10)}`);
	if (design) {
		verified();
		console.log(`PR #${number} is a verified design task and waits for Sebastian's chat approval, then evf approve.`);
		return 0;
	}
	if (!cls) fail("Feedback must be triaged before shipping.");
	if (!(cfg.mergePolicy.feedbackOwnerAfterVerifier as string[]).includes(cls))
		fail("This feedback class requires the owner approval route.");
	verified();
	console.log(`PR #${number} is verified and waits for Sebastian's chat approval, then evf approve.`);
	return 0;
}

/**
 * Runs inside the ship queue, so no other ship moves main meanwhile. Branch protection requires an up-to-date
 * branch: a behind PR gets a plain merge of main (`gh pr update-branch`, never a force push), waits for required
 * CI on the new head and merges only when its approval carries (carryProof). Anything else needs a fresh gate.
 */
function queuedMerge(root: string, cfg: Config, task: TaskRef, wt: string, number: number, timing: ShipTiming): number {
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	let sha = git(wt, "rev-parse", "HEAD");
	requireFreeMigrationNumbers(wt, baseRef(root, cfg), task);
	let verification = checkPr(wt, number, sha, { carry: true });
	const body = () => gh(wt, ["pr", "view", String(number), "--json", "body", "--jq", ".body"]);
	requireGreenMain(wt, cfg, body());
	for (let round = 1; !gitOk(wt, "merge-base", "--is-ancestor", baseRef(root, cfg), sha); round++) {
		if (round > 3) fail(`Main moved during ${round - 1} branch updates. Run evf ship ${task.id} again.`);
		const main = git(root, "rev-parse", baseRef(root, cfg)),
			approved = verification.approval.head,
			base = git(root, "merge-base", approved, main),
			paths = (to: string) => git(root, "diff", "--name-only", "--no-renames", base, to).split("\n").filter(Boolean);
		const mainPaths = new Set(paths(main)),
			overlap = paths(approved).filter((path) => mainPaths.has(path));
		if (overlap.length)
			fail(
				`Fresh gate needed: main changed paths this PR also changes: ${overlap.join(", ")}. Include current main, run CI and get a new verifier review. The branch is unchanged.`,
			);
		console.log(`ship: PR #${number} is behind ${cfg.baseBranch}; merging ${main.slice(0, 10)} into ${task.branch}.`);
		gh(wt, ["pr", "update-branch", String(number)]);
		git(wt, "fetch", "--quiet", cfg.remote, task.branch);
		git(wt, "merge", "--quiet", "--ff-only", "FETCH_HEAD");
		sha = git(wt, "rev-parse", "HEAD");
		waitForRequiredCi(wt, cfg, number, sha, timing);
		try {
			verification = checkPr(wt, number, sha, { carry: true });
		} catch (e) {
			if (e instanceof EvfError)
				fail(
					`Fresh gate needed at ${sha}: ${e.message} The branch now includes ${cfg.baseBranch} at ${main.slice(0, 10)}.`,
				);
			throw e;
		}
		git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	}
	const baseSha = git(root, "merge-base", sha, baseRef(root, cfg));
	requireGreenMain(wt, cfg, body());
	if (verification.carry) {
		const { approvedHead, merges, base, mainIncluded } = verification.carry;
		const proof = [
			`evf ship carries the ${verification.approval.verifierFamily} approval of ${approvedHead} to ${sha}.`,
			...merges.map((m) => `- ${m.commit}: clean merge of ${m.branchParent} (branch) and ${m.mainParent} (main)`),
			`PR paths (${base.slice(0, 10)}..${approvedHead.slice(0, 10)}) and main paths (${base.slice(0, 10)}..${mainIncluded.slice(0, 10)}) do not overlap. Required CI is green on ${sha}.`,
			"",
			`EVF-Carry: ${JSON.stringify(verification.carry)}`,
		].join("\n");
		gh(wt, ["pr", "comment", String(number), "--body", proof]);
		console.log(proof);
	}
	const merge = run("gh", ["pr", "merge", String(number), "--squash", "--match-head-commit", sha], { cwd: wt });
	if (merge.code !== 0)
		fail(
			`Merge refused: ${(merge.stderr || merge.stdout).trim()}. A changed head needs fresh CI and verifier approval.`,
		);
	return afterMerge(root, cfg, task, wt, number, verification, baseSha);
}

/**
 * Required checks of a new head start missing or pending; ship waits until every required name has passed.
 * Any failure means the merge of main broke something.
 */
function waitForRequiredCi(wt: string, cfg: Config, number: number, sha: string, timing: ShipTiming): void {
	const required = requiredCheckNames(wt, nameWithOwner(wt), cfg.baseBranch);
	const start = Date.now();
	for (let printed = 0; ;) {
		const ci = requiredCi(wt, number, required);
		if (ci.failed.length)
			fail(
				`Fresh gate needed at ${sha}: required CI failed after the merge of main (${ci.failed.join(", ")}). Fix the branch, then get a new verifier review.`,
			);
		if (!ci.missing.length && !ci.pending.length) return;
		const waited = Date.now() - start;
		if (waited >= timing.ciWaitMs)
			fail(
				`Required CI on ${sha} is still running after ${Math.round(waited / 60_000)} min (${[...ci.missing.map((n) => `${n} missing`), ...ci.pending.map((n) => `${n} pending`)].join(", ")}). Run evf ship again when it finishes.`,
			);
		if (waited >= printed * 60_000) {
			console.log(`ship: waiting for required CI on ${sha.slice(0, 10)}, ${Math.floor(waited / 60_000)} min.`);
			printed = Math.floor(waited / 60_000) + 1;
		}
		sleep(Math.min(timing.ciPollMs, timing.ciWaitMs - waited));
	}
}

const MAIN_CI_WORKFLOW = "ci.yml",
	MAIN_CI_ISSUE = "P0: CI failed on main";

/**
 * Main's latest finished CI run decides, not the issue state: a red main merges only the PR whose body says
 * Fixes #N for the open fail-forward issue. Cancelled and skipped runs prove nothing either way.
 */
function requireGreenMain(cwd: string, cfg: Config, body: string): void {
	const runs = JSON.parse(
		gh(cwd, [
			"run",
			"list",
			"--workflow",
			MAIN_CI_WORKFLOW,
			"--branch",
			cfg.baseBranch,
			"--event",
			"push",
			"--status",
			"completed",
			"--limit",
			"20",
			"--json",
			"conclusion,headSha,url",
		]),
	) as Array<{ conclusion: string; headSha: string; url: string }>;
	const latest = runs.find((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");
	if (!latest) fail(`Cannot find a finished ${MAIN_CI_WORKFLOW} run on ${cfg.baseBranch}.`);
	if (latest.conclusion === "success") return;
	const repo = nameWithOwner(cwd);
	const fixesOpenIssue = [...body.matchAll(/\bFixes #(\d+)\b/gi)].some(([, n]) => {
		const issue = JSON.parse(gh(cwd, ["api", `repos/${repo}/issues/${n}`])) as { state?: string; title?: string };
		return issue.state === "open" && issue.title === MAIN_CI_ISSUE;
	});
	if (!fixesOpenIssue)
		fail(
			`Main CI is red (${latest.conclusion} at ${latest.headSha.slice(0, 10)}, ${latest.url}). Only a PR whose body says Fixes #<n> for the open "${MAIN_CI_ISSUE}" issue may merge.`,
		);
}

function afterMerge(
	root: string,
	cfg: Config,
	task: TaskRef,
	wt: string,
	prNumber: number,
	verification: MergeEvidence,
	baseSha: string,
): number {
	const mergeSha = gh(wt, ["pr", "view", String(prNumber), "--json", "mergeCommit", "-q", ".mergeCommit.oid"]);
	const record = {
		task: task.id,
		package_id: task.kind === "wp" ? task.wp : null,
		pr: prNumber,
		merge_commit: mergeSha,
		shipped_at: new Date().toISOString(),
		part: task.part,
		package_completion: false,
		verified_head: verification.head,
		base_sha: baseSha,
		verification,
		evidence: {
			path: taskPaths(root, wt, task)[0] ?? "",
			commit: mergeSha,
			test: `GitHub required CI and ${verification.approval.verifierFamily} approval`,
			result: "passed",
			note: `${task.id} merged in PR #${prNumber} after cross-model verification at ${verification.head.slice(0, 10)}. ${verification.approvalUrl}`,
		},
	};
	const dir = join(evfDataDir(root), "shipped");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${task.slug}.json`), `${JSON.stringify(record, null, 2)}\n`);
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const recorded = recordProgress(root, record, false);
	console.log(`ship: merged PR #${prNumber} as ${mergeSha.slice(0, 10)}.`);
	if (task.kind === "fb") onFeedbackShipped(root, task);
	else if (recorded === false) console.log("ship: merged; no package progress recorded.");
	else
		console.log(
			`progress: recorded automatically; the coordinator reviews and acknowledges with evf shipped --clear ${task.id}.`,
		);

	if (task.kind !== "ops") stack(root, task, "down", true);
	const removed = run("git", ["worktree", "remove", wt], { cwd: root });
	if (removed.code === 0) {
		run("git", ["branch", "-D", task.branch], { cwd: root });
		console.log(`cleanup: removed ${wt}.`);
	} else console.log(`cleanup: could not remove ${wt}: ${removed.stderr.trim()}. Run evf gc later.`);
	console.log(`intent: call ws.git.unregisterRoot(${JSON.stringify(wt)}).`);
	return 0;
}

export function listShipped(root: string, clear: string[]): number {
	const dir = join(evfDataDir(root), "shipped");
	if (!existsSync(dir)) {
		console.log("[]");
		return 0;
	}
	const records = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({ path: join(dir, f), value: JSON.parse(readFileSync(join(dir, f), "utf8")) as ShippedRecord }));
	console.log(
		JSON.stringify(
			records.filter((r) => !r.value.acknowledged).map((r) => r.value),
			null,
			2,
		),
	);
	for (const id of clear) {
		const record = records.find((r) => r.value.task === id);
		if (!record) fail(`No retained shipped record for ${id}.`);
		recordProgress(root, record.value, true);
		record.value.acknowledged = true;
		writeFileSync(record.path, JSON.stringify(record.value, null, 2) + "\n");
	} // Acknowledgement clears the inbox and preserves milestone history.

	return 0;
}
