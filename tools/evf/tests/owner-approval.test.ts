// OPS-121: Sebastian's owner approval binds to one head; only a clean merge of main (carryProof) keeps it.
// The drive's ci stage is green only when every required check passed on the exact PR head.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture } from "./fixtures.ts";
import { evfDataDir, parseTask } from "../lib.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { approve } from "../approve.ts";
import { ship } from "../ship.ts";
import { driveOnce } from "../drive.ts";
import { mergePullRequest, OWNER_VOID } from "../merge.ts";

const source = resolve(import.meta.dirname, "../../..");
const AUTHOR = { session: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet-5-5", role: "implementer" };
const VERIFIER = { session: "22222222-2222-4222-8222-222222222222", model: "claude-opus-5-5", role: "verifier" };
const QUALITY = {
	verdict: "approved",
	principles: [
		"laziness-protocol",
		"minimize-reader-load",
		"subtract-before-you-add",
		"test-behavior-not-implementation",
	],
};
const WORDS = "looks good";
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 10 };
const fastShip = { queue: { waitMs: 10_000, pollMs: 10 }, ciWaitMs: 10_000, ciPollMs: 1 };
const pass = (name: string) => ({
	name,
	state: "SUCCESS",
	bucket: "pass",
	link: `https://github.com/test/private/actions/runs/${name}`,
});

function prBody(): string {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	return `${template
		.split("\n")
		.filter((line) => line.startsWith("## "))
		.map((heading) => `${heading}\nConcrete task evidence.`)
		.join(
			"\n\n",
		)}\n\nEVF-Author: ${JSON.stringify(AUTHOR)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/**
 * An ordinary OPS-1 task PR (#77) in a fixture repository with a remote: its worktree, a fake GitHub with green
 * required CI (ci and pr-body) and helpers that move the head, post reviews and owner records, and read the calls.
 */
function ownerFixture(owningPaths = ["tools/evf/", "evf.config.json"]) {
	const f = fixture(),
		task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = { [task.id]: { title: "Workflow upkeep", checks: f.cfg.checks, owningPaths } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, "\t"));
	mkdirSync(join(f.root, "tools/evf"), { recursive: true });
	writeFileSync(join(f.root, "tools/evf/main.ts"), "export const main = 1;\n");
	writeFileSync(join(f.root, "tools/evf/ship.ts"), "export const ship = 1;\n");
	f.git("add", "evf.config.json", "tools/evf/main.ts", "tools/evf/ship.ts");
	f.git("commit", "-qm", "Fixture evf files");
	f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
	f.git("push", "-q", "origin", "main");
	const wt = f.task(task.slug);
	const inWt = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
	const write = (dir: string, path: string, text: string) => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	/** One commit on the PR branch; returns its sha. */
	const commit = (subject: string, files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) write(wt, path, text);
		inWt("add", ...Object.keys(files));
		inWt("commit", "-qm", subject);
		return inWt("rev-parse", "HEAD");
	};
	/** One commit on main, pushed; the worktree fetches it. */
	const mainCommit = (subject: string, files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) write(f.root, path, text);
		f.git("add", ...Object.keys(files));
		f.git("commit", "-qm", subject);
		f.git("push", "-q", "origin", "main");
		inWt("fetch", "-q", "origin", "main");
		return f.git("rev-parse", "HEAD");
	};
	const review = (head: string) => ({
		body: `EVF-Review: ${JSON.stringify({ head, verifier: VERIFIER, verdict: "approved", quality: QUALITY, experience: { verdict: "approved", budget: "met" } })}`,
		html_url: `https://github.com/test/private/pull/77#review-${head.slice(0, 7)}`,
	});
	const owner = (head: string, quote = WORDS) => ({
		body: `Approved by Sebastian:\n\n> ${quote}\n\nEVF-Owner: ${JSON.stringify({ head, quote, at: "2026-11-02T22:18:00.000Z" })}`,
		html_url: `https://github.com/test/private/pull/77#owner-${head.slice(0, 7)}`,
	});
	/** Push the worktree head as the PR head, with these PR comments and green required CI; clears the call log. */
	const publish = (comments: Array<{ body: string; html_url: string }>, edit: (s: any) => void = () => {}) => {
		const head = inWt("rev-parse", "HEAD");
		inWt("push", "-q", "origin", `+${head}:refs/heads/${task.branch}`);
		const s = f.getState();
		s.pr = {
			number: 77,
			title: "OPS-1: Workflow upkeep",
			url: "https://github.com/test/private/pull/77",
			state: "OPEN",
			isDraft: false,
			headRefName: task.branch,
			headRefOid: head,
			baseRefName: "main",
			mergeStateStatus: "CLEAN",
			files: [{ path: "tools/evf/feature.ts" }],
			body: prBody(),
		};
		s.protection = { required_status_checks: { strict: true, contexts: ["ci", "pr-body"] } };
		s.requiredChecks = [pass("ci"), pass("pr-body")];
		s.comments["77"] = comments;
		s.allowMerge = false;
		s.mergeBranch = task.branch;
		s.calls = [];
		edit(s);
		f.setState(s);
		return head;
	};
	const calls = (sub: string) => f.getState().calls.filter((c: any) => c.args[0] === "pr" && c.args[1] === sub);
	const merges = () => calls("merge").map((c: any) => c.args.at(-1));
	const ownerRows = () => {
		const db = openWorkDb(f.root);
		try {
			return db
				.prepare("SELECT gate, approver, head_sha, decision, quote FROM approvals WHERE gate = 'owner' ORDER BY id")
				.all()
				.map((r) => ({ ...r }));
		} finally {
			db.close();
		}
	};
	const shipped = () => JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), "utf8"));
	const quietly = <T>(fn: () => T): { value: T; out: string } => {
		const log = console.log,
			lines: string[] = [];
		console.log = (...a) => lines.push(a.join(" "));
		try {
			return { value: fn(), out: lines.join("\n") };
		} finally {
			console.log = log;
		}
	};
	/** The thrown message of fn, with console output silenced. */
	const refusal = (fn: () => unknown): string => {
		try {
			quietly(fn);
		} catch (e) {
			return (e as Error).message;
		}
		assert.fail("expected a refusal");
	};
	const short = (sha: string) => inWt("rev-parse", "--short", sha);
	return {
		...f,
		task,
		wt,
		inWt,
		commit,
		mainCommit,
		review,
		owner,
		publish,
		calls,
		merges,
		ownerRows,
		shipped,
		quietly,
		refusal,
		short,
	};
}
type Fx = ReturnType<typeof ownerFixture>;

