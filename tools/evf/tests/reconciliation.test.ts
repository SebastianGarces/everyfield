import { checkPrBody } from "../pr-body.ts";
import { prImages } from "../../wiki/pr-images.ts";
import { createHash } from "node:crypto";
import { packageContext, loadProgress, partsOf } from "../lib.ts";
import { feedbackPromote, feedbackIdeas } from "../feedback.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { buildBlocks, renderBlocks } from "../plan.ts";
import { loadDag, loadRegistry } from "../lib.ts";

const source = resolve(import.meta.dirname, "../../..");
test("BUG-workflow: preserve selected producer dependencies across forward references", () => {
	const f = fixture();
	try {
		const dag = loadDag(f.root);
		const { blocks } = buildBlocks(f.root, dag.packages);
		const by = new Map(blocks.map((b) => [b.wp, blocks.filter((x) => x.wp === b.wp)]));
		for (const p of dag.packages)
			for (const d of p.depends_on) {
				const producer = by.get(d)!;
				const finals = [
					producer.find((b) => b.part === "contract") ?? producer.find((b) => b.part === "api") ?? producer[0],
				].map((b) => b.key);
				for (const b of by.get(p.id)!)
					for (const key of finals) assert.ok(b.dependsOn.includes(key), `${b.taskId} lost ${d}: ${key}`);
			}
		const progressPath = join(f.root, "docs/build-progress.json"),
			progress = JSON.parse(readFileSync(progressPath, "utf8"));
		progress.packages["WP-097"].status = "done";
		writeFileSync(progressPath, JSON.stringify(progress));
		const completed = buildBlocks(f.root, dag.packages).blocks;
		assert.deepEqual(completed.find((b) => b.taskId === "WP-087")!.dependsOn, []);
	} finally {
		f.close();
	}
});
test("INV-context: load current acceptance and fail when its required input is missing", () => {
	const registry = loadRegistry(source);
	const index = JSON.parse(readFileSync(join(source, "docs/catalog/index.json"), "utf8"));
	const catalog = JSON.parse(readFileSync(join(source, index.acceptance_source), "utf8"));
	assert.equal(index.counts.active_acceptance_bundles, catalog.length);
	assert.equal(registry.length, index.counts.active_acceptance_bundles);
	assert.deepEqual(
		registry.map((a) => a.id),
		catalog.map((a: { id: string }) => a.id),
	);
	const root = mkdtempSync(join(tmpdir(), "evf-context-"));
	try {
		cpSync(join(source, "docs"), join(root, "docs"), { recursive: true });
		rmSync(join(root, "docs/catalog/requirements/people.json"));
		assert.throws(() => loadRegistry(root), /people.json/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import { fixture } from "./fixtures.ts";
import { parseTask, evfDataDir, loadConfig } from "../lib.ts";
import {
	feedbackTriage,
	startFeedbackTask,
	feedbackQueue,
	cachedTriage,
	readTriage,
	onFeedbackShipped,
	startedToday,
} from "../feedback.ts";
import { verify } from "../verify.ts";
import { taskStart } from "../task.ts";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";

test("INV-authorization: unready override and unopened application gate cannot mutate worktrees", () => {
	const f = fixture();
	try {
		const path = join(f.root, "docs/plan/release-gates.json"),
			gates = JSON.parse(readFileSync(path, "utf8"));
		gates.gates.find((g: { id: string }) => g.id === "G-AUTH").status = "not-authorized";
		writeFileSync(path, JSON.stringify(gates));
		assert.throws(
			() => taskStart(f.root, parseTask("WP-001"), { allowUnready: true, noStack: true }),
			/allow-unready is removed/,
		);
		assert.throws(
			() => taskStart(f.root, parseTask("WP-001"), { allowUnready: false, noStack: true }),
			/G-AUTH is not closed for application implementation/,
		);
		assert.equal(f.git("branch", "--list", "task/*"), "");
	} finally {
		f.close();
	}
});
test("INV-public-feedback: private triage text and routing never enter public provider payloads; bot provenance holds on direct calls", () => {
	const f = fixture();
	try {
		feedbackTriage(f.root, 1, {
			cls: "p1",
			reason: "Private PERSON SECRET original",
			area: "PRIVATE-PATH",
			wp: "WP-001",
		});
		const payload = f.getState().calls.find((c: any) => c.args[1] === "comment").body;
		assert.match(payload, /^Status: triaged:p1\.\n<!-- evf-feedback-status /);
		for (const secret of ["PERSON", "SECRET", "PRIVATE-PATH", "WP-001", "triagedBy", "featureId", "reason"])
			assert.equal(payload.includes(secret), false, secret);
		assert.equal(readTriage(f.root, 1)?.class, "p1");
		const s = f.getState();
		s.issues[1].user = { id: 999, login: "attacker" };
		f.setState(s);
		assert.throws(() => feedbackTriage(f.root, 2, { cls: "p1", reason: "fake bot" }), /verified app-bot/);
		assert.throws(
			() => feedbackTriage(f.root, 1, { cls: "question", reason: "question", reply: "private reply" }),
			/exact human review/,
		);
	} finally {
		f.close();
	}
});
test("BUG-feedback-budget: cached triage does not bypass daily cap and repeated starts consume one slot", () => {
	const f = fixture();
	try {
		f.authorize();
		f.cfg.feedback.dailyFixLimit = 1;
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.git("remote", "add", "origin", "https://example.invalid/private.git");
		for (const n of [1, 2]) feedbackTriage(f.root, n, { cls: "p1", reason: "internal triage", wp: "WP-001" });
		assert.equal(startFeedbackTask(f.root, parseTask("FB-1"), false).issue, 1);
		assert.equal(startFeedbackTask(f.root, parseTask("FB-1"), false).issue, 1);
		assert.equal(startedToday(f.root), 1);
		assert.throws(() => startFeedbackTask(f.root, parseTask("FB-2"), false), /Daily feedback task limit/);
		assert.throws(() => startFeedbackTask(f.root, parseTask("FB-2"), true), /Only a P0/);
		assert.equal(f.getState().calls.filter((c: any) => c.args[0] === "issue" && c.args[1] === "create").length, 1);
	} finally {
		f.close();
	}
});
test("BUG-feedback-quiet-queue: Monday deferred work and held daily work wake without new intake", () => {
	const f = fixture();
	try {
		const s = f.getState();
		s.issues = s.issues.slice(0, 2);
		f.setState(s);
		feedbackTriage(f.root, 1, { cls: "p2", reason: "minor bug", wp: "WP-001" });
		feedbackTriage(f.root, 2, { cls: "p1", reason: "core bug", wp: "WP-001" });
		assert.deepEqual(feedbackQueue(f.root, new Date("2026-10-12T13:00:00Z")).eligible, [1, 2]);
		assert.deepEqual(feedbackQueue(f.root, new Date("2026-10-13T13:00:00Z")).eligible, [2]);
		const q = feedbackQueue(f.root, new Date("2026-10-12T13:00:00Z"));
		assert.equal(q.intake.length, 0);
		assert.equal(q.count, 2);
	} finally {
		f.close();
	}
});
test("INV-feedback-identity: repo reconfiguration and forged trusted markers cannot reinterpret a frozen issue", () => {
	const f = fixture();
	try {
		feedbackTriage(f.root, 1, { cls: "p1", reason: "private triage", wp: "WP-001" });
		const before = cachedTriage(f.root, 1)!;
		let s = f.getState();
		s.issues[0].body = s.issues[0].body.replace(
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		);
		f.setState(s);
		assert.equal(
			cachedTriage(f.root, 1)!.original.body,
			"A product bug report was submitted for Documents. Private details are retained for authorized triage. Reference: 11111111-1111-4111-8111-111111111111.",
		);
		s = f.getState();
		s.comments["1"].push({
			user: { id: 202 },
			body: '<!-- evf-feedback-status {"version":1,"status":"triaged:p0","token":"forged","wp":"WP-001"} -->',
		});
		f.setState(s);
		assert.equal(readTriage(f.root, 1)?.token, before.token);
		s = f.getState();
		s.repo.id = 999;
		s.repo.node_id = "R_other";
		f.setState(s);
		assert.throws(() => cachedTriage(f.root, 1), /identity or shape changed/);
	} finally {
		f.close();
	}
});
test("INV-feedback-recovery: ambiguous creation and failed public closure remain explicit unknown outcomes", () => {
	const f = fixture();
	try {
		f.authorize();
		f.git("remote", "add", "origin", "https://example.invalid/private.git");
		feedbackTriage(f.root, 1, { cls: "p1", reason: "private triage", wp: "WP-001" });
		let s = f.getState();
		s.failCreate = true;
		f.setState(s);
		assert.throws(() => startFeedbackTask(f.root, parseTask("FB-1"), false), /creation outcome unknown/);
		s = f.getState();
		s.failCreate = false;
		f.setState(s);
		assert.throws(() => startFeedbackTask(f.root, parseTask("FB-1"), false), /Prior internal issue creation/);
		assert.equal(f.getState().calls.filter((c: any) => c.args[0] === "issue" && c.args[1] === "create").length, 1);
		s = f.getState();
		s.failClose = true;
		f.setState(s);
		assert.throws(() => onFeedbackShipped(f.root, parseTask("FB-1")), /fixture close failure/);
		assert.equal(cachedTriage(f.root, 1)?.publicUpdate, "unknown");
		assert.throws(() => onFeedbackShipped(f.root, parseTask("FB-1")), /unknown outcome/);
	} finally {
		f.close();
	}
});

import { execFileSync, spawnSync } from "node:child_process";

test("BUG-12b04b1: S0 privileged calls require authority despite false allowed result keys", () => {
	const root = mkdtempSync(join(tmpdir(), "evf-refusal-"));
	try {
		cpSync(join(source, "docs"), join(root, "docs"), { recursive: true });
		const check = () =>
			spawnSync("python3", [join(root, "docs/acceptance/check.py"), "--root", root], { encoding: "utf8" });
		assert.equal(check().status, 0);
		for (const [file, id, operation] of [
			["reference-release", "REFREL-001", "reference.activateGeneration"],
			["operations", "CASE-OPS-006", "fixtures.resetOwnedEnvironment"],
			["operations", "CASE-OPS-008", "dev.createIsolatedPreview"],
		]) {
			const path = join(root, `docs/acceptance/${file}.json`),
				bytes = readFileSync(path, "utf8");
			const data = JSON.parse(bytes),
				example = data.cases.find((c: { id: string }) => c.id === id);
			example.actor = { account: "A", session: "session-A", context: "P" };
			delete example.given["caller-capability"];
			writeFileSync(path, JSON.stringify(data));
			const refused = check();
			assert.equal(refused.status, 1, `${id}: false allowed result must not bypass caller authority`);
			assert.match(refused.stderr, new RegExp(`${id}: actor lacks authority for ${operation.replaceAll(".", "\\.")}`));
			example.expected = { state: {}, result: { error_code: "access_denied" }, event: null };
			writeFileSync(path, JSON.stringify(data));
			assert.equal(check().status, 0, `${id}: an explicit denial permits an unauthorized caller`);
			writeFileSync(path, bytes);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
const importGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
test("INV-feedback-reservations: old reservation charges current budget, recovery stays visible and untrusted actor cannot close", () => {
	const f = fixture();
	try {
		f.authorize();
		f.cfg.feedback.dailyFixLimit = 1;
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.git("remote", "add", "origin", "https://example.invalid/private.git");
		for (const n of [1, 2]) feedbackTriage(f.root, n, { cls: "p1", reason: "private triage", wp: "WP-001" });
		startFeedbackTask(f.root, parseTask("FB-1"), false);
		const log = join(evfDataDir(f.root), "feedback/started.jsonl");
		writeFileSync(
			log,
			readFileSync(log, "utf8") +
				JSON.stringify({ key: "R_feedback:I_2", day: "2020-01-01", state: "reserved" }) +
				"\n",
		);
		assert.throws(() => startFeedbackTask(f.root, parseTask("FB-2"), false), /Daily feedback task limit/);
		assert.deepEqual(feedbackQueue(f.root).recovery, [2]);
		const state = f.getState();
		state.user.id = 999;
		f.setState(state);
		assert.throws(() => onFeedbackShipped(f.root, parseTask("FB-1")), /explicitly trusted triage/);
		assert.equal(f.getState().issues[0].state, "open");
	} finally {
		f.close();
	}
});
test("INV-workflow-routing: Next server paths stay with implementor and presentation/browser paths route to UI", () => {
	const f = fixture();
	try {
		const pkg = loadDag(f.root).packages.find((p) => p.id === "WP-003")!;
		assert.deepEqual(partsOf(pkg), [null]);
		const { blocks } = buildBlocks(f.root, [pkg]);
		assert.equal(blocks[0].specialist, "implementor");
		const ui = loadDag(f.root).packages.find((p) =>
			p.owning_paths.some((p) => p.startsWith("apps/web/src/features/")),
		)!;
		assert.ok(buildBlocks(f.root, [ui]).blocks.some((b) => b.specialist === "ui-designer"));
		const design = loadDag(f.root).packages.find((p) => p.id === "WP-088")!;
		const planned = buildBlocks(f.root, [design]).blocks;
		assert.deepEqual(
			planned.map((b) => ({ task: b.taskId, specialist: b.specialist, paths: b.paths })),
			[
				{
					task: "WP-088",
					specialist: "ui-designer",
					paths: ["packages/ui/src/foundations/", "packages/ui/src/shell/", "tests/ui/foundations/", "tests/ui/shell/"],
				},
			],
		);
	} finally {
		f.close();
	}
});

import { ship, listShipped, prOpen, checkPr } from "../ship.ts";
import { approve } from "../approve.ts";
import { requireImplementation, requireSpend } from "../policy.ts";
test("INV-gate-phases: local evidence producers can start before runtime completion; paid commitment remains gated", () => {
	const f = fixture();
	try {
		f.authorize();
		const path = join(f.root, "docs/plan/release-gates.json"),
			gates = JSON.parse(readFileSync(path, "utf8"));
		for (const g of gates.gates) if (["G-RUNTIME", "G-RECOVERY", "G-SPEND"].includes(g.id)) g.status = "not-passed";
		writeFileSync(path, JSON.stringify(gates));
		const pp = join(f.root, "docs/build-progress.json"),
			p = JSON.parse(readFileSync(pp, "utf8"));
		p.packages["WP-002"].status = "done";
		writeFileSync(pp, JSON.stringify(p));
		requireImplementation(f.root, "WP-003");
		assert.throws(() => requireSpend(f.root), /G-SPEND/);
		gates.gates.find((g: any) => g.id === "G-AUTH").status = "not-authorized";
		writeFileSync(path, JSON.stringify(gates));
		assert.throws(() => requireImplementation(f.root, "WP-003"), /G-AUTH/);
	} finally {
		f.close();
	}
});
test("INV-human-approve: evf approve refuses without quoted owner approval and changes nothing", () => {
	const f = fixture();
	try {
		const before = f.getState().calls.length;
		for (const ownerApproval of [undefined, "", "yes"])
			assert.throws(() => approve(f.root, 6, { ownerApproval }), /Quote Sebastian's approval/);
		assert.equal(f.getState().calls.length, before);
	} finally {
		f.close();
	}
});
const approvePr = (headRefName: string, extra: Record<string, unknown> = {}) => ({
	number: 77,
	title: "Fixture PR",
	url: "https://github.com/test/private/pull/77",
	state: "OPEN",
	isDraft: false,
	baseRefName: "main",
	headRefName,
	headRefOid: "a".repeat(40),
	mergeStateStatus: "CLEAN",
	files: [{ path: "docs/reference/wiki/drafts/a1.json" }],
	...extra,
});
const approveWrites = (f: any) =>
	f
		.getState()
		.calls.filter(
			(c: any) =>
				(c.args[0] === "pr" && ["comment", "merge", "ready", "update-branch"].includes(c.args[1])) ||
				c.args.includes("POST"),
		);
test("INV-human-approve-scope: ordinary build and OPS PRs refuse evf approve before any write", () => {
	const f = fixture();
	try {
		for (const branch of ["task/wp-001", "task/ops-1", "ops/some-tooling"]) {
			const s = f.getState();
			s.pr = approvePr(branch, { files: [{ path: "tools/evf/ship.ts" }] });
			f.setState(s);
			assert.throws(
				() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
				/cannot merge it.*bin\/evf ship/,
			);
		}
		const s = f.getState();
		s.pr = approvePr("wiki/a1", { files: [{ path: "tools/evf/ship.ts" }] });
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/outside docs\/reference\/wiki/,
		);
		assert.deepEqual(approveWrites(f), []);
	} finally {
		f.close();
	}
});
test("INV-human-approve-triage: a feedback PR without its triage record refuses instead of skipping verification", () => {
	const f = fixture();
	try {
		const s = f.getState();
		s.pr = approvePr("task/fb-1");
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/FB-1 has no local triage record/,
		);
		assert.deepEqual(approveWrites(f), []);
	} finally {
		f.close();
	}
});
test("INV-human-approve-head: a behind or moved branch refuses; a stable approved head merges exactly that head", () => {
	const f = fixture();
	try {
		const s = f.getState();
		s.pr = approvePr("wiki/a1", { mergeStateStatus: "BEHIND" });
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head: "a".repeat(40) }),
			/is behind main.*ask Sebastian to approve the new head/,
		);
		s.pr = approvePr("wiki/a1", { headRefOid: "b".repeat(40) });
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head: "a".repeat(40) }),
			/not the a{40} Sebastian approved/,
		);
		assert.deepEqual(approveWrites(f), []);
		s.pr = approvePr("wiki/a1");
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head: "a".repeat(40) }),
			/fixture merge barrier/,
		);
		const merge = approveWrites(f).find((c: any) => c.args[1] === "merge");
		assert.deepEqual(merge.args, ["pr", "merge", "77", "--squash", "--match-head-commit", "a".repeat(40)]);
	} finally {
		f.close();
	}
});
test("INV-merge-policy-config: feedback merge routes must be distinct lists of known bug classes", () => {
	const f = fixture();
	try {
		for (const field of ["feedbackVerifierMerge", "feedbackOwnerAfterVerifier"])
			for (const bad of ["p2", 123, ["p9"], ["feature-small"], ["p2", "p2"], undefined]) {
				const cfg = structuredClone(f.cfg);
				cfg.mergePolicy[field] = bad;
				writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(cfg));
				assert.throws(() => loadConfig(f.root), new RegExp(`mergePolicy\\.${field} must be a list`));
			}
		const cfg = structuredClone(f.cfg);
		cfg.mergePolicy.feedbackOwnerAfterVerifier = ["p1", "p2", "p3"];
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(cfg));
		assert.throws(() => loadConfig(f.root), /p1 in both/);
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		assert.deepEqual(loadConfig(f.root).mergePolicy.feedbackVerifierMerge, ["p0", "p1"]);
	} finally {
		f.close();
	}
});
test("INV-feedback-preservation: approved owner promotion, demand ranking and exact reviewed question reply survive", () => {
	const f = fixture();
	const oldLog = console.log;
	const out: string[] = [];
	try {
		f.git("remote", "add", "origin", "https://example.invalid/private.git");
		feedbackTriage(f.root, 1, { cls: "feature-large", reason: "new product idea", wp: "WP-001" });
		feedbackTriage(f.root, 2, { cls: "duplicate", reason: "same idea", duplicateOf: "1" });
		console.log = (...xs) => out.push(xs.join(" "));
		feedbackIdeas(f.root);
		console.log = oldLog;
		assert.equal(JSON.parse(out[0])[0].demand, 2);
		assert.throws(() => feedbackPromote(f.root, 1), /explicit owner authorization/);
		f.cfg.feedback.ownerActorIds = [202];
		f.cfg.feedback.promotionApprovals = ["R_feedback:I_1"];
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		assert.equal(feedbackPromote(f.root, 1), 0);
		assert.equal(cachedTriage(f.root, 1)?.internalIssue, 801);
		const reply = "A human-reviewed public answer.";
		f.cfg.feedback.replyApprovals = { "R_feedback:I_3": createHash("sha256").update(reply).digest("hex") };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		assert.equal(feedbackTriage(f.root, 3, { cls: "question", reason: "question received", reply }), 0);
		const state = f.getState();
		assert.equal(state.issues[2].state, "closed");
		assert.equal(state.calls.find((c: any) => c.body === reply).body, reply);
	} finally {
		console.log = oldLog;
		f.close();
	}
});
test("INV-model-feedback: verified bot identity never authorizes arbitrary raw public text", () => {
	const f = fixture();
	try {
		const s = f.getState();
		s.issues[0].title = "Private PERSON name";
		s.issues[0].body = "Private original or pastoral narrative";
		f.setState(s);
		assert.throws(
			() => feedbackTriage(f.root, 1, { cls: "p1", reason: "internal reason", wp: "WP-001" }),
			/safe opaque publication marker|outside the reviewed closed/,
		);
		assert.equal(f.getState().calls.filter((c: any) => c.args[0] === "issue" && c.args[1] === "comment").length, 0);
	} finally {
		f.close();
	}
});

