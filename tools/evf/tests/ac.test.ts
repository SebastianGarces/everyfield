import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { fixture, source, setTasks } from "./fixtures.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { STAGE_PROMPTS } from "../drive.ts";
import { checkPrBody } from "../pr-body.ts";
import { doneChecks, parseCheck } from "../spec.ts";
import { parseTask, runtimeDir } from "../lib.ts";

/**
 * OPS-112: Done criteria become an answer key. Every test here carries the marker of the criterion it proves, so
 * `bin/evf ac run OPS-112` runs this file as the task's own answer key. Fixture repositories hold stub tests: no real
 * browser, no real preview.
 */

const cli = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" },
	});

const AUTHOR = { session: "11111111-1111-4111-8111-111111111111", model: "claude-opus-5-5", role: "implementer" };
/** A body from the PR template; `proof` lines go into How it was verified. */
function prBody(proof: string[] = []) {
	const template = readFileSync(join(source, ".agents/skills/everyfield-pr/template.md"), "utf8").replace(
		/<!--[^]*?-->/g,
		"",
	);
	const sections = template
		.split("\n")
		.filter((l) => l.startsWith("## "))
		.map((heading) =>
			[heading, "Concrete task evidence.", ...(heading === "## How it was verified" ? ["", ...proof] : [])].join("\n"),
		);
	return `${sections.join("\n\n")}\n\nEVF-Author: ${JSON.stringify(AUTHOR)}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
}
const TABLE = ["| Criterion | Check | Status | Evidence |", "| --- | --- | --- | --- |"];

/** A task with a worktree, a store row, a fake portless and helpers to commit stub tests and close runs. */
function acFixture(ref = "OPS-1") {
	const f = fixture(),
		task = parseTask(ref);
	f.tasks = { "OPS-1": { title: "Answer key", owningPaths: ["tools/evf/"], checks: f.cfg.checks } };
	setTasks(f.root, f.tasks);
	f.commit();
	const wt = f.task(task.slug);
	const db = openWorkDb(f.root);
	const t = ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET worktree = ?, status = 'active' WHERE id = ?").run(wt, t.id);
	const previews = join(f.root, "fake-bin/previews.json");
	writeFileSync(previews, "[]");
	writeFileSync(
		join(f.root, "fake-bin/portless"),
		`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==="preview"&&a[1]==="status"){process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(previews)},"utf8"));process.exit(0)}process.exit(2)\n`,
	);
	chmodSync(join(f.root, "fake-bin/portless"), 0o755);
	const gitWt = (...args: string[]) => spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" }).stdout.trim();
	const summary = join(f.root, "fake-bin/summary.md");
	writeFileSync(summary, "Stage summary.");
	return {
		...f,
		task,
		wt,
		db,
		taskId: t.id,
		head: () => gitWt("rev-parse", "HEAD"),
		setSpec: (spec: string) => db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(spec, t.id),
		commitFiles: (files: Record<string, string>, message = "stub tests") => {
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(wt, path)), { recursive: true });
				writeFileSync(join(wt, path), text);
			}
			gitWt("add", "-A");
			gitWt("commit", "-qm", message);
		},
		setPreviews: (list: unknown[]) => writeFileSync(previews, JSON.stringify(list)),
		insertRun: (stage: string, role: string) =>
			Number(
				db
					.prepare(
						"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, ?, ?, 0, 'started', ?)",
					)
					.run(t.id, stage, role, new Date().toISOString()).lastInsertRowid,
			),
		runStatus: (run: number) =>
			(db.prepare("SELECT status FROM runs WHERE id = ?").get(run) as { status: string }).status,
		close: (run: number, status: string) =>
			cli(f.root, "run", "done", String(run), "--status", status, "--summary-file", summary),
		proofs: () =>
			db
				.prepare(
					"SELECT criterion, status, head_sha, evidence_url, notes, written_by, run_id FROM proofs WHERE task_id = ? ORDER BY id",
				)
				.all(t.id) as Array<{
				criterion: string;
				status: string;
				head_sha: string;
				evidence_url: string | null;
				notes: string | null;
				written_by: string;
				run_id: number | null;
			}>,
		writeBody: (proof: string[]) => {
			mkdirSync(runtimeDir(f.root, task), { recursive: true });
			writeFileSync(join(runtimeDir(f.root, task), "pr-body.md"), prBody(proof));
		},
		done: () => {
			db.close();
			f.close();
		},
	};
}

test("parse: each Done criterion's Check: line gives its kind and its marker or reason (AC:OPS-112-1)", () => {
	const spec = [
		"Goal: an oversight page.",
		"Done criteria:",
		"1. The /oversight page lists every open escalation.",
		"   Check: AC:WP-005/ui-1",
		"2. The empty state reads calm.",
		"   Check: owner — a tone call a person makes",
		"3. A hyphen works too.",
		"   Check: owner - plain hyphen",
		"4. No check here.",
		"5. Two checks.",
		"   Check: AC:WP-005/ui-5",
		"   Check: owner — also",
		"Non-goals:",
		"1. Check: AC:WP-005/ui-9 is not a criterion.",
	].join("\n");
	assert.deepEqual(
		doneChecks(spec).map((c) => [c.criterion, c.check]),
		[
			["1", { kind: "ac", marker: "AC:WP-005/ui-1", task: "WP-005/ui", n: "1" }],
			["2", { kind: "owner", reason: "a tone call a person makes" }],
			["3", { kind: "owner", reason: "plain hyphen" }],
			["4", null],
			["5", null],
		],
	);
	assert.deepEqual(doneChecks(spec)[4]!.values, ["AC:WP-005/ui-5", "owner — also"]);
	assert.equal(parseCheck("owner —"), null, "an owner check needs a reason");
	assert.equal(parseCheck("owner"), null);
	assert.equal(parseCheck("AC:"), null, "an AC marker needs a task and a criterion number");
	assert.equal(parseCheck("AC:OPS-112-1 and more"), null);
	assert.deepEqual(parseCheck("AC:OPS-112-14"), { kind: "ac", marker: "AC:OPS-112-14", task: "OPS-112", n: "14" });
});

test("task spec: a UI spec needs one valid Check: line per criterion; tooling specs only once they use one; prototype plans are exempt (AC:OPS-112-2)", () => {
	const f = acFixture();
	try {
		const spec = (lines: string[]) => {
			const path = join(f.root, "fake-bin/spec.md");
			writeFileSync(path, ["Goal: g.", "Done criteria:", ...lines, "Non-goals: none."].join("\n"));
			return path;
		};
		const store = (ref: string, lines: string[]) => cli(f.root, "task", "spec", ref, "--file", spec(lines));

		const bare = store("WP-005/ui", ["1. One.", "2. Two."]);
		assert.equal(bare.status, 1);
		assert.match(bare.stderr, /criterion 1 has no Check: line/);
		assert.match(bare.stderr, /criterion 2 has no Check: line/);

		const wrong = store("WP-005/ui", [
			"1. One.",
			"   Check: AC:WP-006/ui-1",
			"2. Two.",
			"   Check: AC:WP-005/ui-3",
			"3. Three.",
			"   Check: owner —",
			"4. Four.",
			"   Check: owner — fine",
		]);
		assert.equal(wrong.status, 1);
		assert.match(wrong.stderr, /criterion 1: AC:WP-006\/ui-1 names task WP-006\/ui, not WP-005\/ui/);
		assert.match(wrong.stderr, /criterion 2: AC:WP-005\/ui-3 names criterion 3, not 2/);
		assert.match(wrong.stderr, /criterion 3: "Check: owner —" is neither/);
		assert.doesNotMatch(wrong.stderr, /criterion 4/);

		const good = store("WP-005/ui", ["1. One.", "   Check: AC:WP-005/ui-1", "2. Two.", "   Check: owner — taste"]);
		assert.equal(good.status, 0, good.stderr);

		assert.equal(store("OPS-1", ["1. One.", "2. Two."]).status, 0, "a tooling spec may leave Check: out");
		const partial = store("OPS-1", ["1. One.", "   Check: AC:OPS-1-1", "2. Two."]);
		assert.equal(partial.status, 1);
		assert.match(partial.stderr, /criterion 2 has no Check: line/);

		const ask = join(f.root, "fake-bin/ask.md");
		writeFileSync(ask, "Try three takes on the page.");
		assert.equal(cli(f.root, "task", "new", "WP-006/ui", "--ask-file", ask, "--mode", "prototype").status, 0);
		assert.equal(store("WP-006/ui", ["1. Each idea shows the page.", "2. Each idea is fast."]).status, 0);
	} finally {
		f.done();
	}
});

const UI_STUB = `import test from "node:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const log = (name) => appendFileSync(process.env.AC_STUB_LOG, JSON.stringify({ name, engine: process.env.UI_ENGINE, url: process.env.UI_BASE_URL, video: process.env.EVF_AC_VIDEO_DIR, browserRun: !!process.env.EVF_BROWSER_RUN, preload: process.execArgv.some((a) => a.endsWith("tools/evf/ac-video.mjs")) }) + "\\n");
	test("the oversight page lists every escalation AC:WP-005/ui-1", () => {
	log("one");
	writeFileSync(join(process.env.EVF_AC_VIDEO_DIR, "flow.webm"), "video");
});
	test("a later criterion that fails AC:WP-005/ui-10", () => { log("ten"); throw new Error("ten"); });
	test("an unmarked test", () => log("unmarked"));
