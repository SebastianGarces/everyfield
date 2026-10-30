import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTask, findTask, openWorkDb, workDbPath } from "./db.ts";
import {
	baseRef,
	EvfError,
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
import { resolveSeat, type Role } from "./seats.ts";
import { taskStart } from "./task.ts";
import { fillRunUsage } from "./usage.ts";

/**
 * A seat is one fresh top-level Claude Code session in its own Herdr pane and task worktree (D82, PLAN.md PR 3).
 * evf launch creates the worktree when it is missing, splits a pane off the TUI workspace (a new workspace only when
 * none exists) with the seat's environment, starts `claude --agent <role> --dangerously-skip-permissions` with a
 * session id evf chose, and records the run. Jonah and evf drive only ever call this.
 */

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

/**
 * The role's agent definition comes from the evf checkout that runs the launch (`<root>/.claude/agents/<role>.md`).
 * It reaches Claude Code as a per-run plugin directory (`--plugin-dir <runtime>/seat-<run>`, agent `evf:<role>`), not
 * as text on the typed line: Herdr types the command into the pane's shell, and the terminal refuses a line of 1024
 * bytes or more (OPS-74). A plugin agent is namespaced, so the worktree's own `.claude/agents` never shadows or
 * replaces it: a task branch that removes, renames or edits a role file cannot change the seat its own drive launches.
 * (`--agents <file>` would also keep the line short, but Claude Code reads a file there only with `--print`.)
 */
/** A launch that created its run row and then closed it as aborted. The drive logs it and goes on. */
export class LaunchAborted extends EvfError {}
/** The typed line is at or over the terminal limit. Retrying cannot shorten it: the drive escalates at once. */
export class LaunchLineTooLong extends EvfError {}
/** Herdr's terminal refuses a typed line of this many bytes or more (`agent_start_input_failed`). */
export const TYPED_LINE_LIMIT = 1024;
export const PLUGIN_NAME = "evf";
export type AgentDefinition = { source: string; markdown: string };
export function agentDefinition(root: string, role: Role, seat: { model: string; effort: string }): AgentDefinition {
	const source = `${root}/.claude/agents/${role}.md`;
	if (!existsSync(source)) fail(`The driving checkout has no agent definition for ${role}: ${source} is missing.`);
	const text = readFileSync(source, "utf8");
	const parsed = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!parsed) fail(`${source} has no frontmatter.`);
	// A role file without its own model or effort gets the seat's, as before.
	const keys = new Set(parsed[1]!.split("\n").flatMap((l) => /^([A-Za-z][\w-]*):/.exec(l)?.[1] ?? []));
	const added = [
		...(keys.has("model") ? [] : [`model: ${seat.model}`]),
		...(keys.has("effort") ? [] : [`effort: ${seat.effort}`]),
	];
	return { source, markdown: `---\n${[parsed[1]!, ...added].join("\n")}\n---\n${parsed[2]!}` };
}
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
export const quote = (arg: string) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

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
	model: string;
	effort: string;
	/** The per-run plugin directory that carries the agent definition; one directory per run, never shared. */
	pluginDir: string;
	/** The file the agent definition was read from, and its text as the plugin carries it. */
	agentSource: string;
	agentMarkdown: string;
};
/** The arguments after `claude`. Everything in them is short: the definition lives in the plugin directory. */
export const claudeArgs = (plan: LaunchPlan): string[] => [
	"--plugin-dir",
	plan.pluginDir,
	"--agent",
	`${PLUGIN_NAME}:${plan.role}`,
	"--name",
	plan.name,
	"--session-id",
	plan.session,
	"--model",
	plan.model,
	"--effort",
	plan.effort,
	"--dangerously-skip-permissions",
];
/** The exact line Herdr types into the pane's shell for `agent start ... -- <args>`: `claude`, then each quoted argument. */
export const typedLine = (plan: LaunchPlan): string => ["claude", ...claudeArgs(plan)].map(quote).join(" ");
export const typedLineBytes = (plan: LaunchPlan): number => Buffer.byteLength(typedLine(plan));
/** Where a run's plugin directory lives: next to the task's other runtime files, outside every worktree. */
export const seatPluginDir = (root: string, task: TaskRef, run: string | number) =>
	join(runtimeDir(root, task), `seat-${run}`);
