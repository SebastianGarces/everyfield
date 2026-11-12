import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const temps = [];
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const temp = (prefix) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	temps.push(dir);
	return dir;
};

const DEV = [
	"bin/dev",
	"bin/lib/node24.sh",
	"scripts/dev.ts",
	"scripts/browser.ts",
	"scripts/fast-check.ts",
	"scripts/package.json",
];
const copyDev = (dir) => {
	for (const file of DEV) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		copyFileSync(join(repo, file), join(dir, file));
	}
};

/**
 * A small workspace repo with the real bin/dev, scripts, hooks, root package.json and Prettier files, and three packages
 * that lint and typecheck like the real ones: `demo` lints from its folder, `rooted` lints from the root with --config
 * (as contracts and reference do), and `app` typechecks and depends on `demo`. node_modules link to this checkout's.
 * main holds a committed file with format and lint errors; the test works on the task branch evf/t-1.
 */
function fixture({ tools = true } = {}) {
	const dir = temp("fast-check-"),
		home = temp("fast-check-home-");
	const globalHooks = join(home, "hooks");
	mkdirSync(globalHooks);
	const gitconfig = join(home, "gitconfig");
	writeFileSync(gitconfig, `[core]\n\thooksPath = ${globalHooks}\n`);
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: gitconfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@everyfield.invalid",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@everyfield.invalid",
	};
	// A seat or CI may set these; the fixture is its own repo, outside CI.
	for (const key of ["CI", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];

	const write = (file, content) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content);
	};
	copyDev(dir);
	for (const file of ["package.json", ".prettierrc", ".prettierignore"])
		copyFileSync(join(repo, file), join(dir, file));
	cpSync(join(repo, "tools/git-hooks"), join(dir, "tools/git-hooks"), { recursive: true });
	write(".gitignore", "node_modules\n");
	write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
	const tsconfig = JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			module: "esnext",
			moduleResolution: "bundler",
			target: "ES2022",
			allowImportingTsExtensions: true,
			skipLibCheck: true,
			types: [],
		},
		include: ["src/**/*.ts"],
	});
	const eslintConfig = (ignores) =>
		`import prettier from "eslint-config-prettier/flat";\nimport tseslint from "typescript-eslint";\nexport default tseslint.config({ ignores: ${JSON.stringify(ignores)} }, ...tseslint.configs.recommended, prettier);\n`;
	const manifest = (name, scripts, dependencies = {}) =>
		JSON.stringify({ name, private: true, type: "module", scripts, dependencies }, null, "\t") + "\n";
	write(
		"packages/demo/package.json",
		manifest("@fx/demo", { lint: "eslint --max-warnings=0 .", typecheck: "tsc --noEmit" }),
	);
	write("packages/demo/eslint.config.mjs", eslintConfig(["src/ignored.ts"]));
	write("packages/demo/tsconfig.json", tsconfig);
	write("packages/demo/src/index.ts", "export const n: number = 1;\n");
	write("packages/demo/src/old.ts", "const   stale = {a:1}\nexport {};\n");
	write("packages/app/package.json", manifest("@fx/app", { typecheck: "tsc --noEmit" }, { "@fx/demo": "workspace:*" }));
	write("packages/app/tsconfig.json", tsconfig);
	write("packages/app/src/index.ts", 'import { n } from "../../demo/src/index.ts";\nexport const m: number = n;\n');
	write(
		"packages/rooted/package.json",
		manifest("@fx/rooted", {
			lint: "cd ../.. && packages/rooted/node_modules/.bin/eslint --config packages/rooted/eslint.config.mjs --max-warnings=0 packages/rooted tests/rooted",
		}),
	);
	write("packages/rooted/eslint.config.mjs", eslintConfig([]));
	write("tests/rooted/ok.ts", "export const ok = 1;\n");
	if (tools) {
		symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
		for (const pkg of ["demo", "app", "rooted"])
			symlinkSync(join(repo, "packages/domain/node_modules"), join(dir, `packages/${pkg}/node_modules`));
	}

	const git = (...args) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
	const ok = (...args) => {
		const run = git(...args);
		assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout.trim();
	};
	ok("init", "-q", "-b", "main");
	ok("add", "-A");
	ok("commit", "-qm", "base");
	ok("checkout", "-qb", "evf/t-1");
	const commit = (files) => {
		for (const [file, content] of Object.entries(files)) write(file, content);
		ok("add", "-A");
		ok("commit", "-qm", "change");
	};
	const dev = (args, extra = {}) =>
		spawnSync(join(dir, "bin/dev"), args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" });
	const check = () => {
		const run = dev(["fast-check", "--json"]);
		const report = JSON.parse(run.stdout);
		return { status: run.status, report, step: (name) => report.steps.find((step) => step.name === name) };
	};
	return { dir, home, env, globalHooks, gitconfig, git, ok, commit, dev, check };
}

