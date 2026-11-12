import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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
const bunScript: string = JSON.parse(readFileSync(join(repo, "packages/ui/package.json"), "utf8")).scripts[
	"typecheck:bun"
];

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

type Fixture = { root: string; log: string; close: () => void };

/** A pnpm workspace whose packages have the given scripts and files. */
function workspace(
	packages: Record<string, { scripts: Record<string, string>; files?: Record<string, string> }>,
	rootScripts: Record<string, string> = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "typecheck-shadow-"));
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
	const log = join(root, "..", `${root.split("/").pop()}.jsonl`);
	return {
		root,
		log,
		close: () => {
			rmSync(root, { recursive: true, force: true });
			rmSync(log, { force: true });
		},
	};
}

/** A real checkable package that the pinned bun can type check. */
function checkable(root: string, files: Record<string, string>) {
	symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
	return {
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ["src"] }),
		...files,
	};
}

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
	return out;
}

function shadow(f: Fixture, extra: Record<string, string | undefined> = {}) {
	const run = spawnSync(process.execPath, [tool], {
		cwd: f.root,
		encoding: "utf8",
		env: env({ CI: undefined, EVERYFIELD_TYPECHECK_LOG: f.log, ...extra }),
	});
	const lines = run.stdout.split("\n").filter((l) => l.startsWith("typecheck-shadow "));
	assert.equal(lines.length, 1, `one result line per run:\n${run.stdout}\n${run.stderr}`);
	return { ...run, line: lines[0], result: JSON.parse(lines[0].slice("typecheck-shadow ".length)) };
}

const TSC_PASS = "exit 0";
const TSC_FAIL = "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 2";
const BUN_SAME_EXIT_1 = "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 1";
const BUN_SAME_EXIT_2 = "printf 'src/a.ts(3,5): error TS2322: Type mismatch.\\n'; exit 2";

test("T-53: exit codes 1 and 2 both mean errors, and matching errors are no mismatch", (t) => {
	for (const bun of [BUN_SAME_EXIT_1, BUN_SAME_EXIT_2]) {
		const f = workspace({
			"packages/a": { scripts: { typecheck: TSC_FAIL, "typecheck:bun": bun } },
			"packages/b": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
		});
		t.after(f.close);
		const run = shadow(f);
		assert.equal(run.status, 1, "pnpm -r fails when tsc fails");
		assert.equal(run.result.mismatch, "no");
		assert.deepEqual(
			run.result.packages.map((p: { dir: string; bun: { outcome: string } }) => [p.dir, p.bun.outcome]),
			[
				["packages/a", "errors"],
				["packages/b", "pass"],
			],
		);
		assert.equal(run.result.tsc.errors, 1);
		assert.equal(run.result.bun.errors, 1);
	}
});

test("T-53: a different error from bun check is a mismatch that lists each difference", (t) => {
	const f = workspace({
		"packages/a": {
			scripts: {
				typecheck: TSC_FAIL,
				"typecheck:bun": "printf 'src/a.ts(4,5): error TS2322: Type mismatch.\\n'; exit 1",
			},
		},
		"packages/b": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
	});
	t.after(f.close);
	const run = shadow(f);
	assert.equal(run.status, 1);
	assert.equal(run.result.mismatch, "yes");
	assert.deepEqual(run.result.packages[0].differences, [
		{ file: "src/a.ts", line: 3, code: "TS2322", only: "tsc" },
		{ file: "src/a.ts", line: 4, code: "TS2322", only: "bun" },
	]);
	assert.equal(run.result.packages[1].mismatch, "no");
});

test("T-53: the exit code is always tsc's when bun check errors, crashes, times out or is missing", (t) => {
	const cases: Array<[string, string | undefined, string]> = [
		["errors", "printf 'src/z.ts(1,1): error TS2307: Cannot find module.\\n'; exit 1", "errors"],
		["crashes", "kill -SEGV $$", "crash"],
		["exits 3", "exit 3", "crash"],
		["times out", "sleep 30", "timeout"],
		["is missing", "./node_modules/.bin/no-such-bun check --no-script", "missing"],
		["has no script", undefined, "missing"],
	];
	for (const tsc of [TSC_PASS, TSC_FAIL])
		for (const [name, bun, outcome] of cases) {
			const scripts: Record<string, string> = { typecheck: tsc };
			if (bun !== undefined) scripts["typecheck:bun"] = bun;
			const f = workspace({
				"packages/a": { scripts },
				"packages/b": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
			});
			t.after(f.close);
			const started = Date.now();
			const run = shadow(f, { TYPECHECK_BUN_TIMEOUT_MS: "1000" });
			assert.equal(run.status, tsc === TSC_PASS ? 0 : 1, `bun ${name}: ${run.stderr}`);
			assert.equal(run.result.tsc.exit, run.status);
			assert.equal(run.result.packages[0].bun.outcome, outcome, `bun ${name}`);
			assert.equal(run.result.bun.outcome, outcome);
			assert.equal(run.result.mismatch, "yes", `bun ${name} is never a silent match`);
			assert.ok(Date.now() - started < 20_000, "a hung bun check is stopped by the timeout");
		}
});

