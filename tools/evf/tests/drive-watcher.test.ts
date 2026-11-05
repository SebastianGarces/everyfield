import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { ensureTask, openWorkDb, syncGoals } from "../db.ts";
import {
	driveHolder,
	readParentCommand,
	recordDriveStopped,
	startHeartbeat,
	type StopProbes,
} from "../drive-signal.ts";
import { machineWatcher, watcherTick, type WatcherProbes } from "../drive-watcher.ts";
import { drive } from "../drive.ts";
import { evfDataDir, parseTask } from "../lib.ts";
import { applyRetention, runSampler, type SamplerProbes } from "../sampler.ts";
import { cli, fixture, noSeatEnv, pidFileHolder, source } from "./fixtures.ts";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SPEC = "Goal: x.\nDone criteria:\n1. y.\nNon-goals: z.";
const task = parseTask("OPS-1");

/** One task row in the given status on a fixture repo, with a helper for each thing the tests read and write. */
function store(status = "active") {
	const f = fixture();
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Watch", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const id = ensureTask(db, task, "implement").id;
	db.prepare("UPDATE tasks SET status = ?, spec = ? WHERE id = ?").run(status, SPEC, id);
	const seed = (type: string, at: number, payload: Record<string, unknown> = {}, taskId: number | null = id) =>
		db
			.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, ?, ?)")
			.run(taskId, iso(at), type, JSON.stringify(payload));
	const events = (type: string) =>
		(
			db
				.prepare("SELECT ts, run_id, payload FROM events WHERE task_id = ? AND type = ? ORDER BY id")
				.all(id, type) as Array<{
				ts: string;
				run_id: number | null;
				payload: string;
			}>
		).map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, any> }));
	const count = (type: string) => events(type).length;
	const insertRun = (stage: string, role: string, status: string) =>
		Number(
			db
				.prepare("INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, ?, 0, ?, ?)")
				.run(id, stage, role, status, iso(T0)).lastInsertRowid,
		);
	return { ...f, db, id, seed, events, count, insertRun, done: () => (db.close(), f.close()) };
}

/** A fake clock and machine. `refusal` makes each start refuse; no pid file names a live drive. */
function watcher(s: ReturnType<typeof store>) {
	const w = {
		at: T0,
		refusal: null as string | null,
		starts: [] as Array<{ ref: string; restartsAtSpawn: number }>,
		notes: [] as Array<{ title: string; body: string }>,
		probes: undefined as unknown as WatcherProbes,
		tick(at: number) {
			w.at = at;
			watcherTick(s.root, w.probes);
		},
	};
	w.probes = {
		now: () => w.at,
		liveDrive: () => false,
		startDrive: (ref) => {
			w.starts.push({ ref, restartsAtSpawn: s.count("drive_restart") });
			return w.refusal;
		},
		notify: (title, body) => w.notes.push({ title, body }),
	};
	return w;
}

const WATCHER_TYPES = ["drive_restart", "drive_death_alert", "drive_restart_refused"];
const watcherEvents = (s: ReturnType<typeof store>) => WATCHER_TYPES.reduce((n, type) => n + s.count(type), 0);
const beat = (s: ReturnType<typeof store>, at: number, pid = 4242) => s.seed("drive_heartbeat", at, { pid });

test("a heartbeat at the start and one per minute: 3 min on a fake clock give exactly 4, with the pid, on the pinned row with a null run; a failed write does not stop the next (AC:OPS-137-1)", () => {
	const s = store();
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const stop = startHeartbeat(s.root, s.id);
		assert.equal(s.count("drive_heartbeat"), 1, "one at the start");
		mock.timers.tick(3 * MIN - 1);
		assert.equal(s.count("drive_heartbeat"), 3);
		mock.timers.tick(1);
		assert.equal(s.count("drive_heartbeat"), 4);
		for (const e of s.events("drive_heartbeat")) {
			assert.deepEqual(e.payload, { pid: process.pid });
			assert.equal(e.run_id, null);
		}
		s.db.exec(
			"CREATE TRIGGER no_beat BEFORE INSERT ON events WHEN NEW.type = 'drive_heartbeat' BEGIN SELECT RAISE(ABORT, 'store refuses'); END",
		);
		const saved = console.error;
		console.error = () => {};
		try {
			assert.doesNotThrow(() => mock.timers.tick(MIN));
		} finally {
			console.error = saved;
		}
		s.db.exec("DROP TRIGGER no_beat");
		mock.timers.tick(MIN);
		assert.equal(s.count("drive_heartbeat"), 5, "the failed minute is lost and the next one records");
		stop();
		mock.timers.tick(10 * MIN);
		assert.equal(s.count("drive_heartbeat"), 5, "no heartbeat after the stop");
	} finally {
		mock.timers.reset();
		s.done();
	}
});