test("fast-check fails a changed file's format error, names it and prints the Prettier fix; ignored and unglobbed files are not checked", () => {
	const fx = fixture();
	fx.commit({
		"packages/demo/src/bad.ts": "export const b = {x:1}\n",
		"packages/demo/src/x.generated.ts": "export const g = {x:1}\n",
		"other/outside.ts": "export const o = {x:1}\n",
	});
	const { status, report, step } = fx.check();
	assert.equal(status, 1);
	assert.equal(report.ok, false);
	assert.deepEqual(report.base, { ref: "main", sha: fx.ok("rev-parse", "main") });
	assert.deepEqual(step("format"), {
		...step("format"),
		status: "failed",
		files: ["packages/demo/src/bad.ts"],
		fix: "pnpm exec prettier --write packages/demo/src/bad.ts",
	});
	assert.equal(typeof step("format").ms, "number");
	assert.equal(step("lint").status, "passed");
	assert.equal(step("typecheck").status, "passed");

	const human = fx.dev(["fast-check"]);
	assert.equal(human.status, 1);
	assert.match(human.stdout, /^format +failed \d+ ms\n {2}packages\/demo\/src\/bad\.ts$/m);
	assert.match(human.stdout, /^ {2}fix: pnpm exec prettier --write packages\/demo\/src\/bad\.ts$/m);
});

test("fast-check fails a changed file's lint error with its package's config, from the package folder or the root, and skips ignored and unowned files", () => {
	const fx = fixture();
	const unused = "const unused = 1;\nexport {};\n";
	fx.commit({
		"packages/demo/src/unused.ts": unused,
		"tests/rooted/bad.ts": unused,
		"packages/demo/src/ignored.ts": unused,
		"scripts/loose.mjs": unused,
	});
	const { status, step } = fx.check();
	assert.equal(status, 1);
	const lint = step("lint");
	assert.equal(lint.status, "failed");
	assert.deepEqual(lint.files.sort(), ["packages/demo/src/unused.ts", "tests/rooted/bad.ts"]);
	assert.deepEqual(lint.fix.split(" && ").sort(), [
		"packages/rooted/node_modules/.bin/eslint --config packages/rooted/eslint.config.mjs --fix tests/rooted/bad.ts",
		"pnpm --dir packages/demo exec eslint --fix src/unused.ts",
	]);
	assert.match(lint.detail, /packages\/demo\/src\/unused\.ts:1:7 'unused' is assigned a value but never used/);
	assert.equal(step("format").status, "passed");
});

