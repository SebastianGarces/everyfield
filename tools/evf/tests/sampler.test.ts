import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { ensureTask, openWorkDb, record, workDbPath } from "../db.ts";
import { drive } from "../drive.ts";
import { evfDataDir, parseTask } from "../lib.ts";
import { awaitLoad, countFullChecks } from "../load.ts";
import {
	applyRetention,
	CPU_CLASSES,
	cpuShares,
	ensureSampler,
	machineProbes,
	runSampler,
	samplerTick,
	stopSampler,
	type ProcessRow,
	type SamplerProbes,
} from "../sampler.ts";
import { alive } from "../ship-queue.ts";
import { verify } from "../verify.ts";
import { fixture, source } from "./fixtures.ts";

const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60_000;

const TABLE: ProcessRow[] = [
	{ pcpu: 40, command: "next-server (v16.0.1)" },
	{ pcpu: 20, command: "/opt/node/bin/node --test tools/evf/tests/*.test.ts" },
	{ pcpu: 10, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer" },
	{ pcpu: 5, command: "/repo/node_modules/.bin/tsc --noEmit" },
	{ pcpu: 5, command: "claude --agent evf:implementer" },
	{ pcpu: 10, command: "/usr/libexec/rapportd" },
	{ pcpu: 10, command: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
];
const SHARES = { next: 0.4, "node-test": 0.2, browser: 0.1, tsc: 0.05, claude: 0.05, macOS: 0.1, other: 0.1 };

function fakeProbes(over: Partial<SamplerProbes> = {}, onSleep: (now: number) => void = () => {}): SamplerProbes {
	let now = T0;
	return {
		now: () => now,
		sleep: (ms) => {
			now += ms;
			onSleep(now);
		},
		load: () => [3.456, 2.25],
		swapUsedGb: () => 1.5,
		freeMemPct: () => 40,
		previews: () => 2,
		processes: () => TABLE,
		fullChecks: () => 1,
		startCheckPoll: () => {},
		...over,
	};
}

function readLines(root: string, file: string): Array<Record<string, unknown>> {
	const path = join(evfDataDir(root), file);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function eventsOf(root: string, type: string): Array<{ task_id: number | null; ts: string; payload: any }> {
	const db = openWorkDb(root);
	try {
		return (
			db.prepare("SELECT task_id, ts, payload FROM events WHERE type = ? ORDER BY id").all(type) as Array<{
				task_id: number | null;
				ts: string;
				payload: string;
			}>
		).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
	} finally {
		db.close();
	}
}

function storeWith<T>(root: string, sql: (db: ReturnType<typeof openWorkDb>) => T): T {
	const db = openWorkDb(root);
	try {
		return sql(db);
	} finally {
		db.close();
	}
}

function escalate(root: string, ref: string): void {
	storeWith(root, (db) => {
		const row = ensureTask(db, parseTask(ref), "implement");
		db.prepare("UPDATE tasks SET status = 'escalated' WHERE id = ?").run(row.id);
	});
}

/** A task row in the given status, with the runs given as `stage:role:status`. Returns its row id. */
function addTask(
	db: ReturnType<typeof openWorkDb>,
	ref: string,
	opts: { status?: string; mode?: string; spec?: string | null; runs?: string[] } = {},
): number {
	const ts = iso(T0);
	const id = Number(
		db
			.prepare("INSERT INTO tasks (slug, mode, ref, status, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(ref.toLowerCase(), opts.mode ?? "implement", ref, opts.status ?? "new", opts.spec ?? null, ts, ts)
			.lastInsertRowid,
	);
	for (const r of opts.runs ?? []) {
		const [stage, role, status] = r.split(":");
		db.prepare("INSERT INTO runs (task_id, stage, role, status, started_at) VALUES (?, ?, ?, ?, ?)").run(
			id,
			stage!,
			role!,
			status!,
			ts,
		);
	}
	return id;
}

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "", ...env },
	});

const lockOf = (root: string) => join(evfDataDir(root), "sampler.lock");
const lockPidOf = (root: string) => Number(readFileSync(lockOf(root), "utf8").trim());
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

/** Ends any real sampler a test started, also when an assertion failed first. */
function cleanUp(root: string): void {
	if (!existsSync(lockOf(root))) return;
	const pid = lockPidOf(root);
	if (pid !== process.pid && alive(pid)) process.kill(pid, "SIGKILL");
}

function waitFor(what: string, ok: () => boolean, ms = 90_000): void {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`);
		spawnSync("sleep", ["0.1"]);
	}
}

/** A load gate fixture: `limit` from the real default formula, a probe that replays `loads` on a fake clock. */
function gateFixture() {
	const f = fixture(),
		limit = 2 * availableParallelism();
	f.cfg.machineLoad = { maxPerCore: 2, maxWaitMinutes: 3 };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	const replay = (loads: number[]) => {
		let now = T0,
			read = 0;
		return {
			read: () => loads[Math.min(read++, loads.length - 1)]!,
			sleep: (ms: number) => (now += ms),
			now: () => now,
		};
	};
	return { f, limit, replay };
}

/** Silence what `fn` prints. Its stderr lines go to `printed`. */
function quiet<T>(fn: () => T, printed: string[] = []): T {
	const error = console.error,
		log = console.log;
	console.error = (...args) => printed.push(args.join(" "));
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.error = error;
		console.log = log;
	}
}

test("three fake minutes write three load lines with exactly the listed fields and values (AC:OPS-133-1)", () => {
	const f = fixture();
	try {
		storeWith(f.root, (db) => addTask(db, "OPS-50", { status: "active", runs: ["implement:implementer:started"] }));
		runSampler(f.root, fakeProbes(), { ticks: 3 });
		const line = (minute: number) => ({
			at: iso(T0 + minute * 60_000),
			load1: 3.46,
			load5: 2.25,
			swapUsedGb: 1.5,
			freeMemPct: 40,
			seats: 1,
			fullChecks: 1,
			previews: 2,
		});
		assert.deepEqual(readLines(f.root, "load.jsonl"), [line(0), line(1), line(2)]);
		assert.equal(existsSync(lockOf(f.root)), false, "a bounded run leaves no lock");
	} finally {
		f.close();
	}
});

test("the machine probes read ps, sysctl and portless output into the record fields (AC:OPS-133-1)", () => {
	const f = fixture(),
		bin = join(f.root, "probe-bin"),
		path = process.env.PATH;
	try {
		mkdirSync(bin);
		const script = (name: string, body: string) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		};
		script(
			"sysctl",
			`if [ "$2" = vm.swapusage ]; then echo "total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)"; else echo 37; fi`,
		);
		script(
			"portless",
			`echo '[{"state":"ready"},{"state":"starting"},{"state":"removed"},{"state":"failed"},{"state":"expired"}]'`,
		);
		script("ps", `printf ' 75.0 next-server (v16)\\n 25,0 /usr/sbin/cfprefsd\\n'`);
		process.env.PATH = `${bin}${delimiter}${path}`;
		const probes = machineProbes(f.root);
		assert.equal(probes.swapUsedGb(), 0.5);
		assert.equal(probes.freeMemPct(), 37);
		assert.equal(probes.previews(), 2);
		assert.deepEqual(probes.processes(), [
			{ pcpu: 75, command: "next-server (v16)" },
			{ pcpu: 25, command: "/usr/sbin/cfprefsd" },
		]);
	} finally {
		process.env.PATH = path;
		f.close();
	}
});

test("fullChecks counts a live full verify, also one inside a drive's own process, and never a quick one (AC:OPS-133-1)", () => {
	const f = fixture(),
		task = parseTask("OPS-1"),
		seen = join(f.root, "fake-bin/seen.json");
	try {
		const marks = join(evfDataDir(f.root), "full-checks");
		const record = `const fs=require("node:fs");const dir=${JSON.stringify(marks)};fs.appendFileSync(${JSON.stringify(seen)},(fs.existsSync(dir)?fs.readdirSync(dir).length:0)+"\\n")`;
		f.cfg.checks = [{ name: "fixture-check", run: [process.execPath, "-e", record] }, ...f.cfg.checks.slice(1)];
		f.cfg.maintenanceTasks = {
			[task.id]: { title: "Upkeep", owningPaths: ["tools/evf/"], checks: f.cfg.checks },
		};
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		f.task(task.slug);
		quiet(() => verify(f.root, task, "author", "full"));
		assert.equal(readFileSync(seen, "utf8"), "1\n", "the verify inside this process counts while its checks run");
		assert.equal(countFullChecks(f.root), 0, "the mark goes when verify ends");
		rmSync(seen);
		quiet(() => verify(f.root, task, "author", "quick"));
		assert.equal(readFileSync(seen, "utf8"), "0\n", "a quick verify does not count");

		mkdirSync(marks, { recursive: true });
		writeFileSync(join(marks, String(deadPid())), "");
		writeFileSync(join(marks, String(process.pid)), "");
		assert.equal(countFullChecks(f.root), 1, "a killed verify does not count");
		assert.deepEqual(readdirSync(marks), [String(process.pid)]);
	} finally {
		f.close();
	}
});

test("the same tick writes one cpu line with each class's share, and an unmatched process is other (AC:OPS-133-2)", () => {
	const f = fixture();
	try {
		runSampler(f.root, fakeProbes(), { ticks: 2 });
		assert.deepEqual(readLines(f.root, "cpu.jsonl"), [
			{ at: iso(T0), ...SHARES },
			{ at: iso(T0 + 60_000), ...SHARES },
		]);
		const one = (command: string) => {
			const shares = cpuShares([{ pcpu: 7, command }]);
			return CPU_CLASSES.find((c) => shares[c] === 1);
		};
		for (const [command, name] of [
			["/opt/node/bin/node /repo/apps/web/.next/dev/build/chunks/pool_entry.js 53161", "next"],
			["/opt/node/bin/node /repo/node_modules/next/dist/bin/next dev", "next"],
			["node --test-concurrency=0 tools/evf/tests/a.test.ts", "node-test"],
			["/opt/node/bin/node /repo/node_modules/typescript/bin/tsc --noEmit", "tsc"],
			["/Users/x/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless", "browser"],
			["/Users/x/.local/share/claude/versions/2.1.0 --agent x", "claude"],
			["kernel_task", "macOS"],
			["/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon", "macOS"],
			// An argument never gives a class to a program that is not node.
			[`claude -p "fix next tsc Chrome"`, "claude"],
			["git -C /repo/next-worktree add .", "other"],
			["/Users/x/dev/tool --flag /Applications/Google Chrome.app/", "other"],
			["node /repo/tools/evf/main.ts verify OPS-1", "other"],
			["some-unknown-program", "other"],
		] as const)
			assert.equal(one(command), name, command);
		assert.deepEqual(
			cpuShares([{ pcpu: 0, command: "next-server" }]),
			{ next: 0, "node-test": 0, browser: 0, tsc: 0, claude: 0, macOS: 0, other: 0 },
			"no CPU in use reads 0, not a division by zero",
		);
	} finally {
		f.close();
	}
});

test("a second sampler on one data folder writes no line, so each minute has one (AC:OPS-133-3)", () => {
	const f = fixture();
	try {
		const probes = fakeProbes({}, () => runSampler(f.root, fakeProbes(), { ticks: 3 }));
		runSampler(f.root, probes, { ticks: 3 });
		assert.deepEqual(
			readLines(f.root, "load.jsonl").map((l) => l.at),
			[0, 1, 2].map((m) => iso(T0 + m * 60_000)),
		);
		assert.equal(readLines(f.root, "cpu.jsonl").length, 3);
	} finally {
		f.close();
	}
});

test("a dead pid, or a live pid that runs another command, in the lock does not block the next start (AC:OPS-133-3)", () => {
	const f = fixture();
	try {
		mkdirSync(evfDataDir(f.root), { recursive: true });
		for (const stale of [deadPid(), process.ppid]) {
			writeFileSync(lockOf(f.root), `${stale}\n`);
			runSampler(f.root, fakeProbes(), { ticks: 1 });
		}
		assert.equal(readLines(f.root, "load.jsonl").length, 2);
		assert.ok(alive(process.ppid), "the stale check signals nobody");
	} finally {
		f.close();
	}
});

test("a sampler whose lock no longer names it stops before its next tick (AC:OPS-133-3)", () => {
	const f = fixture();
	try {
		const probes = fakeProbes({}, () => writeFileSync(lockOf(f.root), `${deadPid()}\n`));
		runSampler(f.root, probes, { ticks: 5 });
		assert.equal(readLines(f.root, "load.jsonl").length, 1);
	} finally {
		f.close();
	}
});

test("evf sampler start runs one detached process; a second start says so and exits 0; stop ends it (AC:OPS-133-3) (AC:OPS-133-11)", () => {
	const f = fixture();
	try {
		const first = cli(f.root, {}, "sampler", "start");
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /Sampler started \(pid \d+\)/);
		const pid = lockPidOf(f.root);
		assert.ok(alive(pid));
		const second = cli(f.root, {}, "sampler", "start");
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, new RegExp(`already runs \\(pid ${pid}\\)`));
		waitFor("the first line", () => readLines(f.root, "cpu.jsonl").length > 0);
		assert.equal(readLines(f.root, "load.jsonl").length, 1, "one sampler, one line");
		assert.deepEqual(Object.keys(readLines(f.root, "load.jsonl")[0]!), [
			"at",
			"load1",
			"load5",
			"swapUsedGb",
			"freeMemPct",
			"seats",
			"fullChecks",
			"previews",
		]);
		assert.equal(eventsOf(f.root, "queue_tick").length, 1);

		const stop = cli(f.root, {}, "sampler", "stop");
		assert.equal(stop.status, 0, stop.stderr);
		assert.equal(existsSync(lockOf(f.root)), false, "stop removes the lock");
		waitFor("the sampler to end", () => !alive(pid), 10_000);
		const again = cli(f.root, {}, "sampler", "stop");
		assert.equal(again.status, 0, "stop exits 0 when none runs");
		assert.match(again.stdout, /No sampler runs/);
	} finally {
		cleanUp(f.root);
		f.close();
	}
});

test("a start from a worktree runs the home checkout's code, so queue_tick outlives that worktree (AC:OPS-133-7)", () => {
	const f = fixture(),
		home = join(f.root, "tools/evf/main.ts");
	try {
		mkdirSync(join(f.root, "tools/evf"), { recursive: true });
		writeFileSync(home, `await import(${JSON.stringify(join(source, "tools/evf/main.ts"))});\n`);
		const start = cli(f.root, {}, "sampler", "start");
		assert.equal(start.status, 0, start.stderr);
		const ps = spawnSync("ps", ["-p", String(lockPidOf(f.root)), "-wwo", "command="], { encoding: "utf8" });
		assert.match(ps.stdout, new RegExp(`${home.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")} sampler run`));
		waitFor("the first queue_tick", () => eventsOf(f.root, "queue_tick").length > 0);
		assert.equal(cli(f.root, {}, "sampler", "stop").status, 0);
	} finally {
		cleanUp(f.root);
		f.close();
	}
});

