// OPS-142: `evf metrics --week` against a store with known answers, through the real command at a fixed clock.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fixture, source } from "./fixtures.ts";
import { evfDataDir } from "../lib.ts";
import { openWorkDb, workDbPath } from "../db.ts";

type Fx = ReturnType<typeof fixture>;
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const MINUTE = 60_000,
	HOUR = 60 * MINUTE;
const ago = (hours: number) => NOW - hours * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const utc = (day: string, time: string) => Date.parse(`2026-${day}T${time}:00.000Z`);

function evf(f: Fx, ...args: string[]) {
	const r = spawnSync(
		process.execPath,
		[`--import=data:text/javascript,Date.now=()=>${NOW}`, join(source, "tools/evf/main.ts"), "metrics", ...args],
		{
			cwd: f.root,
			encoding: "utf8",
			env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" },
		},
	);
	return r;
}
function week(f: Fx) {
	const text = evf(f, "--week"),
		json = evf(f, "--week", "--json");
	assert.equal(text.status, 0, text.stderr);
	assert.equal(json.status, 0, json.stderr);
	const report = JSON.parse(json.stdout) as {
		metrics: Array<{ key: string; name: string; value: any; text: string }>;
		lines: Array<{ key: string; name: string; value: any; text: string }>;
		alarms: Array<{ metric: string; level: string; text: string }>;
	};
	return { text: text.stdout, report, all: [...report.metrics, ...report.lines] };
}

function config(f: Fx, ownerHours: boolean) {
	f.cfg.ownerQueue = {
		timeZone: "UTC",
		digestTimes: ["09:00", "13:00", "17:00"],
		...(ownerHours ? { ownerHours: { start: "08:00", end: "18:00" } } : {}),
	};
	// A load limit of exactly 72 on any machine.
	f.cfg.machineLoad = { maxPerCore: 72 / availableParallelism(), maxWaitMinutes: 0 };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, "\t"));
}