test("fast-check runs both linters of an Oxlint-first lint script and reports what each one finds (T-43)", () => {
	const fx = fixture();
	fx.commit({
		"packages/both/package.json":
			JSON.stringify(
				{
					name: "@fx/both",
					private: true,
					type: "module",
					scripts: { lint: "oxlint -c .oxlintrc.json --max-warnings=0 . && eslint --max-warnings=0 ." },
				},
				null,
				"\t",
			) + "\n",
		"packages/both/.oxlintrc.json": JSON.stringify({
			plugins: ["typescript"],
			categories: { correctness: "off" },
			rules: { "typescript/no-explicit-any": "error" },
		}),
		"packages/both/eslint.config.mjs": `import tseslint from "typescript-eslint";
export default [{ files: ["**/*.ts"], ...tseslint.configs.base, rules: { "no-restricted-syntax": ["error", "DebuggerStatement"] } }];
`,
		"packages/both/src/any.ts": "export const loose: any = 1;\n",
		"packages/both/src/debug.ts": "export function stop() {\n\tdebugger;\n}\n",
		"packages/both/src/fine.ts": "export const fine = 1;\n",
	});
	symlinkSync(join(repo, "packages/domain/node_modules"), join(fx.dir, "packages/both/node_modules"));
	const { status, step } = fx.check();
	assert.equal(status, 1);
	const lint = step("lint");
	assert.equal(lint.status, "failed");
	assert.deepEqual(lint.files.sort(), ["packages/both/src/any.ts", "packages/both/src/debug.ts"]);
	assert.deepEqual(lint.fix.split(" && ").sort(), [
		"pnpm --dir packages/both exec eslint --fix src/debug.ts",
		"pnpm --dir packages/both exec oxlint -c .oxlintrc.json --fix src/any.ts",
	]);
	assert.match(lint.detail, /packages\/both\/src\/any\.ts:1:21 .*\(typescript\(no-explicit-any\)\)/);
	assert.match(lint.detail, /packages\/both\/src\/debug\.ts:2:2 .*\(no-restricted-syntax\)/);
});

test("fast-check fails a type error in a changed package and in its dependents, names each file and prints the rerun command", () => {
	const fx = fixture();
	fx.commit({
		"packages/demo/src/index.ts": 'export const n: string = "now a string";\n',
		"packages/demo/src/wrong.ts": 'export const w: number = "s";\n',
	});
	const { status, step } = fx.check();
	assert.equal(status, 1);
	const typecheck = step("typecheck");
	assert.equal(typecheck.status, "failed");
	assert.deepEqual(typecheck.files.sort(), ["packages/app/src/index.ts", "packages/demo/src/wrong.ts"]);
	assert.equal(typecheck.fix, "pnpm --filter ...@fx/demo --no-bail --if-present typecheck");
	assert.match(typecheck.detail, /error TS2322/);
	assert.equal(step("lint").status, "passed");
});

test("fast-check passes a branch whose own files are clean, though main holds unchanged format and lint errors", () => {
	const fx = fixture();
	assert.equal(fx.dev(["fast-check", "--base", "HEAD"]).status, 0, "nothing changed since HEAD");
	fx.commit({ "packages/demo/src/fine.ts": "export const fine = 1;\n" });
	const { status, report } = fx.check();
	assert.equal(status, 0);
	assert.deepEqual(report.files, ["packages/demo/src/fine.ts"]);
	assert.deepEqual(
		report.steps.map((step) => [step.name, step.status]),
		[
			["format", "passed"],
			["lint", "passed"],
			["typecheck", "passed"],
		],
	);
});

test("fast-check without node_modules fails each needed step with pnpm install, and passes a docs-only branch", () => {
	const fx = fixture({ tools: false });
	fx.commit({ "docs/note.md": "A note.\n" });
	const docs = fx.check();
	assert.equal(docs.status, 0);
	assert.deepEqual(
		docs.report.steps.map((step) => step.status),
		["skipped", "skipped", "skipped"],
	);

	fx.commit({ "packages/demo/src/fine.ts": "export const fine = 1;\n" });
	const { status, report } = fx.check();
	assert.equal(status, 1);
	assert.deepEqual(
		report.steps.map((step) => [step.name, step.status, step.fix]),
		[
			["format", "failed", "pnpm install"],
			["lint", "failed", "pnpm install"],
			["typecheck", "failed", "pnpm install"],
		],
	);
});

