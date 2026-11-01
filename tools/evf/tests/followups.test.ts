import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import {
	findTask,
	followUpsOfTask,
	markMerged,
	migrate,
	newTaskRow,
	openWorkDb,
	requireStartable,
	schemaVersion,
	status,
	withPartial,
} from "../db.ts";
import { driveOnce, next, nextStage, runDone, taskAbandon, taskLink, taskNew, taskSpec } from "../drive.ts";
import { unfiledSlices } from "../followups.ts";
import { laterSlices } from "../spec.ts";
import { checkPrBody } from "../pr-body.ts";
import { approvalBlock, parseAskCoverage } from "../ask-coverage.ts";
import { parseTask } from "../lib.ts";
import { taskStart } from "../task.ts";
import { DatabaseSync } from "node:sqlite";

const specWith = (slices: string[]) =>
	`## Goal\n\nBuild the first slice.\n\n## Done criteria\n\n1. One.\n2. Two.\n\n## Non-goals\n\n- None.\n` +
	(slices.length ? `\n## Later slices\n\n${slices.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n` : "");

/** Store `spec` for `ref` through the real command and return the lines it printed. */
function storeSpec(root: string, ref: string, spec: string): string[] {
	const file = join(root, "spec.md");
	writeFileSync(file, spec);
	const lines: string[] = [];
	const log = console.log;
	console.log = (...a: unknown[]) => void lines.push(a.join(" "));
	try {
		taskSpec(root, parseTask(ref), file);
	} finally {
		console.log = log;
	}
	return lines;
}

function newTask(root: string, ref: string, ask: string): void {
	const file = join(root, "ask.md");
	writeFileSync(file, ask);
	const log = console.log;
	console.log = () => {};
	try {
		taskNew(root, parseTask(ref), { askFile: file });
	} finally {
		console.log = log;
	}
}

const rows = (root: string, where = "1 = 1") => {
	const db = openWorkDb(root);
	try {
		return db
			.prepare(`SELECT id, ref, status, title, ask, parent_task_id FROM tasks WHERE ${where} ORDER BY id`)
			.all() as Array<{
			id: number;
			ref: string;
			status: string;
			title: string;
			ask: string;
			parent_task_id: number | null;
		}>;
	} finally {
		db.close();
	}
};
const count = (root: string, type: string) => {
	const db = openWorkDb(root);
	try {
		return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(type) as { n: number }).n;
	} finally {
		db.close();
	}
};

test("OPS-86-spec: laterSlices lists the items of a heading or a label, joined, and is empty without a section", () => {
	assert.deepEqual(
		laterSlices(
			specWith(["Slice B: lists.\n   Depends on this slice.", "Slice C: forms."]).replace("2. Slice C", "- Slice C"),
		),
		["Slice B: lists. Depends on this slice.", "Slice C: forms."],
	);
	assert.deepEqual(laterSlices(`${specWith([])}\nLater slices:\n- Slice B.\n- Slice C.\n`), ["Slice B.", "Slice C."]);
	assert.deepEqual(laterSlices(specWith([])), []);
	assert.deepEqual(laterSlices(null), []);
});