const STOP_KEYS = [
	"lastMergeAt",
	"mergeWithin60s",
	"parentCommand",
	"pid",
	"ppid",
	"run",
	"signal",
	"stage",
	"summary",
];
const probesAt = (ms: number, parentCommand: string | null = "zsh"): StopProbes => ({
	now: () => ms,
	parentCommand: () => parentCommand,
});

test("one drive_stopped with the exact key set in a pr, ci and ship stage, in a seat wait and between stages; run prefers the evf run; no sender field (AC:OPS-137-2)", () => {
	const s = store();
	try {
		for (const stage of ["pr", "ci", "ship"]) {
			const run = s.insertRun(stage, "evf", "started");
			const before = s.count("drive_stopped");
			recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0));
			const events = s.events("drive_stopped");
			assert.equal(events.length, before + 1);
			const e = events.at(-1)!;
			assert.deepEqual(Object.keys(e.payload).sort(), STOP_KEYS);
			assert.deepEqual(
				{ ...e.payload },
				{
					pid: process.pid,
					ppid: process.ppid,
					parentCommand: "zsh",
					stage,
					run,
					lastMergeAt: null,
					mergeWithin60s: false,
					signal: "SIGTERM",
					summary: `drive stopped by SIGTERM during ${stage}`,
				},
			);
			assert.equal(e.run_id, run);
			const row = s.db.prepare("SELECT status, summary FROM runs WHERE id = ?").get(run)!;
			assert.deepEqual({ ...row }, { status: "aborted", summary: `drive stopped by SIGTERM during ${stage}` });
		}
		// Between stages: nothing open, so the stage and the run are null.
		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0, null));
		const between = s.events("drive_stopped").at(-1)!;
		assert.deepEqual(Object.keys(between.payload).sort(), STOP_KEYS);
		assert.equal(between.payload.stage, null);
		assert.equal(between.payload.run, null);
		assert.equal(between.payload.parentCommand, null);
		assert.equal(between.payload.summary, "drive stopped by SIGTERM between stages");

		// A seat wait: the seat's run stays open and its own last event does not change.
		const seat = s.insertRun("implement", "implementer", "started");
		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0));
		const waited = s.events("drive_stopped").at(-1)!;
		assert.equal(waited.payload.stage, "implement");
		assert.equal(waited.payload.run, seat);
		assert.equal(waited.run_id, null);
		assert.equal(s.db.prepare("SELECT status FROM runs WHERE id = ?").get(seat)!.status, "started");

		// Both open: the evf run names the stage.
		const ci = s.insertRun("ci", "evf", "started");
		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0));
		assert.equal(s.events("drive_stopped").at(-1)!.payload.run, ci);
		assert.equal(s.db.prepare("SELECT status FROM runs WHERE id = ?").get(seat)!.status, "started");

		// The pid file goes, also when the store cannot record.
		const pidFile = join(evfDataDir(s.root), "drive", `${task.slug}.pid`);
		mkdirSync(join(evfDataDir(s.root), "drive"), { recursive: true });
		writeFileSync(pidFile, `${process.pid}\n`);
		s.db.exec(
			"CREATE TRIGGER no_stop BEFORE INSERT ON events WHEN NEW.type = 'drive_stopped' BEGIN SELECT RAISE(ABORT, 'store refuses'); END",
		);
		assert.throws(() => recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0)));
		assert.ok(!existsSync(pidFile));
	} finally {
		s.done();
	}
});

test("parentCommand holds at most 200 characters, is null for a gone parent and null when ps passes its 2 s limit (AC:OPS-137-2)", async () => {
	const s = store();
	let long: ChildProcess | undefined;
	try {
		long = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "x".repeat(400)], { stdio: "ignore" });
		await new Promise((resolve) => long!.once("spawn", resolve));
		const read = readParentCommand(long.pid!);
		assert.equal(read?.length, 200);
		assert.match(read!, /node/);
		const gone = spawnSync(process.execPath, ["-e", ""]).pid;
		assert.equal(readParentCommand(gone), null);
		writeFileSync(join(s.root, "fake-bin/ps"), "#!/bin/sh\nexec sleep 30\n");
		chmodSync(join(s.root, "fake-bin/ps"), 0o755);
		const started = Date.now();
		assert.equal(readParentCommand(process.pid), null);
		const took = Date.now() - started;
		assert.ok(took >= 1900 && took < 10_000, `took ${took} ms`);
	} finally {
		long?.kill("SIGKILL");
		s.done();
	}
});

