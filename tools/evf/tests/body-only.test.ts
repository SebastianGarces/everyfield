import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { driveOnce, nextStage, runDone } from "../drive.ts";
import { parseTask, runtimeDir } from "../lib.ts";
import { checkPr, ship } from "../ship.ts";
import { approve } from "../approve.ts";
import { verify } from "../verify.ts";
import { unmetBodyItem } from "../pr-body.ts";

/** OPS-113: the body_only verdict, the body stage, ship's body item check and the PR #416 replay. */

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
const EXPERIENCE = { verdict: "approved", budget: "met" };
const ITEMS = [
	{ present: "The verifier reviewed this head.", why: "How it was verified names an old head." },
	{ absent: "still to come", why: "The verifier already reviewed the code." },
];
const SPEC = "Goal: g.\nDone criteria:\n1. One.\n2. Two.\nNon-goals: none.";
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 10 };

/** A body from the PR template with `line` added to the Summary section. */
function prBody(line: string, author = AUTHOR) {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	const sections = template
		.split("\n")
		.filter((l) => l.startsWith("## "))
		.map((heading, i) => `${heading}\nConcrete task evidence.${i === 0 ? ` ${line}` : ""}`);
	return `${sections.join("\n\n")}\n\nEVF-Author: ${JSON.stringify(author)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}
const BEFORE = prBody("The verifier is still to come."),
	AFTER = prBody("The verifier reviewed this head.");
const reviewLine = (head: string, extra: Record<string, unknown> = {}, items: unknown = ITEMS) =>
	`EVF-Review: ${JSON.stringify({ head, verifier: VERIFIER, verdict: "body_only", body: items, quality: QUALITY, experience: EXPERIENCE, ...extra })}`;

/**
 * An OPS-1 PR at a reviewed head with a remote, required CI green and one body_only review. `route` registers the
 * task on an owner route (design). The store knows the implementer and verifier sessions, as for a driven task.
 */
function bodyFixture(opts: { route?: string; author?: typeof AUTHOR; before?: string } = {}) {
	const f = fixture(),
		task = parseTask("OPS-1"),
		author = opts.author ?? AUTHOR;
	f.cfg.maintenanceTasks = {
		"OPS-1": {
			title: "Body",
			owningPaths: opts.route === "design" ? ["design/"] : ["tools/evf/"],
			checks: f.cfg.checks,
			...(opts.route ? { route: opts.route } : {}),
		},
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
	f.git("push", "-q", "origin", "main");
	const wt = f.task(task.slug);
	const inWt = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
	const dir = opts.route === "design" ? "design" : "tools/evf";
	mkdirSync(join(wt, dir), { recursive: true });
	writeFileSync(join(wt, dir, "feature.txt"), "reviewed work\n");
	inWt("add", dir);
	inWt("commit", "-qm", "Reviewed work");
	const sha = inWt("rev-parse", "HEAD");
	const before = opts.before ?? (author === AUTHOR ? BEFORE : prBody("The verifier is still to come.", author));
	const state = f.getState();
	state.pr = {
		number: 77,
		url: "https://github.com/test/private/pull/77",
		state: "OPEN",
		isDraft: false,
		headRefName: task.branch,
		headRefOid: sha,
		baseRefName: "main",
		body: before,
		labels: [],
		files: [{ path: `${dir}/feature.txt` }],
	};
	state.protection = { required_status_checks: { strict: true, contexts: ["CI"] } };
	state.requiredChecks = [
		{ name: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
	];
	state.comments["77"] = [
		{ body: `Body only.\n\n${reviewLine(sha)}`, html_url: "https://github.com/test/private/pull/77#c1" },
	];
	f.setState(state);
	const db = openWorkDb(f.root),
		row = ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET spec = ?, worktree = ?, pr_number = 77, status = 'pr_open' WHERE id = ?").run(
		SPEC,
		wt,
		row.id,
	);
	const insertRun = (stage: string, role: string, status: string, session: string | null = null) =>
		Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
				)
				.run(row.id, stage, role, session, status, new Date().toISOString()).lastInsertRowid,
		);
	const bodyFile = join(runtimeDir(f.root, task), "pr-body.md");
	mkdirSync(runtimeDir(f.root, task), { recursive: true });
	writeFileSync(bodyFile, before);
	const setPr = (edit: (s: any) => void) => {
		const s = f.getState();
		edit(s);
		f.setState(s);
	};
	const taskRow = () =>
		db.prepare("SELECT status, round, pr_number, spec FROM tasks WHERE id = ?").get(row.id) as {
			status: string;
			round: number;
			pr_number: number;
			spec: string;
		};
	const runs = () =>
		db
			.prepare("SELECT id, stage, role, status, round, summary FROM runs WHERE task_id = ? ORDER BY id")
			.all(row.id) as Array<{
			id: number;
			stage: string;
			role: string;
			status: string;
			round: number;
			summary: string | null;
		}>;
	const proofs = (head: string) => {
		for (const c of ["1", "2"])
			db.prepare(
				"INSERT INTO proofs (task_id, head_sha, criterion, status, created_at) VALUES (?, ?, ?, 'met', ?)",
			).run(row.id, head, c, new Date().toISOString());
	};
	const close = () => {
		db.close();
		f.close();
	};
	return { f, task, wt, inWt, sha, db, taskId: row.id, insertRun, bodyFile, setPr, taskRow, runs, proofs, close };
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

test("OPS-113-poster: post-review.mjs posts body_only with its items and refuses an empty list, a malformed item and an unapproved quality or experience", () => {
	const f = fixture();
	try {
		// A copy of the poster and the evf code it imports, so it reads this fixture, not the real store.
		cpSync(join(source, "tools/evf"), join(f.root, "tools/evf"), { recursive: true });
		mkdirSync(join(f.root, ".agents/skills/verify-preview"), { recursive: true });
		cpSync(
			join(source, ".agents/skills/verify-preview/scripts"),
			join(f.root, ".agents/skills/verify-preview/scripts"),
			{ recursive: true },
		);
		const head = "c".repeat(40);
		const view = {
			headRefOid: head,
			headRefName: "task/ops-1",
			url: "https://github.com/test/private/pull/9",
			body: BEFORE,
		};
		writeFileSync(
			join(f.root, "fake-bin/gh"),
			`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(view))});\n`,
		);
		const report = join(f.root, "report.md");
		writeFileSync(
			report,
			"## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n| body path | delivered |\n\n## Code quality\nApproved.\n\n## Experience\nNot applicable.\n",
		);
		const post = (verdict: string, items?: unknown, extra: string[] = []) => {
			const args = [
				join(f.root, ".agents/skills/verify-preview/scripts/post-review.mjs"),
				...["--pr", "9", "--report", report, "--head", head, "--verdict", verdict],
				...["--session", VERIFIER.session, "--model", "claude-opus-5-5"],
				...["--budget", "met", "--principles", QUALITY.principles.join(",")],
				...(extra.includes("--quality-verdict") ? [] : ["--quality-verdict", "approved"]),
				...(extra.includes("--experience-verdict") ? [] : ["--experience-verdict", "approved"]),
				...extra,
				"--dry-run",
			];
			if (items !== undefined) {
				const file = join(f.root, "items.json");
				writeFileSync(file, typeof items === "string" ? items : JSON.stringify(items));
				args.push("--body-items", file);
			}
			const r = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
			return { code: r.status, out: r.stdout + r.stderr, review: /^EVF-Review: (.+)$/m.exec(r.stdout)?.[1] };
		};
		const refused = (r: ReturnType<typeof post>, why: RegExp) => {
			assert.equal(r.code, 1, r.out);
			assert.match(r.out, why);
			assert.equal(r.review, undefined);
		};
		refused(post("body_only"), /body_only needs --body-items <file>/);
		refused(post("body_only", []), /non-empty list of body items/);
		refused(post("body_only", "not json"), /is not readable JSON/);
		refused(
			post("body_only", [{ present: "a", absent: "b", why: "both" }]),
			/body item 1 needs exactly one of "present" or "absent"/,
		);
		refused(post("body_only", [{ why: "neither" }]), /body item 1 needs exactly one of "present" or "absent"/);
		refused(
			post("body_only", [ITEMS[0], { present: "", why: "empty" }]),
			/body item 2 needs a non-empty "present" text/,
		);
		refused(post("body_only", [{ absent: "  ", why: "blank" }]), /body item 1 needs a non-empty "absent" text/);
		refused(post("body_only", [{ present: "x" }]), /body item 1 needs a non-empty "why"/);
		refused(post("body_only", [{ present: "x", why: "" }]), /body item 1 needs a non-empty "why"/);
		refused(post("body_only", [{ present: "x", why: "y", extra: 1 }]), /body item 1 needs exactly one/);
		refused(
			post("body_only", ITEMS, ["--quality-verdict", "changes_requested"]),
			/body_only needs an approved code quality review/,
		);
		refused(
			post("body_only", ITEMS, ["--experience-verdict", "changes_requested"]),
			/body_only needs an approved experience review/,
		);

		const good = post("body_only", ITEMS);
		assert.equal(good.code, 0, good.out);
		assert.match(good.out, /EVF-Review: \{"head":"c{40}","verifier":\{[^}]+\},"verdict":"body_only","body":\[/);
		const posted = JSON.parse(good.review!);
		assert.equal(posted.verdict, "body_only");
		assert.deepEqual(posted.body, ITEMS);
		assert.deepEqual(posted.quality, QUALITY);

		// approved and changes_requested keep their exact line: the same keys in the same order, no body.
		for (const verdict of ["approved", "changes_requested"]) {
			const r = post(verdict);
			assert.equal(r.code, 0, r.out);
			assert.deepEqual(
				r.review,
				JSON.stringify({
					head,
					verifier: VERIFIER,
					verdict,
					quality: QUALITY,
					experience: EXPERIENCE,
				}),
			);
		}
	} finally {
		f.close();
	}
});

test("OPS-113-ship: checkPr accepts a body_only review at the exact head only while the body meets every item; a later review at that head replaces it", () => {
	const b = bodyFixture();
	try {
		b.insertRun("implement", "implementer", "passed", AUTHOR.session);
		b.insertRun("verify", "verifier", "passed", VERIFIER.session);
		b.insertRun("ci", "evf", "passed");
		// The body before the fix names the first unmet item.
		assert.throws(
			() => checkPr(b.f.root, 77, b.sha),
			/body_only review of [0-9a-f]{10} lists a body item the PR body does not meet: present "The verifier reviewed this head\." \(How it was verified names an old head\.\)/,
		);
		// The match is exact text: "Still to come" is not "still to come".
		b.setPr((s) => (s.pr.body = prBody("The verifier reviewed this head. Still to come: nothing.")));
		assert.equal(checkPr(b.f.root, 77, b.sha).approval.verdict, "body_only");
		b.setPr((s) => (s.pr.body = prBody("The verifier reviewed this head. It is still to come.")));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /does not meet: absent "still to come"/);

		b.setPr((s) => (s.pr.body = AFTER));
		const accepted = checkPr(b.f.root, 77, b.sha);
		assert.equal(accepted.approval.verdict, "body_only");
		assert.equal(accepted.approval.head, b.sha);
		assert.deepEqual(accepted.approval.body, ITEMS);
		assert.equal(accepted.approvalUrl, "https://github.com/test/private/pull/77#c1");

		// A later changes_requested at the same head replaces the body_only review.
		const later = (line: string) =>
			b.setPr((s) =>
				s.comments["77"].push({
					body: line,
					html_url: `https://github.com/test/private/pull/77#c${s.comments["77"].length + 1}`,
				}),
			);
		later(
			`EVF-Review: ${JSON.stringify({ head: b.sha, verifier: VERIFIER, verdict: "changes_requested", quality: QUALITY, experience: EXPERIENCE })}`,
		);
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /Missing verifier approval for the exact PR head/);
		// A later body_only with other items replaces it again, and its items are the ones checked.
		later(reviewLine(b.sha, {}, [{ present: "Owner item 5", why: "Name owner item 5." }]));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /does not meet: present "Owner item 5"/);
		// A body_only review whose quality or experience is not approved never approves the head.
		later(reviewLine(b.sha, { quality: { ...QUALITY, verdict: "changes_requested" } }));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /Code quality must be approved before shipping/);
		later(reviewLine(b.sha, { experience: { verdict: "changes_requested", budget: "met" } }));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /Experience must be approved before shipping/);
		// A malformed body_only line is no review: the earlier one at the head stays the latest valid one.
		later(reviewLine(b.sha, {}, []));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /Experience must be approved before shipping/);
		later(reviewLine(b.sha));
		assert.equal(checkPr(b.f.root, 77, b.sha).approval.verdict, "body_only");
	} finally {
		b.close();
	}
});

