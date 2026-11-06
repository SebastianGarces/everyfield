import { existsSync } from "node:fs";
import {
	baseRef,
	committedMaintenanceEntry,
	EvfError,
	fail,
	git,
	loadConfig,
	parseTask,
	run,
	worktreePath,
	type Config,
	type TaskRef,
} from "./lib.ts";
import { ensureTask, markMergedByBranch, openWorkDb } from "./db.ts";
import { cachedTriage } from "./feedback.ts";
import {
	commitsAfter,
	heldClasses,
	isHeld,
	mergePullRequest,
	ownerApproveCommand,
	ownerCover,
	ownerHeld,
	ownerLine,
	ownerMergeLine,
	ownerMergeRecordOf,
	ownerRecordOf,
	requireCurrentCode,
	wikiClass,
	type OwnerMergeRecord,
} from "./merge.ts";
import { unfinishedDrafts } from "./wiki.ts";
import {
	afterMerge,
	carryProof,
	checkPr,
	mainMergeRefusal,
	requiredCheckNames,
	requiredCi,
	requireGreenMain,
	ship,
	SHIP_TIMING,
	waitForRequiredCi,
	type MergeEvidence,
	type ShipTiming,
} from "./ship.ts";
import { withShipQueue } from "./ship-queue.ts";
import { APPROVED_PROTOTYPE, mayChangePrototype, registrationRule } from "./policy.ts";
import { recordOwnerAnswer } from "./owner-queue.ts";

/**
 * Human-approved merge for the PRs that never merge automatically: Wiki articles, prototypes, and
 * the verifier-passed P2/P3 feedback fixes (mergePolicy.feedbackOwnerAfterVerifier) and design tasks
 * (entry route "design"), and the document-template PRs (mergePolicy.documentTemplates), landing and
 * marketing PRs (mergePolicy.ownerPaths, OPS-111; these need --head) and Wiki-content task PRs (OPS-109) that would
 * otherwise merge through evf ship. An ordinary task PR that evf ship merges gets his recorded approval of one exact head
 * (`--head`, OPS-121): an EVF-Owner line that every later merge must cover. Every other PR refuses before any write.
 * Every route posts that line for the head it merges, so a stale record never blocks his new approval (OPS-129).
 * Sebastian approves in chat; the agent runs this with his words. Agents never run it without that approval for this PR.
 * It records the approval on the PR, binds it to the exact head commit, and squash-merges.
 * When main is protected, it also posts the evf/verify status for that head.
 * A held PR that is behind main takes a clean merge of main with no path overlap first (OPS-146, `mergeMain`): his words
 * cover that merge, and an EVF-Owner-Merge line records them with the approved head and the merged head.
 */

type Pr = {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	headRefOid: string;
	mergeStateStatus: string;
	body: string;
	files: Array<{ path: string }>;
};
/**
 * `template` and `wiki-task` are task PRs evf ship would merge: they get the verifier checks and evf ship's after-merge
 * steps. A `template` route names its held classes in `what`; `needsHead` is set for the owner-path class.
 */
type Route =
	| { kind: "wiki" | "prototype" }
	| { kind: "verified"; id: string }
	| { kind: "wiki-task"; id: string; task: TaskRef }
	| { kind: "template"; id: string; task: TaskRef; what: string; needsHead: boolean }
	| { kind: "ordinary"; id: string; task: TaskRef };