function seed(db: DatabaseSync, f: Fx) {
	const task = (ref: string, status: string) =>
		Number(
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?)",
				)
				.run(ref.toLowerCase(), ref, status, iso(ago(300)), iso(ago(300))).lastInsertRowid,
		);
	const [A, B, C, D, E, F, G, H] = (
		[
			["OPS-901", "merged"],
			["OPS-902", "merged"],
			["OPS-903", "merged"],
			["OPS-904", "active"],
			["OPS-905", "active"],
			["OPS-906", "merged"],
			["OPS-907", "merged"],
			["WP-908", "active"],
		] as const
	).map(([ref, status]) => task(ref, status)) as [number, number, number, number, number, number, number, number];
	const ev = (id: number | null, type: string, at: number, payload: Record<string, unknown> = {}) =>
		db
			.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, ?, ?)")
			.run(id, iso(at), type, JSON.stringify(payload));
	const run = (id: number, stage: string, role: string, start: number, minutes: number) =>
		db
			.prepare("INSERT INTO runs (task_id, stage, role, status, started_at, ended_at) VALUES (?, ?, ?, 'passed', ?, ?)")
			.run(id, stage, role, iso(start), iso(start + minutes * MINUTE));

	// 1. 10 h of turns, 60% checks. A turn from before the week does not count.
	ev(A, "turn_end", ago(200), { modelMs: 99 * HOUR, checkMs: 0, waitMs: 0, toolMs: 0 });
	ev(A, "turn_end", ago(5), { modelMs: HOUR, checkMs: 6 * HOUR, waitMs: HOUR, toolMs: 2 * HOUR });

	// 2. 10 full starts and 2 merges after the first start. The merge at -100 h came before the signal.
	for (let i = 0; i < 10; i++) ev(A, "check_start", ago(90 - i), { mode: "full" });
	ev(A, "check_start", ago(80), { mode: "quick" });
	ev(A, "merged", ago(100));
	ev(B, "merged", ago(50));
	ev(C, "merged", ago(10));

	// 3. 3 rounds over 3 merges. Of 3 counted round_start, 1 has no new code.
	for (const hours of [60, 50, 40]) ev(A, "round", ago(hours), { round: 1, cause: "ci" });
	for (const nonMergeCommits of [0, 3, 5, null]) ev(A, "round_start", ago(30), { cause: "this_pr", nonMergeCommits });

	// 4. Inside 08:00 to 18:00 UTC: A 2 h, B 2 h, E 1 h, D 22 h and open. An ask on C is left open on a merged task.
	const ask = (id: number, at: number, digestId: string | null = null) =>
		ev(id, "owner_ask", at, { kind: "parked", digestId, askedAt: iso(at) });
	const answer = (id: number, at: number) => ev(id, "owner_answer", at, { answeredAt: iso(at) });
	// Digest "before": F waits 6 h inside over 2 wait events, and a wait at the time of G's ask counts once.
	ask(G, utc("10-27", "09:00"));
	ev(G, "owner_approval_wait", utc("10-27", "09:00"));
	answer(G, utc("10-27", "13:00"));
	ev(F, "owner_approval_wait", utc("10-28", "09:00"));
	ev(F, "owner_approval_wait", utc("10-28", "10:30"));
	ev(F, "merged", utc("10-28", "15:00"));
	ask(D, utc("11-03", "10:00"));
	ask(E, utc("11-04", "08:00"));
	ask(A, utc("11-04", "09:00"), "2026-11-04T13:00");
	answer(A, utc("11-04", "11:00"));
	ask(E, utc("11-04", "10:00"));
	answer(E, utc("11-04", "11:00"));
	ask(B, utc("11-04", "17:00"));
	answer(B, utc("11-05", "09:00"));
	ask(C, ago(30));

	// 5. 20 ticks: 11 straight idle, then one tick each that is not idle, then 5 more plain ones.
	const tick = (minute: number, p: Record<string, unknown>) =>
		ev(null, "queue_tick", ago(30) + minute * MINUTE, { runnable: 1, slotsFree: 1, load: 10, ...p });
	for (let m = 0; m < 11; m++) tick(m, {});
	tick(11, { runnable: 0 });
	tick(12, { slotsFree: 0 });
	tick(13, { load: 72 });
	tick(14, { load: null });
	for (let m = 15; m < 20; m++) tick(m, { runnable: 0 });
	ev(null, "queue_tick", ago(300), { runnable: 1, slotsFree: 1, load: 1 });

	// 6, full run p90 and overlap: 10 runs. Tree t1 fails then passes: the one flake.
	const end = (hours: number, result: string, treeHash: string, minutes: number, mode = "full") =>
		ev(A, "check_end", ago(hours), { result, treeHash, mode, durationMs: minutes * MINUTE });
	end(40, "failed", "t1", 10);
	end(39, "passed", "t1", 10);
	end(38, "failed", "t2", 5);
	end(37, "failed", "t3", 1, "quick");
	end(36, "passed", "t3", 20);
	end(35, "invalidated", "t8", 1);
	end(34, "error", "t9", 1);
	end(33, "passed", "t4", 5);
	end(33 - 2 / 60, "passed", "t5", 5);
	end(32, "passed", "t6", 5);
	// "spread" reaches 3 tasks in 20 h. "slow" takes 40 h. "one" stays on one task.
	const failed = (id: number, hours: number, name: string, ref: string) =>
		ev(id, "test_failed", ago(hours), { test: name, task: ref });
	failed(A, 30, "spread", "OPS-901");
	failed(B, 20, "spread", "OPS-902");
	failed(C, 10, "spread", "OPS-903");
	failed(A, 50, "slow", "OPS-901");
	failed(B, 30, "slow", "OPS-902");
	failed(C, 10, "slow", "OPS-903");
	for (const hours of [3, 2, 1]) failed(A, hours, "one", "OPS-901");

	// 7. 70 min in the last 24 h, 10 min two days back. Load stays above 72 for 5 ticks.
	const wait = (hours: number, minutes: number) =>
		ev(A, "load_wait", ago(hours), { startAt: iso(ago(hours) - minutes * MINUTE), endAt: iso(ago(hours)) });
	wait(1, 40);
	wait(2, 30);
	wait(50, 10);
	const loads = [80, 80, 80, 80, 80, 10, 80, 80].map((load1, i) => ({ at: iso(ago(20) + i * MINUTE), load1 }));
	appendFileSync(
		join(evfDataDir(f.root), "load.jsonl"),
		[...loads.map((l) => JSON.stringify(l)), '{"at":"half a li'].join("\n") + "\n",
	);

	// 8. 10 h, 4 h and 2 h. Only a task's first stage_start counts.
	ev(A, "stage_start", ago(110), { stage: "plan" });
	ev(B, "stage_start", ago(54), { stage: "plan" });
	ev(C, "stage_start", ago(12), { stage: "plan" });
	ev(C, "stage_start", ago(11), { stage: "implement" });

	// Suite p90: "a" doubles, "b" holds, "c" has no earlier week.
	const suite = (hours: number, name: string, ms: number) =>
		ev(A, "check_suite_end", ago(hours), { suite: name, durationMs: ms });
	suite(200, "a", 30_000);
	suite(20, "a", 60_000);
	suite(200, "b", 100_000);
	suite(20, "b", 100_000);
	suite(20, "c", 5_000);

	// One death of 60 min on D. A gap with no death record is a stop, not a death.
	ev(D, "drive_heartbeat", ago(9));
	ev(D, "drive_heartbeat", ago(6));
	ev(D, "drive_restart", ago(5.9));
	ev(D, "drive_death_alert", ago(5.8));
	ev(D, "drive_heartbeat", ago(5));

	// Handoffs of 10, 2 and 4 min. Seat time since the first coordinator run: 300 min, 60 of them the coordinator's.
	run(E, "implement", "implementer", ago(100), 600);
	for (const [hours, gap] of [
		[24, 10],
		[22, 2],
		[20, 4],
	] as const) {
		const task = hours === 24 ? A : hours === 22 ? B : C;
		run(task, "verify", "verifier", ago(hours), 60);
		run(task, "body", "implementer", ago(hours) + (60 + gap) * MINUTE, 10);
	}
	run(A, "registration", "registration", ago(25), 10);
	run(A, "registration", "registration", ago(25), 10);
	run(B, "registration", "registration", ago(25), 5);
	run(H, "registration", "registration", ago(25), 5);
	run(C, "pr", "evf", ago(25), 60);
	run(D, "coordinator", "coordinator", ago(26), 60);

	ev(A, "escalation", ago(40));
	for (const overlapPaths of [["p"], ["p", "q"], ["p"], []]) ev(A, "ship_refused", ago(40), { overlapPaths });
}

