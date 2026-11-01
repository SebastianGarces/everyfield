import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { migrate, openWorkDb, seedProgress, syncGoals, workDbPath } from "../db.ts";
import { evfDataDir } from "../lib.ts";

const cli = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd, encoding: "utf8" });
const sha = (c: string) => c.repeat(40);
const LATEST = 7; // migrations in tools/evf/db/migrations

test("OPS-57-store: the work store migrates from empty under the Git common dir, exposes the views and migrates once", () => {
	const f = fixture();
	try {
		const path = workDbPath(f.root);
		assert.equal(path, join(evfDataDir(f.root), "work.sqlite"));
		assert.ok(!existsSync(path));
		const db = openWorkDb(f.root);
		assert.ok(existsSync(path));
		assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
		const names = (
			db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>
		).map((r) => r.name);
		for (const name of [
			"goals",
			"tasks",
			"runs",
			"events",
			"proofs",
			"approvals",
			"learnings",
			"v_tasks",
			"v_seats",
			"v_recent",
			"v_health",
		])
			assert.ok(names.includes(name), name);
		assert.deepEqual(migrate(db), { version: LATEST, applied: [] });
		db.close();
		const again = openWorkDb(f.root);
		assert.equal((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n, LATEST);
		again.close();
		// The CLI resolves the home root through git, which returns the real path of a symlinked temp dir.
		assert.equal(cli(f.root, "db", "path").stdout.trim(), realpathSync(path));
		const migrated = cli(f.root, "db", "migrate");
		assert.equal(migrated.status, 0, migrated.stderr);
		assert.match(migrated.stdout, new RegExp(`schema ${LATEST}`));
	} finally {
		f.close();
	}
});

test("OPS-57-fresh: several processes open a new store at once and each migration runs once", async () => {
	const f = fixture();
	try {
		const script = `const { openWorkDb } = await import(${JSON.stringify(join(source, "tools/evf/db.ts"))});
			const db = openWorkDb(process.argv[1]);
			const v = db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n;
			db.close();
			process.stdout.write(String(v));`;
		const children = Array.from({ length: 5 }, () =>
			spawn(process.execPath, ["--input-type=module", "-e", script, f.root], { stdio: ["ignore", "pipe", "pipe"] }),
		);
		const results = await Promise.all(
			children.map(
				(child) =>
					new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
						let out = "",
							err = "";
						child.stdout.on("data", (d) => (out += d));
						child.stderr.on("data", (d) => (err += d));
						child.on("exit", (code) => resolve({ code, out, err }));
					}),
			),
		);
		for (const r of results) assert.equal(r.code, 0, r.err);
		assert.deepEqual(
			results.map((r) => r.out),
			Array(5).fill(String(LATEST)),
		);
		const db = openWorkDb(f.root, { readOnly: true });
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n, LATEST);
		assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-57-readers: status and goals list read an existing store read-only, and report an empty store without creating it", () => {
	const f = fixture();
	try {
		const missing = cli(f.root, "status", "--json");
		assert.equal(missing.status, 0, missing.stderr);
		assert.deepEqual(JSON.parse(missing.stdout).tasks, []);
		assert.equal(JSON.parse(missing.stdout).schema_version, 0);
		assert.match(cli(f.root, "status").stdout, /work store: none at/);
		assert.match(cli(f.root, "goals", "list").stdout, /no work store yet/);
		assert.ok(!existsSync(workDbPath(f.root)), "readers never create the store");
		// A writer that opened and closed the store leaves a WAL-mode file that a read-only open can use.
		openWorkDb(f.root).close();
		const report = cli(f.root, "status", "--json");
		assert.equal(report.status, 0, report.stderr);
		assert.equal(JSON.parse(report.stdout).schema_version, LATEST);
		const listed = cli(f.root, "goals", "list");
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /goals: none/);
	} finally {
		f.close();
	}
});

test("OPS-57-goals: goals sync caches the project line and the S-row missions of the build plan, and is idempotent", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const first = syncGoals(f.root, db);
		assert.ok(first.missions.includes("S0") && first.missions.includes("S5"), first.missions.join(","));
		assert.match(first.project, /Everyfield is an operational workspace/);
		const count = () => (db.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n;
		assert.equal(count(), first.missions.length + 1);
		syncGoals(f.root, db);
		assert.equal(count(), first.missions.length + 1);
		const s1 = db.prepare("SELECT packages, parent_id FROM goals WHERE key = 'S1'").get() as {
			packages: string;
			parent_id: number;
		};
		assert.ok(JSON.parse(s1.packages).includes("WP-012"));
		assert.equal(s1.parent_id, (db.prepare("SELECT id FROM goals WHERE key = 'project'").get() as { id: number }).id);
		db.close();
		const listed = cli(f.root, "goals", "list");
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /^project  project/m);
		assert.match(listed.stdout, /S1: .* packages\)/);
	} finally {
		f.close();
	}
});

