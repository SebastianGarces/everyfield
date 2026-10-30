import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { missionFor, openWorkDb } from "./db.ts";
import { fail, parseTask, run, type TaskRef } from "./lib.ts";
import { closeRunPane } from "./panes.ts";
import { doneCriteria, sectionItems, specSections } from "./spec.ts";

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
/**
 * Claude Code (2.1.312) cuts a hook's additionalContext at 8,000 UTF-16 code units and 200 lines, without telling the
 * seat. The session-start context stays under both, with room to spare, so evf decides what is cut and says so.
 */
export const CONTEXT_ROOM = { units: 7600, lines: 180 };

/** The task's open row; with `any`, the latest row in any status. */
const taskRow = (db: DatabaseSync, task: TaskRef, any = false) =>
	db
		.prepare(
			`SELECT id, title, ask, spec, spec_hash, status, round, goal_id FROM tasks WHERE ref = ?${any ? "" : " AND status NOT IN ('merged', 'abandoned', 'done')"} ORDER BY id DESC LIMIT 1`,
		)
		.get(task.id) as Row | undefined;

type Block = { label: string; lines: string[]; priority: number; essential: boolean };
const size = (lines: string[]) => ({ units: lines.reduce((n, l) => n + l.length + 1, 0), lines: lines.length });
const clip = (line: string, max: number) => (line.length > max ? `${line.slice(0, max - 1)}…` : line);

/**
 * The ask and spec as blocks in reading order. The Done and Non-goals sections are essential: they always appear,
 * whole when they fit. The Goal comes next, then the ask, then the other spec sections.
 */
function blocks(ask: unknown, spec: unknown): Block[] {
	const out: Block[] = [];
	if (typeof ask === "string" && ask.trim())
		out.push({ label: "the ask", lines: ["Ask:", ...ask.trim().split("\n")], priority: 2, essential: false });
	if (typeof spec === "string" && spec.trim()) {
		out.push({ label: "", lines: ["Spec:"], priority: 0, essential: true });
		for (const s of specSections(spec.trim())) {
			const essential = s.kind === "done" || s.kind === "non-goals";
			const label = `spec section "${s.title || s.lines[0]!.slice(0, 40)}"`;
			out.push({ label, lines: s.lines, priority: essential ? 0 : s.kind === "goal" ? 1 : 3, essential });
		}
	}
	return out;
}

/**
 * Fit the blocks into `room`. The essential blocks go in whole; when they do not fit, each item becomes one line and
 * every item is cut to the longest length that fits. The other blocks go in whole, by priority, or not at all. Returns
 * the lines to print per block and one note per cut.
 */
function fit(all: Block[], room: { units: number; lines: number }): { shown: Map<Block, string[]>; cuts: string[] } {
	const shown = new Map<Block, string[]>(),
		cuts: string[] = [];
	const fits = (lines: string[]) => {
		const used = size([...[...shown.values()].flat(), ...lines]);
		return used.units <= room.units && used.lines <= room.lines;
	};
	const essential = all.filter((b) => b.essential);
	if (fits(essential.flatMap((b) => b.lines))) for (const b of essential) shown.set(b, b.lines);
	else {
		const items = essential.map((b) => sectionItems(b.lines));
		let max = Math.max(...items.flat().map((l) => l.length));
		while (max > 80 && !fits(items.flat().map((l) => clip(l, max)))) max = Math.floor(max * 0.9);
		essential.forEach((b, i) => {
			const lines = items[i]!.map((l) => clip(l, max));
			while (lines.length > 1 && !fits(lines)) lines.pop(); // Only when even 80 characters an item is too much.
			shown.set(b, lines);
			const cut = items[i]!.slice(0, lines.length).filter((l) => l.length > max).length,
				left = items[i]!.length - lines.length;
			if (cut || left)
				cuts.push(
					`${b.label}: ${cut} of ${items[i]!.length} items cut to ${max} characters${left ? `, the last ${left} items left out` : ""}`,
				);
		});
	}
	for (const b of all.filter((b) => !b.essential).sort((x, y) => x.priority - y.priority)) {
		if (fits(b.lines)) shown.set(b, b.lines);
		else cuts.push(`${b.label} (${b.lines.length} lines)`);
	}
	return { shown, cuts };
}

/**
 * The goal chain a seat reads at session start and after a compaction: project, mission, task, stage, the ask, the
 * spec and the proof rule. `header` is printed first and counts against Claude Code's limit.
 */