test("OPS-86-store: a store migrated from schema 4 gains queued and parent_task_id and keeps its rows", () => {
	const f = fixture();
	try {
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		const files = ["001-init", "002-prototype-statuses", "003-usage-columns", "004-task-seat-override"];
		db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
		files.forEach((name, i) => {
			db.exec(readFileSync(join(source, `tools/evf/db/migrations/${name}.sql`), "utf8"));
			db.prepare("INSERT INTO schema_version VALUES (?, ?, 'x')").run(i + 1, name.slice(4));
		});
		db.exec(
			"INSERT INTO tasks (slug, mode, ref, title, status, seat_model, created_at, updated_at) VALUES ('ops-1', 'implement', 'OPS-1', 'One', 'active', 'm', 't', 't')",
		);
		assert.equal(schemaVersion(db), 4);
		assert.deepEqual(migrate(db).applied, [
			"005-merged-views.sql",
			"006-task-follow-ups.sql",
			"007-follow-up-links.sql",
		]);
		const row = db.prepare("SELECT * FROM v_tasks WHERE ref = 'OPS-1'").get() as Record<string, unknown>;
		assert.equal(row.status, "active");
		assert.equal(row.seat_model, "m");
		assert.equal(row.parent_task_id, null);
		db.exec(
			"INSERT INTO tasks (slug, mode, ref, status, parent_task_id, created_at, updated_at) VALUES ('ops-2', 'implement', 'OPS-2', 'queued', 1, 't', 't')",
		);
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-86-file: storing a spec files queued rows linked to the parent, a WP parent stays visible, and a repeat files nothing", () => {
	const f = fixture();
	try {
		newTask(f.root, "WP-097", "Port the marketing page: home and /oversight.");
		const lines = storeSpec(f.root, "WP-097", specWith(["Slice two: /oversight.", "Slice three: footer."]));
		assert.deepEqual(
			lines.filter((l) => l.startsWith("follow-up:")),
			[
				"follow-up: WP-097 slice 2 queued Slice two: /oversight.",
				"follow-up: WP-097 slice 3 queued Slice three: footer.",
			],
		);
		const [parent, two, three] = rows(f.root);
		assert.deepEqual(
			[two!.status, three!.status, two!.parent_task_id, three!.ref],
			["queued", "queued", parent!.id, "WP-097"],
		);
		assert.equal(
			two!.ask,
			"Slice two: /oversight.\n\nParent task WP-097, verbatim ask:\nPort the marketing page: home and /oversight.",
		);
		const db = openWorkDb(f.root);
		assert.equal(findTask(db, parseTask("WP-097"))!.id, parent!.id);
		db.close();

		// The same spec again: same rows, no new events.
		const filed = count(f.root, "follow_up_filed");
		storeSpec(f.root, "WP-097", specWith(["Slice two: /oversight.", "Slice three: footer."]));
		assert.equal(rows(f.root).length, 3);
		assert.equal(count(f.root, "follow_up_filed"), filed);

		// A changed slice updates its queued row; a removed slice abandons its queued row.
		storeSpec(f.root, "WP-097", specWith(["Slice two: /oversight, all sections."]));
		const after = rows(f.root);
		assert.match(after[1]!.ask, /^Slice two: \/oversight, all sections\./);
		assert.equal(after[1]!.status, "queued");
		assert.equal(after[2]!.status, "abandoned");
	} finally {
		f.close();
	}
});

test("OPS-86-merge: a merged parent releases the next queued slice with one event; the slice after it stays queued", () => {
	const f = fixture();
	try {
		newTask(f.root, "WP-097", "Ask.");
		storeSpec(f.root, "WP-097", specWith(["Two.", "Three."]));
		const db = openWorkDb(f.root);
		const task = parseTask("WP-097");
		markMerged(db, task, "a".repeat(40), null);
		markMerged(db, task, "a".repeat(40), null);
		let [, two, three] = rows(f.root);
		assert.deepEqual([two!.status, three!.status], ["new", "queued"]);
		assert.equal(count(f.root, "follow_up_released"), 1);
		// The released slice is now the ref's current row; its merge releases the third.
		assert.equal(findTask(db, task)!.id, two!.id);
		markMerged(db, task, "b".repeat(40), null);
		[, two, three] = rows(f.root);
		assert.deepEqual([two!.status, three!.status], ["merged", "new"]);
		db.close();
	} finally {
		f.close();
	}
});

test("OPS-86-gate: a spec with unfiled slices cannot pass plan or start implement; storing it again lifts the gate", () => {
	const f = fixture();
	try {
		const task = parseTask("WP-097");
		newTask(f.root, "WP-097", "Ask.");
		const db = openWorkDb(f.root);
		const row = findTask(db, task)!;
		// A spec stored before this change: slices in the text, no rows.
		db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(specWith(["Two: /oversight."]), row.id);
		const stage = db
			.prepare(
				"INSERT INTO runs (task_id, stage, role, status, started_at) VALUES (?, 'plan', 'planner', 'started', 't')",
			)
			.run(row.id).lastInsertRowid;
		const unfiled = unfiledSlices(db, row.id, specWith(["Two: /oversight."]));
		assert.deepEqual(unfiled, ["Two: /oversight."]);
		db.close();

		assert.throws(
			() => runDone(f.root, Number(stage), { status: "passed", summary: "planned" }),
			/no follow-up.*Two: \/oversight\..*bin\/evf task spec WP-097/s,
		);
		const passed = [{ id: 1, stage: "plan", role: "planner", status: "passed", round: 0, summary: null }];
		const blocked = nextStage(task, { ...row, spec: specWith(["Two: /oversight."]) }, passed, false, 0, { unfiled });
		assert.equal(blocked.stage, "blocked");
		assert.match(blocked.reason, /bin\/evf task spec WP-097/);
		// A plan that passed before this change: the drive does not start implement.
		const legacy = openWorkDb(f.root);
		legacy.prepare("UPDATE runs SET status = 'passed', ended_at = 't', summary = 'planned' WHERE id = ?").run(stage);
		legacy.close();
		const driven = driveOnce(f.root, task);
		assert.equal(driven.stage, "blocked");
		assert.match(driven.reason, /no follow-up/);

		storeSpec(f.root, "WP-097", specWith(["Two: /oversight."]));
		const again = openWorkDb(f.root);
		const filedNow = unfiledSlices(again, row.id, specWith(["Two: /oversight."]));
		assert.deepEqual(filedNow, []);
		assert.equal(
			nextStage(task, { ...row, spec: specWith(["Two: /oversight."]) }, passed, false, 0, { unfiled: filedNow }).stage,
			"implement",
		);
		// With the rows filed, a plan run closes passed.
		const second = again
			.prepare(
				"INSERT INTO runs (task_id, stage, role, status, started_at) VALUES (?, 'plan', 'planner', 'started', 'u')",
			)
			.run(row.id).lastInsertRowid;
		again.close();
		runDone(f.root, Number(second), { status: "passed", summary: "planned" });
	} finally {
		f.close();
	}
});

test("OPS-86-plain: a spec without Later slices files nothing and is not gated", () => {
	const f = fixture();
	try {
		newTask(f.root, "WP-097", "Ask.");
		const lines = storeSpec(f.root, "WP-097", specWith([]));
		assert.ok(!lines.some((l) => l.startsWith("follow-up:")));
		assert.equal(rows(f.root).length, 1);
		const db = openWorkDb(f.root);
		const row = findTask(db, parseTask("WP-097"))!;
		assert.deepEqual(unfiledSlices(db, row.id, row.spec), []);
		assert.equal(nextStage(parseTask("WP-097"), row, [], false, 0, { unfiled: [] }).stage, "implement");
		db.close();
	} finally {
		f.close();
	}
});

function withRemote() {
	const f = fixture();
	const check = [{ name: "check", run: [process.execPath, "-e", ""] }];
	f.cfg.maintenanceTasks = {
		"OPS-7": { title: "Seven", owningPaths: ["tools/evf/"], checks: check },
		"OPS-12": { title: "Twelve", owningPaths: ["tools/evf/"], checks: check },
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	mkdirSync(join(f.root, "docs/architecture"), { recursive: true });
	writeFileSync(join(f.root, "docs/architecture/decisions.md"), "# Architecture decisions\n");
	f.git("add", "docs/architecture/decisions.md");
	f.commit();
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	const remoteRef = (ref: string) =>
		spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref]).status === 0;
	return { ...f, remote, remoteRef };
}