test("a stale active or pr_open task gets one restart: nothing at 4 min 59 s, one record before one start at 5 min, none in the next 5 min (AC:OPS-137-3)", () => {
	for (const status of ["active", "pr_open"]) {
		const s = store(status);
		try {
			const w = watcher(s);
			beat(s, T0);
			w.tick(T0 + 5 * MIN - 1000);
			assert.equal(watcherEvents(s), 0);
			assert.deepEqual(w.starts, []);
			w.tick(T0 + 5 * MIN);
			assert.deepEqual(w.starts, [{ ref: "OPS-1", restartsAtSpawn: 1 }], "the record goes before the start");
			assert.equal(s.count("drive_restart"), 1);
			assert.equal(s.events("drive_restart")[0]!.ts, iso(T0 + 5 * MIN));
			assert.match(s.events("drive_restart")[0]!.payload.summary, new RegExp(iso(T0)));
			for (const m of [6, 7, 8, 9]) w.tick(T0 + m * MIN);
			w.tick(T0 + 10 * MIN - 1000);
			assert.equal(s.count("drive_restart"), 1);
			assert.equal(w.starts.length, 1);
			assert.equal(s.count("drive_death_alert"), 0);
		} finally {
			s.done();
		}
	}
});

test("the real start runs evf drive <ref> --detach from the home checkout, with no seat identity (AC:OPS-137-3)", () => {
	const s = store();
	const seat = process.env.EVF_RUN;
	try {
		const out = join(s.root, "started.json");
		writeFileSync(
			join(s.root, "tools/evf/main.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), seat: process.env.EVF_RUN ?? null }));`,
		);
		process.env.EVF_RUN = "99";
		assert.equal(machineWatcher(s.root).startDrive("OPS-1"), null);
		const started = JSON.parse(readFileSync(out, "utf8"));
		assert.deepEqual(started.args, ["drive", "OPS-1", "--detach"]);
		assert.equal(
			spawnSync("realpath", [started.cwd], { encoding: "utf8" }).stdout,
			spawnSync("realpath", [s.root], { encoding: "utf8" }).stdout,
		);
		assert.equal(started.seat, null);
	} finally {
		if (seat === undefined) delete process.env.EVF_RUN;
		else process.env.EVF_RUN = seat;
		s.done();
	}
});

test("a second death raises one alert with the task, the last heartbeat and the command, and no restart; a person's new drive gets a new allowance (AC:OPS-137-4)", () => {
	const s = store();
	try {
		const w = watcher(s);
		beat(s, T0);
		w.tick(T0 + 5 * MIN); // the restart
		// The restarted drive records none in the 5 min after drive_restart.
		w.tick(T0 + 10 * MIN - 1000);
		assert.equal(s.count("drive_death_alert"), 0);
		w.tick(T0 + 10 * MIN);
		assert.equal(s.count("drive_death_alert"), 1);
		assert.equal(w.starts.length, 1, "no second restart");
		assert.equal(w.notes.length, 1);
		for (const text of ["OPS-1", iso(T0), "bin/evf drive OPS-1 --detach"])
			assert.ok(w.notes[0]!.body.includes(text), text);
		for (const m of [11, 20, 60]) w.tick(T0 + m * MIN);
		assert.equal(s.count("drive_death_alert"), 1);
		assert.equal(w.notes.length, 1);
		assert.equal(w.starts.length, 1);

		// A person starts a drive: one more restart, then one more alert.
		beat(s, T0 + 100 * MIN);
		w.tick(T0 + 105 * MIN - 1000);
		assert.equal(w.starts.length, 1);
		w.tick(T0 + 105 * MIN);
		assert.equal(w.starts.length, 2);
		assert.equal(s.count("drive_restart"), 2);
		// This restarted drive lives for a while and then stops its heartbeats: 5 min after the last one is a death.
		beat(s, T0 + 106 * MIN);
		beat(s, T0 + 3000 * MIN);
		w.tick(T0 + 3005 * MIN - 1000);
		assert.equal(s.count("drive_death_alert"), 1);
		w.tick(T0 + 3005 * MIN);
		assert.equal(s.count("drive_death_alert"), 2, "a drive that lived for days still counts as a second death");
		assert.equal(w.notes.length, 2);
		assert.equal(w.starts.length, 2);
	} finally {
		s.done();
	}
});

test("a stale heartbeat on a held, merged, escalated, abandoned, done or awaiting_pick task never restarts and never alerts, past 10 min (AC:OPS-137-5)", () => {
	for (const status of ["held_external", "merged", "escalated", "abandoned", "done", "awaiting_pick"]) {
		const s = store(status);
		try {
			const w = watcher(s);
			beat(s, T0);
			for (let m = 1; m <= 12; m++) w.tick(T0 + m * MIN);
			assert.equal(watcherEvents(s), 0, status);
			assert.deepEqual(w.starts, [], status);
			assert.deepEqual(w.notes, [], status);
		} finally {
			s.done();
		}
	}
});

test("a stop 60 s after the newest merge of any task carries the flag and says so; 61 s and no merge do not (AC:OPS-137-6)", () => {
	const s = store();
	try {
		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0));
		assert.equal(s.events("drive_stopped")[0]!.payload.mergeWithin60s, false);
		assert.equal(s.events("drive_stopped")[0]!.payload.lastMergeAt, null);

		// The newest merge counts, on another task's row.
		const other = ensureTask(s.db, parseTask("OPS-2"), "implement").id;
		s.seed("merged", T0 - 500 * MIN, {}, s.id);
		s.seed("merged", T0, {}, other);
		s.seed("merged", T0 - 900 * MIN, {}, s.id);
		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0 + 60_000));
		const at60 = s.events("drive_stopped")[1]!.payload;
		assert.equal(at60.mergeWithin60s, true);
		assert.equal(at60.lastMergeAt, iso(T0));
		assert.match(at60.summary, /merge came within 60 s.*consider an OPS task/);

		recordDriveStopped(s.root, task, "SIGTERM", s.id, probesAt(T0 + 61_000));
		const at61 = s.events("drive_stopped")[2]!.payload;
		assert.equal(at61.mergeWithin60s, false);
		assert.equal(at61.lastMergeAt, iso(T0));
		assert.doesNotMatch(at61.summary, /merge|OPS task/);

		const status = cli(s.root, {}, "status", "--json");
		const recent = (JSON.parse(status.stdout) as { recent: Array<{ type: string; summary: string }> }).recent;
		assert.ok(recent.some((e) => e.type === "drive_stopped" && /consider an OPS task/.test(e.summary)));
	} finally {
		s.done();
	}
});

