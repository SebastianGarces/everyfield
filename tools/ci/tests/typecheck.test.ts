import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { copyWorkspace } from "../typecheck-corpus.ts";

const repo = resolve(import.meta.dirname, "../../..");
const tool = join(repo, "tools/ci/typecheck.ts");
const rootPkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const PACKAGES = [
	"apps/web",
	"packages/contracts",
	"packages/db",
	"packages/domain",
	"packages/evry",
	"packages/reference",
	"packages/ui",
];
const scriptsOf = (dir: string): Record<string, string> =>
	JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).scripts;
const bunScript = scriptsOf("packages/ui").typecheck!;

/** PATH without any directory that holds a `bun`, so only the pinned binary can run. */
function pathWithoutBun(): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((dir) => {
			try {
				accessSync(join(dir, "bun"), constants.X_OK);
				return false;
			} catch {
				return true;
			}
		})
		.join(delimiter);
}

type Fixture = { root: string; state: string; close: () => void };

/** A pnpm workspace whose packages have the given scripts and files, with an empty state directory beside it. */
function workspace(
	packages: Record<string, { scripts: Record<string, string>; files?: Record<string, string> }>,
	rootScripts: Record<string, string> = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "typecheck-"));
	const state = mkdtempSync(join(tmpdir(), "typecheck-state-"));
	writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: rootScripts }));
	for (const [dir, { scripts, files }] of Object.entries(packages)) {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir.replace("/", "-"), scripts }));
		for (const [file, content] of Object.entries(files ?? {})) {
			mkdirSync(join(root, dir, file, ".."), { recursive: true });
			writeFileSync(join(root, dir, file), content);
		}
	}
	return {
		root,
		state,
		close: () => {
			rmSync(root, { recursive: true, force: true });
			rmSync(state, { recursive: true, force: true });
		},
	};
}

/** Make a fixture package checkable by the pinned bun. */
function checkable(root: string, dir: string) {
	symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
	writeFileSync(
		join(root, dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["src"] }),
	);
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
	return out;
}

/** `pnpm typecheck` in a fixture, with the state directory the retired shadow log would have used. */
function typecheck(f: Fixture, extra: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [tool], {
		cwd: f.root,
		encoding: "utf8",
		env: env({ CI: undefined, XDG_STATE_HOME: f.state, ...extra }),
	});
}

const PASS = "exit 0";

test("INV-typecheck: pnpm typecheck exits 1 when any package's bun check finds errors, crashes, times out or is missing", (t) => {
	const cases: Array<[string, string, RegExp]> = [
		["exits 1", "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 1", /packages\/a: type errors/],
		["exits 2", "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 2", /packages\/a: type errors/],
		["crashes", "kill -SEGV $$", /packages\/a: crashed/],
		["exits 3", "exit 3", /packages\/a: crashed \(exit 3\)/],
		["times out", "sleep 30", /packages\/a: timed out/],
		["is missing", "../../node_modules/.bin/no-such-bun check --no-script", /packages\/a: bun check is missing/],
	];
	for (const [name, script, why] of cases) {
		const f = workspace({
			"packages/a": { scripts: { typecheck: script } },
			"packages/b": { scripts: { typecheck: PASS } },
		});
		t.after(f.close);
		const started = Date.now();
		const run = typecheck(f, { TYPECHECK_TIMEOUT_MS: "1000" });
		assert.equal(run.status, 1, `bun ${name}: ${run.stdout}${run.stderr}`);
		assert.match(run.stderr, why, name);
		assert.match(run.stderr, /typecheck failed in 1 of 2 packages/);
		if (script.includes("TS2322"))
			assert.match(run.stdout, /^packages\/a typecheck: src\/a\.ts\(3,5\): error TS2322: Type mismatch\.$/m);
		assert.ok(Date.now() - started < 20_000, "a hung bun check is stopped by the timeout");
	}
	const clean = workspace({
		"packages/a": { scripts: { typecheck: PASS } },
		"packages/b": { scripts: { typecheck: PASS } },
	});
	t.after(clean.close);
	const run = typecheck(clean);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stderr, /no type errors in 2 packages/);
});

test("INV-typecheck: pnpm typecheck runs no tsc, prints no shadow line and writes no shadow log", (t) => {
	const f = workspace({
		"packages/a": { scripts: { typecheck: PASS, "typecheck:tsc": "touch ../../tsc-ran; exit 1" } },
		"packages/b": { scripts: { typecheck: PASS } },
	});
	t.after(f.close);
	const run = typecheck(f, { HOME: f.state });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(existsSync(join(f.root, "tsc-ran")), false, "typecheck:tsc never ran");
	assert.doesNotMatch(run.stdout + run.stderr, /shadow/);
	assert.deepEqual(readdirSync(f.state), [], "nothing is written to the state directory");
});

