import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { assistantLine, fixture, MARKER, source, toolResultLine, writeTranscript } from "./fixtures.ts";
import { ensureTask, migrate, openWorkDb } from "../db.ts";
import { runDone } from "../drive.ts";
import { claudeArgs, launchPlan } from "../launch.ts";
import { EvfError, loadConfig, parseTask } from "../lib.ts";
import { resolveSeat, ROLES } from "../seats.ts";
import {
	buildUsageReport,
	costOf,
	fillRunUsage,
	readSessionUsage,
	renderUsageReport,
	usageBackfill,
} from "../usage.ts";

const OPUS = "claude-opus-5-5",
	SONNET = "claude-sonnet-5-5";
const S1 = "11111111-1111-4111-8111-111111111111",
	S2 = "22222222-2222-4222-8222-222222222222",
	S3 = "33333333-3333-4333-8333-333333333333";

/** Point CLAUDE_CONFIG_DIR at a fresh folder for the test. */
function claudeDir() {
	const dir = mkdtempSync(join(tmpdir(), "evf-claude-")),
		saved = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = dir;
	return {
		dir,
		close: () => {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = saved;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("OPS-69-migration: 003 adds the cache columns and keeps every row of a version 2 store", () => {
	const path = join(mkdtempSync(join(tmpdir(), "evf-mig-")), "w.sqlite");
	try {
		const db = new DatabaseSync(path);
		const dir = join(source, "tools/evf/db/migrations");
		db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		for (const [v, name] of [
			[1, "001-init.sql"],
			[2, "002-prototype-statuses.sql"],
		] as const) {
			db.exec(readFileSync(join(dir, name), "utf8"));
			db.prepare("INSERT INTO schema_version VALUES (?, ?, 'then')").run(v, name);
		}
		db.exec("INSERT INTO tasks (slug, mode, created_at, updated_at) VALUES ('t', 'implement', 'x', 'x')");
		db.exec(
			"INSERT INTO runs (task_id, stage, role, session_id, tokens_in, tokens_out, cost_est, started_at) VALUES (1, 'plan', 'planner', 's', 7, 8, 1.5, 'x')",
		);
		assert.deepEqual(migrate(db).applied, [
			"003-usage-columns.sql",
			"004-task-seat-override.sql",
			"005-merged-views.sql",
		]);
		assert.deepEqual(
			{
				...db
					.prepare(
						"SELECT tokens_in, tokens_out, cost_est, cache_read_tokens, cache_write_tokens, session_id FROM runs",
					)
					.get(),
			},
			{
				tokens_in: 7,
				tokens_out: 8,
				cost_est: 1.5,
				cache_read_tokens: null,
				cache_write_tokens: null,
				session_id: "s",
			},
		);
		db.close();
	} finally {
		rmSync(path, { force: true });
	}
});

test("OPS-69-parser: each message id counts once, subagents and two models count, synthetic and bad lines are skipped", () => {
	const c = claudeDir();
	try {
		writeTranscript(
			c.dir,
			S1,
			[
				assistantLine("m1", OPUS, { input: 10, output: 5, read: 100, write: 40, write1h: 30 }),
				assistantLine("m1", OPUS, { input: 10, output: 20, read: 100, write: 40, write1h: 30 }), // same message, later block
				toolResultLine(),
				"not json {",
				assistantLine("m2", SONNET, { input: 3, output: 4, read: 7, write: 9 }),
				assistantLine("m3", "<synthetic>", { input: 999, output: 999 }),
				assistantLine("m2", SONNET, { input: 3, output: 4, read: 7, write: 9 }),
			],
			[[assistantLine("sub1", SONNET, { input: 1, output: 2, read: 3, write: 4 })]],
		);
		const got = readSessionUsage(S1)!;
		assert.deepEqual([...got.keys()].sort(), [OPUS, SONNET]);
		assert.deepEqual(got.get(OPUS), { input: 10, output: 20, cacheRead: 100, cacheWrite: 40, cacheWrite1h: 30 });
		assert.deepEqual(got.get(SONNET), { input: 4, output: 6, cacheRead: 10, cacheWrite: 13, cacheWrite1h: 0 });
		assert.equal(readSessionUsage("99999999-9999-4999-8999-999999999999"), null, "no transcript");
		assert.equal(readSessionUsage("../etc"), null, "not a session id");
		// An unreadable main file (a directory in its place) is null, not a throw.
		mkdirSync(join(c.dir, "projects/-fixture-cwd", `${S3}.jsonl`));
		assert.equal(readSessionUsage(S3), null);
	} finally {
		c.close();
	}
});

test("OPS-69-cost: cost sums each model at its own price; unsplit cache writes cost the 5m rate; an unknown model has no cost", () => {
	const t = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 2_000_000, cacheWrite1h: 0 };
	const cents = (n: number | null) => Math.round(n! * 1e6) / 1e6;
	// Dollar amounts come from the API list prices, not from PRICES.
	assert.equal(cents(costOf(OPUS, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 })), 4);
	assert.equal(
		cents(costOf(SONNET, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, cacheWrite1h: 0 })),
		0.1,
	);
	assert.equal(cents(costOf(OPUS, t)), 4 + 20 + 0.2 + 2 * 5);
	assert.equal(cents(costOf(SONNET, { ...t, cacheWrite1h: 1_000_000 })), 2 + 10 + 0.1 + 2.5 + 4);
	assert.equal(costOf("claude-mystery-9", t), null);
	const c = claudeDir(),
		f = fixture();
	try {
		const db = openWorkDb(f.root);
		const row = ensureTask(db, parseTask("OPS-1"), "implement");
		const run = (session: string) =>
			Number(
				db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, session_id, status, started_at) VALUES (?, 'implement', 'implementer', ?, 'passed', 'x')",
					)
					.run(row.id, session).lastInsertRowid,
			);
		const one = { input: 1_000_000, output: 1_000_000 };
		writeTranscript(c.dir, S1, [assistantLine("a", SONNET, one)]);
		writeTranscript(c.dir, S2, [assistantLine("a", SONNET, one), assistantLine("b", OPUS, one)]);
		writeTranscript(c.dir, S3, [assistantLine("a", "claude-mystery-9", one)]);
		const [r1, r2, r3] = [run(S1), run(S2), run(S3)];
		for (const r of [r1, r2, r3]) assert.equal(fillRunUsage(db, r), true);
		const cost = (r: number) => ({
			...(db.prepare("SELECT tokens_in, cost_est FROM runs WHERE id = ?").get(r) as {
				tokens_in: number;
				cost_est: number | null;
			}),
		});
		assert.equal(cost(r1).cost_est, 12);
		assert.equal(cost(r2).cost_est, 12 + 24);
		assert.deepEqual(cost(r3), { tokens_in: 1_000_000, cost_est: null }, "tokens fill, cost stays null");
		db.close();
	} finally {
		f.close();
		c.close();
	}
});

