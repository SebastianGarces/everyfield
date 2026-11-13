import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RECORD_KEYS, wrapSetupCommands } from "../../scripts/setup-step.mjs";

const stack = fileURLToPath(new URL("../../scripts/stack.mjs", import.meta.url));
const wrapper = fileURLToPath(new URL("../../scripts/setup-step.mjs", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "postgres://user:hunter2@db.example.test/everyfield";

// Like Portless: jobs get only PATH and HOME, the config env and the preview's own keys. A production preview
// runs install and build in a source snapshot without .git; a development preview runs install in the worktree.
const fakePortless = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[1] === 'status') { console.log('[]'); process.exit(0); }
const project = args[args.indexOf('--project') + 1];
const mode = args[args.indexOf('--mode') + 1];
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
const cwd = mode === 'production' ? path.join(process.env.FAKE_ROOT, 'snapshot') : project;
fs.mkdirSync(cwd, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...config.env, PREVIEW_SHA: '${SHA}', PREVIEW_URL: 'http://p1.localhost:1355' };
for (const phase of mode === 'production' ? ['install', 'build'] : ['install']) {
  const r = spawnSync(config[phase][0], config[phase].slice(1), { cwd, env, encoding: 'utf8' });
  fs.appendFileSync(path.join(process.env.FAKE_ROOT, 'jobs.log'), phase + ' ' + r.status + ' ' + r.stdout);
  if (r.status !== 0) process.exit(1);
}
console.log(JSON.stringify({ id: '1', project, head: '${SHA}', branch: 't', mode, state: 'ready', url: 'http://p1.localhost:1355' }));
`;

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-step-test-")));
	return { root, records: join(root, "records"), close: () => rmSync(root, { recursive: true, force: true }) };
}

function readStore(dir) {
	return readdirSync(dir)
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** Run a command through the wrapper, as Portless would run a wrapped config command. */
function wrapped(cwd, records, step, command, env = {}) {
	return spawnSync(
		process.execPath,
		[wrapper, "run", "--source", "stack", "--step", step, "--records", records, "--", ...command],
		{ cwd, encoding: "utf8", env: { PATH: process.env.PATH, PREVIEW_SHA: SHA, ...env } },
	);
}

test("T-39: stack up records one install and one build setup step with exactly the listed fields", () => {
	const f = fixture();
	try {
		const bin = join(f.root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "portless"), fakePortless);
		chmodSync(join(bin, "portless"), 0o755);
		const project = join(f.root, "project");
		mkdirSync(join(project, "scripts"), { recursive: true });
		const stub = (label) => [process.execPath, "-e", `console.log(${JSON.stringify(label)})`];
		writeFileSync(
			join(project, "scripts/preview.json"),
			JSON.stringify({
				install: stub("installed"),
				dev: stub("dev"),
				build: stub("built"),
				start: stub("start"),
				env: { A: "1" },
			}),
		);
		const r = spawnSync(process.execPath, [stack, "up", "--project", project, "--mode", "production"], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				FAKE_ROOT: f.root,
				EVF_SETUP_STEPS_DIR: f.records,
				EVF_TASK: "T-39",
				EVF_ROLE: "implementer",
				DATABASE_URL: SECRET,
			},
		});
		assert.equal(r.status, 0, r.stderr);
		// The commands ran with their own output, inside the wrapper.
		assert.equal(readFileSync(join(f.root, "jobs.log"), "utf8"), "install 0 installed\nbuild 0 built\n");
		const records = readStore(f.records).sort((a, b) => a.step.localeCompare(b.step));
		assert.equal(records.length, 2);
		for (const record of records) {
			assert.deepEqual(Object.keys(record).sort(), [...RECORD_KEYS].sort());
			assert.ok(Number.isInteger(record.durationMs) && record.durationMs >= 0);
			assert.ok(!Number.isNaN(Date.parse(record.startedAt)));
			assert.ok(!JSON.stringify(record).includes("hunter2"));
			assert.ok(!JSON.stringify(record).includes(process.execPath));
		}
		assert.deepEqual(
			records.map(({ task, head, role, source, step, cacheState }) => ({ task, head, role, source, step, cacheState })),
			[
				{ task: "T-39", head: SHA, role: "implementer", source: "stack", step: "build", cacheState: "miss" },
				{ task: "T-39", head: SHA, role: "implementer", source: "stack", step: "install", cacheState: "unknown" },
			],
		);
		// The record files and the timed config live outside the project.
		assert.deepEqual(readdirSync(project), ["scripts"]);
	} finally {
		f.close();
	}
});

test("T-39: wrapping changes only install and build, which keep their exact commands", () => {
	const real = JSON.parse(readFileSync(fileURLToPath(new URL("../../scripts/preview.json", import.meta.url)), "utf8"));
	const env = { ...process.env };
	delete process.env.EVF_TASK;
	delete process.env.EVF_ROLE;
	try {
		for (const source of ["stack", "verify-preview"]) {
			const timed = wrapSetupCommands(real, { source, records: "/records", node: "/node" });
			assert.deepEqual({ ...timed, install: real.install, build: real.build }, real);
			for (const step of ["install", "build"])
				assert.deepEqual(timed[step], [
					"/node",
					wrapper,
					"run",
					"--source",
					source,
					"--step",
					step,
					"--records",
					"/records",
					"--",
					...real[step],
				]);
		}
	} finally {
		Object.assign(process.env, env);
	}
});

test("T-39: a verify-preview build of a checkout without the wrapper is still timed from the verifier's checkout", () => {
	const f = fixture();
	try {
		// The previewed commit predates this change: it has no scripts/setup-step.mjs at all.
		const old = join(f.root, "old-commit");
		mkdirSync(old);
		const timed = wrapSetupCommands(
			{ install: [process.execPath, "-e", "0"], build: [process.execPath, "-e", "0"], dev: ["x"] },
			{ source: "verify-preview", records: f.records, node: process.execPath },
		);
		for (const step of ["install", "build"]) {
			const r = spawnSync(timed[step][0], timed[step].slice(1), {
				cwd: old,
				encoding: "utf8",
				env: { PATH: process.env.PATH, PREVIEW_SHA: SHA },
			});
			assert.equal(r.status, 0, r.stderr);
		}
		assert.deepEqual(
			readStore(f.records)
				.map((r) => `${r.source} ${r.step} ${r.cacheState} ${r.head}`)
				.sort(),
			[`verify-preview build miss ${SHA}`, `verify-preview install unknown ${SHA}`],
		);
	} finally {
		f.close();
	}
});

test("T-39: build cache state is miss for a missing or empty .next/cache and hit when it has content; install is unknown", () => {
	const f = fixture();
	try {
		const cases = { missing: null, empty: [], populated: ["fetch-cache"] };
		const states = {};
		for (const [name, entries] of Object.entries(cases)) {
			const cwd = join(f.root, name);
			mkdirSync(cwd);
			if (entries) {
				mkdirSync(join(cwd, "apps/web/.next/cache"), { recursive: true });
				for (const entry of entries) mkdirSync(join(cwd, "apps/web/.next/cache", entry));
			}
			const records = join(f.root, `records-${name}`);
			// The build fills the cache; the state is read before the build starts.
			const r = wrapped(cwd, records, "build", [
				process.execPath,
				"-e",
				"require('fs').mkdirSync('apps/web/.next/cache/new', {recursive: true})",
			]);
			assert.equal(r.status, 0, r.stderr);
			assert.equal(wrapped(cwd, records, "install", [process.execPath, "-e", "0"]).status, 0);
			states[name] = readStore(records)
				.map((x) => `${x.step}:${x.cacheState}`)
				.sort();
		}
		assert.deepEqual(states, {
			missing: ["build:miss", "install:unknown"],
			empty: ["build:miss", "install:unknown"],
			populated: ["build:hit", "install:unknown"],
		});
	} finally {
		f.close();
	}
});

test("T-39: the wrapper passes output and exit code through, and still records a failed command's duration", () => {
	const f = fixture();
	try {
		const failing = [
			process.execPath,
			"-e",
			"process.stdout.write('out'); process.stderr.write('err'); setTimeout(() => process.exit(3), 50)",
		];
		const r = wrapped(f.root, f.records, "build", failing, { DATABASE_URL: SECRET });
		assert.equal(r.status, 3);
		assert.equal(r.stdout, "out");
		assert.equal(r.stderr, "err");
		const [record] = readStore(f.records);
		assert.ok(record.durationMs >= 50);
		assert.ok(!JSON.stringify(record).includes("hunter2"));
		// A record directory that cannot be written warns and leaves the result as it was.
		const blocked = join(f.root, "not-a-dir");
		writeFileSync(blocked, "");
		const ok = wrapped(f.root, blocked, "install", [process.execPath, "-e", "process.stdout.write('fine')"]);
		assert.equal(ok.status, 0);
		assert.equal(ok.stdout, "fine");
		assert.match(ok.stderr, /^setup-step: could not write the install record .*the command result is unchanged\.\n$/);
		const bad = wrapped(f.root, blocked, "install", failing);
		assert.deepEqual([bad.status, bad.stdout], [3, "out"]);
		assert.match(bad.stderr, /^errsetup-step: could not write/);
	} finally {
		f.close();
	}
});

test("T-39: the setup report gives weekly totals, medians and hit rates, and no data where nothing was measured", () => {
	const f = fixture();
	try {
		mkdirSync(f.records);
		const at = (day, ms, source, step, cacheState) => ({
			task: null,
			head: SHA,
			role: null,
			source,
			step,
			startedAt: `2026-11-${day}T10:00:00.000Z`,
			durationMs: ms,
			cacheState,
		});
		const rows = [
			// ISO week 45: Nov 2 to Nov 8.
			at("02", 60_000, "stack", "build", "miss"),
			at("03", 120_000, "stack", "build", "hit"),
			at("04", 30_000, "stack", "build", "hit"),
			at("05", 200_000, "verify-preview", "install", "unknown"),
			at("08", 1_000, "stack", "install", "unknown"),
			// Week 46 has no records. Week 47: Nov 16 to Nov 22.
			at("16", 90_000, "verify-preview", "build", "miss"),
		];
		rows.forEach((row, i) => writeFileSync(join(f.records, `${i}.json`), JSON.stringify(row)));
		const report = (...args) =>
			spawnSync(process.execPath, [wrapper, "report", "--records", f.records, ...args], { encoding: "utf8" });
		const json = report("--json");
		assert.equal(json.status, 0, json.stderr);
		assert.deepEqual(JSON.parse(json.stdout), {
			weeks: [
				{
					week: "2026-W45",
					pairs: [
						{ source: "stack", step: "build", runs: 3, totalMs: 210_000, medianMs: 60_000, hitRate: 2 / 3 },
						{ source: "verify-preview", step: "install", runs: 1, totalMs: 200_000, medianMs: 200_000, hitRate: null },
						{ source: "stack", step: "install", runs: 1, totalMs: 1_000, medianMs: 1_000, hitRate: null },
					],
				},
				{ week: "2026-W46", pairs: [] },
				{
					week: "2026-W47",
					pairs: [{ source: "verify-preview", step: "build", runs: 1, totalMs: 90_000, medianMs: 90_000, hitRate: 0 }],
				},
			],
		});
		const text = report().stdout.split("\n");
		assert.equal(text[0], "2026-W45");
		assert.match(text[1], /^ {2}stack build +runs +3 +total +3\.5 min +median +1\.0 min +hit rate 67%$/);
		assert.match(text[2], /^ {2}verify-preview install .* hit rate no data$/);
		assert.deepEqual(text.slice(4, 6), ["2026-W46", "  no data"]);
		assert.match(text[7], /hit rate 0%$/);
		const empty = spawnSync(process.execPath, [wrapper, "report", "--records", join(f.root, "none")], {
			encoding: "utf8",
		});
		assert.equal(empty.stdout, "no data\n");
		const emptyJson = spawnSync(process.execPath, [wrapper, "report", "--json", "--records", join(f.root, "none")], {
			encoding: "utf8",
		});
		assert.deepEqual(JSON.parse(emptyJson.stdout), { weeks: [] });
	} finally {
		f.close();
	}
});