`;
const TOOL_STUB = `import test from "node:test";
	test("the command prints the table AC:WP-005/ui-2", () => {});
	test("this one fails AC:WP-005/ui-4", () => { throw new Error("the table is wrong"); });
	test("this one is skipped AC:WP-005/ui-5", { skip: true }, () => {});
`;

test("ac run: marked tests run on Chromium and WebKit inside evf browser run against the ready preview of HEAD, with video; evf writes the rows (AC:OPS-112-3 AC:OPS-112-4 AC:OPS-112-8)", () => {
	const f = acFixture("WP-005/ui");
	const log = join(f.root, "fake-bin/stub-log.jsonl");
	process.env.AC_STUB_LOG = log;
	try {
		f.setSpec(
			[
				"Goal: g.",
				"Done criteria:",
				...[1, 2, 3, 4, 5].flatMap((n) => [`${n}. Criterion ${n}.`, `   Check: AC:WP-005/ui-${n}`]),
				"6. Taste.",
				"   Check: owner — a tone call",
				"Non-goals: none.",
			].join("\n"),
		);
		f.commitFiles({ "tests/ui/oversight.test.mjs": UI_STUB, "tools/evf/tests/table.test.ts": TOOL_STUB });
		const head = f.head();

		const none = cli(f.root, "ac", "run", "WP-005/ui");
		assert.equal(none.status, 1);
		assert.match(none.stderr, /No ready portless preview of .*wp-005-ui; browser tests need one/);
		f.setPreviews([{ project: f.wt, state: "ready", head: "0".repeat(40), url: "https://old.localhost:1355" }]);
		const stale = cli(f.root, "ac", "run", "WP-005/ui");
		assert.equal(stale.status, 1);
		assert.match(stale.stderr, new RegExp(`serves 0000000000, not the worktree HEAD ${head.slice(0, 10)}`));
		assert.equal(f.proofs().length, 0, "a refused run writes no row");

		const url = "https://wp-005-ui.localhost:1355";
		f.setPreviews([
			{ project: f.wt, state: "removed", head, url: "https://gone.localhost:1355", createdAt: 3 },
			{ project: f.wt, state: "ready", head, url, createdAt: 2 },
		]);
		writeFileSync(join(f.wt, "stray.txt"), "dirty");
		assert.match(cli(f.root, "ac", "run", "WP-005/ui").stderr, /has uncommitted changes/);
		spawnSync("rm", [join(f.wt, "stray.txt")]);

		const ran = cli(f.root, "ac", "run", "WP-005/ui");
		assert.equal(ran.status, 1, "an unmet row fails the command");
		const calls = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.deepEqual(
			calls.map((c) => [c.name, c.engine, c.url, c.browserRun, c.preload]),
			[
				["one", "chromium", url, true, true],
				["one", "webkit", url, true, true],
			],
			"only the marked browser test runs, once per engine, inside evf browser run with the video preload; -1 never runs -10",
		);
		for (const c of calls) {
			assert.ok(!c.video.startsWith(f.wt), "videos go outside the repository");
			assert.match(c.video, new RegExp(`${head}/ac/criterion-1/${c.engine}$`));
		}

		const rows = new Map(f.proofs().map((p) => [p.criterion, p]));
		assert.deepEqual(
			[...rows.keys()],
			["1", "2", "3", "4", "5"],
			"one row per AC: criterion; the owner row is not evf's",
		);
		for (const p of rows.values()) {
			assert.equal(p.written_by, "evf");
			assert.equal(p.head_sha, head);
		}
		assert.equal(rows.get("1")!.status, "met");
		assert.match(
			rows.get("1")!.notes!,
			/"the oversight page lists every escalation AC:WP-005\/ui-1" \(chromium passed, webkit passed\)/,
		);
		assert.match(rows.get("1")!.notes!, new RegExp(head.slice(0, 10)));
		assert.deepEqual(
			rows
				.get("1")!
				.evidence_url!.split(" ")
				.map((p) => p.split("/ac/")[1]),
			["criterion-1/chromium/flow.webm", "criterion-1/webkit/flow.webm"],
			"each engine's video is the row's evidence",
		);
		assert.equal(rows.get("2")!.status, "met");
		assert.match(rows.get("2")!.notes!, /"the command prints the table AC:WP-005\/ui-2" \(node passed\)/);
		assert.equal(rows.get("2")!.evidence_url, "tools/evf/tests/table.test.ts");
		assert.equal(rows.get("3")!.status, "unmet");
		assert.equal(rows.get("3")!.notes, "no test carries AC:WP-005/ui-3");
		assert.equal(rows.get("4")!.status, "unmet");
		assert.match(rows.get("4")!.notes!, /\(node failed\); node --test exited 1 on node/);
		assert.equal(rows.get("5")!.status, "unmet", "a skipped test does not pass");
		assert.match(rows.get("5")!.notes!, /\(node skipped\)/);

		const shown = cli(f.root, "proof", "show", "WP-005/ui");
		assert.match(shown.stdout, / 1 +met +by evf ac run /);

		// The PR body: the browser row needs its video link; the tools-only row may name tools/evf/tests.
		const body = join(f.root, "fake-bin/body.md");
		const check = (rows: string[]) => {
			writeFileSync(body, prBody([...TABLE, ...rows]));
			return cli(f.root, "pr", "body", "--body-file", body, "--task", "WP-005/ui");
		};
		const noVideo = check([
			"| 1 | AC:WP-005/ui-1 | met | tools/evf/tests says so |",
			"| 2 | AC:WP-005/ui-2 | met | tools/evf/tests/table.test.ts |",
		]);
		assert.equal(noVideo.status, 1);
		assert.match(noVideo.stderr, /AC: rows with no video link: AC:WP-005\/ui-1\./);
		const linked = check([
			"| 1 | AC:WP-005/ui-1 | met | [video](https://evidence.example/evf-evidence/x/index.html#criterion-1/chromium/flow.webm) |",
			"| 2 | AC:WP-005/ui-2 | met | tools/evf/tests/table.test.ts |",
		]);
		assert.equal(linked.status, 0, linked.stderr);
	} finally {
		delete process.env.AC_STUB_LOG;
		f.done();
	}
});

test("video: the evf ac run preload makes every context of a launched browser record when EVF_AC_VIDEO_DIR is set (AC:OPS-112-8)", () => {
	const dir = mkdtempSync(join(tmpdir(), "evf-ac-video-"));
	try {
		// A fake Playwright where the worktree keeps the real one; a browser test file loads it as tests/ui/setup.mjs does.
		const pw = join(dir, "apps/web/node_modules/playwright");
		mkdirSync(pw, { recursive: true });
		writeFileSync(
			join(pw, "index.mjs"),
			`class BrowserType { constructor(name) { this.n = name; } name() { return this.n; } async launch() { return { newContext: async (opts) => opts, async newPage(opts = {}) { return this.newContext(opts); } }; } }