test("OPS-69-close: evf run done fills the usage columns; a missing transcript leaves them null and the close still succeeds", () => {
	const c = claudeDir(),
		f = fixture();
	try {
		const db = openWorkDb(f.root);
		const row = ensureTask(db, parseTask("OPS-1"), "implement");
		const run = (session: string | null) =>
			Number(
				db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, session_id, status, started_at) VALUES (?, 'plan', 'planner', ?, 'started', 'x')",
					)
					.run(row.id, session).lastInsertRowid,
			);
		writeTranscript(c.dir, S1, [assistantLine("a", OPUS, { input: 5, output: 6, read: 7, write: 8 })]);
		const withTranscript = run(S1),
			without = run(S2);
		const usage = (r: number) => ({
			...db
				.prepare(
					"SELECT status, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_est FROM runs WHERE id = ?",
				)
				.get(r),
		});
		runDone(f.root, withTranscript, { status: "passed", summary: "planned" });
		assert.deepEqual(usage(withTranscript), {
			status: "passed",
			tokens_in: 5,
			tokens_out: 6,
			cache_read_tokens: 7,
			cache_write_tokens: 8,
			cost_est: costOf(OPUS, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cacheWrite1h: 0 }),
		});
		runDone(f.root, without, { status: "failed", summary: "no transcript" });
		assert.deepEqual(usage(without), {
			status: "failed",
			tokens_in: null,
			tokens_out: null,
			cache_read_tokens: null,
			cache_write_tokens: null,
			cost_est: null,
		});
		db.close();
	} finally {
		f.close();
		c.close();
	}
});

