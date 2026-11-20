import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
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
	for (const key of ["CI", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];

	const write = (file, content) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), content);
	};
	copyDev(dir);
	for (const file of ["package.json", ".prettierrc", ".prettierignore", ".oxlintrc.json", "tools/.oxlintrc.json"]) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		copyFileSync(join(repo, file), join(dir, file));
	}
	cpSync(join(repo, "scripts/lint"), join(dir, "scripts/lint"), { recursive: true });
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
	const tscCheck = "../../node_modules/typescript-7/bin/tsc --noEmit";
	const manifest = (name, scripts, dependencies = {}) =>
		JSON.stringify({ name, private: true, type: "module", scripts, dependencies }, null, "\t") + "\n";
	write(
		"packages/demo/package.json",
		manifest("@fx/demo", {
			lint: "eslint --max-warnings=0 .",
			typecheck: tscCheck,
			"typecheck:bun": "touch ../../bun-ran; exit 1",
		}),
	);
	write("packages/demo/eslint.config.mjs", eslintConfig(["src/ignored.ts"]));
	write("packages/demo/tsconfig.json", tsconfig);
	write("packages/demo/src/index.ts", "export const n: number = 1;\n");
	write("packages/demo/src/old.ts", "const   stale = {a:1}\nexport {};\n");
	write("packages/app/package.json", manifest("@fx/app", { typecheck: tscCheck }, { "@fx/demo": "workspace:*" }));
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
		mkdirSync(join(dir, "packages/evry"));
		symlinkSync(join(repo, "packages/evry/node_modules"), join(dir, "packages/evry/node_modules"));
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
	const commit = (files, message = "change") => {
		for (const [file, content] of Object.entries(files)) write(file, content);
		ok("add", "-A");
		ok("commit", "-qm", message);
	};
	const dev = (args, extra = {}) =>
		spawnSync(join(dir, "bin/dev"), args, { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" });
	const check = () => {
		const run = dev(["fast-check", "--json"]);
		const report = JSON.parse(run.stdout);
		return { status: run.status, report, step: (name) => report.steps.find((step) => step.name === name) };
	};
	return { dir, home, env, globalHooks, gitconfig, git, ok, commit, write, dev, check };
}

const SESSION = "packages/domain/src/access/session.ts";
const SEATS = "packages/domain/src/identity/seats.ts";
const PERMISSIONS_MAP = ".agents/skills/formal-permissions/map.json";
const MAINTAIN = ".agents/skills/maintain-formal-verification/SKILL.md";
const formalMap = (model, entries) => JSON.stringify({ model, actions: entries, properties: [] }, null, "\t") + "\n";

function formalFixture() {
	const fx = fixture();
	fx.ok("checkout", "-q", "main");
	const map = JSON.parse(readFileSync(join(repo, PERMISSIONS_MAP), "utf8"));
	const files = {
		[PERMISSIONS_MAP]: readFileSync(join(repo, PERMISSIONS_MAP), "utf8"),
		[`${map.model}/Permissions.tla`]: "---- MODULE Permissions ----\n====\n",
	};
	for (const entry of [...map.actions, ...(map.rules ?? []), ...map.properties])
		for (const code of entry.code) files[code.file] = `// ${code.function}\n`;
	fx.commit(files, "formal base");
	fx.ok("branch", "-qf", "evf/t-1", "main");
	fx.ok("checkout", "-q", "evf/t-1");
	return fx;
}

test("INV-lint: a pnpm-workspace.yaml exclusion, a packages entry other than folder/* or a list form the reader does not parse is refused, so pnpm -r skips no package the lint checks count", async () => {
	const { lintRuns } = await import("../../scripts/fast-check.ts");
	const dir = temp("fast-check-workspace-");
	writeFileSync(join(dir, "package.json"), "{}\n");
	const runs = (body) => {
		writeFileSync(join(dir, "pnpm-workspace.yaml"), body);
		return () => lintRuns(dir);
	};
	assert.throws(
		runs('packages:\n  - packages/*\n  - "!packages/x"\nonlyBuiltDependencies:\n  - bun\n'),
		/lists !packages\/x:/,
	);
	assert.throws(runs('packages:\n  - apps/*\n\n  - packages/*\n  - "!packages/x"\n'), /lists !packages\/x:/);
	assert.throws(runs("packages:\n  - packages/**\n  - tools/x\n"), /lists packages\/\*\*, tools\/x:/);
	assert.throws(runs("packages: [apps/*]\n"), /a form this reader does not parse \(packages: \[apps\/\*\]\)/);
	assert.throws(runs("packages:\nonlyBuiltDependencies:\n  - bun\n"), /lists no packages:/);
	assert.throws(runs("packages:\n  - apps/*\n  extra: x\n"), /a packages line this reader does not parse \(extra: x\)/);
	assert.throws(runs("onlyBuiltDependencies:\n  - bun\n"), /has no packages list:/);
	mkdirSync(join(dir, "packages"));
	mkdirSync(join(dir, "apps"));
	assert.deepEqual(runs("packages:\n- apps/*\n- packages/*\n")(), []);
	assert.deepEqual(runs("packages:\n  - apps/*\n\n  - packages/*\nonlyBuiltDependencies:\n  - bun\n")(), []);
	assert.deepEqual(runs("packages: []\n")(), []);
});

test("fast-check's formal step fails a branch that changes a mapped file without its map or model, and names the map, model and maintain skill", () => {
	const fx = formalFixture();
	fx.commit({ [SESSION]: "// lockWriteAuthority\n// one more line\n", "docs/note.md": "A note.\n" });
	const { status, report, step } = fx.check();
	assert.equal(status, 1);
	assert.equal(report.ok, false);
	const formal = step("formal");
	assert.equal(formal.status, "failed");
	assert.deepEqual(formal.files, [SESSION]);
	assert.equal(formal.fix, MAINTAIN);
	assert.equal(typeof formal.ms, "number");
	assert.match(
		formal.detail,
		/mapped in \.agents\/skills\/formal-permissions\/map\.json \(model formal\/permissions\/\)/,
	);
	assert.match(formal.detail, /Formal-model: unchanged/);

	const human = fx.dev(["fast-check"]);
	assert.equal(human.status, 1);
	assert.match(human.stdout, /^formal +failed \d+ ms\n {2}packages\/domain\/src\/access\/session\.ts$/m);
	assert.match(human.stdout, /^ {2}fix: \.agents\/skills\/maintain-formal-verification\/SKILL\.md$/m);
});

test("fast-check's formal step passes a mapped change that also changes the model folder or the map", () => {
	const model = formalFixture();
	model.commit({
		[SESSION]: "// lockWriteAuthority\n// changed\n",
		"formal/permissions/Permissions.tla": "\\* changed\n",
	});
	assert.equal(model.check().step("formal").status, "passed");

	const map = formalFixture();
	const edited = readFileSync(join(map.dir, PERMISSIONS_MAP), "utf8").replace('"model"', '"model" ');
	map.commit({ [SESSION]: "// lockWriteAuthority\n// changed\n", [PERMISSIONS_MAP]: edited });
	const { status, step } = map.check();
	assert.equal(step("formal").status, "passed");
	assert.equal(status, 0);
});

test("fast-check's formal step counts a deleted or renamed mapped file as changed", () => {
	const deleted = formalFixture();
	deleted.ok("rm", "-q", SEATS);
	deleted.ok("commit", "-qm", "drop seats");
	const gone = deleted.check().step("formal");
	assert.equal(gone.status, "failed");
	assert.deepEqual(gone.files, [SEATS]);

	const moved = formalFixture();
	moved.ok("mv", SEATS, "packages/domain/src/identity/seat-rules.ts");
	moved.ok("commit", "-qm", "move seats");
	const renamed = moved.check().step("formal");
	assert.equal(renamed.status, "failed");
	assert.deepEqual(renamed.files, [SEATS]);
});

test("fast-check's formal step passes on a branch commit with the Formal-model: unchanged trailer and names that commit", () => {
	const fx = formalFixture();
	fx.commit({ [SESSION]: "// lockWriteAuthority\n// refactor\n" }, "Refactor the lock\n\nFormal-model: unchanged");
	const trailed = fx.ok("rev-parse", "HEAD");
	fx.commit({ "docs/note.md": "A later commit.\n" });
	const { status, step } = fx.check();
	assert.equal(status, 0);
	const formal = step("formal");
	assert.equal(formal.status, "passed");
	assert.match(formal.detail, new RegExp(`Formal-model: unchanged trailer in commit ${trailed.slice(0, 9)}`));

	const human = fx.dev(["fast-check"]);
	assert.equal(human.status, 0);
	assert.match(
		human.stdout,
		new RegExp(`^formal +passed \\d+ ms: .*Formal-model: unchanged trailer in commit ${trailed.slice(0, 9)}`, "m"),
	);
});

test("fast-check's formal step passes a branch that touches no mapped file and reads a second subsystem's map with no code change", () => {
	const fx = formalFixture();
	fx.commit({ "packages/domain/src/other.ts": "export {};\n" });
	assert.equal(fx.check().step("formal").status, "passed");

	fx.commit({
		".agents/skills/formal-billing/map.json": formalMap("formal/billing", [
			{ name: "Charge", code: [{ file: "packages/domain/src/billing/charge.ts", function: "charge" }], ids: [] },
		]),
		"packages/domain/src/billing/charge.ts": "// charge\n",
	});
	assert.equal(fx.check().step("formal").status, "passed", "a new map and its code are added together");
	fx.ok("branch", "-qf", "main", "HEAD");

	fx.commit({ "packages/domain/src/billing/charge.ts": "// charge\n// changed\n" });
	const formal = fx.check().step("formal");
	assert.equal(formal.status, "failed");
	assert.deepEqual(formal.files, ["packages/domain/src/billing/charge.ts"]);
	assert.match(formal.detail, /formal-billing\/map\.json \(model formal\/billing\/\)/);
});

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
	assert.equal(existsSync(join(fx.dir, "bun-ran")), false, "fast-check ran no typecheck:bun");

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

test("fast-check format-checks a changed file under ops/, as the root format:check globs do (T-176)", () => {
	const fx = fixture();
	fx.commit({
		"ops/actionable-watch/bad.mts": "export const b = {x:1}\n",
		"ops/actionable-watch/fine.mts": "export const fine = 1;\n",
	});
	const { status, step } = fx.check();
	assert.equal(status, 1);
	assert.deepEqual(step("format").files, ["ops/actionable-watch/bad.mts"]);
	assert.equal(step("format").fix, "pnpm exec prettier --write ops/actionable-watch/bad.mts");
});

test("fast-check lints a changed file in tests/{integration,evry,ui,workflow} with the root lint:tests script and its test rules (T-176)", () => {
	const fx = fixture();
	const unused = "const unused = 1;\nexport {};\n";
	fx.commit({
		"tests/ui/bad.test.mjs": unused,
		"tests/integration/bad.test.mts": unused,
		"tests/evry/loose.test.mts": "export const loose: any = 1;\nexport const { id: _id, ...rest } = { id: 1, a: 2 };\n",
		"tests/workflow/fine.test.mjs": "export const fine = 1;\n",
		"tests/support/loose.mts": unused,
	});
	const { status, step } = fx.check();
	assert.equal(status, 1);
	const lint = step("lint");
	assert.equal(lint.status, "failed");
	assert.deepEqual(lint.files.sort(), ["tests/integration/bad.test.mts", "tests/ui/bad.test.mjs"]);
	const [command, fixFiles] = lint.fix.split(" --fix ");
	assert.equal(command, "packages/evry/node_modules/.bin/oxlint -c .oxlintrc.json", "the fix runs from the root");
	assert.deepEqual(fixFiles.split(" ").sort(), lint.files);
	assert.match(lint.detail, /tests\/ui\/bad\.test\.mjs:1:7 .*\(eslint\(no-unused-vars\)\)/);
	assert.doesNotMatch(lint.detail, /tests\/evry|tests\/support/);
});

test("fast-check typechecks a changed tool file with the root typecheck:tools script, beside the package typecheck (T-176)", () => {
	const fx = fixture();
	const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	manifest.scripts["typecheck:tools"] =
		"node_modules/typescript-7/bin/tsc -b tsconfig.tools.json tests/unit/tsconfig.json";
	fx.commit({
		"package.json": JSON.stringify(manifest, null, "\t") + "\n",
		"tsconfig.tools.json": `{
	// Only the fixture's tool folder.
	"compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "types": [] },
	"include": ["tools/qa/**/*.ts"]
}
`,
		"tests/unit/tsconfig.json": `{
	"compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "types": [] },
	"include": ["./**/*.mts"]
}
`,
		"tests/unit/ok.test.mts": "export const ok = 1;\n",
		"tools/qa/wrong.ts": 'export const w: number = "s";\n',
		"packages/demo/src/wrong.ts": 'export const w: number = "s";\n',
	});
	const { status, step } = fx.check();
	assert.equal(status, 1);
	const typecheck = step("typecheck");
	assert.equal(typecheck.status, "failed");
	assert.deepEqual(typecheck.files.sort(), ["packages/demo/src/wrong.ts", "tools/qa/wrong.ts"]);
	assert.equal(typecheck.fix, "pnpm --filter ...@fx/demo --no-bail --if-present typecheck && pnpm run typecheck:tools");
	assert.match(typecheck.detail, /tools\/qa\/wrong\.ts\(1,14\): error TS2322/);

	fx.commit({ "tools/qa/wrong.ts": "export const w: number = 1;\n", "packages/demo/src/wrong.ts": "export {};\n" });
	assert.equal(fx.check().step("typecheck").status, "passed");

	fx.commit({ "tests/unit/wrong.test.mts": 'export const w: number = "s";\n' });
	const unit = fx.check().step("typecheck");
	assert.equal(
		unit.status,
		"failed",
		"a test folder the tools typecheck builds is checked when one of its files changes",
	);
	assert.deepEqual(unit.files, ["tests/unit/wrong.test.mts"]);
});

test("fast-check typechecks a changed integration test through the typecheck:tools folder glob", () => {
	const fx = fixture();
	const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	manifest.scripts["typecheck:tools"] = "node_modules/typescript-7/bin/tsc -b tests/integration/*/tsconfig.json";
	fx.commit({
		"package.json": JSON.stringify(manifest, null, "\t") + "\n",
		"tests/integration/demo/tsconfig.json": `{
	"compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "types": [] },
	"include": ["./**/*.mts"]
}
`,
		"tests/integration/demo/wrong.test.mts": 'export const w: number = "s";\n',
	});
	const typecheck = fx.check().step("typecheck");
	assert.equal(typecheck.status, "failed");
	assert.deepEqual(typecheck.files, ["tests/integration/demo/wrong.test.mts"]);
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
			["formal", "skipped"],
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
		["skipped", "skipped", "skipped", "skipped"],
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
			["formal", "skipped", undefined],
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
