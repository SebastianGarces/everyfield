import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { markMerged, migrate, openWorkDb, orphanRuns } from "../db.ts";
import { approve } from "../approve.ts";
import { evfDataDir, parseTask } from "../lib.ts";

const SHA = "c".repeat(40);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86_400_000;

type Db = ReturnType<typeof openWorkDb>;
const taskRow = (db: Db, ref: string, status: string, extra: { branch?: string; slug?: string } = {}) =>
	Number(
		db
			.prepare(
				"INSERT INTO tasks (slug, mode, ref, title, branch, status, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, ?, ?)",
			)
			.run(extra.slug ?? ref.toLowerCase(), ref, ref, extra.branch ?? `task/${ref.toLowerCase()}`, status, iso(0), iso(0))
			.lastInsertRowid,
	);
const runRow = (db: Db, taskId: number, stage: string, role: string, started = iso(60_000)) =>
	Number(
		db
			.prepare("INSERT INTO runs (task_id, stage, role, status, started_at) VALUES (?, ?, ?, 'started', ?)")
			.run(taskId, stage, role, started).lastInsertRowid,
	);
const runs = (db: Db, taskId: number) =>
	db.prepare("SELECT id, role, status, summary FROM runs WHERE task_id = ? ORDER BY id").all(taskId) as Array<{
		id: number;
		role: string;
		status: string;
		summary: string | null;
	}>;

test("OPS-100-merge: markMerged closes the evf run as passed and a seat run as aborted; a second call writes nothing", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const id = taskRow(db, "OPS-5", "pr_open");
		runRow(db, id, "ship", "evf");
		runRow(db, id, "verify", "verifier");
		markMerged(db, parseTask("OPS-5"), SHA, null);
		assert.deepEqual(
			runs(db, id).map(({ role, status, summary }) => ({ role, status, summary })),
			[
				{ role: "evf", status: "passed", summary: `OPS-5 merged as ${SHA.slice(0, 10)}` },
				{ role: "verifier", status: "aborted", summary: "task merged while the seat was open" },
			],
		);
		const count = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
		const before = count();
		markMerged(db, parseTask("OPS-5"), SHA, null);
		assert.equal(count(), before);
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-100-merge: with no commit the summary is '<ref> merged'", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const id = taskRow(db, "OPS-6", "pr_open");
		runRow(db, id, "ship", "evf");
		markMerged(db, parseTask("OPS-6"), null, null);
		assert.equal(runs(db, id)[0].summary, "OPS-6 merged");
		db.close();
	} finally {
		f.close();
	}
});

const approvePr = (headRefName: string) => ({
	number: 77,
	title: "Fixture PR",
	url: "https://github.com/test/private/pull/77",
	state: "OPEN",
	isDraft: false,
	baseRefName: "main",
	headRefName,
	headRefOid: "a".repeat(40),
	mergeStateStatus: "CLEAN",
	files: [{ path: "docs/reference/wiki/drafts/a1.json" }],
});

test("OPS-100-approve: approve records the merge for a known branch and writes nothing for an unknown one", () => {
	const f = fixture(),
		cwd = process.cwd(),
		log = console.log;
	try {
		f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
		f.git("push", "-q", "origin", "main");
		// The faked gh merge runs in <cwd>/../.. and merges `main` into itself: no change, a real merge commit hash.
		mkdirSync(join(f.root, "a/b"), { recursive: true });
		process.chdir(join(f.root, "a/b"));
		console.log = () => {};
		const db = openWorkDb(f.root);
		const known = taskRow(db, "WP-050", "pr_open", { branch: "wiki/known" });
		const runId = runRow(db, known, "ship", "evf");
		const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
		const state = f.getState();
		state.allowMerge = true;
		state.mergeBranch = "main";

		state.pr = approvePr("wiki/known");
		f.setState(state);
		assert.equal(approve(f.root, 77, { ownerApproval: "Approved for this PR" }), 0);
		const merged = db.prepare("SELECT status, merge_commit FROM tasks WHERE id = ?").get(known) as {
			status: string;
			merge_commit: string;
		};
		assert.equal(merged.status, "merged");
		assert.match(merged.merge_commit, /^[0-9a-f]{40}$/);
		assert.equal(runs(db, known).find((r) => r.id === runId)!.status, "passed");

		const before = rows();
		state.pr = approvePr("wiki/unknown");
		f.setState(state);
		assert.equal(approve(f.root, 77, { ownerApproval: "Approved for this PR" }), 0);
		assert.equal(rows(), before, "no row for a branch the store does not know");
		db.close();
	} finally {
		process.chdir(cwd);
		console.log = log;
		f.close();
	}
});

/** A store at schema 4, as the real one is today, with an orphan evf run on a merged task. */
function storeAtFour(path: string) {
	const db = new DatabaseSync(path);
	db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	const dir = join(source, "tools/evf/db/migrations");
	for (const file of readdirSync(dir).sort().slice(0, 4)) {
		db.exec(readFileSync(join(dir, file), "utf8"));
		db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(Number(file.slice(0, 3)), file, iso(0));
	}
	return db;
}

