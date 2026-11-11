// T-180: `bin/dev help` names exactly the checks `bin/dev check` runs (CHECKS), and what GitHub CI runs beyond them.
// A check added to CHECKS, or one dropped from the help, fails here until the help says so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS } from "../select.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function help(): string {
	const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/dev.ts", "help"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(run.status, 0, run.stderr);
	return run.stdout;
}

/** The comma-separated names after `<label>:` on the help line that starts with it. */
function listed(text: string, label: string): string[] {
	const line = text.split("\n").find((row) => row.trimStart().startsWith(`${label}:`));
	assert.ok(line, `bin/dev help has no "${label}:" line`);
	return line
		.slice(line.indexOf(":") + 1)
		.split(",")
		.map((name) => name.trim());
}

test("bin/dev help lists every check in CHECKS and nothing else", () => {
	assert.deepEqual(listed(help(), "checks").sort(), Object.keys(CHECKS).sort());
});

test("bin/dev help names what GitHub CI runs beyond bin/dev check --full", () => {
	const extras = listed(help(), "GitHub CI also runs");
	assert.deepEqual(extras, ["format:check", "build then server-trace", "test:logs", "db", "census", "wiki"]);
	const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");
	for (const step of ["pnpm format:check", "pnpm build", "server-trace.test.mjs", "pnpm test:logs"])
		assert.ok(ci.includes(step), `ci.yml no longer runs ${step}`);
	for (const job of ["db", "census", "wiki"])
		assert.match(ci, new RegExp(`^  ${job}:`, "m"), `ci.yml has no ${job} job`);
});
