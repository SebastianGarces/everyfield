// T-41: `bin/dev nightly` with fake probes, a fake preview and a fake gh, and the coverage map writer on a real
// throwaway repository whose test reaches a source file only through a child process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coverageMap, type Gh, nightly, type NightlyDeps, nightlyLog, reportFailure } from "../../scripts/nightly.ts";

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
		coverage: () => (
			events.push("coverage"),
			{ passed: 40, failed: 0, tests: { "tests/workflow/dev.test.mjs": ["scripts/dev.ts"] } }
		),
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
	await t.test("the pool fills while coverage runs: no preview, no browser", async (t) => {
		const dir = home(t);
		let asked = 0;
		const { d, events } = deps(dir, {
			slot: async () => (++asked === 1 ? null : "No free preview slot: 4/4 previews in use"),
		});
		await nightly(d);
		assert.deepEqual(events, ["checkout", "coverage", "remove"]);
		assert.deepEqual(
			lines(dir).map((l) => [l.type, l.suite]),
			[
				["nightly_result", "coverage"],
				["nightly_skipped", "tests/ui"],
			],
		);
	});
});

test("T-41 a nightly run writes the map, runs one engine at a time and closes its preview", async (t) => {
	const dir = home(t);
	const { d, events } = deps(dir);
	await nightly(d);
	assert.deepEqual(events, [
		"slot nightly",
		"checkout",
		"coverage",
		"slot /w",
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
			at: "1970-01-01T00:00:03.000Z",
			head: HEAD,
			suite: "coverage",
			passed: 40,
			failed: 0,
			durationMs: 2000,
		},
		{
			type: "nightly_result",
			at: "1970-01-01T00:00:05.000Z",
			head: HEAD,
			suite: "tests/ui chromium",
			passed: 10,
			failed: 0,
			durationMs: 1000,
		},
		{
			type: "nightly_result",
			at: "1970-01-01T00:00:07.000Z",
			head: HEAD,
			suite: "tests/ui webkit",
			passed: 10,
			failed: 0,
			durationMs: 1000,
		},
	]);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "coverage-map.json"), "utf8")), {
		head: HEAD,
		createdAt: "1970-01-01T00:00:02.000Z",
		tests: { "tests/workflow/dev.test.mjs": ["scripts/dev.ts"] },
	});
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

test("T-41 the coverage map records what each test reached, also through a child process", (t) => {
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
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	const map = coverageMap(root);
	assert.deepEqual(map, {
		passed: 2,
		failed: 0,
		tests: {
			"tests/workflow/cli.test.mjs": ["scripts/cli.mjs", "scripts/lib.mjs"],
			"tests/workflow/plain.test.mjs": [],
		},
	});
	assert.ok(!existsSync(join(root, "coverage")));
});