/** The approved PR head: a code commit Sebastian saw. */
const approvedWork = (f: Fx) => f.commit("Approved work", { "tools/evf/feature.ts": "export const feature = 1;\n" });

test("AC:OPS-121-1 evf approve --head records the owner approval for an ordinary task PR; it merges only with a verifier pass and green CI", () => {
	const f = ownerFixture();
	try {
		const head = approvedWork(f);
		const writes = () =>
			f
				.getState()
				.calls.filter(
					(c: any) => (c.args[0] === "pr" && ["comment", "merge"].includes(c.args[1])) || c.args.includes("POST"),
				);

		// No --head, a head that is not the PR head, or an unknown sha: refused before any write.
		f.publish([f.review(head)]);
		assert.match(
			f.refusal(() => approve(f.root, 77, { ownerApproval: WORDS })),
			/cannot merge it without the head Sebastian approved.*--head [0-9a-f]{40}/,
		);
		assert.match(
			f.refusal(() => approve(f.root, 77, { ownerApproval: WORDS, head: "b".repeat(40) })),
			/not the b{40} Sebastian approved/,
		);
		assert.deepEqual([writes(), f.ownerRows()], [[], []]);

		// No verifier pass yet: the record is kept (one comment with the full head, one approvals row), nothing merges.
		f.publish([]);
		const kept = f.quietly(() => approve(f.root, 77, { ownerApproval: WORDS, head: head.slice(0, 10) }));
		assert.equal(kept.value, 0);
		const posted = f.calls("comment");
		assert.equal(posted.length, 1);
		const line = JSON.parse(/^EVF-Owner: (.+)$/m.exec(posted[0].body)![1]);
		assert.deepEqual([line.head, line.quote], [head, WORDS]);
		assert.ok(Date.parse(line.at) > 0);
		assert.deepEqual(f.ownerRows(), [
			{ gate: "owner", approver: "Sebastian", head_sha: head, decision: "approved", quote: WORDS },
		]);
		assert.deepEqual(f.merges(), []);
		assert.match(
			kept.out,
			/merges nothing yet: Missing verifier approval for the exact PR head\..*bin\/evf ship OPS-1/,
		);

		// With the verifier pass and green CI it merges that head through evf ship.
		f.publish([f.review(head)], (s) => (s.allowMerge = true));
		const merged = f.quietly(() => approve(f.root, 77, { ownerApproval: WORDS, head }));
		assert.equal(merged.value, 0);
		assert.deepEqual(f.merges(), [head]);
		assert.match(merged.out, /ship: merged PR #77/);
		const record = f.shipped().owner_approval;
		assert.deepEqual([record.quote, record.approved_head, record.carry], [WORDS, head, undefined]);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-2 the merge choke point merges only a head the latest EVF-Owner record covers; a PR without one merges as before", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		const later = f.commit("Later work", { "tools/evf/feature.ts": "export const feature = 2;\n" });
		const merge = () => mergePullRequest({ root: f.root, cfg: f.cfg, cwd: f.wt, number: 77, sha: later });

		// No EVF-Owner record: the merge reaches GitHub, exactly as today.
		f.publish([f.review(later)]);
		assert.equal(merge().owner, undefined);
		assert.deepEqual(f.merges(), [later]);

		// The latest record is for the head being merged: it merges and reports the cover.
		f.publish([f.review(later), f.owner(approved), f.owner(later)]);
		assert.deepEqual(merge().owner, { quote: WORDS, approved_head: later, approved_at: "2026-11-02T22:18:00.000Z" });
		assert.deepEqual(f.merges(), [later]);

		// The latest record is for an earlier head and a code commit followed: refused before gh runs.
		f.publish([f.review(later), f.owner(later), f.owner(approved)]);
		assert.throws(merge, new RegExp(OWNER_VOID));
		assert.deepEqual(f.merges(), []);

		// evf ship goes through the same gate.
		f.publish([f.review(later), f.owner(approved)]);
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			new RegExp(OWNER_VOID),
		);
		assert.deepEqual(f.merges(), []);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-3 a code commit after the approved head voids the approval, even with a verifier pass at the new head and green CI", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		f.commit("one doubt for both held classes; drop inClass, heldDoubt and policyClass", {
			"tools/evf/feature.ts": "export const feature = 3;\n",
		});
		const head = f.publish([f.owner(approved), f.review(f.inWt("rev-parse", "HEAD"))]);
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			new RegExp(`${OWNER_VOID}.*${head.slice(0, 10)}.*is not a merge of main`),
		);
		assert.deepEqual([f.merges(), f.calls("update-branch")], [[], []]);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-4 a merge of main voids the approval when it is edited, merges a branch not on main, follows a rebase or overlaps main's paths", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		f.mainCommit("Main changes an unrelated path", { "docs/main-only.md": "Main only.\n" });
		const attempt = (expected: RegExp) => {
			f.publish([f.owner(approved), f.review(f.inWt("rev-parse", "HEAD"))]);
			assert.match(
				f.refusal(() => ship(f.root, f.task, fastShip)),
				expected,
			);
			assert.deepEqual(f.merges(), []);
			f.inWt("reset", "-q", "--hard", approved);
		};

		// A merge whose tree differs from the clean merge of its parents (an edit inside the merge).
		f.inWt("merge", "-q", "--no-commit", "origin/main");
		writeFileSync(join(f.wt, "tools/evf/feature.ts"), "export const feature = 4;\n");
		f.inWt("commit", "-qam", "Merge main with an edit");
		attempt(new RegExp(`${OWNER_VOID}.*differs from the clean merge of its parents`));

		// A merge whose second parent is not on main.
		f.inWt("checkout", "-q", "-b", "side", "origin/main");
		f.commit("Side work", { "docs/side.md": "Side.\n" });
		f.inWt("checkout", "-q", f.task.branch);
		f.inWt("merge", "-q", "--no-edit", "side");
		attempt(new RegExp(`${OWNER_VOID}.*which is not on main`));

		// A rebase: the approved head is no longer an ancestor of the head.
		f.inWt("commit", "-q", "--amend", "-m", "Approved work, reworded");
		attempt(new RegExp(`${OWNER_VOID}.*${approved.slice(0, 10)} is not an ancestor`));

		// A clean merge of main, but main changed a path the PR also changes.
		f.mainCommit("Main changes the feature too", { "tools/evf/other.ts": "export const other = 1;\n" });
		f.inWt("reset", "-q", "--hard", approved);
		const both = f.commit("Approved work on other.ts", { "tools/evf/other.ts": "export const other = 1;\n" });
		f.inWt("merge", "-q", "--no-edit", "origin/main");
		f.publish([f.owner(both), f.review(f.inWt("rev-parse", "HEAD"))]);
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			new RegExp(`${OWNER_VOID}.*main changed paths this PR also changes: tools/evf/other.ts`),
		);
		assert.deepEqual(f.merges(), []);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-5 the refusal names the approved head, each later commit oldest first, the reason and the approve command; a stale --head lists the same commits", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		const first = f.commit("First change after approval", { "tools/evf/feature.ts": "export const feature = 5;\n" });
		const second = f.commit("Second change after approval", { "tools/evf/feature.ts": "export const feature = 6;\n" });
		const head = f.publish([f.owner(approved), f.review(second)]);
		const list = `Commits after the approved head, oldest first:\n- ${f.short(first)} First change after approval\n- ${f.short(second)} Second change after approval`;
		const message = f.refusal(() => ship(f.root, f.task, fastShip));
		assert.ok(message.includes(`He approved ${approved.slice(0, 10)} ("${WORDS}")`), message);
		assert.ok(message.includes(`does not carry: ${second.slice(0, 10)} is not a merge of main.`), message);
		assert.ok(message.includes(list), message);
		assert.ok(message.endsWith(`run: bin/evf approve 77 --owner-approval "<his words>" --head ${head}`), message);

		const stale = f.refusal(() => approve(f.root, 77, { ownerApproval: WORDS, head: approved }));
		assert.match(stale, new RegExp(`head is ${head.slice(0, 10)}, not the ${approved} Sebastian approved`));
		assert.ok(stale.includes(list), stale);
		assert.deepEqual([f.calls("comment"), f.ownerRows()], [[], []]);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-6 a new EVF-Owner record for the current head restores the merge through evf approve and evf ship", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		const head = f.commit("Simplifier commit", { "tools/evf/feature.ts": "export const feature = 7;\n" });
		f.publish([f.owner(approved), f.review(head)]);
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			new RegExp(OWNER_VOID),
		);

		// evf approve records the new head; with the verifier pass and green CI it merges that head.
		f.publish([f.owner(approved), f.review(head)], (s) => (s.allowMerge = true));
		const { value } = f.quietly(() => approve(f.root, 77, { ownerApproval: "looks good again", head }));
		assert.equal(value, 0);
		assert.deepEqual(f.merges(), [head]);
		assert.deepEqual(
			[f.shipped().owner_approval.approved_head, f.shipped().owner_approval.quote],
			[head, "looks good again"],
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-6 evf ship merges after a new owner record for the current head", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		const head = f.commit("Simplifier commit", { "tools/evf/feature.ts": "export const feature = 8;\n" });
		f.publish([f.owner(approved), f.review(head)]);
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			new RegExp(OWNER_VOID),
		);
		f.publish([f.owner(approved), f.review(head), f.owner(head)], (s) => (s.allowMerge = true));
		assert.equal(f.quietly(() => ship(f.root, f.task, fastShip)).value, 0);
		assert.deepEqual(f.merges(), [head]);
		assert.equal(f.shipped().owner_approval.approved_head, head);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-7 a clean merge of main made by ship's branch update keeps the approval; the shipped record holds it and the EVF-Carry proof", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		f.mainCommit("Main changes an unrelated path", { "docs/main-only.md": "Main only.\n" });
		f.publish([f.review(approved), f.owner(approved)], (s) => (s.allowMerge = true));
		assert.equal(f.quietly(() => ship(f.root, f.task, fastShip)).value, 0);
		const [update] = f.calls("update-branch");
		assert.deepEqual(update.args, ["pr", "update-branch", "77"]);
		const record = f.shipped();
		assert.notEqual(record.verified_head, approved, "the merged head is the branch update");
		assert.deepEqual(f.merges(), [record.verified_head]);
		assert.deepEqual(
			[record.owner_approval.quote, record.owner_approval.approved_head, record.owner_approval.carry.head],
			[WORDS, approved, record.verified_head],
		);
		assert.equal(record.owner_approval.carry.merges.length, 1);
		assert.equal(record.verification.carry.approvedHead, approved);
		const posted = f
			.calls("comment")
			.map((c: any) => c.args.at(-1))
			.join("\n");
		assert.match(posted, /EVF-Carry: /);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-8 the drive's ship stage records owner_approval_wait for a void approval, merges nothing and starts no implement round", () => {
	const f = ownerFixture();
	try {
		const approved = approvedWork(f);
		const head = f.commit("drop the BodyOnly export and the conditional body spread", {
			"tools/evf/feature.ts": "export const feature = 9;\n",
		});
		f.publish([f.owner(approved), f.review(head)], (s) => (s.allowMerge = true));
		const db = openWorkDb(f.root);
		try {
			const row = ensureTask(db, f.task, "implement");
			db.prepare("UPDATE tasks SET spec = ?, pr_number = 77, status = 'pr_open' WHERE id = ?").run(
				"Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.",
				row.id,
			);
			for (const [stage, role, session] of [
				["implement", "implementer", AUTHOR.session],
				["verify", "verifier", VERIFIER.session],
				["ci", "evf", null],
			] as const)
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, 'passed', ?)",
				).run(row.id, stage, role, session, new Date().toISOString());
			const out = f.quietly(() => driveOnce(f.root, f.task, TIMING)).value;
			assert.equal(out.stage, "done");
			assert.deepEqual(f.merges(), []);
			const wait = db
				.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'owner_approval_wait'")
				.all(row.id)
				.map((r) => JSON.parse(String(r.payload)).summary);
			assert.equal(wait.length, 1);
			assert.match(wait[0], new RegExp(`^OPS-1: evf does not merge PR #77: ${OWNER_VOID}.*--head ${head}$`, "s"));
			const ship = db.prepare("SELECT status FROM runs WHERE task_id = ? AND stage = 'ship'").get(row.id)!;
			assert.equal(ship.status, "passed");
			// The next pass starts no implement round: the task waits for Sebastian.
			const next = f.quietly(() => driveOnce(f.root, f.task, TIMING)).value;
			assert.equal(next.stage, "done");
			assert.equal(
				db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'implement'").get(row.id)!.n,
				1,
			);
			assert.equal(db.prepare("SELECT round FROM tasks WHERE id = ?").get(row.id)!.round, 0);
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

