import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const COPIED = [
	"bin/dev",
	"bin/lib/node24.sh",
	"scripts/dev.ts",
	"scripts/browser.ts",
	"scripts/fast-check.ts",
	"scripts/checklist.ts",
	"scripts/package.json",
	"docs/reliability-checklist.json",
];
const temps = [];
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "checklist-")));
	temps.push(dir);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: join(dir, ".gitconfig-none"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@everyfield.invalid",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@everyfield.invalid",
	};
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
	const git = (...args) => {
		const run = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
	};
	const write = (file, content) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content);
	};
	for (const file of COPIED) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		copyFileSync(join(repo, file), join(dir, file));
	}
	write("tests/integration/notice.test.mts", 'const token = "abc";\n');
	git("init", "-q", "-b", "main");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	git("switch", "-q", "-c", "work");
	const checklist = () => {
		const run = spawnSync(join(dir, "bin/dev"), ["checklist"], { cwd: dir, env, encoding: "utf8" });
		return { status: run.status, stdout: run.stdout, stderr: run.stderr };
	};
	return { write, git, checklist };
}

test("bin/dev checklist prints the one item whose path glob and added-line regex match the branch diff", () => {
	const { write, git, checklist } = fixture();
	write("tests/integration/notice.test.mts", 'const token = "abc";\nconst tampered = token.slice(0, -1) + "x";\n');
	git("commit", "-q", "-am", "tamper the token");
	assert.deepEqual(checklist(), {
		status: 0,
		stdout:
			"tampered-or-random-test-token\n" +
			"  Check: Does every tampered or random token in this test change bytes that always alter the decoded value, never only `base64url` padding bits or a value that can repeat?\n" +
			"  Source: CASE-NTF-016 (T-242 Done 2): the tamper flake that failed main's CI on #850 (issue #873), fixed in #874\n",
		stderr: "",
	});
});

test("bin/dev checklist says no item matches when a trigger's path matches but its regex does not", () => {
	const { write, git, checklist } = fixture();
	write("tests/integration/notice.test.mts", 'const token = "abcd";\n');
	write("README.md", "Fixture.\n");
	git("add", ".");
	git("commit", "-q", "-m", "plain change");
	assert.deepEqual(checklist(), { status: 0, stdout: "No checklist items match this diff.\n", stderr: "" });
});
