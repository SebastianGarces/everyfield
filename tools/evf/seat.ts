import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openWorkDb } from "./db.ts";
import { fail, parseTask, run, type TaskRef } from "./lib.ts";

/**
 * What a seat sees and reports. `evf refocus` prints the goal chain (OpenRig's refocus, guard rail 1). `evf session`
 * prints the pane's Claude Code session id for the EVF-Author and EVF-Review lines. `evf hook <event>` is the entry
 * for the Claude Code hooks in .claude/settings.json: it does nothing outside a seat (no EVF_RUN or EVF_WORKTREE),
 * so ordinary sessions in the repository never touch the store.
 */

type Row = Record<string, unknown>;
type HookInput = {
	session_id?: string;
	cwd?: string;
	hook_event_name?: string;
	source?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	stop_hook_active?: boolean;
	reason?: string;
};
const QUESTION = "Is what you are doing now aligned with this? If not, stop and say so.";
const MAX_LINES = 40;

export function refocusText(db: DatabaseSync, task: TaskRef): string {
	const t = db
		.prepare(
			"SELECT id, title, ask, spec, status, round, goal_id FROM tasks WHERE ref = ? AND status NOT IN ('merged', 'abandoned') ORDER BY id DESC LIMIT 1",
		)
		.get(task.id) as Row | undefined;
	const project = db.prepare("SELECT body FROM goals WHERE key = 'project'").get() as Row | undefined;
	const mission = (
		t?.goal_id
			? db.prepare("SELECT title FROM goals WHERE id = ?").get(t.goal_id as number)
			: task.wp
				? db
						.prepare(
							"SELECT title FROM goals WHERE kind = 'mission' AND EXISTS (SELECT 1 FROM json_each(goals.packages) WHERE value = ?)",
						)
						.get(task.wp)
				: undefined
	) as Row | undefined;
	const stage = t
		? (db.prepare("SELECT stage, role FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1").get(t.id as number) as
				| Row
				| undefined)
		: undefined;
	const lines = [`Goal chain for ${task.id}`, `Project: ${project?.body ?? "(not synced yet: run evf goals sync)"}`];
	if (mission) lines.push(`Mission: ${mission.title}`);
	lines.push(
		t
			? `Task: ${task.id}${t.title && t.title !== task.id ? ` ${t.title}` : ""} (${t.status}, round ${t.round} of 3)`
			: `Task: ${task.id} (not in the work store yet)`,
	);
	if (stage) lines.push(`Stage: ${stage.stage} (${stage.role} seat)`);
	const block = (label: string, text: unknown, max: number) => {
		if (typeof text !== "string" || !text.trim()) return;
		lines.push(`${label}:`);
		lines.push(...text.trim().split("\n").slice(0, max));
	};
	block("Ask", t?.ask, 8);
	block("Spec", t?.spec, 20);
	return [...lines.slice(0, MAX_LINES - 1), QUESTION].join("\n");
}

export function refocus(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		console.log(refocusText(db, task));
		return 0;
	} finally {
		db.close();
	}
}

/** The seat's own session id: the one evf chose at launch, or the one Herdr detected for this pane. */
export function sessionId(): string | null {
	if (process.env.EVF_SESSION) return process.env.EVF_SESSION;
	const pane = process.env.HERDR_PANE_ID;
	if (!pane) return null;
	const r = run("herdr", ["agent", "get", pane]);
	if (r.code !== 0) return null;
	try {
		const value = (JSON.parse(r.stdout) as { result?: { agent?: { agent_session?: { value?: unknown } } } }).result?.agent
			?.agent_session?.value;
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

export function session(_root: string): number {
	const id = sessionId();
	if (!id) fail("No Claude Code session id here: EVF_SESSION is unset and this is not a Herdr pane with a detected agent.");
	console.log(id);
	return 0;
}

function readHookInput(): HookInput {
	try {
		const text = readFileSync(0, "utf8");
		return text.trim() ? (JSON.parse(text) as HookInput) : {};
	} catch {
		return {};
	}
}

/** The real path of `path`, resolving the longest existing prefix so a file that does not exist yet still compares. */
function realPath(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	return parent === path ? path : resolve(realPath(parent), basename(path));
}
const inside = (path: string, dir: string) => {
	const p = realPath(path),
		d = realPath(dir);
	return p === d || p.startsWith(d + sep);
};

function record(db: DatabaseSync, taskId: number, runId: number, type: string, payload: Record<string, unknown>): void {
	db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)").run(
		taskId,
		runId,
		new Date().toISOString(),
		type,
		JSON.stringify(payload),
	);
}

