// OPS-131: the owner queue. evf records each ask and answer, prints what waits for Sebastian and sends nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./fixtures.ts";
import { parseTask } from "../lib.ts";
import { ensureTask, migrate, newTaskRow, openWorkDb, record, workDbPath } from "../db.ts";
import { approve } from "../approve.ts";
import { ship } from "../ship.ts";
import { driveOnce } from "../drive.ts";
import { feedbackTriage } from "../feedback.ts";
import { nextDigest, parseOwnerQueue, splitWait } from "../owner-queue.ts";
import { DEFAULT_DOCUMENT_TEMPLATES, DEFAULT_OWNER_PATHS } from "../policy.ts";

const source = resolve(import.meta.dirname, "../../..");
const AUTHOR = { session: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet-5-5", role: "implementer" };
const VERIFIER = { session: "22222222-2222-4222-8222-222222222222", model: "claude-opus-5-5", role: "verifier" };
const QUALITY = {
	verdict: "approved",
	principles: [
		"laziness-protocol",
		"minimize-reader-load",
		"subtract-before-you-add",
		"test-behavior-not-implementation",
	],
};
const WORDS = "looks good";
const QUESTION = "Keep, abandon or reopen?";
const TIMING = { waitMs: 2000, ciWaitMs: 200, ciPollMs: 10, seatPollMs: 10, startGraceMs: 10 };
const fastShip = { queue: { waitMs: 10_000, pollMs: 10 }, ciWaitMs: 10_000, ciPollMs: 1 };
const HEAD = "a".repeat(40);
const HOUR = 60;
const TEMPLATE = "tools/evf/held-template.txt",
	OWNER_PATH = "tools/evf/held-owner.txt";
type Fx = ReturnType<typeof fixture>;

const cli = (f: { root: string }, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd: f.root,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" },
	});

/** The queue through the real command, in both outputs. */
function queue(f: { root: string }) {
	const text = cli(f, "owner-queue"),
		json = cli(f, "owner-queue", "--json");
	assert.equal(text.status, 0, text.stderr);
	assert.equal(json.status, 0, json.stderr);
	return { lines: text.stdout.trim().split("\n"), text: text.stdout, json: JSON.parse(json.stdout) };
}

function config(f: Fx, ownerQueue: unknown): void {
	f.cfg.ownerQueue = ownerQueue;
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, "\t"));
}

function withStore<T>(f: { root: string }, fn: (db: DatabaseSync) => T): T {
	const db = openWorkDb(f.root);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** A task row with this status, PR and parent. */
function addRow(db: DatabaseSync, ref: string, o: { status?: string; pr?: number; parent?: number } = {}): number {
	const row = newTaskRow(db, parseTask(ref), "implement");
	db.prepare("UPDATE tasks SET status = ?, pr_number = ?, parent_task_id = ? WHERE id = ?").run(
		o.status ?? "pr_open",
		o.pr ?? null,
		o.parent ?? null,
		row.id,
	);
	return row.id;
}

/** An open item asked `age` minutes ago. */
function asked(db: DatabaseSync, id: number, ref: string, age: number, o: { pr?: number; kind?: string } = {}): void {
	record(db, id, null, "owner_ask", {
		task: ref,
		pr: o.pr ?? 77,
		head: HEAD,
		kind: o.kind ?? "template",
		digestId: "2026-11-04T13:00",
		askedAt: new Date(Date.now() - age * 60_000).toISOString(),
	});
}

function ownerEvents(f: { root: string }, type = "owner_ask"): Array<Record<string, any>> {
	return withStore(f, (db) =>
		(db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY id").all(type) as Array<{ payload: string }>).map(
			(e) => JSON.parse(e.payload),
		),
	);
}

const quietly = <T>(fn: () => T): { value: T; out: string; err: string } => {
	const log = console.log,
		error = console.error,
		out: string[] = [],
		err: string[] = [];
	console.log = (...a) => out.push(a.join(" "));
	console.error = (...a) => err.push(a.join(" "));
	try {
		return { value: fn(), out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
};

function prBody(): string {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	return `${template
		.split("\n")
		.filter((line) => line.startsWith("## "))
		.map((heading) => `${heading}\nConcrete task evidence.`)
		.join(
			"\n\n",
		)}\n\nEVF-Author: ${JSON.stringify(AUTHOR)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}

/** Task PR #77 in a fixture with a remote, a fake GitHub with green required CI, and a helper to move its head. */
function prFixture(ref = "OPS-1", scope: Record<string, unknown> = {}) {
	const f = fixture(),
		task = parseTask(ref);
	f.cfg.maintenanceTasks = {
		"OPS-1": {
			title: "Workflow upkeep",
			checks: f.cfg.checks,
			owningPaths: ["tools/evf/", "evf.config.json", "docs/reference/wiki/"],
			...scope,
		},
	};
	f.cfg.mergePolicy.documentTemplates = { ...DEFAULT_DOCUMENT_TEMPLATES, paths: [TEMPLATE] };
	f.cfg.mergePolicy.ownerPaths = { ...DEFAULT_OWNER_PATHS, paths: [OWNER_PATH] };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, "\t"));
	mkdirSync(join(f.root, "tools/evf"), { recursive: true });
	writeFileSync(join(f.root, "tools/evf/main.ts"), "export const main = 1;\n");
	f.git("add", "evf.config.json", "tools/evf/main.ts");
	f.git("commit", "-qm", "Fixture evf files");
	f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
	f.git("push", "-q", "origin", "main");
	if (task.kind === "fb") {
		f.authorize("WP-034");
		f.commit();
		f.git("push", "-q", "origin", "main");
		feedbackTriage(f.root, task.issue!, { cls: "p2", reason: "scoped feedback", wp: "WP-034" });
	}
	const wt = f.task(task.slug);
	const inWt = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
	/** One commit on the branch, pushed as the PR head with an approved review. The call log restarts. */
	const publish = (files: Record<string, string>, edit: (s: any) => void = () => {}) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(wt, path, ".."), { recursive: true });
			writeFileSync(join(wt, path), text);
		}
		inWt("add", ...Object.keys(files));
		inWt("commit", "-qm", "Work");
		const head = inWt("rev-parse", "HEAD");
		inWt("push", "-q", "origin", `+${head}:refs/heads/${task.branch}`);
		const s = f.getState();
		s.pr = {
			number: 77,
			title: `${ref}: work`,
			url: "https://github.com/test/private/pull/77",
			state: "OPEN",
			isDraft: false,
			headRefName: task.branch,
			headRefOid: head,
			baseRefName: "main",
			mergeStateStatus: "CLEAN",
			files: Object.keys(files).map((path) => ({ path })),
			body: prBody(),
		};
		s.protection = { required_status_checks: { strict: true, contexts: ["ci"] } };
		s.requiredChecks = [
			{ name: "ci", state: "SUCCESS", bucket: "pass", link: "https://github.com/test/private/actions/runs/1" },
		];
		s.comments["77"] = [
			{
				body: `EVF-Review: ${JSON.stringify({ head, verifier: VERIFIER, verdict: "approved", quality: QUALITY, experience: { verdict: "approved", budget: "met" } })}`,
				html_url: `https://github.com/test/private/pull/77#review-${head.slice(0, 7)}`,
			},
		];
		s.commitStatus = {
			statuses: [
				{ context: "evf/verify", state: "success", description: `Verified by claude-opus-5-5 at ${head.slice(0, 10)}` },
			],
		};
		s.allowMerge = false;
		s.mergeBranch = task.branch;
		s.calls = [];
		edit(s);
		f.setState(s);
		return head;
	};
	return { ...f, task, wt, inWt, publish };
}

