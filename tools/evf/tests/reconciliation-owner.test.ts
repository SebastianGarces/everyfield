import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fixture } from "./fixtures.ts";
import { parseTask, evfDataDir, loadConfig } from "../lib.ts";
import { feedbackTriage } from "../feedback.ts";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { ship } from "../ship.ts";
import { driveOnce } from "../drive.ts";
import { openWorkDb } from "../db.ts";
import { approve } from "../approve.ts";
import { existsSync } from "node:fs";
import { chmodSync } from "node:fs";
import { mergePullRequest, setLoadedCode } from "../merge.ts";
import { randomUUID } from "node:crypto";
import { wikiClaimCheck, wikiCarryProof } from "../wiki.ts";
import { drive } from "../drive.ts";
import { heldClasses } from "../merge.ts";
import { DEFAULT_OWNER_PATHS } from "../policy.ts";
import {
	DRIVE_TIMING,
	VERIFIER,
	approvable,
	approveWrites,
	approvedExperience,
	approvedQuality,
	at,
	behindCode,
	callsWith,
	capturedLog,
	currentCode,
	inFakeCwd,
	mergeCalls,
	mergeFixture,
	pr375,
	source,
	templateConfig,
	verifiedStatus,
	withCode,
	wpShipFixture,
} from "./reconciliation-helpers.ts";

/** The base branch carries a copy of the evf code, so the drive has a current checkout to run ship from. */
function publishEvfCode(f: ReturnType<typeof mergeFixture>) {
	const source = resolve(import.meta.dirname, "../../..");
	cpSync(join(source, "tools/evf"), join(f.root, "tools/evf"), {
		recursive: true,
		filter: (path) => !/[\\/](tests|node_modules)([\\/]|$)/.test(path),
	});
	mkdirSync(join(f.root, "bin"), { recursive: true });
	cpSync(join(source, "bin/evf"), join(f.root, "bin/evf"));
	f.git("add", "tools/evf", "bin/evf");
	f.git("commit", "-qm", "Publish evf code");
	f.git("push", "-q", "origin", "main");
}

test("OPS-83-375-drive: the drive records owner_approval_wait for the template PR on current code and on code that is behind", () => {
	for (const behind of [false, true]) {
		const { f, db, task } = pr375(),
			log = console.log;
		try {
			publishEvfCode(f);
			console.log = () => {};
			const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
			const out = withCode(behind ? behindCode : currentCode, () => driveOnce(f.root, task, DRIVE_TIMING));
			assert.equal(out.stage, "done");
			assert.match(out.reason, /^PR #77 waits for Sebastian's approval$/);
			assert.deepEqual(mergeCalls(f), []);
			assert.equal(callsWith(f, "pr", "merge").length, 0);
			assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'merged'").get(id)!.n, 0);
			assert.equal(
				db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'owner_approval_wait'").get(id)!.n,
				1,
			);
			assert.equal(
				db.prepare("SELECT status FROM runs WHERE task_id = ? AND stage = 'ship'").get(id)!.status,
				"passed",
			);
			assert.equal(callsWith(f, "POST").length, 1, "the verified status, posted once");
			const dir = join(f.root, ".git/evf-code"),
				checkouts = existsSync(dir) ? readdirSync(dir).length : 0;
			assert.equal(checkouts, behind ? 1 : 0, "behind code ships from one base checkout");
		} catch (e) {
			console.log = log;
			throw e;
		} finally {
			console.log = log;
			db.close();
			f.close();
		}
	}
});

/**
 * The home checkout's bin/wiki: the real tools/wiki promote and seed code, with only the MDX lint stubbed, because the
 * evf CI job installs no Wiki dependencies. Lint itself is proven in tools/wiki/tests.
 */
function withWikiTool(f: { root: string }) {
	mkdirSync(join(f.root, "tools/wiki"), { recursive: true });
	mkdirSync(join(f.root, "bin"), { recursive: true });
	for (const file of ["main.ts", "rows.ts", "seed.py", "pr-images.ts", "ascii-allowlist.json"])
		cpSync(join(source, "tools/wiki", file), join(f.root, "tools/wiki", file));
	writeFileSync(
		join(f.root, "tools/wiki/mdx.ts"),
		"export async function inspect(content: string) {\n\treturn { code: '', words: content.split(/\\s+/).length, errors: [] as string[], warnings: [] as string[], ascii: [] as string[] };\n}\n",
	);
	cpSync(join(source, "bin/wiki"), join(f.root, "bin/wiki"));
	chmodSync(join(f.root, "bin/wiki"), 0o755);
}

type WikiDraft = { path: string; text: string; id: string };

/** A new-article draft in the first seed section, written with `indent` (a tab, or two spaces). */
function wikiDraft(f: { root: string }, name: string, opts: { status?: string; tier?: string; indent?: string } = {}) {
	const seed = JSON.parse(readFileSync(join(f.root, "docs/reference/wiki/seed.json"), "utf8"));
	const base = seed.articles[0],
		section = seed.sections.find((s: { id: string }) => s.id === base.section_id);
	const status = opts.status ?? "pending";
	const row = {
		...base,
		id: randomUUID(),
		slug: `${section.slug}/${name}`,
		title: `Fixture ${name}`,
		status: "draft",
		published_at: null,
		draft: {
			backlog_id: "fixture",
			tier: opts.tier ?? "A",
			closes: [],
			approver: "Sebastian",
			replaces_id: null,
			sources: [],
			claim_check: { status, reviewer: status === "pending" ? "" : "Earlier reviewer", notes: "" },
			rulings: [],
		},
	};
	return {
		path: `docs/reference/wiki/drafts/${row.slug}.json`,
		text: JSON.stringify(row, null, opts.indent ?? "\t") + "\n",
		id: row.id,
	};
}

/** Commit `drafts` in the task worktree, push the branch and point the PR and an approved review at the new head. */
function wikiHead(f: ReturnType<typeof mergeFixture>, drafts: WikiDraft[], wt = f.wt): string {
	for (const d of drafts) {
		mkdirSync(dirname(join(wt, d.path)), { recursive: true });
		writeFileSync(join(wt, d.path), d.text);
	}
	execFileSync("git", ["-C", wt, "add", "docs"]);
	execFileSync("git", ["-C", wt, "commit", "-qm", "Wiki drafts"]);
	const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	execFileSync("git", ["-C", wt, "push", "-q", "origin", `HEAD:refs/heads/${parseTaskOfWt(wt)}`]);
	const state = f.getState();
	state.pr.headRefOid = sha;
	state.comments["77"][0].body =
		`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
	f.setState(state);
	return sha;
}

const parseTaskOfWt = (wt: string) =>
	execFileSync("git", ["-C", wt, "branch", "--show-current"], { encoding: "utf8" }).trim();

const wikiFixture = () => {
	const f = mergeFixture({ owningPaths: ["docs/reference/wiki/"] });
	withWikiTool(f);
	return f;
};

/** The task branch on the fixture's origin. */
const remoteHead = (wt: string) =>
	execFileSync("git", ["-C", wt, "ls-remote", "origin", "refs/heads/task/ops-1"], { encoding: "utf8" }).split("\t")[0];

const headOf = (repo: string, ref = "HEAD") =>
	execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();

/** The draft text with only its three claim_check values replaced, computed by text edits the test can read. */
const claimed = (d: WikiDraft, indent: string, reviewer: string, notes: string) =>
	d.text
		.replace(`${indent.repeat(3)}"status": "pending",`, `${indent.repeat(3)}"status": "passed",`)
		.replace(`${indent.repeat(3)}"reviewer": "",`, `${indent.repeat(3)}"reviewer": ${JSON.stringify(reviewer)},`)
		.replace(`${indent.repeat(3)}"notes": ""`, `${indent.repeat(3)}"notes": ${JSON.stringify(notes)}`);

const NOTES = /^Approved \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: "(.+)"$/;

const notesOf = (wt: string, rev: string, d: WikiDraft) => JSON.parse(at(wt, rev, d.path)).draft.claim_check.notes;

test("OPS-109-gate: the merge refuses a Wiki-content task PR without his approval for that exact head, and evf ship never merges it", () => {
	const f = wikiFixture();
	try {
		const d = wikiDraft(f, "fixture-gate"),
			head = wikiHead(f, [d]);
		const cfg = loadConfig(f.root);
		const refusal = `evf does not merge PR #77: it changes Wiki content (${d.path}). Sebastian approves each Wiki change; after his approval in chat, run: bin/evf approve 77 --owner-approval "<his words>" --head ${head}`;
		assert.throws(() => mergePullRequest({ root: f.root, cfg, cwd: f.wt, number: 77, sha: head }), {
			message: refusal,
		});
		assert.throws(
			() =>
				mergePullRequest({
					root: f.root,
					cfg,
					cwd: f.wt,
					number: 77,
					sha: head,
					ownerApproval: { quote: "Approved this one", approved_head: "a".repeat(40) },
				}),
			/Sebastian approved aaaaaaaaaa, not .* His approval does not carry over to a new head/,
		);
		const { value, lines } = capturedLog(() => ship(f.root, f.taskRef));
		assert.equal(value, 0);
		assert.deepEqual(mergeCalls(f), [], "no merge and no update-branch call");
		assert.match(lines.at(-1)!, /^evf ship does not merge PR #77: it changes Wiki content \(/);
		assert.match(lines.at(-1)!, /bin\/evf approve 77 --owner-approval "<his words>" --head [0-9a-f]{40}$/);
	} finally {
		f.close();
	}
});

