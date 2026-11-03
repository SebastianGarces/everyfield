import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { parseTask, runtimeDir } from "../lib.ts";
import { openWorkDb } from "../db.ts";
import { escape, soak, soakPath, uiEscapedGate, type PrRead } from "../escape.ts";
import { verify } from "../verify.ts";

const MERGED = "a".repeat(40),
	HEAD = "b".repeat(40),
	REVIEWED = "c".repeat(40);
const merged: PrRead = { state: "MERGED", headRefOid: HEAD, mergeCommit: { oid: MERGED } };
const open: PrRead = { state: "OPEN", headRefOid: HEAD, mergeCommit: null };
const TOOLING = [
	{ name: "documentation", run: ["python3", "docs/check-all.py"] },
	{ name: "workflow-regressions", run: ["bin/evf", "test"] },
];

/** Run `fn` and return what it printed to console.log and console.error. */
function output(fn: () => unknown): string {
	const log = console.log,
		error = console.error;
	let out = "";
	console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
	console.error = (...a: unknown[]) => void (out += a.join(" ") + "\n");
	try {
		fn();
	} finally {
		console.log = log;
		console.error = error;
	}
	return out;
}

/** A fixture whose checks name the tooling checks the printed entry copies, with a bare remote for id reservation. */
function withStore() {
	const f = fixture();
	f.cfg.checks = [...f.cfg.checks, ...TOOLING];
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
	f.commit();
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	const reservations = () =>
		spawnSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/evf/ids/"], {
			encoding: "utf8",
		})
			.stdout.split("\n")
			.filter(Boolean);
	const rows = () => {
		const db = openWorkDb(f.root);
		try {
			return db.prepare("SELECT ref, status, ask, title FROM tasks WHERE ref LIKE 'OPS-%' ORDER BY id").all() as Array<{
				ref: string;
				status: string;
				ask: string;
				title: string;
			}>;
		} finally {
			db.close();
		}
	};
	return { ...f, reservations, rows };
}

test("OPS-114-1: evf escape reserves an OPS id and files one new task whose ask holds the words, PR, head and Done template", () => {
	const f = withStore();
	try {
		const home = readFileSync(join(f.root, "evf.config.json"));
		const what = "  The top nav is drawn over the document — scroll up and it covers the title.\n";
		const out = output(() => escape(f.root, { pr: 393, what }, { readPr: () => open }));
		// The real reservation ran: main registers OPS-1..OPS-n, so the next id is one above the highest.
		assert.deepEqual(f.reservations().length, 1);
		const id = f.reservations()[0]!.replace("refs/evf/ids/", "");
		const [row] = f.rows();
		assert.equal(row?.ref, id);
		assert.equal(row?.status, "new");
		assert.equal(row?.title, "Escaped bug from PR #393 becomes a permanent check");
		assert.equal(
			row?.ask,
			"# Ask: escaped bug from PR #393 becomes a permanent check\n" +
				"\n" +
				"## Sebastian's words (verbatim)\n" +
				"\n" +
				"  The top nav is drawn over the document — scroll up and it covers the title.\n" +
				"\n" +
				"\n" +
				"## Escape\n" +
				"\n" +
				"- PR: #393\n" +
				`- Escaped head: ${HEAD} (PR head)\n` +
				"\n" +
				"## Done template\n" +
				"\n" +
				`1. A test in \`tests/ui/escaped/\` fails on the escaped head ${HEAD} and passes on the fix, or on main when main never had the bug.\n` +
				"2. The test passes the 20-run soak: `bin/evf escape soak tests/ui/escaped/<name>.test.mjs` records 20 green runs for the file's current bytes.\n" +
				"3. One `bin/evf proof add` records each of the two runs (the failure on the escaped head and the pass on the fix or main), with the head SHA, the command and the result.",
		);
		// OPS-114-4: the printed entry owns tests/ui/escaped/ with the tooling checks; evf.config.json is untouched.
		const entry = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
		assert.deepEqual(entry, {
			[id]: {
				title: "Escaped bug from PR #393 becomes a permanent check",
				owningPaths: ["tests/ui/escaped/"],
				checks: TOOLING,
				risk: "ordinary",
			},
		});
		assert.deepEqual(readFileSync(join(f.root, "evf.config.json")), home);
		assert.equal(out.trim().split("\n").at(-1), id);
	} finally {
		f.close();
	}
});

