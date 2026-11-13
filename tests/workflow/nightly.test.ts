// T-41, T-216: `bin/dev nightly` with fake probes, a fake preview and a fake gh, and the coverage map writer the GitHub
// nightly runs, on a real throwaway repository whose test reaches a source file only through a child process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseCoverageMap } from "../../tools/ci/select.ts";
import {
	counts,
	coverageMap,
	coverageMapCommand,
	type Gh,
	nightly,
	type NightlyDeps,
	nightlyLog,
	reportFailure,
} from "../../scripts/nightly.ts";

const HEAD = "f".repeat(40);

function home(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "evf-nightly-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const lines = (dir: string) =>
	readFileSync(nightlyLog(dir), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);

/** Fake deps that log every effect; any effect not overridden is a plain success. */
function deps(dir: string, over: Partial<NightlyDeps> = {}) {
	const events: string[] = [];
	let clock = 0;
	const d: NightlyDeps = {
		home: dir,
		now: () => (clock += 1000),
		load: () => ({ load: 3, cores: 12 }),
		slot: async (project) => (events.push(`slot ${project}`), null),
		checkout: () => (events.push("checkout"), { head: HEAD, worktree: "/w", remove: () => events.push("remove") }),
		preview: async () => (
			events.push("preview up"),
			{ url: "https://n.localhost:1355", close: () => events.push("preview down") }
		),
		ui: (_w, url, engine) => (events.push(`ui ${engine} ${url}`), { passed: 10, failed: 0 }),
		gh: () => {
			throw new Error("gh must not run for a green nightly");
		},
		log: () => {},
		...over,
	};
	return { d, events };
}

test("T-41 a loaded machine or a full preview pool records nightly_skipped and starts nothing", async (t) => {
	await t.test("load above 2 × cores", async (t) => {
		const dir = home(t);
		const { d, events } = deps(dir, { load: () => ({ load: 24.5, cores: 12 }) });
		await nightly(d);
		assert.deepEqual(events, []);
		assert.deepEqual(lines(dir), [
			{
				type: "nightly_skipped",
				at: "1970-01-01T00:00:01.000Z",
				head: null,
				suite: "all",
				reason: "the 1-minute load 24.5 is above 2 × 12 cores",
			},
		]);
	});
	await t.test("load exactly 2 × cores still runs", async (t) => {
		const { d, events } = deps(home(t), { load: () => ({ load: 24, cores: 12 }) });
		await nightly(d);
		assert.ok(events.includes("preview up"));
	});
	await t.test("no free preview slot", async (t) => {
		const dir = home(t);
		const { d, events } = deps(dir, { slot: async () => "No free preview slot: 4/4 previews in use" });
		await nightly(d);
		assert.deepEqual(events, []);
		assert.deepEqual(
			lines(dir).map((l) => [l.type, l.suite, l.reason]),
			[["nightly_skipped", "all", "No free preview slot: 4/4 previews in use"]],
		);
	});
});

test("T-216 a local nightly runs only tests/ui, one engine at a time, closes its preview and writes no coverage map", async (t) => {
	const dir = home(t);
	const { d, events } = deps(dir);
	await nightly(d);
	assert.deepEqual(events, [
		"slot nightly",
		"checkout",
		"preview up",
		"ui chromium https://n.localhost:1355",
		"ui webkit https://n.localhost:1355",
		"preview down",
		"remove",
	]);
	assert.deepEqual(lines(dir), [
		// The fake clock ticks one second per read.
		{
			type: "nightly_result",
			at: "1970-01-01T00:00:02.000Z",
			head: HEAD,
			suite: "tests/ui chromium",
			passed: 10,
			failed: 0,
			durationMs: 1000,
		},
		{
			type: "nightly_result",
			at: "1970-01-01T00:00:04.000Z",
			head: HEAD,
			suite: "tests/ui webkit",
			passed: 10,
			failed: 0,
			durationMs: 1000,
		},
	]);
	assert.equal(existsSync(join(dir, "coverage-map.json")), false);
});

test("T-41 a browser run that throws still closes the preview and removes the worktree", async (t) => {
	const { d, events } = deps(home(t), {
		ui: () => {
			throw new Error("browser crashed");
		},
	});
	await assert.rejects(nightly(d), /browser crashed/);
	assert.deepEqual(events.slice(-2), ["preview down", "remove"]);
});

/** A fake gh with one repository's issues. */
function fakeGh() {
	const calls: string[][] = [];
	const issues: { number: number; body: string; comments: { body: string }[] }[] = [];
	const gh: Gh = (args) => {
		calls.push([...args]);
		const body = args[args.indexOf("--body") + 1];
		if (args[1] === "list") return { status: 0, stdout: JSON.stringify(issues) };
		if (args[1] === "create") issues.push({ number: issues.length + 1, body, comments: [] });
		if (args[1] === "comment") issues.find((i) => i.number === Number(args[2]))!.comments.push({ body });
		return { status: 0, stdout: "" };
	};
	return { gh, calls, issues };
}

test("T-41 a failed nightly reports once per head and suite", async (t) => {
	const dir = home(t);
	const { gh, calls, issues } = fakeGh();
	const failing = (ui: { passed: number; failed: number }) => deps(dir, { gh, ui: () => ui }).d;
	await nightly(failing({ passed: 8, failed: 2 }));
	// Both engines failed: one issue, then one comment for the second suite.
	assert.deepEqual(
		calls.map((c) => c.slice(0, 2).join(" ")),
		["issue list", "issue create", "issue list", "issue comment"],
	);
	assert.equal(issues.length, 1);
	assert.match(
		issues[0].body,
		/^<!-- everyfield-nightly -->\n<!-- nightly:f{40}:tests\/ui chromium -->\nNightly `tests\/ui chromium` failed on main at f{40}: 2 failed, 8 passed/,
	);
	assert.match(issues[0].comments[0].body, /^<!-- nightly:f{40}:tests\/ui webkit -->/);
	// A second run on the same head adds nothing.
	await nightly(failing({ passed: 8, failed: 2 }));
	assert.equal(calls.length, 4);
	assert.equal(issues[0].comments.length, 1);
	// Without the local ledger, the issue itself still says the key is known.
	rmSync(join(dir, "nightly-reported.json"));
	const entry = {
		type: "nightly_result",
		at: "x",
		head: HEAD,
		suite: "tests/ui webkit",
		passed: 8,
		failed: 2,
		durationMs: 1,
	} as const;
	assert.equal(reportFailure(dir, gh, entry), "known");
	assert.equal(issues[0].comments.length, 1);
	// A new head comments once.
	assert.equal(reportFailure(dir, gh, { ...entry, head: "e".repeat(40) }), "commented");
	assert.equal(reportFailure(dir, gh, { ...entry, head: "e".repeat(40) }), "known");
	assert.equal(issues[0].comments.length, 2);
});

/** A throwaway repository with selectable tests, committed so the coverage-map command can name its HEAD. */
function coverageRepo(t: { after(fn: () => void): void }, files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "evf-coverage-repo-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
			cwd: root,
			encoding: "utf8",
		});
	git("init", "-q");
	git("add", ".");
	git("commit", "-qm", "base");
	return { root, head: git("rev-parse", "HEAD").trim() };
}

