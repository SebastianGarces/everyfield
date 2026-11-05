import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, fakeClock, fixture } from "./fixtures.ts";
import { ensureTask, openWorkDb, syncGoals } from "../db.ts";
import { drive, driveOnce, taskReopen } from "../drive.ts";
import { evfDataDir, evidenceDir, git, parseTask, runtimeDir } from "../lib.ts";
import { hasVerifiedHead } from "../verify.ts";
import { CHECK_CAP, checkQueueWaiting } from "../check-queue.ts";
import { releaseWait, testPaths } from "../brake.ts";

const TEST = "AC:OPS-125-8 shared test";
const FILE = "tests/workflow/broken.test.ts";
const MIN = 60_000;
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 150, holdPollMs: 10 };

/** The check every branch runs: it reports TEST failed until main's fix reaches the branch. */
const brokenCheck = {
	name: "shared-tests",
	run: [
		process.execPath,
		"-e",
		`const fs=require("node:fs");const fixed=fs.existsSync("tests/workflow/fix.txt");fs.writeFileSync(process.env.EVF_TEST_REPORT,JSON.stringify({tests:[{name:${JSON.stringify(TEST)},file:${JSON.stringify(FILE)},status:fixed?"passed":"failed"}]}));process.exit(fixed?0:1)`,
	],
};

/** A store with one worktree per ref. Each sits before its pr stage, with a commit of its own. */
function brakeFixture(refs: string[], touching: string[] = []) {
	const f = fixture();
	f.cfg.maintenanceTasks = Object.fromEntries(
		refs.map((ref) => [ref, { title: "Brake", owningPaths: ["tools/evf/", "tests/workflow/"], checks: [brokenCheck] }]),
	);
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	f.commit();
	const notices = join(f.root, "notices.json");
	writeFileSync(notices, "[]");
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a[0]==="notification"){const n=JSON.parse(fs.readFileSync(${JSON.stringify(notices)},"utf8"));n.push(a.join(" "));fs.writeFileSync(${JSON.stringify(notices)},JSON.stringify(n))}process.stdout.write("{}")\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
	const db = openWorkDb(f.root);
	syncGoals(f.root, db);
	const tasks = Object.fromEntries(
		refs.map((ref) => {
			const task = parseTask(ref),
				wt = f.task(task.slug),
				id = ensureTask(db, task, "implement").id;
			db.prepare("UPDATE tasks SET worktree = ?, spec = 'Goal: x.', status = 'active' WHERE id = ?").run(wt, id);
			for (const stage of ["implement", "simplify"])
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, ?, 0, 'passed', ?)",
				).run(id, stage, stage === "implement" ? "implementer" : "simplifier", new Date().toISOString());
			mkdirSync(runtimeDir(f.root, task), { recursive: true });
			writeFileSync(join(runtimeDir(f.root, task), "pr-body.md"), "body");
			const path = touching.includes(ref) ? `tests/workflow/${task.slug}.txt` : `tools/evf/${task.slug}.txt`;
			mkdirSync(join(wt, "tests/workflow"), { recursive: true });
			writeFileSync(join(wt, path), ref);
			git(wt, "add", path);
			git(wt, "commit", "-qm", `${ref} work`);
			return [ref, { task, wt, id }];
		}),
	);
	const row = (ref: string) =>
		db.prepare("SELECT status, round FROM tasks WHERE id = ?").get(tasks[ref].id) as { status: string; round: number };
	const types = (type: string) =>
		(db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY id").all(type) as Array<{ payload: string }>).map(
			(e) => JSON.parse(e.payload) as Record<string, any>,
		);
	const runs = (ref: string) =>
		(
			db.prepare("SELECT stage, status FROM runs WHERE task_id = ? ORDER BY id").all(tasks[ref].id) as Array<{
				stage: string;
				status: string;
			}>
		).map((r) => ({ ...r }));
	const pass = (ref: string, release?: object) => {
		const { log, error } = console;
		console.log = console.error = () => {};
		try {
			return driveOnce(f.root, tasks[ref].task, { ...TIMING, ...(release ? { release } : {}) } as never);
		} finally {
			console.log = log;
			console.error = error;
		}
	};
	/** Merges the fix to main and ends the brake, as the coordinator does. */
	const fix = (name = "tests/workflow/fix.txt") => {
		mkdirSync(join(f.root, "tests/workflow"), { recursive: true });
		writeFileSync(join(f.root, name), "fixed");
		f.git("add", name);
		f.git("commit", "-qm", "the fix");
		return f.git("rev-parse", "HEAD");
	};
	const brakeId = () =>
		(db.prepare("SELECT MAX(id) AS id FROM events WHERE type = 'brake_tripped'").get() as { id: number }).id;
	const close = () => {
		db.close();
		f.close();
	};
	return {
		...f,
		db,
		tasks,
		row,
		types,
		runs,
		pass,
		fix,
		brakeId,
		close,
		notices: () => JSON.parse(readFileSync(notices, "utf8")) as string[],
	};
}
type Fixture = ReturnType<typeof brakeFixture>;