test("OPS-113-ship: a body_only review keeps independence, recorded sessions, required CI and the unchanged-body check during merge", () => {
	const b = bodyFixture();
	try {
		b.setPr((s) => (s.pr.body = AFTER));
		b.insertRun("implement", "implementer", "passed", AUTHOR.session);
		b.insertRun("ci", "evf", "passed");
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /no verifier session 22222222-.* evf never launched/);
		b.insertRun("verify", "verifier", "passed", VERIFIER.session);
		assert.equal(checkPr(b.f.root, 77, b.sha).approval.verdict, "body_only");

		b.setPr(
			(s) =>
				(s.comments["77"] = [
					{ body: reviewLine(b.sha, { verifier: { ...VERIFIER, session: AUTHOR.session } }), html_url: "u" },
				]),
		);
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /independent session/);
		b.setPr(
			(s) =>
				(s.comments["77"] = [
					{ body: reviewLine(b.sha, { verifier: { ...VERIFIER, model: "claude-sonnet-5-5" } }), html_url: "u" },
				]),
		);
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /Opus model/);
		b.setPr((s) => (s.comments["77"] = [{ body: reviewLine(b.sha), html_url: "u" }]));

		b.setPr((s) => (s.requiredChecks[0].bucket = "fail"));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /CI must be green/);
		b.setPr((s) => (s.requiredChecks[0].bucket = "pass"));

		// The body changes between the first read and the last one: refused, even though both bodies meet the items.
		b.setPr((s) => (s.prViewBodies = [AFTER, `${AFTER.replace("Concrete task evidence.", "Edited evidence.")}`]));
		assert.throws(() => checkPr(b.f.root, 77, b.sha), /PR changed during merge checks/);
		// An unchanged body passes the same check.
		b.setPr((s) => (s.prViewBodies = [AFTER, AFTER]));
		assert.equal(checkPr(b.f.root, 77, b.sha).approval.verdict, "body_only");
	} finally {
		b.close();
	}
});