test("a refused restart records one refusal and one notification, uses no restart and leaves no restart record; the first tick on current code restarts once (AC:OPS-137-7)", () => {
	const s = store();
	try {
		const w = watcher(s);
		beat(s, T0);
		w.refusal = "evf drive does not start OPS-1: the running evf code is old";
		for (let m = 5; m <= 20; m++) w.tick(T0 + m * MIN);
		assert.equal(s.count("drive_restart_refused"), 1);
		assert.ok(s.events("drive_restart_refused")[0]!.payload.summary.includes(w.refusal));
		assert.equal(w.notes.length, 1);
		assert.ok(w.notes[0]!.body.includes(w.refusal));
		assert.equal(s.count("drive_restart"), 0, "a refusal keeps no restart record");
		assert.equal(s.count("drive_death_alert"), 0);
		assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
		w.refusal = null;
		const tries = w.starts.length;
		w.tick(T0 + 21 * MIN);
		assert.equal(w.starts.length, tries + 1);
		assert.equal(s.count("drive_restart"), 1);
		for (const m of [22, 23, 25]) w.tick(T0 + m * MIN);
		assert.equal(w.starts.length, tries + 1);
		assert.equal(s.count("drive_restart"), 1);
		// The refusal did not use the restart, so the alert comes only after the real restart's drive dies.
		w.tick(T0 + 26 * MIN);
		assert.equal(s.count("drive_death_alert"), 1);
	} finally {
		s.done();
	}
});

test("the real restart: stale code refuses through requireCurrentCode with no seat and no run; current code starts a drive that records its heartbeat (AC:OPS-137-7)", async () => {
	const s = store("pr_open");
	const savedOptions = process.env.NODE_OPTIONS;
	try {
		symlinkSync(join(source, "tools/evf/main.ts"), join(s.root, "tools/evf/main.ts"));
		// Without the preload that claims current code, this checkout's real code differs from the fixture's main.
		delete process.env.NODE_OPTIONS;
		const refusal = machineWatcher(s.root).startDrive("OPS-1");
		assert.match(refusal!, /evf drive does not start OPS-1: /);
		assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM runs").get()!.n, 0);
		assert.equal(s.count("drive_heartbeat"), 0);

		process.env.NODE_OPTIONS = savedOptions;
		// A merged task, so that the started drive records a heartbeat and ends by itself.
		s.db.prepare("UPDATE tasks SET status = 'merged' WHERE id = ?").run(s.id);
		assert.equal(machineWatcher(s.root).startDrive("OPS-1"), null);
		for (let i = 0; i < 600 && s.count("drive_ended") === 0; i++) await new Promise((r) => setTimeout(r, 50));
		assert.ok(s.count("drive_heartbeat") >= 1, "the started drive records a heartbeat");
		assert.equal(s.count("drive_ended"), 1);
	} finally {
		process.env.NODE_OPTIONS = savedOptions;
		s.done();
	}
});