/**
 * #430 (OPS-113): the PR registers a task at the end of maintenanceTasks and changes tools/evf/main.ts and ship.ts;
 * main later registers another task at the same place and changes the same lines.
 */
function replay430(f: Fx) {
	const entry = (title: string) => ({ [title]: { title, checks: f.cfg.checks, owningPaths: ["tools/evf/"] } });
	const config = (...extra: Array<Record<string, unknown>>) =>
		JSON.stringify({ ...f.cfg, maintenanceTasks: Object.assign({}, f.cfg.maintenanceTasks, ...extra) }, null, "\t");
	f.commit("OPS-113: register maintenance task", { "evf.config.json": config(entry("OPS-113")) });
	const approved = f.commit("OPS-113: body-only verdict", {
		"tools/evf/main.ts": "export const main = 'body-only';\n",
		"tools/evf/ship.ts": "export const ship = 'body-only';\n",
	});
	return { approved, config, entry };
}

test("AC:OPS-121-9 the #430 replay: two conflict merges of main and a simplifier commit after the approval are refused and listed", () => {
	const f = ownerFixture();
	try {
		const { approved, config, entry } = replay430(f);
		// 00bd568a: main registers another task in evf.config.json; the merge resolves the conflict by hand.
		f.mainCommit("OPS-112: register maintenance task", { "evf.config.json": config(entry("OPS-112")) });
		assert.throws(() => f.inWt("merge", "-q", "--no-edit", "origin/main"));
		writeFileSync(join(f.wt, "evf.config.json"), config(entry("OPS-112"), entry("OPS-113")));
		f.inWt("commit", "-qam", "Merge main into task/ops-113 (evf.config.json)");
		const merge1 = f.inWt("rev-parse", "HEAD");
		// 4d457248: main changes tools/evf/main.ts and ship.ts; the second merge resolves both.
		f.mainCommit("OPS-114: escaped bug becomes a check", {
			"tools/evf/main.ts": "export const main = 'escape';\n",
			"tools/evf/ship.ts": "export const ship = 'escape';\n",
		});
		assert.throws(() => f.inWt("merge", "-q", "--no-edit", "origin/main"));
		writeFileSync(join(f.wt, "tools/evf/main.ts"), "export const main = ['body-only', 'escape'];\n");
		writeFileSync(join(f.wt, "tools/evf/ship.ts"), "export const ship = ['body-only', 'escape'];\n");
		f.inWt("commit", "-qam", "Merge main into task/ops-113 (tools/evf)");
		const merge2 = f.inWt("rev-parse", "HEAD");
		// c1ea19e4: the simplifier's code commit.
		const simplify = f.commit("drop the BodyOnly export and the conditional body spread", {
			"tools/evf/ship.ts": "export const ship = ['escape'];\n",
		});
		f.publish([f.owner(approved, "looks good"), f.review(simplify)], (s) => (s.allowMerge = true));
		const message = f.refusal(() => ship(f.root, f.task, fastShip));
		assert.ok(message.includes(OWNER_VOID), message);
		assert.ok(
			message.includes(
				[
					"Commits after the approved head, oldest first:",
					`- ${f.short(merge1)} Merge main into task/ops-113 (evf.config.json)`,
					`- ${f.short(merge2)} Merge main into task/ops-113 (tools/evf)`,
					`- ${f.short(simplify)} drop the BodyOnly export and the conditional body spread`,
				].join("\n"),
			),
			message,
		);
		assert.deepEqual(f.merges(), []);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-9 the #430 shape with only a pure merge of main after the approval merges", () => {
	const f = ownerFixture();
	try {
		const { approved } = replay430(f);
		f.mainCommit("Main changes an unrelated path", { "docs/main-only.md": "Main only.\n" });
		f.inWt("merge", "-q", "--no-edit", "origin/main");
		const head = f.publish([f.owner(approved), f.review(approved)], (s) => (s.allowMerge = true));
		assert.equal(f.quietly(() => ship(f.root, f.task, fastShip)).value, 0);
		assert.deepEqual(f.merges(), [head]);
		assert.equal(f.shipped().owner_approval.approved_head, approved);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-10 a held class still merges only the exact head Sebastian approved; a pure merge never carries it", () => {
	const f = ownerFixture(["docs/catalog/", "tools/evf/", "evf.config.json"]);
	try {
		const approved = f.commit("Template change", { "docs/catalog/document-templates.json": "{}\n" });
		f.mainCommit("Main changes an unrelated path", { "docs/main-only.md": "Main only.\n" });
		f.inWt("merge", "-q", "--no-edit", "origin/main");
		const head = f.publish([f.review(approved), f.owner(approved)]);
		const merge = (sha: string) =>
			mergePullRequest({
				root: f.root,
				cfg: f.cfg,
				cwd: f.wt,
				number: 77,
				sha,
				ownerApproval: { quote: WORDS, approved_head: approved },
			});
		// The EVF-Owner record would carry over the pure merge, but the held class keeps its exact-head rule.
		assert.throws(
			() => merge(head),
			/Sebastian approved [0-9a-f]{10}, not [0-9a-f]{10}\. His approval does not carry over to a new head/,
		);
		assert.throws(
			() => mergePullRequest({ root: f.root, cfg: f.cfg, cwd: f.wt, number: 77, sha: head }),
			/document-template paths/,
		);
		assert.deepEqual(f.merges(), []);
		// The held route keeps the exact-head verifier rule: no carry over the merge, no queue, no branch update.
		assert.match(
			f.refusal(() => ship(f.root, f.task, fastShip)),
			/Missing verifier approval for the exact PR head/,
		);
		f.publish([f.review(head), f.owner(approved)]);
		const { out } = f.quietly(() => ship(f.root, f.task, fastShip));
		assert.match(out, /evf ship does not merge PR #77: it changes document-template paths .*--owner-approval/);
		assert.deepEqual([f.merges(), f.calls("update-branch")], [[], []]);
	} finally {
		f.close();
	}
});

/** A task at the ci stage: the verifier passed, so the next drive pass runs ci on PR #77. */
function atCi(f: Fx) {
	approvedWork(f);
	const db = openWorkDb(f.root);
	const row = ensureTask(db, f.task, "implement");
	db.prepare("UPDATE tasks SET spec = ?, pr_number = 77, status = 'pr_open' WHERE id = ?").run(
		"Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.",
		row.id,
	);
	for (const [stage, role, session] of [
		["implement", "implementer", AUTHOR.session],
		["verify", "verifier", VERIFIER.session],
	] as const)
		db.prepare(
			"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, 'passed', ?)",
		).run(row.id, stage, role, session, new Date().toISOString());
	db.close();
	/** Runs the ci stage once with these reported checks and returns its run row. */
	return (checks: unknown[], edit: (s: any) => void = () => {}) => {
		f.publish([], (s) => {
			s.requiredChecks = checks;
			edit(s);
		});
		const d = openWorkDb(f.root);
		try {
			// Each case starts from the passed verify again: the earlier ci run and its events are gone, no round lost.
			d.exec(`DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ${row.id} AND stage = 'ci')`);
			d.prepare("DELETE FROM runs WHERE task_id = ? AND stage = 'ci'").run(row.id);
			d.prepare("UPDATE tasks SET round = 0, status = 'pr_open' WHERE id = ?").run(row.id);
			const n = f.quietly(() => driveOnce(f.root, f.task, TIMING)).value;
			assert.equal(n.stage, "ci");
			return {
				...(d.prepare("SELECT status, summary FROM runs WHERE task_id = ? AND stage = 'ci'").get(row.id) as {
					status: string;
					summary: string;
				}),
			};
		} finally {
			d.close();
		}
	};
}

test("AC:OPS-121-11 the ci stage is green only when every required check passed on the PR head, and lists them", () => {
	const f = ownerFixture();
	try {
		const ci = atCi(f);
		assert.deepEqual(ci([pass("ci"), pass("pr-body"), pass("Vercel")]), {
			status: "passed",
			summary: "CI green: required ci, pr-body passed",
		});
		// Required names come from the rulesets too; skipped counts as failed.
		assert.deepEqual(
			ci([pass("ci"), pass("pr-body"), { ...pass("rules-check"), bucket: "skipping" }], (s) => {
				s.rules = [
					{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "rules-check" }] } },
				];
			}),
			{ status: "failed", summary: "Required CI failed on the PR head: rules-check" },
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-121-12 AC:OPS-121-13 the ci stage: only Vercel, a failed, a pending or a conflicting head is not green; an all-passed head is", () => {
	const f = ownerFixture();
	try {
		const ci = atCi(f);
		// Only a non-required status passed: never green; the wait runs out and names both missing checks.
		assert.deepEqual(ci([pass("Vercel")]), {
			status: "failed",
			summary: "Required CI is not green after 0 min: ci missing, pr-body missing",
		});
		// A failed required check ends the stage at once.
		const started = Date.now();
		assert.deepEqual(
			ci(
				[
					{ ...pass("ci"), bucket: "fail" },
					{ ...pass("pr-body"), bucket: "pending" },
				],
				(s) => (s.checksError = 1),
			),
			{
				status: "failed",
				summary: "Required CI failed on the PR head: ci",
			},
		);
		assert.ok(Date.now() - started < TIMING.ciWaitMs + 1500);
		// A pending required check waits, then fails naming it.
		assert.deepEqual(ci([pass("ci"), { ...pass("pr-body"), bucket: "pending" }]), {
			status: "failed",
			summary: "Required CI is not green after 0 min: pr-body pending",
		});
		// A PR that conflicts with main never starts its checks: the stage fails at once, naming both.
		assert.deepEqual(
			ci([pass("Vercel")], (s) => (s.pr.mergeable = "CONFLICTING")),
			{
				status: "failed",
				summary: "PR #77 conflicts with main, so required CI never starts on its head: ci missing, pr-body missing",
			},
		);
		// Every required check passed.
		assert.deepEqual(ci([pass("Vercel"), pass("ci"), pass("pr-body")]), {
			status: "passed",
			summary: "CI green: required ci, pr-body passed",
		});
		assert.equal(existsSync(join(evfDataDir(f.root), "shipped")), false, "the ci stage never ships");
	} finally {
		f.close();
	}
});
