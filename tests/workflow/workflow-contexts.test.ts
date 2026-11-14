// T-370: GitHub rejects a whole workflow file whose `${{ runner.* }}` sits where the runner context is unavailable
// (a workflow's or job's `env`, `runs-on`, a job's `if`, ...), and then runs none of its jobs. This guard reads every
// .github/workflows/*.yml and allows the runner context only inside a step, the one place these workflows use it.
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const RUNNER_ALLOWED = /^jobs\.[^.]+\.steps(\.|$)/;

/** Each `${{ }}` expression that reads the runner context outside the places GitHub allows it, as "line N: key path". */
function runnerContextMisuse(text: string): string[] {
	const found: string[] = [];
	// Open keys by indentation; a list item adds a "-" segment. Lines of a block scalar belong to its key.
	const stack: { indent: number; key: string }[] = [];
	let block: { indent: number; path: string } | null = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.trim() || /^\s*#/.test(line)) continue;
		const indent = line.search(/\S/);
		let path: string;
		if (block && indent > block.indent) path = block.path;
		else {
			block = null;
			const item = line.slice(indent).match(/^-\s+/);
			const keyAt = indent + (item?.[0].length ?? 0);
			// A list item closes the item before it at its own indent (a compact `key:\n- item` keeps its key open).
			while (
				stack.length &&
				(stack.at(-1)!.indent > indent || (stack.at(-1)!.indent === indent && (!item || stack.at(-1)!.key === "-")))
			)
				stack.pop();
			if (item) stack.push({ indent, key: "-" });
			const key = line.slice(keyAt).match(/^(["']?)([\w.-]+)\1\s*:(?:\s|$)/);
			if (key) {
				stack.push({ indent: keyAt, key: key[2]! });
				if (/:\s*[|>][-+]?\d*\s*(?:#.*)?$/.test(line)) block = { indent: keyAt, path: pathOf(stack) };
			}
			path = pathOf(stack);
		}
		for (const [expression] of line.matchAll(/\$\{\{[\s\S]*?\}\}/g))
			if (/(?<![\w.-])runner\./.test(expression) && !RUNNER_ALLOWED.test(path)) found.push(`line ${i + 1}: ${path}`);
	}
	return found;
}

const pathOf = (stack: { key: string }[]) =>
	stack
		.map((s) => s.key)
		.filter((key) => key !== "-")
		.join(".");

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
	assert.deepEqual(runnerContextMisuse(workflow), [
		"line 2: env.TOP",
		"line 5: jobs.ui.if",
		"line 6: jobs.ui.runs-on",
		"line 9: jobs.ui.env.UI_DIR",
	]);
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