/** Run in a folder two levels below the root: the fake gh merges into the checkout at cwd/../.. */
function inFakeCwd<T>(f: { root: string }, fn: () => T): T {
	const cwd = process.cwd(),
		dir = join(f.root, "fake-bin", "cwd");
	mkdirSync(dir, { recursive: true });
	process.chdir(dir);
	try {
		return fn();
	} finally {
		process.chdir(cwd);
	}
}

function assertAskShape(event: Record<string, unknown>): void {
	assert.deepEqual(Object.keys(event), ["task", "pr", "head", "kind", "digestId", "askedAt"]);
}

test("AC:OPS-131-1 evf owner-queue prints one line per open item, urgent first and then oldest first, and says when nothing waits", () => {
	const f = fixture();
	try {
		assert.match(queue(f).text, /^Nothing waits for Sebastian\.$/m, "no store yet");
		withStore(f, () => {});
		assert.match(queue(f).text, /^Nothing waits for Sebastian\.$/m, "an empty store");
		withStore(f, (db) => {
			const newer = addRow(db, "OPS-3", { pr: 303 });
			asked(db, newer, "OPS-3", 30, { pr: 303, kind: "design" });
			const older = addRow(db, "OPS-2", { pr: 202 });
			asked(db, older, "OPS-2", 200, { pr: 202 });
			const urgent = addRow(db, "OPS-4", { pr: 404 });
			asked(db, urgent, "OPS-4", 5, { pr: 404, kind: "void_approval" });
			addRow(db, "OPS-5", { parent: urgent });
		});
		const { lines } = queue(f);
		assert.equal(lines[0], "3 waiting for Sebastian.");
		assert.equal(
			lines[1],
			`URGENT | PR #404 | ${HEAD.slice(0, 10)} | OPS-4 | Approve the new head of PR #404, because new code voided your approval. | age 0h 5m | blocks 2`,
		);
		assert.equal(
			lines[2],
			`PR #202 | ${HEAD.slice(0, 10)} | OPS-2 | Approve the document template change in PR #202. | age 3h 20m | blocks 1`,
		);
		assert.equal(
			lines[3],
			`PR #303 | ${HEAD.slice(0, 10)} | OPS-3 | Approve the design task in PR #303. | age 0h 30m | blocks 1`,
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-131-2 evf owner-queue --json returns the same items with every field and the next digest time", () => {
	const f = fixture();
	try {
		withStore(f, (db) => asked(db, addRow(db, "OPS-2", { pr: 202 }), "OPS-2", 90, { pr: 202 }));
		const { json } = queue(f);
		assert.match(json.nextDigest, /^\d{4}-\d\d-\d\dT(09|13|17):00$/);
		assert.equal(json.items.length, 1);
		const item = json.items[0];
		assert.deepEqual(Object.keys(item), [
			"task",
			"pr",
			"head",
			"kind",
			"ask",
			"askedAt",
			"ageMinutes",
			"blocked",
			"urgent",
			"question",
			"digestId",
		]);
		const { askedAt, ...rest } = item;
		assert.ok(Date.parse(askedAt) > 0);
		assert.deepEqual(rest, {
			task: "OPS-2",
			pr: 202,
			head: HEAD,
			kind: "template",
			ask: "Approve the document template change in PR #202.",
			ageMinutes: 90,
			blocked: 1,
			urgent: false,
			question: null,
			digestId: "2026-11-04T13:00",
		});
	} finally {
		f.close();
	}
});

test("AC:OPS-131-3 an item that blocks 2 tasks is urgent through a follow-up or a dag dependent; 1 is not, and merged work does not count", () => {
	const f = fixture();
	try {
		// The follow-up route: an open row counts; a merged or abandoned row does not.
		withStore(f, (db) => {
			const open = addRow(db, "OPS-2", { pr: 2 });
			asked(db, open, "OPS-2", 10, { pr: 2 });
			addRow(db, "OPS-12", { status: "queued", parent: open });
			const merged = addRow(db, "OPS-3", { pr: 3 });
			asked(db, merged, "OPS-3", 10, { pr: 3 });
			addRow(db, "OPS-13", { status: "merged", parent: merged });
			addRow(db, "OPS-14", { status: "abandoned", parent: merged });
		});
		let { json, lines } = queue(f);
		const of = (task: string) => json.items.find((i: { task: string }) => i.task === task);
		assert.deepEqual([of("OPS-2").blocked, of("OPS-2").urgent], [2, true]);
		assert.deepEqual([of("OPS-3").blocked, of("OPS-3").urgent], [1, false]);
		assert.match(
			lines.find((l) => l.includes("OPS-2"))!,
			/^URGENT .* blocks 2$/,
		);
		assert.doesNotMatch(
			lines.find((l) => l.includes("OPS-3"))!,
			/URGENT/,
		);

		// The dag route: a package with one direct dependent that has dependents of its own, so transitive ones show.
		const dag = JSON.parse(readFileSync(join(f.root, "docs/plan/dag.json"), "utf8")) as {
			packages: Array<{ id: string; depends_on: string[]; ui_depends_on?: string[] }>;
		};
		const dependentsOf = (id: string) =>
			dag.packages.filter((p) => p.depends_on.includes(id) || p.ui_depends_on?.includes(id));
		const chain = dag.packages.find((p) => {
			const d = dependentsOf(p.id);
			return d.length === 1 && dependentsOf(d[0]!.id).length > 0;
		})!;
		const dependent = dependentsOf(chain.id)[0]!.id;
		withStore(f, (db) => asked(db, addRow(db, chain.id, { pr: 9 }), chain.id, 10, { pr: 9 }));
		({ json, lines } = queue(f));
		const item = () => json.items.find((i: { task: string }) => i.task === chain.id);
		assert.deepEqual([item().blocked, item().urgent], [2, true], "direct dependents only");
		assert.match(
			lines.find((l) => l.includes(chain.id))!,
			/^URGENT .* blocks 2$/,
		);

		withStore(f, (db) => addRow(db, dependent, { status: "merged" }));
		({ json, lines } = queue(f));
		assert.deepEqual([item().blocked, item().urgent], [1, false], "a merged dependent does not count");
		assert.doesNotMatch(
			lines.find((l) => l.includes(chain.id))!,
			/URGENT/,
		);

		withStore(f, (db) => addRow(db, `${dependent}/ui`, { status: "active" }));
		({ json } = queue(f));
		assert.equal(item().blocked, 2, "a dependent with an open part is not merged");
	} finally {
		f.close();
	}
});

test("AC:OPS-131-4 an item older than 48 h shows the keep, abandon or reopen question; a younger item does not", () => {
	const f = fixture();
	try {
		withStore(f, (db) => {
			asked(db, addRow(db, "OPS-2", { pr: 2 }), "OPS-2", 48 * HOUR + 1, { pr: 2 });
			asked(db, addRow(db, "OPS-3", { pr: 3 }), "OPS-3", 48 * HOUR - 1, { pr: 3 });
		});
		const { json, lines } = queue(f);
		assert.deepEqual(
			json.items.map((i: { task: string; question: string | null }) => [i.task, i.question]),
			[
				["OPS-2", QUESTION],
				["OPS-3", null],
			],
		);
		assert.ok(lines.find((l) => l.includes("OPS-2"))!.endsWith(`blocks 1 | ${QUESTION}`));
		assert.ok(!lines.find((l) => l.includes("OPS-3"))!.includes(QUESTION));
	} finally {
		f.close();
	}
});

test("AC:OPS-131-5 each route in evf ship records one owner_ask; a rerun on the same head adds none and a new head adds one", () => {
	const cases: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
		["held template", "template", {}, { [TEMPLATE]: "export const t = 1;\n" }],
		["held owner path", "owner_path", {}, { [OWNER_PATH]: "export const p = 1;\n" }],
		["Wiki route", "wiki", {}, { "docs/reference/wiki/seed.json": '{"sections":[],"articles":[]}\n' }],
		["design task", "design", { owningPaths: ["design/"], route: "design" }, { "design/note.txt": "one\n" }],
	];
	for (const [name, kind, scope, files] of cases) {
		const f = prFixture("OPS-1", scope);
		try {
			f.publish(files);
			assert.equal(quietly(() => ship(f.root, f.task, fastShip)).value, 0, name);
			let asks = ownerEvents(f);
			assert.equal(asks.length, 1, name);
			assertAskShape(asks[0]!);
			assert.deepEqual(
				[asks[0]!.task, asks[0]!.pr, asks[0]!.head, asks[0]!.kind],
				["OPS-1", 77, f.inWt("rev-parse", "HEAD"), kind],
				name,
			);
			assert.match(asks[0]!.digestId, /^\d{4}-\d\d-\d\dT(09|13|17):00$/);

			f.setState({ ...f.getState(), calls: [] });
			assert.equal(quietly(() => ship(f.root, f.task, fastShip)).value, 0, name);
			assert.equal(ownerEvents(f).length, 1, `${name}: a rerun on the same head adds no event`);

			f.publish(Object.fromEntries(Object.keys(files).map((p) => [p, `${readFileSync(join(f.wt, p))}\n`])));
			assert.equal(quietly(() => ship(f.root, f.task, fastShip)).value, 0, name);
			asks = ownerEvents(f);
			assert.equal(asks.length, 2, `${name}: a new head adds one`);
			assert.equal(asks[1]!.head, f.inWt("rev-parse", "HEAD"));
		} finally {
			f.close();
		}
	}
});

test("AC:OPS-131-5 a P2 fix, a void approval, an escalation and an awaiting pick each record one owner_ask", () => {
	// P2 feedback: the owner route of evf ship.
	let f = prFixture("FB-1");
	try {
		const head = f.publish({ "tools/evf/fix.ts": "export const fix = 1;\n" });
		assert.equal(quietly(() => ship(f.root, f.task, fastShip)).value, 0);
		const asks = ownerEvents(f);
		assert.equal(asks.length, 1);
		assertAskShape(asks[0]!);
		assert.deepEqual([asks[0]!.task, asks[0]!.pr, asks[0]!.head, asks[0]!.kind], ["FB-1", 77, head, "feedback"]);
	} finally {
		f.close();
	}

	// Void approval: by hand through evf ship, then through the drive's ship stage on the same head.
	f = prFixture();
	try {
		const approved = f.publish({ "tools/evf/feature.ts": "export const feature = 1;\n" });
		const head = f.publish({ "tools/evf/feature.ts": "export const feature = 2;\n" }, (s) => {
			s.comments["77"].push({
				body: `Approved\n\nEVF-Owner: ${JSON.stringify({ head: approved, quote: WORDS, at: "2026-11-02T22:18:00.000Z" })}`,
				html_url: "https://github.com/test/private/pull/77#owner",
			});
		});
		const row = withStore(f, (db) => {
			const t = ensureTask(db, f.task, "implement");
			db.prepare("UPDATE tasks SET pr_number = 77, status = 'pr_open', worktree = ? WHERE id = ?").run(f.wt, t.id);
			return t.id;
		});
		assert.throws(() => quietly(() => ship(f.root, f.task, fastShip)), /owner approval is void/);
		const manual = ownerEvents(f);
		assert.equal(manual.length, 1);
		assertAskShape(manual[0]!);
		assert.deepEqual([manual[0]!.head, manual[0]!.kind, manual[0]!.pr], [head, "void_approval", 77]);

		withStore(f, (db) => {
			db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(
				"Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.",
				row,
			);
			for (const [stage, role, session] of [
				["implement", "implementer", AUTHOR.session],
				["verify", "verifier", VERIFIER.session],
				["ci", "evf", null],
			] as const)
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, 'passed', ?)",
				).run(row, stage, role, session, new Date().toISOString());
		});
		herdrStub(f.root);
		assert.equal(quietly(() => driveOnce(f.root, f.task, TIMING)).value.stage, "done");
		assert.equal(ownerEvents(f).length, 1, "the drive's refusal on the same head adds none");
	} finally {
		f.close();
	}

	// Escalation and awaiting pick: the drive's own routes.
	f = prFixture();
	try {
		herdrStub(f.root);
		const spec = "Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.";
		withStore(f, (db) => {
			const t = ensureTask(db, f.task, "implement");
			db.prepare("UPDATE tasks SET spec = ?, status = 'pr_open', pr_number = 77, worktree = ? WHERE id = ?").run(
				spec,
				f.wt,
				t.id,
			);
			for (let i = 0; i < 6; i++)
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, 'implement', 'implementer', 0, 'failed', ?)",
				).run(t.id, new Date().toISOString());
		});
		assert.equal(quietly(() => driveOnce(f.root, f.task, TIMING)).value.stage, "escalated");
		quietly(() => driveOnce(f.root, f.task, TIMING));
		const asks = ownerEvents(f);
		assert.equal(asks.length, 1);
		assertAskShape(asks[0]!);
		assert.deepEqual(
			[asks[0]!.task, asks[0]!.pr, asks[0]!.head, asks[0]!.kind],
			["OPS-1", 77, f.inWt("rev-parse", "HEAD"), "escalation"],
		);
	} finally {
		f.close();
	}

	f = prFixture();
	try {
		herdrStub(f.root);
		const spec = "Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.";
		withStore(f, (db) => {
			const t = ensureTask(db, f.task, "prototype");
			db.prepare("UPDATE tasks SET spec = ?, status = 'active' WHERE id = ?").run(spec, t.id);
			for (const [stage, role] of [
				["plan", "planner"],
				["idea1", "ideator"],
				["idea2", "ideator"],
				["idea3", "ideator"],
				["compare", "comparer"],
			] as const)
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, ?, 0, 'passed', ?)",
				).run(t.id, stage, role, new Date().toISOString());
		});
		assert.equal(quietly(() => driveOnce(f.root, f.task, TIMING)).value.stage, "pick");
		quietly(() => driveOnce(f.root, f.task, TIMING));
		const asks = ownerEvents(f);
		assert.equal(asks.length, 1);
		assertAskShape(asks[0]!);
		assert.deepEqual(
			[asks[0]!.task, asks[0]!.pr, asks[0]!.head, asks[0]!.kind],
			["OPS-1", null, null, "prototype_pick"],
		);
		assert.match(queue(f).lines[1]!, /^no PR \| unknown \| OPS-1 \| Pick one of the compared ideas for OPS-1\./);
	} finally {
		f.close();
	}
});