export function refocusText(db: DatabaseSync, task: TaskRef, header?: string): string {
	const t = taskRow(db, task);
	const project = db.prepare("SELECT body FROM goals WHERE key = 'project'").get() as Row | undefined;
	const mission = (
		t?.goal_id ? db.prepare("SELECT title FROM goals WHERE id = ?").get(t.goal_id as number) : missionFor(db, task.wp)
	) as Row | undefined;
	const stage = t
		? (db
				.prepare("SELECT stage, role FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
				.get(t.id as number) as Row | undefined)
		: undefined;
	const lines = [`Goal chain for ${task.id}`, `Project: ${project?.body ?? "(not synced yet: run evf goals sync)"}`];
	if (mission) lines.push(`Mission: ${mission.title}`);
	lines.push(
		t
			? `Task: ${task.id}${t.title && t.title !== task.id ? ` ${t.title}` : ""} (${t.status}, round ${t.round} of 3)`
			: `Task: ${task.id} (not in the work store yet)`,
	);
	if (stage) lines.push(`Stage: ${stage.stage} (${stage.role} seat)`);
	const head = [...(header ? [header] : []), ...lines];
	const criteria = doneCriteria(typeof t?.spec === "string" ? t.spec : null);
	const rule =
		typeof t?.spec === "string" && t.spec.trim()
			? [
					`Proof rule: a verify closes passed only when each of the ${criteria.length} Done criteria (${criteria.join(", ") || "none found: the spec has no numbered Done list evf can read"}) has a met or n/a proof at the head. bin/evf proof show ${task.id} lists the proofs.`,
				]
			: [];
	const all = blocks(t?.ask, t?.spec);
	const show = `bin/evf task spec ${task.id} --show`;
	// The closing lines depend on what was cut; reserve room for them and widen the reserve until the whole fits.
	for (let reserve = 400; ; reserve += 400) {
		const fixed = size([...head, ...rule, QUESTION]);
		const { shown, cuts } = fit(all, {
			units: CONTEXT_ROOM.units - fixed.units - reserve,
			lines: CONTEXT_ROOM.lines - fixed.lines - 1,
		});
		// A cut is announced first, before the text it shortens; a whole context names the command at its end.
		const body = all.flatMap((b) => shown.get(b) ?? []);
		const out = cuts.length
			? [
					...head,
					`SHORTENED to fit Claude Code's 8,000-character hook limit. Not shown here: ${cuts.join("; ")}. Run ${show} and read the full ask and spec before you build or judge.`,
					...body,
					...rule,
					QUESTION,
				]
			: [...head, ...body, ...rule, `Full ask and spec: ${show}.`, QUESTION];
		const s = size(out);
		if ((s.units <= CONTEXT_ROOM.units && s.lines <= CONTEXT_ROOM.lines) || reserve > CONTEXT_ROOM.units)
			return out.join("\n");
	}
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

/** `evf task spec <task> --show`: the stored ask and spec in full, the text a seat's session context may shorten. */
export function showSpec(root: string, task: TaskRef): number {
	const db = openWorkDb(root);
	try {
		const t = taskRow(db, task) ?? taskRow(db, task, true);
		if (!t) fail(`${task.id} is not in the work store.`);
		if (typeof t.spec !== "string" || !t.spec.trim()) fail(`${task.id} has no stored spec yet.`);
		const criteria = doneCriteria(t.spec);
		console.log(
			[
				`${task.id} (${t.status}), spec ${String(t.spec_hash ?? "").slice(0, 12)}, ${criteria.length} Done criteria: ${criteria.join(", ")}`,
				"",
				"Ask:",
				typeof t.ask === "string" && t.ask.trim() ? t.ask.trim() : "(no ask stored)",
				"",
				"Spec:",
				t.spec.trim(),
			].join("\n"),
		);
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
		const value = (JSON.parse(r.stdout) as { result?: { agent?: { agent_session?: { value?: unknown } } } }).result
			?.agent?.agent_session?.value;
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

export function session(): number {
	const id = sessionId();
	if (!id)
		fail("No Claude Code session id here: EVF_SESSION is unset and this is not a Herdr pane with a detected agent.");
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

/**
 * The real path of `path`: symlinks resolved, including a dangling one (its target is where a write would land), and
 * the longest existing prefix resolved so a file that does not exist yet still compares.
 */
function realPath(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	const parent = dirname(path);
	if (parent === path) return path;
	const here = resolve(realPath(parent), basename(path));
	try {
		if (lstatSync(here).isSymbolicLink()) return realPath(resolve(dirname(here), readlinkSync(here)));
	} catch {
		// Not a link: a path that does not exist yet.
	}
	return here;
}
/** Claude Code expands a leading ~ in tool paths; the guard must see the same file. */
const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);
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

type SeatRun = { id: number; task_id: number; session_id: string | null; ref: string; role: string; status: string };
function seatRun(db: DatabaseSync, runId: number): SeatRun | null {
	return (
		(db
			.prepare(
				"SELECT r.id, r.task_id, r.session_id, r.role, r.status, t.ref FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
			)
			.get(runId) as SeatRun | undefined) ?? null
	);
}

/** Claude Code ends a session on /clear and an in-app /resume too; the seat keeps working in the same pane. */
const SEAT_CONTINUES = new Set(["clear", "resume"]);

const seatRunId = (): number | null => {
	const id = Number(process.env.EVF_RUN);
	return Number.isInteger(id) && id > 0 ? id : null;
};

export function hook(root: string, event: string): number {
	if (!["session-start", "path-guard", "read-guard", "stop", "session-end"].includes(event))
		fail("evf hook takes session-start, path-guard, read-guard, stop or session-end.");
	const input = readHookInput();
	if (event === "path-guard") return pathGuard(input);
	if (event === "read-guard") return readGuard(input);
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
			const header = `You are the ${seat.role} seat for ${seat.ref} (run ${runId}${process.env.EVF_WORKTREE ? `, worktree ${process.env.EVF_WORKTREE}` : ""}).`;
			const context = refocusText(db, parseTask(seat.ref), header);
			record(db, seat.task_id, runId, "refocus", {
				source,
				lines: context.split("\n").length,
				summary: `refocus after ${source}`,
			});
			console.log(
				JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
			);
			return 0;
		}
		if (event === "stop") {
			record(db, seat.task_id, runId, "stop", {
				stop_hook_active: input.stop_hook_active === true,
				summary: `${seat.role}@${seat.ref} ended a turn`,
			});
			// A seat does not end its turn with its stage open (Claude Code caps these continuations itself).
			if (seat.status === "started" && input.stop_hook_active !== true && process.env.EVF_STAGE)
				console.log(
					JSON.stringify({
						decision: "block",
						reason: `Your ${seat.role} stage for ${seat.ref} is still open. Close it now: bin/evf run done ${runId} --status passed|failed --summary-file <path>. If you are blocked, say why in the summary and use failed.`,
					}),
				);
			return 0;
		}
		// session-end: a seat that exits without closing its stage is aborted, never silently passed. A clear or
		// resume is a new session in the same seat, so the run stays open and the next SessionStart records its id.
		const reason = input.reason ?? null;
		const ended = SEAT_CONTINUES.has(reason ?? "")
			? 0
			: db
					.prepare("UPDATE runs SET status = 'aborted', ended_at = ? WHERE id = ? AND status = 'started'")
					.run(new Date().toISOString(), runId).changes;
		record(db, seat.task_id, runId, "session_end", {
			reason,
			aborted: ended > 0,
			summary: `${seat.role}@${seat.ref} session ended${ended ? " before the stage closed" : ""}`,
		});
		if (ended) closeRunPane(db, runId);
		return 0;
	} finally {
		db.close();
	}
}

const deny = (reason: string) =>
	console.log(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
		}),
	);

