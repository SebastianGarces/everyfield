import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureTask, openWorkDb, record } from "./db.ts";
import { fail, type TaskRef } from "./lib.ts";
import { validateOverride, type HeadlessRole } from "./seats.ts";
import { fillRunUsage } from "./usage.ts";

const now = () => new Date().toISOString();

/**
 * `evf headless` (OPS-134): one `claude -p` session a coordinator starts, with a `runs` row so `evf usage` shows its
 * cost. The run has no stage in the stage machine: EVF_STAGE stays unset, and the drive ignores these roles.
 */
export function headless(
	root: string,
	task: TaskRef,
	role: HeadlessRole,
	opts: { promptFile: string; model?: string; effort?: string },
): number {
	const model = opts.model ?? "claude-opus-5-5",
		effort = opts.effort ?? "medium";
	validateOverride({ model, effort });
	const prompt = readFileSync(opts.promptFile, "utf8");
	if (!prompt.trim()) fail("The prompt file is empty.");
	const session = randomUUID();
	let db = openWorkDb(root);
	let taskId: number, runId: number;
	try {
		const t = ensureTask(db, task, "implement");
		taskId = t.id;
		runId = Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)",
				)
				.run(t.id, role, role, model, effort, t.round, session, now()).lastInsertRowid,
		);
	} finally {
		db.close();
	}
	const env: NodeJS.ProcessEnv = {
		...process.env,
		EVF_RUN: String(runId),
		EVF_ROLE: role,
		EVF_SESSION: session,
	};
	// A session started from inside a seat must not inherit that seat's stage or edit rails.
	for (const k of ["EVF_STAGE", "EVF_WORKTREE", "EVF_RUNTIME", "EVF_BLIND"]) delete env[k];
	const r = spawnSync("claude", ["-p", "--session-id", session, "--model", model, "--effort", effort], {
		env,
		input: prompt,
		stdio: ["pipe", "inherit", "inherit"],
	});
	if (r.error) console.error(`evf headless: claude did not run: ${r.error.message}`);
	const code = r.error ? 127 : (r.status ?? 1),
		status = code === 0 ? "passed" : "failed";
	db = openWorkDb(root);
	try {
		// Written whatever the session-end hook did: the hook aborts a started run, and only this exit code is the outcome.
		db.prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(status, now(), runId);
		fillRunUsage(db, runId);
		record(db, taskId, runId, "headless_end", {
			status,
			exit_code: code,
			summary: `${role}@${task.id} session ended ${status} (exit ${code})`,
		});
	} finally {
		db.close();
	}
	return code;
}