import { existsSync } from "node:fs";
import { stack } from "../task.ts";
import { caseCoverage, caseGrep } from "../coverage.ts";
import { producerReady, recordProgress, recordFastTrack, reconcileProgress } from "../progress.ts";
import { renderAc, renderBrief } from "../brief.ts";

test("BUG-fast-track: real prerequisite policy unlocks WP-087 only after bounded reviewed completion on main", () => {
	const f = fixture();
	try {
		// Deliberately do not call authorize(): its transitive done shortcut hid this escaped bug.
		const path = join(f.root, "docs/plan/release-gates.json"),
			gates = JSON.parse(readFileSync(path, "utf8"));
		for (const g of gates.gates)
			if (g.id === "G-AUTH") g.status = "authorized";
			else if (g.id === "G-WORKFLOW") g.status = "reconciled-independent-review";
		writeFileSync(path, JSON.stringify(gates));
		f.commit();
		const commit = f.git("rev-parse", "main"),
			progressPath = join(f.root, "docs/build-progress.json");
		const evidence = {
			commit,
			checks: [{ command: "normal tests", result: "passed", evidence: "/operator/tests.log" }],
			author: { actor: "author", model_family: "Sol" },
			verifier: {
				actor: "verifier",
				model_family: "Opus",
				verdict: "approved",
				commit,
				evidence: "intent://verifier-review",
			},
			owner_go_live: { actor: "Sebastian", commit, evidence: "intent://owner-go-live" },
		};
		assert.throws(
			() => requireImplementation(f.root, "WP-087"),
			/Prerequisites need reviewed producer\/interface milestones: WP-097/,
		);
		const before = readFileSync(progressPath, "utf8");
		for (const [wp, input, reason] of [
			["WP-087", evidence, /limited to the declared WP-097/],
			["WP-097", {}, /nonempty strings/],
			["WP-097", { ...evidence, commit: "0".repeat(40) }, /already on main/],
			["WP-097", { ...evidence, checks: [] }, /passing normal test/],
			[
				"WP-097",
				{ ...evidence, checks: [{ ...evidence.checks[0], result: "failed" }] },
				/Every fast-track test must pass/,
			],
			["WP-097", { ...evidence, verifier: { ...evidence.verifier, commit: "0".repeat(40) } }, /approvals must name/],
			["WP-097", { ...evidence, verifier: { ...evidence.verifier, model_family: "Sol" } }, /distinct author\/verifier/],
			["WP-097", { ...evidence, owner_go_live: { ...evidence.owner_go_live, actor: "author" } }, /declared owner/],
		] as const) {
			assert.throws(() => recordFastTrack(f.root, wp, input), reason);
			assert.equal(readFileSync(progressPath, "utf8"), before);
		}
		f.git("checkout", "-b", "unmerged");
		writeFileSync(join(f.root, "candidate.txt"), "unmerged");
		f.git("add", "candidate.txt");
		f.git("commit", "-qm", "Unmerged fixture commit");
		const unmerged = f.git("rev-parse", "HEAD");
		assert.throws(
			() =>
				recordFastTrack(f.root, "WP-097", {
					...evidence,
					commit: unmerged,
					verifier: { ...evidence.verifier, commit: unmerged },
					owner_go_live: { ...evidence.owner_go_live, commit: unmerged },
				}),
			/already on main/,
		);
		assert.equal(readFileSync(progressPath, "utf8"), before);
		f.git("checkout", "main");
		recordFastTrack(f.root, "WP-097", evidence);
		const after = readFileSync(progressPath, "utf8"),
			progress = JSON.parse(after);
		assert.equal(progress.packages["WP-097"].status, "done");
		assert.deepEqual(progress.packages["WP-097"].fast_track, evidence);
		requireImplementation(f.root, "WP-087");
		assert.throws(() => requireImplementation(f.root, "WP-001"), /WP-087/);
		recordFastTrack(f.root, "WP-097", evidence);
		assert.equal(readFileSync(progressPath, "utf8"), after);
		assert.throws(
			() =>
				recordFastTrack(f.root, "WP-097", {
					...evidence,
					owner_go_live: { ...evidence.owner_go_live, evidence: "different approval" },
				}),
			/already records different evidence/,
		);
		assert.equal(readFileSync(progressPath, "utf8"), after);
	} finally {
		f.close();
	}
});

