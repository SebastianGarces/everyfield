import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, migrate, openWorkDb, workDbPath } from "../db.ts";
import { taskHandoff } from "../drive.ts";
import { launchPlan } from "../launch.ts";
import { parseTask } from "../lib.ts";
import { resolveSeat, ROLES } from "../seats.ts";

const OPUS = "claude-opus-5-5",
	SONNET = "claude-sonnet-5-5";
const roles = Object.keys(ROLES) as Array<keyof typeof ROLES>;
const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", ...env },
	});

/** A fixture whose config sets a global seats entry and a seatTrial, and a store with OPS-82 and OPS-83 rows. */
function setup() {
	const f = fixture();
	const cfg = JSON.parse(readFileSync(join(f.root, "evf.config.json"), "utf8"));
	cfg.seats = { simplifier: { effort: "low" } };
	cfg.seatTrial = { roles: ["implementer", "ui"], model: OPUS, effort: "medium" };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(cfg));
	const db = openWorkDb(f.root);
	for (const ref of ["OPS-82", "OPS-83", "OPS-84"]) ensureTask(db, parseTask(ref), "implement");
	const row = (ref: string) =>
		db.prepare("SELECT id, status, seat_model, seat_effort FROM tasks WHERE ref = ?").get(ref) as {
			id: number;
			status: string;
			seat_model: string | null;
			seat_effort: string | null;
		};
	const events = (ref: string) =>
		db
			.prepare("SELECT type, payload FROM events WHERE task_id = ? AND type = 'seat_override'")
			.all(row(ref).id) as Array<{
			type: string;
			payload: string;
		}>;
	const seats = (ref: string, ...args: string[]) => cli(f.root, {}, "task", "seats", ref, ...args);
	const plan = (ref: string, role: (typeof roles)[number]) =>
		launchPlan(f.root, parseTask(ref), role, { idea: role === "ideator" ? 1 : undefined });
	const resolved = (ref: string) => roles.map((role) => [role, plan(ref, role).model, plan(ref, role).effort]);
	return { ...f, cfg, db, row, events, seats, plan, resolved };
}

test("OPS-81-migration: schema 3 reaches 4, keeps every row and a second run changes nothing", () => {
	const dir = readdirSync(join(source, "tools/evf/db/migrations")).sort();
	assert.ok(dir.includes("004-task-seat-override.sql"));
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	// Build a schema 3 store with the first three migrations, then add a row.
	for (const file of dir.slice(0, 3)) {
		db.exec(readFileSync(join(source, "tools/evf/db/migrations", file), "utf8"));
		db.prepare("INSERT INTO schema_version VALUES (?, ?, ?)").run(Number(file.slice(0, 3)), file, "t");
	}
	db.prepare(
		"INSERT INTO tasks (slug, mode, ref, title, status, created_at, updated_at) VALUES ('ops-9', 'implement', 'OPS-9', 'kept', 'active', 't', 't')",
	).run();
	assert.deepEqual(migrate(db), { version: 4, applied: ["004-task-seat-override.sql"] });
	assert.deepEqual(
		{ ...(db.prepare("SELECT ref, title, status, seat_model, seat_effort FROM tasks").get() as object) },
		{ ref: "OPS-9", title: "kept", status: "active", seat_model: null, seat_effort: null },
	);
	assert.ok("seat_model" in (db.prepare("SELECT * FROM v_tasks").get() as object));
	assert.deepEqual(migrate(db), { version: 4, applied: [] });
	db.close();
});

test("OPS-81-apply: an override reaches every role of its task only, with a trial odd and even", () => {
	const f = setup();
	try {
		const before = { odd: f.resolved("OPS-83"), even: f.resolved("OPS-84") };
		const set = f.seats("OPS-82", "--model", OPUS, "--effort", "high");
		assert.equal(set.status, 0, set.stderr);
		assert.match(set.stdout, /OPS-82 seats: claude-opus-5-5 high \(was default\)/);
		assert.deepEqual(
			f.resolved("OPS-82"),
			roles.map((r) => [r, OPUS, "high"]),
			"every role, the three idea seats' role included",
		);
		for (const idea of [1, 2, 3])
			assert.deepEqual(
				[
					launchPlan(f.root, parseTask("OPS-82"), "ideator", { idea }).model,
					launchPlan(f.root, parseTask("OPS-82"), "ideator", { idea }).effort,
				],
				[OPUS, "high"],
			);
		for (const round of [0, 1, 2])
			assert.equal(launchPlan(f.root, parseTask("OPS-82"), "implementer", { round }).effort, "high");
		assert.deepEqual(f.resolved("OPS-83"), before.odd, "an odd task in the trial arm keeps its resolution");
		assert.deepEqual(f.resolved("OPS-84"), before.even, "an even task keeps its resolution");
		assert.deepEqual(
			before.odd.map(([r, m]) => [r, m]).filter(([r]) => r === "implementer"),
			[["implementer", OPUS]],
		);
		// The dry run prints the resolved values and creates no store when none exists.
		const dry = cli(f.root, {}, "launch", "OPS-82", "--role", "simplifier", "--dry-run");
		assert.match(dry.stdout, /model: claude-opus-5-5, effort: high/);
		// Store events.
		const ev = f.events("OPS-82");
		assert.equal(ev.length, 1);
		assert.deepEqual(JSON.parse(ev[0]!.payload), {
			model: OPUS,
			effort: "high",
			previous_model: null,
			previous_effort: null,
			summary: "OPS-82 seats: claude-opus-5-5 high (was default)",
		});
	} finally {
		f.close();
	}
});