test("OPS-109-ship: the verifier's pass records the claim check in one commit, promotes the drafts, pushes and names approve with the new head", () => {
	const f = wikiFixture();
	try {
		const tabs = wikiDraft(f, "fixture-tabs"),
			spaces = wikiDraft(f, "fixture-spaces", { indent: "  " }),
			reviewed = wikiHead(f, [tabs, spaces]),
			before = f.getState().calls.length;
		const { value, lines } = capturedLog(() => ship(f.root, f.taskRef));
		assert.equal(value, 0);
		const promoted = headOf(f.wt),
			claim = headOf(f.wt, "HEAD~1");
		assert.equal(headOf(f.wt, "HEAD~2"), reviewed, "two commits: claim check, then promotion");
		assert.equal(remoteHead(f.wt), promoted, "pushed");
		// The claim-check commit changes only the claim_check values of the pending drafts.
		const reviewer = "verifier claude-opus-5-5 (session 22222222-2222-4222-8222-222222222222)";
		const notes = notesOf(f.wt, claim, tabs);
		assert.equal(
			NOTES.exec(notes)![1],
			`independent verifier review of ${reviewed}: https://github.com/test/private/pull/77#issuecomment-1`,
		);
		assert.equal(at(f.wt, claim, tabs.path), claimed(tabs, "\t", reviewer, notes));
		assert.equal(at(f.wt, claim, spaces.path), claimed(spaces, "  ", reviewer, notesOf(f.wt, claim, spaces)));
		assert.equal(
			execFileSync("git", ["-C", f.wt, "diff", "--name-only", reviewed, claim], { encoding: "utf8" }).trim().split("\n")
				.length,
			2,
		);
		// The promotion commit writes the seed and manifest and deletes the drafts; check-seed passes on that head.
		assert.deepEqual(
			execFileSync("git", ["-C", f.wt, "diff", "--name-status", claim, promoted], { encoding: "utf8" })
				.trim()
				.split("\n")
				.sort(),
			[
				`D\t${spaces.path}`,
				`D\t${tabs.path}`,
				"M\tdocs/reference/wiki/manifest.json",
				"M\tdocs/reference/wiki/seed.json",
			].sort(),
		);
		const seed = JSON.parse(at(f.wt, promoted, "docs/reference/wiki/seed.json"));
		for (const d of [tabs, spaces]) {
			const article = seed.articles.find((a: { id: string }) => a.id === d.id);
			assert.equal(article.status, "published");
			assert.equal(article.content, JSON.parse(d.text).content);
		}
		const manifest = JSON.parse(at(f.wt, promoted, "docs/reference/wiki/manifest.json"));
		assert.deepEqual(
			manifest.releases
				.slice(-2)
				.map((r: { id: string; approvedBy: string; pr: number }) => [r.id, r.approvedBy, r.pr])
				.sort(),
			[
				[tabs.id, "Sebastian", 77],
				[spaces.id, "Sebastian", 77],
			].sort(),
		);
		const check = spawnSync(join(f.root, "bin/wiki"), ["check-seed", "--seed-dir", join(f.wt, "docs/reference/wiki")], {
			encoding: "utf8",
		});
		assert.equal(check.status, 0, check.stderr);
		const calls = f.getState().calls.slice(before);
		assert.deepEqual(
			calls.filter((c: any) => c.args.includes("POST")).map((c: any) => c.args.at(-1)),
			[`description=Verified by claude-opus-5-5 (session 22222222) at ${promoted.slice(0, 10)}`],
		);
		assert.ok(calls.some((c: any) => c.args.includes(`repos/test/private/statuses/${promoted}`)));
		assert.deepEqual(mergeCalls(f), []);
		assert.equal(
			lines.at(-1),
			`evf ship does not merge PR #77: it changes Wiki content (docs/reference/wiki/manifest.json, docs/reference/wiki/seed.json). The verifier passed it; claim check recorded on 2 drafts and 2 drafts promoted. Sebastian approves each Wiki change; after his approval in chat, run: bin/evf approve 77 --owner-approval "<his words>" --head ${promoted}`,
		);

		// GitHub shows the pushed head. A rerun carries the review over evf's commits and has nothing left to do.
		const s = f.getState();
		s.pr.headRefOid = promoted;
		s.calls = [];
		f.setState(s);
		const again = capturedLog(() => ship(f.root, f.taskRef));
		assert.equal(headOf(f.wt), promoted);
		assert.match(again.lines.at(-1)!, /The verifier passed it\. Sebastian approves/);
		assert.equal(callsWith(f, "POST", `repos/test/private/statuses/${promoted}`).length, 1);

		// evf approve merges that head on his words and runs the after-merge steps of evf ship.
		approvable(f, "task/ops-1", ["docs/reference/wiki/seed.json", "docs/reference/wiki/manifest.json"], promoted);
		const t = f.getState();
		t.commitStatus = verifiedStatus(promoted);
		t.allowMerge = true;
		t.mergeBranch = "task/ops-1";
		t.calls = [];
		f.setState(t);
		const words = "The 501c3 article is good to merge";
		assert.equal(
			capturedLog(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head: promoted }))).value,
			0,
		);
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			promoted,
		]);
		const record = JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", "ops-1.json"), "utf8"));
		assert.deepEqual(record.verification.wikiCarry, {
			approvedHead: reviewed,
			head: promoted,
			claimChecked: [],
			promoted: [spaces.path, tabs.path].sort(),
		});
		assert.equal(record.owner_approval.quote, words);
		assert.equal(record.owner_approval.approved_head, promoted);
		const db = openWorkDb(f.root);
		assert.equal(
			(db.prepare("SELECT status FROM tasks WHERE ref = 'OPS-1'").get() as { status: string }).status,
			"merged",
		);
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-109-claim-check: Maya's claim check sets every pending draft in one pushed commit and refuses bad input", () => {
	const f = wikiFixture();
	try {
		const pending = wikiDraft(f, "fixture-maya"),
			failed = wikiDraft(f, "fixture-failed", { status: "failed", indent: "  " }),
			start = wikiHead(f, [pending, failed]);
		const maya = (reviewer: string, approval: string) =>
			capturedLog(() => wikiClaimCheck(f.root, f.taskRef, { reviewer, approval }));
		assert.throws(
			() => maya("Maya (Head of Growth)", "yes"),
			/Quote Maya \(Head of Growth\)'s approval in two words or more/,
		);
		assert.throws(() => maya("  ", "Looks right to me"), /Name the reviewer/);
		writeFileSync(join(f.wt, "scratch.txt"), "x");
		assert.throws(() => maya("Maya (Head of Growth)", "Looks right to me"), /uncommitted changes/);
		rmSync(join(f.wt, "scratch.txt"));
		assert.equal(headOf(f.wt), start);

		const words = 'Both articles look right to me — "ship it"';
		const { lines } = maya("Maya (Head of Growth)", words);
		const head = headOf(f.wt);
		assert.equal(headOf(f.wt, "HEAD~1"), start, "one commit");
		assert.equal(remoteHead(f.wt), head, "pushed");
		const notes = notesOf(f.wt, head, pending);
		assert.equal(NOTES.exec(notes)![1], words);
		assert.equal(at(f.wt, head, pending.path), claimed(pending, "\t", "Maya (Head of Growth)", notes));
		assert.equal(at(f.wt, head, failed.path), failed.text, "a failed claim check stays unchanged");
		assert.deepEqual(lines, [
			`claim-check: 1 draft passed by Maya (Head of Growth) at ${head.slice(0, 10)}: ${pending.path}`,
		]);
		assert.throws(() => maya("Maya (Head of Growth)", words), /OPS-1 has no pending Wiki drafts/);
		assert.equal(headOf(f.wt), head, "no commit");

		// evf ship carries the verifier's review of the start head over her claim check, then stops at promotion:
		// the failed draft is not promoted, so approve refuses and names the step.
		const s = f.getState();
		s.pr.headRefOid = head;
		f.setState(s);
		capturedLog(() => ship(f.root, f.taskRef));
		const promoted = headOf(f.wt);
		assert.equal(headOf(f.wt, "HEAD~1"), head, "one promotion commit, no verifier claim check");
		approvable(f, "task/ops-1", [failed.path], promoted);
		const t = f.getState();
		t.commitStatus = verifiedStatus(promoted);
		t.calls = [];
		f.setState(t);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head: promoted }),
			new RegExp(
				`PR #77 is not ready for Sebastian's approval at ${promoted.slice(0, 10)}: 1 draft is not promoted \\(${failed.path.replace(/[./]/g, "\\$&")} \\(claim check failed\\)\\)`,
			),
		);
		assert.deepEqual(approveWrites(f), []);
	} finally {
		f.close();
	}
});