/** A fake machine: a clock, the load and the queue length the release gate reads. */
const machine = (load = 1, waiting = 0) => {
	const clock = fakeClock();
	const m = { load, waiting };
	return { m, clock, probe: { now: clock.now, load: () => m.load, waiting: () => m.waiting } };
};

test("AC:OPS-141-1 one test failing on 2 branches that do not touch its paths holds those rounds, and a seat that closes later holds too", () => {
	const f = brakeFixture(["OPS-1", "OPS-2", "OPS-3"]);
	try {
		// The first branch alone is an ordinary failure: its implementer may look at it.
		f.pass("OPS-1");
		assert.deepEqual(f.runs("OPS-1").at(-1), { stage: "pr", status: "failed" });
		assert.equal(f.row("OPS-1").status, "active");
		assert.equal(f.types("brake_tripped").length, 0);

		// The second branch trips the brake in its own pr stage: no failed run and no round.
		f.pass("OPS-2");
		assert.equal(f.row("OPS-2").status, "held_external");
		assert.equal(f.row("OPS-2").round, 0);
		assert.deepEqual(f.runs("OPS-2").at(-1), { stage: "pr", status: "aborted" });
		const held = f.types("held_external");
		assert.deepEqual(
			held.map((h) => [h.cause, h.checks, h.brake]),
			[["test", [TEST], f.brakeId()]],
		);

		// The first branch holds at its next pass, with no seat launched and no round lost.
		assert.equal(f.pass("OPS-1").stage, "held");
		assert.equal(f.row("OPS-1").status, "held_external");
		assert.equal(f.row("OPS-1").round, 0);
		assert.deepEqual(f.runs("OPS-1").at(-1), { stage: "pr", status: "aborted" }, "its failure costs no retry");

		// A later branch joins the same brake. A poll changes nothing.
		f.pass("OPS-3");
		assert.equal(f.row("OPS-3").status, "held_external");
		assert.equal(f.pass("OPS-3").stage, "held");
		assert.equal(f.types("brake_tripped").length, 1);
		assert.equal(f.types("held_external").length, 3);
	} finally {
		f.close();
	}
});

test("AC:OPS-141-1 failures more than 60 min apart do not trip the brake, and a test with no file never does", () => {
	const f = brakeFixture(["OPS-1", "OPS-2"]);
	try {
		f.pass("OPS-1");
		f.db
			.prepare("UPDATE events SET ts = ? WHERE type = 'test_failed'")
			.run(new Date(Date.now() - 61 * MIN).toISOString());
		f.pass("OPS-2");
		assert.equal(f.types("brake_tripped").length, 0);
		assert.deepEqual(f.runs("OPS-2").at(-1), { stage: "pr", status: "failed" });

		// Both inside the window, but the reporter gave no file, so no path says the branch is innocent.
		f.db
			.prepare(
				"UPDATE events SET ts = ?, payload = json_set(payload, '$.file', json('null'), '$.touchesOwnPaths', json('null')) WHERE type = 'test_failed'",
			)
			.run(new Date().toISOString());
		f.pass("OPS-1");
		f.pass("OPS-2");
		assert.equal(f.types("brake_tripped").length, 0);
	} finally {
		f.close();
	}
});