test("BUG-plan-context: plan and brief use the same manifest acceptance scope, including consumed bundles", () => {
	const f = fixture();
	try {
		const pkg = loadDag(f.root).packages.find((p) => p.id === "WP-001")!;
		const context = packageContext(f.root, pkg.id),
			block = buildBlocks(f.root, [pkg]).blocks[0];
		assert.equal(block.acceptanceCount, context.acceptance_ids.length);
		assert.match(
			renderBrief(f.root, parseTask(pkg.id), {}),
			new RegExp(`Selected acceptance count: ${block.acceptanceCount}`),
		);
		assert.equal(block.acceptanceCount, 8);
		const brief = renderBrief(f.root, parseTask("WP-002"), {});
		assert.match(brief, /Goal: Provide shared trusted scope, time, revision, replay, receipt and audit contracts/);
		assert.match(brief, /Owned requirements: REQ-IDN-029, REQ-OPS-004, REQ-PI-037, REQ-PPL-024, REQ-TSK-018/);
		assert.match(brief, /Write owned cases at package start for: REQ-IDN-029, REQ-OPS-004, REQ-PI-037, REQ-PPL-024/);
		assert.match(brief, /Owned cases: AUDIT-001, AUDIT-002, AUDIT-003/);
		const selected = loadDag(f.root).packages.filter((p) => ["WP-005", "WP-088", "WP-089", "WP-090"].includes(p.id));
		const parts = buildBlocks(f.root, selected).blocks;
		assert.deepEqual(
			parts.filter((b) => b.wp === "WP-005").map((b) => [b.part, b.dependsOn]),
			[
				["contract", []],
				["api", ["wp-005-contract"]],
				["ui", ["wp-088", "wp-089", "wp-090", "wp-005-contract"]],
			],
		);
		const ui = renderBrief(f.root, parseTask("WP-005/ui"), {});
		assert.match(ui, /Design prototype: design\/everyfield-ui\.html/);
		assert.match(ui, /Screen map: design\/handoff\/screens\.md/);
		assert.match(ui, /screens\.md#L\d+: Sign in, with an invitation notice/);
		assert.match(renderBrief(f.root, parseTask("WP-048"), {}), /Design prototype: design\/everyfield-ui\.html/);
		for (const pkg of loadDag(f.root).packages.filter((p) => ["WP-088", "WP-049", "WP-097"].includes(p.id))) {
			const { blocks, external } = buildBlocks(f.root, [pkg]);
			const outputs = [renderBrief(f.root, parseTask(pkg.id), {}), renderBlocks(blocks, external, [])];
			for (const output of outputs) {
				assert.ok(
					output.includes(`UI guidance: ${pkg.ui_composition_rule ?? pkg.goal}`),
					`${pkg.id} must print its own UI guidance`,
				);
				assert.doesNotMatch(output, /reuse approved E3 pages/i);
			}
		}
	} finally {
		f.close();
	}
});

test("INV-case-coverage: one passing test covers several cases by exact name or annotation, never a failed/skipped result", () => {
	const ids = ["REF-CASE-001", "CA017", "ASMT-011"];
	const report = {
		tests: [{ name: "AC:REF-CASE-001 AC:CA017 reference install", status: "passed", annotations: ["AC:ASMT-011"] }],
	};
	assert.deepEqual(caseCoverage(ids, report), { missing: [], duplicates: [] });
	assert.deepEqual(
		caseCoverage(ids, { tests: [...report.tests, { name: "AC:CA017 alternate projection", status: "passed" }] })
			.duplicates,
		[{ caseId: "CA017", tests: [report.tests[0].name, "AC:CA017 alternate projection"] }],
	);
	for (const status of ["failed", "skipped"])
		assert.deepEqual(caseCoverage(ids, { tests: [{ ...report.tests[0], status }] }).missing, ids);
	const re = new RegExp(caseGrep(["CA017"]));
	assert.equal(re.test("AC:CA017 install"), true);
	assert.equal(re.test("AC:CA017-extra"), false);
	assert.equal(re.test("CA017"), false);
	assert.deepEqual(caseCoverage(["CA017"], { tests: [{ name: "AC:CA017-extra", status: "passed" }] }).missing, [
		"CA017",
	]);
});

import { bootstrapReadiness } from "../doctor.ts";
test("BUG-bootstrap-reader: case and full brief preserve structured fixtures, actors, clock, actions, expected and groups", () => {
	const f = fixture();
	try {
		const c = renderAc(f.root, "REF-CASE-001");
		assert.match(c, /"timezone": "America\/Chicago"/);
		assert.match(c, /"accepted_original_sha256": "d365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a"/);
		for (const field of ["given", "actor", "clock", "action", "expected"])
			assert.ok(c.includes(field + ":\n```json\n"));
		assert.doesNotMatch(c, /undefined|\[object Object\]/);
		assert.match(renderAc(f.root, "CASE-DOC-004"), /group:\n```json\n"frozen-template-generation"/);
		const subcases = renderAc(f.root, "SCHEMA-004");
		assert.match(subcases, /subcases:\n```json\n/);
		assert.match(subcases, /"name": "completion-without-assignment"/);
		assert.match(subcases, /"earned_credit": true/);
		const full = renderBrief(f.root, parseTask("WP-001"), { full: true });
		assert.ok(full.includes(c));
		assert.doesNotMatch(full, /fixture undefined|\[object Object\]/);
		const catalog = loadRegistry(f.root);
		assert.ok(renderAc(f.root, catalog.find((e) => e.case_ids.includes("REF-CASE-001"))!.id).includes(c));
	} finally {
		f.close();
	}
});

function validPrBody() {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	return (
		template
			.split("\n")
			.filter((line) => line.startsWith("## "))
			.map((heading) => heading + "\nConcrete task evidence.")
			.join("\n\n") + "\n\nEVF-Author: openai\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
	);
}

const approvedQuality = {
	verdict: "approved",
	principles: [
		"laziness-protocol",
		"minimize-reader-load",
		"subtract-before-you-add",
		"test-behavior-not-implementation",
	],
};

const approvedExperience = { verdict: "approved", budget: "met" };

function mergeFixture() {
	const f = fixture(),
		task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = {
		[task.id]: { title: "Workflow upkeep", owningPaths: ["tools/evf/"], checks: f.cfg.checks },
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const bare = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", bare);
	f.git("push", "-q", "origin", "main");
	const wt = f.task(task.slug),
		sha = f.git("rev-parse", task.branch),
		state = f.getState();
	state.pr = {
		number: 77,
		url: "https://github.com/test/private/pull/77",
		state: "OPEN",
		isDraft: false,
		headRefOid: sha,
		baseRefName: "main",
		body: validPrBody(),
	};
	state.requiredChecks = [
		{ name: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
	];
	state.comments["77"] = [
		{
			body: `Verified the actual tooling behavior.\n\nEVF-Review: ${JSON.stringify({ head: sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
			html_url: "https://github.com/test/private/pull/77#issuecomment-1",
		},
	];
	f.setState(state);
	return { ...f, taskRef: task, wt, sha };
}

test("BUG-c048ea5-body-path: PR create and edit read body files relative to the caller", () => {
	const f = mergeFixture(),
		cwd = process.cwd();
	try {
		const caller = join(realpathSync(f.root), "fake-bin/caller");
		mkdirSync(caller);
		verify(f.root, f.taskRef, "author", "full");
		const body = validPrBody(),
			file = join(caller, "review.md");
		writeFileSync(file, body);
		process.chdir(caller);
		for (const state of ["OPEN", "CLOSED"])
			for (const path of ["./review.md", file]) {
				const provider = f.getState();
				provider.pr.state = state;
				provider.calls = [];
				f.setState(provider);
				assert.equal(prOpen(f.root, f.taskRef, path), 0);
				const call = f
					.getState()
					.calls.find((c) => c.args[0] === "pr" && c.args[1] === (state === "OPEN" ? "edit" : "create"));
				assert.equal(call.body, body);
				assert.equal(call.args[call.args.indexOf("--body-file") + 1], file);
			}
	} finally {
		process.chdir(cwd);
		f.close();
	}
});

test("BUG-c048ea5-folder-path: maintenance refuses an existing folder without a trailing slash before creating its worktree", () => {
	const f = fixture(),
		task = parseTask("OPS-1");
	try {
		mkdirSync(join(f.root, "docs/tooling"));
		f.cfg.maintenanceTasks = {
			[task.id]: { title: "Workflow upkeep", owningPaths: ["docs/tooling"], checks: f.cfg.checks },
		};
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		assert.throws(
			() => taskStart(f.root, task, { allowUnready: false, noStack: true }),
			/docs\/tooling is a folder; use docs\/tooling\//,
		);
		assert.equal(f.git("branch", "--list", "task/*"), "");
		f.cfg.maintenanceTasks[task.id].owningPaths = ["docs"];
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		assert.throws(
			() => taskStart(f.root, task, { allowUnready: false, noStack: true }),
			/docs is a folder; use docs\//,
		);
		assert.equal(f.git("branch", "--list", "task/*"), "");
		for (const path of ["docs/tooling/", "AGENTS.md"]) {
			f.cfg.maintenanceTasks[task.id].owningPaths = [path];
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
			f.commit();
			assert.equal(taskStart(f.root, task, { allowUnready: false, noStack: true }), 0);
			assert.equal(f.git("branch", "--list", "--format=%(refname:short)", "task/*"), "task/ops-1");
		}
	} finally {
		f.close();
	}
});

test("BUG-c048ea5-pr-class: body checks select Wiki and prototype formats from PR metadata and keep ordinary work strict", () => {
	const f = mergeFixture();
	try {
		const footer = "\n\nEVF-Author: openai\n\n🤖 Generated with [Codex](https://openai.com/codex/)";
		const bodies = {
			wiki:
				"## Scope and sources\nA16 article; publisher sources checked on 2026-10-18.\n\n## Verification\nLint and desktop/mobile renders passed at abc123; screenshots linked in the task.\n\n## Review and approval\nIndependent Opus review pending. Sebastian approval pending." +
				footer,
			prototype:
				"## Summary\nFB-1 proposes a shorter meeting flow.\n\n## Preview and limitations\nLocal preview at abc123 exercises the concept with synthetic data; persistence is incomplete.\n\n## Review and approval\nSebastian product review and approval pending." +
				footer,
		};
		const cli = (...args: string[]) =>
			spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "pr", "body", ...args], {
				cwd: f.root,
				encoding: "utf8",
			});
		const wiki = { headRefName: "wiki/a16", labels: [], files: [{ path: "docs/reference/wiki/drafts/a16.json" }] };
		const prototype = {
			headRefName: "task/fb-1",
			labels: [{ name: "prototype" }],
			files: [{ path: "apps/web/prototype.tsx" }],
		};
		for (const [kind, metadata] of [
			["wiki", wiki],
			["prototype", prototype],
		] as const) {
			const state = f.getState();
			state.pr = { ...metadata, body: bodies[kind] };
			f.setState(state);
			const checked = cli("77");
			assert.equal(checked.status, 0, checked.stderr);
			assert.match(checked.stdout, new RegExp(`PASSED ${kind} PR body standard for openai`));
			const file = join(f.root, "fake-bin/body.md");
			writeFileSync(file, bodies[kind]);
			const local = cli("--body-file", file, "--class", kind);
			assert.equal(local.status, 0, local.stderr);
			assert.match(local.stdout, new RegExp(`PASSED ${kind} PR body standard for openai`));
			assert.equal(cli("--body-file", file).status, 1, "local files default to the ordinary template");
			for (const missing of ["## Review and approval", "EVF-Author: openai"]) {
				state.pr.body = bodies[kind].replace(missing, "Removed");
				f.setState(state);
				assert.equal(cli("77").status, 1, `${kind} must require ${missing}`);
			}
		}
		for (const metadata of [
			{ ...wiki, files: [{ path: "tools/evf/ship.ts" }] },
			{ ...wiki, files: [] },
			{ ...prototype, headRefName: "task/ops-1" },
			{ ...prototype, labels: [] },
			{ headRefName: "task/ops-1", labels: [], files: [] },
		]) {
			const state = f.getState();
			state.pr = { ...metadata, body: bodies.prototype };
			f.setState(state);
			assert.equal(cli("77").status, 1, "unrelated PRs cannot use a lighter format");
		}
		const state = f.getState();
		state.pr = { headRefName: "task/ops-1", labels: [], files: [], body: validPrBody() };
		f.setState(state);
		const ordinary = cli("77");
		assert.equal(ordinary.status, 0, ordinary.stderr);
		assert.match(ordinary.stdout, /PASSED ordinary PR body standard for openai/);
		const file = join(f.root, "fake-bin/body.md");
		writeFileSync(file, validPrBody());
		assert.match(cli("--body-file", file, "--class", "unknown").stderr, /class must be ordinary, wiki or prototype/);
		assert.match(cli("77", "--class", "prototype").stderr, /only for local body files/);
		f.authorize("WP-034");
		f.commit();
		f.git("push", "-q", "origin", "main");
		feedbackTriage(f.root, 1, { cls: "feature-small", reason: "scoped prototype", wp: "WP-034" });
		const task = parseTask("FB-1");
		f.task(task.slug);
		verify(f.root, task, "author", "full");
		writeFileSync(file, bodies.prototype + "\n");
		const provider = f.getState();
		provider.pr = { number: 77, state: "CLOSED" };
		provider.calls = [];
		f.setState(provider);
		assert.equal(prOpen(f.root, task, file), 0);
		const created = f.getState().calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
		assert.equal(created.body, bodies.prototype + "\n");
		assert.deepEqual(created.args.slice(-3), ["--draft", "--label", "prototype"]);
		assert.throws(() => ship(f.root, task), /is a prototype/);
	} finally {
		f.close();
	}
});

test("BUG-fb0159d-wiki-images: real pr-images output keeps a Wiki body valid on first upload and replacement", async () => {
	const f = fixture(),
		oldGlobal = process.env.GIT_CONFIG_GLOBAL;
	try {
		const gist = f.bare(join(f.root, "fake-bin/screenshots.git"));
		const config = join(f.root, "fake-bin/gist.gitconfig");
		writeFileSync(config, `[url "file://${gist}"]\n\tinsteadOf = https://gist.github.com/a1b2c3.git\n`);
		process.env.GIT_CONFIG_GLOBAL = config;
		const body =
			readFileSync(join(f.root, "tools/evf/templates/wiki-pr.md"), "utf8")
				.replace(/<!--[^]*?-->/g, (comment) => (/^<!-- \/?wiki-screenshots -->$/.test(comment) ? comment : ""))
				.replace(/^## .+$/gm, (heading) => heading + "\nVerified fixture article evidence.")
				.replace("EVF-Author: <family>", "EVF-Author: openai") +
			"\n🤖 Generated with [Codex](https://openai.com/codex/)";
		const state = f.getState();
		state.pr = { body };
		f.setState(state);
		for (const name of ["article.png", "article-mobile.png"]) {
			const png = join(f.root, "fake-bin", name);
			writeFileSync(
				png,
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
					"base64",
				),
			);
			await prImages(77, [png], true, f.root);
			const published = f.getState().pr.body;
			assert.equal(checkPrBody(f.root, published, "wiki").authorFamily, "openai");
			const image = `![${name.replace(/\.png$/, "")}](https://gist.githubusercontent.com/fixture-owner/a1b2c3/raw/${name})`;
			assert.ok(published.indexOf(image) > published.indexOf("## Verification"));
			assert.ok(published.indexOf(image) < published.indexOf("## Review and approval"));
			assert.equal(
				execFileSync("git", ["--git-dir", gist, "ls-tree", "--name-only", "HEAD"], { encoding: "utf8" }).trim(),
				name,
			);
		}
		assert.equal(f.getState().calls.filter((c) => c.args[0] === "gist" && c.args[1] === "create").length, 1);
	} finally {
		if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = oldGlobal;
		f.close();
	}
});

test("INV-phase7-ship: CI, independent exact-head approval and approved code quality are required", () => {
	const f = mergeFixture();
	try {
		const valid = f.getState();
		const scenarios = [
			{
				name: "red CI",
				edit: (s) => {
					s.requiredChecks[0].bucket = "fail";
					s.requiredChecks[0].state = "FAILURE";
					s.checksError = 1;
				},
				reason: /CI must be green/,
			},
			{
				name: "missing CI",
				edit: (s) => {
					s.requiredChecks = [];
				},
				reason: /CI is missing/,
			},
			{
				name: "pending CI",
				edit: (s) => {
					s.requiredChecks[0].bucket = "pending";
				},
				reason: /CI must be green/,
			},
			{
				name: "same-family approval",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "openai", verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /different model family/,
			},
			{
				name: "older-head approval",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: "a".repeat(40), verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /approval for the exact PR head/,
			},
			{
				name: "rejected approval",
				edit: (s) => {
					s.comments["77"].push({
						body: `EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "anthropic", verdict: "changes_requested", quality: approvedQuality, experience: approvedExperience })}`,
					});
				},
				reason: /approval for the exact PR head/,
			},
			...[
				{ name: "missing quality", quality: undefined, reason: /Missing verifier approval for the exact PR head/ },
				{
					name: "rejected quality",
					quality: { ...approvedQuality, verdict: "changes_requested" },
					reason: /Code quality must be approved before shipping/,
				},
				{
					name: "empty principles",
					quality: { ...approvedQuality, principles: [] },
					reason: /Missing verifier approval for the exact PR head/,
				},
				{
					name: "missing required principle",
					quality: { ...approvedQuality, principles: ["laziness-protocol"] },
					reason: /Missing verifier approval for the exact PR head/,
				},
			].map(({ name, quality, reason }) => ({
				name,
				reason,
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "anthropic", verdict: "approved", quality, experience: approvedExperience })}`;
				},
			})),
			...[
				{
					name: "missing experience",
					experience: undefined,
					reason: /Missing verifier approval for the exact PR head/,
				},
				{
					name: "failed budget",
					experience: { ...approvedExperience, budget: "exceeded" },
					reason: /Experience budget exceeded/,
				},
				{
					name: "failed smoothness",
					experience: { ...approvedExperience, verdict: "changes_requested" },
					reason: /Experience must be approved/,
				},
				{
					name: "unlisted exception",
					experience: { ...approvedExperience, budget: "exceeded", exception: "reports" },
					reason: /Experience budget exceeded/,
				},
			].map(({ name, experience, reason }) => ({
				name,
				reason,
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience })}`;
				},
			})),
			{
				name: "PR head differs",
				edit: (s) => {
					s.pr.headRefOid = "b".repeat(40);
				},
				reason: /PR head changed/,
			},
		];
		for (const scenario of scenarios) {
			const state = structuredClone(valid);
			scenario.edit(state);
			state.calls = [];
			f.setState(state);
			assert.throws(() => ship(f.root, f.taskRef), scenario.reason, scenario.name);
			assert.deepEqual(
				f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge"),
				[],
				scenario.name,
			);
		}
		for (const category of ["reports", "analytics"]) {
			const state = structuredClone(valid);
			state.pr.body = state.pr.body.replace("EVF-Author:", `EVF-Experience-Exception: ${category}\n\nEVF-Author:`);
			const experience = { ...approvedExperience, budget: "exceeded", exception: category };
			state.comments["77"][0].body =
				`EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience })}`;
			f.setState(state);
			assert.throws(() => ship(f.root, f.taskRef), /fixture merge barrier/);
			assert.deepEqual(f.getState().calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge").args, [
				"pr",
				"merge",
				"77",
				"--squash",
				"--match-head-commit",
				f.sha,
			]);
			state.calls = [];
			state.comments["77"][0].body =
				`EVF-Review: ${JSON.stringify({ head: f.sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience: { ...experience, verdict: "changes_requested" } })}`;
			f.setState(state);
			assert.throws(() => ship(f.root, f.taskRef), /Experience must be approved/);
			assert.deepEqual(
				f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge"),
				[],
			);
		}
		// Round-trip the actual review poster through the ship parser.
		const report = join(f.root, "fake-bin/review.md");
		writeFileSync(
			report,
			"## Code quality\nApproved. The parser checks external review data once; no extra layers to remove.\n\n## Experience\nChanged reads and writes finish under one second; optimistic UI and request counts pass.\n",
		);
		valid.calls = [];
		f.setState(valid);
		valid.comments["77"][0].body = execFileSync(
			process.execPath,
			[
				join(source, ".agents/skills/verify-preview/scripts/post-review.mjs"),
				"--pr",
				"77",
				"--report",
				report,
				"--family",
				"anthropic",
				"--verdict",
				"approved",
				"--head",
				f.sha,
				"--experience-verdict",
				"approved",
				"--budget",
				"met",
				"--quality-verdict",
				"approved",
				"--principles",
				approvedQuality.principles.join(","),
				"--dry-run",
			],
			{ cwd: f.root, encoding: "utf8" },
		);
		const posted = JSON.parse(valid.comments["77"][0].body.split("EVF-Review: ")[1]);
		assert.deepEqual(posted.quality, approvedQuality);
		assert.deepEqual(posted.experience, approvedExperience);
		f.setState(valid);
		assert.throws(() => ship(f.root, f.taskRef), /fixture merge barrier/);
		const merge = f.getState().calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge");
		assert.deepEqual(merge.args, ["pr", "merge", "77", "--squash", "--match-head-commit", f.sha]);
		assert.deepEqual(
			f.getState().calls.filter((c) => c.args[0] === "api" && c.args.includes("POST")),
			[],
		);
	} finally {
		f.close();
	}
});

