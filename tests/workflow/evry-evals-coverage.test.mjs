// OPS-102: every Evry adapter operation ships with recorded eval cases. Operations are discovered from the adapter
// source (reads and commands), never from a hand-kept list. An operation is covered when a case object in
// tests/evry/evals/*.cases.json has "operation": "<name>". The baseline lists operations uncovered today and only
// shrinks (rule: .agents/skills/test-standard/SKILL.md). Source-text parse: no database, env, network or build.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const NAME = "[a-z][A-Za-z]*\\.[a-z][A-Za-z]*";
const EXPECTED_TODAY = 22;

// An operation is a string in an `operation: "x.y",` property or a factory call such as `readHousehold("x.y")`
// inside an exported declaration. A union type (`"a" | "b"`) and non-exported helpers add nothing by themselves.
function discoverOperations() {
	const found = new Set();
	const adapters = path("packages/evry/src/adapters/");
	for (const group of readdirSync(adapters, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
		for (const kind of ["reads", "commands"]) {
			let files;
			try {
				files = readdirSync(`${adapters}${group.name}/${kind}`).filter((f) => /\.ts$/.test(f) && !/\.test\./.test(f));
			} catch {
				continue;
			}
			for (const file of files) {
				const source = readFileSync(`${adapters}${group.name}/${kind}/${file}`, "utf8");
				for (const chunk of source.split(/^export /m).slice(1)) {
					for (const m of chunk.matchAll(new RegExp(`\\boperation:\\s*"(${NAME})"\\s*,`, "g"))) found.add(m[1]);
					for (const m of chunk.matchAll(new RegExp(`\\b[A-Za-z]\\w*\\(\\s*"(${NAME})"\\s*\\)`, "g"))) found.add(m[1]);
				}
			}
		}
	}
	return [...found].sort();
}

function coveredOperations() {
	const dir = path("tests/evry/evals/");
	const covered = new Set();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".cases.json"))) {
		const walk = (node) => {
			if (Array.isArray(node)) node.forEach(walk);
			else if (node && typeof node === "object") {
				if (typeof node.operation === "string") covered.add(node.operation);
				Object.values(node).forEach(walk);
			}
		};
		walk(JSON.parse(readFileSync(`${dir}${file}`, "utf8")));
	}
	return covered;
}

function coverageProblems(operations, covered, baseline) {
	const problems = [];
	const known = new Set(operations);
	for (const op of operations)
		if (!covered.has(op) && !baseline.includes(op))
			problems.push(`${op} has no eval case in tests/evry/evals/*.cases.json and is not in the baseline`);
	for (const op of baseline) {
		if (!known.has(op))
			problems.push(`${op} is in the baseline but no adapter exports it: remove it from the baseline`);
		else if (covered.has(op)) problems.push(`${op} now has an eval case: remove it from the baseline`);
	}
	return problems;
}

const baseline = JSON.parse(readFileSync(path("tests/workflow/evry-evals-baseline.json"), "utf8"));

test(`INV-OPS102: discovery finds the ${EXPECTED_TODAY} adapter operations on main`, () => {
	assert.equal(discoverOperations().length, EXPECTED_TODAY);
});

test("INV-OPS102: the baseline is sorted, unique and one name each", () => {
	assert.deepEqual(baseline, [...new Set(baseline)].sort());
});

test("INV-OPS102: every adapter operation has an eval case or sits in the shrinking baseline", () => {
	assert.deepEqual(coverageProblems(discoverOperations(), coveredOperations(), baseline), []);
});

test("INV-OPS102: an uncovered operation, a covered baseline entry and a vanished baseline entry each fail by name", () => {
	const ops = ["people.a", "people.b"];
	assert.deepEqual(coverageProblems(ops, new Set(["people.a"]), []), [
		"people.b has no eval case in tests/evry/evals/*.cases.json and is not in the baseline",
	]);
	assert.deepEqual(coverageProblems(ops, new Set(["people.a", "people.b"]), ["people.b"]), [
		"people.b now has an eval case: remove it from the baseline",
	]);
	assert.deepEqual(coverageProblems(ops, new Set(ops), ["people.gone"]), [
		"people.gone is in the baseline but no adapter exports it: remove it from the baseline",
	]);
});
