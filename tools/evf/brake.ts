import { loadavg } from "node:os";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { checkQueueWaiting, CHECK_CAP } from "./check-queue.ts";
import { openWorkDb, record } from "./db.ts";
import { baseRef, fail, git, gitOk, hasRemote, loadConfig } from "./lib.ts";

/**
 * OPS-141. The brake: one test that fails on 2 or more branches that do not touch its paths, within 60 min, holds those
 * rounds and reports the test once. It writes only events and the `held_external` status: no check, proof or review
 * passes here, and a released task runs its checks again. Staged release: 2 tasks start, then 2 more each 5 min, while
 * load is under 24 and the check queue is short.
 */
export const BRAKE_BRANCHES = 2;
export const BRAKE_WINDOW_MS = 60 * 60_000;
export const RELEASE_BATCH = 2;
export const RELEASE_EVERY_MS = 5 * 60_000;
export const RELEASE_LOAD = 24;
/** Tickets waiting behind the running full checks at which the queue is no longer short. */
export const RELEASE_QUEUE = CHECK_CAP;

/**
 * A test's paths: the app, package or tool that holds its file, or else the folder of its file. An evf test's path is its
 * own file: the evf suite runs mostly on branches that change tools/evf/, so that folder would make a test broken on
 * main count as each branch's own failure.
 */
export function testPaths(file: string): string[] {
	if (file.startsWith("tools/evf/tests/")) return [file];
	const unit = /^(?:apps|packages|tools)\/[^/]+\//.exec(file)?.[0];
	if (unit) return [unit];
	return dirname(file) === "." ? [file] : [`${dirname(file)}/`];
}

export const touchesOwnPaths = (file: string, changed: string[]): boolean =>
	testPaths(file).some((p) => (p.endsWith("/") ? changed.some((c) => c.startsWith(p)) : changed.includes(p)));

type Failure = { id: number; ts: string; task: string; head: string; test: string; file: string };
type TestKey = Pick<Failure, "test" | "file">;
export type BrakeHit = TestKey & {
	brake: number;
	head: string;
	/** The brakes this call started, each once across every drive. The caller reports them. */
	tripped: Array<TestKey & { brake: number; branches: string[] }>;
};

/**
 * What the task's latest finished verify failed, for branches that do not touch the test's paths. A later clean run
 * clears a failure and a coordinator's reopen sets it aside. An event with no test file never counts.
 */
function standingFailures(db: DatabaseSync, taskId: number): Failure[] {
	const rows = db
		.prepare(
			"SELECT id, ts, type, payload FROM events WHERE task_id = ? AND type IN ('check_start', 'test_failed', 'check_end', 'reopen') ORDER BY id",
		)
		.all(taskId) as Array<{ id: number; ts: string; type: string; payload: string }>;
	let running: Failure[] = [],
		finished: Failure[] = [];
	for (const row of rows) {
		const p = JSON.parse(row.payload) as Record<string, unknown>;
		if (row.type === "reopen") running = finished = [];
		else if (row.type === "check_start") running = [];
		else if (row.type === "check_end") {
			if (p.result === "passed" || p.result === "failed") finished = running;
		} else if (p.touchesOwnPaths === false && typeof p.file === "string")
			running = [
				...running,
				{
					id: row.id,
					ts: row.ts,
					task: String(p.task),
					head: String(p.head),
					test: String(p.test),
					file: p.file,
				},
			];
	}
	return finished;
}

const sameTest = "json_extract(payload, '$.test') = ? AND json_extract(payload, '$.file') = ?";

