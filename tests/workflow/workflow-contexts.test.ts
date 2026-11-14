// T-370: GitHub rejects a whole workflow file whose `${{ runner.* }}` sits where the runner context is unavailable
// (a workflow's or job's `env`, `runs-on`, a job's `if`, ...), and then runs none of its jobs. This guard reads every
// .github/workflows/*.yml and allows the runner context only inside a step, the one place these workflows use it.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Each line whose `${{ }}` expression reads the runner context outside a `steps:` block, as "line N". */
function runnerContextMisuse(text: string): string[] {
	const found: string[] = [];
	let stepsIndent = -1;
	text.split("\n").forEach((line, i) => {
		if (!line.trim() || /^\s*#/.test(line)) return;
		const indent = line.search(/\S/);
		if (stepsIndent >= 0 && indent <= stepsIndent) stepsIndent = -1;
		if (stepsIndent < 0 && /^\s*steps:/.test(line)) stepsIndent = indent;
		else if (stepsIndent < 0 && /\$\{\{[^}]*(?<![\w.-])runner\./.test(line)) found.push(`line ${i + 1}`);
	});
	return found;
}

test("no workflow file uses the runner context where GitHub forbids it", () => {
	const files = globSync(".github/workflows/*.yml", { cwd: root }).sort();
	assert.ok(files.length > 0, "workflow files");
	const misuse = files.flatMap((file) =>
		runnerContextMisuse(readFileSync(join(root, file), "utf8")).map((where) => `${file} ${where}`),
	);
	assert.deepEqual(misuse, []);
});

test("the guard flags the runner context in a workflow env, a job env, runs-on and a job if", () => {
	const workflow = [
		"env:",
		"  TOP: ${{ runner.temp }}/a",
		"jobs:",
		"  ui:",
		"    if: ${{ runner.os == 'Linux' }}",
		"    runs-on: ${{ runner.arch }}",
		"    env:",
		'      NEXT_TELEMETRY_DISABLED: "1"',
		"      UI_DIR: ${{ runner.temp }}/nightly-ui",
		"    steps:",
		"      - run: echo",
	].join("\n");
	assert.deepEqual(runnerContextMisuse(workflow), ["line 2", "line 5", "line 6", "line 9"]);
});

test("the guard allows the runner context in steps and block scalars", () => {
	const workflow = [
		"jobs:",
		"  ui:",
		"    steps:",
		"      - name: logs",
		"        env:",
		"          DIR: ${{ runner.temp }}",
		"        with:",
		"          path: |",
		"            ${{ runner.temp }}/nightly-ui",
		"            env: ${{ runner.temp }}",
		"      - if: ${{ runner.os == 'Linux' }}",
		"        run: echo ${{ runner.temp }}",
		"  next:",
		"    env:",
		"      GOOD: ${{ github.sha }}",
	].join("\n");
	assert.deepEqual(runnerContextMisuse(workflow), []);
});
