// T-258: the apps/web `typecheck` script judges only the branch's own code. `next dev` and `next build` write route
// types under .next (and next-env.d.ts, which imports them) for the tree they ran on, and a reused worktree or evf check
// slot keeps them when it moves to another branch. These tests run the real script and tsconfig files on a copy of
// apps/web's config with such stale files planted, so no running dev server's .next is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
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
const web = join(repo, "apps/web");
const script = JSON.parse(readFileSync(join(web, "package.json"), "utf8")).scripts.typecheck;
const tsc = join(repo, "node_modules/typescript-7/bin/tsc");
const temps = [];
test.after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A tree shaped like the repo (root tsconfig.base.json, apps/web's two tsconfigs and package.json) with one clean
 * source file and the generated files of a `next dev` run on a branch that had a route this one lacks. */
function staleWorktree() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "web-typecheck-")));
	temps.push(root);
	const app = join(root, "apps/web");
	const write = (file, content) => {
		mkdirSync(dirname(join(app, file)), { recursive: true });
		writeFileSync(join(app, file), content);
	};
	mkdirSync(app, { recursive: true });
	copyFileSync(join(repo, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
	symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
	for (const file of ["package.json", "tsconfig.json", "tsconfig.typecheck.json"])
		copyFileSync(join(web, file), join(app, file));
	write("src/app/page.ts", "export default function Page(): string {\n\treturn 'home';\n}\n");
	const validator =
		"import type * as Route from '../../../src/app/(product)/elsewhere/route.js';\nexport type Seen = typeof Route;\n";
	write(".next/dev/types/validator.ts", validator);
	write(".next/dev/types/routes.d.ts", "export type Routes = '/elsewhere';\n");
	write(".next/types/validator.ts", validator.replace("../../../", "../../"));
	write("next-env.d.ts", 'import "./.next/dev/types/routes.d.ts";\n');
	return { app, write };
}

const run = (cwd, command) => {
	const ran = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
	return { status: ran.status, output: ran.stdout + ran.stderr };
};

test("the stale generated files fail a typecheck that reads them, so the fixture plants the real hazard", () => {
	const { app } = staleWorktree();
	const ran = run(app, `${tsc} --noEmit -p tsconfig.json`);
	assert.notEqual(ran.status, 0);
	assert.match(ran.output, /\.next\/dev\/types\/validator\.ts\(\d+,\d+\): error TS2307/);
});

test("the web typecheck passes on clean code despite stale generated route types", () => {
	const { app } = staleWorktree();
	const ran = run(app, script);
	assert.equal(ran.status, 0, ran.output);
});

test("the web typecheck still fails on a type error in the branch's own code, against that file", () => {
	const { app, write } = staleWorktree();
	write("src/app/broken.ts", "export const count: number = 'three';\n");
	const ran = run(app, script);
	assert.notEqual(ran.status, 0);
	assert.match(ran.output, /^src\/app\/broken\.ts\(1,14\): error TS2322/m);
	assert.doesNotMatch(ran.output, /\.next\//);
});

test("the web typecheck reads tsconfig.json's files minus Next's generated ones, as on a fresh CI checkout", () => {
	const list = (config) => {
		const ran = spawnSync(tsc, ["--noEmit", "--listFilesOnly", "-p", config], { cwd: web, encoding: "utf8" });
		assert.equal(ran.status, 0, ran.stderr);
		return ran.stdout.split("\n").filter(Boolean).sort();
	};
	const generated = (file) => file.startsWith(join(web, ".next") + "/") || file === join(web, "next-env.d.ts");
	const editor = list("tsconfig.json").filter((file) => !generated(file));
	const checked = list("tsconfig.typecheck.json");
	assert.ok(checked.some((file) => file.startsWith(join(web, "src") + "/")));
	assert.deepEqual(checked, editor);
});
