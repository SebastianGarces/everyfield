import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { source } from "./fixtures.ts";
// @ts-expect-error plain ESM script with no types
import { assertDevelopmentDatabase, composeEnv } from "../../../.agents/skills/verify-preview/scripts/preview-env.mjs";

const DEV = "ep-dev.example.test";
const MAIN = `# main\nDATABASE_URL="postgres://u:p@${DEV}/db"\nIDENTITY_SECRET=main-secret\nOTHER=main-other\n`;

function files(worktree: string | null) {
	const dir = mkdtempSync(join(tmpdir(), "evf-preview-env-"));
	const main = join(dir, "main.env"),
		wt = join(dir, "wt.env");
	writeFileSync(main, MAIN);
	if (worktree !== null) writeFileSync(wt, worktree);
	return { main, wt, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("OPS-71: no worktree file gives the main file's env", () => {
	const f = files(null);
	try {
		const env = composeEnv(f.main, f.wt);
		assert.equal(env.DATABASE_URL, `postgres://u:p@${DEV}/db`);
		assert.equal(env.IDENTITY_SECRET, "main-secret");
	} finally {
		f.done();
	}
});

test("OPS-71: a seed-only worktree file overrides IDENTITY_* and keeps the shared DATABASE_URL", () => {
	const f = files("IDENTITY_SECRET=seed-secret\nIDENTITY_ORIGIN='http://seed.test'\n");
	try {
		const env = composeEnv(f.main, f.wt);
		assert.equal(env.DATABASE_URL, `postgres://u:p@${DEV}/db`);
		assert.equal(env.IDENTITY_SECRET, "seed-secret");
		assert.equal(env.IDENTITY_ORIGIN, "http://seed.test");
		assert.equal(env.OTHER, "main-other");
	} finally {
		f.done();
	}
});

test("OPS-71: a full copy of the main file composes to the same env", () => {
	const f = files(MAIN);
	try {
		assert.deepEqual(composeEnv(f.main, f.wt), composeEnv(f.main, join(f.main, "absent")));
		assert.equal(composeEnv(f.main, f.wt).DATABASE_URL, `postgres://u:p@${DEV}/db`);
	} finally {
		f.done();
	}
});

test("OPS-71: a non-development DATABASE_URL host is refused and the message shows no value", () => {
	const f = files("DATABASE_URL=postgres://u:hunter2@prod.example.test/db\n");
	try {
		const env = composeEnv(f.main, f.wt);
		assert.throws(
			() => assertDevelopmentDatabase(env, [DEV]),
			(e: Error) => /Refused/.test(e.message) && !/hunter2|prod\.example/.test(e.message),
		);
		assert.throws(() => assertDevelopmentDatabase({}, [DEV]), /Refused/);
		assert.doesNotThrow(() => assertDevelopmentDatabase(composeEnv(f.main, join(f.main, "absent")), [DEV]));
	} finally {
		f.done();
	}
});

test("OPS-71: preview.mjs never writes the worktree's apps/web/.env.local", () => {
	const script = readFileSync(join(source, ".agents/skills/verify-preview/scripts/preview.mjs"), "utf8");
	assert.doesNotMatch(script, /copyFileSync|unlinkSync|rmSync|"rm"|"cp"/);
});

test("OPS-71: settings.json has no git push ask rule and keeps the main, force and mirror push denials", () => {
	const { permissions } = JSON.parse(readFileSync(join(source, ".claude/settings.json"), "utf8"));
	assert.deepEqual((permissions.ask ?? []).filter((r: string) => /git push/.test(r)), []);
	for (const rule of [
		"Bash(git push *--force*)",
		"Bash(git push -f*)",
		"Bash(git push * -f*)",
		"Bash(git push * +*)",
		"Bash(git push --mirror*)",
		"Bash(git push * --mirror*)",
		"Bash(git push * main)",
		"Bash(git push * main *)",
		"Bash(git push *:main*)",
		"Bash(git push *:refs/heads/main*)",
	])
		assert.ok(permissions.deny.includes(rule), rule);
});
