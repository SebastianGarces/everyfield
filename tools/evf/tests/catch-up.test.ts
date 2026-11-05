// OPS-146: a stale home checkout fast-forwards and the command reruns on the new code, or evf refuses as before.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, fixture } from "./fixtures.ts";
import { evfDataDir } from "../lib.ts";

const CODE = 'console.log("new code ran:", process.argv.slice(2).join(" ")); process.exit(7);\n';

/**
 * A home checkout at `old` whose origin/main is one commit ahead, with new evf code in `tools/evf/main.ts`. A real evf
 * process without the test preload runs this repository's code, which differs from the fixture's main, so it is stale.
 */
function stale(newCode = CODE) {
	const f = fixture();
	const write = (path: string, text: string) => {
		mkdirSync(join(f.root, path, ".."), { recursive: true });
		writeFileSync(join(f.root, path), text);
	};
	f.git("remote", "add", "origin", f.bare(join(f.root, "fake-bin/origin.git")));
	write("tools/evf/main.ts", "throw new Error('old code');\n");
	write("bin/evf", "#!/bin/sh\n");
	write("shared.md", "Old.\n");
	f.git("add", "tools/evf/main.ts", "bin/evf", "shared.md");
	f.git("commit", "-qm", "Old evf code");
	f.git("push", "-q", "origin", "main");
	const old = f.git("rev-parse", "HEAD");
	write("tools/evf/main.ts", newCode);
	write("shared.md", "New.\n");
	f.git("add", "tools/evf/main.ts", "shared.md");
	f.git("commit", "-qm", "New evf code");
	f.git("push", "-q", "origin", "main");
	const next = f.git("rev-parse", "HEAD");
	f.git("reset", "-q", "--hard", old);
	const evf = (...args: string[]) => cli(f.root, { NODE_OPTIONS: "" }, ...args);
	return { ...f, write, old, next, evf };
}

for (const args of [
	["ship", "OPS-1"],
	["drive", "OPS-1"],
	["drive", "OPS-1", "--once"],
])
	test(`AC:OPS-146-5 evf ${args.join(" ")} fast-forwards a stale home checkout and reruns on the new code`, () => {
		const f = stale();
		try {
			const r = f.evf(...args);
			assert.equal(f.git("rev-parse", "HEAD"), f.next);
			assert.equal(r.stdout, `new code ran: ${args.join(" ")}\n`);
			assert.equal(r.status, 7, "the exit code is the rerun's");
			assert.ok(r.stderr.includes(`moved from ${f.old.slice(0, 10)} to ${f.next.slice(0, 10)}`), r.stderr);
		} finally {
			f.close();
		}
	});

test("AC:OPS-146-5 local changes that main did not touch stay through the fast-forward", () => {
	const f = stale();
	try {
		f.write("evf.config.json", `${readFileSync(join(f.root, "evf.config.json"), "utf8")}\n`);
		const local = readFileSync(join(f.root, "evf.config.json"), "utf8");
		assert.equal(f.evf("drive", "OPS-1").status, 7);
		assert.equal(f.git("rev-parse", "HEAD"), f.next);
		assert.equal(readFileSync(join(f.root, "evf.config.json"), "utf8"), local);
	} finally {
		f.close();
	}
});

for (const [name, code] of [
	["fails at its start", "throw new Error('new code broke');\n"],
	["ends with success", 'console.log("new code ran"); process.exit(0);\n'],
])
	test(`AC:OPS-146-6 the old process does nothing more after the fast-forward when the new code ${name}`, () => {
		const f = stale(code);
		try {
			for (const args of [
				["ship", "OPS-1"],
				["drive", "OPS-1"],
			]) {
				f.git("reset", "-q", "--hard", f.old);
				const s = f.getState();
				s.calls = [];
				f.setState(s);
				const r = f.evf(...args);
				assert.equal(f.git("rev-parse", "HEAD"), f.next);
				assert.equal(r.status === 0, name === "ends with success", r.stderr);
				if (r.status !== 0) assert.match(r.stderr, /new code broke/);
				// The old code's next steps: a refusal, a GitHub call, a drive's pid file.
				assert.doesNotMatch(r.stderr, /does not merge|does not start|worktree|No open PR/);
				assert.deepEqual(f.getState().calls, []);
				assert.equal(existsSync(join(evfDataDir(f.root), "drive/ops-1.pid")), false);
			}
		} finally {
			f.close();
		}
	});

const REFUSALS: Array<[string, (f: ReturnType<typeof stale>) => () => void]> = [
	[
		"has its own commit",
		(f) => {
			f.write("own.md", "Own.\n");
			f.git("add", "own.md");
			f.git("commit", "-qm", "A commit only here");
			return () => assert.equal(readFileSync(join(f.root, "own.md"), "utf8"), "Own.\n");
		},
	],
	[
		"has an uncommitted change in tools/evf",
		(f) => {
			f.write("tools/evf/main.ts", "// Local edit.\n");
			return () => assert.equal(readFileSync(join(f.root, "tools/evf/main.ts"), "utf8"), "// Local edit.\n");
		},
	],
	[
		"has a local change in a file main changed",
		(f) => {
			f.write("shared.md", "Local key.\n");
			return () => assert.equal(readFileSync(join(f.root, "shared.md"), "utf8"), "Local key.\n");
		},
	],
	[
		"is on another branch",
		(f) => {
			f.git("checkout", "-q", "-b", "elsewhere");
			return () => assert.equal(f.git("branch", "--show-current"), "elsewhere");
		},
	],
	[
		"has a detached HEAD",
		(f) => {
			f.git("checkout", "-q", "--detach");
			return () => assert.equal(f.git("branch", "--show-current"), "");
		},
	],
];

for (const [name, setup] of REFUSALS)
	test(`AC:OPS-146-7 a checkout that ${name} refuses as today, and local changes stay`, () => {
		const f = stale();
		try {
			// The control: without the setup, this checkout catches up. So the setup alone causes the refusal below.
			assert.equal(f.evf("drive", "OPS-1").status, 7);
			f.git("reset", "-q", "--hard", f.old);
			const stayed = setup(f),
				before = f.git("rev-parse", "HEAD");
			const r = f.evf("drive", "OPS-1");
			assert.equal(r.status, 1);
			assert.match(r.stderr, /evf drive does not start OPS-1: .*Update the home checkout to main/);
			assert.doesNotMatch(r.stdout, /new code ran/);
			assert.equal(f.git("rev-parse", "HEAD"), before);
			stayed();
		} finally {
			f.close();
		}
	});