test("INV-phase7-readiness: doctor reports workflow and preview setup without obsolete trust requirements", () => {
	const f = fixture();
	try {
		// Set the gate and stack states here; the live release-gates.json and evf.config.json change as the project moves on.
		f.cfg.stack = null;
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		const path = join(f.root, "docs/plan/release-gates.json"),
			gates = JSON.parse(readFileSync(path, "utf8"));
		const missing = (workflow: string) => {
			for (const g of gates.gates)
				g.status = g.id === "G-AUTH" ? "not-authorized" : g.id === "G-WORKFLOW" ? workflow : g.status;
			writeFileSync(path, JSON.stringify(gates));
			return bootstrapReadiness(f.root)
				.filter(([ready]) => !ready)
				.map(([, item]) => item);
		};
		assert.deepEqual(missing("received-reconciliation-required"), [
			"owner kickoff approval in G-AUTH",
			"W0 to W5 merged and one task completed through the Phase 7 flow",
			"repository remote origin",
			"owner-approved WP-097 fast-track completion on main",
			"local preview up/status commands",
		]);
		assert.deepEqual(missing("reconciled-independent-review"), [
			"owner kickoff approval in G-AUTH",
			"repository remote origin",
			"owner-approved WP-097 fast-track completion on main",
			"local preview up/status commands",
		]);
		f.cfg.stack = { usesPaidProviders: false, up: ["node", "stack", "up"], status: ["node", "stack", "status"] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		assert.deepEqual(missing("reconciled-independent-review"), [
			"owner kickoff approval in G-AUTH",
			"repository remote origin",
			"owner-approved WP-097 fast-track completion on main",
		]);
	} finally {
		f.close();
	}
});

test("INV-phase7-feedback: P2 waits for owner after the same checks, while P1 reaches exact-head merge", () => {
	const f = mergeFixture();
	try {
		f.authorize("WP-034");
		f.commit();
		f.git("push", "-q", "origin", "main");
		feedbackTriage(f.root, 1, { cls: "p2", reason: "scoped feedback", wp: "WP-034" });
		const task = parseTask("FB-1");
		f.task(task.slug);
		const state = f.getState(),
			sha = f.git("rev-parse", task.branch);
		state.pr.headRefOid = sha;
		state.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		state.calls = [];
		f.setState(state);
		assert.equal(ship(f.root, task), 0);
		assert.deepEqual(
			f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge"),
			[],
		);
		assert.ok(
			f.getState().calls.some((c) => c.args.includes("state=success") && c.args.includes("context=evf/verify")),
		);
		const cache = join(evfDataDir(f.root), "feedback", "issue-1.json"),
			record = JSON.parse(readFileSync(cache, "utf8"));
		record.class = "p1";
		writeFileSync(cache, JSON.stringify(record));
		assert.throws(() => ship(f.root, task), /fixture merge barrier/);
		assert.deepEqual(f.getState().calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge").args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			sha,
		]);
	} finally {
		f.close();
	}
});

