import { dirname, resolve, join } from "node:path";
import { fixture } from "./fixtures.ts";
import { parseTask, evfDataDir } from "../lib.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureTask, openWorkDb } from "../db.ts";
import { reconcileProgress } from "../progress.ts";
import { principles } from "../principles.ts";
import { DEFAULT_DOCUMENT_TEMPLATES } from "../policy.ts";
import { setLoadedCode, type CodeIdentity } from "../merge.ts";

// Helpers the reconciliation test files share. The tests live in three files so that the runner can run them in parallel.

export const source = resolve(import.meta.dirname, "../../..");

export const approvePr = (headRefName: string, extra: Record<string, unknown> = {}) => ({
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

export const approveWrites = (f: any) =>
	f
		.getState()
		.calls.filter(
			(c: any) =>
				(c.args[0] === "pr" && ["comment", "merge", "ready", "update-branch"].includes(c.args[1])) ||
				c.args.includes("POST"),
		);

// Review parties (D82): the author and the verifier are different Claude Code sessions; the verifier is Opus.
export const AUTHOR = {
	session: "11111111-1111-4111-8111-111111111111",
	model: "claude-sonnet-5-5",
	role: "implementer",
};

export const VERIFIER = { session: "22222222-2222-4222-8222-222222222222", model: "claude-opus-5-5", role: "verifier" };

export const authorLine = `EVF-Author: ${JSON.stringify(AUTHOR)}`;

export function validPrBody() {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	return (
		template
			.split("\n")
			.filter((line) => line.startsWith("## "))
			.map((heading) => heading + "\nConcrete task evidence.")
			.join("\n\n") +
		"\n\n" +
		authorLine +
		"\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"
	);
}

export const approvedQuality = {
	verdict: "approved",
	principles: [
		"laziness-protocol",
		"minimize-reader-load",
		"subtract-before-you-add",
		"test-behavior-not-implementation",
	],
};

export const approvedExperience = { verdict: "approved", budget: "met" };

export function mergeFixture(scope: Record<string, unknown> = { owningPaths: ["tools/evf/"] }) {
	const f = fixture(),
		task = parseTask("OPS-1");
	f.cfg.maintenanceTasks = {
		[task.id]: { title: "Workflow upkeep", checks: f.cfg.checks, ...scope },
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
	state.protection = { required_status_checks: { strict: true, contexts: ["CI"] } };
	state.requiredChecks = [
		{ name: "CI", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
	];
	state.comments["77"] = [
		{
			body: `Verified the actual tooling behavior.\n\nEVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
			html_url: "https://github.com/test/private/pull/77#issuecomment-1",
		},
	];
	f.setState(state);
	return { ...f, taskRef: task, wt, sha };
}

/** WP-001/OPS-67 ship setup: an approved, green WP task whose merge commit lands on the base ref. */
export function wpShipFixture(
	mergeBranchOverride?: string,
	file = "packages/reference/fixture.txt",
	shape: { task?: string; extraFiles?: string[] } = {},
) {
	const f = mergeFixture(),
		task = parseTask(shape.task ?? "WP-001");
	f.authorize(shape.task ? task.wp! : "WP-032");
	const progressPath = join(f.root, "docs/build-progress.json"),
		initial = JSON.parse(readFileSync(progressPath, "utf8"));
	initial.packages[task.wp!].status = "not_started";
	writeFileSync(progressPath, JSON.stringify(initial));
	reconcileProgress(f.root);
	f.commit();
	f.git("push", "-q", "origin", "main");
	const wt = f.task(task.slug);
	for (const name of [file, ...(shape.extraFiles ?? [])]) {
		mkdirSync(dirname(join(wt, name)), { recursive: true });
		writeFileSync(join(wt, name), "Reviewed reference bundle");
		execFileSync("git", ["-C", wt, "add", name]);
	}
	execFileSync("git", ["-C", wt, "commit", "-qm", "Reviewed fixture output"]);
	const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (mergeBranchOverride) {
		f.git("checkout", "-q", "-b", mergeBranchOverride);
		mkdirSync(join(f.root, "packages/reference"), { recursive: true });
		writeFileSync(join(f.root, "packages/reference/fixture.txt"), "Different merged bytes");
		f.git("add", "packages/reference/fixture.txt");
		f.git("commit", "-qm", "Other bytes");
		f.git("checkout", "-q", "main");
	}
	const state = f.getState();
	state.allowMerge = true;
	state.mergeBranch = mergeBranchOverride ?? task.branch;
	state.pr.headRefOid = sha;
	state.comments["77"][0].body =
		`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
	f.setState(state);
	// The work store knows the seats evf launched, then the drive reaches the ship stage.
	const db = openWorkDb(f.root),
		row = ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET spec = ?, pr_number = 77 WHERE id = ?").run(
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
	const shipped = () => JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), "utf8"));
	return { f, db, task, progressPath, shipped };
}

export const DRIVE_TIMING = {
	waitMs: 2000,
	ciWaitMs: 200,
	ciPollMs: 10,
	seatPollMs: 10,
	startGraceMs: 10,
	holdPollMs: 10,
};

/** The fake gh mergeCalls into the checkout two levels above its cwd; evf approve runs gh in the caller's cwd. */
export const inFakeCwd = <T>(f: { root: string }, fn: () => T): T => {
	const cwd = process.cwd(),
		dir = join(f.root, "fake-bin", "cwd");
	mkdirSync(dir, { recursive: true });
	process.chdir(dir);
	try {
		return fn();
	} finally {
		process.chdir(cwd);
	}
};

/** The PR fields evf approve reads, on top of the ship fixture's PR. */
export function approvable(f: ReturnType<typeof mergeFixture>, branch: string, files: string[], head: string) {
	f.git("push", "-q", "origin", branch);
	const s = f.getState();
	s.pr = {
		...s.pr,
		title: "Template PR",
		headRefName: branch,
		headRefOid: head,
		mergeStateStatus: "CLEAN",
		files: files.map((path) => ({ path })),
	};
	f.setState(s);
}

export const verifiedStatus = (head: string) => ({
	statuses: [
		{
			context: "evf/verify",
			state: "success",
			description: `Verified by claude-opus-5-5 (session 22222222) at ${head.slice(0, 10)}`,
		},
	],
});

/** The class is read from the base branch (OPS-83), so the policy is committed and pushed to it. */
export const templateConfig = (f: { root: string; cfg: any; git: (...a: string[]) => string }, paths: string[]) => {
	f.cfg.mergePolicy.documentTemplates = { ...structuredClone(DEFAULT_DOCUMENT_TEMPLATES), paths };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.git("add", "evf.config.json");
	f.git("commit", "-qm", "Template policy");
	f.git("push", "-q", "origin", "main");
};

export const callsWith = (f: any, ...match: string[]) =>
	f.getState().calls.filter((c: any) => match.every((m) => c.args.includes(m)));

export const mergeCalls = (f: any) =>
	f.getState().calls.filter((c: any) => c.args[0] === "pr" && ["merge", "update-branch"].includes(c.args[1]));

export const capturedLog = <T>(fn: () => T): { value: T; lines: string[] } => {
	const log = console.log,
		lines: string[] = [];
	console.log = (...a: unknown[]) => lines.push(a.join(" "));
	try {
		return { value: fn(), lines };
	} finally {
		console.log = log;
	}
};

export const currentCode = (base: { commit: string; evfTree: string; binTree: string }): CodeIdentity => ({
	checkout: "fixture",
	...base,
	dirty: false,
});

export const behindCode = (base: { binTree: string }): CodeIdentity => ({
	checkout: "/old/checkout",
	commit: "1".repeat(40),
	evfTree: "2".repeat(40),
	binTree: base.binTree,
	dirty: false,
});

export const withCode = <T>(claim: Parameters<typeof setLoadedCode>[0], fn: () => T): T => {
	setLoadedCode(claim);
	try {
		return fn();
	} finally {
		setLoadedCode(currentCode);
	}
};

/** PR #375 (WP-036/api): the engine swap plus rebuilt templates, with files outside the class beside them. */
export const PR375_FILES = [
	"packages/domain/src/documents/templates/layouts/invoice.tsx",
	"packages/domain/src/documents/templates/fonts/Inter-Regular.ttf",
	"packages/domain/src/documents/theme.ts",
	"docs/catalog/document-templates.json",
	"pnpm-lock.yaml",
	"tests/integration/documents/render.test.ts",
];

export const pr375 = () =>
	wpShipFixture(undefined, "packages/domain/src/documents/templates/registry.ts", {
		task: "WP-036/api",
		extraFiles: PR375_FILES,
	});

export const at = (wt: string, rev: string, path: string) =>
	execFileSync("git", ["-C", wt, "show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
