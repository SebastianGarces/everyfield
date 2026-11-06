import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { source, setTasks, readTask, writeTask } from "./fixtures.ts";
import {
	delay,
	MAIN,
	node,
	preview,
	queueFixture,
	specOf,
	STUB_TESTS,
	task,
	ticketName,
	TOOL_STUB,
	UI_STUB,
	until,
	watch,
} from "./queue-fixture.ts";
import { acRun } from "../ac.ts";
import { withCheckQueue } from "../check-queue.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { evfDataDir, parseTask, WaitGaveUp } from "../lib.ts";
import { withShipQueue } from "../ship-queue.ts";
import { verify } from "../verify.ts";

/** OPS-138. Each test carries the marker of the Done criterion it proves, so `evf ac run OPS-138` runs this file. */

/** A process that joins the queue through withCheckQueue and holds its place until its release file exists. */
function queuer(f: ReturnType<typeof queueFixture>, name: string, log: string) {
	return watch(
		spawn(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { appendFileSync, existsSync } from "node:fs";
import { withCheckQueue } from ${JSON.stringify(join(source, "tools/evf/check-queue.ts"))};
import { sleep } from ${JSON.stringify(join(source, "tools/evf/lib.ts"))};
withCheckQueue(${JSON.stringify(f.root)}, ${JSON.stringify(name)}, () => {
	appendFileSync(${JSON.stringify(log)}, "start ${name}\\n");
	while (!existsSync(${JSON.stringify(`${log}-${name}`)})) sleep(5);
	appendFileSync(${JSON.stringify(log)}, "end ${name}\\n");
}, { waitMs: 60000, pollMs: 10 });`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
		),
	);
}
/**
 * A process that waits in the queue inside a worker thread that never yields, as the drive's pr stage does, on a clock
 * that runs one minute in each 15 ms.
 */
function workerWaiter(f: ReturnType<typeof queueFixture>, log: string) {
	const script = join(f.root, "fake-bin/worker-waiter.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { withCheckQueue } from ${JSON.stringify(join(source, "tools/evf/check-queue.ts"))};
let clock = 0;
Date.now = () => (clock += 20000);
withCheckQueue(${JSON.stringify(f.root)}, "OPS-1", () => writeFileSync(${JSON.stringify(log)}, "started"), {
	waitMs: Infinity,
	pollMs: 5,
});`,
	);
	return watch(
		spawn(
			process.execPath,
			[
				"-e",
				`new (require("node:worker_threads").Worker)(${JSON.stringify(script)}).on("error", (e) => { throw e; });`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
		),
	);
}
const positions = (err: string) =>
	[...err.matchAll(/position (\d+), 3 running, (\d+) min\./g)].map((m) => ({
		position: Number(m[1]),
		minute: Number(m[2]),
	}));
const logged = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

/** Own-process tickets with low numbers, in the test's process. */
function tickets(dir: string, numbers: number[]) {
	for (const n of numbers)
		writeFileSync(
			join(dir, ticketName(n)),
			JSON.stringify({ pid: process.pid, task: `OPS-T${n}`, at: new Date().toISOString() }),
		);
}

function quiet<T>(fn: () => T): { value?: T; thrown?: unknown; err: string } {
	const { log, error } = console;
	let err = "";
	console.log = () => {};
	console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
	try {
		return { value: fn(), err };
	} catch (thrown) {
		return { thrown, err };
	} finally {
		console.log = log;
		console.error = error;
	}
}

test("a fourth full check waits, prints its position and starts when a slot frees; the cap is a code default (AC:OPS-138-1)", async () => {
	const f = queueFixture();
	try {
		const keys = Object.keys(JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8")) as object);
		assert.deepEqual(
			keys.filter((key) => /queue|cap/i.test(key)),
			[],
			"no setting resizes the queue",
		);
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const fourth = f.cli(f.wt, ["verify", "OPS-1"]);
		await until("the queue position", () => /position 1, 3 running/.test(fourth.err()));
		await delay(150);
		assert.equal(existsSync(f.ran), false, "no check started");
		await f.stop(holders[0]!);
		assert.equal(await fourth.done, 0, fourth.err());
		assert.equal(existsSync(f.ran), true);
		assert.deepEqual(f.tickets().length, 2, "the finished check's ticket is gone; the two live holders stay");
	} finally {
		await f.finish();
	}
});

test("with fewer than three running a full check starts at once (AC:OPS-138-1)", async () => {
	const f = queueFixture();
	try {
		f.holder(1);
		f.holder(2);
		const third = f.cli(f.wt, ["verify", "OPS-1"]);
		assert.equal(await third.done, 0, third.err());
		assert.doesNotMatch(third.err(), /waits in the full check queue/);
	} finally {
		await f.finish();
	}
});

test("a waiter in a worker thread prints its position once per minute during the wait, and the position falls (AC:OPS-138-2)", async () => {
	const f = queueFixture();
	try {
		tickets(f.dir, [1, 2, 3, 4, 5]);
		const log = join(f.root, "fake-bin/started.log");
		const waiter = workerWaiter(f, log);
		// Each line arrives while the wait goes on: the drive's pr stage waits in a worker thread that never yields.
		for (const [position, ahead] of [
			[3, 1],
			[2, 2],
			[1, 3],
		] as const) {
			await until(`position ${position}, one minute on`, () => {
				const lines = positions(waiter.err()).filter((line) => line.position === position);
				return lines.length >= 2;
			});
			assert.equal(existsSync(log), false, "the waiter still waits");
			rmSync(join(f.dir, ticketName(ahead)));
		}
		assert.equal(await waiter.done, 0, waiter.err());
		assert.equal(existsSync(log), true);
		const lines = positions(waiter.err());
		assert.deepEqual(
			lines.map((line) => line.minute),
			lines.map((_, minute) => minute),
			"one line at the start and one per minute",
		);
		assert.deepEqual(
			[...new Set(lines.map((line) => line.position))],
			[3, 2, 1],
			"the position falls as waiters ahead of it start",
		);
	} finally {
		f.close();
	}
});

test("a position line that nobody can read does not end the wait (AC:OPS-138-2)", async () => {
	const f = queueFixture();
	try {
		tickets(f.dir, [1, 2, 3]);
		const log = join(f.root, "fake-bin/started.log");
		const waiter = workerWaiter(f, log);
		await until("the first position", () => positions(waiter.err()).length > 0);
		waiter.child.stderr!.destroy();
		await delay(200);
		assert.equal(existsSync(log), false, "the waiter still waits");
		rmSync(join(f.dir, ticketName(1)));
		await until("the start", () => existsSync(log));
		assert.equal(await waiter.done, 0);
	} finally {
		f.close();
	}
});

test("more waiters than free slots start in arrival order, and the running count never passes the cap (AC:OPS-138-3)", async () => {
	const f = queueFixture();
	try {
		const log = join(f.root, "fake-bin/order.log");
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const names = ["A", "B", "C", "D", "E"];
		const waiters = [];
		for (const name of names) {
			const w = queuer(f, name, log);
			waiters.push(w);
			await until(`${name} in the queue`, () => /waits in the full check queue/.test(w.err()));
		}
		const started = () => logged(log).filter((l) => l.startsWith("start"));
		await f.stop(holders[0]!);
		await f.stop(holders[1]!);
		await until("two free slots used", () => started().length === 2);
		await delay(100);
		assert.deepEqual(
			started()
				.map((l) => l.slice(6))
				.sort(),
			["A", "B"],
			"two slots go to the first two",
		);
		await f.stop(holders[2]!);
		await until("the third", () => started().length === 3);
		assert.equal(started()[2], "start C");
		await delay(100);
		assert.equal(started().length, 3, "D and E wait while A, B and C run");
		writeFileSync(`${log}-A`, "");
		await until("the fourth", () => started().length === 4);
		assert.equal(started()[3], "start D");
		writeFileSync(`${log}-B`, "");
		await until("the fifth", () => started().length === 5);
		assert.equal(started()[4], "start E");
		for (const name of ["C", "D", "E"]) writeFileSync(`${log}-${name}`, "");
		assert.deepEqual(await Promise.all(waiters.map((w) => w.done)), [0, 0, 0, 0, 0]);
		assert.deepEqual(f.tickets(), []);
	} finally {
		await f.finish();
	}
});

test("arrivals at the same moment never pass the cap (AC:OPS-138-3)", async () => {
	const f = queueFixture();
	try {
		const log = join(f.root, "fake-bin/burst.log");
		const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
		for (const name of names) writeFileSync(`${log}-${name}`, "");
		const waiters = names.map((name) => queuer(f, name, log));
		assert.deepEqual(
			await Promise.all(waiters.map((w) => w.done)),
			names.map(() => 0),
		);
		let running = 0,
			most = 0;
		for (const line of logged(log)) {
			running += line.startsWith("start") ? 1 : -1;
			most = Math.max(most, running);
		}
		assert.ok(most <= 3, `ran ${most} at once`);
		assert.deepEqual(f.tickets(), []);
	} finally {
		await f.finish();
	}
});

test("SIGKILL of a holder frees its slot and SIGKILL of a waiter removes its place; pass, fail and throw free the slot (AC:OPS-138-4)", async () => {
	const f = queueFixture();
	try {
		const log = join(f.root, "fake-bin/kill.log");
		const running = [];
		for (const name of ["A", "B", "C"]) {
			running.push(queuer(f, name, log));
			await until(`${name} running`, () => logged(log).includes(`start ${name}`));
		}
		const killedWaiter = queuer(f, "D", log);
		await until("D waits", () => /position 1/.test(killedWaiter.err()));
		const next = queuer(f, "E", log);
		await until("E waits behind D", () => /position 2/.test(next.err()));
		assert.equal(f.tickets().length, 5);

		const ticketOf = (pid: number) =>
			f.tickets().find((t) => (JSON.parse(readFileSync(join(f.dir, t), "utf8")) as { pid: number }).pid === pid);
		const waiterTicket = ticketOf(killedWaiter.child.pid!)!;
		assert.ok(waiterTicket);
		await f.stop(killedWaiter.child);
		await until("the killed waiter's place to go", () => !f.tickets().includes(waiterTicket));
		await delay(100);
		assert.equal(logged(log).includes("start E"), false, "three holders still run");

		await f.stop(running[0]!.child);
		await until("E takes the freed slot", () => logged(log).includes("start E"));
		assert.equal(logged(log).includes("start D"), false);
		for (const name of ["B", "C", "E"]) writeFileSync(`${log}-${name}`, "");
		await Promise.all([running[1]!.done, running[2]!.done, next.done]);
		assert.deepEqual(f.tickets(), []);

		// A pass, a failed report and a throw each end with no ticket.
		assert.equal(quiet(() => withCheckQueue(f.root, "OPS-1", () => "passed")).value, "passed");
		assert.deepEqual(f.tickets(), []);
		const failed = f.tasks["OPS-1"];
		failed.checks = [{ name: "red", run: node("process.exit(1)") }];
		setTasks(f.root, f.tasks);
		f.git("-C", f.root, "add", "evf.config.json");
		f.git("-C", f.root, "commit", "-qm", "red");
		f.git("-C", f.wt, "merge", "-q", "--no-edit", "main");
		assert.equal(quiet(() => verify(f.root, task, "author", "full")).value?.passed, false);
		assert.deepEqual(f.tickets(), []);
		assert.match(
			String(
				quiet(() =>
					withCheckQueue(f.root, "OPS-1", () => {
						throw new Error("thrown inside");
					}),
				).thrown,
			),
			/thrown inside/,
		);
		assert.deepEqual(f.tickets(), []);
	} finally {
		await f.finish();
	}
});

test("every full verify queues; --quick and refusals that need no check do not wait; --ignore-load skips only the load wait (AC:OPS-138-5)", async () => {
	const f = queueFixture();
	try {
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const expectNoWait = async (args: string[], status: number, pattern: RegExp) => {
			const r = f.cli(f.wt, args);
			assert.equal(await r.done, status, r.err());
			assert.match(r.err() + r.out(), pattern);
			assert.doesNotMatch(r.err(), /waits in the full check queue/);
		};
		// Quick: no slot, and it holds no ticket while it runs.
		await expectNoWait(["verify", "OPS-1", "--quick"], 0, /PASSED local tooling checks/);
		await expectNoWait(["verify", "OPS-1", "--head", "0".repeat(40)], 1, /does not match requested SHA/);
		for (const command of ["verify", "check"])
			for (const reason of ["", "  "])
				await expectNoWait([command, "OPS-1", "--ignore-load", reason], 1, /--ignore-load needs a reason/);
		writeFileSync(join(f.wt, "dirty"), "x");
		await expectNoWait(["verify", "OPS-1"], 1, /is not clean/);
		rmSync(join(f.wt, "dirty"));
		f.commitFiles({ "tools/evf/later.txt": "x" }, f.root);
		await expectNoWait(["verify", "OPS-1"], 1, /Include current main/);
		f.git("-C", f.wt, "merge", "-q", "--no-edit", "main");
		f.setLoad({ maxPerCore: 0, maxWaitMinutes: 0 });
		await expectNoWait(["verify", "OPS-1"], 1, /machineLoad needs/);
		f.setLoad({ maxPerCore: 2, maxWaitMinutes: 30 });

		const checked = f.cli(f.wt, ["check", "OPS-1"]);
		await until("evf check in the queue", () => /position 1/.test(checked.err()));
		await f.stop(checked.child);

		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		rmSync(f.ran, { force: true });
		const forced = f.cli(f.wt, ["verify", "OPS-1", "--ignore-load", "fixture reason"], "high");
		await until("the override in the queue", () => /position 1/.test(forced.err()));
		await delay(100);
		assert.deepEqual(f.overrides(), [], "the load step comes after the queue");
		assert.equal(existsSync(f.ran), false);
		await f.stop(holders[0]!);
		assert.equal(await forced.done, 0, forced.err());
		assert.equal(existsSync(f.ran), true);
		assert.equal(f.overrides()[0]!.reason, "fixture reason");
	} finally {
		await f.finish();
	}
});

test("a refusal found after the wait frees the slot: main moved while the check queued (AC:OPS-138-5)", async () => {
	const f = queueFixture();
	try {
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const waiting = f.cli(f.wt, ["verify", "OPS-1"]);
		await until("the wait", () => /position 1/.test(waiting.err()));
		writeFileSync(join(f.root, "later.txt"), "x");
		f.git("-C", f.root, "add", "later.txt");
		f.git("-C", f.root, "commit", "-qm", "later on main");
		await f.stop(holders[0]!);
		assert.equal(await waiting.done, 1);
		assert.match(waiting.err(), /Include current main/);
		assert.equal(existsSync(f.ran), false);
		assert.equal(f.tickets().length, 2);
	} finally {
		await f.finish();
	}
});

test("a full check holds its slot during the load wait, and a load give-up frees it (AC:OPS-138-6)", async () => {
	const f = queueFixture();
	const real = os.loadavg;
	try {
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const queued = f.cli(f.wt, ["verify", "OPS-1"], "high");
		await until("the wait", () => /position 1/.test(queued.err()));
		assert.doesNotMatch(queued.err(), /load limit/, "the queue comes before the load wait");
		await f.stop(holders[0]!);
		assert.equal(await queued.done, 1);
		assert.match(queued.err(), /The machine stayed above its load limit/);
		assert.equal(f.tickets().length, 2, "the give-up left no ticket");
		for (const ticket of f.tickets()) rmSync(join(f.dir, ticket));

		// While the load step reads the machine, this process has its ticket.
		const seen: number[] = [];
		os.loadavg = () => {
			seen.push(f.tickets().length);
			return [50, 50, 50];
		};
		syncBuiltinESMExports();
		const gaveUp = quiet(() => verify(f.root, task, "author", "full"));
		assert.ok(gaveUp.thrown instanceof WaitGaveUp);
		assert.deepEqual(seen, [1]);
		assert.deepEqual(f.tickets(), []);
	} finally {
		os.loadavg = real;
		syncBuiltinESMExports();
		await f.finish();
	}
});

test("evf test waits on load, logs an override, refuses an empty reason and passes only Node's options on (AC:OPS-138-7)", async () => {
	const f = queueFixture();
	try {
		f.commitFiles({ "tools/evf/tests/stub.test.ts": STUB_TESTS }, f.root);
		const evfTest = async (args: string[], load: keyof typeof LOADS | undefined, status: number) => {
			const r = f.cli(f.root, ["test", ...args], load);
			assert.equal(await r.done, status, r.err() + r.out());
			return r;
		};
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const refused = await evfTest([], "high", 1);
		assert.match(refused.err(), /The machine stayed above its load limit/);
		assert.doesNotMatch(refused.out(), /alpha/);

		f.setLoad({ maxPerCore: 1, maxWaitMinutes: 0.005 });
		const waited = await evfTest([], "falling", 0);
		assert.match(waited.err(), /evf test: load 50\.0, .*waiting, 0 of 0\.005 min/);
		assert.match(waited.out(), /alpha/);

		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		for (const [flag, reason] of [
			[["--ignore-load", "separate reason"], "separate reason"],
			[["--ignore-load=inline reason"], "inline reason"],
		] as const) {
			const forced = await evfTest([...flag, "--test-name-pattern=alpha"], "high", 0);
			assert.match(forced.out(), /alpha/);
			assert.doesNotMatch(forced.out(), /beta/, "other Node options still reach the runner");
			assert.equal(f.overrides().at(-1)!.reason, reason);
			assert.equal(f.overrides().at(-1)!.command, "test");
		}
		const count = f.overrides().length;
		for (const flag of [
			["--ignore-load", ""],
			["--ignore-load", " "],
			["--ignore-load="],
			["--ignore-load"],
			["--ignore-load", "--test-name-pattern=alpha"],
		]) {
			const empty = await evfTest(flag, "high", 1);
			assert.match(empty.err(), /--ignore-load needs a reason/);
			assert.doesNotMatch(empty.out(), /alpha/);
		}
		assert.equal(f.overrides().length, count);
	} finally {
		await f.finish();
	}
});

test("evf ac run waits on load; --ignore-load runs at once, logs it, and its browser run does not wait (AC:OPS-138-8)", async () => {
	const f = queueFixture();
	try {
		f.setSpec(specOf("OPS-1-1"));
		f.commitFiles({ "tools/evf/tests/tool.test.ts": TOOL_STUB, "tests/ui/browser.test.mjs": UI_STUB });
		preview(f);
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const refused = f.cli(f.wt, ["ac", "run", "OPS-1"], "high");
		assert.equal(await refused.done, 1);
		assert.match(refused.err(), /The machine stayed above its load limit/);
		assert.doesNotMatch(refused.out(), /file\(s\) carry it/);

		f.setLoad({ maxPerCore: 1, maxWaitMinutes: 0.005 });
		const waited = f.cli(f.wt, ["ac", "run", "OPS-1"], "falling");
		assert.equal(await waited.done, 0, waited.err() + waited.out());
		assert.match(waited.err(), /evf ac run: load 50\.0, .*waiting/);

		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const forced = f.cli(f.wt, ["ac", "run", "OPS-1", "--ignore-load", "release blocker"], "high");
		assert.equal(await forced.done, 0, forced.err() + forced.out());
		assert.match(forced.out(), /criterion 1 met/);
		assert.deepEqual(
			f.overrides().map((o) => [o.command, o.reason]),
			[["ac run", "release blocker"]],
			"one override: the browser run inside it logs none",
		);

		const empty = f.cli(f.wt, ["ac", "run", "OPS-1", "--ignore-load", ""], "high");
		assert.equal(await empty.done, 1);
		assert.match(empty.err(), /--ignore-load needs a reason/);
	} finally {
		await f.finish();
	}
});

test("the ac run of evf run done stays ungated at its start and its browser runs keep their gate (AC:OPS-138-8)", async () => {
	const f = queueFixture();
	const real = os.loadavg,
		options = process.env.NODE_OPTIONS;
	try {
		f.setSpec(specOf("OPS-1-1"));
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		os.loadavg = () => [50, 50, 50];
		syncBuiltinESMExports();
		f.commitFiles({ "tools/evf/tests/tool.test.ts": TOOL_STUB });
		const tool = quiet(() => acRun(f.root, task, {}));
		assert.equal(tool.value?.[0]!.status, "met", "ungated at its own start");

		f.commitFiles({ "tests/ui/browser.test.mjs": UI_STUB });
		preview(f);
		process.env.NODE_OPTIONS = `${options} --import=${f.preloads.high}`;
		const browser = quiet(() => acRun(f.root, task, {}));
		assert.equal(browser.value?.[0]!.status, "unmet", "its browser run still gives up under load");
		assert.match(browser.err, /The machine stayed above its load limit/);
	} finally {
		os.loadavg = real;
		syncBuiltinESMExports();
		process.env.NODE_OPTIONS = options;
		await f.finish();
	}
});

test("nothing inside a command that passed the gate waits again; evf test with CI set does not wait (AC:OPS-138-9)", async () => {
	/** Runs `inner` once, from inside whatever started it. */
	const nested = (inner: string[]) =>
		`if(!process.env.EVF_NESTED){const r=process.getBuiltinModule("node:child_process").spawnSync(process.execPath,[${JSON.stringify(MAIN)},...${JSON.stringify(inner)}],{encoding:"utf8",env:{...process.env,EVF_NESTED:"1",NODE_TEST_CONTEXT:undefined}});console.log(r.stdout);console.error(r.stderr);if(r.status)process.exit(r.status)}`;
	const stub = (inner: string[]) =>
		`import test from "node:test";\ntest("nest (AC:OPS-1-1)", () => {\n${nested(inner)}\n});\n`;
	for (const inner of [["test"], ["ac", "run", "OPS-1"]]) {
		// The load is over the limit only inside the gate: an inner wait gives up at once and fails the outer command.
		const f = queueFixture([{ name: "nested", run: node(nested(inner)) }]);
		try {
			f.setSpec(specOf("OPS-1-1"));
			f.commitFiles({ "tools/evf/tests/nest.test.ts": stub(inner) });
			f.setLoad({ maxPerCore: 1, maxWaitMinutes: 0 });
			for (const outer of [["verify", "OPS-1"], ["verify", "OPS-1", "--quick"], ["test"], ["ac", "run", "OPS-1"]]) {
				const run = f.cli(f.wt, outer, "inside");
				const code = await run.done;
				const report = /checks: (.*checks\.json)/.exec(run.out())?.[1];
				const logs = report
					? (JSON.parse(readFileSync(report, "utf8")) as { checks: Array<{ log: string }> }).checks
							.map((c) => readFileSync(c.log, "utf8"))
							.join("\n")
					: "";
				assert.equal(code, 0, `${outer.join(" ")} > ${inner.join(" ")}: ${run.err()}${run.out()}${logs}`);
				assert.doesNotMatch(run.err() + run.out(), /load limit/);
			}
			assert.deepEqual(f.overrides(), [], "no outer command needed an override");

			// The gate's environment stays out of the process: a drive that verifies launches seats afterwards.
			const before = process.env.EVF_LOAD_GATE_ROOT;
			quiet(() => verify(f.root, task, "author", "full"));
			assert.equal(process.env.EVF_LOAD_GATE_ROOT, before);
		} finally {
			await f.finish();
		}
	}
	const f = queueFixture();
	try {
		f.commitFiles({ "tools/evf/tests/stub.test.ts": STUB_TESTS }, f.root);
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const ci = f.cli(f.root, ["test"], "high", { CI: "true" });
		assert.equal(await ci.done, 0, ci.err());
		assert.doesNotMatch(ci.err(), /load/);
		const another = f.cli(f.root, ["test"], "high", { EVF_LOAD_GATE_ROOT: "/another/checkout" });
		assert.equal(await another.done, 1, "the gate of another checkout does not count");
	} finally {
		await f.finish();
	}
});

test("a full check gives up after 120 minutes: the message names the queue, no check_start, no ticket (AC:OPS-138-10)", () => {
	const f = queueFixture();
	try {
		tickets(f.dir, [1, 2, 3]);
		const held = f.tickets();

		const realNow = Date.now;
		let clock = 0;
		Date.now = () => (clock += 30 * 60_000);
		const gaveUp = quiet(() => verify(f.root, task, "author", "full"));
		Date.now = realNow;
		assert.ok(gaveUp.thrown instanceof WaitGaveUp);
		assert.match(gaveUp.thrown.message, /waited in the full check queue for 120 min and no check ran/);
		assert.deepEqual(f.events("check_start"), []);
		assert.deepEqual(f.tickets(), held);
		assert.equal(existsSync(f.ran), false);
	} finally {
		f.close();
	}
});

test("check_start and the report hold the queue wait plus the load wait (AC:OPS-138-12)", async () => {
	const f = queueFixture();
	try {
		f.setLoad({ maxPerCore: 1, maxWaitMinutes: 0.005 });
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const start = Date.now();
		const run = f.cli(f.wt, ["verify", "OPS-1"], "falling");
		await until("the wait", () => /position 1/.test(run.err()));
		await delay(1000);
		await f.stop(holders[0]!);
		assert.equal(await run.done, 0, run.err());
		const wall = Date.now() - start;
		const started = f.events("check_start").at(-1)!;
		const queuedMs = Number(started.queuedMs);
		assert.ok(queuedMs >= 1000 + 250, `queue wait of 1000 ms plus load wait of about 300 ms, got ${queuedMs}`);
		assert.ok(queuedMs < wall, `${queuedMs} is under the ${wall} ms the command ran`);
		const report = JSON.parse(readFileSync(/checks: (.*checks\.json)/.exec(run.out())![1]!, "utf8")) as {
			queuedMs: number;
		};
		assert.equal(report.queuedMs, queuedMs);
		assert.equal(f.events("check_end").at(-1)!.queuedMs, queuedMs);
	} finally {
		await f.finish();
	}
});

test("evf help and the README state the cap, the order, the limit and the gated commands (AC:OPS-138-13)", async () => {
	const f = queueFixture();
	try {
		const help = f.cli(f.root, ["help"]);
		assert.equal(await help.done, 0);
		const text = help.out();
		assert.match(text, /At most 3 full checks/);
		assert.match(text, /arrival\s+order/);
		assert.match(text, /task start, verify, test, ac run, timing and browser run wait/);
		assert.match(text, /evf test \[--ignore-load "<reason>"\]/);
		assert.match(text, /evf ac run <task> \[--ignore-load "<reason>"\]/);
		const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8");
		assert.match(readme, /At most 3 full checks run at once/);
		assert.match(readme, /Waiters start in arrival order/);
		assert.match(readme, /After 120 minutes in\s+the queue/);
		assert.match(readme, /`evf verify`, `evf test`, `evf ac run`/);
		assert.match(readme, /`queuedMs` is the time spent in the full check queue plus the load wait/);
		assert.match(readme, /In CI, `evf test` with `CI` set does not wait/);
		assert.doesNotMatch(readme, /CI runners use the same rule/);
	} finally {
		await f.finish();
	}
});

test("a commit during the queue wait meets the same owning-path refusal as one before it (AC:OPS-138-14)", async () => {
	const f = queueFixture();
	try {
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const waiting = f.cli(f.wt, ["verify", "OPS-1"]);
		await until("the wait", () => /position 1/.test(waiting.err()));
		f.commitFiles({ "outside.txt": "x" });
		await f.stop(holders[0]!);
		assert.equal(await waiting.done, 1, waiting.out());
		assert.match(waiting.err(), /changes paths outside its reviewed owning paths/);
		assert.equal(existsSync(f.ran), false, "no check ran");
		assert.deepEqual(f.events("check_start"), []);
		assert.equal(f.tickets().length, 2, "the refusal frees the slot");
	} finally {
		await f.finish();
	}
});

test("the checks that run are the list of the commit they check, also when it lands during the queue wait (AC:OPS-138-14)", async () => {
	const f = queueFixture();
	try {
		const holders = [f.holder(1), f.holder(2), f.holder(3)];
		const waiting = f.cli(f.wt, ["verify", "OPS-1"]);
		await until("the wait", () => /position 1/.test(waiting.err()));
		f.commitFiles({
			"tools/evf/tasks/OPS-1.json": JSON.stringify({
				title: "Queue",
				owningPaths: ["tools/evf/"],
				checks: [{ name: "later", run: node("") }],
			}),
		});
		const head = f.git("-C", f.wt, "rev-parse", "HEAD");
		await f.stop(holders[0]!);
		assert.equal(await waiting.done, 0, waiting.err());
		const path = /PASSED local tooling checks: (\S+checks\.json)/.exec(waiting.out())![1]!;
		const report = JSON.parse(readFileSync(path, "utf8")) as { sha: string; checks: Array<{ name: string }> };
		assert.equal(report.sha, head);
		assert.deepEqual(
			report.checks.map((c) => c.name),
			["format", "later", "package-unit-tests"],
		);
		assert.equal(existsSync(f.ran), false, "the list from before the commit did not run");
	} finally {
		await f.finish();
	}
});

test("OPS-144-1: a format error refuses at once with the queue full and the load high, and holds no ticket", () => {
	const f = queueFixture([{ name: "long", run: node("") }]);
	try {
		f.cfg.checks = f.cfg.checks.map((c: { name: string }) =>
			c.name === "format" ? { ...c, run: node("process.exit(1)") } : c,
		);
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.git("-C", f.root, "add", "evf.config.json");
		f.git("-C", f.root, "commit", "-qm", "red format");
		f.git("-C", f.wt, "merge", "-q", "--no-edit", "main");
		tickets(f.dir, [1, 2, 3]);
		const held = f.tickets().length;
		// Any wait for the load gate would throw here: this limit is below every real load, and it allows no wait.
		f.setLoad({ maxPerCore: 0.000001, maxWaitMinutes: 0 });
		const { value: report, err, thrown } = quiet(() => verify(f.root, task, "author", "full"));
		assert.equal(thrown, undefined);
		assert.equal(report?.passed, false);
		assert.deepEqual(
			report?.checks.map((c) => c.name),
			["format"],
		);
		assert.equal(report?.stoppedAfter, "format");
		assert.deepEqual(report?.notRun, ["long", "package-unit-tests", "ui-escaped"]);
		assert.doesNotMatch(err, /waits in the full check queue/);
		assert.equal(f.tickets().length, held);
	} finally {
		f.close();
	}
});

test("through the queue the same named checks run in the same order per mode with the same results; the ship queue stays apart (AC:OPS-138-14)", () => {
	const ok = node("");
	const f = queueFixture([
		{ name: "both", run: ok },
		{ name: "full-only", run: ok, modes: ["full"] },
		{ name: "quick-only", run: ok, modes: ["quick"] },
		{ name: "red", run: node("process.exit(3)") },
	]);
	try {
		const shape = (mode: "full" | "quick") => {
			const report = quiet(() => verify(f.root, task, "author", mode)).value!;
			return { passed: report.passed, checks: report.checks.map((c) => [c.name, c.passed, c.exitCode]) };
		};
		// OPS-144: format goes first, and an author run stops at its first failure.
		const format = ["format", true, 0];
		assert.deepEqual(shape("full"), {
			passed: false,
			checks: [format, ["both", true, 0], ["full-only", true, 0], ["red", false, 3]],
		});
		assert.deepEqual(shape("quick"), {
			passed: false,
			checks: [format, ["both", true, 0], ["quick-only", true, 0], ["red", false, 3]],
		});

		tickets(f.dir, [1, 2, 3]);
		assert.equal(
			withShipQueue(f.root, "OPS-1", () => "merged", { waitMs: 200, pollMs: 20 }),
			"merged",
			"a full check queue does not hold up a ship",
		);
		assert.equal(existsSync(join(evfDataDir(f.root), "ship-queue/lock.json")), false);
	} finally {
		f.close();
	}
});