test("pre-push hook: git refuses a real push of a task branch with a format error, and passes evf refs, tags and deletions unchecked", () => {
	const fx = fixture();
	const remote = join(temp("fast-check-remote-"), "remote.git");
	assert.equal(spawnSync("git", ["init", "-q", "--bare", remote]).status, 0);
	fx.ok("remote", "add", "origin", remote);
	assert.equal(fx.dev(["hooks", "install"]).status, 0);
	fx.ok("push", "-q", "origin", "main");
	fx.ok("push", "-q", "--no-verify", "origin", "main:refs/heads/evf/old");
	fx.commit({ "packages/demo/src/bad.ts": "export const b = {x:1}\n" });

	const refused = fx.git("push", "origin", "evf/t-1");
	assert.notEqual(refused.status, 0);
	assert.match(refused.stdout + refused.stderr, /packages\/demo\/src\/bad\.ts/);
	assert.match(refused.stderr, /pre-push: bin\/dev fast-check failed, so git did not push/);
	assert.equal(spawnSync("git", ["-C", remote, "rev-parse", "--verify", "--quiet", "refs/heads/evf/t-1"]).status, 1);

	fx.ok("push", "-q", "origin", "HEAD:refs/evf/ids/T-9");
	fx.ok("tag", "v-fixture");
	fx.ok("push", "-q", "origin", "v-fixture");
	fx.ok("push", "-q", "origin", ":refs/heads/evf/old");
	assert.equal(spawnSync("git", ["-C", remote, "rev-parse", "--verify", "--quiet", "refs/evf/ids/T-9"]).status, 0);
});

test("the tracked hooks still run the global prepare-commit-msg and pre-push, so a commit keeps its Bematist-Session trailer", () => {
	const fx = fixture();
	writeFileSync(
		join(fx.globalHooks, "prepare-commit-msg"),
		'#!/bin/sh\nprintf "\\nBematist-Session: fixture-session\\n" >> "$1"\n',
		{ mode: 0o755 },
	);
	const pushed = join(fx.home, "pushed");
	writeFileSync(join(fx.globalHooks, "pre-push"), `#!/bin/sh\ncat > ${JSON.stringify(pushed)}\n`, { mode: 0o755 });
	assert.equal(fx.dev(["hooks", "install"]).status, 0);
	assert.equal(fx.ok("config", "--get", "core.hooksPath"), "tools/git-hooks");

	fx.commit({ "docs/note.md": "A note.\n" });
	const message = fx.ok("log", "-1", "--format=%B");
	assert.equal(message.match(/^Bematist-Session: fixture-session$/gm)?.length, 1, message);

	const remote = join(temp("fast-check-remote-"), "remote.git");
	assert.equal(spawnSync("git", ["init", "-q", "--bare", remote]).status, 0);
	fx.ok("push", "-q", remote, "HEAD:refs/evf/ids/T-9");
	assert.match(
		readFileSync(pushed, "utf8"),
		new RegExp(`^HEAD ${fx.ok("rev-parse", "HEAD")} refs/evf/ids/T-9 0{40}$`, "m"),
	);
});

test("hooks install and the root prepare script set a relative core.hooksPath once, never the global config, and do nothing in CI or outside git", () => {
	const fx = fixture();
	const local = join(fx.dir, ".git/config");
	const globalBefore = readFileSync(fx.gitconfig, "utf8");

	assert.equal(fx.dev(["hooks", "install"], { CI: "true" }).status, 0);
	assert.equal(fx.git("config", "--local", "--get", "core.hooksPath").status, 1, "CI leaves the repo alone");

	const prepare = spawnSync("pnpm", ["run", "--silent", "prepare"], { cwd: fx.dir, env: fx.env, encoding: "utf8" });
	assert.equal(prepare.status, 0, prepare.stderr);
	const once = readFileSync(local, "utf8");
	assert.equal(fx.ok("config", "--local", "--get", "core.hooksPath"), "tools/git-hooks");
	assert.equal(fx.dev(["hooks", "install"]).status, 0);
	assert.equal(readFileSync(local, "utf8"), once);
	assert.equal(readFileSync(fx.gitconfig, "utf8"), globalBefore);

	const outside = temp("fast-check-nogit-");
	copyDev(outside);
	const plain = spawnSync(join(outside, "bin/dev"), ["hooks", "install"], {
		cwd: outside,
		env: fx.env,
		encoding: "utf8",
	});
	assert.equal(plain.status, 0, plain.stderr);
	assert.equal(plain.stdout, "");
});