test("OPS-81-partial: a partial override keeps the other field's normal resolution; clear and change work", () => {
	const f = setup();
	try {
		assert.equal(f.seats("OPS-83", "--effort", "xhigh").status, 0);
		assert.deepEqual(f.row("OPS-83").seat_model, null);
		assert.deepEqual(
			[f.plan("OPS-83", "implementer").model, f.plan("OPS-83", "implementer").effort],
			[OPUS, "xhigh"],
			"trial model",
		);
		assert.deepEqual([f.plan("OPS-83", "simplifier").model, f.plan("OPS-83", "simplifier").effort], [SONNET, "xhigh"]);
		assert.equal(f.seats("OPS-83", "--model", OPUS).status, 0);
		assert.deepEqual(
			[f.row("OPS-83").seat_model, f.row("OPS-83").seat_effort],
			[OPUS, "xhigh"],
			"--model clears nothing",
		);
		assert.equal(f.seats("OPS-83", "--effort", "low").status, 0);
		assert.deepEqual([f.row("OPS-83").seat_model, f.row("OPS-83").seat_effort], [OPUS, "low"]);
		const cleared = f.seats("OPS-83", "--clear");
		assert.equal(cleared.status, 0, cleared.stderr);
		assert.deepEqual([f.row("OPS-83").seat_model, f.row("OPS-83").seat_effort], [null, null]);
		const last = JSON.parse(f.events("OPS-83").at(-1)!.payload);
		assert.deepEqual([last.model, last.effort, last.previous_model, last.previous_effort], [null, null, OPUS, "low"]);
		assert.equal(f.events("OPS-83").length, 4);
		assert.deepEqual(resolveSeat(f.cfg, parseTask("OPS-84"), "ui"), {
			model: SONNET,
			effort: "medium",
			stage: "implement",
		});
	} finally {
		f.close();
	}
});

test("OPS-81-refuse: bad models, efforts, empty calls, seats, missing and closed rows change nothing", () => {
	const f = setup();
	try {
		const refused = (args: string[], pattern: RegExp, env: Record<string, string> = {}) => {
			const r = cli(f.root, env, "task", "seats", "OPS-82", ...args);
			assert.equal(r.status, 1, r.stdout);
			assert.match(r.stderr, pattern);
			assert.deepEqual([f.row("OPS-82").seat_model, f.row("OPS-82").seat_effort], [null, null]);
			assert.equal(f.events("OPS-82").length, 0);
		};
		refused(["--model", "gpt-5"], /--model must start with claude- \(got gpt-5\)/);
		refused(["--model", "claude-Fable-1"], /--model names a Fable model/);
		refused(["--model", "fable"], /--model names a Fable model/);
		refused(["--effort", "extreme"], /--effort must be one of low, medium, high, xhigh, max/);
		refused([], /Give --model, --effort or --clear/);
		refused(["--clear", "--model", OPUS], /--clear alone/);
		refused(["--model", OPUS, "--effort", "high"], /coordinator/, { EVF_RUN: "7" });
		refused(["--model", OPUS, "--effort", "high"], /human shell/, { EVF_RUN: "7" });
		const none = cli(f.root, {}, "task", "seats", "OPS-99", "--model", OPUS);
		assert.equal(none.status, 1);
		assert.match(none.stderr, /no open task row/);
		for (const status of ["merged", "abandoned"]) {
			f.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, f.row("OPS-84").id);
			const r = f.seats("OPS-84", "--model", OPUS);
			assert.equal(r.status, 1, status);
			assert.equal(f.row("OPS-84").seat_model, null);
		}
		assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'seat_override'").get()!.n, 0);
		assert.match(cli(f.root, {}, "help").stdout, /evf task seats <task>/);
	} finally {
		f.close();
	}
});

