import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { source } from "./fixtures.ts";
import {
	delay,
	MAIN,
	node,
	preview,
	queueFixture,
	specOf,
	STUB_TESTS,
	ticketName,
	TOOL_STUB,
	UI_STUB,
	until,
	watch,
} from "./queue-fixture.ts";
import { budgetEnv, testBudget, failedTestFlags } from "../budget.ts";
import { CHECK_CAP, withCheckQueue } from "../check-queue.ts";
import { checkCiTests } from "../ci-tests.ts";
import { WaitGaveUp } from "../lib.ts";
import { awaitLoad, DEFAULT_LOAD, type MemoryProbe } from "../load.ts";
import { machineProbes } from "../sampler.ts";

/** OPS-151. Each test carries the marker of the Done criterion it proves, so `evf ac run OPS-151` runs this file. */

const MEMORY = { maxPerCore: 1_000_000, maxWaitMinutes: 0, memoryFloorPct: 15, swapCeilingGb: 12 };

/**
 * A queue fixture with a machine of 12 cores, a log of each spawned `--test` command line and a fake `sysctl`. The fake reports the
 * files `mem` and `swap`, fails while `fail` exists, counts its reads in `reads` and reports `insideMem` to a process
 * that holds a slot token. `lowReads` makes the first n reads report 1% free.
 */
function budgetFixture(checks?: Parameters<typeof queueFixture>[0]) {
	const f = queueFixture(checks);
	const bin = join(f.root, "fake-bin"),
		state = (name: string) => join(bin, name),
		argvLog = state("argv.log"),
		log = state("order.log");
	const coresJs = state("cores.mjs"),
		argvJs = state("argv.mjs");
	writeFileSync(
		coresJs,
		`import os from "node:os";\nimport { syncBuiltinESMExports } from "node:module";\nos.availableParallelism = () => 12;\nsyncBuiltinESMExports();\n`,
	);
	writeFileSync(
		argvJs,
		`import childProcess from "node:child_process";\nimport { appendFileSync } from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nconst real = childProcess.spawnSync;\nchildProcess.spawnSync = (command, args, options) => {\n\tif (args?.includes("--test")) appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");\n\treturn real(command, args, options);\n};\nsyncBuiltinESMExports();\n`,
	);
	writeFileSync(state("mem"), "60");
	writeFileSync(state("swap"), "1");
	writeFileSync(
		state("sysctl"),
		`#!/bin/sh
d=${JSON.stringify(bin)}
echo x >> "$d/reads"
[ -e "$d/fail" ] && exit 1
case "$2" in
kern.memorystatus_level)
	if [ -n "$EVF_CHECK_SLOT" ] && [ -e "$d/insideMem" ]; then cat "$d/insideMem"
	elif [ "$(wc -l < "$d/reads")" -le "$(cat "$d/lowReads" 2>/dev/null || echo 0)" ]; then echo 1
	else cat "$d/mem"; fi ;;
vm.swapusage) echo "total = 1.00M  used = $(cat "$d/swap")G  free = 1.00M  (encrypted)" ;;
esac
`,
		{ mode: 0o755 },
	);
	const options = `${process.env.NODE_OPTIONS ?? ""} --import=${coresJs} --import=${argvJs}`;
	return {
		...f,
		state,
		log,
		options,
		/** A seat command on the 12-core machine, with load preload `load` on top. */
		seat: (
			cwd: string,
			args: string[],
			load?: keyof typeof f.preloads,
			env: NodeJS.ProcessEnv = {},
		): ReturnType<typeof f.cli> =>
			f.cli(cwd, args, undefined, {
				NODE_OPTIONS: `${options}${load ? ` --import=${f.preloads[load]}` : ""}`,
				EVF_ORDER_LOG: log,
				...env,
			}),
		argv: () =>
			existsSync(argvLog)
				? readFileSync(argvLog, "utf8")
						.trim()
						.split("\n")
						.map((l) => JSON.parse(l) as string[])
				: [],
		reads: () => (existsSync(state("reads")) ? readFileSync(state("reads"), "utf8").trim().split("\n").length : 0),
		order: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
	};
}
const concurrency = (argv: string[]) => argv.filter((a) => a.startsWith("--test-concurrency="));