/** A Herdr that logs each call and answers nothing. */
function herdrStub(root: string): () => string[] {
	const log = join(root, "herdr.log");
	writeFileSync(join(root, "fake-bin/herdr"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\necho '{"result":{}}'\n`);
	chmodSync(join(root, "fake-bin/herdr"), 0o755);
	return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
}

test("AC:OPS-131-6 evf approve on either route and a merge through evf ship each record one owner_answer, and the item leaves the queue", () => {
	const check = (f: ReturnType<typeof prFixture>, head: string, count = 1) => {
		const answers = ownerEvents(f, "owner_answer");
		assert.equal(answers.length, count);
		const a = answers.at(-1)!;
		assert.deepEqual(Object.keys(a), ["task", "pr", "head", "answeredAt"]);
		assert.deepEqual([a.task, a.pr, a.head], [f.task.id, 77, head]);
		assert.ok(Date.parse(a.answeredAt) > 0);
		assert.deepEqual(queue(f).json.items, []);
	};
	// The ordinary route of evf approve records the approval and its answer; nothing merges yet.
	let f = prFixture();
	try {
		const head = f.publish({ "tools/evf/feature.ts": "export const feature = 1;\n" }, (s) => (s.comments["77"] = []));
		withStore(f, (db) =>
			record(db, ensureTask(db, f.task, "implement").id, null, "owner_ask", {
				task: "OPS-1",
				pr: 77,
				head,
				kind: "parked",
				digestId: null,
				askedAt: new Date().toISOString(),
			}),
		);
		assert.equal(queue(f).json.items.length, 1);
		assert.equal(quietly(() => approve(f.root, 77, { ownerApproval: WORDS, head })).value, 0);
		check(f, head);
		// A second approval and the merge through evf ship have no open ask left.
		f.publish({ "tools/evf/feature.ts": "export const feature = 2;\n" }, (s) => (s.allowMerge = true));
		const merged = f.inWt("rev-parse", "HEAD");
		assert.equal(quietly(() => approve(f.root, 77, { ownerApproval: WORDS, head: merged })).value, 0);
		assert.equal(ownerEvents(f, "owner_answer").length, 1, "a task with no open ask records no answer");
	} finally {
		f.close();
	}

	// The merging route of evf approve: a held document-template PR.
	f = prFixture();
	try {
		const head = f.publish({ [TEMPLATE]: "export const t = 1;\n" });
		quietly(() => ship(f.root, f.task, fastShip));
		assert.equal(queue(f).json.items.length, 1);
		f.setState({ ...f.getState(), allowMerge: true, calls: [] });
		const r = quietly(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: WORDS })));
		assert.equal(r.value, 0, r.err);
		check(f, head);
	} finally {
		f.close();
	}

	// A merge through evf ship answers an open ask on the task.
	f = prFixture();
	try {
		const head = f.publish({ "tools/evf/feature.ts": "export const feature = 1;\n" }, (s) => (s.allowMerge = true));
		withStore(f, (db) =>
			record(db, ensureTask(db, f.task, "implement").id, null, "owner_ask", {
				task: "OPS-1",
				pr: 77,
				head,
				kind: "parked",
				digestId: null,
				askedAt: new Date().toISOString(),
			}),
		);
		assert.equal(quietly(() => ship(f.root, f.task, fastShip)).value, 0);
		check(f, head);
	} finally {
		f.close();
	}
});

test("AC:OPS-131-6 task pick, compare-passed, task reopen and abandon each record one owner_answer; no open ask records none", () => {
	const f = fixture();
	try {
		const statuses: Array<[string, string, string, string[]]> = [
			["OPS-2", "prototype", "awaiting_pick", ["task", "pick", "OPS-2", "2", "--owner-approval", WORDS]],
			["OPS-3", "prototype", "escalated", ["task", "compare-passed", "OPS-3", "--owner-approval", WORDS]],
			["OPS-4", "implement", "escalated", ["task", "reopen", "OPS-4", "--reason", "fixed the cause"]],
			["OPS-5", "implement", "pr_open", ["task", "abandon", "OPS-5", "--reason", "no longer wanted"]],
		];
		withStore(f, (db) => {
			for (const [ref, mode, status] of statuses) {
				const row = newTaskRow(db, parseTask(ref), mode);
				db.prepare("UPDATE tasks SET status = ?, pr_number = 77 WHERE id = ?").run(status, row.id);
				asked(db, row.id, ref, 10);
			}
			const compare = (db.prepare("SELECT id FROM tasks WHERE ref = 'OPS-3'").get() as { id: number }).id;
			for (const [stage, status] of [
				["idea1", "failed"],
				["idea2", "passed"],
				["idea3", "passed"],
			])
				db.prepare(
					"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, 'ideator', 0, ?, ?)",
				).run(compare, stage, status, new Date().toISOString());
		});
		for (const [i, [ref, , , command]] of statuses.entries()) {
			assert.ok(
				queue(f).json.items.some((item: { task: string }) => item.task === ref),
				`${ref} is open before the answer`,
			);
			const r = cli(f, ...command);
			assert.equal(r.status, 0, r.stderr);
			const answers = ownerEvents(f, "owner_answer");
			assert.equal(answers.length, i + 1, ref);
			assert.deepEqual(Object.keys(answers[i]!), ["task", "pr", "head", "answeredAt"]);
			assert.deepEqual([answers[i]!.task, answers[i]!.pr, answers[i]!.head], [ref, 77, HEAD]);
			assert.ok(!queue(f).json.items.some((item: { task: string }) => item.task === ref), `${ref} left the queue`);
		}
		// A task with no open ask records no answer.
		withStore(f, (db) => addRow(db, "OPS-6", { status: "escalated" }));
		assert.equal(cli(f, "task", "reopen", "OPS-6", "--reason", "fixed the cause").status, 0);
		assert.equal(ownerEvents(f, "owner_answer").length, statuses.length);
	} finally {
		f.close();
	}
});

test("AC:OPS-131-7 splitWait splits a wait into minutes inside and outside ownerHours", () => {
	const hours = { start: "09:00", end: "17:00" },
		zone = "America/New_York";
	const at = (iso: string) => new Date(iso);
	// Crosses the start boundary: 08:00 to 10:30 Eastern on a normal day (UTC-5 in December).
	assert.deepEqual(splitWait(at("2026-12-02T13:00:00Z"), at("2026-12-02T15:30:00Z"), hours, zone), {
		inside: 90,
		outside: 60,
	});
	// Crosses the end boundary and the next day's start: 16:00 to 10:00 the next morning.
	assert.deepEqual(splitWait(at("2026-12-02T21:00:00Z"), at("2026-12-03T15:00:00Z"), hours, zone), {
		inside: 120,
		outside: 960,
	});
	// More than one day: 12:00 on day one to 12:00 on day three holds two full 8-hour windows.
	assert.deepEqual(splitWait(at("2026-12-02T17:00:00Z"), at("2026-12-04T17:00:00Z"), hours, zone), {
		inside: 16 * HOUR,
		outside: 32 * HOUR,
	});
	// Fully outside: 18:00 to 08:00 the next morning.
	assert.deepEqual(splitWait(at("2026-12-02T23:00:00Z"), at("2026-12-03T13:00:00Z"), hours, zone), {
		inside: 0,
		outside: 14 * HOUR,
	});
	// Clocks go back on 2026-11-01: midnight to midnight Eastern lasts 25 hours, and the window keeps 8.
	assert.deepEqual(splitWait(at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z"), hours, zone), {
		inside: 8 * HOUR,
		outside: 17 * HOUR,
	});
	// Clocks go forward on 2026-03-08: midnight to midnight lasts 23 hours.
	assert.deepEqual(splitWait(at("2026-03-08T05:00:00Z"), at("2026-03-09T04:00:00Z"), hours, zone), {
		inside: 8 * HOUR,
		outside: 15 * HOUR,
	});
	// A window that holds the change counts real time: 01:00 to 03:30 that morning is 1.5 h, not 2.5 h.
	assert.deepEqual(
		splitWait(at("2026-03-08T05:00:00Z"), at("2026-03-09T04:00:00Z"), { start: "01:00", end: "03:30" }, zone),
		{ inside: 90, outside: 21 * HOUR + 30 },
	);
});

test("AC:OPS-131-8 ownerHours set shows the age split in both outputs; unset says so and shows none; invalid refuses and names the key", () => {
	const f = fixture();
	try {
		withStore(f, (db) => asked(db, addRow(db, "OPS-2", { pr: 2 }), "OPS-2", 3 * HOUR, { pr: 2 }));
		let q = queue(f);
		assert.match(q.text, /^ownerHours is not set, so ages show no inside or outside split\.$/m);
		assert.doesNotMatch(q.lines[1]!, /inside|outside/);
		assert.match(q.json.note, /ownerHours is not set/);
		assert.equal(q.json.ownerHours, null);
		assert.ok(!("insideMinutes" in q.json.items[0]));

		// The whole day is inside the hours or nearly so, in a zone with a known offset.
		config(f, { timeZone: "UTC", ownerHours: { start: "00:00", end: "23:59" } });
		q = queue(f);
		assert.doesNotMatch(q.text, /ownerHours is not set/);
		assert.ok(!("note" in q.json));
		const item = q.json.items[0];
		assert.equal(item.insideMinutes + item.outsideMinutes, item.ageMinutes);
		assert.ok(q.lines[1]!.includes(`(inside ${item.insideMinutes} min, outside ${item.outsideMinutes} min)`));

		for (const bad of [
			{ start: "9:00", end: "17:00" },
			{ start: "22:00", end: "06:00" },
			{ start: "09:00", end: "09:00" },
			"09:00-17:00",
			null,
		]) {
			config(f, { ownerHours: bad });
			for (const args of [["owner-queue"], ["owner-queue", "--json"]]) {
				const r = cli(f, ...args);
				assert.equal(r.status, 1);
				assert.match(r.stderr, /ownerQueue\.ownerHours/);
			}
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-131-9 ownerQueue.digestTimes sets the 3 digest times; the queue and digestId follow them, the default applies and a bad list refuses", () => {
	const q = parseOwnerQueue({ timeZone: "America/Chicago", digestTimes: ["08:15", "12:30", "20:45"] });
	// 2026-11-04 is UTC-6 in Chicago.
	const local = (time: string) => Date.parse(`2026-11-04T${time}:00-06:00`);
	assert.equal(nextDigest(local("07:00"), q), "2026-11-04T08:15");
	assert.equal(nextDigest(local("08:15"), q), "2026-11-04T08:15", "at the slot");
	assert.equal(nextDigest(local("08:16"), q), "2026-11-04T12:30");
	assert.equal(nextDigest(local("21:00"), q), "2026-11-05T08:15", "after the last slot");

	const absent = parseOwnerQueue(undefined);
	assert.deepEqual([absent.digestTimes, absent.ownerHours], [["09:00", "13:00", "17:00"], null]);
	assert.equal(absent.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
	assert.deepEqual(parseOwnerQueue({ timeZone: "UTC" }).digestTimes, ["09:00", "13:00", "17:00"]);

	const f = prFixture();
	try {
		// These slots are not the defaults, so a match proves the time comes from the config.
		config(f, { timeZone: "UTC", digestTimes: ["00:01", "00:02", "23:59"] });
		f.git("add", "evf.config.json");
		f.git("commit", "-qm", "Digest times");
		f.git("push", "-q", "origin", "main");
		const { json, text } = queue(f);
		assert.match(json.nextDigest, /T(00:01|00:02|23:59)$/);
		assert.ok(text.includes(`Next digest: ${json.nextDigest} (UTC).`));

		f.publish({ [TEMPLATE]: "export const t = 1;\n" });
		quietly(() => ship(f.root, f.task, fastShip));
		assert.match(ownerEvents(f)[0]!.digestId, /T(00:01|00:02|23:59)$/);

		for (const bad of [
			["09:00", "13:00"],
			["09:00", "13:00", "17:00", "20:00"],
			["13:00", "09:00", "17:00"],
			["09:00", "09:00", "17:00"],
			["9:00", "13:00", "17:00"],
			"09:00",
		]) {
			config(f, { digestTimes: bad });
			const r = cli(f, "owner-queue");
			assert.equal(r.status, 1);
			assert.match(r.stderr, /ownerQueue\.digestTimes/);
		}
	} finally {
		f.close();
	}
});

test("AC:OPS-131-10 the store migration gives each task that already waits one owner_ask, and a rerun adds nothing", () => {
	const f = fixture();
	try {
		const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
		const rerun = (db: DatabaseSync) => {
			db.prepare("DELETE FROM schema_version WHERE name = 'owner-queue'").run();
			migrate(db);
		};
		withStore(f, (db) => {
			const event = (id: number, type: string, ts: string, payload: object = {}) =>
				db
					.prepare("INSERT INTO events (task_id, ts, type, payload) VALUES (?, ?, ?, ?)")
					.run(id, ts, type, JSON.stringify(payload));
			const approval = (id: number, ts: string) =>
				db
					.prepare(
						"INSERT INTO approvals (task_id, gate, approver, head_sha, decision, quote, created_at) VALUES (?, 'owner', 'Sebastian', ?, 'approved', 'yes please', ?)",
					)
					.run(id, HEAD, ts);
			const escalated = addRow(db, "OPS-2", { status: "escalated", pr: 388 });
			event(escalated, "escalation", at(60));
			const pick = addRow(db, "OPS-3", { status: "awaiting_pick" });
			event(pick, "awaiting_pick", at(50));
			const held = addRow(db, "OPS-4", { pr: 4 });
			event(held, "owner_approval_wait", at(90));
			event(held, "owner_approval_wait", at(40), { summary: "waits" });
			const voided = addRow(db, "OPS-5", { pr: 5 });
			event(voided, "owner_approval_wait", at(30), { summary: "Sebastian's owner approval is void." });
			approval(voided, at(35));
			const fb = addRow(db, "FB-6", { pr: 6 });
			event(fb, "owner_approval_wait", at(20));
			// These do not wait: approved after the wait, merged, abandoned, or a plain open PR.
			const approved = addRow(db, "OPS-7", { pr: 7 });
			event(approved, "owner_approval_wait", at(10));
			approval(approved, at(5));
			event(addRow(db, "OPS-8", { status: "merged", pr: 8 }), "owner_approval_wait", at(10));
			event(addRow(db, "OPS-9", { status: "abandoned", pr: 9 }), "escalation", at(10));
			addRow(db, "OPS-10", { pr: 10 });
			rerun(db);
		});
		const asks = ownerEvents(f);
		assert.deepEqual(asks.map((a) => [a.task, a.pr, a.head, a.kind, a.digestId]).sort(), [
			["FB-6", 6, null, "feedback", null],
			["OPS-2", 388, null, "escalation", null],
			["OPS-3", null, null, "prototype_pick", null],
			["OPS-4", 4, null, "parked", null],
			["OPS-5", 5, null, "void_approval", null],
		]);
		for (const a of asks) assertAskShape(a);
		const age = (task: string) => (Date.now() - Date.parse(asks.find((a) => a.task === task)!.askedAt)) / 3_600_000;
		assert.ok(Math.abs(age("OPS-2") - 60) < 0.1, "askedAt is the time of the escalation");
		assert.ok(Math.abs(age("OPS-4") - 40) < 0.1, "askedAt is the time of the latest wait");

		const { json, lines } = queue(f);
		assert.equal(json.items.length, 5);
		assert.ok(
			lines.includes(
				`PR #388 | unknown | OPS-2 | Decide how PR #388 goes on, because it stopped and escalated. | age 60h 0m | blocks 1 | ${QUESTION}`,
			),
		);
		withStore(f, rerun);
		assert.equal(ownerEvents(f).length, 5, "a rerun adds nothing");
	} finally {
		f.close();
	}
});