/** Write the run's plugin directory: a manifest and the role file. Each run has its own, so two launches never share a path. */
function writeSeatPlugin(plan: LaunchPlan): void {
	mkdirSync(join(plan.pluginDir, ".claude-plugin"), { recursive: true });
	mkdirSync(join(plan.pluginDir, "agents"), { recursive: true });
	writeFileSync(
		join(plan.pluginDir, ".claude-plugin/plugin.json"),
		`${JSON.stringify({ name: PLUGIN_NAME, version: "0.0.0", description: `evf seat definition for run ${plan.env.EVF_RUN}` })}\n`,
	);
	writeFileSync(join(plan.pluginDir, "agents", `${plan.role}.md`), plan.agentMarkdown);
}
/** Refuse a typed line at or over the terminal limit before any pane exists. */
export function guardTypedLine(plan: LaunchPlan, limit = TYPED_LINE_LIMIT): void {
	const bytes = typedLineBytes(plan);
	if (bytes >= limit)
		throw new LaunchLineTooLong(
			`The launch line for ${plan.role} is ${bytes} bytes; the terminal accepts fewer than ${limit}. Retrying cannot help: shorten the plugin path or the seat arguments.`,
		);
}

export function launchPlan(
	root: string,
	task: TaskRef,
	role: Role,
	opts: { mode?: string; round?: number; run?: string; idea?: number },
): LaunchPlan {
	const cfg = loadConfig(root),
		seat = resolveSeat(cfg, task, role),
		agent = agentDefinition(root, role, seat),
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
		model: seat.model,
		effort: seat.effort,
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
		pluginDir: seatPluginDir(root, task, opts.run ?? "<run>"),
		agentMarkdown: agent.markdown,
		agentSource: agent.source,
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
	...claudeArgs(plan),
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
		`# store: ensure task ${task.id} (${plan.mode}); insert run {stage: ${plan.stage}, role: ${role}, model: ${plan.model}, effort: ${plan.effort}, session: ${plan.session}}`,
		tui
			? `herdr ${splitArgs(plan, splitTarget(tui)).map(quote).join(" ")}`
			: `herdr ${workspaceArgs(plan, label).map(quote).join(" ")}`,
		`# agent definition: ${plan.agentSource} (the driving checkout ${root}, not the task worktree), written to ${plan.pluginDir}/agents/${role}.md`,
		`herdr ${startArgs(plan, tui ? "<new pane>" : "<root pane>")
			.map(quote)
			.join(" ")}`,
		`# typed line: ${typedLineBytes(plan)} bytes (the terminal accepts fewer than ${TYPED_LINE_LIMIT})`,
		`# store: run.herdr_agent = ${plan.agent}, run.herdr_pane = ${tui ? "<new pane>" : "<root pane>"}; task.herdr_workspace_id = ${tui ? tui.workspace : "<new workspace>"}; event stage_start`,
		...(opts.prompt
			? [
					"# wait for the run's session_start event, then send the prompt:",
					`herdr agent prompt ${plan.agent} ${quote(opts.prompt)}`,
					"# confirm a turn began; if not, send it once more (event prompt_resent)",
				]
			: []),
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
	/** How long launch waits for the run's session_start event (the Claude session-start hook) before the prompt. */
	sessionReadyMs: number;
	sessionPollMs: number;
	/** How long after the prompt launch waits for a turn to begin before it sends the prompt once more. */
	turnConfirmMs: number;
	turnPollMs: number;
	/** A typed line of this many bytes or more is refused before a pane exists. Herdr's terminal limit; tests lower it. */
	typedLineLimit: number;
};
export const LAUNCH_TIMING: LaunchTiming = {
	paneReadyMs: 30_000,
	paneReadyPollMs: 500,
	busyRetries: 3,
	busyBackoffMs: 1_000,
	sessionReadyMs: 60_000,
	sessionPollMs: 250,
	turnConfirmMs: 15_000,
	turnPollMs: 500,
	typedLineLimit: TYPED_LINE_LIMIT,
};