/** Fails instead of hanging the suite when a command deadlocks. */
async function within(ms: number, what: string, done: Promise<number | null>) {
	let timer: NodeJS.Timeout;
	const late = new Promise<never>(
		(_, no) => (timer = setTimeout(() => no(new Error(`${what}: no end in ${ms} ms`)), ms)),
	);
	try {
		return await Promise.race([done, late]);
	} finally {
		clearTimeout(timer!);
	}
}

/** One stub test file: it logs its start, waits and logs its end. A process that outlives a SIGKILL stops at `release`. */
const slowStub = (name: string, ms: number) =>
	`import test from "node:test";\nimport { appendFileSync } from "node:fs";\nconst log = (t) => appendFileSync(process.env.EVF_ORDER_LOG, t + "\\n");\ntest("${name}", async () => {\n\tlog("start ${name}");\n\tawait new Promise((d) => setTimeout(d, ${ms}));\n\tlog("end ${name}");\n});\n`;
const holdingStub = (release: string) =>
	`import test from "node:test";\nimport { existsSync } from "node:fs";\nconst end = Date.now() + 60000;\ntest("hold", async () => {\n\twhile (!process.env.EVF_NO_HOLD && !existsSync(${JSON.stringify(release)}) && Date.now() < end) await new Promise((d) => setTimeout(d, 20));\n});\n`;
const interleaved = (order: string[]) =>
	order.some((line, i) => line.startsWith("start") && order[i + 1]?.startsWith("start"));

test("the budget of 12 cores and a cap of 3 reaches node, and a later explicit --test-concurrency wins (AC:OPS-151-1)", async () => {
	assert.deepEqual(testBudget(12, 3, false), {
		testProcesses: 4,
		pnpmConcurrency: 4,
		packageTestProcesses: 1,
		nextWorkers: 4,
	});
	const f = budgetFixture();
	try {
		f.commitFiles(
			{ "tools/evf/tests/a.test.ts": slowStub("a", 500), "tools/evf/tests/b.test.ts": slowStub("b", 500) },
			f.root,
		);
		const budgeted = f.seat(f.root, ["test"]);
		assert.equal(await budgeted.done, 0, budgeted.err());
		assert.deepEqual(concurrency(f.argv()[0]!), ["--test-concurrency=4"]);
		assert.ok(interleaved(f.order()), `under the budget the two files overlap: ${f.order().join(", ")}`);

		rmSync(f.log);
		const explicit = f.seat(f.root, ["test", "--test-concurrency=1"]);
		assert.equal(await explicit.done, 0, explicit.err());
		assert.deepEqual(concurrency(f.argv()[1]!), ["--test-concurrency=4", "--test-concurrency=1"]);
		assert.equal(interleaved(f.order()), false, `node used the later value: ${f.order().join(", ")}`);
	} finally {
		await f.finish();
	}
});

test("3 full checks together never go over the cores (AC:OPS-151-2)", () => {
	for (const cores of [4, 12, 16]) {
		const b = testBudget(cores, CHECK_CAP, false);
		assert.equal(CHECK_CAP, 3);
		for (const total of [b.testProcesses, b.nextWorkers, b.pnpmConcurrency * b.packageTestProcesses])
			assert.ok(3 * total <= cores, `${cores} cores: 3 × ${total}`);
		for (const value of Object.values(b)) assert.ok(value >= 1, `${cores} cores: ${JSON.stringify(b)}`);
	}
});

test("evf verify gives its check children the budget through the three variables (AC:OPS-151-3)", async () => {
	const out = "EVF_BUDGET_OUT";
	const f = budgetFixture([
		{
			name: "prints",
			run: node(
				`const e=process.env;require("node:fs").writeFileSync(e.${out},JSON.stringify([e.npm_config_workspace_concurrency,e.EVF_NODE_TEST_FLAGS,e.EVF_NEXT_WORKERS]))`,
			),
		},
	]);
	try {
		const file = f.state("budget.json");
		for (const args of [
			["verify", "OPS-1"],
			["verify", "OPS-1", "--quick"],
		]) {
			rmSync(file, { force: true });
			const run = f.seat(f.wt, args, undefined, { [out]: file });
			assert.equal(await run.done, 0, run.err());
			assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["4", "--test-concurrency=1", "4"]);
		}
		assert.deepEqual(budgetEnv(testBudget(12, 3, false)), {
			npm_config_workspace_concurrency: "4",
			EVF_NODE_TEST_FLAGS: "--test-concurrency=1",
			EVF_NEXT_WORKERS: "4",
		});
	} finally {
		await f.finish();
	}
});