test("INV-phase7-progress: ship and acknowledgement preserve reviewed milestones and unlock dependents idempotently", () => {
	const f = mergeFixture(),
		log = console.log;
	try {
		f.authorize("WP-032");
		const progressPath = join(f.root, "docs/build-progress.json"),
			initial = JSON.parse(readFileSync(progressPath, "utf8"));
		initial.packages["WP-001"].status = "not_started";
		writeFileSync(progressPath, JSON.stringify(initial));
		reconcileProgress(f.root);
		f.commit();
		f.git("push", "-q", "origin", "main");
		const task = parseTask("WP-001"),
			wt = f.task(task.slug);
		mkdirSync(join(wt, "packages/reference"), { recursive: true });
		writeFileSync(join(wt, "packages/reference/fixture.txt"), "Reviewed reference bundle");
		const candidateGit = (...args) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
		candidateGit("add", "packages/reference/fixture.txt");
		candidateGit("commit", "-qm", "Reviewed fixture output");
		const sha = candidateGit("rev-parse", "HEAD"),
			state = f.getState();
		state.allowMerge = true;
		state.mergeBranch = task.branch;
		state.pr.headRefOid = sha;
		state.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: sha, verifierFamily: "anthropic", verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(state);
		console.log = () => {};
		assert.equal(ship(f.root, task), 0);
		const path = join(evfDataDir(f.root), "shipped", `${task.slug}.json`),
			record = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(record.verified_head, sha);
		assert.equal(record.verification.approval.verifierFamily, "anthropic");
		assert.deepEqual(record.verification.approval.quality, approvedQuality);
		assert.equal(loadProgress(f.root)["WP-001"].status, "in_progress");
		assert.equal(producerReady(f.root, "WP-001"), false);
		listShipped(f.root, [task.id]);
		assert.equal(producerReady(f.root, "WP-001"), true);
		requireImplementation(f.root, "WP-032");
		const progress = readFileSync(join(f.root, "docs/build-progress.json"), "utf8");
		listShipped(f.root, [task.id]);
		assert.equal(readFileSync(join(f.root, "docs/build-progress.json"), "utf8"), progress);
		assert.throws(
			() =>
				recordProgress(
					f.root,
					{
						...record,
						verification: {
							...record.verification,
							approval: { ...record.verification.approval, head: "a".repeat(40) },
						},
					},
					true,
				),
			/independently reviewed/,
		);
		assert.equal(readFileSync(join(f.root, "docs/build-progress.json"), "utf8"), progress);
		// BUG-ops7-progress-shape (D20): the build explorer renders evf-written milestones, and reconcile upgrades older ones.
		const explorer = () =>
			spawnSync("python3", [join(f.root, "docs/render-build-explorer.py"), "--check", "--root", f.root], {
				encoding: "utf8",
			});
		assert.equal(explorer().status, 0, explorer().stderr);
		const old = JSON.parse(progress),
			milestone = old.packages["WP-001"].milestones["WP-001"];
		for (const field of [
			"passed_case_portions",
			"passed_gate_portions",
			"deferred_case_portions",
			"deferred_gate_portions",
		])
			delete milestone[field];
		writeFileSync(progressPath, JSON.stringify(old));
		assert.match(explorer().stderr, /Missing milestone field/);
		reconcileProgress(f.root);
		assert.equal(explorer().status, 0, explorer().stderr);
		assert.deepEqual(
			JSON.parse(readFileSync(progressPath, "utf8")).packages["WP-001"].milestones["WP-001"].passed_case_portions,
			[],
		);
	} finally {
		console.log = log;
		f.close();
	}
});

