import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script with no types
import { assertDevelopmentDatabase, composeEnv, composePreviewEnv } from "../../../.agents/skills/verify-preview/scripts/preview-env.mjs";

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

test("OPS-71: values parse like dotenv: inline comments dropped, quoted \\n unescaped, multiline kept", () => {
	const f = files(null);
	try {
		writeFileSync(f.wt, 'A=value # note\nB="x\\ny"\nC="line1\nline2"\n');
		const env = composeEnv(f.main, f.wt);
		assert.equal(env.A, "value");
		assert.equal(env.B, "x\ny");
		assert.equal(env.C, "line1\nline2");
	} finally {
		f.done();
	}
});

test("OPS-76: the composed preview env trusts the preview's own URL whatever the env files hold; an explicit config wins", () => {
	const f = files("IDENTITY_ORIGIN='https://stale.localhost'\n");
	try {
		const env = composeEnv(f.main, f.wt);
		assert.equal(env.IDENTITY_ORIGIN, "https://stale.localhost");
		const fixed = { CI: "true" };
		const composed = composePreviewEnv(env, fixed);
		assert.equal(composed.IDENTITY_ORIGIN, "${PREVIEW_URL}");
		assert.equal(composed.CI, "true");
		assert.equal(composed.DATABASE_URL, env.DATABASE_URL);
		assert.equal(composePreviewEnv(env, fixed, { IDENTITY_ORIGIN: "http://explicit.test" }).IDENTITY_ORIGIN, "http://explicit.test");
	} finally {
		f.done();
	}
});