test("OPS-113-carry: a body_only approval carries over a merge-only head with its items checked on that head's body; a code commit does not carry", () => {
	const b = bodyFixture();
	try {
		b.setPr((s) => (s.pr.body = AFTER));
		// Main moves on a path the PR does not change; the branch merges it cleanly.
		writeFileSync(join(b.f.root, "docs/main-only.md"), "Main only.\n");
		b.f.git("add", "docs/main-only.md");
		b.f.git("commit", "-qm", "Main changes docs/main-only.md");
		b.f.git("push", "-q", "origin", "main");
		b.inWt("fetch", "-q", "origin", "main");
		b.inWt("merge", "-q", "--no-edit", "origin/main");
		const merged = b.inWt("rev-parse", "HEAD");
		b.setPr((s) => (s.pr.headRefOid = merged));
		const carried = checkPr(b.f.root, 77, merged, { carry: true });
		assert.equal(carried.approval.verdict, "body_only");
		assert.equal(carried.carry?.approvedHead, b.sha);
		assert.equal(carried.carry?.head, merged);
		assert.throws(
			() => checkPr(b.f.root, 77, merged),
			/Missing verifier approval for the exact PR head/,
			"only the carry route carries",
		);

		// The merged head's body is the one checked.
		b.setPr((s) => (s.pr.body = BEFORE));
		assert.throws(
			() => checkPr(b.f.root, 77, merged, { carry: true }),
			/does not meet: present "The verifier reviewed this head\."/,
		);
		b.setPr((s) => (s.pr.body = AFTER));

		// A code commit after the review: the existing "does not carry" refusal.
		writeFileSync(join(b.wt, "tools/evf/feature.txt"), "new work after the review\n");
		b.inWt("commit", "-qam", "New work after the review");
		const code = b.inWt("rev-parse", "HEAD");
		b.setPr((s) => (s.pr.headRefOid = code));
		assert.throws(
			() => checkPr(b.f.root, 77, code, { carry: true }),
			/The approval of [0-9a-f]{10} does not carry: [0-9a-f]{10} is not a merge of main/,
		);
	} finally {
		b.close();
	}
});

