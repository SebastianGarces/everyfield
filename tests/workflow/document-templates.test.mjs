import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../../scripts/lint/check-repo-files.mjs", import.meta.url));
const documents = "packages/domain/src/documents";
const listed = `${documents}/templates/listed-content.ts`;
const commented = `${documents}/templates/commented-content.ts`;

function check(t, files) {
	const dir = mkdtempSync(join(tmpdir(), "document-templates-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const put = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	put(
		"evf.toml",
		`[[policy.class]]\nname = "document-templates"\npaths = [\n  "${listed}",\n  # "${commented}",\n]\noutcome = "owner"\n`,
	);
	put(`${documents}/templates/.keep`, "");
	for (const file of files) put(file, "export {};\n");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const { status, stderr } = spawnSync(process.execPath, [CHECK], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, EVERYFIELD_ROOT: dir },
	});
	return { status, failures: stderr.split("\n").slice(1).filter(Boolean), stderr };
}

test("a listed content file and other document code pass", (t) => {
	const { status, stderr } = check(t, [listed, `${documents}/render.ts`]);
	assert.equal(status, 0, stderr);
});

test("an unlisted content file anywhere under documents, or an unlisted template JSON, fails by name", (t) => {
	const unlisted = [
		`${documents}/templates/new.json`,
		`${documents}/templates/new-content.ts`,
		`${documents}/templates/sub/new-content.ts`,
		`${documents}/top-content.ts`,
		commented,
	];
	const { status, failures } = check(t, [listed, ...unlisted]);
	assert.equal(status, 1);
	assert.deepEqual(
		failures.sort(),
		unlisted
			.map((file) => `${file}: is not in the document-templates owner class of evf.toml; add its exact path there`)
			.sort(),
	);
});
