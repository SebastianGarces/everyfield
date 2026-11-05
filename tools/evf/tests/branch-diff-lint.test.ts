import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { checkBranchDiffTests, describeRefusal, lintBranchDiffSource } from "../branch-diff-lint.ts";

const inTest = (body: string) => `test("t", () => {\n${body}\n});\n`;
const lines = (text: string) => lintBranchDiffSource("x.test.ts", text).map((r) => [r.line, r.read]);

const REFUSED: Array<[string, string, Array<[number, string]>]> = [
	["direct, cwd source", inTest(`spawnSync("git", ["diff", "main...HEAD"], { cwd: source });`), [[2, "git diff"]]],
	["direct log", inTest(`execFileSync("git", ["log", "--format=%H"], { cwd: source });`), [[2, "git log"]]],
	["-C source", inTest(`spawnSync("git", ["-C", source, "merge-base", "HEAD", "main"]);`), [[2, "git merge-base"]]],
	["no cwd", inTest(`spawnSync("git", ["rev-list", "main..HEAD"], { encoding: "utf8" });`), [[2, "git rev-list"]]],
	["no options", inTest(`spawnSync("git", ["cherry", "main"]);`), [[2, "git cherry"]]],
	["process.cwd()", inTest(`spawnSync("git", ["diff"], { cwd: process.cwd() });`), [[2, "git diff"]]],
	[
		"import.meta",
		inTest(`spawnSync("git", ["diff"], { cwd: join(import.meta.dirname, "../..") });`),
		[[2, "git diff"]],
	],
	["path under source", inTest(`spawnSync("git", ["-C", join(source, "tools"), "log"]);`), [[2, "git log"]]],
	["alias of source", inTest(`const repo = source;\nspawnSync("git", ["diff"], { cwd: repo });`), [[3, "git diff"]]],
	["--git-dir of source", inTest(`spawnSync("git", ["--git-dir", join(source, ".git"), "log"]);`), [[2, "git log"]]],
	["show with a revision", inTest('spawnSync("git", ["-C", source, "show", `${rev}:x.ts`]);'), [[2, "git show"]]],
	["lib git", inTest(`git(source, "diff", "--name-only", "main");`), [[2, "git diff"]]],
	["shell string", inTest(`execSync("git diff --name-only origin/main...HEAD");`), [[2, "git diff"]]],
	["shell template", inTest("execSync(`git -C ${source} log main..HEAD`);"), [[2, "git log"]]],
	["shell after cd", inTest("execSync(`cd ${source} && git log`, { cwd: f.root });"), [[2, "git log"]]],
	["sh -c", inTest(`spawnSync("sh", ["-c", "git merge-base HEAD main"], { cwd: source });`), [[2, "git merge-base"]]],
	[
		"OPS-125: a file-local helper called with source",
		`function check(repo: string) {
	const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	const commits = git("log", "--no-merges", "HEAD");
	return commits;
}
${inTest("check(source);")}`,
		[[7, "git log"]],
	],
	[
		"a variadic helper with no cwd",
		`const g = (...x: string[]) => execFileSync("git", x);\n${inTest(`g("diff", "main");`)}`,
		[[3, "git diff"]],
	],
	[
		"an array parameter",
		`const g = (repo: string, args: string[]) => spawnSync("git", ["-C", repo, ...args]);\n${inTest(`g(source, ["log"]);`)}`,
		[[3, "git log"]],
	],
	[
		"a helper that passes its argument to another helper",
		`const read = (r: string) => spawnSync("git", ["diff"], { cwd: r });
const outer = (r: string) => read(r);
${inTest("outer(source);")}`,
		[[4, "git diff"]],
	],
	[
		"helpers that call each other, called with source",
		`const a = (r: string) => {
	b(r);
	spawnSync("git", ["log"], { cwd: r });
};
const b = (r: string) => a(r);
${inTest("a(source);")}`,
		[[7, "git log"]],
	],
	[
		"helpers that call each other, with the argv in a rest parameter",
		`const a = (...x: string[]) => {
	b(...x);
	execFileSync("git", x);
};
const b = (...x: string[]) => a(...x);
${inTest(`a("log");`)}`,
		[[7, "git log"]],
	],
];

for (const [name, text, expected] of REFUSED)
	test(`OPS-136: the lint refuses ${name} AC:OPS-136-6`, () => {
		assert.deepEqual(lines(text), expected);
	});

test("OPS-136: a refusal names the file, the line and the fix AC:OPS-136-6", () => {
	const refusals = lintBranchDiffSource(
		"tools/evf/tests/x.test.ts",
		`function check(repo: string) {\n\treturn spawnSync("git", ["log"], { cwd: repo });\n}\n${inTest("check(source);")}`,
	);
	assert.equal(refusals.length, 1);
	const message = describeRefusal(refusals[0]!);
	assert.match(message, /^tools\/evf\/tests\/x\.test\.ts:5: reads the branch diff of the current checkout: git log\./);
	assert.match(message, /Fix: read the diff in a repository the test builds itself/);
});