test("OPS-109-approve: a pending draft refuses approve before any write and names the claim-check step", () => {
	const f = wikiFixture();
	try {
		const d = wikiDraft(f, "fixture-pending"),
			head = wikiHead(f, [d]);
		approvable(f, "task/ops-1", [d.path], head);
		const s = f.getState();
		s.commitStatus = verifiedStatus(head);
		s.calls = [];
		f.setState(s);
		assert.throws(() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head }), {
			message: `PR #77 is not ready for Sebastian's approval at ${head.slice(0, 10)}: 1 draft has no claim check yet (${d.path}). The verifier records it in bin/evf ship OPS-1, or a named reviewer through bin/evf wiki claim-check OPS-1 --reviewer "<name>" --approval "<words>".`,
		});
		assert.deepEqual(approveWrites(f), []);
	} finally {
		f.close();
	}
});

test("OPS-109-promote-fails: a draft the wiki tool refuses stops ship with its error and pushes nothing", () => {
	const f = wikiFixture();
	try {
		const ok = wikiDraft(f, "fixture-ok"),
			tierC = wikiDraft(f, "fixture-tier-c", { tier: "C" }),
			start = wikiHead(f, [ok, tierC]);
		assert.throws(
			() => capturedLog(() => ship(f.root, f.taskRef)),
			/evf ship stopped before pushing anything: bin\/wiki promote \S+fixture-tier-c\.json failed: .*tier C cannot be promoted by this tool/s,
		);
		assert.equal(headOf(f.wt), start, "the branch is back at the head it started from");
		assert.equal(execFileSync("git", ["-C", f.wt, "status", "--porcelain"], { encoding: "utf8" }), "");
		assert.equal(remoteHead(f.wt), start, "nothing pushed");
		assert.deepEqual(callsWith(f, "POST"), []);
	} finally {
		f.close();
	}
});

test("OPS-109-carry: the review carries only over claim checks and promotions of the PR's drafts; any other change needs a new pass", () => {
	const f = wikiFixture();
	try {
		const d = wikiDraft(f, "fixture-carry"),
			reviewed = wikiHead(f, [d]);
		capturedLog(() => ship(f.root, f.taskRef));
		const promoted = headOf(f.wt);
		const main = headOf(f.root, "origin/main");
		assert.equal(typeof wikiCarryProof(f.wt, reviewed, promoted, main), "object");
		const commit = (edit: () => void, base = promoted) => {
			execFileSync("git", ["-C", f.wt, "reset", "-q", "--hard", base]);
			edit();
			execFileSync("git", ["-C", f.wt, "add", "--all"]);
			execFileSync("git", ["-C", f.wt, "commit", "-qm", "Another change"]);
			return headOf(f.wt);
		};
		const other = commit(() => writeFileSync(join(f.wt, "docs/reference/wiki/backlog.json"), "[]\n"));
		assert.equal(
			wikiCarryProof(f.wt, reviewed, other, main),
			"docs/reference/wiki/backlog.json is not a claim check or promotion of this PR's drafts",
		);
		const seedPath = join(f.wt, "docs/reference/wiki/seed.json");
		const tampered = commit(() => {
			const seed = JSON.parse(readFileSync(seedPath, "utf8"));
			seed.articles[0].title = "Changed after review";
			writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
		});
		assert.equal(
			wikiCarryProof(f.wt, reviewed, tampered, main),
			"seed.json changes more than the promoted drafts' articles",
		);
		// A draft whose content changes after review, beside its claim check.
		const row = JSON.parse(d.text);
		row.title = "Edited after review";
		row.draft.claim_check = { status: "passed", reviewer: "Someone", notes: "x" };
		const edited = commit(() => writeFileSync(join(f.wt, d.path), JSON.stringify(row, null, "\t") + "\n"), reviewed);
		assert.equal(wikiCarryProof(f.wt, reviewed, edited, main), `${d.path} changes more than its claim_check`);
		// Through evf ship: the PR head with another change asks for a new verifier pass and writes nothing.
		const s = f.getState();
		s.pr.headRefOid = other;
		s.calls = [];
		f.setState(s);
		execFileSync("git", ["-C", f.wt, "reset", "-q", "--hard", other]);
		assert.throws(() => ship(f.root, f.taskRef), {
			message: `Missing verifier approval for the exact PR head. The approval of ${reviewed.slice(0, 10)} does not carry: docs/reference/wiki/backlog.json is not a claim check or promotion of this PR's drafts. Ask the verifier for a new pass at ${other.slice(0, 10)}.`,
		});
		assert.deepEqual(callsWith(f, "POST"), []);
		assert.equal(headOf(f.wt), other);
	} finally {
		f.close();
	}
});