test("INV-phase7-pr-body: missing, empty and reordered required sections refuse shipping using the merged template", () => {
	const f = mergeFixture();
	try {
		const valid = f.getState(),
			template = join(f.root, ".agents/skills/everyfield-pr/template.md");
		const first = "## Summary",
			last = "## Follow-ups";
		for (const [body, reason] of [
			[valid.pr.body.replace(first, "## Unlisted"), /missing required sections: ## Summary/],
			[
				valid.pr.body.replace(`${first}\nConcrete task evidence.`, `${first}\n<!-- Only a comment -->`),
				/section has no content: ## Summary/,
			],
			[valid.pr.body.replace(first, "TEMP").replace(last, first).replace("TEMP", last), /template order/],
			[
				valid.pr.body.replace(`${last}\nConcrete task evidence.`, `${last}\n<!-- Only a comment -->`),
				/section has no content: ## Follow-ups/,
			],
			[valid.pr.body.replace(first, `\`\`\`md\n${first}\n\`\`\``), /missing required sections: ## Summary/],
		]) {
			const state = structuredClone(valid);
			state.pr.body = body;
			state.calls = [];
			f.setState(state);
			assert.throws(() => ship(f.root, f.taskRef), reason);
			assert.deepEqual(
				f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge"),
				[],
			);
		}
		assert.equal(checkPrBody(f.root, valid.pr.body).authorFamily, "openai");
		// A template change takes effect without copying its headings into the checker.
		writeFileSync(template, readFileSync(template, "utf8") + "\n## New obligation\n");
		assert.throws(() => checkPrBody(f.root, valid.pr.body), /missing required sections: ## New obligation/);
		const expanded = valid.pr.body.replace("EVF-Author:", "## New obligation\nSpecific evidence.\n\nEVF-Author:");
		assert.equal(checkPrBody(f.root, expanded).sections.at(-1), "## New obligation");
		writeFileSync(template, "<!-- ## Comment only -->");
		assert.throws(() => checkPrBody(f.root, expanded), /template must define distinct required sections/);
	} finally {
		f.close();
	}
});

import { principles } from "../principles.ts";
const quiet = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("INV-wp-scope: verify accepts only the task's own new-package lock importer, scaffold, at-start cases and generated projections", () => {
	const f = fixture();
	try {
		f.authorize("WP-002");
		const lock =
			"lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/db:\n    dependencies:\n      pg:\n        specifier: 8.0.0\n        version: 8.0.0\n\npackages:\n\n  pg@8.0.0:\n    resolution: {integrity: sha512-fixture}\n";
		const generateIn = (root: string) => {
			for (const flag of ["--refresh-manifest", "--refresh-plan"])
				execFileSync("python3", ["docs/package-context.py", flag, "--root", root], { cwd: root, stdio: "ignore" });
		};
		// The fixture owns its base: projections start equal to the generators' output, whatever the live docs hold.
		generateIn(f.root);
		writeFileSync(join(f.root, "pnpm-lock.yaml"), lock);
		f.git("add", "pnpm-lock.yaml");
		f.commit();
		const wt = f.task("wp-002"),
			git = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
		const index = JSON.parse(readFileSync(join(wt, "docs/catalog/index.json"), "utf8"));
		const atStart: string[] = loadDag(wt).packages.find((p) => p.id === "WP-002")!.context_scope
			.case_requirements_at_start;
		const file = index.case_files.find((path: string) =>
			JSON.parse(readFileSync(join(wt, path), "utf8")).cases.some(
				(c: { work_packages: string[]; requirement: string }) =>
					c.work_packages.join() === "WP-002" && atStart.includes(c.requirement),
			),
		);
		const addCase = (id: string, requirement?: string) => {
			const payload = JSON.parse(readFileSync(join(wt, file), "utf8"));
			const own = structuredClone(
				payload.cases.find(
					(c: { work_packages: string[]; requirement: string }) =>
						c.work_packages.join() === "WP-002" && atStart.includes(c.requirement),
				),
			);
			own.id = id;
			if (requirement) {
				own.requirement = requirement;
				own.requirement_ids = [requirement];
			}
			payload.cases.push(own);
			writeFileSync(join(wt, file), JSON.stringify(payload, null, 2) + "\n");
		};
		const generate = () => generateIn(wt);
		// Which projections a new case changes depends on the catalog; derive them from the generators' actual output.
		const projections = () =>
			git(
				"diff",
				"--name-only",
				"main",
				"--",
				"docs/plan/context-manifest.json",
				"docs/plan/dag.json",
				"docs/plan/build-plan.md",
			)
				.split("\n")
				.filter(Boolean);
		const write = (path: string, text: string) => {
			mkdirSync(join(wt, path, ".."), { recursive: true });
			writeFileSync(join(wt, path), text);
		};
		let printed: string[] = [];
		const scopeOf = () => {
			git("add", "-A");
			git("commit", "-qm", "Candidate");
			const log = console.log;
			printed = [];
			console.log = (...m) => {
				printed.push(...m.join(" ").split("\n"));
			};
			let s;
			try {
				s = verify(f.root, parseTask("WP-002"), "author", "full").scope!;
			} finally {
				console.log = log;
			}
			return {
				owned: s.owned,
				accepted: Object.fromEntries(s.accepted.map((a) => [a.path, a.rule])),
				outside: [...s.outside].sort(),
			};
		};
		for (const name of ["package.json", "tsconfig.json", "eslint.config.mjs"])
			write(`packages/contracts/${name}`, "{}\n");
		write("packages/contracts/src/common/values.ts", "export {};\n");
		write("apps/web/package.json", "{}\n");
		writeFileSync(
			join(wt, "pnpm-lock.yaml"),
			lock.replace("\n  packages/db:", "\n  packages/contracts: {}\n\n  packages/db:"),
		);
		addCase("SCOPE-FIXTURE-001");
		generate();
		const generated = projections();
		assert.ok(generated.includes("docs/plan/context-manifest.json"));
		assert.deepEqual(scopeOf(), {
			owned: ["packages/contracts/src/common/values.ts"],
			accepted: {
				[file]: "own-at-start-cases",
				...Object.fromEntries(generated.map((p) => [p, "generated-projection"])),
				"packages/contracts/eslint.config.mjs": "own-package-scaffold",
				"packages/contracts/package.json": "own-package-scaffold",
				"packages/contracts/tsconfig.json": "own-package-scaffold",
				"pnpm-lock.yaml": "own-lock-importer",
			},
			outside: ["apps/web/package.json"],
		});
		assert.deepEqual(
			printed.filter((l) => l.startsWith("  outside: ")),
			["  outside: apps/web/package.json (verifier: confirm a recorded ruling)"],
		);
		// Each widening stays outside: a lock entry beyond the importer, another package's case and a hand-edited projection.
		writeFileSync(
			join(wt, "pnpm-lock.yaml"),
			readFileSync(join(wt, "pnpm-lock.yaml"), "utf8") + "\n  zod@4.0.0:\n    resolution: {integrity: sha512-extra}\n",
		);
		addCase("SCOPE-FIXTURE-002", "REQ-KNOW-078");
		generate();
		writeFileSync(
			join(wt, "docs/plan/build-plan.md"),
			readFileSync(join(wt, "docs/plan/build-plan.md"), "utf8") + "\nHand-written line.\n",
		);
		assert.deepEqual(scopeOf(), {
			owned: ["packages/contracts/src/common/values.ts"],
			accepted: {
				"packages/contracts/eslint.config.mjs": "own-package-scaffold",
				"packages/contracts/package.json": "own-package-scaffold",
				"packages/contracts/tsconfig.json": "own-package-scaffold",
			},
			outside: [
				...new Set(["apps/web/package.json", "docs/plan/build-plan.md", ...projections(), file, "pnpm-lock.yaml"]),
			].sort(),
		});
	} finally {
		f.close();
	}
});

test("BUG-ops6-stack-start: task start fails when stack up fails", () => {
	const f = fixture();
	try {
		f.cfg.stack = { usesPaidProviders: false, up: [process.execPath, "-e", "process.exit(3)"] };
		f.authorize("WP-001");
		f.commit();
		assert.throws(
			() => quiet(() => taskStart(f.root, parseTask("WP-001"), { allowUnready: false, noStack: false })),
			/stack up failed with exit code 3/,
		);
	} finally {
		f.close();
	}
});

test("BUG-ops6-stack-node: stack commands named node run on evf's Node, not the first node on PATH", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, "fake-bin/node"), "#!/bin/sh\nexit 9\n");
		execFileSync("chmod", ["+x", join(f.root, "fake-bin/node")]);
		f.cfg.stack = {
			usesPaidProviders: false,
			up: [
				"node",
				"-e",
				'require("node:fs").writeFileSync(process.env.EVF_RUNTIME_DIR+"/stack.json",JSON.stringify({node:process.execPath}))',
			],
		};
		f.authorize("WP-001");
		f.commit();
		const task = parseTask("WP-001");
		quiet(() => taskStart(f.root, task, { allowUnready: false, noStack: true }));
		assert.equal(
			quiet(() => stack(f.root, task, "up")),
			0,
		);
		assert.equal(
			JSON.parse(readFileSync(join(evfDataDir(f.root), "runtime", task.slug, "stack.json"), "utf8")).node,
			process.execPath,
		);
	} finally {
		f.close();
	}
});