function gh(args: string[]): string {
	const r = run("gh", args);
	if (r.code !== 0) fail(`gh ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout.trim();
}

const readPr = (n: number): Pr =>
	JSON.parse(
		gh([
			"pr",
			"view",
			String(n),
			"--json",
			"number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,body,files",
		]),
	) as Pr;

/** Fetch the PR head: a design task's registration is the one reviewed there, never the home checkout's file. */
function fetchHead(root: string, cfg: Config, pr: Pr): void {
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch, pr.headRefName);
	if (git(root, "rev-parse", `${cfg.remote}/${pr.headRefName}`) !== pr.headRefOid)
		fail(`PR #${pr.number} head moved while evf read it. Check the new head, then retry.`);
}

/** Only the PR classes the owner policy names may merge on his approval; everything else refuses before any write. */
function routeOf(root: string, cfg: Config, pr: Pr): Route {
	const fb = /^task\/fb-(\d+)$/.exec(pr.headRefName);
	const ops = /^task\/ops-(\d+)$/.exec(pr.headRefName)?.[1];
	const task = ops ? parseTask(`OPS-${ops}`) : undefined;
	if (task) fetchHead(root, cfg, pr);
	const design = task && committedMaintenanceEntry(root, task.id, pr.headRefOid);
	if (task && design?.route === "design") {
		const owns = (path: string) =>
			registrationRule(task, path) ??
			((path !== APPROVED_PROTOTYPE || mayChangePrototype(design)) &&
				design.owningPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)));
		const other = pr.files.map((f) => f.path).filter((path) => !owns(path));
		if (other.length)
			fail(
				`PR #${pr.number} is a design task but changes files outside its owning paths or ${APPROVED_PROTOTYPE} (${other.slice(0, 3).join(", ")}).`,
			);
		return { kind: "verified", id: task.id };
	}
	if (/^wiki\/[\w.-]+$/.test(pr.headRefName)) {
		const other = pr.files.map((f) => f.path).filter((path) => !path.startsWith("docs/reference/wiki/"));
		if (other.length)
			fail(
				`PR #${pr.number} is on a Wiki branch but changes files outside docs/reference/wiki/ (${other.slice(0, 3).join(", ")}). evf approve merges only Wiki article changes.`,
			);
		return { kind: "wiki" };
	}
	// The document-template class: a PR evf ship would otherwise merge, whose exact-head diff touches a template path.
	const taskBranch = /^task\/(wp-\d{3}(?:-(?:contract|api|ui))?|ops-[1-9]\d*|fb-\d+)$/.exec(pr.headRefName)?.[1];
	if (taskBranch) {
		const ref = parseTask(taskBranch.replace(/^(wp-\d{3})-(\w+)$/, "$1/$2").replace(/^wp-/, "WP-"));
		const cls = fb ? cachedTriage(root, Number(fb[1]))?.class : undefined;
		const merges = !fb || (!!cls && (cfg.mergePolicy.feedbackVerifierMerge as string[]).includes(cls));
		// A head evf cannot fetch has no diff to read; the PR falls through to the refusals below, before any write.
		const fetched =
			!!task || run("git", ["-C", root, "fetch", "--quiet", cfg.remote, cfg.baseBranch, pr.headRefName]).code === 0;
		if (merges && fetched) {
			if (!task) fetchHead(root, cfg, pr);
			// Doubt about a class is the class, as in the merge: the held PR must stay approvable.
			const held = heldClasses(root, cfg, pr.headRefOid);
			if (!held.doubt && wikiClass(root, cfg, pr.headRefOid).paths.length)
				return { kind: "wiki-task", id: ref.id, task: ref };
			if (isHeld(held)) {
				const owner = ownerHeld(held);
				const what = [
					held.doubt || held.templates.length ? "document templates" : "",
					owner ? "landing and marketing owner paths" : "",
				]
					.filter(Boolean)
					.join(" and ");
				return { kind: "template", id: ref.id, task: ref, what, needsHead: owner };
			}
			return { kind: "ordinary", id: ref.id, task: ref };
		}
	}
	if (!fb)
		fail(
			`PR #${pr.number} (${pr.headRefName}) is not a Wiki article, prototype, P2/P3 feedback fix or design task, so evf approve cannot merge it. Ordinary builds and other OPS tasks merge through the verifier: bin/evf ship <task>.`,
		);
	const id = `FB-${fb[1]}`;
	const cls = cachedTriage(root, Number(fb[1]))?.class;
	if (!cls)
		fail(
			`${id} has no local triage record, so its merge route is unknown. Triage it again on this machine (bin/evf feedback triage ${fb[1]} ...), then retry. evf approve does not guess.`,
		);
	if (cls === "feature-small") return { kind: "prototype" };
	if ((cfg.mergePolicy.feedbackOwnerAfterVerifier as string[]).includes(cls)) return { kind: "verified", id };
	if ((cfg.mergePolicy.feedbackVerifierMerge as string[]).includes(cls))
		fail(`${id} is ${cls}. It merges through the verifier, not evf approve: bin/evf ship ${id}`);
	fail(`${id} is triaged ${cls}, which has no merge route through evf approve.`);
}