const lastFix = (db: DatabaseSync, k: TestKey): number =>
	(
		db
			.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE type = 'brake_fixed' AND ${sameTest}`)
			.get(k.test, k.file) as { id: number }
	).id;

function openBrake(db: DatabaseSync, k: TestKey): number | null {
	const row = db
		.prepare(`SELECT MAX(id) AS id FROM events WHERE type = 'brake_tripped' AND id > ? AND ${sameTest}`)
		.get(lastFix(db, k), k.test, k.file) as { id: number | null };
	return row.id;
}

/** The branches whose standing failure of this test falls inside the window and after the last fix. */
function failingBranches(db: DatabaseSync, k: TestKey, at: number): string[] {
	const since = new Date(at - BRAKE_WINDOW_MS).toISOString(),
		fixed = lastFix(db, k);
	const tasks = db
		.prepare(
			`SELECT DISTINCT task_id FROM events WHERE type = 'test_failed' AND id > ? AND ts >= ? AND task_id IS NOT NULL AND ${sameTest}`,
		)
		.all(fixed, since, k.test, k.file) as Array<{ task_id: number }>;
	const branches = tasks.flatMap(({ task_id }) =>
		standingFailures(db, task_id)
			.filter((f) => f.test === k.test && f.file === k.file && f.id > fixed && f.ts >= since)
			.map((f) => f.task),
	);
	return [...new Set(branches)].sort();
}

/** The transaction makes one drive the only one that starts this brake when several reach it together. */
function trip(db: DatabaseSync, k: TestKey, branches: string[]): { brake: number; started: boolean } {
	db.exec("BEGIN IMMEDIATE");
	try {
		const open = openBrake(db, k);
		const brake =
			open ??
			Number(
				db
					.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (NULL, NULL, ?, 'brake_tripped', ?)")
					.run(
						new Date().toISOString(),
						JSON.stringify({
							test: k.test,
							file: k.file,
							branches,
							summary: `brake: ${k.test} fails on ${branches.join(", ")}; file one OPS fix`,
						}),
					).lastInsertRowid,
			);
		db.exec("COMMIT");
		return { brake, started: open === null };
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}

/** The coordinator overruled this brake for this task. The exemption ends with the brake: a later brake can hold it. */
const reopenedSince = (db: DatabaseSync, taskId: number, brake: number): boolean =>
	!!db.prepare("SELECT 1 FROM events WHERE task_id = ? AND type = 'reopen' AND id > ?").get(taskId, brake);

/**
 * The brake that holds this task, or null. A failure that reaches the threshold starts its brake here. A task reopened
 * after a brake started is exempt from it, so its next failure goes to a seat.
 */
export function brakeOn(db: DatabaseSync, taskId: number, at = Date.now()): BrakeHit | null {
	const tripped: BrakeHit["tripped"] = [];
	let hit: Omit<BrakeHit, "tripped"> | null = null;
	for (const f of standingFailures(db, taskId)) {
		if (f.id <= lastFix(db, f)) continue;
		let brake = openBrake(db, f);
		if (brake === null) {
			const branches = failingBranches(db, f, at);
			if (branches.length < BRAKE_BRANCHES) continue;
			const result = trip(db, f, branches);
			brake = result.brake;
			if (result.started) tripped.push({ test: f.test, file: f.file, brake, branches });
		}
		if (!reopenedSince(db, taskId, brake)) hit ??= { brake, test: f.test, file: f.file, head: f.head };
	}
	return hit && { ...hit, tripped };
}

export const brakeStands = (db: DatabaseSync, brake: number): boolean =>
	!db.prepare("SELECT 1 FROM events WHERE type = 'brake_fixed' AND json_extract(payload, '$.brake') = ?").get(brake);

/** `evf brake fixed`: the coordinator names the merged commit, and the held tasks may then release. */
export function brakeFixed(root: string, brake: number, commit: string): number {
	if (process.env.EVF_RUN) fail("A seat cannot end a brake: the coordinator runs evf brake fixed from a human shell.");
	if (!/^[0-9a-f]{7,40}$/.test(commit)) fail("--commit takes the fix's commit sha on main.");
	const cfg = loadConfig(root);
	if (hasRemote(root, cfg)) gitOk(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	if (!gitOk(root, "merge-base", "--is-ancestor", commit, baseRef(root, cfg)))
		fail(`${commit} is not on ${baseRef(root, cfg)}. Run this after the fix merges.`);
	const db = openWorkDb(root);
	try {
		const row = db.prepare("SELECT payload FROM events WHERE id = ? AND type = 'brake_tripped'").get(brake) as
			{ payload: string } | undefined;
		if (!row) fail(`Event ${brake} is not a brake. Find it with: bin/evf events --type brake_tripped`);
		if (!brakeStands(db, brake)) {
			console.log(`brake ${brake} already ended.`);
			return 0;
		}
		const { test, file } = JSON.parse(row.payload) as TestKey;
		const sha = git(root, "rev-parse", commit);
		record(db, null, null, "brake_fixed", {
			brake,
			test,
			file,
			commit: sha,
			summary: `brake ${brake} ended by ${sha.slice(0, 10)}; held tasks release in stages`,
		});
		console.log(`brake ${brake} ended: held tasks release ${RELEASE_BATCH} per ${RELEASE_EVERY_MS / 60_000} min.`);
		return 0;
	} finally {
		db.close();
	}
}

/** What the release gate reads. Tests give a fake clock and fake readings. */
export type ReleaseProbe = { now: () => number; load: () => number; waiting: () => number };
const machineRelease = (root: string): ReleaseProbe => ({
	now: Date.now,
	load: () => loadavg()[0],
	waiting: () => checkQueueWaiting(root),
});

/**
 * Takes a release slot, or says why this task waits. A task that holds a slot in the last 5 min keeps it, so a restart
 * costs none. One drive alone is no burst: a drive's first look, with no other start in the last 5 min, reads no load or
 * queue. Each later look reads them, so a drive that waits does not pass when the 5 min run out.
 */
export function releaseWait(
	db: DatabaseSync,
	root: string,
	taskId: number,
	task: string,
	why: "hold" | "drive",
	probe: ReleaseProbe = machineRelease(root),
	firstLook = false,
): string | null {
	const at = probe.now(),
		load = probe.load(),
		waiting = probe.waiting();
	db.exec("BEGIN IMMEDIATE");
	try {
		const slots = (
			db
				.prepare("SELECT DISTINCT task_id FROM events WHERE type = 'release_start' AND ts > ?")
				.all(new Date(at - RELEASE_EVERY_MS).toISOString()) as Array<{ task_id: number }>
		).map((r) => r.task_id);
		let wait: string | null = null;
		if (!slots.includes(taskId) && !(why === "drive" && firstLook && slots.length === 0)) {
			if (slots.length >= RELEASE_BATCH)
				wait = `${RELEASE_BATCH} tasks started in the last ${RELEASE_EVERY_MS / 60_000} min`;
			else if (load >= RELEASE_LOAD) wait = `load ${load.toFixed(1)} is ${RELEASE_LOAD} or more`;
			else if (waiting >= RELEASE_QUEUE) wait = `${waiting} checks wait in the full check queue`;
		}
		if (!wait && !slots.includes(taskId))
			db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, NULL, ?, 'release_start', ?)").run(
				taskId,
				new Date(at).toISOString(),
				JSON.stringify({ why, load, waiting, summary: `${task} starts (${why}): load ${load.toFixed(1)}` }),
			);
		db.exec("COMMIT");
		return wait;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