test("a checkout path the shell would split gives no reporter flags, so a package script still runs (T-2)", () => {
	assert.match(
		failedTestFlags("/repo/tools/evf/r.mjs"),
		/--test-reporter=spec .*--test-reporter=\/repo\/tools\/evf\/r\.mjs /,
	);
	for (const path of ["/my repo/r.mjs", "/repo*/r.mjs", "/repo$x/r.mjs"]) assert.equal(failedTestFlags(path), "");
});

/** Every package script of the files `evf ci-tests` reads, with the one `evf verify` never runs. */
function packageFiles(root: string) {
	return [
		"package.json",
		...readdirSync(join(root, "packages")).map((p) => `packages/${p}/package.json`),
		...readdirSync(join(root, "apps")).map((p) => `apps/${p}/package.json`),
	].filter((file) => existsSync(join(root, file)));
}
/** tests/ui is a browser suite that needs a preview. No configured check reaches it, and browsers are out of the budget. */
const BROWSER_SCRIPTS = new Set(["package.json:test:ui"]);
/** The node or tsx test commands of one script that carry neither the budget variable nor their own limit of 1. */
const unbudgeted = (script: string) =>
	script
		.split(/\s*(?:&&|\|\||;)\s*/)
		.filter((part) => /^(?:\S+=\S+ )*(?:node|tsx)\b.*\s--test(\s|$)/.test(part))
		.filter(
			(part) => !part.includes("--test ${EVF_NODE_TEST_FLAGS:-}") && !part.includes("--test --test-concurrency=1"),
		);

test("every package test command carries the budget, next.config reads the workers, ci-tests finds the same files (AC:OPS-151-4)", () => {
	assert.deepEqual(unbudgeted("node --test a.test.mts"), ["node --test a.test.mts"], "the check sees a bare command");
	assert.deepEqual(unbudgeted("pnpm x && tsx --conditions=y --test b.test.mts"), [
		"tsx --conditions=y --test b.test.mts",
	]);
	assert.deepEqual(
		unbudgeted("node --test ${EVF_NODE_TEST_FLAGS:-} a.test.mts && tsx --test --test-concurrency=1 b"),
		[],
	);

	let scripts = 0;
	for (const file of packageFiles(source)) {
		const pkg = JSON.parse(readFileSync(join(source, file), "utf8")) as { scripts?: Record<string, string> };
		for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
			if (BROWSER_SCRIPTS.has(`${file}:${name}`)) continue;
			if (/\s--test(\s|$)/.test(script)) scripts++;
			assert.deepEqual(unbudgeted(script), [], `${file} script ${name}`);
		}
	}
	assert.ok(scripts >= 20, `the walk reached the real scripts: ${scripts}`);
	const config = readFileSync(join(source, "apps/web/next.config.ts"), "utf8");
	assert.match(config, /cpus: Number\(process\.env\.EVF_NEXT_WORKERS\)/);

	// With the flag taken back out of each script, ci-tests prints the same coverage line: the flag hides no test file.
	const copy = mkdtempSync(join(tmpdir(), "evf-ci-tests-"));
	const lines = (root: string) => {
		const { log } = console,
			out: string[] = [];
		console.log = (...a: unknown[]) => void out.push(a.join(" "));
		try {
			checkCiTests(root);
		} finally {
			console.log = log;
		}
		return out;
	};
	try {
		const tracked = execFileSync("git", ["ls-files", "tests", "packages", "apps", ".github/workflows/ci.yml"], {
			cwd: source,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		}).split("\n");
		const put = (path: string, text: string) => {
			mkdirSync(dirname(join(copy, path)), { recursive: true });
			writeFileSync(join(copy, path), text);
		};
		for (const path of tracked.filter((p) => /\.test\.\w+$/.test(p))) put(path, "");
		for (const path of [
			"tests/integration/writes/suites.json",
			".github/workflows/ci.yml",
			"tools/evf/ci-test-exceptions.json",
		])
			if (existsSync(join(source, path))) put(path, readFileSync(join(source, path), "utf8"));
		for (const file of packageFiles(source))
			put(file, readFileSync(join(source, file), "utf8").replaceAll(" ${EVF_NODE_TEST_FLAGS:-}", ""));
		const real = lines(source);
		assert.match(real.at(-1)!, /^CI includes all \d+ test files/);
		assert.deepEqual(real, lines(copy));
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
});