test("OPS-109-unchanged: a P2 fix and a design task with Wiki paths keep their routes; a PR without Wiki paths is never held", () => {
	// A P2 fix that changes a Wiki draft keeps its owner route: verified, no claim check, no promotion.
	let f = mergeFixture();
	try {
		withWikiTool(f);
		f.authorize("WP-034");
		f.commit();
		f.git("push", "-q", "origin", "main");
		feedbackTriage(f.root, 1, { cls: "p2", reason: "scoped feedback", wp: "WP-034" });
		const task = parseTask("FB-1"),
			wt = f.task(task.slug),
			head = wikiHead(f, [wikiDraft(f, "fixture-p2")], wt);
		const { lines } = capturedLog(() => ship(f.root, task));
		assert.deepEqual(lines, ["PR #77 is verified and waits for Sebastian's chat approval, then evf approve."]);
		assert.equal(headOf(wt), head, "no claim-check or promotion commit");
	} finally {
		f.close();
	}
	// A design task that changes a Wiki draft keeps the design route.
	f = mergeFixture({ owningPaths: ["design/"], route: "design" });
	try {
		withWikiTool(f);
		const head = wikiHead(f, [wikiDraft(f, "fixture-design")]);
		const { lines } = capturedLog(() => ship(f.root, f.taskRef));
		assert.deepEqual(lines, [
			"PR #77 is a verified design task and waits for Sebastian's chat approval, then evf approve.",
		]);
		assert.equal(headOf(f.wt), head);
	} finally {
		f.close();
	}
	// An ordinary WP part without Wiki paths merges through the queue, and the merge takes no approval.
	const { f: g, db, task } = wpShipFixture();
	try {
		const head = g.getState().pr.headRefOid;
		assert.equal(capturedLog(() => ship(g.root, task)).value, 0);
		assert.deepEqual(callsWith(g, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			head,
		]);
	} finally {
		db.close();
		g.close();
	}
});

// OPS-122: evf ship promotes a PR's drafts in passes, so a draft that links to another draft of the PR promotes too.
/** `d` with `edit` applied to its row, at the path its slug names. */
function editedDraft(d: WikiDraft, edit: (row: any) => void): WikiDraft {
	const row = JSON.parse(d.text);
	edit(row);
	return {
		path: `docs/reference/wiki/drafts/${row.slug}.json`,
		text: JSON.stringify(row, null, "\t") + "\n",
		id: row.id,
	};
}

/** A new draft named `name` whose related_article_slugs name `related`. */
const linkingDraft = (f: { root: string }, name: string, related: string[]) =>
	editedDraft(wikiDraft(f, name), (row) => (row.related_article_slugs = related));

const slugOf = (d: WikiDraft) => JSON.parse(d.text).slug as string;

/** A draft that renames the first published article to `name` in its section (replaces_id is its id). */
function renamedDraft(f: { root: string }, name: string): WikiDraft {
	const published = JSON.parse(readFileSync(join(f.root, "docs/reference/wiki/seed.json"), "utf8")).articles[0];
	return editedDraft(wikiDraft(f, name), (row) => {
		Object.assign(row, { ...published, slug: `${published.slug.replace(/\/[^/]+$/, "")}/${name}` });
		Object.assign(row, { status: "draft", published_at: null });
		row.draft.replaces_id = published.id;
	});
}

const releaseIds = (wt: string, rev: string) =>
	JSON.parse(at(wt, rev, "docs/reference/wiki/manifest.json")).releases.map((r: { id: string }) => r.id);