const ACCEPTED: Array<[string, string]> = [
	[
		"helpers that call each other, called with a fixture",
		`const a = (r: string) => {
	b(r);
	spawnSync("git", ["log"], { cwd: r });
};
const b = (r: string) => a(r);
${inTest("a(fixture().root);")}`,
	],
	["fixture()", inTest(`const f = fixture();\nf.git("diff", "main");\nspawnSync("git", ["-C", f.root, "log"]);`)],
	[
		"a fixture worktree",
		inTest(`const f = fixture();\nconst wt = f.task("wp-1");\nspawnSync("git", ["log"], { cwd: wt });`),
	],
	[
		"a temporary git init",
		inTest(
			`const dir = mkdtempSync(join(tmpdir(), "x-"));\nspawnSync("git", ["init"], { cwd: dir });\nspawnSync("git", ["diff", "a", "b"], { cwd: dir });`,
		),
	],
	[
		"--git-dir on a fixture remote",
		inTest(`const f = fixture();\nconst remote = f.bare("o");\nspawnSync("git", ["--git-dir", remote, "log", "-1"]);`),
	],
	["git -C source ls-files", inTest(`spawnSync("git", ["-C", source, "ls-files", "packages"], { encoding: "utf8" });`)],
	["git rev-parse in source", inTest(`spawnSync("git", ["rev-parse", "HEAD"], { cwd: source });`)],
	["show with no revision", inTest(`spawnSync("git", ["show", "--stat"], { cwd: source });`)],
	[
		"git text in fixture content",
		inTest(
			`writeFileSync(hook, "#!/bin/sh\\ngit diff main...HEAD\\n");\nwriteFileSync(p, 'spawnSync("git", ["log"], { cwd: source })');\nwriteFileSync(q, \`execSync("git log")\`);`,
		),
	],
	["git text in a comment", inTest(`// spawnSync("git", ["diff"], { cwd: source })\nconst x = 1; /* git log */`)],
	["a regex that holds a quote", inTest(`assert.match(x, /"git" \\["diff"\\]/);\nassert.match(y, /a'b/);`)],
	[
		"a helper called only on a fixture",
		`const read = (r: string) => spawnSync("git", ["diff"], { cwd: r });\n${inTest("read(fixture().root);")}`,
	],
	["a helper nobody calls", `const read = (r: string) => spawnSync("git", ["diff"], { cwd: r });\n`],
	["a method named like the helper", inTest(`repo.run("log");\nf.git("merge-base", "a", "b");`)],
	[
		"a local source parameter on a fixture",
		`const read = (source: string) => spawnSync("git", ["log"], { cwd: source });\n${inTest("read(fixture().root);")}`,
	],
];

for (const [name, text] of ACCEPTED)
	test(`OPS-136: the lint accepts ${name} AC:OPS-136-7`, () => {
		assert.deepEqual(lines(text), []);
	});

test("OPS-136: the decision is per test block: one file holds a refused block and an accepted block AC:OPS-136-7", () => {
	const text = `function changed(repo: string) {
	return spawnSync("git", ["diff", "main"], { cwd: repo });
}
${inTest(`const f = fixture();\nchanged(f.root);`)}${inTest("changed(source);")}`;
	assert.deepEqual(lines(text), [[9, "git diff"]], "only the call in the second block");
});

function repoWith(testFile: string) {
	const f = fixture();
	mkdirSync(join(f.root, "tools/evf/tests"), { recursive: true });
	mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
	writeFileSync(join(f.root, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: bin/evf test\n");
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
	const started = join(f.root, "started.txt");
	writeFileSync(
		join(f.root, "tools/evf/tests/one.test.ts"),
		`import test from "node:test";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const source = process.cwd();
writeFileSync(${JSON.stringify(started)}, "started");
test("one", () => {
${testFile}
});
`,
	);
	const evfTest = () => {
		const env: NodeJS.ProcessEnv = { ...process.env, EVF_RUN: "", EVF_WORKTREE: "" };
		delete env.NODE_TEST_CONTEXT;
		return spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "test"], {
			cwd: f.root,
			encoding: "utf8",
			env,
		});
	};
	return { f, started, evfTest };
}

test("OPS-136: evf test prints the refusal, exits non-zero and starts no tests; a clean tree goes on to node --test AC:OPS-136-8", () => {
	const refused = repoWith(
		`spawnSync("git", ["-C", "elsewhere", "status"]);\nspawnSync("git", ["log"], { cwd: source });`,
	);
	try {
		const r = refused.evfTest();
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /tools\/evf\/tests\/one\.test\.ts:8: reads the branch diff/);
		assert.equal(existsSync(refused.started), false, "no test started");
	} finally {
		refused.f.close();
	}
	const clean = repoWith(`spawnSync("git", ["-C", source, "ls-files"]);`);
	try {
		const r = clean.evfTest();
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(existsSync(clean.started), true, "node --test ran the test");
	} finally {
		clean.f.close();
	}
	assert.match(
		readFileSync(join(source, ".github/workflows/ci.yml"), "utf8"),
		/^ +- run: bin\/evf test( \$\{\{ .* \}\})?$/m,
	);
});

test("OPS-136: the lint passes on the real tools/evf/tests AC:OPS-136-9", () => {
	checkBranchDiffTests(source);
});