test("AC:OPS-131-11 owner-queue ask adds a PR no route recorded and owner-queue answer records the answer; answer with no open item refuses and writes nothing", () => {
	const f = prFixture();
	try {
		const head = f.inWt("rev-parse", "HEAD");
		withStore(f, (db) => {
			const t = ensureTask(db, f.task, "implement");
			db.prepare("UPDATE tasks SET pr_number = 393, status = 'pr_open', worktree = ? WHERE id = ?").run(f.wt, t.id);
		});
		const ask = cli(f, "owner-queue", "ask", "OPS-1", "--kind", "parked");
		assert.equal(ask.status, 0, ask.stderr);
		const asks = ownerEvents(f);
		assert.equal(asks.length, 1);
		assertAskShape(asks[0]!);
		assert.deepEqual([asks[0]!.task, asks[0]!.pr, asks[0]!.head, asks[0]!.kind], ["OPS-1", 393, head, "parked"]);
		assert.match(queue(f).lines[1]!, new RegExp(`PR #393 \\| ${head.slice(0, 10)} \\| OPS-1 \\| `));

		assert.equal(cli(f, "owner-queue", "ask", "OPS-1", "--kind", "parked").status, 0);
		assert.equal(ownerEvents(f).length, 1, "a rerun on the same head adds no event");
		assert.match(cli(f, "owner-queue", "ask", "OPS-1", "--kind", "bogus").stderr, /--kind must be one of/);
		assert.match(cli(f, "owner-queue", "ask", "OPS-9", "--kind", "parked").stderr, /OPS-9 has no task row/);

		const answer = cli(f, "owner-queue", "answer", "OPS-1");
		assert.equal(answer.status, 0, answer.stderr);
		const answers = ownerEvents(f, "owner_answer");
		assert.equal(answers.length, 1);
		assert.deepEqual(Object.keys(answers[0]!), ["task", "pr", "head", "answeredAt"]);
		assert.deepEqual([answers[0]!.task, answers[0]!.pr, answers[0]!.head], ["OPS-1", 393, head]);
		assert.deepEqual(queue(f).json.items, []);

		const again = cli(f, "owner-queue", "answer", "OPS-1");
		assert.equal(again.status, 1);
		assert.match(again.stderr, /OPS-1 has no open owner ask/);
		assert.equal(ownerEvents(f, "owner_answer").length, 1, "the refusal wrote nothing");
	} finally {
		f.close();
	}
});