/** Deny an Edit, Write or notebook edit outside the seat's worktree or its runtime dir. Silent (allow) everywhere else. */
function pathGuard(input: HookInput): number {
	const worktree = process.env.EVF_WORKTREE;
	if (!worktree) return 0;
	const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
	if (typeof target !== "string" || !target) return 0;
	const absolute = resolve(input.cwd ?? process.cwd(), expandHome(target));
	if (inside(absolute, worktree)) return 0;
	if (process.env.EVF_RUNTIME && inside(absolute, process.env.EVF_RUNTIME)) return 0;
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

/**
 * A blind seat (an idea seat of prototype mode, EVF_BLIND=1) reads only its own worktree: Read, Grep and Glob
 * outside it are denied, so one idea cannot see another. Other seats read the whole repository.
 */
function readGuard(input: HookInput): number {
	const worktree = process.env.EVF_WORKTREE;
	if (process.env.EVF_BLIND !== "1" || !worktree) return 0;
	const target = input.tool_input?.file_path ?? input.tool_input?.path;
	const cwd = input.cwd ?? process.cwd();
	const absolute = resolve(cwd, typeof target === "string" && target ? expandHome(target) : ".");
	if (!inside(absolute, worktree)) {
		deny(`This idea seat reads only its own worktree ${worktree}; ${absolute} is outside it.`);
		return 0;
	}
	// A Glob pattern can leave the search path on its own (absolute, ~ or ..): judge its fixed prefix too. Grep's
	// pattern is a regex, not a path, and Grep's location is the path checked above.
	const pattern = input.tool_name === "Glob" ? input.tool_input?.pattern : undefined;
	if (typeof pattern === "string" && (/^[~/]/.test(pattern) || /(^|\/)\.\.(\/|$)/.test(pattern))) {
		const prefix = expandHome(pattern).split(/[*?[{]/)[0]!;
		const where = resolve(absolute, prefix);
		if (!inside(where, worktree))
			deny(`This idea seat reads only its own worktree ${worktree}; ${where} is outside it.`);
	}
	return 0;
}