test("OPS-69-backfill: it fills only the usage columns, skips runs without a session or transcript, reports counts and repeats to the same rows", () => {
	const c = claudeDir(),
		f = fixture();
	try {
		const db = openWorkDb(f.root);
		const row = ensureTask(db, parseTask("OPS-1"), "implement");
		const ins = (stage: string, role: string, session: string | null) =>
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, model, session_id, status, summary, started_at) VALUES (?, ?, ?, ?, ?, 'passed', 'kept', 'x')",
				)
				.run(row.id, stage, role, SONNET, session);
		ins("implement", "implementer", S1);
		ins("verify", "verifier", S2); // no transcript
		ins("pr", "evf", null); // no session id
		writeTranscript(c.dir, S1, [assistantLine("a", SONNET, { input: 2, output: 3 })]);
		db.close();
		const rows = () => {
			const d = openWorkDb(f.root);
			const all = d.prepare("SELECT * FROM runs ORDER BY id").all();
			d.close();
			return all as Array<Record<string, unknown>>;
		};
		const before = rows();
		const lines: string[] = [];
		const log = console.log;
		console.log = (s: string) => void lines.push(s);
		try {
			usageBackfill(f.root);
			const first = rows();
			usageBackfill(f.root);
			assert.deepEqual(rows(), first, "a second run leaves every row the same");
			assert.equal(lines[0], lines[1]);
			assert.match(lines[0]!, /filled 1 runs, skipped 2 \(no session id: 1, no transcript: 1\)/);
			assert.match(lines[0]!, /estimates|estimate/);
			const usageCols = ["tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens", "cost_est"];
			for (const [i, b] of before.entries())
				for (const k of Object.keys(b))
					if (!usageCols.includes(k) || i > 0) assert.equal(first[i]![k], b[k], `run ${i} column ${k} unchanged`);
			assert.equal(first[0]!.tokens_in, 2);
			assert.equal(first[1]!.tokens_in, null);
		} finally {
			console.log = log;
		}
	} finally {
		f.close();
		c.close();
	}
});

/** A store with known usage: OPS-7 (round 1) and one prototype task. */
function reportStore(f: ReturnType<typeof fixture>) {
	const db = openWorkDb(f.root);
	const t = ensureTask(db, parseTask("OPS-7"), "implement");
	db.prepare("UPDATE tasks SET round = 1 WHERE id = ?").run(t.id);
	const ins = (
		stage: string,
		role: string,
		model: string,
		round: number,
		status: string,
		u: [number, number, number, number, number | null] | null,
	) =>
		db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, model, round, status, started_at, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_est) VALUES (?, ?, ?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)",
			)
			.run(t.id, stage, role, model, round, status, ...(u ?? [null, null, null, null, null]));
	ins("plan", "planner", OPUS, 0, "passed", [1000, 2000, 3000, 4000, 1.5]);
	ins("implement", "implementer", SONNET, 0, "passed", [100, 200, 300, 400, 0.25]);
	ins("verify", "verifier", OPUS, 0, "failed", [10, 20, 30, 40, 0.5]);
	ins("implement", "implementer", SONNET, 1, "passed", [1, 2, 3, 4, 0.125]);
	ins("verify", "verifier", OPUS, 1, "passed", null); // no data, not zero
	ins("pr", "evf", "", 0, "passed", null);
	const p = ensureTask(db, parseTask("OPS-8"), "prototype");
	db.prepare(
		"INSERT INTO runs (task_id, stage, role, model, round, status, started_at, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_est) VALUES (?, 'idea1', 'ideator', ?, 0, 'passed', 'x', 5, 6, 7, 8, 0.0625)",
	).run(p.id, SONNET);
	return db;
}

