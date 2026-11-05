import type { DatabaseSync } from "node:sqlite";
import { record } from "./db.ts";
import { notify, run } from "./lib.ts";
import { readEntries, runSplit, type Split } from "./turn-time.ts";
import { transcriptPath } from "./usage.ts";

/**
 * The long run check (OPS-134). It tells a seat at 60 min and the coordinator at 120 min where the run's time went. It
 * only informs: nothing here closes a run, closes a pane, changes a task or escalates. The events table holds the
 * once-only rule, so a new drive process does not repeat a nudge or a notice.
 */

const MINUTE = 60_000,
	NUDGE_AT = 60 * MINUTE,
	NOTICE_AT = 120 * MINUTE,
	RUN_TIMEOUT_MS = 10_000;

type LongRunSeat = { taskId: number; ref: string; runId: number; agent: string; worktree: string };

const minutes = (ms: number) => Math.round(ms / MINUTE);
function splitText(s: Split, elapsed: number): string {
	const part = (label: string, ms: number) => `${label} ${minutes(ms)} min (${Math.round((ms / elapsed) * 100)}%)`;
	return [part("model", s.modelMs), part("tool", s.toolMs), part("check", s.checkMs), part("wait", s.waitMs)].join(
		", ",
	);
}

/** The run's split so far, or null when its transcript is missing, unreadable or holds no entry. */
function readSplit(session: string | null, start: number, at: number): Split | null {
	try {
		const path = session ? transcriptPath(session) : null,
			entries = path ? readEntries(path) : [];
		return entries.length ? runSplit(entries, start, at) : null;
	} catch {
		return null;
	}
}

/** Whether the worktree HEAD's committer time is over 60 min old. Unknown counts as no. */
function noRecentCommit(worktree: string, at: number): boolean {
	const r = run("git", ["-C", worktree, "log", "-1", "--format=%ct"], { timeoutMs: RUN_TIMEOUT_MS });
	const seconds = Number(r.stdout.trim());
	return r.code === 0 && at - seconds * 1000 > NUDGE_AT;
}

/**
 * The check for one watched run. Call the result on each poll. `isWorking` asks Herdr for the seat's state, and only a
 * working seat is nudged. It reads the transcript at most once a minute, not before minute 60 and not after both events
 * exist.
 */
export function longRunCheck(
	db: DatabaseSync,
	seat: LongRunSeat,
	clock: () => number,
	isWorking: () => boolean,
): () => void {
	const { taskId, ref, runId, agent } = seat;
	const has = (type: string) => !!db.prepare("SELECT 1 FROM events WHERE run_id = ? AND type = ?").get(runId, type);
	let lastRead = -Infinity;
	return () => {
		const at = clock();
		if (at - lastRead < MINUTE) return;
		const row = db.prepare("SELECT started_at, session_id FROM runs WHERE id = ?").get(runId) as {
			started_at: string;
			session_id: string | null;
		};
		const start = Date.parse(row.started_at),
			elapsed = at - start;
		if (elapsed < NUDGE_AT) return;
		const wantsNotice = elapsed >= NOTICE_AT && !has("long_run_notice"),
			wantsNudge = !has("long_run_nudge");
		if (!wantsNotice && !wantsNudge) return;
		lastRead = at;
		const split = readSplit(row.session_id, start, at),
			elapsedMin = minutes(elapsed),
			text = split ? splitText(split, elapsed) : "the split is not available (no readable transcript)";
		if (wantsNotice) {
			const body = `${agent} is open at ${elapsedMin} min: ${text}. It keeps working; no action is taken.`;
			notify(`${ref} long run`, body);
			record(db, taskId, runId, "long_run_notice", {
				elapsedMin,
				split,
				summary: `${ref} ${body}`,
			});
		}
		// Integer arithmetic: exactly 70% must not count as over 70%.
		if (
			!wantsNudge ||
			!split ||
			(split.checkMs + split.waitMs) * 10 <= elapsed * 7 ||
			!noRecentCommit(seat.worktree, at) ||
			!isWorking()
		)
			return;
		// No --wait, and Herdr refuses --timeout without it: the process timeout bounds the send. Herdr submits the text to
		// the working agent, and Claude Code queues it for the running turn.
		const sent = run(
			"herdr",
			[
				"agent",
				"prompt",
				agent,
				`Long run check for ${ref}: this run is open at ${elapsedMin} min with no commit in the last 60 min. Time so far: ${text}. Over 70% of it went to checks or waits. Act on this split: stop any check that repeats without new information, run a smaller check, or commit the work that is ready, and then go on.`,
			],
			{ timeoutMs: RUN_TIMEOUT_MS },
		);
		record(db, taskId, runId, "long_run_nudge", {
			elapsedMin,
			split,
			delivered: sent.code === 0,
			summary: `${agent} nudged at ${elapsedMin} min: ${text}`,
		});
	};
}
