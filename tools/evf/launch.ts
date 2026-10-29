import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ensureTask, findTask, openWorkDb, workDbPath } from "./db.ts";
import {
	baseRef,
	fail,
	git,
	loadConfig,
	run,
	runtimeDir,
	sleep,
	worktreePath,
	type Config,
	type TaskRef,
} from "./lib.ts";
import { chooseSplit, findTui, readLayout, rebalance, type Direction } from "./panes.ts";
import { taskStart } from "./task.ts";

/**
 * A seat is one fresh top-level Claude Code session in its own Herdr pane and task worktree (D82, PLAN.md PR 3).
 * evf launch creates the worktree when it is missing, splits a pane off the TUI workspace (a new workspace only when
 * none exists) with the seat's environment, starts `claude --agent <role> --dangerously-skip-permissions` with a
 * session id evf chose, and records the run. Jonah and evf drive only ever call this.
 */

export const ROLES = {
	planner: { model: "claude-opus-5-5", effort: "high", stage: "plan" },
	implementer: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	ui: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	simplifier: { model: "claude-sonnet-5-5", effort: "medium", stage: "simplify" },
	evidence: { model: "claude-sonnet-5-5", effort: "medium", stage: "evidence" },
	verifier: { model: "claude-opus-5-5", effort: "high", stage: "verify" },
	ideator: { model: "claude-sonnet-5-5", effort: "medium", stage: "idea" },
	comparer: { model: "claude-sonnet-5-5", effort: "medium", stage: "compare" },
	"prototype-merger": { model: "claude-opus-5-5", effort: "high", stage: "merge" },
} as const;
export type Role = keyof typeof ROLES;
export const isRole = (value: string | undefined): value is Role => !!value && value in ROLES;

/**
 * Every seat gets these: oh-my-zsh's update prompt off (DISABLE_AUTO_UPDATE, it ate the first launch character),
 * Claude Code's background updater off (DISABLE_AUTOUPDATER), no advisor (Decision 17), plus the evf ids the hooks read.
 */
export const SEAT_ENV = {
	DISABLE_AUTO_UPDATE: "true",
	DISABLE_AUTOUPDATER: "1",
	CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
};
const START_TIMEOUT_MS = 90_000;
const TRUST_PROMPT = /trust this folder|Yes, proceed|trust the files in this folder/i;

