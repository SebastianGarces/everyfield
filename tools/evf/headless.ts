import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ensureTask, openWorkDb } from "./db.ts";
import type { TaskRef } from "./lib.ts";
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
	const prompt = readFileSync(opts.promptFile, "utf8"),
		session = randomUUID(),
		db = openWorkDb(root);
	try {
		const t = ensureTask(db, task, "implement");
		const runId = db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, model, effort, round, session_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)",
			)
			.run(t.id, role, role, model, effort, t.round, session, now()).lastInsertRowid;
		const env: NodeJS.ProcessEnv = { ...process.env, EVF_RUN: String(runId), EVF_ROLE: role, EVF_SESSION: session };
		// A session started from inside a seat must not inherit that seat's stage or edit rails.
		for (const k of ["EVF_STAGE", "EVF_WORKTREE", "EVF_RUNTIME", "EVF_BLIND"]) delete env[k];
		const r = spawnSync("claude", ["-p", "--session-id", session, "--model", model, "--effort", effort], {
			env,
			input: prompt,
			stdio: ["pipe", "inherit", "inherit"],
		});
		if (r.error) console.error(`evf headless: claude did not run: ${r.error.message}`);
		const code = r.error ? 127 : (r.status ?? 1);
		// Written whatever the session-end hook did: the hook aborts a started run, and only this exit code is the outcome.
		db.prepare("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(
			code === 0 ? "passed" : "failed",
			now(),
			runId,
		);
		fillRunUsage(db, Number(runId));
		return code;
	} finally {
		db.close();
	}
}