function seeded() {
	const f = fixture();
	config(f, true);
	const db = openWorkDb(f.root);
	try {
		seed(db, f);
	} finally {
		db.close();
	}
	return f;
}

test("OPS-142-2,4: each metric, part 2 line and alarm matches a store with known answers", () => {
	const f = seeded();
	try {
		const { all, report } = week(f);
		const values = Object.fromEntries(all.map((m) => [m.key, m.value]));
		assert.deepEqual(values, {
			seatSplit: { modelPct: 10, checksPct: 60, waitsPct: 10, otherPct: 20, hours: 10 },
			fullRunsPerMerge: { perMerge: 5, runs: 10, merges: 2 },
			roundsPerMerge: { perMerge: 1, rounds: 3, merges: 3, nonCodePct: 33.3 },
			ownerWait: { p90InsideHours: 22, asks: 4, open: 1, oldestOpenHours: 50 },
			queueIdle: { idlePct: 55, idleMinutes: 11, minutes: 20, longestStraightMinutes: 11 },
			flakeInvalid: { flakePct: 12.5, flakyRuns: 1, decidedRuns: 8, invalidPct: 10, invalidRuns: 1, runs: 10 },
			loadThrottled: { minutes: 80, worstDayMinutes: 70, longestAboveAlarmMinutes: 5 },
			startToMerge: { p50Hours: 4, p90Hours: 10, merges: 3 },
			fullRunP90: { p90Minutes: 20, runs: 5 },
			suiteRise: {
				suites: [
					{ suite: "a", risePct: 100 },
					{ suite: "b", risePct: 0 },
				],
			},
			deadDrive: { minutes: 60, deaths: 1 },
			bodyHandoff: { p50Minutes: 4, runs: 3 },
			escalations: { per10Merges: 3.3, escalations: 1, merges: 3 },
			refusals: {
				refusals: 4,
				paths: [
					{ path: "p", count: 3 },
					{ path: "q", count: 1 },
				],
			},
			registration: { p50Minutes: 5, worstMinutes: 20, tasks: 2 },
			coordinator: { pct: 20, coordinatorHours: 1, seatHours: 5 },
			overlap: {
				groups: [
					{ overlaps: 0, medianMinutes: 10, runs: 3 },
					{ overlaps: 1, medianMinutes: 5, runs: 2 },
				],
			},
			digest: { beforeP90Hours: 6, afterP90Hours: 2, cutPct: 66.7, before: 2, after: 3 },
		});
		assert.deepEqual(
			report.alarms.map((a) => `${a.level} ${a.metric}: ${a.text}`),
			[
				"alarm Seat time split: checks 60% is over 50%",
				"target Full check runs per merge: 5 is over 4",
				"target Rounds per merge and non-code share: 1 is not under 1.0",
				"target Rounds per merge and non-code share: non-code share 33.3% is not under 20%",
				"target Owner wait inside ownerHours: p90 22 h is not under 4 h",
				"alarm Owner wait inside ownerHours: 1 open ask(s) older than 24 h, the oldest 50 h",
				"target Queue idle time: 55% is not under 5%",
				"alarm Queue idle time: 11 straight idle min",
				"target Flake and invalidation rate: flake 12.5% is not under 1%",
				"alarm Flake and invalidation rate: invalid 10% is at or over 5%",
				"alarm Flake and invalidation rate: test failed on 3 tasks in 24 h: spread",
				"target Load-throttled minutes: 70 min on the worst day is not under 60",
				"alarm Load-throttled minutes: load above 72 for 5 straight min",
				"target Start to merge: p90 10 h is not under 10 h",
				"target Full run p90: 20 min is not under 15 min",
				"alarm Suite p90 week on week: a p90 is up 100%",
				"alarm Dead-drive minutes: 60 dead min",
				"alarm Escalations per 10 merges: 3.3 is over 1",
				"alarm Refusals per path: p caused 3 refusals",
				"target Registration per OPS task: worst 20 min is not under 15 min",
				"target Coordinator share of seat time: 20% is not under 10%",
			],
		);
	} finally {
		f.close();
	}
});