type HerdrResult = { result?: Record<string, unknown> };
function herdr(args: string[]): HerdrResult {
	const r = run("herdr", args);
	if (r.code !== 0) fail(`herdr ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
	try {
		return JSON.parse(r.stdout) as HerdrResult;
	} catch {
		return {};
	}
}
const idOf = (value: unknown, key: string): string => {
	const id = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : value;
	if (typeof id === "string") return id;
	fail(`Herdr returned no ${key}.`);
};
const quote = (arg: string) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

/** Idea seats of prototype mode get their own worktree and branch next to the task's. */
export const ideaWorktree = (root: string, cfg: Config, task: TaskRef, idea: number) =>
	`${worktreePath(root, cfg, task)}-idea${idea}`;
export const ideaBranch = (task: TaskRef, idea: number) => `${task.branch}-idea${idea}`;
function createIdeaWorktree(root: string, cfg: Config, task: TaskRef, idea: number): string {
	const path = ideaWorktree(root, cfg, task, idea),
		branch = ideaBranch(task, idea);
	if (!existsSync(path)) {
		git(root, "worktree", "add", "--quiet", "-b", branch, path, baseRef(root, cfg));
		console.log(`launch: idea worktree ${path} on ${branch}.`);
		if (existsSync(`${path}/package.json`)) {
			const install = run("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: path });
			if (install.code !== 0) fail(`Dependency install failed in ${path}: ${install.stderr.trim().slice(0, 300)}`);
		}
	}
	return path;
}

export type LaunchPlan = {
	task: string;
	role: Role;
	idea?: number;
	stage: string;
	mode: string;
	round: number;
	worktree: string;
	session: string;
	/** Herdr agent name `<role>-<slug>-<run id>`; `<run>` until the run row exists. */
	agent: string;
	name: string;
	env: Record<string, string>;
	claudeArgs: string[];
};

export function launchPlan(
	root: string,
	task: TaskRef,
	role: Role,
	opts: { mode?: string; round?: number; run?: string; idea?: number },
): LaunchPlan {
	const cfg = loadConfig(root),
		seat = ROLES[role],
		session = randomUUID(),
		idea = opts.idea,
		worktree = idea ? ideaWorktree(root, cfg, task, idea) : worktreePath(root, cfg, task),
		stage = idea ? `idea${idea}` : seat.stage,
		tag = idea ? String(idea) : "";
	return {
		task: task.id,
		role,
		...(idea ? { idea } : {}),
		stage,
		mode: opts.mode ?? "implement",
		round: opts.round ?? 0,
		worktree,
		session,
		agent: `${role}${tag}-${task.slug}-${opts.run ?? "<run>"}`,
		name: `${role}${tag}@${task.id}`,
		env: {
			EVF_TASK: task.id,
			EVF_RUN: opts.run ?? "<run>",
			EVF_ROLE: role,
			EVF_STAGE: stage,
			EVF_WORKTREE: worktree,
			EVF_RUNTIME: runtimeDir(root, task),
			EVF_SESSION: session,
			...(idea ? { EVF_IDEA: String(idea) } : {}),
			...(role === "ideator" ? { EVF_BLIND: "1" } : {}),
			...SEAT_ENV,
		},
		claudeArgs: [
			"--agent",
			role,
			"--name",
			`${role}${tag}@${task.id}`,
			"--session-id",
			session,
			"--model",
			seat.model,
			"--effort",
			seat.effort,
			"--dangerously-skip-permissions",
		],
	};
}

const envArgs = (plan: LaunchPlan) => Object.entries(plan.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
const workspaceArgs = (plan: LaunchPlan, label: string) => [
	"workspace",
	"create",
	"--cwd",
	plan.worktree,
	"--label",
	label,
	...envArgs(plan),
	"--no-focus",
];
const splitArgs = (plan: LaunchPlan, target: { pane: string; direction: Direction }) => [
	"pane",
	"split",
	target.pane,
	"--direction",
	target.direction,
	"--cwd",
	plan.worktree,
	...envArgs(plan),
	"--no-focus",
];
/** Where a new seat goes inside the TUI workspace: the largest pane along its longer side. */
function splitTarget(tui: { pane: string }): { pane: string; direction: Direction } {
	const layout = readLayout(tui.pane);
	return layout ? chooseSplit(layout.panes, tui.pane) : { pane: tui.pane, direction: "right" };
}
const startArgs = (plan: LaunchPlan, pane: string) => [
	"agent",
	"start",
	plan.agent,
	"--kind",
	"claude",
	"--pane",
	pane,
	"--timeout",
	String(START_TIMEOUT_MS),
	"--",
	...plan.claudeArgs,
];

/** Print every step without changing Herdr, the store or the worktree. It only reads Herdr to find the TUI workspace. */
export function launchDryRun(
	root: string,
	task: TaskRef,
	role: Role,
	opts: { mode?: string; prompt?: string; idea?: number },
): number {
	const plan = launchPlan(root, task, role, { mode: opts.mode, idea: opts.idea });
	const label = opts.idea ? `${task.slug}-idea${opts.idea}` : task.slug,
		tui = findTui();
	const lines = [
		`# evf launch ${task.id} --role ${role}${opts.idea ? ` --idea ${opts.idea}` : ""} (dry run)`,
		existsSync(plan.worktree)
			? `# worktree exists: ${plan.worktree}`
			: opts.idea
				? `git worktree add -b ${ideaBranch(task, opts.idea)} ${plan.worktree} ${baseRef(root, loadConfig(root))}`
				: `bin/evf task start ${task.id} --no-stack`,
		`# store: ensure task ${task.id} (${plan.mode}); insert run {stage: ${plan.stage}, role: ${role}, model: ${ROLES[role].model}, effort: ${ROLES[role].effort}, session: ${plan.session}}`,
		tui
			? `herdr ${splitArgs(plan, splitTarget(tui)).map(quote).join(" ")}`
			: `herdr ${workspaceArgs(plan, label).map(quote).join(" ")}`,
		`herdr ${startArgs(plan, tui ? "<new pane>" : "<root pane>")
			.map(quote)
			.join(" ")}`,
		`# store: run.herdr_agent = ${plan.agent}, run.herdr_pane = ${tui ? "<new pane>" : "<root pane>"}; task.herdr_workspace_id = ${tui ? tui.workspace : "<new workspace>"}; event stage_start`,
		...(opts.prompt ? [`herdr agent prompt ${plan.agent} ${quote(opts.prompt)}`] : []),
	];
	console.log(lines.join("\n"));
	return 0;
}

/**
 * After `agent start` fails, a fresh worktree may be sitting at Claude Code's folder-trust dialog. Accept it once and
 * wait for the agent to settle; anything else is a real failure. Herdr names the agent only on a successful start,
 * so the pane id is the handle until then.
 */
