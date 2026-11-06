import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { source } from "./fixtures.ts";
import {
	AUTHOR,
	approvedExperience,
	approvedQuality,
	mergeCalls,
	mergeFixture,
	VERIFIER,
} from "./reconciliation-helpers.ts";
import { ship } from "../ship.ts";

/**
 * OPS-145: a merge-only review narrows what the verifier reads and nothing that evf ship checks. The PR merged main,
 * and main changed a path the PR changes, so the approval of the prior head cannot carry to the merge result.
 */
const SHIP = { ciWaitMs: 200, ciPollMs: 10 };
const REPORT =
	"## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n| The feature | delivered |\n\n## Code quality\nApproved on the merge result.\n\n## Experience\nThe merge changes no flow.\n";
const reviewComment = (head: string, verifier: unknown = VERIFIER) => ({
	body: `EVF-Review: ${JSON.stringify({ head, verifier, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
	html_url: "https://github.com/test/private/pull/77#issuecomment-5",
});

function mergedOverlap() {
	const f = mergeFixture();
	const inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
	writeFileSync(join(f.wt, "README.md"), `Approved PR line.\n${readFileSync(join(f.wt, "README.md"), "utf8")}`);
	inWt("add", "README.md");
	inWt("commit", "-qm", "Approved work");
	const prior = inWt("rev-parse", "HEAD");
	writeFileSync(join(f.root, "README.md"), `${readFileSync(join(f.root, "README.md"), "utf8")}Main line.\n`);
	f.git("add", "README.md");
	f.git("commit", "-qm", "Main changes README.md");
	f.git("push", "-q", "origin", "main");
	inWt("fetch", "-q", "origin", "main");
	inWt("merge", "-q", "--no-edit", "origin/main");
	inWt("push", "-q", "origin", `HEAD:refs/heads/${f.taskRef.branch}`);
	const head = inWt("rev-parse", "HEAD");
	const state = f.getState();
	state.pr.headRefOid = head;
	state.pr.headRefName = f.taskRef.branch;
	state.pr.mergeStateStatus = "CLEAN";
	state.comments["77"] = [reviewComment(prior)];
	f.setState(state);
	const patch = (change: (s: ReturnType<typeof f.getState>) => void) => {
		const s = f.getState();
		change(s);
		f.setState(s);
	};
	return { f, prior, head, patch };
}
const quiet = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("AC:OPS-145-5 post-review.mjs writes the merge-only review for the exact merge result, and it holds no prior head", () => {
	const { f, prior, head } = mergedOverlap();
	try {
		const report = join(f.root, "fake-bin/merge-only.md");
		writeFileSync(report, REPORT);
		// The arguments the merge_only prompt names, around the ones every review needs.
		const body = execFileSync(
			process.execPath,
			[
				join(source, ".agents/skills/verify-preview/scripts/post-review.mjs"),
				"--pr",
				"77",
				"--report",
				report,
				"--head",
				head,
				"--session",
				VERIFIER.session,
				"--model",
				VERIFIER.model,
				"--verdict",
				"approved",
				"--experience-verdict",
				"approved",
				"--budget",
				"not_applicable",
				"--quality-verdict",
				"approved",
				"--principles",
				approvedQuality.principles.join(","),
				"--dry-run",
			],
			{
				cwd: f.root,
				encoding: "utf8",
				env: { ...process.env, PATH: `${join(f.root, "fake-bin")}:${process.env.PATH}` },
			},
		);
		const review = JSON.parse(/^EVF-Review: (.+)$/m.exec(body)![1]!);
		assert.equal(review.head, head);
		assert.notEqual(review.head, prior);
	} finally {
		f.close();
	}
});

test("AC:OPS-145-6 evf ship on a merge-only head: a review of the prior head, red CI and a review by the author all refuse; an independent review of the exact head with green CI merges", () => {
	const { f, head, patch } = mergedOverlap();
	try {
		const attempt = () => quiet(() => ship(f.root, f.taskRef, SHIP));
		assert.throws(attempt, /does not carry: main changed paths this PR also changes: README\.md/);
		assert.deepEqual(mergeCalls(f), []);

		patch((s) => {
			s.comments["77"] = [reviewComment(head, { ...VERIFIER, session: AUTHOR.session })];
		});
		assert.throws(attempt, /must come from an independent session/);
		assert.deepEqual(mergeCalls(f), []);

		patch((s) => {
			s.comments["77"] = [reviewComment(head)];
			s.requiredChecks = [
				{ name: "CI", state: "FAILURE", bucket: "fail", link: "https://github.com/test/private/actions/runs/1" },
			];
		});
		assert.throws(attempt, /Required GitHub CI must be green on the exact PR head: CI failed/);
		assert.deepEqual(mergeCalls(f), []);

		patch((s) => {
			s.requiredChecks = [
				{ name: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
			];
		});
		try {
			attempt();
		} catch (e) {
			// The fixture's merge stops after the call; the call is what this test reads.
			assert.match(String(e), /merge barrier/);
		}
		assert.deepEqual(
			mergeCalls(f).map((c: { args: string[] }) => c.args.slice(-2)),
			[["--match-head-commit", head]],
		);
	} finally {
		f.close();
	}
});
