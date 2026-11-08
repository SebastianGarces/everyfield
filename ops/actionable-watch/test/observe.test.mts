import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	advance, buildPayload, HEARTBEAT_STALE_MS, markDelivered, normalize, parseCi, parseState, parseStatus,
	type Ci, type Snapshot, type State,
} from "../observe.mts";
import { ciRuns, NOW, rawStatus, running, type Task } from "./fixtures.mts";

const snap = (raw: unknown, ci: Ci | null = null): Snapshot => {
	const s = parseStatus(raw);
	assert.ok(s.ok, "fixture parses");
	return normalize(s.value, ci);
};
const baseline = (raw: unknown, ci: Ci | null = null): State => advance(null, snap(raw, ci)).next;
/** Events due when going from `prev` to `cur`, with all of prev's conditions already sent. */
const due = (prev: unknown, cur: unknown, ciPrev: Ci | null = null, ciCur: Ci | null = ciPrev) =>
	advance(baseline(prev, ciPrev), snap(cur, ciCur)).due.map((e) => e.key);

describe("normalisation", () => {
	test("raw statuses that differ only in volatile fields give identical snapshots", () => {
		const a = running({ noise: "a", now: NOW, heartbeat: NOW - 100 });
		const b = running({ noise: "b", now: NOW + 90_000, heartbeat: NOW + 89_000 });
		assert.notDeepEqual(a, b);
		assert.deepEqual(snap(a), snap(b));
	});

	test("the snapshot keeps actionable identity only", () => {
		const s = snap(running({ decisions: [{ id: 7, task: 1, question: "secret ask" }] }), { sha: "a".repeat(40), conclusion: "success" });
		assert.deepEqual(s, {
			tasks: [{ id: 1, label: "task-1", phase: "running", lifecycle: "open", step: "implement", run: 10, error: null, eligibleWaiting: false }],
			deadSeats: [],
			heartbeatStale: false,
			tickError: false,
			capacityFree: true,
			decisions: [{ id: "D-7", task: 1 }],
			ci: { sha: "a".repeat(40), conclusion: "success" },
		});
	});

	test("unexpected shapes are refused, not guessed", () => {
		for (const raw of [null, [], "x", {}, { ...running(), tasks: "no" }, { ...running(), budget: {} }, { ...running(), seats: [{ task: 1 }] }, { ...running(), now: "soon" }, { ...running(), decisions: [{ id: "has space" }] }]) {
			assert.deepEqual(parseStatus(raw), { ok: false, code: "evf_bad_shape" });
		}
	});

	test("main CI reads the newest head sha", () => {
		const sha = "b".repeat(40);
		assert.deepEqual(parseCi(ciRuns(sha, "failure")), { ok: true, value: { sha, conclusion: "failure" } });
		assert.deepEqual(parseCi(ciRuns(sha, null, "in_progress")), { ok: true, value: { sha, conclusion: "pending" } });
		assert.deepEqual(parseCi([]), { ok: true, value: null });
		assert.deepEqual(parseCi({ runs: [] }), { ok: false, code: "gh_bad_shape" });
		assert.deepEqual(parseCi([{ headSha: "not-a-sha", status: "completed", createdAt: "x" }]), { ok: false, code: "gh_bad_shape" });
	});
});

