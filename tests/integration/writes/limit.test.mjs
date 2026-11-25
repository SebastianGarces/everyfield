import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { limitFailure } from "./failures.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));

async function census(t, suite, limit) {
	const directory = await mkdtemp(join(tmpdir(), "evf-census-limit-"));
	const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...env } = process.env;
	const child = spawn(process.execPath, ["--test", "--test-reporter=spec", fixture("census-limit.mjs")], {
		env: { ...env, CENSUS_FIXTURE: directory, CENSUS_SUITE: suite, CENSUS_LIMIT: String(limit) },
		stdio: ["ignore", "pipe", "inherit"],
		signal: t.signal,
	});
	const pids = () => {
		const file = join(directory, "pids.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	};
	t.after(() => spawnSync("kill", ["-KILL", ...remaining(pids())]));
	let log = "";
	child.stdout.on("data", (chunk) => (log += chunk));
	const [exit] = await once(child, "close");
	return { directory, exit, log, pids: pids() };
}

function remaining(pids) {
	let left = pids;
	for (let look = 0; left.length && look < 100; look++) {
		const { stdout } = spawnSync("ps", ["-o", "pid=,stat=", "-p", left.join(",")], { encoding: "utf8" });
		const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/));
		left = rows.filter(([pid, stat]) => pid && !stat.startsWith("Z")).map(([pid]) => Number(pid));
	}
	return left;
}

test(
	"INV-census: at its limit the census names the phase, the files still running and the evidence, and leaves no child process",
	{ timeout: 60_000 },
	async (t) => {
		const { directory, exit, log, pids } = await census(t, "census-hanging.mjs", 12_000);
		assert.equal(exit, 1, log);
		assert.equal(pids.length, 3, "the hanging suite never started:\n" + log);
		assert.deepEqual(remaining(pids), []);
		const cause = /^ +Error: (The census reached[^]*?)\n +at /m.exec(log)?.[1].replace(/^ {2}/gm, "") ?? log;
		const shape = cause.replace(/\d+ s\b/g, "N s").replace(/load average .*/, "load average N");
		assert.equal(
			shape,
			[
				`The census reached its N s limit in its behaviors phase; evidence: ${directory}`,
				"Elapsed: N s (requests N s, behaviors N s); load average N",
				"Suite files finished: 1 of 2",
				"Still running:",
				`  ${fixture("census-hanging.mjs")} (N s)`,
				"Slowest finished:",
				`  ${fixture("census-passing.mjs")} (N s)`,
			].join("\n"),
		);
	},
);

test(
	"INV-census: inside its limit a passing census passes, and a failing suite keeps its own error",
	{ timeout: 60_000 },
	async (t) => {
		const passing = await census(t, "census-passing.mjs", 50_000);
		assert.equal(passing.exit, 0, passing.log);
		assert.match(passing.log, /the census passed/);
		const failing = await census(t, "census-failing.mjs", 50_000);
		assert.equal(failing.exit, 1, failing.log);
		assert.match(failing.log, /Error: behaviors failed: .*behaviors\.log/);
		assert.doesNotMatch(failing.log, /reached its/);
		assert.match(readFileSync(join(failing.directory, "behaviors.log"), "utf8"), /planted failure/);
	},
);

test("INV-census: the limit message lists the slowest files first and says when no suite file started", () => {
	const at = (event, file, ms) => ({ event, file, at: ms });
	const minute = 60_000;
	const base = { limit: 30 * minute, directory: "/tmp/census", now: 30 * minute, load: [20.04, 18, 9.5] };
	const files = ["a", "b", "c", "d"];
	const requests = { label: "requests", at: 0 };
	assert.equal(
		limitFailure({ ...base, files, phases: [requests], rows: [] }),
		[
			"The census reached its 30 min 0 s limit in its requests phase; evidence: /tmp/census",
			"Elapsed: 30 min 0 s (requests 30 min 0 s); load average 20.0 18.0 9.5",
			"Suite files finished: 0 of 4",
			"Still running: none",
			"Slowest finished: none",
		].join("\n"),
	);
	const rows = [
		at("start", "a", 2 * minute),
		at("start", "b", 2 * minute),
		at("finish", "a", 3 * minute),
		at("start", "c", 3 * minute),
		at("finish", "b", 8 * minute),
	];
	const phases = [requests, { label: "native", at: minute }, { label: "behaviors", at: 2 * minute }];
	assert.equal(
		limitFailure({ ...base, files, phases, rows }),
		[
			"The census reached its 30 min 0 s limit in its behaviors phase; evidence: /tmp/census",
			"Elapsed: 30 min 0 s (requests 1 min 0 s, native 1 min 0 s, behaviors 28 min 0 s); load average 20.0 18.0 9.5",
			"Suite files finished: 2 of 4",
			"Still running:",
			"  c (27 min 0 s)",
			"Slowest finished:",
			"  b (6 min 0 s)",
			"  a (1 min 0 s)",
		].join("\n"),
	);
});