function seatRun(db: DatabaseSync, runId: number): { id: number; task_id: number; session_id: string | null; ref: string; role: string; status: string } | null {
	return (
		(db
			.prepare(
				"SELECT r.id, r.task_id, r.session_id, r.role, r.status, t.ref FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
			)
			.get(runId) as { id: number; task_id: number; session_id: string | null; ref: string; role: string; status: string } | undefined) ?? null
	);
}

const seatRunId = (): number | null => {
	const id = Number(process.env.EVF_RUN);
	return Number.isInteger(id) && id > 0 ? id : null;
};

export function hook(root: string, event: string): number {
	if (!["session-start", "path-guard", "stop", "session-end"].includes(event))
		fail("evf hook takes session-start, path-guard, stop or session-end.");
	const input = readHookInput();
	if (event === "path-guard") return pathGuard(input);
	const runId = seatRunId();
	if (runId === null) return 0; // Not a seat: an ordinary session in the repository.
	const db = openWorkDb(root);
	try {
		const seat = seatRun(db, runId);
		if (!seat) return 0;
		if (event === "session-start") {
			const source = input.source ?? "startup";
			if (input.session_id && input.session_id !== seat.session_id)
				db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(input.session_id, runId);
			record(db, seat.task_id, runId, source === "compact" ? "compaction" : "session_start", {
				source,
				summary: `${seat.role}@${seat.ref} session ${source}`,
			});
			const chain = refocusText(db, parseTask(seat.ref));
			record(db, seat.task_id, runId, "refocus", { source, lines: chain.split("\n").length, summary: `refocus after ${source}` });
			const header = `You are the ${seat.role} seat for ${seat.ref} (run ${runId}${process.env.EVF_WORKTREE ? `, worktree ${process.env.EVF_WORKTREE}` : ""}).`;
			console.log(
				JSON.stringify({
					hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${header}\n${chain}` },
				}),
			);
			return 0;
		}
		if (event === "stop") {
			record(db, seat.task_id, runId, "stop", {
				stop_hook_active: input.stop_hook_active === true,
				summary: `${seat.role}@${seat.ref} ended a turn`,
			});
			return 0;
		}
		// session-end: a seat that exits without closing its stage is aborted, never silently passed.
		const ended = db
			.prepare("UPDATE runs SET status = 'aborted', ended_at = ? WHERE id = ? AND status = 'started'")
			.run(new Date().toISOString(), runId).changes;
		record(db, seat.task_id, runId, "session_end", {
			reason: input.reason ?? null,
			aborted: ended > 0,
			summary: `${seat.role}@${seat.ref} session ended${ended ? " before the stage closed" : ""}`,
		});
		return 0;
	} finally {
		db.close();
	}
}

/** Deny an Edit, Write or notebook edit outside the seat's worktree. Silent (allow) everywhere else. */
function pathGuard(input: HookInput): number {
	const worktree = process.env.EVF_WORKTREE;
	if (!worktree) return 0;
	const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
	if (typeof target !== "string" || !target) return 0;
	const absolute = resolve(input.cwd ?? process.cwd(), target);
	if (inside(absolute, worktree)) return 0;
	console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: `This seat edits only inside its worktree ${worktree}; ${absolute} is outside it.`,
			},
		}),
	);
	return 0;
}