test("OPS-81-verifier: a non-Opus override leaves the verifier on Opus; an Opus override applies to it", () => {
	const f = setup();
	try {
		const set = f.seats("OPS-82", "--model", SONNET, "--effort", "low");
		assert.equal(set.status, 0, set.stderr);
		assert.equal(set.stdout.split("\n").filter((l) => /verifier keeps its Opus setting/.test(l)).length, 1);
		assert.deepEqual([f.plan("OPS-82", "verifier").model, f.plan("OPS-82", "verifier").effort], [OPUS, "medium"]);
		assert.deepEqual([f.plan("OPS-82", "planner").model, f.plan("OPS-82", "planner").effort], [SONNET, "low"]);
		assert.deepEqual([f.plan("OPS-82", "implementer").model, f.plan("OPS-82", "implementer").effort], [SONNET, "low"]);
		const opus = f.seats("OPS-82", "--model", "claude-opus-5-5", "--effort", "max");
		assert.doesNotMatch(opus.stdout, /verifier keeps/);
		assert.deepEqual([f.plan("OPS-82", "verifier").model, f.plan("OPS-82", "verifier").effort], [OPUS, "max"]);
	} finally {
		f.close();
	}
});

test("OPS-81-handoff: the handoff carries the override and a plain prototype gives a plain implement row", () => {
	const f = setup(),
		savedRun = process.env.EVF_RUN;
	delete process.env.EVF_RUN; // The handoff records the calling seat's run; a harness seat running this test has one.
	try {
		const proto = (ref: string, model: string | null, effort: string | null) => {
			const task = parseTask(ref);
			f.db.prepare("DELETE FROM tasks WHERE ref = ?").run(ref);
			const row = ensureTask(f.db, task, "prototype");
			f.db
				.prepare("UPDATE tasks SET ask = 'ask', seat_model = ?, seat_effort = ? WHERE id = ?")
				.run(model, effort, row.id);
			f.db
				.prepare(
					"INSERT INTO approvals (task_id, gate, approver, head_sha, proof_ids, decision, quote, created_at) VALUES (?, 'pick', 'Sebastian', NULL, '[1]', 'approved', 'go', 't')",
				)
				.run(row.id);
			const file = join(f.root, `${ref}.md`);
			writeFileSync(file, "Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.\nApproach: a.");
			return { task, row, file };
		};
		const a = proto("OPS-82", OPUS, "high");
		assert.equal(taskHandoff(f.root, a.task, a.file), 0);
		const rows = f.db
			.prepare("SELECT id, mode, status, seat_model, seat_effort FROM tasks WHERE ref = 'OPS-82' ORDER BY id")
			.all() as Array<Record<string, unknown>>;
		assert.deepEqual(
			rows.map((r) => [r.mode, r.status, r.seat_model, r.seat_effort]),
			[
				["prototype", "done", OPUS, "high"],
				["implement", "specced", OPUS, "high"],
			],
		);
		const events = f.db
			.prepare("SELECT type, payload FROM events WHERE type IN ('handoff', 'spec_set') ORDER BY id")
			.all() as Array<{ type: string; payload: string }>;
		for (const e of events)
			assert.deepEqual([JSON.parse(e.payload).seat_model, JSON.parse(e.payload).seat_effort], [OPUS, "high"], e.type);
		assert.equal(f.plan("OPS-82", "implementer").model, OPUS, "launch reads the new implement row");
		const b = proto("OPS-84", null, null);
		assert.equal(taskHandoff(f.root, b.task, b.file), 0);
		const plain = f.db
			.prepare("SELECT seat_model, seat_effort FROM tasks WHERE ref = 'OPS-84' AND mode = 'implement'")
			.get() as Record<string, unknown>;
		assert.deepEqual({ ...plain }, { seat_model: null, seat_effort: null });
	} finally {
		if (savedRun !== undefined) process.env.EVF_RUN = savedRun;
		f.close();
	}
});

test("OPS-81-status: evf status shows the override, default and a task with no seat, in text and JSON", () => {
	const f = setup();
	try {
		f.seats("OPS-82", "--model", OPUS, "--effort", "high");
		const json = JSON.parse(cli(f.root, {}, "status", "--json").stdout).tasks as Array<Record<string, unknown>>;
		const by = (ref: string) => json.find((t) => t.ref === ref)!;
		assert.deepEqual([by("OPS-82").seat_model, by("OPS-82").seat_effort], [OPUS, "high"]);
		assert.deepEqual([by("OPS-83").seat_model, by("OPS-83").seat_effort], [null, null]);
		assert.equal(by("OPS-82").active_seats, 0, "no run backs the override");
		const text = cli(f.root, {}, "status").stdout;
		assert.match(text, /OPS-82\s.*claude-opus-5-5 high/);
		assert.match(text, /OPS-83\s.*\sdefault\s/);
		const one = cli(f.root, {}, "status", "OPS-82").stdout;
		assert.match(one, /claude-opus-5-5 high/);
	} finally {
		f.close();
	}
});

test("OPS-81-dry-run: a dry run creates no store when none exists", () => {
	const f = fixture();
	try {
		const r = cli(f.root, {}, "launch", "OPS-82", "--role", "planner", "--dry-run");
		assert.equal(r.status, 0, r.stderr);
		assert.equal(spawnSync("test", ["-e", workDbPath(f.root)]).status, 1);
	} finally {
		f.close();
	}
});