test("evf ac run passes the budget to its node engine tests and leaves the browser command alone (AC:OPS-151-5)", async () => {
	const f = budgetFixture();
	try {
		f.setSpec(specOf("OPS-1-1"));
		f.commitFiles({ "tools/evf/tests/tool.test.ts": TOOL_STUB });
		const run = f.seat(f.wt, ["ac", "run", "OPS-1"]);
		assert.equal(await run.done, 0, run.err() + run.out());
		const tool = f.argv()[0]!;
		assert.deepEqual(concurrency(tool), ["--test-concurrency=4"]);
		assert.equal(tool[0], "--test");

		rmSync(f.state("argv.log"));
		f.git("-C", f.wt, "rm", "-q", "tools/evf/tests/tool.test.ts");
		f.commitFiles({ "tests/ui/browser.test.mjs": UI_STUB });
		preview(f);
		const browser = f.seat(f.wt, ["ac", "run", "OPS-1"]);
		await browser.done;
		const browsers = f.argv().filter((argv) => argv.some((a) => a.includes("video")));
		assert.ok(browsers.length >= 2, `chromium and webkit: ${JSON.stringify(f.argv())}`);
		for (const argv of browsers) assert.deepEqual(concurrency(argv), [], "the browser command gets no budget flag");
	} finally {
		await f.finish();
	}
});

test("in GitHub CI evf test uses the whole runner, takes no slot and reads no load, memory or swap (AC:OPS-151-6)", async () => {
	assert.equal(testBudget(12, 3, true).testProcesses, 12);
	const f = budgetFixture();
	try {
		f.setLoad({ ...MEMORY, maxPerCore: 0.000001 });
		f.commitFiles({ "tools/evf/tests/stub.test.ts": STUB_TESTS }, f.root);
		writeFileSync(f.state("mem"), "1");
		[1, 2, 3].forEach(f.holder);
		const before = f.tickets();
		const ci = f.seat(f.root, ["test"], "high", { GITHUB_ACTIONS: "true" });
		assert.equal(await within(60_000, "evf test in CI", ci.done), 0, ci.err());
		assert.deepEqual(concurrency(f.argv()[0]!), ["--test-concurrency=12"]);
		assert.doesNotMatch(ci.err(), /waits in the full check queue|waiting,/);
		assert.deepEqual(f.tickets(), before);
		assert.equal(f.reads(), 0);
	} finally {
		await f.finish();
	}
});

test("a fourth direct evf test waits for a slot, prints its position and starts when a slot frees (AC:OPS-151-7)", async () => {
	const f = budgetFixture();
	try {
		f.commitFiles({ "tools/evf/tests/stub.test.ts": STUB_TESTS }, f.root);
		const [first] = [1, 2, 3].map(f.holder);
		const fourth = f.seat(f.root, ["test"]);
		await until("the position", () =>
			/evf test waits in the full check queue, position 1, 3 running/.test(fourth.err()),
		);
		await delay(200);
		assert.deepEqual(f.argv(), [], "no test process started");
		await f.stop(first!);
		assert.equal(await within(60_000, "the fourth evf test", fourth.done), 0, fourth.err());
		assert.equal(f.argv().length, 1);
		assert.equal(f.tickets().length, 2, "its own ticket is gone");
	} finally {
		await f.finish();
	}
});