test("AC:OPS-141-2 a test failing on a branch that touches its paths does not trigger the brake", () => {
	const f = brakeFixture(["OPS-1", "OPS-2", "OPS-3"], ["OPS-2", "OPS-3"]);
	try {
		f.pass("OPS-1");
		f.pass("OPS-2");
		f.pass("OPS-3");
		assert.deepEqual(
			f.types("test_failed").map((e) => [e.task, e.file, e.touchesOwnPaths]),
			[
				["OPS-1", FILE, false],
				["OPS-2", FILE, true],
				["OPS-3", FILE, true],
			],
		);
		assert.equal(f.types("brake_tripped").length, 0);
		assert.equal(f.types("held_external").length, 0);
		for (const ref of ["OPS-1", "OPS-2", "OPS-3"]) assert.equal(f.row(ref).status, "active");
	} finally {
		f.close();
	}
});

test("AC:OPS-141-3 the brake reports the test name once, across every branch, poll and restart", () => {
	const f = brakeFixture(["OPS-1", "OPS-2", "OPS-3"]);
	try {
		f.pass("OPS-1");
		f.pass("OPS-2");
		f.pass("OPS-1");
		f.pass("OPS-3");
		for (const ref of ["OPS-1", "OPS-2", "OPS-3"]) f.pass(ref);
		const naming = f.notices().filter((n) => n.includes(TEST));
		assert.equal(naming.length, 1, f.notices().join("\n"));
		assert.equal(f.notices().length, 1, "a held branch adds no notice of its own");
		for (const part of [FILE, "OPS-1", "OPS-2", "File one OPS fix", `bin/evf brake fixed ${f.brakeId()} --commit`])
			assert.ok(naming[0]!.includes(part), `${part} in: ${naming[0]}`);
		const summaries = f.db
			.prepare(
				"SELECT json_extract(payload, '$.summary') AS s FROM events WHERE json_extract(payload, '$.summary') LIKE ?",
			)
			.all(`%${TEST}%`);
		assert.equal(summaries.length, 1, "one summary names the test");
	} finally {
		f.close();
	}
});

/** Holds every ref on one brake and ends it. */
function heldAndFixed(f: Fixture, refs: string[]) {
	f.pass(refs[0]!);
	for (const ref of refs.slice(1)) f.pass(ref);
	f.pass(refs[0]!);
	for (const ref of refs) assert.equal(f.row(ref).status, "held_external", ref);
	const sha = f.fix();
	const ended = cli(f.root, {}, "brake", "fixed", String(f.brakeId()), "--commit", sha);
	assert.equal(ended.status, 0, ended.stderr);
	return sha;
}