test("OPS-142-1,4: the text prints the 8 metrics, the 5 lines and an alarm line, with the values of --json", () => {
	const f = seeded();
	try {
		const { text, report, all } = week(f);
		const lines = text.trim().split("\n");
		report.metrics.forEach((m, i) => {
			assert.ok(
				lines.some((l) => l.startsWith(`${i + 1}. ${m.name}: ${m.text}`)),
				`metric ${i + 1}: ${m.text}`,
			);
		});
		assert.equal(report.metrics.length, 8);
		assert.equal(lines.filter((l) => l.startsWith("- ")).length, 5);
		for (const m of all) assert.ok(text.includes(`${m.name}: ${m.text}`), m.name);
		assert.ok(lines.includes("ALARM Seat time split: checks 60% is over 50%"));
		assert.ok(lines.includes("ALARM Full check runs per merge (target missed): 5 is over 4"));
		assert.equal(lines.filter((l) => l.startsWith("ALARM ")).length, report.alarms.length);
	} finally {
		f.close();
	}
});

test("OPS-142-3: a store with no signal prints no data for every metric, never 0, and no alarm", () => {
	const f = fixture();
	try {
		config(f, true);
		openWorkDb(f.root).close();
		const { text, report, all } = week(f);
		assert.equal(all.length, 18);
		for (const m of all) {
			assert.equal(m.value, null, m.key);
			assert.match(m.text, /^no data/, m.key);
			assert.ok(text.includes(`${m.name}: no data`), m.key);
		}
		assert.deepEqual(report.alarms, []);
		assert.doesNotMatch(text, /ALARM/);
	} finally {
		f.close();
	}
});

test("OPS-142-3: one missing signal leaves the others, and an old ask still alarms with ownerHours unset", () => {
	const f = seeded();
	try {
		config(f, false);
		const { all, report } = week(f);
		const by = Object.fromEntries(all.map((m) => [m.key, m]));
		assert.equal(by.ownerWait!.value.p90InsideHours, null);
		assert.match(by.ownerWait!.text, /^no data \(ownerHours is not set\)/);
		assert.equal(by.digest!.value, null);
		assert.equal(by.seatSplit!.value.checksPct, 60);
		assert.ok(report.alarms.some((a) => a.metric === by.ownerWait!.name && /older than 24 h/.test(a.text)));
	} finally {
		f.close();
	}
});