test("T-216 the GitHub nightly's coverage-map command writes a map parseCoverageMap accepts, and none when a test fails", (t) => {
	const lib = "export const add = (a, b) => a + b;\n";
	const passing = [
		'import { test } from "node:test";',
		'import assert from "node:assert/strict";',
		'import { add } from "../../scripts/lib.mjs";',
		'test("adds", () => assert.equal(add(1, 2), 3));',
	].join("\n");
	const { root, head } = coverageRepo(t, { "scripts/lib.mjs": lib, "tests/workflow/add.test.mjs": passing });
	const out = join(home(t), "coverage-map.json");
	const at = new Date("2026-11-13T07:30:00.000Z");
	assert.equal(
		coverageMapCommand([out], root, () => at),
		0,
	);
	const map = parseCoverageMap(readFileSync(out, "utf8"));
	assert.deepEqual(map, {
		head,
		createdAt: "2026-11-13T07:30:00.000Z",
		tests: { "tests/workflow/add.test.mjs": ["scripts/lib.mjs"] },
	});

	const failing = coverageRepo(t, {
		"scripts/lib.mjs": lib,
		"tests/workflow/add.test.mjs": passing,
		"tests/workflow/broken.test.mjs":
			'import { test } from "node:test";\ntest("fails", () => { throw new Error("no"); });\n',
	});
	const none = join(home(t), "coverage-map.json");
	assert.equal(coverageMapCommand([none], failing.root), 1);
	assert.equal(existsSync(none), false, "a failing coverage run writes no map, so the workflow uploads none");
	assert.equal(coverageMapCommand([], root), 2);
});