describe("actionable transitions give exactly one event", () => {
	test("(a) a run leaves running", () => {
		const cur = rawStatus({ tasks: [{ id: 1, phase: "waiting", wait: "waits for review" }], agents: [{ task: 1, run: null, step: "review", state: "waiting" }] });
		assert.deepEqual(due(running(), cur), ["seat-finished:1:10:implement"]);
	});

	test("(a) the step advances to a new run", () => {
		const cur = rawStatus({ tasks: [{ id: 1 }], agents: [{ task: 1, run: 11, step: "review" }], seats: [{ task: 1, run: 11 }] });
		assert.deepEqual(due(running(), cur), ["seat-finished:1:10:implement"]);
	});

	test("(b) a task enters a failed state", () => {
		const cur = rawStatus({ tasks: [{ id: 1, phase: "failed" }], agents: [{ task: 1, run: 10, state: "failed" }], seats: [{ task: 1, run: 10 }] });
		assert.deepEqual(due(running(), cur), ["task-error:1:failed"]);
	});

	test("(b) a waiting task's agent errors", () => {
		const prev = rawStatus({ tasks: [{ id: 2, phase: "waiting", wait: "waits for T-1 to land" }], agents: [{ task: 2, state: "waiting", step: null }] });
		const cur = rawStatus({ tasks: [{ id: 2, phase: "waiting", wait: "waits for T-1 to land" }], agents: [{ task: 2, state: "error", step: null }] });
		assert.deepEqual(due(prev, cur), ["task-error:2:error"]);
	});

	test("(b) evf tick_error becomes set", () => {
		assert.deepEqual(due(running(), running({ tickError: "store locked" })), ["tick-error"]);
	});

	test("(c) evf heartbeat stops for 15 minutes", () => {
		const stale = running({ heartbeat: NOW - HEARTBEAT_STALE_MS });
		assert.deepEqual(due(running(), stale), ["stuck-heartbeat"]);
		assert.deepEqual(due(running(), running({ heartbeat: NOW - HEARTBEAT_STALE_MS + 1 })), []);
	});

	test("(c) a not-live seat on a running task fires on the second poll only", () => {
		const dead = running({ seats: [{ task: 1, run: 10, live: false }] });
		const s0 = baseline(running());
		const first = advance(s0, snap(dead));
		assert.deepEqual(first.due, []);
		assert.deepEqual(advance(first.next, snap(dead)).due.map((e) => e.key), ["stuck-seat:10"]);
	});

	test("(c) a 6-hour live, active run is not stuck", () => {
		const longRun = running({ seats: [{ task: 1, run: 10, live: true, started_at: NOW - 6 * 3600_000, activity_at: NOW - 30_000 }] });
		let state = baseline(running());
		for (let i = 0; i < 5; i++) {
			const step = advance(state, snap(longRun));
			assert.deepEqual(step.due, []);
			state = step.next;
		}
	});

	test("(d) a slot frees while released work waits", () => {
		const waiting = { id: 3, phase: "waiting", wait: "waits for a free seat" };
		const full = running({ tasks: [{ id: 1 }, waiting], seatsUsed: 8, seatsMax: 8 });
		const free = running({ tasks: [{ id: 1 }, waiting], seatsUsed: 7, seatsMax: 8 });
		assert.deepEqual(due(full, free), ["slot-available:3"]);
	});

	test("(e) main CI fails for a new head sha", () => {
		const green: Ci = { sha: "1".repeat(40), conclusion: "success" };
		const red: Ci = { sha: "2".repeat(40), conclusion: "failure" };
		assert.deepEqual(due(running(), running(), green, red), [`ci-failed:${"2".repeat(40)}`]);
	});

	test("(f) a new decision id opens", () => {
		const cur = running({ decisions: [{ id: "D-9", task: 1, kind: "approval" }] });
		assert.deepEqual(due(running(), cur), ["decision:D-9"]);
	});
});

describe("slot notices count released, eligible work only", () => {
	const freeWith = (tasks: Task[], decisions: Record<string, unknown>[] = []) =>
		running({ tasks: [{ id: 1 }, ...tasks], seatsUsed: 1, seatsMax: 8, decisions });
	const fullWith = (tasks: Task[], decisions: Record<string, unknown>[] = []) =>
		running({ tasks: [{ id: 1 }, ...tasks], seatsUsed: 8, seatsMax: 8, decisions });

	const queues: [string, Task[], Record<string, unknown>[]][] = [
		["held phase", [{ id: 4, phase: "held", hold: "Do not release", wait: "held: Do not release" }], []],
		["hold set on a waiting task", [{ id: 4, phase: "waiting", hold: "owner hold", wait: null }], []],
		["owner-gated wait", [{ id: 4, phase: "waiting", wait: "waits for the owner to approve" }], []],
		["decision pending on the task", [{ id: 4, phase: "waiting", wait: null }], [{ id: 12, task: 4 }]],
		["dependency wait", [{ id: 4, phase: "waiting", wait: "waits for T-75 to land" }], []],
		["terminal lifecycle", [{ id: 4, phase: "landed", lifecycle: "landed" }], []],
	];
	for (const [name, tasks, decisions] of queues) {
		test(`${name} with a free slot gives no slot event`, () => {
			const keys = due(fullWith(tasks, decisions), freeWith(tasks, decisions));
			assert.deepEqual(keys.filter((k) => k.startsWith("slot-available")), []);
		});
	}
});

