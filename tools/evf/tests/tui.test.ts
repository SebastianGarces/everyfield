import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { buildNeeded, crateDir, tuiPlan } from "../tui.ts";
import { workDbPath } from "../db.ts";
import { evfDataDir } from "../lib.ts";

const cli = (cwd: string, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd, encoding: "utf8" });

test("OPS-61-tui: evf tui --dry-run names the store, the cached binary and whether cargo must build, without cargo", () => {
	const f = fixture();
	try {
		// The CLI resolves the home root through git, which returns the real path of a symlinked temp dir.
		const root = realpathSync(f.root);
		const first = cli(f.root, "tui", "--dry-run");
		assert.equal(first.status, 0, first.stderr);
		const lines = Object.fromEntries(
			first.stdout
				.trim()
				.split("\n")
				.map((l) => l.split(/: (.*)/s).slice(0, 2)),
		) as Record<string, string>;
		assert.equal(lines.db, workDbPath(root));
		assert.equal(lines.crate, join(source, "tools/evf-tui"));
		assert.equal(lines.binary, join(evfDataDir(root), "bin", "evf-tui"));
		assert.equal(lines.build, "needed (binary missing)");
		assert.match(
			lines.cargo,
			/^cargo build --release --locked --manifest-path .*tools\/evf-tui\/Cargo\.toml --target-dir .*\/evf\/cargo-target$/,
		);
		assert.ok(lines.cargo.endsWith(join(evfDataDir(root), "cargo-target")), "the build lands under the Git common dir");

		// A binary newer than every source is current; one older than a source is stale.
		mkdirSync(join(evfDataDir(root), "bin"), { recursive: true });
		writeFileSync(lines.binary, "#!/bin/sh\nexit 0\n");
		const current = cli(f.root, "tui", "--dry-run");
		assert.equal(current.status, 0, current.stderr);
		assert.match(current.stdout, /^build: current \(binary newer than every source\)$/m);
		const old = new Date("2000-01-01T00:00:00Z");
		utimesSync(lines.binary, old, old);
		const stale = cli(f.root, "tui", "--dry-run");
		assert.match(stale.stdout, /^build: needed \(sources newer than the binary\)$/m);

		// The plan refuses a checkout without the crate, and extra arguments are a usage error.
		assert.throws(() => tuiPlan(root, join(f.root, "no-such-crate")), /TUI crate is missing/);
		assert.deepEqual(buildNeeded(crateDir(), join(f.root, "absent")), { needed: true, reason: "binary missing" });
		const usage = cli(f.root, "tui", "--dry-run", "extra");
		assert.equal(usage.status, 2);
		assert.match(usage.stderr, /Unknown command: evf tui/);
	} finally {
		f.close();
	}
});