test("T-41 the coverage map records what each test ran or read, also through a child process", (t) => {
	const root = mkdtempSync(join(tmpdir(), "evf-coverage-repo-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const files: Record<string, string> = {
		"scripts/lib.mjs": "export const add = (a, b) => a + b;\n",
		"scripts/cli.mjs": 'import { add } from "./lib.mjs";\nconsole.log(add(1, 2));\n',
		"scripts/unused.mjs": "export {};\n",
		"tests/workflow/cli.test.mjs": [
			'import { test } from "node:test";',
			'import assert from "node:assert/strict";',
			'import { execFileSync } from "node:child_process";',
			'test("cli adds", () => assert.equal(execFileSync(process.execPath, ["scripts/cli.mjs"], { encoding: "utf8" }), "3\\n"));',
		].join("\n"),
		"tests/workflow/plain.test.mjs": 'import { test } from "node:test";\ntest("nothing", () => {});\n',
		// Reads that V8 coverage cannot see: a file as text here, a directory listing and a text read in a child.
		"docs/notes.md": "# notes\n",
		"docs/unread.md": "# unread\n",
		"cases/a.json": "{}\n",
		"scripts/list.mjs":
			'import { readdirSync } from "node:fs";\nimport { readFile } from "node:fs/promises";\nconsole.log(readdirSync("cases").length, (await readFile("docs/notes.md", "utf8")).length);\n',
		"tests/workflow/reads.test.mjs": [
			'import { test } from "node:test";',
			'import { readFileSync } from "node:fs";',
			'import { execFileSync } from "node:child_process";',
			'test("reads", () => {',
			'	readFileSync("docs/notes.md", "utf8");',
			'	readFileSync("/etc/hosts", "utf8");',
			'	execFileSync(process.execPath, ["scripts/list.mjs"]);',
			"});",
		].join("\n"),
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	const map = coverageMap(root);
	assert.deepEqual(map, {
		passed: 3,
		failed: 0,
		tests: {
			"tests/workflow/cli.test.mjs": ["scripts/cli.mjs", "scripts/lib.mjs"],
			"tests/workflow/plain.test.mjs": [],
			"tests/workflow/reads.test.mjs": ["cases/", "docs/notes.md", "scripts/list.mjs"],
		},
	});
	assert.ok(!existsSync(join(root, "coverage")));
});

test("T-41 suite counts come from the run's own summary, not a nested run it printed first", () => {
	const nested = "ℹ tests 33\nℹ pass 29\nℹ fail 4\n";
	assert.deepEqual(counts(`${nested}✔ outer\nℹ tests 1\nℹ pass 1\nℹ fail 0\n`), { passed: 1, failed: 0 });
	assert.deepEqual(counts("# tests 3\n# pass 2\n# fail 1\n"), { passed: 2, failed: 1 });
	assert.deepEqual(counts("Error: cannot find module"), { passed: 0, failed: 1 });
});