test("OPS-69-report: per task by role and model, build versus review split, prototype group, no data never zero; text and JSON are exact", () => {
	const f = fixture();
	try {
		const db = reportStore(f);
		const r = buildUsageReport(db);
		db.close();
		const agg = (
			runs: number,
			withData: number,
			i: number,
			o: number,
			cr: number,
			cw: number,
			cost: number | null,
		) => ({
			runs,
			runs_with_data: withData,
			no_data: runs - withData,
			input: i,
			output: o,
			cache_read: cr,
			cache_write: cw,
			cost_estimate_usd: cost,
			unpriced_runs: 0,
		});
		const note = "Costs are estimates at API list prices. Nothing is billed.";
		const pricesSource = "https://docs.claude.com/en/docs/about-claude/pricing, read 2026-10-30";
		const sonnet = "claude-sonnet-5-5",
			opus = "claude-opus-5-5";
		const op7 = {
			task: "OPS-7",
			rounds: 1,
			verify_fails: 1,
			ci_fails: 0,
			by_role_model: [
				{ role: "implementer", model: sonnet, ...agg(2, 2, 101, 202, 303, 404, 0.375) },
				{ role: "planner", model: opus, ...agg(1, 1, 1000, 2000, 3000, 4000, 1.5) },
				{ role: "verifier", model: opus, ...agg(2, 1, 10, 20, 30, 40, 0.5) },
			],
			total: agg(5, 4, 1111, 2222, 3333, 4444, 2.375),
		};
		const op8 = {
			task: "OPS-8",
			rounds: 0,
			verify_fails: 0,
			ci_fails: 0,
			by_role_model: [{ role: "ideator", model: sonnet, ...agg(1, 1, 5, 6, 7, 8, 0.0625) }],
			total: agg(1, 1, 5, 6, 7, 8, 0.0625),
		};
		const byModel = [
			{
				model: opus,
				groups: {
					build: agg(1, 1, 1000, 2000, 3000, 4000, 1.5),
					review: agg(2, 1, 10, 20, 30, 40, 0.5),
					prototype: agg(0, 0, 0, 0, 0, 0, null),
				},
				total: agg(3, 2, 1010, 2020, 3030, 4040, 2),
			},
			{
				model: sonnet,
				groups: {
					build: agg(1, 1, 100, 200, 300, 400, 0.25),
					review: agg(1, 1, 1, 2, 3, 4, 0.125),
					prototype: agg(1, 1, 5, 6, 7, 8, 0.0625),
				},
				total: agg(3, 3, 106, 208, 310, 412, 0.4375),
			},
		];
		assert.deepEqual(r, { note, prices_source: pricesSource, tasks: [op7, op8], by_model: byModel });
		const text = [
			`Usage report. ${note} Prices: ${pricesSource}.`,
			"",
			"OPS-7: rounds 1, verify fails 1, CI fails 0",
			`  implementer on ${sonnet}: input 101, output 202, cache read 303, cache write 404, $0.38 estimate (2 runs)`,
			`  planner on ${opus}: input 1,000, output 2,000, cache read 3,000, cache write 4,000, $1.50 estimate (1 run)`,
			`  verifier on ${opus}: input 10, output 20, cache read 30, cache write 40, $0.50 estimate (2 runs, 1 with no data)`,
			"  total: input 1,111, output 2,222, cache read 3,333, cache write 4,444, $2.38 estimate (5 runs, 1 with no data)",
			"",
			"OPS-8: rounds 0, verify fails 0, CI fails 0",
			`  ideator on ${sonnet}: input 5, output 6, cache read 7, cache write 8, $0.06 estimate (1 run)`,
			"  total: input 5, output 6, cache read 7, cache write 8, $0.06 estimate (1 run)",
			"",
			"By model",
			`  ${opus}`,
			"    build (round 0 plan, implement, ui, simplify): input 1,000, output 2,000, cache read 3,000, cache write 4,000, $1.50 estimate (1 run)",
			"    review and rework (evidence, verify, round 1+ build stages): input 10, output 20, cache read 30, cache write 40, $0.50 estimate (2 runs, 1 with no data)",
			"    prototype: no data (0 runs)",
			"    total: input 1,010, output 2,020, cache read 3,030, cache write 4,040, $2.00 estimate (3 runs, 1 with no data)",
			`  ${sonnet}`,
			"    build (round 0 plan, implement, ui, simplify): input 100, output 200, cache read 300, cache write 400, $0.25 estimate (1 run)",
			"    review and rework (evidence, verify, round 1+ build stages): input 1, output 2, cache read 3, cache write 4, $0.13 estimate (1 run)",
			"    prototype: input 5, output 6, cache read 7, cache write 8, $0.06 estimate (1 run)",
			"    total: input 106, output 208, cache read 310, cache write 412, $0.44 estimate (3 runs)",
		].join("\n");
		assert.equal(renderUsageReport(r), text);
		const run = (...args: string[]) =>
			spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "usage", ...args], {
				cwd: f.root,
				encoding: "utf8",
			});
		const cli = run("--json", "OPS-7");
		assert.equal(cli.status, 0, cli.stderr);
		assert.deepEqual(JSON.parse(cli.stdout), { note, prices_source: pricesSource, tasks: [op7] });
		assert.equal(run().stdout.trimEnd(), text);
	} finally {
		f.close();
	}
});

