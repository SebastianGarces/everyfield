import { checkPrBody } from "../pr-body.ts";
import { prImages } from "../../wiki/pr-images.ts";
import { createHash } from "node:crypto";
import { packageContext, loadProgress, partsOf } from "../lib.ts";
import { feedbackPromote, feedbackIdeas } from "../feedback.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlocks, renderBlocks } from "../plan.ts";
import { loadDag, loadRegistry } from "../lib.ts";
import { fixture } from "./fixtures.ts";
import { nextStage } from "../drive.ts";
import { parseTask, evfDataDir, evidenceDir, loadConfig, independentReview } from "../lib.ts";
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
import { readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { ship, listShipped, prOpen } from "../ship.ts";
import { ensureTask, findTask, openWorkDb } from "../db.ts";
import { withShipQueue } from "../ship-queue.ts";
import { awaitLoad, loadLimit } from "../load.ts";
import { availableParallelism } from "node:os";
import { spawn } from "node:child_process";
import { renumberMigrations } from "../migrations.ts";
import { approve } from "../approve.ts";
import { requireImplementation, requireSpend, requireTaskScope } from "../policy.ts";
import { existsSync } from "node:fs";
import { stack } from "../task.ts";
import { caseCoverage, caseGrep } from "../coverage.ts";
import {
	LEGACY_FAMILY_WAIVER_END,
	producerReady,
	recordProgress,
	recordFastTrack,
	reconcileProgress,
	reviewedMilestone,
} from "../progress.ts";
import { renderAc, renderBrief } from "../brief.ts";
import { bootstrapReadiness } from "../doctor.ts";
import { principles } from "../principles.ts";
import {
	AUTHOR,
	VERIFIER,
	approvePr,
	approveWrites,
	approvedExperience,
	approvedQuality,
	at,
	authorLine,
	mergeFixture,
	source,
	validPrBody,
} from "./reconciliation-helpers.ts";

test("BUG-workflow: preserve selected producer dependencies across forward references", () => {
	const f = fixture();
	try {
		const dag = loadDag(f.root);
		const { blocks } = buildBlocks(f.root, dag.packages);
		const by = new Map(blocks.map((b) => [b.wp, blocks.filter((x) => x.wp === b.wp)]));
		for (const p of dag.packages)
			for (const d of p.depends_on) {
				const producer = by.get(d)!;
				const finals = [producer.find((b) => b.part === "api") ?? producer[0]].map((b) => b.key);
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

test("INV-human-approve-scope: ordinary build and OPS PRs refuse evf approve before any write", () => {
	const f = fixture();
	try {
		// An OPS branch's route comes from the registration committed at its PR head, so the head is fetched.
		f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
		f.git("push", "-q", "origin", "main", "main:refs/heads/task/ops-1");
		for (const branch of ["task/wp-001", "task/ops-1", "ops/some-tooling"]) {
			const s = f.getState();
			s.pr = approvePr(branch, { files: [{ path: "tools/evf/ship.ts" }], headRefOid: f.git("rev-parse", "main") });
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
		assert.equal(
			brief.split("\n").find((line) => line.startsWith("Goal: ")),
			`Goal: ${loadDag(f.root).packages.find((p) => p.id === "WP-002")!.goal}`,
		);
		const plan = loadDag(f.root).packages.find((p) => p.id === "WP-002")!;
		assert.ok(brief.includes(`Features: ${plan.outputs.join("\n")}`));
		assert.ok(brief.includes(`Acceptance cases:\n${plan.acceptance_gates.map((c, i) => `${i + 1}. ${c}`).join("\n")}`));
		assert.doesNotMatch(brief, /Outputs:|Acceptance gates:/);
		const acceptance = JSON.parse(
			execFileSync("python3", [join(f.root, "docs/package-context.py"), "--acceptance", "--root", f.root], {
				encoding: "utf8",
			}),
		);
		assert.ok(acceptance.every((bundle) => !("test_protocol" in bundle)));

		assert.match(brief, /Owned requirements: REQ-IDN-029, REQ-OPS-004, REQ-PI-037, REQ-PPL-024, REQ-TSK-018/);
		assert.match(brief, /Write owned cases at package start for: REQ-IDN-029, REQ-OPS-004, REQ-PI-037, REQ-PPL-024/);
		assert.match(brief, /Owned cases: AUDIT-001, AUDIT-002, AUDIT-003/);
		const selected = loadDag(f.root).packages.filter((p) => ["WP-005", "WP-088", "WP-089", "WP-090"].includes(p.id));
		const parts = buildBlocks(f.root, selected).blocks;
		assert.deepEqual(
			parts.filter((b) => b.wp === "WP-005").map((b) => [b.part, b.dependsOn]),
			[
				["api", []],
				["ui", ["wp-088", "wp-089", "wp-090", "wp-005-api"]],
			],
		);
		const api = parts.find((b) => b.taskId === "WP-005/api")!;
		assert.ok(api.paths.includes("packages/contracts/src/identity/"), "the api part owns the contract paths");
		assert.match(
			renderBrief(f.root, parseTask("WP-005/api"), {}),
			/Contract first: build packages\/contracts\/[^\n]* before the server work that uses it\./,
		);
		assert.throws(
			() => renderBrief(f.root, parseTask("WP-005/contract"), {}),
			/WP-005\/contract is retired\. The contract work is the first step of WP-005\/api\./,
		);
		// BUG-178: the api author sees the recorded budget before the PR opens, not from the verifier after.
		const apiBrief = renderBrief(f.root, parseTask("WP-005/api"), {});
		assert.match(
			apiBrief,
			/Performance budget \(docs\/architecture\/patterns\.md, D69, D70\):\nEvery simple read or write finishes in under one second end to end on a production build\.[^\n]* A simple write request sends at most six statements, independent of data size: the session lookup, then the write\./,
		);
		assert.match(apiBrief, /its measured budget in tests\/integration\/writes\/limits\.json/);
		const ui = renderBrief(f.root, parseTask("WP-005/ui"), {});
		assert.doesNotMatch(ui, /Performance budget/);
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
		const dagPath = join(f.root, "docs/plan/dag.json");
		const dag = JSON.parse(readFileSync(dagPath, "utf8"));
		const identity = dag.packages.find((p) => p.id === "WP-005");
		identity.outputs = [];
		identity.acceptance_gates = [];
		writeFileSync(dagPath, JSON.stringify(dag));
		const planCheck = spawnSync("python3", ["docs/package-context.py", "--check-plan"], {
			cwd: f.root,
			encoding: "utf8",
		});
		assert.equal(planCheck.status, 0, planCheck.stderr);
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

test("BUG-pr165-ledger: only a transfer-only OPS task commits the progress ledger; reconcile refuses a task worktree", () => {
	const f = fixture(),
		task = parseTask("OPS-1");
	try {
		for (const owningPaths of [["docs/plan/", "docs/build-progress.json"], ["docs/"]]) {
			f.cfg.maintenanceTasks = { [task.id]: { title: "Plan review", owningPaths, checks: f.cfg.checks } };
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
			f.commit();
			assert.throws(
				() => taskStart(f.root, task, { allowUnready: false, noStack: true }),
				/Only a transfer task that owns exactly docs\/build-progress.json may commit the progress ledger/,
			);
			assert.equal(f.git("branch", "--list", "task/*"), "");
		}
		f.cfg.maintenanceTasks![task.id].owningPaths = ["docs/build-progress.json"];
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		requireTaskScope(f.root, f.root, task);
		const wt = f.task(task.slug),
			ledger = readFileSync(join(wt, "docs/build-progress.json"), "utf8");
		assert.throws(() => reconcileProgress(wt), /Reconcile progress in the home checkout, not a task worktree/);
		assert.equal(readFileSync(join(wt, "docs/build-progress.json"), "utf8"), ledger);
		reconcileProgress(f.root);
	} finally {
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
		for (const path of [
			"other-review.html",
			"apps/web/src/app/page.tsx",
			"design/handoff/",
			"design/handoff/export.py",
			"apps/web/README.md",
			"packages/ui/src/index.ts",
			"scripts/seed.mjs",
			"scripts/",
			"tests/ui/",
		]) {
			f.cfg.maintenanceTasks[task.id].owningPaths = [path];
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
			f.commit();
			assert.throws(
				() => taskStart(f.root, task, { allowUnready: false, noStack: true }),
				/Maintenance owning paths must stay in documentation and workflow tooling/,
			);
		}
		for (const path of [
			"docs/tooling/",
			"tools/evf-tui/",
			"scripts/preview.json",
			"scripts/stack.mjs",
			"tests/workflow/",
			"tests/workflow/stack.test.mjs",
			"AGENTS.md",
			"everyfield-feature-review.html",
			"design/handoff/screens.md",
		]) {
			f.cfg.maintenanceTasks[task.id].owningPaths = [path];
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
			f.commit();
			assert.equal(taskStart(f.root, task, { allowUnready: false, noStack: true }), 0);
			assert.equal(f.git("branch", "--list", "--format=%(refname:short)", "task/*"), "task/ops-1");
			f.git("worktree", "remove", "--force", join(f.root, f.cfg.worktreeDir, task.slug));
			f.git("branch", "-D", task.branch);
		}
	} finally {
		f.close();
	}
});

test("BUG-c048ea5-pr-class: body checks select Wiki and prototype formats from PR metadata and keep ordinary work strict", () => {
	const f = mergeFixture();
	try {
		const footer = "\n\n" + authorLine + "\n\n🤖 Generated with [Codex](https://openai.com/codex/)";
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
			assert.match(
				checked.stdout,
				new RegExp(`PASSED ${kind} PR body standard for claude-sonnet-5-5 \\(implementer\\)`),
			);
			const file = join(f.root, "fake-bin/body.md");
			writeFileSync(file, bodies[kind]);
			const local = cli("--body-file", file, "--class", kind);
			assert.equal(local.status, 0, local.stderr);
			assert.match(local.stdout, new RegExp(`PASSED ${kind} PR body standard for claude-sonnet-5-5 \\(implementer\\)`));
			assert.equal(cli("--body-file", file).status, 1, "local files default to the ordinary template");
			for (const missing of ["## Review and approval", authorLine]) {
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
		assert.match(ordinary.stdout, /PASSED ordinary PR body standard for claude-sonnet-5-5 \(implementer\)/);
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
				.replace(/^EVF-Author: .*$/m, authorLine) + "\n🤖 Generated with [Codex](https://openai.com/codex/)";
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
			assert.deepEqual(checkPrBody(f.root, published, "wiki").author, AUTHOR);
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
				name: "required check not created yet",
				edit: (s) => {
					s.rules = [
						{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "pr-body" }] } },
					];
					s.requiredChecks = [{ ...s.requiredChecks[0], name: "pr-body" }];
				},
				reason: /Required GitHub CI is missing on the exact PR head: CI\./,
			},
			{
				name: "author session approval",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: { ...VERIFIER, session: AUTHOR.session }, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /independent session/,
			},
			{
				name: "non-Opus verifier",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: { ...VERIFIER, model: "claude-sonnet-5-5" }, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /Opus model/,
			},
			{
				name: "non-verifier seat",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: { ...VERIFIER, role: "implementer" }, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /verifier seat/,
			},
			{
				name: "older-head approval",
				edit: (s) => {
					s.comments["77"][0].body =
						`EVF-Review: ${JSON.stringify({ head: "a".repeat(40), verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
				},
				reason: /approval for the exact PR head/,
			},
			{
				name: "rejected approval",
				edit: (s) => {
					s.comments["77"].push({
						body: `EVF-Review: ${JSON.stringify({ head: f.sha, verifier: VERIFIER, verdict: "changes_requested", quality: approvedQuality, experience: approvedExperience })}`,
					});
				},
				reason: /approval for the exact PR head/,
			},
			...[
				{
					name: "missing quality",
					quality: undefined,
					reason: /Missing quality field in verifier review for the exact PR head/,
				},
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
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: VERIFIER, verdict: "approved", quality, experience: approvedExperience })}`;
				},
			})),
			...[
				{
					name: "missing experience",
					experience: undefined,
					reason: /Missing experience field in verifier review for the exact PR head/,
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
						`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience })}`;
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
				`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience })}`;
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
				`EVF-Review: ${JSON.stringify({ head: f.sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: { ...experience, verdict: "changes_requested" } })}`;
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
			"## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n| The parser | delivered |\n\n## Code quality\nApproved. The parser checks external review data once; no extra layers to remove.\n\n## Experience\nChanged reads and writes finish under one second; optimistic UI and request counts pass.\n",
		);
		valid.calls = [];
		f.setState(valid);
		const posterArgs = [
			join(source, ".agents/skills/verify-preview/scripts/post-review.mjs"),
			"--pr",
			"77",
			"--report",
			report,
			"--session",
			VERIFIER.session,
			"--model",
			VERIFIER.model,
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
		];
		for (const omitted of approvedQuality.principles) {
			const args = [...posterArgs];
			args[args.indexOf("--principles") + 1] = approvedQuality.principles.filter((name) => name !== omitted).join(",");
			const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8" });
			assert.equal(result.status, 1, `poster accepted missing ${omitted}`);
			assert.ok(result.stderr.includes(`--principles is missing required names: ${omitted}`), result.stderr);
		}
		valid.comments["77"][0].body = execFileSync(process.execPath, posterArgs, { cwd: f.root, encoding: "utf8" });
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

test("INV-phase7-ship: independent review is another session, the verifier seat and an Opus model (D82)", () => {
	assert.equal(independentReview(AUTHOR, VERIFIER), null);
	assert.equal(independentReview(AUTHOR, { ...VERIFIER, model: "claude-opus-6-0" }), null);
	assert.match(independentReview(AUTHOR, { ...VERIFIER, session: AUTHOR.session })!, /independent session/);
	assert.match(
		independentReview(AUTHOR, { ...VERIFIER, role: "implementer" })!,
		/verifier seat: the review role is implementer/,
	);
	assert.match(independentReview({ ...AUTHOR, role: "verifier" }, VERIFIER)!, /the author role is verifier/);
	assert.match(
		independentReview(AUTHOR, { ...VERIFIER, model: "claude-sonnet-5-5" })!,
		/Opus model: the review model is claude-sonnet-5-5/,
	);
});

test("INV-phase7-ship: ship and the review poster accept an independent Opus verifier and refuse the author's session, another seat or a non-Opus model", () => {
	const f = mergeFixture();
	try {
		const valid = f.getState();
		writeFileSync(
			join(f.root, "fake-bin/review.md"),
			"## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n| The parser | delivered |\n\n## Code quality\nApproved.\n\n## Experience\nNot applicable.\n",
		);
		const cases = [
			{ name: "independent Opus verifier", verifier: VERIFIER, ships: true, reason: /fixture merge barrier/ },
			{
				name: "later Opus version",
				verifier: { ...VERIFIER, model: "claude-opus-6-0" },
				ships: true,
				reason: /fixture merge barrier/,
			},
			{
				name: "author session",
				verifier: { ...VERIFIER, session: AUTHOR.session },
				ships: false,
				reason: /independent session/,
			},
			{
				name: "implementer seat",
				verifier: { ...VERIFIER, role: "implementer" },
				ships: false,
				reason: /verifier seat/,
			},
			{
				name: "Sonnet verifier",
				verifier: { ...VERIFIER, model: "claude-sonnet-5-5" },
				ships: false,
				reason: /Opus model/,
			},
		];
		for (const { name, verifier, ships, reason } of cases) {
			const state = structuredClone(valid);
			assert.deepEqual(checkPrBody(f.root, state.pr.body).author, AUTHOR);
			state.comments["77"][0].body =
				`EVF-Review: ${JSON.stringify({ head: f.sha, verifier, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
			state.calls = [];
			f.setState(state);
			assert.throws(() => ship(f.root, f.taskRef), reason, name);
			const poster = spawnSync(
				process.execPath,
				[
					join(source, ".agents/skills/verify-preview/scripts/post-review.mjs"),
					...["--pr", "77", "--report", join(f.root, "fake-bin/review.md")],
					...["--session", verifier.session, "--model", verifier.model, "--role", verifier.role],
					...["--verdict", "approved", "--head", f.sha, "--experience-verdict", "approved", "--budget", "met"],
					...["--quality-verdict", "approved", "--principles", approvedQuality.principles.join(","), "--dry-run"],
				],
				{ cwd: f.root, encoding: "utf8" },
			);
			assert.equal(poster.status, ships ? 0 : 1, `poster: ${name}: ${poster.stderr}`);
			// The poster refuses with the rule's own words, so it cannot drift from ship.
			if (!ships)
				assert.ok(poster.stderr.includes(independentReview(AUTHOR, verifier)!), `poster: ${name}: ${poster.stderr}`);
			if (ships)
				assert.ok(
					poster.stdout.includes(`"verifier":${JSON.stringify(verifier)}`),
					`poster records the verifier: ${poster.stdout}`,
				);
		}
		const state = structuredClone(valid);
		state.pr.body = valid.pr.body.replace(authorLine, "EVF-Author: anthropic");
		assert.throws(() => checkPrBody(f.root, state.pr.body), /EVF-Author must be \{"session"/);
		state.pr.body = valid.pr.body.replace(
			authorLine,
			`EVF-Author: ${JSON.stringify({ ...AUTHOR, session: "not-a-uuid" })}`,
		);
		assert.throws(() => checkPrBody(f.root, state.pr.body), /session must be the Claude Code session UUID/);

		// The poster reads the body with ship's parser, so HTML comments and fenced examples count for neither.
		const posted = (body: string) => {
			const s = structuredClone(valid);
			s.pr.body = body;
			f.setState(s);
			return spawnSync(
				process.execPath,
				[
					join(source, ".agents/skills/verify-preview/scripts/post-review.mjs"),
					...["--pr", "77", "--report", join(f.root, "fake-bin/review.md")],
					...["--session", VERIFIER.session, "--model", VERIFIER.model],
					...["--verdict", "approved", "--head", f.sha, "--experience-verdict", "approved", "--budget", "met"],
					...["--quality-verdict", "approved", "--principles", approvedQuality.principles.join(","), "--dry-run"],
				],
				{ cwd: f.root, encoding: "utf8" },
			);
		};
		const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8");
		const withComments =
			template
				.replace(/^## .+$/gm, (heading) => `${heading}\nConcrete task evidence.`)
				.replace(/^EVF-Author: \{"session".*$/m, authorLine) +
			"\n🤖 Generated with [Claude Code](https://claude.com/claude-code)";
		const fencedExample = valid.pr.body.replace(
			authorLine,
			`\`\`\`text\nEVF-Author: anthropic\n\`\`\`\n\n${authorLine}`,
		);
		const oldForm = valid.pr.body.replace(authorLine, "EVF-Author: anthropic");
		assert.deepEqual(
			checkPrBody(f.root, withComments).author,
			AUTHOR,
			"ship accepts a body that keeps the template comments",
		);
		assert.deepEqual(checkPrBody(f.root, fencedExample).author, AUTHOR, "ship ignores a fenced example");
		assert.throws(() => checkPrBody(f.root, oldForm));
		for (const [name, body, accepted] of [
			["template comments kept", withComments, true],
			["fenced example before the line", fencedExample, true],
			["old family form", oldForm, false],
		] as const) {
			const result = posted(body);
			assert.equal(result.status, accepted ? 0 : 1, `poster, ${name}: ${result.stderr}`);
			if (accepted) assert.ok(result.stdout.includes(`"verifier":${JSON.stringify(VERIFIER)}`), name);
			else assert.match(result.stderr, /standard ship checks: EVF-Author must be/);
		}
	} finally {
		f.close();
	}
});

test("INV-carry-approval: an approval carries only over clean merges of main on paths the PR never changed", () => {
	const f = mergeFixture();
	try {
		const inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
		const mainCommit = (path: string, text: string) => {
			writeFileSync(join(f.root, path), text);
			f.git("add", path);
			f.git("commit", "-qm", `Main changes ${path}`);
			f.git("push", "-q", "origin", "main");
			inWt("fetch", "-q", "origin", "main");
		};
		writeFileSync(join(f.wt, "tools/evf/feature.ts"), "export const feature = 1;\n");
		writeFileSync(join(f.wt, "README.md"), "Approved PR line.\n" + readFileSync(join(f.wt, "README.md"), "utf8"));
		inWt("add", "tools/evf/feature.ts", "README.md");
		inWt("commit", "-qm", "Approved work");
		const approved = inWt("rev-parse", "HEAD");
		mainCommit("docs/main-only.md", "Main only.\n");
		inWt("merge", "-q", "--no-edit", "origin/main");
		const clean = inWt("rev-parse", "HEAD");
		const attempt = (head: string, edit: (s) => void = () => {}) => {
			inWt("reset", "-q", "--hard", head);
			const state = f.getState();
			state.pr.headRefOid = head;
			state.comments["77"] = [
				{
					body: `EVF-Review: ${JSON.stringify({ head: approved, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
					html_url: "https://github.com/test/private/pull/77#issuecomment-2",
				},
			];
			state.requiredChecks = [{ ...state.requiredChecks[0], bucket: "pass" }];
			delete state.checksError;
			state.calls = [];
			edit(state);
			f.setState(state);
			return () => ship(f.root, f.taskRef);
		};
		const merges = () => f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge");

		assert.throws(attempt(clean), /fixture merge barrier/);
		assert.deepEqual(merges()[0].args, ["pr", "merge", "77", "--squash", "--match-head-commit", clean]);
		const posted = f.getState().calls.find((c) => c.args[0] === "pr" && c.args[1] === "comment");
		const proof = JSON.parse(posted.args[posted.args.indexOf("--body") + 1].split("EVF-Carry: ")[1]);
		assert.equal(proof.approvedHead, approved);
		assert.equal(proof.head, clean);
		assert.deepEqual(proof.overlap, []);
		assert.deepEqual(
			proof.merges.map((m) => [m.commit, m.branchParent]),
			[[clean, approved]],
		);

		assert.throws(
			attempt(clean, (s) => {
				s.requiredChecks[0].bucket = "fail";
				s.checksError = 1;
			}),
			/CI must be green/,
		);
		assert.deepEqual(merges(), []);

		inWt("reset", "-q", "--hard", approved);
		inWt("merge", "-q", "--no-commit", "origin/main");
		writeFileSync(join(f.wt, "tools/evf/feature.ts"), "export const feature = 2;\n");
		inWt("commit", "-qam", "Merge main with an edit");
		assert.throws(attempt(inWt("rev-parse", "HEAD")), /does not carry: .* differs from the clean merge of its parents/);
		assert.deepEqual(merges(), []);

		inWt("reset", "-q", "--hard", clean);
		writeFileSync(join(f.wt, "tools/evf/feature.ts"), "export const feature = 3;\n");
		inWt("commit", "-qam", "New work after approval");
		assert.throws(attempt(inWt("rev-parse", "HEAD")), /does not carry: .* is not a merge of main/);
		assert.deepEqual(merges(), []);

		inWt("reset", "-q", "--hard", approved);
		mainCommit("README.md", readFileSync(join(f.root, "README.md"), "utf8") + "Main line.\n");
		inWt("merge", "-q", "--no-edit", "origin/main");
		assert.throws(attempt(inWt("rev-parse", "HEAD")), /main changed paths this PR also changes: README.md/);
		assert.deepEqual(merges(), []);
	} finally {
		f.close();
	}
});

const fastShip = {
	queue: { waitMs: 10_000, pollMs: 10 },
	ciWaitMs: 10_000,
	ciPollMs: 1,
};

test("INV-ship-queue: concurrent ships run one after the other in arrival order; a stopped holder never blocks", async () => {
	const f = fixture(),
		error = console.error;
	try {
		const log = join(f.root, "fake-bin/queue.log"),
			lock = join(evfDataDir(f.root), "ship-queue/lock.json");
		// A holder with `release` keeps the lock until that file exists, so a slow process start never reorders the ships.
		const holder = (name: string, holdMs: number, release = "") =>
			spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { appendFileSync, existsSync } from "node:fs";
import { withShipQueue } from ${JSON.stringify(join(source, "tools/evf/ship-queue.ts"))};
import { sleep } from ${JSON.stringify(join(source, "tools/evf/lib.ts"))};
withShipQueue(${JSON.stringify(f.root)}, ${JSON.stringify(name)}, () => {
	appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");
	sleep(${holdMs});
	while (${JSON.stringify(release)} && !existsSync(${JSON.stringify(release)})) sleep(20);
	appendFileSync(${JSON.stringify(log)}, "end ${name}\\n");
}, { waitMs: 20000, pollMs: 20 });`,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
		const started = async (name: string) => {
			while (!(existsSync(log) && readFileSync(log, "utf8").includes(`start ${name}`)))
				await new Promise((r) => setTimeout(r, 20));
		};
		const finished = (child: ReturnType<typeof spawn>) =>
			new Promise<{ code: number | null; stderr: string }>((done) => {
				let stderr = "";
				child.stderr!.on("data", (d) => (stderr += d));
				child.on("exit", (code) => done({ code, stderr }));
			});

		const release = join(f.root, "fake-bin/release-OPS-91");
		const first = holder("OPS-91", 0, release),
			firstDone = finished(first);
		await started("OPS-91");
		const second = holder("OPS-92", 50),
			secondDone = finished(second);
		let waiting = "";
		second.stderr!.on("data", (d) => (waiting += d));
		while (!waiting.includes("waits in the ship queue")) await new Promise((r) => setTimeout(r, 20));
		writeFileSync(release, "");
		const [a, b] = await Promise.all([firstDone, secondDone]);
		assert.deepEqual([a.code, b.code], [0, 0], a.stderr + b.stderr);
		assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
			"start OPS-91",
			"end OPS-91",
			"start OPS-92",
			"end OPS-92",
		]);
		assert.match(b.stderr, /OPS-92 waits in the ship queue behind OPS-91/);
		assert.equal(existsSync(lock), false, "the last ship released the queue");

		// A holder that stopped without releasing (crash, kill) loses the lock to the next ship.
		const stopped = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(lock, JSON.stringify({ pid: stopped, task: "OPS-93", at: new Date().toISOString() }));
		const lines: string[] = [];
		console.error = (...args) => lines.push(args.join(" "));
		assert.equal(
			withShipQueue(f.root, "OPS-94", () => "merged", fastShip.queue),
			"merged",
		);
		assert.match(lines.join("\n"), /removed the queue lock of a stopped ship \(OPS-93/);

		// A live holder makes the next ship wait only up to its bound, then it refuses without running.
		const busy = holder("OPS-95", 3_000);
		await started("OPS-95");
		let ran = false;
		assert.throws(
			() => withShipQueue(f.root, "OPS-96", () => (ran = true), { waitMs: 200, pollMs: 20 }),
			/ship queue is still busy after 0 min/,
		);
		assert.equal(ran, false);
		assert.deepEqual(
			readdirSync(join(evfDataDir(f.root), "ship-queue/tickets")),
			[],
			"the refused ship left the queue",
		);
		busy.kill("SIGKILL");
		await finished(busy);
	} finally {
		console.error = error;
		f.close();
	}
});

test("INV-ship-queue-update: a behind PR is updated by a merge of main, waits for every required check and carries; otherwise a fresh gate is needed", () => {
	const f = mergeFixture(),
		log = console.log,
		lines: string[] = [];
	try {
		const inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
		const lock = join(evfDataDir(f.root), "ship-queue/lock.json");
		const pass = {
			name: "ci",
			state: "SUCCESS",
			bucket: "pass",
			link: "https://github.com/test/private/actions/runs/2",
		};
		const prBody = { ...pass, name: "pr-body" };
		const mainCommit = (path: string, text: string) => {
			writeFileSync(join(f.root, path), text);
			f.git("add", path);
			f.git("commit", "-qm", `Main changes ${path}`);
			f.git("push", "-q", "origin", "main");
			return f.git("rev-parse", "HEAD");
		};
		writeFileSync(join(f.wt, "tools/evf/feature.ts"), "export const feature = 1;\n");
		writeFileSync(join(f.wt, "README.md"), "Approved PR line.\n" + readFileSync(join(f.wt, "README.md"), "utf8"));
		inWt("add", "tools/evf/feature.ts", "README.md");
		inWt("commit", "-qm", "Approved work");
		const approved = inWt("rev-parse", "HEAD");
		const attempt = (checksQueue: unknown[], reported = [pass, prBody], timing = fastShip) => {
			inWt("reset", "-q", "--hard", approved);
			inWt("push", "-q", "origin", `+${approved}:refs/heads/${f.taskRef.branch}`);
			const state = f.getState();
			state.pr.headRefOid = approved;
			state.comments["77"] = [
				{
					body: `EVF-Review: ${JSON.stringify({ head: approved, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
					html_url: "https://github.com/test/private/pull/77#issuecomment-3",
				},
			];
			state.protection = { required_status_checks: { strict: true, contexts: ["ci", "pr-body"] } };
			state.requiredChecks = reported;
			state.checksQueue = checksQueue;
			state.calls = [];
			f.setState(state);
			lines.length = 0;
			return () => ship(f.root, f.taskRef, timing);
		};
		const calls = (sub: string) => f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === sub);
		console.log = (...args) => lines.push(args.join(" "));

		const main = mainCommit("docs/main-only.md", "Main only.\n");
		// Checks: the approved head, then the new head with none reported, with only pr-body (ci not created yet),
		// with ci pending, then every required check green.
		assert.throws(
			attempt([[pass, prBody], [], [prBody], [prBody, { name: "ci", bucket: "pending" }]]),
			/fixture merge barrier/,
		);
		assert.equal(calls("checks").length, 6, "ship polled until ci existed and passed");
		const head = inWt("rev-parse", "HEAD");
		assert.equal(f.getState().pr.headRefOid, head);
		assert.deepEqual(inWt("rev-list", "--parents", "-n", "1", head).split(" ").slice(1), [approved, main]);
		assert.deepEqual(calls("update-branch")[0].args, ["pr", "update-branch", "77"]);
		assert.match(lines.join("\n"), /waiting for required CI on/);
		const proof = JSON.parse(calls("comment")[0].args.at(-1).split("EVF-Carry: ")[1]);
		assert.deepEqual([proof.approvedHead, proof.head], [approved, head]);
		assert.deepEqual(calls("merge")[0].args, ["pr", "merge", "77", "--squash", "--match-head-commit", head]);
		assert.equal(existsSync(lock), false, "a refused merge releases the queue");

		// Required ci is never created on the new head (CI run 40016189676): ship refuses at its bound, no merge.
		mainCommit("docs/never.md", "Never.\n");
		assert.throws(
			attempt([[pass, prBody]], [prBody], { ...fastShip, ciWaitMs: 300, ciPollMs: 20 }),
			/Required CI on [a-f0-9]{40} is still running after 0 min \(ci missing\)/,
		);
		assert.deepEqual([calls("comment"), calls("merge")], [[], []]);
		assert.equal(existsSync(lock), false);

		// Required CI fails on the merge of main: no merge, and the queue is free again.
		mainCommit("docs/second.md", "Second.\n");
		assert.throws(
			attempt([
				[pass, prBody],
				[prBody, { name: "ci", bucket: "fail" }],
			]),
			/Fresh gate needed at [a-f0-9]{40}: required CI failed after the merge of main \(ci\)/,
		);
		assert.equal(calls("update-branch").length, 1);
		assert.deepEqual(calls("merge"), []);
		assert.equal(existsSync(lock), false);
		const refusals = () => {
			const db = openWorkDb(f.root);
			try {
				return (
					db.prepare("SELECT payload FROM events WHERE type = 'ship_refused' ORDER BY id").all() as Array<{
						payload: string;
					}>
				).map((row) => JSON.parse(row.payload));
			} finally {
				db.close();
			}
		};
		assert.deepEqual(
			refusals().at(-1).overlapPaths,
			[],
			"AC:OPS-140-1 a Fresh gate refusal without an overlap records no paths",
		);
		assert.equal(refusals().at(-1).kind, "fresh_gate");

		// Main changed a path the PR changes: refuse before touching the branch.
		mainCommit("README.md", readFileSync(join(f.root, "README.md"), "utf8") + "Main line.\n");
		const overlapMain = mainCommit("README.md", readFileSync(join(f.root, "README.md"), "utf8") + "Main line.\n");
		// AC:OPS-140-6 the rule and its message are unchanged, byte for byte.
		assert.throws(attempt([]), {
			message:
				"Fresh gate needed: main changed paths this PR also changes: README.md. Include current main, run CI and get a new verifier review. The branch is unchanged.",
		});
		assert.deepEqual([calls("update-branch"), calls("merge")], [[], []]);
		assert.equal(inWt("rev-parse", "HEAD"), approved);
		assert.equal(existsSync(lock), false);
		// AC:OPS-140-1 the refusal records its kind, overlap paths, main and head.
		const refused = refusals().at(-1);
		assert.deepEqual(
			[refused.kind, refused.overlapPaths, refused.main, refused.head],
			["fresh_gate", ["README.md"], overlapMain, approved],
		);

		// AC:OPS-140-1 a head that already merged the overlapping main refuses in the carry check: the same paths.
		const before = refusals().length;
		const retry = attempt([]);
		inWt("merge", "-q", "--no-edit", "origin/main");
		inWt("push", "-q", "origin", `HEAD:refs/heads/${f.taskRef.branch}`);
		const merged = f.getState();
		merged.pr.headRefOid = inWt("rev-parse", "HEAD");
		f.setState(merged);
		assert.throws(retry, /does not carry: main changed paths this PR also changes: README.md\./);
		assert.deepEqual(
			refusals()
				.slice(before)
				.map((r) => [r.kind, r.overlapPaths]),
			[["fresh_gate", ["README.md"]]],
			"one event for one refusal",
		);
	} finally {
		console.log = log;
		f.close();
	}
});

test("INV-load-limit: heavy commands wait above the machine limit with one line per minute, run below it and log overrides", () => {
	const f = mergeFixture(),
		error = console.error,
		lines: string[] = [];
	try {
		const setLimit = (maxPerCore: number, maxWaitMinutes: number) => {
			f.cfg.machineLoad = { maxPerCore, maxWaitMinutes };
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		};
		const limit = 2 * availableParallelism();
		delete f.cfg.machineLoad;
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		assert.deepEqual(loadLimit(f.root), {
			cores: availableParallelism(),
			maxPerCore: 2,
			maxWaitMinutes: 30,
			memoryFloorPct: 15,
			swapCeilingGb: 12,
			limit,
		});
		setLimit(2, 3);
		// A fake clock: each sleep advances it; the load falls below the limit after `busyMs`.
		const probe = (busyMs: number) => {
			let now = 0;
			return { read: () => (now < busyMs ? limit + 5 : limit - 1), sleep: (ms: number) => (now += ms), now: () => now };
		};
		console.error = (...args) => lines.push(args.join(" "));

		awaitLoad(f.root, "verify", undefined, probe(150_000));
		assert.deepEqual(
			lines.map((l) => l.match(/waiting, (\d) of 3 min/)?.[1]),
			["0", "1", "2"],
		);
		assert.match(lines[0], new RegExp(`^evf verify: load ${limit + 5}\\.0, limit ${limit} \\(2 × \\d+ cores\\)`));
		lines.length = 0;
		awaitLoad(f.root, "verify", undefined, probe(0));
		assert.deepEqual(lines, [], "below the limit runs at once and prints nothing");
		assert.throws(
			() => awaitLoad(f.root, "task start", undefined, probe(Infinity)),
			/stayed above its load limit for 3 min/,
		);
		assert.equal(lines.length, 3);

		const overrides = join(evfDataDir(f.root), "load-overrides.jsonl");
		assert.throws(() => awaitLoad(f.root, "verify", " ", probe(Infinity)), /--ignore-load needs a reason/);
		lines.length = 0;
		awaitLoad(f.root, "browser run", "release blocker", probe(Infinity));
		assert.match(lines[0], /load override logged .*: release blocker/);
		assert.deepEqual(
			readFileSync(overrides, "utf8")
				.trim()
				.split("\n")
				.map((l) => {
					const { command, limit: logged, reason } = JSON.parse(l);
					return [command, logged, reason];
				}),
			[["browser run", limit, "release blocker"]],
		);

		// evf verify itself: refuses above the limit before any check, runs with a logged override and below it.
		console.error = () => {};
		const reports = () => (existsSync(evidenceDir(f.root, f.taskRef, f.sha, "author-full")) ? 1 : 0);
		setLimit(1e-9, 0);
		assert.throws(() => verify(f.root, f.taskRef, "author", "full"), /stayed above its load limit for 0 min/);
		assert.equal(reports(), 0, "no check ran");
		assert.equal(verify(f.root, f.taskRef, "author", "full", undefined, "owner asked for this run").passed, true);
		assert.equal(readFileSync(overrides, "utf8").trim().split("\n").length, 2);
		setLimit(1e6, 0);
		assert.equal(verify(f.root, f.taskRef, "author", "quick").passed, true);
		assert.equal(readFileSync(overrides, "utf8").trim().split("\n").length, 2);
	} finally {
		console.error = error;
		f.close();
	}
});

test("BUG-196-carry-progress: a carried approval on owning paths records progress only while its carry proof holds", () => {
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
		const inWt = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
		mkdirSync(join(wt, "packages/reference"), { recursive: true });
		writeFileSync(join(wt, "packages/reference/fixture.txt"), "Reviewed reference bundle");
		inWt("add", "packages/reference/fixture.txt");
		inWt("commit", "-qm", "Reviewed fixture output");
		const approved = inWt("rev-parse", "HEAD");
		writeFileSync(join(f.root, "docs/main-only.md"), "Main only.\n");
		f.git("add", "docs/main-only.md");
		f.git("commit", "-qm", "Main changes an unrelated path");
		f.git("push", "-q", "origin", "main");
		inWt("fetch", "-q", "origin", "main");
		inWt("merge", "-q", "--no-edit", "origin/main");
		const head = inWt("rev-parse", "HEAD"),
			state = f.getState();
		state.allowMerge = true;
		state.mergeBranch = task.branch;
		state.pr.headRefOid = head;
		state.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: approved, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(state);
		console.log = () => {};
		assert.equal(ship(f.root, task), 0);
		const record = JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), "utf8"));
		assert.equal(record.verified_head, head);
		assert.equal(record.verification.approval.head, approved);
		assert.equal(record.verification.carry.approvedHead, approved);
		assert.equal(loadProgress(f.root)["WP-001"].milestones[task.id].merge_commit, record.merge_commit);
		const progress = readFileSync(progressPath, "utf8");

		// The carry must still prove itself: a record whose proof names another head, or whose approved head
		// does not reach the tested head through clean merges of main, is refused as before.
		const refused = (edit: (r) => void) => {
			const copy = structuredClone(record);
			edit(copy);
			assert.throws(() => recordProgress(f.root, copy, true), /independently reviewed/);
			assert.equal(readFileSync(progressPath, "utf8"), progress);
		};
		refused((r) => delete r.verification.carry);
		refused((r) => (r.verification.carry.approvedHead = f.sha));
		refused((r) => {
			r.verification.approval.head = f.sha;
			r.verification.carry.approvedHead = f.sha;
		});
		refused((r) => (r.verification.checks[0].bucket = "fail"));
		listShipped(f.root, [task.id]);
		assert.equal(producerReady(f.root, "WP-001"), true);
	} finally {
		console.log = log;
		f.close();
	}
});

test("BUG-179-red-main: ship refuses while main's latest CI run failed, unless the PR fixes the open P0 issue", () => {
	const f = mergeFixture();
	try {
		const run = (conclusion: string) => ({ conclusion, headSha: "c".repeat(40), url: "https://example.invalid/run" });
		const attempt = (edit: (s) => void) => {
			const state = f.getState();
			state.mainRuns = [run("cancelled"), run("failure"), run("success")];
			state.issues = [
				...state.issues.filter((i) => i.number !== 176),
				{ number: 176, title: "P0: CI failed on main", state: "open" },
			];
			state.calls = [];
			edit(state);
			f.setState(state);
			return () => ship(f.root, f.taskRef);
		};
		const merges = () => f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge");
		const fixes = (n: number) => (s) => {
			s.pr.body = s.pr.body.replace("EVF-Author:", `Fixes #${n}\n\nEVF-Author:`);
		};
		assert.throws(
			attempt(() => {}),
			/Main CI is red \(failure at cccccccccc/,
		);
		assert.deepEqual(merges(), []);
		assert.throws(attempt(fixes(3)), /Main CI is red/);
		assert.throws(
			attempt((s) => {
				fixes(176)(s);
				s.issues.at(-1).state = "closed";
			}),
			/Main CI is red/,
		);
		assert.deepEqual(merges(), []);
		assert.throws(attempt(fixes(176)), /fixture merge barrier/);
		assert.equal(merges().length, 1);
		assert.throws(
			attempt((s) => {
				s.mainRuns = [run("skipped"), run("success"), run("failure")];
			}),
			/fixture merge barrier/,
		);
	} finally {
		f.close();
	}
});

test("BUG-wave1-0016: renumber a migration that collides with main and keep the journal and snapshot chain valid", () => {
	const f = mergeFixture();
	try {
		const dir = "packages/db/migrations";
		const inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
		const snapshot = (id: string, prevId: string, tables: string[]) =>
			JSON.stringify({
				id,
				prevId,
				version: "7",
				dialect: "postgresql",
				tables: Object.fromEntries(
					tables
						.map((t) => t.split(":"))
						.map(([t, column]) => [`public.${t}`, { name: t, columns: column ? { [column]: { name: column } } : {} }]),
				),
				enums: {},
			});
		const add = (repo: string, name: string, tables: string[], prevId: string, id: string) => {
			mkdirSync(join(repo, dir, "meta"), { recursive: true });
			const journalPath = join(repo, dir, "meta/_journal.json");
			const journal = existsSync(journalPath)
				? JSON.parse(readFileSync(journalPath, "utf8"))
				: { version: "7", dialect: "postgresql", entries: [] };
			const idx = Number(name.slice(0, 4));
			journal.entries.push({ idx, version: "7", when: 1000 + idx, tag: name, breakpoints: true });
			writeFileSync(journalPath, JSON.stringify(journal, null, 2));
			writeFileSync(join(repo, dir, `${name}.sql`), `CREATE TABLE ${tables.at(-1)!.split(":")[0]} ();\n`);
			writeFileSync(join(repo, dir, `meta/${name.slice(0, 4)}_snapshot.json`), snapshot(id, prevId, tables));
			execFileSync("git", ["-C", repo, "add", dir]);
			execFileSync("git", ["-C", repo, "commit", "-qm", `Add ${name}`]);
		};
		add(f.root, "0001_a", ["a"], "00000000-0000-0000-0000-000000000000", "s1");
		add(f.root, "0002_main", ["a", "main_table"], "s1", "s2-main");
		f.git("push", "-q", "origin", "main");
		inWt("reset", "-q", "--hard", "HEAD");
		execFileSync("git", ["-C", f.wt, "merge", "-q", "--ff-only", "main~1"]);
		add(f.wt, "0002_branch", ["a", "branch_table"], "s1", "s2-branch");
		const branchTip = inWt("rev-parse", "HEAD");
		inWt("fetch", "-q", "origin", "main");
		const mainSnapshot = f.git("show", `origin/main:${dir}/meta/0002_snapshot.json`);

		// The author resolves the merge by hand: both 0002 migrations stay and ship refuses the collision.
		assert.notEqual(spawnSync("git", ["-C", f.wt, "merge", "-q", "--no-edit", "origin/main"]).status, 0);
		inWt("checkout", "--ours", "--", `${dir}/meta`);
		inWt("commit", "-qam", "Merge main");
		assert.throws(() => ship(f.root, f.taskRef), /New migrations 0002_branch.sql reuse numbers main already has/);
		assert.deepEqual(
			f.getState().calls.filter((c) => c.args[0] === "pr" && c.args[1] === "merge"),
			[],
		);

		const expectValid = () => {
			const read = (path: string) => readFileSync(join(f.wt, dir, path), "utf8");
			const journal = JSON.parse(read("meta/_journal.json"));
			assert.deepEqual(
				journal.entries.map((e) => [e.idx, e.tag]),
				[
					[1, "0001_a"],
					[2, "0002_main"],
					[3, "0003_branch"],
				],
			);
			assert.ok(journal.entries.every((e, i) => i === 0 || e.when > journal.entries[i - 1].when));
			assert.deepEqual(
				readdirSync(join(f.wt, dir)).filter((n) => n.endsWith(".sql")),
				["0001_a.sql", "0002_main.sql", "0003_branch.sql"],
			);
			assert.equal(read("meta/0002_snapshot.json"), mainSnapshot);
			const moved = JSON.parse(read("meta/0003_snapshot.json"));
			assert.deepEqual([moved.id, moved.prevId], ["s2-branch", "s2-main"]);
			assert.deepEqual(Object.keys(moved.tables), ["public.a", "public.main_table", "public.branch_table"]);
			assert.equal(read("0003_branch.sql"), "CREATE TABLE branch_table ();\n");
		};
		assert.deepEqual(renumberMigrations(f.wt, "origin/main"), ["0002_branch.sql -> 0003_branch.sql"]);
		inWt("commit", "-qm", "Renumber migrations after main");
		expectValid();
		const repaired = inWt("rev-parse", "HEAD^{tree}");
		renumberMigrations(f.wt, "origin/main");
		assert.equal(inWt("status", "--porcelain"), "");

		// Inside a conflicted merge, the command resolves the migration files to the same result.
		inWt("reset", "-q", "--hard", branchTip);
		assert.notEqual(spawnSync("git", ["-C", f.wt, "merge", "-q", "--no-edit", "origin/main"]).status, 0);
		renumberMigrations(f.wt, "origin/main");
		inWt("commit", "-q", "--no-edit");
		expectValid();
		assert.equal(inWt("rev-parse", "HEAD^{tree}"), repaired);

		// BUG-6cdb381: consecutive branch migrations with one suffix move without overwriting each other.
		inWt("reset", "-q", "--hard", branchTip);
		add(f.wt, "0003_branch", ["a", "branch_table", "extra"], "s2-branch", "s3-branch");
		assert.notEqual(spawnSync("git", ["-C", f.wt, "merge", "-q", "--no-edit", "origin/main"]).status, 0);
		assert.deepEqual(renumberMigrations(f.wt, "origin/main"), [
			"0002_branch.sql -> 0003_branch.sql",
			"0003_branch.sql -> 0004_branch.sql",
		]);
		assert.equal(readFileSync(join(f.wt, dir, "0003_branch.sql"), "utf8"), "CREATE TABLE branch_table ();\n");
		assert.equal(readFileSync(join(f.wt, dir, "0004_branch.sql"), "utf8"), "CREATE TABLE extra ();\n");
		assert.deepEqual(
			JSON.parse(readFileSync(join(f.wt, dir, "meta/_journal.json"), "utf8")).entries.map((e) => e.tag),
			["0001_a", "0002_main", "0003_branch", "0004_branch"],
		);
		const fourth = JSON.parse(readFileSync(join(f.wt, dir, "meta/0004_snapshot.json"), "utf8"));
		assert.deepEqual([fourth.id, fourth.prevId], ["s3-branch", "s2-branch"]);
		assert.deepEqual(Object.keys(fourth.tables), [
			"public.a",
			"public.main_table",
			"public.branch_table",
			"public.extra",
		]);
		inWt("merge", "--abort");

		// Both sides change the same table: no silent merge.
		inWt("reset", "-q", "--hard", branchTip);
		add(f.wt, "0003_branch_more", ["a", "main_table:x", "branch_table"], "s2-branch", "s3-branch");
		assert.notEqual(spawnSync("git", ["-C", f.wt, "merge", "-q", "--no-edit", "origin/main"]).status, 0);
		assert.throws(
			() => renumberMigrations(f.wt, "origin/main"),
			/Main and this branch both change snapshot.tables.public.main_table/,
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
			`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
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
			`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(state);
		const store = openWorkDb(f.root);
		ensureTask(store, task, "implement");
		store.prepare("UPDATE tasks SET status = 'pr_open', pr_number = 77 WHERE ref = ?").run(task.id);
		console.log = () => {};
		assert.equal(ship(f.root, task), 0);
		// OPS-66: a standalone ship marks the current row merged with the merge commit, once.
		const shipped = store.prepare("SELECT id, status, merge_commit FROM tasks WHERE ref = ?").all(task.id);
		assert.equal(shipped.length, 1);
		assert.equal(shipped[0].status, "merged");
		assert.equal(shipped[0].merge_commit, f.git("rev-parse", "HEAD"));
		assert.equal(
			store.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'merged'").get(shipped[0].id).n,
			1,
		);
		assert.equal(nextStage(task, findTask(store, task), []).stage, "done");
		const nextOut = spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "next", task.id], {
			cwd: f.root,
			encoding: "utf8",
			env: { ...process.env, EVF_RUN: "" },
		});
		assert.equal(JSON.parse(nextOut.stdout).stage, "done");
		store.close();
		const path = join(evfDataDir(f.root), "shipped", `${task.slug}.json`),
			record = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(record.verified_head, sha);
		assert.deepEqual(record.verification.approval.verifier, VERIFIER);
		assert.deepEqual(record.verification.author, AUTHOR);
		const held = structuredClone(record);
		held.acknowledged = true;
		assert.equal(reviewedMilestone(f.root, held), true, "an independent Opus review counts");
		held.verification.approval.verifier = { ...VERIFIER, session: AUTHOR.session };
		assert.equal(reviewedMilestone(f.root, held), false, "the author's own session never counts");
		// Records written before D82 carry model families; the rule that shipped them stays frozen for them.
		delete held.verification.author;
		delete held.verification.approval.verifier;
		held.verification.authorFamily = "xai";
		held.verification.approval.verifierFamily = "xai";
		held.verification.checkedAt = new Date(Date.parse(LEGACY_FAMILY_WAIVER_END) - 1).toISOString();
		assert.equal(reviewedMilestone(f.root, held), true, "a stored checkedAt inside the waiver still counts");
		held.verification.checkedAt = LEGACY_FAMILY_WAIVER_END;
		assert.equal(reviewedMilestone(f.root, held), false, "a review at the waiver instant does not count");
		held.verification.authorFamily = "openai";
		held.verification.approval.verifierFamily = "xai";
		held.verification.checkedAt = "2026-10-24T00:00:00.000Z";
		assert.equal(reviewedMilestone(f.root, held), false, "openai never reviewed xai");
		held.verification.authorFamily = "xai";
		held.verification.approval.verifierFamily = "anthropic";
		held.verification.checkedAt = "2026-10-28T00:00:00.000Z";
		assert.equal(reviewedMilestone(f.root, held), true, "anthropic reviewed xai after the waiver");
		assert.deepEqual(record.verification.approval.quality, approvedQuality);
		assert.equal(loadProgress(f.root)["WP-001"].status, "in_progress");
		assert.equal(producerReady(f.root, "WP-001"), true, "ship acknowledges the reviewed milestone itself");
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
		const priorMilestone = JSON.parse(progress).packages["WP-001"].milestones[task.id];
		f.git("push", "-q", "origin", "main");
		const later = f.task(task.slug);
		writeFileSync(join(later, "README.md"), "Later reviewed outside-path fix\n");
		execFileSync("git", ["-C", later, "add", "README.md"]);
		execFileSync("git", ["-C", later, "commit", "-qm", "Later maintenance"]);
		const laterSha = f.git("rev-parse", task.branch),
			laterState = f.getState();
		laterState.pr.headRefOid = laterSha;
		laterState.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: laterSha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(laterState);
		assert.equal(ship(f.root, task), 0);
		assert.equal(producerReady(f.root, "WP-001"), true, "new outside-path record hid reviewed producer");
		listShipped(f.root, [task.id]);
		assert.equal(producerReady(f.root, "WP-001"), true);
		requireImplementation(f.root, "WP-032");
		assert.equal(readFileSync(progressPath, "utf8"), progress);
		const canonical = JSON.parse(progress);
		canonical.packages["WP-001"].milestones[task.id].acknowledged = false;
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-001"), false, "unacknowledged producer cannot unlock dependents");
		canonical.packages["WP-001"].milestones[task.id] = { ...priorMilestone, merge_commit: "a".repeat(40) };
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-001"), false, "unintegrated producer cannot unlock dependents");
		writeFileSync(progressPath, progress);

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
		assert.deepEqual(checkPrBody(f.root, valid.pr.body).author, AUTHOR);
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