test("BUG-ops6-principles-target: principles --apply writes the task worktree and leaves the home checkout unchanged", () => {
	const f = fixture();
	try {
		const skill = Buffer.from("---\nname: principle-fixture\n---\n\n# Fixture principle\n"),
			blob = createHash("sha1").update(`blob ${skill.length}\0`).update(skill).digest("hex"),
			commit = "c".repeat(40);
		const repo = "up/plugins",
			state = f.getState();
		state.api = {
			[`repos/${repo}/commits/main`]: { sha: commit, commit: { committer: { date: "2026-10-18T00:00:00Z" } } },
			[`repos/${repo}/commits/${commit}`]: { sha: commit, commit: { committer: { date: "2026-10-18T00:00:00Z" } } },
			[`repos/${repo}/git/trees/${commit}?recursive=1`]: {
				truncated: false,
				tree: [{ path: "pstack/skills/principle-fixture/SKILL.md", type: "blob", sha: blob }],
			},
			[`repos/${repo}/git/blobs/${blob}`]: { content: skill.toString("base64"), encoding: "base64" },
		};
		f.setState(state);
		(f.cfg as Record<string, unknown>).principles = { repo, path: "pstack/skills", prefix: "principle-", ref: "main" };
		f.cfg.maintenanceTasks = {
			"OPS-1": {
				title: "Principle refresh",
				owningPaths: [".agents/skills/", "skills-lock.json"],
				checks: f.cfg.checks,
			},
		};
		writeFileSync(join(f.root, "skills-lock.json"), '{"version":1,"skills":{}}\n');
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.git("add", "skills-lock.json");
		f.commit();
		const wt = f.task("ops-1"),
			homeLock = readFileSync(join(f.root, "skills-lock.json"), "utf8");
		assert.equal(
			quiet(() => principles(f.root, { apply: true, task: parseTask("OPS-1") })),
			0,
		);
		assert.equal(existsSync(join(f.root, ".agents/skills/principle-fixture")), false);
		assert.equal(readFileSync(join(f.root, "skills-lock.json"), "utf8"), homeLock);
		assert.deepEqual(readFileSync(join(wt, ".agents/skills/principle-fixture/SKILL.md")), skill);
		assert.equal(
			JSON.parse(readFileSync(join(wt, "skills-lock.json"), "utf8")).skills["principle-fixture"].upstreamCommit,
			commit,
		);
		assert.throws(() => principles(f.root, { apply: true }), /Give the maintenance task/);
		assert.equal(existsSync(join(f.root, ".agents/skills/principle-fixture")), false);
	} finally {
		f.close();
	}
});