test("OPS-69-private: transcript text never reaches a runs column, an event payload or the report", () => {
	const c = claudeDir(),
		f = fixture();
	try {
		const db = openWorkDb(f.root);
		const row = ensureTask(db, parseTask("OPS-1"), "implement");
		const id = Number(
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, model, session_id, status, started_at) VALUES (?, 'plan', 'planner', ?, ?, 'started', 'x')",
				)
				.run(row.id, OPUS, S1).lastInsertRowid,
		);
		writeTranscript(
			c.dir,
			S1,
			[assistantLine("a", OPUS, { input: 1, output: 2 }, `answer ${MARKER}`), toolResultLine()],
			[[assistantLine("s", OPUS, { input: 1 }, MARKER), toolResultLine()]],
		);
		runDone(f.root, id, { status: "passed", summary: "planned" });
		usageBackfill(f.root);
		const report = buildUsageReport(db);
		const dump = JSON.stringify([
			db.prepare("SELECT * FROM runs").all(),
			db.prepare("SELECT * FROM events").all(),
			report,
			renderUsageReport(report),
		]);
		assert.ok(dump.includes('"tokens_in":2'), "the usage was read");
		assert.equal(dump.includes(MARKER), false);
		db.close();
	} finally {
		f.close();
		c.close();
	}
});