test("an evf test inside a full verify takes no second slot and repeats no wait; inside --quick it takes its own (AC:OPS-151-8)", async () => {
	const nested = {
		name: "nested",
		run: node(
			`const r=require("node:child_process").spawnSync(process.execPath,[${JSON.stringify(MAIN)},"test"],{encoding:"utf8",env:{...process.env,NODE_TEST_CONTEXT:undefined}});console.log(r.stdout);console.error(r.stderr);process.exit(r.status)`,
		),
	};
	const f = budgetFixture([nested]);
	try {
		const counted = `import test from "node:test";\nimport { appendFileSync, readdirSync } from "node:fs";\ntest("count", () => appendFileSync(process.env.EVF_ORDER_LOG, readdirSync(${JSON.stringify(f.dir)}).length + "\\n"));\n`;
		f.commitFiles({ "tools/evf/tests/stub.test.ts": counted });
		f.setLoad({ ...MEMORY, maxPerCore: 1 });
		// Inside a slot both the load and the memory read short with no time to wait: one more wait fails the check.
		writeFileSync(f.state("insideMem"), "1");
		[1, 2].forEach(f.holder);
		const full = f.seat(f.wt, ["verify", "OPS-1"], "inside");
		assert.equal(await within(120_000, "the full verify", full.done), 0, full.err() + full.out());
		assert.doesNotMatch(full.err(), /waits in the full check queue|waiting,/);
		assert.deepEqual(f.order(), ["3"], "two holders and this verify; no second slot");
		const readsOfVerify = f.reads();
		assert.equal(readsOfVerify, 2, "one memory and one swap read, by the verify");

		rmSync(f.log);
		const quick = f.seat(f.wt, ["verify", "OPS-1", "--quick"], "inside");
		assert.equal(await within(120_000, "the quick verify", quick.done), 0, quick.err() + quick.out());
		assert.deepEqual(f.order(), ["3"], "two holders and the nested evf test, because the quick verify holds none");
		assert.equal(f.tickets().length, 2, "its own slot is free again");
	} finally {
		await f.finish();
	}
});