test("OPS-86-ops: OPS slices get distinct reserved ids; a failed reservation stores nothing; queued rows cannot start", () => {
	const f = withRemote();
	try {
		newTask(f.root, "OPS-5", "The ask of OPS-5.");
		const lines = storeSpec(f.root, "OPS-5", specWith(["First.", "Second."]));
		assert.deepEqual(
			lines.filter((l) => l.startsWith("follow-up:")),
			["follow-up: OPS-13 queued First.", "follow-up: OPS-14 queued Second."],
		);
		assert.ok(f.remoteRef("refs/evf/ids/OPS-13") && f.remoteRef("refs/evf/ids/OPS-14"));
		assert.deepEqual(
			rows(f.root, "status = 'queued'").map((r) => r.ref),
			["OPS-13", "OPS-14"],
		);

		// A repeat reserves nothing.
		storeSpec(f.root, "OPS-5", specWith(["First.", "Second."]));
		assert.ok(!f.remoteRef("refs/evf/ids/OPS-15"));

		// A queued OPS row is the ref's only row, so it is found, and nothing starts it.
		assert.throws(
			() => requireStartable(f.root, parseTask("OPS-13"), "implementer"),
			/OPS-13 is queued.*waits for OPS-5/,
		);
		assert.throws(
			() => taskStart(f.root, parseTask("OPS-13"), { allowUnready: false, noStack: true }),
			/OPS-13 is queued/,
		);
		const db = openWorkDb(f.root);
		const queued = findTask(db, parseTask("OPS-14"))!;
		assert.equal(nextStage(parseTask("OPS-14"), queued, [], false, 0, { waitsFor: "OPS-13" }).stage, "blocked");
		db.close();
		assert.equal(driveOnce(f.root, parseTask("OPS-13")).stage, "blocked");

		// A reservation that fails leaves the old spec and no new row.
		newTask(f.root, "OPS-6", "Ask six.");
		f.git("remote", "set-url", "origin", join(f.root, "no-such-remote"));
		assert.throws(() => storeSpec(f.root, "OPS-6", specWith(["Only."])), /ID reservations|reserve/i);
		assert.equal(rows(f.root, "ref = 'OPS-6'")[0]!.status, "new");
		assert.equal(rows(f.root, "ref = 'OPS-6'")[0]!.id, rows(f.root, "ref = 'OPS-6'").at(-1)!.id);
		assert.equal(rows(f.root, "status = 'queued'").length, 2);
	} finally {
		f.close();
	}
});

