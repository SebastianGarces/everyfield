import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const tool = resolve(import.meta.dirname, "../parallel.ts");
const cli = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
const lines = (stdout: string) => stdout.trimEnd().split("\n");

test("parallel: every command passes, so it exits 0 and each output line carries its command's label", () => {
	const r = cli("one=echo first; echo second >&2", "two=printf 'no newline'");
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const out = lines(r.stdout);
	for (const line of ["[one] first", "[one] second", "[two] no newline"]) assert.ok(out.includes(line), r.stdout);
	assert.ok(
		out.every((line) => /^\[(?:one|two)\] |^parallel: /.test(line)),
		r.stdout,
	);
	assert.match(out.at(-1)!, /^parallel: all 2 commands in [\d.]+ s passed$/);
});

test("parallel: one failing command fails the run, and the last line names it with its exit code", () => {
	const r = cli("ok=true", "bad=echo broken; exit 3", "gone=kill -TERM $$");
	assert.equal(r.status, 1, r.stdout + r.stderr);
	const out = lines(r.stdout);
	assert.ok(out.includes("[bad] broken"), r.stdout);
	assert.match(
		out.at(-1)!,
		/^parallel: 2 of 3 commands in [\d.]+ s failed: bad \(exit 3\), gone \(killed by SIGTERM\)$/,
	);
});

test("parallel: the commands run at the same time, not one after another", () => {
	const r = cli("a=sleep 1", "b=sleep 1", "c=sleep 1");
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const total = Number(
		lines(r.stdout)
			.at(-1)!
			.match(/in ([\d.]+) s/)![1],
	);
	assert.ok(total < 2.5, `three 1 s commands took ${total} s`);
});

test("parallel: a malformed or repeated label is refused before anything runs", () => {
	for (const args of [[], ["no label"], ["a=true", "a=false"], ["a=  "]]) {
		const r = cli(...args);
		assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
		assert.equal(r.stdout, "");
	}
});