test("OPS-142-3: a week with merges and no check runs prints no data for runs per merge, and a true 0 for escalations", () => {
	const f = fixture();
	try {
		config(f, true);
		const db = openWorkDb(f.root);
		const id = Number(
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES ('a', 'implement', 'OPS-901', 'merged', ?, ?)",
				)
				.run(iso(ago(5)), iso(ago(5))).lastInsertRowid,
		);
		db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, 'merged', '{}')").run(id, iso(ago(5)));
		db.close();
		const by = Object.fromEntries(week(f).all.map((m) => [m.key, m]));
		assert.equal(by.fullRunsPerMerge!.value, null);
		assert.equal(by.loadThrottled!.value, null);
		assert.equal(by.escalations!.value.per10Merges, 0);
		assert.equal(by.roundsPerMerge!.value.perMerge, 0);
		assert.match(by.roundsPerMerge!.text, /non-code no data/);
	} finally {
		f.close();
	}
});

test("OPS-142-2: a dead spell ends when its task leaves active, or at the next heartbeat if that comes first", () => {
	const f = fixture();
	try {
		config(f, true);
		const db = openWorkDb(f.root);
		const ev = (id: number, type: string, at: number) =>
			db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, ?, '{}')").run(id, iso(at), type);
		// Each task: a heartbeat, a death record 6 min later, then the event that ends the spell `minutes` after the beat.
		const ends: Array<[string, string, number]> = [
			["OPS-911", "abandon", 30],
			["OPS-912", "merged", 20],
			["OPS-913", "held_external", 10],
			["OPS-914", "escalation", 7],
			["OPS-915", "handoff", 8],
			["OPS-916", "awaiting_pick", 9],
		];
		ends.forEach(([ref, type, minutes], i) => {
			const id = Number(
				db
					.prepare(
						"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES (?, 'implement', ?, 'active', ?, ?)",
					)
					.run(ref.toLowerCase(), ref, iso(ago(150)), iso(ago(150))).lastInsertRowid,
			);
			const beat = ago(100 - i);
			ev(id, "drive_heartbeat", beat);
			ev(id, "drive_death_alert", beat + 6 * MINUTE);
			ev(id, type, beat + minutes * MINUTE);
		});
		// The next heartbeat at 3 min comes before the merge at 40 min.
		const id = Number(
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, status, created_at, updated_at) VALUES ('opsx', 'implement', 'OPS-917', 'active', ?, ?)",
				)
				.run(iso(ago(150)), iso(ago(150))).lastInsertRowid,
		);
		ev(id, "drive_heartbeat", ago(50));
		ev(id, "drive_restart", ago(50) + 2 * MINUTE);
		ev(id, "drive_heartbeat", ago(50) + 3 * MINUTE);
		ev(id, "merged", ago(50) + 40 * MINUTE);
		db.close();
		const dead = week(f).all.find((m) => m.key === "deadDrive")!;
		assert.deepEqual(dead.value, { minutes: 87, deaths: 7 });
	} finally {
		f.close();
	}
});

test("OPS-142-5: the command writes nothing and reads through openWorkDb", () => {
	const f = seeded();
	try {
		const dir = evfDataDir(f.root),
			hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
		const state = () => ({
			store: hash(workDbPath(f.root)),
			load: hash(join(dir, "load.jsonl")),
			files: readdirSync(dir)
				.filter((n) => !/-(shm|wal)$/.test(n))
				.sort(),
		});
		const before = state();
		week(f);
		assert.deepEqual(state(), before);
		const code = readFileSync(resolve(import.meta.dirname, "../metrics.ts"), "utf8");
		assert.match(code, /openWorkDb\(root, \{ readOnly: true \}\)/);
		assert.doesNotMatch(code, /DatabaseSync|writeFileSync|appendFileSync|record\(/);
	} finally {
		f.close();
	}
});

test("OPS-142-6: the README defines each metric, and the command needs --week", () => {
	const f = seeded();
	try {
		const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8"),
			section = readme.slice(readme.indexOf("## Weekly metrics"), readme.indexOf("## Usage and seat models"));
		for (const m of week(f).all) assert.ok(section.includes(`| ${m.name} |`), m.name);
		assert.notEqual(evf(f).status, 0);
	} finally {
		f.close();
	}
});