const AUTHOR = { session: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet-5-5", role: "implementer" };
function prBody(summary: string) {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	const headings = template.split("\n").filter((l) => l.startsWith("## "));
	return (
		headings.map((h) => `${h}\n${h === "## Summary" ? summary : "Concrete task evidence."}`).join("\n\n") +
		`\n\nEVF-Author: ${JSON.stringify(AUTHOR)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`
	);
}

test("OPS-86-body: an ordinary body for a task with follow-ups needs a Partial: first line naming every label", () => {
	const f = fixture();
	try {
		const followUps = [
			{ label: "OPS-13", status: "queued", title: "First" },
			{ label: "WP-097 slice 2", status: "queued", title: "Second" },
		];
		const check = (summary: string, fu = followUps) => checkPrBody(f.root, prBody(summary), "ordinary", fu);
		assert.throws(() => check("Ported home."), /follow-ups \(OPS-13, WP-097 slice 2\).*Partial:/s);
		assert.throws(() => check("Ported home.\nPartial: later."), /Partial:/);
		assert.throws(() => check("Partial: only OPS-13 is named."), /missing WP-097 slice 2/);
		assert.equal(check("Partial: deferred OPS-13 and WP-097 slice 2.\nMore text.").kind, "ordinary");
		// Without follow-ups, today's rules hold.
		assert.equal(check("Ported home.", []).kind, "ordinary");
	} finally {
		f.close();
	}
});

test("OPS-86-coverage: the Ask coverage table parses, and approval needs no missing row and filed deferrals", () => {
	const table = (rows: string) =>
		`## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n${rows}\n\n## Criteria\n\n| n | status |\n| - | - |\n| 1 | met |\n`;
	const ok = parseAskCoverage(table("| home route | delivered |\n| /oversight | deferred OPS-13 |"));
	assert.deepEqual("rows" in ok && ok.rows, [
		{ deliverable: "home route", status: "delivered" },
		{ deliverable: "/oversight", status: "deferred", label: "OPS-13" },
	]);
	assert.equal(approvalBlock("rows" in ok ? ok.rows : [], ["OPS-13"]), null);
	assert.match(approvalBlock("rows" in ok ? ok.rows : [], ["OPS-99"])!, /OPS-13/);
	const missing = parseAskCoverage(table("| /oversight | missing |"));
	assert.match(approvalBlock("rows" in missing ? missing.rows : [], [])!, /missing deliverables.*\/oversight/);
	assert.match(
		("error" in parseAskCoverage("## Code quality\nx") &&
			(parseAskCoverage("## Code quality\nx") as { error: string }).error) ||
			"",
		/Ask coverage/,
	);
	const late = parseAskCoverage(`| a | b |\n| - | - |\n| 1 | met |\n\n${table("| x | delivered |")}`);
	assert.match(("error" in late && late.error) || "", /before the first criterion or check table/);
	assert.match(
		("error" in parseAskCoverage(table("| x | maybe |")) &&
			(parseAskCoverage(table("| x | maybe |")) as { error: string }).error) ||
			"",
		/maybe/,
	);
});

test("OPS-86-poster: post-review.mjs refuses a report without coverage, a missing row and an unfiled deferral", () => {
	const f = fixture();
	try {
		// A copy of the poster and the evf code it imports, so it reads this fixture's store, not the real one.
		cpSync(join(source, "tools/evf"), join(f.root, "tools/evf"), { recursive: true });
		mkdirSync(join(f.root, ".agents/skills/verify-preview"), { recursive: true });
		cpSync(
			join(source, ".agents/skills/verify-preview/scripts"),
			join(f.root, ".agents/skills/verify-preview/scripts"),
			{
				recursive: true,
			},
		);
		newTask(f.root, "WP-097", "Ask.");
		storeSpec(f.root, "WP-097", specWith(["Two."]));
		const head = "c".repeat(40);
		const view = {
			headRefOid: head,
			headRefName: "task/wp-097",
			url: "https://github.com/test/private/pull/9",
			body: prBody("Partial: deferred Two. (WP-097 slice 2)"),
		};
		writeFileSync(
			join(f.root, "fake-bin/gh"),
			`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(view))});\n`,
		);
		const rest = "## Code quality\nApproved.\n\n## Experience\nNot applicable.\n";
		const post = (report: string) => {
			const file = join(f.root, "report.md");
			writeFileSync(file, report);
			const r = spawnSync(
				process.execPath,
				[
					join(f.root, ".agents/skills/verify-preview/scripts/post-review.mjs"),
					...["--pr", "9", "--report", file, "--head", head, "--verdict", "approved"],
					...["--session", "22222222-2222-4222-8222-222222222222", "--model", "claude-opus-5-5"],
					...["--experience-verdict", "approved", "--budget", "met", "--quality-verdict", "approved"],
					...[
						"--principles",
						"laziness-protocol,minimize-reader-load,subtract-before-you-add,test-behavior-not-implementation",
					],
					"--dry-run",
				],
				{ cwd: f.root, encoding: "utf8" },
			);
			return { code: r.status, out: r.stdout + r.stderr };
		};
		const cov = (rows: string) => `## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n${rows}\n\n${rest}`;
		assert.match(post(rest).out, /Ask coverage section/);
		assert.match(post(cov("| /oversight | missing |")).out, /missing deliverables.*\/oversight/);
		assert.match(post(cov("| /oversight | deferred OPS-99 |")).out, /not follow-ups of this task/);
		const good = post(cov("| home | delivered |\n| /oversight | deferred WP-097 slice 2 |"));
		assert.equal(good.code, 0, good.out);
	} finally {
		f.close();
	}
});

test("OPS-86-owner: owner-review text and evf status start with a Partial: line only for a task with follow-ups", () => {
	const f = fixture();
	try {
		newTask(f.root, "WP-097", "Ask.");
		newTask(f.root, "WP-098", "Other ask.");
		storeSpec(f.root, "WP-097", specWith(["Two: /oversight."]));
		storeSpec(f.root, "WP-098", specWith([]));
		const wait = "PR #9 is verified and waits for Sebastian's chat approval, then evf approve.";
		assert.equal(
			withPartial(f.root, parseTask("WP-097"), wait),
			`Partial: this PR covers only part of the ask. Deferred: Two: /oversight. (WP-097 slice 2).\n${wait}`,
		);
		assert.equal(withPartial(f.root, parseTask("WP-098"), wait), wait);

		const lines: string[] = [];
		const log = console.log;
		console.log = (...a: unknown[]) => void lines.push(a.join(" "));
		try {
			status(f.root, { json: true, task: "WP-097" });
			status(f.root, { json: true, task: "WP-098" });
			status(f.root, { json: false, task: "WP-097" });
		} finally {
			console.log = log;
		}
		const sliced = JSON.parse(lines[0]!).tasks.find((t: { status: string }) => t.status !== "queued");
		assert.deepEqual(sliced.followUps, ["WP-097 slice 2"]);
		assert.match(sliced.partial, /^Partial: /);
		assert.ok(
			!("followUps" in JSON.parse(lines[1]!).tasks[0]),
			"a task without follow-ups prints what it printed before",
		);
		assert.ok(lines.slice(2).some((l) => l.startsWith("WP-097: Partial: ")));
	} finally {
		f.close();
	}
});

// OPS-109: evf task link records an existing row as a follow-up, or as the row of one later slice.

/** Run a command and return what it printed. */
function printed(fn: () => unknown): string[] {
	const lines: string[] = [];
	const log = console.log;
	console.log = (...a: unknown[]) => void lines.push(a.join(" "));
	try {
		fn();
	} finally {
		console.log = log;
	}
	return lines;
}
const link = (
	root: string,
	ref: string,
	followUp: string,
	opts: { id?: number; slice?: number; remove?: boolean } = {},
) => printed(() => taskLink(root, parseTask(ref), { followUp: parseTask(followUp), remove: false, ...opts }));
const linkCols = (root: string, ref: string) => {
	const db = openWorkDb(root);
	try {
		return db
			.prepare("SELECT id, status, parent_task_id, slice, linked FROM tasks WHERE ref = ? ORDER BY id")
			.all(ref)
			.map((r) => ({ ...r }));
	} finally {
		db.close();
	}
};

test("OPS-109-link: an existing WP and OPS row become follow-ups with no new id, keep their status, and repeat as no change", () => {
	const f = withRemote();
	try {
		newTask(f.root, "OPS-7", "Fix the wiki article.");
		newTask(f.root, "WP-033", "Build the documents page.");
		newTask(f.root, "OPS-12", "Tooling follow-up.");
		const parent = rows(f.root, "ref = 'OPS-7'")[0]!;
		assert.deepEqual(link(f.root, "OPS-7", "WP-033"), [
			`link: OPS-7: linked WP-033 (store row ${rows(f.root, "ref = 'WP-033'")[0]!.id}) as a follow-up.`,
		]);
		link(f.root, "OPS-7", "OPS-12");
		assert.deepEqual(
			linkCols(f.root, "WP-033").map((r) => [r.status, r.parent_task_id, r.slice, r.linked]),
			[["new", parent.id, null, 1]],
		);
		assert.equal(count(f.root, "follow_up_linked"), 2);
		assert.ok(!f.remoteRef("refs/evf/ids/OPS-13"), "no id is reserved");
		// A repeat changes nothing and writes no event.
		assert.deepEqual(link(f.root, "OPS-7", "WP-033"), [
			`link: no change; store row ${rows(f.root, "ref = 'WP-033'")[0]!.id} already is that follow-up.`,
		]);
		assert.equal(count(f.root, "follow_up_linked"), 2);
		// followUpsOf names both, so the Partial: line, the PR body check and evf status include them.
		assert.deepEqual(
			followUpsOfTask(f.root, parseTask("OPS-7")).map((x) => x.label),
			["WP-033", "OPS-12"],
		);
		assert.equal(
			withPartial(f.root, parseTask("OPS-7"), "waits"),
			"Partial: this PR covers only part of the ask. Deferred: WP-033 (WP-033); OPS-12 (OPS-12).\nwaits",
		);
		const fu = followUpsOfTask(f.root, parseTask("OPS-7"));
		assert.throws(() => checkPrBody(f.root, prBody("Fixed the article."), "ordinary", fu), /Partial:/);
		assert.equal(checkPrBody(f.root, prBody("Partial: deferred WP-033 and OPS-12."), "ordinary", fu).kind, "ordinary");
		const json = JSON.parse(printed(() => status(f.root, { json: true, task: "OPS-7" }))[0]!);
		assert.deepEqual(json.tasks[0].followUps, ["WP-033", "OPS-12"]);
		// The verifier's Ask coverage defers to the linked labels and passes.
		const report = parseAskCoverage(
			"## Ask coverage\n\n| Deliverable | Status |\n| --- | --- |\n| article fix | delivered |\n| documents page | deferred WP-033 |\n| tooling | deferred OPS-12 |\n",
		);
		assert.ok("rows" in report);
		assert.equal(
			approvalBlock(
				report.rows,
				fu.map((x) => x.label),
			),
			null,
		);
		// --remove undoes the link; a second remove is no change.
		assert.match(link(f.root, "OPS-7", "OPS-12", { remove: true })[0]!, /^link: OPS-7: unlinked OPS-12/);
		assert.deepEqual(
			linkCols(f.root, "OPS-12").map((r) => [r.parent_task_id, r.slice, r.linked]),
			[[null, null, 0]],
		);
		assert.match(link(f.root, "OPS-7", "OPS-12", { remove: true })[0]!, /no change; store row \d+ is no follow-up/);
		assert.equal(count(f.root, "follow_up_unlinked"), 1);
		assert.deepEqual(
			followUpsOfTask(f.root, parseTask("OPS-7")).map((x) => x.label),
			["WP-033"],
		);
	} finally {
		f.close();
	}
});

test("OPS-109-link: refuses a self link, a cycle, a second parent, an abandoned or merged row, and asks for --id", () => {
	const f = withRemote();
	try {
		for (const ref of ["OPS-7", "OPS-12", "WP-033", "WP-034", "WP-035"]) newTask(f.root, ref, `Ask of ${ref}.`);
		link(f.root, "OPS-7", "OPS-12");
		const before = count(f.root, "follow_up_linked");
		assert.throws(() => link(f.root, "OPS-7", "OPS-7"), /OPS-7 cannot be a follow-up of itself/);
		assert.throws(
			() => link(f.root, "OPS-12", "OPS-7"),
			/OPS-12 is already a follow-up of OPS-7; the link would make a cycle/,
		);
		link(f.root, "OPS-12", "WP-033");
		assert.throws(() => link(f.root, "OPS-7", "WP-033"), /is already a follow-up of OPS-12/);
		const seat = process.env.EVF_RUN;
		delete process.env.EVF_RUN; // A human shell abandons rows.
		try {
			printed(() => taskAbandon(f.root, parseTask("WP-034"), { reason: "stale fixture row" }));
		} finally {
			if (seat !== undefined) process.env.EVF_RUN = seat;
		}
		const abandoned = rows(f.root, "ref = 'WP-034'")[0]!.id;
		assert.throws(() => link(f.root, "OPS-7", "WP-034"), /WP-034 has no open task row/);
		assert.throws(() => link(f.root, "OPS-7", "WP-034", { id: abandoned }), /is abandoned; link an open row/);
		const db = openWorkDb(f.root);
		markMerged(db, parseTask("WP-035"), "d".repeat(40), null);
		newTaskRow(db, parseTask("OPS-12"), "implement");
		db.close();
		assert.throws(() => link(f.root, "OPS-7", "WP-035"), /is merged; link an open row/);
		// OPS-12 now has two open rows: --id picks one.
		const [first, second] = rows(f.root, "ref = 'OPS-12'");
		assert.throws(
			() => link(f.root, "OPS-7", "OPS-12", { remove: true }),
			new RegExp(`OPS-12 has rows ${first!.id} \\(new\\), ${second!.id} \\(new\\): pick one with --id`),
		);
		assert.throws(() => link(f.root, "OPS-7", "OPS-12", { id: 999 }), /Store row 999 is not a row of OPS-12/);
		assert.equal(count(f.root, "follow_up_linked"), before + 1, "only the WP-033 link under OPS-12 was written");
		assert.match(link(f.root, "OPS-7", "OPS-12", { id: second!.id })[0]!, /linked OPS-12 \(store row \d+\)/);
	} finally {
		f.close();
	}
});

test("OPS-109-slice: a row linked to slice 1 fills it, a new spec reserves one id for slice 2, and next is no longer blocked", () => {
	const f = withRemote();
	try {
		const task = parseTask("OPS-5"),
			spec = specWith(["Docs page.", "Footer."]);
		newTask(f.root, "OPS-5", "The ask of OPS-5.");
		newTask(f.root, "OPS-12", "Docs page, already filed.");
		// The blocked state of a spec stored before its slices had rows (OPS-107 today), and a passed plan.
		const db = openWorkDb(f.root);
		const row = findTask(db, task)!;
		db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(spec, row.id);
		db.prepare(
			"INSERT INTO runs (task_id, stage, role, status, started_at, ended_at) VALUES (?, 'plan', 'planner', 'passed', 't', 't')",
		).run(row.id);
		db.close();
		const nextOf = () => JSON.parse(printed(() => next(f.root, task))[0]!);
		assert.equal(nextOf().stage, "blocked");
		assert.throws(() => requireStartable(f.root, task, "implementer"), /2 later slices with no follow-up/);

		// A plain link never fills a slice.
		link(f.root, "OPS-5", "OPS-12");
		assert.match(nextOf().reason, /2 later slices with no follow-up/);
		assert.throws(() => link(f.root, "OPS-5", "OPS-12", { slice: 3 }), /has 2 later slices, so there is no slice 3/);
		assert.match(link(f.root, "OPS-5", "OPS-12", { slice: 1 })[0]!, /as a follow-up for later slice 1\.$/);
		assert.match(nextOf().reason, /1 later slice with no follow-up: "Footer\."/);

		// Storing the spec again files only slice 2: exactly one new OPS id.
		const lines = storeSpec(f.root, "OPS-5", spec);
		assert.deepEqual(
			lines.filter((l) => l.startsWith("follow-up:")),
			["follow-up: OPS-12 new OPS-12", "follow-up: OPS-13 queued Footer."],
		);
		assert.ok(f.remoteRef("refs/evf/ids/OPS-13") && !f.remoteRef("refs/evf/ids/OPS-14"));
		assert.equal(nextOf().stage, "implement");
		requireStartable(f.root, task, "implementer");
		assert.deepEqual(
			followUpsOfTask(f.root, task).map((x) => x.label),
			["OPS-12", "OPS-13"],
		);
		// A new spec without slices abandons the filed slice 2 and never edits or abandons the linked row.
		storeSpec(f.root, "OPS-5", specWith([]));
		assert.deepEqual(
			linkCols(f.root, "OPS-12").map((r) => [r.status, r.slice, r.linked]),
			[["new", 1, 1]],
		);
		assert.equal(rows(f.root, "ref = 'OPS-13'")[0]!.status, "abandoned");
		assert.ok(!f.remoteRef("refs/evf/ids/OPS-14"));
		// A slice that a linked row covers refuses another row.
		storeSpec(f.root, "OPS-5", spec);
		newTask(f.root, "OPS-7", "Seven.");
		assert.throws(
			() => link(f.root, "OPS-5", "OPS-7", { slice: 1 }),
			/Slice 1 of OPS-5 already has a follow-up: OPS-12/,
		);
	} finally {
		f.close();
	}
});

test("OPS-109-store: migration 7 numbers the filed slices, and a store that applied another migration 7 stops", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	const dir = join(source, "tools/evf/db/migrations");
	[
		"001-init",
		"002-prototype-statuses",
		"003-usage-columns",
		"004-task-seat-override",
		"005-merged-views",
		"006-task-follow-ups",
	].forEach((file, i) => {
		db.exec(readFileSync(join(dir, `${file}.sql`), "utf8"));
		db.prepare("INSERT INTO schema_version VALUES (?, ?, 'x')").run(i + 1, file.slice(4));
	});
	const insert = db.prepare(
		"INSERT INTO tasks (slug, mode, ref, status, parent_task_id, created_at, updated_at) VALUES ('s', 'implement', ?, ?, ?, 't', 't')",
	);
	insert.run("WP-097", "active", null);
	for (const status of ["queued", "abandoned", "queued", "new"]) insert.run("WP-097", status, 1);
	assert.deepEqual(migrate(db).applied, ["007-follow-up-links.sql"]);
	assert.deepEqual(
		db
			.prepare("SELECT id, status, slice, linked FROM tasks ORDER BY id")
			.all()
			.map((r) => ({ ...r })),
		[
			{ id: 1, status: "active", slice: null, linked: 0 },
			{ id: 2, status: "queued", slice: 1, linked: 0 },
			{ id: 3, status: "abandoned", slice: null, linked: 0 },
			{ id: 4, status: "queued", slice: 2, linked: 0 },
			{ id: 5, status: "new", slice: 3, linked: 0 },
		],
	);
	db.close();

	const other = new DatabaseSync(":memory:");
	other.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
	other.prepare("INSERT INTO schema_version VALUES (7, 'qa-previews', 'x')").run();
	assert.throws(
		() => migrate(other),
		/The work store applied migration 7 as qa-previews, but this evf code numbers 007-follow-up-links\.sql 7\. Renumber the newer migration after the last one on main\./,
	);
	other.close();
});