test("T-53: each run appends its result line to the log outside CI and only prints it in CI", (t) => {
	const f = workspace({
		"packages/a": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
		"packages/b": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
	});
	t.after(f.close);
	const first = shadow(f);
	const second = shadow(f);
	const logged = readFileSync(f.log, "utf8").trimEnd().split("\n");
	assert.deepEqual(
		logged,
		[first.line, second.line].map((l) => l.slice("typecheck-shadow ".length)),
	);
	for (const field of ["commit", "dirty", "at"]) assert.ok(field in first.result, field);
	assert.deepEqual(Object.keys(first.result.tsc), ["exit", "errors", "wall_ms"]);
	assert.deepEqual(Object.keys(first.result.bun), ["exit", "outcome", "errors", "wall_ms"]);
	assert.equal(first.result.mismatch, "no");
	const inCi = shadow(f, { CI: "true" });
	assert.equal(inCi.result.ci, true);
	assert.equal(readFileSync(f.log, "utf8").trimEnd().split("\n").length, 2, "CI appends nothing");
});

test("T-53: every package runs the pinned bun 1.4.4 as check --no-script --no-pretty, never a global bun", (t) => {
	assert.equal(rootPkg.devDependencies.bun, "1.4.4");
	for (const dir of PACKAGES) {
		const scripts = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8")).scripts;
		// The shadow reads the tsconfig tsc reads: apps/web's typecheck-only one (T-258), else the package's own.
		const project = / -p (\S+)/.exec(scripts.typecheck)?.[1];
		const bun = `../../node_modules/.bin/bun check ${project ? `-p ${project} ` : ""}--no-script --no-pretty --all`;
		assert.equal(scripts["typecheck:bun"], bun, dir);
	}
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
	const run = spawnSync("pnpm", ["run", "typecheck:bun"], {
		cwd: join(repo, "packages/ui"),
		encoding: "utf8",
		env: env({ PATH }),
	});
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout + run.stderr, /No type errors in \d+ files/);
	assert.equal(existsSync(marker), false, "the global bun never ran");
});

test("T-53: typecheck:bun at the root, in a package and in the shadow never starts a check script", (t) => {
	const f = workspace(
		{
			"packages/p": {
				scripts: { check: "touch ../../package-check-ran", typecheck: TSC_PASS, "typecheck:bun": bunScript },
				files: { "src/a.ts": "export const a: number = 1;\n" },
			},
			"packages/q": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
		},
		{ check: "touch root-check-ran", "typecheck:bun": rootPkg.scripts["typecheck:bun"] },
	);
	t.after(f.close);
	for (const [file, content] of Object.entries(checkable(f.root, {})))
		writeFileSync(join(f.root, "packages/p", file), content);
	const markers = [join(f.root, "root-check-ran"), join(f.root, "package-check-ran")];
	const atRoot = spawnSync("pnpm", ["run", "typecheck:bun"], { cwd: f.root, encoding: "utf8", env: env() });
	assert.equal(atRoot.status, 0, atRoot.stdout + atRoot.stderr);
	assert.match(atRoot.stdout, /No type errors/);
	const inPackage = spawnSync("pnpm", ["run", "typecheck:bun"], {
		cwd: join(f.root, "packages/p"),
		encoding: "utf8",
		env: env(),
	});
	assert.equal(inPackage.status, 0, inPackage.stdout + inPackage.stderr);
	assert.match(inPackage.stdout + inPackage.stderr, /No type errors/);
	const run = shadow(f);
	assert.equal(run.result.packages[0].bun.outcome, "pass");
	for (const marker of markers) assert.equal(existsSync(marker), false, `${marker} must not exist`);
	// Without --no-script the same binary does start the package's check script, so the marker can appear.
	spawnSync(join(repo, "node_modules/.bin/bun"), ["check"], { cwd: join(f.root, "packages/p"), env: env() });
	assert.equal(existsSync(markers[1]), true, "control: bun check without --no-script runs the check script");
});

test("T-53: a package .env reaches no checker, child process or output", (t) => {
	const sentinel = "t53-sentinel-4f1c9e";
	const f = workspace({
		// The tsc stand-in prints its whole environment, so a loaded .env would show in the output.
		"packages/p": {
			scripts: { typecheck: "env", "typecheck:bun": bunScript },
			files: {
				".env": `T53_SENTINEL=${sentinel}\nFORCE_COLOR=1\n`,
				".env.local": `T53_SENTINEL=${sentinel}\nFORCE_COLOR=1\n`,
				"src/a.ts": "export const a: number = 'one';\n",
				"print.ts": "console.log(String(process.env.T53_SENTINEL));\n",
			},
		},
		"packages/q": { scripts: { typecheck: TSC_PASS, "typecheck:bun": "exit 0" } },
	});
	t.after(f.close);
	for (const [file, content] of Object.entries(checkable(f.root, {})))
		writeFileSync(join(f.root, "packages/p", file), content);
	const env0 = { T53_SENTINEL: undefined, FORCE_COLOR: undefined, NO_COLOR: undefined };
	const run = shadow(f, env0);
	const everything = run.stdout + run.stderr + readFileSync(f.log, "utf8");
	assert.equal(everything.includes(sentinel), false, "the sentinel reaches no output or log");
	assert.match(run.stdout, /packages\/p typecheck: PATH=/, "control: the stand-in did print its environment");
	assert.equal(run.result.packages[0].bun.outcome, "errors");
	const bun = spawnSync("pnpm", ["run", "typecheck:bun"], {
		cwd: join(f.root, "packages/p"),
		encoding: "utf8",
		env: env(env0),
	});
	assert.equal(bun.status, 1);
	assert.match(bun.stdout + bun.stderr, /src\/a\.ts\(1,14\): error TS2322/);
	assert.equal((bun.stdout + bun.stderr).includes("\x1b["), false, "bun check did not take FORCE_COLOR from .env");
	// Controls: the same FORCE_COLOR from the real environment does colour bun check, and bun's runtime does load .env.
	const coloured = spawnSync("pnpm", ["run", "typecheck:bun"], {
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