function acceptTrustDialog(pane: string, agent: string): boolean {
	const screen = run("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "80"]);
	if (!TRUST_PROMPT.test(screen.stdout)) return false;
	run("herdr", ["pane", "send-keys", pane, "enter"]);
	const settled = run("herdr", ["agent", "wait", pane, "--until", "idle", "--timeout", String(START_TIMEOUT_MS)]);
	if (settled.code !== 0) return false;
	run("herdr", ["agent", "rename", pane, agent]);
	return true;
}

/** Waits around `herdr agent start`. Tests pass short values; production uses LAUNCH_TIMING. */
export type LaunchTiming = {
	paneReadyMs: number;
	paneReadyPollMs: number;
	busyRetries: number;
	busyBackoffMs: number;
};
export const LAUNCH_TIMING: LaunchTiming = {
	paneReadyMs: 30_000,
	paneReadyPollMs: 500,
	busyRetries: 3,
	busyBackoffMs: 1_000,
};

/**
 * A new pane is an available shell once its shell owns the foreground: `herdr pane process-info` reports
 * `process_info.foreground_process_group_id` equal to `process_info.shell_pid`. While the shell still starts up
 * (oh-my-zsh, profile scripts) another process group is in front and `agent start` answers agent_pane_busy.
 */
function paneShellReady(pane: string): { ready: boolean; seen: string } {
	const r = run("herdr", ["pane", "process-info", "--pane", pane]);
	if (r.code !== 0) return { ready: false, seen: (r.stderr || r.stdout).trim().slice(0, 120) || "no answer" };
	try {
		const info = (JSON.parse(r.stdout) as { result?: { process_info?: Record<string, unknown> } }).result?.process_info;
		const group = info?.foreground_process_group_id,
			shell = info?.shell_pid;
		return { ready: typeof shell === "number" && group === shell, seen: `foreground group ${group}, shell ${shell}` };
	} catch {
		return { ready: false, seen: "unreadable answer" };
	}
}
function waitForShell(workspace: string, pane: string, timing: LaunchTiming): void {
	const started = Date.now();
	for (;;) {
		const state = paneShellReady(pane);
		if (state.ready) return;
		const waited = Date.now() - started;
		if (waited >= timing.paneReadyMs)
			fail(
				`pane ${pane} in workspace ${workspace} was not an available shell after waiting ${Math.round(waited / 100) / 10} s (${state.seen}).`,
			);
		sleep(Math.min(timing.paneReadyPollMs, timing.paneReadyMs - waited));
	}
}

/** Does an agent named `agent` or any agent in `pane` exist? null when Herdr cannot say. */
function agentPresent(agent: string, pane: string): boolean | null {
	const r = run("herdr", ["agent", "list"]);
	if (r.code !== 0) return null;
	try {
		const agents = (JSON.parse(r.stdout) as { result?: { agents?: Array<{ name?: string; pane_id?: string }> } }).result
			?.agents;
		if (!Array.isArray(agents)) return null;
		return agents.some((a) => a.name === agent || a.pane_id === pane);
	} catch {
		return null;
	}
}

/**
 * Start the seat once. agent_pane_busy retries with growing backoff; before each retry the agent list proves the
 * earlier start did not succeed late, so a seat never starts twice. Any other failure tries the trust dialog once.
 */
function startSeat(plan: LaunchPlan, workspace: string, pane: string, timing: LaunchTiming): void {
	for (let attempt = 0; ; attempt++) {
		const started = run("herdr", startArgs(plan, pane));
		if (started.code === 0) return;
		const output = (started.stderr || started.stdout).trim();
		if (!/agent_pane_busy/.test(output)) {
			if (acceptTrustDialog(pane, plan.agent)) return;
			fail(
				`herdr agent start failed in workspace ${workspace} pane ${pane}: ${output}. Read the pane, then close the workspace or retry.`,
			);
		}
		if (attempt >= timing.busyRetries)
			fail(
				`herdr agent start stayed busy in workspace ${workspace} pane ${pane} after ${attempt} retries: ${output}. Read the pane, then close the workspace or retry.`,
			);
		sleep(timing.busyBackoffMs * 2 ** attempt);
		const present = agentPresent(plan.agent, pane);
		if (present === true) return; // The earlier start succeeded late: that seat is the one.
		if (present === null)
			fail(
				`herdr agent start was busy in workspace ${workspace} pane ${pane} and Herdr cannot list agents; not retrying.`,
			);
	}
}

export function launch(
	root: string,
	task: TaskRef,
	role: Role,
	opts: {
		mode?: string;
		prompt?: string;
		ignoreLoad?: string;
		dryRun?: boolean;
		idea?: number;
		timing?: Partial<LaunchTiming>;
	},
): number {
	const timing = { ...LAUNCH_TIMING, ...opts.timing };
	// A merged ref fails before it gets a worktree or a row, dry run included. Reading never creates the store.
	if (existsSync(workDbPath(root))) {
		const known = openWorkDb(root, { readOnly: true });
		try {
			if (findTask(known, task)?.status === "merged") fail(`${task.id} is merged.`);
		} finally {
			known.close();
		}
	}
	if (opts.dryRun) return launchDryRun(root, task, role, opts);
	const cfg = loadConfig(root);
	if (opts.idea && role !== "ideator") fail("--idea is for the ideator role.");
	if (role === "ideator" && !opts.idea) fail("The ideator role needs --idea 1, 2 or 3.");
	if (opts.idea) createIdeaWorktree(root, cfg, task, opts.idea);
	else if (!existsSync(worktreePath(root, cfg, task))) {
		console.log(`launch: creating the ${task.id} worktree.`);
		taskStart(root, task, { allowUnready: false, noStack: true, ignoreLoad: opts.ignoreLoad });
	}
	const db = openWorkDb(root);
	try {
		const taskRow = ensureTask(db, task, opts.mode ?? "implement");
		if (taskRow.status === "merged" || taskRow.status === "abandoned") fail(`${task.id} is ${taskRow.status}.`);
		if (taskRow.status === "escalated")
			fail(`${task.id} is escalated after ${taskRow.round} rounds. Sebastian decides before another seat starts.`);
		const plan = launchPlan(root, task, role, { mode: taskRow.mode, round: taskRow.round, idea: opts.idea });
		const now = new Date().toISOString();
		const runId = db
			.prepare(
				`INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
			)
			.run(
				taskRow.id,
				plan.stage,
				role,
				ROLES[role].model,
				ROLES[role].effort,
				taskRow.round,
				plan.session,
				now,
			).lastInsertRowid;
		plan.env.EVF_RUN = String(runId);
		plan.agent = `${role}${opts.idea ?? ""}-${task.slug}-${runId}`; // One Herdr agent per run, so round 2 never collides with round 1's seat.
		// Until the agent is up, any Herdr failure aborts the run, so the store never lists a seat that does not exist.
		let workspace = "",
			pane = "";
		const tui = findTui();
		try {
			if (tui) {
				const made = herdr(splitArgs(plan, splitTarget(tui))).result ?? {};
				workspace = tui.workspace;
				pane = idOf(made.pane, "pane_id");
			} else {
				const ws = herdr(workspaceArgs(plan, opts.idea ? `${task.slug}-idea${opts.idea}` : task.slug)).result ?? {};
				workspace = idOf(ws.workspace, "workspace_id");
				pane = idOf(ws.root_pane, "pane_id");
			}
			waitForShell(workspace, pane, timing);
			startSeat(plan, workspace, pane, timing);
		} catch (error) {
			// A split pane that never ran its agent goes away; the TUI pane and the other seats stay as they are.
			if (tui && pane && pane !== tui.pane) {
				run("herdr", ["pane", "close", pane]);
				rebalance(tui.pane);
			}
			const reason = error instanceof Error ? error.message : String(error);
			db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
				new Date().toISOString(),
				`launch failed: ${reason.slice(0, 500)}`,
				runId,
			);
			throw error;
		}
		db.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = ? WHERE id = ?").run(plan.agent, pane, runId);
		if (opts.idea)
			db.prepare(
				"UPDATE tasks SET status = CASE WHEN status IN ('new', 'specced') THEN 'active' ELSE status END, updated_at = ? WHERE id = ?",
			).run(new Date().toISOString(), taskRow.id);
		else
			db.prepare(
				"UPDATE tasks SET status = CASE WHEN status IN ('new', 'specced') THEN 'active' ELSE status END, worktree = ?, branch = ?, herdr_workspace_id = ?, updated_at = ? WHERE id = ?",
			).run(plan.worktree, task.branch, workspace, new Date().toISOString(), taskRow.id);
		db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'stage_start', ?)").run(
			taskRow.id,
			runId,
			new Date().toISOString(),
			JSON.stringify({
				role,
				stage: plan.stage,
				workspace,
				pane,
				session: plan.session,
				summary: `${plan.name} started in ${workspace}`,
			}),
		);
		if (opts.prompt) {
			herdr(["agent", "prompt", plan.agent, opts.prompt]);
			db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'prompt_sent', ?)").run(
				taskRow.id,
				runId,
				new Date().toISOString(),
				JSON.stringify({ summary: opts.prompt.slice(0, 200) }),
			);
		}
		console.log(
			JSON.stringify({
				task: task.id,
				run: runId,
				role,
				stage: plan.stage,
				session: plan.session,
				workspace,
				pane,
				agent: plan.agent,
				worktree: plan.worktree,
			}),
		);
		return 0;
	} finally {
		db.close();
	}
}