test("OPS-114-2: the escaped head is the merge commit, else the PR head, and --head overrides both", () => {
	const f = withStore();
	try {
		let n = 0;
		const reserveId = () => `OPS-${900 + ++n}`;
		const headOf = (ref: string) => /Escaped head: (\S+) \(([^)]+)\)/.exec(f.rows().find((r) => r.ref === ref)!.ask)!;
		output(() => escape(f.root, { pr: 10, what: "merged" }, { readPr: () => merged, reserveId }));
		output(() => escape(f.root, { pr: 11, what: "open" }, { readPr: () => open, reserveId }));
		output(() => escape(f.root, { pr: 12, what: "reviewed", head: REVIEWED }, { readPr: () => merged, reserveId }));
		assert.deepEqual(headOf("OPS-901").slice(1), [MERGED, "merge commit"]);
		assert.deepEqual(headOf("OPS-902").slice(1), [HEAD, "PR head"]);
		assert.deepEqual(headOf("OPS-903").slice(1), [REVIEWED, "override"]);
		assert.throws(
			() => escape(f.root, { pr: 13, what: "short", head: "abc123" }, { readPr: () => open, reserveId }),
			/full 40-character commit SHA/,
		);
	} finally {
		f.close();
	}
});

test("OPS-114-4: evf escape refuses a missing or empty --what and a PR that does not exist, and reserves no id", () => {
	const f = withStore();
	try {
		let reserved = 0;
		const reserveId = () => `OPS-${900 + ++reserved}`;
		assert.throws(() => escape(f.root, { pr: 393 }, { readPr: () => open, reserveId }), /Give --what/);
		for (const what of ["", "  \n\t"])
			assert.throws(() => escape(f.root, { pr: 393, what }, { readPr: () => open, reserveId }), /--what is empty/);
		assert.throws(
			() => escape(f.root, { pr: 99999, what: "words" }, { readPr: () => null, reserveId }),
			/PR #99999 does not exist/,
		);
		// The real reservation path is not reached either: the remote holds no reservation.
		assert.throws(() => escape(f.root, { pr: 99999, what: "words" }, { readPr: () => null }), /does not exist/);
		assert.equal(reserved, 0);
		assert.deepEqual(f.reservations(), []);
		assert.deepEqual(f.rows(), []);
	} finally {
		f.close();
	}
});

test("OPS-114-5: a second evf escape for the same PR and head files nothing and prints the existing id", () => {
	const f = withStore();
	try {
		let reserved = 0;
		const reserveId = () => `OPS-${900 + ++reserved}`;
		output(() => escape(f.root, { pr: 393, what: "first" }, { readPr: () => open, reserveId }));
		const again = output(() => escape(f.root, { pr: 393, what: "second words" }, { readPr: () => open, reserveId }));
		assert.equal(reserved, 1);
		assert.equal(f.rows().length, 1);
		assert.match(again, /OPS-901 already covers PR #393/);
		assert.equal(again.trim().split("\n").at(-1), "OPS-901");
		// Another head of the same PR is another escape.
		output(() => escape(f.root, { pr: 393, what: "later", head: REVIEWED }, { readPr: () => open, reserveId }));
		assert.equal(f.rows().length, 2);
	} finally {
		f.close();
	}
});

/** A registered OPS task worktree whose checks print the base URL the ui-escaped check got. */
function opsTask(f: ReturnType<typeof fixture>) {
	f.cfg.checks = [
		...f.cfg.checks,
		{
			name: "ui-escaped",
			run: [process.execPath, "-e", "console.log('ui-escaped ran against ' + process.env.UI_BASE_URL)"],
		},
	];
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg, null, 2));
	f.commit();
	const wt = f.task("ops-900"),
		task = parseTask("OPS-900");
	const cfg = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
	cfg.maintenanceTasks = {
		...cfg.maintenanceTasks,
		"OPS-900": {
			title: "Escape fixture",
			owningPaths: ["tools/evf/"],
			checks: [{ name: "own", run: [process.execPath, "-e", ""] }],
		},
	};
	writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
	f.git("-C", wt, "add", "evf.config.json");
	f.git("-C", wt, "commit", "-qm", "Register OPS-900");
	const commit = (path: string, text: string) => {
		mkdirSync(join(wt, path, ".."), { recursive: true });
		writeFileSync(join(wt, path), text);
		f.git("-C", wt, "add", path);
		f.git("-C", wt, "commit", "-qm", `Change ${path}`);
	};
	const stackUp = (url: string) => {
		mkdirSync(runtimeDir(f.root, task), { recursive: true });
		writeFileSync(join(runtimeDir(f.root, task), "stack.json"), JSON.stringify({ url, state: "ready" }));
	};
	return { wt, task, commit, stackUp };
}

