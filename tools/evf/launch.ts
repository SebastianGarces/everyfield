import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ensureTask, openWorkDb } from "./db.ts";
import { fail, loadConfig, run, worktreePath, type TaskRef } from "./lib.ts";
import { taskStart } from "./task.ts";

/**
 * A seat is one fresh top-level Claude Code session in its own Herdr pane and task worktree (D82, PLAN.md PR 3).
 * evf launch creates the worktree when it is missing, opens a Herdr workspace with the seat's environment, starts
 * `claude --agent <role>` with a session id evf chose, and records the run. Jonah and evf drive only ever call this.
 */

export const ROLES = {
	planner: { model: "claude-opus-5-5", effort: "high", stage: "plan" },
	implementer: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	ui: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	simplifier: { model: "claude-sonnet-5-5", effort: "medium", stage: "simplify" },
	evidence: { model: "claude-sonnet-5-5", effort: "medium", stage: "evidence" },
	verifier: { model: "claude-opus-5-5", effort: "high", stage: "verify" },
} as const;
export type Role = keyof typeof ROLES;
export const isRole = (value: string | undefined): value is Role => !!value && value in ROLES;

/** Every seat gets these: no update prompt at launch, no advisor (Decision 17), and the evf ids the hooks read. */
export const SEAT_ENV = { DISABLE_AUTO_UPDATE: "true", CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
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
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string")
		return (value as Record<string, string>)[key];
	fail(`Herdr returned no ${key}.`);
};
const quote = (arg: string) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

export type LaunchPlan = {
	task: string;
	role: Role;
	stage: string;
	mode: string;
	round: number;
	worktree: string;
	session: string;
	agent: string;
	name: string;
	env: Record<string, string>;
	claudeArgs: string[];
};

export function launchPlan(root: string, task: TaskRef, role: Role, opts: { mode?: string; round?: number; run?: string }): LaunchPlan {
	const cfg = loadConfig(root),
		seat = ROLES[role],
		session = randomUUID(),
		worktree = worktreePath(root, cfg, task);
	return {
		task: task.id,
		role,
		stage: seat.stage,
		mode: opts.mode ?? "implement",
		round: opts.round ?? 0,
		worktree,
		session,
		agent: `${role}-${task.slug}`,
		name: `${role}@${task.id}`,
		env: {
			EVF_TASK: task.id,
			EVF_RUN: opts.run ?? "<run>",
			EVF_ROLE: role,
			EVF_STAGE: seat.stage,
			EVF_WORKTREE: worktree,
			EVF_SESSION: session,
			...SEAT_ENV,
		},
		claudeArgs: [
			"--agent",
			role,
			"--name",
			`${role}@${task.id}`,
			"--session-id",
			session,
			"--model",
			seat.model,
			"--effort",
			seat.effort,
			"--permission-mode",
			"acceptEdits",
		],
	};
}

const workspaceArgs = (plan: LaunchPlan, label: string) => [
	"workspace",
	"create",
	"--cwd",
	plan.worktree,
	"--label",
	label,
	...Object.entries(plan.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
	"--no-focus",
];
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

/** Print every step without touching Herdr, the store or the worktree. */
export function launchDryRun(root: string, task: TaskRef, role: Role, opts: { mode?: string; prompt?: string }): number {
	const plan = launchPlan(root, task, role, { mode: opts.mode });
	const lines = [
		`# evf launch ${task.id} --role ${role} (dry run)`,
		existsSync(plan.worktree) ? `# worktree exists: ${plan.worktree}` : `bin/evf task start ${task.id} --no-stack`,
		`# store: ensure task ${task.id} (${plan.mode}); insert run {stage: ${plan.stage}, role: ${role}, model: ${ROLES[role].model}, effort: ${ROLES[role].effort}, session: ${plan.session}}`,
		`herdr ${workspaceArgs(plan, task.slug).map(quote).join(" ")}`,
		`herdr ${startArgs(plan, "<root pane>").map(quote).join(" ")}`,
		`# store: run.herdr_agent = ${plan.agent}, run.herdr_pane = <root pane>; event stage_start`,
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

export function launch(
	root: string,
	task: TaskRef,
	role: Role,
	opts: { mode?: string; prompt?: string; ignoreLoad?: string; dryRun?: boolean },
): number {
	if (opts.dryRun) return launchDryRun(root, task, role, opts);
	const cfg = loadConfig(root);
	if (!existsSync(worktreePath(root, cfg, task))) {
		console.log(`launch: creating the ${task.id} worktree.`);
		taskStart(root, task, { allowUnready: false, noStack: true, ignoreLoad: opts.ignoreLoad });
	}
	const db = openWorkDb(root);
	try {
		const taskRow = ensureTask(db, task, opts.mode ?? "implement");
		if (taskRow.status === "merged" || taskRow.status === "abandoned") fail(`${task.id} is ${taskRow.status}.`);
		if (taskRow.status === "escalated")
			fail(`${task.id} is escalated after ${taskRow.round} rounds. Sebastian decides before another seat starts.`);
		const plan = launchPlan(root, task, role, { mode: taskRow.mode, round: taskRow.round });
		const now = new Date().toISOString();
		const runId = db
			.prepare(
				`INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)`,
			)
			.run(taskRow.id, plan.stage, role, ROLES[role].model, ROLES[role].effort, taskRow.round, plan.session, now)
			.lastInsertRowid;
		plan.env.EVF_RUN = String(runId);
		const ws = herdr(workspaceArgs(plan, task.slug)).result ?? {};
		const workspace = idOf(ws.workspace, "workspace_id"),
			pane = idOf(ws.root_pane, "pane_id");
		const started = run("herdr", startArgs(plan, pane));
		if (started.code !== 0 && !acceptTrustDialog(pane, plan.agent)) {
			db.prepare("UPDATE runs SET status = 'aborted', ended_at = ?, summary = ? WHERE id = ?").run(
				new Date().toISOString(),
				`agent start failed: ${(started.stderr || started.stdout).trim().slice(0, 500)}`,
				runId,
			);
			fail(
				`herdr agent start failed in workspace ${workspace} pane ${pane}: ${(started.stderr || started.stdout).trim()}. Read the pane, then close the workspace or retry.`,
			);
		}
		db.prepare("UPDATE runs SET herdr_agent = ?, herdr_pane = ? WHERE id = ?").run(plan.agent, pane, runId);
		db.prepare(
			"UPDATE tasks SET status = CASE WHEN status = 'new' THEN 'active' ELSE status END, worktree = ?, branch = ?, herdr_workspace_id = ?, updated_at = ? WHERE id = ?",
		).run(plan.worktree, task.branch, workspace, new Date().toISOString(), taskRow.id);
		db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'stage_start', ?)").run(
			taskRow.id,
			runId,
			new Date().toISOString(),
			JSON.stringify({ role, stage: plan.stage, workspace, pane, session: plan.session, summary: `${plan.name} started in ${workspace}` }),
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
			JSON.stringify({ task: task.id, run: runId, role, stage: plan.stage, session: plan.session, workspace, pane, agent: plan.agent, worktree: plan.worktree }),
		);
		return 0;
	} finally {
		db.close();
	}
}
