export const HEARTBEAT_STALE_MS = 15 * 60_000;
export const DEAD_SEAT_POLLS = 2;
export const MAX_PENDING = 50;

const ERROR_VALUES = new Set(["failed", "error", "errored", "stuck", "crashed"]);
const WAITING_PHASES = new Set(["waiting", "queued", "ready"]);
const GATED_WAIT = /owner|decision|decide|approv|ruling|answer|review|hold|blocked|waits for T-\d+/i;
const CI_FAILURES = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; detail?: string };

type RawTask = { id: number; label: string; phase: string; lifecycle: string; held: boolean; wait: string | null };
type RawAgent = { task: number | null; run: number | null; step: string | null; state: string };
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
	level: boolean;
	task?: number;
	label?: string;
	step?: string | null;
	run?: number;
	decision?: string;
	sha?: string;
	conclusion?: string;
};
export type State = { version: 1; snapshot: Snapshot; sent: string[]; pending: WatchEvent[]; sends: number[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
export const token = (v: string, max = 64): string => (v.length <= max && /^[A-Za-z0-9._-]+$/.test(v) ? v : "");

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

type Fields = Record<string, (v: unknown) => boolean>;
type ListResult<T> = { ok: true; value: T[] } | { ok: false; detail: string };

function list<T>(name: string, v: unknown, fields: Fields, build: (x: Record<string, unknown>) => T): ListResult<T> {
	if (!Array.isArray(v)) return { ok: false, detail: `list=${name} fields=${name}:${typeOf(v)}` };
	const out: T[] = [];
	for (const [i, x] of v.entries()) {
		if (!isObj(x)) return { ok: false, detail: `list=${name} index=${i} fields=item:${typeOf(x)}` };
		const bad = Object.entries(fields)
			.filter(([k, check]) => !check(x[k]))
			.map(([k]) => `${k}:${typeOf(x[k])}`);
		if (bad.length) return { ok: false, detail: `list=${name} index=${i} fields=${bad.join(",")}` };
		out.push(build(x));
	}
	return { ok: true, value: out };
}

const intOrNull = (v: unknown) => v === null || isInt(v);
const strOrNull = (v: unknown) => v === null || isStr(v);
const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v);
const DECISION_ID = /^[A-Za-z0-9-]{1,32}$/;

function decisionId(v: unknown): string {
	return isInt(v) ? `D-${v}` : (v as string);
}

export function parseStatus(raw: unknown): Result<Status> {
	const bad = (detail: string) => ({ ok: false as const, code: "evf_bad_shape", detail });
	if (!isObj(raw)) return bad(`list=top fields=status:${typeOf(raw)}`);
	const seatsBudget = isObj(raw.budget) && isObj(raw.budget.seats) ? raw.budget.seats : null;
	const top = [
		...(isInt(raw.now) ? [] : [`now:${typeOf(raw.now)}`]),
		...(intOrNull(raw.heartbeat) ? [] : [`heartbeat:${typeOf(raw.heartbeat)}`]),
		...(seatsBudget && isInt(seatsBudget.used) && isInt(seatsBudget.max)
			? []
			: [`budget.seats:${typeOf(seatsBudget ?? raw.budget)}`]),
	];
	if (top.length || !seatsBudget) return bad(`list=top fields=${top.join(",")}`);
	const tasks = list("tasks", raw.tasks, { id: isInt, phase: isStr, lifecycle: isStr, wait: strOrNull }, (t) => ({
		id: t.id as number,
		label: isStr(t.label) ? token(t.label) : "",
		phase: token(t.phase as string, 32),
		lifecycle: token(t.lifecycle as string, 32),
		held: (t.hold ?? null) !== null || (t.hold_by ?? null) !== null || t.phase === "held",
		wait: t.wait as string | null,
	}));
	const agents = list(
		"agents",
		raw.agents,
		{ task: intOrNull, state: isStr, run: optional(intOrNull), step: optional(strOrNull) },
		(a): RawAgent => ({
			task: a.task as number | null,
			run: (a.run ?? null) as number | null,
			step: isStr(a.step) ? token(a.step, 32) : null,
			state: token(a.state as string, 32),
		}),
	);
	const seats = list("seats", raw.seats, { task: isInt, run: isInt, live: (v) => typeof v === "boolean" }, (s) => ({
		task: s.task as number,
		run: s.run as number,
		live: s.live as boolean,
	}));
	const decisions = list(
		"decisions",
		raw.decisions,
		{ id: (v) => isInt(v) || (isStr(v) && DECISION_ID.test(v)), task: optional(intOrNull) },
		(d) => ({ id: decisionId(d.id), task: isInt(d.task) ? d.task : null }),
	);
	if (!tasks.ok) return bad(tasks.detail);
	if (!agents.ok) return bad(agents.detail);
	if (!seats.ok) return bad(seats.detail);
	if (!decisions.ok) return bad(decisions.detail);
	return {
		ok: true,
		value: {
			now: raw.now as number,
			heartbeat: raw.heartbeat as number | null,
			tickError: raw.tick_error !== null && raw.tick_error !== undefined,
			seatsUsed: seatsBudget.used as number,
			seatsMax: seatsBudget.max as number,
			tasks: tasks.value,
			agents: agents.value,
			seats: seats.value,
			decisions: decisions.value,
		},
	};
}

export function parseCi(raw: unknown): Result<Ci | null> {
	const parsed = list(
		"runs",
		raw,
		{
			headSha: (v) => isStr(v) && /^[0-9a-f]{7,40}$/.test(v),
			status: isStr,
			createdAt: isStr,
			conclusion: (v) => v === undefined || v === null || isStr(v),
		},
		(r) => ({
			sha: r.headSha as string,
			status: r.status as string,
			conclusion: (r.conclusion ?? "") as string,
			at: r.createdAt as string,
		}),
	);
	if (!parsed.ok) return { ok: false, code: "gh_bad_shape" };
	const runs = parsed.value;
	if (runs.length === 0) return { ok: true, value: null };
	const sha = [...runs].sort((a, b) => b.at.localeCompare(a.at))[0]!.sha;
	const forSha = runs.filter((r) => r.sha === sha);
	const conclusion = forSha.some((r) => CI_FAILURES.has(r.conclusion))
		? "failure"
		: forSha.every((r) => r.status === "completed")
			? "success"
			: "pending";
	return { ok: true, value: { sha, conclusion } };
}

export function normalize(status: Status, ci: Ci | null): Snapshot {
	const agentByTask = new Map(
		status.agents.filter((a) => a.task !== null && a.state !== "needs_you").map((a) => [a.task as number, a]),
	);
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

export function isEligibleWaiting(t: RawTask, hasOpenDecision: boolean): boolean {
	return (
		t.lifecycle === "open" &&
		!t.held &&
		WAITING_PHASES.has(t.phase) &&
		!hasOpenDecision &&
		!(t.wait !== null && GATED_WAIT.test(t.wait))
	);
}

export function deriveEvents(prev: Snapshot | null, cur: Snapshot): WatchEvent[] {
	const events: WatchEvent[] = [];
	const curById = new Map(cur.tasks.map((t) => [t.id, t]));
	const prevById = new Map((prev?.tasks ?? []).map((t) => [t.id, t]));

	const decidedNow = new Set(cur.decisions.map((d) => d.task));
	for (const p of prev?.tasks ?? []) {
		if (p.phase !== "running" || p.run === null) continue;
		if (decidedNow.has(p.id)) continue;
		const c = curById.get(p.id);
		if (c && c.phase === "running" && c.run === p.run && c.step === p.step) continue;
		if (c?.error) continue;
		events.push({
			key: `seat-finished:${p.id}:${p.run}:${p.step}`,
			kind: "seat-finished",
			level: false,
			task: p.id,
			label: p.label,
			step: p.step,
			run: p.run,
		});
	}
	for (const c of cur.tasks) {
		if (c.error)
			events.push({
				key: `task-error:${c.id}:${c.error}`,
				kind: "task-error",
				level: true,
				task: c.id,
				label: c.label,
				step: c.step,
			});
	}
	if (cur.tickError) events.push({ key: "tick-error", kind: "tick-error", level: true });
	if (cur.heartbeatStale) events.push({ key: "stuck-heartbeat", kind: "stuck-heartbeat", level: true });
	const prevDead = new Set((prev?.deadSeats ?? []).map((s) => s.run));
	for (const s of cur.deadSeats) {
		if (!prevDead.has(s.run)) continue;
		const t = curById.get(s.task);
		events.push({
			key: `stuck-seat:${s.run}`,
			kind: "stuck-seat",
			level: true,
			task: s.task,
			label: t?.label,
			step: t?.step,
			run: s.run,
		});
	}
	if (cur.capacityFree) {
		for (const c of cur.tasks) {
			if (c.eligibleWaiting && prevById.get(c.id)?.eligibleWaiting) {
				events.push({ key: `slot-available:${c.id}`, kind: "slot-available", level: true, task: c.id, label: c.label });
			}
		}
	}
	if (cur.ci?.conclusion === "failure") {
		events.push({
			key: `ci-failed:${cur.ci.sha}`,
			kind: "ci-failed",
			level: true,
			sha: cur.ci.sha,
			conclusion: "failure",
		});
	}
	for (const d of cur.decisions) {
		events.push({
			key: `decision:${d.id}`,
			kind: "decision-open",
			level: true,
			decision: d.id,
			...(d.task === null ? {} : { task: d.task }),
		});
	}
	return events;
}

export function advance(state: State | null, cur: Snapshot): { next: State; due: WatchEvent[] } {
	if (!state) {
		const sent = deriveEvents(null, cur)
			.filter((e) => e.level)
			.map((e) => e.key);
		return { next: { version: 1, snapshot: cur, sent, pending: [], sends: [] }, due: [] };
	}
	const events = deriveEvents(state.snapshot, cur);
	const active = new Set(events.filter((e) => e.level).map((e) => e.key));
	const sent = state.sent.filter((k) => active.has(k));
	const pending = state.pending.filter((e) => !e.level || active.has(e.key));
	const known = new Set([...sent, ...pending.map((e) => e.key)]);
	for (const e of events) if (!known.has(e.key)) pending.push(e);
	const capped = pending.slice(-MAX_PENDING);
	return { next: { version: 1, snapshot: cur, sent, pending: capped, sends: state.sends }, due: capped };
}

export function markDelivered(state: State, delivered: WatchEvent[]): State {
	const keys = new Set(delivered.map((e) => e.key));
	const sent = [...new Set([...state.sent, ...delivered.filter((e) => e.level).map((e) => e.key)])];
	return { ...state, sent, pending: state.pending.filter((e) => !keys.has(e.key)) };
}

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

export function buildTestPayload(nowMs: number) {
	return {
		source: "everyfield-actionable-watch",
		version: 1,
		kind: "test",
		at: new Date(nowMs).toISOString(),
		events: [],
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
		Array.isArray(raw.pending) &&
		raw.pending.every((e) => isObj(e) && isStr(e.key) && isStr(e.kind) && typeof e.level === "boolean");
	const okSends = raw.sends === undefined || (Array.isArray(raw.sends) && raw.sends.every(isInt));
	return okSnapshot && okSent && okPending && okSends ? ({ ...raw, sends: raw.sends ?? [] } as State) : null;
}