describe("dedup", () => {
	test("unchanged status gives nothing, poll after poll", () => {
		let state = baseline(running());
		for (let i = 0; i < 10; i++) {
			const step = advance(state, snap(running({ noise: i % 2 ? "a" : "b" })));
			assert.deepEqual(step.due, []);
			state = step.next;
		}
	});

	test("a baseline over active conditions does not wake, and they stay quiet", () => {
		const noisy = running({ tickError: "x", decisions: [{ id: 1 }], heartbeat: NOW - HEARTBEAT_STALE_MS });
		const first = advance(null, snap(noisy));
		assert.deepEqual(first.due, []);
		assert.deepEqual(advance(first.next, snap(noisy)).due, []);
	});

	test("a delivered key stays quiet while its condition holds, and recurs after it clears", () => {
		const open = running({ decisions: [{ id: "D-3" }] });
		const s1 = advance(baseline(running()), snap(open));
		assert.deepEqual(s1.due.map((e) => e.key), ["decision:D-3"]);
		const sent = markDelivered(s1.next, s1.due);
		assert.deepEqual(advance(sent, snap(open)).due, []);
		const cleared = advance(sent, snap(running())).next;
		assert.deepEqual(cleared.sent, []);
		assert.deepEqual(advance(cleared, snap(open)).due.map((e) => e.key), ["decision:D-3"]);
	});

	test("a re-entered stuck state and a new failing sha fire again", () => {
		const stale = running({ heartbeat: NOW - HEARTBEAT_STALE_MS });
		let s = markDelivered(...((r) => [r.next, r.due] as const)(advance(baseline(running()), snap(stale))));
		s = advance(s, snap(running())).next;
		assert.deepEqual(advance(s, snap(stale)).due.map((e) => e.key), ["stuck-heartbeat"]);

		const red1: Ci = { sha: "3".repeat(40), conclusion: "failure" };
		const red2: Ci = { sha: "4".repeat(40), conclusion: "failure" };
		const a = advance(baseline(running()), snap(running(), red1));
		const b = advance(markDelivered(a.next, a.due), snap(running(), red2));
		assert.deepEqual(b.due.map((e) => e.key), [`ci-failed:${"4".repeat(40)}`]);
	});

	test("an undelivered event stays pending; a cleared level event is dropped", () => {
		const open = running({ decisions: [{ id: "D-5" }] });
		const s1 = advance(baseline(running()), snap(open));
		const s2 = advance(s1.next, snap(open));
		assert.deepEqual(s2.due.map((e) => e.key), ["decision:D-5"]);
		assert.deepEqual(advance(s2.next, snap(running())).due, []);
	});

	test("state round-trips through the parser; corrupt state is refused", () => {
		const s = baseline(running({ decisions: [{ id: 1 }] }));
		assert.deepEqual(parseState(JSON.parse(JSON.stringify(s))), s);
		for (const bad of [null, {}, { ...s, version: 2 }, { ...s, sent: [1] }, { ...s, snapshot: { tasks: "x" } }, { ...s, pending: [{ key: 1 }] }]) {
			assert.equal(parseState(bad), null);
		}
	});
});

describe("redaction", () => {
	test("sensitive text in status never reaches the payload", () => {
		const secret = "sebastian@example.com https://user:pw@hooks.example/x sk-SECRET transcript-text";
		const raw = rawStatus({
			tasks: [{ id: 1, label: `ok ${secret}`, phase: "failed", wait: secret }],
			agents: [{ task: 1, run: 10, step: `implement ${secret}` }],
			seats: [{ task: 1, run: 10 }],
			decisions: [{ id: 2, task: 1, question: secret, context: secret }],
		});
		const s = advance(baseline(running()), snap(raw));
		const text = JSON.stringify(buildPayload(s.due, NOW)) + JSON.stringify(s.next);
		for (const bit of ["@", "https", "pw", "SECRET", "transcript", "Title", "Doing", "Bash"]) {
			assert.ok(!text.includes(bit), `payload or state leaks ${bit}`);
		}
		assert.deepEqual(buildPayload(s.due, NOW).events, [
			{ kind: "task-error", key: "task-error:1:failed", task: 1, label: "", step: "" },
			{ kind: "decision-open", key: "decision:D-2", decision: "D-2", task: 1 },
		]);
	});
});