export const chromium = new BrowserType("chromium"), webkit = new BrowserType("webkit");`,
		);
		writeFileSync(
			join(dir, "probe.test.mjs"),
			`import test from "node:test";
import { appendFileSync } from "node:fs";
import { chromium, webkit } from "./apps/web/node_modules/playwright/index.mjs";
	test("probe", async () => {
		const b = await webkit.launch({});
		appendFileSync("out.jsonl", JSON.stringify({ small: await b.newContext({ viewport: { width: 390, height: 844 } }), page: await b.newPage(), name: chromium.name() }) + "\\n");
	});`,
		);
		// Inside a node:test process this names the parent's protocol; the nested run would then skip its files.
		const { NODE_TEST_CONTEXT: _, ...env } = process.env;
		const run = (video: string) => {
			const r = spawnSync(
				process.execPath,
				["--test", `--import=${pathToFileURL(join(source, "tools/evf/ac-video.mjs")).href}`, "probe.test.mjs"],
				{ cwd: dir, encoding: "utf8", env: { ...env, EVF_AC_VIDEO_DIR: video } },
			);
			assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
			const lines = readFileSync(join(dir, "out.jsonl"), "utf8").trim().split("\n");
			rmSync(join(dir, "out.jsonl"));
			return JSON.parse(lines.at(-1)!);
		};
		const on = run("/tmp/evf-ac-video");
		assert.deepEqual(on.small.recordVideo, { dir: "/tmp/evf-ac-video", size: { width: 390, height: 844 } });
		assert.deepEqual(on.page.recordVideo, { dir: "/tmp/evf-ac-video", size: { width: 1440, height: 900 } });
		assert.equal(on.name, "chromium", "the patched engines keep their methods");
		const off = run("");
		assert.equal(off.small.recordVideo, undefined, "without the variable nothing records");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pr body: an AC: row of the proof table links its video unless only tools/evf/tests tests prove it (AC:OPS-112-9)", () => {
	const check =
		(rows: string[], video = new Set<string>()) =>
		() =>
			checkPrBody(source, prBody([...TABLE, ...rows]), "ordinary", [], video);
	assert.throws(check(["| 3 | AC:WP-090/ui-3 | met | see the run |"]), /no video link: AC:WP-090\/ui-3\./);
	assert.throws(
		check(["| 3 | AC:WP-090/ui-3 | met | [video](/local/flow.webm) |"]),
		/no video link/,
		"a local path is not the evidence page",
	);
	assert.doesNotThrow(
		check(["| 3 | AC:WP-090/ui-3 | met | [video](https://e.example/t/p/index.html#criterion-3/webkit/a.webm) |"]),
	);
	assert.doesNotThrow(check(["| 3 | AC:OPS-9-3 | met | tools/evf/tests/x.test.ts |"]));
	assert.throws(
		check(["| 3 | AC:OPS-9-3 | met | tools/evf/tests/x.test.ts |"], new Set(["AC:OPS-9-3"])),
		/no video link: AC:OPS-9-3/,
		"evf stored a video for the marker, so the row needs its link",
	);
	assert.throws(
		check(["| 1 | AC:WP-090/ui-1 | met | none |", "| 2 | AC:WP-090/ui-2 | met | none |"]),
		/AC:WP-090\/ui-1, AC:WP-090\/ui-2/,
		"the message names every bad row",
	);
	assert.doesNotThrow(check(["| 1 | owner — tone | met | screenshot |"]), "owner rows need no video");
	const html = readFileSync(join(source, ".agents/skills/verify-preview/scripts/publish.mjs"), "utf8");
	assert.match(html, /<figure id="\$\{esc\(f\)\}"><video/, "the evidence page gives each video an anchor to link");
});

const OPS_STUB = (passing: boolean) => `import test from "node:test";
	test("the first criterion holds AC:OPS-1-1", () => { if (!${passing}) throw new Error("broken"); });
	test("the second criterion holds AC:OPS-1-2", () => {});