/**
 * His approval of one exact head: one PR comment with its EVF-Owner line and, for a route with a task, an `approvals`
 * row (gate owner). The latest record then covers this head, whatever earlier record the PR has.
 */
function recordOwnerApproval(root: string, n: number, task: TaskRef | undefined, head: string, words: string): void {
	const at = new Date().toISOString();
	gh([
		"pr",
		"comment",
		String(n),
		"--body",
		`Approved by Sebastian at \`${head.slice(0, 10)}\`:\n\n> ${words.replace(/\n/g, "\n> ")}\n\n${ownerLine({ head, quote: words, at })}`,
	]);
	if (!task) return;
	const db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		db.prepare(
			"INSERT INTO approvals (task_id, gate, approver, head_sha, decision, quote, created_at) VALUES (?, 'owner', 'Sebastian', ?, 'approved', ?, ?)",
		).run(t.id, head, words, at);
	} finally {
		db.close();
	}
}

/**
 * A rerun finishes the merge that an earlier `evf approve` started (a CI wait ran out, or the process died): the head is
 * the one its EVF-Owner-Merge line names, his latest record is still that approval and the head still carries from it.
 * Any later commit, or a merge of main by anyone else, has no such line and needs his approval of the new head.
 */
function resumedMerge(root: string, cfg: Config, pr: Pr, named: string | undefined): OwnerMergeRecord | undefined {
	const record = ownerMergeRecordOf(root, pr.number);
	if (record?.merged_head !== pr.headRefOid || (named && !record.approved_head.startsWith(named))) return undefined;
	if (ownerRecordOf(root, pr.number)?.head !== record.approved_head) return undefined;
	fetchHead(root, cfg, pr);
	const proof = carryProof(root, record.approved_head, pr.headRefOid, baseRef(root, cfg));
	return typeof proof === "string" ? undefined : record;
}

/**
 * Merges main into a held PR's branch (a plain merge, never a force push) until the branch includes main, and waits for
 * required CI on each new head. Inside the ship queue, so no ship moves main during those steps. Returns the final head.
 */