/** A real `evf drive` through main.ts. Its exit code and the events are what a watcher reads. */
const realDrive = (s: ReturnType<typeof store>, ...flags: string[]) => cli(s.root, {}, "drive", "OPS-1", ...flags);

test("every normal exit records drive_ended with its stage and exit code, and the watcher skips that task (AC:OPS-137-8)", () => {
	const cases: Array<[string, string, number, (s: ReturnType<typeof store>) => string[]]> = [
		[
			"owner wait",
			"done",
			0,
			(s) => {
				s.db.prepare("UPDATE tasks SET status = 'pr_open' WHERE id = ?").run(s.id);
				for (const [stage, role] of [
					["implement", "implementer"],
					["simplify", "simplifier"],
					["pr", "evf"],
					["verify", "verifier"],
					["ci", "evf"],
					["ship", "evf"],
				])
					s.insertRun(stage!, role!, "passed");
				return [];
			},
		],
		[
			"pick",
			"pick",
			0,
			(s) => {
				s.db.prepare("UPDATE tasks SET mode = 'prototype' WHERE id = ?").run(s.id);
				for (const stage of ["idea1", "idea2", "idea3", "compare"]) s.insertRun(stage, "implementer", "passed");
				return [];
			},
		],
		[
			"blocked",
			"blocked",
			2,
			(s) => {
				s.db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(s.id);
				return [];
			},
		],
		[
			"escalated",
			"escalated",
			2,
			(s) => {
				s.db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(s.id);
				return [];
			},
		],
		[
			"done",
			"done",
			0,
			(s) => {
				s.db.prepare("UPDATE tasks SET status = 'merged' WHERE id = ?").run(s.id);
				return [];
			},
		],
		[
			"--once in a hold",
			"held",
			0,
			(s) => {
				s.db.prepare("UPDATE tasks SET status = 'held_external', pr_number = 77 WHERE id = ?").run(s.id);
				s.seed("held_external", T0, { cause: "pr", checks: ["x"], head: "abc", summary: "held" });
				return ["--once"];
			},
		],
	];
	for (const [name, stage, code, arrange] of cases) {
		const s = store();
		try {
			const flags = arrange(s);
			const r = realDrive(s, ...flags);
			assert.equal(r.status, code, `${name}: ${r.stderr}`);
			const ended = s.events("drive_ended");
			assert.equal(ended.length, 1, name);
			assert.equal(ended[0]!.payload.stage, stage, name);
			assert.equal(ended[0]!.payload.code, code, name);
			assert.ok(s.count("drive_heartbeat") >= 1, name);
			// The row goes back to a watched status, as a task can after a drive ends. The latest drive record still decides.
			s.db.prepare("UPDATE tasks SET status = 'active', mode = 'implement' WHERE id = ?").run(s.id);
			const w = watcher(s);
			w.tick(Date.now() + 60 * MIN);
			assert.equal(watcherEvents(s), 0, name);
			assert.deepEqual(w.starts, [], name);
		} finally {
			s.done();
		}
	}
});

test("a drive whose row is abandoned while it runs reports the abandoned end (AC:OPS-137-8)", () => {
	const s = store();
	const ends: string[] = [];
	const saved = console.log;
	console.log = () => {};
	try {
		const code = drive(s.root, task, {
			onPinned: (pin) => s.db.prepare("UPDATE tasks SET status = 'abandoned' WHERE id = ?").run(pin),
			onEnd: (n) => ends.push(n.stage),
		});
		assert.equal(code, 2);
		assert.deepEqual(ends, ["abandoned"]);
	} finally {
		console.log = saved;
		s.done();
	}
});

test("an uncaught failure in the drive loop records no drive_ended, so the watcher counts that death (AC:OPS-137-8)", () => {
	const s = store();
	try {
		const wt = s.task("ops-1");
		s.db.prepare("UPDATE tasks SET worktree = ? WHERE id = ?").run(wt, s.id);
		s.db.exec("CREATE TRIGGER no_runs BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'store refuses'); END");
		const r = realDrive(s);
		assert.notEqual(r.status, 0, r.stdout);
		assert.equal(r.status === 2, false);
		assert.equal(s.count("drive_ended"), 0);
		const beats = s.events("drive_heartbeat");
		assert.ok(beats.length >= 1);
		const w = watcher(s);
		w.tick(Date.parse(beats.at(-1)!.ts) + 5 * MIN);
		assert.equal(s.count("drive_restart"), 1);
	} finally {
		s.done();
	}
});