test("AC:OPS-141-4 after the fix merges, held tasks release 2 per 5 min on a fake clock, on a head that includes the fix", () => {
	const refs = ["OPS-1", "OPS-2", "OPS-3", "OPS-4", "OPS-5"];
	const f = brakeFixture(refs);
	try {
		// Before the fix no poll releases anything, whatever the clock says.
		f.pass("OPS-1");
		for (const ref of refs.slice(1)) f.pass(ref);
		f.pass("OPS-1");
		const { clock, probe } = machine();
		clock.sleep(60 * MIN);
		for (const ref of refs) assert.equal(f.pass(ref, probe).stage, "held");
		assert.equal(f.types("release_start").length, 0);

		const sha = f.fix();
		const refused = cli(f.root, {}, "brake", "fixed", String(f.brakeId()), "--commit", "0000000");
		assert.notEqual(refused.status, 0, "a commit that is not on main ends no brake");
		assert.equal(cli(f.root, {}, "brake", "fixed", String(f.brakeId()), "--commit", sha).status, 0);

		const held = () => refs.filter((ref) => f.row(ref).status === "held_external");
		const poll = () => held().forEach((ref) => f.pass(ref, probe));
		poll();
		assert.equal(held().length, 3, "2 start at once");
		poll();
		clock.sleep(5 * MIN - 1);
		poll();
		assert.equal(held().length, 3, "no more before 5 min");
		clock.sleep(1);
		poll();
		assert.equal(held().length, 1, "2 more at 5 min");
		clock.sleep(5 * MIN);
		poll();
		assert.equal(held().length, 0, "the last at 10 min");
		assert.equal(f.types("hold_released").length, 5);

		// A released task includes the fix and runs its checks again, which now pass.
		const { wt } = f.tasks["OPS-1"]!;
		assert.equal(git(wt, "merge-base", "--is-ancestor", sha, "HEAD"), "");
		f.pass("OPS-1");
		assert.equal(
			f
				.types("check_end")
				.filter((e) => e.task === "OPS-1")
				.at(-1)!.result,
			"passed",
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-141-5 release pauses while load is 24 or more and while the queue is long, and goes on when they fall", () => {
	const f = brakeFixture(["OPS-1", "OPS-2"]);
	try {
		heldAndFixed(f, ["OPS-1", "OPS-2"]);
		const { m, clock, probe } = machine(24);
		const n = f.pass("OPS-1", probe);
		assert.equal(n.stage, "held");
		assert.match(n.reason, /load 24\.0 is 24 or more/);
		clock.sleep(30 * MIN);
		assert.equal(f.pass("OPS-1", probe).stage, "held", "time alone does not release it");
		assert.equal(f.row("OPS-1").status, "held_external");

		m.load = 23.9;
		m.waiting = 3;
		assert.match(f.pass("OPS-1", probe).reason, /3 checks wait/);
		assert.equal(f.row("OPS-1").status, "held_external");

		m.waiting = 2;
		assert.equal(f.pass("OPS-1", probe).stage, "pr");
		assert.equal(f.row("OPS-1").status, "active");

		m.load = 40;
		assert.equal(f.pass("OPS-2", probe).stage, "held", "the load gate reads each release");
		m.load = 1;
		assert.equal(f.pass("OPS-2", probe).stage, "pr");
	} finally {
		f.close();
	}
});

test("AC:OPS-141-5 several drives start in stages; one drive alone reads no load, and a restart takes no second slot", () => {
	const f = brakeFixture(["OPS-1", "OPS-2", "OPS-3", "OPS-4"]);
	const quietDrive = (ref: string, release: object) => {
		const { log } = console;
		const lines: string[] = [];
		console.log = (...a: unknown[]) => void lines.push(a.join(" "));
		try {
			const { task, id } = f.tasks[ref]!;
			// Three failures in a row end the drive at its first pass, right after the start gate.
			for (let i = 0; i < 3; i++)
				f.db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, 'pr', 'evf', 0, 'failed', ?)",
					)
					.run(id, new Date().toISOString());
			assert.equal(drive(f.root, task, {}, { ...TIMING, release } as never), 2);
			return lines;
		} finally {
			console.log = log;
		}
	};
	const slots = () => f.types("release_start").map((e) => e.why);
	try {
		// One drive at a load of 132: no burst, so it starts.
		const lone = machine(132);
		quietDrive("OPS-1", lone.probe);
		assert.deepEqual(slots(), ["drive"]);
		const { task, id } = f.tasks["OPS-1"]!;
		assert.equal(releaseWait(f.db, f.root, id, task.id, "hold", lone.probe), null, "it keeps its slot");
		assert.deepEqual(slots(), ["drive"]);

		// A second start in the window reads the load, and goes on when it falls.
		const clock = lone.clock,
			m = lone.m;
		let reads = 0;
		const falling = {
			now: clock.now,
			load: () => (++reads > 2 ? (m.load = 1) : m.load),
			waiting: () => 0,
		};
		const second = quietDrive("OPS-2", falling);
		assert.ok(
			second.some((l) => /waits to start: load 132\.0 is 24 or more/.test(l)),
			second.join("\n"),
		);
		assert.equal(slots().length, 2);

		// The third waits out the 5 min. Its clock moves with each read.
		const moving = {
			now: () => {
				clock.sleep(MIN);
				return clock.now();
			},
			load: () => 1,
			waiting: () => 0,
		};
		const third = quietDrive("OPS-3", moving);
		assert.ok(
			third.some((l) => /waits to start: 2 tasks started in the last 5 min/.test(l)),
			third.join("\n"),
		);
		assert.ok(clock.elapsed() >= 5 * MIN);
		assert.equal(slots().length, 3);
	} finally {
		f.close();
	}
});