test("BUG-wp003-shared-report: each check keeps its own report and only AC: reports turn on case coverage", () => {
	const f = fixture();
	try {
		const ids = packageContext(f.root, "WP-002").case_ids,
			writer = (tests: unknown[]) => [
				process.execPath,
				"-e",
				`require("node:fs").writeFileSync(process.env.EVF_TEST_REPORT,${JSON.stringify(JSON.stringify({ tests }))})`,
			];
		const tooling = { name: "workflow", run: writer([{ name: "INV-workflow: stack isolation", status: "passed" }]) };
		const cases = {
			name: "package cases",
			run: writer([
				{
					name:
						ids
							.slice(0, -1)
							.map((id) => `AC:${id}`)
							.join(" ") + " package behavior",
					status: "passed",
				},
			]),
		};
		f.authorize("WP-002");
		f.commit();
		const wt = f.task("wp-002");
		const run = (checks: unknown[]) => {
			f.cfg.checks = checks as typeof f.cfg.checks;
			writeFileSync(join(wt, "evf.config.json"), JSON.stringify(f.cfg));
			importGit(wt, "add", "evf.config.json");
			importGit(wt, "commit", "-qm", "Commit check definitions");
			return quiet(() => verify(f.root, parseTask("WP-002"), "author", "full"));
		};
		const toolingOnly = run([tooling]);
		assert.deepEqual(
			toolingOnly.checks.map((c) => c.name),
			["workflow"],
		);
		assert.equal(toolingOnly.passed, true);
		const both = run([cases, tooling]);
		assert.deepEqual(
			both.checks.map((c) => [c.name, c.passed]),
			[
				["package cases", true],
				["workflow", true],
				["case-coverage", false],
			],
		);
		assert.deepEqual(JSON.parse(readFileSync(both.checks[2].log, "utf8")).missing, ids.slice(-1));
		// Check names that slug alike keep separate reports and logs.
		const alike = run([cases, { ...tooling, name: "package_cases" }]);
		assert.deepEqual(
			alike.checks.map((c) => [c.name, c.passed]),
			[
				["package cases", true],
				["package_cases", true],
				["case-coverage", false],
			],
		);
		assert.equal(new Set(alike.checks.map((c) => c.log)).size, 3);
		for (const c of alike.checks.slice(0, 2)) assert.equal(existsSync(c.log.replace(/\.log$/, ".tests.json")), true);
		assert.deepEqual(JSON.parse(readFileSync(alike.checks[2].log, "utf8")).missing, ids.slice(-1));
	} finally {
		f.close();
	}
});

test("BUG-ops6-fixture-cleanup: fixture commits and bare pushes start no background maintenance, so close removes the whole fixture", () => {
	// Git's detached auto-maintenance kept writing into a fixture's .git while close() removed it (ENOTEMPTY on CI).
	const f = fixture(),
		traces = mkdtempSync(join(tmpdir(), "evf-trace-")),
		trace = join(traces, "git.json");
	try {
		f.git("config", "gc.auto", "1");
		for (let i = 0; i < 50; i++) writeFileSync(join(f.root, `loose-${i}.txt`), `loose object ${i}`);
		f.git("add", ".");
		const traced = (...args: string[]) =>
			execFileSync("git", ["-C", f.root, ...args], { env: { ...process.env, GIT_TRACE2_EVENT: trace }, stdio: "pipe" });
		traced("commit", "-qm", "Many loose objects");
		// The receiving side of a local push does not inherit the test's git environment.
		traced("push", "-q", f.bare(join(f.root, "fake-bin/receiver.git")), "main");
		const events = readFileSync(trace, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const command of ["commit", "push"])
			assert.equal(
				events.some((e) => e.event === "start" && e.argv.includes(command)),
				true,
				`${command} actually ran`,
			);
		const children = events.filter((e) => e.event === "child_start").map((e) => e.argv.join(" "));
		assert.deepEqual(
			children.filter((argv) => /\b(maintenance|gc)\b/.test(argv)),
			[],
		);
	} finally {
		f.close();
		rmSync(traces, { recursive: true, force: true });
	}
	assert.equal(existsSync(f.root), false);
});
