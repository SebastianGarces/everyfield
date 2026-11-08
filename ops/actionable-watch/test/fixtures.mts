// Raw `evf status --json` fixtures shaped like evf 2.0.0 output, with every volatile field present.
// `agents` follows evf's `agents_of` (crates/evf-store/src/overview.rs): each open decision first adds a
// `needs_you` row (task may be null, no `run` or `step` keys) and hides that task's own row. The real,
// redacted capture lives in status-open-decision.json.
export const NOW = 1_794_122_077_675;

export type Task = { id: number; phase?: string; lifecycle?: string; hold?: string | null; wait?: string | null; label?: string };
type Agent = { task: number; run?: number | null; step?: string | null; state?: string };
type Seat = { task: number; run: number; live?: boolean; activity_at?: number; started_at?: number };

export function rawStatus(o: {
	tasks?: Task[];
	agents?: Agent[];
	seats?: Seat[];
	decisions?: Record<string, unknown>[];
	seatsUsed?: number;
	seatsMax?: number;
	now?: number;
	heartbeat?: number | null;
	tickError?: string | null;
	noise?: string;
} = {}) {
	const now = o.now ?? NOW;
	const noise = o.noise ?? "a";
	return {
		now,
		heartbeat: o.heartbeat === undefined ? now - 500 : o.heartbeat,
		machine: { at: now - 1000, free_mem_pct: noise === "a" ? 34 : 12, load1: noise === "a" ? 5.8 : 19.1, swap_used_gb: 10.3 },
		paused: null,
		tick_error: o.tickError ?? null,
		tick_error_at: o.tickError ? now - 10 : null,
		budget: {
			cores: 12,
			max_load: 24,
			min_free_mem_pct: 15,
			previews: { max: 4, used: 0 },
			seats: { max: o.seatsMax ?? 8, used: o.seatsUsed ?? 2 },
			slots: { max: 2, used: 0 },
		},
		audit: [{ action: "spec_stored", actor: "seat:R-1", at: now - (noise === "a" ? 5 : 900), detail: `{"n":"${noise}"}`, hash: noise.repeat(64) }],
		checks: [],
		grants: [],
		recent_answers: [{ id: 20, question: `May it land? ${noise}`, answered_at: now - 99 }],
		rulings: [{ id: 45, kind: "ruling", state: "open", question: `ruling ${noise}`, task: 1 }],
		decisions: o.decisions ?? [],
		tasks: (o.tasks ?? []).map((t) => ({
			blocks: 1,
			created_at: now - 1e6,
			updated_at: now - (noise === "a" ? 10 : 20),
			hold: t.hold ?? null,
			hold_by: t.hold ? "owner" : null,
			id: t.id,
			label: t.label ?? `task-${t.id}`,
			landed_sha: null,
			lifecycle: t.lifecycle ?? "open",
			phase: t.phase ?? "running",
			pr_number: null,
			pr_url: null,
			priority: 0,
			round: 0,
			title: `Title of ${t.id} ${noise}`,
			wait: t.wait === undefined ? null : t.wait,
			workflow: "implement",
		})),
		agents: [
			...needsYou(o.decisions ?? [], now),
			...(o.agents ?? []).filter((a) => !(o.decisions ?? []).some((d) => d.task === a.task)).map((a) => ({
			hold: null,
			hold_by: null,
			label: `task-${a.task}`,
			lifecycle: "open",
			part: "Build",
			phase: "running",
			run: a.run ?? null,
			since: now - (noise === "a" ? 100 : 7000),
			state: a.state ?? "working",
			step: a.step === undefined ? "implement" : a.step,
			task: a.task,
			title: `Title ${noise}`,
			wait: `implement is running ${noise}`,
			})),
		],
		seats: (o.seats ?? []).map((s) => ({
			activity: `Bash: something ${noise}`,
			activity_at: s.activity_at ?? now - (noise === "a" ? 1000 : 3000),
			cache_read: null,
			cost: noise === "a" ? null : 1.23,
			doing: `Doing ${noise}`,
			effort: "medium",
			instance: 0,
			label: `task-${s.task}`,
			live: s.live ?? true,
			model: "claude-opus-5-5",
			pane: "wJE:p10",
			parked_on: null,
			role: "implementer",
			round: 0,
			run: s.run,
			session: noise === "a" ? "09077c38-0000" : "11111111-0000",
			started_at: s.started_at ?? now - 60_000,
			step: "implement",
			task: s.task,
			title: `Seat title ${noise}`,
			tokens_in: noise === "a" ? null : 100,
			tokens_out: noise === "a" ? null : 200,
			turn: noise === "a" ? 1 : 4,
			turn_started_at: now - 50,
		})),
	};
}

/** evf's row per open decision, one per task (the first one), shaped exactly as `agents_of` writes it. */
function needsYou(decisions: Record<string, unknown>[], now: number) {
	const seen = new Set<unknown>();
	return decisions
		.filter((d) => d.task === undefined || d.task === null || (!seen.has(d.task) && seen.add(d.task)))
		.map((d) => ({
			task: d.task ?? null,
			title: "",
			label: d.task ? `task-${d.task}` : null,
			state: "needs_you",
			decision: d.id,
			kind: d.kind ?? "question",
			open_decisions: 1,
			since: now - 5,
		}));
}

/** One running task with a live seat: the common idle-but-busy baseline. */
export const running = (o: Parameters<typeof rawStatus>[0] = {}) =>
	rawStatus({ tasks: [{ id: 1 }], agents: [{ task: 1, run: 10 }], seats: [{ task: 1, run: 10 }], ...o });

export const ciRuns = (sha: string, conclusion: string | null, status = "completed") => [
	{ headSha: sha, status, conclusion: conclusion ?? "", createdAt: "2026-11-08T07:00:00Z" },
	{ headSha: "0".repeat(40), status: "completed", conclusion: "success", createdAt: "2026-11-07T07:00:00Z" },
];