test("OPS-113-owner: a body_only review alone never merges an owner-route PR; evf approve reads it through checkPr and still needs the owner words and the exact head", () => {
	const b = bodyFixture({ route: "design" });
	try {
		b.f.git("push", "-q", "origin", b.task.branch);
		const merges = () => b.f.getState().calls.filter((c: any) => c.args[0] === "pr" && c.args[1] === "merge");
		b.setPr((s) => (s.pr.body = AFTER));
		// ship verifies the design route and waits: no merge.
		assert.equal(
			quiet(() => ship(b.f.root, b.task)),
			0,
		);
		assert.deepEqual(merges(), []);
		const status = b.f.getState().calls.find((c: any) => c.args.some((a: string) => a.endsWith(`statuses/${b.sha}`)));
		assert.ok(status.args.includes("state=success"), "ship recorded the verifier pass");
		b.setPr((s) => {
			s.pr = {
				...s.pr,
				title: "Fixture PR",
				mergeStateStatus: "CLEAN",
				files: [{ path: "design/everyfield-marketing.html" }],
			};
			s.commitStatus = {
				statuses: [
					{ context: "evf/verify", state: "success", description: `Verified by anthropic at ${b.sha.slice(0, 10)}` },
				],
			};
		});
		for (const ownerApproval of [undefined, "", "yes"])
			assert.throws(() => approve(b.f.root, 77, { ownerApproval }), /Quote Sebastian's approval/);
		assert.throws(
			() => approve(b.f.root, 77, { ownerApproval: "Approved for this PR", head: "a".repeat(40) }),
			/not the a{40} Sebastian approved/,
		);
		// approve reads the body_only review through checkPr: an unmet item refuses before any merge.
		b.setPr((s) => (s.pr.body = BEFORE));
		assert.throws(
			() => approve(b.f.root, 77, { ownerApproval: "Approved for this PR", head: b.sha }),
			/does not meet: present "The verifier reviewed this head\."/,
		);
		assert.deepEqual(merges(), []);
		// The owner's words, the exact head and a met body reach the merge, exactly as for an approved review.
		b.setPr((s) => (s.pr.body = AFTER));
		assert.throws(
			() => approve(b.f.root, 77, { ownerApproval: "Approved for this PR", head: b.sha }),
			/fixture merge barrier/,
		);
		assert.deepEqual(merges()[0].args, ["pr", "merge", "77", "--squash", "--match-head-commit", b.sha]);
	} finally {
		b.close();
	}
});

// PR #416 (WP-036): the blocking review at 6b97c92 asked only for body fixes; the second verifier approved the same
// head after the author rewrote the body. The fixtures are the body at that review, the body after the fix and the
// review's one blocking finding as body items. The fixture branch head stands in for 6b97c92.
const PR416 = join(import.meta.dirname, "fixtures/pr416");
const recorded = JSON.parse(readFileSync(join(PR416, "review.json"), "utf8")) as {
	head: string;
	review: { verifier: typeof VERIFIER; body: Array<Record<string, string>>; quality: unknown; experience: unknown };
};
const AT_REVIEW = readFileSync(join(PR416, "body-at-review.md"), "utf8"),
	FIXED = readFileSync(join(PR416, "body-after.md"), "utf8");
const AUTHOR416 = JSON.parse(/^EVF-Author: (.+)$/m.exec(FIXED)![1]);

/** The #416 PR in a fixture: its body at the blocking review, its EVF-Author session and its verifier session. */
function replay416() {
	const b = bodyFixture({ author: AUTHOR416, before: AT_REVIEW });
	b.insertRun("implement", "implementer", "passed", AUTHOR416.session);
	// The author checks ran at the head (the pr stage needs a verified head to push).
	quiet(() => verify(b.f.root, b.task, "author", "full"));
	b.proofs(b.sha);
	const review = {
		head: b.sha,
		verifier: recorded.review.verifier,
		verdict: "body_only",
		body: recorded.review.body,
		quality: recorded.review.quality,
		experience: recorded.review.experience,
	};
	b.setPr((s) => {
		s.comments["77"] = [
			{
				body: `Recorded #416 finding.\n\nEVF-Review: ${JSON.stringify(review)}`,
				html_url: "https://github.com/test/private/pull/77#416",
			},
		];
		s.allowMerge = true;
		s.mergeBranch = b.task.branch;
	});
	const verifyRun = b.insertRun("verify", "verifier", "started", recorded.review.verifier.session);
	quiet(() =>
		runDone(b.f.root, verifyRun, {
			status: "body-only",
			summary: "Code approved at 6b97c92; the body is out of date.",
		}),
	);
	const next = () =>
		JSON.parse(
			spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "next", "OPS-1"], {
				cwd: b.f.root,
				encoding: "utf8",
			}).stdout,
		);
	return { ...b, next };
}