test("OPS-69-config: no seats key keeps the defaults; a role override and the trial change model and effort; one task keeps one arm", () => {
	const f = fixture();
	try {
		const write = (extra: Record<string, unknown>) => {
			const cfg = JSON.parse(readFileSync(join(f.root, "evf.config.json"), "utf8"));
			delete cfg.seats;
			delete cfg.seatTrial;
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify({ ...cfg, ...extra }));
		};
		const seat = (task: string, role: keyof typeof ROLES) => {
			const p = launchPlan(f.root, parseTask(task), role, {}),
				args = claudeArgs(p);
			return [p.model, p.effort, args[args.indexOf("--model") + 1], args[args.indexOf("--effort") + 1]];
		};
		write({});
		for (const role of Object.keys(ROLES) as Array<keyof typeof ROLES>)
			assert.deepEqual(
				seat("OPS-70", role),
				[ROLES[role].model, ROLES[role].effort, ROLES[role].model, ROLES[role].effort],
				role,
			);
		write({ seats: { implementer: { effort: "high" }, simplifier: { model: OPUS } } });
		assert.deepEqual(seat("OPS-70", "implementer"), [SONNET, "high", SONNET, "high"]);
		assert.deepEqual(seat("OPS-70", "simplifier"), [OPUS, "medium", OPUS, "medium"]);
		assert.deepEqual(
			seat("OPS-70", "ui"),
			[SONNET, "medium", SONNET, "medium"],
			"a role without an entry keeps its default",
		);
		write({ seatTrial: { roles: ["implementer", "ui"], model: OPUS, effort: "medium" } });
		const arm = (n: number) => seat(`OPS-${n}`, "implementer")[0];
		assert.deepEqual(
			[arm(69), arm(70), arm(71), arm(72)],
			[OPUS, SONNET, OPUS, SONNET],
			"alternating tasks get different models",
		);
		assert.equal(seat("WP-021/ui", "ui")[0], OPUS);
		assert.equal(seat("OPS-69", "verifier")[0], OPUS, "roles outside the trial are untouched");
		assert.equal(seat("OPS-70", "ui")[0], SONNET);
		for (const round of [0, 1, 2])
			assert.equal(
				launchPlan(f.root, parseTask("OPS-69"), "implementer", { round }).model,
				OPUS,
				"one task, one arm in every round",
			);
		// The dry run prints the resolved values.
		const dry = spawnSync(
			process.execPath,
			[join(source, "tools/evf/main.ts"), "launch", "OPS-69", "--role", "implementer", "--dry-run"],
			{ cwd: f.root, encoding: "utf8" },
		);
		assert.match(dry.stdout, new RegExp(`model: ${OPUS}, effort: medium`));
		assert.match(dry.stdout, new RegExp(`--model ${OPUS} --effort medium`));
		assert.deepEqual(resolveSeat({ seatTrial: { roles: ["ui"], effort: "low" } }, parseTask("OPS-69"), "ui"), {
			model: SONNET,
			effort: "low",
			stage: "implement",
		});
	} finally {
		f.close();
	}
});

test("OPS-69-refusals: evf refuses a bad seats or trial config and names the field", () => {
	const f = fixture();
	try {
		const base = JSON.parse(readFileSync(join(f.root, "evf.config.json"), "utf8"));
		const refuse = (extra: Record<string, unknown>, message: RegExp) => {
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify({ ...base, ...extra }));
			assert.throws(
				() => loadConfig(f.root),
				(e) => e instanceof EvfError && message.test(e.message),
				JSON.stringify(extra),
			);
			const out = spawnSync(
				process.execPath,
				[join(source, "tools/evf/main.ts"), "launch", "OPS-1", "--role", "implementer", "--dry-run"],
				{ cwd: f.root, encoding: "utf8" },
			);
			assert.notEqual(out.status, 0, "nothing launches");
			assert.match(out.stderr, message);
		};
		refuse({ seats: { implementer: { model: "claude-Fable-9" } } }, /seats\.implementer\.model names a Fable model/);
		refuse({ seats: { implementer: { model: "gpt-6" } } }, /seats\.implementer\.model must start with claude-/);
		refuse({ seats: { ui: { effort: "ultra" } } }, /seats\.ui\.effort must be one of low, medium, high, xhigh, max/);
		refuse({ seats: { cook: { model: OPUS } } }, /seats\.cook is not a role/);
		refuse({ seats: { verifier: { model: SONNET } } }, /seats\.verifier\.model must be an Opus model/);
		refuse({ seatTrial: { roles: ["verifier"], model: SONNET } }, /seatTrial\.model must be an Opus model/);
		refuse({ seatTrial: { roles: ["implementer"], model: "FABLE-x" } }, /seatTrial\.model names a Fable model/);
		refuse({ seatTrial: { roles: ["cook"], model: OPUS } }, /seatTrial\.roles names cook/);
		refuse({ seatTrial: { roles: ["ui"], effort: "max-ish" } }, /seatTrial\.effort must be one of/);
		writeFileSync(
			join(f.root, "evf.config.json"),
			JSON.stringify({ ...base, seats: { verifier: { model: "claude-opus-5-6", effort: "max" } } }),
		);
		assert.doesNotThrow(() => loadConfig(f.root), "a later Opus verifies");
	} finally {
		f.close();
	}
});
