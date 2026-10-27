import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { migrate, openWorkDb, seedProgress, syncGoals, workDbPath } from "../db.ts";
import { evfDataDir } from "../lib.ts";

const cli = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd, encoding: "utf8" });
const sha = (c: string) => c.repeat(40);

test("OPS-57-store: the work store migrates from empty under the Git common dir, exposes the views and migrates once", () => {
	const f = fixture();
	try {
		const path = workDbPath(f.root);
		assert.equal(path, join(evfDataDir(f.root), "work.sqlite"));
		assert.ok(!existsSync(path));
		const db = openWorkDb(f.root);
		assert.ok(existsSync(path));
		assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
		const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map(
			(r) => r.name,
		);
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
		assert.deepEqual(migrate(db), { version: 1, applied: [] });
		db.close();
		const again = openWorkDb(f.root);
		assert.equal((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n, 1);
		again.close();
		assert.equal(cli(f.root, "db", "path").stdout.trim(), path);
		const migrated = cli(f.root, "db", "migrate");
		assert.equal(migrated.status, 0, migrated.stderr);
		assert.match(migrated.stdout, /schema 1/);
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
		const s1 = db.prepare("SELECT packages, parent_id FROM goals WHERE key = 'S1'").get() as { packages: string; parent_id: number };
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
		writeFileSync(path, JSON.stringify(ledger));
		f.git("add", "-A");
		f.commit();
		// A checkout's working copy may carry an unreviewed edit; the seed reads the committed ledger only.
		writeFileSync(path, JSON.stringify({ ...ledger, packages: {} }));
		const db = openWorkDb(f.root);
		syncGoals(f.root, db);
		assert.deepEqual(seedProgress(f.root, db), { tasks: 3, events: 3, seen: 3 });
		assert.deepEqual(seedProgress(f.root, db), { tasks: 0, events: 0, seen: 3 });
		db.close();
		const out = cli(f.root, "status", "--json");
		assert.equal(out.status, 0, out.stderr);
		const report = JSON.parse(out.stdout);
		assert.equal(report.schema_version, 1);
		const byRef = Object.fromEntries(report.tasks.map((t: { ref: string }) => [t.ref, t]));
		assert.equal(byRef["WP-001"].pr_number, 81);
		assert.equal(byRef["WP-001"].status, "merged");
		assert.equal(byRef["WP-001"].goal_key, "S0");
		assert.equal(byRef["WP-001"].merge_commit, sha("a"));
		assert.equal(byRef["WP-005/ui"].pr_number, 113);
		assert.equal(byRef["WP-005/ui"].slug, "wp-005-ui");
		assert.equal(report.recent.filter((e: { type: string }) => e.type === "legacy_milestone").length, 3);
		assert.equal(report.health.merged_24h, 0, "seeded tasks keep their ledger dates");
		assert.equal(report.seats.length, 0);
		const one = JSON.parse(cli(f.root, "status", "--json", "WP-005").stdout);
		assert.deepEqual(one.tasks.map((t: { ref: string }) => t.ref).sort(), ["WP-005/api", "WP-005/ui"]);
		assert.deepEqual(one.runs, []);
		const text = cli(f.root, "status");
		assert.match(text.stdout, /WP-001 .*merged .*#81 .*S0/);
		const seeded = cli(f.root, "db", "seed-progress");
		assert.equal(seeded.status, 0, seeded.stderr);
		assert.match(seeded.stdout, /0 new merged tasks .* \(3 already stored\)/);
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
		writer.prepare("INSERT INTO events (ts, type, payload) VALUES (?, 'lock_test_2', '{}')").run(new Date().toISOString());
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