test("OPS-114-6: ui-escaped skips other tasks with one line, fails closed without a stack and runs with UI_BASE_URL", () => {
	const f = fixture();
	try {
		// An OPS task that changes only tooling skips the check with one line.
		const { commit } = opsTask(f);
		commit("tools/evf/change.ts", "export {};\n");
		let report!: ReturnType<typeof verify>;
		const skipped = output(() => (report = verify(f.root, parseTask("OPS-900"), "author", "full")));
		assert.equal(report.passed, true);
		assert.equal(
			report.checks.some((c) => c.name === "ui-escaped"),
			false,
		);
		assert.equal(
			skipped
				.split("\n")
				.filter((l) => l.includes("ui-escaped"))
				.join("\n"),
			"evf verify: ui-escaped skipped: OPS-900 is not a WP /ui part and changes no file under tests/ui/escaped/.",
		);

		// A WP /ui part: one line while the folder holds no test, then fail closed without a stack, then run.
		const ui = parseTask("WP-005/ui");
		f.authorize("WP-005");
		f.commit();
		const wt = f.task(ui.slug);
		const uiCheck = () => {
			let r!: ReturnType<typeof verify>;
			const out = output(() => (r = verify(f.root, ui, "author", "full")));
			return { out, check: r.checks.find((c) => c.name === "ui-escaped") };
		};
		const empty = uiCheck();
		assert.equal(empty.check, undefined);
		assert.match(empty.out, /^evf verify: ui-escaped skipped: tests\/ui\/escaped\/ holds no escaped test yet\.$/m);

		const file = "tests/ui/escaped/overlap.test.mjs";
		mkdirSync(join(wt, "tests/ui/escaped"), { recursive: true });
		writeFileSync(join(wt, file), "// one escaped test\n");
		f.git("-C", wt, "add", file);
		f.git("-C", wt, "commit", "-qm", "Add an escaped test");
		const noStack = uiCheck().check!;
		assert.equal(noStack.passed, false);
		assert.match(
			readFileSync(noStack.log, "utf8"),
			/No running stack for WP-005\/ui\. Start it with bin\/evf stack up WP-005\/ui/,
		);

		mkdirSync(runtimeDir(f.root, ui), { recursive: true });
		writeFileSync(
			join(runtimeDir(f.root, ui), "stack.json"),
			JSON.stringify({ url: "https://wp-005-ui.localhost:1355", state: "ready" }),
		);
		const unsoaked = uiCheck().check!;
		assert.equal(unsoaked.passed, false);
		assert.match(readFileSync(unsoaked.log, "utf8"), /has no 20-green soak record for its current bytes/);

		output(() => soak(f.root, ui, join(wt, file), () => ({ code: 0, stdout: "ok", stderr: "" })));
		const ran = uiCheck().check!;
		assert.equal(ran.passed, true);
		assert.match(readFileSync(ran.log, "utf8"), /ui-escaped ran against https:\/\/wp-005-ui\.localhost:1355/);

		// The API part skips.
		assert.deepEqual(uiEscapedGate(f.root, f.root, parseTask("WP-005/api"), f.git("rev-parse", "main")), {
			skip: "WP-005/api is not a WP /ui part and changes no file under tests/ui/escaped/.",
		});
	} finally {
		f.close();
	}
});

