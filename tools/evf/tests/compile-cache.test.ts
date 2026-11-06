import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { copyMovedTools, fixture, source } from "./fixtures.ts";

/** bin/evf turns on Node's compile cache: the folder it picks, and what stays true with the cache on. */

const HELP = "evf: Everyfield v3 workflow CLI";

/** The launcher's environment, free of what the suite itself may carry (the comparison arms and CI set these). */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "" };
	for (const name of [
		"NODE_COMPILE_CACHE",
		"NODE_DISABLE_COMPILE_CACHE",
		"NODE_DEBUG_NATIVE",
		"NODE_OPTIONS",
		"NODE_TEST_CONTEXT",
		"GITHUB_ACTIONS",
		"CI",
	])
		delete env[name];
	return { ...env, ...extra };
}

/** Copies the launcher and the evf code to `root`. A fixture must leave out the tests, or `evf test` would run them. */
function copyEvf(root: string, opts: { tests?: boolean } = {}) {
	cpSync(join(source, "tools/evf"), join(root, "tools/evf"), {
		recursive: true,
		filter: (path) => opts.tests || !/[\\/]tests([\\/]|$)/.test(relative(source, path)),
	});
	copyMovedTools(root);
	mkdirSync(join(root, "bin"), { recursive: true });
	cpSync(join(source, "bin/evf"), join(root, "bin/evf"));
}

/** Runs a copy's launcher with the compile cache's debug lines on stderr. */
const launch = (root: string, env: NodeJS.ProcessEnv = {}, ...args: string[]) =>
	spawnSync(join(root, "bin/evf"), args.length ? args : ["help"], {
		cwd: root,
		encoding: "utf8",
		env: cleanEnv(env),
	});

const debug = { NODE_DEBUG_NATIVE: "COMPILE_CACHE" };

/** The folder Node reports using, or undefined when no compile cache is on. */
function cacheFolder(root: string, env: NodeJS.ProcessEnv = {}) {
	const r = launch(root, { ...env, ...debug });
	assert.equal(r.status, 0, r.stderr);
	return r.stderr.match(/\[compile cache\] resolved path (.+?) \+ v/)?.[1];
}

/** Modules whose V8 code came from the cache, and those Node had to compile. */
function hitsAndMisses(stderr: string) {
	const moduleOf = /V8 code cache for ESM (\S+) was (accepted|not initialized|rejected)/g;
	const hits: string[] = [],
		misses: string[] = [];
	for (const [, file, result] of stderr.matchAll(moduleOf)) (result === "accepted" ? hits : misses).push(file);
	return { hits, misses };
}

const entries = (folder: string): string[] =>
	readdirSync(folder, { recursive: true, encoding: "utf8" }).filter((p) => statSync(join(folder, p)).isFile());

const BOUND_KB = 262144;

/** The folder's size as the launcher measures it. */
const sizeKb = (folder: string) => Number(spawnSync("du", ["-sk", folder], { encoding: "utf8" }).stdout.split("\t")[0]);

/** Writes real 1 MB entries that are a day old, oldest first, and returns their paths in that order. */
function seedEntries(folder: string, megabytes: number) {
	const dir = join(folder, "v0-seeded"),
		content = Buffer.alloc(1024 * 1024, 1),
		start = Date.now() - 86_400_000;
	mkdirSync(dir, { recursive: true });
	return Array.from({ length: megabytes }, (_, i) => {
		const path = join(dir, `entry-${i}`),
			when = new Date(start + i * 1000);
		writeFileSync(path, content);
		utimesSync(path, when, when);
		return path;
	});
}

const PAST_BOUND_MB = 270;
const TARGET_MB = 128;

/** A prune kept the newest seeded entries, about the target's worth: it neither stopped early nor deleted past it. */
function assertPrunedToTarget(seeded: string[]) {
	const kept = seeded.filter((path) => existsSync(path));
	assert.ok(Math.abs(kept.length - TARGET_MB) <= 2, `${kept.length} MB of seeded entries kept, not about ${TARGET_MB}`);
	assert.deepEqual(kept, seeded.slice(-kept.length), "the oldest went first, and the newest stayed");
}