test("a token with a dead holder or another queue folder gives no bypass (AC:OPS-151-9)", async () => {
	const f = budgetFixture();
	try {
		f.commitFiles({ "tools/evf/tests/stub.test.ts": STUB_TESTS }, f.root);
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		const holders = [1, 2, 3].map(f.holder);
		const deadTicket = join(f.dir, ticketName(0));
		writeFileSync(deadTicket, JSON.stringify({ pid: dead, task: "gone", at: new Date().toISOString() }));
		const other = mkdtempSync(join(tmpdir(), "evf-other-queue-"));
		try {
			const liveTicket = join(other, ticketName(1));
			writeFileSync(liveTicket, JSON.stringify({ pid: process.pid, task: "other", at: new Date().toISOString() }));
			for (const [i, token] of [deadTicket, liveTicket].entries()) {
				const run = f.seat(f.root, ["test"], undefined, { EVF_CHECK_SLOT: token });
				await until("the position", () => /position 1, 3 running/.test(run.err()));
				assert.deepEqual(f.argv().length, i, "it waits as a direct command");
				await f.stop(holders[i]!);
				assert.equal(await within(60_000, "the queued evf test", run.done), 0, run.err());
				assert.equal(f.argv().length, i + 1);
				f.holder(10 + i);
			}
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	} finally {
		await f.finish();
	}
});

/** A fake clock: each sleep advances it. */
function clock() {
	let now = 0;
	return {
		read: () => 0,
		sleep: (ms: number) => void (now += ms),
		now: () => now,
		at: () => now,
	};
}
function captured<T>(fn: () => T): { value?: T; thrown?: unknown; lines: string[] } {
	const { error } = console,
		lines: string[] = [];
	console.error = (...a: unknown[]) => void lines.push(a.join(" "));
	try {
		return { value: fn(), lines };
	} catch (thrown) {
		return { thrown, lines };
	} finally {
		console.error = error;
	}
}

test("a full check waits on free memory and on swap, prints each minute, starts on recovery, gives up at 30 min (AC:OPS-151-10)", async () => {
	const f = budgetFixture();
	try {
		f.setLoad(DEFAULT_LOAD);
		const cases: Array<[string, (t: () => number) => MemoryProbe, RegExp]> = [
			[
				"free memory",
				(t) => ({ freeMemPct: () => (t() < 150_000 ? 9 : 40), swapUsedGb: () => 1 }),
				/free memory 9%, floor 15%/,
			],
			[
				"swap",
				(t) => ({ freeMemPct: () => 40, swapUsedGb: () => (t() < 150_000 ? 13.5 : 11) }),
				/swap used 13\.5 GB, ceiling 12 GB/,
			],
		];
		for (const [what, probe, reading] of cases) {
			const c = clock();
			const { lines, thrown } = captured(() => awaitLoad(f.root, "verify", undefined, c, null, probe(c.at)));
			assert.equal(thrown, undefined, what);
			assert.equal(lines.length, 3, `${what}: one line per minute: ${lines.join(" | ")}`);
			lines.forEach((line, minute) => {
				assert.match(line, reading);
				assert.match(line, new RegExp(`waiting, ${minute} of 30 min`));
			});
			assert.ok(c.at() >= 150_000, `${what}: it started only after recovery`);
		}
		const c = clock();
		const short = captured(() =>
			awaitLoad(f.root, "verify", undefined, c, null, { freeMemPct: () => 9, swapUsedGb: () => 13.5 }),
		);
		assert.ok(short.thrown instanceof WaitGaveUp);
		assert.equal(c.at(), 30 * 60_000);
		assert.match(short.thrown.message, /short of memory or over its swap ceiling for 30 min/);
		assert.match(short.thrown.message, /free memory 9%, floor 15%; swap used 13\.5 GB, ceiling 12 GB/);

		// Through a real verify with the real probes: a give-up frees the slot and runs nothing; recovery starts the check.
		f.setLoad(MEMORY);
		writeFileSync(f.state("swap"), "13");
		const refused = f.seat(f.wt, ["verify", "OPS-1"]);
		assert.notEqual(await refused.done, 0);
		assert.match(refused.err(), /swap used 13\.0 GB, ceiling 12 GB/);
		assert.equal(existsSync(f.ran), false);
		assert.deepEqual(f.tickets(), [], "the slot is free");

		writeFileSync(f.state("swap"), "1");
		rmSync(f.state("reads"));
		writeFileSync(f.state("lowReads"), "1");
		f.setLoad({ ...MEMORY, maxWaitMinutes: 0.02 });
		const recovered = f.seat(f.wt, ["verify", "OPS-1"]);
		assert.equal(await recovered.done, 0, recovered.err());
		assert.match(recovered.err(), /free memory 1%, floor 15%; waiting/);
		assert.equal(existsSync(f.ran), true);
	} finally {
		await f.finish();
	}
});

test("--ignore-load skips the memory wait and logs one line; a failed or missing probe prints one line and blocks nothing (AC:OPS-151-11)", async () => {
	const f = budgetFixture();
	const path = process.env.PATH;
	try {
		f.setLoad(MEMORY);
		writeFileSync(f.state("mem"), "1");
		const forced = f.seat(f.wt, ["verify", "OPS-1", "--ignore-load", "fixture reason"]);
		assert.equal(await forced.done, 0, forced.err());
		assert.equal(existsSync(f.ran), true);
		assert.equal(f.reads(), 0, "the override reads no memory");
		assert.deepEqual(
			f.overrides().map((o) => [o.command, o.reason]),
			[["verify", "fixture reason"]],
		);

		rmSync(f.ran);
		writeFileSync(f.state("fail"), "");
		const failing = f.seat(f.wt, ["verify", "OPS-1"]);
		assert.equal(await failing.done, 0, failing.err());
		assert.equal(existsSync(f.ran), true);
		assert.equal(failing.err().match(/memory and swap not read/g)?.length, 1, failing.err());

		// The load stays high for two reads: a probe that failed once stays silent during the rest of this wait.
		const c = clock();
		let loads = 0;
		const broken = {
			freeMemPct: () => assert.fail("a failed probe is not read again"),
			swapUsedGb: () => 1,
		};
		let first = true;
		const once = { ...broken, freeMemPct: () => (first ? ((first = false), Number("x")) : broken.freeMemPct()) };
		f.setLoad({ ...MEMORY, maxPerCore: 1, maxWaitMinutes: 30 });
		const unit = captured(() =>
			awaitLoad(f.root, "verify", undefined, { ...c, read: () => (loads++ < 2 ? 1e6 : 0) }, null, once),
		);
		assert.equal(unit.thrown, undefined);
		assert.equal(unit.lines.filter((l) => /memory and swap not read/.test(l)).length, 1, unit.lines.join(" | "));

		// A platform with no sysctl at all.
		const empty = mkdtempSync(join(tmpdir(), "evf-no-sysctl-"));
		try {
			process.env.PATH = empty;
			const none = captured(() => awaitLoad(f.root, "verify", undefined, clock(), null, machineProbes(f.root)));
			assert.equal(none.thrown, undefined);
			assert.equal(none.lines.filter((l) => /memory and swap not read/.test(l)).length, 1, none.lines.join(" | "));
		} finally {
			process.env.PATH = path;
			rmSync(empty, { recursive: true, force: true });
		}
	} finally {
		process.env.PATH = path;
		await f.finish();
	}
});

test("SIGKILL of a direct evf test holder and of a verify holder frees the slot, and a waiter starts (AC:OPS-151-12)", async () => {
	const release = "fake-bin/release";
	const f = budgetFixture([
		{
			name: "hold",
			run: node(
				`const fs=require("node:fs");fs.appendFileSync(process.env.EVF_ORDER_LOG,"hold\\n");const end=Date.now()+60000;while(!fs.existsSync(process.env.EVF_RELEASE)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)`,
			),
		},
	]);
	const free = join(f.root, release);
	try {
		f.commitFiles({ "tools/evf/tests/hold.test.ts": holdingStub(free) }, f.root);
		f.git("-C", f.wt, "merge", "-q", "--no-edit", "main");
		const holders = [f.holder(1), f.holder(2)];
		const direct = f.seat(f.root, ["test"], undefined, { EVF_RELEASE: free });
		await until("the direct holder's ticket and test process", () => f.tickets().length === 3 && f.argv().length === 1);
		const waiter = f.seat(f.root, ["test"], undefined, { EVF_NO_HOLD: "1" });
		await until("the waiter", () => /position 1, 3 running/.test(waiter.err()));
		await f.stop(direct.child);
		assert.equal(await within(60_000, "the waiter after a killed evf test", waiter.done), 0, waiter.err());

		rmSync(f.log, { force: true });
		const verifying = f.seat(f.wt, ["verify", "OPS-1"], undefined, { EVF_RELEASE: free });
		await until("the verify holder's check", () => f.order().includes("hold"));
		const next = f.seat(f.root, ["test"], undefined, { EVF_NO_HOLD: "1" });
		await until("the second waiter", () => /position 1, 3 running/.test(next.err()));
		await f.stop(verifying.child);
		assert.equal(await within(60_000, "the waiter after a killed verify", next.done), 0, next.err());
		await Promise.all(holders.map(f.stop));
	} finally {
		// What a killed holder started may finish (a non-goal of OPS-138 and OPS-151); it stops here, before the folder goes.
		writeFileSync(free, "");
		await delay(200);
		await f.finish();
	}
});

test("the default on 12 cores and a cap of 3 is the value the PR chose (AC:OPS-151-14)", () => {
	// The OPS-151 PR body, "Comparison table": 4 test processes, which is cores / slots. The table states why it won.
	assert.equal(testBudget(12, 3, false).testProcesses, 4);
});

test("evf help and the README state the budget, the floor, the ceiling and the CI behavior (AC:OPS-151-15)", () => {
	const help = spawnSync(process.execPath, [MAIN, "help"], { encoding: "utf8" }).stdout.replace(/\s+/g, " ");
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8");
	const section = readme
		.slice(readme.indexOf("## Machine load limit"), readme.indexOf("## Full check queue"))
		.replace(/\s+/g, " ");
	for (const [name, text] of [
		["help", help],
		["README", section],
	] as const) {
		assert.ok(text.includes(`free memory is under ${DEFAULT_LOAD.memoryFloorPct}%`), `${name} floor`);
		assert.ok(text.includes(`swap used is over ${DEFAULT_LOAD.swapCeilingGb} GB`), `${name} ceiling`);
		assert.match(text, /cores \/ 3/, `${name} budget`);
		assert.match(text, /GitHub CI/, `${name} CI`);
		assert.match(text, /takes no (queue )?slot/, `${name} CI slot`);
	}
});

test("the checks and how they pass stay the same: a failing check under the budget still fails verify (AC:OPS-151-16)", async () => {
	// The names and commands on main when OPS-151 started. OPS-151 adds a budget and changes no check.
	const { checks } = JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8")) as {
		checks: Array<{ name: string; run: string[] }>;
	};
	assert.deepEqual(
		checks.map(({ name, run }) => ({ name, run })),
		[
			{ name: "workflow-regressions", run: ["bin/evf", "test"] },
			{ name: "documentation", run: ["python3", "docs/check-all.py"] },
			{ name: "local-app", run: ["corepack", "pnpm", "check"] },
			{ name: "package-unit-tests", run: ["corepack", "pnpm", "-r", "--if-present", "test:unit"] },
			{ name: "format", run: ["corepack", "pnpm", "format:check"] },
		],
	);
	const f = budgetFixture([{ name: "fails", run: node("process.exit(7)") }]);
	try {
		const run = f.seat(f.wt, ["verify", "OPS-1"]);
		assert.equal(await run.done, 1, run.err());
		assert.match(run.err(), /evf verify: fails failed\./);
	} finally {
		await f.finish();
	}
});
