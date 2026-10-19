import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBrief } from "./brief.ts";
import { requireImplementation, requireSpend, requireTaskRisk, requireTaskScope } from "./policy.ts";
import { reviewedMilestone } from "./progress.ts";
import { startFeedbackTask, cachedTriage } from "./feedback.ts";
import {
	baseRef,
	command,
	fail,
	findPackage,
	git,
	gitOk,
	hasRemote,
	loadConfig,
	loadDag,
	pathsForPart,
	partsOf,
	evfDataDir,
	requireWorktree,
	run,
	runtimeDir,
	worktreePath,
	type Config,
	type TaskRef,
} from "./lib.ts";

export function stackEnv(root: string, task: TaskRef, wt: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		EVF_TASK: task.id,
		EVF_TASK_SLUG: task.slug,
		EVF_WORKTREE: wt,
		EVF_RUNTIME_DIR: runtimeDir(root, task),
	};
}

export function stackInfo(root: string, task: TaskRef): Record<string, string> {
	const path = join(runtimeDir(root, task), "stack.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
}

function stackCmd(cfg: Config, name: "up" | "down" | "status" | "traces" | "logs"): string[] | null {
	return cfg.stack?.[name] ?? null;
}

export function stack(root: string, task: TaskRef, action: "up" | "down" | "status", optional = false): number {
	const cfg = loadConfig(root);
	if (task.kind === "ops") fail("Maintenance tasks have no application stack.");
	if (action === "up") {
		const wp = task.kind === "wp" ? task.wp : cachedTriage(root, task.issue!)?.wp;
		if (!wp) fail("No reviewed stack task scope.");
		requireImplementation(root, wp, task.part);
		requireTaskRisk(root, task);
	}
	if (action === "up" && cfg.stack) {
		if (typeof cfg.stack.usesPaidProviders !== "boolean")
			fail("Declare whether the stack uses paid providers before starting it.");
		if (cfg.stack.usesPaidProviders) requireSpend(root);
	}
	const configured = stackCmd(cfg, action),
		argv = configured && command(configured);
	if (!argv) {
		const msg = `No stack "${action}" command in evf.config.json yet. The workflow bootstrap package defines the per-task stack command.`;
		if (optional) {
			console.log(`stack: skipped. ${msg}`);
			return 0;
		}
		fail(msg);
	}
	const wt = requireWorktree(root, cfg, task);
	mkdirSync(runtimeDir(root, task), { recursive: true });
	const r = run(argv[0], argv.slice(1), { cwd: wt, env: stackEnv(root, task, wt), inherit: true });
	if (r.code === 0 && action !== "down") {
		const info = stackInfo(root, task);
		if (Object.keys(info).length) console.log(`stack: ${JSON.stringify(info)}`);
	}
	return r.code;
}

export function debugCmd(root: string, task: TaskRef, name: "traces" | "logs", extra: string[]): number {
	const cfg = loadConfig(root);
	const configured = stackCmd(cfg, name),
		argv = configured && command(configured);
	if (!argv)
		fail(`No stack "${name}" command in evf.config.json yet. The observability setup (WP-003, WP-050) defines it.`);
	const wt = requireWorktree(root, cfg, task);
	return run(argv[0], [...argv.slice(1), ...extra], { cwd: wt, env: stackEnv(root, task, wt), inherit: true }).code;
}

export function taskStart(
	root: string,
	task: TaskRef,
	opts: { allowUnready: boolean; noStack: boolean; uiTier?: string; overLimit?: boolean },
): number {
	const cfg = loadConfig(root);
	if (opts.allowUnready)
		fail(
			"--allow-unready is removed. Use a read-only brief to investigate; implementation requires closed action gates and reviewed producer milestones.",
		);
	if (task.kind === "fb") {
		const r = startFeedbackTask(root, task, opts.overLimit === true);
		console.log(
			`feedback: FB-${task.issue} is ${r.class}; internal issue #${(r as { internalIssue?: number }).internalIssue}.`,
		);
	} else if (task.kind === "ops") {
		requireTaskScope(root, task);
		renderBrief(root, task, {});
	} else {
		const pkg = findPackage(loadDag(root), task.wp);
		pathsForPart(pkg, task.part);
		requireImplementation(root, task.wp, task.part);
		requireTaskRisk(root, task);
		renderBrief(root, task, {}); // Resolve all current context before any worktree/remote mutation.
		const parts = partsOf(pkg),
			anchor =
				task.part === "api" && parts.includes("contract")
					? "contract"
					: task.part === "ui"
						? parts.includes("contract")
							? "contract"
							: "api"
						: null;
		if (anchor) {
			const path = join(evfDataDir(root), "shipped", `${task.wp.toLowerCase()}-${anchor}.json`);
			if (!existsSync(path)) fail(`Required ${task.wp}/${anchor} merged-part evidence is missing.`);
			const record = JSON.parse(readFileSync(path, "utf8"));
			if (
				record.task !== `${task.wp}/${anchor}` ||
				record.package_id !== task.wp ||
				record.part !== anchor ||
				typeof record.merge_commit !== "string" ||
				!gitOk(root, "merge-base", "--is-ancestor", record.merge_commit, baseRef(root, cfg))
			)
				fail("Required split prerequisite is not integrated into current main.");
			if (!reviewedMilestone(root, record)) fail("Split prerequisite requires reviewed integrated milestone evidence.");
		}
	}

	if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const base = baseRef(root, cfg);
	const wt = worktreePath(root, cfg, task);

	if (existsSync(wt)) {
		const behind = git(wt, "rev-list", "--count", `HEAD..${base}`);
		console.log(`worktree: reusing ${wt} (${behind} commits behind ${base}).`);
	} else if (gitOk(root, "show-ref", "--verify", "--quiet", `refs/heads/${task.branch}`)) {
		git(root, "worktree", "add", "--quiet", wt, task.branch);
		console.log(`worktree: ${wt} on existing branch ${task.branch}.`);
	} else {
		git(root, "worktree", "add", "--quiet", "-b", task.branch, wt, base);
		console.log(`worktree: ${wt} on new branch ${task.branch} from ${base}.`);
	}
	mkdirSync(runtimeDir(root, task), { recursive: true });
	writeFileSync(
		join(runtimeDir(root, task), "active.json"),
		JSON.stringify({ startedAt: new Date().toISOString() }) + "\n",
	);
	console.log(`intent: call ws.git.registerRoot(${JSON.stringify(wt)}) so Intent shows this worktree.`);
	console.log(
		"shell: your shell starts in the workspace root. evf commands find the worktree from the task ID; for other commands use `git -C` or the worktree path.",
	);

	if (!opts.noStack && task.kind !== "ops") {
		const code = stack(root, task, "up", true);
		if (code !== 0)
			fail(
				`stack up failed with exit code ${code}. The worktree exists; fix the stack, then run evf stack up ${task.id}.`,
			);
	}
	console.log("");
	console.log(renderBrief(root, task, { uiTier: opts.uiTier }));
	return 0;
}