test("OPS-57-seed: the ledger committed on the base branch seeds merged tasks once, with PR numbers, missions and legacy events", () => {
	const f = fixture();
	try {
		const path = join(f.root, "docs/build-progress.json");
		const ledger = JSON.parse(readFileSync(path, "utf8"));
		ledger.packages["WP-001"] = {
			...ledger.packages["WP-001"],
			status: "in_progress",
			updated_at: "2026-10-18T06:52:29.870Z",
			evidence: [
				{
					path: "packages/reference/",
					commit: sha("a"),
					test: "GitHub required CI and anthropic approval",
					result: "passed",
					note: `WP-001 merged in PR #81 after cross-model verification at ${sha("a").slice(0, 10)}. https://github.com/test/private/pull/81#issuecomment-1`,
				},
			],
			milestones: { "WP-001": { task: "WP-001", merge_commit: sha("a"), acknowledged: true, stage: "producer" } },
		};
		ledger.packages["WP-005"] = {
			...ledger.packages["WP-005"],
			status: "in_progress",
			updated_at: "2026-10-19T00:00:00.000Z",
			evidence: [
				{ commit: sha("b"), note: "WP-005/api merged in PR #94 after cross-model verification at bbbbbbbbbb." },
				{ commit: sha("c"), note: "WP-005/ui merged in PR #113 after cross-model verification at cccccccccc." },
			],
			milestones: {
				"WP-005/api": { task: "WP-005/api", merge_commit: sha("b"), acknowledged: true, stage: "producer" },
				"WP-005/ui": { task: "WP-005/ui", merge_commit: sha("c"), acknowledged: false, stage: "part" },
			},
		};
		ledger.packages["WP-097"] = {
			...ledger.packages["WP-097"],
			status: "done",
			updated_at: "2026-10-14T00:00:00.000Z",
			evidence: [
				{ commit: sha("d"), note: "WP-097 fast-track go-live at dddddddddd." },
				{ path: "docs/", note: "no commit here" },
			],
			milestones: {},
		};
		writeFileSync(path, JSON.stringify(ledger));
		f.git("add", "-A");
		f.commit();
		// A checkout's working copy may carry an unreviewed edit; the seed reads the committed ledger only.
		writeFileSync(path, JSON.stringify({ ...ledger, packages: {} }));
		const db = openWorkDb(f.root);
		syncGoals(f.root, db);
		assert.deepEqual(seedProgress(f.root, db), { tasks: 4, events: 4, seen: 4 });
		assert.deepEqual(seedProgress(f.root, db), { tasks: 0, events: 0, seen: 4 });
		db.close();
		const out = cli(f.root, "status", "--json");
		assert.equal(out.status, 0, out.stderr);
		const report = JSON.parse(out.stdout);
		assert.equal(report.schema_version, LATEST);
		const byRef = Object.fromEntries(report.tasks.map((t: { ref: string }) => [t.ref, t]));
		assert.equal(byRef["WP-001"].pr_number, 81);
		assert.equal(byRef["WP-001"].status, "merged");
		assert.equal(byRef["WP-001"].goal_key, "S0");
		assert.equal(byRef["WP-001"].merge_commit, sha("a"));
		assert.equal(byRef["WP-005/ui"].pr_number, 113);
		assert.equal(byRef["WP-005/ui"].slug, "wp-005-ui");
		assert.equal(
			byRef["WP-097"].merge_commit,
			sha("d"),
			"a done package without milestones seeds one task per evidence commit",
		);
		assert.equal(byRef["WP-097"].pr_number, null);
		assert.equal(report.recent.filter((e: { type: string }) => e.type === "legacy_milestone").length, 4);
		assert.equal(report.health.merged_24h, 0, "seeded tasks keep their ledger dates");
		assert.equal(report.seats.length, 0);
		const one = JSON.parse(cli(f.root, "status", "--json", "WP-005").stdout);
		assert.deepEqual(one.tasks.map((t: { ref: string }) => t.ref).sort(), ["WP-005/api", "WP-005/ui"]);
		assert.deepEqual(one.runs, []);
		const text = cli(f.root, "status");
		assert.match(text.stdout, /WP-001 .*merged .*#81 .*S0/);
		const seeded = cli(f.root, "db", "seed-progress");
		assert.equal(seeded.status, 0, seeded.stderr);
		assert.match(seeded.stdout, /0 new merged tasks .* \(4 already stored\)/);
	} finally {
		f.close();
	}
});

test("OPS-57-locks: a reader opens read-only while a writer holds the store, and a second writer waits for the lock", async () => {
	const f = fixture();
	try {
		openWorkDb(f.root).close();
		const holder = spawn(
			process.execPath,
			[
				"-e",
				`const { DatabaseSync } = require("node:sqlite");
				const db = new DatabaseSync(process.argv[1]);
				db.exec("PRAGMA busy_timeout = 5000");
				db.exec("BEGIN IMMEDIATE");
				db.prepare("INSERT INTO events (ts, type, payload) VALUES (?, 'lock_test', '{}')").run(new Date().toISOString());
				process.stdout.write("locked\\n");
				setTimeout(() => { db.exec("COMMIT"); db.close(); }, 600);`,
				workDbPath(f.root),
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const exited = new Promise<number | null>((resolve) => holder.on("exit", resolve));
		await new Promise<void>((resolve, reject) => {
			holder.stdout.on("data", (chunk) => String(chunk).includes("locked") && resolve());
			exited.then((code) => reject(new Error(`the lock holder exited with ${code} before locking`)));
		});
		const reader = openWorkDb(f.root, { readOnly: true });
		assert.equal((reader.prepare("SELECT open_tasks FROM v_health").get() as { open_tasks: number }).open_tasks, 0);
		assert.throws(() => reader.exec("INSERT INTO events (ts, type) VALUES ('x', 'y')"), /readonly/i);
		reader.close();
		const started = Date.now();
		const writer = openWorkDb(f.root);
		writer
			.prepare("INSERT INTO events (ts, type, payload) VALUES (?, 'lock_test_2', '{}')")
			.run(new Date().toISOString());
		const waited = Date.now() - started;
		assert.ok(waited >= 200, `the writer waited for the lock instead of failing (${waited} ms)`);
		assert.equal(
			(writer.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'lock_test%'").get() as { n: number }).n,
			2,
		);
		writer.close();
		assert.equal(await exited, 0);
	} finally {
		f.close();
	}
});