test("cpu.jsonl holds no command text: each line has only at and the class keys (AC:OPS-133-4)", () => {
	const f = fixture(),
		marker = "MARKER-7f3a91-secret-arg";
	try {
		const processes = () => [
			{ pcpu: 60, command: `/opt/node/bin/node --test ${marker}.test.ts --token=${marker}` },
			{ pcpu: 40, command: `some-program ${marker}` },
		];
		runSampler(f.root, fakeProbes({ processes }), { ticks: 2 });
		const text = readFileSync(join(evfDataDir(f.root), "cpu.jsonl"), "utf8");
		assert.equal(text.includes(marker), false);
		const lines = readLines(f.root, "cpu.jsonl");
		assert.equal(lines.length, 2);
		for (const line of lines) assert.deepEqual(Object.keys(line), ["at", ...CPU_CLASSES]);
		assert.equal(lines[0]!["node-test"], 0.6);
		assert.equal(lines[0]!.other, 0.4);
	} finally {
		f.close();
	}
});

test("a wait records one load_wait with the highest load, ended under the limit or given up (AC:OPS-133-5)", () => {
	const { f, limit, replay } = gateFixture();
	try {
		const taskId = storeWith(f.root, (db) => ensureTask(db, parseTask("OPS-7"), "implement").id);
		quiet(() =>
			awaitLoad(f.root, "verify", undefined, replay([limit + 3, limit + 9, limit + 4, limit - 1]), parseTask("OPS-7")),
		);
		const [ended] = eventsOf(f.root, "load_wait");
		assert.equal(ended!.task_id, taskId);
		assert.deepEqual(ended!.payload, {
			command: "verify",
			task: "OPS-7",
			startAt: iso(T0),
			endAt: iso(T0 + 45_000),
			maxLoad: limit + 9,
		});

		assert.throws(
			() => quiet(() => awaitLoad(f.root, "browser run", undefined, replay([limit + 2, limit + 8, limit + 1]))),
			/stayed above its load limit for 3 min/,
		);
		const [, gaveUp] = eventsOf(f.root, "load_wait");
		assert.equal(gaveUp!.task_id, null);
		assert.deepEqual(gaveUp!.payload, {
			command: "browser run",
			task: null,
			startAt: iso(T0),
			endAt: iso(T0 + 180_000),
			maxLoad: limit + 8,
		});
		assert.equal(eventsOf(f.root, "load_wait").length, 2);

		quiet(() => awaitLoad(f.root, "verify", undefined, replay([limit + 1, limit]), parseTask("OPS-8")));
		const noRow = eventsOf(f.root, "load_wait").at(-1)!;
		assert.equal(noRow.task_id, null, "a task with no store row has a null task_id");
		assert.equal(noRow.payload.task, "OPS-8", "and keeps its task in the payload");
	} finally {
		f.close();
	}
});

