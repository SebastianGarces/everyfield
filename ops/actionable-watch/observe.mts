// Pure core of the actionable-change watcher: parse evf status and main CI runs, reduce them to a
// canonical snapshot, derive actionable events and advance the dedup state. No I/O here.

/**
 * Stuck, defined conservatively. evf's loop writes `heartbeat` on every tick, and `evf status`
 * reports its own clock as `now`. If `now - heartbeat` reaches 15 minutes the loop has not ticked
 * for many tick periods: the drive is stuck no matter what any seat is doing. A seat is stuck only
 * when evf itself says its pane is not `live` while the task still reads running, on two polls in a
 * row (about 3 minutes at a 90 s cadence), so one missed probe cannot fire it. Runtime length and
 * `activity_at` are never inputs: a long, live run is healthy.
 */
export const HEARTBEAT_STALE_MS = 15 * 60_000;
export const DEAD_SEAT_POLLS = 2; // enforced by intersecting the previous and current snapshot
export const MAX_PENDING = 50;

const ERROR_VALUES = new Set(["failed", "error", "errored", "stuck", "crashed"]);
const WAITING_PHASES = new Set(["waiting", "queued", "ready"]);
// A wait that names an owner gate, a decision, a review, a hold or another task is not slot-bound.
const GATED_WAIT = /owner|decision|decide|approv|ruling|answer|review|hold|blocked|waits for T-\d+/i;
const CI_FAILURES = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

type RawTask = { id: number; label: string; phase: string; lifecycle: string; held: boolean; wait: string | null };
type RawAgent = { task: number; run: number | null; step: string | null; state: string };
type RawSeat = { task: number; run: number; live: boolean };
export type Status = {
	now: number;
	heartbeat: number | null;
	tickError: boolean;
	seatsUsed: number;
	seatsMax: number;
	tasks: RawTask[];
	agents: RawAgent[];
	seats: RawSeat[];
	decisions: { id: string; task: number | null }[];
};
export type Ci = { sha: string; conclusion: "failure" | "success" | "pending" };

export type TaskSnap = {
	id: number;
	label: string;
	phase: string;
	lifecycle: string;
	step: string | null;
	run: number | null;
	error: string | null;
	eligibleWaiting: boolean;
};
export type Snapshot = {
	tasks: TaskSnap[];
	deadSeats: { task: number; run: number }[];
	heartbeatStale: boolean;
	tickError: boolean;
	capacityFree: boolean;
	decisions: { id: string; task: number | null }[];
	ci: Ci | null;
};

export type EventKind =
	| "seat-finished"
	| "task-error"
	| "tick-error"
	| "stuck-heartbeat"
	| "stuck-seat"
	| "slot-available"
	| "ci-failed"
	| "decision-open";
export type WatchEvent = {
	key: string;
	kind: EventKind;
	/** level events hold while their condition holds; edge events are one-off transitions */
	level: boolean;
	task?: number;
	label?: string;
	step?: string | null;
	run?: number;
	decision?: string;
	sha?: string;
	conclusion?: string;
};
export type State = { version: 1; snapshot: Snapshot; sent: string[]; pending: WatchEvent[] };

// ---- boundary parsing -------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
/** Identifiers pass whole; anything that is not a short slug (prose, URLs, emails) becomes "". */
export const token = (v: string, max = 64): string => (v.length <= max && /^[A-Za-z0-9._-]+$/.test(v) ? v : "");