test("AC:OPS-131-12 evf owner-queue and --json send no message and leave the store byte-identical", () => {
	const f = fixture();
	try {
		const herdr = herdrStub(f.root);
		withStore(f, (db) => {
			asked(db, addRow(db, "OPS-2", { pr: 2 }), "OPS-2", 49 * HOUR, { pr: 2 });
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		});
		const files = () =>
			["", "-wal"].map((suffix) => {
				const path = `${workDbPath(f.root)}${suffix}`;
				// A read-only open may leave an empty -wal behind: it holds no bytes, so it counts as no file.
				return existsSync(path) && readFileSync(path).length ? readFileSync(path).toString("base64") : null;
			});
		const before = files();
		f.setState({ ...f.getState(), calls: [] });
		const { json } = queue(f);
		assert.equal(json.items.length, 1);
		assert.deepEqual(f.getState().calls, [], "no gh call");
		assert.deepEqual(herdr(), [], "no herdr call");
		assert.ok(
			files().every((file, i) => file === before[i]),
			"the store is byte-identical",
		);

		// A store older than the queue refuses instead of printing a false empty queue; it writes nothing.
		withStore(f, (db) => db.prepare("DELETE FROM schema_version WHERE name = 'owner-queue'").run());
		const old = cli(f, "owner-queue");
		assert.equal(old.status, 1);
		assert.match(old.stderr, /Run evf db migrate/);
		assert.equal(
			(() => {
				const db = new DatabaseSync(workDbPath(f.root), { readOnly: true });
				try {
					return db.prepare("SELECT COUNT(*) AS n FROM schema_version WHERE name = 'owner-queue'").get()!.n;
				} finally {
					db.close();
				}
			})(),
			0,
		);
	} finally {
		f.close();
	}
});