test("each awaitLoad caller that knows its task passes it, and evf browser run records null (AC:OPS-133-5)", () => {
	const f = fixture(),
		task = parseTask("OPS-1");
	try {
		f.cfg.maintenanceTasks = { [task.id]: { title: "Upkeep", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		const wt = f.task(task.slug);
		f.cfg.machineLoad = { maxPerCore: 1e-9, maxWaitMinutes: 0 };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		storeWith(f.root, () => {}); // The store exists, as it does on any machine that ran a drive.
		assert.throws(() => verify(f.root, task, "author", "full"), /stayed above its load limit/);
		assert.notEqual(cli(f.root, {}, "browser", "run", "--", "true").status, 0);
		assert.notEqual(cli(f.root, {}, "timing", "OPS-1", "--set", "unused.json").status, 0);
		rmSync(wt, { recursive: true, force: true });
		f.git("worktree", "prune");
		f.git("branch", "-qD", task.branch);
		const start = cli(f.root, {}, "task", "start", "OPS-1", "--no-stack");
		assert.match(start.stderr, /stayed above its load limit/, start.stderr);
		assert.deepEqual(
			eventsOf(f.root, "load_wait").map((e) => [e.payload.command, e.payload.task]),
			[
				["verify", "OPS-1"],
				["browser run", null],
				["timing", "OPS-1"],
				["task start", "OPS-1"],
			],
		);
	} finally {
		f.close();
	}
});

test("no load_wait under the limit on the first read or for --ignore-load; a failed write changes nothing (AC:OPS-133-6)", () => {
	const { f, limit, replay } = gateFixture();
	try {
		storeWith(f.root, () => {}); // The store exists, so zero events below is not the missing-store path.
		awaitLoad(f.root, "verify", undefined, replay([limit - 1]), parseTask("OPS-7"));
		awaitLoad(f.root, "verify", undefined, replay([limit]));
		quiet(() => awaitLoad(f.root, "verify", "owner asked", replay([limit + 50]), parseTask("OPS-7")));
		assert.deepEqual(eventsOf(f.root, "load_wait"), []);
		const overrides = readLines(f.root, "load-overrides.jsonl");
		assert.deepEqual(
			overrides.map((o) => [o.command, o.load, o.reason]),
			[["verify", limit + 50, "owner asked"]],
		);

		// A missing store: the wait ends as it would, and the gate does not create a store.
		const store = workDbPath(f.root);
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${store}${suffix}`, { force: true });
		quiet(() => awaitLoad(f.root, "verify", undefined, replay([limit + 1, limit - 1])));
		assert.equal(existsSync(store), false);
		assert.throws(
			() => quiet(() => awaitLoad(f.root, "verify", undefined, replay([limit + 1]))),
			/stayed above its load limit/,
		);

		// A store that cannot open: the same two results, and the refusal stays the load refusal.
		mkdirSync(store);
		const printed: string[] = [];
		quiet(() => {
			awaitLoad(f.root, "verify", undefined, replay([limit + 1, limit - 1]));
			assert.throws(() => awaitLoad(f.root, "verify", undefined, replay([limit + 1])), /stayed above its load limit/);
		}, printed);
		assert.ok(printed.some((l) => /load_wait not recorded/.test(l)));
	} finally {
		f.close();
	}
});

/** The ten kinds the criterion names, and 13 started seats on one task plus one evf stage run that is not a seat. */
function addEveryKind(db: ReturnType<typeof openWorkDb>): void {
	addTask(db, "OPS-60"); // Runnable: nextStage names plan.
	addTask(db, "OPS-61", { status: "active", spec: "# OPS-61\n\n## Later slices\n\n1. A later slice\n" }); // Blocked.
	addTask(db, "OPS-62", { status: "escalated" });
	addTask(db, "OPS-63", {
		mode: "prototype",
		status: "awaiting_pick",
		spec: "# OPS-63",
		runs: ["idea1", "idea2", "idea3", "compare"].map((s) => `${s}:ideator:passed`),
	}); // Waiting for Sebastian's pick.
	addTask(db, "OPS-64", { status: "queued", spec: "# OPS-64" });
	addTask(db, "OPS-65", {
		status: "active",
		runs: [...Array.from({ length: 13 }, () => "implement:implementer:started"), "pr:evf:started"],
	});
	addTask(db, "OPS-66", { status: "merged" });
	addTask(db, "OPS-67", { status: "done" });
	addTask(db, "OPS-68", { status: "abandoned" });
	addTask(db, "OPS-69", { status: "active", runs: ["pr:evf:started"] }); // A started evf run: in neither, and no seat.
	addTask(db, "OPS-59", { status: "held_external", spec: "# OPS-59", runs: ["ci:evf:failed"] }); // nextStage says held.
}

test("queue_tick counts every kind of task once and slotsFree stops at 0 with 13 seats (AC:OPS-133-7)", () => {
	const f = fixture();
	try {
		storeWith(f.root, addEveryKind);
		runSampler(f.root, fakeProbes(), { ticks: 2 });
		const ticks = eventsOf(f.root, "queue_tick");
		assert.equal(ticks.length, 2, "one queue_tick per minute");
		assert.equal(ticks[0]!.task_id, null);
		assert.deepEqual(ticks[0]!.payload, {
			runnable: 1,
			held: 5,
			holdReasons: { blocked: 2, escalated: 1, waiting: 1, queued: 1 },
			seats: 13,
			slotsFree: 0,
			load: 3.46,
		});
	} finally {
		f.close();
	}
});

test("slotsFree reads 9 with 3 seats, and a later stage evf runs itself counts as runnable (AC:OPS-133-7)", () => {
	const f = fixture();
	try {
		storeWith(f.root, (db) => {
			addTask(db, "OPS-70", {
				status: "active",
				runs: ["implement:implementer:started", "verify:verifier:started", "simplify:simplifier:started"],
			});
			addTask(db, "OPS-71", { status: "pr_open", spec: "# OPS-71", runs: ["pr:evf:passed", "verify:verifier:passed"] });
			addTask(db, "OPS-72", { status: "active", spec: "# OPS-72", runs: ["ship:evf:passed"] }); // nextStage says done.
		});
		runSampler(f.root, fakeProbes(), { ticks: 1 });
		const { payload } = eventsOf(f.root, "queue_tick")[0]!;
		assert.equal(payload.seats, 3);
		assert.equal(payload.slotsFree, 9);
		assert.equal(payload.runnable, 1);
		assert.equal(payload.held, 0);
	} finally {
		f.close();
	}
});

test("a started headless run is no seat and leaves its task in the count (AC:OPS-134-11)", () => {
	const f = fixture();
	try {
		storeWith(f.root, (db) => {
			addTask(db, "OPS-70", { status: "active", runs: ["implement:implementer:started"] });
			addTask(db, "OPS-71", {
				status: "pr_open",
				spec: "# OPS-71",
				runs: ["pr:evf:passed", "coordinator:coordinator:started"],
			});
			addTask(db, "OPS-72", {
				status: "pr_open",
				spec: "# OPS-72",
				runs: ["pr:evf:passed", "registration:registration:started"],
			});
		});
		runSampler(f.root, fakeProbes(), { ticks: 1 });
		const { payload } = eventsOf(f.root, "queue_tick")[0]!;
		assert.equal(payload.seats, 1);
		assert.equal(payload.runnable, 2);
	} finally {
		f.close();
	}
});

test("a held_external task is held, and counts as runnable again once its hold ends (AC:OPS-133-7)", () => {
	const f = fixture();
	try {
		const held = storeWith(f.root, (db) => {
			const id = addTask(db, "OPS-73", {
				status: "held_external",
				spec: "# OPS-73",
				runs: ["implement:implementer:passed", "ci:evf:failed"],
			});
			record(db, id, null, "held_external", { cause: "main", checks: ["app"], head: null, summary: "main fails" });
			return id;
		});
		runSampler(f.root, fakeProbes(), { ticks: 1 });
		assert.deepEqual(eventsOf(f.root, "queue_tick")[0]!.payload, {
			runnable: 0,
			held: 1,
			holdReasons: { blocked: 1, escalated: 0, waiting: 0, queued: 0 },
			seats: 0,
			slotsFree: 12,
			load: 3.46,
		});
		storeWith(f.root, (db) => db.prepare("UPDATE tasks SET status = 'pr_open' WHERE id = ?").run(held));
		runSampler(f.root, fakeProbes(), { ticks: 1 });
		const released = eventsOf(f.root, "queue_tick")[1]!.payload;
		assert.equal(released.runnable, 1);
		assert.equal(released.held, 0);
	} finally {
		f.close();
	}
});

test("evf status and its recent feed leave out queue_tick but keep load_wait (AC:OPS-133-7)", () => {
	const { f, limit, replay } = gateFixture();
	try {
		runSampler(f.root, fakeProbes(), { ticks: 60 });
		quiet(() => awaitLoad(f.root, "verify", undefined, replay([limit + 1, limit - 1])));
		const status = cli(f.root, {}, "status", "--json");
		const types = (JSON.parse(status.stdout) as { recent: Array<{ type: string }> }).recent.map((e) => e.type);
		assert.ok(types.includes("load_wait"));
		assert.equal(types.includes("queue_tick"), false);
	} finally {
		f.close();
	}
});

test("retention removes only what is older than 30 days, through a rename (AC:OPS-133-8)", () => {
	const f = fixture();
	try {
		const dir = evfDataDir(f.root);
		mkdirSync(dir, { recursive: true });
		const old = iso(T0 - 30 * DAY - 1),
			edge = iso(T0 - 30 * DAY),
			fresh = iso(T0 - DAY);
		const kept = [
			JSON.stringify({ at: edge, load1: 2 }),
			JSON.stringify({ at: fresh, load1: 3 }),
			"not json at all",
			JSON.stringify({ at: "not a time", load1: 4 }),
			JSON.stringify({ load1: 5 }),
		];
		for (const file of ["load.jsonl", "cpu.jsonl"])
			writeFileSync(join(dir, file), [JSON.stringify({ at: old, load1: 1 }), ...kept].join("\n") + "\n");
		const before = statSync(join(dir, "load.jsonl")).ino;
		const insert = (type: string, ts: string) =>
			storeWith(f.root, (db) => db.prepare("INSERT INTO events (ts, type, payload) VALUES (?, ?, '{}')").run(ts, type));
		for (const type of ["queue_tick", "load_wait", "merged"]) {
			insert(type, old);
			insert(type, edge);
			insert(type, fresh);
		}
		applyRetention(f.root, T0);

		for (const file of ["load.jsonl", "cpu.jsonl"])
			assert.equal(readFileSync(join(dir, file), "utf8"), kept.join("\n") + "\n", file);
		assert.notEqual(statSync(join(dir, "load.jsonl")).ino, before, "a new file replaces the old one");
		assert.deepEqual(
			readdirSync(dir).filter((n) => n.endsWith(".tmp")),
			[],
		);
		for (const type of ["queue_tick", "load_wait"])
			assert.deepEqual(
				eventsOf(f.root, type).map((e) => e.ts),
				[edge, fresh],
				type,
			);
		assert.deepEqual(
			eventsOf(f.root, "merged").map((e) => e.ts),
			[old, edge, fresh],
			"another event type stays",
		);
	} finally {
		f.close();
	}
});

test("the sampler applies retention at start and then once per hour (AC:OPS-133-8)", () => {
	const f = fixture();
	try {
		const dir = evfDataDir(f.root);
		mkdirSync(dir, { recursive: true });
		const stale = JSON.stringify({ at: iso(T0 - 40 * DAY), load1: 1 });
		const staleCount = () => readLines(f.root, "load.jsonl").filter((l) => l.load1 === 1).length;
		writeFileSync(join(dir, "load.jsonl"), `${stale}\n`);
		const seen: number[] = [];
		let minute = 0;
		const probes = fakeProbes({}, () => {
			minute++;
			if (minute === 1) {
				assert.equal(staleCount(), 0, "gone at start");
				appendStale();
			}
			if (minute === 59) seen.push(staleCount());
			if (minute === 61) seen.push(staleCount());
		});
		const appendStale = () =>
			writeFileSync(join(dir, "load.jsonl"), `${readFileSync(join(dir, "load.jsonl"), "utf8")}${stale}\n`);
		runSampler(f.root, probes, { ticks: 62 });
		assert.deepEqual(seen, [1, 0], "still there after 59 minutes, gone after the hour");
	} finally {
		f.close();
	}
});

test("the README section states the retention rule and the records, and help names evf sampler (AC:OPS-133-9)", () => {
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8"),
		section = readme.split(/^## /m).find((s) => s.startsWith("Minute sampler"));
	assert.ok(section, "the README has the section");
	assert.match(section, /30 days/);
	for (const needed of [
		".git/evf/load.jsonl",
		".git/evf/cpu.jsonl",
		"queue_tick",
		"load_wait",
		"evf sampler start",
		"evf sampler stop",
		"slotsFree",
		"holdReasons",
		"startAt",
		...CPU_CLASSES,
	])
		assert.ok(section.includes(needed), needed);
	const help = spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "help"], { encoding: "utf8" }).stdout;
	assert.match(help, /evf sampler start \| stop/);
});

test("with no machineLoad setting the limit is 2 × cores and the give-up comes at 30 minutes (AC:OPS-133-10)", () => {
	const f = fixture();
	try {
		delete f.cfg.machineLoad;
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		const limit = 2 * availableParallelism();
		let now = 0,
			gaveUpAt = -1;
		const probe = (load: (ms: number) => number) => {
			now = 0;
			return { read: () => load(now), sleep: (ms: number) => (now += ms), now: () => now };
		};
		quiet(() =>
			awaitLoad(
				f.root,
				"verify",
				undefined,
				probe(() => limit),
			),
		);
		assert.equal(now, 0, "the limit itself runs at once");
		quiet(() =>
			awaitLoad(
				f.root,
				"verify",
				undefined,
				probe((ms) => (ms < 29 * 60_000 ? limit + 1 : limit)),
			),
		);
		assert.equal(now, 29 * 60_000, "a wait under 30 minutes still ends in a run");
		assert.throws(
			() =>
				quiet(() =>
					awaitLoad(
						f.root,
						"verify",
						undefined,
						probe(() => {
							gaveUpAt = now;
							return limit + 1;
						}),
					),
				),
			/stayed above its load limit for 30 min/,
		);
		assert.equal(gaveUpAt, 30 * 60_000);
	} finally {
		f.close();
	}
});

const DRIVE_TIMING = { waitMs: 200, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 10 };

test("a drive calls the sampler start once, and a throwing start leaves the drive running (AC:OPS-133-11)", () => {
	const f = fixture(),
		task = parseTask("OPS-1");
	try {
		escalate(f.root, task.id);
		const calls: string[] = [];
		const clean = quiet(() =>
			drive(f.root, task, { once: true, startSampler: (root) => calls.push(root) }, DRIVE_TIMING),
		);
		assert.deepEqual(calls, [f.root]);
		assert.equal(clean, 2, "the drive reached the stage machine: an escalated task stops with 2");
		const before = eventsOf(f.root, "next").length;

		const printed: string[] = [];
		let thrown = 0;
		const code = quiet(
			() =>
				drive(
					f.root,
					task,
					{
						once: true,
						startSampler: () => {
							thrown++;
							throw new Error("no sampler today");
						},
					},
					DRIVE_TIMING,
				),
			printed,
		);
		assert.equal(thrown, 1);
		assert.equal(code, 2, "the same result as with a working start");
		assert.ok(eventsOf(f.root, "next").length > before, "the stage machine ran after the throw");
		assert.ok(printed.some((l) => /the sampler did not start: Error: no sampler today/.test(l)));
		assert.equal(existsSync(lockOf(f.root)), false, "the fake starters left no real sampler");
	} finally {
		f.close();
	}
});

test("evf drive starts a real sampler through main.ts unless EVF_NO_SAMPLER is set, and stop ends it (AC:OPS-133-11)", () => {
	const f = fixture();
	try {
		escalate(f.root, "OPS-1");
		assert.equal(cli(f.root, {}, "drive", "OPS-1", "--once").status, 2);
		assert.equal(existsSync(lockOf(f.root)), false, "a test's drive starts no sampler");

		const driven = cli(f.root, { EVF_NO_SAMPLER: "" }, "drive", "OPS-1", "--once");
		assert.equal(driven.status, 2, driven.stderr);
		waitFor("the sampler's lock", () => existsSync(lockOf(f.root)));
		const pid = lockPidOf(f.root);
		assert.ok(alive(pid));
		assert.equal(cli(f.root, {}, "sampler", "stop").status, 0);
		waitFor("the sampler to end", () => !alive(pid), 10_000);
	} finally {
		cleanUp(f.root);
		f.close();
	}
});

test("ensureSampler does nothing when a sampler holds the lock, and stop leaves a stranger's pid alone (AC:OPS-133-11)", () => {
	const f = fixture(),
		flag = process.env.EVF_NO_SAMPLER;
	try {
		mkdirSync(evfDataDir(f.root), { recursive: true });
		writeFileSync(lockOf(f.root), `${process.pid}\n`);
		delete process.env.EVF_NO_SAMPLER;
		ensureSampler(f.root);
		assert.equal(lockPidOf(f.root), process.pid, "no second sampler took the lock");
		process.env.EVF_NO_SAMPLER = flag;
		rmSync(lockOf(f.root));
		ensureSampler(f.root);
		assert.equal(existsSync(lockOf(f.root)), false, "the flag keeps a test's drive from spawning");

		writeFileSync(lockOf(f.root), `${process.ppid}\n`);
		assert.equal(
			quiet(() => stopSampler(f.root)),
			0,
		);
		assert.ok(alive(process.ppid), "a reused pid gets no signal");
		assert.equal(existsSync(lockOf(f.root)), false);
	} finally {
		process.env.EVF_NO_SAMPLER = flag;
		f.close();
	}
});

test("a throwing probe writes null in its fields, and the next tick runs (AC:OPS-133-12)", () => {
	const f = fixture();
	try {
		const boom = () => {
			throw new Error("probe failed");
		};
		let n = 0;
		const once =
			<T>(value: T) =>
			() => {
				if (n === 0) return boom();
				return value;
			};
		const probes = fakeProbes(
			{
				load: once<[number, number]>([1, 2]),
				swapUsedGb: once(1),
				freeMemPct: once(50),
				previews: once(3),
				processes: once(TABLE),
				fullChecks: once(0),
			},
			() => n++,
		);
		runSampler(f.root, probes, { ticks: 2 });
		const [broken, healed] = readLines(f.root, "load.jsonl");
		assert.deepEqual(broken, {
			at: iso(T0),
			load1: null,
			load5: null,
			swapUsedGb: null,
			freeMemPct: null,
			seats: 0,
			fullChecks: null,
			previews: null,
		});
		assert.deepEqual(healed, {
			at: iso(T0 + 60_000),
			load1: 1,
			load5: 2,
			swapUsedGb: 1,
			freeMemPct: 50,
			seats: 0,
			fullChecks: 0,
			previews: 3,
		});
		const cpu = readLines(f.root, "cpu.jsonl");
		assert.deepEqual(cpu[0], { at: iso(T0), ...Object.fromEntries(CPU_CLASSES.map((c) => [c, null])) });
		assert.deepEqual(cpu[1], { at: iso(T0 + 60_000), ...SHARES });
		assert.deepEqual(
			eventsOf(f.root, "queue_tick").map((e) => e.payload.load),
			[null, 1],
			"the queue is still counted when load fails",
		);
	} finally {
		f.close();
	}
});

test("a busy store skips that queue_tick and leaves the two files written (AC:OPS-133-12)", () => {
	const f = fixture();
	try {
		const writer = openWorkDb(f.root);
		writer.exec("BEGIN IMMEDIATE");
		try {
			samplerTick(f.root, fakeProbes());
		} finally {
			writer.exec("ROLLBACK");
			writer.close();
		}
		const loadLines = readLines(f.root, "load.jsonl");
		assert.equal(loadLines.length, 1);
		assert.equal(loadLines[0]!.seats, 0, "a read still works under a write lock, so seats is the real count");
		assert.equal(readLines(f.root, "cpu.jsonl").length, 1);
		assert.deepEqual(eventsOf(f.root, "queue_tick"), [], "the tick under the lock wrote no queue_tick");
		samplerTick(f.root, fakeProbes());
		assert.equal(eventsOf(f.root, "queue_tick").length, 1, "the next tick records again");
	} finally {
		f.close();
	}
});

test("a stuck or failing child costs its field: each probe has a timeout and a tick starts no git (AC:OPS-133-12)", () => {
	const f = fixture(),
		bin = join(f.root, "probe-bin"),
		path = process.env.PATH;
	try {
		storeWith(f.root, (db) => {
			// A task whose stored stage would read its worktree with git if the tick asked for that.
			const id = addTask(db, "OPS-80", {
				status: "active",
				spec: "# OPS-80",
				runs: ["simplify:simplifier:passed", "implement:implementer:passed"],
			});
			db.prepare("UPDATE tasks SET worktree = ? WHERE id = ?").run(f.root, id);
			db.prepare("UPDATE runs SET progress_head = 'abc' WHERE task_id = ? AND stage = 'simplify'").run(id);
		});
		mkdirSync(bin);
		for (const [name, body] of [
			["ps", "exec sleep 30"],
			["sysctl", "exit 3"],
			["portless", "echo not-json"],
			["git", "echo git-called >> " + JSON.stringify(join(f.root, "git-called")) + "\nexec sleep 30"],
		] as const) {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(bin, name), 0o755);
		}
		evfDataDir(f.root); // A sampler reads its data folder once, before its first tick.
		process.env.PATH = `${bin}${delimiter}${path}`;
		const real = machineProbes(f.root, 300);
		const started = Date.now();
		samplerTick(f.root, {
			...fakeProbes(),
			swapUsedGb: real.swapUsedGb,
			freeMemPct: real.freeMemPct,
			previews: real.previews,
			processes: real.processes,
		});
		assert.ok(Date.now() - started < 15_000, "the stuck ps ended at its timeout");
		process.env.PATH = path;
		const [line] = readLines(f.root, "load.jsonl");
		assert.deepEqual([line!.swapUsedGb, line!.freeMemPct, line!.previews], [null, null, null]);
		assert.equal(line!.load1, 3.46, "the other fields still read");
		assert.equal(readLines(f.root, "cpu.jsonl")[0]!.next, null);
		assert.equal(existsSync(join(f.root, "git-called")), false, "the tick starts no git");
		assert.equal(eventsOf(f.root, "queue_tick")[0]!.payload.runnable, 1);
	} finally {
		process.env.PATH = path;
		f.close();
	}
});