function list<T>(v: unknown, item: (x: Record<string, unknown>) => T | null): T[] | null {
	if (!Array.isArray(v)) return null;
	const out: T[] = [];
	for (const x of v) {
		const parsed = isObj(x) ? item(x) : null;
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}

function decisionId(v: unknown): string | null {
	if (isInt(v)) return `D-${v}`;
	if (isStr(v) && /^[A-Za-z0-9-]{1,32}$/.test(v)) return v;
	return null;
}

export function parseStatus(raw: unknown): Result<Status> {
	const bad = { ok: false as const, code: "evf_bad_shape" };
	if (!isObj(raw) || !isInt(raw.now) || !(raw.heartbeat === null || isInt(raw.heartbeat))) return bad;
	const seatsBudget = isObj(raw.budget) && isObj(raw.budget.seats) ? raw.budget.seats : null;
	if (!seatsBudget || !isInt(seatsBudget.used) || !isInt(seatsBudget.max)) return bad;
	const tasks = list(raw.tasks, (t) =>
		isInt(t.id) && isStr(t.phase) && isStr(t.lifecycle) && (t.wait === null || isStr(t.wait))
			? {
					id: t.id,
					label: isStr(t.label) ? token(t.label) : "",
					phase: token(t.phase, 32),
					lifecycle: token(t.lifecycle, 32),
					held: (t.hold ?? null) !== null || (t.hold_by ?? null) !== null || t.phase === "held",
					wait: t.wait,
				}
			: null,
	);
	const agents = list(raw.agents, (a) =>
		isInt(a.task) && isStr(a.state) && (a.run === null || isInt(a.run)) && (a.step === null || isStr(a.step))
			? { task: a.task, run: a.run, step: a.step === null ? null : token(a.step, 32), state: token(a.state, 32) }
			: null,
	);
	const seats = list(raw.seats, (s) =>
		isInt(s.task) && isInt(s.run) && typeof s.live === "boolean" ? { task: s.task, run: s.run, live: s.live } : null,
	);
	const decisions = list(raw.decisions, (d) => {
		const id = decisionId(d.id);
		return id && (d.task === undefined || d.task === null || isInt(d.task)) ? { id, task: isInt(d.task) ? d.task : null } : null;
	});
	if (!tasks || !agents || !seats || !decisions) return bad;
	return {
		ok: true,
		value: {
			now: raw.now,
			heartbeat: raw.heartbeat,
			tickError: raw.tick_error !== null && raw.tick_error !== undefined,
			seatsUsed: seatsBudget.used,
			seatsMax: seatsBudget.max,
			tasks,
			agents,
			seats,
			decisions,
		},
	};
}

/** `gh run list --json headSha,status,conclusion,createdAt` for the CI push workflow on main. */
export function parseCi(raw: unknown): Result<Ci | null> {
	const runs = list(raw, (r) =>
		isStr(r.headSha) && /^[0-9a-f]{7,40}$/.test(r.headSha) && isStr(r.status) && isStr(r.createdAt) && isStr(r.conclusion ?? "")
			? { sha: r.headSha, status: r.status, conclusion: (r.conclusion ?? "") as string, at: r.createdAt }
			: null,
	);
	if (!runs) return { ok: false, code: "gh_bad_shape" };
	if (runs.length === 0) return { ok: true, value: null };
	const sha = [...runs].sort((a, b) => b.at.localeCompare(a.at))[0].sha;
	const forSha = runs.filter((r) => r.sha === sha);
	const conclusion = forSha.some((r) => CI_FAILURES.has(r.conclusion))
		? "failure"
		: forSha.every((r) => r.status === "completed")
			? "success"
			: "pending";
	return { ok: true, value: { sha, conclusion } };
}

// ---- canonical snapshot -----------------------------------------------------------------------

/** Keeps actionable identity only. Volatile fields (now, heartbeat, machine, since, activity, doing,
 * cost, tokens, audit, wait prose) never reach the snapshot; heartbeat survives only as a boolean. */
export function normalize(status: Status, ci: Ci | null): Snapshot {
	const agentByTask = new Map(status.agents.map((a) => [a.task, a]));
	const decidedTasks = new Set(status.decisions.map((d) => d.task));
	const tasks = status.tasks
		.map((t): TaskSnap => {
			const a = agentByTask.get(t.id);
			const error = [t.phase, a?.state ?? "", t.lifecycle].find((v) => ERROR_VALUES.has(v)) ?? null;
			return {
				id: t.id,
				label: t.label,
				phase: t.phase,
				lifecycle: t.lifecycle,
				step: a?.step ?? null,
				run: a?.run ?? null,
				error,
				eligibleWaiting: isEligibleWaiting(t, decidedTasks.has(t.id)),
			};
		})
		.sort((a, b) => a.id - b.id);
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const deadSeats = status.seats
		.filter((s) => !s.live && byId.get(s.task)?.phase === "running" && byId.get(s.task)?.run === s.run)
		.map((s) => ({ task: s.task, run: s.run }))
		.sort((a, b) => a.run - b.run);
	return {
		tasks,
		deadSeats,
		heartbeatStale: status.heartbeat !== null && status.now - status.heartbeat >= HEARTBEAT_STALE_MS,
		tickError: status.tickError,
		capacityFree: status.seatsUsed < status.seatsMax,
		decisions: [...status.decisions].sort((a, b) => a.id.localeCompare(b.id)),
		ci,
	};
}

/** Released, eligible work only. Held, owner-gated, decision-pending, dependency-blocked and terminal
 * tasks never count. This predicate informs a notice; nothing in the watcher starts a task. */
export function isEligibleWaiting(t: RawTask, hasOpenDecision: boolean): boolean {
	return (
		t.lifecycle === "open" &&
		!t.held &&
		WAITING_PHASES.has(t.phase) &&
		!hasOpenDecision &&
		!(t.wait !== null && GATED_WAIT.test(t.wait))
	);
}

// ---- events -----------------------------------------------------------------------------------

export function deriveEvents(prev: Snapshot | null, cur: Snapshot): WatchEvent[] {
	const events: WatchEvent[] = [];
	const curById = new Map(cur.tasks.map((t) => [t.id, t]));
	const prevById = new Map((prev?.tasks ?? []).map((t) => [t.id, t]));

	for (const p of prev?.tasks ?? []) {
		if (p.phase !== "running" || p.run === null) continue;
		const c = curById.get(p.id);
		if (c && c.phase === "running" && c.run === p.run && c.step === p.step) continue;
		if (c?.error) continue; // a run that ends in error is reported once, as task-error
		events.push({ key: `seat-finished:${p.id}:${p.run}:${p.step}`, kind: "seat-finished", level: false, task: p.id, label: p.label, step: p.step, run: p.run });
	}
	for (const c of cur.tasks) {
		if (c.error) events.push({ key: `task-error:${c.id}:${c.error}`, kind: "task-error", level: true, task: c.id, label: c.label, step: c.step });
	}
	if (cur.tickError) events.push({ key: "tick-error", kind: "tick-error", level: true });
	if (cur.heartbeatStale) events.push({ key: "stuck-heartbeat", kind: "stuck-heartbeat", level: true });
	const prevDead = new Set((prev?.deadSeats ?? []).map((s) => s.run));
	for (const s of cur.deadSeats) {
		if (!prevDead.has(s.run)) continue;
		const t = curById.get(s.task);
		events.push({ key: `stuck-seat:${s.run}`, kind: "stuck-seat", level: true, task: s.task, label: t?.label, step: t?.step, run: s.run });
	}
	if (cur.capacityFree) {
		for (const c of cur.tasks) {
			if (c.eligibleWaiting && prevById.get(c.id)?.eligibleWaiting) {
				events.push({ key: `slot-available:${c.id}`, kind: "slot-available", level: true, task: c.id, label: c.label });
			}
		}
	}
	if (cur.ci?.conclusion === "failure") {
		events.push({ key: `ci-failed:${cur.ci.sha}`, kind: "ci-failed", level: true, sha: cur.ci.sha, conclusion: "failure" });
	}
	for (const d of cur.decisions) {
		events.push({ key: `decision:${d.id}`, kind: "decision-open", level: true, decision: d.id, ...(d.task === null ? {} : { task: d.task }) });
	}
	return events;
}

/**
 * One poll's state step. No previous state (first run, missing or corrupt file) re-baselines: every
 * condition already true counts as sent, and nothing wakes. Otherwise a key wakes once; a level key
 * leaves `sent` when its condition clears, so a genuine recurrence wakes again.
 */
export function advance(state: State | null, cur: Snapshot): { next: State; due: WatchEvent[] } {
	if (!state) {
		const sent = deriveEvents(null, cur).filter((e) => e.level).map((e) => e.key);
		return { next: { version: 1, snapshot: cur, sent, pending: [] }, due: [] };
	}
	const events = deriveEvents(state.snapshot, cur);
	const active = new Set(events.filter((e) => e.level).map((e) => e.key));
	const sent = state.sent.filter((k) => active.has(k));
	const pending = state.pending.filter((e) => !e.level || active.has(e.key));
	const known = new Set([...sent, ...pending.map((e) => e.key)]);
	for (const e of events) if (!known.has(e.key)) pending.push(e);
	const capped = pending.slice(-MAX_PENDING);
	return { next: { version: 1, snapshot: cur, sent, pending: capped }, due: capped };
}

export function markDelivered(state: State, delivered: WatchEvent[]): State {
	const keys = new Set(delivered.map((e) => e.key));
	const sent = [...new Set([...state.sent, ...delivered.filter((e) => e.level).map((e) => e.key)])];
	return { ...state, sent, pending: state.pending.filter((e) => !keys.has(e.key)) };
}

/** The wake payload: event kind and identifiers only. */
export function buildPayload(events: WatchEvent[], nowMs: number) {
	return {
		source: "everyfield-actionable-watch",
		version: 1,
		at: new Date(nowMs).toISOString(),
		events: events.map((e) => {
			const out: Record<string, string | number | null> = { kind: e.kind, key: e.key };
			for (const f of ["task", "label", "step", "run", "decision", "sha", "conclusion"] as const) {
				if (e[f] !== undefined) out[f] = e[f] as string | number | null;
			}
			return out;
		}),
	};
}

export function parseState(raw: unknown): State | null {
	if (!isObj(raw) || raw.version !== 1 || !isObj(raw.snapshot)) return null;
	const s = raw.snapshot;
	const okSnapshot =
		Array.isArray(s.tasks) &&
		s.tasks.every((t) => isObj(t) && isInt(t.id) && isStr(t.phase)) &&
		Array.isArray(s.deadSeats) &&
		Array.isArray(s.decisions) &&
		typeof s.heartbeatStale === "boolean" &&
		typeof s.tickError === "boolean" &&
		typeof s.capacityFree === "boolean" &&
		(s.ci === null || (isObj(s.ci) && isStr(s.ci.sha) && isStr(s.ci.conclusion)));
	const okSent = Array.isArray(raw.sent) && raw.sent.every(isStr);
	const okPending =
		Array.isArray(raw.pending) && raw.pending.every((e) => isObj(e) && isStr(e.key) && isStr(e.kind) && typeof e.level === "boolean");
	return okSnapshot && okSent && okPending ? (raw as State) : null;
}