test("AC:OPS-131-13 the coordinator role states the digest routine and that evf sends no message", () => {
	const role = readFileSync(join(source, ".agents/roles/coordinator.md"), "utf8").replace(/\s+/g, " ");
	for (const line of [
		"Jonah runs `bin/evf owner-queue` and sends the digest at the fixed digest times",
		"sends an urgent item at once",
		"asks the keep, abandon or reopen question for an item older than 48 h",
		"evf sends no message",
	])
		assert.ok(role.includes(line), line);
});

/** Every gh call of a run, with commit ids, times and fixture paths made equal across fixtures. */
const githubCalls = (f: { getState: () => any }) =>
	JSON.stringify(f.getState().calls)
		.replace(/\b[0-9a-f]{40}\b/g, "<sha>")
		.replace(/\b[0-9a-f]{10}\b/g, "<short>")
		.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");

test("AC:OPS-131-14 with event writes forced to fail, evf ship and evf approve return the same exit code and make the same GitHub calls, and evf warns", () => {
	const flow = (failing: boolean) => {
		const f = prFixture();
		try {
			if (failing)
				withStore(f, (db) =>
					db.exec(
						"CREATE TRIGGER forced_failure BEFORE INSERT ON events WHEN NEW.type IN ('owner_ask', 'owner_answer') BEGIN SELECT RAISE(ABORT, 'forced write failure'); END",
					),
				);
			const head = f.publish({ [TEMPLATE]: "export const t = 1;\n" });
			const held = quietly(() => ship(f.root, f.task, fastShip));
			const heldCalls = githubCalls(f);
			f.setState({ ...f.getState(), allowMerge: true, calls: [] });
			const approved = quietly(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: WORDS })));
			return {
				held: held.value,
				approved: approved.value,
				heldOut: held.out.replaceAll(head, "<sha>").replaceAll(head.slice(0, 10), "<short>"),
				heldCalls,
				approveCalls: githubCalls(f),
				merged: f.getState().calls.filter((c: any) => c.args[1] === "merge").length,
				warnings: `${held.err}\n${approved.err}`,
				asks: ownerEvents(f).length,
				answers: ownerEvents(f, "owner_answer").length,
			};
		} finally {
			f.close();
		}
	};
	const working = flow(false),
		failing = flow(true);
	assert.deepEqual([working.asks, working.answers], [1, 1]);
	assert.deepEqual([failing.asks, failing.answers], [0, 0]);
	assert.deepEqual([failing.held, failing.approved], [working.held, working.approved]);
	assert.equal(failing.merged, 1);
	assert.equal(failing.heldOut, working.heldOut);
	assert.equal(failing.heldCalls, working.heldCalls);
	assert.equal(failing.approveCalls, working.approveCalls);
	assert.doesNotMatch(working.warnings, /warning: could not record/);
	assert.match(failing.warnings, /warning: could not record the owner ask of OPS-1: forced write failure/);

	// On this task's branch, the diff of ship.ts and approve.ts against main only adds recording calls.
	const git = (...args: string[]) => spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
	if (git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim() !== "task/ops-131") return;
	const base = git("merge-base", "HEAD", "main");
	if (base.status !== 0) return;
	const diff = git("diff", "--unified=0", base.stdout.trim(), "--", "tools/evf/ship.ts", "tools/evf/approve.ts");
	const changed = diff.stdout.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
	assert.ok(changed.length > 0);
	for (const line of changed) assert.match(line, /^\+.*(recordOwner|ownerHeld,|owner-queue\.ts)/, line);
});

test("AC:OPS-131-15 evf help lists owner-queue and its forms, and the README describes the events, the key and ownerHours", () => {
	const f = fixture();
	try {
		const help = cli(f, "help").stdout;
		for (const form of [
			"evf owner-queue [--json]",
			"evf owner-queue ask <task> --kind parked",
			"evf owner-queue answer <task>",
		])
			assert.ok(help.includes(form), form);
	} finally {
		f.close();
	}
	const readme = readFileSync(join(source, "tools/evf/README.md"), "utf8");
	for (const word of ["## Owner queue", "owner_ask", "owner_answer", "`ownerQueue`", "ownerHours", "digestTimes"])
		assert.ok(readme.includes(word), word);
	assert.match(readme, /Sebastian sets `ownerHours`/);
});