test("OPS-113-replay: PR #416 at 6b97c92 reaches a mergeable checkPr through verify (body_only), body, ci and ship with one verifier run and no round", () => {
	assert.equal(recorded.head, "6b97c927dd3490a7ab0a4fd92d431e206a225d2a");
	assert.ok(recorded.review.body.length >= 3);
	assert.ok(unmetBodyItem(AT_REVIEW, recorded.review.body as never), "the body at the review fails the items");
	assert.equal(unmetBodyItem(FIXED, recorded.review.body as never), undefined, "the fixed body meets every item");
	const r = replay416();
	try {
		assert.throws(() => checkPr(r.f.root, 77, r.sha), /does not meet/, "the body at the review is not mergeable");
		let n = r.next();
		assert.deepEqual([n.stage, n.role, n.round], ["body", "implementer", 0]);

		// The body seat writes the fixed body and closes passed; evf pushes it and checks it.
		const bodyRun = r.insertRun("body", "implementer", "started");
		writeFileSync(r.bodyFile, FIXED);
		quiet(() => runDone(r.f.root, bodyRun, { status: "passed", summary: "Body updated." }));
		assert.equal(r.runs().at(-1)!.status, "passed", r.runs().at(-1)!.summary ?? "");
		assert.equal(r.f.getState().pr.body, FIXED, "evf pushed the body with evf pr open");
		assert.equal(r.inWt("rev-parse", "HEAD"), r.sha, "the head did not move");
		n = r.next();
		assert.deepEqual([n.stage, n.round], ["ci", 0]);

		assert.equal(quiet(() => driveOnce(r.f.root, r.task, TIMING)).stage, "ci");
		assert.equal(r.next().stage, "ship");
		const evidence = checkPr(r.f.root, 77, r.sha);
		assert.equal(evidence.approval.verdict, "body_only");
		assert.equal(evidence.head, r.sha);
		assert.equal(quiet(() => driveOnce(r.f.root, r.task, TIMING)).stage, "done");
		assert.equal(r.taskRow().status, "merged");
		const merges = r.f.getState().calls.filter((c: any) => c.args[0] === "pr" && c.args[1] === "merge");
		assert.deepEqual(merges.at(-1).args, ["pr", "merge", "77", "--squash", "--match-head-commit", r.sha]);

		const verifies = r.runs().filter((x) => x.stage === "verify");
		assert.equal(verifies.length, 1, "exactly one verifier run");
		assert.equal(r.taskRow().round, 0, "no round added");
		assert.deepEqual(
			r.runs().map((x) => x.stage),
			["implement", "verify", "body", "ci", "ship"],
		);
	} finally {
		r.close();
	}
});