`;
const OPS_SPEC = (second = "   Check: AC:OPS-1-2") =>
	["Goal: g.", "Done criteria:", "1. One.", "   Check: AC:OPS-1-1", "2. Two.", second, "Non-goals: none."].join("\n");
const OPS_ROWS = [
	"| 1 | AC:OPS-1-1 | met | tools/evf/tests/answer.test.ts |",
	"| 2 | AC:OPS-1-2 | met | tools/evf/tests/answer.test.ts |",
];

test("proof add: met and n/a are refused for an AC: criterion; unmet, owner rows and unchecked specs keep the old rule (AC:OPS-112-5)", () => {
	const f = acFixture();
	try {
		f.setSpec(OPS_SPEC("   Check: owner — taste"));
		const add = (n: string, status: string) =>
			cli(f.root, "proof", "add", "OPS-1", "--criterion", n, "--status", status);
		for (const status of ["met", "n/a"]) {
			const refused = add("1", status);
			assert.equal(refused.status, 1);
			assert.match(refused.stderr, /Criterion 1 checks AC:OPS-1-1: .*Run bin\/evf ac run OPS-1\./);
		}
		assert.equal(add("1", "unmet").status, 0);
		assert.equal(add("2", "met").status, 0, "an owner criterion takes a seat's met");
		f.setSpec("Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.");
		assert.equal(add("1", "met").status, 0, "a spec with no Check: lines keeps today's proof add");
		assert.deepEqual(
			f.proofs().map((p) => [p.criterion, p.status, p.written_by]),
			[
				["1", "unmet", "seat"],
				["2", "met", "seat"],
				["1", "met", "seat"],
			],
		);
	} finally {
		f.done();
	}
});

test("run done gate: a passed implement runs evf ac run at HEAD and lists each unmet criterion; an earlier head's row does not carry; failed runs no test (AC:OPS-112-6)", () => {
	const f = acFixture();
	try {
		f.setSpec(OPS_SPEC());
		f.commitFiles({ "tools/evf/tests/answer.test.ts": OPS_STUB(true) });
		f.writeBody([...TABLE, ...OPS_ROWS]);
		assert.equal(cli(f.root, "ac", "run", "OPS-1").status, 0);
		assert.deepEqual(
			f.proofs().map((p) => p.status),
			["met", "met"],
		);
		f.commitFiles({ "tools/evf/tests/answer.test.ts": OPS_STUB(false) }, "break criterion 1");
		const run = f.insertRun("implement", "implementer");
		const refused = f.close(run, "passed");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /implement cannot close passed: evf ac run found AC: criteria not met at/);
		assert.match(
			refused.stderr,
			/criterion 1 \(AC:OPS-1-1\): evf ac run at [0-9a-f]{10}: unmet; "the first criterion holds AC:OPS-1-1" \(node failed\)/,
		);
		assert.doesNotMatch(refused.stderr, /criterion 2 \(/);
		assert.equal(f.runStatus(run), "started", "the run stays open");
		assert.equal(f.proofs().filter((p) => p.head_sha === f.head()).length, 2, "the gate ran the tests at the new head");

		const rows = f.proofs().length;
		const failed = f.close(run, "failed");
		assert.equal(failed.status, 0, failed.stderr);
		assert.equal(f.proofs().length, rows, "a failed close runs no test");
	} finally {
		f.done();
	}
});

test("verify gate stays: owner rows still need a met or n/a proof; specs with no Check: lines close as before (AC:OPS-112-7)", () => {
	const f = acFixture();
	try {
		f.setSpec(OPS_SPEC("   Check: owner — a person judges it"));
		f.commitFiles({ "tools/evf/tests/answer.test.ts": OPS_STUB(true) });
		const verify = f.insertRun("verify", "verifier");
		const refused = f.close(verify, "passed");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Done criteria 2 have no met or n\/a proof at/);
		assert.equal(cli(f.root, "proof", "add", "OPS-1", "--criterion", "2", "--status", "met").status, 0);
		assert.equal(f.close(verify, "passed").status, 0);

		f.setSpec("Goal: g.\nDone criteria:\n1. One.\n2. Two.\n3. Three.\nNon-goals: none.");
		f.writeBody([]);
		const before = f.proofs().length;
		const implement = f.insertRun("implement", "implementer");
		assert.equal(f.close(implement, "passed").status, 0, "an unchecked spec has no answer key gate");
		assert.equal(f.proofs().length, before, "and evf runs no test for it");
		assert.match(
			f.close(f.insertRun("verify", "verifier"), "passed").stderr,
			/Done criteria 3 have no met or n\/a proof/,
		);
	} finally {
		f.done();
	}
});

test("replay #386: the ask names /oversight, no test carries its marker, and implement and verify both refuse to pass (AC:OPS-112-10)", () => {
	const f = acFixture("WP-005/ui");
	try {
		const ask = join(f.root, "fake-bin/ask.md");
		writeFileSync(ask, "Build the /oversight page so I can see every open escalation.");
		assert.equal(cli(f.root, "task", "new", "WP-005/ui", "--ask-file", ask).status, 0);
		const spec = join(f.root, "fake-bin/spec.md");
		writeFileSync(
			spec,
			[
				"Goal: the /oversight page.",
				"Done criteria:",
				"1. The /oversight page lists every open escalation.",
				"   Check: AC:WP-005/ui-1",
				"2. The page reads calm.",
				"   Check: owner — a tone call",
				"Non-goals: none.",
			].join("\n"),
		);
		assert.equal(cli(f.root, "task", "spec", "WP-005/ui", "--file", spec).status, 0);
		f.commitFiles({
			"tests/ui/home.test.mjs": `import test from "node:test";\ntest("the home page loads", () => {});\n`,
		});
		assert.equal(
			cli(f.root, "proof", "add", "WP-005/ui", "--criterion", "1", "--status", "met").status,
			1,
			"the author cannot mark it met",
		);
		for (const [stage, role] of [
			["implement", "implementer"],
			["verify", "verifier"],
		] as const) {
			const run = f.insertRun(stage, role);
			const refused = f.close(run, "passed");
			assert.equal(refused.status, 1, `${stage} must refuse`);
			assert.match(refused.stderr, new RegExp(`${stage} cannot close passed`));
			assert.match(refused.stderr, /criterion 1 \(AC:WP-005\/ui-1\): no test carries AC:WP-005\/ui-1/);
			assert.equal(f.runStatus(run), "started");
		}
	} finally {
		f.done();
	}
});

test("replay a passing PR: run done writes met rows at the head with no seat proof add, and the verify gate sees them (AC:OPS-112-11)", () => {
	const f = acFixture();
	try {
		f.setSpec(OPS_SPEC());
		f.commitFiles({ "tools/evf/tests/answer.test.ts": OPS_STUB(true) });
		f.writeBody([...TABLE, ...OPS_ROWS]);
		const implement = f.insertRun("implement", "implementer");
		const closed = f.close(implement, "passed");
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(f.runStatus(implement), "passed");
		assert.deepEqual(
			f.proofs().map((p) => [p.criterion, p.status, p.written_by, p.head_sha, p.run_id]),
			[
				["1", "met", "evf", f.head(), implement],
				["2", "met", "evf", f.head(), implement],
			],
		);
		const verify = f.insertRun("verify", "verifier");
		const approved = f.close(verify, "passed");
		assert.equal(approved.status, 0, approved.stderr);
		assert.equal(f.proofs().filter((p) => p.written_by === "seat").length, 0, "no seat wrote a proof row");
		assert.equal(
			(f.db.prepare("SELECT decision FROM approvals WHERE task_id = ?").get(f.taskId) as { decision: string }).decision,
			"approved",
		);
	} finally {
		f.done();
	}
});

test("seat prompts and role texts: plan from the verbatim ask with Check: lines, implement writes the marked tests, verify judges code and owner rows (AC:OPS-112-12)", () => {
	const task = parseTask("OPS-7"),
		next = { stage: "implement" as const, round: 0, reason: "" },
		ctx = { prBody: "/tmp/body.md" } as Parameters<(typeof STAGE_PROMPTS)["plan"]>[2];
	const flat = (text: string) => text.replace(/\s+/g, " ");
	const plan = STAGE_PROMPTS.plan!(task, next, ctx),
		implement = STAGE_PROMPTS.implement!(task, next, ctx),
		verify = STAGE_PROMPTS.verify!(task, next, ctx);
	assert.match(plan, /one Done criterion for each user action and expected result in the verbatim ask/);
	assert.match(plan, /each Ask coverage deliverable \(route, page, screen, command, file\)/);
	assert.match(plan, /"Check: AC:OPS-7-<n>".*"Check: owner — <reason>"/);
	assert.match(implement, /write the test whose name carries that marker.*do not proof add that row/);
	assert.match(verify, /judge the code and its simplicity\. You judge the owner rows\./);
	assert.match(verify, /you may rely on those rows; still read each marked test.*only sees the page load/);
	const role = (path: string) => flat(readFileSync(join(source, path), "utf8"));
	const coordinator = role(".agents/roles/coordinator.md");
	assert.match(coordinator, /one criterion for each user action and expected result the ask names/);
	assert.match(coordinator, /Ask coverage deliverable \(route, page, screen, command, file\)/);
	assert.match(coordinator, /`Check: AC:<task>-<n>`.*`Check: owner — <reason>`/);
	assert.match(role(".claude/agents/planner.md"), /one Done criterion for each user action and expected result/);
	assert.match(
		role(".agents/roles/implementor.md"),
		/write the test whose name carries that marker.*Do not `proof add` those rows/,
	);
	assert.match(role(".claude/agents/implementer.md"), /do not `proof add` that row/);
	assert.match(role(".agents/roles/verifier.md"), /You judge the `owner` rows\..*only sees the page load/);
	assert.match(role(".claude/agents/verifier.md"), /Judge the code, its simplicity and the `owner` rows/);
});

test("this task's answer key: every test in this file carries an OPS-112 marker and every AC: criterion has a test (AC:OPS-112-14)", () => {
	const self = readFileSync(import.meta.filename, "utf8");
	const names = [...self.matchAll(/^test\(\s*"([^"]+)"/gm)].map((m) => m[1]!);
	assert.ok(names.length >= 10);
	for (const name of names) assert.match(name, /AC:OPS-112-\d+/, `"${name}" carries no OPS-112 marker`);
	const proven = new Set(names.flatMap((n) => [...n.matchAll(/AC:OPS-112-(\d+)/g)].map((m) => Number(m[1]))));
	assert.deepEqual(
		[...proven].sort((a, b) => a - b),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14],
		"criterion 13 is the owner row",
	);
	assert.ok(existsSync(join(source, "tools/evf/ac-reporter.mjs")));
});

/**
 * OPS-147: the real preview.mjs against a fake portless that keeps state and, like the real one, refuses a second
 * preview of one project at another head. `upHead` makes `preview up` serve that head instead of the project's HEAD.
 */
function gateFixture() {
	const f = acFixture("WP-005/ui");
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	mkdirSync(join(f.root, "packages/db/scripts"), { recursive: true });
	writeFileSync(
		join(f.root, "packages/db/scripts/reset-dev.ts"),
		'const developmentHosts = new Set(["dev.invalid"]);\n',
	);
	f.git("add", "packages");
	f.git("commit", "-qm", "reset script");
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	writeFileSync(join(f.root, ".git/info/exclude"), ".env*\n");
	mkdirSync(join(f.root, "apps/web"), { recursive: true });
	writeFileSync(join(f.root, "apps/web/.env.local"), "DATABASE_URL=postgres://u:p@dev.invalid/db\n");
	const statePath = join(f.root, "fake-bin/portless-state.json");
	writeFileSync(
		join(f.root, "fake-bin/portless"),
		`#!${process.execPath}
const fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2),p=${JSON.stringify(statePath)};
const s=JSON.parse(fs.readFileSync(p,"utf8"));s.calls.push(a);const save=()=>fs.writeFileSync(p,JSON.stringify(s));let out="";
if(a[1]==="status")out=JSON.stringify(s.previews);
else if(a[1]==="down")s.previews=s.previews.map(x=>x.id===a[2]?{...x,state:"removed"}:x);
else if(a[1]==="up"){
 const project=a[a.indexOf("--project")+1],mode=a[a.indexOf("--mode")+1];
 const head=s.upHead??cp.execFileSync("git",["-C",project,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
 const clash=s.previews.find(x=>x.project===project&&x.mode===mode&&x.state==="ready"&&x.head!==head);
 if(clash){process.stderr.write("Preview "+clash.id+" has different inputs; stop it first");save();process.exit(1)}
 s.seedEnv=fs.existsSync(project+"/apps/web/.env.local");
 const up={id:"gate-preview",project,head,mode,state:"ready",url:"https://gate.localhost:1355",createdAt:9};s.previews.push(up);out=JSON.stringify(up)}
save();process.stdout.write(out);\n`,
	);
	const log = join(f.root, "fake-bin/stub-log.jsonl");
	process.env.AC_STUB_LOG = log;
	f.setSpec(["Goal: g.", "Done criteria:", "1. One.", "   Check: AC:WP-005/ui-1", "Non-goals: none."].join("\n"));
	f.writeBody([]);
	type Preview = { id: string; project: string; state: string; head: string; mode: string; url: string };
	const seat: Preview[] = [
		{
			id: "old-head",
			project: f.wt,
			state: "ready",
			head: "0".repeat(40),
			mode: "production",
			url: "https://old.localhost:1355",
		},
		{
			id: "other-seat",
			project: join(f.root, ".worktrees/verify-other"),
			state: "ready",
			head: "1".repeat(40),
			mode: "production",
			url: "https://other.localhost:1355",
		},
	];
	const setState = (extra: object = {}) =>
		writeFileSync(statePath, JSON.stringify({ previews: seat, calls: [], ...extra }));
	const state = () =>
		JSON.parse(readFileSync(statePath, "utf8")) as { previews: Preview[]; calls: string[][]; seedEnv?: boolean };
	const previewByTest = (name: string) =>
		`import test from "node:test";\nimport { appendFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\ntest("${name} AC:WP-005/ui-1", () => {\n\tappendFileSync(process.env.AC_STUB_LOG, process.env.UI_BASE_URL + "\\n");\n\twriteFileSync(join(process.env.EVF_AC_VIDEO_DIR, "flow.webm"), "video");\n${name === "fails" ? '\tthrow new Error("no");\n' : ""}});\n`;
	const seen = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
	const worktrees = () =>
		f
			.git("worktree", "list")
			.split("\n")
			.filter((l) => l.includes("/gate-"));
	setState();
	return { ...f, setState, state, previewByTest, seen, worktrees };
}

test("run done: with a preview of an old head running, the gate starts a preview of HEAD, closes and stops only its own (AC:OPS-112-4 OPS-147-5,6)", () => {
	const f = gateFixture();
	try {
		mkdirSync(join(f.wt, "apps/web"), { recursive: true });
		f.commitFiles({ "tests/ui/gate.test.mjs": f.previewByTest("passes") });
		writeFileSync(join(f.wt, "apps/web/.env.local"), "IDENTITY_SECRET=seeded\n");
		const run = f.insertRun("implement", "implementer");
		const closed = f.close(run, "passed");
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(f.runStatus(run), "passed");
		assert.deepEqual(f.seen(), Array(2).fill("https://gate.localhost:1355"), "both engines test the gate's preview");
		assert.deepEqual(
			f.proofs().map((p) => [p.criterion, p.status, p.head_sha]),
			[["1", "met", f.head()]],
		);
		const { calls, previews, seedEnv } = f.state();
		assert.equal(seedEnv, true, "a seed's env in the task worktree reaches the gate's preview");
		assert.deepEqual(
			calls.filter((c) => c[1] === "down"),
			[["preview", "down", "gate-preview"]],
		);
		assert.deepEqual(
			previews.filter((p) => p.state === "ready").map((p) => p.id),
			["old-head", "other-seat"],
		);
		assert.deepEqual(f.worktrees(), [], "the gate's worktree is gone");

		// `evf ac run` is no gate: it starts nothing and still refuses the old head.
		f.setState();
		const refused = cli(f.root, "ac", "run", "WP-005/ui");
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, new RegExp(`serves 0000000000, not the worktree HEAD ${f.head().slice(0, 10)}`));
		assert.ok(!f.state().calls.some((c) => c[1] === "up"));
	} finally {
		f.done();
	}
});

test("run done: the gate refuses a started preview that does not serve HEAD and a marked test that fails, and stops its preview (AC:OPS-112-4 OPS-147-7)", () => {
	const f = gateFixture();
	try {
		f.commitFiles({ "tests/ui/gate.test.mjs": f.previewByTest("passes") });
		const run = f.insertRun("implement", "implementer");

		f.setState({ upHead: "2".repeat(40) });
		const wrongHead = f.close(run, "passed");
		assert.equal(wrongHead.status, 1);
		assert.match(
			wrongHead.stderr,
			new RegExp(`ready at 2222222222|at 2222222222, not ready at HEAD ${f.head().slice(0, 10)}`),
		);
		assert.equal(f.runStatus(run), "started");
		assert.deepEqual(f.seen(), [], "no test ran against another commit");
		assert.equal(f.proofs().length, 0);
		assert.ok(f.state().calls.some((c) => c[1] === "down" && c[2] === "gate-preview"));
		assert.deepEqual(f.worktrees(), []);

		f.commitFiles({ "tests/ui/gate.test.mjs": f.previewByTest("fails") });
		f.setState();
		const unmet = f.close(run, "passed");
		assert.equal(unmet.status, 1);
		assert.match(unmet.stderr, /implement cannot close passed: evf ac run found AC: criteria not met/);
		assert.equal(f.runStatus(run), "started");
		assert.deepEqual(
			f.proofs().map((p) => [p.status, p.head_sha]),
			[["unmet", f.head()]],
		);
		assert.deepEqual(
			f.state().calls.filter((c) => c[1] === "down"),
			[["preview", "down", "gate-preview"]],
		);
		assert.deepEqual(f.worktrees(), []);
	} finally {
		f.done();
	}
});