test("OPS-114-6: a stack.json whose preview is gone counts as no running stack", () => {
	const f = fixture();
	try {
		// The stack status stub reports the state the test writes beside stack.json.
		f.cfg.stack = {
			usesPaidProviders: false,
			status: [
				process.execPath,
				"-e",
				"const fs=require('fs');const p=process.env.EVF_RUNTIME_DIR+'/state';console.log(JSON.stringify({state:fs.existsSync(p)?fs.readFileSync(p,'utf8'):'stopped'}))",
			],
		};
		const { wt, task, commit, stackUp } = opsTask(f);
		const file = "tests/ui/escaped/overlap.test.mjs";
		commit(file, "// one escaped test\n");
		const base = f.git("rev-parse", "main");
		stackUp("https://ops-900.localhost:1355");
		const gone = { fail: "No running stack for OPS-900. Start it with bin/evf stack up OPS-900, then rerun." };
		assert.deepEqual(uiEscapedGate(f.root, wt, task, base), gone);
		assert.throws(
			() => soak(f.root, task, join(wt, file), () => ({ code: 0, stdout: "", stderr: "" })),
			/No running stack for OPS-900/,
		);

		writeFileSync(join(runtimeDir(f.root, task), "state"), "ready");
		output(() => soak(f.root, task, join(wt, file), () => ({ code: 0, stdout: "", stderr: "" })));
		assert.deepEqual(uiEscapedGate(f.root, wt, task, base), { baseUrl: "https://ops-900.localhost:1355" });
	} finally {
		f.close();
	}
});

test("OPS-114-7: a soak records 20 green runs, stops at the first failure, and a changed file needs a new soak", () => {
	const f = fixture();
	try {
		const { wt, task, commit, stackUp } = opsTask(f);
		const file = "tests/ui/escaped/overlap.test.mjs";
		commit(file, "// version 1\n");
		const base = f.git("rev-parse", "main");
		const hash = () =>
			createHash("sha256")
				.update(readFileSync(join(wt, file)))
				.digest("hex");
		assert.throws(
			() => soak(f.root, task, join(wt, file), () => ({ code: 0, stdout: "", stderr: "" })),
			/No running stack for OPS-900/,
		);
		stackUp("https://ops-900.localhost:1355");
		assert.throws(() => soak(f.root, task, join(wt, "tools/evf/x.test.mjs")), /not a test file in tests\/ui\/escaped/);

		// Pass: 20 runs, each against the stack URL, recorded under the file's content hash.
		const urls: string[] = [];
		let pass!: ReturnType<typeof soak>;
		output(
			() =>
				(pass = soak(f.root, task, join(wt, file), (rel, url) => {
					urls.push(`${rel} ${url}`);
					return { code: 0, stdout: "", stderr: "" };
				})),
		);
		assert.equal(urls.length, 20);
		assert.equal(urls[0], `${file} https://ops-900.localhost:1355`);
		assert.deepEqual([pass.passed, pass.runs, pass.failedRun, pass.sha256], [true, 20, null, hash()]);
		assert.deepEqual(JSON.parse(readFileSync(soakPath(f.root, task, hash()), "utf8")), pass);
		assert.ok("baseUrl" in uiEscapedGate(f.root, wt, task, base));

		// Stale: the file changes, the old record no longer matches, and verify's gate names the soak command.
		commit(file, "// version 2\n");
		const stale = uiEscapedGate(f.root, wt, task, base);
		assert.deepEqual(stale, {
			fail: `${file} has no 20-green soak record for its current bytes. Run bin/evf escape soak ${file} in the OPS-900 worktree.`,
		});

		// Failure on run n: the soak ends there and records the failure; the gate still fails.
		let calls = 0;
		const failed = output(() =>
			soak(f.root, task, join(wt, file), () => ({ code: ++calls === 7 ? 1 : 0, stdout: "", stderr: "flaky" })),
		);
		assert.equal(calls, 7);
		const record = JSON.parse(readFileSync(soakPath(f.root, task, hash()), "utf8"));
		assert.deepEqual([record.passed, record.runs, record.failedRun], [false, 7, 7]);
		assert.match(readFileSync(record.log, "utf8"), /--- run 7: exit 1\n\nflaky/);
		assert.match(failed, /FAILED on run 7 of 20-run soak/);
		assert.ok("fail" in uiEscapedGate(f.root, wt, task, base));
	} finally {
		f.close();
	}
});

test("OPS-114-11: no CI workflow runs the escaped-bug tests or the ui-escaped check", () => {
	const dir = join(source, ".github/workflows");
	const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
	assert.ok(files.length > 0);
	for (const name of files) {
		const text = readFileSync(join(dir, name), "utf8");
		assert.doesNotMatch(text, /tests\/ui\/escaped|ui-escaped/, `${name} must not run the local-only escaped checks`);
		assert.doesNotMatch(text, /test:ui\b/, `${name} must not run tests/ui, which includes tests/ui/escaped/`);
	}
});