test("INV-typecheck: a failing typecheck:tools fails the run after every package's bun check", (t) => {
	const FAIL = "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 1";
	const cases: Array<[string, string, number]> = [
		[PASS, "exit 0", 0],
		[PASS, "printf 'tools/qa/a.ts(1,1): error TS2322: Type mismatch.\\n'; exit 2", 2],
		[FAIL, "exit 2", 1],
		[FAIL, "exit 0", 1],
	];
	for (const [pkg, tools, status] of cases) {
		const f = workspace(
			{
				"packages/a": { scripts: { typecheck: pkg } },
				"packages/b": { scripts: { typecheck: PASS } },
			},
			{ "typecheck:tools": tools },
		);
		t.after(f.close);
		const run = typecheck(f);
		assert.equal(run.status, status, `${pkg} / ${tools}: ${run.stderr}`);
		if (status === 2) assert.match(run.stderr, /typecheck:tools failed/);
	}
});

test("INV-typecheck: pnpm typecheck runs tsconfig.tools.json over scripts, tools/ci, tools/qa and ops/actionable-watch", () => {
	assert.equal(rootPkg.scripts["typecheck:tools"], "node_modules/typescript-7/bin/tsc -p tsconfig.tools.json");
	const listed = spawnSync(
		join(repo, "node_modules/typescript-7/bin/tsc"),
		["-p", "tsconfig.tools.json", "--listFilesOnly"],
		{
			cwd: repo,
			encoding: "utf8",
		},
	);
	assert.equal(listed.status, 0, listed.stderr);
	const files = listed.stdout.split("\n").map((file) => file.trim().slice(repo.length + 1));
	for (const file of [
		"scripts/fast-check.ts",
		"tools/ci/typecheck.ts",
		"tools/ci/tests/typecheck.test.ts",
		"tools/qa/qa.ts",
		"tools/qa/tests/qa.test.ts",
		"ops/actionable-watch/run.mts",
		"ops/actionable-watch/test/run.test.mts",
	])
		assert.ok(files.includes(file), `${file} is in the tools program`);
});

test("INV-typecheck: every package's typecheck runs the pinned bun 1.4.4, never a global bun, and typecheck:tsc keeps tsc", (t) => {
	assert.equal(rootPkg.devDependencies.bun, "1.4.4");
	assert.equal(rootPkg.scripts.typecheck, "node tools/ci/typecheck.ts");
	assert.equal(rootPkg.scripts["typecheck:tsc"], "pnpm -r --if-present --no-bail typecheck:tsc");
	for (const dir of PACKAGES) {
		const scripts = scriptsOf(dir);
		// apps/web checks its typecheck-only tsconfig (T-258), the others their own.
		const project = dir === "apps/web" ? " -p tsconfig.typecheck.json" : "";
		assert.equal(scripts.typecheck, `../../node_modules/.bin/bun check${project} --no-script --no-pretty --all`, dir);
		assert.equal(scripts["typecheck:tsc"], `../../node_modules/typescript-7/bin/tsc --noEmit${project}`, dir);
		assert.equal("typecheck:bun" in scripts, false, dir);
	}
	assert.equal("typecheck:bun" in rootPkg.scripts, false);
	// A global bun that records any call, ahead of everything else on a PATH that holds no other bun.
	const fake = mkdtempSync(join(tmpdir(), "global-bun-"));
	t.after(() => rmSync(fake, { recursive: true, force: true }));
	const marker = join(fake, "called");
	writeFileSync(join(fake, "bun"), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o755 });
	const PATH = [fake, pathWithoutBun()].join(delimiter);
	const stripped = spawnSync("sh", ["-c", "command -v bun"], {
		encoding: "utf8",
		env: env({ PATH: pathWithoutBun() }),
	});
	assert.notEqual(stripped.status, 0, "the stripped PATH has no bun");
	const version = spawnSync("sh", ["-c", `${bunScript.split(" ")[0]} --version`], {
		cwd: join(repo, "packages/ui"),
		encoding: "utf8",
		env: env({ PATH: pathWithoutBun() }),
	});
	assert.equal(version.stdout.trim(), "1.4.4");
	const run = spawnSync("pnpm", ["run", "typecheck"], {
		cwd: join(repo, "packages/ui"),
		encoding: "utf8",
		env: env({ PATH }),
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout + run.stderr, /No type errors in \d+ files/);
	assert.equal(existsSync(marker), false, "the global bun never ran");
});

test("INV-typecheck: typecheck at the root and in a package never starts a check script", (t) => {
	const f = workspace(
		{
			"packages/p": {
				scripts: { check: "touch ../../package-check-ran", typecheck: bunScript },
				files: { "src/a.ts": "export const a: number = 1;\n" },
			},
			"packages/q": { scripts: { typecheck: PASS } },
		},
		{ check: "touch root-check-ran", typecheck: `node ${tool}` },
	);
	t.after(f.close);
	checkable(f.root, "packages/p");
	const markers = [join(f.root, "root-check-ran"), join(f.root, "package-check-ran")];
	const atRoot = spawnSync("pnpm", ["run", "typecheck"], { cwd: f.root, encoding: "utf8", env: env() });
	assert.equal(atRoot.status, 0, atRoot.stdout + atRoot.stderr);
	assert.match(atRoot.stdout, /packages\/p typecheck: .*No type errors/);
	const inPackage = spawnSync("pnpm", ["run", "typecheck"], {
		cwd: join(f.root, "packages/p"),
		encoding: "utf8",
		env: env(),
	});
	assert.equal(inPackage.status, 0, inPackage.stdout + inPackage.stderr);
	assert.match(inPackage.stdout + inPackage.stderr, /No type errors/);
	for (const marker of markers) assert.equal(existsSync(marker), false, `${marker} must not exist`);
	// Without --no-script the same binary does start the package's check script, so the marker can appear.
	spawnSync(join(repo, "node_modules/.bin/bun"), ["check"], { cwd: join(f.root, "packages/p"), env: env() });
	assert.equal(existsSync(markers[1]!), true, "control: bun check without --no-script runs the check script");
});