function mergeMain(
	root: string,
	cfg: Config,
	pr: Pr,
	approved: string,
	quote: string,
	again: string,
	postVerified: (sha: string) => void,
	timing: ShipTiming,
): string {
	const n = pr.number,
		rerun = `bin/evf approve ${n} --owner-approval "<his words>" --head ${approved}`;
	let sha = pr.headRefOid;
	for (let round = 1; ; round++) {
		if (round > 3) fail(`Main moved during ${round - 1} branch updates. Run ${rerun} again.`);
		// The queue wait and the CI wait both let main move, and a ship ahead in the queue is what moves it. This fetches
		// main and refuses if it landed evf code. The checks below then judge the main GitHub is about to merge, so stale
		// code or an overlap refuses before the branch changes.
		requireCurrentCode(root, cfg, `evf approve does not merge PR #${n}`);
		// As in evf ship: a red main stays out of the branch, because the failure would strand his approval on that head.
		requireGreenMain(root, cfg, gh(["pr", "view", String(n), "--json", "body", "--jq", ".body"]));
		const main = git(root, "rev-parse", baseRef(root, cfg)),
			refusal = mainMergeRefusal(root, approved, sha, main);
		if (refusal)
			fail(
				round === 1
					? notMerged(n, cfg, refusal, again)
					: `PR #${n} holds evf approve's merge of ${cfg.baseBranch} at ${sha}, and ${cfg.baseBranch} moved again to ${main.slice(0, 10)}. evf approve did not merge that newer ${cfg.baseBranch}: ${refusal}. Update the branch (gh pr update-branch ${n}), then ${again}.`,
			);
		console.log(`approve: PR #${n} is behind ${cfg.baseBranch}; merging ${main.slice(0, 10)} into ${pr.headRefName}.`);
		gh(["pr", "update-branch", String(n)]);
		// With the base branch: carryProof below must see the main GitHub merged.
		git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch, pr.headRefName);
		sha = git(root, "rev-parse", `${cfg.remote}/${pr.headRefName}`);
		// Anything but a clean merge of main voids his approval here, before his words reach the new head.
		ownerCover(root, cfg, undefined, n, sha);
		const record = { quote, approved_head: approved, merged_head: sha, at: new Date().toISOString() };
		gh([
			"pr",
			"comment",
			String(n),
			"--body",
			`evf approve merged \`${cfg.baseBranch}\` into this branch. Sebastian approved \`${approved.slice(0, 10)}\`; the merged head is \`${sha.slice(0, 10)}\`.\n\n> ${quote.replace(/\n/g, "\n> ")}\n\n${ownerMergeLine(record)}`,
		]);
		postVerified(sha);
		waitForRequiredCi(root, cfg, n, sha, timing, rerun);
		git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
		if (run("git", ["-C", root, "merge-base", "--is-ancestor", baseRef(root, cfg), sha]).code === 0) return sha;
	}
}

/** The refusal of a PR whose branch evf approve did not change. */
const notMerged = (n: number, cfg: Config, why: string, again: string): string =>
	`PR #${n} is behind ${cfg.baseBranch}, and evf approve did not merge ${cfg.baseBranch} into it: ${why}. The branch is unchanged. Update it (gh pr update-branch ${n}), then ${again}.`;

/**
 * The ordinary route (OPS-121): the record, and with a verifier approval and green required CI it merges through evf
 * ship; otherwise it keeps the record and names what is missing. A behind branch is fine: ship's update is a clean
 * merge of main, which carries his approval.
 */
function approveOrdinary(root: string, n: number, task: TaskRef, head: string, words: string): number {
	recordOwnerApproval(root, n, task, head, words);
	console.log(`Recorded Sebastian's approval of ${head.slice(0, 10)} on PR #${n}.`);
	recordOwnerAnswer(root, task.branch, head);
	try {
		checkPr(root, n, head, { carry: true });
	} catch (e) {
		if (!(e instanceof EvfError)) throw e;
		console.log(
			`evf approve merges nothing yet: ${e.message} The record stays; once that holds, run: bin/evf ship ${task.id}`,
		);
		return 0;
	}
	return ship(root, task);
}