/** A fixture repository that tracks a copy of evf and has an empty `.git/evf` cache. */
function evfRepo() {
	const f = fixture();
	copyEvf(f.root);
	f.git("add", "-A");
	f.git("commit", "-qm", "evf code");
	return { f, cache: join(realpathSync(f.root), ".git/evf/node-compile-cache") };
}

test("the launcher sets one folder under the Git common directory for every worktree, and a caller's value stands", () => {
	const { f, cache } = evfRepo();
	try {
		const linked = join(f.root, "linked");
		f.git("worktree", "add", "-q", "-b", "linked", linked);
		assert.equal(cacheFolder(f.root), cache);
		assert.equal(cacheFolder(linked), cache);
		const mine = join(realpathSync(f.root), "my-cache");
		assert.equal(cacheFolder(linked, { NODE_COMPILE_CACHE: mine }), mine);
		assert.ok(entries(mine).length > 0);
	} finally {
		f.close();
	}
});

test("outside a Git repository the launcher runs normally with no cache", () => {
	const root = mkdtempSync(join(tmpdir(), "evf-no-git-"));
	try {
		copyEvf(root);
		const r = launch(root, debug);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, new RegExp(`^${HELP}`));
		assert.equal(r.stderr, "", "Node reports no compile cache");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("with GITHUB_ACTIONS=true the launcher sets no cache", () => {
	const { f, cache } = evfRepo();
	try {
		assert.equal(cacheFolder(f.root, { GITHUB_ACTIONS: "true" }), undefined);
		assert.equal(existsSync(cache), false);
	} finally {
		f.close();
	}
});

test("evf test passes the launcher's cache folder to its test processes, git status stays clean, and the cache is out of evidence", () => {
	const { f, cache } = evfRepo();
	try {
		const seen = join(f.root, ".git/seen-by-test");
		mkdirSync(join(f.root, "tools/evf/tests"), { recursive: true });
		mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
		writeFileSync(join(f.root, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: bin/evf test\n");
		writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
		writeFileSync(
			join(f.root, "tools/evf/tests/stub.test.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.SEEN_BY_TEST!, process.env.NODE_COMPILE_CACHE ?? "unset");\n`,
		);
		f.git("add", "-A");
		f.git("commit", "-qm", "stub test");
		const r = launch(f.root, { SEEN_BY_TEST: seen }, "test", "--all", "--ignore-load", "compile cache test");
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(readFileSync(seen, "utf8"), cache);
		assert.ok(entries(cache).length > 0, "the cache was written");
		assert.equal(f.git("status", "--porcelain"), "");
		assert.ok(!(cache + sep).includes(`${join(".git", "evf", "evidence")}${sep}`));
	} finally {
		f.close();
	}
});

test("a changed source file runs its new code on the next command", () => {
	const { f } = evfRepo();
	try {
		const main = join(f.root, "tools/evf/main.ts");
		assert.equal(launch(f.root).status, 0);
		assert.ok(
			hitsAndMisses(launch(f.root, debug).stderr).hits.some((file) => file.endsWith("tools/evf/main.ts")),
			"the first run filled the cache for the file this test edits",
		);

		const text = readFileSync(main, "utf8"),
			changed = text.replace(HELP, "evf: changed help");
		assert.notEqual(changed, text);
		writeFileSync(main, changed);

		const after = launch(f.root);
		assert.equal(after.status, 0, after.stderr);
		assert.match(after.stdout, /^evf: changed help/);
	} finally {
		f.close();
	}
});

test("an unwritable cache folder gives a normal run with the usual output and no added error text", () => {
	const { f, cache } = evfRepo();
	const usual = launch(f.root, { NODE_DISABLE_COMPILE_CACHE: "1" });
	assert.equal(usual.status, 0, usual.stderr);
	assert.equal(existsSync(cache), false, "the turn-off line writes nothing");
	mkdirSync(cache, { recursive: true });
	chmodSync(cache, 0o555);
	try {
		assert.throws(() => accessSync(cache, constants.W_OK), /EACCES/, "the folder is really unwritable");
		const r = launch(f.root);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, usual.stdout);
		assert.equal(r.stderr, usual.stderr);
		assert.deepEqual(readdirSync(cache), []);
	} finally {
		chmodSync(cache, 0o755);
		f.close();
	}
});

/** Runs six launchers that all reach evf's main.ts before any goes on, and asserts each passes with no added text. */
async function startTogether(root: string) {
	const count = 6,
		arrived = mkdtempSync(join(tmpdir(), "evf-arrived-")),
		barrier = `${arrived}.mjs`;
	// Each evf process waits here until all have started, so they compile and save at the same time, whatever the load.
	// The launcher's own Node version probe and its prune also load this file, and pass through.
	writeFileSync(
		barrier,
		`import { readdirSync, writeFileSync } from "node:fs";
if (process.argv[1]?.endsWith("main.ts")) {
	const dir = ${JSON.stringify(arrived)}, deadline = Date.now() + 60000;
	writeFileSync(dir + "/" + process.pid, "");
	while (readdirSync(dir).length < ${count}) {
		if (Date.now() > deadline) throw new Error("the other processes did not start");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
}
`,
	);
	try {
		const runs = await Promise.all(
			Array.from(
				{ length: count },
				() =>
					new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
						const child = spawn(join(root, "bin/evf"), ["help"], {
							cwd: root,
							env: cleanEnv({ NODE_OPTIONS: `--import=${barrier}` }),
						});
						let out = "",
							err = "";
						child.stdout.on("data", (d) => (out += d));
						child.stderr.on("data", (d) => (err += d));
						child.once("error", reject);
						child.once("close", (code) => resolve({ code, out, err }));
					}),
			),
		);
		assert.equal(readdirSync(arrived).length, count, "every process was alive at the barrier");
		for (const run of runs) {
			assert.equal(run.code, 0, run.err);
			assert.match(run.out, new RegExp(`^${HELP}`));
			assert.equal(run.err, "");
		}
	} finally {
		rmSync(arrived, { recursive: true, force: true });
		rmSync(barrier, { force: true });
	}
}

test("processes that start together on one empty cache all pass and fill it", async () => {
	const { f, cache } = evfRepo();
	try {
		assert.equal(existsSync(cache), false);
		await startTogether(f.root);
		assert.ok(entries(cache).length > 0);
	} finally {
		f.close();
	}
});

test("processes that start together on a folder past the bound all pass and leave it under the bound", async () => {
	const { f, cache } = evfRepo();
	try {
		const seeded = seedEntries(cache, PAST_BOUND_MB);
		assert.ok(sizeKb(cache) > BOUND_KB);
		await startTogether(f.root);
		assert.ok(sizeKb(cache) <= BOUND_KB);
		assertPrunedToTarget(seeded);
		assert.ok(
			entries(cache).some((p) => !p.startsWith("v0-seeded")),
			"the cache filled again",
		);
	} finally {
		f.close();
	}
});

test("prunes that overlap on one folder stop at the size to keep", async () => {
	const folder = mkdtempSync(join(tmpdir(), "evf-prunes-"));
	try {
		const seeded = seedEntries(folder, PAST_BOUND_MB);
		const codes = await Promise.all(
			Array.from(
				{ length: 6 },
				() =>
					new Promise<number | null>((resolve, reject) => {
						const prune = join(source, "tools/evf/compile-cache-prune.ts");
						const child = spawn(process.execPath, [prune, folder, String(TARGET_MB * 1024)], {
							env: cleanEnv({ NODE_DISABLE_COMPILE_CACHE: "1" }),
							stdio: "ignore",
						});
						child.once("error", reject);
						child.once("close", resolve);
					}),
			),
		);
		assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
		assertPrunedToTarget(seeded);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a folder past the bound loses its oldest entries, and the next commands run normally and fill and hit the cache", () => {
	const { f, cache } = evfRepo();
	try {
		const seeded = seedEntries(cache, PAST_BOUND_MB);
		assert.ok(sizeKb(cache) > BOUND_KB);

		const r = launch(f.root);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, new RegExp(`^${HELP}`));
		assert.equal(r.stderr, "");
		assert.ok(sizeKb(cache) <= BOUND_KB);
		assertPrunedToTarget(seeded);
		assert.ok(
			entries(cache).some((p) => !p.startsWith("v0-seeded")),
			"the run filled the cache again",
		);

		const next = launch(f.root, debug);
		assert.equal(next.status, 0, next.stderr);
		assert.match(next.stdout, new RegExp(`^${HELP}`));
		assert.ok(hitsAndMisses(next.stderr).hits.some((file) => file.endsWith("tools/evf/main.ts")));
	} finally {
		f.close();
	}
});

test("a folder under the bound keeps its entries and still gets hits", () => {
	const { f, cache } = evfRepo();
	try {
		const seeded = seedEntries(cache, 100);
		assert.equal(launch(f.root).status, 0);
		const { hits, misses } = hitsAndMisses(launch(f.root, debug).stderr);
		assert.ok(hits.length > 0);
		assert.deepEqual(misses, []);
		assert.ok(seeded.every((path) => existsSync(path)));
	} finally {
		f.close();
	}
});

test("a folder the caller set, or a cache turned off, is not pruned", () => {
	const { f, cache } = evfRepo();
	try {
		const mine = join(realpathSync(f.root), ".git/caller-cache");
		const theirs = seedEntries(mine, PAST_BOUND_MB);
		assert.equal(launch(f.root, { NODE_COMPILE_CACHE: mine }).status, 0);
		assert.ok(theirs.every((path) => existsSync(path)));
		assert.ok(
			entries(mine).some((p) => !p.startsWith("v0-seeded")),
			"Node still used the caller's folder",
		);
		assert.equal(existsSync(cache), false);

		const ours = seedEntries(cache, PAST_BOUND_MB);
		assert.equal(launch(f.root, { NODE_DISABLE_COMPILE_CACHE: "1" }).status, 0);
		assert.ok(ours.every((path) => existsSync(path)));
	} finally {
		f.close();
	}
});

test("an unwritable folder past the bound gives a normal run with the usual output", () => {
	const { f, cache } = evfRepo();
	const usual = launch(f.root, { NODE_DISABLE_COMPILE_CACHE: "1" });
	const seeded = seedEntries(cache, PAST_BOUND_MB),
		version = join(cache, "v0-seeded");
	chmodSync(version, 0o555);
	chmodSync(cache, 0o555);
	try {
		assert.throws(() => accessSync(version, constants.W_OK), /EACCES/, "the folder is really unwritable");
		const r = launch(f.root);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, usual.stdout);
		assert.equal(r.stderr, usual.stderr);
		assert.ok(seeded.every((path) => existsSync(path)));
	} finally {
		chmodSync(cache, 0o755);
		chmodSync(version, 0o755);
		f.close();
	}
});

test("a prune that cannot run gives a normal run with the usual output", () => {
	const { f, cache } = evfRepo();
	const usual = launch(f.root, { NODE_DISABLE_COMPILE_CACHE: "1" });
	seedEntries(cache, PAST_BOUND_MB);
	rmSync(join(f.root, "tools/evf/compile-cache-prune.ts"));
	try {
		const r = launch(f.root);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.stdout, usual.stdout);
		assert.equal(r.stderr, usual.stderr);
	} finally {
		f.close();
	}
});

test("cache hits in a copied tools/evf: a second process hits, and the counts are reported", (t) => {
	const base = mkdtempSync(join(tmpdir(), "evf-copies-"));
	try {
		const cache = join(base, "cache"),
			[one, two] = [join(base, "one"), join(base, "two")];
		for (const copy of [one, two]) copyEvf(copy, { tests: true });
		const count = (root: string) => {
			const r = launch(root, { NODE_COMPILE_CACHE: cache, ...debug });
			assert.equal(r.status, 0, r.stderr);
			const { hits, misses } = hitsAndMisses(r.stderr);
			return { hits: hits.length, misses: misses.length };
		};
		const first = count(one),
			second = count(one),
			otherCopy = count(two);
		t.diagnostic(`first process: ${JSON.stringify(first)}`);
		t.diagnostic(`second process: ${JSON.stringify(second)}`);
		t.diagnostic(`process in a second copy: ${JSON.stringify(otherCopy)}`);
		assert.equal(first.hits, 0);
		assert.ok(first.misses > 0);
		assert.deepEqual(second, { hits: first.misses, misses: 0 });
		assert.equal(otherCopy.hits + otherCopy.misses, first.misses);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