/**
 * A new pane is a shell at its prompt once the shell owns the foreground and runs nothing else: `herdr pane
 * process-info` reports `foreground_process_group_id` equal to `shell_pid`, and `foreground_processes` lists only the
 * shell. The group check alone is not enough. While zsh loads oh-my-zsh and the profile scripts it is already the
 * foreground group, and its subshells (`brew shellenv`, `uname`, `tail`) show up as extra processes of that group
 * until the line editor starts. A line typed in that window meets the terminal in canonical mode: Herdr answers
 * `agent_start_input_failed` for a line of 1024 bytes or more (OPS-74). Herdr exposes no direct prompt flag, and
 * `pane read` shows the prompt only after the fact, so waitForShell asks for the quiet shell on two polls in a row.
 */
function paneShellReady(pane: string): { ready: boolean; seen: string } {
	const r = run("herdr", ["pane", "process-info", "--pane", pane]);
	if (r.code !== 0) return { ready: false, seen: (r.stderr || r.stdout).trim().slice(0, 120) || "no answer" };
	try {
		const info = (JSON.parse(r.stdout) as { result?: { process_info?: Record<string, unknown> } }).result?.process_info;
		const group = info?.foreground_process_group_id,
			shell = info?.shell_pid;
		const others = (
			Array.isArray(info?.foreground_processes) ? (info.foreground_processes as Array<{ pid?: number }>) : []
		).filter((p) => p.pid !== shell).length;
		return {
			ready: typeof shell === "number" && group === shell && others === 0,
			seen: `foreground group ${group}, shell ${shell}, ${others} other process${others === 1 ? "" : "es"}`,
		};
	} catch {
		return { ready: false, seen: "unreadable answer" };
	}
}
/** The pause between the two quiet polls: long enough to catch a subshell that starts next, short against a launch. */
const QUIET_RECHECK_MS = 100;
function waitForShell(workspace: string, pane: string, timing: LaunchTiming): void {
	const started = Date.now();
	for (let quiet = 0; ;) {
		const state = paneShellReady(pane);
		quiet = state.ready ? quiet + 1 : 0;
		if (quiet >= 2) return;
		if (quiet === 1) {
			sleep(Math.min(QUIET_RECHECK_MS, timing.paneReadyPollMs));
			continue;
		}
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
 * Start the seat once. Two answers mean the shell was not ready for the line: agent_pane_busy (another process owns
 * the foreground) and agent_start_input_failed (the terminal was still in canonical mode). Both retry in the same
 * pane with growing backoff; each retry first waits for the quiet shell again, and the agent list proves the earlier
 * start did not succeed late, so a seat never starts twice. Any other failure tries the trust dialog once.
 */
function startSeat(plan: LaunchPlan, workspace: string, pane: string, timing: LaunchTiming): void {
	let waitedMs = 0;
	for (let attempt = 0; ; attempt++) {
		const started = run("herdr", startArgs(plan, pane));
		if (started.code === 0) return;
		const output = (started.stderr || started.stdout).trim();
		const code = /agent_pane_busy|agent_start_input_failed/.exec(output)?.[0];
		if (!code) {
			if (acceptTrustDialog(pane, plan.agent)) return;
			fail(
				`herdr agent start failed in workspace ${workspace} pane ${pane}: ${output}. Read the pane, then close the workspace or retry.`,
			);
		}
		if (attempt >= timing.busyRetries)
			fail(
				`herdr agent start answered ${code} in workspace ${workspace} pane ${pane} on all ${attempt + 1} attempts over ${Math.round(waitedMs / 100) / 10} s of waiting: ${output}. Read the pane, then close the workspace or retry.`,
			);
		const backoff = timing.busyBackoffMs * 2 ** attempt;
		sleep(backoff);
		waitedMs += backoff;
		const present = agentPresent(plan.agent, pane);
		if (present === true) return; // The earlier start succeeded late: that seat is the one.
		if (present === null)
			fail(
				`herdr agent start answered ${code} in workspace ${workspace} pane ${pane} and Herdr cannot list agents; not retrying.`,
			);
		const before = Date.now();
		waitForShell(workspace, pane, timing);
		waitedMs += Date.now() - before;
	}
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
/** The last meaningful lines of a pane: what the seat's shell or Claude printed before the start failed. */
function paneExcerpt(pane: string): string {
	const r = run("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "80"]);
	if (r.code !== 0) return "";
	return stripAnsi(r.stdout)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /[\p{L}\p{N}]/u.test(line))
		.slice(-6)
		.map((line) => line.slice(0, 160))
		.join(" | ");
}

/** The agent state `herdr agent get` reports, or "unknown" when Herdr cannot say. */
function agentStatus(agent: string): string {
	const r = run("herdr", ["agent", "get", agent], { timeoutMs: 10_000 });
	try {
		return String(
			(JSON.parse(r.stdout) as { result?: { agent?: { agent_status?: string } } }).result?.agent?.agent_status ??
				"unknown",
		);
	} catch {
		return "unknown";
	}
}

/** Wait for the run's session_start event: the Claude session-start hook ran, so the session reads a prompt. */
function waitForSession(db: DatabaseSync, runId: number, timing: LaunchTiming): boolean {
	const started = Date.now();
	for (;;) {
		if (db.prepare("SELECT 1 FROM events WHERE run_id = ? AND type = 'session_start'").get(runId)) return true;
		const waited = Date.now() - started;
		if (waited >= timing.sessionReadyMs) return false;
		sleep(Math.min(timing.sessionPollMs, timing.sessionReadyMs - waited));
	}
}

/** Events that a seat's start writes by itself; any other event of the run after the prompt shows a turn began. */
const START_EVENTS = new Set([
	"stage_start",
	"session_start",
	"refocus",
	"prompt_sent",
	"prompt_resent",
	"launch_retry",
]);
/** Did the prompt start a turn? The agent left idle, a later event of the run shows activity, or the run closed. */
function turnBegan(db: DatabaseSync, runId: number, agent: string, afterEvent: number): boolean {
	if (agentStatus(agent) !== "idle") return true; // working, blocked, done, or a state Herdr cannot name: not a lost prompt.
	const later = db.prepare("SELECT type FROM events WHERE run_id = ? AND id > ?").all(runId, afterEvent) as Array<{
		type: string;
	}>;
	if (later.some((e) => !START_EVENTS.has(e.type))) return true;
	return (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status !== "started";
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
		const event = (type: string, payload: Record<string, unknown>, runId: number): number =>
			Number(
				db
					.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)")
					.run(taskRow.id, runId, new Date().toISOString(), type, JSON.stringify(payload)).lastInsertRowid,
			);
		// The line is measured before a run row or a pane exists; a nine-digit run id makes the path as long as it can get.
		guardTypedLine({ ...plan, pluginDir: seatPluginDir(root, task, "999999999") }, timing.typedLineLimit);
		const now = new Date().toISOString();
		const runId = db
			.prepare(
				`INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
			)
			.run(taskRow.id, plan.stage, role, plan.model, plan.effort, taskRow.round, plan.session, now).lastInsertRowid;
		plan.env.EVF_RUN = String(runId);
		plan.agent = `${role}${opts.idea ?? ""}-${task.slug}-${runId}`; // One Herdr agent per run, so round 2 never collides with round 1's seat.
		plan.pluginDir = seatPluginDir(root, task, runId);
		writeSeatPlugin(plan);
		const tui = findTui();
		/**
		 * One try at a seat: a pane, a ready shell, the agent and, with a prompt to send, the Claude session. A failure
		 * reads the pane so the real error (agent not found, command not found) reaches the message, then closes the
		 * dead pane. The TUI pane and the other seats stay as they are.
		 */
		const attempt = (): { workspace: string; pane: string } => {
			let workspace = "",
				pane = "";
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
				if (opts.prompt && !waitForSession(db, runId, timing))
					fail(
						`The Claude session in pane ${pane} sent no session_start within ${Math.round(timing.sessionReadyMs / 100) / 10} s, so it cannot read a prompt.`,
					);
				return { workspace, pane };
			} catch (error) {
				const excerpt = pane ? paneExcerpt(pane) : "";
				if (tui && pane && pane !== tui.pane) {
					run("herdr", ["pane", "close", pane]);
					rebalance(tui.pane);
				} else if (!tui && workspace) run("herdr", ["workspace", "close", workspace]);
				const reason = error instanceof Error ? error.message : String(error);
				throw new EvfError(excerpt ? `${reason} The pane shows: ${excerpt}` : reason);
			}
		};
		// Until the agent is up, any Herdr failure ends the attempt. The first failure closes the dead pane and tries a
		// new one with a new session id; a second failure aborts the run, so the store never lists a seat that does not exist.
		let placed: { workspace: string; pane: string } | undefined,
			failure = "";
		for (let tries = 0; tries < 2 && !placed; tries++) {
			if (tries) {
				plan.env.EVF_SESSION = randomUUID();
				plan.session = plan.env.EVF_SESSION;
				db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(plan.session, runId);
				event(
					"launch_retry",
					{ reason: failure.slice(0, 400), summary: `launch of ${plan.name} failed, trying a new pane` },
					runId,
				);
				console.log(`launch: ${failure} Trying a new pane once.`);
			}
			try {
				placed = attempt();
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
		}
		if (!placed) {
			db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
				new Date().toISOString(),
				`launch failed: ${failure.slice(0, 700)}`,
				runId,
			);
			fillRunUsage(db, runId);
			throw new LaunchAborted(failure);
		}
		const { workspace, pane } = placed;
		db.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = ? WHERE id = ?").run(plan.agent, pane, runId);
		if (opts.idea)
			db.prepare(
				"UPDATE tasks SET status = CASE WHEN status IN ('new', 'specced') THEN 'active' ELSE status END, updated_at = ? WHERE id = ?",
			).run(new Date().toISOString(), taskRow.id);
		else
			db.prepare(
				"UPDATE tasks SET status = CASE WHEN status IN ('new', 'specced') THEN 'active' ELSE status END, worktree = ?, branch = ?, herdr_workspace_id = ?, updated_at = ? WHERE id = ?",
			).run(plan.worktree, task.branch, workspace, new Date().toISOString(), taskRow.id);
		event(
			"stage_start",
			{
				role,
				stage: plan.stage,
				workspace,
				pane,
				session: plan.session,
				summary: `${plan.name} started in ${workspace}`,
			},
			runId,
		);
		if (opts.prompt) {
			herdr(["agent", "prompt", plan.agent, opts.prompt]);
			const sent = event("prompt_sent", { summary: opts.prompt.slice(0, 200) }, runId);
			// A prompt that went in before the session was ready, or was swallowed, starts no turn: send it once more.
			const confirmStart = Date.now();
			let began = false;
			while (!(began = turnBegan(db, runId, plan.agent, sent)) && Date.now() - confirmStart < timing.turnConfirmMs)
				sleep(Math.min(timing.turnPollMs, Math.max(1, timing.turnConfirmMs - (Date.now() - confirmStart))));
			if (!began) {
				herdr(["agent", "prompt", plan.agent, opts.prompt]);
				event("prompt_resent", { summary: `no turn began after the first prompt; sent it again` }, runId);
			}
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