test("evf drive --stop records the request, signals the live drive and exits 0 when none runs; that stop never restarts, a new drive's heartbeat clears it (AC:OPS-137-9)", async () => {
	const s = store();
	try {
		const none = realDrive(s, "--stop");
		assert.equal(none.status, 0);
		assert.match(none.stdout, /No drive runs for OPS-1/);
		assert.equal(s.events("drive_stop_requested")[0]!.payload.pid, null);

		const { child, exited } = await pidFileHolder(s.root, task.slug, "main.ts", "drive", "OPS-1");
		beat(s, T0, child.pid!);
		const stopped = realDrive(s, "--stop");
		assert.equal(stopped.status, 0);
		assert.match(stopped.stdout, new RegExp(`pid ${child.pid}`));
		assert.equal(await exited, "SIGTERM");
		assert.equal(s.events("drive_stop_requested")[1]!.payload.pid, child.pid);

		const w = watcher(s);
		// A heartbeat that the stopped drive wrote just after the request clears nothing.
		beat(s, T0, child.pid!);
		for (let m = 5; m <= 12; m++) w.tick(T0 + m * MIN);
		assert.equal(watcherEvents(s), 0);
		assert.deepEqual(w.starts, []);

		beat(s, T0 + 20 * MIN, child.pid! + 1);
		w.tick(T0 + 25 * MIN);
		assert.equal(s.count("drive_restart"), 1, "a new drive's heartbeat clears the request");
	} finally {
		s.done();
	}
});

test("--stop signals no process that a pid file names when that pid now runs another command (AC:OPS-137-9)", async () => {
	const s = store();
	const { child } = await pidFileHolder(s.root, task.slug, "other.ts");
	try {
		const r = realDrive(s, "--stop");
		assert.equal(r.status, 0);
		assert.match(r.stdout, /No drive runs/);
		assert.equal(child.exitCode, null);
		assert.equal(child.signalCode, null);
	} finally {
		child.kill("SIGKILL");
		s.done();
	}
});