test("OPS-113-replay: the same #416 replay with one commit after the verdict needs a new verify before ship", () => {
	const r = replay416();
	try {
		writeFileSync(join(r.wt, "tools/evf/feature.txt"), "one more commit after the verdict\n");
		r.inWt("commit", "-qam", "One more commit");
		const moved = r.inWt("rev-parse", "HEAD");
		let n = r.next();
		assert.equal(n.stage, "pr");
		assert.match(n.reason, /head moved after the body_only review/);

		// A body seat at the moved head cannot pass: its check names the moved head, and pr follows.
		const bodyRun = r.insertRun("body", "implementer", "started");
		writeFileSync(r.bodyFile, FIXED);
		quiet(() => runDone(r.f.root, bodyRun, { status: "passed", summary: "Body updated." }));
		assert.equal(r.runs().at(-1)!.status, "failed");
		assert.match(r.runs().at(-1)!.summary!, /head moved from the body_only review/);
		assert.equal(r.next().stage, "pr");

		// pr runs the author checks at the new head and opens the PR there; then a full verify, never ci.
		assert.equal(quiet(() => driveOnce(r.f.root, r.task, TIMING)).stage, "pr");
		assert.equal(r.runs().at(-1)!.status, "passed", r.runs().at(-1)!.summary ?? "");
		n = r.next();
		assert.deepEqual([n.stage, n.role], ["verify", "verifier"]);
		// ship refuses the old body_only review at the new head, carry or not.
		r.setPr((s) => (s.pr.headRefOid = moved));
		assert.throws(() => checkPr(r.f.root, 77, moved), /Missing verifier approval for the exact PR head/);
		assert.throws(
			() => checkPr(r.f.root, 77, moved, { carry: true }),
			/does not carry: [0-9a-f]{10} is not a merge of main/,
		);
		assert.equal(r.taskRow().round, 0);
	} finally {
		r.close();
	}
});