test("OPS-100-migration: 005 closes orphan evf runs of merged tasks, adds the three view columns and runs once", () => {
	const dir = fixture();
	try {
		const db = storeAtFour(join(dir.root, "old.sqlite"));
		const ins = db.prepare(
			"INSERT INTO tasks (id, slug, mode, ref, title, branch, status, merge_commit, created_at, updated_at) VALUES (?, ?, 'implement', ?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(1, "wp-097", "WP-097", "a", "b", "merged", SHA, iso(3 * DAY), iso(0));
		ins.run(2, "wp-097-2", "WP-097", "a", "b2", "escalated", null, iso(2 * DAY), iso(0));
		ins.run(3, "ops-9", "OPS-9", "a", "b3", "pr_open", null, iso(DAY), iso(0));
		const run = db.prepare(
			"INSERT INTO runs (id, task_id, stage, role, status, started_at) VALUES (?, ?, ?, ?, 'started', ?)",
		);
		run.run(10, 1, "ship", "evf", iso(3 * DAY));
		run.run(11, 1, "verify", "verifier", iso(3 * DAY));
		run.run(12, 3, "ship", "evf", iso(DAY));
		const ev = db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, NULL, ?, ?, '{}')");
		ev.run(1, iso(3 * DAY), "merged");
		ev.run(1, iso(3 * DAY - 1000), "stage_end");
		ev.run(3, iso(1000), "owner_approval_wait");

		assert.equal(migrate(db).version, 5);
		const run10 = db.prepare("SELECT status, summary FROM runs WHERE id = 10").get();
		assert.deepEqual({ ...run10 }, { status: "passed", summary: `WP-097 merged as ${SHA.slice(0, 10)}` });
		assert.equal((db.prepare("SELECT status FROM runs WHERE id = 11").get() as { status: string }).status, "started");
		assert.equal((db.prepare("SELECT status FROM runs WHERE id = 12").get() as { status: string }).status, "started");
		const view = (id: number) => db.prepare("SELECT last_event, merged_at, ref_rows FROM v_tasks WHERE id = ?").get(id);
		assert.deepEqual({ ...(view(1) as object) }, { last_event: "stage_end", merged_at: view(1) && (view(1) as any).merged_at, ref_rows: 2 });
		assert.ok((view(1) as any).merged_at);
		assert.deepEqual({ ...(view(3) as object) }, { last_event: "owner_approval_wait", merged_at: null, ref_rows: 1 });

		const snapshot = JSON.stringify(db.prepare("SELECT * FROM runs ORDER BY id").all());
		assert.deepEqual(migrate(db), { version: 5, applied: [] });
		assert.equal(JSON.stringify(db.prepare("SELECT * FROM runs ORDER BY id").all()), snapshot);
		db.close();
	} finally {
		dir.close();
	}
});

test("OPS-100-health: merged_24h counts by the merged event, not updated_at", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const old = taskRow(db, "OPS-7", "merged");
		db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, 'merged', '{}')").run(old, iso(3 * DAY));
		const fresh = taskRow(db, "OPS-8", "merged");
		db.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, 'merged', '{}')").run(fresh, iso(1000));
		const merged24 = () => (db.prepare("SELECT merged_24h FROM v_health").get() as { merged_24h: number }).merged_24h;
		assert.equal(merged24(), 1);
		db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(iso(0), old);
		assert.equal(merged24(), 1, "touching updated_at of a task merged 3 days ago changes nothing");
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-100-orphans: status --json and doctor report an evf run with a dead pid, not one with a live pid", () => {
	const f = fixture();
	try {
		const db = openWorkDb(f.root);
		const dead = taskRow(db, "OPS-31", "pr_open");
		db.prepare("UPDATE tasks SET pr_number = 88 WHERE id = ?").run(dead);
		const orphan = runRow(db, dead, "ship", "evf", iso(30 * 60_000));
		const live = taskRow(db, "OPS-32", "pr_open");
		runRow(db, live, "ci", "evf");
		const pids = join(evfDataDir(f.root), "drive");
		mkdirSync(pids, { recursive: true });
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
		writeFileSync(join(pids, "ops-31.pid"), `${child.stdout}\n`); // exited: a dead pid
		writeFileSync(join(pids, "ops-32.pid"), `${process.pid}\n`); // this test runner: alive
		assert.deepEqual(
			orphanRuns(db, f.root).map((o) => o.run_id),
			[orphan],
		);
		db.close();
		const cli = (...args: string[]) =>
			spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd: f.root, encoding: "utf8" });
		const json = JSON.parse(cli("status", "--json").stdout);
		assert.equal(json.orphanRuns.length, 1);
		assert.deepEqual(
			[json.orphanRuns[0].ref, json.orphanRuns[0].run_id, json.orphanRuns[0].stage, json.orphanRuns[0].age_minutes],
			["OPS-31", orphan, "ship", 30],
		);
		assert.match(json.orphanRuns[0].repair, /evf approve 88 .*evf task reopen OPS-31/);
		assert.doesNotMatch(json.orphanRuns[0].repair, /evf ship/);
		const text = cli("status").stdout;
		assert.match(text, new RegExp(`orphan evf run ${orphan}: OPS-31 ship started 30 min ago`));
		assert.doesNotMatch(text, /OPS-32 ci started/);
		assert.match(cli("doctor").stdout, new RegExp(`WARN  orphan evf run ${orphan}: OPS-31 ship`));
	} finally {
		f.close();
	}
});