test("AC:OPS-141-6 the brake never marks a check as passed and never clears a required check", () => {
	const f = brakeFixture(["OPS-1", "OPS-2"]);
	try {
		f.pass("OPS-1");
		f.pass("OPS-2");
		f.pass("OPS-1");
		const { task, wt } = f.tasks["OPS-2"]!;
		const report = () =>
			JSON.parse(
				readFileSync(
					join(evidenceDir(f.root, task, git(wt, "rev-parse", "HEAD"), "author-full"), "checks.json"),
					"utf8",
				),
			);

		// Held: the checks stay failed, no run or proof passes, the head is not verified.
		const runsBefore = f.runs("OPS-2").filter((r) => r.status === "passed").length;
		assert.equal(report().passed, false);
		assert.equal(hasVerifiedHead(f.root, task), false);
		assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM proofs").get() as { n: number }).n, 0);
		assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n, 0);
		assert.equal(
			f.types("check_end").some((e) => e.result === "passed"),
			false,
		);

		// A brake ended by a commit that fixes nothing: the required check still runs, still fails, and blocks the PR.
		const sha = f.fix("tests/workflow/not-the-fix.txt");
		assert.equal(cli(f.root, {}, "brake", "fixed", String(f.brakeId()), "--commit", sha).status, 0);
		const { probe } = machine();
		f.pass("OPS-2", probe);
		assert.equal(f.row("OPS-2").status, "active");
		assert.equal(f.runs("OPS-2").filter((r) => r.status === "passed").length, runsBefore);
		f.pass("OPS-2", probe);
		assert.equal(hasVerifiedHead(f.root, task), false);
		assert.equal(report().passed, false);
		assert.equal(
			f.types("check_end").some((e) => e.result === "passed"),
			false,
		);
		assert.deepEqual(f.runs("OPS-2").at(-1), { stage: "pr", status: "failed" }, "a real failure, with no PR opened");
		assert.equal(
			(f.db.prepare("SELECT pr_number AS n FROM tasks WHERE id = ?").get(f.tasks["OPS-2"]!.id) as { n: number | null })
				.n,
			null,
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-141-4 evf task reopen overrules the brake for one task, and a new failure holds it again", () => {
	const f = brakeFixture(["OPS-1", "OPS-2"]);
	const saved = process.env.EVF_RUN;
	delete process.env.EVF_RUN;
	try {
		f.pass("OPS-1");
		f.pass("OPS-2");
		const { log } = console;
		console.log = () => {};
		taskReopen(f.root, f.tasks["OPS-2"]!.task, "coordinator needs this branch");
		console.log = log;
		assert.equal(f.row("OPS-2").status, "active");
		// pr runs again rather than ci: no check counts as passed. The check still fails, so the task holds again.
		f.pass("OPS-2");
		assert.equal(f.types("check_start").filter((e) => e.task === "OPS-2").length, 2);
		assert.equal(f.row("OPS-2").status, "held_external");
		assert.equal(f.types("brake_tripped").length, 1);
	} finally {
		if (saved !== undefined) process.env.EVF_RUN = saved;
		f.close();
	}
});

test("a test's paths are its app, package or tool, or else its folder", () => {
	assert.deepEqual(testPaths("tools/evf/tests/x.test.ts"), ["tools/evf/"]);
	assert.deepEqual(testPaths("packages/db/src/a.test.ts"), ["packages/db/"]);
	assert.deepEqual(testPaths("tests/e2e/a.spec.ts"), ["tests/e2e/"]);
	assert.deepEqual(testPaths("a.test.ts"), ["a.test.ts"]);
});

test("the check queue counts only tickets behind the running checks", () => {
	const f = fixture();
	try {
		const dir = join(evfDataDir(f.root), "check-queue");
		mkdirSync(dir, { recursive: true });
		const ticket = (n: number) =>
			writeFileSync(join(dir, `${String(n).padStart(15, "0")}.json`), JSON.stringify({ pid: process.pid, task: "x" }));
		for (let n = 1; n <= CHECK_CAP; n++) ticket(n);
		assert.equal(checkQueueWaiting(f.root), 0);
		ticket(CHECK_CAP + 1);
		ticket(CHECK_CAP + 2);
		assert.equal(checkQueueWaiting(f.root), 2);
	} finally {
		f.close();
	}
});