test("OPS-113-next: no path from a moved head reaches ci or ship after a body_only review", () => {
	const task = parseTask("OPS-1");
	const t = {
		id: 1,
		ref: task.id,
		slug: task.slug,
		mode: "implement",
		status: "pr_open",
		round: 0,
		goal_id: null,
		spec: SPEC,
		pr_number: 77,
		worktree: null,
		seat_model: null,
		seat_effort: null,
	};
	const run = (stage: string, status: string, id: number, role = "x") => ({
		id,
		stage,
		role,
		status,
		round: 0,
		summary: "s",
	});
	const verified = run("verify", "passed", 1, "verifier");
	const at = { head: "a".repeat(40) };
	for (const last of [
		[],
		[run("body", "passed", 2, "implementer")],
		[run("body", "failed", 2, "implementer")],
		[run("body", "aborted", 2, "implementer")],
	]) {
		const runs = [verified, ...last];
		assert.equal(nextStage(task, t, runs, false, 0, { bodyOnly: { ...at, moved: true } }).stage, "pr");
		const same = nextStage(task, t, runs, false, 0, { bodyOnly: { ...at, moved: false } }).stage;
		assert.equal(same, last[0]?.status === "passed" ? "ci" : "body");
	}
	// Without a body_only approval in force, a passed verify goes to ci as before and a body run goes to pr.
	assert.equal(nextStage(task, t, [verified]).stage, "ci");
	assert.equal(nextStage(task, t, [verified, run("body", "passed", 2)]).stage, "pr");
});