/** Ship stops: the branch is back at `start`, the worktree is clean, nothing is pushed and no status is posted. */
function assertNothingShipped(f: ReturnType<typeof wikiFixture>, start: string) {
	assert.equal(headOf(f.wt), start, "the branch is back at the head it started from");
	assert.equal(
		execFileSync("git", ["-C", f.wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
		"",
	);
	assert.equal(remoteHead(f.wt), start, "nothing pushed");
	assert.deepEqual(callsWith(f, "POST"), []);
}

const shipError = (f: ReturnType<typeof wikiFixture>) => {
	try {
		capturedLog(() => ship(f.root, f.taskRef));
	} catch (e) {
		return (e as Error).message;
	}
	assert.fail("evf ship did not stop");
};

const LINT = "ERROR related_article_slugs must name known articles";

/** Five drafts that sort before a renamed article and link to its new slug; ship promotes them all (PR #388's case). */
function shipRenameCase(f: ReturnType<typeof wikiFixture>) {
	const renamed = renamedDraft(f, "zz-welcome-renamed");
	const linking = [1, 2, 3, 4, 5].map((n) => linkingDraft(f, `fixture-link-${n}`, [slugOf(renamed)]));
	const drafts = [...linking, renamed];
	assert.deepEqual(
		drafts.map((d) => d.path),
		drafts.map((d) => d.path).sort(),
		"every linking draft sorts before the renamed article",
	);
	const reviewed = wikiHead(f, drafts);
	const { value, lines } = capturedLog(() => ship(f.root, f.taskRef));
	assert.equal(value, 0);
	return { renamed, linking, drafts, reviewed, promoted: headOf(f.wt), lines };
}

/** A chain a -> b -> c in path order, so each draft needs the next one published first. */
function shipChainCase(f: ReturnType<typeof wikiFixture>) {
	const c = wikiDraft(f, "fixture-chain-c"),
		b = linkingDraft(f, "fixture-chain-b", [slugOf(c)]),
		a = linkingDraft(f, "fixture-chain-a", [slugOf(b)]);
	const reviewed = wikiHead(f, [a, b, c]);
	const { value, lines } = capturedLog(() => ship(f.root, f.taskRef));
	assert.equal(value, 0);
	return { a, b, c, reviewed, promoted: headOf(f.wt), lines };
}

test("AC:OPS-122-1 a renamed article and five drafts that sort before it and link to its new slug promote in one pushed commit", () => {
	const f = wikiFixture();
	try {
		const { renamed, drafts, reviewed, promoted, lines } = shipRenameCase(f);
		assert.equal(headOf(f.wt, "HEAD~2"), reviewed, "two commits: claim check, then one promotion");
		assert.equal(
			execFileSync("git", ["-C", f.wt, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
			"OPS-1: promote 6 Wiki drafts",
		);
		assert.equal(remoteHead(f.wt), promoted, "pushed");
		assert.match(lines.at(-1)!, /The verifier passed it; claim check recorded on 6 drafts and 6 drafts promoted\. /);
		const seed = JSON.parse(at(f.wt, promoted, "docs/reference/wiki/seed.json"));
		for (const d of drafts) {
			const article = seed.articles.find((x: { id: string }) => x.id === d.id);
			assert.equal(article.status, "published", d.path);
			assert.equal(article.slug, slugOf(d));
		}
		assert.equal(
			seed.articles.filter((x: { id: string }) => x.id === renamed.id).length,
			1,
			"the rename replaces the article",
		);
		assert.deepEqual(releaseIds(f.wt, promoted).slice(-6).sort(), drafts.map((d) => d.id).sort());
		for (const d of drafts) assert.equal(existsSync(join(f.wt, d.path)), false, `${d.path} is deleted`);
		const check = spawnSync(join(f.root, "bin/wiki"), ["check-seed", "--seed-dir", join(f.wt, "docs/reference/wiki")], {
			encoding: "utf8",
		});
		assert.equal(check.status, 0, check.stderr);
	} finally {
		f.close();
	}
});

test("AC:OPS-122-2 a chain of three drafts that each link to the next promotes in reverse path order in one ship and one commit", () => {
	const f = wikiFixture();
	try {
		const { a, b, c, reviewed, promoted, lines } = shipChainCase(f);
		assert.equal(headOf(f.wt, "HEAD~2"), reviewed, "two commits: claim check, then one promotion");
		assert.equal(remoteHead(f.wt), promoted, "pushed");
		assert.match(lines.at(-1)!, /3 drafts promoted\. /);
		assert.deepEqual(releaseIds(f.wt, promoted).slice(-3), [c.id, b.id, a.id], "c first, then b, then a");
	} finally {
		f.close();
	}
});

test("AC:OPS-122-3 a draft that names an unknown slug stops ship with its path and lint error, resets and pushes nothing", () => {
	const f = wikiFixture();
	try {
		const broken = linkingDraft(f, "fixture-broken", ["administrative/financial/no-such-article"]),
			start = wikiHead(f, [broken]);
		const message = shipError(f);
		assert.ok(
			message.startsWith(`evf ship stopped before pushing anything: bin/wiki promote ${broken.path} failed: `),
			message,
		);
		assert.ok(message.includes(`\n${broken.path}:\n`), message);
		assert.ok(message.includes(LINT), message);
		assert.ok(message.includes("Promotion requires a passing lint"), message);
		assertNothingShipped(f, start);
		assert.equal(at(f.wt, "HEAD", broken.path), broken.text, "the draft is unchanged");
	} finally {
		f.close();
	}
});

test("AC:OPS-122-4 one broken draft among fine drafts promotes nothing and the message names only the broken draft", () => {
	const f = wikiFixture();
	try {
		const before = wikiDraft(f, "fixture-a-fine"),
			broken = linkingDraft(f, "fixture-b-broken", ["administrative/financial/no-such-article"]),
			after = linkingDraft(f, "fixture-c-fine", [slugOf(before)]),
			start = wikiHead(f, [before, broken, after]);
		const message = shipError(f);
		assert.ok(
			message.startsWith(`evf ship stopped before pushing anything: bin/wiki promote ${broken.path} failed: `),
			message,
		);
		assert.equal(message.split(LINT).length - 1, 1, message);
		for (const fine of [before, after])
			assert.ok(!message.includes(slugOf(fine)), `${fine.path} is not named: ${message}`);
		assertNothingShipped(f, start);
	} finally {
		f.close();
	}
});

test("AC:OPS-122-5 two drafts that link to each other fail; ship pushes nothing and names both with their lint errors", () => {
	const f = wikiFixture();
	try {
		const x = editedDraft(wikiDraft(f, "fixture-cycle-x"), () => {});
		const y = linkingDraft(f, "fixture-cycle-y", [slugOf(x)]);
		const xLinked = editedDraft(x, (row) => (row.related_article_slugs = [slugOf(y)]));
		const start = wikiHead(f, [xLinked, y]);
		const message = shipError(f);
		assert.ok(
			message.startsWith(
				`evf ship stopped before pushing anything: bin/wiki promote ${xLinked.path}, bin/wiki promote ${y.path} failed: `,
			),
			message,
		);
		for (const d of [xLinked, y])
			assert.ok(new RegExp(`\\n${d.path}:\\n[^]*?${LINT}`).test(message), `${d.path}: ${message}`);
		assert.equal(message.split(LINT).length - 1, 2, message);
		assertNothingShipped(f, start);
	} finally {
		f.close();
	}
});

test("AC:OPS-122-6 a promote attempt that writes and then fails is not retried: ship stops at once, resets and pushes nothing", () => {
	const f = wikiFixture();
	try {
		const first = wikiDraft(f, "fixture-stub-a"),
			second = wikiDraft(f, "fixture-stub-b"),
			start = wikiHead(f, [first, second]);
		const log = join(f.root, "wiki-calls.log");
		for (const target of ["seed.json", "manifest.json", "the draft"]) {
			// The stub logs its call, appends to `target` and exits 1, as a promotion that fails half way would.
			const file = target === "the draft" ? '"$2"' : `"$last/${target}"`;
			writeFileSync(
				join(f.root, "bin/wiki"),
				`#!/bin/sh\necho "$1 $2" >> ${JSON.stringify(log)}\nfor a; do last=$a; done\nprintf ' ' >> ${file}\necho "ERROR stub failure"\nexit 1\n`,
			);
			rmSync(log, { force: true });
			const message = shipError(f);
			assert.equal(
				message,
				`evf ship stopped before pushing anything: bin/wiki promote ${first.path} failed: ERROR stub failure\nIt changed the seed, manifest or draft before it failed.`,
				target,
			);
			assert.deepEqual(
				readFileSync(log, "utf8").trim().split("\n"),
				[`promote ${join(f.wt, first.path)}`],
				`${target}: one attempt only`,
			);
			assertNothingShipped(f, start);
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-122-7 the review carries over an out-of-path-order promotion; a hand edit of a promoted article in that commit refuses", () => {
	const f = wikiFixture();
	try {
		const { a, b, c, reviewed, promoted } = shipChainCase(f);
		const main = headOf(f.root, "origin/main");
		const carry = wikiCarryProof(f.wt, reviewed, promoted, main);
		assert.deepEqual(carry, {
			approvedHead: reviewed,
			head: promoted,
			claimChecked: [],
			promoted: [a.path, b.path, c.path],
		});
		const seedPath = join(f.wt, "docs/reference/wiki/seed.json");
		const seed = JSON.parse(readFileSync(seedPath, "utf8"));
		seed.articles.find((x: { id: string }) => x.id === b.id).content += "\nAn unreviewed sentence.\n";
		writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
		execFileSync("git", ["-C", f.wt, "commit", "-q", "--amend", "-a", "--no-edit"]);
		assert.match(
			String(wikiCarryProof(f.wt, reviewed, headOf(f.wt), main)),
			/^seed\.json does not hold the reviewed article of \S+ as published$/,
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-122-8 after an out-of-path-order promotion, approve needs his words for the promoted head and then merges it", () => {
	const f = wikiFixture();
	try {
		const { drafts, reviewed, promoted } = shipRenameCase(f);
		approvable(f, "task/ops-1", ["docs/reference/wiki/seed.json", "docs/reference/wiki/manifest.json"], promoted);
		const t = f.getState();
		t.commitStatus = verifiedStatus(promoted);
		t.allowMerge = true;
		t.mergeBranch = "task/ops-1";
		t.calls = [];
		f.setState(t);
		for (const ownerApproval of [undefined, "", "yes"])
			assert.throws(
				() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval, head: promoted })),
				/Quote Sebastian's approval/,
			);
		const words = "The welcome rename is good to merge";
		assert.throws(
			() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head: reviewed })),
			/His approval does not carry over/,
		);
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
		assert.equal(
			capturedLog(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head: promoted }))).value,
			0,
		);
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			promoted,
		]);
		const record = JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", "ops-1.json"), "utf8"));
		assert.deepEqual(record.verification.wikiCarry, {
			approvedHead: reviewed,
			head: promoted,
			claimChecked: [],
			promoted: drafts.map((d) => d.path).sort(),
		});
		assert.equal(record.owner_approval.quote, words);
		assert.equal(record.owner_approval.approved_head, promoted);
	} finally {
		f.close();
	}
});

// The nested run gets only its own flags: process.execArgv would pass on this run's name pattern, and a nested run
// that matched this test again would start another run without end. The env mark skips it in a nested run anyway.
const NESTED = "EVF_TEST_NESTED_OPS109";