export function approve(
	root: string,
	n: number,
	opts: { ownerApproval?: string; head?: string },
	timing: ShipTiming = SHIP_TIMING,
): number {
	const words = opts.ownerApproval?.trim() ?? "";
	if (words.split(/\s+/).filter(Boolean).length < 2)
		fail(
			'Quote Sebastian\'s approval for this PR: evf approve <PR> --owner-approval "<his words>". Never run this without his approval in chat.',
		);
	if (opts.head !== undefined && !/^[0-9a-f]{7,40}$/.test(opts.head))
		fail("--head must be the approved commit SHA (at least 7 hex characters).");
	const cfg = loadConfig(root);
	const pr = readPr(n);
	if (pr.state !== "OPEN") fail(`PR #${n} is ${pr.state.toLowerCase()}.`);
	if (pr.baseRefName !== cfg.baseBranch) fail(`PR #${n} targets ${pr.baseRefName}, not ${cfg.baseBranch}.`);
	const route = routeOf(root, cfg, pr);
	const head = pr.headRefOid,
		shipRoute = route.kind === "template" || route.kind === "wiki-task";
	if (route.kind === "ordinary" && !opts.head)
		fail(
			`PR #${n} (${pr.headRefName}) is an ordinary task PR, so evf approve cannot merge it without the head Sebastian approved; it merges through the verifier: bin/evf ship ${route.id}. To record his approval of the current head, run: bin/evf approve ${n} --owner-approval "<his words>" --head ${head}`,
		);
	const again =
		route.kind === "verified" || shipRoute
			? `have the verifier pass the new head (bin/evf ship ${route.id}), then ask Sebastian to approve it`
			: "ask Sebastian to approve the new head";
	// Sebastian approves a landing or marketing PR for one exact head, so the command names it (OPS-111).
	if (route.kind === "template" && route.needsHead && !opts.head)
		fail(
			`PR #${n} changes ${route.what}. Name the head Sebastian approved: bin/evf approve ${n} --owner-approval "<his words>" --head ${head}`,
		);
	const resumed = route.kind === "ordinary" ? undefined : resumedMerge(root, cfg, pr, opts.head);
	const approved = resumed?.approved_head ?? head,
		quote = resumed?.quote ?? words;
	// A record for another head voids the merge unless this approval replaces it, and only an exact head replaces it.
	const stale = opts.head || resumed ? undefined : ownerRecordOf(root, n);
	if (stale && stale.head !== head)
		fail(
			`PR #${n} has Sebastian's approval of ${stale.head.slice(0, 10)} ("${stale.quote}"), but its head is ${head.slice(0, 10)}. Name the head he approves. ${ownerApproveCommand(n, head)}`,
		);
	if (opts.head && !resumed && !head.startsWith(opts.head))
		fail(
			`PR #${n} head is ${head.slice(0, 10)}, not the ${opts.head} Sebastian approved. His approval does not carry over: ${route.kind === "ordinary" || route.kind === "template" ? ownerApproveCommand(n, head) : `${again}.`}\n${commitsAfter(root, opts.head, head)}`,
		);
	if (route.kind === "ordinary") return approveOrdinary(root, n, route.task, head, words);
	// His words cover a clean merge of main with no path overlap (OPS-146). Anything else refuses before any write. A
	// conflicting PR reports DIRTY, not BEHIND, and refuses the same way.
	const needsMain = pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY";
	if (needsMain) {
		requireCurrentCode(root, cfg, `evf approve does not merge PR #${n}`);
		requireGreenMain(root, cfg, pr.body);
		let why: string | undefined;
		try {
			fetchHead(root, cfg, pr);
			why = mainMergeRefusal(root, approved, head, baseRef(root, cfg));
		} catch (e) {
			if (!(e instanceof EvfError)) throw e;
			why = e.message.split("\n")[0];
		}
		if (why) fail(notMerged(n, cfg, why, again));
	}

	// A Wiki task PR merges only with every draft claim-checked and promoted (OPS-109).
	const unfinished = route.kind === "wiki-task" && unfinishedDrafts(root, baseRef(root, cfg), head, route.task);
	if (unfinished) fail(`PR #${n} is not ready for Sebastian's approval at ${head.slice(0, 10)}: ${unfinished}`);

	const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	let evidence: MergeEvidence | undefined,
		baseSha = "";
	// A rerun waits as the first run did; its merge of main is the only change after the verifier's pass.
	if (resumed)
		waitForRequiredCi(
			root,
			cfg,
			n,
			head,
			timing,
			`bin/evf approve ${n} --owner-approval "<his words>" --head ${approved}`,
		);
	if (route.kind === "verified" || shipRoute) {
		try {
			evidence = checkPr(root, n, head, resumed ? { carry: true } : { wikiCarry: route.kind === "wiki-task" });
		} catch (e) {
			// A held task PR waits for the verifier's pass first; name the command that gives it.
			if (shipRoute && e instanceof EvfError)
				fail(
					`PR #${n} changes ${route.kind === "template" ? route.what : "Wiki content"} and needs the verifier to pass it first (bin/evf ship ${route.id}) at ${head.slice(0, 10)}: ${e.message}`,
				);
			throw e;
		}
		const status = JSON.parse(gh(["api", `repos/${repo}/commits/${approved}/status`])) as {
			statuses: Array<{ context: string; state: string; description: string | null }>;
		};
		const verified = status.statuses.find((s) => s.context === cfg.statusContext);
		if (verified?.state !== "success" || !verified.description?.startsWith("Verified"))
			fail(
				`PR #${n} needs the verifier to pass it first (bin/evf ship ${route.id}) at ${approved.slice(0, 10)}; a branch update needs a fresh verification.`,
			);
		baseSha = git(root, "merge-base", head, baseRef(root, cfg));
	}
	if (!resumed) recordOwnerApproval(root, n, "task" in route ? route.task : undefined, head, words);
	if (pr.isDraft) gh(["pr", "ready", String(n)]);
	const protectedMain = run("gh", ["api", `repos/${repo}/branches/${cfg.baseBranch}/protection`]).code === 0;
	const postVerified = (sha: string) => {
		if (!protectedMain) return;
		gh([
			"api",
			"-X",
			"POST",
			`repos/${repo}/statuses/${sha}`,
			"-f",
			"state=success",
			"-f",
			`context=${cfg.statusContext}`,
			"-f",
			`description=Approved by Sebastian at ${approved.slice(0, 10)}${sha === approved ? "" : `; main merged at ${sha.slice(0, 10)}`}`,
		]);
	};
	const merge = (sha: string) => {
		// The checks of the head that merges, read while the PR is open, for the shipped record.
		const checks = evidence && requiredCi(root, n, requiredCheckNames(root, repo, cfg.baseBranch)).passed;
		const merged = mergePullRequest({
			root,
			cfg,
			number: n,
			sha,
			ownerApproval: { quote, approved_head: approved },
		});
		if (merged.code !== 0) fail(`The merge failed: ${(merged.stderr || merged.stdout).trim()}`);
		return { sha, owner: merged.owner, checks };
	};
	const {
		sha: final,
		owner,
		checks,
	} = needsMain
		? withShipQueue(
				root,
				"id" in route ? route.id : `PR #${n}`,
				() => merge(mergeMain(root, cfg, pr, approved, quote, again, postVerified, timing)),
				timing.queue,
			)
		: (postVerified(head), merge(head));
	console.log(
		`Merged PR #${n} (${pr.title}) at ${final.slice(0, 10)} with Sebastian's approval${final === approved ? "" : ` of ${approved.slice(0, 10)}`}.`,
	);
	recordOwnerAnswer(root, pr.headRefName, approved);
	const mergeCommit = run("gh", [
		"pr",
		"view",
		String(n),
		"--json",
		"mergeCommit",
		"-q",
		".mergeCommit.oid",
	]).stdout.trim();
	markMergedByBranch(root, pr.headRefName, /^[0-9a-f]{40}$/.test(mergeCommit) ? mergeCommit : null);
	if (shipRoute && evidence) {
		// The record of a merged main names the head that merged, as evf ship's carry does; `owner` holds the proof.
		if (final !== evidence.head) {
			evidence = {
				...evidence,
				head: final,
				checks: checks ?? evidence.checks,
				...(owner?.carry ? { carry: owner.carry } : {}),
			};
			baseSha = git(root, "merge-base", final, baseRef(root, cfg));
		}
		// The same bookkeeping evf ship runs, so package progress and dependents unlock. A task without a worktree
		// reads its registration from the merged head in the home checkout.
		const path = worktreePath(root, cfg, route.task),
			hasWorktree = existsSync(path);
		return afterMerge(root, cfg, route.task, hasWorktree ? path : root, n, evidence, baseSha, {
			...(hasWorktree ? {} : { rev: final }),
			ownerApproval: owner ?? { quote, approved_head: approved, approved_at: new Date().toISOString() },
		});
	}
	return 0;
}