test("--stop on a live pid whose command ps cannot read sends no signal, records nothing and exits non-zero; the watcher waits; a start refuses (AC:OPS-137-9) (AC:OPS-137-10)", async () => {
	const s = store();
	const { child } = await pidFileHolder(s.root, task.slug, "main.ts", "drive", "OPS-1");
	try {
		writeFileSync(join(s.root, "fake-bin/ps"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(s.root, "fake-bin/ps"), 0o755);
		const r = realDrive(s, "--stop");
		assert.equal(r.status, 1);
		assert.match(r.stderr, new RegExp(`could not read the command of pid ${child.pid}`));
		assert.equal(s.count("drive_stop_requested"), 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(child.signalCode, null, "no signal reached the process");
		assert.equal(child.exitCode, null);

		assert.deepEqual(driveHolder(s.root, task.slug), { kind: "unread", pid: child.pid });
		const w = watcher(s);
		w.probes.liveDrive = machineWatcher(s.root).liveDrive;
		beat(s, T0);
		w.tick(T0 + 60 * MIN);
		assert.equal(watcherEvents(s), 0);
		assert.deepEqual(w.starts, []);

		const start = realDrive(s);
		assert.notEqual(start.status, 0);
		assert.match(start.stderr, /evf drive already runs for OPS-1/);
	} finally {
		child.kill("SIGKILL");
		s.done();
	}
});

test("--stop exits 0 with a message when the drive ends between the check and the signal (AC:OPS-137-9)", async () => {
	const s = store();
	const { child, exited } = await pidFileHolder(s.root, task.slug, "main.ts", "drive", "OPS-1");
	try {
		// The drive dies during the check. The async spawn lets this test process reap it, so the pid is really gone.
		writeFileSync(
			join(s.root, "fake-bin/ps"),
			`#!/bin/sh\nkill -9 ${child.pid}\nsleep 1\necho "node main.ts drive OPS-1"\n`,
		);
		chmodSync(join(s.root, "fake-bin/ps"), 0o755);
		const stop = spawn(
			process.execPath,
			["--disable-warning=ExperimentalWarning", join(source, "tools/evf/main.ts"), "drive", "OPS-1", "--stop"],
			{ cwd: s.root, env: noSeatEnv() },
		);
		let out = "";
		stop.stdout.on("data", (d) => (out += d));
		const code = await new Promise((resolve) => stop.once("exit", resolve));
		assert.equal(await exited, "SIGKILL");
		assert.equal(code, 0);
		assert.match(out, new RegExp(`No drive runs for OPS-1: pid ${child.pid} ended before the signal`));
		assert.equal(s.events("drive_stop_requested")[0]!.payload.pid, child.pid);
	} finally {
		child.kill("SIGKILL");
		s.done();
	}
});

test("SIGINT never restarts, SIGTERM from any other sender does, and a task with no heartbeat is not watched (AC:OPS-137-9)", () => {
	const interrupted = store();
	try {
		const w = watcher(interrupted);
		beat(interrupted, T0);
		recordDriveStopped(interrupted.root, task, "SIGINT", interrupted.id, probesAt(T0));
		for (let m = 5; m <= 12; m++) w.tick(T0 + m * MIN);
		assert.equal(watcherEvents(interrupted), 0);
		assert.deepEqual(w.starts, []);
	} finally {
		interrupted.done();
	}
	const terminated = store();
	try {
		const w = watcher(terminated);
		beat(terminated, T0);
		recordDriveStopped(terminated.root, task, "SIGTERM", terminated.id, probesAt(T0));
		w.tick(T0 + 5 * MIN);
		assert.equal(terminated.count("drive_restart"), 1);
	} finally {
		terminated.done();
	}
	const old = store();
	try {
		const w = watcher(old);
		for (let m = 5; m <= 12; m++) w.tick(T0 + m * MIN);
		assert.equal(watcherEvents(old), 0);
		assert.deepEqual(w.starts, []);
	} finally {
		old.done();
	}
});

test("a silent drive that is still alive starts nothing, records nothing and uses no restart; a dead pid or another command counts as dead (AC:OPS-137-10)", async () => {
	const s = store();
	try {
		const w = watcher(s);
		w.probes.liveDrive = machineWatcher(s.root).liveDrive;
		beat(s, T0);

		const live = await pidFileHolder(s.root, task.slug, "main.ts", "drive", "OPS-1");
		assert.deepEqual(driveHolder(s.root, task.slug), { kind: "drive", pid: live.child.pid });
		for (const m of [5, 60, 600]) w.tick(T0 + m * MIN);
		assert.equal(watcherEvents(s), 0);
		assert.deepEqual(w.starts, []);
		assert.deepEqual(w.notes, []);
		live.child.kill("SIGKILL");
		await live.exited;

		// A pid that a different command now holds.
		const other = await pidFileHolder(s.root, task.slug, "other.ts");
		assert.deepEqual(driveHolder(s.root, task.slug), { kind: "none" });
		w.tick(T0 + 601 * MIN);
		assert.equal(s.count("drive_restart"), 1, "another command's pid counts as dead");
		other.child.kill("SIGKILL");
		await other.exited;
		assert.deepEqual(driveHolder(s.root, task.slug), { kind: "none" }, "a dead pid counts as dead");
		w.tick(T0 + 606 * MIN);
		assert.equal(s.count("drive_death_alert"), 1);

		// Alive during a second silence: no alert either.
		beat(s, T0 + 700 * MIN);
		w.tick(T0 + 705 * MIN);
		assert.equal(s.count("drive_restart"), 2);
		const back = await pidFileHolder(s.root, task.slug, "main.ts", "drive", "OPS-1");
		w.tick(T0 + 900 * MIN);
		assert.equal(s.count("drive_death_alert"), 1);
		back.child.kill("SIGKILL");
		await back.exited;
	} finally {
		s.done();
	}
});

test("the real restart recovers a drive whose pid another command now holds: the new drive takes the pid file and records a heartbeat (AC:OPS-137-10)", async () => {
	const s = store("pr_open");
	const other = await pidFileHolder(s.root, task.slug, "other.ts");
	try {
		symlinkSync(join(source, "tools/evf/main.ts"), join(s.root, "tools/evf/main.ts"));
		beat(s, Date.now() - 10 * MIN);
		const real = machineWatcher(s.root);
		watcherTick(s.root, {
			...real,
			notify: () => assert.fail("no notification"),
			// A merged row, so that the started drive records its heartbeat and ends by itself.
			startDrive: (ref) => {
				s.db.prepare("UPDATE tasks SET status = 'merged' WHERE id = ?").run(s.id);
				return real.startDrive(ref);
			},
		});
		for (let i = 0; i < 1800 && s.count("drive_ended") === 0; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(s.count("drive_restart"), 1);
		assert.equal(s.count("drive_restart_refused"), 0);
		assert.equal(s.count("drive_ended"), 1, readFileSync(join(evfDataDir(s.root), "drive/ops-1.log"), "utf8"));
		assert.equal(s.count("drive_heartbeat"), 2, "the seeded heartbeat and the new drive's");
		assert.notEqual(s.events("drive_heartbeat")[1]!.payload.pid, other.child.pid);
		assert.equal(other.child.signalCode, null, "the other command gets no signal");
	} finally {
		other.child.kill("SIGKILL");
		s.done();
	}
});

test("heartbeats and drive_ended leave v_tasks' last event alone, heartbeats stay out of the recent feed, and retention removes only heartbeats older than 7 days (AC:OPS-137-11)", () => {
	const s = store("pr_open");
	const DAY = 24 * 60 * MIN;
	try {
		s.seed("owner_approval_wait", T0, { summary: "waits for the owner" });
		beat(s, T0 + MIN);
		s.seed("drive_ended", T0 + 2 * MIN, { stage: "done", code: 0, summary: "drive ended" });
		s.seed("drive_stop_requested", T0 + 3 * MIN, { pid: null, summary: "stop requested" });
		const row = s.db.prepare("SELECT last_event, last_event_at FROM v_tasks WHERE id = ?").get(s.id)!;
		assert.deepEqual({ ...row }, { last_event: "owner_approval_wait", last_event_at: iso(T0) });
		// Other readers of the view: the ones that count from the events stay as they were.
		const recent = s.db
			.prepare("SELECT type FROM v_recent")
			.all()
			.map((e) => e.type);
		assert.equal(recent.includes("drive_heartbeat"), false);
		assert.ok(recent.includes("drive_ended"));
		const status = cli(s.root, {}, "status", "--json");
		const types = (JSON.parse(status.stdout) as { recent: Array<{ type: string }> }).recent.map((e) => e.type);
		assert.ok(types.includes("owner_approval_wait"));
		assert.equal(types.includes("drive_heartbeat"), false);

		const now = T0 + 100 * DAY;
		beat(s, now - 7 * DAY - 1000);
		beat(s, now - 7 * DAY + 1000);
		const kept = [
			"drive_ended",
			"drive_restart",
			"drive_death_alert",
			"drive_restart_refused",
			"drive_stop_requested",
			"drive_stopped",
		];
		for (const type of kept) s.seed(type, now - 60 * DAY);
		const before = Object.fromEntries(kept.map((type) => [type, s.count(type)]));
		applyRetention(s.root, now);
		assert.deepEqual(
			s.events("drive_heartbeat").map((e) => e.ts),
			[iso(now - 7 * DAY + 1000)],
		);
		assert.deepEqual(Object.fromEntries(kept.map((type) => [type, s.count(type)])), before);
	} finally {
		s.done();
	}
});

const samplerProbes = (over: Partial<SamplerProbes> = {}): SamplerProbes => {
	let now = T0;
	return {
		now: () => now,
		sleep: (ms) => {
			now += ms;
		},
		load: () => [1, 1],
		swapUsedGb: () => 0,
		freeMemPct: () => 50,
		previews: () => 0,
		processes: () => [{ pcpu: 1, command: "node" }],
		fullChecks: () => 0,
		...over,
	};
};

test("the watcher ticks once per minute in the sampler; either one's failure leaves the other whole; EVF_NO_SAMPLER runs no watcher (AC:OPS-137-12)", () => {
	const s = store();
	const saved = process.env.EVF_NO_SAMPLER;
	delete process.env.EVF_NO_SAMPLER;
	const lines = (file: string) => {
		const path = join(evfDataDir(s.root), file);
		return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
	};
	const ticks = () => s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'queue_tick'").get()!.n;
	try {
		// A failing watcher: every sampler record is still there.
		let calls = 0;
		const failing: WatcherProbes = {
			now: () => {
				calls++;
				throw new Error("watcher failure");
			},
			liveDrive: () => false,
			startDrive: () => null,
			notify: () => {},
		};
		beat(s, T0);
		const savedError = console.error;
		console.error = () => {};
		try {
			runSampler(s.root, samplerProbes(), { ticks: 3, watcher: failing });
		} finally {
			console.error = savedError;
		}
		assert.equal(calls, 3, "one watcher tick per sampler minute");
		assert.equal(lines("load.jsonl"), 3);
		assert.equal(lines("cpu.jsonl"), 3);
		assert.equal(ticks(), 3);

		// A failing sampler: every probe throws, and the watcher still restarts the dead drive.
		const w = watcher(s);
		w.at = T0 + 5 * MIN;
		const broke = () => {
			throw new Error("probe failure");
		};
		runSampler(
			s.root,
			samplerProbes({
				load: broke,
				swapUsedGb: broke,
				freeMemPct: broke,
				previews: broke,
				processes: broke,
				fullChecks: broke,
			}),
			{ ticks: 1, watcher: w.probes },
		);
		assert.equal(s.count("drive_restart"), 1);

		// It reads no sampler record.
		const code = readFileSync(join(source, "tools/evf/drive-watcher.ts"), "utf8");
		assert.doesNotMatch(code, /queue_tick|load\.jsonl|cpu\.jsonl|load_wait/);

		process.env.EVF_NO_SAMPLER = "1";
		calls = 0;
		runSampler(s.root, samplerProbes(), { ticks: 2, watcher: failing });
		assert.equal(calls, 0);
	} finally {
		process.env.EVF_NO_SAMPLER = saved;
		s.done();
	}
});