test("AC:OPS-122-9 the OPS-109 wiki tests run and pass", { skip: process.env[NESTED] ? "nested run" : false }, () => {
	// Inside a node:test process NODE_TEST_CONTEXT names the parent's protocol; the nested run would report nothing here.
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const r = spawnSync(
		process.execPath,
		["--test", "--test-reporter=tap", "--test-name-pattern=^OPS-109-", import.meta.filename],
		{ encoding: "utf8", env: { ...env, [NESTED]: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
	);
	assert.equal(r.status, 0, r.stdout.slice(-4000) + r.stderr);
	assert.match(r.stdout, /^# pass 7$/m, "the seven OPS-109 tests ran");
	assert.match(r.stdout, /^# fail 0$/m);
});

const OWNER_ERR = "evf.config.json mergePolicy.ownerPaths";

const OWNER_PATHS = [
	"apps/web/src/app/page.tsx",
	"apps/web/src/app/access/",
	"apps/web/src/app/oversight/",
	"apps/web/src/app/privacy/",
	"apps/web/src/app/terms/",
	"apps/web/src/marketing/",
	"apps/web/src/styles/marketing.css",
];

/** PR #405: the six paths of its merge commit 6fc1c575. */
const PR405_FILES = [
	"apps/web/package.json",
	"apps/web/src/components/kit/EvryBot.tsx",
	"apps/web/src/styles/marketing.css",
	"tests/ui/marketing/evry-bot.test.mjs",
	"tests/ui/marketing/evry-follow.test.mjs",
	"tests/ui/marketing/oversight.test.mjs",
];

const ownerApprove = (head: string) =>
	`Sebastian approves each landing and marketing PR for its exact head; after his approval in chat, run: bin/evf approve 77 --owner-approval "<his words>" --head ${head}`;

/** The GitHub writes ship could make: a status, a branch update, a comment or a merge. */
const shipWrites = (f: any) =>
	f
		.getState()
		.calls.filter(
			(c: any) =>
				(c.args[0] === "pr" && ["comment", "merge", "ready", "update-branch"].includes(c.args[1])) ||
				c.args.includes("POST"),
		);

/** Commit `files` in the task worktree and point the fixture PR and an approved review at the new head. */
function ownerHead(f: ReturnType<typeof mergeFixture>, wt: string, files: string[]): string {
	for (const file of files) {
		mkdirSync(dirname(join(wt, file)), { recursive: true });
		writeFileSync(join(wt, file), "x");
		execFileSync("git", ["-C", wt, "add", file]);
	}
	execFileSync("git", ["-C", wt, "commit", "-qm", "Owner paths"]);
	const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		state = f.getState();
	state.pr.headRefOid = sha;
	state.comments["77"][0].body =
		`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
	f.setState(state);
	return sha;
}

/** Moves origin/main to a commit whose evf.config.json is `text`; the home checkout keeps its own config. */
function baseConfig(f: { root: string; git: (...a: string[]) => string }, text: string) {
	f.git("checkout", "-q", "-b", "base-config", "origin/main");
	writeFileSync(join(f.root, "evf.config.json"), text);
	f.git("commit", "-qam", "Base config");
	f.git("push", "-q", "origin", "base-config:main");
	f.git("checkout", "-q", "main");
}

/** A config whose explicit ownerPaths key has an empty path list. */
const malformedOwnerPaths = (cfg: any) => {
	const c = structuredClone(cfg);
	c.mergePolicy.ownerPaths = { ...structuredClone(DEFAULT_OWNER_PATHS), paths: [] };
	return JSON.stringify(c);
};

const MALFORMED_OWNER = `evf.config.json is unreadable: ${OWNER_ERR}.paths must be a non-empty list of distinct relative paths with no .. part; got [].`;

test("OPS-111-config: the built-in ownerPaths holds the report's seven paths and his words; a malformed key stops loadConfig and names it", () => {
	const real = DEFAULT_OWNER_PATHS;
	assert.deepEqual(real.paths, OWNER_PATHS);
	assert.equal(real.approvedAtUtc, "2026-11-02T05:18:00Z");
	assert.equal(real.quote, "you can make decisions and let me know what those were so I can revert them if I disagree");
	assert.match(real.scope, /^The landing and marketing site: /);
	const f = fixture();
	try {
		const load = (edit: (c: any) => void) => {
			const cfg = structuredClone(f.cfg);
			cfg.mergePolicy.ownerPaths = structuredClone(DEFAULT_OWNER_PATHS);
			edit(cfg);
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(cfg));
			return () => loadConfig(f.root);
		};
		// The key is optional: an absent key loads and the built-in default applies; an explicit key loads as written.
		assert.equal(load((c) => delete c.mergePolicy.ownerPaths)().mergePolicy.ownerPaths, undefined);
		assert.deepEqual(load(() => {})().mergePolicy.ownerPaths, real);
		assert.throws(
			load((c) => (c.mergePolicy.ownerPaths = ["apps/web/"])),
			{ message: `${OWNER_ERR} must be an object with paths, approvedAtUtc, quote and scope.` },
		);
		const paths = (value: unknown) => ({
			message: `${OWNER_ERR}.paths must be a non-empty list of distinct relative paths with no .. part; got ${JSON.stringify(value)}.`,
		});
		for (const bad of [[], ["a.css", "a.css"], ["/apps/web/page.tsx"], ["apps/../web/page.tsx"], [""]])
			assert.throws(
				load((c) => (c.mergePolicy.ownerPaths.paths = bad)),
				paths(bad),
			);
		assert.throws(
			load((c) => (c.mergePolicy.ownerPaths.approvedAtUtc = "Nov 2, 2026, 1:18 AM ET")),
			{ message: `${OWNER_ERR}.approvedAtUtc must be an ISO UTC timestamp; got "Nov 2, 2026, 1:18 AM ET".` },
		);
		for (const field of ["quote", "scope"])
			for (const bad of [" ", undefined])
				assert.throws(
					load((c) => (c.mergePolicy.ownerPaths[field] = bad)),
					{ message: `${OWNER_ERR}.${field} must be a non-empty string.` },
				);
	} finally {
		f.close();
	}
});

test("OPS-111-class: prefix and exact entries match from the base config; near misses stay ordinary", () => {
	const f = mergeFixture();
	try {
		const cfg = loadConfig(f.root);
		const branch = (name: string, ...files: string[]) => {
			f.git("checkout", "-q", "-b", name, "main");
			for (const file of files) {
				mkdirSync(dirname(join(f.root, file)), { recursive: true });
				writeFileSync(join(f.root, file), `${name}\n`);
				f.git("add", file);
			}
			f.git("commit", "-qm", name);
			f.git("checkout", "-q", "main");
			return heldClasses(f.root, cfg, f.git("rev-parse", name).trim()).owner;
		};
		// A folder entry matches every path under it; a file entry matches that file only.
		assert.deepEqual(branch("prefix", "apps/web/src/marketing/Hero.tsx", "apps/web/src/app/privacy/sections/a.tsx"), [
			"apps/web/src/app/privacy/sections/a.tsx",
			"apps/web/src/marketing/Hero.tsx",
		]);
		assert.deepEqual(branch("exact", "apps/web/src/app/page.tsx", "apps/web/src/styles/marketing.css", "README.md"), [
			"apps/web/src/app/page.tsx",
			"apps/web/src/styles/marketing.css",
		]);
		assert.deepEqual(
			branch(
				"near",
				"apps/web/src/app/pages.tsx",
				"apps/web/src/app/(product)/page.tsx",
				"apps/web/src/app/terms.tsx",
				"apps/web/src/marketing-kit.ts",
				"apps/web/src/styles/marketing.css.map",
				"apps/web/src/components/kit/EvryBot.tsx",
			),
			[],
		);
		// The home checkout's own config cannot narrow the class: it is read from the base branch.
		const narrowed = structuredClone(f.cfg);
		narrowed.mergePolicy.ownerPaths = { ...structuredClone(DEFAULT_OWNER_PATHS), paths: ["nothing/"] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(narrowed));
		assert.deepEqual(branch("home", "apps/web/src/styles/marketing.css"), ["apps/web/src/styles/marketing.css"]);
	} finally {
		f.close();
	}
});

test("OPS-111-class: every failed step returns doubt with its reason", () => {
	const cases: Array<[string, (f: ReturnType<typeof mergeFixture>, sha: string) => string, RegExp]> = [
		["a bad sha", () => "HEAD", /the head to merge is not a full commit sha \("HEAD"\)/],
		["a missing commit", () => "f".repeat(40), /commit ffffffffff is not in the repository/],
		[
			"a failed fetch",
			(f, sha) => {
				f.git("remote", "set-url", "origin", "/nonexistent/origin.git");
				return sha;
			},
			/git fetch origin main failed/,
		],
		[
			"no merge base",
			(f) => f.git("commit-tree", "HEAD^{tree}", "-m", "orphan"),
			/git merge-base origin\/main .* failed/,
		],
		[
			"a failed diff",
			(f, sha) => {
				const tree = f.git("rev-parse", `${sha}^{tree}`);
				rmSync(join(f.root, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });
				return sha;
			},
			/git diff to .* failed/,
		],
		[
			"an unreadable base config",
			(f, sha) => {
				baseConfig(f, "{ not json");
				return sha;
			},
			/the origin\/main evf\.config\.json is unreadable/,
		],
		[
			"a malformed base ownerPaths",
			(f, sha) => {
				baseConfig(f, malformedOwnerPaths(f.cfg));
				return sha;
			},
			/the origin\/main evf\.config\.json is unreadable: evf\.config\.json mergePolicy\.ownerPaths\.paths must be/,
		],
	];
	for (const [name, setup, why] of cases) {
		const f = mergeFixture();
		try {
			const cfg = loadConfig(f.root),
				sha = setup(f, ownerHead(f, f.wt, ["README.md"]));
			const held = heldClasses(f.root, cfg, sha);
			assert.deepEqual([held.templates, held.owner], [[], []], name);
			assert.match(held.doubt ?? "", why, name);
		} finally {
			f.close();
		}
	}
});

test("OPS-111-405: the verified #405 file list is held on marketing.css: status posted, no queue, no update, no merge", () => {
	const { f, db, task } = wpShipFixture(undefined, PR405_FILES[0], { extraFiles: PR405_FILES.slice(1) });
	try {
		const sha = f.getState().pr.headRefOid,
			wt = join(f.root, ".worktrees", task.slug);
		assert.deepEqual(
			execFileSync("git", ["-C", wt, "diff", "--name-only", "origin/main", sha], { encoding: "utf8" })
				.trim()
				.split("\n"),
			PR405_FILES,
			"the PR changes exactly #405's six paths",
		);
		const s = f.getState();
		s.calls = [];
		f.setState(s);
		const { value, lines } = capturedLog(() => ship(f.root, task));
		assert.equal(value, 0);
		assert.deepEqual(lines, [
			`evf ship does not merge PR #77: it changes landing and marketing owner paths (apps/web/src/styles/marketing.css). The verifier passed it. ${ownerApprove(sha)}`,
		]);
		assert.deepEqual(
			shipWrites(f).map((c: any) => c.args),
			[
				[
					"api",
					"-X",
					"POST",
					`repos/test/private/statuses/${sha}`,
					"-f",
					"state=success",
					"-f",
					"context=evf/verify",
					"-f",
					`description=Verified by claude-opus-5-5 (session 22222222) at ${sha.slice(0, 10)}`,
				],
			],
			"one evf/verify success; no update-branch, comment or merge",
		);
		assert.equal(existsSync(join(evfDataDir(f.root), "ship-queue")), false, "never entered the ship queue");
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-ship: an OPS task and a P1 fix join the class; more than five paths show five and a count", () => {
	for (const kind of ["ops", "fb"] as const) {
		const f = mergeFixture();
		try {
			let task = f.taskRef,
				wt = f.wt;
			if (kind === "fb") {
				f.authorize("WP-034");
				f.commit();
				f.git("push", "-q", "origin", "main");
				feedbackTriage(f.root, 1, { cls: "p1", reason: "scoped feedback", wp: "WP-034" });
				task = parseTask("FB-1");
				wt = f.task(task.slug);
			}
			const files = Array.from({ length: 7 }, (_, i) => `apps/web/src/marketing/part-${i}.tsx`),
				sha = ownerHead(f, wt, files);
			const { value, lines } = capturedLog(() => ship(f.root, task));
			assert.equal(value, 0, kind);
			assert.deepEqual(mergeCalls(f), [], kind);
			assert.equal(callsWith(f, "state=success").length, 1, kind);
			assert.equal(lines.length, 1, kind);
			assert.equal(
				lines[0],
				`evf ship does not merge PR #77: it changes landing and marketing owner paths (${files.slice(0, 5).join(", ")}) (7 paths in all). The verifier passed it. ${ownerApprove(sha)}`,
				kind,
			);
		} finally {
			f.close();
		}
	}
});

test("OPS-111-doubt: a malformed base ownerPaths or an unreadable base config holds an ordinary PR and names the reason", () => {
	for (const [name, text, why] of [
		[
			"malformed ownerPaths",
			(cfg: any) => malformedOwnerPaths(cfg),
			`evf cannot tell whether it changes document templates or landing and marketing owner paths (the origin/main ${MALFORMED_OWNER}), so it holds it as if it did`,
		],
		[
			"unreadable",
			() => "{ not json",
			"evf cannot tell whether it changes document templates or landing and marketing owner paths (the origin/main evf.config.json is unreadable: ",
		],
	] as const) {
		const { f, db, task } = wpShipFixture();
		try {
			const head = f.getState().pr.headRefOid;
			baseConfig(f, text(f.cfg));
			const s = f.getState();
			s.calls = [];
			f.setState(s);
			const { value, lines } = capturedLog(() => ship(f.root, task));
			assert.equal(value, 0, name);
			assert.equal(lines.length, 1, name);
			assert.ok(lines[0].startsWith(`evf ship does not merge PR #77: ${why}`), `${name}: ${lines[0]}`);
			assert.ok(lines[0].endsWith(`The verifier passed it. ${ownerApprove(head)}`), name);
			assert.deepEqual(mergeCalls(f), [], name);
			assert.equal(callsWith(f, "pr", "merge").length, 0, name);
			assert.equal(callsWith(f, "state=success").length, 1, name);
		} finally {
			db.close();
			f.close();
		}
	}
});

test("OPS-111-merge: the choke point refuses an owner-path PR without his words for that exact head", () => {
	const { f, db, task } = wpShipFixture(undefined, "apps/web/src/styles/marketing.css");
	try {
		const cfg = loadConfig(f.root),
			wt = join(f.root, ".worktrees", task.slug),
			sha = f.getState().pr.headRefOid;
		const merge = (ownerApproval?: { quote: string; approved_head: string }) =>
			mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha, ownerApproval });
		assert.throws(() => merge(), {
			message: `evf does not merge PR #77: it changes landing and marketing owner paths (apps/web/src/styles/marketing.css). ${ownerApprove(sha)}`,
		});
		assert.throws(() => merge({ quote: "Approved", approved_head: sha }), /does not merge PR #77: it changes/);
		assert.throws(
			() => merge({ quote: "Approved: the page looks right", approved_head: "a".repeat(40) }),
			/Sebastian approved aaaaaaaaaa, not .* His approval does not carry over to a new head\./,
		);
		assert.deepEqual(callsWith(f, "pr", "merge"), [], "no gh pr merge call");
		assert.equal(merge({ quote: "Approved: the page looks right", approved_head: sha }).code, 0);
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			sha,
		]);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-merge: doubt about the owner class refuses the merge without his words", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const cfg = loadConfig(f.root),
			wt = join(f.root, ".worktrees", task.slug),
			sha = f.getState().pr.headRefOid;
		baseConfig(f, malformedOwnerPaths(f.cfg));
		assert.throws(
			() => mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha }),
			(e: Error) => e.message.includes(MALFORMED_OWNER) && e.message.includes(`--head ${sha}`),
		);
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-approve: merges a verified owner-path PR at --head; refuses without a verifier pass, --head, the same head or an up-to-date branch", () => {
	const { f, db, task, shipped } = wpShipFixture(undefined, "apps/web/src/styles/marketing.css");
	try {
		const head = f.getState().pr.headRefOid,
			words = "Approved: the landing page looks right";
		approvable(f as any, task.branch, ["apps/web/src/styles/marketing.css"], head);
		const refuses = (opts: { head?: string }, message: string | RegExp, edit: (s: any) => void = () => {}) => {
			const s = f.getState();
			s.calls = [];
			edit(s);
			f.setState(s);
			assert.throws(
				() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, ...opts })),
				typeof message === "string" ? { message } : message,
			);
			assert.deepEqual(approveWrites(f), []);
		};
		refuses(
			{ head },
			`PR #77 needs the verifier to pass it first (bin/evf ship WP-001) at ${head.slice(0, 10)}; a branch update needs a fresh verification.`,
		);
		const verified = (s: any) => (s.commitStatus = verifiedStatus(head));
		refuses(
			{},
			`PR #77 changes landing and marketing owner paths. Name the head Sebastian approved: bin/evf approve 77 --owner-approval "<his words>" --head ${head}`,
			verified,
		);
		refuses(
			{ head: "deadbee" },
			/head is .*, not the deadbee Sebastian approved\. His approval does not carry over/,
			verified,
		);
		refuses({ head }, /PR #77 is behind main\. Update it/, (s) => {
			verified(s);
			s.pr.mergeStateStatus = "BEHIND";
		});
		const s = f.getState();
		s.pr.mergeStateStatus = "CLEAN";
		s.calls = [];
		f.setState(s);
		assert.equal(capturedLog(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head }))).value, 0);
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			head,
		]);
		assert.deepEqual(
			{ quote: shipped().owner_approval.quote, head: shipped().owner_approval.approved_head },
			{ quote: words, head },
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-both: a PR in the document-template and owner-path classes is held and the message names both", () => {
	const { f, db, task } = wpShipFixture(undefined, "packages/reference/fixture.txt", {
		extraFiles: ["apps/web/src/styles/marketing.css"],
	});
	try {
		templateConfig(f, ["packages/reference/"]);
		const head = f.getState().pr.headRefOid;
		const { value, lines } = capturedLog(() => ship(f.root, task));
		assert.equal(value, 0);
		assert.deepEqual(lines, [
			`evf ship does not merge PR #77: it changes document-template paths (packages/reference/fixture.txt) and landing and marketing owner paths (apps/web/src/styles/marketing.css). The verifier passed it. ${ownerApprove(head)}`,
		]);
		assert.deepEqual(mergeCalls(f), []);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-unchanged: an ordinary PR whose paths only resemble the owner paths still merges through evf ship", () => {
	const { f, db, task } = wpShipFixture(undefined, "packages/reference/fixture.txt", {
		extraFiles: [
			"apps/web/src/app/pages.tsx",
			"apps/web/src/app/(product)/page.tsx",
			"apps/web/src/components/kit/EvryBot.tsx",
			"tests/ui/marketing/oversight.test.mjs",
		],
	});
	try {
		const head = f.getState().pr.headRefOid;
		assert.equal(capturedLog(() => ship(f.root, task)).value, 0);
		assert.deepEqual(
			callsWith(f, "pr", "merge").map((c: any) => c.args),
			[["pr", "merge", "77", "--squash", "--match-head-commit", head]],
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-375: stale evf code stops evf ship before any GitHub write; the same PR on current code merges", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const head = f.getState().pr.headRefOid,
			base = f.git("rev-parse", "origin/main").slice(0, 10),
			rerun = `Update the home checkout to main (git -C ${f.root} merge --ff-only origin/main), then rerun the command from it.`;
		const claims: Array<[string, Parameters<typeof setLoadedCode>[0], string]> = [
			[
				"a different tools/evf tree (#375)",
				behindCode,
				`The running evf code is at 1111111111 (/old/checkout); main is at ${base}. tools/evf or bin/evf differ from main, so a merge rule may be missing here. ${rerun}`,
			],
			[
				"a different bin/evf tree",
				(b) => ({ ...currentCode(b), binTree: "3".repeat(40) }),
				"tools/evf or bin/evf differ from main",
			],
			[
				"uncommitted changes",
				(b) => ({ ...currentCode(b), dirty: true }),
				"The checkout has uncommitted changes in tools/evf or bin/evf",
			],
			["code evf cannot read", () => undefined, "evf cannot tell which code it runs"],
		];
		for (const [name, claim, why] of claims) {
			const s = f.getState();
			s.calls = [];
			f.setState(s);
			withCode(claim, () =>
				assert.throws(
					() => ship(f.root, task),
					(e: Error) =>
						e.message.startsWith("evf ship does not merge PR #77: ") &&
						e.message.includes(why) &&
						e.message.includes(base) &&
						e.message.endsWith(rerun),
					name,
				),
			);
			assert.deepEqual(shipWrites(f), [], `${name}: no status, update-branch, comment or merge`);
		}
		assert.equal(capturedLog(() => ship(f.root, task)).value, 0, "current code merges");
		assert.deepEqual(
			callsWith(f, "pr", "merge").map((c: any) => c.args),
			[["pr", "merge", "77", "--squash", "--match-head-commit", head]],
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-drive-start: evf drive on stale code refuses before any seat, run row or detached child", () => {
	const { f, db, task } = wpShipFixture();
	try {
		writeFileSync(
			join(f.root, "fake-bin/herdr"),
			`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(join(f.root, "herdr-calls.jsonl"))},JSON.stringify(process.argv.slice(2))+"\\n");process.stdout.write("{}");\n`,
		);
		chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
		const runs = () => (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
			before = runs(),
			base = f.git("rev-parse", "origin/main").slice(0, 10);
		for (const opts of [{ once: true }, {}, { detach: true }])
			withCode(behindCode, () =>
				assert.throws(
					() => drive(f.root, task, opts, DRIVE_TIMING),
					{
						message: `evf drive does not start WP-001: The running evf code is at 1111111111 (/old/checkout); main is at ${base}. tools/evf or bin/evf differ from main, so a merge rule may be missing here. Update the home checkout to main (git -C ${f.root} merge --ff-only origin/main), then rerun the command from it.`,
					},
					JSON.stringify(opts),
				),
			);
		assert.equal(runs(), before, "no new run row");
		assert.equal(existsSync(join(f.root, "herdr-calls.jsonl")), false, "no seat launched");
		assert.equal(existsSync(join(evfDataDir(f.root), "drive")), false, "no pid file and no detached log");
		assert.deepEqual(shipWrites(f), []);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-111-drive: the drive holds an owner-path PR with no new round, on current code and through the base checkout when behind", () => {
	for (const behind of [false, true]) {
		const { f, db, task } = wpShipFixture(undefined, "apps/web/src/styles/marketing.css"),
			log = console.log;
		try {
			publishEvfCode(f);
			writeFileSync(join(f.root, "fake-bin/herdr"), `#!${process.execPath}\nprocess.stdout.write("{}");\n`);
			chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
			console.log = () => {};
			const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
			// A drive that started on current code, after which main changed tools/evf under it.
			const out = withCode(behind ? behindCode : currentCode, () => driveOnce(f.root, task, DRIVE_TIMING));
			assert.equal(out.stage, "done");
			assert.match(out.reason, /^PR #77 waits for Sebastian's approval$/);
			assert.equal((db.prepare("SELECT round FROM tasks WHERE id = ?").get(id) as { round: number }).round, 0);
			assert.deepEqual(mergeCalls(f), []);
			const waits = db
				.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'owner_approval_wait'")
				.all(id) as Array<{ payload: string }>;
			assert.equal(waits.length, 1);
			assert.match(
				JSON.parse(waits[0].payload).summary,
				/^WP-001: PR #77 is verified and waits for Sebastian's approval/,
			);
			const dir = join(f.root, ".git/evf-code");
			assert.equal(
				existsSync(dir) ? readdirSync(dir).length : 0,
				behind ? 1 : 0,
				"behind code ships from the base checkout",
			);
		} finally {
			console.log = log;
			db.close();
			f.close();
		}
	}
});
