import { existsSync } from "node:fs";
import {
	baseRef,
	committedConfig,
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
import { cachedTriage } from "./feedback.ts";
import { mergePullRequest, templateClass } from "./merge.ts";
import { afterMerge, checkPr, type MergeEvidence } from "./ship.ts";
import { APPROVED_PROTOTYPE, changesOnlyOwnRegistration, mayChangePrototype } from "./policy.ts";

/**
 * Human-approved merge for the PRs that never merge automatically: Wiki articles, prototypes, and
 * the verifier-passed P2/P3 feedback fixes (mergePolicy.feedbackOwnerAfterVerifier) and design tasks
 * (maintenanceTasks route "design"), and the document-template PRs (mergePolicy.documentTemplates) that would
 * otherwise merge through evf ship. Every other PR refuses before any write. Sebastian approves in chat;
 * the agent runs this with his words. Agents never run it without that approval for this PR.
 * It records the approval on the PR, binds it to the exact head commit, and squash-merges.
 * When main is protected, it also posts the evf/verify status for that head.
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
	files: Array<{ path: string }>;
};
type Route =
	{ kind: "wiki" | "prototype" } | { kind: "verified"; id: string } | { kind: "template"; id: string; task: TaskRef };

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
			"number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,files",
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
	const design = task && committedConfig(root, pr.headRefOid).maintenanceTasks?.[task.id];
	if (task && design?.route === "design") {
		const base = git(root, "merge-base", baseRef(root, cfg), pr.headRefOid);
		const owns = (path: string) =>
			path === "evf.config.json"
				? changesOnlyOwnRegistration(root, task, base, pr.headRefOid)
				: (path !== APPROVED_PROTOTYPE || mayChangePrototype(design)) &&
					design.owningPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
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
			// Doubt about the class is the class, as in the merge: the held PR must stay approvable.
			const held = templateClass(root, cfg, pr.headRefOid);
			if (held.doubt || held.paths.length) return { kind: "template", id: ref.id, task: ref };
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

export function approve(root: string, n: number, opts: { ownerApproval?: string; head?: string }): number {
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
	const head = pr.headRefOid;
	const again =
		route.kind === "verified" || route.kind === "template"
			? `have the verifier pass the new head (bin/evf ship ${route.id}), then ask Sebastian to approve it`
			: "ask Sebastian to approve the new head";
	if (opts.head && !head.startsWith(opts.head))
		fail(
			`PR #${n} head is ${head.slice(0, 10)}, not the ${opts.head} Sebastian approved. His approval does not carry over: ${again}.`,
		);
	// Updating the branch would create a head Sebastian never saw, so approve never updates it.
	if (pr.mergeStateStatus === "BEHIND")
		fail(
			`PR #${n} is behind ${cfg.baseBranch}. Update it (gh pr update-branch ${n}), then ${again}. evf approve merges only the exact head he approved.`,
		);

	const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	let evidence: MergeEvidence | undefined,
		baseSha = "";
	if (route.kind === "verified" || route.kind === "template") {
		try {
			evidence = checkPr(root, n, head);
		} catch (e) {
			// A template PR waits for the verifier's pass first; name the command that gives it.
			if (route.kind === "template" && e instanceof EvfError)
				fail(
					`PR #${n} changes document templates and needs the verifier to pass it first (bin/evf ship ${route.id}) at ${head.slice(0, 10)}: ${e.message}`,
				);
			throw e;
		}
		const status = JSON.parse(gh(["api", `repos/${repo}/commits/${head}/status`])) as {
			statuses: Array<{ context: string; state: string; description: string | null }>;
		};
		const verified = status.statuses.find((s) => s.context === cfg.statusContext);
		if (verified?.state !== "success" || !verified.description?.startsWith("Verified"))
			fail(
				`PR #${n} needs the verifier to pass it first (bin/evf ship ${route.id}) at ${head.slice(0, 10)}; a branch update needs a fresh verification.`,
			);
		baseSha = git(root, "merge-base", head, baseRef(root, cfg));
	}
	gh([
		"pr",
		"comment",
		String(n),
		"--body",
		`Approved by Sebastian at \`${head.slice(0, 10)}\`:\n\n> ${words.replace(/\n/g, "\n> ")}`,
	]);
	if (pr.isDraft) gh(["pr", "ready", String(n)]);
	const protectedMain = run("gh", ["api", `repos/${repo}/branches/${cfg.baseBranch}/protection`]).code === 0;
	if (protectedMain)
		gh([
			"api",
			"-X",
			"POST",
			`repos/${repo}/statuses/${head}`,
			"-f",
			"state=success",
			"-f",
			`context=${cfg.statusContext}`,
			"-f",
			`description=Approved by Sebastian at ${head.slice(0, 10)}`,
		]);
	const merged = mergePullRequest({
		root,
		cfg,
		number: n,
		sha: head,
		ownerApproval: { quote: words, approved_head: head },
	});
	if (merged.code !== 0) fail(`The merge failed: ${(merged.stderr || merged.stdout).trim()}`);
	console.log(`Merged PR #${n} (${pr.title}) at ${head.slice(0, 10)} with Sebastian's approval.`);
	if (route.kind === "template" && evidence) {
		// The same bookkeeping evf ship runs, so package progress and dependents unlock. A task without a worktree
		// reads its registration from the merged head in the home checkout.
		const path = worktreePath(root, cfg, route.task),
			hasWorktree = existsSync(path);
		return afterMerge(root, cfg, route.task, hasWorktree ? path : root, n, evidence, baseSha, {
			...(hasWorktree ? {} : { rev: head }),
			ownerApproval: { quote: words, approved_head: head, approved_at: new Date().toISOString() },
		});
	}
	return 0;
}