test("INV-typecheck: a package .env reaches no checker, child process or output", (t) => {
	const sentinel = "t53-sentinel-4f1c9e";
	const f = workspace({
		"packages/p": {
			scripts: { typecheck: bunScript },
			files: {
				".env": `T53_SENTINEL=${sentinel}\nFORCE_COLOR=1\n`,
				".env.local": `T53_SENTINEL=${sentinel}\nFORCE_COLOR=1\n`,
				"src/a.ts": "export const a: number = 'one';\n",
				"print.ts": "console.log(String(process.env.T53_SENTINEL));\n",
			},
		},
		// A child that prints its whole environment, so a loaded .env would show in the output.
		"packages/q": { scripts: { typecheck: "env" } },
	});
	t.after(f.close);
	checkable(f.root, "packages/p");
	writeFileSync(join(f.root, "packages/q/.env"), `T53_SENTINEL=${sentinel}\n`);
	const env0 = { T53_SENTINEL: undefined, FORCE_COLOR: undefined, NO_COLOR: undefined };
	const run = typecheck(f, env0);
	assert.equal(run.status, 1);
	assert.equal((run.stdout + run.stderr).includes(sentinel), false, "the sentinel reaches no output");
	assert.match(run.stdout, /packages\/q typecheck: PATH=/, "control: the child did print its environment");
	assert.match(run.stdout, /packages\/p typecheck: src\/a\.ts\(1,14\): error TS2322/);
	assert.equal(run.stdout.includes("\x1b["), false, "bun check did not take FORCE_COLOR from .env");
	// Controls: the same FORCE_COLOR from the real environment does colour bun check, and bun's runtime does load .env.
	const coloured = spawnSync("pnpm", ["run", "typecheck"], {
		cwd: join(f.root, "packages/p"),
		encoding: "utf8",
		env: env({ ...env0, FORCE_COLOR: "1" }),
	});
	assert.equal((coloured.stdout + coloured.stderr).includes("\x1b["), true);
	const runtime = spawnSync(join(repo, "node_modules/.bin/bun"), ["./print.ts"], {
		cwd: join(f.root, "packages/p"),
		encoding: "utf8",
		env: env(env0),
	});
	assert.equal(runtime.stdout.trim(), sentinel);
});

test("INV-typecheck: a type error seeded in any one of the 7 packages fails pnpm typecheck, and typecheck:tsc too", (t) => {
	const copy = mkdtempSync(join(tmpdir(), "typecheck-seeded-"));
	t.after(() => rmSync(copy, { recursive: true, force: true }));
	const before = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout;
	copyWorkspace(repo, copy, PACKAGES);
	// The copy holds the packages only, so the tools step (tested above) has nothing to check here.
	const copyPkg = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
	delete copyPkg.scripts["typecheck:tools"];
	writeFileSync(join(copy, "package.json"), JSON.stringify(copyPkg));
	const run = () => spawnSync(process.execPath, [tool], { cwd: copy, encoding: "utf8" });
	const clean = run();
	assert.equal(clean.status, 0, `control: the unseeded copy passes\n${clean.stdout}${clean.stderr}`);
	const seeded = "src/__seeded__/t110.ts";
	for (const dir of PACKAGES) {
		const file = join(copy, dir, seeded);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, 'export const seeded: number = "seeded";\n');
		const failed = run();
		assert.equal(failed.status, 1, `${dir}: ${failed.stdout}${failed.stderr}`);
		assert.match(failed.stdout, new RegExp(`^${dir} typecheck: ${seeded}\\(1,14\\): error TS2322`, "m"), dir);
		assert.match(failed.stderr, new RegExp(`typecheck failed in 1 of 7 packages:\\n  ${dir}: type errors`), dir);
		rmSync(join(copy, dir, "src/__seeded__"), { recursive: true });
	}
	// The backstop: tsc fails a seeded copy as well.
	writeFileSync(join(copy, "packages/ui", "src/t110-seeded.ts"), 'export const seeded: number = "seeded";\n');
	const tsc = spawnSync("pnpm", ["run", "typecheck:tsc"], { cwd: copy, encoding: "utf8" });
	assert.notEqual(tsc.status, 0, tsc.stdout + tsc.stderr);
	assert.match(tsc.stdout, /packages\/ui typecheck:tsc: src\/t110-seeded\.ts\(1,14\): error TS2322/);
	assert.equal(
		spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout,
		before,
		"tree unchanged",
	);
});
